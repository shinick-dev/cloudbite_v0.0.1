# Cloudbite 컴퓨터 비용 화면

읽기 전용 비용·크레딧 화면이다. 아무것도 켜거나 끄거나 옮기지 않으며, 예산 강제·자동 크레딧 이전·스케일 조정은 없다.

## 구성

| 파일 | 역할 |
|---|---|
| `src/cloudbite-computer-costs.ts` | `computerCosts(env, { refresh, ownerTag, deps })` — 서버 쪽 조회·정규화·캐시 |
| `client/cloudbite-computer-costs.ts`, `.css` | 모바일 화면 원본 (KO/EN) |
| `tools/build-cloudbite-computer-costs.mjs` | 원본 → `src/cloudbite-computer-costs-page.ts` 생성 (`--check` 로 최신 여부 확인) |
| `test/cloudbite-computer-costs.mjs` | 주입한 fetch 와 가짜 DOM 으로 검증 (네트워크·키 없음) |

라우팅은 루트 소유다: 소유자 쿠키 확인 후
`GET /api/cloudbite/computer/costs[?refresh=1]` → `computerCosts(env, { refresh, ownerTag: await computerOwnerTag() })` 의 `{ status, body }`,
`/cloudbite/computer/costs` · `costs.js` · `costs.css` → `CLOUDBITE_COMPUTER_COSTS_HTML/JS/CSS`.
페이지는 인라인 스크립트·스타일이 없어 `script-src 'self'; style-src 'self'` 로 충분하다. 401 이면 메인 컴퓨터 화면 로그인 링크만 보인다 (WebAuthn 없음).

## 출처 (2026-10-19 공식 문서 확인)

- Daytona OpenAPI `https://www.daytona.io/docs/openapi.json`
  - `GET /sandbox?limit&cursor` → `{ items, nextCursor }` (cpu, memory GiB, disk GiB, gpu, state, organizationId)
  - `GET /organizations/{organizationId}/usage` → `regionUsage[]` 의 `current*`/`total*`, `max*PerSandbox`. 조직 ID 는 조회된 샌드박스의 `organizationId` 에서만 얻는다. 샌드박스가 없으면 한도는 "알 수 없음".
- Daytona 청구 문서 `https://www.daytona.io/docs/en/billing`: 실행 중 = 예약 자원 전부, 정지 = 예약 디스크만, 보관 = 과금 없음. **잔액·지갑 API 는 없다** — 화면은 대시보드 지갑 링크만 보여 준다.
- 가격은 `COMPUTER_PRICING` (`https://www.daytona.io/pricing`) 을 그대로 재사용한다. 실행 중 `computerHourlyCost({cpu, memoryGiB, diskGiB})`, 정지 `computerHourlyCost({cpu:0, memoryGiB:0, diskGiB})`.
- Nosana OpenAPI `https://api.nosana.com/api/openapi.json`: `GET /credits/balance` (Bearer 키) → `assignedCredits`·`reservedCredits`·`settledCredits`, 단위 **USD 센트**. 사용 가능 = assigned − reserved − settled. 호출 주소는 `https://api.nosana.com/api/credits/balance`, 키는 `CLOUDBITE_COMPUTER_NOSANA_API_KEY` 만 쓴다 (추론용 `CLOUDBITE_NOSANA_API_KEY` 는 쓰지 않는다).

## 정직성 규칙

- 공급자 실패(예: Daytona 403)는 `unavailable` + 고정 오류 코드(`unauthorized`·`forbidden`·`timeout`·`unreachable`·`rate_limited`·`upstream_error`·`invalid_response`)이며 0 으로 바꾸지 않는다. 공급자 본문·이메일·키는 응답에 들어가지 않는다.
- Nosana 값은 세 필드가 모두 유한한 숫자일 때만 `ok` 이고, 아니면 숫자 없이 `invalid_response`.
- GPU 샌드박스, 크기를 모르는 샌드박스, 전이 상태(starting 등)는 요금 `null` 로 세기만 하고 합계에 넣지 않는다. 스냅샷·볼륨·네트워크·GPU 는 `excluded` 로 명시한다.
- 추정(시간당 비용)과 잔액(공급자 보고)은 화면에서 별도 섹션이다. 최대 CPU 같은 한도는 공급자 `usage` 응답에서만 나온다.

## 한계

- 계정당 2쪽 × 100개, 요청당 10초, 계정은 병렬(최대 3). 더 있으면 `truncated`·`partial`.
- 캐시 60초, 설정(키·계정·소유자)의 SHA-256 다이제스트별로 분리. `refresh=1` 도 10초 안의 캐시는 재사용한다. 동시 요청은 한 번의 관측을 공유한다.
- 실제 키로 한 실측은 아직 없다 — 루트가 배포 전 실제 GET 으로 확인한다.

## Verified Nosana unit discrepancy

On 2026-10-19 the live balance endpoint returned assignedCredits=20 and settledCredits=1.254. Transactions use amountUsd, and the same 50-minute reservation appears as a $0.303 job_debit (with a $0.293 refund), matching raw credit amounts. The OpenAPI field descriptions say cents, but that does not match the active API. This integration therefore uses the returned values directly as USD, without dividing by 100. Recheck against amountUsd if the provider changes this contract. This display does not authorize spending.
