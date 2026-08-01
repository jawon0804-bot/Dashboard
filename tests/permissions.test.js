// tests/permissions.test.js
// Dashboard 로그인 게이트(lib/permissions.js)를 고정한다.
//
// [왜 이 테스트가 있는가]
// 2026-08-01까지 /api/login이 `doc.data().active !== true → 401`로 막고 있었다.
// 그런데 active는 m-event/M-SMART에서 "계정 활성"과 "알림 수신"도 겸하던 필드라,
// **Dashboard만 그걸 관리자 여부의 뜻으로 쓰고 있었다.** "메일을 받게 하려고 active를
// 켜면 Dashboard까지 열리는" 부작용이 여기서 나왔다.
//
// role로 옮기면서 두 방향의 사고가 가능해졌고, 아래가 그 둘을 막는다:
//   ① 백필 전에 배포되면 → 폴백이 없으면 **관리자 전원이 로그인 불가**  → [2]번 그룹
//   ② 폴백을 너무 넓게 잡으면 → **현장 작업자 전원이 Dashboard에 로그인**  → [3]번 그룹
//
// ⚠️ 이 파일의 규칙은 m-event/functions/lib/permissions.js, M-Engine/lib/permissions.py와
//    **같은 규칙의 사본**이다. 셋 중 하나를 고치면 나머지도 같이 고칠 것.
const test = require("node:test");
const assert = require("node:assert");

const { isAdmin, isMaster, isActiveAccount, canAccessDashboard } = require("../lib/permissions");

const CENTER = "쿠팡울산2Sub-Hub";

test("[1] role이 있으면 role이 이긴다", () => {
  assert.strictEqual(canAccessDashboard({ role: "admin", active: true, center_name: CENTER }), true);
  assert.strictEqual(canAccessDashboard({ role: "user", active: true, center_name: CENTER }), false);
  // 축이 분리됐으므로 active는 '계정 활성'만 뜻한다 — 관리자면 로그인 자체는 가능해야 한다.
  assert.strictEqual(isAdmin({ role: "admin", active: false }), true);
});

test("[2] 전환기 폴백 — role 없는 문서는 예전 의미(active)로 판정한다", () => {
  // 이게 깨지면 시트 백필이 반영되기 전에 배포됐을 때 Dashboard 로그인이 통째로 막힌다.
  assert.strictEqual(canAccessDashboard({ active: true, center_name: CENTER }), true);
  assert.strictEqual(canAccessDashboard({ active: false, center_name: CENTER }), false);
  assert.strictEqual(canAccessDashboard({ role: "", active: true }), true, "빈 문자열은 '없음'으로 보고 폴백");
});

test("[3] 현장 작업자는 여전히 못 들어온다 (권한 상승 방지)", () => {
  // 백필로 전원이 active:true가 된 뒤에도 role:"user"면 막혀야 한다.
  // 여기가 뚫리면 M-SMART만 쓰던 사람들이 전부 관리 대시보드에 들어온다.
  assert.strictEqual(canAccessDashboard({ role: "user", active: true, center_name: CENTER }), false);
  assert.strictEqual(canAccessDashboard({ center_name: CENTER }), false, "role도 active도 없으면 거부");
  assert.strictEqual(canAccessDashboard({}), false);
});

test("[4] 비활성 계정(퇴사자)은 관리자여도 거부", () => {
  assert.strictEqual(canAccessDashboard({ role: "admin", active: false }), false);
  assert.strictEqual(isActiveAccount({ active: false }), false);
  // 값이 없으면 활성으로 본다(fail-open) — 잘못 잠기면 현장이 멈추므로 명시적 false만 인정.
  assert.strictEqual(isActiveAccount({}), true);
});

test("[5] Master는 데이터 범위이지 권한이 아니다", () => {
  assert.strictEqual(isMaster({ center_name: "Master" }), true);
  assert.strictEqual(isMaster({ center_name: CENTER }), false);
  // ⚠️ `|| isMaster`를 되살리면 "전 센터를 열람하되 관리는 안 하는 계정"이 표현 불가가 된다.
  assert.strictEqual(canAccessDashboard({ center_name: "Master", role: "user", active: true }), false);
  assert.strictEqual(canAccessDashboard({ center_name: "Master", role: "admin", active: true }), true);
  // 전환기 — 현재 운영 중인 Master 계정 2명이 이 상태(role 없음 + active:true)다.
  assert.strictEqual(canAccessDashboard({ center_name: "Master", active: true }), true);
});

test("[6] 잘못된 입력에 터지지 않는다", () => {
  assert.strictEqual(canAccessDashboard(null), false);
  assert.strictEqual(canAccessDashboard(undefined), false);
  assert.strictEqual(isAdmin(null), false);
  assert.strictEqual(isMaster(null), false);
});
