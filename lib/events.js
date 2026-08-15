// lib/events.js
// [2026-07-11 신규] 3번 뷰 - 이벤트(m-event) 조회
// events 컬렉션은 m-event가 쓰고 이 서버는 읽기만 한다 (새 API/Function 없이
// Admin SDK로 직접 조회).
// - 미해결(발생/진행중)은 기간 무관하게 항상 포함 (오래된 미해결 건도 놓치면 안 됨)
// - 완료된 것도 최근 EVENT_RECENT_LOOKBACK_DAYS일 이내면 같이 포함(초록색으로 구분 표시) —
//   그렇지 않으면 관리자가 안 보는 사이에 발생→완료까지 다 끝난 이슈를 영영 놓치게 됨
//
// [2026-07-27] 사진 처리 방식 변경:
//   예전엔 buildEventsData()가 모든 이벤트의 사진 signed URL을 **미리** 발급했다.
//   Cloud Run 기본 서비스계정에서 서명은 IAM signBlob 네트워크 왕복이라, 이벤트가
//   N건이면 캐시 갱신마다 최대 3N회 호출이 발생한다 — 사용자가 팝업을 한 번도 안
//   열어도 전부 발급됐다. 이제 목록에는 photos 필드(이미 URL이라 서명 불필요)만
//   싣고, Storage 추측 경로 폴백은 팝업을 열 때 /api/event-photos로 그때 처리한다
//   (m-event의 loadEventPhotos()가 모달을 열 때 처리하는 것과 같은 구조).
const { admin, db } = require("./firebase");
const {
  MASTER_CENTER_NAME,
  EVENT_OPEN_STATUSES,
  EVENT_RECENT_LOOKBACK_DAYS,
  EVENT_PHOTO_URL_TTL_MS,
  MAX_COMPLETION_PHOTOS,
} = require("../config/constants");
const { getBucket } = require("./storage");
const { parsePhotosField, parsePhotoCount, buildPhotoPaths, MAX_PHOTOS } = require("./photoNaming");

function docToEventItem(doc) {
  const data = doc.data();
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
    // photos 필드가 있으면 그대로 (이미 다운로드 URL이라 서명 불필요).
    photos: parsePhotosField(data.photos),
    // photos가 비었을 때 "사진이 몇 장 있어야 하는지" — 프런트는 이 값이 0보다
    // 크면 팝업을 열 때 /api/event-photos를 호출해 Storage 폴백을 시도한다.
    photoCount: Math.min(parsePhotoCount(data.photo_count), MAX_PHOTOS),
    // [2026-08-15] 완료 사진 — m-event에서 관리자가 완료 처리하며 올린 증빙(최대 2장,
    // 이벤트 보고서의 완료사진 열로도 나간다). 점검 사진과 달리 **폴백이 필요 없다**:
    // 값이 이미 다운로드 URL이고, 파일명을 추측하는 경로 자체가 없기 때문이다
    // (m-event가 업로드 때 받은 URL을 문서에 저장한다).
    completionPhotos: Array.isArray(data.completion_photos)
      ? data.completion_photos.filter(Boolean).slice(0, MAX_COMPLETION_PHOTOS)
      : [],
  };
}

async function buildEventsData(center) {
  const isMaster = center === MASTER_CENTER_NAME;

  // 미해결(발생/진행중)은 기간 무관하게 항상 포함
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
  docsById.forEach((doc) => {
    const firstFid = String(doc.data().facility_id || "").split(",")[0].trim();
    if (!firstFid) return;

    if (!eventsByFid[firstFid]) eventsByFid[firstFid] = [];
    eventsByFid[firstFid].push(docToEventItem(doc));
  });

  // 같은 설비 안에서도 발생 > 진행중 > 완료 순으로, 동순위면 최신순
  // ("조치중"은 2026-08-14 이전 이름 — 옛 문서가 맨 뒤로 밀리지 않도록 같이 둔다)
  const STATUS_ORDER = { 발생: 0, 진행중: 1, 조치중: 1, 완료: 2 };
  Object.keys(eventsByFid).forEach((fid) => {
    eventsByFid[fid].sort((a, b) => {
      const diff = (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
      return diff !== 0 ? diff : (b.created_at || "").localeCompare(a.created_at || "");
    });
  });

  return eventsByFid;
}

// ---------------------------------------------------------------------------
// 이벤트 1건의 사진 URL 해석 (/api/event-photos 전용)
// m-event의 loadEventPhotos()와 동일한 2단계:
//   ① photos 필드(콤마구분 URL)가 있으면 그대로
//   ② 없으면 photo_count만큼 Storage 경로를 추측해 signed URL 발급
//
// ⚠️ getSignedUrl()은 **객체 존재 여부를 확인하지 않는다** — 없는 파일에 대해서도
//    정상적인 URL을 만들어 주기 때문에, 그대로 내보내면 프런트에서 깨진 이미지가
//    된다. m-event 클라이언트는 getDownloadURL()(없으면 object-not-found throw)을
//    써서 자연스럽게 걸러졌는데, 이식하면서 그 성질이 사라졌었다.
//    → exists()로 먼저 확인하고 있는 것만 서명한다.
//
// 반환 null = 문서 없음 또는 다른 센터의 이벤트(둘을 구분하지 않아 존재 탐색 방지)
// ---------------------------------------------------------------------------
async function getEventPhotos(eventId, authCenter) {
  const doc = await db.collection("events").doc(eventId).get();
  if (!doc.exists) return null;

  const data = doc.data();
  if (authCenter !== MASTER_CENTER_NAME && data.center_name !== authCenter) return null;

  const fromField = parsePhotosField(data.photos);
  if (fromField.length > 0) return fromField.slice(0, MAX_PHOTOS);

  const paths = buildPhotoPaths(data);
  if (paths.length === 0) return [];

  const urls = await Promise.all(
    paths.map(async (path) => {
      try {
        const file = getBucket().file(path);
        const [exists] = await file.exists();
        if (!exists) return null; // 해당 번호 파일이 실제로 없을 수 있음
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + EVENT_PHOTO_URL_TTL_MS,
        });
        return url;
      } catch (e) {
        console.error(`이벤트 사진 URL 발급 실패 (${path}):`, e);
        return null;
      }
    })
  );

  return urls.filter(Boolean);
}

module.exports = { buildEventsData, getEventPhotos };
