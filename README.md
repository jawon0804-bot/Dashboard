# 시설물 점검 대시보드 — Cloud Run 분리 버전

## 무엇이 바뀌었나

| 구분 | 기존 (단일 HTML) | 변경 후 |
|---|---|---|
| Firestore 읽기 | 브라우저가 매번 직접 `.get()` | Cloud Run 서버가 전담, **5분 캐시** 적용 |
| 로그인 인증 | 클라이언트에서 `UserDB` 직접 조회 | 서버 `/api/login`에서 처리 |
| 데이터 가공 (fid 분해, 엑셀 링크 매핑) | 클라이언트 JS | 서버 `/api/dashboard`에서 가공 후 JSON 응답 |
| Firebase API 키 | HTML 소스에 노출 | 서버에만 존재 (서비스 계정 사용) |
| UI / 차트 렌더링 | 그대로 | 그대로 (Chart.js 로직 변경 없음) |

다른 팀이 UI를 바꾸고 싶다면 `public/index.html`만 통째로 교체해도 됩니다.
**API 계약**(`/api/login`, `/api/dashboard`의 요청/응답 형식)만 지키면 백엔드는 손댈 필요가 없습니다.

```
[브라우저: index.html]  →  fetch  →  [Cloud Run: server.js]  →  [Firestore]
   UI / Chart.js만 담당              인증 + 데이터 가공 +
                                      5분 캐시 (읽기 절감)
```

## 폴더 구조

```
cloudrun-dashboard/
├── server.js          # Express API 서버 (Firestore 읽기 전담, 캐시)
├── package.json
├── Dockerfile
├── .dockerignore
└── public/
    └── index.html      # 프론트엔드 (Firebase SDK 제거됨)
```

## 배포 전 꼭 확인할 것

1. **로고 이미지 추가**
   `index.html`이 `assets/logo.jpg`를 참조합니다. 원본 로고 파일을
   `public/assets/logo.jpg` 경로에 넣어주세요. (없으면 로고만 안 보이고 나머지는 정상 동작)

2. **Firestore 컬렉션/필드명은 기존과 동일하게 유지**
   - `UserDB` (name, phone, center)
   - `inspection_logs` (centerName, facilityId, datetime, worker)
   - `MaxerveUlsan_Excel` (facilityId, file_url)

3. **Firestore 복합 색인 미리 생성** (자세한 내용은 아래 "Master 센터 & 60일 리밋" 섹션 참고)
   ```bash
   gcloud firestore indexes composite create \
     --collection-group=inspection_logs \
     --field-config field-path=centerName,order=ascending \
     --field-config field-path=datetime,order=ascending \
     --project=m-smart-90148
   ```

## 로컬 테스트

```bash
cd cloudrun-dashboard
npm install

# 로컬에서 Firestore 접근하려면 서비스 계정 키가 필요합니다.
# GCP 콘솔 > IAM > 서비스 계정 > 키 생성(JSON) 후:
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
export FIREBASE_PROJECT_ID="m-smart-90148"

npm start
# http://localhost:8080 접속
```

## Cloud Run 배포

```bash
# 1. 프로젝트 설정
gcloud config set project m-smart-90148

# 2. 빌드 + 배포 (소스에서 직접 — Dockerfile 자동 사용)
gcloud run deploy facility-dashboard \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=m-smart-90148

# 3. 배포 완료 후 출력되는 URL로 접속
```

배포 시 Cloud Run 서비스 계정에 **Firestore 읽기 권한**(`roles/datastore.user` 또는
`roles/datastore.viewer`)이 있는지 확인하세요. 기본 컴퓨트 서비스 계정을 쓰면
프로젝트 내 Firestore에 대해 보통 자동으로 권한이 있지만, 별도 서비스 계정을
지정했다면 IAM에서 역할을 추가해야 합니다.

```bash
gcloud projects add-iam-policy-binding m-smart-90148 \
  --member="serviceAccount:<CLOUD_RUN_SERVICE_ACCOUNT>" \
  --role="roles/datastore.user"
```

## Master 센터 & 60일 리밋 (신규)

- **`UserDB`의 `center` 필드 값이 `"Master"`인 사용자**로 로그인하면, 특정 센터로 필터링하지 않고
  **모든 센터의 `inspection_logs`**와 **등록된 모든 엑셀 컬렉션**(`EXCEL_COLLECTION_BY_CENTER`에 등록된 것 전체)을
  합쳐서 보여줍니다.
- 새 센터가 추가되면 `server.js` 상단의 `EXCEL_COLLECTION_BY_CENTER`에 한 줄만 추가하면
  Master 화면에도 자동으로 포함됩니다.
- **`inspection_logs`(점검기록)는 최근 60일치만 조회**합니다 (`INSPECTION_LOGS_LOOKBACK_DAYS` 상수로 조절 가능).
  엑셀 보고서(`MaxerveXXX_Excel`)는 리밋 없이 전체 조회됩니다.

### ⚠️ Firestore 복합 색인(Composite Index) 필요

일반 센터 조회는 `where("centerName", "==", center).where("datetime", ">=", lookbackDate)`처럼
**동등 조건 + 범위 조건을 함께** 사용합니다. Firestore는 이런 복합 쿼리에 **복합 색인**을 요구합니다.

**미리 만들어두는 방법 (배포 전 1회, 권장)**

```bash
gcloud firestore indexes composite create \
  --collection-group=inspection_logs \
  --field-config field-path=centerName,order=ascending \
  --field-config field-path=datetime,order=ascending \
  --project=m-smart-90148
```

또는 Firebase 콘솔에서 직접: **Firestore Database → 색인(Indexes) → 복합 색인 만들기**
- 컬렉션 ID: `inspection_logs`
- 필드 1: `centerName` (오름차순)
- 필드 2: `datetime` (오름차순)
- 쿼리 범위: 컬렉션(Collection)

생성 후 "사용 설정됨(Enabled)" 상태가 될 때까지 보통 몇 분~십여 분 걸립니다.

**미리 안 만들었다면**: 배포 후 처음 일반 센터로 로그인할 때 서버 로그(Cloud Run 로그 또는 로컬 콘솔)에
에러와 함께 색인 생성 링크(`https://console.firebase.google.com/...`)가 자동으로 출력됩니다.
그 링크를 클릭해도 동일하게 1회 생성됩니다. (Master 조회는 단일 조건이라 색인이 따로 필요 없습니다.)

## 보고서 팝업 (신규)

3번 뷰 피봇 테이블의 "보고서" 칸이 이제 `보고서 N건` 텍스트 링크로 바뀌었습니다.
클릭하면 해당 설비ID의 엑셀 보고서 **전체 목록**을 최신순으로, 페이지당 15건씩
페이지네이션(`1 2 3 ...`)하여 팝업으로 보여줍니다.

- 제목: `설비ID(위치명)` 형식 (예: `기계_01 (OHD1F_1A01)`)
- 각 행 클릭(또는 다운로드 아이콘) 시 새 탭에서 엑셀 파일 다운로드
- 페이지네이션은 `/api/excel-files` 호출로 처리되며, `/api/dashboard`가 만들어둔
  5분 캐시(`excelList:{center}`)를 재사용하므로 팝업을 여러 번 열어도 추가 Firestore 읽기가
  거의 발생하지 않습니다.



### POST /api/login
요청:
```json
{ "name": "홍길동", "phone": "010-1234-5678" }
```
응답 (성공):
```json
{ "ok": true, "center": "울산" }
```
`center`가 `"Master"`이면 전체 센터 통합 뷰가 표시됩니다.

응답 (실패):
```json
{ "ok": false, "message": "인증 실패: ..." }
```

### GET /api/dashboard?center=울산
응답:
```json
{
  "ok": true,
  "cached": false,
  "center": "울산",
  "records": [
    { "date": "2026-06-01", "inspector": "홍길동", "fid": "기계_01", "file_url": "https://..." }
  ],
  "excelMap": { "기계_01": "https://..." },
  "excelCountByFid": { "기계_01": 10 },
  "fidLocations": { "기계_01": "OHD1F_1A01" },
  "generatedAt": "2026-06-19T06:40:00.000Z"
}
```
`records`는 최근 60일치 `inspection_logs`만 포함합니다. `excelCountByFid`는 설비ID별
엑셀 보고서 전체 건수로, 3번 뷰의 "보고서 N건" 링크 표시에 사용됩니다.

### GET /api/excel-files?center=울산&fid=기계_01&page=1&pageSize=15
특정 설비ID의 엑셀 보고서 전체 목록을 최신순으로 페이지네이션하여 반환합니다.
응답:
```json
{
  "ok": true,
  "fid": "기계_01",
  "page": 1,
  "pageSize": 15,
  "totalCount": 37,
  "totalPages": 3,
  "items": [
    { "docId": "abc123", "file_url": "https://...", "fileName": "2026-06-01_점검.xlsx", "uploadedAt": "2026-06-01T10:00:00" }
  ]
}
```

### POST /api/dashboard/refresh?center=울산
해당 center의 캐시를 즉시 무효화합니다 (관리/디버깅용). `center` 생략 시 전체 캐시 초기화.

## 캐시 동작

- center별로 **5분(300초)** 캐시
- 동일 현장에서 5분 이내 새로고침/탭 재방문 시 Firestore 실제 읽기 발생 안 함
- 5분이 지나면 다음 요청 시 자동 갱신
- Cloud Run이 여러 인스턴스로 스케일 아웃되면 인스턴스마다 캐시가 분리됩니다.
  읽기 절감 효과를 극대화하려면 `--min-instances=1 --max-instances=1`로
  고정하거나, 필요 시 Redis(Memorystore) 같은 공유 캐시로 확장할 수 있습니다.
  (현재 트래픽 규모라면 단일 인스턴스 메모리 캐시로 충분합니다.)
