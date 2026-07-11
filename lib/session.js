// lib/session.js
// [신규] 세션 토큰 (HMAC-SHA256 서명)
// - 로그인 성공 시 { center, exp } 를 서명해 발급
// - 이후 API 호출은 Authorization: Bearer <token> 헤더 필수
// - Cloud Run 환경변수 SESSION_SECRET 을 반드시 설정할 것.
//   미설정 시 임시 난수 키로 기동하지만, 인스턴스 재시작/스케일아웃 때마다
//   기존 세션이 전부 무효화되므로 운영 환경에서는 꼭 고정 키를 지정한다.
//   예) gcloud run deploy ... --set-env-vars SESSION_SECRET=$(openssl rand -hex 32)
const crypto = require("crypto");
const { MASTER_CENTER_NAME } = require("../config/constants");

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (() => {
    console.warn(
      "[경고] SESSION_SECRET 환경변수가 없어 임시 난수 키로 기동합니다. " +
        "인스턴스 재시작 시 전체 재로그인이 필요하니 Cloud Run 환경변수로 설정하세요."
    );
    return crypto.randomBytes(32).toString("hex");
  })();

// 12시간 → 4시간. 토큰에 폐기(로그아웃) 수단이 없어서
// 탈취당했을 때 유효한 시간을 줄이는 쪽으로 대응. Firestore 조회를 늘리는
// 실시간 폐기 목록 방식은 이 서버의 "읽기 최소화" 설계 방향과 맞지 않아 보류.
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4시간

function signSession(center) {
  const payload = Buffer.from(
    JSON.stringify({ center, exp: Date.now() + TOKEN_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.center || typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data; // { center, exp }
  } catch (e) {
    return null;
  }
}

// 인증 미들웨어: 토큰 검증 후 req.authCenter 에 로그인 신원(센터)을 심는다.
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = verifySession(token);
  if (!session) {
    return res.status(401).json({ ok: false, message: "세션이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요." });
  }
  req.authCenter = session.center;
  next();
}

// 조회 대상 센터 결정: Master 로그인만 임의의 center 파라미터 허용,
// 일반 계정은 파라미터를 무시하고 자기 센터로 강제한다.
function resolveCenter(req) {
  const requested = (req.query.center || "").toString().trim();
  if (req.authCenter === MASTER_CENTER_NAME) {
    return requested || MASTER_CENTER_NAME;
  }
  return req.authCenter;
}

module.exports = { signSession, verifySession, authMiddleware, resolveCenter };
