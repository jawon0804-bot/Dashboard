// lib/facilities.js
// 설비ID -> 위치명 / sheet_label 매핑 조회 (center_configs 하위 컬렉션 기반)
const { db } = require("./firebase");
const { MASTER_CENTER_NAME } = require("../config/constants");
const { getOrBuild } = require("./cache");

// ---------------------------------------------------------------------------
// 설비ID -> 위치명 매핑 (center_configs/{center}/facilities 에서 동적으로 조회)
// 센터별 서브컬렉션: center_configs/{center}/facilities/{fid}
//   fid_name: 위치명, category: 카테고리, center_name: 센터명
// 결과는 메모리에 캐시 (CACHE_TTL_MS 동일 적용)
// [수정] 조회 실패 시 빈 객체를 "캐시하지 않고" 반환한다.
//        (기존에는 일시 오류 한 번에 빈 매핑이 5분간 굳어버렸음)
// ---------------------------------------------------------------------------
async function fetchFidLocationsFromDb(center) {
  const locations = {};
  const isMaster = center === MASTER_CENTER_NAME;

  if (isMaster) {
    // Master: center_configs 전체 센터 서브컬렉션 병렬 조회
    const centersSnap = await db.collection("center_configs").get();
    await Promise.all(
      centersSnap.docs.map(async (centerDoc) => {
        const snap = await centerDoc.ref.collection("facilities").get();
        snap.forEach((doc) => {
          locations[doc.id] = doc.data().fid_name || doc.id;
        });
      })
    );
  } else {
    const snap = await db
      .collection("center_configs")
      .doc(center)
      .collection("facilities")
      .get();
    snap.forEach((doc) => {
      locations[doc.id] = doc.data().fid_name || doc.id;
    });
  }
  return locations;
}

async function getFidLocations(center) {
  try {
    return await getOrBuild(`fidLocations:${center}`, () => fetchFidLocationsFromDb(center));
  } catch (e) {
    console.error("center_configs/facilities 조회 오류:", e);
    return {}; // 캐시 없이 즉시 반환 → 다음 요청이 재시도
  }
}

// ---------------------------------------------------------------------------
// fid → sheet_label 역매핑 함수
// center_configs/{center}/inspections 에서 fids 배열 읽어서 fid → sheet_label 매핑
// [수정] getFidLocations와 동일하게 실패 시 캐시하지 않음
// ---------------------------------------------------------------------------
async function fetchSheetLabelsFromDb(center) {
  const labels = {};
  const isMaster = center === MASTER_CENTER_NAME;

  const applySnap = (snap) => {
    snap.forEach((doc) => {
      const data = doc.data();
      const label = data.sheet_label || doc.id;
      const fids = Array.isArray(data.fids) ? data.fids : [];
      fids.forEach((fid) => {
        labels[String(fid).trim()] = label;
      });
    });
  };

  if (isMaster) {
    const centersSnap = await db.collection("center_configs").get();
    await Promise.all(
      centersSnap.docs.map(async (centerDoc) => {
        const snap = await centerDoc.ref.collection("inspections").get();
        applySnap(snap);
      })
    );
  } else {
    const snap = await db
      .collection("center_configs")
      .doc(center)
      .collection("inspections")
      .get();
    applySnap(snap);
  }
  return labels;
}

async function getSheetLabels(center) {
  try {
    return await getOrBuild(`sheetLabels:${center}`, () => fetchSheetLabelsFromDb(center));
  } catch (e) {
    console.error("sheetLabels 조회 오류:", e);
    return {};
  }
}

module.exports = { getFidLocations, getSheetLabels };
