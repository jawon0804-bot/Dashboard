// lib/events.js
// [2026-07-11 신규] 3번 뷰 - 이벤트(m-event) 조회
// events 컬렉션은 m-event가 쓰고 이 서버는 읽기만 한다 (Maxerve_Excel과 동일 패턴,
// 새 API/Function 없이 Admin SDK로 직접 조회).
// - 미해결(발생/조치중)은 기간 무관하게 항상 포함 (오래된 미해결 건도 놓치면 안 됨)
// - 완료된 것도 최근 EVENT_RECENT_LOOKBACK_DAYS일 이내면 같이 포함(초록색으로 구분 표시) —
//   그렇지 않으면 관리자가 안 보는 사이에 발생→완료까지 다 끝난 이슈를 영영 놓치게 됨
// 사진: events.photos(콤마구분 URL)가 있으면 그대로 쓰고, 없으면 m-event 클라이언트의
// loadEventPhotos() 파일명 패턴을 이식해 Storage에서 signed URL을 직접 발급.
//
// ⚠️ 사진 파일명 추측 규칙(resolveEventPhotoUrls)은 m-event의
// manager/index.html에 있는 loadEventPhotos()와 동일한 로직이 두 저장소에
// 중복 구현되어 있다. 파일명 규칙이 바뀌면 두 곳 다 고칠 것 (system_map.md 참고).
const { admin, db } = require("./firebase");
const { MASTER_CENTER_NAME, EVENT_OPEN_STATUSES, EVENT_RECENT_LOOKBACK_DAYS } = require("../config/constants");
const { getBucket } = require("./excel");

async function resolveEventPhotoUrls(data) {
  const fromField = String(data.photos || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromField.length > 0) return fromField;

  const count = Math.min(Number(data.photo_count) || 0, 3);
  if (count === 0) return [];

  const dt = String(data.datetime || "").replace(/[-:\s]/g, "").slice(0, 12);
  const facilityId = String(data.facility_id || "").replace(/\s/g, "_");
  const urls = await Promise.all(
    Array.from({ length: count }, (_, i) => i + 1).map(async (i) => {
      const fileName = `${dt.slice(0, 8)}_${dt.slice(8, 12)}_${facilityId}_${i}.jpg`;
      try {
        const [url] = await getBucket()
          .file(`inspection_photos/${data.center_name}/${fileName}`)
          .getSignedUrl({ action: "read", expires: Date.now() + 60 * 60 * 1000 });
        return url;
      } catch (e) {
        return null; // 해당 번호 파일이 없을 수 있음 - m-event 클라이언트 로직도 개별 실패 허용
      }
    })
  );
  return urls.filter(Boolean);
}

async function docToEventItem(doc) {
  const data = doc.data();
  const photos = await resolveEventPhotoUrls(data);
  const history = Array.isArray(data.history)
    ? data.history.map((h) => ({
        type: h.type || "",
        content: h.content || "",
        by: h.by || "",
        at: h.at && h.at.toDate ? h.at.toDate().toISOString() : "",
      }))
    : [];

  return {
    id: doc.id,
    status: data.status || "",
    center_name: data.center_name || "",
    facility_id: data.facility_id || "",
    fid_name: data.fid_name || "",
    memo: data.memo || "",
    worker: data.worker || "",
    datetime: data.datetime || "",
    created_at: data.created_at && data.created_at.toDate ? data.created_at.toDate().toISOString() : "",
    history,
    photos,
  };
}

async function buildEventsData(center) {
  const isMaster = center === MASTER_CENTER_NAME;

  // 미해결(발생/조치중)은 기간 무관하게 항상 포함
  const openQuery = isMaster
    ? db.collection("events").where("status", "in", EVENT_OPEN_STATUSES)
    : db.collection("events").where("center_name", "==", center).where("status", "in", EVENT_OPEN_STATUSES);

  // 완료된 것도 최근 것은 같이 보여준다 (관리자가 안 보는 사이 발생→완료까지 끝난 이슈를
  // 영영 놓치지 않도록). center_name+created_at, center_name+status 복합 인덱스 필요
  // (2026-07-11에 gcloud firestore indexes composite create로 생성, system_map.md 참고).
  const cutoffTimestamp = admin.firestore.Timestamp.fromMillis(
    Date.now() - EVENT_RECENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const recentQuery = isMaster
    ? db.collection("events").where("created_at", ">=", cutoffTimestamp)
    : db.collection("events").where("center_name", "==", center).where("created_at", ">=", cutoffTimestamp);

  const [openSnap, recentSnap] = await Promise.all([openQuery.get(), recentQuery.get()]);

  const docsById = new Map();
  openSnap.docs.forEach((doc) => docsById.set(doc.id, doc));
  recentSnap.docs.forEach((doc) => {
    if (doc.data().status === "완료") docsById.set(doc.id, doc);
  });

  const eventsByFid = {};
  await Promise.all(
    Array.from(docsById.values()).map(async (doc) => {
      const firstFid = String(doc.data().facility_id || "").split(",")[0].trim();
      if (!firstFid) return;

      const item = await docToEventItem(doc);
      if (!eventsByFid[firstFid]) eventsByFid[firstFid] = [];
      eventsByFid[firstFid].push(item);
    })
  );

  // 같은 설비 안에서도 발생 > 조치중 > 완료 순으로, 동순위면 최신순
  const STATUS_ORDER = { 발생: 0, 조치중: 1, 완료: 2 };
  Object.keys(eventsByFid).forEach((fid) => {
    eventsByFid[fid].sort((a, b) => {
      const diff = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
      return diff !== 0 ? diff : (b.created_at || "").localeCompare(a.created_at || "");
    });
  });

  return eventsByFid;
}

module.exports = { buildEventsData };
