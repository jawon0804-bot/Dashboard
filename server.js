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

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

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
// Firebase Admin 초기화
// Cloud Run 환경에서는 별도 키 파일 없이 서비스 계정(런타임 서비스 ID)으로
// 자동 인증됩니다. 로컬 테스트 시에는 GOOGLE_APPLICATION_CREDENTIALS 환경변수로
// 서비스 계정 키 json 경로를 지정하세요.
// ---------------------------------------------------------------------------
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || "m-smart-90148",
});
const db = admin.firestore();

// ---------------------------------------------------------------------------
// [신규] 세션 토큰 (HMAC-SHA256 서명)
// - 로그인 성공 시 { center, exp } 를 서명해 발급
// - 이후 API 호출은 Authorization: Bearer <token> 헤더 필수
// - Cloud Run 환경변수 SESSION_SECRET 을 반드시 설정할 것.
//   미설정 시 임시 난수 키로 기동하지만, 인스턴스 재시작/스케일아웃 때마다
//   기존 세션이 전부 무효화되므로 운영 환경에서는 꼭 고정 키를 지정한다.
//   예) gcloud run deploy ... --set-env-vars SESSION_SECRET=$(openssl rand -hex 32)
// ---------------------------------------------------------------------------
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (() => {
    console.warn(
      "[경고] SESSION_SECRET 환경변수가 없어 임시 난수 키로 기동합니다. " +
        "인스턴스 재시작 시 전체 재로그인이 필요하니 Cloud Run 환경변수로 설정하세요."
    );
    return crypto.randomBytes(32).toString("hex");
  })();

// [2026-07-11 수정] 12시간 → 4시간. 토큰에 폐기(로그아웃) 수단이 없어서
// 탈취당했을 때 유효한 시간을 줄이는 쪽으로 대응. Firestore 조회를 늘리는
// 실시간 폐기 목록 방식은 이 서버의 "읽기 최소화" 설계 방향과 맞지 않아 보류.
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4시간

function signSession(center) {
  const payload = Buffer.from(
    JSON.stringify({ center, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.center || typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data; // { center, exp }
  } catch (e) {
    return null;
  }
}

// 인증 미들웨어: 토큰 검증 후 req.authCenter 에 로그인 신원(센터)을 심는다.
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = verifySession(token);
  if (!session) {
    return res.status(401).json({ ok: false, message: "세션이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요." });
  }
  req.authCenter = session.center;
  next();
}

// 조회 대상 센터 결정: Master 로그인만 임의의 center 파라미터 허용,
// 일반 계정은 파라미터를 무시하고 자기 센터로 강제한다.
function resolveCenter(req) {
  const requested = (req.query.center || "").toString().trim();
  if (req.authCenter === MASTER_CENTER_NAME) {
    return requested || MASTER_CENTER_NAME;
  }
  return req.authCenter;
}

// ---------------------------------------------------------------------------
// [2026-07 변경] 로그인 brute-force 방어는 이제 M-Event의
// loginWithCredentials Cloud Function이 login_attempts/login_lockouts
// 컬렉션으로 자체 처리한다. /api/login은 idToken만 받으므로 서버 측
// IP 레이트리밋(loginRateLimit)은 더 이상 필요 없어 제거했다.
// ---------------------------------------------------------------------------
// 엑셀 보고서 단일 컬렉션
// 센터별로 별도 컬렉션을 쓰던 방식(MaxerveUlsan_Excel 등)에서
// Maxerve_Excel 하나로 통합하고 centerName 필드로 필터링합니다.
// 신규 센터 추가 시 코드 수정/재배포 없이 Firestore에 문서만 넣으면 됩니다.
// ---------------------------------------------------------------------------
const EXCEL_COLLECTION = "Maxerve_Excel";

// "Master" 센터로 로그인하면 모든 센터의 데이터를 통합해서 봅니다.
const MASTER_CENTER_NAME = "Master";

// inspection_logs(점검기록)는 최근 60일치만 조회합니다. (엑셀 보고서는 전체 유지)
const INSPECTION_LOGS_LOOKBACK_DAYS = 60;

// [수정] inspection_logs.datetime 은 KST 기준 문자열이므로 룩백 경계일도
// KST 기준으로 계산한다. (기존 UTC 기준 계산은 최대 9시간 어긋남)
function getLookbackDateString(days) {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  kstNow.setUTCDate(kstNow.getUTCDate() - days);
  return kstNow.toISOString().substring(0, 10); // "YYYY-MM-DD"
}

// URL에서 사람이 읽기 좋은 파일명을 뽑아냅니다.
// Firebase Storage 다운로드 URL은 경로가 %2F로 인코딩되어 있고 쿼리스트링(토큰)이
// 붙어있어서 그대로 쓰면 매우 지저분합니다. 디코딩 + 쿼리 제거 + 마지막 조각만 추출합니다.
// 그래도 알아볼 수 없는 형태(긴 해시/토큰뿐)라면 깔끔한 기본 이름으로 대체합니다.
function extractCleanFileName(url, uploadedAt) {
  try {
    const withoutQuery = url.split("?")[0];
    const decoded = decodeURIComponent(withoutQuery);
    const lastSegment = decoded.split("/").pop();

    // 60자 초과이거나 확장자가 없으면 알아보기 힘든 토큰일 가능성이 높음 -> 기본 이름 사용
    const hasReadableExtension = /\.(xlsx|xls|csv|pdf)$/i.test(lastSegment);
    if (lastSegment && lastSegment.length <= 60 && hasReadableExtension) {
      return lastSegment;
    }
  } catch (e) {
    // decodeURIComponent 실패 등 - 아래 기본값으로 폴백
  }
  const dateLabel = uploadedAt ? String(uploadedAt).substring(0, 10) : "";
  return dateLabel ? `보고서_${dateLabel}.xlsx` : "보고서.xlsx";
}

// ---------------------------------------------------------------------------
// GCS 버킷 핸들 + storage_path -> 다운로드 URL 즉석 발급
// Firestore 문서에 storage_path(신규, 만료 없는 경로)가 있으면 요청 시점마다
// 짧은 유효기간의 signed URL을 새로 발급한다 (응답 즉시 소비되므로 1시간이면 충분).
// storage_path가 없는 예전 문서는 저장돼 있던 file_url(만료됐을 수 있음)로 폴백.
// ---------------------------------------------------------------------------
const STORAGE_BUCKET_NAME = "m-smart-90148.firebasestorage.app";
let _bucket = null;
function getBucket() {
  if (!_bucket) _bucket = admin.storage().bucket(STORAGE_BUCKET_NAME);
  return _bucket;
}

async function resolveFileUrl(data) {
  if (data.storage_path) {
    try {
      const [url] = await getBucket().file(data.storage_path).getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 60 * 1000, // 1시간
      });
      return url;
    } catch (e) {
      console.error(`signed url 생성 실패 (${data.storage_path}):`, e.message);
      return data.file_url || ""; // 서명 실패 시에만 예전 필드로 폴백
    }
  }
  return data.file_url || "";
}

// ---------------------------------------------------------------------------
// 센터(또는 Master)에 해당하는 엑셀 데이터를 Maxerve_Excel 단일 컬렉션에서 조회해
// { excelMap, excelListByFid } 형태로 가공해 반환하는 공통 함수.
// Master면 centerName 필터 없이 전체 조회, 일반 센터면 centerName으로 필터링.
// /api/dashboard와 /api/excel-files(캐시 미스 시) 양쪽에서 재사용합니다.
// ---------------------------------------------------------------------------
async function buildExcelData(center) {
  const excelMap = {};
  const excelListByFid = {};

  const isMaster = center === MASTER_CENTER_NAME;

  // Master는 전체 조회, 일반 센터는 centerName 필터링
  const excelQuery = isMaster
    ? db.collection(EXCEL_COLLECTION)
    : db.collection(EXCEL_COLLECTION).where("center_name", "==", center);

  const excelSnap = await excelQuery.get();

  // 1단계: 문서 순회하며 유효한 것만 골라둔다 (file_url 또는 storage_path 둘 중 하나만 있어도 통과)
  const rawDocs = [];
  excelSnap.forEach((doc) => {
    const data = doc.data();
    if (!data.facility_id || (!data.file_url && !data.storage_path)) return;

    let fidList = [];
    if (Array.isArray(data.facility_id)) {
      fidList = data.facility_id;
    } else if (typeof data.facility_id === "string") {
      fidList = data.facility_id.split(",").map((s) => s.trim());
    } else {
      fidList = [String(data.facility_id)];
    }
    fidList.sort((a, b) => a.localeCompare(b));
    if (fidList.length === 0) return;

    rawDocs.push({ doc, data, primaryFid: fidList[0] });
  });

  // 2단계: 다운로드 URL을 병렬로 즉석 발급 (storage_path 있으면 새로, 없으면 file_url 그대로)
  await Promise.all(
    rawDocs.map(async ({ doc, data, primaryFid }) => {
      const uploadedAt =
        data.uploaded_at || data.createdAt || data.datetime || (doc.createTime ? doc.createTime.toDate().toISOString() : "");
      const resolvedUrl = await resolveFileUrl(data);
      const cleanFid = String(primaryFid).trim();

      if (!excelListByFid[cleanFid]) excelListByFid[cleanFid] = [];
      excelListByFid[cleanFid].push({
        docId: doc.id,
        file_url: resolvedUrl,
        fileName: data.fileName || data.file_name || extractCleanFileName(resolvedUrl, uploadedAt),
        uploadedAt,
      });
    })
  );

  // 설비별 최신순 정렬
  Object.keys(excelListByFid).forEach((fid) => {
    excelListByFid[fid].sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });
  });

  // excelMap: 정렬 완료된 첫 번째 항목(최신)으로 구성
  Object.keys(excelListByFid).forEach((fid) => {
    excelMap[fid] = excelListByFid[fid][0].file_url;
  });

  return { excelMap, excelListByFid };
}

// ---------------------------------------------------------------------------
// 메모리 캐시 (인스턴스 단위, 5분 TTL)
// Cloud Run은 인스턴스가 여러 개 뜰 수 있어 완전한 전역 캐시는 아니지만,
// 최소 동시성(min-instances=1) 또는 단일 인스턴스 운영 시 읽기량이 크게 줄어듭니다.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
const cache = new Map(); // key -> { data, expiresAt }

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// [신규] 캐시 스탬피드 방지 헬퍼
// 캐시 만료 직후 동일 키로 요청이 동시에 몰려도 builder(Firestore 조회 +
// signed URL 대량 발급)는 딱 1번만 실행되고, 나머지 요청은 그 Promise를 공유한다.
// builder가 throw하면 아무것도 캐시하지 않으므로 다음 요청이 자연스럽게 재시도한다.
// ---------------------------------------------------------------------------
const inflight = new Map(); // key -> Promise

async function getOrBuild(key, builder) {
  const cached = getCache(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const data = await builder();
      setCache(key, data);
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// 설비ID -> 위치명 매핑 (center_configs/{center}/facilities 에서 동적으로 조회)
// 센터별 서브컬렉션: center_configs/{center}/facilities/{fid}
//   fid_name: 위치명, category: 카테고리, center_name: 센터명
// 결과는 메모리에 캐시 (CACHE_TTL_MS 동일 적용)
// [수정] 조회 실패 시 빈 객체를 "캐시하지 않고" 반환한다.
//        (기존에는 일시 오류 한 번에 빈 매핑이 5분간 굳어버렸음)
// ---------------------------------------------------------------------------
async function fetchFidLocationsFromDb(center) {
  const locations = {};
  const isMaster = center === MASTER_CENTER_NAME;

  if (isMaster) {
    // Master: center_configs 전체 센터 서브컬렉션 병렬 조회
    const centersSnap = await db.collection("center_configs").get();
    await Promise.all(
      centersSnap.docs.map(async (centerDoc) => {
        const snap = await centerDoc.ref.collection("facilities").get();
        snap.forEach((doc) => {
          locations[doc.id] = doc.data().fid_name || doc.id;
        });
      })
    );
  } else {
    const snap = await db
      .collection("center_configs")
      .doc(center)
      .collection("facilities")
      .get();
    snap.forEach((doc) => {
      locations[doc.id] = doc.data().fid_name || doc.id;
    });
  }
  return locations;
}

async function getFidLocations(center) {
  try {
    return await getOrBuild(`fidLocations:${center}`, () => fetchFidLocationsFromDb(center));
  } catch (e) {
    console.error("center_configs/facilities 조회 오류:", e);
    return {}; // 캐시 없이 즉시 반환 → 다음 요청이 재시도
  }
}

// ---------------------------------------------------------------------------
// fid → sheet_label 역매핑 함수
// center_configs/{center}/inspections 에서 fids 배열 읽어서 fid → sheet_label 매핑
// [수정] getFidLocations와 동일하게 실패 시 캐시하지 않음
// ---------------------------------------------------------------------------
async function fetchSheetLabelsFromDb(center) {
  const labels = {};
  const isMaster = center === MASTER_CENTER_NAME;

  const applySnap = (snap) => {
    snap.forEach((doc) => {
      const data = doc.data();
      const label = data.sheet_label || doc.id;
      const fids = Array.isArray(data.fids) ? data.fids : [];
      fids.forEach((fid) => {
        labels[String(fid).trim()] = label;
      });
    });
  };

  if (isMaster) {
    const centersSnap = await db.collection("center_configs").get();
    await Promise.all(
      centersSnap.docs.map(async (centerDoc) => {
        const snap = await centerDoc.ref.collection("inspections").get();
        applySnap(snap);
      })
    );
  } else {
    const snap = await db
      .collection("center_configs")
      .doc(center)
      .collection("inspections")
      .get();
    applySnap(snap);
  }
  return labels;
}

async function getSheetLabels(center) {
  try {
    return await getOrBuild(`sheetLabels:${center}`, () => fetchSheetLabelsFromDb(center));
  } catch (e) {
    console.error("sheetLabels 조회 오류:", e);
    return {};
  }
}

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

      const [logsSnap, { excelMap, excelListByFid }, fidLocations] = await Promise.all([
        logsQuery.get(),
        buildExcelData(center),
        getFidLocations(center),
      ]);

      // 점검 기록 가공
      // [수정] file_url 필드는 클라이언트에서 사용하지 않아 제거 (3번 뷰 아이콘은
      // excelMap[fid]만 사용). 레코드 수천 건일 때 페이로드가 눈에 띄게 줄어든다.
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

      const excelCountByFid = {};
      Object.keys(excelListByFid).forEach((fid) => {
        excelCountByFid[fid] = excelListByFid[fid].length;
      });

      // 설비별 엑셀 전체 목록은 /api/excel-files 페이지네이션 조회에서 재사용하도록
      // 별도 캐시 키로도 저장해둡니다 (동일 5분 TTL).
      setCache(`excelList:${center}`, excelListByFid);

      return {
        center,
        records,
        excelMap,
        excelCountByFid,
        fidLocations,
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
// GET /api/excel-files?center=XXX&fid=기계_01&page=1&pageSize=15   [인증 필수]
// - fid가 있으면: 해당 설비ID의 엑셀 보고서 전체 목록을 최신순으로 반환
// - fid가 없으면: 센터(또는 Master)의 "모든" 설비 엑셀 보고서를 합쳐 최신순으로 반환
//   (3번 뷰 헤더 "보고서" 클릭 시 사용 — 전체 설비 통합 목록)
// /api/dashboard와 동일한 5분 캐시(excelList:{center})를 재사용하므로
// 팝업을 여러 번 열어도 Firestore 추가 읽기가 거의 발생하지 않습니다.
// ---------------------------------------------------------------------------
app.get("/api/excel-files", authMiddleware, async (req, res) => {
  try {
    const center = resolveCenter(req);
    const fid = (req.query.fid || "").toString().trim(); // 비어있으면 "전체" 모드
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    // 캐시가 없으면(만료 또는 /api/dashboard를 아직 호출 안 한 경우) 직접 조회.
    // getOrBuild가 동시 요청을 1회 조회로 합쳐준다.
    const excelListByFid = await getOrBuild(`excelList:${center}`, async () => {
      const built = await buildExcelData(center);
      return built.excelListByFid;
    });

    let fullList;
    if (fid) {
      // 특정 설비ID 모드: 항목에 fid를 별도로 붙이지 않아도 이미 알고 있음
      fullList = (excelListByFid[fid] || []).map((item) => ({ ...item, fid }));
    } else {
      // 전체 모드: 모든 설비ID의 파일을 합쳐서 최신순 재정렬
      fullList = [];
      Object.keys(excelListByFid).forEach((f) => {
        excelListByFid[f].forEach((item) => fullList.push({ ...item, fid: f }));
      });
      fullList.sort((a, b) => {
        const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return tb - ta;
      });
    }

    const totalCount = fullList.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const items = fullList.slice(start, start + pageSize);

    return res.json({
      ok: true,
      fid: fid || null,
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
    cache.delete(`excelList:${center}`);
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
