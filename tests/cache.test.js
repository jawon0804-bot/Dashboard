// tests/cache.test.js
// 캐시는 ① 스탬피드 방지(동시 요청 1회 조회) ② 실패 시 미캐싱 ③ 항목 수 상한
// 세 가지가 핵심이다. 특히 ③은 무인증 /api/fidlocations로 임의의 키가 들어올 수
// 있어서(= 인스턴스 메모리 고갈 경로) 회귀 테스트로 고정해 둔다.
const test = require("node:test");
const assert = require("node:assert");

const { cache, getCache, setCache, getOrBuild } = require("../lib/cache");
const { CACHE_TTL_MS, MAX_CACHE_ENTRIES } = require("../config/constants");

test("setCache/getCache 왕복", (t) => {
  cache.clear();
  setCache("k", { a: 1 });
  assert.deepStrictEqual(getCache("k"), { a: 1 });
  assert.strictEqual(getCache("없는키"), null);
});

test("TTL이 지나면 만료된다", () => {
  cache.clear();
  const realNow = Date.now;
  try {
    setCache("k", "v");
    Date.now = () => realNow() + CACHE_TTL_MS + 1;
    assert.strictEqual(getCache("k"), null);
  } finally {
    Date.now = realNow;
  }
});

test("항목 수가 상한을 넘지 않는다 (임의 키 주입 방어)", () => {
  cache.clear();
  for (let i = 0; i < MAX_CACHE_ENTRIES * 2; i++) {
    setCache(`fidLocations:임의센터${i}`, {});
  }
  assert.ok(
    cache.size <= MAX_CACHE_ENTRIES,
    `상한 ${MAX_CACHE_ENTRIES}를 넘음: ${cache.size}`
  );
});

test("같은 키를 갱신하는 건 항목 수를 늘리지 않는다", () => {
  cache.clear();
  for (let i = 0; i < 100; i++) setCache("같은키", i);
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(getCache("같은키"), 99);
});

test("getOrBuild: 동시 요청이 몰려도 builder는 1번만 실행된다", async () => {
  cache.clear();
  let calls = 0;
  const builder = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return "결과";
  };

  const results = await Promise.all([
    getOrBuild("k", builder),
    getOrBuild("k", builder),
    getOrBuild("k", builder),
  ]);

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(results, ["결과", "결과", "결과"]);
});

test("getOrBuild: builder가 throw하면 캐시하지 않고 다음 요청이 재시도한다", async () => {
  cache.clear();
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("조회 실패");
  };

  await assert.rejects(() => getOrBuild("k", failing));
  assert.strictEqual(getCache("k"), null, "실패 결과가 캐시되면 안 된다");

  await assert.rejects(() => getOrBuild("k", failing));
  assert.strictEqual(calls, 2, "다음 요청이 실제로 재시도해야 한다");
});
