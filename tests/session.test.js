// tests/session.test.js
// HMAC 세션 토큰: 위조된 토큰이 통과하면 센터 격리(비-Master는 자기 센터만)가
// 통째로 무너지므로, 서명/만료 검증을 회귀 테스트로 고정한다.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

// lib/session.js는 모듈 로드 시점에 SESSION_SECRET을 읽으므로 require 전에 넣는다.
const SECRET = "test-secret-do-not-use-in-production";
process.env.SESSION_SECRET = SECRET;

const { signSession, verifySession, resolveCenter } = require("../lib/session");
const { MASTER_CENTER_NAME } = require("../config/constants");

function forge(payloadObj, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

test("정상 토큰은 center/uid를 그대로 복원한다", () => {
  const token = signSession("쿠팡울산2Sub-Hub", "user-123");
  const data = verifySession(token);
  assert.ok(data);
  assert.strictEqual(data.center, "쿠팡울산2Sub-Hub");
  assert.strictEqual(data.uid, "user-123");
});

test("uid 없이 발급된(구버전) 토큰도 계속 검증된다", () => {
  const token = forge({ center: "A", exp: Date.now() + 60000 });
  const data = verifySession(token);
  assert.ok(data);
  assert.strictEqual(data.center, "A");
});

test("payload를 바꾸면 거부된다 (센터 위조 차단)", () => {
  const token = signSession("일반센터", "u1");
  const [, sig] = token.split(".");
  const tampered = Buffer.from(JSON.stringify({ center: MASTER_CENTER_NAME, exp: Date.now() + 60000 }))
    .toString("base64url") + "." + sig;
  assert.strictEqual(verifySession(tampered), null);
});

test("다른 키로 서명한 토큰은 거부된다", () => {
  const token = forge({ center: MASTER_CENTER_NAME, exp: Date.now() + 60000 }, "wrong-secret");
  assert.strictEqual(verifySession(token), null);
});

test("만료된 토큰은 거부된다", () => {
  const token = forge({ center: "A", exp: Date.now() - 1 });
  assert.strictEqual(verifySession(token), null);
});

test("형식이 깨진 입력은 전부 null (throw하지 않는다)", () => {
  for (const bad of ["", "abc", "a.b", null, undefined, 123, "....", "eyJ.", ".sig"]) {
    assert.strictEqual(verifySession(bad), null, `입력: ${String(bad)}`);
  }
});

test("resolveCenter: 비-Master는 center 파라미터를 무시하고 자기 센터로 강제", () => {
  const req = { authCenter: "우리센터", query: { center: "남의센터" } };
  assert.strictEqual(resolveCenter(req), "우리센터");
});

test("resolveCenter: Master만 임의 센터 조회 가능, 미지정이면 Master(전체)", () => {
  assert.strictEqual(
    resolveCenter({ authCenter: MASTER_CENTER_NAME, query: { center: "남의센터" } }),
    "남의센터"
  );
  assert.strictEqual(
    resolveCenter({ authCenter: MASTER_CENTER_NAME, query: {} }),
    MASTER_CENTER_NAME
  );
});
