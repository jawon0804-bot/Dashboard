// lib/cache.js
// 메모리 캐시 (인스턴스 단위, 5분 TTL)
// Cloud Run은 인스턴스가 여러 개 뜰 수 있어 완전한 전역 캐시는 아니지만,
// 최소 동시성(min-instances=1) 또는 단일 인스턴스 운영 시 읽기량이 크게 줄어듭니다.
const { CACHE_TTL_MS, MAX_CACHE_ENTRIES } = require("../config/constants");

const cache = new Map(); // key -> { data, expiresAt }

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

// ---------------------------------------------------------------------------
// 항목 수 상한 유지
// 만료 항목은 "같은 키를 다시 읽을 때"만 지워지므로, 한 번 쓰고 다시 안 읽히는
// 키(예: 무인증 /api/fidlocations에 들어온 임의의 center 문자열)는 그대로 눌러
// 앉는다 → 상한을 두고 넘치면 ① 만료된 것부터 ② 그래도 넘치면 가장 오래된
// 삽입 순서대로 비운다(Map은 삽입 순서를 보존).
// ---------------------------------------------------------------------------
function evictIfNeeded() {
  if (cache.size < MAX_CACHE_ENTRIES) return;

  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }

  for (const key of cache.keys()) {
    if (cache.size < MAX_CACHE_ENTRIES) break;
    cache.delete(key);
  }
}

function setCache(key, data) {
  // 갱신(이미 있는 키)이면 항목 수가 안 늘어나므로 정리도 불필요
  if (!cache.has(key)) evictIfNeeded();
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// 캐시 스탬피드 방지 헬퍼
// 캐시 만료 직후 동일 키로 요청이 동시에 몰려도 builder(Firestore 조회 +
// signed URL 대량 발급)는 딱 1번만 실행되고, 나머지 요청은 그 Promise를 공유한다.
// builder가 throw하면 아무것도 캐시하지 않으므로 다음 요청이 자연스럽게 재시도한다.
// ---------------------------------------------------------------------------
const inflight = new Map(); // key -> Promise

async function getOrBuild(key, builder) {
  const cached = getCache(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const data = await builder();
      setCache(key, data);
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { cache, getCache, setCache, getOrBuild };
