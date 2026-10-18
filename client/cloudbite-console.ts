// Cloudbite 프로젝트 콘솔 (브라우저). tools/build-cloudbite-console.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-page.ts 의
// CLOUDBITE_JS 로 고정한다. 같은 출처 외부 스크립트로 내려가며, 화면은 전부 textContent·createElement 로만 그린다.
// 데모는 브라우저 안 시뮬레이션이다 — 실제 Daytona 샌드박스나 Nosana 추론을 만들지 않으며 화면에서 그렇게 밝힌다.
// 실제 실행은 서버 준비 상태와 기존 관리자 토큰(메모리에만)을 요구하고, 실패해도 데모로 몰래 바꾸지 않는다.
import type {
  CloudbiteBootstrap, ExpertActivity, ExpertArtifact, ExpertDefinition, ExpertOpinion, ExpertRun, ExpertStatus,
  OpinionDirection, ProjectBrief, ProjectRun, ProjectStatus,
} from '../src/cloudbite-contract';

type Mode = 'demo' | 'live';
type ConsoleExpert = ExpertRun & { invalidOpinion?: boolean };
type ConsoleProject = Omit<ProjectRun, 'experts'> & { experts: ConsoleExpert[] };
interface Limits { min: number; max: number }
interface FormInput { title: string; objective: string; context: string; expertIds: string[] }
interface DemoStep {
  at: number; expert: number; status?: ExpertStatus; activity?: Omit<ExpertActivity, 'id' | 'at'>;
  artifacts?: ExpertArtifact[]; opinion?: ExpertOpinion; error?: string; sandboxId?: string;
}
interface Aggregate {
  selected: number; completed: number; valid: number; invalid: number; failed: number; pending: number; cancelled: number;
  counts: Record<OpinionDirection, number>; meanConfidence: number | null; buckets: number[];
  leading: OpinionDirection | null; disagreement: boolean;
  supportVoices: Array<{ name: string; confidence: number; summary: string }>;
  concernVoices: Array<{ name: string; confidence: number; summary: string }>;
  actions: Array<{ text: string; count: number; names: string[] }>;
  headline: string;
}

const DIRECTIONS: OpinionDirection[] = ['support', 'conditional', 'concern', 'abstain'];
const DIRECTION_LABEL: Record<OpinionDirection, string> = { support: '지지', conditional: '조건부', concern: '우려', abstain: '판단 보류' };
const STATUS_LABEL: Record<ExpertStatus, string> = {
  queued: '대기', provisioning: '작업공간 준비', running: '작업 중', completed: '완료', failed: '실패', cancelled: '취소됨',
};
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: '초안', running: '진행 중', completed: '완료', partial: '일부 완료', failed: '실패', cancelled: '취소됨',
};
const EXPERT_STATUSES = Object.keys(STATUS_LABEL) as ExpertStatus[];
const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[];
const ACTIVITY_KINDS: ExpertActivity['kind'][] = ['status', 'thought', 'tool', 'artifact', 'error'];
const TERMINAL_EXPERT: ExpertStatus[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_PROJECT: ProjectStatus[] = ['completed', 'partial', 'failed', 'cancelled'];
const LIMIT = { title: 120, objective: 1500, context: 3000 };

// ───────────────────────── 값 정리 (서버·모델이 보낸 것은 전부 의심한다) ─────────────────────────

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function str(v: unknown, n: number, fallback = ''): string { return typeof v === 'string' ? clip(v, n) : fallback; }
function strList(v: unknown, n: number, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max).map(x => clip(x, n)) : [];
}
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function normalizeExpertDef(raw: unknown): ExpertDefinition | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 80), name = str(raw.name, 80);
  if (!id || !name) return null;
  const src = isObj(raw.source) ? raw.source : {};
  return {
    id, name, domain: str(raw.domain, 80, '일반'), summary: str(raw.summary, 400), prompt: str(raw.prompt, 6000),
    tools: strList(raw.tools, 80, 20), outputs: strList(raw.outputs, 120, 20),
    source: {
      repository: str(src.repository, 200), path: str(src.path, 200), revision: str(src.revision, 80),
      license: str(src.license, 80), basis: 'metadata-derived',
    },
  };
}

function normalizeBootstrap(raw: unknown): CloudbiteBootstrap {
  if (!isObj(raw) || !Array.isArray(raw.experts) || !isObj(raw.configuration)) throw new Error('카탈로그 응답 형식이 올바르지 않습니다');
  const seen = new Set<string>();
  const experts: ExpertDefinition[] = [];
  for (const r of raw.experts.slice(0, 500)) {
    const e = normalizeExpertDef(r);
    if (e && !seen.has(e.id)) { seen.add(e.id); experts.push(e); }
  }
  const c = raw.configuration;
  const max = num(c.maxExperts);
  return {
    experts,
    configuration: {
      liveReady: c.liveReady === true, missing: strList(c.missing, 80, 20),
      maxExperts: max !== null && max >= 1 ? Math.min(Math.floor(max), 100) : 5,
    },
  };
}

function normalizeOpinion(raw: unknown): ExpertOpinion | null {
  if (!isObj(raw)) return null;
  const direction = raw.direction as OpinionDirection;
  const confidence = num(raw.confidence);
  const summary = str(raw.summary, 600).trim();
  if (!DIRECTIONS.includes(direction) || confidence === null || confidence < 0 || confidence > 100 || !summary) return null;
  return {
    direction, confidence: Math.round(confidence), summary,
    evidence: strList(raw.evidence, 300, 8), assumptions: strList(raw.assumptions, 300, 8), nextActions: strList(raw.nextActions, 200, 8),
  };
}

function normalizeExpertRun(raw: unknown, i: number): ConsoleExpert | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 120), expertId = str(raw.expertId, 80);
  if (!id || !expertId) return null;
  let status = raw.status as ExpertStatus;
  let error = str(raw.error, 400) || undefined;
  if (!EXPERT_STATUSES.includes(status)) { status = 'failed'; error = '서버가 알 수 없는 상태를 보냈습니다'; }
  const activity: ExpertActivity[] = [];
  if (Array.isArray(raw.activity)) {
    for (const [j, a] of raw.activity.slice(-200).entries()) {
      if (!isObj(a)) continue;
      const kind = ACTIVITY_KINDS.includes(a.kind as ExpertActivity['kind']) ? a.kind as ExpertActivity['kind'] : 'status';
      const message = str(a.message, 500);
      if (message) activity.push({ id: str(a.id, 80, `${id}-${j}`), at: num(a.at) ?? 0, kind, message });
    }
  }
  const artifacts: ExpertArtifact[] = [];
  if (Array.isArray(raw.artifacts)) {
    for (const a of raw.artifacts.slice(0, 50)) {
      if (!isObj(a)) continue;
      const path = str(a.path, 200);
      if (!path) continue;
      const bytes = num(a.bytes);
      artifacts.push({
        path, label: str(a.label, 120, path),
        ...(typeof a.content === 'string' ? { content: clip(a.content, 200_000) } : {}),
        ...(bytes !== null && bytes >= 0 ? { bytes } : {}),
      });
    }
  }
  const opinion = raw.opinion === undefined || raw.opinion === null ? null : normalizeOpinion(raw.opinion);
  const run: ConsoleExpert = {
    id, expertId, name: str(raw.name, 80, `전문가 ${i + 1}`), status, activity, artifacts, updatedAt: num(raw.updatedAt) ?? 0,
  };
  const sandboxId = str(raw.sandboxId, 120);
  if (sandboxId) run.sandboxId = sandboxId;
  if (error) run.error = error;
  if (opinion) run.opinion = opinion;
  else if (raw.opinion !== undefined && raw.opinion !== null) run.invalidOpinion = true;
  return run;
}

function normalizeProject(raw: unknown): ConsoleProject | null {
  if (!isObj(raw) || !Array.isArray(raw.experts) || !isObj(raw.brief)) return null;
  const id = str(raw.id, 120);
  if (!id) return null;
  const b = raw.brief;
  const experts = raw.experts.slice(0, 100).map(normalizeExpertRun).filter((e): e is ConsoleExpert => e !== null);
  const status = PROJECT_STATUSES.includes(raw.status as ProjectStatus) ? raw.status as ProjectStatus : statusFromExperts(experts);
  return {
    id, status, experts, createdAt: num(raw.createdAt) ?? 0, updatedAt: num(raw.updatedAt) ?? 0,
    brief: {
      title: str(b.title, LIMIT.title), objective: str(b.objective, LIMIT.objective), context: str(b.context, LIMIT.context),
      expertIds: strList(b.expertIds, 80, 100), mode: b.mode === 'live' ? 'live' : 'demo', requestId: str(b.requestId, 120),
    },
  };
}

function statusFromExperts(experts: ConsoleExpert[]): ProjectStatus {
  if (experts.length === 0) return 'draft';
  if (experts.some(e => !TERMINAL_EXPERT.includes(e.status))) return 'running';
  const done = experts.filter(e => e.status === 'completed').length;
  if (done === experts.length) return 'completed';
  if (experts.every(e => e.status === 'cancelled')) return 'cancelled';
  if (done > 0) return 'partial';
  return experts.some(e => e.status === 'cancelled') ? 'cancelled' : 'failed';
}

function validateForm(f: FormInput, limits: Limits): string[] {
  const errors: string[] = [];
  if (!f.title.trim()) errors.push('프로젝트 이름을 입력하세요.');
  if (f.title.length > LIMIT.title) errors.push(`프로젝트 이름은 ${LIMIT.title}자 이하여야 합니다.`);
  if (!f.objective.trim()) errors.push('목표를 입력하세요.');
  if (f.objective.length > LIMIT.objective) errors.push(`목표는 ${LIMIT.objective}자 이하여야 합니다.`);
  if (f.context.length > LIMIT.context) errors.push(`맥락은 ${LIMIT.context}자 이하여야 합니다.`);
  if (f.expertIds.length < limits.min) errors.push(`전문가를 ${limits.min}명 이상 선택하세요.`);
  if (f.expertIds.length > limits.max) errors.push(`전문가는 최대 ${limits.max}명까지 선택할 수 있습니다.`);
  return errors;
}

// ───────────────────────── 종합 (완료된 유효 의견만) ─────────────────────────

function aggregate(p: ConsoleProject): Aggregate {
  const counts: Record<OpinionDirection, number> = { support: 0, conditional: 0, concern: 0, abstain: 0 };
  const buckets = [0, 0, 0, 0, 0];
  const actionMap = new Map<string, { text: string; count: number; names: string[]; conf: number }>();
  const supportVoices: Aggregate['supportVoices'] = [], concernVoices: Aggregate['concernVoices'] = [];
  let completed = 0, valid = 0, invalid = 0, failed = 0, pending = 0, cancelled = 0, confSum = 0;
  for (const e of p.experts) {
    if (e.status === 'failed') { failed++; continue; }
    if (e.status === 'cancelled') { cancelled++; continue; }
    if (e.status !== 'completed') { pending++; continue; }
    completed++;
    const o = e.opinion;
    if (!o) { invalid++; continue; }
    valid++;
    counts[o.direction]++;
    confSum += o.confidence;
    buckets[Math.min(4, Math.floor(o.confidence / 20))]++;
    const voice = { name: e.name, confidence: o.confidence, summary: o.summary };
    if (o.direction === 'support') supportVoices.push(voice);
    if (o.direction === 'concern') concernVoices.push(voice);
    for (const a of o.nextActions) {
      const key = a.replace(/\s+/g, ' ').trim().toLowerCase();
      const cur = actionMap.get(key);
      if (cur) { cur.count++; if (!cur.names.includes(e.name)) cur.names.push(e.name); cur.conf = Math.max(cur.conf, o.confidence); }
      else actionMap.set(key, { text: a, count: 1, names: [e.name], conf: o.confidence });
    }
  }
  const byConf = (a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence;
  supportVoices.sort(byConf); concernVoices.sort(byConf);
  let leading: OpinionDirection | null = null;
  for (const d of DIRECTIONS) if (counts[d] > 0 && (leading === null || counts[d] > counts[leading])) leading = d;
  const tie = leading !== null && DIRECTIONS.filter(d => counts[d] === counts[leading!]).length > 1;
  const disagreement = counts.support > 0 && counts.concern > 0;
  const actions = [...actionMap.values()].sort((a, b) => b.count - a.count || b.conf - a.conf).slice(0, 5)
    .map(({ text, count, names }) => ({ text, count, names }));
  let headline = '아직 종합할 완료 의견이 없습니다.';
  if (valid > 0 && leading) {
    const base = tie ? '의견이 팽팽히 갈립니다 — 결정 전에 쟁점을 먼저 좁히세요.'
      : leading === 'support' ? '진행 쪽 의견이 우세합니다 — 제시된 다음 행동으로 바로 옮길 수 있습니다.'
        : leading === 'conditional' ? '조건을 정하고 작게 시작하라는 의견이 우세합니다.'
          : leading === 'concern' ? '우려가 우세합니다 — 핵심 위험을 해소하기 전에는 확대하지 마세요.'
            : '판단을 보류한 의견이 많습니다 — 추가 정보가 필요합니다.';
    headline = valid < p.experts.length ? `${base} (선택한 ${p.experts.length}명 중 ${valid}명 의견 기준)` : base;
  }
  return {
    selected: p.experts.length, completed, valid, invalid, failed, pending, cancelled, counts,
    meanConfidence: valid ? Math.round(confSum / valid) : null, buckets, leading: tie ? null : leading, disagreement,
    supportVoices: supportVoices.slice(0, 2), concernVoices: concernVoices.slice(0, 2), actions, headline,
  };
}

// ───────────────────────── 브라우저 데모 (시뮬레이션) ─────────────────────────

const DEMO_SOURCE = { repository: 'cloudbite 내장 데모', path: 'client/cloudbite-console.ts', revision: 'demo', license: 'demo', basis: 'metadata-derived' as const };
const DEMO_EXPERTS: ExpertDefinition[] = [
  ['demo-product-strategist', '제품 전략가', '제품 전략', '출시 범위와 단계, 경쟁 대안 대비 차별점을 판단합니다.'],
  ['demo-business-model', '비즈니스 모델 전문가', '사업·재무', '가격, 단위 경제성, 추론 비용 회수 경로를 검토합니다.'],
  ['demo-ai-trust', 'AI 윤리·신뢰성 전문가', 'AI 신뢰성', '근거 표기, 책임 한계, 위험 도메인의 안전장치를 점검합니다.'],
  ['demo-data-validation', '데이터 검증 전문가', '데이터 품질', '출처 품질과 의견 근거의 검증 가능성을 따집니다.'],
  ['demo-ux-research', 'UX 리서처', '사용자 경험', '첫 사용 흐름과 이해 가능성, 사용자 가치 도달 시간을 봅니다.'],
  ['demo-security-compliance', '보안·컴플라이언스 전문가', '보안·규제', '데이터 처리, 접근 통제, 규제 요구를 검토합니다.'],
].map(([id, name, domain, summary]) => ({
  id, name, domain, summary,
  prompt: `당신은 Cloudbite 데모의 AI 역할 "${name}"입니다. 실제 인물이 아니며 보증을 뜻하지 않습니다. ${summary} 공통 프로젝트 문서를 읽고 역할 관점의 권고·근거·가정·자체 평가 확신도·다음 행동을 out/result.json 에 씁니다.`,
  tools: ['read_file', 'write_file', 'python'], outputs: ['out/notes.md', 'out/result.json', 'out/report.md'], source: DEMO_SOURCE,
}));

type Archetype = 'strategy' | 'business' | 'trust' | 'data' | 'ux' | 'security' | 'generic';
function archetypeOf(e: ExpertDefinition): Archetype {
  const t = `${e.id} ${e.name} ${e.domain}`.toLowerCase();
  if (/전략|strateg|product|제품/.test(t)) return 'strategy';
  if (/비즈니스|재무|사업|가격|finance|business|pricing/.test(t)) return 'business';
  if (/윤리|신뢰|ethic|trust|safety/.test(t)) return 'trust';
  if (/데이터|data|검증|analy/.test(t)) return 'data';
  if (/ux|사용자|디자인|design|research/.test(t)) return 'ux';
  if (/보안|규제|컴플라|법|security|legal|compliance|privacy/.test(t)) return 'security';
  return 'generic';
}

function has(text: string, words: string[]): boolean { return words.some(w => text.includes(w)); }
function quote(s: string, n = 48): string { const t = s.replace(/\s+/g, ' ').trim(); return t ? `“${clip(t, n)}”` : '“(비어 있음)”'; }

interface DemoWork { steps: Array<[ExpertActivity['kind'], string]>; notes: string; opinion: ExpertOpinion }
function demoWork(e: ExpertDefinition, b: ProjectBrief, h: number): DemoWork {
  const all = `${b.title}\n${b.objective}\n${b.context}`;
  const jitter = (base: number, span: number) => base + (h % span);
  const ctx = b.context.trim() ? quote(b.context) : '맥락 미입력';
  const obj = quote(b.objective);
  let direction: OpinionDirection, confidence: number, summary: string;
  let steps: DemoWork['steps'], evidence: string[], assumptions: string[], nextActions: string[];
  switch (archetypeOf(e)) {
    case 'strategy': {
      const fast = has(all, ['2주', '4주', '빠르', '단기']);
      const wide = has(all, ['100', '전체', '모든']);
      direction = fast || wide ? 'conditional' : 'support';
      confidence = jitter(fast && wide ? 70 : 64, 14);
      summary = fast && wide ? '일정은 짧고 범위는 넓습니다. 핵심 역할로 범위를 좁힌 단계 출시가 필요합니다.'
        : wide ? '범위가 넓습니다. 핵심 역할로 먼저 검증한 뒤 확장하세요.'
          : '목표와 범위가 맞물려 있어 바로 실행할 만합니다.';
      steps = [
        ['tool', `python scope_matrix.py — 목표 ${obj} 를 기능·범위·일정 축으로 분해`],
        ['thought', wide ? '역할 수가 많으면 첫 주에 품질 편차가 커짐. 상위 20개 역할 우선 검토' : '범위가 좁아 첫 출시 리스크가 낮음'],
        ['tool', 'write_file out/notes.md — 단계별 출시안 3안 비교표 작성'],
      ];
      evidence = [`목표 ${obj}`, fast ? '일정 관련 표현(단기 일정)이 브리프에 있음' : '일정 제약이 명시되지 않음', wide ? '넓은 범위 표현이 있음' : '범위가 좁게 정의됨'];
      assumptions = ['첫 사용자 집단이 하나로 정해져 있다고 가정', '경쟁 서비스와 같은 기능 비교는 범위 밖'];
      nextActions = ['핵심 역할 20개로 첫 출시 범위 제한', '2주 단위 출시 체크포인트 설정'];
      break;
    }
    case 'business': {
      const free = has(all, ['무료']) && !has(all, ['유료', '구독', '과금']);
      const paid = has(all, ['부분 유료', '유료', '구독', '과금']);
      direction = free ? 'concern' : paid ? 'support' : 'conditional';
      confidence = jitter(free ? 72 : paid ? 66 : 58, 12);
      summary = free ? '무료만으로는 전문가 수만큼 늘어나는 추론 비용을 회수할 경로가 없습니다.'
        : paid ? '유료 전환 경로가 있어 사용량 한도만 정하면 단위 경제성이 성립합니다.'
          : '수익 모델이 정해지지 않아 가격 실험부터 필요합니다.';
      steps = [
        ['tool', 'python unit_economics.py --experts 5 --rounds 3 — 의견 1회당 추론 비용 추정'],
        ['thought', free ? '무료 사용자당 비용이 선형 증가, 상한 없음' : paid ? '부분 유료 시 상위 10% 사용자가 비용을 상쇄' : '가격 가설 3개를 비교해야 함'],
        ['tool', 'write_file out/notes.md — 가격 시나리오별 손익분기 표'],
      ];
      evidence = [free ? '브리프에 무료 모델만 언급' : paid ? '브리프에 유료 전환 표현이 있음' : '수익 모델 언급 없음', `맥락 ${ctx}`];
      assumptions = ['전문가 1명당 추론 3회 내외', '모델 단가는 데모 가정값이며 실제 견적이 아님'];
      nextActions = ['사용 한도와 가격 상한을 먼저 설정', '핵심 역할 20개로 첫 출시 범위 제한'];
      break;
    }
    case 'trust': {
      const risky = has(all, ['의료', '법률', '투자', '금융', '진단']);
      const sourced = has(all, ['출처', '근거', '검증']);
      direction = risky ? 'concern' : sourced ? 'conditional' : 'concern';
      confidence = jitter(risky ? 78 : 61, 12);
      summary = risky ? '고위험 도메인 조언이 포함됩니다. 책임 한계와 전문가 검토 없이 공개하면 안 됩니다.'
        : sourced ? '근거 표기 의도가 있습니다. 출처 품질 기준을 문서로 정하면 진행 가능합니다.'
          : '의견마다 근거·출처를 표기하는 기준이 없어 신뢰를 설명하기 어렵습니다.';
      steps = [
        ['tool', 'read_file PROJECT.md — 위험 도메인 키워드 점검'],
        ['thought', risky ? '고위험 도메인 표현 발견: 면책·사람 검토 단계 필수' : '고위험 도메인 표현 없음, 근거 표기 기준이 관건'],
        ['tool', 'write_file out/notes.md — 근거 표기 체크리스트 초안'],
      ];
      evidence = [risky ? '브리프에 고위험 도메인 표현이 있음' : '고위험 도메인 표현 없음', sourced ? '근거·출처 언급 있음' : '근거·출처 기준 언급 없음'];
      assumptions = ['AI 역할 의견은 실제 전문가 보증이 아님을 사용자에게 고지한다고 가정'];
      nextActions = ['의견별 근거·출처 표기 기준 문서화', risky ? '고위험 주제는 사람 전문가 검토 후 공개' : 'AI 역할 고지 문구를 첫 화면에 배치'];
      break;
    }
    case 'data': {
      const sourced = has(all, ['데이터', '근거', '출처', '지표']);
      direction = sourced ? 'support' : 'conditional';
      confidence = jitter(sourced ? 69 : 55, 15);
      summary = sourced ? '근거 데이터를 쓰려는 방향이 분명합니다. 자동 검증 파이프라인을 붙이면 됩니다.'
        : '의견의 근거 데이터가 정의되지 않았습니다. 검증 가능한 지표부터 정하세요.';
      steps = [
        ['tool', 'python claim_check.py PROJECT.md — 검증 가능한 주장 수 집계'],
        ['thought', sourced ? '검증 가능한 주장이 있어 표본 점검 가능' : '정량 지표가 없어 결과 비교 기준 부재'],
        ['tool', 'write_file out/notes.md — 지표 정의서와 표본 점검 절차'],
      ];
      evidence = [`목표 ${obj}`, sourced ? '데이터·근거 관련 표현이 있음' : '정량 지표 언급 없음'];
      assumptions = ['초기 표본 30건으로 의견 품질을 점검할 수 있다고 가정'];
      nextActions = ['의견별 근거·출처 표기 기준 문서화', '주간 표본 30건 품질 점검'];
      break;
    }
    case 'ux': {
      const simple = has(all, ['간단', '쉽', '초보', '처음']);
      direction = simple ? 'support' : 'conditional';
      confidence = jitter(simple ? 67 : 60, 14);
      summary = simple ? '쉬운 첫 경험을 목표로 해 사용자 가치 도달이 빠를 것입니다.'
        : '전문가 수가 많을수록 결과 이해가 어렵습니다. 요약→근거 순 정보 구조가 필요합니다.';
      steps = [
        ['tool', 'python flow_walkthrough.py — 첫 질문부터 결과 이해까지 단계 수 계산'],
        ['thought', simple ? '첫 결과까지 3단계, 양호' : '결과 화면에서 의견 비교 단계가 길어질 위험'],
        ['tool', 'write_file out/notes.md — 첫 사용 흐름 스토리보드'],
      ];
      evidence = [`목표 ${obj}`, simple ? '쉬운 사용 경험 표현이 있음' : '사용 흐름 요구 언급 없음'];
      assumptions = ['첫 사용자는 의견 원문보다 요약을 먼저 본다고 가정'];
      nextActions = ['종합 요약을 먼저, 근거를 펼쳐 보기로 배치', '초기 사용자 5명 사용성 테스트'];
      break;
    }
    case 'security': {
      const sensitive = has(all, ['기업', '개인정보', '고객 데이터', 'B2B', '사내']);
      direction = sensitive ? 'concern' : 'conditional';
      confidence = jitter(sensitive ? 74 : 57, 12);
      summary = sensitive ? '고객 데이터가 전문가 작업공간마다 복제됩니다. 격리·보존 기한 정책 없이는 진행하면 안 됩니다.'
        : '민감 데이터 언급은 없지만 작업공간별 데이터 보존 기한은 정해야 합니다.';
      steps = [
        ['tool', 'python data_flow.py — 브리프가 작업공간으로 복제되는 경로 추적'],
        ['thought', sensitive ? '민감 데이터 표현 발견: 작업공간 수만큼 노출면 증가' : '민감 데이터 표현 없음'],
        ['tool', 'write_file out/notes.md — 데이터 보존·삭제 정책 초안'],
      ];
      evidence = [sensitive ? '브리프에 기업·개인정보 관련 표현이 있음' : '민감 데이터 표현 없음', '작업공간은 전문가별로 분리되어 있음'];
      assumptions = ['작업 종료 후 작업공간을 삭제한다고 가정'];
      nextActions = ['작업공간 데이터 보존 기한과 삭제 절차 확정', sensitive ? '고객 데이터는 익명화 후 투입' : '접근 로그 보관 정책 수립'];
      break;
    }
    default: {
      const pick = h % 3;
      direction = (['support', 'conditional', 'concern'] as const)[pick];
      confidence = jitter(52, 25);
      summary = `${e.domain} 관점에서 ${DIRECTION_LABEL[direction]} 의견입니다. 목표 ${obj} 의 전제를 역할 기준으로 검토했습니다.`;
      steps = [
        ['tool', `read_file PROJECT.md — ${e.domain} 관점 쟁점 추출`],
        ['thought', `${e.domain} 기준으로 가장 큰 불확실성을 정리`],
        ['tool', 'write_file out/notes.md — 역할 관점 검토 메모'],
      ];
      evidence = [`목표 ${obj}`, `맥락 ${ctx}`];
      assumptions = ['역할 정의는 카탈로그 메타데이터 기반'];
      nextActions = [`${e.domain} 관점 핵심 가정 검증`];
    }
  }
  confidence = Math.max(0, Math.min(100, confidence));
  const notes = [`# ${e.name} 작업 메모 (브라우저 데모)`, '', `프로젝트: ${b.title}`, `목표: ${b.objective}`, '',
    '## 검토 단계', ...steps.map(([, m], i) => `${i + 1}. ${m}`), '', '## 근거', ...evidence.map(x => `- ${x}`), '',
    '> 이 파일은 브라우저 안에서 만든 시뮬레이션 결과입니다. 실제 샌드박스나 모델 추론을 거치지 않았습니다.'].join('\n');
  return { steps, notes, opinion: { direction, confidence, summary, evidence, assumptions, nextActions } };
}

function workorderText(e: ExpertDefinition, b: ProjectBrief): string {
  return [`# 작업 지시서 — ${e.name}`, '', `역할 분야: ${e.domain}`, '', '## 공통 프로젝트', `- 이름: ${b.title}`, `- 목표: ${b.objective}`,
    `- 맥락: ${b.context || '(없음)'}`, '', '## 역할 목표', e.summary || `${e.domain} 관점에서 공통 프로젝트를 검토한다.`, '',
    '## 산출물 계약', '- out/result.json: direction(support|conditional|concern|abstain), confidence(0–100, 자체 평가), summary, evidence[], assumptions[], nextActions[]',
    '- out/report.md: 사람이 읽는 보고서', '', '확신도는 자체 평가이며 보정된 정확도가 아니다.'].join('\n');
}

function personaText(e: ExpertDefinition): string {
  return [`# ${e.name}`, '', `분야: ${e.domain}`, '', e.summary, '', '## 역할 지시', e.prompt || '(카탈로그에 지시문 없음)', '',
    `## 도구\n${e.tools.map(t => `- ${t}`).join('\n') || '- (없음)'}`, '', `## 출처\n${e.source.repository} · ${e.source.path} · ${e.source.revision} · ${e.source.license} (${e.source.basis})`,
    '', 'AI 역할이며 실제 인물의 의견이나 보증이 아니다.'].join('\n');
}

function reportText(e: ExpertDefinition, b: ProjectBrief, o: ExpertOpinion): string {
  return [`# ${e.name} 보고서 (브라우저 데모)`, '', `프로젝트: ${b.title}`, '', `## 권고: ${DIRECTION_LABEL[o.direction]} · 자체 평가 확신도 ${o.confidence}%`, '', o.summary, '',
    '## 근거', ...o.evidence.map(x => `- ${x}`), '', '## 가정', ...o.assumptions.map(x => `- ${x}`), '', '## 다음 행동', ...o.nextActions.map((x, i) => `${i + 1}. ${x}`), '',
    '> 시뮬레이션 결과. 실제 Daytona 샌드박스나 Nosana 추론을 거치지 않았습니다.'].join('\n');
}

/** 데모 실행 계획: 결정적(같은 브리프면 같은 결과). failIndex 의 전문가는 중간에 실패한다 */
function demoPlan(b: ProjectBrief, experts: ExpertDefinition[], failIndex: number, now: number): { project: ConsoleProject; steps: DemoStep[] } {
  const steps: DemoStep[] = [];
  const runs: ConsoleExpert[] = experts.map((e, i) => ({
    id: `demo-${i + 1}-${e.id}`, expertId: e.id, name: e.name, status: 'queued', activity: [], artifacts: [], updatedAt: now,
  }));
  experts.forEach((e, i) => {
    const h = hash(`${e.id}\n${b.title}\n${b.objective}\n${b.context}`);
    const w = demoWork(e, b, h);
    let t = 300 + i * 450;
    steps.push({ at: t, expert: i, status: 'provisioning', sandboxId: `demo-ws-${(h % 0xffff).toString(16).padStart(4, '0')}`,
      activity: { kind: 'status', message: '데모 작업공간 준비 — 브라우저 시뮬레이션, 실제 샌드박스 아님' },
      artifacts: [
        { path: 'PERSONA.md', label: '페르소나', content: personaText(e) },
        { path: 'PROJECT.md', label: '공통 프로젝트', content: `# ${b.title}\n\n## 목표\n${b.objective}\n\n## 맥락\n${b.context || '(없음)'}` },
        { path: 'WORKORDER.md', label: '작업 지시서', content: workorderText(e, b) },
      ] });
    t += 900 + (h % 500);
    steps.push({ at: t, expert: i, status: 'running', activity: { kind: 'tool', message: 'read_file WORKORDER.md — 역할 목표와 산출물 계약 확인' } });
    w.steps.forEach(([kind, message], j) => {
      t += 1300 + ((h >>> (j * 4)) % 1100);
      steps.push({ at: t, expert: i, activity: { kind, message } });
      if (i === failIndex && j === 1) {
        t += 900;
        steps.push({ at: t, expert: i, status: 'failed', error: '데모: 추론 응답 시간 초과를 시뮬레이션했습니다',
          activity: { kind: 'error', message: '추론 응답 시간 초과(시뮬레이션) — 이 전문가 의견은 종합에서 제외됩니다' } });
      }
    });
    if (i === failIndex) return;
    t += 700;
    steps.push({ at: t, expert: i, activity: { kind: 'artifact', message: 'out/notes.md 작성 완료' },
      artifacts: [{ path: 'out/notes.md', label: '작업 메모', content: w.notes }] });
    t += 1000 + (h % 600);
    steps.push({ at: t, expert: i, status: 'completed', opinion: w.opinion,
      activity: { kind: 'artifact', message: `out/result.json 제출 — ${DIRECTION_LABEL[w.opinion.direction]} · 확신도 ${w.opinion.confidence}%` },
      artifacts: [
        { path: 'out/result.json', label: '결과 JSON', content: JSON.stringify(w.opinion, null, 2) },
        { path: 'out/report.md', label: '보고서', content: reportText(e, b, w.opinion) },
      ] });
  });
  steps.sort((a, b2) => a.at - b2.at);
  const project: ConsoleProject = { id: `demo-${hash(b.requestId).toString(36)}`, brief: b, status: 'running', experts: runs, createdAt: now, updatedAt: now };
  return { project, steps };
}

function applyStep(p: ConsoleProject, s: DemoStep, now: number): ConsoleProject {
  const experts = p.experts.map((e, i) => {
    if (i !== s.expert || TERMINAL_EXPERT.includes(e.status)) return e;
    const next: ConsoleExpert = { ...e, updatedAt: now, activity: e.activity.slice(), artifacts: e.artifacts.slice() };
    if (s.status) next.status = s.status;
    if (s.sandboxId) next.sandboxId = s.sandboxId;
    if (s.error) next.error = s.error;
    if (s.opinion) next.opinion = s.opinion;
    if (s.activity) next.activity.push({ id: `${e.id}-${next.activity.length}`, at: now, ...s.activity });
    for (const a of s.artifacts ?? []) {
      const k = next.artifacts.findIndex(x => x.path === a.path);
      if (k >= 0) next.artifacts[k] = a; else next.artifacts.push(a);
    }
    return next;
  });
  return { ...p, experts, status: statusFromExperts(experts), updatedAt: now };
}

function cancelProject(p: ConsoleProject, now: number): ConsoleProject {
  const experts = p.experts.map(e => TERMINAL_EXPERT.includes(e.status) ? e : {
    ...e, status: 'cancelled' as const, updatedAt: now,
    activity: [...e.activity, { id: `${e.id}-${e.activity.length}`, at: now, kind: 'status' as const, message: '사용자가 프로젝트를 취소했습니다' }],
  });
  return { ...p, experts, status: 'cancelled', updatedAt: now };
}

// ───────────────────────── 내보내기 ─────────────────────────

function markdownReport(p: ConsoleProject, demo: boolean): string {
  const a = aggregate(p);
  const lines = [`# ${p.brief.title}`, '', demo ? '> 브라우저 데모 시뮬레이션 결과입니다. 실제 Daytona 샌드박스나 Nosana 추론을 거치지 않았습니다.' : '> 실제 실행 결과입니다. 확신도는 각 AI 역할의 자체 평가이며 보정된 정확도가 아닙니다.', '',
    '## 목표', p.brief.objective, '', '## 맥락', p.brief.context || '(없음)', '',
    '## 종합', `- 상태: ${PROJECT_STATUS_LABEL[p.status]}`, `- 선택 ${a.selected}명 · 유효 의견 ${a.valid}명 · 실패 ${a.failed} · 대기·진행 ${a.pending} · 취소 ${a.cancelled} · 형식 오류 ${a.invalid}`,
    `- ${DIRECTIONS.map(d => `${DIRECTION_LABEL[d]} ${a.counts[d]}`).join(' · ')}`,
    `- 평균 자체 평가 확신도: ${a.meanConfidence === null ? '—' : a.meanConfidence + '%'}`, '', a.headline, '', '## 다음 행동',
    ...(a.actions.length ? a.actions.map((x, i) => `${i + 1}. ${x.text} (${x.names.join(', ')})`) : ['(없음)']), '', '## 전문가별 의견'];
  for (const e of p.experts) {
    lines.push('', `### ${e.name} — ${STATUS_LABEL[e.status]}`);
    if (e.opinion) lines.push(`${DIRECTION_LABEL[e.opinion.direction]} · 확신도 ${e.opinion.confidence}%`, '', e.opinion.summary);
    else if (e.error) lines.push(`오류: ${e.error}`);
    else if (e.invalidOpinion) lines.push('결과 형식이 올바르지 않아 종합에서 제외했습니다.');
  }
  return lines.join('\n') + '\n';
}

// ───────────────────────── DOM ─────────────────────────

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') (n as unknown as Record<string, unknown>)[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

function fill(n: Element, ...kids: Kid[]): void { n.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false)); }

function boot(): void {
  const root = document.getElementById('cloudbite');
  if (!root) return;

  const S = {
    gen: 0,
    boot: { status: 'loading' as 'loading' | 'ready' | 'error', data: null as CloudbiteBootstrap | null, error: '' },
    mode: 'demo' as Mode,
    adminToken: '',
    selected: new Set<string>(),
    failSim: false,
    run: null as null | {
      mode: Mode; phase: 'starting' | 'running' | 'cancelling' | 'done' | 'error'; project: ConsoleProject | null;
      accessToken: string; error: string; startedAt: number; pollErrors: number;
    },
    focusExpert: '',
    tab: 'activity' as 'persona' | 'workorder' | 'activity' | 'artifacts',
    artifactPath: '',
    artifactCache: new Map<string, { state: 'loading' | 'ok' | 'error'; text: string }>(),
    formErrors: [] as string[],
  };
  let timers: number[] = [];
  let pollTimer = 0;
  let lastAnnounce = '';

  const catalogue = (): ExpertDefinition[] => S.mode === 'live' ? S.boot.data?.experts ?? [] : (S.boot.data?.experts.length ? S.boot.data.experts : DEMO_EXPERTS);
  const catalogueIsBuiltin = () => S.mode === 'demo' && !S.boot.data?.experts.length;
  const limits = (): Limits => ({ min: 1, max: Math.max(1, Math.min(5, S.mode === 'live' ? S.boot.data?.configuration.maxExperts ?? 5 : 5)) });
  const active = () => !!S.run && (S.run.phase === 'starting' || S.run.phase === 'running' || S.run.phase === 'cancelling'
    || (S.run.phase === 'error' && !!S.run.project && !TERMINAL_PROJECT.includes(S.run.project.status)));
  const findDef = (id: string) => catalogue().find(e => e.id === id) ?? DEMO_EXPERTS.find(e => e.id === id);

  // ── 고정 뼈대 (입력란은 한 번만 만들어 포커스·입력 중 글자를 잃지 않는다)
  const titleIn = h('input', { id: 'cb-title', type: 'text', maxlength: LIMIT.title, autocomplete: 'off', value: '100인 AI 자문실 출시' });
  const objectiveIn = h('textarea', { id: 'cb-objective', rows: 3, maxlength: LIMIT.objective });
  objectiveIn.value = '스타트업 팀을 대상으로 부분 유료 모델의 100인 AI 자문실을 4주 안에 출시하는 것이 적절한지 판단하고, 주의할 점을 받고 싶습니다.';
  const contextIn = h('textarea', { id: 'cb-context', rows: 4, maxlength: LIMIT.context });
  contextIn.value = '초기 사용자는 5~20인 스타트업 팀. 의견마다 근거와 출처를 보여 주려 함. 팀 데이터는 업로드하지 않음.';
  const counter = (inp: HTMLInputElement | HTMLTextAreaElement, max: number) => {
    const c = h('span', { class: 'cb-count', 'aria-hidden': 'true' });
    const upd = () => { c.textContent = `${inp.value.length} / ${max}`; };
    inp.addEventListener('input', upd); upd();
    return c;
  };
  const tokenIn = h('input', { id: 'cb-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '기존 관리자 세션 토큰' });
  tokenIn.addEventListener('input', () => { S.adminToken = tokenIn.value; renderControls(); });
  const failIn = h('input', { id: 'cb-fail', type: 'checkbox' });
  failIn.addEventListener('change', () => { S.failSim = failIn.checked; });
  const filterIn = h('input', { id: 'cb-filter', type: 'search', placeholder: '역할·분야 검색', autocomplete: 'off', 'aria-label': '전문가 검색' });
  filterIn.addEventListener('input', () => renderCatalogue());

  const modeDemo = h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'true', onclick: () => setMode('demo') }, '브라우저 데모');
  const modeLive = h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'false', onclick: () => setMode('live') }, '실제 실행');
  const startBtn = h('button', { type: 'submit', class: 'cb-primary' }, '전문가 작업 시작');
  const cancelBtn = h('button', { type: 'button', class: 'cb-secondary', onclick: () => cancelRun() }, '취소');
  const formMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const catalogueBox = h('div', { class: 'cb-catalogue', role: 'group', 'aria-labelledby': 'cb-cat-label' });
  const catalogueNote = h('p', { class: 'cb-help' });
  const selCount = h('span', { class: 'cb-selcount' });
  const liveStatus = h('div', { class: 'cb-live-status' });
  const clearTokenBtn = h('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.adminToken = ''; tokenIn.value = ''; renderControls(); tokenIn.focus(); } }, '토큰 지우기');
  const liveBox = h('div', { class: 'cb-live' }, liveStatus,
    h('label', { for: 'cb-token', class: 'cb-label' }, '관리자 토큰'), tokenIn,
    h('p', { class: 'cb-help' }, '토큰은 이 탭 메모리에만 두고 저장하지 않습니다. Daytona·Nosana API 키는 입력받지 않습니다.'), clearTokenBtn);
  const demoBox = h('div', { class: 'cb-demoopts' },
    h('label', { class: 'cb-check' }, failIn, ' 한 전문가 실패 시뮬레이션'));

  const form = h('form', { class: 'cb-form', novalidate: true, 'aria-labelledby': 'cb-brief-h' },
    h('div', { class: 'cb-segs', role: 'group', 'aria-label': '실행 방식' }, modeDemo, modeLive),
    liveBox, demoBox,
    h('label', { for: 'cb-title', class: 'cb-label' }, '프로젝트 이름'), titleIn, counter(titleIn, LIMIT.title),
    h('label', { for: 'cb-objective', class: 'cb-label' }, '목표 — 무엇을 판단하거나 만들까요?'), objectiveIn, counter(objectiveIn, LIMIT.objective),
    h('label', { for: 'cb-context', class: 'cb-label' }, '맥락 (선택)'), contextIn, counter(contextIn, LIMIT.context),
    h('div', { class: 'cb-label-row' }, h('span', { id: 'cb-cat-label', class: 'cb-label' }, '전문가 선택'), selCount),
    filterIn, catalogueBox, catalogueNote, formMsg,
    h('div', { class: 'cb-actions' }, startBtn, cancelBtn));
  form.addEventListener('submit', ev => { ev.preventDefault(); startRun(); });

  const modeBadge = h('span', { class: 'cb-badge' });
  const crumb = h('span', { class: 'cb-crumb-title' });
  const dlJson = h('button', { type: 'button', class: 'cb-ghost', onclick: () => download('json') }, 'JSON 내보내기');
  const dlMd = h('button', { type: 'button', class: 'cb-ghost', onclick: () => download('md') }, '보고서 내보내기');
  const banner = h('p', { class: 'cb-banner' });
  const live = h('div', { class: 'cb-sr', 'aria-live': 'polite' });
  const progress = h('div', { class: 'cb-progress' });
  const cards = h('div', { class: 'cb-cards' });
  const detail = h('div', { class: 'cb-detail' });
  const synth = h('div', { class: 'cb-synth-body' });

  root.replaceChildren(
    h('header', { class: 'cb-top' },
      h('div', { class: 'cb-brand' }, h('span', { class: 'cb-word' }, 'cloudbite'), h('span', { class: 'cb-suffix' }, '전문가 작업공간')),
      h('nav', { class: 'cb-crumbs', 'aria-label': '위치' }, h('span', null, '프로젝트'), h('span', { 'aria-hidden': 'true' }, '›'), crumb, h('span', { 'aria-hidden': 'true' }, '›'), h('strong', null, '전문가 작업공간')),
      h('div', { class: 'cb-topright' }, modeBadge, dlMd, dlJson, h('a', { class: 'cb-legacy', href: '/lab' }, '기존 실습실'))),
    banner, live,
    h('main', { class: 'cb-grid' },
      h('section', { class: 'cb-panel cb-brief', 'aria-labelledby': 'cb-brief-h' }, h('h2', { id: 'cb-brief-h' }, '공통 프로젝트'),
        h('p', { class: 'cb-help' }, '선택한 전문가마다 독립 작업공간에서 같은 브리프를 각자의 역할로 수행합니다.'), form),
      h('section', { class: 'cb-panel cb-synth', 'aria-labelledby': 'cb-synth-h' }, h('h2', { id: 'cb-synth-h' }, '종합'), synth),
      h('section', { class: 'cb-panel cb-work', 'aria-labelledby': 'cb-work-h' },
        h('div', { class: 'cb-work-head' }, h('h2', { id: 'cb-work-h' }, '전문가 작업공간'), progress), cards, detail)));

  // ── 렌더 (동적 영역만 다시 그린다. 포커스는 data-fk 로 되돌린다)
  function keepFocus(fn: () => void): void {
    const a = document.activeElement as HTMLElement | null;
    const key = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    fn();
    if (key) { const n = root!.querySelector(`[data-fk="${CSS.escape(key)}"]`) as HTMLElement | null; if (n) n.focus(); }
  }

  function renderAll(): void { keepFocus(() => { renderControls(); renderCatalogue(); renderWork(); renderSynth(); }); }

  function renderControls(): void {
    const demo = S.mode === 'demo';
    modeDemo.setAttribute('aria-pressed', String(demo)); modeLive.setAttribute('aria-pressed', String(!demo));
    modeDemo.disabled = modeLive.disabled = active();
    const runMode = S.run?.mode ?? S.mode;
    modeBadge.textContent = runMode === 'demo' ? '브라우저 데모' : '실제 실행';
    modeBadge.className = `cb-badge ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    banner.textContent = runMode === 'demo'
      ? '브라우저 데모 — 이 화면의 작업공간·활동·파일은 브라우저 안 시뮬레이션입니다. 실제 Daytona 샌드박스나 Nosana 추론을 만들지 않습니다.'
      : '실제 실행 — 서버가 전문가별 Daytona 샌드박스를 만들고 반환한 상태만 표시합니다. 확신도는 자체 평가이며 보정된 정확도가 아닙니다.';
    banner.className = `cb-banner ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    crumb.textContent = clip(S.run?.project?.brief.title || titleIn.value || '새 프로젝트', 40);
    demoBox.hidden = !demo; liveBox.hidden = demo;
    const cfg = S.boot.data?.configuration;
    const liveKids: Kid[] = [];
    if (S.boot.status === 'loading') liveKids.push(h('p', { class: 'cb-help' }, '서버 준비 상태를 확인하는 중…'));
    else if (S.boot.status === 'error') liveKids.push(h('p', { class: 'cb-warn' }, `서버 카탈로그를 불러오지 못했습니다: ${S.boot.error}`),
      h('button', { type: 'button', class: 'cb-ghost', onclick: () => loadBootstrap() }, '다시 확인'));
    else if (cfg && !cfg.liveReady) liveKids.push(h('div', { class: 'cb-warn' }, h('strong', null, '실제 실행 준비 안 됨'),
      h('p', null, cfg.missing.length ? '서버 운영자가 다음 설정을 서버에 넣어야 합니다 (값은 이 화면에서 받지 않습니다):' : '서버가 실제 실행 준비가 안 됐다고 응답했습니다.'),
      cfg.missing.length ? h('ul', null, ...cfg.missing.map(m => h('li', null, h('code', null, m)))) : null));
    else if (cfg) liveKids.push(h('p', { class: 'cb-ok' }, `서버 준비됨 · 최대 ${cfg.maxExperts}명`));
    liveStatus.replaceChildren(...liveKids.filter((k): k is Node => !!k));
    clearTokenBtn.hidden = !S.adminToken;
    const busy = active();
    for (const n of [titleIn, objectiveIn, contextIn, failIn, tokenIn]) n.disabled = busy;
    const liveBlocked = !demo && (S.boot.status !== 'ready' || !cfg?.liveReady || !S.adminToken.trim());
    startBtn.disabled = busy || liveBlocked;
    startBtn.textContent = S.run?.phase === 'starting' ? '시작하는 중…' : busy ? '진행 중…' : S.run ? '다시 실행' : '전문가 작업 시작';
    cancelBtn.disabled = !busy || S.run?.phase === 'cancelling' || S.run?.phase === 'starting';
    cancelBtn.textContent = S.run?.phase === 'cancelling' ? '취소하는 중…' : '취소';
    const msgs = [...S.formErrors];
    if (S.run?.error) msgs.push(S.run.error);
    formMsg.replaceChildren(...msgs.map(m => h('p', null, m)));
    const p = S.run?.project;
    dlJson.disabled = dlMd.disabled = !p;
    selCount.textContent = `${S.selected.size} / 최대 ${limits().max}명`;
  }

  function renderCatalogue(): void {
    const list = catalogue();
    const q = filterIn.value.trim().toLowerCase();
    const shown = list.filter(e => !q || `${e.name} ${e.domain} ${e.summary}`.toLowerCase().includes(q)).slice(0, 120);
    const busy = active();
    const full = S.selected.size >= limits().max;
    catalogueBox.replaceChildren(...shown.map(e => {
      const on = S.selected.has(e.id);
      const cb = h('input', { type: 'checkbox', id: `cb-x-${e.id}`, 'data-fk': `x:${e.id}`, checked: on, disabled: busy || (!on && full) });
      cb.addEventListener('change', () => {
        if (cb.checked) S.selected.add(e.id); else S.selected.delete(e.id);
        S.formErrors = []; keepFocus(() => { renderCatalogue(); renderControls(); });
      });
      return h('label', { class: `cb-expert-opt${on ? ' is-on' : ''}`, for: `cb-x-${e.id}` }, cb,
        h('span', { class: 'cb-opt-text' }, h('span', { class: 'cb-opt-name' }, e.name), h('span', { class: 'cb-opt-domain' }, e.domain)));
    }));
    if (!shown.length) catalogueBox.append(h('p', { class: 'cb-empty' }, list.length ? '검색과 맞는 역할이 없습니다.' : S.mode === 'live' ? '서버 카탈로그가 비어 있어 실제 실행을 할 수 없습니다.' : '역할이 없습니다.'));
    catalogueNote.textContent = catalogueIsBuiltin() ? '서버 카탈로그가 비어 있거나 응답하지 않아 데모 전용 내장 역할 6개를 씁니다.'
      : `${list.length}개 역할 카탈로그${list.length > shown.length ? ` · ${shown.length}개 표시` : ''} · 3–5명을 권장합니다.`;
  }

  function statusDot(s: ExpertStatus): HTMLElement { return h('span', { class: `cb-dot s-${s}`, 'aria-hidden': 'true' }); }
  function ago(at: number): string {
    if (!at) return '';
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? `${s}초 전` : `${Math.round(s / 60)}분 전`;
  }

  function renderWork(): void {
    const p = S.run?.project;
    if (!S.run) { progress.replaceChildren(); cards.replaceChildren(h('p', { class: 'cb-empty' }, '프로젝트를 시작하면 전문가별 작업공간이 여기에 나타납니다.')); detail.replaceChildren(); return; }
    if (!p) {
      progress.replaceChildren(h('span', { class: 'cb-help' }, S.run.phase === 'error' ? '시작하지 못했습니다' : '프로젝트를 만드는 중…'));
      cards.replaceChildren(h('p', { class: S.run.phase === 'error' ? 'cb-warn' : 'cb-empty' }, S.run.phase === 'error' ? S.run.error : '서버가 전문가 작업공간을 준비하고 있습니다.'));
      detail.replaceChildren(); return;
    }
    const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
    const bar = h('div', { class: 'cb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.experts.length, 'aria-valuenow': done, 'aria-label': '전문가 진행' },
      ...p.experts.map(e => h('span', { class: `cb-bar-seg s-${e.status}`, title: `${e.name}: ${STATUS_LABEL[e.status]}` })));
    progress.replaceChildren(h('span', { class: `cb-pstatus p-${p.status}` }, PROJECT_STATUS_LABEL[p.status]), bar,
      h('span', { class: 'cb-help' }, `${done} / ${p.experts.length} 종료`));
    if (!S.focusExpert || !p.experts.some(e => e.id === S.focusExpert)) S.focusExpert = p.experts[0]?.id ?? '';
    cards.replaceChildren(...p.experts.map(e => {
      const last = e.activity.slice(-3);
      const def = findDef(e.expertId);
      return h('button', { type: 'button', class: `cb-card s-${e.status}${e.id === S.focusExpert ? ' is-focus' : ''}`, 'data-fk': `card:${e.id}`,
        'aria-pressed': String(e.id === S.focusExpert), onclick: () => { S.focusExpert = e.id; keepFocus(renderWork); } },
        h('span', { class: 'cb-card-head' }, statusDot(e.status), h('span', { class: 'cb-card-name' }, e.name), h('span', { class: 'cb-card-status' }, STATUS_LABEL[e.status])),
        h('span', { class: 'cb-card-meta' }, `${def?.domain ?? ''}${def ? ' · ' : ''}${e.sandboxId ? (S.run!.mode === 'demo' ? `데모 작업공간 ${e.sandboxId}` : `샌드박스 ${e.sandboxId}`) : '작업공간 대기'}`),
        h('span', { class: 'cb-card-log' }, ...(last.length ? last.map(a => h('span', { class: `cb-log k-${a.kind}` }, a.message)) : [h('span', { class: 'cb-log' }, '대기 중')])),
        h('span', { class: 'cb-card-foot' }, `파일 ${e.artifacts.length}개`,
          e.opinion ? h('span', { class: `cb-chip d-${e.opinion.direction}` }, `${DIRECTION_LABEL[e.opinion.direction]} ${e.opinion.confidence}%`) : null,
          e.invalidOpinion ? h('span', { class: 'cb-chip d-invalid' }, '형식 오류') : null));
    }));
    renderDetail(p);
  }

  function renderDetail(p: ConsoleProject): void {
    const e = p.experts.find(x => x.id === S.focusExpert);
    if (!e) { detail.replaceChildren(); return; }
    const def = findDef(e.expertId);
    const tabs: Array<[typeof S.tab, string]> = [['activity', '활동'], ['artifacts', `파일 ${e.artifacts.length}`], ['workorder', '작업 지시서'], ['persona', '페르소나']];
    const tabBtns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: `cb-tab-${k}`, 'data-fk': `tab:${k}`, 'aria-selected': String(S.tab === k),
      'aria-controls': 'cb-tabpanel', tabindex: S.tab === k ? '0' : '-1', class: 'cb-tab', onclick: () => { S.tab = k; keepFocus(renderWork); } }, label));
    const tablist = h('div', { class: 'cb-tabs', role: 'tablist', 'aria-label': `${e.name} 작업공간` }, ...tabBtns);
    tablist.addEventListener('keydown', ev => {
      const k = (ev as KeyboardEvent).key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
      ev.preventDefault();
      const i = tabs.findIndex(([t]) => t === S.tab);
      const n = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      S.tab = tabs[n][0]; renderWork();
      (root!.querySelector(`#cb-tab-${S.tab}`) as HTMLElement | null)?.focus();
    });
    let body: Node;
    if (S.tab === 'activity') {
      body = e.activity.length ? h('ol', { class: 'cb-activity' }, ...e.activity.slice().reverse().map(a =>
        h('li', { class: `k-${a.kind}` }, h('span', { class: 'cb-act-kind' }, { status: '상태', thought: '판단', tool: '도구', artifact: '파일', error: '오류' }[a.kind]),
          h('span', { class: 'cb-act-msg' }, a.message), h('time', { class: 'cb-act-at' }, ago(a.at)))))
        : h('p', { class: 'cb-empty' }, '아직 활동이 없습니다.');
      if (e.error) body = h('div', null, h('p', { class: 'cb-warn' }, `오류: ${e.error}`), body);
    } else if (S.tab === 'artifacts') {
      body = artifactView(p, e);
    } else if (S.tab === 'workorder') {
      const wo = e.artifacts.find(a => a.path === 'WORKORDER.md' && typeof a.content === 'string');
      body = h('div', null, !wo ? h('p', { class: 'cb-help' }, '작업공간이 아직 작업 지시서를 내보내지 않아 브리프로 만든 미리보기를 보여 줍니다.') : null,
        h('pre', { class: 'cb-file' }, wo?.content ?? (def ? workorderText(def, p.brief) : '역할 정의를 찾을 수 없습니다.')));
    } else {
      body = def ? h('div', null, h('pre', { class: 'cb-file' }, personaText(def))) : h('p', { class: 'cb-empty' }, '카탈로그에서 이 역할을 찾을 수 없습니다.');
    }
    const op = e.opinion;
    fill(detail,
      h('div', { class: 'cb-detail-head' }, statusDot(e.status), h('h3', null, e.name), h('span', { class: 'cb-help' }, def?.summary ?? '')),
      op ? h('div', { class: `cb-opinion d-${op.direction}` }, h('span', { class: `cb-chip d-${op.direction}` }, `${DIRECTION_LABEL[op.direction]} · 자체 평가 ${op.confidence}%`),
        h('p', null, op.summary)) : null,
      tablist, h('div', { id: 'cb-tabpanel', role: 'tabpanel', 'aria-labelledby': `cb-tab-${S.tab}`, class: 'cb-tabpanel' }, body));
  }

  function artifactView(p: ConsoleProject, e: ConsoleExpert): Node {
    if (!e.artifacts.length) return h('p', { class: 'cb-empty' }, '아직 만든 파일이 없습니다.');
    if (!e.artifacts.some(a => a.path === S.artifactPath)) S.artifactPath = (e.artifacts.find(a => a.path === 'out/report.md') ?? e.artifacts.find(a => a.path.startsWith('out/')) ?? e.artifacts[0]).path;
    const a = e.artifacts.find(x => x.path === S.artifactPath)!;
    const list = h('ul', { class: 'cb-files' }, ...e.artifacts.map(x => h('li', null, h('button', { type: 'button', class: `cb-filebtn${x.path === a.path ? ' is-on' : ''}`,
      'data-fk': `file:${x.path}`, 'aria-pressed': String(x.path === a.path), onclick: () => { S.artifactPath = x.path; keepFocus(renderWork); } },
      h('span', { class: 'cb-file-path' }, x.path), h('span', { class: 'cb-help' }, x.label)))));
    let view: Node;
    if (typeof a.content === 'string') view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': `${a.path} 내용` }, a.content || '(빈 파일)');
    else if (S.run?.mode === 'live' && S.run.accessToken) {
      const key = `${p.id}\n${e.expertId}\n${a.path}`;
      const c = S.artifactCache.get(key);
      if (!c) { fetchArtifact(p.id, e.expertId, a.path, key); view = h('p', { class: 'cb-help' }, '파일을 불러오는 중…'); }
      else if (c.state === 'loading') view = h('p', { class: 'cb-help' }, '파일을 불러오는 중…');
      else if (c.state === 'error') view = h('div', null, h('p', { class: 'cb-warn' }, c.text),
        h('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.artifactCache.delete(key); renderWork(); } }, '다시 불러오기'));
      else view = h('pre', { class: 'cb-file', tabindex: '0' }, c.text || '(빈 파일)');
    } else view = h('p', { class: 'cb-empty' }, '이 파일은 내용을 함께 보내지 않았습니다.');
    return h('div', { class: 'cb-artifacts' }, list, view);
  }

  function renderSynth(): void {
    const p = S.run?.project;
    if (!p) { synth.replaceChildren(h('p', { class: 'cb-empty' }, S.run ? '프로젝트가 만들어지면 완료된 의견을 종합합니다.' : '아직 실행한 프로젝트가 없습니다.')); return; }
    const a = aggregate(p);
    const total = a.valid || 1;
    const segs = DIRECTIONS.filter(d => a.counts[d] > 0).map(d => {
      const s = h('span', { class: `cb-dist-seg d-${d}` }, `${Math.round(a.counts[d] / total * 100)}%`);
      s.style.flexGrow = String(a.counts[d]);
      return s;
    });
    const maxB = Math.max(1, ...a.buckets);
    fill(synth,
      h('div', { class: 'cb-tally' }, h('span', { class: 'cb-big' }, String(a.valid)), h('span', null, ` / ${a.selected} 유효 의견`)),
      h('p', { class: 'cb-counts' }, `실패 ${a.failed} · 대기·진행 ${a.pending} · 취소 ${a.cancelled}${a.invalid ? ` · 형식 오류 ${a.invalid}` : ''} — 완료된 유효 의견만 종합합니다.`),
      a.valid ? h('div', { class: 'cb-dist', role: 'img', 'aria-label': DIRECTIONS.map(d => `${DIRECTION_LABEL[d]} ${a.counts[d]}`).join(', ') }, ...segs) : null,
      h('ul', { class: 'cb-legend' }, ...DIRECTIONS.map(d => h('li', null, h('span', { class: `cb-sw d-${d}`, 'aria-hidden': 'true' }), `${DIRECTION_LABEL[d]} `, h('strong', null, String(a.counts[d]))))),
      h('div', { class: 'cb-recommend' }, h('h3', null, '종합 제안'), h('p', { class: 'cb-headline' }, a.headline),
        a.actions.length ? h('ol', { class: 'cb-actions-list' }, ...a.actions.map(x => h('li', null, h('span', null, x.text),
          h('span', { class: 'cb-help' }, `${x.names.join(', ')}${x.count > 1 ? ` · ${x.count}명 공통` : ''}`)))) : null),
      a.disagreement ? h('div', { class: 'cb-dispute' }, h('h3', null, '이견'),
        ...a.supportVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-support' }, h('span', { class: 'cb-chip d-support' }, `지지 · ${v.name} ${v.confidence}%`), h('p', null, v.summary))),
        ...a.concernVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-concern' }, h('span', { class: 'cb-chip d-concern' }, `우려 · ${v.name} ${v.confidence}%`), h('p', null, v.summary))))
        : a.valid > 1 ? h('p', { class: 'cb-help' }, '지지와 우려가 동시에 나온 쟁점은 아직 없습니다.') : null,
      h('div', { class: 'cb-conf' }, h('h3', null, '자체 평가 확신도'),
        h('p', { class: 'cb-help' }, a.meanConfidence === null ? '완료된 유효 의견이 없습니다.' : `평균 ${a.meanConfidence}% · 각 역할의 자체 평가이며 보정된 정확도가 아닙니다.`),
        h('div', { class: 'cb-hist', role: 'img', 'aria-label': `확신도 분포 ${a.buckets.map((n, i) => `${i * 20}–${i * 20 + 20}%: ${n}`).join(', ')}` },
          ...a.buckets.map((n, i) => { const col = h('span', { class: 'cb-hist-col' }, h('span', { class: 'cb-hist-n' }, n ? String(n) : ''));
            const fill = h('span', { class: 'cb-hist-bar' }); fill.style.height = `${Math.round(n / maxB * 100)}%`; col.append(fill, h('span', { class: 'cb-hist-x' }, i === 4 ? '80–100' : `${i * 20}–${i * 20 + 19}`)); return col; }))));
    const phrase = `${PROJECT_STATUS_LABEL[p.status]}: 유효 의견 ${a.valid}, 실패 ${a.failed}`;
    if (TERMINAL_PROJECT.includes(p.status) && phrase !== lastAnnounce) { lastAnnounce = phrase; live.textContent = phrase; }
  }

  // ── 동작
  function setMode(m: Mode): void {
    if (active() || S.mode === m) return;
    S.mode = m; S.formErrors = [];
    const ids = new Set(catalogue().map(e => e.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
    if (!S.selected.size && m === 'demo') defaultSelection();
    renderAll();
  }

  function defaultSelection(): void {
    const list = catalogue();
    const want: Archetype[] = ['strategy', 'business', 'trust', 'ux'];
    for (const a of want) { const e = list.find(x => archetypeOf(x) === a && !S.selected.has(x.id)); if (e) S.selected.add(e.id); }
    for (const e of list) { if (S.selected.size >= 4) break; S.selected.add(e.id); }
  }

  function clearTimers(): void { for (const t of timers) clearTimeout(t); timers = []; clearTimeout(pollTimer); pollTimer = 0; }

  function startRun(): void {
    if (active()) return;
    const f: FormInput = { title: titleIn.value.trim(), objective: objectiveIn.value.trim(), context: contextIn.value.trim(), expertIds: [...S.selected] };
    S.formErrors = validateForm(f, limits());
    if (S.mode === 'live') {
      if (!S.boot.data?.configuration.liveReady) S.formErrors.push('서버가 실제 실행 준비가 되지 않았습니다.');
      if (!S.adminToken.trim()) S.formErrors.push('관리자 토큰을 입력하세요.');
    }
    if (S.formErrors.length) { renderControls(); return; }
    clearTimers();
    const gen = ++S.gen;
    const brief: ProjectBrief = { ...f, mode: S.mode, requestId: crypto.randomUUID() };
    S.artifactCache.clear(); S.focusExpert = ''; S.artifactPath = ''; lastAnnounce = '';
    S.run = { mode: S.mode, phase: 'starting', project: null, accessToken: '', error: '', startedAt: Date.now(), pollErrors: 0 };
    if (S.mode === 'demo') startDemo(gen, brief); else void startLive(gen, brief);
    renderAll();
  }

  function startDemo(gen: number, brief: ProjectBrief): void {
    const defs = brief.expertIds.map(id => findDef(id)).filter((e): e is ExpertDefinition => !!e);
    const failIndex = S.failSim ? defs.length - 1 : -1;
    const plan = demoPlan(brief, defs, failIndex, Date.now());
    S.run!.project = plan.project; S.run!.phase = 'running';
    for (const step of plan.steps) {
      timers.push(setTimeout(() => {
        if (gen !== S.gen || !S.run?.project || S.run.phase !== 'running') return;
        S.run.project = applyStep(S.run.project, step, Date.now());
        if (TERMINAL_PROJECT.includes(S.run.project.status)) { S.run.phase = 'done'; timers = []; }
        renderAll();
      }, step.at) as unknown as number);
    }
  }

  async function errorText(res: Response): Promise<string> {
    let server = '';
    try { const j = await res.json(); if (isObj(j)) server = str(j.error, 200); } catch { /* 본문 없음 */ }
    const base = res.status === 401 || res.status === 403 ? '관리자 또는 프로젝트 권한이 없거나 만료되었습니다. 토큰을 다시 확인하세요.'
      : res.status === 404 ? '프로젝트를 찾을 수 없습니다.'
        : res.status === 409 ? '같은 요청이 이미 처리 중입니다.'
          : res.status === 413 ? '입력이 너무 깁니다. 목표나 맥락을 줄이세요.'
            : res.status === 429 ? '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.'
              : res.status === 503 ? '서버 실행 설정이 준비되지 않았습니다.'
                : `서버 오류 (HTTP ${res.status})`;
    return server ? `${base} — ${server}` : base;
  }

  async function startLive(gen: number, brief: ProjectBrief): Promise<void> {
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/projects', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-admin-token': S.adminToken.trim() }, body: JSON.stringify(brief) });
    } catch {
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 실행하세요. (데모로 바꾸지 않았습니다)'; renderAll(); return;
    }
    if (gen !== S.gen) return;
    if (!res.ok) { const msg = await errorText(res); if (gen !== S.gen) return; S.run!.phase = 'error'; S.run!.error = msg; renderAll(); return; }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen) return;
    const project = isObj(body) ? normalizeProject(body.project) : null;
    const token = isObj(body) ? str(body.accessToken, 2000) : '';
    if (!project || !token) { S.run!.phase = 'error'; S.run!.error = '서버 응답 형식이 올바르지 않습니다.'; renderAll(); return; }
    S.run!.project = project; S.run!.accessToken = token;
    S.run!.phase = TERMINAL_PROJECT.includes(project.status) ? 'done' : 'running';
    if (S.run!.phase === 'running') schedulePoll(gen, 1200);
    renderAll();
  }

  function schedulePoll(gen: number, ms: number): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void poll(gen); }, ms) as unknown as number;
  }

  async function poll(gen: number): Promise<void> {
    const run = S.run;
    if (gen !== S.gen || !run?.project || run.phase !== 'running') return;
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(run.project.id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${run.accessToken}` } });
    } catch {
      if (gen !== S.gen) return;
      return pollFailed(gen, '서버 연결이 끊겼습니다.');
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const msg = await errorText(res);
      if (gen !== S.gen) return;
      if (res.status === 401 || res.status === 403 || res.status === 404) { run.phase = 'error'; run.error = msg; renderAll(); return; }
      return pollFailed(gen, msg);
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 형식 오류 */ }
    if (gen !== S.gen) return;
    const p = normalizeProject(body);
    if (!p || p.id !== run.project.id) return pollFailed(gen, '서버 응답 형식이 올바르지 않습니다.');
    run.pollErrors = 0; run.error = '';
    if (p.updatedAt >= run.project.updatedAt) run.project = p; // 늦게 도착한 옛 상태는 버린다
    if (TERMINAL_PROJECT.includes(run.project.status)) run.phase = 'done'; else schedulePoll(gen, 2000);
    renderAll();
  }

  function pollFailed(gen: number, msg: string): void {
    const run = S.run!;
    run.pollErrors++;
    if (run.pollErrors >= 4) { run.phase = 'error'; run.error = `${msg} 상태 확인을 멈췄습니다.`; renderAll(); appendRetry(gen); return; }
    run.error = `${msg} 다시 확인하는 중… (${run.pollErrors}/3)`;
    renderControls();
    schedulePoll(gen, 1500 * 2 ** run.pollErrors);
  }

  function appendRetry(gen: number): void {
    formMsg.append(h('button', { type: 'button', class: 'cb-ghost', onclick: () => {
      if (gen !== S.gen || !S.run?.project) return;
      S.run.phase = 'running'; S.run.error = ''; S.run.pollErrors = 0; renderAll(); void poll(gen);
    } }, '상태 다시 확인'));
  }

  async function cancelRun(): Promise<void> {
    const run = S.run;
    if (!run || !active() || run.phase === 'cancelling' || run.phase === 'starting') return;
    const gen = ++S.gen; // 진행 중이던 타이머·조회 응답은 이제 전부 무시된다
    clearTimers();
    if (run.mode === 'demo') {
      if (run.project) run.project = cancelProject(run.project, Date.now());
      run.phase = 'done'; renderAll(); return;
    }
    run.phase = 'cancelling'; run.error = ''; renderAll();
    const id = run.project?.id;
    if (!id) { run.phase = 'done'; renderAll(); return; }
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: `Bearer ${run.accessToken}` } });
      if (gen !== S.gen) return;
      if (!res.ok) { const msg = await errorText(res); if (gen !== S.gen) return; run.phase = 'error'; run.error = `취소하지 못했습니다: ${msg}`; renderAll(); return; }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 형식 오류 */ }
      if (gen !== S.gen) return;
      const p = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
      if (p && p.id === id) run.project = p;
      else if (run.project) run.project = { ...run.project, status: 'cancelled' };
      run.phase = 'done';
    } catch {
      if (gen !== S.gen) return;
      run.phase = 'error'; run.error = '취소 요청을 보내지 못했습니다. 다시 시도하세요.';
    }
    renderAll();
  }

  async function fetchArtifact(projectId: string, expertId: string, path: string, key: string): Promise<void> {
    const gen = S.gen, token = S.run?.accessToken ?? '';
    S.artifactCache.set(key, { state: 'loading', text: '' });
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(projectId)}/artifact?expert=${encodeURIComponent(expertId)}&path=${encodeURIComponent(path)}`,
        { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
      const text = res.ok ? clip(await res.text(), 200_000) : await errorText(res);
      if (gen !== S.gen) return;
      S.artifactCache.set(key, { state: res.ok ? 'ok' : 'error', text });
    } catch {
      if (gen !== S.gen) return;
      S.artifactCache.set(key, { state: 'error', text: '파일을 불러오지 못했습니다.' });
    }
    keepFocus(renderWork);
  }

  function download(kind: 'json' | 'md'): void {
    const p = S.run?.project;
    if (!p) return;
    const demo = S.run!.mode === 'demo';
    const text = kind === 'json'
      ? JSON.stringify({ kind: demo ? 'cloudbite-browser-demo' : 'cloudbite-live', note: demo ? '브라우저 시뮬레이션 — 실제 샌드박스·추론 아님' : '확신도는 자체 평가이며 보정된 정확도가 아님', project: p, aggregate: aggregate(p) }, null, 2)
      : markdownReport(p, demo);
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'json' ? 'application/json' : 'text/markdown' }));
    const safe = p.brief.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'cloudbite';
    const a = h('a', { href: url, download: `${safe}${demo ? '-demo' : ''}.${kind === 'json' ? 'json' : 'md'}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadBootstrap(): Promise<void> {
    S.boot = { status: 'loading', data: null, error: '' }; renderControls();
    try {
      const res = await fetch('/api/cloudbite/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      S.boot = { status: 'ready', data: normalizeBootstrap(await res.json()), error: '' };
    } catch (e) {
      S.boot = { status: 'error', data: null, error: e instanceof Error ? clip(e.message, 200) : '알 수 없는 오류' };
    }
    // 실행 중인 프로젝트는 그대로 둔다. 선택만 지금 카탈로그에 있는 역할로 맞추고, 아직 시작 전이면 기본 선택을 다시 잡는다
    if (!S.run) S.selected.clear();
    const ids = new Set(catalogue().map(e => e.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
    if (!S.selected.size && S.mode === 'demo') defaultSelection();
    renderAll();
  }

  // 첫 화면부터 전문가가 각자 작업공간에서 일하는 모습을 보인다: 내장 예시 브리프로 데모를 바로 시작한다 (명시적 데모 표시)
  defaultSelection();
  renderAll();
  // 카탈로그를 잠깐(최대 1.5초) 기다렸다가 시작한다. 늦으면 내장 데모 역할로 먼저 시작한다
  void Promise.race([loadBootstrap(), new Promise(r => setTimeout(r, 1500))]).then(() => { if (!S.run && S.mode === 'demo') startRun(); });
  setInterval(() => { if (S.run?.project && active()) keepFocus(renderWork); }, 5000);
}

const CloudbiteCore = { normalizeBootstrap, normalizeProject, normalizeOpinion, aggregate, validateForm, demoPlan, applyStep, cancelProject, statusFromExperts, markdownReport, archetypeOf, DEMO_EXPERTS };
const hook = (globalThis as { __cloudbiteTestHook?: (core: typeof CloudbiteCore) => void }).__cloudbiteTestHook;
if (typeof hook === 'function') hook(CloudbiteCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
