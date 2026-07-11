// lib/excel.js
// Maxerve_Excel 컬렉션 조회 + GCS signed URL 발급
const { admin, db } = require("./firebase");
const { EXCEL_COLLECTION, MASTER_CENTER_NAME, STORAGE_BUCKET_NAME } = require("../config/constants");

// ---------------------------------------------------------------------------
// GCS 버킷 핸들 + storage_path -> 다운로드 URL 즉석 발급
// Firestore 문서에 storage_path(신규, 만료 없는 경로)가 있으면 요청 시점마다
// 짧은 유효기간의 signed URL을 새로 발급한다 (응답 즉시 소비되므로 1시간이면 충분).
// storage_path가 없는 예전 문서는 저장돼 있던 file_url(만료됐을 수 있음)로 폴백.
// ---------------------------------------------------------------------------
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

module.exports = { getBucket, buildExcelData };
