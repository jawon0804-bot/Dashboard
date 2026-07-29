// tests/photoNaming.test.js
// 이벤트 사진 파일명/장수 규칙 회귀 테스트.
// 이 로직은 m-event에도 같은 규칙이 세 벌 더 있어서(lib/photoNaming.js 주석 참고)
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

// ─────────────────────────────────────────────────────────────
// [정본] M-SMART가 실제로 파일을 쓸 때 쓰는 규칙을 그대로 옮긴 것.
//   M-SMART/public/js/submit.js:
//     const cleanFid = safeFid.replace(/[/\\?%*:|"<>\s]/g, "");
//     fileName = `inspection_photos/${center}/${timeTag}_${cleanFid}_${i+1}.jpg`
// 읽는 쪽(이 저장소 + m-event 3곳)은 전부 이 규칙과 같아야 한다. 아래 테스트는
// "우리 구현이 이 정본과 일치하는가"를 검사한다 — 우리끼리만 일치하는 상태(2026-07-29
// 이전이 그랬다)를 통과시키지 않기 위함이다.
// ─────────────────────────────────────────────────────────────
function mSmartCleanFid(fid) {
  return String(fid).replace(/[/\\?%*:|"<>\s]/g, "");
}

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

test("buildPhotoFileName: 설비ID 정규화가 M-SMART(쓰는 쪽)와 일치한다 (회귀)", () => {
  // 2026-07-29 이전엔 여기서 공백을 밑줄로 바꿨고(`/\s/g,"_"`), m-event 구현 2곳도
  // 똑같아서 "3곳이 일치한다"고 관리되고 있었다. 그런데 정작 파일을 만드는 M-SMART는
  // 공백을 **지운다**. 즉 셋이 사이좋게 틀린 경로를 보고 있었다.
  // 아래는 우리 구현을 M-SMART 원본 규칙과 직접 대조한다.
  const cases = [
    "전기_02",        // 현재 운용 형태 — 영향 없음
    "전기 02",        // 공백: 예전엔 "전기_02"로 만들어 실제 파일과 어긋났다
    "기계  35",       // 공백 2개
    'A/B?C%D*E:F|G"H<I>J', // 파일명 금지문자 전체
    "순찰_02",
  ];
  for (const fid of cases) {
    const expected = `20260727_1430_${mSmartCleanFid(fid)}_1.jpg`;
    assert.strictEqual(
      buildPhotoFileName("2026-07-27 14:30", fid, 1),
      expected,
      `설비ID "${fid}"에서 M-SMART 규칙과 어긋남`
    );
  }
});

test("buildPhotoFileName: 공백은 지운다 (밑줄 치환이 아님)", () => {
  assert.strictEqual(
    buildPhotoFileName("2026-07-27 14:30", "전기 02", 2),
    "20260727_1430_전기02_2.jpg"
  );
});

test("buildPhotoFileName: datetime에 초가 있든 없든 같은 결과 (M-SMART는 초 없이 저장)", () => {
  // M-SMART submit.js의 dateTimeStr은 toLocaleString('sv-SE').substring(0,16) = 초 없음.
  // 과거 데이터에 초가 붙은 경우가 있어도 앞 12자리만 쓰므로 동일해야 한다.
  assert.strictEqual(
    buildPhotoFileName("2026-07-27 14:30", "전기_02", 1),
    buildPhotoFileName("2026-07-27 14:30:22", "전기_02", 1)
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
