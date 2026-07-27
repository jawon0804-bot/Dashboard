// tests/dateUtils.test.js
// 60일 룩백 경계일은 KST 기준이어야 한다.
// inspection_logs.datetime이 KST 문자열이라, UTC로 계산하면 최대 9시간(=날짜 하루)
// 어긋나 하루치 기록이 통째로 빠지거나 더 들어온다.
const test = require("node:test");
const assert = require("node:assert");

const { getLookbackDateString } = require("../lib/dateUtils");

// Date.now를 고정해서 "UTC로는 어제, KST로는 오늘"인 순간을 재현한다.
// 2026-07-27T16:30:00Z = 2026-07-28 01:30 KST
function withFrozenNow(iso, fn) {
  const realNow = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    fn();
  } finally {
    Date.now = realNow;
  }
}

test("days=0이면 UTC 날짜가 아니라 KST 날짜를 돌려준다 (회귀)", () => {
  withFrozenNow("2026-07-27T16:30:00Z", () => {
    assert.strictEqual(getLookbackDateString(0), "2026-07-28");
  });
});

test("days만큼 과거로 간다 (KST 기준)", () => {
  withFrozenNow("2026-07-27T16:30:00Z", () => {
    assert.strictEqual(getLookbackDateString(60), "2026-05-29");
  });
});

test("월/연 경계를 넘어도 정상 (윤년 2월 포함)", () => {
  // 2028-03-01 09:00 KST → 60일 전
  withFrozenNow("2028-03-01T00:00:00Z", () => {
    assert.strictEqual(getLookbackDateString(1), "2028-02-29"); // 2028은 윤년
  });
  withFrozenNow("2026-01-01T00:00:00Z", () => {
    assert.strictEqual(getLookbackDateString(1), "2025-12-31");
  });
});

test("항상 YYYY-MM-DD 형식", () => {
  assert.match(getLookbackDateString(60), /^\d{4}-\d{2}-\d{2}$/);
});
