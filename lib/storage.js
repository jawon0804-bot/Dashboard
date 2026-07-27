// lib/storage.js
// GCS 버킷 핸들 공유 — events.js(이벤트 사진 signed URL)와 reportFiles.js(이벤트
// 보고서 목록)가 재사용한다.
//
// [2026-07-23] 원래 lib/excel.js라는 이름으로 Maxerve_Excel(설비별 점검표) 조회
// 로직(buildExcelData/resolveFileUrl/extractCleanFileName)을 갖고 있었지만, 3번 뷰의
// "보고서" 팝업이 점검표 대신 m-event의 이벤트 보고서를 보여주는 것으로 완전히
// 대체되면서 그 로직은 전부 제거됐다.
// [2026-07-27] 남은 게 getBucket() 하나뿐인데 파일명만 excel.js로 남아 있어
// 오해를 부르므로 storage.js로 이름을 바로잡았다.
const { admin } = require("./firebase");
const { STORAGE_BUCKET_NAME } = require("../config/constants");

let _bucket = null;
function getBucket() {
  if (!_bucket) _bucket = admin.storage().bucket(STORAGE_BUCKET_NAME);
  return _bucket;
}

module.exports = { getBucket };
