// tests/photoNaming.test.js
// 이벤트 사진 파일명/장수 규칙 회귀 테스트.
// 이 로직은 m-event에도 같은 규칙이 두 벌 더 있어서(lib/photoNaming.js 주석 참고)
// 한쪽만 어긋나면 "한쪽 화면에만 사진이 안 뜨는" 형태로 조용히 깨진다.
const test = require("node:test");
const assert = require("node:assert");

const {
  MAX_PHOTOS,
  parsePhotoCount,
  buildPhotoFileName,
  buildPhotoPaths,
  parsePhotosField,
} = require("../lib/photoNaming");

test("parsePhotoCount: 문자열 '3장' 형태를 숫자로 읽는다 (회귀)", () => {
  // 예전엔 Number(data.photo_count)를 썼는데 Number("3장")은 NaN이라
  // ||0으로 떨어져 사진이 통째로 0장이 됐다. m-event는 이 형식으로도 저장한다.
  assert.strictEqual(parsePhotoCount("3장"), 3);
  assert.strictEqual(parsePhotoCount("사진 2장"), 2);
  assert.strictEqual(Number.isNaN(Number("3장")), true, "전제 확인: Number()는 NaN이 맞다");
});

test("parsePhotoCount: 숫자/숫자문자열도 그대로 처리", () => {
  assert.strictEqual(parsePhotoCount(3), 3);
  assert.strictEqual(parsePhotoCount("3"), 3);
  assert.strictEqual(parsePhotoCount(10), 10);
});

test("parsePhotoCount: 값이 없거나 숫자가 없으면 0", () => {
  assert.strictEqual(parsePhotoCount(undefined), 0);
  assert.strictEqual(parsePhotoCount(null), 0);
  assert.strictEqual(parsePhotoCount(""), 0);
  assert.strictEqual(parsePhotoCount("없음"), 0);
  assert.strictEqual(parsePhotoCount(0), 0);
});

test("buildPhotoFileName: {YYYYMMDD}_{HHmm}_{fid}_{순번}.jpg", () => {
  assert.strictEqual(
    buildPhotoFileName("2026-07-27 14:30:22", "전기_02", 1),
    "20260727_1430_전기_02_1.jpg"
  );
});

test("buildPhotoFileName: 설비ID의 공백은 밑줄로 치환", () => {
  assert.strictEqual(
    buildPhotoFileName("2026-07-27 14:30:22", "전기 02", 2),
    "20260727_1430_전기_02_2.jpg"
  );
});

test("buildPhotoPaths: 센터 경로 + 장수만큼, MAX_PHOTOS로 상한", () => {
  const paths = buildPhotoPaths({
    photo_count: "5장",
    center_name: "쿠팡울산2Sub-Hub",
    datetime: "2026-07-27 14:30:22",
    facility_id: "전기_02",
  });
  assert.strictEqual(paths.length, MAX_PHOTOS);
  assert.strictEqual(
    paths[0],
    "inspection_photos/쿠팡울산2Sub-Hub/20260727_1430_전기_02_1.jpg"
  );
  assert.strictEqual(
    paths[MAX_PHOTOS - 1],
    `inspection_photos/쿠팡울산2Sub-Hub/20260727_1430_전기_02_${MAX_PHOTOS}.jpg`
  );
});

test("buildPhotoPaths: photo_count가 없으면 빈 배열 (Storage 조회 자체를 안 함)", () => {
  assert.deepStrictEqual(buildPhotoPaths({ center_name: "A", datetime: "2026-07-27 14:30:22" }), []);
  assert.deepStrictEqual(buildPhotoPaths({ photo_count: 0, center_name: "A" }), []);
});

test("parsePhotosField: 콤마 구분 + 공백/빈값 제거", () => {
  assert.deepStrictEqual(
    parsePhotosField("https://a/1.jpg, https://a/2.jpg ,,"),
    ["https://a/1.jpg", "https://a/2.jpg"]
  );
  assert.deepStrictEqual(parsePhotosField(""), []);
  assert.deepStrictEqual(parsePhotosField(undefined), []);
});
