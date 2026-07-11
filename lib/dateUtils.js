// lib/dateUtils.js
// [수정] inspection_logs.datetime 은 KST 기준 문자열이므로 룩백 경계일도
// KST 기준으로 계산한다. (기존 UTC 기준 계산은 최대 9시간 어긋남)
function getLookbackDateString(days) {
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  kstNow.setUTCDate(kstNow.getUTCDate() - days);
  return kstNow.toISOString().substring(0, 10); // "YYYY-MM-DD"
}

module.exports = { getLookbackDateString };
