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
cloudrun-dashboard/
├── server.js          # Express API 서버 (Firestore 읽기 전담 + 캐싱)
├── package.json
├── Dockerfile
├── .dockerignore
└── public/
    └── index.html      # 화면 (Firebase SDK 없이 fetch()로만 통신)
```

> `index.html`은 `server.js`가 `express.static("public")`로 직접 서빙해요. 즉 화면과 API가 같은 서버, 같은 주소에서 나가기 때문에 `index.html` 안의 `API_BASE`는 빈 문자열(`""`)로 둬도 동작해요.

---

## 🔌 API 엔드포인트

| 엔드포인트 | 메서드 | 용도 |
|---|---|---|
| `/api/login` | POST | 이름+전화번호로 로그인, 소속 센터 반환 |
| `/api/dashboard` | GET | 센터별 점검 기록 + 설비 위치명 + 미해결 이벤트 한 번에 조회 |
| `/api/excel-files` | GET | 센터의 이벤트 보고서(Storage `report/{center}/*.xlsx`) 목록을 페이지 단위로 조회 |
| `/api/fidlocations` | GET | 설비ID → 위치명/시트라벨 매핑 (m-event가 이걸 가져다 씀) |
| `/api/dashboard/refresh` | POST | 캐시 강제 초기화 (관리/디버깅용) |
| `/healthz` | GET | 서버 살아있는지 확인용 |

### 1️⃣ `POST /api/login`
```json
// 요청
{ "name": "홍길동", "phone": "010-1234-5678" }

// 성공 응답
{ "ok": true, "center": "쿠팡울산2Sub-Hub" }

// 실패 응답
{ "ok": false, "message": "인증 실패: ..." }
```
- `UserDB`에서 이름+전화번호가 일치하는 사용자를 찾고, **`active`가 명시적으로 `true`인 계정만** 로그인을 허용해요.
- `center`가 `"Master"`로 오면 화면에서 전체 센터 통합 뷰가 표시돼요.

### 2️⃣ `GET /api/dashboard?center=센터명`
```json
{
  "ok": true,
  "cached": false,
  "center": "쿠팡울산2Sub-Hub",
  "records": [
    { "date": "2026-06-01", "inspector": "홍길동", "fid": "기계_01" }
  ],
  "fidLocations": { "기계_01": "OHD1F_1A01" },
  "eventsByFid": { "기계_01": [ { "id": "...", "status": "발생", "memo": "...", "history": [...] } ] },
  "generatedAt": "2026-06-19T06:40:00.000Z"
}
```
- `records`: 최근 **60일치** `inspection_logs`만 포함 (오래된 데이터까지 한꺼번에 불러오면 느려지니까 제한을 둠)
- `fidLocations`: 설비ID → 위치명 매핑 (예: `기계_01` → `OHD1F_1A01`)
- `eventsByFid`: 설비별 미해결(+최근 완료) 이벤트 목록 (m-event `events` 컬렉션 연동, 3번 뷰 하위 행에 표시)
- [2026-07-23] `excelMap`/`excelCountByFid`(설비별 점검표 링크/건수)는 제거됨 — 3번 뷰가 더 이상 설비 단위 점검표를 보여주지 않음 (`lib/excel.js`의 `buildExcelData` 삭제)

### 3️⃣ `GET /api/excel-files?center=센터명&page=1&pageSize=15`
[2026-07-23 변경] 이제 Storage `report/{center}/*.xlsx`(m-event가 생성하는 **이벤트 보고서**)를 최신순으로 페이지네이션해서 줘요 — 예전엔 설비별 `Maxerve_Excel` 점검표를 줬지만, 이벤트 보고서는 설비 단위가 아니라 센터 전체 기간 단위 파일이라 `fid` 파라미터는 더 이상 안 씀(보내도 무시됨). 헤더의 "이벤트 보고서" 링크를 클릭했을 때 뜨는 팝업이 이 API를 써요.

### 4️⃣ `GET /api/fidlocations?center=센터명`
```json
{ "ok": true, "fidLocations": {"기계_01": "OHD1F_1A01"}, "sheetLabels": {"기계_01": "승강기 점검일지"} }
```
> 🔗 **이 엔드포인트는 m-event(이벤트 트래커)가 가져다 써요.** m-event 화면이 설비ID를 사람이 읽기 좋은 이름으로 바꿔서 보여줄 때 이 API를 호출해요. Dashboard와 m-event가 서로 연결되어 있다는 걸 보여주는 부분이에요.

---

## 🔐 로그인 & 권한

- 일반 사용자: 로그인하면 자기 소속 센터(`center`)의 데이터만 보여요.
- `center: "Master"`인 사용자: **모든 센터**의 데이터를 통합해서 봐요. (`/api/dashboard`, `/api/excel-files`, `/api/fidlocations` 모두 Master를 특별 취급해서, 센터 필터 없이 전체 조회하도록 분기되어 있어요)

> 🧸 비유: 일반 선생님은 자기 반 출석부만 보고, 교장 선생님(Master)은 전교생 출석부를 한 번에 보는 것과 같아요.

---

## ⚡ 캐싱 — 왜, 어떻게 빠르게 만들었나요?

50개 센터 × 100명 규모의 트래픽을 가정하고 설계됐어요. 매번 Firestore에 직접 묻지 않도록 **메모리 캐시**를 둬서 읽기 비용을 크게 줄였어요.

| 항목 | 내용 |
|---|---|
| 캐시 유지 시간 | 5분 (300초) |
| 캐시 단위 | 센터별로 따로 (`dashboard:{center}`, `reportFiles:{center}`, `fidLocations:{center}`, `sheetLabels:{center}`) |
| 효과 | 같은 센터에서 5분 안에 여러 번 새로고침해도 Firestore 실제 읽기는 한 번만 발생 |

> 🧸 비유: 식당에서 같은 메뉴를 자꾸 물어보면, 직원이 매번 주방까지 가서 확인하지 않고 "방금 확인했는데 짜장면 있어요!"라고 5분 동안은 외워서 바로 대답해주는 것과 같아요.

> ⚠️ **알아둘 점**: Cloud Run은 트래픽이 늘면 인스턴스를 여러 개로 늘릴 수 있는데(스케일 아웃), **이 캐시는 인스턴스 메모리 안에만 있어서 인스턴스끼리 서로 공유가 안 돼요.** 그래서 배포 시 `--min-instances=1 --max-instances=3`처럼 인스턴스 개수를 적당히 제한해서 캐시 분산을 최소화해요. 트래픽이 더 늘어나면 Redis(Memorystore) 같은 공유 캐시로 바꿀 수 있어요.

---

## 📈 화면에 보이는 3가지 뷰 (차트/표)

| 뷰 | 형태 | 내용 |
|---|---|---|
| 1번 뷰 | 막대그래프 | 날짜별 일일 점검 횟수 |
| 2번 뷰 | 가로 막대그래프 | 설비 카테고리별(소방/전기/순찰/기계공조/기타) 점검 건수 |
| 3번 뷰 | 표 (피봇 테이블) | 설비ID별 총 점검 건수 + 미해결 이벤트 하위 행 + 헤더의 "이벤트 보고서" 팝업 링크(센터 전체) |

카테고리 분류는 설비ID 문자열에 "소방", "전기", "순찰", "기계"/"공조" 같은 키워드가 포함되어 있는지로 단순하게 나눠요. (그 외는 전부 "기타설비"로 분류)

---

## ☁️ Firestore 연동

| 컬렉션/경로 | 용도 |
|---|---|
| `UserDB` | 로그인 인증 (`name`, `phone`, `active`, `center_name`) |
| `inspection_logs` | 점검 기록 (최근 60일만 조회) |
| `events` | m-event 이벤트(발생/조치중/완료) — 3번 뷰 하위 행에 표시 (`lib/events.js`) |
| `center_configs/{center}/facilities` | 설비ID → 위치명(`fid_name`) 매핑 |
| `center_configs/{center}/inspections` | 설비ID → 점검표 이름(`sheet_label`) 매핑 |

Firestore 외에 **Cloud Storage**도 직접 읽어요:

| 경로 | 용도 |
|---|---|
| `report/{center}/*.xlsx` | m-event가 생성하는 **이벤트 보고서** — `lib/reportFiles.js`가 목록 조회 + signed URL 발급 (`/api/excel-files`가 사용) |

> ⚠️ **[2026-07-23] `Maxerve_Excel` 컬렉션은 더 이상 이 대시보드가 읽지 않습니다.** 이전엔 설비별 점검표 목록/링크(`excelMap`, `excelCountByFid`)를 여기서 만들었는데, 3번 뷰가 이벤트 보고서로 완전히 교체되면서 `buildExcelData`(구 `lib/excel.js`)를 삭제했어요. `Maxerve_Excel` 자체는 다른 앱(m-event의 엑셀 탭 등)이 여전히 쓰고 있으니 컬렉션을 지우면 안 됩니다 — **이 대시보드만** 더 이상 안 씁니다.

---

## ⚠️ Firestore 복합 인덱스 (배포 전 꼭 확인)

일반 센터 조회는 아래처럼 동등 조건 + 범위 조건을 같이 써요:
```js
.where("center_name", "==", center).where("datetime", ">=", lookbackDate)
```
이런 조합은 Firestore가 **복합 인덱스**를 요구해요. 미리 안 만들어두면 처음 조회할 때 에러가 나고, 에러 메시지에 색인 생성 링크가 자동으로 찍혀요 (그 링크 눌러도 1회성으로 생성 가능).

**미리 만들어두는 방법(권장):**
```bash
gcloud firestore indexes composite create \
  --collection-group=inspection_logs \
  --field-config field-path=center_name,order=ascending \
  --field-config field-path=datetime,order=ascending \
  --project=m-smart-90148
```
> ⚠️ 참고: 예전 설계 문서에는 필드명이 `centerName`으로 적혀 있었는데, 실제 코드는 `center_name`(스네이크케이스)을 쓰고 있어요. 인덱스를 만들 때 **반드시 실제 필드명인 `center_name`**으로 만들어야 해요. (Master 조회는 단일 조건이라 인덱스가 따로 필요 없어요.)

> 이건 인수인계 노트에서 말한 "Firestore 복합 인덱스 추가 필요" 항목과 같은 작업이에요.

---

## 🚀 배포 / 로컬 테스트

### 로컬 테스트
```bash
cd cloudrun-dashboard
npm install
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export FIREBASE_PROJECT_ID="m-smart-90148"
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
  --set-env-vars FIREBASE_PROJECT_ID=m-smart-90148
```
- `--min-instances=1`: 인스턴스를 항상 1개 켜둬서 첫 접속이 느려지는 콜드스타트를 방지
- `--max-instances=3`: 너무 많이 늘어나서 캐시가 여기저기 흩어지는 걸 방지

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
| 백엔드 | Node.js + Express |
| 프론트엔드 | 순수 HTML/JS + Chart.js (차트), chartjs-plugin-datalabels |
| 데이터베이스 | Google Cloud Firestore |
| 캐싱 | 인스턴스 메모리 캐시 (Map, 5분 TTL) |
| 배포 | Docker + Cloud Run |

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
2. `active`가 명시적으로 `true`인지 확인 (필드 자체가 없거나 `false`면 로그인 자체가 막힘)

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
