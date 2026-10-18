# Cloudbite: 100인 전문가 풀 설계 및 단계별 구축안

- 작성일: 2026-10-18
- 상태: 100종 실행 연결 및 초기 지식 확장 / 모든 역할 답변 품질 평가 전
- 대상 제품: Cloudbite (`shinick-dev/cloudbite_v0.0.1`)
- 요청: 100인 전문가 구성안을 문서화하고 Work Stack에 실행 과제로 등록.
- 범위: 전문가 카탈로그, 지식 패키지, 질문별 팀 구성, 검증, 단계별 확장.
- 이 문서는 구성안과 구현 현황이다. 100종 선택 가능이 전문성 검증이나 100명 동시 실행을 의미하지 않는다.

## 1. 목표와 현재 출발점

사용자가 공통 프로젝트나 질문을 제시하면 서로 다른 전문 영역의 AI 역할이 독립된 Daytona 샌드박스에서 근거와 산출물을 작성한다. Nosana 추론을 활용하고, 최종 결과에서는 합의뿐 아니라 반론·전제·불확실성을 보존한다.

계획 수립 시점의 카탈로그는 일반 전문가 12종과 지식 자료가 연결된 PrimeTime STA 전문가 1종이었다. 먼저 25종을 공개했고, 이번 확장에서 기존 25종의 ID와 순서를 유지한 채 75종을 추가하여 100종 모두 실행 목록에 연결한다. 일반 역할 95종에 초기 지식 카드 570장이 있으며, STA는 별도 50장·120출처 지식 묶음을 유지하고 나머지 기존 4종은 메타데이터 기반이다. 초기 자료와 STA의 지식 깊이는 동일하지 않고 모든 역할은 답변 품질 평가 전이다. 세부 범위는 [75종 확장 문서](pool-expansion.md)에 기록한다.

현행 선택 한도는 프로젝트당 최대 5명이다. 100명은 선택 가능한 풀의 목표이며, 이 과제로 기존 동시 실행·방문자 할당량을 올리지 않는다.

## 2. 구성 원칙

1. 공통 자문 70명, 반도체·EDA 10명, 산업별 적용 10명, 검증·판단 10명으로 구성한다.
2. 역할별로 담당 질문, 분석 방법, 필요한 입력, 산출물, 답변 불가 조건을 구분한다.
3. 직함이 유사해도 조사 대상과 판단 권한을 구분한다. 고객 발견은 수요·문제 검증, UX 연구는 사용 행동·사용성을 담당한다.
4. 일반 법률·규제 역할에는 관할 국가, 적용 제도, 자료 기준일을 요구한다.
5. 지식 자료의 양만으로 준비 완료를 판단하지 않는다. 출처 품질, 권리, 검색 적합성, 실제 답변 평가를 함께 확인한다.
6. 동일 모델을 쓰는 역할 간 오류는 상관될 수 있다. 찬성 비율과 평균 자체 평가 확신도를 정답 확률로 환산하지 않는다.
7. 부족한 입력이나 검증 불가한 근거가 있으면 추가 질문·조건부 결론·기권을 허용한다.

## 3. 전문가 100인 카탈로그

번호는 이 문서의 계획용 번호이며 런타임 expert ID가 아니다. 기존 역할과의 매핑은 구현 시 확인한다.

### 1. 고객·제품·사업 전략 (1–10)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 1 | Product Manager | 문제 정의, MVP 범위, 출시 조건. |
| 2 | Customer Discovery Researcher | 고객 인터뷰와 수요 검증 설계. |
| 3 | Market Research Analyst | 시장 규모, 세분 시장, 진입 기회. |
| 4 | Business Strategist | 사업 방향과 전략적 선택지 비교. |
| 5 | Competitive Intelligence Analyst | 경쟁 제품, 대체재, 고객의 전환 이유 분석. |
| 6 | Business Model Architect | 사용자·구매자·수익 구조 설계. |
| 7 | Product Portfolio Strategist | 여러 아이템 사이의 투자 우선순위. |
| 8 | Product Analytics Specialist | 활성화·유지·핵심 가치 지표 설계. |
| 9 | Platform & Ecosystem Strategist | 플랫폼, 파트너, 네트워크 효과. |
| 10 | International Expansion Specialist | 국가별 진출 순서와 현지화 조건. |

### 2. UX·디자인·사용자 행동 (11–20)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 11 | UX Researcher | 사용자의 실제 행동과 사용성 문제 분석. |
| 12 | Service Designer | 신청부터 이용·지원까지 전체 경험 설계. |
| 13 | Information Architect | 메뉴, 정보 구조, 탐색 체계. |
| 14 | Interaction Designer | 화면 흐름, 조작 방식, 상태 변화. |
| 15 | Visual Interface Designer | 시각적 위계와 디자인 시스템. |
| 16 | Content Designer | 안내 문구, 오류 메시지, 용어 체계. |
| 17 | Accessibility Specialist | 키보드·스크린리더 등 접근성 검토. |
| 18 | Behavioral Scientist | 행동 장벽, 인지 편향, 동기 분석. |
| 19 | Onboarding Specialist | 가입부터 첫 가치 경험까지 개선. |
| 20 | Human–AI Interaction Researcher | AI에 대한 신뢰, 통제권, 불확실성 표현. |

### 3. 소프트웨어 설계·구현 (21–30)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 21 | Software Architect | 시스템 경계, 의존성, 구조적 선택. |
| 22 | Frontend Engineer | 브라우저 구현, 상태 관리, 렌더링. |
| 23 | Backend Engineer | 업무 로직, API, 비동기 작업 처리. |
| 24 | Mobile Engineer | 모바일 앱 구조와 기기 제약. |
| 25 | API & Integration Architect | 외부 서비스 연결과 API 계약. |
| 26 | Database Engineer | 데이터 모델, 쿼리, 트랜잭션. |
| 27 | Distributed Systems Engineer | 동시성, 재시도, 일관성, 중복 실행. |
| 28 | Real-time Collaboration Engineer | 실시간 상태 동기화와 공동 작업. |
| 29 | Software Quality Engineer | 테스트 전략, 회귀 방지, 출시 검증. |
| 30 | Legacy Modernization Engineer | 기존 코드 재사용과 단계적 전환. |

### 4. AI·데이터·실험 (31–40)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 31 | AI Systems Engineer | 모델·도구·애플리케이션 연결 구조. |
| 32 | LLM Application Engineer | 구조화 출력, 도구 호출, 문맥 관리. |
| 33 | RAG & Knowledge Engineer | 문서 수집, 검색, 인용, 지식 갱신. |
| 34 | Multi-agent Systems Engineer | 역할 분담, 협업, 충돌 해결. |
| 35 | Model Evaluation Engineer | 평가 데이터와 품질 통과 기준. |
| 36 | Inference Optimization Engineer | 추론 지연, 처리량, 모델 비용. |
| 37 | Data Engineer | 데이터 수집·변환·품질 관리. |
| 38 | Statistician | 표본, 추정, 불확실성, 통계적 해석. |
| 39 | Experimentation & Causal Inference Specialist | 실험 설계와 인과관계 검증. |
| 40 | Recommendation & Ranking Engineer | 질문에 적합한 전문가 검색·추천. |

### 5. 클라우드·실행 환경·운영 (41–50)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 41 | Cloud Architect | 클라우드 구성과 서비스 선택. |
| 42 | Sandbox & Container Engineer | 격리 실행 환경과 생명주기 관리. |
| 43 | GPU Computing Engineer | GPU 자원, 추론 워크로드, 처리량. |
| 44 | Site Reliability Engineer | 가용성 목표, 장애 대응, 복구. |
| 45 | Platform Engineer | 개발자가 사용하는 내부 실행 플랫폼. |
| 46 | Infrastructure Automation Engineer | 인프라 선언, 환경 재현, 설정 관리. |
| 47 | Observability Engineer | 로그·지표·추적과 원인 분석. |
| 48 | Performance Engineer | 병목 분석과 응답 시간 개선. |
| 49 | FinOps Specialist | 클라우드·샌드박스·모델 비용 통제. |
| 50 | Release & Disaster Recovery Engineer | 배포, 롤백, 백업, 재해 복구. |

### 6. 보안·개인정보·법적 검토 (51–60)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 51 | Security Architect | 위협 모델, 신뢰 경계, 보안 설계. |
| 52 | Application Security Engineer | 웹·API 취약점과 방어 구현. |
| 53 | Identity & Access Architect | 인증, 권한, 세션, 운영자 접근. |
| 54 | Sandbox Security Engineer | 테넌트 격리, 탈출 위험, 네트워크 제한. |
| 55 | AI Security Engineer | 프롬프트 주입, 도구 오용, 데이터 유출. |
| 56 | Red Team Specialist | 공격 시나리오와 악용 가능성 검증. |
| 57 | Privacy Engineer | 최소 수집, 보관 기간, 삭제, 데이터 흐름. |
| 58 | Commercial Contracts Analyst | 이용약관, 계약상 책임, 공급자 조건. |
| 59 | IP & Open-source Licensing Analyst | 저작권, 라이선스, 지식 자료 사용권. |
| 60 | Compliance & AI Governance Analyst | 적용 규정, 관리 절차, 감사 증거. |

### 7. 매출·재무·사업 운영 (61–70)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 61 | Pricing Analyst | 가격 기준, 요금제, 지불 의향 검증. |
| 62 | FP&A Analyst | 예산, 현금 흐름, 손익과 민감도 분석. |
| 63 | Venture Investment Analyst | 투자 논리, 성장 가능성, 실사 질문. |
| 64 | B2B Sales Strategist | 구매 담당자, 영업 과정, 계약 장벽. |
| 65 | Growth Marketer | 고객 획득 채널과 성장 실험. |
| 66 | Customer Success Strategist | 고객 정착, 재구매, 이탈 방지. |
| 67 | Business Operations Designer | 반복 업무와 운영 절차 설계. |
| 68 | Organization & Workforce Designer | 팀 구성, 역할, 채용 우선순위. |
| 69 | Procurement & Vendor Risk Analyst | 공급자 선정, 의존성, 대체 가능성. |
| 70 | Partnership & Distribution Strategist | 제휴와 유통 경로 설계. |

### 8. 반도체·EDA (71–80)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 71 | Semiconductor System Architect | PPA 목표와 시스템 구조. |
| 72 | RTL Design Engineer | 합성 가능한 RTL과 마이크로아키텍처. |
| 73 | Functional Verification Engineer | 검증 계획, 커버리지, 시뮬레이션. |
| 74 | Formal Verification Engineer | 속성 검증, 등가성, 증명 범위. |
| 75 | Logic Synthesis Engineer | 합성 제약, 로직 최적화, 결과 분석. |
| 76 | Physical Design Engineer | 배치·배선, 혼잡, 물리적 타이밍 수렴. |
| 77 | PrimeTime STA Specialist | SDC, setup/hold, 예외 경로, 타이밍 분석. |
| 78 | DFT & Test Engineer | scan, ATPG, 테스트 가능성과 커버리지. |
| 79 | Power & Signal Integrity Engineer | 전력, IR drop, EM, 신호 무결성. |
| 80 | Advanced Packaging Engineer | 칩렛, 패키지, 연결·열 제약. |

### 9. 산업별 적용 (81–90)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 81 | Manufacturing Systems Specialist | 생산 공정, 수율, 품질 관리. |
| 82 | Robotics Engineer | 인지·계획·제어와 실제 환경 제약. |
| 83 | Embedded & IoT Engineer | 펌웨어, 센서, 통신, 기기 운영. |
| 84 | Mobility Systems Specialist | 차량·이동 서비스와 운영 안전. |
| 85 | Healthcare Informatics Specialist | 의료 정보 흐름과 임상 업무 적용. |
| 86 | Learning Science Specialist | 학습 효과, 교육 설계, 평가. |
| 87 | Financial Services Systems Specialist | 결제·정산·금융 서비스 구조. |
| 88 | Supply Chain & Logistics Specialist | 재고, 수요, 배송, 공급망. |
| 89 | Energy Systems Specialist | 전력 수요, 효율, 에너지 운영. |
| 90 | Public-sector Service Specialist | 공공 서비스, 조달, 행정 적용. |

### 10. 근거 검증·반론·종합 판단 (91–100)

| 번호 | 역할 | 담당 범위 |
|---|---|---|
| 91 | Evidence Auditor | 인용한 자료가 실제 주장을 뒷받침하는지 확인. |
| 92 | Quantitative Model Reviewer | 계산, 단위, 수치 가정 재검산. |
| 93 | Assumption Auditor | 숨은 가정과 검증되지 않은 전제 추출. |
| 94 | Adversarial Reviewer | 제안이 실패할 가장 강한 반론 작성. |
| 95 | Pre-mortem Analyst | 실패한 미래를 가정하고 원인을 역추적. |
| 96 | Decision Analyst | 선택지, 효용, 위험, 추가 정보의 가치 비교. |
| 97 | Systems Thinking Specialist | 연쇄 효과, 피드백, 이해관계 충돌 분석. |
| 98 | Implementation Feasibility Reviewer | 인력·기간·의존성을 고려한 실행 가능성. |
| 99 | Outcome Evaluation Specialist | 실행 후 성과 측정과 개선 기준. |
| 100 | Synthesis Editor | 합의·불일치·조건을 보존하면서 최종 판단 정리. |

## 4. 페르소나 지식 패키지의 최소 계약

각 역할은 아래 항목을 갖춰야 한다. 초기 초안, 지식 연결, 평가 통과 등의 준비 상태를 구분하고 실제 통과 전에는 검증된 전문가로 표시하지 않는다.

| 항목 | 필수 내용 |
|---|---|
| 역할 정의 | 담당 질문, 인접 역할과의 경계, 필요한 입력, 답변 불가 범위 |
| 지식 명세 | 자료 목록, 문서·도구 버전, 기준일, 관련 관할, 소유권·라이선스·재배포 조건 |
| 지식 카드 | 직접 작성한 요약·체크리스트·실패 패턴과 추적 가능한 원출처 |
| 검색 설계 | 질문에 맞는 자료 검색, 출처 ID, 검색 결과와 사용자 입력의 신뢰 경계 |
| 분석 방법 | 재현 가능한 검토 순서, 계산·실험 방법, 가정 처리 규칙 |
| 실행 도구 | 실제 사용 가능한 도구와 권한, 샌드박스 접근 범위, 비용·시간 제한 |
| 산출물 | 결론, 근거, 가정, 반론, 다음 행동, 역할별 문서·계산 결과 |
| 확신도 | 자체 평가임을 명시하고 판단 근거와 부족한 정보를 함께 제시 |
| 평가 | 정상·정보 부족·범위 외·반례·상충 근거 질문 및 채점 기준 |
| 변경 이력 | 지식·프롬프트 버전과 해시, 평가 결과, 갱신 이력 |

지식 원문을 소유하고 있다는 이유로 공개 저장소나 샌드박스에 복사하지 않는다. pro-bably STA 자료는 기존 가져오기 계약과 권리를 유지한다. STA 자료를 다른 반도체 역할의 지식으로 일괄 재사용하지 않는다.

출처 ID나 URL의 형식 검증과 원문이 주장을 뒷받침하는지에 대한 검증을 구분한다. 현재 실행 환경에서 원문 조회가 불가능하면 검증 미실시를 표시한다.

공통 산출물의 제안 필드:

- `recommendation`: 권고 및 적용 조건.
- `claims`: 주요 주장, 근거 위치, 확인된 사실/가정/미검증 구분.
- `assumptions`: 결론을 바꾸는 입력과 전제.
- `counterarguments`: 강한 반론과 남는 위험.
- `confidence`: 자체 평가와 그 이유. 보정된 정확도로 표시하지 않음.
- `next_actions`: 담당자, 필요한 증거, 완료 조건.
- `artifacts`: 실제 생성한 파일과 계산·실험 결과.
- `abstention_reason`: 판단을 유보하는 경우의 이유.

필드명은 설계 제안이다. 기존 opinion 스키마와의 호환성을 검토한 뒤 변경한다.

## 5. 질문별 팀 구성과 검토 흐름

### 팀 선택

질문의 목표, 산업, 의사결정 단계, 위험, 필요한 증거를 먼저 분류한다. 현행 최대 5명 범위 안에서 도메인 역할 3~4명과 검증 역할 1~2명을 추천하고 사용자가 확인·변경할 수 있도록 설계한다.

| 질문 | 추천 팀 (계획용 번호) |
|---|---|
| Cloudbite를 유료 출시해도 될까? | 1 Product Manager / 2 Customer Discovery / 61 Pricing / 51 Security Architect / 96 Decision Analyst |
| 전문가 답변을 더 신뢰할 수 있게 만들려면? | 33 Knowledge Engineer / 35 Model Evaluation / 38 Statistician / 91 Evidence Auditor / 94 Adversarial Reviewer |
| 실행 실패와 비용을 줄이려면? | 42 Sandbox Engineer / 43 GPU Engineer / 44 SRE / 49 FinOps / 98 Feasibility Reviewer |
| STA 타이밍 위반을 어떻게 해결할까? | 77 STA / 75 Synthesis / 76 Physical Design / 92 Quantitative Reviewer / 91 Evidence Auditor |

카탈로그 등록만 된 역할과 지식·평가가 준비된 역할을 구분한다. 자동 추천은 사용 가능한 역할 범위와 추천 이유를 보여준다.

### 독립 분석과 후속 검토

1. 도메인 역할은 초기에는 다른 역할의 답변을 보지 않고 독립 분석한다.
2. 실제 답변이 생성된 뒤 검증 역할이 해당 산출물과 근거를 읽고 주장별 확인·반론을 작성한다.
3. 종합은 동의한 조건, 충돌한 근거, 추가로 확인할 사실을 남긴다.

현재 역할별 병렬 실행만으로 2번의 교차 검토가 구현되었다고 주장하지 않는다. 후속 검토는 별도 실행 단계와 비용 한도가 필요한 구현 항목이다. 전문가 선택 5명 제한을 유지하고, 검토 호출도 실행 예산에 포함하는 방식을 먼저 설계한다.

Synthesis Editor를 별도 실행한다면 추가 실행임을 표시한다. 현재 종합 기능이 그 역할의 검증을 대체한다고 가정하지 않는다.

## 6. 우선 구축할 20명과 확장 순서

### 1단계: 공통 15명 + 검증 5명

공통 15명:

- 1 Product Manager
- 2 Customer Discovery Researcher
- 4 Business Strategist
- 11 UX Researcher
- 20 Human–AI Interaction Researcher
- 21 Software Architect
- 31 AI Systems Engineer
- 33 RAG & Knowledge Engineer
- 35 Model Evaluation Engineer
- 42 Sandbox & Container Engineer
- 49 FinOps Specialist
- 51 Security Architect
- 57 Privacy Engineer
- 61 Pricing Analyst
- 62 FP&A Analyst

검증 5명:

- 91 Evidence Auditor
- 92 Quantitative Model Reviewer
- 93 Assumption Auditor
- 94 Adversarial Reviewer
- 100 Synthesis Editor

기존 STA 전문가는 지식 패키지와 평가 구조의 참고 사례로 병행 유지한다. 따라서 첫 단계의 목표 카탈로그 수와 이번에 새로 작성할 역할 수는 같지 않을 수 있다. 기존 역할과의 매핑을 먼저 수행한다.

### 2단계: 지식 깊이와 팀 단위 품질 검증

- 기존 일반 역할의 자료를 보강하고 역할별 평가를 수행한다.
- 동일 모델·동일 질문에서 단일 역할, 여러 도메인 역할, 검토 포함 구성의 결과를 비교한다.
- 평가 지표와 통과 기준은 시험 전에 정한다. 근거 충실도, 주장별 인용 적합성, 계산 정확성, 범위 외 기권, 비용·지연을 포함한다.
- 반도체 역할은 독립 자료와 검증 문제를 확보한 순서대로 추가한다.

### 3단계: 사용 기록에 따른 100인 확장

- 질문 유형, 필요한데 제공하지 못한 전문 영역, 사용자 피드백, 실패·지연·비용을 함께 검토한다.
- 현재 사용 기록의 집계는 개선 후보를 찾는 신호로 사용한다. 이를 답변의 의미적 정확성이나 시장 수요 검증으로 간주하지 않는다.
- 역할 중복과 실제 수요를 확인하면서 나머지 역할을 도입한다.
- 의료·금융·공공 등 산업 역할은 해당 분야 자료와 평가 담당자를 확보한 뒤 공개한다.
- 자동 지식 갱신이나 운영 프롬프트 변경은 이 설계만으로 활성화하지 않는다.

## 7. 실행 과제와 완료 기준

100종 실행 연결과 초기 지식 확장은 완료했으며 전문성 검증은 진행 중인 백로그다. 기존의 평가 후 공개 계획과 달리 이번 요청에 따라 초기 역할을 모두 공개하되, 화면과 실행 자료에 평가 전 상태를 명시한다.

- [x] 기존 13종 역할과 계획 100종의 ID·명칭·범위 매핑 및 중복 정리.
- [x] 지식 패키지 계약, 준비 상태, 출처·권리·버전 메타데이터 정의.
- [x] 우선 20명에 대한 초기 자료와 역할별 분석·산출물 명세 작성.
- [x] 우선 20명에 역할별 지식 검색과 기존 실행 도구 연결.
- [x] 규칙 기반 최대 5명 팀 추천; 추천 이유·사용자 변경·준비 중 역할 선택 잠금 구현.
- [ ] 질문의 목표·산업·위험을 이해하는 자동 분류와 팀 구성 품질 평가.
- [ ] 독립 분석 → 근거 확인·반론 → 종합의 후속 검토 흐름 구현.
- [x] 일반 역할 평가 질문 285개(1단계60 + 확장225)와 채점 기준을 실행 지식과 분리해 작성.
- [ ] 모델·전문가 채점을 통한 역할별 평가 및 단일 역할 대비 비교 평가 수행.
- [ ] 동일 확신도, 상관된 오류, 누락 근거를 표현하는 보고 방식 검증.
- [ ] 지식·프롬프트 버전별 사용 기록과 피드백으로 개선 우선순위 점검.
- [x] 카탈로그 100종을 실제 실행 ID에 연결하고 모든 역할에 평가 전 상태 표시.
- [ ] 답변 품질 평가를 통과한 역할을 구분하는 공개 기준과 운영 품질 단계 적용.

완료 판정은 명단에 100개 항목이 존재하는 것으로 끝내지 않는다. 공개 역할마다 자료·권리·경계·도구·평가 결과가 추적 가능해야 하고, 실제 실행 상태와 검증 미실시 항목을 화면에서 구분해야 한다.

## 8. 관련 파일과 참고

- 현재 역할: `src/cloudbite-personas.ts`
- STA 지식 연결: `src/cloudbite-sta.ts`, `docs/cloudbite/sta-expert.md`
- 출처 계약: `docs/cloudbite/persona-provenance.md`
- 실행 구조: `docs/cloudbite/runtime.md`
- 사용 기록: `docs/cloudbite/history.txt`
- 제품 범위: `PRODUCT.md`
- 구성·평가 원칙 참고: [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)

100인 배치는 Cloudbite를 위한 자체 제안이며 NIST의 공식 역할 분류가 아니다.

