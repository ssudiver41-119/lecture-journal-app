# 강의일지 · 결과보고 웹앱 (lecture-journal-app)

**119복지인권연구소 · ONEBLOCKAI연구소** 이대영 강사 전용 —
강의 메모 몇 줄로 **① 강의일지(내부 기록용)** · **② 기관 제출용 결과보고서** · **③ 후속 감사·자료 안내 메일 초안**을 만들고,
완성된 문서를 **구글 드라이브**에 저장하는 1페이지 웹앱입니다.

- 입력: 강의 날짜·기관명·교육 분야·진행 방식·대상/인원·강의 메모(+음성 입력)·서류/정산 메모
- 생성: 양식 3종 중 선택 → AI가 **마크다운 기호 없는 순수 텍스트**로 작성
- 결과: 화면에서 직접 수정 → **전체 복사** 또는 **드라이브에 저장**
- 저장: 드라이브에 `[YYYY-MM-DD] 기관명_강의일지` Google 문서 + `강의일지_누적현황` 시트 1행
- 최근 5건은 이 기기 브라우저에만 임시 보관

빌드 도구 없이 **GitHub → Vercel → Apps Script** 만으로 배포됩니다.

---

## 1. 주요 기능

| 구분 | 내용 |
| --- | --- |
| 화면 | 한국어 단일 페이지, 모바일 우선(최대 520px), 홈화면 설치(PWA) 지원, 3개 탭(작성·결과·최근) |
| 강의 정보 | 강의 날짜(KST 오늘 기본값), 기관명\*, 교육 분야(AI 실무 교육/인권교육/개인정보보호법/4대 법정의무교육/기타 직접 입력), 진행 방식(대면/Zoom 온라인/혼합), 대상·인원 |
| 강의 메모 | 자유 입력 + **음성으로 말하기**(Web Speech API, Android Chrome·PC 크롬) + 자주 쓰는 키워드 칩 삽입 |
| 생성 양식 | ① 강의일지(내부 기록용, 시간대별 진행·질의응답·개선점) ② 결과보고서(공문체, 개요·목적·내용·결과·성과·향후 계획) ③ 메일 초안(제목+본문, 존댓말) |
| 결과 편집 | 생성문을 textarea에서 직접 수정, 글자 수 표시, **전체 복사**, **드라이브에 저장** |
| 드라이브 저장 | 저장 후 문서·누적 시트·폴더 링크 표시. 미연동 시 데모 안내(저장되지 않음을 명확히 표시) |
| 최근 기록 | 이 기기에 최근 5건(날짜·기관·양식·본문 요약), 눌러서 다시 열기·삭제 |
| 설정 | 소속·강사명(문서에 그대로 반영), **접근 코드(APP_ACCESS_CODE)** 저장(localStorage), 서버 연결 상태 표시 |
| 안전 장치 | 마크다운 기호 금지(지침 + 서버 후처리), 메모에 없는 사실 창작 금지(`(확인 필요)` 표기) |

---

## 2. 파일 구조

```
lecture-journal-app/
├── index.html                  # 화면 (HTML + CSS + JS 단일 파일)
├── api/generate.js             # 문서 생성 API (Origin·접근코드·Rate Limit·입력검증 + 마크다운 제거)
├── api/save-drive.js           # 드라이브 저장 API (Origin·접근코드·검증 → Apps Script 웹훅)
├── apps-script/Code.gs         # Apps Script (드라이브 문서 + 누적 시트 생성)
├── tests/api-generate.test.mjs # 생성 API 테스트
├── tests/api-save-drive.test.mjs # 저장 API 테스트
├── tests/index-html.test.mjs   # 화면(마크업·KST 날짜·프롬프트) 테스트
├── dev-server.mjs              # 로컬 미리보기 서버(개발용, 배포와 무관)
├── manifest.json · sw.js · icons/  # 홈화면 앱(PWA)
├── vercel.json                 # Vercel 함수 실행시간·헤더 설정
├── package.json                # npm test (의존성 없음)
├── .env.example                # 환경변수 예시
├── .gitignore
├── README.md
└── 구글드라이브_연동가이드.md   # 순서대로 따라 하는 상세 절차서
```

---

## 3. 로컬에서 실행·테스트

```bash
cd lecture-journal-app

node --test          # 테스트 66건 (Node 20 이상, 의존성 설치 불필요)
npm run dev          # http://localhost:4321 — API 키 없이 샘플 문서로 화면 확인
```

`npm run dev` 는 `ANTHROPIC_API_KEY` 가 없으면 **샘플 강의일지**를 돌려주고, 키가 있으면 실제 `api/generate.js` 를 호출합니다.
드라이브 저장은 `GOOGLE_DRIVE_WEBHOOK_URL` 이 없으므로 **데모 안내**가 뜹니다(정상).

> `index.html` 을 파일로 직접 열면 `/api/*` 가 없어 생성이 실패합니다. 화면 확인은 `npm run dev` 로 하세요.

테스트가 확인하는 것:

- **생성 API**: 상태 조회(GET)·메서드·CORS, Origin 검증, 접근 코드 게이트, 입력/본문 크기 검증, Rate Limit(분·일·IP별), Anthropic 호출 파라미터(모델·max_tokens·thinking), 업스트림 오류 매핑(429/500/502/504), 잘림(truncated), 마크다운 제거
- **저장 API**: 데모 모드, 웹훅 전송(토큰 포함), 양식 라벨, 기타 분야, 마크다운 정리, 인증·Origin, 입력 검증(날짜·기관·본문·양식·길이), 웹훅 거절/오류/연결 실패, Rate Limit
- **화면**: KST 기준 오늘 날짜(새벽·월말·연말 경계), 프롬프트의 마크다운 금지·사실 창작 금지, 폼 항목, 양식 3종, 접근 코드 저장·헤더 전송, 최근 5건 제한, 비밀값 미포함, PWA 설정

---

## 4. 배포 3단계

### 4-1. GitHub → Vercel

1. <https://vercel.com> 로그인 → **Add New… → Project**
2. GitHub 저장소 `ssudiver41-119/lecture-journal-app` **Import**
3. Framework Preset: **Other**, Build Command·Output Directory: **비워 두기**
4. **Deploy** → `https://lecture-journal-app-xxxx.vercel.app` 주소 생성

### 4-2. Google Apps Script 웹앱

`apps-script/Code.gs` 를 붙여넣고 **setupDrive** 를 한 번 실행한 뒤 웹 앱으로 배포합니다.
자세한 절차는 **[구글드라이브_연동가이드.md](./구글드라이브_연동가이드.md)** 를 보세요.

요약:
1. <https://script.google.com> → 새 프로젝트 → `Code.gs` 전체 붙여넣기 → 저장
2. 함수 `setupDrive` 실행 → 권한 승인 → `강의일지_아카이브` 폴더·`강의일지_누적현황` 시트 생성
3. (권장) 프로젝트 설정 → 스크립트 속성 `SHARED_TOKEN` = 임의의 긴 문자열
4. 배포 → 새 배포 → **웹 앱**, 실행 계정 **나**, 액세스 **모든 사용자** → **웹 앱 URL** 복사

### 4-3. Vercel 환경변수 연결 후 재배포

Vercel → Project → **Settings → Environment Variables**

| 이름 | 값 | 필수 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API 키 | ✅ |
| `APP_ACCESS_CODE` | 앱 ⚙ 설정 → 접근 코드에 넣을 값 (예: `lj-2026-8f3k`) | 권장 |
| `GOOGLE_DRIVE_WEBHOOK_URL` | Apps Script 웹 앱 URL | ✅ (없으면 저장은 데모) |
| `WEBHOOK_SHARED_SECRET` | Apps Script 의 `SHARED_TOKEN` 과 같은 값 | 권장 |
| `APP_MODEL` | 기본 `claude-sonnet-5-5` | 선택 |
| `APP_MAX_TOKENS` | 기본 `3000` | 선택 |
| `MAX_PROMPT_CHARS` | 기본 `12000` | 선택 |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_DAY` | 기본 `12` / `200` | 선택 |
| `SAVE_RATE_LIMIT_PER_MIN` / `SAVE_RATE_LIMIT_PER_DAY` | 기본 `10` / `100` | 선택 |

저장 후 **Deployments → Redeploy** (환경변수는 재배포해야 반영됩니다).

### 4-4. 동작 확인

1. 배포 주소 접속 → ⚙ 설정에서 **접근 코드 입력** → **설정 저장**
2. **연결 확인** → "서버 연결됨 · 바로 생성할 수 있습니다" 확인
3. 기관명·강의 메모를 넣고 **AI로 문서 만들기** → 결과 탭에서 문장 확인(수정 가능)
4. **드라이브에 저장** → "드라이브에 저장했습니다" + 문서·시트 링크 확인
5. 드라이브 `강의일지_아카이브` 폴더의 문서와 `강의일지_누적현황` 시트 1행 확인 → 테스트 문서·행 삭제

터미널에서 저장만 확인하려면(접근 코드를 쓰지 않는 경우):

```bash
curl -X POST "https://<배포주소>/api/save-drive" \
  -H "Content-Type: application/json" \
  -H "Origin: https://<배포주소>" \
  -d '{"date":"2026-11-15","org":"테스트복지관","field":"AI 실무 교육","method":"대면","audience":"30명","format":"journal","content":"연동 테스트 본문"}'
```

---

## 5. API 명세

### 5-1. `GET /api/generate` — 연결 상태

```json
{ "ok": true, "service": "lecture-journal-app", "ready": true, "accessCodeRequired": true, "time": "2026-11-15 09:10" }
```

키·코드 값 자체는 돌려주지 않습니다.

### 5-2. `POST /api/generate` — 문서 생성

요청: `{ "prompt": "…", "maxTokens": 3000 }` (헤더 `x-app-code` 는 접근 코드가 설정된 경우 필수)

| 상태 | 의미 |
| --- | --- |
| 200 | `{ "text": "정리된 문서", "truncated": false }` |
| 400 | 프롬프트 없음/형식 오류 |
| 401 | `code: "access_code_required"` — 앱 설정에서 접근 코드 입력 |
| 403 | 허용되지 않은 오리진, 또는 오리진 없는 직접 호출(접근 코드 미설정 시) |
| 413 | 본문·프롬프트 길이 초과 |
| 429 | 분당/일일 생성 한도 (`Retry-After` 헤더) |
| 502 / 504 | 업스트림 오류 / 응답 지연 |
| 503 | 서버에 `ANTHROPIC_API_KEY` 미설정 |

`max_tokens` 는 서버 설정값(`APP_MAX_TOKENS`)을 넘을 수 없고, 최소 256으로 올려집니다.

### 5-3. `POST /api/save-drive` — 드라이브 저장

```json
{
  "date": "2026-11-15",
  "org": "구래종합사회복지관",
  "field": "AI 실무 교육",
  "fieldEtc": "",
  "method": "대면",
  "audience": "사회복지사 30명",
  "format": "journal",
  "note": "강사료 세금계산서 발행",
  "content": "강의일지 …",
  "lecturer": "이대영",
  "affiliation": "119복지인권연구소 · ONEBLOCKAI연구소"
}
```

| 필드 | 필수 | 규칙 |
| --- | --- | --- |
| `date` | ✅ | `YYYY-MM-DD`, 실제 존재하는 날짜 |
| `org` | ✅ | 2~80자 |
| `format` | ✅ | `journal` / `report` / `mail` |
| `content` | ✅ | 1~30,000자 (저장 전 마크다운 기호 자동 제거) |
| `field` / `fieldEtc` | — | 40자. `field` 가 `기타` 면 `fieldEtc` 값이 문서·시트에 들어감 |
| `method` / `audience` / `note` | — | 20 / 60 / 500자 |

| 상태 | 의미 |
| --- | --- |
| 200 `mode:"live"` | 저장 완료 — `stored.docUrl`, `stored.sheetUrl`, `stored.folderUrl` |
| 200 `mode:"demo"` | `code: "WEBHOOK_NOT_CONFIGURED"` — 연동 전, 저장되지 않음 |
| 400 | `VALIDATION_ERROR` (`errors` 에 항목별 메시지) |
| 401 | 접근 코드 필요 |
| 403 | 허용되지 않은 오리진 |
| 413 | 본문 64KB 초과 |
| 429 | 저장 한도 초과 (`Retry-After`) |
| 502 | `WEBHOOK_ERROR` / `WEBHOOK_REJECTED` |
| 504 | `WEBHOOK_UNREACHABLE` / `WEBHOOK_TIMEOUT`(20초) |

---

## 6. 구글 드라이브에 만들어지는 것

- 폴더: `강의일지_아카이브` (스크립트 속성 `PARENT_FOLDER_ID` 로 상위 폴더 지정 가능)
- 문서: `[2026-11-15] 구래종합사회복지관_강의일지` (양식이 결과보고서면 `_결과보고서`, 메일 초안이면 `_메일초안`)
  - 제목·소속, 강의일자·저장일시, 기관/교육 정보 표, 본문(줄바꿈 유지), 안내 문구
- 시트: `강의일지_누적현황` — 탭 `누적현황`
  - 강의일자 · 기관명 · 교육분야 · 진행방식 · 대상·인원 · 양식 · 문서명 · 문서링크(하이퍼링크) · 저장일시
  - 머리글 자동 생성(고정 행), 열 너비·줄바꿈 자동 설정

Apps Script **프로젝트 설정 → 스크립트 속성**(모두 선택):

| 속성 | 기본값 | 설명 |
| --- | --- | --- |
| `PARENT_FOLDER_ID` | (없음) | 폴더를 만들 상위 폴더 ID. 없으면 내 드라이브 최상위 |
| `FOLDER_NAME` | `강의일지_아카이브` | 저장 폴더 이름 |
| `SHEET_NAME` | `강의일지_누적현황` | 누적 시트 파일 이름 |
| `SHEET_TAB` | `누적현황` | 시트 탭 이름 |
| `SHARED_TOKEN` | (없음) | 설정 시 웹훅 호출에 `?token=` 필요 |

---

## 7. 화면 문구·항목 바꾸기

모두 `index.html` 안에서 수정합니다.

- 소속·제목: `.header` 안의 `#headerOrg`, `.header h1`, `#headerSub` (기본값은 ⚙ 설정에서도 바꿀 수 있음)
- 교육 분야 선택지: `<select id="field">` 의 `<option value="…">`
- 진행 방식: `#method-chips` 의 `data-value`
- 양식 이름·설명: `#format-list` 의 `.format-item` (`data-format` 값은 `api/save-drive.js` 의 `FORMAT_LABELS` 와 맞춰야 함)
- 양식별 작성 지침: `FORMAT_GUIDE` (journal/report/mail)
- 프롬프트 공통 지침: `buildPrompt()` 안의 `[공통 지침]`
- 색·글꼴: `:root` 의 CSS 변수
- 최근 보관 개수: `HISTORY_LIMIT` (5) — 서버 검증과 무관

> 양식 이름을 바꾸면 `api/save-drive.js` 의 `FORMAT_LABELS`, `apps-script/Code.gs` 의 `FORMAT_LABELS` 도 함께 맞춰 주세요.

---

## 8. 보안·개인정보

- **API 키와 웹훅 URL 은 서버(Vercel 환경변수)에만** 둡니다. 브라우저 코드에는 어떤 비밀값도 없습니다.
- **접근 코드**(`APP_ACCESS_CODE`)를 설정하면 생성·저장 모두 `x-app-code` 헤더가 맞아야 동작합니다. 코드는 사용자 기기 localStorage 에만 저장됩니다.
- **Origin 검증**: 배포 도메인·localhost·`APP_ALLOWED_ORIGINS` 외 오리진은 403. 오리진 없는 직접 호출은 접근 코드가 설정된 경우에만 허용됩니다.
- **Rate Limit**: 생성(분 12/일 200), 저장(분 10/일 100), 전체 일일 상한(500). 서버리스 인스턴스 메모리 기반(best-effort)이라 인스턴스가 늘면 느슨해질 수 있습니다. 필요하면 Vercel KV/Upstash 로 교체하세요.
- **본문 크기 제한**: 생성 48KB/12,000자, 저장 64KB/30,000자. 초과 시 413.
- **로그**: 강의 메모·문서 본문은 로그에 남기지 않습니다(오류 코드·상태만).
- **저장 위치**: 문서·시트는 대영 님 구글 계정 드라이브 안에만 생성됩니다. 폴더를 공유하지 않으면 외부에 노출되지 않습니다.
- **기기 보관**: 최근 5건은 브라우저 localStorage 에만 있고, ⚙ 설정 → 최근 기록 삭제로 지울 수 있습니다.
- **마크다운 제거**: 모델이 `**`, `##`, 백틱, 표를 섞어 보내도 서버(`sanitizeText`)와 저장 API 가 한 번 더 걷어냅니다.
- 비밀값은 `.env`/Vercel 환경변수에만 두고 저장소에 커밋하지 않습니다(`.gitignore` 처리, `.env.example` 만 공개).

---

## 9. 문제 해결

| 증상 | 확인 |
| --- | --- |
| "접근 코드가 필요합니다" | Vercel `APP_ACCESS_CODE` 값과 앱 ⚙ 설정의 접근 코드가 같은지, 저장 후 다시 시도 |
| 연결 상태가 "AI 키가 설정되지 않았습니다" | Vercel 에 `ANTHROPIC_API_KEY` 추가 후 **Redeploy** |
| "브라우저에서 바로 연 파일이거나 허용되지 않은 주소" | `index.html` 을 파일로 열었거나 다른 도메인에서 호출. Vercel 배포 주소로 접속 |
| "드라이브 연동이 아직 설정되지 않았습니다(데모)" | `GOOGLE_DRIVE_WEBHOOK_URL` 미설정 또는 재배포 안 함 |
| 502 `WEBHOOK_REJECTED`, "인증 토큰이 올바르지 않습니다" | `WEBHOOK_SHARED_SECRET` ≠ Apps Script `SHARED_TOKEN` |
| 504 `WEBHOOK_UNREACHABLE` | 배포 액세스가 `모든 사용자`인지, URL 이 `/exec` 로 끝나는지 |
| 문서·시트가 안 생긴다 | Apps Script 편집기에서 `setupDrive()` 를 한 번 실행(권한 승인) |
| 생성물에 `**`, `#` 가 보인다 | 서버 후처리로 대부분 제거됩니다. 계속되면 캡처와 함께 알려 주세요 |
| 음성 입력이 안 된다 | Android Chrome·PC 크롬에서만 지원(iOS Safari 미지원). 키보드로 입력 |
| 코드를 고쳤는데 반영이 안 된다 | Apps Script 는 **배포 관리 → 기존 배포 편집 → 새 버전** (새 배포는 URL 변경) |

더 자세한 절차는 [구글드라이브_연동가이드.md](./구글드라이브_연동가이드.md) 를 보세요.

---

## 10. 라이선스

비공개 운영용 코드입니다(UNLICENSED). 저장소가 Public 이므로 코드는 공개되지만, 재사용·재배포는 119복지인권연구소 · ONEBLOCKAI연구소의 허락이 필요합니다.
