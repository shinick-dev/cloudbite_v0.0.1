# Jev 자동 전문가 선택 — 콘솔 (client/cloudbite-console.ts)

구현 범위: 브라우저 콘솔만. 서버 경로·공유 계약은 조정자 소유이며, 아래 모양을 전제로 한다.
상태: 구현 준비 완료(implementation-ready). 실제 서버·TypeSafe 호출과 브라우저 확인은 아직 하지 않았다.

## 전제한 계약

- `bootstrap.configuration.routing` (선택): `{provider:'typesafe', model, ready:boolean, maxExperts}`.
  없거나 형식이 틀리면 예전 직접 고르기 화면 그대로다. 공유 계약에 들어오기 전까지 콘솔의
  `ConsoleBootstrap` 교차 타입에 `Routing` 으로 둔다.
- `POST /api/cloudbite/route` 본문은 정확히 `{title, objective, context, requestId}`.
  같은 출처 쿠키 + 토큰이 있을 때만 `x-admin-token` (프로젝트 만들기와 같은 규칙, 거부돼도 쿠키로 넘어가지 않음).
- 응답 `{provider:'typesafe', model, policyVersion:'jev-routing/v1', evaluatedCount, threshold, expertIds, matches[{expertId, relevance}], queryHash, expiresAt}`.
  `expertIds` 는 지금 카탈로그의 실제 id·중복 없음·1..한도(서버·방문자·routing.maxExperts 중 가장 작은 값, 최대 5)여야 하며,
  아니면 팀을 버리고 아무것도 만들지 않는다.
- 성공하면 같은 브리프·같은 `requestId` 로 `POST /api/cloudbite/projects`
  `{title, objective, context, requestId, mode, expertIds, routing:'jev'}` (다른 경로 메타데이터는 보내지 않는다).

## 화면 동작

- routing 이 있으면 기본은 "Jev selects your experts" 상자다. 직접 고르기는 숨겨지고, 실행 버튼 한 번으로
  경로 → 만들기(실제 실행) 또는 경로 → 이 탭의 시뮬레이션(브라우저 데모)이 이어진다. 미리보기 버튼은 없다 — 실행마다 새 `requestId`.
- 진행: 시작 버튼 "Choosing experts…"·상태 "Routing" → 기존 Starting/샌드박스 준비 → 실행 → 완료/오류.
  진행 세부에는 "Experts chosen by Jev" 단계가 앞에 붙는다.
- 고른 팀은 읽기 전용 목록으로, 적합도는 "selection suitability NN%" 로만 보인다 (0–1 밖이면 숫자 그대로). 확신도·정확도라고 쓰지 않는다.
- `ready:false`: 이유를 보이고 시작을 잠근다. 규칙 기반 제안·직접 선택으로 몰래 바꾸지 않는다.
- 자격 없는 공개 사용자: Jev 를 부르지 않고(유료 호출 없음) 로그인·접근이 필요하다고 알리며, "Choose experts manually instead" 로
  명시적으로 바꾼 경우에만 예전 브라우저 데모가 돈다.
- 직접 고르기 / Jev 선택은 사용자가 누를 때만 바뀌고 KO/EN 전환 뒤에도 남는다. 규칙 기반 팀 제안은 직접 고르기 안에만 남는다(Jev 로 표시하지 않음).
- 역할 카탈로그는 Jev 모드에서 둘러보기 전용(상자 잠김)이다.

## 상태 보호

- 경로 응답·만들기 응답은 기존 세대 값(`S.gen`)으로 거른다. 고르는 중 Stop → 세대 증가, 늦게 온 팀으로 만들지 않는다.
- 고르는 동안 브리프·실행 방식·자동/직접 전환은 잠기고, 언어를 바꿔도 예시 브리프 글자를 바꾸지 않는다. 만들기는 누른 순간의 브리프를 쓴다.
- 경로 실패(422·503·429·409·401/403·네트워크·깨진 팀)는 오류로만 보이고 재시도·대체가 없다. 다시 실행하면 새 `requestId` 로 다시 고르며,
  실패하면 이전 팀을 보이거나 쓰지 않는다. 브리프를 고치면 이전 선택이 오래됐다고 알린다.

## 결정·남은 위험

- 브라우저 데모 + Jev: 경로는 실제 서버 호출이지만 실행은 기존처럼 이 탭의 시뮬레이션이며 `POST /projects` 를 보내지 않는다
  (콘솔 데모는 원래 서버 프로젝트를 만들지 않는다). 서버 데모 프로젝트를 원하면 조정자가 정해야 한다.
- 경로 미리보기 캐시(10분)는 쓰지 않는다 — 실행할 때마다 한 번 묻는다.
- relevance 척도는 0–1 로 가정해 표시한다. 다른 척도면 표시만 숫자로 바뀐다.

## 확인

- `node test/cloudbite-console.mjs` — 75 통과 (Jev 10개 추가: 정리, 소유자·방문자·토큰 경로, 실패·깨진 팀, 취소·늦은 응답, KO/EN, 데모, 공개·준비 안 됨, 다시 실행, 옛 bootstrap).
- `npm run build:cloudbite-console`, `node tools/build-cloudbite-console.mjs --check`, `tsc --noEmit`, `tsc -p tsconfig.client.json` 통과.
