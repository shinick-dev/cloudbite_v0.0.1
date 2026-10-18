// The planning catalogue as an optional bootstrap field: the original 100 roles (docs/cloudbite/expert-pool-100.md)
// followed by research-document roles 101–120 (Falsify extension). The catalogue bound and the project team bound are
// separate (cloudbite-catalogue-limits.ts).
// A catalogue entry is not a runnable expert and not proof of expertise: only entries mapped to an actual
// CLOUDBITE_EXPERTS id are 'available', and a project still selects runnable expert ids (at most PROJECT_MAX_EXPERTS). Every entry is
// unvalidated. Planned numbers are not runtime ids; pool-NNN ids can never be submitted as expertIds.
import { findExpert } from './cloudbite-personas';
import { KNOWLEDGE_PACKS } from './cloudbite-knowledge-registry';
import { CATALOGUE_MAX_ROLES } from './cloudbite-catalogue-limits';

export interface ExpertPoolEntry {
  id: string; catalogNumber: number; name: string; domain: string; category: string; categoryLabel: { ko: string; en: string };
  mission: string; expertId?: string; availability: 'available' | 'planned'; knowledge: 'metadata-derived' | 'curated-knowledge' | 'none';
  evaluation: 'unvalidated'; priority: boolean; keywords: string[]; mappingNote?: string;
}
export interface ExpertPool { version: string; entries: ExpertPoolEntry[]; priorityNumbers: number[] }

export const POOL_VERSION = 'expert-pool-120/2026-10-19';
export const POOL_LIMITS = Object.freeze({ entries: CATALOGUE_MAX_ROLES, name: 80, mission: 240, keywords: 12, keyword: 40, note: 240 });

const CATEGORIES: Array<{ key: string; ko: string; en: string; domain: string }> = [
  { key: 'product-strategy', ko: '고객·제품·사업 전략', en: 'Customer, product and business strategy', domain: 'product' },
  { key: 'ux-design', ko: 'UX·디자인·사용자 행동', en: 'UX, design and user behaviour', domain: 'design' },
  { key: 'software', ko: '소프트웨어 설계·구현', en: 'Software design and implementation', domain: 'software' },
  { key: 'ai-data', ko: 'AI·데이터·실험', en: 'AI, data and experimentation', domain: 'data-ai' },
  { key: 'cloud-ops', ko: '클라우드·실행 환경·운영', en: 'Cloud, runtime and operations', domain: 'cloud' },
  { key: 'security-legal', ko: '보안·개인정보·법적 검토', en: 'Security, privacy and legal review', domain: 'security' },
  { key: 'revenue-ops', ko: '매출·재무·사업 운영', en: 'Revenue, finance and business operations', domain: 'business' },
  { key: 'semiconductor', ko: '반도체·EDA', en: 'Semiconductors and EDA', domain: 'semiconductor-eda' },
  { key: 'industry', ko: '산업별 적용', en: 'Industry applications', domain: 'industry' },
  { key: 'review', ko: '근거 검증·반론·종합 판단', en: 'Evidence review, challenge and synthesis', domain: 'review' },
  // Numbers above 100 name their category explicitly instead of following groups of ten.
  { key: 'clinical-medicine', ko: '임상의학 근거', en: 'Clinical medicine evidence', domain: 'clinical-medicine' },
  { key: 'biomedical-research', ko: '생의학 연구', en: 'Biomedical research', domain: 'biomedical-research' },
  { key: 'pharmaceutical-science', ko: '약학·약리 과학', en: 'Pharmaceutical science', domain: 'pharmaceutical-science' },
  { key: 'chemistry', ko: '화학', en: 'Chemistry', domain: 'chemistry' },
];

// [plan number, plan name, scope, keywords]. Names and scopes follow the plan document.
const PLAN: Array<[number, string, string, string[]]> = [
  [1, 'Product Manager', 'Problem definition, MVP scope and launch conditions.', ['product', 'mvp', 'roadmap', 'launch', '제품', '출시']],
  [2, 'Customer Discovery Researcher', 'Customer interviews and demand validation design.', ['customer', 'interview', 'demand', 'discovery', '고객', '인터뷰', '수요']],
  [3, 'Market Research Analyst', 'Market size, segments and entry opportunities.', ['market', 'segment', 'tam', '시장', '세분']],
  [4, 'Business Strategist', 'Business direction and comparison of strategic options.', ['strategy', 'competitive', 'option', '전략', '사업']],
  [5, 'Competitive Intelligence Analyst', 'Competing products, substitutes and why customers switch.', ['competitor', 'substitute', 'switching', '경쟁', '대체재']],
  [6, 'Business Model Architect', 'User, buyer and revenue structure design.', ['business model', 'revenue', 'buyer', '수익', '비즈니스 모델']],
  [7, 'Product Portfolio Strategist', 'Investment priority across several product bets.', ['portfolio', 'prioritization', '포트폴리오', '우선순위']],
  [8, 'Product Analytics Specialist', 'Activation, retention and core value metrics.', ['analytics', 'activation', 'retention', 'metric', '지표', '유지']],
  [9, 'Platform & Ecosystem Strategist', 'Platforms, partners and network effects.', ['platform', 'ecosystem', 'network effect', '플랫폼', '생태계']],
  [10, 'International Expansion Specialist', 'Country entry order and localisation conditions.', ['international', 'localization', 'expansion', '해외', '현지화']],
  [11, 'UX Researcher', 'Observed user behaviour and usability problems.', ['ux research', 'usability', 'user behavior', '사용성', '사용자 조사']],
  [12, 'Service Designer', 'End-to-end experience from sign-up to use and support.', ['service design', 'journey', 'blueprint', '서비스 디자인', '여정']],
  [13, 'Information Architect', 'Menus, information structure and navigation.', ['information architecture', 'navigation', 'menu', '정보 구조', '탐색']],
  [14, 'Interaction Designer', 'Screen flows, controls and state changes.', ['interaction', 'flow', 'ui', 'ux', '화면 흐름', '인터랙션']],
  [15, 'Visual Interface Designer', 'Visual hierarchy and design systems.', ['visual design', 'design system', 'typography', '디자인 시스템', '시각']],
  [16, 'Content Designer', 'Guidance copy, error messages and terminology.', ['copy', 'content design', 'error message', '문구', '용어']],
  [17, 'Accessibility Specialist', 'Keyboard, screen reader and other accessibility review.', ['accessibility', 'a11y', 'wcag', 'screen reader', '접근성']],
  [18, 'Behavioral Scientist', 'Behavioural barriers, cognitive biases and motivation.', ['behavioral', 'bias', 'nudge', 'motivation', '행동', '편향']],
  [19, 'Onboarding Specialist', 'Sign-up through first value experience.', ['onboarding', 'activation', 'first value', '온보딩', '가입']],
  [20, 'Human-AI Interaction Researcher', 'Trust in AI, user control and uncertainty display.', ['human-ai', 'trust', 'explainability', 'uncertainty', 'ai 신뢰', '불확실성']],
  [21, 'Software Architect', 'System boundaries, dependencies and structural choices.', ['architecture', 'system design', 'dependency', '아키텍처', '설계']],
  [22, 'Frontend Engineer', 'Browser implementation, state management and rendering.', ['frontend', 'browser', 'react', 'rendering', '프론트엔드']],
  [23, 'Backend Engineer', 'Business logic, APIs and asynchronous jobs.', ['backend', 'api', 'queue', 'server', '백엔드']],
  [24, 'Mobile Engineer', 'Mobile app structure and device constraints.', ['mobile', 'ios', 'android', '모바일', '앱']],
  [25, 'API & Integration Architect', 'External service connections and API contracts.', ['integration', 'api contract', 'webhook', '연동', '외부 서비스']],
  [26, 'Database Engineer', 'Data models, queries and transactions.', ['database', 'sql', 'schema', 'transaction', '데이터베이스']],
  [27, 'Distributed Systems Engineer', 'Concurrency, retries, consistency and duplicate execution.', ['distributed', 'concurrency', 'idempotency', 'consistency', '동시성', '분산']],
  [28, 'Real-time Collaboration Engineer', 'Real-time state synchronisation and co-editing.', ['real-time', 'websocket', 'crdt', 'collaboration', '실시간', '동기화']],
  [29, 'Software Quality Engineer', 'Test strategy, regression prevention and release verification.', ['testing', 'qa', 'regression', 'quality', '테스트', '품질']],
  [30, 'Legacy Modernization Engineer', 'Reuse of existing code and staged migration.', ['legacy', 'migration', 'refactor', 'modernization', '레거시', '전환']],
  [31, 'AI Systems Engineer', 'How models, tools and applications connect.', ['ai system', 'llm', 'model integration', 'tool calling', 'ai 엔지니어']],
  [32, 'LLM Application Engineer', 'Structured output, tool calls and context management.', ['llm app', 'prompt', 'structured output', 'context window', '프롬프트']],
  [33, 'RAG & Knowledge Engineer', 'Document collection, retrieval, citation and knowledge updates.', ['rag', 'retrieval', 'knowledge base', 'citation', '검색', '지식']],
  [34, 'Multi-agent Systems Engineer', 'Role division, collaboration and conflict resolution between agents.', ['multi-agent', 'agents', 'orchestration', '멀티 에이전트']],
  [35, 'Model Evaluation Engineer', 'Evaluation data and quality pass criteria.', ['evaluation', 'eval', 'benchmark', 'quality gate', '평가']],
  [36, 'Inference Optimization Engineer', 'Inference latency, throughput and model cost.', ['inference', 'latency', 'throughput', 'quantization', '추론']],
  [37, 'Data Engineer', 'Data collection, transformation and quality.', ['data pipeline', 'etl', 'data quality', '데이터 파이프라인']],
  [38, 'Statistician', 'Sampling, estimation, uncertainty and statistical interpretation.', ['statistics', 'sample size', 'confidence interval', '통계', '표본']],
  [39, 'Experimentation & Causal Inference Specialist', 'Experiment design and causal validation.', ['a/b test', 'experiment', 'causal', '실험', '인과']],
  [40, 'Recommendation & Ranking Engineer', 'Searching for and recommending suitable experts for a question.', ['recommendation', 'ranking', 'search', '추천', '랭킹']],
  [41, 'Cloud Architect', 'Cloud configuration and service selection.', ['cloud', 'aws', 'cloudflare', 'gcp', '클라우드']],
  [42, 'Sandbox & Container Engineer', 'Isolated execution environments and their lifecycle.', ['sandbox', 'container', 'isolation', 'daytona', '샌드박스', '컨테이너']],
  [43, 'GPU Computing Engineer', 'GPU resources, inference workloads and throughput.', ['gpu', 'cuda', 'nosana', 'workload', 'gpu 자원']],
  [44, 'Site Reliability Engineer', 'Availability targets, incident response and recovery.', ['sre', 'slo', 'incident', 'availability', '장애', '가용성']],
  [45, 'Platform Engineer', 'Internal execution platforms used by developers.', ['platform engineering', 'developer platform', 'internal tools', '플랫폼 엔지니어링']],
  [46, 'Infrastructure Automation Engineer', 'Declared infrastructure, reproducible environments and configuration.', ['terraform', 'infrastructure as code', 'configuration', '인프라 자동화']],
  [47, 'Observability Engineer', 'Logs, metrics, traces and root-cause analysis.', ['observability', 'logging', 'tracing', 'metrics', '관측', '로그']],
  [48, 'Performance Engineer', 'Bottleneck analysis and response-time improvement.', ['performance', 'bottleneck', 'profiling', '성능', '병목']],
  [49, 'FinOps Specialist', 'Cloud, sandbox and model cost control.', ['finops', 'cloud cost', 'cost', 'budget', '비용']],
  [50, 'Release & Disaster Recovery Engineer', 'Deployment, rollback, backup and disaster recovery.', ['release', 'rollback', 'backup', 'disaster recovery', '배포', '복구']],
  [51, 'Security Architect', 'Threat models, trust boundaries and security design.', ['security', 'threat model', 'trust boundary', '보안', '위협']],
  [52, 'Application Security Engineer', 'Web and API vulnerabilities and defensive implementation.', ['appsec', 'owasp', 'vulnerability', 'xss', '취약점']],
  [53, 'Identity & Access Architect', 'Authentication, authorisation, sessions and operator access.', ['authentication', 'authorization', 'session', 'iam', '인증', '권한']],
  [54, 'Sandbox Security Engineer', 'Tenant isolation, escape risk and network restriction.', ['sandbox security', 'tenant isolation', 'escape', '격리', '테넌트']],
  [55, 'AI Security Engineer', 'Prompt injection, tool misuse and data leakage.', ['prompt injection', 'ai security', 'jailbreak', 'data leakage', '프롬프트 주입']],
  [56, 'Red Team Specialist', 'Attack scenarios and abuse-potential testing.', ['red team', 'attack', 'abuse', 'penetration', '레드팀', '공격']],
  [57, 'Privacy Engineer', 'Minimal collection, retention, deletion and data flows.', ['privacy', 'gdpr', 'personal data', 'retention', '개인정보']],
  [58, 'Commercial Contracts Analyst', 'Terms of service, contractual liability and supplier terms.', ['contract', 'terms of service', 'liability', '계약', '약관']],
  [59, 'IP & Open-source Licensing Analyst', 'Copyright, licences and rights to knowledge material.', ['license', 'open source', 'copyright', 'ip', '라이선스', '저작권']],
  [60, 'Compliance & AI Governance Analyst', 'Applicable regulation, control procedures and audit evidence.', ['compliance', 'ai governance', 'regulation', 'audit', '규제', '컴플라이언스']],
  [61, 'Pricing Analyst', 'Price basis, plans and willingness-to-pay validation.', ['pricing', 'price', 'willingness to pay', 'plan', '가격', '요금제']],
  [62, 'FP&A Analyst', 'Budget, cash flow, profit and loss and sensitivity analysis.', ['fp&a', 'budget', 'cash flow', 'forecast', '예산', '현금 흐름']],
  [63, 'Venture Investment Analyst', 'Investment thesis, growth potential and diligence questions.', ['investment', 'venture', 'due diligence', '투자', '실사']],
  [64, 'B2B Sales Strategist', 'Buyers, sales process and contract barriers.', ['b2b', 'sales', 'procurement', 'enterprise', '영업']],
  [65, 'Growth Marketer', 'Customer acquisition channels and growth experiments.', ['growth', 'acquisition', 'marketing', 'funnel', '성장', '마케팅']],
  [66, 'Customer Success Strategist', 'Customer adoption, renewal and churn prevention.', ['customer success', 'churn', 'renewal', '이탈', '고객 성공']],
  [67, 'Business Operations Designer', 'Recurring work and operating procedures.', ['operations', 'process', 'sop', 'workflow', '운영', '절차']],
  [68, 'Organization & Workforce Designer', 'Team composition, roles and hiring priority.', ['organization', 'hiring', 'team design', '조직', '채용']],
  [69, 'Procurement & Vendor Risk Analyst', 'Supplier selection, dependency and replaceability.', ['vendor', 'supplier', 'vendor risk', 'lock-in', '공급자']],
  [70, 'Partnership & Distribution Strategist', 'Partnerships and distribution channel design.', ['partnership', 'distribution', 'channel', '제휴', '유통']],
  [71, 'Semiconductor System Architect', 'PPA targets and system architecture.', ['soc', 'ppa', 'semiconductor', 'chip architecture', '반도체']],
  [72, 'RTL Design Engineer', 'Synthesisable RTL and microarchitecture.', ['rtl', 'verilog', 'systemverilog', 'microarchitecture']],
  [73, 'Functional Verification Engineer', 'Verification plans, coverage and simulation.', ['uvm', 'functional verification', 'coverage', 'simulation', '검증']],
  [74, 'Formal Verification Engineer', 'Property checking, equivalence and proof scope.', ['formal verification', 'equivalence', 'assertion', 'property']],
  [75, 'Logic Synthesis Engineer', 'Synthesis constraints, logic optimisation and result analysis.', ['synthesis', 'design compiler', 'logic optimization', '합성']],
  [76, 'Physical Design Engineer', 'Placement and routing, congestion and physical timing closure.', ['physical design', 'place and route', 'congestion', 'timing closure', '배치', '배선']],
  [77, 'PrimeTime STA Specialist', 'SDC, setup/hold, timing exceptions and timing analysis.', ['sta', 'primetime', 'setup', 'hold', 'sdc', '타이밍']],
  [78, 'DFT & Test Engineer', 'Scan, ATPG, testability and coverage.', ['dft', 'scan', 'atpg', 'test coverage']],
  [79, 'Power & Signal Integrity Engineer', 'Power, IR drop, EM and signal integrity.', ['ir drop', 'electromigration', 'signal integrity', 'power', '전력']],
  [80, 'Advanced Packaging Engineer', 'Chiplets, packages, interconnect and thermal constraints.', ['chiplet', 'packaging', 'interposer', 'thermal', '패키지']],
  [81, 'Manufacturing Systems Specialist', 'Production processes, yield and quality control.', ['manufacturing', 'yield', 'mes', 'quality control', '제조', '수율']],
  [82, 'Robotics Engineer', 'Perception, planning, control and real-world constraints.', ['robotics', 'robot', 'perception', 'control', '로봇']],
  [83, 'Embedded & IoT Engineer', 'Firmware, sensors, communication and device operation.', ['embedded', 'iot', 'firmware', 'sensor', '임베디드']],
  [84, 'Mobility Systems Specialist', 'Vehicle and mobility services and operational safety.', ['mobility', 'vehicle', 'automotive', 'fleet', '모빌리티', '차량']],
  [85, 'Healthcare Informatics Specialist', 'Medical information flows and clinical workflow fit.', ['healthcare', 'clinical', 'ehr', 'medical', '의료']],
  [86, 'Learning Science Specialist', 'Learning outcomes, instructional design and assessment.', ['education', 'learning', 'assessment', 'edtech', '교육', '학습']],
  [87, 'Financial Services Systems Specialist', 'Payment, settlement and financial service structure.', ['payment', 'settlement', 'fintech', 'banking', '결제', '금융']],
  [88, 'Supply Chain & Logistics Specialist', 'Inventory, demand, delivery and supply chains.', ['supply chain', 'logistics', 'inventory', 'delivery', '물류', '재고']],
  [89, 'Energy Systems Specialist', 'Power demand, efficiency and energy operations.', ['energy', 'grid', 'power demand', 'efficiency', '에너지']],
  [90, 'Public-sector Service Specialist', 'Public services, procurement and administrative fit.', ['public sector', 'government', 'public procurement', '공공', '행정']],
  [91, 'Evidence Auditor', 'Whether cited material actually supports the claims made.', ['evidence', 'citation check', 'source audit', '근거', '인용']],
  [92, 'Quantitative Model Reviewer', 'Rechecking calculations, units and numeric assumptions.', ['calculation', 'units', 'model review', 'numbers', '계산', '수치']],
  [93, 'Assumption Auditor', 'Hidden assumptions and unverified premises.', ['assumption', 'premise', 'hidden assumption', '가정', '전제']],
  [94, 'Adversarial Reviewer', 'The strongest argument for why a proposal will fail.', ['counterargument', 'devil\'s advocate', 'risk', '반론', '비판']],
  [95, 'Pre-mortem Analyst', 'Assume failure and trace back its causes.', ['pre-mortem', 'failure analysis', 'risk', '실패', '사전 부검']],
  [96, 'Decision Analyst', 'Comparing options, utility, risk and value of more information.', ['decision', 'trade-off', 'expected value', '의사결정', '선택지']],
  [97, 'Systems Thinking Specialist', 'Knock-on effects, feedback loops and stakeholder conflicts.', ['systems thinking', 'feedback loop', 'second-order', '시스템 사고', '연쇄 효과']],
  [98, 'Implementation Feasibility Reviewer', 'Feasibility given people, time and dependencies.', ['feasibility', 'implementation', 'timeline', 'resourcing', '실행 가능성']],
  [99, 'Outcome Evaluation Specialist', 'Post-launch outcome measurement and improvement criteria.', ['outcome', 'impact', 'feedback', 'evaluation', '성과', '피드백']],
  [100, 'Synthesis Editor', 'Final judgement that keeps agreement, disagreement and conditions.', ['synthesis', 'summary', 'consensus', 'disagreement', '종합']],
];

// [plan number, plan name, scope, keywords, category]. Research-document review only: no diagnosis, treatment, dosing
// or laboratory instructions. Appended after the released 100, whose numbers, names and categories stay unchanged.
const RESEARCH_PLAN: Array<[number, string, string, string[], string]> = [
  [101, 'Biomedical Research Methodologist', 'Study design, bias and whether reported methods support the stated claims of a paper.', ['research methodology', 'study design', 'bias', 'biomedical', '연구 방법론', '연구 설계'], 'biomedical-research'],
  [102, 'Clinical Evidence Reviewer', 'Whether clinical claims in a document follow from the reported evidence; no patient advice.', ['clinical evidence', 'clinical claim', 'evidence grading', 'unsupported conclusion', '임상 근거', '임상 주장'], 'clinical-medicine'],
  [103, 'Clinical Trial Methodologist', 'Trial registration, randomisation, endpoints and reporting completeness of trial papers.', ['clinical trial', 'randomization', 'endpoint', 'consort', '임상시험', '무작위'], 'clinical-medicine'],
  [104, 'Epidemiologist', 'Observational designs, confounding and how population figures are reported and interpreted.', ['epidemiology', 'cohort', 'confounding', 'incidence', '역학', '교란'], 'clinical-medicine'],
  [105, 'Biomedical Biostatistician', 'Rechecking reported statistics, tables and numeric consistency between text and tables.', ['biostatistics', 'p-value', 'confidence interval', 'table mismatch', '생물통계', '통계 오류'], 'biomedical-research'],
  [106, 'Systematic Review & Meta-analysis Specialist', 'Search, inclusion, pooling and heterogeneity reporting in evidence syntheses.', ['systematic review', 'meta-analysis', 'prisma', 'heterogeneity', '체계적 문헌고찰', '메타분석'], 'clinical-medicine'],
  [107, 'Pharmacology & Pharmacokinetics Scientist', 'Whether pharmacology and PK statements in a paper are consistent with its reported data; no dosing advice.', ['pharmacology', 'pharmacokinetics', 'half-life', 'exposure', '약리학', '약동학'], 'pharmaceutical-science'],
  [108, 'Medicinal Chemist', 'Structure-activity claims and compound descriptions as reported; no synthesis routes.', ['medicinal chemistry', 'structure-activity', 'sar', 'lead compound', '의약화학', '구조활성'], 'chemistry'],
  [109, 'Analytical Chemist', 'Reported analytical methods, calibration, units and measurement consistency.', ['analytical chemistry', 'calibration', 'hplc', 'mass spectrometry', '분석화학', '검량'], 'chemistry'],
  [110, 'Chemical Identity & Structure Reviewer', 'Consistency of compound names, identifiers, formulas and structures across a document.', ['chemical identity', 'cas number', 'molecular formula', 'smiles', '화학 구조', '화합물 식별'], 'chemistry'],
  [111, 'Molecular & Cell Biologist', 'Whether molecular and cell-biology conclusions follow from the reported experiments.', ['molecular biology', 'cell biology', 'western blot', 'gene expression', '분자생물학', '세포생물학'], 'biomedical-research'],
  [112, 'Biochemist', 'Reported assays, kinetics and biochemical interpretation as written in a paper.', ['biochemistry', 'enzyme kinetics', 'assay', 'protein', '생화학', '효소'], 'biomedical-research'],
  [113, 'Genomics & Bioinformatics Reviewer', 'Data availability, pipelines and reproducibility of genomic analyses as reported.', ['genomics', 'bioinformatics', 'sequencing', 'gwas', '유전체', '생물정보'], 'biomedical-research'],
  [114, 'Preclinical & Translational Scientist', 'Whether animal or in-vitro findings are over-extrapolated to human conclusions.', ['preclinical', 'translational', 'animal model', 'in vitro', '전임상', '중개연구'], 'biomedical-research'],
  [115, 'Toxicology Evidence Reviewer', 'How reported toxicity and safety findings are stated and supported; no exposure guidance.', ['toxicology', 'safety signal', 'adverse effect', 'noael', '독성학', '안전성'], 'pharmaceutical-science'],
  [116, 'Scientific Image Integrity Reviewer', 'Signals of figure duplication or inconsistency that need human review; never an accusation.', ['image integrity', 'figure duplication', 'image manipulation', 'blot', '이미지 무결성', '그림 중복'], 'biomedical-research'],
  [117, 'Biomedical Citation & Retraction Reviewer', 'Whether cited references exist, match their claims and are not retracted, checked only against retrieved records.', ['citation', 'reference check', 'retraction', 'fabricated reference', '인용 검증', '철회'], 'biomedical-research'],
  [118, 'Research Integrity & Benchmark Curator', 'Benchmark labels, clean/mutant separation and needs-review handling for document-check evaluations.', ['research integrity', 'benchmark', 'label', 'needs-review', '연구 진실성', '벤치마크'], 'biomedical-research'],
  [119, 'Immunology Research Reviewer', 'Immunology methods, markers and whether immune-response claims follow from reported data.', ['immunology', 'antibody', 'cytokine', 'flow cytometry', '면역학', '항체'], 'biomedical-research'],
  [120, 'Chemical Biology Scientist', 'Probe, target-engagement and mechanism claims at the chemistry-biology boundary as reported.', ['chemical biology', 'chemical probe', 'target engagement', 'mechanism', '화학생물학', '표적 결합'], 'chemistry'],
];

/** Plan number → actual runtime expert id. Planned-only numbers have no id. */
const MAPPING: Record<number, { expertId: string; note?: string }> = {
  1: { expertId: 'agency-product-manager' },
  2: { expertId: 'cb-customer-discovery' },
  4: { expertId: 'agency-business-strategist' },
  11: { expertId: 'cb-ux-researcher' },
  14: { expertId: 'agency-design-ux-architect', note: 'Runs as the existing UX Architect role, which covers related interaction and information-architecture scope; it is not a dedicated Interaction Designer.' },
  20: { expertId: 'cb-human-ai-interaction' },
  21: { expertId: 'agency-engineering-software-architect' },
  31: { expertId: 'agency-engineering-ai-engineer', note: 'Runs as the existing AI Engineer role with the phase-one AI systems knowledge pack.' },
  33: { expertId: 'cb-knowledge-engineer' },
  35: { expertId: 'cb-model-evaluation' },
  42: { expertId: 'cb-sandbox-engineer' },
  49: { expertId: 'cb-finops' },
  51: { expertId: 'agency-security-architect' },
  57: { expertId: 'agency-engineering-privacy-engineer' },
  61: { expertId: 'agency-specialized-pricing-analyst' },
  62: { expertId: 'agency-finance-fpa-analyst' },
  65: { expertId: 'agency-marketing-growth-hacker', note: 'Runs as the existing Growth Hacker role, which covers related acquisition and growth-experiment scope.' },
  67: { expertId: 'agency-operations-manager', note: 'Runs as the existing Operations Manager role, which covers related process-improvement scope.' },
  77: { expertId: 'probably-primetime-sta', note: 'Runs as the curated PrimeTime STA Expert pilot.' },
  91: { expertId: 'cb-evidence-auditor' },
  92: { expertId: 'cb-quantitative-reviewer' },
  93: { expertId: 'cb-assumption-auditor' },
  94: { expertId: 'cb-adversarial-reviewer' },
  99: { expertId: 'agency-product-feedback-synthesizer', note: 'Runs as the existing Feedback Synthesizer role, which covers related feedback-analysis scope; it is not a dedicated outcome-evaluation role.' },
  100: { expertId: 'cb-synthesis-editor' },
};
// Research roles use their specified runtime ids; until a deployment registers them they stay 'planned'.
for (const [number] of RESEARCH_PLAN) MAPPING[number] = { expertId: `cb-role-${number}` };

// Fill new runtime mappings from the actual pack registry while protecting all released ids.
for (const pack of KNOWLEDGE_PACKS) {
  const mapped = MAPPING[pack.catalogNumber];
  if (mapped && mapped.expertId !== pack.expertId) throw new Error('Knowledge pack conflicts with released role mapping');
  if (!mapped) MAPPING[pack.catalogNumber] = { expertId: pack.expertId };
}

/** The twenty phase-one plan numbers (15 common + 5 review roles). */
export const PRIORITY_NUMBERS: readonly number[] = Object.freeze([1, 2, 4, 11, 20, 21, 31, 33, 35, 42, 49, 51, 57, 61, 62, 91, 92, 93, 94, 100]);

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/** Builds the catalogue from the authoritative runtime experts: availability and knowledge come from findExpert only. */
export function buildExpertPool(): ExpertPool {
  const priority = new Set(PRIORITY_NUMBERS);
  const plan = [...PLAN.map(([n, name, mission, keywords]) => [n, name, mission, keywords, CATEGORIES[Math.floor((n - 1) / 10)].key] as const), ...RESEARCH_PLAN];
  if (plan.length > POOL_LIMITS.entries) throw new Error('Expert pool exceeds the catalogue bound');
  const entries = plan.map(([number, name, mission, keywords, key]): ExpertPoolEntry => {
    const category = CATEGORIES.find(c => c.key === key)!;
    const mapped = MAPPING[number];
    const expert = mapped ? findExpert(mapped.expertId) : undefined;
    const runtimeName = expert && expert.name !== name ? `Runs as runtime role "${expert.name}".` : '';
    const note = expert ? [mapped.note ?? runtimeName].filter(Boolean).join(' ') : mapped ? 'Mapped runtime role is not in this deployment\'s catalogue.' : '';
    return {
      id: `pool-${String(number).padStart(3, '0')}`, catalogNumber: number, name: clip(name, POOL_LIMITS.name),
      domain: expert?.domain ?? `${category.domain}.planned`, category: category.key, categoryLabel: { ko: category.ko, en: category.en },
      mission: clip(mission, POOL_LIMITS.mission),
      ...(expert ? { expertId: expert.id } : {}),
      availability: expert ? 'available' : 'planned',
      knowledge: expert ? expert.source.basis : 'none',
      evaluation: 'unvalidated', priority: priority.has(number),
      keywords: keywords.slice(0, POOL_LIMITS.keywords).map(k => clip(k.normalize('NFKC').toLowerCase(), POOL_LIMITS.keyword)),
      ...(note ? { mappingNote: clip(note, POOL_LIMITS.note) } : {}),
    };
  });
  return { version: POOL_VERSION, entries, priorityNumbers: [...PRIORITY_NUMBERS] };
}

export const CLOUDBITE_POOL: ExpertPool = deepFreeze(buildExpertPool());
