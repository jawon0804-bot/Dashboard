// server.js
// Cloud Run에서 실행되는 백엔드 API 서버
// - Firestore 읽기를 이 서버 한 곳으로 집중시켜 클라이언트 직접 호출을 제거
// - center(현장) 단위로 5분 캐시를 두어 동일 데이터 반복 조회를 방지
// - 로그인(이름+전화번호) 인증도 서버에서 처리

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
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

function getLookbackDateString(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().substring(0, 10); // "YYYY-MM-DD"
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

    // 너무 길거나(40자 이상) 확장자가 없으면 알아보기 힘든 토큰일 가능성이 높음 -> 기본 이름 사용
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
    : db.collection(EXCEL_COLLECTION).where("centerName", "==", center);

  const excelSnap = await excelQuery.get();

  excelSnap.forEach((doc) => {
    const data = doc.data();
    if (!data.facilityId || !data.file_url) return;

    let fidList = [];
    if (Array.isArray(data.facilityId)) {
      fidList = data.facilityId;
    } else if (typeof data.facilityId === "string") {
      fidList = data.facilityId.split(",").map((s) => s.trim());
    } else {
      fidList = [String(data.facilityId)];
    }
    fidList.sort((a, b) => a.localeCompare(b));

    if (fidList.length === 0) return;

    const primaryFid = fidList[0];
    const uploadedAt =
      data.uploadedAt || data.createdAt || data.datetime || (doc.createTime ? doc.createTime.toDate().toISOString() : "");

    const cleanFid = String(primaryFid).trim();
    if (!excelListByFid[cleanFid]) excelListByFid[cleanFid] = [];
    excelListByFid[cleanFid].push({
      docId: doc.id,
      file_url: data.file_url,
      fileName: data.fileName || data.file_name || extractCleanFileName(data.file_url, uploadedAt),
      uploadedAt,
    });
  });

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
// 설비ID -> 위치명 매핑 (기존 HTML에 하드코딩되어 있던 것을 서버로 이동)
// 다른 팀이 UI만 바꾸더라도 이 매핑 로직은 그대로 서버에서 응답에 포함되므로
// 프론트는 이 데이터를 몰라도 됩니다.
// ---------------------------------------------------------------------------
const FID_LOCATIONS = {
  "전기_01": "수변전일지_모니터링PC", "전기_02": "수변전일지_전기실", "전기_03": "수변전설비_특고압부",
  "전기_04": "수변전설비_저압부", "전기_05": "수변전설비_발전설비",
  "소방_01": "1F_1구역_소화기", "소방_02": "1F_2구역_가스계 소화기",
  "소방_05": "1F_1구역_옥내소화전", "소방_06": "1F_2구역_옥외소화전",
  "소방_07": "3F_A구역_방화셔터", "소방_08": "3F_B구역_스프링클러", "소방_10": "3F_C구역_화재감지기",
  "순찰_01": "외곽 선로", "순찰_02": "옥상 공조실 주행",
  "기계_01": "OHD1F_1A01", "기계_02": "OHD1F_1A02", "기계_03": "OHD1F_1A03", "기계_04": "OHD1F_1A04",
  "기계_05": "OHD1F_1A05", "기계_06": "OHD1F_1A06", "기계_07": "OHD1F_1A07", "기계_08": "OHD1F_1A08",
  "기계_09": "OHD3F_3A01", "기계_10": "OHD3F_3A02", "기계_11": "OHD3F_3A03", "기계_12": "OHD3F_3A04",
  "기계_13": "OHD3F_3A05", "기계_14": "OHD3F_3A06", "기계_15": "OHD3F_3A07", "기계_16": "OHD3F_3A08",
  "기계_17": "OHD3F_3A09", "기계_18": "OHD3F_3A10",
  "기계_19": "도크레벨러1F_1_1A02", "기계_20": "도크레벨러1F_2_1A03", "기계_21": "도크레벨러1F_3_1A04",
  "기계_22": "도크레벨러1F_4_1A05", "기계_23": "도크레벨러1F_5_1A06", "기계_24": "도크레벨러1F_6_1A07",
  "기계_25": "도크레벨러3F_7_3A02", "기계_26": "도크레벨러3F_8_3A03", "기계_27": "도크레벨러3F_9_3A04",
  "기계_28": "도크레벨러3F_10_3A05", "기계_29": "도크레벨러3F_11_3A06", "기계_30": "도크레벨러3F_12_3A07",
  "기계_31": "도크레벨러3F_13_3A08", "기계_32": "도크레벨러3F_14_3A09",
  "기계_33": "도크레벨러3F_15_3A10", "기계_34": "도크레벨러3F_16_3A11",
  "기계_35": "승강기_1호", "기계_36": "승강기_2호", "기계_37": "승강기_3호",
  "기계_38": "승강기_1호(기계실)", "기계_39": "승강기_2호(기계실)", "기계_40": "승강기_3호(기계실)",
  "기계_41": "집수정펌프_기계실2EA", "기계_42": "집수정펌프_2Core_PIT_2EA", "기계_43": "집수정펌프_3Core_PIT_2EA",
  "기계_44": "집수정펌프_전기실_DA_2EA", "기계_45": "집수정펌프_1Core_ELEV_PIT_1EA",
  "기계_46": "집수정펌프_2Core_PIT_오배수_1SET", "기계_47": "집수정펌프_3Core_PIT_오배수_1SET",
  "기계_48": "부스터펌프_상수공급펌프", "기계_49": "부스터펌프_저수조공급펌프",
  "기계_50": "오수정화설비_2Core_PIT", "기계_51": "오수정화설비_3Core_PIT",
  "기계_52": "저수조설비_기계실", "기계_53": "배기팬_1호_2Core", "기계_54": "배기팬_2호_3Core",
};

// ---------------------------------------------------------------------------
// POST /api/login
// 기존 클라이언트의 UserDB 조회(이름+전화번호) 로직을 서버로 이전
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ ok: false, message: "이름과 전화번호를 모두 입력해주세요." });
    }

    const snapshot = await db
      .collection("UserDB")
      .where("name", "==", name)
      .where("phone", "==", phone)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({ ok: false, message: "인증 실패: 등록되지 않은 사용자이거나 정보가 일치하지 않습니다." });
    }

    const userData = snapshot.docs[0].data();

    // active 필드가 명시적으로 true인 계정만 로그인 허용
    // false이거나 필드가 없으면 차단 (Firebase 콘솔에서 active: true/false로 관리)
    if (userData.active !== true) {
      return res.status(403).json({ ok: false, message: "접근이 제한된 계정입니다. 관리자에게 문의하세요." });
    }

    return res.json({ ok: true, center: userData.center || "" });
  } catch (err) {
    console.error("로그인 처리 오류:", err);
    return res.status(500).json({ ok: false, message: "서버 연결에 문제가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard?center=XXX
// 기존 loadDashboardData()의 Firestore 조회 + 가공 로직을 서버로 이전
// center 단위로 5분 캐시 적용 → 동일 현장에서 새로고침을 반복해도
// Firestore 실제 읽기는 5분에 한 번만 발생
// ---------------------------------------------------------------------------
app.get("/api/dashboard", async (req, res) => {
  try {
    const center = (req.query.center || "").toString().trim();
    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    const cacheKey = `dashboard:${center}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ ok: true, cached: true, ...cached });
    }

    const isMaster = center === MASTER_CENTER_NAME;
    const lookbackDate = getLookbackDateString(INSPECTION_LOGS_LOOKBACK_DAYS);

    // inspection_logs: 최근 60일치만 조회 (datetime은 ISO 문자열이라 사전식 비교 = 시간순 비교와 동일)
    // Master는 centerName 필터 없이 전체 센터를 60일 리밋만 걸어서 조회
    const logsQuery = isMaster
      ? db.collection("inspection_logs").where("datetime", ">=", lookbackDate)
      : db.collection("inspection_logs").where("centerName", "==", center).where("datetime", ">=", lookbackDate);

    // 엑셀 보고서: 리밋 없이 전체. Master는 등록된 모든 센터 컬렉션을 병렬 조회 후 합산
    const [logsSnap, { excelMap, excelListByFid }] = await Promise.all([
      logsQuery.get(),
      buildExcelData(center),
    ]);

    // 점검 기록 가공
    const records = [];
    logsSnap.forEach((doc) => {
      const data = doc.data();
      const fids = Array.isArray(data.facilityId) ? data.facilityId : [data.facilityId || "알수없음"];

      const firstFid = fids[0] ? String(fids[0]).trim() : "";
      const linkForThisRecord = excelMap[firstFid] || "";

      fids.forEach((fid, index) => {
        const cleanFid = fid ? String(fid).trim() : "알수없음";
        records.push({
          date: data.datetime ? data.datetime.substring(0, 10) : "",
          inspector: data.worker || "미지정",
          fid: cleanFid,
          file_url: index === 0 ? linkForThisRecord : "",
        });
      });
    });

    const excelCountByFid = {};
    Object.keys(excelListByFid).forEach((fid) => {
      excelCountByFid[fid] = excelListByFid[fid].length;
    });

    const payload = {
      center,
      records,
      excelMap,
      excelCountByFid,
      fidLocations: FID_LOCATIONS,
      generatedAt: new Date().toISOString(),
    };

    setCache(cacheKey, payload);
    // 설비별 엑셀 전체 목록은 /api/excel-files 페이지네이션 조회에서 재사용하도록
    // 별도 캐시 키로도 저장해둡니다 (동일 5분 TTL).
    setCache(`excelList:${center}`, excelListByFid);

    return res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    console.error("대시보드 데이터 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "데이터 조회 중 오류가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/excel-files?center=XXX&fid=기계_01&page=1&pageSize=15
// - fid가 있으면: 해당 설비ID의 엑셀 보고서 전체 목록을 최신순으로 반환
// - fid가 없으면: 센터(또는 Master)의 "모든" 설비 엑셀 보고서를 합쳐 최신순으로 반환
//   (3번 뷰 헤더 "보고서" 클릭 시 사용 — 전체 설비 통합 목록)
// /api/dashboard와 동일한 5분 캐시(excelList:{center})를 재사용하므로
// 팝업을 여러 번 열어도 Firestore 추가 읽기가 거의 발생하지 않습니다.
// ---------------------------------------------------------------------------
app.get("/api/excel-files", async (req, res) => {
  try {
    const center = (req.query.center || "").toString().trim();
    const fid = (req.query.fid || "").toString().trim(); // 비어있으면 "전체" 모드
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    const listCacheKey = `excelList:${center}`;
    let excelListByFid = getCache(listCacheKey);

    if (!excelListByFid) {
      // 캐시가 없으면(만료 또는 /api/dashboard를 아직 호출 안 한 경우) 직접 조회
      const built = await buildExcelData(center);
      excelListByFid = built.excelListByFid;
      setCache(listCacheKey, excelListByFid);
    }

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
app.post("/api/dashboard/refresh", (req, res) => {
  const center = (req.query.center || "").toString().trim();
  if (center) {
    cache.delete(`dashboard:${center}`);
    cache.delete(`excelList:${center}`);
  } else {
    cache.clear();
  }
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
