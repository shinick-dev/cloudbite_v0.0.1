# Cloudbite 프로젝트 콘솔

공통 프로젝트 → 선택한 전문가 역할 → 전문가별 작업공간 → 활동·파일 → 종합을 한 화면에서 보여 주는 콘솔이다.

## 파일

| 파일 | 역할 |
|---|---|
| `client/cloudbite-console.ts` | 브라우저 소스 (값 정리·종합·데모 계획·화면). `tsconfig.client.json` 으로 검사 |
| `client/cloudbite-console.css` | 파란·흰 스타일. 외부 폰트·CDN 없음. 아이콘은 퍼센트 인코딩한 SVG data URI 를 CSS mask 로 쓴다 (CSP `img-src data:` 허용, JS 에 SVG 이름공간 URL 없음) |
| `tools/build-cloudbite-console.mjs` | 위 두 파일 → `src/cloudbite-page.ts` (만든 파일). `--check` 는 최신 여부만 확인 |
| `src/cloudbite-page.ts` | `CLOUDBITE_HTML`, `CLOUDBITE_JS`, `CLOUDBITE_CSS`, `CLOUDBITE_JS_PATH`, `CLOUDBITE_CSS_PATH` |
| `test/cloudbite-console.mjs` | 코어 함수 + 가짜 DOM 화면 동작 검사 (`node test/cloudbite-console.mjs`) |

소스를 고친 뒤에는 `node tools/build-cloudbite-console.mjs` 로 다시 만든다. `package.json` 스크립트는 이 작업 범위 밖이라
`npm run check` 에 `--check` 가 아직 들어 있지 않다 — 통합 시 조정자가 추가할 것을 권한다.

## 라우팅 (런타임 담당)

- `GET /`, `GET /cloudbite` → `CLOUDBITE_HTML` (`text/html`)
- `GET CLOUDBITE_JS_PATH` (`/cloudbite/console.js`) → `CLOUDBITE_JS` (`text/javascript`)
- `GET CLOUDBITE_CSS_PATH` (`/cloudbite/console.css`) → `CLOUDBITE_CSS` (`text/css`)

페이지에는 인라인 스크립트·`style` 속성이 없다. 현재 `src/index.ts` 의 CSP 는 `style-src 'unsafe-inline'` 만 허용하므로
Cloudbite 응답에는 `script-src 'self'; style-src 'self'; connect-src 'self'` 를 포함한 CSP 를 써야 스타일이 적용된다.
JS 는 CSSOM(`element.style.x = …`)으로만 막대 너비·높이를 정한다(CSP 허용 범위).

## API 사용

- `GET /api/cloudbite/bootstrap` — 카탈로그·준비 상태. 실패하거나 카탈로그가 비면 데모는 "6 built-in demo roles"로 돌고 그 사실을 표시한다. 실제 실행은 막힌다.
- `POST /api/cloudbite/projects` — `x-admin-token` 헤더(메모리의 기존 관리자 토큰), 본문 `ProjectBrief`(`mode:'live'`, `requestId` 는 `crypto.randomUUID()`).
- `GET /api/cloudbite/projects/:id` — `Authorization: Bearer <accessToken>`. 1.2초 뒤 첫 조회, 이후 2초 간격. 네트워크·5xx 는 지수 대기로 3번 재시도 후 멈추고 "Check status again" 버튼. 401/403/404 는 즉시 멈춤. `updatedAt` 이 더 작은 응답은 버린다.
- `POST /api/cloudbite/projects/:id/cancel` — 같은 Bearer. 응답 `{project}` 또는 `ProjectRun` 둘 다 받는다.
- `GET /api/cloudbite/projects/:id/artifact?expert=<ExpertRun.expertId>&path=<path>` — `content` 가 없는 파일을 열 때만. **`expert` 는 `expertId` 를 보낸다** (런타임과 맞출 통합 지점).
- 오류는 `{error}` 문자열을 상태별 영어 안내 뒤에 덧붙여 글자로만 보인다.

## 동작 규칙

- 화면 문구는 영어다(2026-10-18 사용자 요청). 내장 데모 역할·데모 활동·보고서·오류 문구는 영어로 옮겼고, 서버·모델이 돌려준 내용은 받은 그대로 보인다.
- 첫 화면은 예시 브리프("Launch a 100-expert AI advisory room")로 **브라우저 데모**를 자동 시작해 전문가 4명이 각자 작업공간에서 일하는 모습을 보인다. 머리 배지·띠에 "No real Daytona sandbox or Nosana inference is created"를 항상 표시한다.
- 데모 결과는 브리프 문구에서 결정적으로 만든다(같은 입력 → 같은 결과). 무료/유료, 의료·법률, 기업·개인정보, 근거·출처, 일정·범위 표현(영어·한국어 키워드 모두)에 따라 역할별 의견이 바뀐다. 파일(`PERSONA.md`, `PROJECT.md`, `WORKORDER.md`, `out/notes.md`, `out/result.json`, `out/report.md`)은 실제 내용을 담는다. Settings 의 "Simulate one expert failing"으로 실패 경로를 볼 수 있다.
- 취소·재실행 시 세대 번호를 올리고 타이머를 모두 지운다. 이전 세대의 타이머·조회·파일 응답은 적용되지 않는다. 진행 중에는 시작 버튼·입력·모드 전환이 잠긴다.
- 실제 실행 실패는 오류로 보여 주며 데모로 바꾸지 않는다. 서버가 준비 안 됐으면 빠진 설정 **이름**만 보여 주고 시작을 막는다. API 키 입력란은 없다.
- 관리자 토큰·프로젝트 토큰은 메모리 변수에만 있다. 빌드 도구가 `localStorage`·`sessionStorage`·`indexedDB`·`document.cookie`·`innerHTML` 등이 들어가면 빌드를 멈춘다.
- 종합은 `completed` 이면서 의견 형식이 유효한 전문가만 센다. 실패·대기/진행·취소·형식 오류 개수는 따로 보인다. 확신도는 "자체 평가, 보정된 정확도 아님"으로 표기한다. 지지와 우려가 함께 있으면 이견 블록을 보인다. 다음 행동은 공백 정규화 후 중복을 합쳐 공통 수·확신도 순으로 5개.
- 서버 값은 전부 `normalize*` 로 길이·개수·형식을 제한한다. 알 수 없는 전문가 상태는 `failed`, 범위 밖 확신도·빈 요약 의견은 "형식 오류"로 종합에서 제외.
- 레이아웃(기준 1536×1024): 네이비 70px 머리(브랜드·영어 부제·모드 배지·비대화형 Operator 상태) | 224px 왼쪽 탐색 | 가운데 작업공간 + 오른쪽 340px 진행·결정 패널. 1280px 이하에서 오른쪽 패널이 아래로, 860px 이하에서 탐색이 머리 아래 가로 줄이 되고 1열(390px 확인).
- 탐색: Home(기본) · Guide(사용 순서) · Help(데모·확신도·제한 안내) · Settings(실행 방식·관리자 토큰·준비 상태·실패 시뮬레이션·기존 실습실 링크). 장식 버튼 없음.
- Home 가운데: Current project 카드(제목·목표·상태·선택/완료 수·Run experts/Stop/Edit project/내보내기) → 접히는 Project setup(기존 입력란·전문가 선택) → Expert workspace(전문가 목록·Execution stream·파일/활동/작업 지시서/페르소나 탭).
- Execution stream 은 모든 전문가가 보고한 활동을 시간순으로 보이는 읽기 전용 기록이다(데모는 "simulated" 표시). 입력란·명령 프롬프트·CLI 선택 없음. Full screen 은 클래스 기반 오버레이이며 Escape·Exit full screen·다른 화면 이동으로 끈다. Clear view 는 지금 보이는 줄만 화면에서 숨기고(새 줄은 계속 들어옴) 프로젝트 기록·파일은 건드리지 않는다. Restore history 가 숨긴 줄을 되돌린다.
- 파일 탭은 사용자가 직접 고르기 전까지 가장 쓸모 있는 파일(out/report.md 우선)을 따라간다.
- 오른쪽: Project progress(관찰된 상태로만 만든 단계·완료 수, 선택한 전문가 수 기준), What to do now(상태별 안내), Synthesis & confidence(기존 종합). 클릭으로 완료되는 단계는 없다.
- JSON·Markdown 내보내기는 Blob 다운로드이며 데모 여부를 파일 안에 적는다.
- 기존 실습실 링크는 `/lab`.
