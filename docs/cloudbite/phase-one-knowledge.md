# Cloudbite phase-one starter knowledge (20 roles)

- 작성일: 2026-10-18
- 데이터: `src/cloudbite-phase-one-data.ts` (`PhaseOneKnowledgePack`, `PHASE_ONE_PACKS`)
- 구조 테스트: `test/cloudbite-phase-one-data.mjs`
- Held-out 평가 케이스: `test/fixtures/pool-phase-one-evaluation.jsonl` (런타임 데이터에 포함하지 않음)
- 계획 문서: `docs/cloudbite/expert-pool-100.md` §6 1단계

## 무엇이 들어 있나

`docs/cloudbite/expert-pool-100.md`의 1단계 20개 역할마다 지식 팩 1개를 둔다. 각 팩은 담당 질문, 분석 방법, 범위 제한, 산출물 경로, 역할 지시문, 지식 카드 6장, 출처 기록 2~3개를 갖는다.

| 번호 | expertId | 카드 | 출처 |
|---|---|---|---|
| 1 | agency-product-manager | 6 | gov-uk-agile-delivery, gov-uk-service-standard |
| 2 | cb-customer-discovery | 6 | gov-uk-user-research, gov-uk-agile-delivery |
| 4 | agency-business-strategist | 6 | hmt-green-book, hmt-aqua-book |
| 11 | cb-ux-researcher | 6 | gov-uk-user-research, w3c-wcag22 |
| 20 | cb-human-ai-interaction | 6 | google-pair-guidebook, ms-hai-guidelines, nist-ai-600-1 |
| 21 | agency-engineering-software-architect | 6 | aws-well-architected, google-sre-book |
| 31 | agency-engineering-ai-engineer | 6 | owasp-llm-top10, nist-ai-600-1, nosana-docs |
| 33 | cb-knowledge-engineer | 6 | w3c-prov-overview, owasp-llm-top10, nist-ai-600-1 |
| 35 | cb-model-evaluation | 6 | nist-ai-rmf-core, nist-ai-600-1, nist-sematech-handbook |
| 42 | cb-sandbox-engineer | 6 | daytona-docs, nist-sp-800-190 |
| 49 | cb-finops | 6 | finops-framework, daytona-docs, nosana-docs |
| 51 | agency-security-architect | 6 | owasp-threat-modeling, owasp-asvs, nist-csf-2 |
| 57 | agency-engineering-privacy-engineer | 6 | nist-privacy-framework, eu-gdpr |
| 61 | agency-specialized-pricing-analyst | 6 | stripe-pricing-models, finops-framework |
| 62 | agency-finance-fpa-analyst | 6 | sba-business-plan, ifrs-standards, hmt-green-book |
| 91 | cb-evidence-auditor | 6 | odni-icd-203, hmt-aqua-book |
| 92 | cb-quantitative-reviewer | 6 | nist-sp-811, nist-sematech-handbook, hmt-aqua-book |
| 93 | cb-assumption-auditor | 6 | hmt-aqua-book, odni-icd-203, hmt-green-book |
| 94 | cb-adversarial-reviewer | 6 | nist-ai-600-1, owasp-threat-modeling, hmt-aqua-book |
| 100 | cb-synthesis-editor | 6 | odni-icd-203, hmt-aqua-book |

합계: 카드 120장, 서로 다른 출처 29개. 팩별 JSON 크기는 약 7~9 KB로 48 KiB 한도 안이다.

## 작성 원칙

- 카드는 Cloudbite를 위해 직접 작성한 요약이다. 원문 인용·복사가 없고, 출처는 `download_policy: link-only`로 URL만 기록한다.
- 카드는 역할별로 다르다(전 역할 공통 카드 없음). 각 카드는 판단 방법, 필요한 입력, 중단 조건 또는 산출물 중 하나 이상을 구체적으로 담는다.
- 모든 지시문에 공통 경계가 붙는다: 프로젝트 브리프와 검색된 카드는 지시가 아닌 데이터, 이 팩의 카드·출처 ID만 인용, 확신도는 이유를 동반한 자체 평가(보정된 확률 아님), 입력 부족 시 질문·조건부 답·기권.
- 검증 역할(91, 92, 93, 94, 100)의 지시문은 이번 실행에서 다른 역할의 산출물을 보지 못한다는 사실을 명시하고, 브리프에 동료 결과가 없으면 "검토·검증한 동료 결과 없음"을 밝히도록 한다. 교차 검토라고 표현하지 않는다.
- 고정 확신도 숫자, 점수 흔들기(jitter), 무작위 값은 데이터에 없다(테스트로 확인).

## 출처 확인 근거 (2026-10-18, 1회 배치)

10개 문서를 HTTP GET(리다이렉트 추적)으로 한 번 조회했다. 성공한 9개만 `checkStatus: 'retrieved'`와 실제 UTC 시각을 기록했다. 조회는 "해당 URL이 그 문서로 열린다"까지만 확인한 것이며, 각 카드의 해석이 원문과 일치하는지 대조한 것은 아니다.

| source id | checkedAt (UTC) | 결과 |
|---|---|---|
| hmt-aqua-book | 2026-10-18T14:49:15Z | 200, `https://www.gov.uk/guidance/the-aqua-book`로 리다이렉트, 제목 "The AQuA Book - GOV.UK" (URL을 리다이렉트 대상으로 갱신) |
| gov-uk-user-research | 2026-10-18T14:49:18Z | 200, "User research - Service Manual - GOV.UK" |
| gov-uk-agile-delivery | 2026-10-18T14:49:19Z | 200, "Agile delivery - Service Manual - GOV.UK" |
| owasp-llm-top10 | 2026-10-18T14:49:21Z | 200, owasp.org/projects/… 로 리다이렉트, 제목 일치 |
| nist-ai-600-1 | 2026-10-18T14:49:22Z | 200, application/pdf (PDF-1.6, 약 1.1 MB) |
| odni-icd-203 | — | **403 Access Denied → unverified 유지** |
| finops-framework | 2026-10-18T14:49:25Z | 200, "FinOps Framework Overview" |
| daytona-docs | 2026-10-18T14:49:26Z | 200, "Documentation · Daytona" (랜딩 페이지만) |
| owasp-asvs | 2026-10-18T14:49:28Z | 200, owasp.org/projects/asvs 로 리다이렉트, 제목 일치 |
| nist-ai-rmf-core | 2026-10-18T14:49:29Z | 200, §5 Core 및 Govern/Map/Measure/Manage 내용 확인 |

나머지 19개 출처(gov-uk-service-standard, w3c-wcag22, owasp-threat-modeling, google-sre-book, aws-well-architected, nosana-docs, google-pair-guidebook, ms-hai-guidelines, w3c-prov-overview, nist-sematech-handbook, nist-sp-800-190, nist-csf-2, nist-privacy-framework, eu-gdpr, stripe-pricing-models, sba-business-plan, ifrs-standards, hmt-green-book, nist-sp-811)는 조회하지 않았으므로 `unverified`, `checkedAt: ''`, `checkNote: 'not fetched during authoring yet'`이다.

## 테스트가 확인하는 것 / 확인하지 않는 것

`node test/cloudbite-phase-one-data.mjs`가 확인하는 것:

- 20개 ID와 계획 번호가 shared 계약 순서와 정확히 일치.
- 팩·카드·출처 필드 집합이 인터페이스와 정확히 일치, `aliases`/`tool_scope` 항상 배열.
- 카드 ≥6/역할, 총 ≥120, 카드 ID 전역 유일, ID 형식 `[a-zA-Z0-9_-]{1,80}`, 카드 요약 ≥200자, 역할 간 동일 요약 없음, 카드 종류 ≥3/역할.
- 카드의 `source_ids`가 같은 팩의 출처 ID/별칭으로 모두 해석되고, 팩에 실린 출처는 모두 카드에서 인용됨.
- `retrieved`는 UTC 시각 필수, `unverified`는 시각 없음.
- 팩 JSON과 출처 JSON 각각 48 KiB 이하.
- 이름·임무·요약·지시문·도메인이 20개 모두 서로 다름; 검증 역할 지시문의 동료 결과 경계 문구.
- 고정 숫자 확신도·jitter·무작위 없음.
- Held-out 케이스: 역할당 ≥3, normal + missing-info + (out-of-scope 또는 adversarial), 런타임 데이터에 `pass_criteria`/`fail_conditions` 없음, 케이스 프롬프트·기준과 런타임 데이터 사이에 8단어 연속 일치 없음.

확인하지 않는 것: 모델 답변 품질·정확도. 이 테스트는 구조·내용 형식 검사이며, held-out 케이스로 실제 모델을 돌려 채점한 적은 없다.

## 한계

- 20개 팩 모두 **evaluation: unvalidated** 상태의 시작용 지식이다. STA 팩(카드 50장, 출처 120개, 역할별 평가)과 같은 깊이가 아니다.
- 카드 내용은 작성자의 종합이며, 해당 분야 전문가 검토를 받지 않았다. 조회된 출처도 카드 해석과의 대조는 하지 않았다.
- 법률·회계·세무·규제 관련 카드는 관할·기준일을 요구하고 판단을 보류하도록 썼지만, 법률 자문 수준의 검증은 없다.
- 공급자 문서(Daytona, Nosana, Stripe, AWS)는 공급자 관점이며 가격·한도는 바뀔 수 있다. 카드는 구체 수치를 담지 않고 날짜가 붙은 입력을 요구한다.
- ODNI ICD 203은 403으로 조회 실패. 91·93·100 역할은 대신 조회된 Aqua Book 출처를 함께 갖는다.
- Held-out 케이스 60개는 작성자가 만든 것으로, 채점 기준의 신뢰도(채점자 간 일치)는 측정하지 않았다.
