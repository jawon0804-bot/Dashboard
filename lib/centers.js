// lib/centers.js
// settings/all_centers 문서의 centers 배열 = 이 시스템의 "존재하는 센터" 목록.
// (M-Engine의 스케줄 그룹, m-event의 Master 드롭다운과 같은 소스 — 신규 센터
//  추가 시 이 배열에 반드시 등록해야 한다. system_map.md 2번 참고)
//
// 용도 두 가지:
//   1. /api/centers — Master 계정의 센터 드롭다운
//   2. /api/fidlocations의 center 파라미터 검증 (아래 isKnownCenter 주석 참고)
const { db } = require("./firebase");
const { getOrBuild } = require("./cache");

const CENTER_LIST_CACHE_KEY = "centers:list";

async function getCenterList() {
  return getOrBuild(CENTER_LIST_CACHE_KEY, async () => {
    const doc = await db.collection("settings").doc("all_centers").get();
    const raw = doc.exists ? doc.data().centers || [] : [];
    return raw
      .filter((c) => typeof c === "string" && c.trim())
      .map((c) => c.trim())
      .sort((a, b) => a.localeCompare(b));
  });
}

// ---------------------------------------------------------------------------
// 무인증 엔드포인트(/api/fidlocations)에 들어온 center 값 검증.
//
// 이 검증이 필요한 이유: center 값이 캐시 키(`fidLocations:{center}`)와 Firestore
// 쿼리에 그대로 들어가므로, 검증이 없으면 인증 없이 임의의 문자열로 캐시 항목과
// Firestore 읽기를 무한정 유발할 수 있다.
//
// 단, 이 API는 m-event가 설비명 표시에 의존하는 **공유 엔드포인트**다
// (system_map.md 3번). 그래서 실패 시 fail-open으로 둔다:
//   - 목록 조회 자체가 실패하면 → 통과시킨다 (Firestore 일시 장애가 m-event의
//     설비명 표시까지 끌고 내려가지 않도록)
//   - 목록이 비어 있으면 → 통과시킨다 (settings 미설정 환경에서 잠기지 않도록)
// 즉 "정상적으로 목록을 읽었는데 그 안에 없는 센터"일 때만 거부한다.
// ---------------------------------------------------------------------------
async function isKnownCenter(center) {
  try {
    const centers = await getCenterList();
    if (centers.length === 0) return true;
    return centers.includes(center);
  } catch (e) {
    console.error("센터 목록 조회 실패 — center 검증을 건너뜁니다:", e);
    return true;
  }
}

module.exports = { getCenterList, isKnownCenter, CENTER_LIST_CACHE_KEY };
