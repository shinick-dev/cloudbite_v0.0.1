# Cloudbite expert pool expansion A (25 starter roles)

- 작성일: 2026-10-19 (KST). 출처 확인 배치 시각은 UTC 2026-10-18T15:33Z.
- 데이터: `src/cloudbite-expansion-a.ts` (`EXTENSION_A_PACKS: PhaseOneKnowledgePack[]`, 인터페이스는 `src/cloudbite-phase-one-data.ts`에서 type-only import)
- Held-out 평가 케이스: `test/fixtures/pool-expansion-a-evaluation.jsonl` (75건, 런타임 모듈에 포함하지 않음)
- 로스터: `docs/cloudbite/expert-pool-100.md` §3
- 버전: `expansion-2026-10-19.1`
- 상태: **starter knowledge, unvalidated.** 검증된 전문가 역할이 아니다. 평가 케이스는 작성만 되었고 채점·통과 결과는 없다.

## 범위와 통합 상태

이 작업은 25개 역할의 지식 팩 데이터와 평가 케이스, 이 문서만 추가한다. 레지스트리·페르소나·러너·UI·`package.json`에는 연결하지 않았다. 통합(레지스트리 등록, 런타임 검토 역할 강제, 전체 앱 검사)은 코디네이터 소관이다. 이 묶음에는 검토 역할(#95–98)이 없다.

## 역할별 구성

모든 팩: 질문 3, 방법 5, 제한 3, 산출물 2(`out/rNNN-<slug>.<md|csv|json>`), 도구 `workspace-artifact-write`, `knowledge-search`, `calculation`(런타임이 실제 권한으로 필터링), 카드 6장(각 200자 이상, 한·영 match term 포함, `cbNNN-topic` ID, `roles:[expertId]`).

| 번호 | expertId | 이름 | 카드 | 출처 (unverified 표시) | 산출물 | 팩 JSON 바이트 |
|---|---|---|---|---|---|---|
| 3 | cb-role-003 | Market Research Analyst | 6 | census-naics, census-cbp, eurostat-sbs, kosis | `out/r003-market-sizing.md`, `out/r003-segment-table.csv` | 11062 |
| 5 | cb-role-005 | Competitive Intelligence Analyst | 6 | sec-edgar (unverified), dart-korea, uspto-ppubs | `out/r005-alternative-map.md`, `out/r005-evidence-register.csv` | 10079 |
| 6 | cb-role-006 | Business Model Architect | 6 | stripe-pricing-models, sba-business-plan, ifrs-15 | `out/r006-model-canvas.md`, `out/r006-unit-economics.csv` | 10174 |
| 7 | cb-role-007 | Product Portfolio Strategist | 6 | hmt-green-book, hmt-magenta-book, gov-uk-agile-delivery | `out/r007-bet-inventory.csv`, `out/r007-funding-plan.md` | 9968 |
| 8 | cb-role-008 | Product Analytics Specialist | 6 | ga4-events, nist-sematech-handbook, gov-uk-measuring-success | `out/r008-metric-definitions.md`, `out/r008-tracking-plan.csv` | 10025 |
| 9 | cb-role-009 | Platform & Ecosystem Strategist | 6 | eu-dma, apple-app-review, google-play-policy | `out/r009-network-effects.md`, `out/r009-dependency-register.csv` | 10246 |
| 10 | cb-role-010 | International Expansion Specialist | 6 | w3c-i18n, unicode-cldr, eu-gdpr, world-bank-data | `out/r010-country-order.md`, `out/r010-localisation-checklist.csv` | 10544 |
| 12 | cb-role-012 | Service Designer | 6 | gov-uk-service-standard, gov-uk-user-research, gov-uk-agile-delivery | `out/r012-service-blueprint.md`, `out/r012-failure-points.csv` | 9951 |
| 13 | cb-role-013 | Information Architect | 6 | w3c-wai-menus, w3c-wcag22, govuk-design-system, gov-uk-user-research | `out/r013-site-map.md`, `out/r013-tree-test-plan.csv` | 10044 |
| 15 | cb-role-015 | Visual Interface Designer | 6 | w3c-wcag22, material-design-3, apple-hig (unverified), govuk-design-system | `out/r015-design-tokens.json`, `out/r015-hierarchy-review.md` | 10513 |
| 16 | cb-role-016 | Content Designer | 6 | gov-uk-content-design, plain-language-gov, govuk-design-system | `out/r016-copy-review.md`, `out/r016-terminology.csv` | 9978 |
| 17 | cb-role-017 | Accessibility Specialist | 6 | w3c-wcag22, w3c-aria-apg, w3c-wai-aria-12 | `out/r017-issue-log.csv`, `out/r017-test-plan.md` | 10056 |
| 18 | cb-role-018 | Behavioral Scientist | 6 | bit-east, ftc-dark-patterns (unverified), oecd-basic (unverified) | `out/r018-behaviour-diagnosis.md`, `out/r018-intervention-plan.csv` | 10340 |
| 19 | cb-role-019 | Onboarding Specialist | 6 | nist-sp-800-63b, w3c-wcag22, google-pair-guidebook, gov-uk-service-standard | `out/r019-first-value-path.md`, `out/r019-onboarding-funnel.csv` | 10208 |
| 22 | cb-role-022 | Frontend Engineer | 6 | web-dev-vitals, whatwg-html, mdn-web-docs | `out/r022-state-map.md`, `out/r022-performance-budget.csv` | 9807 |
| 23 | cb-role-023 | Backend Engineer | 6 | rfc-9110, rfc-9457, owasp-asvs, aws-builders-idempotent | `out/r023-endpoint-review.csv`, `out/r023-job-design.md` | 10651 |
| 24 | cb-role-024 | Mobile Engineer | 6 | android-architecture, android-vitals, apple-hig (unverified), owasp-masvs | `out/r024-architecture-review.md`, `out/r024-device-constraints.csv` | 10625 |
| 25 | cb-role-025 | API & Integration Architect | 6 | openapi-spec, rfc-6749, rfc-9110, aws-builders-retries | `out/r025-integration-contract.md`, `out/r025-failure-matrix.csv` | 10841 |
| 26 | cb-role-026 | Database Engineer | 6 | postgres-isolation, postgres-explain, postgres-ddl-constraints, sqlite-transactions | `out/r026-schema-review.md`, `out/r026-query-plan-notes.csv` | 10462 |
| 27 | cb-role-027 | Distributed Systems Engineer | 6 | aws-builders-retries, aws-builders-idempotent, google-sre-book, rfc-9110 | `out/r027-failure-walkthrough.md`, `out/r027-retry-policy.csv` | 10955 |
| 28 | cb-role-028 | Real-time Collaboration Engineer | 6 | crdt-shapiro-hal (unverified), yjs-docs, rfc-6455 | `out/r028-sync-design.md`, `out/r028-conflict-cases.csv` | 10147 |
| 29 | cb-role-029 | Software Quality Engineer | 6 | nist-ssdf, playwright-docs, google-sre-book | `out/r029-test-strategy.md`, `out/r029-release-gate.csv` | 10165 |
| 30 | cb-role-030 | Legacy Modernization Engineer | 6 | fowler-strangler-fig, azure-strangler-fig, aws-pg-strangler-fig | `out/r030-migration-plan.md`, `out/r030-component-decisions.csv` | 10162 |
| 32 | cb-role-032 | LLM Application Engineer | 6 | json-schema-spec, owasp-llm-top10, nist-ai-600-1 | `out/r032-output-schema.json`, `out/r032-context-plan.md` | 10368 |
| 34 | cb-role-034 | Multi-agent Systems Engineer | 6 | nist-ai-rmf-core, owasp-llm-top10, mcp-spec | `out/r034-role-matrix.csv`, `out/r034-coordination-design.md` | 10282 |

합계: 팩 25개, 카드 150장(ID 전역 고유, 기존 phase-one 카드와도 겹치지 않음), 팩 안 출처 기록 85개, 서로 다른 출처 70개. 팩별 JSON 약 10–11 KB(카드·출처 파일 48 KiB, 팩 192 KiB 한도 안).

## 작성 원칙

- 카드는 Cloudbite용으로 직접 쓴 요약·체크리스트·계산법·실패 패턴이다. 원문 인용이나 복사가 없고, 출처는 `download_policy: link-only`로 URL 메타데이터만 둔다. 라이선스 매뉴얼·벤더 문서 본문을 옮기지 않았다.
- 카드 내용은 해당 분야의 일반적 방법을 의역한 것이다. 출처 기록은 "어디서 확인할 수 있는가"를 가리키며, 카드의 모든 문장이 그 문서에 그대로 있다는 뜻이 아니다.
- 지시문(`instructions`)은 역할별로 입력 가정, 검토 방법, 유보·인계 조건, 확신도 근거를 담고, 공통 꼬리말로 시뮬레이션 AI 역할·자격 없음·미검증 팩, brief와 카드 텍스트의 비신뢰 경계, 팩 안 ID만 인용하는 인용 경계, 사전 숫자 없는 자기평가 확신도를 명시한다.
- 규제성 주제(접근성 법적 준수, 개인정보 국외 이전, 세무·고용, 수익 인식, 앱스토어 정책, 특허)는 자격 있는 사람의 검토로 넘기고 관할·버전·날짜 확인을 요구한다. 인증·서명·준수 확인을 하지 않는다.
- 런타임 모듈은 `import type` 하나만 쓰며 config·페르소나·DO를 import하지 않고 네트워크를 쓰지 않는다. 평가 케이스·원문 페이지 텍스트는 런타임 모듈에 없다.

## 출처 확인 결과

한 번의 제한된 배치로 고유 URL 70개를 각각 HTTP GET 1회(리다이렉트 추적, 20초 제한) 조회했다. `retrieved`는 HTTP 200이고 도달한 페이지의 제목(또는 PDF 헤더)이 기록한 문서를 가리킬 때만 붙였고, `checkedAt`은 실제 조회 시각(UTC), `checkNote`에 상태 코드·리다이렉트 대상·제목을 남겼다. 이는 문서가 존재하고 그 문서라는 확인일 뿐, 카드 해석이 문서와 일치한다는 검증이 아니다.

- retrieved: 고유 출처 65개 (팩 안 기록 79개)
- unverified: 고유 출처 5개 (팩 안 기록 6개), 모두 `checkedAt` 빈 값
  - `sec-edgar`: HTTP 403 Request Rate Threshold Exceeded(연락처를 밝히지 않은 자동 클라이언트). 내용 미확인.
  - `ftc-dark-patterns`: 이 URL과 ftc.gov 홈까지 HTTP 404(사이트가 이 클라이언트를 거부). URL 자체가 맞는지도 확인 못 함.
  - `oecd-basic`: DOI 10.1787/9ea76a8f-en이 이 URL로 리다이렉트됨은 확인, 본문은 HTTP 403 봇 차단.
  - `crdt-shapiro-hal`: HAL이 봇 확인 페이지를 반환. 레코드 제목·내용 미확인.
  - `apple-hig`: HTTP 200이지만 제목 없는 JavaScript 셸. 내용 미확인.
- 리다이렉트로 문서명이 바뀐 3건은 기록 제목을 도달한 문서에 맞췄다: `gov-uk-content-design`(→ Writing to GOV.UK standards), `plain-language-gov`(→ digital.gov Plain language guide series), `sba-business-plan`(→ SBA Plan your business). URL은 원래 링크를 유지하고 `checkNote`에 이동 대상을 남겼다.
- 원 조회 기록(상태·제목 TSV)은 작성 세션의 스크래치패드에만 있고 저장소에 커밋하지 않았다. 페이지 본문도 저장하지 않았다.

## Held-out 평가 케이스

`test/fixtures/pool-expansion-a-evaluation.jsonl`: 역할당 정확히 3건(`normal`, `missing-info`, `out-of-scope`), 총 75건. ID는 `cbNNN-case1..3`으로 전역 고유. 필드는 기존 `pool-phase-one-evaluation.jsonl`과 같은 `id, expertId, catalogNumber, type, prompt, pass_criteria, fail_conditions`. 카드 문장을 복사하지 않은 새 결정 질문이며, 기대 기준과 실패·유보 조건만 있고 모범 답안이나 점수는 없다. 아직 어떤 모델 실행으로도 채점하지 않았다.

## 수행한 구조 점검 (로컬, 통합 전)

작업 트리에 의존성이 없어 상위 저장소의 `node_modules`(esbuild, tsc)를 절대 경로로 사용했다. 스크래치패드의 점검 스크립트를 esbuild로 번들해 다음을 확인했고 결과는 PASS다.

- 25개 팩 각각 `checkKnowledgePack` 통과, `knowledgeWorkspaceFiles`가 파일 4개 생성
- 로스터와 catalogNumber/expertId/name/domain 정확히 일치, 인터페이스 필드 집합 일치, 버전 문자열 일치
- 질문·방법·제한 각 3개 이상, 지시문 필수 요소 포함
- 팩당 카드 6장, 각 200자 이상, match term 3개 이상(한글·영문 각각 포함), 카드 자신의 term으로 검색 시 매칭됨, 카드 ID·요약 중복 없음(phase-one 포함)
- 팩당 출처 2개 이상, 모든 출처가 카드에서 쓰임, unverified는 `checkedAt` 빈 값, retrieved는 UTC 시각
- 산출물 정확히 2개, `out/rNNN-…` 평면 경로·예약 이름 아님·전역 고유
- 카드·출처 JSON 48 KiB, 팩 192 KiB 이하
- 평가 케이스 75건, 역할당 3유형, ID 형식·고유성, 카드 문장 80자 이상 일치 없음

추가로 `tsc --strict`(ES2022+DOM lib)로 새 모듈과 `cloudbite-knowledge.ts`를 함께 타입 검사해 오류 0을 확인했다. 전체 앱 검사·테스트 스위트·레지스트리 연결은 하지 않았다.

## 알려진 공백과 위험

- 모든 팩은 미검증 starter다. 평가 케이스로 실제 실행·채점한 결과가 없다.
- `cb-role-018`(Behavioral Scientist)은 retrieved 출처가 `bit-east` 하나뿐이다. FTC·OECD 문서를 다른 환경에서 확인하거나 대체 1차 출처를 찾아야 한다.
- `cb-role-015`, `cb-role-024`의 `apple-hig`, `cb-role-028`의 CRDT 논문, `cb-role-005`의 EDGAR는 미확인이다.
- 출처 확인은 "문서가 맞다"는 수준이다. 카드의 특정 주장(예: WCAG 2.2 신규 기준 이름, SP 800-63B의 비밀번호 규칙 권고, 대비율 공식)은 원문 대조를 거치지 않았다.
- 인접 역할 번호(예: 39 Experimentation, 52 AppSec, 53 Identity, 57 Privacy, 58 Contracts, 60 Compliance, 61 Pricing, 62 FP&A)를 인계 대상으로 적었으나 해당 역할 팩의 존재 여부는 이 작업에서 확인하지 않았다.
- 일부 라이선스 표기(JSON Schema, HAL, Android 문서)는 "verify"로 남겼다.
- 벤더 문서(Stripe, Apple, Google, AWS, Microsoft)는 1차 출처지만 특정 벤더 관점을 반영한다.
