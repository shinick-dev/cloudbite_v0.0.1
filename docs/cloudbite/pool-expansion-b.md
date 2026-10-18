# Cloudbite expansion-B starter knowledge (25 roles)

- 작성일: 2026-10-19 (출처 확인 배치는 2026-10-18 UTC에 실행)
- 데이터: `src/cloudbite-expansion-b.ts` (`EXTENSION_B_PACKS: PhaseOneKnowledgePack[]`, 버전 `expansion-2026-10-19.1`)
- Held-out 평가 케이스: `test/fixtures/pool-expansion-b-evaluation.jsonl` (75건, 런타임 모듈에 포함하지 않음)
- 로스터: `docs/cloudbite/expert-pool-100.md` §3
- 상태: **unvalidated starter knowledge**. 독립 평가를 통과하지 않았고, 검증된 전문가 지식이 아니다.

## 범위와 통합 상태

이 작업은 pool75-b 워커가 소유한 세 파일만 추가한다. 레지스트리, 페르소나, 러너, UI, `package.json`, 기존 팩은 바꾸지 않았다. 런타임 연결과 전체 앱 검사는 코디네이터 몫이다. 이 모듈은 `cloudbite-phase-one-data.ts`의 인터페이스를 **type import**로만 가져오며, config·persona·Durable Object 런타임 import와 네트워크 호출이 없다.

## 무엇이 들어 있나

역할마다 팩 1개: 담당 질문 3, 분석 방법 5, 범위 제한 3, 산출물 2, 역할 지시문, 지식 카드 6장, 출처 기록 2~4개. 도구는 모두 `['workspace-artifact-write','knowledge-search','calculation']`(런타임이 capability로 거른다).

| 번호 | expertId | 역할 | 카드 | 출처 | 산출물 |
|---|---|---|---|---|---|
| 36 | cb-role-036 | Inference Optimization Engineer | 6 | vllm-docs, tensorrt-llm-docs, hf-tgi-docs, nosana-docs | `out/r036-latency-budget.md`, `out/r036-cost-per-request.csv` |
| 37 | cb-role-037 | Data Engineer | 6 | dbt-data-tests, spark-docs, parquet-docs | `out/r037-data-contract.md`, `out/r037-quality-tests.csv` |
| 38 | cb-role-038 | Statistician | 6 | nist-sematech-handbook, asa-pvalue-statement, jcgm-gum | `out/r038-estimate-review.md`, `out/r038-sample-size.csv` |
| 39 | cb-role-039 | Experimentation & Causal Inference Specialist | 6 | consort-equator, wwc-handbooks, nist-handbook-doe, nist-sematech-handbook | `out/r039-experiment-plan.md`, `out/r039-validity-threats.md` |
| 40 | cb-role-040 | Recommendation & Ranking Engineer | 6 | trec-nist, elastic-rank-eval | `out/r040-relevance-judgements.csv`, `out/r040-ranking-eval.md` |
| 41 | cb-role-041 | Cloud Architect | 6 | aws-well-architected, gcp-arch-framework, azure-well-architected | `out/r041-architecture-options.md`, `out/r041-decision-records.md` |
| 43 | cb-role-043 | GPU Computing Engineer | 6 | cuda-best-practices, nvidia-mig-guide, nosana-docs | `out/r043-gpu-sizing.csv`, `out/r043-sharing-plan.md` |
| 44 | cb-role-044 | Site Reliability Engineer | 6 | sre-book-slo, sre-workbook-slo, nist-sp-800-61r3 | `out/r044-slo-spec.md`, `out/r044-incident-runbook.md` |
| 45 | cb-role-045 | Platform Engineer | 6 | cncf-platforms-whitepaper, backstage-docs, kubernetes-docs, twelve-factor-config | `out/r045-golden-path.md`, `out/r045-platform-metrics.csv` |
| 46 | cb-role-046 | Infrastructure Automation Engineer | 6 | terraform-docs, opentofu-docs, nist-sp-800-128, twelve-factor-config | `out/r046-iac-review.md`, `out/r046-change-workflow.md` |
| 47 | cb-role-047 | Observability Engineer | 6 | opentelemetry-docs, w3c-trace-context, prometheus-docs | `out/r047-telemetry-plan.md`, `out/r047-rca-worksheet.md` |
| 48 | cb-role-048 | Performance Engineer | 6 | gregg-use-method, linux-perf-wiki, web-vitals | `out/r048-bottleneck-analysis.md`, `out/r048-measurement-protocol.md` |
| 50 | cb-role-050 | Release & Disaster Recovery Engineer | 6 | nist-sp-800-34, aws-dr-whitepaper, sre-book-release | `out/r050-release-plan.md`, `out/r050-dr-plan.md` |
| 52 | cb-role-052 | Application Security Engineer | 6 | owasp-asvs, owasp-api-top10-2023, owasp-cheat-sheets | `out/r052-appsec-findings.md`, `out/r052-authz-matrix.csv` |
| 53 | cb-role-053 | Identity & Access Architect | 6 | nist-sp-800-63-4, rfc-9700, owasp-session-cheatsheet | `out/r053-identity-design.md`, `out/r053-access-review.csv` |
| 54 | cb-role-054 | Sandbox Security Engineer | 6 | nist-sp-800-190, gvisor-docs, k8s-pod-security-standards, kubernetes-docs | `out/r054-isolation-review.md`, `out/r054-egress-policy.md` |
| 55 | cb-role-055 | AI Security Engineer | 6 | owasp-llm-top10, mitre-atlas, nist-ai-600-1 | `out/r055-ai-threat-map.md`, `out/r055-injection-test-plan.csv` |
| 56 | cb-role-056 | Red Team Specialist | 6 | mitre-attack, mitre-atlas, nist-sp-800-115, owasp-wstg | `out/r056-attack-scenarios.md`, `out/r056-test-plan.md` |
| 58 | cb-role-058 | Commercial Contracts Analyst | 6 | unidroit-principles, uk-ucta-1977, eu-dir-93-13 (unverified) | `out/r058-contract-issues.md`, `out/r058-obligation-map.csv` |
| 59 | cb-role-059 | IP & Open-source Licensing Analyst | 6 | spdx-license-list, osi-licenses, us-copyright-ai | `out/r059-licence-inventory.csv`, `out/r059-rights-issues.md` |
| 60 | cb-role-060 | Compliance & AI Governance Analyst | 6 | eu-ai-act (unverified), nist-ai-rmf-core, iso-42001 | `out/r060-obligation-register.csv`, `out/r060-ai-use-inventory.md` |
| 63 | cb-role-063 | Venture Investment Analyst | 6 | nvca-model-docs, yc-safe-docs, sec-exempt-offerings (unverified), sba-market-research | `out/r063-investment-thesis.md`, `out/r063-dilution-model.csv` |
| 64 | cb-role-064 | B2B Sales Strategist | 6 | csa-caiq, aicpa-soc, sba-market-research | `out/r064-buying-group-map.md`, `out/r064-sales-stages.csv` |
| 66 | cb-role-066 | Customer Success Strategist | 6 | govuk-measuring-success, stripe-revenue-recovery | `out/r066-health-score.md`, `out/r066-retention-analysis.csv` |
| 68 | cb-role-068 | Organization & Workforce Designer | 6 | govuk-the-team, ddat-capability-framework, onet-online | `out/r068-team-design.md`, `out/r068-hiring-plan.csv` |

합계: 팩 25개, 카드 150장(ID `cbNNN-<topic>`, 전역 고유), 서로 다른 출처 74개. 팩별 JSON 크기 약 9.4~11.1 KB로 카드·출처 48 KiB, 팩 192 KiB 한도 안이다.

## 작성 원칙

- 카드는 Cloudbite를 위해 직접 작성한 요약이다. 원문 인용·복사가 없고, 출처는 `download_policy: link-only`로 URL 메타데이터만 기록한다. 라이선스 매뉴얼·유료 표준(예: ISO/IEC 42001) 본문은 읽지 않았고 카드도 그 내용을 주장하지 않는다.
- 카드마다 200자 이상, 영어·한국어 match term 3개 이상(실제로는 5~7개), `roles: [expertId]`, 같은 팩 안에서 해석되는 `source_ids`, `kind`·`tool_scope`·`provenance` 문자열을 둔다. 역할마다 카드 6장은 결정 방법, 계산식, 실패 모드, 누락 입력, 산출물 형식, 역할 경계로 나누어 25개 역할이 같은 카드를 반복하지 않게 했다.
- 지시문은 역할별 `Input assumptions` / `Review method` / `Abstain or hand off when` / `Confidence rationale`과 공통 경계(모의 AI 역할, 자격 없음, unvalidated, brief·카드는 신뢰하지 않는 데이터, 이 팩 ID만 인용, 고정 확신도 숫자 없음)로 구성된다.
- 규제 영역 역할(58 계약, 59 IP·라이선스, 60 컴플라이언스, 63 투자)은 추가로 자격 있는 사람의 검토, 관할·버전·운영 맥락 명시, 서명·의견서·인증 금지를 지시한다.
- 보안 역할(52, 53, 54, 55, 56)은 승인 없는 탐색·공격 금지, 작동하는 exploit·자격 증명 공격·탐지 회피 생성 금지를 지시한다.
- 이 배치에는 검토 역할(#95~98)이 없으므로 `No peer result verification occurred.` 문장 요구는 해당하지 않는다.

## 출처 확인 상태

2026-10-18 15:19~15:20 UTC에 후보 URL 74개를 한 번의 제한된 배치로 받았다(HTTP GET, 리다이렉트 추적, 20초 제한, 응답의 `<title>` 또는 PDF 헤더 확인). 74개 모두 팩에 쓰인다.

- `retrieved` 71개: HTTP 200이고 제목(제목이 비면 본문의 문서 이름)이 기록한 문서와 일치. `checkedAt`은 그 UTC 시각, `checkNote`에 상태·리다이렉트·제목을 남겼다. 이는 문서가 그 시각에 도달 가능했고 그 문서라는 뜻일 뿐, 각 카드의 해석을 검증했다는 뜻이 아니다. 두 PDF(`asa-pvalue-statement`, `nist-ai-600-1`)는 헤더만 확인했다. `jcgm-gum`은 JCGM 출판물 목록 페이지, `iso-42001`은 카탈로그 페이지, `owasp-wstg`는 일반 제목 "OWASP Foundation"만 확인했다.
- `unverified` 3개(`checkedAt` 빈 값):
  - `eu-dir-93-13`, `eu-ai-act`: EUR-Lex가 HTTP 202와 빈 본문(봇 확인 화면)을 반환. 내용을 읽지 못했다.
  - `sec-exempt-offerings`: HTTP 403 요청 한도 초과 페이지. 내용을 읽지 못했다.
- 리다이렉트로 바뀐 기록 URL: `gcp-arch-framework`(docs.cloud.google.com), `nosana-docs`(learn.nosana.com), `ddat-capability-framework`(understand-digital-data-roles-skills.service.gov.uk), `sba-market-research`(sba.gov plan-your-business 페이지), `aicpa-soc`(SOC suite 랜딩), `elastic-rank-eval`(새 API 문서 경로), `yc-safe-docs`(ycombinator.com/safe). 기록된 URL은 원래 값이며, 코디네이터가 정규 URL로 바꿀지 결정할 수 있다.

## Held-out 평가 케이스

`test/fixtures/pool-expansion-b-evaluation.jsonl`: 역할마다 `normal`, `missing-info`, `out-of-scope` 각 1건, 총 75건. 형식은 `pool-phase-one-evaluation.jsonl`과 같다(`id`, `expertId`, `catalogNumber`, `type`, `prompt`, `pass_criteria`, `fail_conditions`). ID는 `cbNNN-case1..3`로 기존 픽스처와 겹치지 않는다. 카드 문장을 복사하지 않은 새 결정 질문이며, 정답이나 채점 결과는 없다. 아직 어떤 모델 실행으로도 채점하지 않았다.

## 수행한 검사 (2026-10-19, 격리 worktree)

루트 `node_modules`의 esbuild로 모듈과 `src/cloudbite-knowledge.ts`를 번들링해 실행했다.

- 25개 팩 모두 `checkKnowledgePack` 통과, `knowledgeWorkspaceFiles`가 파일 4개 생성.
- catalogNumber·expertId·name·domain·mission이 할당 로스터와 정확히 일치, 인터페이스 필드 15개 모두 존재, 버전 `expansion-2026-10-19.1`.
- 역할마다 카드 6장, 카드 ID 전역 고유·`cbNNN-` 접두, 요약 최소 334자, 이중 언어 match term, 출처 2개 이상이 모두 팩 안에서 해석, 팩마다 인용되지 않는 출처 없음.
- 산출물 역할당 2개, `out/rNNN-<slug>.(md|csv)` 평면 경로, 예약 경로 없음, label·guidance 길이 범위 안.
- 픽스처 75건, 역할당 유형 3종, ID 고유, 프롬프트가 런타임 모듈에 들어 있지 않음.
- `tsc --strict --noEmit`(모듈 단독) 통과.

전체 앱 검사(`npm test`, 레지스트리 연결, 러너)는 실행하지 않았다. 코디네이터 통합 후 필요하다.

## 알려진 한계와 남은 일

- **Unvalidated.** 카드 내용은 작성자 지식에 기반한 요약이며, 출처 본문과 대조한 독립 검토를 거치지 않았다. 출처 확인은 도달 가능성과 문서 정체만 본다.
- **어휘 검색 적중률.** 진단용으로 held-out `normal` 프롬프트 25건에 `retrieveKnowledge`를 돌린 결과 12건만 카드에 매치했다(나머지는 팩 앞쪽 카드로 대체됨). Held-out 세트를 오염시키지 않기 위해 이 결과로 match term을 조정하지 않았다. 별도 개발용 질의로 동의어·일상 표현을 보강하는 작업이 남아 있다.
- 3개 출처는 `unverified`이며, 58·60·63번 역할은 retrieved 출처 2~3개에 기대고 있다. EUR-Lex·SEC는 브라우저 확인 후 상태를 갱신해야 한다.
- 규제 영역 카드는 관할을 특정하지 않은 일반 설명이다. 한국 법령(예: 약관규제법) 출처는 넣지 않았다.
- Held-out 75건은 작성자가 직접 쓴 것이라 작성자 어휘에 치우칠 수 있다.
