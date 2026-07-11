// config/constants.js
// 여러 lib 모듈에서 공유하는 설정값 모음.
module.exports = {
  // "Master" 센터로 로그인하면 모든 센터의 데이터를 통합해서 봅니다.
  MASTER_CENTER_NAME: "Master",

  // 엑셀 보고서 단일 컬렉션. 센터별로 별도 컬렉션을 쓰던 방식(MaxerveUlsan_Excel 등)에서
  // Maxerve_Excel 하나로 통합하고 centerName 필드로 필터링합니다.
  EXCEL_COLLECTION: "Maxerve_Excel",

  // inspection_logs(점검기록)는 최근 60일치만 조회합니다. (엑셀 보고서는 전체 유지)
  INSPECTION_LOGS_LOOKBACK_DAYS: 60,

  STORAGE_BUCKET_NAME: "m-smart-90148.firebasestorage.app",

  // 메모리 캐시 TTL (인스턴스 단위, 5분)
  CACHE_TTL_MS: 5 * 60 * 1000,

  // 3번 뷰 이벤트 연동: 미해결 상태값 + 완료된 것도 같이 보여줄 기간(일)
  EVENT_OPEN_STATUSES: ["발생", "조치중"],
  EVENT_RECENT_LOOKBACK_DAYS: 30,
};
