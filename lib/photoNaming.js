// lib/photoNaming.js
// 이벤트 사진의 "photos 필드가 비어 있을 때 Storage 경로를 추측하는" 규칙.
//
// ⚠️ 이 규칙은 **3개 구현이 중복 존재**한다 (system_map.md 4번 체크리스트 참고).
//   1. m-event  manager/js/events-tab.js       loadEventPhotos()      (브라우저, getDownloadURL)
//   2. m-event  functions/lib/report-export.js resolvePhotoBuffers()  (Admin SDK, download)
//   3. 이 파일 + lib/events.js                  getEventPhotos()       (Admin SDK, signed URL)
// 파일명 규칙이 바뀌면 3곳을 전부 고칠 것.
//
// GCP SDK 의존성이 없는 순수 함수만 둔다 — tests/에서 자격증명 없이 돌리기 위함.

// 이벤트 1건당 표시할 사진 최대 장수 (m-event의 Math.min(count,3)과 동일)
const MAX_PHOTOS = 3;

// photo_count는 **"3장"(문자열)과 3(숫자)이 섞여** 저장된다.
// m-event가 inspection_logs → events로 값을 옮길 때 형식을 통일하지 않고 그대로
// 통과시키기 때문 (m-event functions/lib/events.js의 주석에 명시되어 있음).
// 그래서 읽는 쪽이 둘 다 처리해야 한다 — Number("3장")은 NaN이라, 단순 Number()
// 변환을 쓰면 문자열로 저장된 기록의 사진을 통째로 놓친다(실제로 그랬음).
// m-event의 toCount()/parseInt와 동일하게 숫자만 남기고 파싱한다.
function parsePhotoCount(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (!digits) return 0;
  const n = parseInt(digits, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

// `{YYYYMMDD}_{HHmm}_{facility_id}_{순번}.jpg`
// ⚠️ datetime은 "2026-07-27 14:30"(공백 구분) 형식을 전제로 한다.
//
// ⚠️⚠️ [2026-07-29 수정 — 정본은 M-SMART다]
//   여기 있던 fid 정규화는 `replace(/\s/g, "_")`(공백을 밑줄로 치환)였다. m-event의
//   두 구현도 똑같아서 "3곳이 일치한다"고 관리되고 있었는데, **정작 파일을 실제로
//   쓰는 M-SMART와는 달랐다.**
//     M-SMART/public/js/submit.js: cleanFid = safeFid.replace(/[/\\?%*:|"<>\s]/g, "")
//   M-SMART는 공백을 **밑줄로 바꾸는 게 아니라 지우고**, 파일명에 쓸 수 없는 특수문자
//   (/ \ ? % * : | " < >)도 함께 지운다. 즉 설비ID에 공백이나 그 문자가 하나라도
//   있으면 소비자 3곳 전부가 없는 경로를 찾게 된다(사진이 0장으로 표시됨).
//   현재 운용 중인 `기계_35`/`전기_01` 형태에는 증상이 안 나타나지만, 공백 있는
//   설비ID가 하나 생기는 순간 조용히 깨지는 종류의 불일치다.
//
//   → 읽는 쪽 3곳을 M-SMART(쓰는 쪽)에 맞춘다. 반대로 M-SMART를 바꾸면 이미
//     올라간 파일들이 전부 안 잡히므로, 정본은 언제나 "쓰는 쪽"이어야 한다.
//   포맷을 바꿀 거면 M-SMART submit.js + 아래 3곳을 같이 바꿔야 한다.
const FID_UNSAFE_CHARS = /[/\\?%*:|"<>\s]/g;

function buildPhotoFileName(datetime, facilityId, index) {
  const dt = String(datetime ?? "").replace(/[-:\s]/g, "").slice(0, 12);
  const fid = String(facilityId ?? "").replace(FID_UNSAFE_CHARS, "");
  return `${dt.slice(0, 8)}_${dt.slice(8, 12)}_${fid}_${index}.jpg`;
}

// events 문서 → 추측한 Storage 경로 목록 (최대 MAX_PHOTOS개)
function buildPhotoPaths(data) {
  const count = Math.min(parsePhotoCount(data.photo_count), MAX_PHOTOS);
  if (count === 0) return [];
  const center = String(data.center_name ?? "");
  return Array.from({ length: count }, (_, i) =>
    `inspection_photos/${center}/${buildPhotoFileName(data.datetime, data.facility_id, i + 1)}`
  );
}

// photos 필드(콤마 구분 URL). 값이 있으면 Storage 추측 없이 이걸 그대로 쓴다.
function parsePhotosField(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  MAX_PHOTOS,
  FID_UNSAFE_CHARS,
  parsePhotoCount,
  buildPhotoFileName,
  buildPhotoPaths,
  parsePhotosField,
};
