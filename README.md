# 📊 Dashboard (facility-dashboard) — 관리주체 모니터링 대시보드

> **한 줄 설명**: 로그인해서 센터별 점검 현황을 차트와 표로 한눈에 보고, 이벤트 보고서도 다운로드할 수 있는 화면이에요. Firestore를 직접 들여다보지 않고, 중간에 있는 서버가 데이터를 캐싱해서 빠르고 안전하게 보여줘요.

> ⚠️ **[2026-07-23] 대상 변경**: 원래 이 대시보드는 (Maxerve) 내부 관리자가 설비별 점검표를 확인·다운로드하려고 만든 화면이었어요. 지금은 **관리주체(건물/시설 소유·운영 측)가 보는 화면으로 성격이 바뀌면서, 3번 뷰의 "보고서" 기능이 설비별 점검표 대신 m-event가 만드는 "이벤트 보고서"(센터 전체 기간 단위 발생/조치 이력)를 보여주는 것으로 완전히 교체됐어요.** 이 문서의 API/캐시/Firestore 관련 설명도 이 변경을 반영해서 갱신했습니다. 자세한 내용은 아래 각 섹션과 "🕰️ 변경 이력" 참고.

---

## 🧸 이게 뭐 하는 거예요?

**교무실 모니터 + 비서**를 합친 거예요!

- 선생님들이 교무실에서 "어느 반이 청소 검사를 통과했는지" 한눈에 보는 화면처럼
- 관리자가 로그인하면 "어느 설비가 며칠에 몇 번 점검됐는지"를 그래프와 표로 볼 수 있어요
- 그리고 **비서 역할의 서버(`server.js`)**가 중간에서 Firestore에 직접 묻지 않고, 한 번 물어본 답을 5분 동안 기억해뒀다가 같은 질문이 또 오면 다시 안 묻고 바로 대답해줘요 (캐싱)

---

## 🗺️ 어디서 볼 수 있나요?

| 항목 | 내용 |
|---|---|
| 배포 위치 | Cloud Run |
| 서비스 이름 | `facility-dashboard` |
| 리전 | `asia-northeast3` (서울) |
| 백엔드 파일 | `server.js` (Express) |
| 프론트엔드 파일 | `public/index.html` |
| Firebase 프로젝트 | `m-smart-90148` |

---

## 🏗️ 가장 중요한 변화: "예전 버전"에서 "지금 버전"으로

이 서비스는 원래 브라우저가 Firebase에 직접 접속하는 구조였다가, **Cloud Run 서버를 사이에 끼워 넣는 구조로 리팩토링**됐어요. 이 변화를 이해하는 게 Dashboard를 이해하는 핵심이에요.

| 구분 | 예전 방식 | 지금 방식 |
|---|---|---|
| Firestore 읽기 | 브라우저가 매번 직접 조회 | **서버(`server.js`)가 전담** + 5분 캐시 |
| 로그인 인증 | 브라우저가 `UserDB`를 직접 조회 | 서버의 `/api/login`에서 처리 |
| 데이터 가공 | 브라우저 JS가 직접 가공 | 서버가 가공해서 깔끔한 JSON으로 응답 |
| Firebase 인증 정보 | 브라우저 코드에 노출 | **서버에만 존재** (서비스 계정 사용) |

```
[브라우저: index.html]  →  fetch(/api/...)  →  [Cloud Run: server.js]  →  [Firestore]
   화면(차트)만 담당                              인증 + 데이터 가공 +
                                                    5분 캐시로 읽기 절감
```

> 🧸 비유: 예전엔 손님(브라우저)이 직접 창고(Firestore)에 들어가서 물건을 찾았는데, 지금은 **창구 직원(서버)**이 생겨서 손님은 "이거 주세요" 요청만 하고, 직원이 창고에서 찾아다 줘요. 직원은 자주 찾는 물건은 책상 위에 잠깐 꺼내놓고(캐시) 다음 손님이 또 찾으면 창고까지 안 가고 바로 줘요.

> ⚠️ **보안 관련**: 예전 방식(브라우저가 Firebase에 직접 접속)에서는 Firebase API 키가 누구나 볼 수 있는 HTML 소스에 그대로 노출됐어요. 지금은 서버만 Firestore에 접근하니, 그 키가 브라우저에 노출되지 않아요. 이게 이번 구조 변경의 중요한 이유 중 하나예요.

---

## 📁 폴더 구조

```
Dashboard/
├── server.js               # Express 설정 + 라우트 정의만 담당
├── config/
│   └── constants.js        # 공유 상수 (Master 센터명, 룩백 일수, 캐시 TTL/상한 등)
├── lib/
│   ├── firebase.js         # Firebase Admin 초기화 (한 번만)
│   ├── session.js          # HMAC 세션 토큰 발급/검증 + 센터 강제(resolveCenter)
│   ├── cache.js            # 메모리 캐시 (TTL + 항목 수 상한 + 스탬피드 방지)
│   ├── centers.js          # settings/all_centers 센터 목록 + center 값 검증
│   ├── dateUtils.js        # KST 기준 룩백 날짜 계산
│   ├── facilities.js       # fid → 위치명 / sheet_label 매핑
│   ├── events.js           # m-event events 조회 + 이벤트 사진 URL 해석
│   ├── photoNaming.js      # 사진 파일명/장수 규칙 (순수 함수, m-event와 공유되는 계약)
│   ├── reportFiles.js      # Storage report/{center}/*.xlsx 목록 + signed URL
│   └── storage.js          # GCS 버킷 핸들 공유 (구 lib/excel.js)
├── tests/                  # 순수 로직 회귀 테스트 (node --test, GCP 자격증명 불필요)
├── .github/workflows/      # 테스트 CI
├── package.json
├── Dockerfile
├── .dockerignore
└── public/
    ├── index.html          # 화면 (데이터는 fetch()로만, Firebase SDK는 로그인 전용)
    ├── privacy.html
    └── assets/logo.jpg
```

> [2026-07-11] `server.js`가 약 800줄까지 커져서 `config/`와 `lib/`로 분리했어요.
> (m-smart-monitor의 `functions/config`, `functions/lib` 구조를 참고한 방식)

> `index.html`은 `server.js`가 `express.static("public")`로 직접 서빙해요. 즉 화면과 API가 같은 서버, 같은 주소에서 나가기 때문에 `index.html` 안의 `API_BASE`는 빈 문자열(`""`)로 둬도 동작해요.

---

## 🔌 API 엔드포인트

| 엔드포인트 | 메서드 | 용도 |
|---|---|---|
| `/api/login` | POST | Firebase idToken 검증 → 세션 토큰 발급 (판정 자체는 m-event Function이 함) |
| `/api/dashboard` | GET | 센터별 점검 기록 + 설비 위치명 + 이벤트 한 번에 조회 |
| `/api/event-photos` | GET | 이벤트 1건의 사진 URL (상세 팝업을 열 때만 호출) |
| `/api/excel-files` | GET | 센터의 이벤트 보고서(Storage `report/{center}/*.xlsx`) 목록을 페이지 단위로 조회 |
| `/api/fidlocations` | GET | 설비ID → 위치명/시트라벨 매핑 |
| `/api/centers` | GET | 센터 목록 (**Master 전용**) |
| `/api/dashboard/refresh` | POST | 캐시 강제 초기화 (관리/디버깅용) |
| `/health` | GET | 서버 살아있는지 확인용 (200 + `ok`). **2026-07-30에 `/healthz`에서 이름 변경** — 아래 참고 |

> ⚠️ **`/healthz`로 되돌리지 마세요.** `healthz`·`statusz`·`varz`는 구글이 내부 진단 페이지로
> 선점한 이름이라 **Google Frontend가 가로채고 요청이 우리 서버까지 오지 않아요.** 라우트가
> 멀쩡한데도 라이브에서만 404가 나고(로컬은 200) 로그에도 안 찍혀서 3주 동안 원인을 못 찾았던
> 항목이에요. `/health`·`/healthcheck`·`/readyz`·`/livez`는 정상적으로 도달합니다.

`/health`를 뺀 나머지는 전부 `Authorization: Bearer <세션토큰>` 헤더가 필요해요.
(2026-07-29부터 `/api/fidlocations`도 여기 포함 — 아래 4️⃣ 참고. 그 전까지는 이 API만 무인증이었어요.)

### 1️⃣ `POST /api/login`
```json
// 요청 — 이름/전화번호가 아니라 Firebase idToken을 보냅니다
{ "idToken": "eyJhbGciOi..." }

// 성공 응답 — token이 이후 모든 API 호출에 쓰이는 세션 토큰
{ "ok": true, "center": "쿠팡울산2Sub-Hub", "token": "eyJjZW50ZXI...<서명>" }

// 실패 응답
{ "ok": false, "message": "인증 실패: ..." }
```

로그인은 **2단계**예요 (이 부분이 예전 문서와 가장 크게 달라진 곳):

1. 브라우저가 m-event의 `loginWithCredentials` Cloud Function을 직접 호출해서 이름+전화번호를 대조하고 커스텀 토큰을 받아요 → `signInWithCustomToken`으로 Firebase Auth 로그인 → `idToken` 획득
2. 그 `idToken`을 이 엔드포인트로 보내면, 서버가 검증하고 **자체 HMAC 세션 토큰**을 발급해요 (4시간 TTL, 브라우저 `localStorage`에 보관)

- 즉 **이름/전화번호 대조와 brute-force 잠금은 이 서버가 아니라 m-event Function이 담당**해요. (`login_attempts`/`login_lockouts` 기록도 거기서 남습니다)
- `UserDB` 문서를 `doc(uid)`로 단건 조회해서 **`active`가 명시적으로 `true`인 계정만** 허용하고, `allowed_apps`가 배열이면 `"dashboard"`가 포함되어야 해요.
- `center`가 `"Master"`면 화면에서 전체 센터 통합 뷰가 표시돼요.

> ⚠️ **`active` 게이트 주의**: `loginWithCredentials` 자체는 `active`를 검사하지 않아요(`allowed_apps`만 봄).
> 즉 **`active:true`를 요구하는 건 Dashboard 로그인이 유일**합니다. 나중에 "계정 활성"과
> "관리자 권한"을 별도 필드로 분리할 때 `server.js`의 이 조건도 같이 안 바꾸면
> **Dashboard 로그인이 통째로 막혀요.** (`system_map.md` 2번 `UserDB` 항목 참고)

### 2️⃣ `GET /api/dashboard?center=센터명`
```json
{
  "ok": true,
  "cached": false,
  "center": "쿠팡울산2Sub-Hub",
  "records": [
    { "date": "2026-06-01", "inspector": "홍길동", "fid": "기계_01" }
  ],
  "truncated": false,
  "fidLocations": { "기계_01": "OHD1F_1A01" },
  "eventsByFid": {
    "기계_01": [
      { "id": "...", "status": "발생", "memo": "...", "history": [],
        "photos": [], "photoCount": 3 }
    ]
  },
  "eventsError": false,
  "generatedAt": "2026-06-19T06:40:00.000Z"
}
```
- `records`: 최근 **60일치** `inspection_logs`만 포함 (오래된 데이터까지 한꺼번에 불러오면 느려지니까 제한을 둠)
- `truncated`: 조회가 상한에 걸려 **최신 것만** 담았다는 뜻(화면에 경고 배너). 상한은 두 단계예요 — 쿼리 단계 `INSPECTION_LOGS_QUERY_LIMIT`(문서 2만 건, Firestore 읽기 자체를 자름) + 응답 단계 `INSPECTION_LOGS_MAX_RECORDS`(레코드 5만 건, 문서 1건이 `facility_id` 배열만큼 펼쳐지므로 2차 방어)
- `fidLocations`: 설비ID → 위치명 매핑 (예: `기계_01` → `OHD1F_1A01`)
- `eventsByFid`: 설비별 미해결(+최근 완료) 이벤트 목록 (m-event `events` 컬렉션 연동, 3번 뷰 하위 행에 표시)
  - `photos`: `events.photos` 필드에 URL이 있으면 그대로. 비어 있고 `photoCount > 0`이면 팝업을 열 때 `/api/event-photos`로 따로 받아옵니다
- `eventsError`: **이벤트 조회만 실패**했다는 뜻(점검기록은 정상). 이때도 200으로 응답하고 화면에 경고 배너를 띄웁니다 — 예전엔 이벤트 쿼리 하나가 실패하면 대시보드 전체가 500이었어요
- [2026-07-23] `excelMap`/`excelCountByFid`(설비별 점검표 링크/건수)는 제거됨 — 3번 뷰가 더 이상 설비 단위 점검표를 보여주지 않음

### 2️⃣-1 `GET /api/event-photos?id=이벤트ID`
```json
{ "ok": true, "photos": ["https://storage.googleapis.com/..."] }
```
이벤트 상세 팝업을 **열 때만** 호출해요. m-event의 `loadEventPhotos()`와 같은 2단계로 해석합니다:
`events.photos` 필드가 있으면 그대로, 없으면 `photo_count`만큼 Storage 경로(`inspection_photos/{center}/{YYYYMMDD}_{HHmm}_{fid}_{n}.jpg`)를 추측해서 **실제로 존재하는 파일만** signed URL로 발급해요.

- 비-Master는 자기 센터의 이벤트만 조회 가능. 없는 이벤트와 남의 센터 이벤트는 똑같이 404 (존재 여부 탐색 방지)
- 예전엔 `/api/dashboard`가 **모든 이벤트의 사진 URL을 미리** 발급했어요. signed URL 발급은 IAM `signBlob` 네트워크 왕복이라, 팝업을 한 번도 안 열어도 이벤트 수 × 최대 3장만큼 호출이 나갔습니다.

### 3️⃣ `GET /api/excel-files?center=센터명&page=1&pageSize=15`
[2026-07-23 변경] 이제 Storage `report/{center}/*.xlsx`(m-event가 생성하는 **이벤트 보고서**)를 최신순으로 페이지네이션해서 줘요 — 예전엔 설비별 `Maxerve_Excel` 점검표를 줬지만, 이벤트 보고서는 설비 단위가 아니라 센터 전체 기간 단위 파일이라 `fid` 파라미터는 더 이상 안 씀(보내도 무시됨). 헤더의 "이벤트 보고서" 링크를 클릭했을 때 뜨는 팝업이 이 API를 써요.

### 4️⃣ `GET /api/fidlocations?center=센터명`
```json
{ "ok": true, "fidLocations": {"기계_01": "OHD1F_1A01"}, "sheetLabels": {"기계_01": "승강기 점검일지"} }
```

> 🔄 **[2026-07-29] 무인증 → 인증 필수로 바꿨어요. 이 저장소에서 가장 오래 잘못 적혀 있던 항목이에요.**
>
> 예전 문서엔 "m-event가 가져다 쓰는 유일한 무인증 API라 절대 바꾸지 말 것"이라고 적혀 있었어요.
> 그런데 **m-event는 2026-07-11에 이 API를 안 쓰게 됐어요.** `firestore.rules`가 이미
> `center_configs/{center}/**`를 본인 센터에 한해 읽도록 허용하고 있어서, m-event가
> Firestore를 직접 읽는 방식으로 바꿨거든요(`m-event/manager/js/auth.js`의 `loadFidLocations`).
> 그 커밋 주석엔 "의존 해소"라고 적혀 있었는데, **정작 이 README·`server.js` 주석·m-event README·
> `system_map.md` 어디에도 반영되지 않아서** 3주 가까이 "쓰이고 있다"고 믿긴 채로 남아 있었어요.
>
> 확인 방법 두 가지로 교차 검증했어요:
> - 5개 저장소 전체 grep → 이 API 호출부 **0건**
> - Cloud Run 액세스 로그 → `referer: m-smart-0804.web.app`(m-event) 트래픽이
>   **2026-07-11 05:39을 마지막으로 완전히 끊김**. 그 이후 기록은 07-27/28 코드리뷰 때
>   직접 날린 `curl` 검증뿐 (`center=Master`, `center=nonexistent-center-xyz` 등)
>
> 즉 **소비자가 없는데 센터별 설비 매핑을 인증 없이 내주는 창구만 열려 있던 상태**였어요.
> 그래서 다른 조회 API와 똑같이 `authMiddleware` + `resolveCenter`를 붙였어요.
> **응답 형식(`{ok, fidLocations, sheetLabels}`)은 그대로예요.**
>
> ↩️ 되돌리려면: `server.js`에서 `authMiddleware`를 `cors()`로 바꾸고 `center`를 `req.query`에서
> 읽으면 예전 동작으로 정확히 복귀해요. (저장소 밖 소비자 — 예컨대 Apps Script — 가 나타나는
> 경우를 대비한 탈출구예요. M-Engine `/order`가 실제로 그런 사례였어요)

아래 두 검증은 무인증 시절(2026-07-27)에 넣은 방어예요. 지금은 인증 + `resolveCenter`가 같은 위협을 이미 막지만, 다중 방어로 남겨뒀어요:

- **`center=Master`는 400으로 거부.** Master는 `center_configs` 전체를 순회하는 분기라, 무인증 시절엔 이 경로로 전 센터 매핑이 통째로 나갔어요 (Master 전용인 `/api/centers`가 우회됐던 셈).
- **`settings/all_centers.centers`에 없는 센터는 404.** `center` 값이 캐시 키와 Firestore 쿼리에 그대로 들어가서, 검증이 없으면 임의 문자열로 캐시 항목과 읽기 비용을 무한히 만들 수 있었어요.
  - 단 **목록 조회 자체가 실패하거나 목록이 비어 있으면 통과**시켜요(fail-open).
  - 비-Master는 `resolveCenter`가 `center` 파라미터를 무시하고 자기 센터로 강제하므로, 이제 임의 문자열 자체가 들어올 수 없어요.

### 5️⃣ `GET /api/centers` (Master 전용)
```json
{ "ok": true, "centers": ["쿠팡울산2Sub-Hub", "..."] }
```
Master 계정의 센터 드롭다운용. Master가 아니면 403.

---

## 🔐 로그인 & 권한

- 일반 사용자: 로그인하면 자기 소속 센터(`center`)의 데이터만 보여요.
- `center: "Master"`인 사용자: **모든 센터**의 데이터를 통합해서 봐요. (`/api/dashboard`, `/api/excel-files`가 Master를 특별 취급해서 센터 필터 없이 전체 조회하도록 분기돼요)
  - ⚠️ **`/api/fidlocations`는 예외** — 여기선 `center=Master`를 거부하고 구체적인 센터명을 요구해요. (위 4️⃣ 참고)
- 비-Master 계정이 `?center=` 파라미터를 조작해도 서버(`lib/session.js`의 `resolveCenter`)가 자기 센터로 강제로 되돌려요.

> 🧸 비유: 일반 선생님은 자기 반 출석부만 보고, 교장 선생님(Master)은 전교생 출석부를 한 번에 보는 것과 같아요.

---

## ⚡ 캐싱 — 왜, 어떻게 빠르게 만들었나요?

50개 센터 × 100명 규모의 트래픽을 가정하고 설계됐어요. 매번 Firestore에 직접 묻지 않도록 **메모리 캐시**를 둬서 읽기 비용을 크게 줄였어요.

| 항목 | 내용 |
|---|---|
| 캐시 유지 시간 | 5분 (300초) |
| 캐시 단위 | 센터별로 따로 (`dashboard:{center}`, `reportFiles:{center}`, `fidLocations:{center}`, `sheetLabels:{center}`, `centers:list`) |
| 항목 수 상한 | 500개 (`MAX_CACHE_ENTRIES`) — 넘치면 만료된 것 → 오래된 것 순으로 비움 |
| 동시 요청 | 같은 키로 요청이 몰려도 Firestore 조회는 1회만 (스탬피드 방지, `getOrBuild`) |
| 실패 시 | 조회가 실패하면 **아무것도 캐시하지 않음** — 다음 요청이 자연스럽게 재시도 |
| 효과 | 같은 센터에서 5분 안에 여러 번 새로고침해도 Firestore 실제 읽기는 한 번만 발생 |

> ⚠️ **항목 수 상한이 왜 필요했나**: 만료된 캐시 항목은 "같은 키를 다시 읽을 때"만 지워져요. 그런데 캐시 키에 `center` 값이 그대로 들어가고 당시 `/api/fidlocations`는 무인증이라, 상한이 없으면 임의의 센터 문자열로 항목을 무한히 쌓아 인스턴스 메모리를 고갈시킬 수 있었어요. (2026-07-27 추가 / 2026-07-29에 그 API도 인증 필수가 되면서 유입 경로 자체는 사라졌지만, 상한은 안전장치로 유지)

> 🧸 비유: 식당에서 같은 메뉴를 자꾸 물어보면, 직원이 매번 주방까지 가서 확인하지 않고 "방금 확인했는데 짜장면 있어요!"라고 5분 동안은 외워서 바로 대답해주는 것과 같아요.

> ⚠️ **알아둘 점**: Cloud Run은 트래픽이 늘면 인스턴스를 여러 개로 늘릴 수 있는데(스케일 아웃), **이 캐시는 인스턴스 메모리 안에만 있어서 인스턴스끼리 서로 공유가 안 돼요.** 그래서 배포 시 `--min-instances=1 --max-instances=3`처럼 인스턴스 개수를 적당히 제한해서 캐시 분산을 최소화해요. 트래픽이 더 늘어나면 Redis(Memorystore) 같은 공유 캐시로 바꿀 수 있어요.

---

## 📈 화면에 보이는 3가지 뷰 (차트/표)

| 뷰 | 형태 | 내용 |
|---|---|---|
| 1번 뷰 | 막대그래프 | 날짜별 일일 점검 횟수 |
| 2번 뷰 | 가로 막대그래프 | 설비 카테고리별(소방/전기/순찰/기계공조/기타) 점검 건수 |
| 3번 뷰 | 표 (피봇 테이블) | 설비별 총 점검 건수 + 이벤트 하위 행 + 헤더의 "이벤트 보고서" 팝업 링크(센터 전체) |
| 4번 뷰 | 파이차트 + 표 | 점검자별 비율 및 건수 |

카테고리 분류는 설비ID 문자열에 "소방", "전기", "순찰", "기계"/"공조" 같은 키워드가 포함되어 있는지로 단순하게 나눠요. (그 외는 전부 "기타설비"로 분류)

> ⚠️ **3번 뷰에 표시되는 설비 = "필터된 점검기록에 나오는 설비" ∪ "이벤트가 있는 설비"** (2026-07-27 수정)
>
> 서버는 미해결 이벤트를 **기간 제한 없이** 가져와요 — 오래 방치된 이슈를 놓치지 않으려는 설계예요.
> 그런데 예전엔 화면이 그걸 다시 "점검기록에 등장하는 설비"로만 좁혀서,
> 최근 60일간 점검기록이 없는 설비의 미해결 이벤트는 **아예 안 보였고**, 날짜/작업자 필터를
> 걸면 그 조건에 안 걸리는 설비의 이벤트가 사라졌어요. 오래 방치된 이슈일수록 화면에서
> 사라지는, 의도와 정반대 동작이었죠.
>
> 지금은 이벤트가 있는 설비를 항상 같이 표시해요. 이때 점검 건수는 `0 건`으로 흐리게 나오는데,
> 이건 오류가 아니라 "이 조회 조건에는 점검기록이 없다"는 뜻이에요.
> 설비 카테고리 필터는 "이 종류만 보겠다"는 명시적 선택이라 이벤트에도 적용하지만,
> 날짜/작업자 필터는 점검기록에 대한 조건이라 이벤트에는 적용하지 않아요.

---

## ☁️ Firestore 연동

| 컬렉션/경로 | 용도 |
|---|---|
| `UserDB` | 로그인 인증 (`name`, `phone`, `active`, `center_name`) |
| `inspection_logs` | 점검 기록 (최근 60일만 조회) |
| `events` | m-event 이벤트(발생/진행중/완료) — 3번 뷰 하위 행에 표시 (`lib/events.js`). ⚠️ 상태값은 m-event가 쓰고 여기선 읽기만 하는 공유 문자열이에요. 2026-08-14에 `조치중`→`진행중`으로 바뀌었고, 옛 이름이 남은 문서·이력도 있어서 `EVENT_OPEN_STATUSES`/`STATUS_ORDER`/색상·정렬이 **둘 다 받도록** 돼 있어요. 🆕 `completion_photos`(2026-08-15)도 읽어서 이벤트 팝업에 초록 테두리로 같이 보여줘요 — 값이 이미 다운로드 URL이라 점검 사진과 달리 **파일명 추측 폴백이 필요 없어요** |
| `center_configs/{center}/facilities` | 설비ID → 위치명(`fid_name`) 매핑 |
| `center_configs/{center}/inspections` | 설비ID → 점검표 이름(`sheet_label`) 매핑 |

Firestore 외에 **Cloud Storage**도 직접 읽어요:

| 경로 | 용도 |
|---|---|
| `report/{center}/*.xlsx` | m-event가 생성하는 **이벤트 보고서** — `lib/reportFiles.js`가 목록 조회 + signed URL 발급 (`/api/excel-files`가 사용) |

> ⚠️ **[2026-07-23] `Maxerve_Excel` 컬렉션은 더 이상 이 대시보드가 읽지 않습니다.** 이전엔 설비별 점검표 목록/링크(`excelMap`, `excelCountByFid`)를 여기서 만들었는데, 3번 뷰가 이벤트 보고서로 완전히 교체되면서 `buildExcelData`(구 `lib/excel.js`)를 삭제했어요. `Maxerve_Excel` 자체는 다른 앱(m-event의 엑셀 탭 등)이 여전히 쓰고 있으니 컬렉션을 지우면 안 됩니다 — **이 대시보드만** 더 이상 안 씁니다.

---

## ⚠️ Firestore 복합 인덱스 (배포 전 꼭 확인)

일반 센터 조회는 동등 조건 + 범위 조건 + 정렬을 같이 써요:
```js
.where("center_name", "==", center).where("datetime", ">=", lookbackDate)
.orderBy("datetime", "desc").limit(INSPECTION_LOGS_QUERY_LIMIT)
```
이런 조합은 Firestore가 **복합 인덱스**를 요구해요. 미리 안 만들어두면 조회가 `FAILED_PRECONDITION`으로 실패해요.

**현재 상태 (2026-07-27 `gcloud firestore indexes composite list`로 실제 확인):**

| 인덱스 | 상태 | 쓰임 |
|---|---|---|
| `inspection_logs (center_name ASC, datetime DESC)` | ✅ READY (`CICAgJjmnIgK`) | **지금 쓰는 쿼리** — 일반 센터 |
| `inspection_logs (center_name ASC, datetime ASC)` | ✅ READY (`CICAgNiav4AK`) | 정렬 추가 전 쿼리 |

Master 조회(`datetime >=` + `orderBy(datetime desc)`)는 범위와 정렬이 같은 단일 필드라 자동 생성되는 단일 필드 인덱스로 처리돼서 복합 인덱스가 필요 없어요.

> ✅ **[2026-07-27] `centerName`(카멜케이스) 죽은 인덱스 3개를 삭제했어요.** 예전 설계 문서에 필드명이 `centerName`으로 적혀 있던 시절의 잔재로, `inspection_logs`에 2개(`CICAgJiUsZIK`/`CICAgNi4-ZIK`) + `Maxerve_Excel`에 1개(`CICAgJj7z4EJ`)가 남아 있었습니다.
> **5개 저장소(M-SMART·m-event·M-Engine·Dashboard·m-smart-monitor) 전체를 clone해서 확인한 결과 `centerName`을 쓰는 소스코드가 0건**이었고(문서에만 등장), 데이터를 쓰는 M-SMART `public/js/submit.js`도 `center_name`으로 저장합니다. 인덱스는 문서를 쓸 때마다 갱신 비용이 드는데 `inspection_logs`는 점검할 때마다 쌓이는 최다 쓰기 컬렉션이라 정리 효과가 큽니다.
> 삭제 후 실제 데이터로 재검증 완료 — 복합 인덱스 13개 → 10개, `FAILED_PRECONDITION` 0건.

> 쿼리 형태를 바꿀 땐 **반드시 인덱스부터 확인**하세요. 이 저장소 계열에서 "인덱스가 없어서 기능이 조용히 실패한 채 방치"된 사고가 여러 번 있었어요.

---

## 🚀 배포 / 로컬 테스트

### 회귀 테스트 (GCP 자격증명 불필요)
```bash
npm ci
npm test
```
`tests/`는 GCP SDK를 안 타는 순수 로직만 검증해요 — 세션 토큰 서명/만료, 캐시 TTL·상한·스탬피드,
KST 룩백 날짜, 이벤트 사진 파일명/장수 규칙. 개발 PC에서 그냥 돌아가고 CI(`.github/workflows/test.yml`)도
같은 명령을 씁니다.

> 사진 장수 파싱과 KST 날짜 계산은 **실제로 한 번씩 틀렸던 자리**라 회귀 테스트로 고정해뒀어요.
> (고친 버그를 일부러 되살리면 테스트가 FAIL 나는 것까지 확인함)

### 로컬 실행
```bash
npm ci
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export FIREBASE_PROJECT_ID="m-smart-90148"
export SESSION_SECRET="$(openssl rand -hex 32)"   # 없으면 임시 난수 키로 뜸(재시작 시 재로그인)
npm start
# http://localhost:8080 접속
```

### Cloud Run 배포
```bash
gcloud config set project m-smart-90148

gcloud run deploy facility-dashboard \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=3 \
  --set-env-vars FIREBASE_PROJECT_ID=m-smart-90148 \
  --set-secrets SESSION_SECRET=dashboard-session-secret:latest
```
- `--min-instances=1`: 인스턴스를 항상 1개 켜둬서 첫 접속이 느려지는 콜드스타트를 방지
- `--max-instances=3`: 너무 많이 늘어나서 캐시가 여기저기 흩어지는 걸 방지
- `SESSION_SECRET`: **반드시 설정**. 없으면 인스턴스마다 임시 난수 키로 떠서, 인스턴스가 2개 이상일 때 A에서 받은 토큰을 B가 거부해 로그인이 산발적으로 풀립니다. 평문 env var 대신 Secret Manager(`--set-secrets`)를 쓰세요
  - 이미 설정돼 있으므로 재배포 시엔 `gcloud run deploy --source .`만 해도 유지됩니다 (기존 설정 보존)

> ⚠️ `--source .` 배포는 리비전을 2개 만듭니다(빌드 이미지 → 베이스 이미지 고정). 트래픽은 **나중 것**이 받으니, 배포 후 확인할 땐 `gcloud run services describe`의 `status.traffic`을 보세요.

### 권한 확인
Cloud Run 서비스 계정에 Firestore 읽기 권한(`roles/datastore.user`)이 있어야 해요.
```bash
gcloud projects add-iam-policy-binding m-smart-90148 \
  --member="serviceAccount:<CLOUD_RUN_SERVICE_ACCOUNT>" \
  --role="roles/datastore.user"
```

---

## 🛠️ 기술 스택

| 분류 | 내용 |
|---|---|
| 백엔드 | Node.js 22 (LTS) + Express |
| 프론트엔드 | 순수 HTML/JS + Chart.js **4.x 고정** (차트), chartjs-plugin-datalabels 2.2.0 |
| 데이터베이스 | Google Cloud Firestore |
| 캐싱 | 인스턴스 메모리 캐시 (Map, 5분 TTL + 500개 상한) |
| 테스트 | Node 내장 러너(`node --test`) — 별도 의존성 없음 |
| 배포 | Docker + Cloud Run |

> ⚠️ **CDN 스크립트는 버전을 고정해서 쓰세요.** `chartjs-plugin-datalabels` 2.2.0은 Chart.js 3.x/4.x만
> 지원해요. 예전엔 `chart.js`를 버전 없이(=최신) 불러서, Chart.js가 메이저 버전을 올리는 순간
> 이 저장소를 한 줄도 안 고쳤는데 대시보드가 조용히 깨질 수 있었어요. (2026-07-27 `@4`로 고정)

---

## ❓ 더 알아야 할 것들 (확인 필요)

- [ ] GitHub 레포 주소
- [ ] `public/assets/logo.jpg` 로고 파일이 실제로 들어있는지 (없어도 나머지는 동작하지만 로고만 안 보임)
- [ ] 위 "Firestore 복합 인덱스" 작업이 실제로 적용됐는지 (인수인계 노트의 미완료 항목과 동일)
- [ ] Cloud Run 인스턴스 메모리/CPU 설정값
- [ ] 이벤트 보고서(`report/{center}/`) 파일이 계속 쌓이기만 하는데, 오래된 파일 정리(수명주기) 정책이 필요한지

> 위 항목은 정보를 알려주시면 채워 넣을게요!

---

## 🚨 트러블슈팅 / 미래의 나를 위한 메모

> 시스템이 너무 잘 돌아가서 한동안 안 건드리다가, 갑자기 뭔가 안 될 때 여기부터 확인하세요.

### 데이터가 너무 오래된 캐시만 보여요
- 캐시는 5분 TTL이라 최대 5분까지는 옛날 데이터가 보일 수 있음 (정상 동작)
- 5분이 지나도 안 바뀌면 `/api/dashboard/refresh?center=센터명`을 호출해서 캐시 강제 초기화

### 특정 센터만 점검 기록이 하나도 안 보여요
1. Firestore 복합 인덱스(`center_name` + `datetime`)가 만들어졌는지 확인 — 없으면 쿼리가 조용히 실패하거나 콘솔에 인덱스 생성 링크가 찍힘
2. 그 센터의 `inspection_logs` 문서에 `center_name` 필드 값이 오타 없이 정확한지 확인 (대소문자, 공백 등)

### 로그인은 되는데 데이터가 하나도 안 떠요
1. `UserDB`의 `center_name`과 `inspection_logs`/`events`의 `center_name`이 정확히 일치하는지 확인 (철자 하나라도 다르면 매칭 안 됨)
2. `active`가 명시적으로 `true`인지 확인 (필드 자체가 없거나 `false`면 **Dashboard 로그인만** 막힘 — m-event/M-SMART는 `active`를 안 봄)

### "이름/전화번호는 맞는데" 로그인이 안 돼요
- m-event 로그인(1단계)은 통과했는데 `/api/login`(2단계)에서 401이 나는 경우예요. `UserDB` 문서의 `active`가 `true`인지, `allowed_apps`가 배열이면 `"dashboard"`가 들어있는지 확인하세요.
- Cloud Run 로그에 `[로그인] uid=... center=...`가 찍히면 2단계까지 성공한 거예요.

### 이벤트가 있는데 3번 뷰에 안 보여요
1. 화면 위에 노란 경고 배너(`이벤트 정보를 불러오지 못했습니다`)가 떠 있는지 확인 — 떠 있으면 `events` 쿼리 실패(대개 복합 인덱스 누락)이고, Cloud Run 로그에 원인이 찍혀요
2. 설비 카테고리 필터가 "전체"인지 확인 (이 필터는 이벤트에도 적용돼요. 날짜/작업자 필터는 이벤트에 적용 안 됨)
3. `events` 문서의 `facility_id` 첫 값이 `center_configs/{center}/facilities`의 문서 ID와 일치하는지 확인

### 이벤트 상세 팝업에 사진이 안 떠요
- `events.photos` 필드가 비어 있으면 `photo_count`만큼 Storage 경로를 **추측**해서 찾아요. 파일명 규칙(`{YYYYMMDD}_{HHmm}_{설비ID}_{순번}.jpg`)이 안 맞으면 못 찾습니다
- 이 규칙은 **m-event에 두 벌 더 있어요**(`manager/js/events-tab.js`, `functions/lib/report-export.js`). 한쪽만 고치면 한쪽 화면에서만 사진이 깨져요 — `lib/photoNaming.js` 주석과 `system_map.md` 4번 체크리스트 참고
- `photo_count`는 `"3장"`(문자열)과 `3`(숫자)이 섞여 저장돼요. `Number()`로 파싱하면 문자열 쪽이 통째로 0장이 됩니다 (실제로 그랬던 버그 — `tests/photoNaming.test.js`로 고정해둠)

### 로컬에서 이벤트 보고서 목록이 500이 나요 (프로덕션은 멀쩡한데)
로컬 개발 환경 전용 문제이고 코드 버그가 아니에요. 두 단계로 막힙니다:

1. **`The requested project was not found.`** — ADC(`application_default_credentials.json`)의 `quota_project_id`가 엉뚱한(또는 삭제된) 프로젝트를 가리키면 버킷 목록 조회(`getFiles`)가 실패해요. 개별 객체 조회(`exists`)는 프로젝트를 안 타서 성공하기 때문에 헷갈립니다.
   ```bash
   gcloud auth application-default set-quota-project m-smart-90148
   ```
   (임시로는 `GOOGLE_CLOUD_QUOTA_PROJECT=m-smart-90148` 환경변수로도 됩니다)
2. **`Cannot sign data without 'client_email'.`** — signed URL 서명은 서비스 계정이 있어야 해요. 개인 계정 ADC로는 원리상 불가능하고, Cloud Run에서는 런타임 서비스 계정이 IAM `signBlob`으로 처리합니다. **로컬에서 다운로드 링크까지 확인하려면** 서비스 계정 키를 `GOOGLE_APPLICATION_CREDENTIALS`로 지정해야 해요.

### Cloud Run 인스턴스가 여러 개 떠서 캐시가 안 맞는 것 같아요
- 캐시는 인스턴스 메모리 안에만 있어서 인스턴스마다 따로 놂 — 이건 알려진 한계임
- `--max-instances=3`으로 제한해뒀지만, 트래픽이 늘면 그래도 분산될 수 있음
- 근본 해결은 Redis(Memorystore) 같은 공유 캐시 도입 (아직 미구현)

### "이벤트 보고서" 팝업이 갑자기 안 열리거나 목록이 비어요
- `/api/excel-files`는 자체 캐시(`reportFiles:{center}`, 5분 TTL)를 씀 — `/api/dashboard`와는 이제 캐시를 공유하지 않음(예전엔 `excelList:{center}`를 같이 썼지만 2026-07-23에 분리됨)
- 목록이 비어있으면 Storage `report/{center}/` 경로에 실제로 `.xlsx` 파일이 있는지 확인 (m-event 보고서 탭의 "매핑" 버튼을 눌러야 파일이 생김 — 자동 생성은 매달 1일)
- 여전히 안 열리면 Cloud Run 서비스 계정에 Storage 조회 권한(`roles/storage.objectViewer` 이상)이 있는지 확인 — signed URL 발급(`getSignedUrl`)이 실패하면 500이 남

### 왜 이렇게 짰는지 (설계 이유)
- **Firestore 직접 접속 → 서버 경유로 바꾼 이유**: API 키 노출 방지 + 읽기 비용 절감(캐싱) 두 가지가 핵심 동기. 트래픽이 50개소×100명 규모로 커질 걸 가정하고 설계됨.
- **[2026-07-23] 3번 뷰를 설비별 점검표에서 센터 전체 이벤트 보고서로 바꾼 이유**: 대시보드의 대상이 내부 관리자에서 관리주체로 바뀌면서, 설비 단위로 쪼개진 점검표보다 센터 전체 발생/조치 이력을 한 파일로 보는 이벤트 보고서가 더 맞는 요구가 됨. 겸사겸사 `/api/dashboard`가 매번 돌리던 `Maxerve_Excel` 조회+서명URL 발급(설비 단위라 문서 수가 많음)이 없어져서 Firestore 읽기 비용도 줄었음.

### 이벤트 보고서 목록/다운로드가 느려요
- `lib/reportFiles.js`가 목록(list) 조회는 캐시하지만, **signed URL 발급은 화면에 실제 보이는 페이지 분량(최대 15건)에 대해서만 매 요청마다 새로 함** (Cloud Run 기본 서비스계정은 로컬 개인키가 없어서 signed URL 하나 만들 때마다 IAM `signBlob` API를 호출 — 네트워크 왕복이 생김)
- 파일이 아주 많아지면 그만큼 첫 페이지 응답이 느려질 수 있음 — 필요해지면 서명URL도 캐싱(단, 유효기간 안에서만)하는 걸 고려

### 외부 요인으로 멈출 수 있는 지점
- Cloud Run 서비스 계정의 Firestore 권한(`roles/datastore.user`)이 실수로 제거되면 전체 조회 실패
- Cloud Run 서비스 계정의 Storage 권한이 제거되면 이벤트 보고서 목록/다운로드 실패
- GCP 프로젝트 결제 정지 시 전체 서비스 중단
- Dashboard가 죽으면 m-event의 설비 이름 표시 기능도 같이 죽음 (서로 의존 관계, m-event README 참고)

---

## 🕰️ 변경 이력

### [2026-07-27] 전량 코드리뷰 후 수정

저장소 전체(`server.js` + `config/` + `lib/` + `public/index.html`)를 읽고 리뷰한 결과.
"화면에 오류는 안 뜨는데 정보가 조용히 누락되는 것"을 우선 처리했다.

**기능 버그**
- **3번 뷰에서 이벤트가 필터에 따라 사라지던 문제** — 서버는 미해결 이벤트를 기간 제한 없이 가져오는데 화면이 다시 "점검기록에 등장하는 설비"로 좁혀서, 오래 방치된 이슈일수록 안 보였다. 표시 대상을 점검기록 ∪ 이벤트의 합집합으로 변경 (위 "화면에 보이는 뷰" 섹션 참고)
- **이벤트 사진이 안 뜨던 문제** — ① `photo_count`를 `Number()`로 파싱해서 `"3장"` 형태가 0장이 됐고(m-event는 두 형식을 섞어 저장), ② `getSignedUrl()`은 객체 존재를 확인하지 않아 없는 파일도 URL이 만들어져 깨진 이미지가 됐다. 파싱을 m-event와 동일하게 맞추고, `exists()`로 확인한 파일만 서명하도록 수정
- **이벤트 조회 실패가 대시보드 전체를 500으로 만들던 문제** — 이벤트만 비우고 `eventsError: true`로 알리도록 격리 (실제로 인덱스 누락 때 점검기록까지 못 보게 된 이력이 있음)
- **Master가 데이터 없는 센터로 전환하면 이전 센터의 작업자 목록이 드롭다운에 남던 문제** 수정
- 60일 룩백이 연말을 넘으면 제목이 `01월~12월`로 뒤집혀 표시되던 문제 수정

**보안 / 비용**
- **`/api/fidlocations?center=Master`가 무인증으로 전 센터 설비 매핑을 덤프하던 문제** — Master 거부 + 등록되지 않은 센터 404 (fail-open, 위 4️⃣ 참고)
- **캐시 Map 무제한 증가** — 무인증 엔드포인트로 임의 키를 넣어 인스턴스 메모리를 고갈시킬 수 있었다. 500개 상한 + 만료/오래된 순 축출 추가
- **로그아웃이 Firebase Auth 세션을 안 지우던 문제** — `signOut()` 추가. 로그아웃/401/로그인 거부 세 경로 모두 적용 (공유 PC 잔존 세션)
- 이벤트 사진 signed URL을 **팝업 열 때만** 발급하도록 `/api/event-photos` 신설 — 예전엔 팝업을 안 열어도 이벤트 수만큼 IAM `signBlob` 호출이 나갔다
- 인라인 `onclick`에 이벤트 ID를 넣던 것을 `data-event-id` + 위임 리스너로 교체 (HTML 속성 안의 JS 문자열은 `escapeHtml`로 못 막는 컨텍스트)
- `npm audit fix`로 의존성 취약점 11건 → 8건 (남은 8건은 전부 `firebase-admin` 의존 트리 안이라 메이저 업그레이드가 필요 — 별도 작업)

**인프라 / 정리**
- `Dockerfile`: Node 18(2025-04-30 EOL) → **Node 22 LTS**, `npm install` → `npm ci`
- `.dockerignore` 신설 (`.git`/`tests`/`.github` 제외 — 이미지 크기 = Artifact Registry 저장 비용)
- CDN의 `chart.js` 버전 고정(`@4`)
- `tests/` 신설 + `.github/workflows/test.yml` (26개 케이스, 배포 CI는 별도)
- `/api/dashboard`에 응답 크기 상한(`INSPECTION_LOGS_MAX_RECORDS`) + `truncated` 플래그
- 3·4번 뷰의 집계를 `records.filter()` 반복 → `Map` 1회 집계로 변경 (기록 수 × 설비 수 → 기록 수)
- `lib/excel.js` → `lib/storage.js` 이름 정정(엑셀 로직은 2026-07-23에 이미 다 빠졌음), `lib/centers.js`·`lib/photoNaming.js` 신설
- 2026-07-23 전환 때 남은 `fid` 파라미터 배선 제거(서버 응답의 `fid: null`, 그려진 적 없는 설비ID 배지 포함)
- `/api/login` 403 메시지가 "M-SMART 접근 권한"이라고 나오던 것 수정, 로그인 성공 시 `uid`/센터 로그 기록, 세션 토큰에 `uid` 포함(구버전 토큰 호환)

### [2026-07-27, 이어서] 미결 3건 처리

- **`SESSION_SECRET` 설정 (실사용 전 필수였던 것)** — Cloud Run에 아예 설정돼 있지 않아, 인스턴스마다 임시 난수 키로 뜨고 있었다. `--max-instances=3`이라 인스턴스가 2개 이상 뜨면 **서명 키가 서로 달라 로그인이 산발적으로 풀리는** 상태였다. Secret Manager에 `dashboard-session-secret`으로 등록(평문 env var가 아니라 `secretKeyRef` — M-Engine의 Gmail 앱 비밀번호와 같은 방식) + 런타임 서비스 계정에 `secretAccessor` 부여 후 연결. 기동 로그에서 경고가 사라진 것으로 실제 적용 확인
- **`/api/dashboard` 쿼리 단계 상한** — `orderBy(datetime desc) + limit(2만)` 추가로 Firestore **읽기량 자체**를 제한. 필요한 인덱스 `(center_name ASC, datetime DESC)`가 이미 READY라 새로 만들 필요가 없었다(배포 전 확인). 실제 데이터로 검증: 일반 센터 244건 / Master 245건, `records[0]`이 최신
- **`firebase-admin` 업그레이드는 하지 않기로 함** — 남은 취약점 8건이 전부 `uuid` 단일 권고("v3/v5/v6에서 `buf` 인자를 줄 때 경계 검사 누락")에서 파생된 것이고, **13.10.0으로 올려도 14.2.0으로 올려도 똑같이 `uuid@9.0.1`을 끌어와서 해소되지 않는다**(별도 폴더에서 실제 설치해 확인). npm이 제안하는 "수정"은 `firebase-admin@10.3.0` 다운그레이드라 채택 불가. 우리 코드는 `uuid`를 직접 쓰지 않고(0건) Google 전송 계층 내부에서만 쓰이며 `buf` 인자를 넘기는 경로가 없어 실질 위험이 없다고 판단. `overrides`로 강제 교체하는 건 Firestore/Storage 클라이언트를 깨뜨릴 위험이 더 커서 하지 않음. **상류(Google 클라이언트 라이브러리)가 uuid를 올릴 때까지 대기**

### [2026-07-23] 3번 뷰 "보고서" 팝업을 설비별 점검표 → 센터 전체 이벤트 보고서로 교체
대시보드의 대상이 내부 관리자에서 **관리주체**로 바뀌면서, m-event가 새로 만든 "이벤트 보고서" 기능(Storage `report/{center}/*.xlsx`)을 이 대시보드에서도 볼 수 있게 통합했다.

- `lib/reportFiles.js` 신규 — Storage `report/{center}/` 목록 조회(`listReportFileMeta`, 캐시 가능) + signed URL 발급(`signReportFileUrl`, 페이지 분량만) 분리
- `server.js`
  - `/api/excel-files`: `Maxerve_Excel` 기반 `buildExcelData` 대신 `lib/reportFiles.js` 사용, `fid` 파라미터 제거(더 이상 설비 단위가 아님)
  - `/api/dashboard`: `buildExcelData` 호출 제거 → 응답에서 `excelMap`/`excelCountByFid` 필드 삭제, 관련 캐시(`excelList:{center}`) 삭제
- `lib/excel.js`: `buildExcelData`/`resolveFileUrl`/`extractCleanFileName` 삭제 (죽은 코드) — `getBucket()`만 남기고 `lib/events.js`/`lib/reportFiles.js`가 공유
- `config/constants.js`: 더 이상 안 쓰는 `EXCEL_COLLECTION` 삭제
- `public/index.html`
  - 피봇 테이블 헤더 "보고서" → "이벤트 보고서", 팝업 제목도 동일하게 변경
  - 설비별 최신 점검표 다운로드 아이콘(3번 뷰 3번째 열) 삭제, 관련 `excelMap`/`excelCountByFid` 프런트 변수 삭제
  - 스크롤 시 sticky 헤더 위로 이전 행이 삐져나오는 렌더링 버그 수정 (`border-collapse: collapse` → `separate` + `border-spacing:0`)
  - 라이트모드에서 "이벤트 보고서" 링크 글자가 안 보이던 문제 수정 (하드코딩된 다크모드 색상 → `var(--text-main)`)

> ⚠️ `Maxerve_Excel` Firestore 컬렉션 자체는 삭제하지 않았다 — m-event의 엑셀 탭 등 다른 곳에서 여전히 사용 중.
