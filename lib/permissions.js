// ==============================================================================
// lib/permissions.js — UserDB 권한 판정
//
// ⚠️⚠️ **이 파일은 m-event/functions/lib/permissions.js 와 같은 규칙의 사본이다.**
//   (M-Engine에도 lib/permissions.py로 파이썬 판본이 하나 더 있다 — 총 3벌)
//   세 저장소가 npm 패키지를 공유하지 않아서 물리적으로 합칠 수가 없다. 한쪽을
//   고치면 **반드시 나머지 둘도 같이 고칠 것.** 같은 코드베이스에서 월간 집계 로직이
//   이미 py/js 두 벌로 존재하다가 경계 불일치로 사고가 난 전례가 있다.
//
// ------------------------------------------------------------------------------
// [2026-08-01] 그전까지 `active: true` 하나가 세 가지를 겸했다:
//     ① 계정 활성  ② 관리자 권한  ③ 알림메일 수신
// 그중 Dashboard는 ②의 용도로 active를 쓰고 있었다 — server.js의 /api/login이
// `active !== true → 401`로 막았고, 이건 m-event/M-SMART엔 없는 Dashboard만의 조건이었다.
// 그래서 "메일을 받게 하려고 active를 켜면 Dashboard까지 열리는" 부작용이 있었다.
//
//     role         : 관리자 권한          ("admin" | "user")  ← Dashboard 접근은 이걸로
//     active       : 계정 활성(로그인 가부)  (true | false)
//     notify_email : 알림메일 수신 여부       (true | false)   ← Dashboard는 안 씀
//     center_name  : 데이터 범위            (센터명 | "Master")
//     grade        : 직급 — 표시용이며 권한과 무관하다. 읽지 말 것.
//
// [전환기 폴백] role이 없으면 예전 의미(active === true)로 판정한다.
//   UserDB 정본이 구글시트라서 코드 배포와 시트 백필이 원자적으로 같이 일어날 수 없다.
//   폴백이 없으면 배포가 백필보다 먼저 도착하는 순간 **Dashboard 로그인이 전원 막힌다.**
//   백필이 끝나면 hasRole()과 폴백 한 줄만 지우면 된다.
// ==============================================================================

const MASTER_CENTER_NAME = "Master";
const ROLE_ADMIN = "admin";
const ROLE_USER  = "user";

function hasRole(src) {
  return !!src && typeof src.role === "string" && src.role !== "";
}

/**
 * 관리자 권한 — Dashboard에서는 곧 "로그인 가능 여부"다.
 * ⚠️ Master는 자동 포함되지 않는다(범위와 권한을 분리하기 위해). Master 계정도
 *   Dashboard를 써야 하면 UserDB에 role:"admin"을 명시할 것.
 *   전환기에는 폴백이 active:true를 보고 그대로 통과시키므로 당장 동작은 안 바뀐다.
 */
function isAdmin(src) {
  if (!src) return false;
  if (hasRole(src)) return src.role === ROLE_ADMIN;
  return src.active === true;            // [전환기 폴백] — 백필 완료 후 제거
}

/** 데이터 범위가 전 센터인가 (조회 범위이지 권한이 아니다) */
function isMaster(src) {
  return !!src && src.center_name === MASTER_CENTER_NAME;
}

/**
 * 계정 활성 — 값이 없으면 활성으로 본다(fail-open).
 * 잘못 잠기면 현장이 멈추므로 차단은 active:false를 명시적으로 넣어서만 한다.
 */
function isActiveAccount(src) {
  return !!src && src.active !== false;
}

/**
 * Dashboard에 로그인할 수 있는가 — 활성 계정이면서 관리자일 것.
 *
 * 예전 조건(`active !== true → 401`)과 전환기 동안 결과가 같다:
 *   role 없음 + active:true  → 통과 (예전과 동일)
 *   role 없음 + active:false → 거부 (예전과 동일)
 *   role:"admin"             → 통과
 *   role:"user"              → 거부 — 현장 작업자는 여전히 못 들어온다
 */
function canAccessDashboard(src) {
  return isActiveAccount(src) && isAdmin(src);
}

module.exports = {
  MASTER_CENTER_NAME,
  ROLE_ADMIN,
  ROLE_USER,
  hasRole,
  isAdmin,
  isMaster,
  isActiveAccount,
  canAccessDashboard,
};
