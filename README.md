# 📊 Dashboard (facility-dashboard) — 관리자 모니터링 대시보드

> **한 줄 설명**: 관리자가 로그인해서 센터별 점검 현황을 차트와 표로 한눈에 보고, 엑셀 보고서도 다운로드할 수 있는 화면이에요. Firestore를 직접 들여다보지 않고, 중간에 있는 서버가 데이터를 캐싱해서 빠르고 안전하게 보여줘요.

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
| `/api/dashboard` | GET | 센터별 점검 기록 + 엑셀 링크 + 설비 위치명 한 번에 조회 |
| `/api/excel-files` | GET | 특정 설비(또는 전체)의 엑셀 보고서 목록을 페이지 단위로 조회 |
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
    { "date": "2026-06-01", "inspector": "홍길동", "fid": "기계_01", "file_url": "https://..." }
  ],
  "excelMap": { "기계_01": "https://..." },
  "excelCountByFid": { "기계_01": 10 },
  "fidLocations": { "기계_01": "OHD1F_1A01" },
  "generatedAt": "2026-06-19T06:40:00.000Z"
}
```
- `records`: 최근 **60일치** `inspection_logs`만 포함 (오래된 데이터까지 한꺼번에 불러오면 느려지니까 제한을 둠)
- `excelMap`: 설비별 **가장 최신** 엑셀 파일 1건의 링크 (표에서 아이콘 클릭 시 바로 다운로드용)
- `excelCountByFid`: 설비별 엑셀 보고서 **전체 건수** ("보고서 N건" 링크 표시용)
- `fidLocations`: 설비ID → 위치명 매핑 (예: `기계_01` → `OHD1F_1A01`)

### 3️⃣ `GET /api/excel-files?center=센터명&fid=기계_01&page=1&pageSize=15`
특정 설비(또는 `fid` 생략 시 센터 전체)의 엑셀 보고서를 최신순으로 페이지네이션해서 줘요. "보고서 N건" 링크를 클릭했을 때 뜨는 팝업이 이 API를 써요.

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
| 캐시 단위 | 센터별로 따로 (`dashboard:{center}`, `excelList:{center}`, `fidLocations:{center}`, `sheetLabels:{center}`) |
| 효과 | 같은 센터에서 5분 안에 여러 번 새로고침해도 Firestore 실제 읽기는 한 번만 발생 |

> 🧸 비유: 식당에서 같은 메뉴를 자꾸 물어보면, 직원이 매번 주방까지 가서 확인하지 않고 "방금 확인했는데 짜장면 있어요!"라고 5분 동안은 외워서 바로 대답해주는 것과 같아요.

> ⚠️ **알아둘 점**: Cloud Run은 트래픽이 늘면 인스턴스를 여러 개로 늘릴 수 있는데(스케일 아웃), **이 캐시는 인스턴스 메모리 안에만 있어서 인스턴스끼리 서로 공유가 안 돼요.** 그래서 배포 시 `--min-instances=1 --max-instances=3`처럼 인스턴스 개수를 적당히 제한해서 캐시 분산을 최소화해요. 트래픽이 더 늘어나면 Redis(Memorystore) 같은 공유 캐시로 바꿀 수 있어요.

---

## 📈 화면에 보이는 3가지 뷰 (차트/표)

| 뷰 | 형태 | 내용 |
|---|---|---|
| 1번 뷰 | 막대그래프 | 날짜별 일일 점검 횟수 |
| 2번 뷰 | 가로 막대그래프 | 설비 카테고리별(소방/전기/순찰/기계공조/기타) 점검 건수 |
| 3번 뷰 | 표 (피봇 테이블) | 설비ID별 총 점검 건수 + 최신 엑셀 다운로드 아이콘 + "보고서 N건" 팝업 링크 |

카테고리 분류는 설비ID 문자열에 "소방", "전기", "순찰", "기계"/"공조" 같은 키워드가 포함되어 있는지로 단순하게 나눠요. (그 외는 전부 "기타설비"로 분류)

---

## ☁️ Firestore 연동

| 컬렉션/경로 | 용도 |
|---|---|
| `UserDB` | 로그인 인증 (`name`, `phone`, `active`, `center_name`) |
| `inspection_logs` | 점검 기록 (최근 60일만 조회) |
| `Maxerve_Excel` | 생성된 엑셀 보고서 목록 (단일 컬렉션, `center_name`으로 필터링) |
| `center_configs/{center}/facilities` | 설비ID → 위치명(`fid_name`) 매핑 |
| `center_configs/{center}/inspections` | 설비ID → 점검표 이름(`sheet_label`) 매핑 |

> 💡 **컬렉션 통합 이력**: 예전엔 센터마다 별도 엑셀 컬렉션(`MaxerveUlsan_Excel` 등)을 썼는데, 지금은 `Maxerve_Excel` 하나로 통합하고 `center_name` 필드로 구분해요. 그래서 새 센터가 추가돼도 **코드 수정·재배포 없이** Firestore에 문서만 넣으면 바로 동작해요.

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
- [ ] 50개소 확장 시 `Maxerve_Excel` 컬렉션 구조를 더 손볼 계획이 있는지 (현재도 이미 단일 컬렉션 + `center_name` 구조로 되어 있어 보임 — 추가 변경이 필요한지 확인)
- [ ] Cloud Run 인스턴스 메모리/CPU 설정값

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
1. `UserDB`의 `center_name`과 `inspection_logs`/`Maxerve_Excel`의 `center_name`이 정확히 일치하는지 확인 (철자 하나라도 다르면 매칭 안 됨)
2. `active`가 명시적으로 `true`인지 확인 (필드 자체가 없거나 `false`면 로그인 자체가 막힘)

### Cloud Run 인스턴스가 여러 개 떠서 캐시가 안 맞는 것 같아요
- 캐시는 인스턴스 메모리 안에만 있어서 인스턴스마다 따로 놂 — 이건 알려진 한계임
- `--max-instances=3`으로 제한해뒀지만, 트래픽이 늘면 그래도 분산될 수 있음
- 근본 해결은 Redis(Memorystore) 같은 공유 캐시 도입 (아직 미구현)

### "보고서 N건" 팝업이 갑자기 안 열려요
- `/api/excel-files`는 `/api/dashboard`가 만들어둔 캐시(`excelList:{center}`)를 재사용하는 구조라서, `/api/dashboard`를 한 번도 안 부른 상태에서 바로 팝업을 열면 새로 조회함 (느릴 수 있음, 정상 동작)
- 진짜 안 열리면 `Maxerve_Excel` 컬렉션의 `file_url`, `facility_id` 필드가 비어있는 문서가 있는지 확인 (이런 문서는 자동으로 건너뜀)

### 왜 이렇게 짰는지 (설계 이유)
- **Firestore 직접 접속 → 서버 경유로 바꾼 이유**: API 키 노출 방지 + 읽기 비용 절감(캐싱) 두 가지가 핵심 동기. 트래픽이 50개소×100명 규모로 커질 걸 가정하고 설계됨.
- **센터별 엑셀 컬렉션을 하나로 통합한 이유**: 센터가 늘어날 때마다 코드에 매핑 테이블을 추가하고 재배포해야 하는 게 번거로워서, `Maxerve_Excel` 하나 + `center_name` 필드 구조로 바꿈. 새 센터 추가 시 코드 수정이 필요 없어짐.

### 외부 요인으로 멈출 수 있는 지점
- Cloud Run 서비스 계정의 Firestore 권한(`roles/datastore.user`)이 실수로 제거되면 전체 조회 실패
- GCP 프로젝트 결제 정지 시 전체 서비스 중단
- Dashboard가 죽으면 m-event의 설비 이름 표시 기능도 같이 죽음 (서로 의존 관계, m-event README 참고)
