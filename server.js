// server.js
// Cloud Run에서 실행되는 백엔드 API 서버
// - Firestore 읽기를 이 서버 한 곳으로 집중시켜 클라이언트 직접 호출을 제거
// - center(현장) 단위로 5분 캐시를 두어 동일 데이터 반복 조회를 방지
// - 로그인 세션(HMAC 서명 토큰) 발급도 서버에서 처리
//
// [2026-07 보안/안정성 패치]
//  1. HMAC 서명 세션 토큰 도입: /api/dashboard, /api/excel-files, /api/centers,
//     /api/event-photos, /api/dashboard/refresh, /api/fidlocations 는 로그인 후
//     발급된 토큰이 있어야 접근 가능 (fidlocations는 2026-07-29에 합류)
//  2. 비-Master 계정은 자기 센터 데이터만 조회 가능 (center 파라미터 위조 차단)
//  3. 캐시 스탬피드 방지 (동시 요청 시 Firestore 조회 1회로 합침)
//  4. 조회 실패 시 빈 결과를 캐시하지 않음 (다음 요청이 재시도)
//  5. 60일 룩백 날짜 KST 기준으로 보정
//  6. 로그인 시도 횟수 제한(brute-force 방어)은 이 서버가 아니라 m-event의
//     loginWithCredentials Cloud Function이 담당한다 — /api/login은 그 함수가
//     발급한 idToken을 검증만 하므로 여기서 대입 공격이 성립하지 않는다.
//
// ★ [2026-07-29 정정] "/api/fidlocations 는 M-Event가 공유 사용 중이므로 무인증을
//   유지한다"고 적혀 있던 주의사항은 더 이상 사실이 아니다 — m-event는 07-11에
//   Firestore 직접 조회로 전환했고 호출부가 남아 있지 않다(해당 라우트 주석 참고).
//   지금은 다른 API와 동일하게 인증이 필요하다. 응답 형식은 그대로 유지.
//
// [2026-07-11] server.js가 너무 비대해져서(약 800줄) config/와 lib/로 로직을
// 분리했다. 이 파일은 익스프레스 설정 + 라우트 정의만 담당한다.
// (m-smart-monitor의 functions/config, functions/lib 구조를 참고함)

const express = require("express");
const compression = require("compression");

const { admin, db } = require("./lib/firebase");
const {
  MASTER_CENTER_NAME,
  INSPECTION_LOGS_LOOKBACK_DAYS,
  INSPECTION_LOGS_QUERY_LIMIT,
  INSPECTION_LOGS_MAX_RECORDS,
} = require("./config/constants");
const { cache, getCache, getOrBuild } = require("./lib/cache");
const { signSession, authMiddleware, resolveCenter } = require("./lib/session");
const { getLookbackDateString } = require("./lib/dateUtils");
const { getFidLocations, getSheetLabels } = require("./lib/facilities");
const { buildEventsData, getEventPhotos } = require("./lib/events");
const { listReportFileMeta, signReportFileUrl } = require("./lib/reportFiles");
const { getCenterList, isKnownCenter } = require("./lib/centers");
const { canAccessDashboard } = require("./lib/permissions");

const app = express();
// [2026-07-11 수정] cors()를 전역 적용하지 않음. 이 서버의 프론트엔드(public/index.html)는
// express.static("public")로 같은 서버·같은 오리진에서 서빙되므로 CORS가 아예 필요 없음.
// [2026-07-29] 마지막까지 남아있던 크로스오리진 호출부(/api/fidlocations ← m-event)가
// 실제로는 07-11에 사라진 것이 확인되어, 그 라우트의 cors()와 여기 require까지 제거했다.
// 이제 이 서버는 CORS를 전혀 쓰지 않는다(package.json의 cors 의존성만 미사용으로 남음).
app.use(express.json());
app.use(compression());

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
//
// ✅ [2026-08-01] "계정 활성 / 관리자 권한" 분리 완료 — 아래 경고는 그 작업으로 해소됐다.
//    예전엔 이 엔드포인트가 `active !== true → 401`로 막았고, 그게 m-event/M-SMART엔
//    없는 Dashboard만의 조건이라 **active가 사실상 "관리자냐"의 뜻으로 쓰이고 있었다.**
//    이제 판정은 lib/permissions.js의 canAccessDashboard()가 한다(관리자 = role:"admin",
//    role이 아직 없는 문서는 예전 의미인 active로 폴백). 전환기 동안 결과는 예전과 동일하다.
//    ⚠️ 그 폴백을 지우는 건 구글시트 백필이 UserDB 전 문서에 반영된 뒤에 할 것.
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

    // [유지] "미등록"과 "권한 없음" 응답을 통일해 계정 존재 여부 노출 방지.
    if (!doc.exists || !canAccessDashboard(doc.data())) {
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
      return res.status(403).json({ ok: false, message: "이 계정은 대시보드 접근 권한이 없습니다." });
    }

    const center = userData.center_name || "";
    // 세션 토큰엔 신원이 안 실리므로(센터만) 접속 이력은 여기서 남긴다.
    console.log(`[로그인] uid=${uid} center=${center}`);
    return res.json({ ok: true, center, token: signSession(center, uid) });
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
      // Master는 center_name 필터 없이 전체 센터를 60일 리밋만 걸어서 조회.
      // [2026-07-27] orderBy(datetime desc) + limit 추가 — 예전엔 상한이 없어
      // Master가 센터 수에 비례해 무한정 읽었다. 최신순이라 잘려도 최근 데이터는 온전.
      // (필요 인덱스는 config/constants.js의 INSPECTION_LOGS_QUERY_LIMIT 주석 참고)
      const baseQuery = isMaster
        ? db.collection("inspection_logs").where("datetime", ">=", lookbackDate)
        : db
            .collection("inspection_logs")
            .where("center_name", "==", center)
            .where("datetime", ">=", lookbackDate);
      const logsQuery = baseQuery.orderBy("datetime", "desc").limit(INSPECTION_LOGS_QUERY_LIMIT);

      // [2026-07-27] 이벤트 조회 실패가 대시보드 전체를 500으로 만들지 않도록 격리.
      // 실제로 events 복합 인덱스 누락 때 FAILED_PRECONDITION으로 점검기록까지 못 보게
      // 된 이력이 있다(system_map.md 6번). 이벤트만 비우고 나머지는 그대로 보여주되,
      // 조용히 "이벤트 0건"으로 보이면 안 되므로 eventsError로 프런트에 알린다.
      // (M-Engine 월간 리포트의 센터별 오류 격리와 같은 교훈)
      const safeBuildEvents = async () => {
        try {
          return { data: await buildEventsData(center), failed: false };
        } catch (e) {
          console.error("이벤트 조회 실패 — 점검기록만 반환합니다:", e);
          return { data: {}, failed: true };
        }
      };

      const [logsSnap, fidLocations, events] = await Promise.all([
        logsQuery.get(),
        getFidLocations(center),
        safeBuildEvents(),
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

      // 쿼리 상한에 걸렸으면(= 가져온 문서 수가 정확히 limit) 더 오래된 기록이 남아 있다는 뜻
      let truncated = logsSnap.size >= INSPECTION_LOGS_QUERY_LIMIT;
      if (truncated) {
        console.warn(
          `[경고] ${center}: 점검기록이 쿼리 상한 ${INSPECTION_LOGS_QUERY_LIMIT}건에 도달했습니다(최신순으로 잘림).`
        );
      }

      // 응답 크기 2차 방어: 문서 1건이 여러 레코드로 펼쳐지므로 여기서 한 번 더 자른다
      let finalRecords = records;
      if (records.length > INSPECTION_LOGS_MAX_RECORDS) {
        truncated = true;
        finalRecords = records
          .slice()
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
          .slice(0, INSPECTION_LOGS_MAX_RECORDS);
        console.warn(
          `[경고] ${center}: 점검기록 ${records.length}건이 상한 ${INSPECTION_LOGS_MAX_RECORDS}건을 초과해 잘라냈습니다.`
        );
      }

      return {
        center,
        records: finalRecords,
        truncated,
        fidLocations,
        eventsByFid: events.data,
        eventsError: events.failed,
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
// GET /api/event-photos?id=XXX   [인증 필수]
// [2026-07-27 신규] 이벤트 상세 팝업을 열 때만 사진 URL을 해석한다.
// /api/dashboard가 모든 이벤트의 signed URL을 미리 발급하던 것을 대체 —
// 서명은 IAM signBlob 왕복이라 팝업을 안 열어도 비용이 나가고 있었다.
// 접근 제어: 비-Master는 자기 센터의 이벤트만. (lib/events.js getEventPhotos)
// ---------------------------------------------------------------------------
app.get("/api/event-photos", authMiddleware, async (req, res) => {
  const id = (req.query.id || "").toString().trim();
  if (!id) {
    return res.status(400).json({ ok: false, message: "id 파라미터가 필요합니다." });
  }

  try {
    const photos = await getEventPhotos(id, req.authCenter);
    // 문서 없음 / 다른 센터 이벤트를 구분하지 않는다 (존재 여부 탐색 방지)
    if (photos === null) {
      return res.status(404).json({ ok: false, message: "이벤트를 찾을 수 없습니다." });
    }
    return res.json({ ok: true, photos });
  } catch (err) {
    console.error("이벤트 사진 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "사진 조회 중 오류가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/excel-files?center=XXX&page=1&pageSize=15   [인증 필수]
// [2026-07-23 변경] Maxerve_Excel(설비별 점검표) 대신 m-event가 생성하는
// "이벤트 보고서"(Storage report/{center}/*.xlsx)를 대신 보여준다.
// 이벤트 보고서는 설비 단위가 아니라 센터 전체 기간 단위 파일이라 fid 개념 자체가
// 없어졌다 — 2026-07-27에 남아 있던 fid 파라미터 배선(항상 null을 반환하던
// 응답 필드 포함)을 전부 제거했다.
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
      page: safePage,
      pageSize,
      totalCount,
      totalPages,
      items,
    });
  } catch (err) {
    console.error("이벤트 보고서 목록 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "보고서 목록 조회 중 오류가 발생했습니다." });
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
// fid → fid_name / sheet_label 매핑 반환.
//
// [2026-07-29 변경 — 무인증 해제] 이 엔드포인트는 "m-event가 공유해서 쓰니까
// 무인증·CORS 개방을 유지해야 한다"는 전제로 열려 있었다. 그 전제는 이미 깨져
// 있었다: m-event는 2026-07-11에 Firestore(center_configs)를 직접 읽는 방식으로
// 전환했고(m-event/manager/js/auth.js의 loadFidLocations), 그 뒤로 이 API를
// 호출하지 않는다. 5개 저장소 전체 grep 결과 호출부 0건이고, Cloud Run 액세스
// 로그에서도 referer=m-smart-0804.web.app 트래픽이 2026-07-11 05:39 이후 완전히
// 끊겼다(그 뒤 기록은 07-27/28 코드리뷰 때 수동으로 날린 curl 검증뿐).
//
// 즉 "센터별 설비ID→위치명 매핑 전체"를 인증 없이 내주는 창구가 실제 소비자
// 없이 열려만 있던 상태였다. 그래서:
//   · authMiddleware 적용 — 다른 조회 API와 동일하게 세션 토큰을 요구
//   · resolveCenter 사용 — 비-Master는 center 파라미터를 위조해도 자기 센터로 강제
//   · cors() 제거 — 남은 호출부가 same-origin(이 서버의 index.html)뿐이라 불필요
//
// 아래 두 검증(① Master 거부 ② 미등록 센터 거부)은 무인증 시절의 방어였고, 지금은
// 인증+resolveCenter가 같은 위협을 이미 막지만 다중 방어로 그대로 둔다.
// ⚠️ 되돌릴 일이 생기면(저장소 밖 소비자 — 예: Apps Script — 가 나타나는 경우)
//    authMiddleware를 cors()로 되돌리고 center를 req.query에서 읽으면 예전 동작으로
//    정확히 복귀한다. 응답 형식({ok, fidLocations, sheetLabels})은 바꾸지 않았다.
app.get("/api/fidlocations", authMiddleware, async (req, res) => {
  const center = resolveCenter(req);
  if (!center) return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });

  if (center === MASTER_CENTER_NAME) {
    return res.status(400).json({ ok: false, message: "조회할 센터를 지정해주세요." });
  }

  try {
    if (!(await isKnownCenter(center))) {
      console.warn(`[fidlocations] 등록되지 않은 센터 요청: ${center}`);
      return res.status(404).json({ ok: false, message: "알 수 없는 센터입니다." });
    }

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

  try {
    return res.json({ ok: true, centers: await getCenterList() });
  } catch (e) {
    console.error("센터 목록 조회 오류:", e);
    return res.status(500).json({ ok: false, message: "센터 목록 조회 중 오류가 발생했습니다." });
  }
});

// 가동 확인용. 인증 없이 200 + "ok"만 돌려준다(내부 정보 노출 없음).
//
// ⚠️ 경로 이름을 `/healthz`로 되돌리지 말 것 — 그러면 다시 죽는다.
// 2026-07-11부터 3주간 "라우트는 있는데 라이브에선 404"인 상태였고, 2026-07-30에
// 원인을 찾았다: `healthz`/`statusz`/`varz`는 구글이 내부 진단 페이지(z-page)로
// 선점한 이름이라, **Google Frontend가 가로채 자기 404를 돌려주고 요청이 컨테이너에
// 도달조차 하지 않는다.** 로컬에선 200이라 더 헷갈렸다.
// 실측: /healthz·/statusz·/varz → 구글 404(1568B, x-powered-by 없음)
//       /health·/healthcheck·/readyz·/livez → Express까지 도달 (= 우리가 응답)
// "z로 끝나서"가 아니다(readyz/livez는 통과). 저 세 이름만 피하면 된다.
app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
