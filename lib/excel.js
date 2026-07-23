// lib/excel.js
// GCS 버킷 핸들 공유 — events.js(사진 signed URL)와 reportFiles.js(이벤트 보고서 목록)가 재사용한다.
//
// [2026-07-23] 이 파일이 원래 갖고 있던 Maxerve_Excel(설비별 점검표) 조회 로직
// (buildExcelData/resolveFileUrl/extractCleanFileName)은 제거했다 — 대시보드의 대상이
// 내부 관리자에서 관리주체로 바뀌면서 3번 뷰의 "보고서" 팝업이 점검표 대신 m-event의
// 이벤트 보고서(lib/reportFiles.js, Storage report/{center}/*.xlsx)를 보여주는 것으로
// 완전히 대체됐고, buildExcelData를 부르는 곳이 서버에 더 이상 없었다(죽은 코드).
const { admin } = require("./firebase");
const { STORAGE_BUCKET_NAME } = require("../config/constants");

let _bucket = null;
function getBucket() {
  if (!_bucket) _bucket = admin.storage().bucket(STORAGE_BUCKET_NAME);
  return _bucket;
}

module.exports = { getBucket };
