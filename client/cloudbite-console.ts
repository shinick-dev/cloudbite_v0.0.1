// Cloudbite 프로젝트 콘솔 (브라우저). tools/build-cloudbite-console.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-page.ts 의
// CLOUDBITE_JS 로 고정한다. 같은 출처 외부 스크립트로 내려가며, 화면은 전부 textContent·createElement 로만 그린다.
// 데모는 브라우저 안 시뮬레이션이다 — 실제 Daytona 샌드박스나 Nosana 추론을 만들지 않으며 화면에서 그렇게 밝힌다.
// 실제 실행은 서버 준비 상태와 기존 관리자 토큰(메모리에만)을 요구하고, 실패해도 데모로 몰래 바꾸지 않는다.
// 화면 문구는 영어다 (2026-10-18 사용자 요청). 서버·모델이 돌려준 내용은 받은 그대로 보여 주고 번역하지 않는다.
import type {
  CloudbiteBootstrap, ExpertActivity, ExpertArtifact, ExpertDefinition, ExpertOpinion, ExpertRun, ExpertStatus,
  OpinionDirection, ProjectBrief, ProjectRun, ProjectStatus,
} from '../src/cloudbite-contract';

type Mode = 'demo' | 'live';
type View = 'home' | 'guide' | 'help' | 'settings';
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
const DIRECTION_LABEL: Record<OpinionDirection, string> = { support: 'Support', conditional: 'Conditional', concern: 'Concern', abstain: 'Abstain' };
const STATUS_LABEL: Record<ExpertStatus, string> = {
  queued: 'Queued', provisioning: 'Preparing sandbox', running: 'Working', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft', running: 'Running', completed: 'Completed', partial: 'Partially complete', failed: 'Failed', cancelled: 'Cancelled',
};
const KIND_LABEL: Record<ExpertActivity['kind'], string> = { status: 'status', thought: 'note', tool: 'tool', artifact: 'file', error: 'error' };
const EXPERT_STATUSES = Object.keys(STATUS_LABEL) as ExpertStatus[];
const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[];
const ACTIVITY_KINDS: ExpertActivity['kind'][] = ['status', 'thought', 'tool', 'artifact', 'error'];
const TERMINAL_EXPERT: ExpertStatus[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_PROJECT: ProjectStatus[] = ['completed', 'partial', 'failed', 'cancelled'];
const LIMIT = { title: 120, objective: 1500, context: 3000 };
const STREAM_ROWS = 400;

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
function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

// 임시 Cloudbite 운영자 토큰 (docs/cloudbite/temporary-operator.txt): 서버(src/cloudbite-operator.ts)와 같은 모양만 받는다
const OPERATOR_TOKEN = /^cbo_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isOperatorToken = (t: string) => t.trim().startsWith('cbo_');
/** `#operator=<token>` 조각을 읽는다. present = 운영자 자격처럼 보이는 조각이 있다 (형식이 틀려도 지워야 한다) */
function operatorFragment(hash: string): { present: boolean; token: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('&');
  const hit = parts.find(p => p === 'operator' || p.startsWith('operator='));
  const value = hit === undefined ? null : hit.slice('operator='.length);
  return { present: hit !== undefined || raw.includes('cbo_'), token: value !== null && OPERATOR_TOKEN.test(value) ? value : '' };
}
/** 운영자 조각을 메모리로 옮기고, 어떤 요청보다 먼저 주소창·현재 기록 항목에서 지운다. location·history 가 없으면 조용히 넘어간다 */
function takeOperatorLink(): { present: boolean; token: string } {
  const g = globalThis as { location?: Location; history?: History };
  const loc = g.location;
  const found = operatorFragment(loc && typeof loc.hash === 'string' ? loc.hash : '');
  if (!found.present || !loc) return found;
  const clean = `${loc.pathname ?? ''}${loc.search ?? ''}`;
  try {
    if (g.history && typeof g.history.replaceState === 'function') { g.history.replaceState(g.history.state, '', clean); return found; }
  } catch { /* 아래 대안으로 */ }
  try { if (typeof loc.replace === 'function') loc.replace(`${clean}#`); } catch { /* 지울 방법이 없다 */ }
  return found;
}

function normalizeExpertDef(raw: unknown): ExpertDefinition | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 80), name = str(raw.name, 80);
  if (!id || !name) return null;
  const src = isObj(raw.source) ? raw.source : {};
  return {
    id, name, domain: str(raw.domain, 80, 'General'), summary: str(raw.summary, 400), prompt: str(raw.prompt, 6000),
    tools: strList(raw.tools, 80, 20), outputs: strList(raw.outputs, 120, 20),
    source: {
      repository: str(src.repository, 200), path: str(src.path, 200), revision: str(src.revision, 80),
      license: str(src.license, 80), basis: 'metadata-derived',
    },
  };
}

function normalizeBootstrap(raw: unknown): CloudbiteBootstrap {
  if (!isObj(raw) || !Array.isArray(raw.experts) || !isObj(raw.configuration)) throw new Error('The catalogue response has an invalid format');
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
  if (!EXPERT_STATUSES.includes(status)) { status = 'failed'; error = 'The server sent an unknown status'; }
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
    id, expertId, name: str(raw.name, 80, `Expert ${i + 1}`), status, activity, artifacts, updatedAt: num(raw.updatedAt) ?? 0,
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
  if (!f.title.trim()) errors.push('Enter a project name.');
  if (f.title.length > LIMIT.title) errors.push(`The project name must be ${LIMIT.title} characters or fewer.`);
  if (!f.objective.trim()) errors.push('Enter an objective.');
  if (f.objective.length > LIMIT.objective) errors.push(`The objective must be ${LIMIT.objective} characters or fewer.`);
  if (f.context.length > LIMIT.context) errors.push(`The context must be ${LIMIT.context} characters or fewer.`);
  if (f.expertIds.length < limits.min) errors.push(`Select at least ${plural(limits.min, 'expert')}.`);
  if (f.expertIds.length > limits.max) errors.push(`You can select up to ${plural(limits.max, 'expert')}.`);
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
  let headline = 'No completed opinions to synthesise yet.';
  if (valid > 0 && leading) {
    const base = tie ? 'Opinions are evenly split — narrow down the disputed points before deciding.'
      : leading === 'support' ? 'Most opinions favour going ahead — you can move straight to the suggested next actions.'
        : leading === 'conditional' ? 'Most opinions say: set the conditions first and start small.'
          : leading === 'concern' ? 'Concerns dominate — do not expand until the key risks are resolved.'
            : 'Many experts abstained — more information is needed.';
    headline = valid < p.experts.length ? `${base} (based on ${valid} of ${p.experts.length} selected experts)` : base;
  }
  return {
    selected: p.experts.length, completed, valid, invalid, failed, pending, cancelled, counts,
    meanConfidence: valid ? Math.round(confSum / valid) : null, buckets, leading: tie ? null : leading, disagreement,
    supportVoices: supportVoices.slice(0, 2), concernVoices: concernVoices.slice(0, 2), actions, headline,
  };
}

// ───────────────────────── 브라우저 데모 (시뮬레이션) ─────────────────────────

const DEMO_SOURCE = { repository: 'cloudbite built-in demo', path: 'client/cloudbite-console.ts', revision: 'demo', license: 'demo', basis: 'metadata-derived' as const };
const DEMO_EXPERTS: ExpertDefinition[] = [
  ['demo-product-strategist', 'Product Strategist', 'Product strategy', 'Judges launch scope, phasing and differentiation against alternatives.'],
  ['demo-business-model', 'Business Model Expert', 'Business & finance', 'Reviews pricing, unit economics and how inference costs are recovered.'],
  ['demo-ai-trust', 'AI Ethics & Trust Expert', 'AI trust', 'Checks evidence labelling, liability limits and safeguards for high-risk domains.'],
  ['demo-data-validation', 'Data Validation Expert', 'Data quality', 'Examines source quality and whether the evidence behind opinions can be verified.'],
  ['demo-ux-research', 'UX Researcher', 'User experience', 'Looks at the first-use flow, clarity and time to user value.'],
  ['demo-security-compliance', 'Security & Compliance Expert', 'Security & regulation', 'Reviews data handling, access control and regulatory requirements.'],
].map(([id, name, domain, summary]) => ({
  id, name, domain, summary,
  prompt: `You are "${name}", an AI role in the Cloudbite demo. You are not a real person and your output is not an endorsement. ${summary} Read the shared project documents and write your role's recommendation, evidence, assumptions, self-assessed confidence and next actions to out/result.json.`,
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
function quote(s: string, n = 48): string { const t = s.replace(/\s+/g, ' ').trim(); return t ? `“${clip(t, n)}”` : '“(empty)”'; }

interface DemoWork { steps: Array<[ExpertActivity['kind'], string]>; notes: string; opinion: ExpertOpinion }
function demoWork(e: ExpertDefinition, b: ProjectBrief, h: number): DemoWork {
  // 키워드는 영어·한국어 둘 다 본다 (브리프를 어느 언어로 써도 결정적으로 반응)
  const all = `${b.title}\n${b.objective}\n${b.context}`.toLowerCase();
  const jitter = (base: number, span: number) => base + (h % span);
  const ctx = b.context.trim() ? quote(b.context) : 'no context given';
  const obj = quote(b.objective);
  let direction: OpinionDirection, confidence: number, summary: string;
  let steps: DemoWork['steps'], evidence: string[], assumptions: string[], nextActions: string[];
  switch (archetypeOf(e)) {
    case 'strategy': {
      const fast = has(all, ['2 weeks', '4 weeks', 'two weeks', 'four weeks', '2-week', '4-week', 'fast', 'quick', '2주', '4주', '빠르', '단기']);
      const wide = has(all, ['100', 'every', 'entire', 'all roles', '전체', '모든']);
      direction = fast || wide ? 'conditional' : 'support';
      confidence = jitter(fast && wide ? 70 : 64, 14);
      summary = fast && wide ? 'The timeline is short and the scope is wide. Launch in phases, narrowing to the core roles first.'
        : wide ? 'The scope is wide. Validate with the core roles first, then expand.'
          : 'Objective and scope fit together; this is ready to execute.';
      steps = [
        ['tool', `python scope_matrix.py — split objective ${obj} into feature, scope and schedule axes`],
        ['thought', wide ? 'Many roles widen quality variance in week one. Review the top 20 roles first' : 'Narrow scope keeps first-launch risk low'],
        ['tool', 'write_file out/notes.md — comparison table of three phased launch options'],
      ];
      evidence = [`Objective ${obj}`, fast ? 'The brief mentions a short timeline' : 'No schedule constraint is stated', wide ? 'The brief uses wide-scope wording' : 'The scope is narrowly defined'];
      assumptions = ['Assumes a single first user group', 'Feature-by-feature comparison with competitors is out of scope'];
      nextActions = ['Limit the first launch to 20 core roles', 'Set two-week launch checkpoints'];
      break;
    }
    case 'business': {
      const paid = has(all, ['paid', 'subscription', 'freemium', 'pricing', 'billing', '유료', '구독', '과금']);
      const free = has(all, ['free', '무료']) && !paid;
      direction = free ? 'concern' : paid ? 'support' : 'conditional';
      confidence = jitter(free ? 72 : paid ? 66 : 58, 12);
      summary = free ? 'A free-only model has no way to recover inference costs that grow with every expert.'
        : paid ? 'There is a paid conversion path; with usage limits in place the unit economics work.'
          : 'No revenue model is defined yet, so start with pricing experiments.';
      steps = [
        ['tool', 'python unit_economics.py --experts 5 --rounds 3 — estimate inference cost per opinion'],
        ['thought', free ? 'Cost per free user grows linearly with no cap' : paid ? 'With partial paid plans, the top 10% of users offset costs' : 'Three pricing hypotheses need comparing'],
        ['tool', 'write_file out/notes.md — break-even table per pricing scenario'],
      ];
      evidence = [free ? 'The brief mentions only a free model' : paid ? 'The brief mentions a paid conversion path' : 'No revenue model mentioned', `Context ${ctx}`];
      assumptions = ['About three inference rounds per expert', 'Model unit prices are demo assumptions, not real quotes'];
      nextActions = ['Set usage limits and a price ceiling first', 'Limit the first launch to 20 core roles'];
      break;
    }
    case 'trust': {
      const risky = has(all, ['medical', 'legal', 'investment', 'financial', 'diagnos', '의료', '법률', '투자', '금융', '진단']);
      const sourced = has(all, ['source', 'evidence', 'citation', 'verif', '출처', '근거', '검증']);
      direction = risky ? 'concern' : sourced ? 'conditional' : 'concern';
      confidence = jitter(risky ? 78 : 61, 12);
      summary = risky ? 'The advice touches high-risk domains. Do not publish without liability limits and human expert review.'
        : sourced ? 'The intent to cite evidence is there. Document source-quality criteria and you can proceed.'
          : 'There is no standard for citing evidence per opinion, so trust is hard to explain.';
      steps = [
        ['tool', 'read_file PROJECT.md — scan for high-risk domain keywords'],
        ['thought', risky ? 'High-risk domain wording found: disclaimer and human review required' : 'No high-risk domain wording; evidence labelling is the key issue'],
        ['tool', 'write_file out/notes.md — draft evidence-labelling checklist'],
      ];
      evidence = [risky ? 'The brief contains high-risk domain wording' : 'No high-risk domain wording', sourced ? 'Evidence or sources are mentioned' : 'No evidence or source standard mentioned'];
      assumptions = ['Assumes users are told AI role opinions are not real expert endorsements'];
      nextActions = ['Document an evidence and source labelling standard per opinion', risky ? 'Publish high-risk topics only after human expert review' : 'Show the AI-role disclosure on the first screen'];
      break;
    }
    case 'data': {
      const sourced = has(all, ['data', 'evidence', 'source', 'metric', '데이터', '근거', '출처', '지표']);
      direction = sourced ? 'support' : 'conditional';
      confidence = jitter(sourced ? 69 : 55, 15);
      summary = sourced ? 'The plan clearly intends to use evidence. Add an automated verification pipeline.'
        : 'The evidence behind opinions is not defined. Start with verifiable metrics.';
      steps = [
        ['tool', 'python claim_check.py PROJECT.md — count verifiable claims'],
        ['thought', sourced ? 'Verifiable claims exist, so sampling checks are possible' : 'No quantitative metric, so there is no baseline for comparison'],
        ['tool', 'write_file out/notes.md — metric definitions and sampling procedure'],
      ];
      evidence = [`Objective ${obj}`, sourced ? 'The brief mentions data or evidence' : 'No quantitative metric mentioned'];
      assumptions = ['Assumes an initial sample of 30 items is enough to check opinion quality'];
      nextActions = ['Document an evidence and source labelling standard per opinion', 'Check a weekly sample of 30 opinions'];
      break;
    }
    case 'ux': {
      const simple = has(all, ['simple', 'easy', 'beginner', 'first-time', 'onboarding', '간단', '쉽', '초보', '처음']);
      direction = simple ? 'support' : 'conditional';
      confidence = jitter(simple ? 67 : 60, 14);
      summary = simple ? 'Aiming for an easy first experience should get users to value quickly.'
        : 'The more experts, the harder results are to read. Use a summary-then-evidence structure.';
      steps = [
        ['tool', 'python flow_walkthrough.py — count steps from first question to understanding results'],
        ['thought', simple ? 'Three steps to the first result, good' : 'Comparing opinions on the results screen risks getting long'],
        ['tool', 'write_file out/notes.md — first-use flow storyboard'],
      ];
      evidence = [`Objective ${obj}`, simple ? 'The brief asks for an easy experience' : 'No usage-flow requirement mentioned'];
      assumptions = ['Assumes first-time users read the summary before raw opinions'];
      nextActions = ['Show the synthesis first and let users expand the evidence', 'Run usability tests with 5 early users'];
      break;
    }
    case 'security': {
      const sensitive = has(all, ['enterprise', 'personal data', 'customer data', 'b2b', 'internal', 'pii', '기업', '개인정보', '고객 데이터', '사내']);
      direction = sensitive ? 'concern' : 'conditional';
      confidence = jitter(sensitive ? 74 : 57, 12);
      summary = sensitive ? 'Customer data is copied into every expert workspace. Do not proceed without isolation and retention policies.'
        : 'No sensitive data is mentioned, but a retention period per workspace still has to be set.';
      steps = [
        ['tool', 'python data_flow.py — trace how the brief is copied into each workspace'],
        ['thought', sensitive ? 'Sensitive data wording found: exposure grows with the number of workspaces' : 'No sensitive data wording'],
        ['tool', 'write_file out/notes.md — draft data retention and deletion policy'],
      ];
      evidence = [sensitive ? 'The brief mentions enterprise or personal data' : 'No sensitive data wording', 'Workspaces are separated per expert'];
      assumptions = ['Assumes workspaces are deleted after the run ends'];
      nextActions = ['Confirm workspace data retention and deletion steps', sensitive ? 'Anonymise customer data before use' : 'Define an access-log retention policy'];
      break;
    }
    default: {
      const pick = h % 3;
      direction = (['support', 'conditional', 'concern'] as const)[pick];
      confidence = jitter(52, 25);
      summary = `${DIRECTION_LABEL[direction]} opinion from a ${e.domain} perspective. Reviewed the premises of objective ${obj} against the role's criteria.`;
      steps = [
        ['tool', `read_file PROJECT.md — extract issues from a ${e.domain} perspective`],
        ['thought', `List the largest uncertainty by ${e.domain} criteria`],
        ['tool', 'write_file out/notes.md — role review notes'],
      ];
      evidence = [`Objective ${obj}`, `Context ${ctx}`];
      assumptions = ['Role definition is based on catalogue metadata'];
      nextActions = [`Validate the key ${e.domain} assumptions`];
    }
  }
  confidence = Math.max(0, Math.min(100, confidence));
  const notes = [`# ${e.name} working notes (browser demo)`, '', `Project: ${b.title}`, `Objective: ${b.objective}`, '',
    '## Review steps', ...steps.map(([, m], i) => `${i + 1}. ${m}`), '', '## Evidence', ...evidence.map(x => `- ${x}`), '',
    '> This file is a simulation produced in the browser. No real sandbox or model inference was involved.'].join('\n');
  return { steps, notes, opinion: { direction, confidence, summary, evidence, assumptions, nextActions } };
}

function workorderText(e: ExpertDefinition, b: ProjectBrief): string {
  return [`# Work order — ${e.name}`, '', `Domain: ${e.domain}`, '', '## Shared project', `- Name: ${b.title}`, `- Objective: ${b.objective}`,
    `- Context: ${b.context || '(none)'}`, '', '## Role goal', e.summary || `Review the shared project from a ${e.domain} perspective.`, '',
    '## Output contract', '- out/result.json: direction(support|conditional|concern|abstain), confidence(0–100, self-assessed), summary, evidence[], assumptions[], nextActions[]',
    '- out/report.md: human-readable report', '', 'Confidence is a self-assessment, not calibrated accuracy.'].join('\n');
}

function personaText(e: ExpertDefinition): string {
  return [`# ${e.name}`, '', `Domain: ${e.domain}`, '', e.summary, '', '## Role instructions', e.prompt || '(no instructions in the catalogue)', '',
    `## Tools\n${e.tools.map(t => `- ${t}`).join('\n') || '- (none)'}`, '', `## Source\n${e.source.repository} · ${e.source.path} · ${e.source.revision} · ${e.source.license} (${e.source.basis})`,
    '', 'This is an AI role, not the opinion or endorsement of a real person.'].join('\n');
}

function reportText(e: ExpertDefinition, b: ProjectBrief, o: ExpertOpinion): string {
  return [`# ${e.name} report (browser demo)`, '', `Project: ${b.title}`, '', `## Recommendation: ${DIRECTION_LABEL[o.direction]} · self-assessed confidence ${o.confidence}%`, '', o.summary, '',
    '## Evidence', ...o.evidence.map(x => `- ${x}`), '', '## Assumptions', ...o.assumptions.map(x => `- ${x}`), '', '## Next actions', ...o.nextActions.map((x, i) => `${i + 1}. ${x}`), '',
    '> Simulated result. No real Daytona sandbox or Nosana inference was involved.'].join('\n');
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
      activity: { kind: 'status', message: 'Preparing demo workspace — browser simulation, not a real sandbox' },
      artifacts: [
        { path: 'PERSONA.md', label: 'Persona', content: personaText(e) },
        { path: 'PROJECT.md', label: 'Shared project', content: `# ${b.title}\n\n## Objective\n${b.objective}\n\n## Context\n${b.context || '(none)'}` },
        { path: 'WORKORDER.md', label: 'Work order', content: workorderText(e, b) },
      ] });
    t += 900 + (h % 500);
    steps.push({ at: t, expert: i, status: 'running', activity: { kind: 'tool', message: 'read_file WORKORDER.md — check role goal and output contract' } });
    w.steps.forEach(([kind, message], j) => {
      t += 1300 + ((h >>> (j * 4)) % 1100);
      steps.push({ at: t, expert: i, activity: { kind, message } });
      if (i === failIndex && j === 1) {
        t += 900;
        steps.push({ at: t, expert: i, status: 'failed', error: 'Demo: simulated an inference response timeout',
          activity: { kind: 'error', message: 'Inference response timed out (simulated) — this expert is excluded from the synthesis' } });
      }
    });
    if (i === failIndex) return;
    t += 700;
    steps.push({ at: t, expert: i, activity: { kind: 'artifact', message: 'Wrote out/notes.md' },
      artifacts: [{ path: 'out/notes.md', label: 'Working notes', content: w.notes }] });
    t += 1000 + (h % 600);
    steps.push({ at: t, expert: i, status: 'completed', opinion: w.opinion,
      activity: { kind: 'artifact', message: `Submitted out/result.json — ${DIRECTION_LABEL[w.opinion.direction]} · confidence ${w.opinion.confidence}%` },
      artifacts: [
        { path: 'out/result.json', label: 'Result JSON', content: JSON.stringify(w.opinion, null, 2) },
        { path: 'out/report.md', label: 'Report', content: reportText(e, b, w.opinion) },
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
    activity: [...e.activity, { id: `${e.id}-${e.activity.length}`, at: now, kind: 'status' as const, message: 'The user stopped the project' }],
  });
  return { ...p, experts, status: 'cancelled', updatedAt: now };
}

// ───────────────────────── 내보내기 ─────────────────────────

function markdownReport(p: ConsoleProject, demo: boolean): string {
  const a = aggregate(p);
  const lines = [`# ${p.brief.title}`, '', demo ? '> Browser demo simulation. No real Daytona sandbox or Nosana inference was involved.' : '> Live run result. Confidence is each AI role\'s self-assessment, not calibrated accuracy.', '',
    '## Objective', p.brief.objective, '', '## Context', p.brief.context || '(none)', '',
    '## Synthesis', `- Status: ${PROJECT_STATUS_LABEL[p.status]}`, `- Selected ${a.selected} · valid opinions ${a.valid} · failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled} · invalid format ${a.invalid}`,
    `- ${DIRECTIONS.map(d => `${DIRECTION_LABEL[d]} ${a.counts[d]}`).join(' · ')}`,
    `- Mean self-assessed confidence: ${a.meanConfidence === null ? '—' : a.meanConfidence + '%'}`, '', a.headline, '', '## Next actions',
    ...(a.actions.length ? a.actions.map((x, i) => `${i + 1}. ${x.text} (${x.names.join(', ')})`) : ['(none)']), '', '## Opinions by expert'];
  for (const e of p.experts) {
    lines.push('', `### ${e.name} — ${STATUS_LABEL[e.status]}`);
    if (e.opinion) lines.push(`${DIRECTION_LABEL[e.opinion.direction]} · confidence ${e.opinion.confidence}%`, '', e.opinion.summary);
    else if (e.error) lines.push(`Error: ${e.error}`);
    else if (e.invalidOpinion) lines.push('Excluded from the synthesis because the result format was invalid.');
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
/** CSS 마스크 아이콘 (cloudbite-console.css 의 .i-*) — 장식이므로 읽기 프로그램에서 숨긴다 */
function icon(name: string): HTMLElement { return h('span', { class: `cb-i i-${name}`, 'aria-hidden': 'true' }); }
function clock(at: number): string {
  if (!at) return '--:--:--';
  const d = new Date(at), p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function boot(): void {
  // 운영자 링크는 화면·요청보다 먼저 지운다. 링크가 있으면 실제 실행 모드로 열고 자동 데모·자동 실행은 하지 않는다
  const link = takeOperatorLink();
  const root = document.getElementById('cloudbite');
  if (!root) return;

  const S = {
    gen: 0,
    boot: { status: 'loading' as 'loading' | 'ready' | 'error', data: null as CloudbiteBootstrap | null, error: '' },
    mode: (link.present ? 'live' : 'demo') as Mode,
    adminToken: link.token,
    selected: new Set<string>(),
    failSim: false,
    run: null as null | {
      mode: Mode; phase: 'starting' | 'running' | 'cancelling' | 'done' | 'error'; project: ConsoleProject | null;
      accessToken: string; error: string; startedAt: number; pollErrors: number;
    },
    view: 'home' as View,
    setupOpen: link.present,
    full: false,
    /** "Clear view" 때 화면에서만 숨긴 실행 기록 줄. 프로젝트 기록·파일은 그대로 둔다 */
    hiddenRows: new Set<string>(),
    focusExpert: '',
    tab: 'artifacts' as 'persona' | 'workorder' | 'activity' | 'artifacts',
    artifactPath: '',
    /** 사용자가 파일을 직접 고르기 전에는 새 파일이 생기면 가장 쓸모 있는 파일(out/report.md 우선)로 따라간다 */
    artifactPicked: false,
    artifactCache: new Map<string, { state: 'loading' | 'ok' | 'error'; text: string }>(),
    formErrors: (link.present && !link.token ? ['The temporary Cloudbite operator link is malformed. It was removed from the address bar; ask the owner for a new link.'] : []) as string[],
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
  const titleIn = h('input', { id: 'cb-title', type: 'text', maxlength: LIMIT.title, autocomplete: 'off', value: 'Launch a 100-expert AI advisory room' });
  const objectiveIn = h('textarea', { id: 'cb-objective', rows: 3, maxlength: LIMIT.objective });
  objectiveIn.value = 'Decide whether launching a 100-expert AI advisory room for startup teams on a partially paid model within 4 weeks makes sense, and what to watch out for.';
  const contextIn = h('textarea', { id: 'cb-context', rows: 3, maxlength: LIMIT.context });
  contextIn.value = 'Early users are startup teams of 5–20 people. Every opinion should show its evidence and sources. Team data will not be uploaded.';
  const counter = (inp: HTMLInputElement | HTMLTextAreaElement, max: number) => {
    const c = h('span', { class: 'cb-count', 'aria-hidden': 'true' });
    const upd = () => { c.textContent = `${inp.value.length} / ${max}`; };
    inp.addEventListener('input', upd); upd();
    return c;
  };
  for (const inp of [titleIn, objectiveIn]) inp.addEventListener('input', () => { if (!S.run) renderControls(); });
  const tokenIn = h('input', { id: 'cb-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Existing admin session token' });
  tokenIn.value = S.adminToken;
  tokenIn.addEventListener('input', () => { S.adminToken = tokenIn.value; renderControls(); renderProgress(); });
  const failIn = h('input', { id: 'cb-fail', type: 'checkbox' });
  failIn.addEventListener('change', () => { S.failSim = failIn.checked; });
  const filterIn = h('input', { id: 'cb-filter', type: 'search', placeholder: 'Search roles or domains', autocomplete: 'off', 'aria-label': 'Search experts' });
  filterIn.addEventListener('input', () => renderCatalogue());

  const modeDemo = h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'true', onclick: () => setMode('demo') }, 'Browser demo');
  const modeLive = h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'false', onclick: () => setMode('live') }, 'Live run');
  const startBtn = h('button', { type: 'button', class: 'cb-primary', onclick: () => startRun() });
  const startLabel = h('span');
  startBtn.append(icon('play'), startLabel);
  const cancelBtn = h('button', { type: 'button', class: 'cb-secondary', onclick: () => cancelRun() });
  const cancelLabel = h('span');
  cancelBtn.append(icon('stop'), cancelLabel);
  const formMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const catalogueBox = h('div', { class: 'cb-catalogue', role: 'group', 'aria-labelledby': 'cb-cat-label' });
  const catalogueNote = h('p', { class: 'cb-help' });
  const selCount = h('span', { class: 'cb-selcount' });
  const liveStatus = h('div', { class: 'cb-live-status' });
  const clearTokenBtn = h('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.adminToken = ''; tokenIn.value = ''; renderControls(); tokenIn.focus(); } }, 'Clear token');
  const tokenLabel = h('label', { for: 'cb-token', class: 'cb-label' });
  const liveBox = h('div', { class: 'cb-live' }, liveStatus,
    tokenLabel, tokenIn,
    h('p', { class: 'cb-help' }, 'The token stays in this tab\'s memory only and is never stored. Daytona and Nosana API keys are configured on the server, never entered here.'), clearTokenBtn);
  const demoBox = h('div', { class: 'cb-demoopts' },
    h('label', { class: 'cb-check' }, failIn, ' Simulate one expert failing'));

  const modeLine = h('span');
  const form = h('form', { class: 'cb-form', novalidate: true, 'aria-label': 'Project setup' },
    h('div', { class: 'cb-field' }, h('label', { for: 'cb-title', class: 'cb-label' }, 'Project name'), titleIn, counter(titleIn, LIMIT.title)),
    h('div', { class: 'cb-field' }, h('label', { for: 'cb-context', class: 'cb-label' }, 'Context (optional)'), contextIn, counter(contextIn, LIMIT.context)),
    h('div', { class: 'cb-field is-wide' }, h('label', { for: 'cb-objective', class: 'cb-label' }, 'Objective — what should the experts decide or produce?'), objectiveIn, counter(objectiveIn, LIMIT.objective)),
    h('div', { class: 'cb-field is-wide' },
      h('div', { class: 'cb-label-row' }, h('span', { id: 'cb-cat-label', class: 'cb-label' }, 'Choose experts'), selCount),
      filterIn, catalogueBox, catalogueNote),
    h('div', { class: 'cb-mode-line' }, icon('settings'), modeLine,
      h('button', { type: 'button', class: 'cb-ghost', onclick: () => setView('settings') }, 'Change in Settings')));
  form.addEventListener('submit', ev => { ev.preventDefault(); startRun(); });

  // ── 머리 (네이비 70px)
  const modeBadge = h('span', { class: 'cb-badge' });
  const profileState = h('span', { class: 'cb-profile-state' });
  const banner = h('p', { class: 'cb-banner' });
  const live = h('div', { class: 'cb-sr', 'aria-live': 'polite' });

  // ── 현재 프로젝트 카드
  const projTitle = h('h2', { id: 'cb-project-h', class: 'cb-project-title' });
  const projObjective = h('p', { class: 'cb-project-obj' });
  const projStatus = h('span', { class: 'cb-pill' });
  const projMeta = h('div', { class: 'cb-project-meta' });
  const setupLabel = h('span');
  const setupBtn = h('button', { type: 'button', class: 'cb-ghost', 'aria-expanded': 'false', 'aria-controls': 'cb-setup', 'data-fk': 'setup',
    onclick: () => { S.setupOpen = !S.setupOpen; renderControls(); if (S.setupOpen && !active()) titleIn.focus(); } }, icon('edit'), setupLabel);
  const dlJson = h('button', { type: 'button', class: 'cb-ghost', onclick: () => download('json') }, icon('download'), h('span', null, 'Export JSON'));
  const dlMd = h('button', { type: 'button', class: 'cb-ghost', onclick: () => download('md') }, icon('download'), h('span', null, 'Export report'));
  const setup = h('div', { id: 'cb-setup', class: 'cb-setup' }, form);
  const projectCard = h('section', { class: 'cb-panel cb-project', 'aria-labelledby': 'cb-project-h' },
    h('div', { class: 'cb-project-top' },
      h('div', { class: 'cb-project-text' }, h('span', { class: 'cb-eyebrow' }, 'Current project'), projTitle, projObjective), projStatus),
    projMeta,
    h('div', { class: 'cb-project-actions' }, startBtn, cancelBtn, setupBtn, h('span', { class: 'cb-spacer' }), dlMd, dlJson),
    formMsg, setup);

  // ── 전문가 작업공간 (실행 기록 + 파일)
  const wsSub = h('p', { class: 'cb-ws-sub' });
  const fullLabel = h('span'), fullIcon = h('span');
  const fullBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'full', onclick: () => setFull(!S.full) }, fullIcon, fullLabel);
  const clearBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'clear', onclick: () => clearView() }, icon('clear'), h('span', null, 'Clear view'));
  const restoreBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'restore', onclick: () => restoreView() }, icon('history'), h('span', null, 'Restore history'));
  const roster = h('div', { class: 'cb-roster', role: 'group', 'aria-label': 'Experts in this project' });
  const streamState = h('span', { class: 'cb-stream-state' });
  const streamLog = h('ol', { class: 'cb-stream-log', role: 'log', 'aria-label': 'Execution stream', tabindex: '0' });
  const streamNote = h('p', { class: 'cb-stream-note' });
  const inspector = h('div', { class: 'cb-inspector' });
  const wsPanel = h('section', { class: 'cb-panel cb-workspace', 'aria-labelledby': 'cb-ws-h' },
    h('div', { class: 'cb-ws-head' },
      h('div', { class: 'cb-ws-title' }, h('h2', { id: 'cb-ws-h' }, 'Expert workspace'), wsSub),
      h('div', { class: 'cb-ws-actions' }, fullBtn, clearBtn, restoreBtn)),
    roster,
    h('div', { class: 'cb-stream' },
      h('div', { class: 'cb-stream-bar' }, icon('pulse'), h('span', { class: 'cb-stream-title' }, 'Execution stream'), h('span', { class: 'cb-stream-ro' }, 'read-only'), streamState),
      streamLog, streamNote),
    inspector);

  // ── 오른쪽: 진행 · 할 일 · 종합
  const progressBody = h('div');
  const tipBody = h('div');
  const synth = h('div', { class: 'cb-synth-body' });
  const aside = h('aside', { class: 'cb-aside', 'aria-label': 'Progress and decision' },
    h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-prog-h' }, h('div', { class: 'cb-panel-head' }, h('h2', { id: 'cb-prog-h' }, 'Project progress')), progressBody),
    h('section', { class: 'cb-tip', 'aria-labelledby': 'cb-tip-h' }, h('div', { class: 'cb-tip-head' }, icon('tip'), h('h2', { id: 'cb-tip-h' }, 'What to do now')), tipBody),
    h('section', { class: 'cb-panel cb-synth', 'aria-labelledby': 'cb-synth-h' }, h('div', { class: 'cb-panel-head' }, icon('chart'), h('h2', { id: 'cb-synth-h' }, 'Synthesis & confidence')), synth));

  // ── Guide · Help · Settings (기존 안내·설정 내용을 실제로 보여 준다)
  const guideStep = (n: number, title: string, text: string) => h('li', null, h('span', { class: 'cb-guide-n' }, String(n)), h('h3', null, title), h('p', null, text));
  const goHome = h('button', { type: 'button', class: 'cb-primary', onclick: () => setView('home') }, icon('home'), h('span', null, 'Back to Home'));
  const guideView = h('section', { class: 'cb-view cb-page', id: 'cb-view-guide', 'aria-labelledby': 'cb-guide-h' },
    h('div', { class: 'cb-page-head' }, h('h2', { id: 'cb-guide-h' }, 'Guide'), h('p', null, 'How a Cloudbite project runs, from brief to decision.')),
    h('ol', { class: 'cb-guide-steps' },
      guideStep(1, 'Write the shared brief', 'On Home, open Edit project. Give the project a name, the objective the experts should judge and optional context. Every expert receives the same brief.'),
      guideStep(2, 'Choose up to five experts', 'Pick roles from the catalogue in Project setup. Each selected expert works in its own isolated workspace with its own persona and work order. Three to five experts are recommended.'),
      guideStep(3, 'Run in demo or live mode', 'Browser demo simulates the run inside this tab. Live run asks the server to create one Daytona sandbox per expert, with inference configured on the server. Choose the mode in Settings.'),
      guideStep(4, 'Watch the execution stream', 'The stream lists the activity each expert reports — status changes, tool steps, notes and files. It is read-only: you cannot type commands into it.'),
      guideStep(5, 'Inspect files and personas', 'Select an expert to open available run artifacts, activity and its role definition. A work order may be shown as a labelled preview. Browser-demo files are simulated.'),
      guideStep(6, 'Review the synthesis', 'The right panel counts only completed, valid opinions. Failed, pending and cancelled experts are listed separately. Export a report or JSON when you are done.')),
    h('div', null, goHome));

  const faq = (q: string, a: string) => h('section', null, h('h3', null, q), h('p', null, a));
  const helpView = h('section', { class: 'cb-view cb-page', id: 'cb-view-help', 'aria-labelledby': 'cb-help-h' },
    h('div', { class: 'cb-page-head' }, h('h2', { id: 'cb-help-h' }, 'Help'), h('p', null, 'What the console shows, and what it does not claim.')),
    h('div', { class: 'cb-faq' },
      faq('Is the browser demo real?', 'No. The browser demo is a deterministic simulation that runs in this tab. It creates no Daytona sandbox and makes no Nosana inference call. Its results change with the wording of your brief, but they are scripted.'),
      faq('What does confidence mean?', 'Each expert reports its own confidence from 0 to 100. It is a self-assessment, not calibrated accuracy or independent agreement. Failed, pending, cancelled and invalid results are excluded from the average.'),
      faq('Why is Live run disabled?', 'Live run needs the server to be configured and an existing admin session token. If the server is not ready, Settings lists the missing setting names. API keys are never entered in this console.'),
      faq('How many experts can run?', 'Up to five experts per project, with up to three working at once. The catalogue currently has twelve roles. A hundred-expert room is a future concept, not a verified capacity.'),
      faq('What do Clear view and Full screen do?', 'Clear view only empties the visible stream window; new activity keeps arriving and the project history and files stay intact. Restore history brings the hidden rows back. Full screen expands the workspace; press Escape or Exit full screen to return.'),
      faq('Where is my data kept?', 'Tokens live only in this tab\'s memory. Exports are generated in the browser as downloads and state whether they come from a demo or a live run.')));

  const settingsView = h('section', { class: 'cb-view cb-page', id: 'cb-view-settings', 'aria-labelledby': 'cb-settings-h' },
    h('div', { class: 'cb-page-head' }, h('h2', { id: 'cb-settings-h' }, 'Settings'), h('p', null, 'Execution mode and session. Project details and expert selection are under Home → Edit project.')),
    h('div', { class: 'cb-settings' },
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-mode-h' }, h('h2', { id: 'cb-mode-h' }, 'Execution mode'),
        h('div', { class: 'cb-segs', role: 'group', 'aria-label': 'Execution mode' }, modeDemo, modeLive),
        h('p', { class: 'cb-help' }, 'The mode is locked while a project is running.'), demoBox, liveBox),
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-about-h' }, h('h2', { id: 'cb-about-h' }, 'About this console'),
        h('p', { class: 'cb-help' }, 'Cloudbite v0.0.1 — one shared project, several expert personas, each in a separate Daytona sandbox, with inference configured on the server.'),
        h('p', { class: 'cb-help' }, 'The legacy classroom lab is a separate product and is not part of this console.'),
        h('a', { href: '/lab' }, 'Open the legacy lab'))));

  const homeView = h('div', { class: 'cb-view cb-home', id: 'cb-view-home' }, h('div', { class: 'cb-center' }, projectCard, wsPanel), aside);
  const views: Record<View, HTMLElement> = { home: homeView, guide: guideView, help: helpView, settings: settingsView };
  const NAV: Array<[View, string]> = [['home', 'Home'], ['guide', 'Guide'], ['help', 'Help'], ['settings', 'Settings']];
  const navBtns = NAV.map(([v, label]) => h('button', { type: 'button', class: 'cb-nav-btn', 'data-fk': `nav:${v}`, onclick: () => setView(v) }, icon(v), h('span', null, label)));

  root.replaceChildren(
    h('header', { class: 'cb-top' },
      h('div', { class: 'cb-brand' }, h('span', { class: 'cb-logo' }, icon('cloud')),
        h('div', { class: 'cb-brand-text' }, h('span', { class: 'cb-word' }, 'Cloudbite', h('small', null, 'v0.0.1')),
          h('span', { class: 'cb-sub' }, 'Expert sandboxes for one shared project'))),
      h('div', { class: 'cb-top-right' }, modeBadge,
        h('div', { class: 'cb-profile', role: 'status', 'aria-label': 'Session' }, h('span', { class: 'cb-avatar' }, icon('user')),
          h('span', { class: 'cb-profile-text' }, h('span', { class: 'cb-profile-name' }, 'Operator'), profileState)))),
    live,
    h('div', { class: 'cb-shell' },
      h('nav', { class: 'cb-nav', 'aria-label': 'Primary' }, h('span', { class: 'cb-nav-label' }, 'Workspace'),
        h('ul', { class: 'cb-nav-list' }, ...navBtns.map(b => h('li', null, b))),
        h('div', { class: 'cb-nav-foot' }, h('span', null, 'Up to 5 experts per project · 3 run at once'), h('a', { href: '/cloudbite/access', target: '_blank', rel: 'noopener noreferrer' }, 'Try a sandbox'), h('a', { href: '/lab' }, 'Legacy lab'))),
      h('main', { class: 'cb-main' }, banner, homeView, guideView, helpView, settingsView)));

  document.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Escape' && S.full) { ev.preventDefault(); setFull(false); } });

  // ── 렌더 (동적 영역만 다시 그린다. 포커스는 data-fk 로 되돌린다)
  function keepFocus(fn: () => void): void {
    const a = document.activeElement as HTMLElement | null;
    const key = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    fn();
    if (key) { const n = root!.querySelector(`[data-fk="${CSS.escape(key)}"]`) as HTMLElement | null; if (n) n.focus(); }
  }

  function renderAll(): void { keepFocus(() => { renderNav(); renderControls(); renderCatalogue(); renderWork(); renderProgress(); renderSynth(); }); }

  function renderNav(): void {
    NAV.forEach(([v], i) => { navBtns[i].setAttribute('aria-current', v === S.view ? 'page' : 'false'); views[v].hidden = v !== S.view; });
  }

  function renderControls(): void {
    const demo = S.mode === 'demo';
    modeDemo.setAttribute('aria-pressed', String(demo)); modeLive.setAttribute('aria-pressed', String(!demo));
    modeDemo.disabled = modeLive.disabled = active();
    const runMode = S.run?.mode ?? S.mode;
    modeBadge.textContent = runMode === 'demo' ? 'Browser demo' : 'Live run';
    modeBadge.className = `cb-badge ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    const operator = isOperatorToken(S.adminToken);
    profileState.textContent = operator ? 'Temporary Cloudbite operator token in memory' : S.adminToken.trim() ? 'Admin token held in memory' : 'No admin token';
    tokenLabel.textContent = operator ? 'Temporary Cloudbite operator token (Cloudbite runs only)' : 'Admin token';
    banner.textContent = runMode === 'demo'
      ? 'Browser demo — simulated activity and files; no Daytona or Nosana calls.'
      : 'Live run — server-reported activity. Confidence is self-assessed.';
    banner.className = `cb-banner ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    modeLine.textContent = demo ? 'Next run: Browser demo (simulated in this tab).' : 'Next run: Live run (server sandboxes).';
    demoBox.hidden = !demo; liveBox.hidden = demo;
    const cfg = S.boot.data?.configuration;
    const liveKids: Kid[] = [];
    if (S.boot.status === 'loading') liveKids.push(h('p', { class: 'cb-help' }, 'Checking server readiness…'));
    else if (S.boot.status === 'error') liveKids.push(h('p', { class: 'cb-warn' }, `Could not load the server catalogue: ${S.boot.error}`),
      h('button', { type: 'button', class: 'cb-ghost', onclick: () => loadBootstrap() }, 'Check again'));
    else if (cfg && !cfg.liveReady) liveKids.push(h('div', { class: 'cb-warn' }, h('strong', null, 'Live run is not ready'),
      h('p', null, cfg.missing.length ? 'The server operator must add these settings on the server (values are never entered here):' : 'The server reported that live runs are not ready.'),
      cfg.missing.length ? h('ul', null, ...cfg.missing.map(m => h('li', null, h('code', null, m)))) : null));
    else if (cfg) liveKids.push(h('p', { class: 'cb-ok' }, `Server ready · up to ${plural(cfg.maxExperts, 'expert')}`));
    liveStatus.replaceChildren(...liveKids.filter((k): k is Node => !!k));
    clearTokenBtn.hidden = !S.adminToken;
    const busy = active();
    for (const n of [titleIn, objectiveIn, contextIn, failIn, tokenIn, filterIn]) n.disabled = busy;
    const liveBlocked = !demo && (S.boot.status !== 'ready' || !cfg?.liveReady || !S.adminToken.trim());
    startBtn.disabled = busy || liveBlocked;
    startLabel.textContent = S.run?.phase === 'starting' ? 'Starting…' : busy ? 'Running…' : S.run ? 'Run again' : 'Run experts';
    cancelBtn.disabled = !busy || S.run?.phase === 'cancelling' || S.run?.phase === 'starting';
    cancelLabel.textContent = S.run?.phase === 'cancelling' ? 'Stopping…' : 'Stop';
    if (S.formErrors.length) S.setupOpen = true;
    setup.hidden = !S.setupOpen;
    setupBtn.setAttribute('aria-expanded', String(S.setupOpen));
    setupLabel.textContent = S.setupOpen ? 'Hide project setup' : 'Edit project';
    const msgs = [...S.formErrors];
    if (S.run?.error) msgs.push(S.run.error);
    formMsg.replaceChildren(...msgs.map(m => h('p', null, m)));
    const p = S.run?.project;
    dlJson.disabled = dlMd.disabled = !p;
    selCount.textContent = `${S.selected.size} of max ${limits().max} selected`;
    // 프로젝트 카드: 실행 중이면 서버·데모가 돌려준 브리프, 아니면 지금 입력한 브리프
    projTitle.textContent = clip(p?.brief.title || titleIn.value.trim() || 'Untitled project', 120);
    projObjective.textContent = p?.brief.objective || objectiveIn.value.trim() || 'Add an objective in Edit project.';
    const pst = p ? p.status : S.run?.phase === 'starting' ? 'running' : S.run?.phase === 'error' ? 'failed' : 'draft';
    projStatus.textContent = S.run?.phase === 'starting' ? 'Starting' : PROJECT_STATUS_LABEL[pst];
    projStatus.className = `cb-pill p-${pst}`;
    const meta: Kid[] = [];
    if (p) {
      const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
      const valid = p.experts.filter(e => e.status === 'completed' && e.opinion).length;
      meta.push(h('span', null, h('strong', null, `${done} of ${plural(p.experts.length, 'expert')}`), ' finished'),
        h('span', null, h('strong', null, String(valid)), ' valid ', valid === 1 ? 'opinion' : 'opinions'));
    } else meta.push(h('span', null, h('strong', null, plural(S.selected.size, 'expert')), ' selected'));
    meta.push(h('span', null, 'Mode: ', h('strong', null, runMode === 'demo' ? 'Browser demo' : 'Live run')));
    if (p && S.run?.mode === 'live') meta.push(h('span', null, 'Project ', h('code', null, clip(p.id, 24))));
    fill(projMeta, ...meta);
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
        S.formErrors = []; keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
      });
      return h('label', { class: `cb-expert-opt${on ? ' is-on' : ''}`, for: `cb-x-${e.id}` }, cb,
        h('span', { class: 'cb-opt-text' }, h('span', { class: 'cb-opt-name' }, e.name), h('span', { class: 'cb-opt-domain' }, e.domain)));
    }));
    if (!shown.length) catalogueBox.append(h('p', { class: 'cb-empty' }, list.length ? 'No roles match your search.' : S.mode === 'live' ? 'The server catalogue is empty, so a live run is not possible.' : 'No roles available.'));
    catalogueNote.textContent = catalogueIsBuiltin() ? 'The server catalogue is empty or unreachable, so the demo uses 6 built-in demo roles.'
      : `${list.length}-role catalogue${list.length > shown.length ? ` · ${shown.length} shown` : ''} · 3–5 experts recommended.`;
  }

  function statusDot(s: ExpertStatus): HTMLElement { return h('span', { class: `cb-dot s-${s}`, 'aria-hidden': 'true' }); }

  function streamRows(p: ConsoleProject): Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string }> {
    const rows: Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string; seq: number }> = [];
    let seq = 0;
    for (const e of p.experts) for (const a of e.activity) rows.push({ key: `${e.id}\n${a.id}`, at: a.at, name: e.name, kind: a.kind, message: a.message, seq: seq++ });
    return rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function renderWork(): void {
    const p = S.run?.project;
    restoreBtn.disabled = S.hiddenRows.size === 0;
    if (!S.run || !p) {
      roster.replaceChildren();
      wsSub.textContent = !S.run ? 'Experts appear here once the project starts.' : S.run.phase === 'error' ? 'The project did not start.' : 'Creating expert workspaces…';
      streamState.textContent = S.run?.phase === 'starting' ? 'starting…' : 'idle';
      const msg = S.run?.phase === 'error' ? S.run.error : S.run ? 'The server is preparing expert workspaces.' : 'The execution stream shows each expert\'s reported activity once a project starts.';
      streamLog.replaceChildren(h('li', { class: S.run?.phase === 'error' ? 'cb-stream-empty k-error' : 'cb-stream-empty' }, msg));
      streamNote.textContent = '';
      clearBtn.disabled = true;
      inspector.replaceChildren();
      return;
    }
    if (!S.focusExpert || !p.experts.some(e => e.id === S.focusExpert)) S.focusExpert = p.experts[0]?.id ?? '';
    roster.replaceChildren(...p.experts.map(e => h('button', { type: 'button', class: `cb-card s-${e.status}${e.id === S.focusExpert ? ' is-focus' : ''}`, 'data-fk': `card:${e.id}`,
      'aria-pressed': String(e.id === S.focusExpert), onclick: () => { if (S.focusExpert !== e.id) S.artifactPicked = false; S.focusExpert = e.id; keepFocus(renderWork); } },
      h('span', { class: 'cb-card-head' }, statusDot(e.status), h('span', { class: 'cb-card-name' }, e.name)),
      h('span', { class: 'cb-card-foot' }, h('span', { class: 'cb-card-status' }, STATUS_LABEL[e.status]),
        e.opinion ? h('span', { class: `cb-chip d-${e.opinion.direction}` }, `${DIRECTION_LABEL[e.opinion.direction]} ${e.opinion.confidence}%`) : null,
        e.invalidOpinion ? h('span', { class: 'cb-chip d-invalid' }, 'Invalid format') : null))));
    const fe = p.experts.find(e => e.id === S.focusExpert);
    const def = fe ? findDef(fe.expertId) : undefined;
    wsSub.textContent = fe ? [fe.name, def?.domain, fe.sandboxId ? (S.run.mode === 'demo' ? `demo workspace ${fe.sandboxId}` : `sandbox ${fe.sandboxId}`) : 'workspace pending', STATUS_LABEL[fe.status]].filter(Boolean).join(' · ') : '';

    // 실행 기록: 모든 전문가가 보고한 활동을 시간순으로. 숨긴 줄은 화면에서만 뺀다
    const rows = streamRows(p);
    const visible = rows.filter(r => !S.hiddenRows.has(r.key));
    const shown = visible.slice(-STREAM_ROWS);
    const working = p.experts.filter(e => !TERMINAL_EXPERT.includes(e.status) && e.status !== 'queued').length;
    const phase = S.run.phase === 'cancelling' ? 'stopping' : PROJECT_STATUS_LABEL[p.status].toLowerCase();
    streamState.textContent = `${S.run.mode === 'demo' ? 'simulated · ' : ''}${phase} · ${working} active · ${plural(rows.length, 'event')}`;
    const atBottom = streamLog.scrollHeight - streamLog.scrollTop - streamLog.clientHeight < 48;
    if (!shown.length) {
      streamLog.replaceChildren(h('li', { class: 'cb-stream-empty' }, S.hiddenRows.size
        ? 'View cleared. New activity will appear here; the project history is unchanged.' : 'No activity reported yet.'));
    } else {
      streamLog.replaceChildren(...shown.map(r => h('li', { class: `cb-row k-${r.kind}` },
        h('time', { class: 'cb-row-at' }, clock(r.at)), h('span', { class: 'cb-row-who' }, r.name),
        h('span', { class: 'cb-row-kind' }, KIND_LABEL[r.kind]), h('span', { class: 'cb-row-msg' }, r.message))));
    }
    if (atBottom) streamLog.scrollTop = streamLog.scrollHeight;
    const hiddenCount = rows.length - visible.length;
    streamNote.textContent = hiddenCount ? `${plural(hiddenCount, 'earlier row')} hidden from this view. Restore history to show them again.`
      : visible.length > shown.length ? `Showing the latest ${shown.length} of ${visible.length} rows.` : '';
    clearBtn.disabled = visible.length === 0;
    renderDetail(p);
  }

  function renderDetail(p: ConsoleProject): void {
    const e = p.experts.find(x => x.id === S.focusExpert);
    if (!e) { inspector.replaceChildren(); return; }
    const def = findDef(e.expertId);
    const tabs: Array<[typeof S.tab, string]> = [['artifacts', `Files ${e.artifacts.length}`], ['activity', 'Activity'], ['workorder', 'Work order'], ['persona', 'Persona']];
    const tabBtns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: `cb-tab-${k}`, 'data-fk': `tab:${k}`, 'aria-selected': String(S.tab === k),
      'aria-controls': 'cb-tabpanel', tabindex: S.tab === k ? '0' : '-1', class: 'cb-tab', onclick: () => { S.tab = k; keepFocus(renderWork); } }, label));
    const tablist = h('div', { class: 'cb-tabs', role: 'tablist', 'aria-label': `${e.name} workspace` }, ...tabBtns);
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
        h('li', { class: `k-${a.kind}` }, h('span', { class: 'cb-act-kind' }, KIND_LABEL[a.kind]),
          h('span', { class: 'cb-act-msg' }, a.message), h('time', { class: 'cb-act-at' }, clock(a.at)))))
        : h('p', { class: 'cb-empty' }, 'No activity yet.');
      if (e.error) body = h('div', null, h('p', { class: 'cb-warn' }, `Error: ${e.error}`), body);
    } else if (S.tab === 'artifacts') {
      body = artifactView(p, e);
    } else if (S.tab === 'workorder') {
      const wo = e.artifacts.find(a => a.path === 'WORKORDER.md' && typeof a.content === 'string');
      body = h('div', null, !wo ? h('p', { class: 'cb-help' }, 'The workspace has not exported a work order yet, so this is a preview built from the brief.') : null,
        h('pre', { class: 'cb-file' }, wo?.content ?? (def ? workorderText(def, p.brief) : 'The role definition could not be found.')));
    } else {
      body = def ? h('div', null, h('pre', { class: 'cb-file' }, personaText(def))) : h('p', { class: 'cb-empty' }, 'This role was not found in the catalogue.');
    }
    const op = e.opinion;
    fill(inspector,
      h('div', { class: 'cb-detail-head' }, statusDot(e.status), h('h3', null, e.name), h('span', { class: 'cb-help' }, def?.summary ?? '')),
      op ? h('div', { class: `cb-opinion d-${op.direction}` }, h('span', { class: `cb-chip d-${op.direction}` }, `${DIRECTION_LABEL[op.direction]} · self-assessed ${op.confidence}%`),
        h('p', null, op.summary)) : null,
      tablist, h('div', { id: 'cb-tabpanel', role: 'tabpanel', 'aria-labelledby': `cb-tab-${S.tab}`, class: 'cb-tabpanel' }, body));
  }

  function artifactView(p: ConsoleProject, e: ConsoleExpert): Node {
    if (!e.artifacts.length) return h('p', { class: 'cb-empty' }, 'No files yet. Files appear as the expert writes them.');
    if (!S.artifactPicked || !e.artifacts.some(a => a.path === S.artifactPath)) S.artifactPath = (e.artifacts.find(a => a.path === 'out/report.md') ?? e.artifacts.find(a => a.path.startsWith('out/')) ?? e.artifacts[0]).path;
    const a = e.artifacts.find(x => x.path === S.artifactPath)!;
    const list = h('ul', { class: 'cb-files', 'aria-label': 'Available files' }, ...e.artifacts.map(x => h('li', null, h('button', { type: 'button', class: `cb-filebtn${x.path === a.path ? ' is-on' : ''}`,
      'data-fk': `file:${x.path}`, 'aria-pressed': String(x.path === a.path), onclick: () => { S.artifactPath = x.path; S.artifactPicked = true; keepFocus(renderWork); } },
      icon('file'), h('span', { class: 'cb-file-text' }, h('span', { class: 'cb-file-path' }, x.path), h('span', { class: 'cb-help' }, x.label))))));
    let view: Node;
    if (typeof a.content === 'string') view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': `${a.path} contents` }, a.content || '(empty file)');
    else if (S.run?.mode === 'live' && S.run.accessToken) {
      const key = `${p.id}\n${e.expertId}\n${a.path}`;
      const c = S.artifactCache.get(key);
      if (!c) { fetchArtifact(p.id, e.expertId, a.path, key); view = h('p', { class: 'cb-help' }, 'Loading file…'); }
      else if (c.state === 'loading') view = h('p', { class: 'cb-help' }, 'Loading file…');
      else if (c.state === 'error') view = h('div', null, h('p', { class: 'cb-warn' }, c.text),
        h('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.artifactCache.delete(key); renderWork(); } }, 'Load again'));
      else view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': `${a.path} contents` }, c.text || '(empty file)');
    } else view = h('p', { class: 'cb-empty' }, 'This file was reported without its contents.');
    return h('div', { class: 'cb-artifacts' }, list, view);
  }

  function renderProgress(): void {
    const p = S.run?.project;
    const run = S.run;
    // 진행 단계는 관찰된 상태에서만 만든다 (클릭으로 완료되는 단계 없음)
    type StepState = 'done' | 'active' | 'pending' | 'blocked';
    const step = (label: string, state: StepState, n = '') => h('li', { class: `cb-step is-${state}` },
      h('span', { class: 'cb-step-mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check') : null),
      h('span', null, label, h('span', { class: 'cb-sr' }, ` — ${state}`)), h('span', { class: 'cb-step-n' }, n));
    if (!run) {
      fill(progressBody, h('div', { class: 'cb-progress-num' }, h('span', { class: 'cb-big' }, String(S.selected.size)), h('span', { class: 'cb-help' }, `${S.selected.size === 1 ? 'expert' : 'experts'} selected · not started`)),
        h('ol', { class: 'cb-steps' }, step('Brief submitted', 'pending'), step('Workspaces prepared', 'pending'), step('Experts working', 'pending'), step('Opinions submitted', 'pending'), step('Synthesis ready', 'pending')));
    } else if (!p) {
      fill(progressBody, h('div', { class: 'cb-progress-num' }, h('span', { class: 'cb-big' }, '0'), h('span', { class: 'cb-help' }, run.phase === 'error' ? 'project not created' : 'creating project…')),
        h('ol', { class: 'cb-steps' }, step('Brief submitted', run.phase === 'error' ? 'blocked' : 'active'), step('Workspaces prepared', 'pending'), step('Experts working', 'pending'), step('Opinions submitted', 'pending'), step('Synthesis ready', 'pending')));
    } else {
      const n = p.experts.length;
      const started = p.experts.filter(e => e.status !== 'queued').length;
      const working = p.experts.filter(e => e.status === 'running' || e.status === 'provisioning').length;
      const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
      const a = aggregate(p);
      const terminal = TERMINAL_PROJECT.includes(p.status);
      const stopped = p.status === 'cancelled' || p.status === 'failed';
      const bar = h('div', { class: 'cb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': n, 'aria-valuenow': done, 'aria-label': 'Experts finished' },
        ...p.experts.map(e => h('span', { class: `cb-bar-seg s-${e.status}`, title: `${e.name}: ${STATUS_LABEL[e.status]}` })));
      fill(progressBody,
        h('div', { class: 'cb-progress-num' }, h('span', { class: 'cb-big' }, `${done} / ${n}`), h('span', { class: 'cb-help' }, `experts finished · ${PROJECT_STATUS_LABEL[p.status].toLowerCase()}`)),
        bar,
        h('ol', { class: 'cb-steps' },
          step('Brief submitted', 'done'),
          step('Workspaces prepared', started === n ? 'done' : stopped ? 'blocked' : 'active', `${started}/${n}`),
          step('Experts working', done === n ? 'done' : stopped ? 'blocked' : working ? 'active' : 'pending', working ? `${working} active` : ''),
          step('Opinions submitted', a.valid + a.failed + a.cancelled + a.invalid === n ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : stopped ? 'blocked' : 'pending', `${a.valid} valid`),
          step('Synthesis ready', terminal ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : 'pending', a.failed ? `${a.failed} failed` : '')));
    }
    // 지금 할 일
    const cfg = S.boot.data?.configuration;
    const tips: Kid[] = [];
    const go = (label: string, v: View) => h('button', { type: 'button', class: 'cb-ghost', onclick: () => setView(v) }, label);
    if (!run) {
      tips.push(h('p', null, 'Check the brief with Edit project, choose up to five experts, then select Run experts.'));
      if (S.mode === 'live' && (!cfg?.liveReady || !S.adminToken.trim())) tips.push(h('p', null, 'Live run is blocked until the server is ready and an admin token is entered.'), go('Open Settings', 'settings'));
    } else if (run.phase === 'starting') tips.push(h('p', null, run.mode === 'demo' ? 'Starting the browser simulation…' : 'Asking the server to create one sandbox per expert…'));
    else if (run.phase === 'error' && !p) tips.push(h('p', null, 'The project could not start. Read the error on the project card, fix it and run again. Nothing was switched to demo mode.'));
    else if (p && active()) {
      tips.push(h('p', null, run.mode === 'demo' ? 'The simulated experts are working. Select an expert above the stream to open its files.'
        : 'Experts are working in separate sandboxes. Select an expert to read its files; the synthesis updates as valid opinions arrive.'));
      if (run.error) tips.push(h('p', null, run.error));
    } else if (p) {
      const a = aggregate(p);
      tips.push(h('p', null, a.valid ? 'Results are in. Read the synthesis below, check any dissent, then export a report.'
        : 'No valid opinions to synthesise. Check the errors in the execution stream and run again.'));
      if (a.failed || a.invalid) tips.push(h('p', null, `${plural(a.failed + a.invalid, 'expert')} did not produce a valid opinion and ${a.failed + a.invalid === 1 ? 'is' : 'are'} excluded.`));
    }
    fill(tipBody, ...tips);
  }

  function renderSynth(): void {
    const p = S.run?.project;
    if (!p) { synth.replaceChildren(h('p', { class: 'cb-empty' }, S.run ? 'Completed opinions are synthesised once the project exists.' : 'No project has run yet.')); return; }
    const a = aggregate(p);
    const total = a.valid || 1;
    const segs = DIRECTIONS.filter(d => a.counts[d] > 0).map(d => {
      const s = h('span', { class: `cb-dist-seg d-${d}` }, `${Math.round(a.counts[d] / total * 100)}%`);
      s.style.flexGrow = String(a.counts[d]);
      return s;
    });
    const maxB = Math.max(1, ...a.buckets);
    fill(synth,
      h('div', { class: 'cb-tally' }, h('span', { class: 'cb-big' }, String(a.valid)), h('span', null, ` / ${a.selected} valid opinions`)),
      h('p', { class: 'cb-counts' }, `Failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled}${a.invalid ? ` · invalid format ${a.invalid}` : ''} — only completed, valid opinions are counted.`),
      a.valid ? h('div', { class: 'cb-dist', role: 'img', 'aria-label': DIRECTIONS.map(d => `${DIRECTION_LABEL[d]} ${a.counts[d]}`).join(', ') }, ...segs) : null,
      h('ul', { class: 'cb-legend' }, ...DIRECTIONS.map(d => h('li', null, h('span', { class: `cb-sw d-${d}`, 'aria-hidden': 'true' }), `${DIRECTION_LABEL[d]} `, h('strong', null, String(a.counts[d]))))),
      h('div', { class: 'cb-recommend' }, h('h3', null, 'Suggested decision'), h('p', { class: 'cb-headline' }, a.headline),
        a.actions.length ? h('ol', { class: 'cb-actions-list' }, ...a.actions.map(x => h('li', null, h('span', null, x.text),
          h('span', { class: 'cb-help' }, `${x.names.join(', ')}${x.count > 1 ? ` · shared by ${x.count}` : ''}`)))) : null),
      a.disagreement ? h('div', { class: 'cb-dispute' }, h('h3', null, 'Dissent'),
        ...a.supportVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-support' }, h('span', { class: 'cb-chip d-support' }, `Support · ${v.name} ${v.confidence}%`), h('p', null, v.summary))),
        ...a.concernVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-concern' }, h('span', { class: 'cb-chip d-concern' }, `Concern · ${v.name} ${v.confidence}%`), h('p', null, v.summary))))
        : a.valid > 1 ? h('p', { class: 'cb-help' }, 'No point has drawn both support and concern yet.') : null,
      h('div', { class: 'cb-conf' }, h('h3', null, 'Self-assessed confidence'),
        h('p', { class: 'cb-help' }, a.meanConfidence === null ? 'No completed, valid opinions yet.' : `Mean ${a.meanConfidence}% · each role's self-assessment, not calibrated accuracy.`),
        h('div', { class: 'cb-hist', role: 'img', 'aria-label': `Confidence distribution ${a.buckets.map((n, i) => `${i * 20}–${i * 20 + 20}%: ${n}`).join(', ')}` },
          ...a.buckets.map((n, i) => { const col = h('span', { class: 'cb-hist-col' }, h('span', { class: 'cb-hist-n' }, n ? String(n) : ''));
            const bar = h('span', { class: 'cb-hist-bar' }); bar.style.height = `${Math.round(n / maxB * 100)}%`; col.append(bar, h('span', { class: 'cb-hist-x' }, i === 4 ? '80–100' : `${i * 20}–${i * 20 + 19}`)); return col; }))));
    const phrase = `${PROJECT_STATUS_LABEL[p.status]}: ${plural(a.valid, 'valid opinion')}, ${a.failed} failed`;
    if (TERMINAL_PROJECT.includes(p.status) && phrase !== lastAnnounce) { lastAnnounce = phrase; live.textContent = phrase; }
  }

  // ── 동작
  function setView(v: View): void {
    if (S.full && v !== 'home') setFull(false);
    S.view = v; renderNav();
    navBtns[NAV.findIndex(([k]) => k === v)].focus();
  }

  function setFull(on: boolean): void { paintFull(on); fullBtn.focus(); }
  function paintFull(on: boolean): void {
    S.full = on;
    wsPanel.className = `cb-panel cb-workspace${on ? ' is-full' : ''}`;
    root!.className = `cb-root${on ? ' is-fullscreen' : ''}`;
    fullIcon.className = `cb-i i-${on ? 'collapse' : 'expand'}`;
    fullIcon.setAttribute('aria-hidden', 'true');
    fullLabel.textContent = on ? 'Exit full screen' : 'Full screen';
    fullBtn.setAttribute('aria-pressed', String(on));
  }

  function clearView(): void {
    const p = S.run?.project;
    if (!p) return;
    for (const r of streamRows(p)) S.hiddenRows.add(r.key);
    keepFocus(renderWork);
  }

  function restoreView(): void {
    S.hiddenRows.clear();
    keepFocus(renderWork);
    streamLog.scrollTop = 0;
  }

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
      if (!S.boot.data?.configuration.liveReady) S.formErrors.push('The server is not ready for live runs.');
      if (!S.adminToken.trim()) S.formErrors.push('Enter the admin token in Settings.');
      else if (isOperatorToken(S.adminToken) && !OPERATOR_TOKEN.test(S.adminToken.trim())) S.formErrors.push('The temporary Cloudbite operator token is malformed. Clear it and use a new link.');
    }
    if (S.formErrors.length) { renderControls(); return; }
    clearTimers();
    const gen = ++S.gen;
    const brief: ProjectBrief = { ...f, mode: S.mode, requestId: crypto.randomUUID() };
    S.artifactCache.clear(); S.hiddenRows.clear(); S.focusExpert = ''; S.artifactPath = ''; S.artifactPicked = false; lastAnnounce = '';
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
    const base = res.status === 401 || res.status === 403 ? 'Admin or project permission is missing or has expired. Check the token.'
      : res.status === 404 ? 'The project could not be found.'
        : res.status === 409 ? 'The same request is already being processed.'
          : res.status === 413 ? 'The input is too long. Shorten the objective or context.'
            : res.status === 429 ? 'Too many requests. Try again shortly.'
              : res.status === 503 ? 'The server run configuration is not ready.'
                : `Server error (HTTP ${res.status})`;
    return server ? `${base} — ${server}` : base;
  }

  async function startLive(gen: number, brief: ProjectBrief): Promise<void> {
    const operator = isOperatorToken(S.adminToken);
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/projects', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-admin-token': S.adminToken.trim() }, body: JSON.stringify(brief) });
    } catch {
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = 'Could not reach the server. Check the network and run again. (Not switched to demo.)'; renderAll(); return;
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const msg = operator && res.status === 401 ? 'The temporary Cloudbite operator token was rejected or has expired. Ask the owner for a new link.' : await errorText(res);
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = msg; renderAll(); return;
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen) return;
    const project = isObj(body) ? normalizeProject(body.project) : null;
    const token = isObj(body) ? str(body.accessToken, 2000) : '';
    if (!project || !token) { S.run!.phase = 'error'; S.run!.error = 'The server response has an invalid format.'; renderAll(); return; }
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
      return pollFailed(gen, 'The connection to the server was lost.');
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
    if (!p || p.id !== run.project.id) return pollFailed(gen, 'The server response has an invalid format.');
    run.pollErrors = 0; run.error = '';
    if (p.updatedAt >= run.project.updatedAt) run.project = p; // 늦게 도착한 옛 상태는 버린다
    if (TERMINAL_PROJECT.includes(run.project.status)) run.phase = 'done'; else schedulePoll(gen, 2000);
    renderAll();
  }

  function pollFailed(gen: number, msg: string): void {
    const run = S.run!;
    run.pollErrors++;
    if (run.pollErrors >= 4) { run.phase = 'error'; run.error = `${msg} Stopped checking the status.`; renderAll(); appendRetry(gen); return; }
    run.error = `${msg} Checking again… (${run.pollErrors}/3)`;
    renderControls(); renderProgress();
    schedulePoll(gen, 1500 * 2 ** run.pollErrors);
  }

  function appendRetry(gen: number): void {
    formMsg.append(h('button', { type: 'button', class: 'cb-ghost', onclick: () => {
      if (gen !== S.gen || !S.run?.project) return;
      S.run.phase = 'running'; S.run.error = ''; S.run.pollErrors = 0; renderAll(); void poll(gen);
    } }, 'Check status again'));
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
      if (!res.ok) { const msg = await errorText(res); if (gen !== S.gen) return; run.phase = 'error'; run.error = `Could not stop the project: ${msg}`; renderAll(); return; }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 형식 오류 */ }
      if (gen !== S.gen) return;
      const p = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
      if (p && p.id === id) run.project = p;
      else if (run.project) run.project = { ...run.project, status: 'cancelled' };
      run.phase = 'done';
    } catch {
      if (gen !== S.gen) return;
      run.phase = 'error'; run.error = 'Could not send the stop request. Try again.';
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
      S.artifactCache.set(key, { state: 'error', text: 'Could not load the file.' });
    }
    keepFocus(renderWork);
  }

  function download(kind: 'json' | 'md'): void {
    const p = S.run?.project;
    if (!p) return;
    const demo = S.run!.mode === 'demo';
    const text = kind === 'json'
      ? JSON.stringify({ kind: demo ? 'cloudbite-browser-demo' : 'cloudbite-live', note: demo ? 'Browser simulation — no real sandbox or inference' : 'Confidence is self-assessed, not calibrated accuracy', project: p, aggregate: aggregate(p) }, null, 2)
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
      S.boot = { status: 'error', data: null, error: e instanceof Error ? clip(e.message, 200) : 'Unknown error' };
    }
    // 실행 중인 프로젝트는 그대로 둔다. 선택만 지금 카탈로그에 있는 역할로 맞추고, 아직 시작 전이면 기본 선택을 다시 잡는다
    if (!S.run) S.selected.clear();
    const ids = new Set(catalogue().map(e => e.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
    if (!S.selected.size && (S.mode === 'demo' || link.present)) defaultSelection();
    renderAll();
  }

  // 첫 화면부터 전문가가 각자 작업공간에서 일하는 모습을 보인다: 내장 예시 브리프로 데모를 바로 시작한다 (명시적 데모 표시)
  paintFull(false);
  defaultSelection();
  renderAll();
  // 카탈로그를 잠깐(최대 1.5초) 기다렸다가 시작한다. 늦으면 내장 데모 역할로 먼저 시작한다
  void Promise.race([loadBootstrap(), new Promise(r => setTimeout(r, 1500))]).then(() => { if (!S.run && S.mode === 'demo' && !link.present) startRun(); });
}

const CloudbiteCore = { normalizeBootstrap, normalizeProject, normalizeOpinion, aggregate, validateForm, demoPlan, applyStep, cancelProject, statusFromExperts, markdownReport, archetypeOf, operatorFragment, DEMO_EXPERTS };
const hook = (globalThis as { __cloudbiteTestHook?: (core: typeof CloudbiteCore) => void }).__cloudbiteTestHook;
if (typeof hook === 'function') hook(CloudbiteCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
