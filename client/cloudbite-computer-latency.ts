// Cloudbite latency check (browser). tools/build-cloudbite-computer-latency.mjs transforms this file (no bundling) into
// src/cloudbite-computer-latency-page.ts → CLOUDBITE_COMPUTER_LATENCY_JS, served same-origin at /cloudbite/computer/latency.js
// for the page /cloudbite/computer/latency (?lang=ko|en).
// Sign-in stays on the main computer page (/cloudbite/computer): this page only uses the existing HttpOnly cookie, and a 401
// shows a link there. It never starts WebAuthn, reads storage or holds a token.
// Nothing is requested on load, on typing or on a timer: each request comes from one explicit button.
//   Measure connection: 5 sequential GET latency/ping, each timed with performance.now() around fetch + body → count/p50/p95.
//   Measure backend: one GET latency/backend; its browser round trip is shown apart from the server-side provider timings.
//   Typing preview: input event → next animation frame, measured on this device only, with no request at all.
// Clocks are never mixed: browser timings use performance.now(), server timings come measured; serverTime is not subtracted.
// No distance, location or benchmark is derived. A hidden tab or a 401 aborts what is in flight.
// Everything is drawn with createElement/textContent. Text comes from DICT (EN/KO); server reason codes are shown verbatim.

const API = '/api/cloudbite/computer/latency';
const COMPUTER_PATH = '/cloudbite/computer';
const PING_SAMPLES = 5;
const TYPING_MAX = 50;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const REASONS = ['absent', 'not_configured', 'ownership_mismatch', 'stopped', 'not_running', 'error', 'timeout', 'provider_error', 'exec_failed', 'skipped_after_control_failure'] as const;
type Reason = typeof REASONS[number];

type Lang = 'en' | 'ko';
type Msg = { text: () => string; kind: 'ok' | 'warn' | 'info' } | null;
type Sample = { at: string | null; ms: number | null; reason: string | null };
type Backend = {
  measuredAt: string | null; cached: boolean; cacheAgeMs: number | null;
  machine: { status: string; providerState: string | null; account: string | null };
  apiControl: Sample; remoteExec: Sample;
};
type Reply = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; code: string; aborted: boolean };

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Latency', brand: 'Cloudbite', sub: 'Latency', back: 'Cloud computer',
    h1: 'Check latency', lead: 'Measure how quickly this device reaches Cloudbite and how quickly Cloudbite reaches your computer. Nothing is measured until you press a button.',
    signedOut: 'You are not signed in to your cloud computer. Sign in on the cloud computer page, then come back.', signInLink: 'Sign in on the cloud computer page',
    netErr: 'Network error — nothing was measured.', httpErr: (n: number) => `Server answered ${n}.`, rejected: (c: string) => `Rejected: ${c}`,
    cancelled: 'Stopped because the tab was hidden. Press the button again to measure.',
    unavailable: 'unavailable', ms: (v: number) => `${v.toFixed(1)} ms`,
    edgeTitle: 'This device → Cloudbite', edgeLead: `${PING_SAMPLES} requests one after another. Each one is a full HTTPS round trip including server handling.`,
    edgeRun: 'Measure connection', edgeRunning: 'Measuring…',
    count: 'Samples', p50: 'Median (p50)', p95: 'p95', failed: 'Failed requests', samples: 'Each sample', when: 'Measured',
    edgeNone: 'No sample succeeded, so there is no number to show.',
    edgeNote: 'A round-trip time is not a distance or a location, and one short check is not a benchmark.',
    backTitle: 'Cloudbite → your computer', backLead: 'One request. Cloudbite times its own calls to the provider; these are not added to or subtracted from the browser time.',
    backRun: 'Measure backend', backRunning: 'Measuring…',
    browserTrip: 'This request, browser round trip', control: 'Provider control API round trip', exec: 'Remote command round trip',
    execNote: 'Includes provider queueing and running a small fixed command, so it is not a pure network time.',
    machine: 'Computer status', provider: 'Provider reports', measuredAt: 'Server measured at',
    cached: (s: number) => `Reused from a measurement ${s} s ago (kept for 30 s).`, fresh: 'Fresh measurement.',
    reason: {
      absent: 'no computer yet', not_configured: 'account not configured', ownership_mismatch: 'ownership not confirmed — not measured',
      stopped: 'computer is stopped — nothing was started', not_running: 'computer is not running — nothing was started', error: 'computer is in an error state',
      timeout: 'no answer in time', provider_error: 'provider did not answer correctly', exec_failed: 'command did not complete',
      skipped_after_control_failure: 'skipped because the control call failed',
    } as Record<Reason, string>,
    unknownReason: (c: string) => `unknown (${c})`,
    typeTitle: 'Typing preview on this device', typeLead: 'Type in the box. Each key is timed from the input event to the next animation frame here. No request is sent.',
    typeLabel: 'Type here', typeClear: 'Clear samples', typeNone: 'No samples yet.',
    typeNote: 'This is local paint response only. It is not how long input takes to reach your remote desktop (Photon); measuring that needs a video loop, which is not implemented.',
  },
  ko: {
    title: 'Cloudbite — 지연 시간', brand: 'Cloudbite', sub: '지연 시간', back: '클라우드 컴퓨터',
    h1: '지연 시간 확인', lead: '이 기기에서 Cloudbite까지, Cloudbite에서 내 컴퓨터까지 얼마나 빨리 닿는지 잽니다. 버튼을 누르기 전에는 아무것도 재지 않습니다.',
    signedOut: '클라우드 컴퓨터에 로그인되어 있지 않습니다. 클라우드 컴퓨터 페이지에서 로그인한 뒤 돌아오세요.', signInLink: '클라우드 컴퓨터 페이지에서 로그인',
    netErr: '네트워크 오류 — 잰 값이 없습니다.', httpErr: (n: number) => `서버 응답 ${n}.`, rejected: (c: string) => `거부됨: ${c}`,
    cancelled: '탭이 가려져 측정을 멈췄습니다. 다시 재려면 버튼을 누르세요.',
    unavailable: '측정 불가', ms: (v: number) => `${v.toFixed(1)} ms`,
    edgeTitle: '이 기기 → Cloudbite', edgeLead: `요청 ${PING_SAMPLES}개를 차례로 보냅니다. 각각 서버 처리를 포함한 HTTPS 왕복 전체입니다.`,
    edgeRun: '연결 측정', edgeRunning: '측정 중…',
    count: '표본 수', p50: '중앙값 (p50)', p95: 'p95', failed: '실패한 요청', samples: '각 표본', when: '측정 시각',
    edgeNone: '성공한 표본이 없어 보여 줄 숫자가 없습니다.',
    edgeNote: '왕복 시간은 거리나 위치가 아니며, 짧은 한 번의 확인은 벤치마크가 아닙니다.',
    backTitle: 'Cloudbite → 내 컴퓨터', backLead: '요청 하나를 보냅니다. Cloudbite가 공급자 호출을 직접 잽니다. 이 값을 브라우저 시간에 더하거나 빼지 않습니다.',
    backRun: '백엔드 측정', backRunning: '측정 중…',
    browserTrip: '이 요청의 브라우저 왕복', control: '공급자 제어 API 왕복', exec: '원격 명령 왕복',
    execNote: '공급자 대기열과 작은 고정 명령 실행이 포함되어 순수 네트워크 시간이 아닙니다.',
    machine: '컴퓨터 상태', provider: '공급자 보고', measuredAt: '서버 측정 시각',
    cached: (s: number) => `${s}초 전 측정을 다시 보여 줍니다 (30초 동안 유지).`, fresh: '새로 잰 값입니다.',
    reason: {
      absent: '아직 컴퓨터가 없음', not_configured: '계정이 설정되지 않음', ownership_mismatch: '소유 확인 안 됨 — 재지 않음',
      stopped: '컴퓨터가 멈춰 있음 — 아무것도 시작하지 않음', not_running: '컴퓨터가 실행 중이 아님 — 아무것도 시작하지 않음', error: '컴퓨터가 오류 상태',
      timeout: '제시간에 응답 없음', provider_error: '공급자가 제대로 답하지 않음', exec_failed: '명령이 끝나지 않음',
      skipped_after_control_failure: '제어 호출이 실패해 건너뜀',
    } as Record<Reason, string>,
    unknownReason: (c: string) => `알 수 없음 (${c})`,
    typeTitle: '이 기기의 입력 미리보기', typeLead: '상자에 입력해 보세요. 키마다 입력 이벤트부터 다음 애니메이션 프레임까지를 이 기기에서 잽니다. 요청은 보내지 않습니다.',
    typeLabel: '여기에 입력', typeClear: '표본 지우기', typeNone: '아직 표본이 없습니다.',
    typeNote: '이 값은 이 기기의 화면 반응일 뿐입니다. 입력이 원격 데스크톱(Photon)에 닿는 시간이 아니며, 그것을 재려면 아직 구현되지 않은 영상 루프가 필요합니다.',
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const code = (v: unknown): string | null => { const c = str(v, 64); return SAFE_CODE.test(c) ? c : null; };
const now = (): number => performance.now();

/** Nearest-rank quantile of finite samples; null when there are none. */
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function errorCode(body: unknown): string {
  if (!isObj(body)) return '';
  const e = body.error;
  return (isObj(e) ? code(e.code) : code(e)) ?? '';
}

/** One timed GET. `ms` covers request start to the parsed body; it is only kept when the answer is a definite success. */
async function timedGet(path: string, signal: AbortSignal): Promise<{ reply: Reply; ms: number }> {
  const t0 = now();
  let res: Response;
  try { res = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal }); }
  catch { return { reply: { ok: false, status: 0, code: '', aborted: signal.aborted }, ms: now() - t0 }; }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  const ms = now() - t0;
  if (signal.aborted) return { reply: { ok: false, status: 0, code: '', aborted: true }, ms };
  if (res.ok && isObj(parsed) && parsed.ok === true) return { reply: { ok: true, status: res.status, body: parsed }, ms };
  return { reply: { ok: false, status: res.ok ? 502 : res.status, code: errorCode(parsed), aborted: false }, ms };
}
const authStatus = (s: number): boolean => s === 401 || s === 403;

function normalizeSample(raw: unknown): Sample {
  if (!isObj(raw)) return { at: null, ms: null, reason: 'provider_error' };
  const ms = num(raw.ms), reason = code(raw.reason);
  return { at: iso(raw.at), ms: reason ? null : ms, reason: ms === null && !reason ? 'provider_error' : reason };
}
function normalizeBackend(raw: Record<string, unknown>): Backend | null {
  if (raw.schema !== 'cloudbite.computer.latency.backend.v1' || !isObj(raw.machine)) return null;
  const m = raw.machine;
  return {
    measuredAt: iso(raw.measuredAt), cached: raw.cached === true, cacheAgeMs: num(raw.cacheAgeMs),
    machine: { status: code(m.status) ?? 'unknown', providerState: code(m.providerState), account: code(m.account) },
    apiControl: normalizeSample(raw.apiControl), remoteExec: normalizeSample(raw.remoteExec),
  };
}

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k) el.append(k);
  return el;
}
function button(cls: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls);
  b.setAttribute('type', 'button');
  b.addEventListener('click', onClick);
  return b;
}
function link(cls: string, href: string): HTMLAnchorElement {
  const a = h('a', cls);
  a.setAttribute('href', href);
  return a;
}
function showMsg(el: HTMLElement, m: Msg): void {
  el.hidden = !m;
  if (m) { el.textContent = m.text(); el.className = `cl-msg cl-${m.kind}`; }
}

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const qs = params.get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;

  const S = {
    signedOut: false,
    edge: { running: false, samples: [] as number[], failures: 0, at: null as string | null, msg: null as Msg, done: false },
    back: { running: false, data: null as Backend | null, browserMs: null as number | null, msg: null as Msg },
    typing: [] as number[],
  };
  // gen is bumped on sign-out or hide: every answer that arrives later is dropped and in-flight requests are aborted.
  let gen = 0, ac = new AbortController(), frame = false;

  // ── skeleton ──
  const brand = h('strong', 'cl-brand'), brandSub = h('span', 'cl-sub');
  const backLink = link('cl-nav-link', COMPUTER_PATH);
  const langNav = h('nav', 'cl-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = button('cl-lang-btn', () => { if (lang !== l) { lang = l; render(); } });
    b.textContent = l.toUpperCase(); b.setAttribute('lang', l);
    langNav.append(b);
    return b;
  });
  const header = h('header', 'cl-header', h('div', 'cl-brand-row', brand, brandSub), h('div', 'cl-header-side', backLink, langNav));
  const h1 = h('h1'), lead = h('p', 'cl-lead');

  const gateMsg = h('p', 'cl-msg'), signInLink = link('cl-btn cl-primary', COMPUTER_PATH);
  gateMsg.setAttribute('role', 'status');
  const gate = h('section', 'cl-card', gateMsg, h('div', 'cl-actions', signInLink));

  const edgeTitle = h('h2'), edgeLead = h('p', 'cl-fine'), edgeBtn = button('cl-btn cl-primary', () => { void measureEdge(); });
  edgeBtn.id = 'cl-edge-run';
  const edgeMsg = h('p', 'cl-msg'), edgeFacts = h('dl', 'cl-facts'), edgeNote = h('p', 'cl-fine');
  edgeMsg.setAttribute('role', 'status');
  const edgeCard = h('section', 'cl-card', edgeTitle, edgeLead, h('div', 'cl-actions', edgeBtn), edgeMsg, edgeFacts, edgeNote);

  const backTitle = h('h2'), backLead = h('p', 'cl-fine'), backBtn = button('cl-btn cl-primary', () => { void measureBackend(); });
  backBtn.id = 'cl-backend-run';
  const backMsg = h('p', 'cl-msg'), backFacts = h('dl', 'cl-facts'), backCache = h('p', 'cl-fine'), execNote = h('p', 'cl-fine');
  backMsg.setAttribute('role', 'status');
  const backCard = h('section', 'cl-card', backTitle, backLead, h('div', 'cl-actions', backBtn), backMsg, backFacts, backCache, execNote);

  const typeTitle = h('h2'), typeLead = h('p', 'cl-fine'), typeLabel = h('label', 'cl-field-label'), typeIn = h('textarea', 'cl-input');
  typeIn.id = 'cl-typing'; typeLabel.setAttribute('for', 'cl-typing');
  for (const [k, v] of [['autocomplete', 'off'], ['autocapitalize', 'none'], ['spellcheck', 'false'], ['rows', '3'], ['maxlength', '2000']]) typeIn.setAttribute(k, v);
  const typeFacts = h('dl', 'cl-facts'), typeNote = h('p', 'cl-callout');
  const typeClear = button('cl-btn', () => { S.typing = []; render(); });
  typeClear.id = 'cl-typing-clear';
  const typeCard = h('section', 'cl-card', typeTitle, typeLead, h('div', 'cl-field', typeLabel, typeIn), typeFacts, h('div', 'cl-actions', typeClear), typeNote);

  const main = h('main', 'cl-main', h1, lead, gate, h('div', 'cl-grid', edgeCard, backCard, typeCard));
  root.replaceChildren(header, main);

  // ── local typing: no request, ever ──
  typeIn.addEventListener('input', (e: Event) => {
    if (frame) return; // one pending frame at a time keeps the samples independent
    const t = now(), ts = typeof e.timeStamp === 'number' && e.timeStamp > 0 && e.timeStamp <= t ? e.timeStamp : t;
    frame = true;
    requestAnimationFrame(() => {
      frame = false;
      S.typing.push(now() - ts);
      if (S.typing.length > TYPING_MAX) S.typing.splice(0, S.typing.length - TYPING_MAX);
      render();
    });
  });

  function failMsg(r: Reply & { ok: false }): Msg {
    return r.status === 0 ? { text: () => T().netErr, kind: 'warn' } : r.code ? { text: () => T().rejected(r.code), kind: 'warn' } : { text: () => T().httpErr(r.status), kind: 'warn' };
  }

  async function measureEdge(): Promise<void> {
    if (S.edge.running || S.signedOut) return;
    const g = gen, signal = ac.signal;
    S.edge = { running: true, samples: [], failures: 0, at: new Date().toISOString(), msg: null, done: false };
    render();
    for (let i = 0; i < PING_SAMPLES; i++) {
      const { reply, ms } = await timedGet(`${API}/ping`, signal);
      if (g !== gen) return;
      if (!reply.ok && authStatus(reply.status)) { signedOut(); return; }
      if (reply.ok) S.edge.samples.push(ms);
      else { S.edge.failures++; S.edge.msg = failMsg(reply); }
      render();
    }
    S.edge.running = false; S.edge.done = true;
    render();
  }

  async function measureBackend(): Promise<void> {
    if (S.back.running || S.signedOut) return;
    const g = gen, signal = ac.signal;
    S.back = { running: true, data: null, browserMs: null, msg: null };
    render();
    const { reply, ms } = await timedGet(`${API}/backend`, signal);
    if (g !== gen) return;
    if (!reply.ok && authStatus(reply.status)) { signedOut(); return; }
    S.back.running = false;
    if (!reply.ok) S.back.msg = failMsg(reply);
    else {
      const data = normalizeBackend(reply.body);
      if (data) { S.back.data = data; S.back.browserMs = ms; }
      else S.back.msg = { text: () => T().httpErr(502), kind: 'warn' };
    }
    render();
  }

  /** Abort everything in flight; later answers of the old generation are ignored. */
  function cancel(why: Msg): void {
    gen++; ac.abort(); ac = new AbortController();
    if (S.edge.running) { S.edge.running = false; S.edge.msg = why; }
    if (S.back.running) { S.back.running = false; S.back.msg = why; }
  }
  function signedOut(): void {
    cancel(null);
    S.signedOut = true;
    S.edge = { running: false, samples: [], failures: 0, at: null, msg: null, done: false };
    S.back = { running: false, data: null, browserMs: null, msg: null };
    render();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && (S.edge.running || S.back.running)) { cancel({ text: () => T().cancelled, kind: 'info' }); render(); }
  });

  // ── render ──
  function fact(dl: HTMLElement, k: string, v: string): void { dl.append(h('dt', '', k), h('dd', '', v)); }
  const msText = (v: number | null): string => (v === null ? T().unavailable : T().ms(v));
  const reasonText = (c: string): string => (REASONS as readonly string[]).includes(c) ? T().reason[c as Reason] : T().unknownReason(c);
  const sampleText = (s: Sample): string => (s.ms !== null ? T().ms(s.ms) : `${T().unavailable} — ${reasonText(s.reason ?? 'provider_error')}`);

  function render(): void {
    const d = T();
    document.documentElement.lang = lang; document.title = d.title;
    brand.textContent = d.brand; brandSub.textContent = d.sub;
    backLink.textContent = d.back; backLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    langNav.setAttribute('aria-label', 'Language');
    for (const b of langBtns) b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    h1.textContent = d.h1; lead.textContent = d.lead;

    gate.hidden = !S.signedOut; edgeCard.hidden = S.signedOut; backCard.hidden = S.signedOut;
    showMsg(gateMsg, S.signedOut ? { text: () => T().signedOut, kind: 'info' } : null);
    signInLink.textContent = d.signInLink; signInLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);

    // browser → edge
    edgeTitle.textContent = d.edgeTitle; edgeLead.textContent = d.edgeLead; edgeNote.textContent = d.edgeNote;
    edgeBtn.textContent = S.edge.running ? d.edgeRunning : d.edgeRun; edgeBtn.disabled = S.edge.running;
    showMsg(edgeMsg, S.edge.msg);
    edgeFacts.replaceChildren();
    const e = S.edge;
    if (e.running || e.done || e.samples.length || e.failures) {
      fact(edgeFacts, d.count, `${e.samples.length} / ${PING_SAMPLES}`);
      if (e.samples.length) {
        fact(edgeFacts, d.p50, msText(quantile(e.samples, 0.5)));
        fact(edgeFacts, d.p95, msText(quantile(e.samples, 0.95)));
        fact(edgeFacts, d.samples, e.samples.map(v => v.toFixed(1)).join(' · '));
      } else if (e.done) fact(edgeFacts, d.p50, d.edgeNone);
      if (e.failures) fact(edgeFacts, d.failed, String(e.failures));
      if (e.at) fact(edgeFacts, d.when, new Date(e.at).toLocaleString(lang));
    }

    // edge → provider
    backTitle.textContent = d.backTitle; backLead.textContent = d.backLead;
    backBtn.textContent = S.back.running ? d.backRunning : d.backRun; backBtn.disabled = S.back.running;
    showMsg(backMsg, S.back.msg);
    backFacts.replaceChildren();
    const b = S.back.data;
    backCache.hidden = !b; execNote.hidden = !b;
    if (b) {
      fact(backFacts, d.browserTrip, msText(S.back.browserMs));
      fact(backFacts, d.control, sampleText(b.apiControl));
      fact(backFacts, d.exec, sampleText(b.remoteExec));
      fact(backFacts, d.machine, b.machine.status);
      if (b.machine.providerState) fact(backFacts, d.provider, b.machine.providerState);
      if (b.measuredAt) fact(backFacts, d.measuredAt, new Date(b.measuredAt).toLocaleString(lang));
      backCache.textContent = b.cached && b.cacheAgeMs !== null ? d.cached(Math.round(b.cacheAgeMs / 1000)) : d.fresh;
      execNote.textContent = d.execNote;
    }

    // typing
    typeTitle.textContent = d.typeTitle; typeLead.textContent = d.typeLead; typeLabel.textContent = d.typeLabel;
    typeClear.textContent = d.typeClear; typeClear.disabled = !S.typing.length; typeNote.textContent = d.typeNote;
    typeFacts.replaceChildren();
    if (S.typing.length) {
      fact(typeFacts, d.count, String(S.typing.length));
      fact(typeFacts, d.p50, msText(quantile(S.typing, 0.5)));
      fact(typeFacts, d.p95, msText(quantile(S.typing, 0.95)));
    } else fact(typeFacts, d.count, d.typeNone);
  }

  render();
}

const rootEl = document.getElementById('cb-computer-latency');
if (rootEl) mount(rootEl);

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
