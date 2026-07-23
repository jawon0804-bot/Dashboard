// lib/reportFiles.js
// [2026-07-23] m-event가 새로 만든 "이벤트 보고서"(report/{center}/*.xlsx, Storage) 목록 조회.
// 대시보드 대상이 내부 관리자에서 관리주체로 바뀌면서, 3번 뷰 "보고서" 팝업이 쓰던
// Maxerve_Excel(설비별 점검표) 조회 로직(구 buildExcelData)을 완전히 걷어내고 이걸로 대체했다.
//
// [성능] 목록(list)과 서명URL(signed URL) 발급을 분리한다:
//  - listReportFileMeta: getFiles() 결과에 이미 포함된 메타데이터만 씀(추가 API 호출 없음),
//    캐시(reportFiles:{center})로 재사용 가능
//  - signReportFileUrl: 페이지네이션으로 화면에 실제 보여줄 항목(최대 15개)에 대해서만
//    signed URL을 발급 — 파일이 몇 건이든 매 요청마다 "전체" 서명을 만들지 않는다
//    (서명URL 발급은 Cloud Run 기본 서비스계정에선 IAM signBlob 호출이라 건당 네트워크
//     왕복이 생김 — 페이지당 최대 15건으로 비용/지연을 제한하는 게 핵심)
const { getBucket } = require("./excel");
const { MASTER_CENTER_NAME } = require("../config/constants");

// getFiles()가 돌려주는 File 객체는 list 응답에 포함된 메타데이터(updated 등)를
// 이미 file.metadata에 갖고 있음 — 여기서 getMetadata()를 또 부르면 불필요한 API 호출.
async function listReportFileMeta(center) {
  const isMaster = center === MASTER_CENTER_NAME;
  const prefix = isMaster ? "report/" : `report/${center}/`;

  const [files] = await getBucket().getFiles({ prefix });
  const items = files
    .filter(f => f.name.endsWith(".xlsx"))
    .map(f => ({
      path: f.name,
      fileName: f.name.split("/").pop(),
      uploadedAt: f.metadata?.updated || f.metadata?.timeCreated || "",
    }));

  items.sort((a, b) => {
    const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return tb - ta;
  });
  return items;
}

async function signReportFileUrl(path) {
  const [url] = await getBucket().file(path).getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000, // 1시간
  });
  return url;
}

module.exports = { listReportFileMeta, signReportFileUrl };
