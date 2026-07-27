// config/constants.js
// 여러 lib 모듈에서 공유하는 설정값 모음.
module.exports = {
  // "Master" 센터로 로그인하면 모든 센터의 데이터를 통합해서 봅니다.
  MASTER_CENTER_NAME: "Master",

  // inspection_logs(점검기록)는 최근 60일치만 조회합니다. (엑셀 보고서는 전체 유지)
  INSPECTION_LOGS_LOOKBACK_DAYS: 60,

  // 한 번의 /api/dashboard 응답에 담을 점검기록(레코드) 상한.
  // Master는 전 센터 60일치를 필터 없이 읽으므로 센터 수에 비례해 응답이 무한정
  // 커진다 — 상한을 넘으면 최신 것부터 잘라내고 응답에 truncated:true를 실어
  // "조용히 일부만 보여주는" 상태가 되지 않게 한다.
  // ⚠️ 이건 응답/메모리 방어일 뿐 Firestore 읽기량은 줄이지 않는다.
  //    쿼리 단계에서 자르려면 orderBy(datetime desc)+limit이 필요하고
  //    그건 inspection_logs 복합 인덱스가 선행되어야 한다 (README 참고).
  INSPECTION_LOGS_MAX_RECORDS: 50000,

  STORAGE_BUCKET_NAME: "m-smart-90148.firebasestorage.app",

  // 메모리 캐시 TTL (인스턴스 단위, 5분)
  CACHE_TTL_MS: 5 * 60 * 1000,

  // 캐시 항목 수 상한.
  // 키에 center 값이 그대로 들어가는데 /api/fidlocations는 무인증이라,
  // 상한이 없으면 임의의 center 문자열로 항목을 무한히 쌓아 인스턴스 메모리를
  // 고갈시킬 수 있다 (만료 항목은 같은 키를 "다시 읽을 때"만 지워지므로
  // 한 번 쓰고 버려진 키는 영원히 남는다).
  MAX_CACHE_ENTRIES: 500,

  // 3번 뷰 이벤트 연동: 미해결 상태값 + 완료된 것도 같이 보여줄 기간(일)
  EVENT_OPEN_STATUSES: ["발생", "조치중"],
  EVENT_RECENT_LOOKBACK_DAYS: 30,

  // 이벤트 사진 signed URL 유효기간
  EVENT_PHOTO_URL_TTL_MS: 60 * 60 * 1000, // 1시간
};
