// config/constants.js
// 여러 lib 모듈에서 공유하는 설정값 모음.
module.exports = {
  // "Master" 센터로 로그인하면 모든 센터의 데이터를 통합해서 봅니다.
  MASTER_CENTER_NAME: "Master",

  // inspection_logs(점검기록)는 최근 60일치만 조회합니다. (엑셀 보고서는 전체 유지)
  INSPECTION_LOGS_LOOKBACK_DAYS: 60,

  // [2026-07-27] 쿼리 단계 상한(문서 수).
  // Master는 전 센터 60일치를 읽으므로 센터 수에 비례해 읽기량이 무한정 커진다.
  // orderBy(datetime desc) + limit으로 **Firestore 읽기 자체**를 자른다 —
  // 최신 것부터 남으므로 잘려도 "최근 데이터"는 온전하다.
  //   · 비-Master: center_name== + datetime>= + orderBy(datetime desc)
  //     → 복합 인덱스 (center_name ASC, datetime DESC) 필요. **이미 READY**(CICAgJjmnIgK)
  //   · Master: datetime>= + orderBy(datetime desc)
  //     → 정렬/범위가 같은 단일 필드라 자동 생성되는 단일 필드 인덱스로 처리됨
  // ⚠️ 이 쿼리 형태를 바꿀 땐 위 인덱스부터 확인할 것 (없으면 조용히 실패한다)
  INSPECTION_LOGS_QUERY_LIMIT: 20000,

  // 응답에 담을 레코드 상한(2차 방어).
  // 문서 1건이 facility_id 배열만큼 레코드로 펼쳐지므로, 문서 수를 제한해도
  // 레코드 수는 그보다 커질 수 있다. 넘치면 최신 날짜부터 남긴다.
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
