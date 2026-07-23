// server.js
// Cloud Run에서 실행되는 백엔드 API 서버
// - Firestore 읽기를 이 서버 한 곳으로 집중시켜 클라이언트 직접 호출을 제거
// - center(현장) 단위로 5분 캐시를 두어 동일 데이터 반복 조회를 방지
// - 로그인(이름+전화번호) 인증도 서버에서 처리
//
// [2026-07 보안/안정성 패치]
//  1. HMAC 서명 세션 토큰 도입: /api/dashboard, /api/excel-files, /api/centers,
//     /api/dashboard/refresh 는 로그인 후 발급된 토큰이 있어야 접근 가능
//  2. 비-Master 계정은 자기 센터 데이터만 조회 가능 (center 파라미터 위조 차단)
//  3. 캐시 스탬피드 방지 (동시 요청 시 Firestore 조회 1회로 합침)
//  4. 조회 실패 시 빈 결과를 캐시하지 않음 (다음 요청이 재시도)
//  5. 60일 룩백 날짜 KST 기준으로 보정
//  6. 로그인 시도 IP당 횟수 제한 (brute-force 방어)
//
// ★ 주의: /api/fidlocations 는 이벤트(M-Event) 프로젝트가 공유 사용 중이므로
//   응답 형식({ok, fidLocations, sheetLabels})과 무인증 접근을 그대로 유지한다.
//
// [2026-07-11] server.js가 너무 비대해져서(약 800줄) config/와 lib/로 로직을
// 분리했다. 이 파일은 익스프레스 설정 + 라우트 정의만 담당한다.
// (m-smart-monitor의 functions/config, functions/lib 구조를 참고함)

const express = require("express");
const cors = require("cors");

const { admin, db } = require("./lib/firebase");
const { MASTER_CENTER_NAME, INSPECTION_LOGS_LOOKBACK_DAYS } = require("./config/constants");
const { cache, getCache, setCache, getOrBuild } = require("./lib/cache");
const { signSession, authMiddleware, resolveCenter } = require("./lib/session");
const { getLookbackDateString } = require("./lib/dateUtils");
const { getFidLocations, getSheetLabels } = require("./lib/facilities");
const { buildEventsData } = require("./lib/events");
const { listReportFileMeta, signReportFileUrl } = require("./lib/reportFiles");

const app = express();
// [2026-07-11 수정] cors()를 전역 적용하지 않음. 이 서버의 프론트엔드(public/index.html)는
// express.static("public")로 같은 서버·같은 오리진에서 서빙되므로 인증 필요 API는
// CORS가 아예 필요 없음(same-origin). 다른 도메인(m-event)이 실제로 호출하는 건
// /api/fidlocations 하나뿐이므로, CORS는 그 라우트에만 별도로 적용한다.
app.use(express.json());

// 응답 압축 (선택 의존성) — `npm install compression` 후 자동 활성화.
// 미설치 상태여도 서버는 정상 기동한다.
try {
  app.use(require("compression")());
} catch (e) {
  console.warn("[안내] compression 미설치 — `npm install compression` 시 응답 전송량 절감 가능");
}

app.use(express.static("public")); // 프론트(index.html 등) 정적 서빙

// ---------------------------------------------------------------------------
// POST /api/login
// [2026-07 변경] 로그인 판정(이름+전화번호 대조, brute-force 방어)은
// M-Event의 loginWithCredentials Cloud Function으로 위임됨.
// 클라이언트는 그 함수가 발급한 커스텀 토큰으로 Firebase Auth 로그인 후
// idToken을 이 엔드포인트로 보낸다. 여기서는 idToken 검증 + UserDB 조회 +
// 기존 HMAC 세션 토큰 발급만 담당한다.
//
// UserDB 문서 ID = Firebase Auth UID (loginWithCredentials가
// admin.auth().createCustomToken(matched.id, ...)로 문서ID를 그대로 uid로
// 사용하기 때문) → where 쿼리 없이 doc(uid) 단건 조회로 매칭 가능.
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ ok: false, message: "인증 토큰이 없습니다." });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const doc = await db.collection("UserDB").doc(uid).get();

    // [유지] "미등록"과 "비활성 계정" 응답을 통일해 계정 존재 여부 노출 방지.
    if (!doc.exists || doc.data().active !== true) {
      return res.status(401).json({
        ok: false,
        message: "인증 실패: 정보가 일치하지 않거나 접근이 제한된 계정입니다. 관리자에게 문의하세요.",
      });
    }

    const userData = doc.data();

    // allowed_apps가 배열로 지정된 경우에만 화이트리스트 검사.
    // 필드 자체가 없으면(Array가 아니면) 전체 앱 허용 — Cloud Function의
    // isAppAllowed()와 동일한 하위호환 규칙.
    if (Array.isArray(userData.allowed_apps) && !userData.allowed_apps.includes("dashboard")) {
      return res.status(403).json({ ok: false, message: "이 계정은 M-SMART 접근 권한이 없습니다." });
    }

    const center = userData.center_name || "";
    return res.json({ ok: true, center, token: signSession(center) });
  } catch (err) {
    console.error("로그인 처리 오류:", err);
    return res.status(401).json({ ok: false, message: "인증 토큰이 유효하지 않습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard?center=XXX   [인증 필수]
// center 단위로 5분 캐시 적용 → 동일 현장에서 새로고침을 반복해도
// Firestore 실제 읽기는 5분에 한 번만 발생
// [수정] 비-Master 계정은 center 파라미터를 무시하고 자기 센터로 강제,
//        캐시 스탬피드 방지, records에서 미사용 file_url 필드 제거
// ---------------------------------------------------------------------------
app.get("/api/dashboard", authMiddleware, async (req, res) => {
  try {
    const center = resolveCenter(req);
    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    const cacheKey = `dashboard:${center}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ ok: true, cached: true, ...cached });
    }

    const payload = await getOrBuild(cacheKey, async () => {
      const isMaster = center === MASTER_CENTER_NAME;
      const lookbackDate = getLookbackDateString(INSPECTION_LOGS_LOOKBACK_DAYS);

      // inspection_logs: 최근 60일치만 조회 (datetime은 ISO 문자열이라 사전식 비교 = 시간순 비교와 동일)
      // Master는 centerName 필터 없이 전체 센터를 60일 리밋만 걸어서 조회
      const logsQuery = isMaster
        ? db.collection("inspection_logs").where("datetime", ">=", lookbackDate)
        : db
            .collection("inspection_logs")
            .where("center_name", "==", center)
            .where("datetime", ">=", lookbackDate);

      const [logsSnap, fidLocations, eventsByFid] = await Promise.all([
        logsQuery.get(),
        getFidLocations(center),
        buildEventsData(center),
      ]);

      // 점검 기록 가공
      const records = [];
      logsSnap.forEach((doc) => {
        const data = doc.data();
        const fids = Array.isArray(data.facility_id) ? data.facility_id : [data.facility_id || "알수없음"];

        fids.forEach((fid) => {
          const cleanFid = fid ? String(fid).trim() : "알수없음";
          records.push({
            date: data.datetime ? data.datetime.substring(0, 10) : "",
            inspector: data.worker || "미지정",
            fid: cleanFid,
          });
        });
      });

      return {
        center,
        records,
        fidLocations,
        eventsByFid,
        generatedAt: new Date().toISOString(),
      };
    });

    return res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    console.error("대시보드 데이터 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "데이터 조회 중 오류가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/excel-files?center=XXX&page=1&pageSize=15   [인증 필수]
// [2026-07-23 변경] Maxerve_Excel(설비별 점검표) 대신 m-event가 생성하는
// "이벤트 보고서"(Storage report/{center}/*.xlsx)를 대신 보여준다.
// 이벤트 보고서는 설비 단위가 아니라 센터 전체 기간 단위 파일이라 fid 파라미터는 더 이상
// 안 씀 — 프런트가 fid를 붙여 보내도 무시하고 항상 센터(또는 Master는 전체) 통합 목록을 반환.
// 5분 캐시(reportFiles:{center})로 Storage 목록 조회 + signed URL 발급 비용을 줄인다.
// ---------------------------------------------------------------------------
app.get("/api/excel-files", authMiddleware, async (req, res) => {
  try {
    const center = resolveCenter(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    // 목록 자체는 캐시(list API 1회 호출, 추가 API 호출 없음) — signed URL은 아래에서
    // 화면에 실제로 보여줄 페이지 분량(최대 15개)에 대해서만 그때그때 발급한다.
    const fullList = await getOrBuild(`reportFiles:${center}`, () => listReportFileMeta(center));

    const totalCount = fullList.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const pageMeta = fullList.slice(start, start + pageSize);

    const items = await Promise.all(pageMeta.map(async (item) => ({
      fileName: item.fileName,
      uploadedAt: item.uploadedAt,
      file_url: await signReportFileUrl(item.path),
    })));

    return res.json({
      ok: true,
      fid: null,
      page: safePage,
      pageSize,
      totalCount,
      totalPages,
      items,
    });
  } catch (err) {
    console.error("엑셀 파일 목록 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "엑셀 파일 목록 조회 중 오류가 발생했습니다." });
  }
});

// 캐시 강제 무효화 (관리/디버깅용 - 필요시 버튼에 연결 가능)
// [수정] 인증 필수 + 비-Master는 자기 센터 캐시만 무효화 가능
//        (무인증 상태로 두면 외부에서 캐시를 계속 비워 Firestore 읽기 비용을
//         강제로 발생시킬 수 있음)
app.post("/api/dashboard/refresh", authMiddleware, (req, res) => {
  const isMaster = req.authCenter === MASTER_CENTER_NAME;
  const requested = (req.query.center || "").toString().trim();
  const center = isMaster ? requested : req.authCenter;

  if (center) {
    cache.delete(`dashboard:${center}`);
    cache.delete(`reportFiles:${center}`);
  } else if (isMaster) {
    cache.clear(); // 전체 캐시 비우기는 Master만 허용
  }
  res.json({ ok: true });
});

// ── /api/fidlocations ──────────────────────────────────────────
// fid → fid_name 매핑 반환 (m-event 이벤트트래커에서 사용)
// ★ 이벤트(M-Event) 프로젝트가 공유 사용 중 — 응답 형식과 무인증 접근을
//   변경하지 말 것. (변경 시 이벤트 프로젝트도 함께 배포해야 함)
app.get("/api/fidlocations", cors(), async (req, res) => {
  const center = (req.query.center || "").toString().trim();
  if (!center) return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
  try {
    const [locations, sheetLabels] = await Promise.all([
      getFidLocations(center),
      getSheetLabels(center),
    ]);
    return res.json({ ok: true, fidLocations: locations, sheetLabels });
  } catch (e) {
    console.error("fidlocations 오류:", e);
    return res.status(500).json({ ok: false, message: "조회 중 오류가 발생했습니다." });
  }
});

// ── /api/centers ───────────────────────────────────────────────
// Master 계정용 센터 목록.   [인증 필수 — Master만 접근 가능]
// settings/all_centers 문서의 centers 배열 필드에서 읽는다.
// (M-Event 대시보드와 동일한 소스 — 신규 센터 추가 시 이 배열에도 반드시 추가할 것)
app.get("/api/centers", authMiddleware, async (req, res) => {
  if (req.authCenter !== MASTER_CENTER_NAME) {
    return res.status(403).json({ ok: false, message: "권한이 없습니다." });
  }

  const cacheKey = "centers:list";
  const cached = getCache(cacheKey);
  if (cached) return res.json({ ok: true, centers: cached });

  try {
    const doc = await db.collection("settings").doc("all_centers").get();
    const centers = doc.exists ? (doc.data().centers || []).slice().sort((a, b) => a.localeCompare(b)) : [];
    setCache(cacheKey, centers);
    return res.json({ ok: true, centers });
  } catch (e) {
    console.error("센터 목록 조회 오류:", e);
    return res.status(500).json({ ok: false, message: "센터 목록 조회 중 오류가 발생했습니다." });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
