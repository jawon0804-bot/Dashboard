// lib/cache.js
// 메모리 캐시 (인스턴스 단위, 5분 TTL)
// Cloud Run은 인스턴스가 여러 개 뜰 수 있어 완전한 전역 캐시는 아니지만,
// 최소 동시성(min-instances=1) 또는 단일 인스턴스 운영 시 읽기량이 크게 줄어듭니다.
const { CACHE_TTL_MS } = require("../config/constants");

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

function setCache(key, data) {
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
