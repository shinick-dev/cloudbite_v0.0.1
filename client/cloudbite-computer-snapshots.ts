// Cloudbite computer snapshots (browser). tools/build-cloudbite-computer-snapshots.mjs transforms this file (no bundling) into
// src/cloudbite-computer-snapshots-page.ts → CLOUDBITE_COMPUTER_SNAPSHOTS_JS, served same-origin at /cloudbite/computer/snapshots.js
// for the page /cloudbite/computer/snapshots (?lang=ko|en).
// Sign-in stays on the main computer page (/cloudbite/computer): this page only uses the existing HttpOnly cookie, and a 401
// shows a link there. It never starts WebAuthn, reads storage or holds a token.
// A capture is a cold filesystem copy (no RAM): it is sent only after the explicit stop acknowledgement and a press of Capture,
// as one POST {requestId,name,acknowledgeStop:true} whose requestId and exact body stay in memory until the server answers
// definitely, so Retry repeats the same request. Choosing a template only marks an own finished capture for a FUTURE new
// computer; nothing is restored now and the current computer always resumes its own disk.
// The list polls only while the tab is visible, signed in and a capture is still in progress, with a backoff of at least 5 s.
// Everything is drawn with createElement/textContent. Text comes from DICT (EN/KO); server error codes are shown verbatim.

const API = '/api/cloudbite/computer';
const SNAPSHOTS_API = `${API}/snapshots`;
const SELECT_API = `${API}/snapshots/select`;
const CAPTURE_API = `${API}/snapshot`;
const COMPUTER_PATH = '/cloudbite/computer';
const NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const POLL_FIRST_MS = 5000;
const POLL_MAX_MS = 30000;
const POLL_MAX = 120;
const MAX_ITEMS = 50;

type Account = 'primary' | 'secondary' | 'tertiary';
const ACCOUNTS: Account[] = ['primary', 'secondary', 'tertiary'];
type ItemState = 'requesting' | 'unknown' | 'snapshotting' | 'active' | 'unconfirmed' | 'error' | 'missing';
const ITEM_STATES: ItemState[] = ['requesting', 'unknown', 'snapshotting', 'active', 'unconfirmed', 'error', 'missing'];
type LatestState = 'waiting_stop' | ItemState;
const BUSY: LatestState[] = ['waiting_stop', 'requesting', 'unknown', 'snapshotting'];
type Item = { name: string; account: Account; requestedAt: string | null; state: ItemState; error: string | null; selected: boolean; selectable: boolean };
type Doc = {
  items: Item[]; selected: { account: Account; name: string } | null;
  latest: { name: string; state: LatestState; error: string | null } | null;
  machine: { status: string; account: Account | null; id: string | null; template: string | null };
};
type Op = { requestId: string; json: string; phase: 'sending' | 'uncertain'; key: string };
type Reply = { ok: true; status: number; body: unknown } | { ok: false; status: number; code: string };
type Lang = 'en' | 'ko';
type Msg = { text: () => string; kind: 'ok' | 'warn' | 'info' } | null;

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Snapshots', brand: 'Cloudbite', sub: 'Snapshots', back: 'Cloud computer',
    h1: 'Computer snapshots', lead: 'Save a copy of your computer\'s disk, and choose which saved copy a new computer starts from.',
    loading: 'Loading…', loadFailed: 'Could not load your snapshots.', odd: 'The server answered in an unexpected way.', retryLoad: 'Try again',
    netErr: 'Network error — nothing was confirmed.', rejected: (c: string) => `Rejected: ${c}`,
    signedOut: 'You are not signed in to your cloud computer. Sign in on the cloud computer page, then come back.', signInLink: 'Sign in on the cloud computer page',
    checkAgain: 'Check again',
    aboutTitle: 'How snapshots work',
    about: [
      'A snapshot is a cold copy of the disk only: files and installed programs. Memory (open windows, running programs, unsaved work) is never saved.',
      'Capturing stops your computer first. Start it again afterwards from the cloud computer page.',
      'A chosen snapshot is used only when a brand-new computer is created in the same account, because none exists. Your current computer always resumes its own disk; nothing is restored into it.',
    ],
    machineTitle: 'Your computer', mStatus: 'Status', mAccount: 'Account', mTemplate: 'Created from', mPrepared: 'the prepared CloudBite image',
    noMachine: 'There is no computer yet. A new one will be created from the chosen snapshot (same account) or the prepared image.',
    status: { absent: 'No computer', starting: 'Starting', running: 'Running', stopped: 'Stopped', stopping: 'Stopping', snapshotting: 'Capturing', error: 'Error', unknown: 'Not confirmed' } as Record<string, string>,
    account: { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' } as Record<Account, string>,
    captureTitle: 'Capture a snapshot', nameLabel: 'Snapshot name', nameHint: '3–63 lowercase letters, digits or dashes, starting with a letter or digit. A name can be used once.',
    nameBad: 'Use 3–63 lowercase letters, digits or dashes.',
    ackStop: 'I understand my computer will be stopped first, and anything only in memory (open programs, unsaved work) will be lost.',
    capture: 'Capture', capturing: 'Sending…', captureNeedsMachine: 'Start a computer first — there is nothing to capture yet.',
    captureBusy: 'A capture is still in progress. Wait until it finishes.',
    captureOk: 'Capture accepted. Your computer stops first; the snapshot is ready only when the list says Ready.',
    uncertain: 'No definite answer from the server. Retry sends the same request with the same ID, so it will not happen twice.',
    retrySame: 'Retry same request', forget: 'Forget it', forgot: 'Forgotten. Refresh to see what the server recorded.',
    latestTitle: 'Latest capture', latestLine: (n: string, s: string) => `${n} — ${s}`,
    latest: {
      waiting_stop: 'Waiting for the computer to stop', requesting: 'Requested', unknown: 'Not confirmed yet — checking', snapshotting: 'Capturing',
      active: 'Ready', unconfirmed: 'Not confirmed — Daytona did not prove this capture is ours', error: 'Failed', missing: 'No longer exists',
    } as Record<LatestState, string>,
    listTitle: 'Saved snapshots', refresh: 'Refresh', listNone: 'No snapshots captured yet.', listFailed: 'Could not refresh the list.',
    pollPaused: 'Automatic refresh paused. Press Refresh to check again.', polling: 'A capture is in progress. This list refreshes by itself while the page is open.',
    requested: (t: string) => `Captured ${t}`, errorCode: (c: string) => `Error: ${c}`, chosen: 'Chosen for new computers',
    choose: 'Use for new computers', choosing: 'Saving choice…', clear: 'Clear choice', clearing: 'Clearing…',
    chooseOk: 'Saved. Only a brand-new computer in this account starts from this snapshot; the current computer is unchanged.',
    clearOk: 'Cleared. A new computer starts from the prepared image.',
    selectedLine: (n: string, a: string) => `Chosen: ${n} (${a} account) — used only for a brand-new computer.`,
    noneSelected: 'No snapshot chosen. A new computer starts from the prepared image.',
  },
  ko: {
    title: 'Cloudbite — 스냅샷', brand: 'Cloudbite', sub: '스냅샷', back: '클라우드 컴퓨터',
    h1: '컴퓨터 스냅샷', lead: '컴퓨터 디스크의 사본을 저장하고, 새 컴퓨터가 어느 사본에서 시작할지 고릅니다.',
    loading: '불러오는 중…', loadFailed: '스냅샷을 불러오지 못했습니다.', odd: '서버가 예상과 다른 형태로 답했습니다.', retryLoad: '다시 시도',
    netErr: '네트워크 오류 — 확인된 것이 없습니다.', rejected: (c: string) => `거부됨: ${c}`,
    signedOut: '클라우드 컴퓨터에 로그인되어 있지 않습니다. 클라우드 컴퓨터 페이지에서 로그인한 뒤 돌아오세요.', signInLink: '클라우드 컴퓨터 페이지에서 로그인',
    checkAgain: '다시 확인',
    aboutTitle: '스냅샷 동작 방식',
    about: [
      '스냅샷은 디스크만 차갑게 복사합니다: 파일과 설치한 프로그램. 메모리(열린 창, 실행 중인 프로그램, 저장하지 않은 작업)는 저장하지 않습니다.',
      '캡처하면 먼저 컴퓨터를 중지합니다. 끝난 뒤 클라우드 컴퓨터 페이지에서 다시 시작하세요.',
      '고른 스냅샷은 같은 계정에 컴퓨터가 없어 새 컴퓨터를 만들 때만 쓰입니다. 지금 컴퓨터는 항상 자기 디스크로 다시 켜지며, 스냅샷을 덮어쓰지 않습니다.',
    ],
    machineTitle: '내 컴퓨터', mStatus: '상태', mAccount: '계정', mTemplate: '만든 원본', mPrepared: 'CloudBite 기본 이미지',
    noMachine: '아직 컴퓨터가 없습니다. 새 컴퓨터는 고른 스냅샷(같은 계정) 또는 기본 이미지에서 만들어집니다.',
    status: { absent: '컴퓨터 없음', starting: '시작 중', running: '실행 중', stopped: '중지됨', stopping: '중지 중', snapshotting: '캡처 중', error: '오류', unknown: '확인 안 됨' } as Record<string, string>,
    account: { primary: '기본', secondary: '보조', tertiary: '세 번째' } as Record<Account, string>,
    captureTitle: '스냅샷 캡처', nameLabel: '스냅샷 이름', nameHint: '영문 소문자·숫자·대시 3~63자, 첫 글자는 영문 소문자나 숫자. 같은 이름은 한 번만 쓸 수 있습니다.',
    nameBad: '영문 소문자·숫자·대시 3~63자를 쓰세요.',
    ackStop: '먼저 컴퓨터가 중지되며, 메모리에만 있는 것(열린 프로그램, 저장하지 않은 작업)은 사라짐을 이해합니다.',
    capture: '캡처', capturing: '보내는 중…', captureNeedsMachine: '먼저 컴퓨터를 시작하세요 — 아직 캡처할 것이 없습니다.',
    captureBusy: '캡처가 아직 진행 중입니다. 끝날 때까지 기다리세요.',
    captureOk: '캡처가 접수되었습니다. 먼저 컴퓨터를 중지하며, 목록에 준비됨이라고 나올 때만 스냅샷이 준비된 것입니다.',
    uncertain: '서버의 확실한 답이 없습니다. 다시 보내기는 같은 ID 의 같은 요청이라 두 번 일어나지 않습니다.',
    retrySame: '같은 요청 다시 보내기', forget: '잊기', forgot: '잊었습니다. 새로 고침으로 서버 기록을 확인하세요.',
    latestTitle: '최근 캡처', latestLine: (n: string, s: string) => `${n} — ${s}`,
    latest: {
      waiting_stop: '컴퓨터 중지를 기다리는 중', requesting: '요청함', unknown: '아직 확인 안 됨 — 확인 중', snapshotting: '캡처 중',
      active: '준비됨', unconfirmed: '확인 안 됨 — Daytona 가 이 캡처가 내 것임을 증명하지 않았습니다', error: '실패', missing: '더 이상 없음',
    } as Record<LatestState, string>,
    listTitle: '저장된 스냅샷', refresh: '새로 고침', listNone: '아직 캡처한 스냅샷이 없습니다.', listFailed: '목록을 새로 고치지 못했습니다.',
    pollPaused: '자동 새로 고침을 멈췄습니다. 새로 고침을 눌러 다시 확인하세요.', polling: '캡처가 진행 중입니다. 페이지가 열려 있는 동안 목록이 스스로 새로 고쳐집니다.',
    requested: (t: string) => `캡처 ${t}`, errorCode: (c: string) => `오류: ${c}`, chosen: '새 컴퓨터용으로 선택됨',
    choose: '새 컴퓨터에 사용', choosing: '선택 저장 중…', clear: '선택 해제', clearing: '해제 중…',
    chooseOk: '저장했습니다. 이 계정에서 새로 만드는 컴퓨터만 이 스냅샷에서 시작하며, 지금 컴퓨터는 바뀌지 않습니다.',
    clearOk: '해제했습니다. 새 컴퓨터는 기본 이미지에서 시작합니다.',
    selectedLine: (n: string, a: string) => `선택됨: ${n} (${a} 계정) — 새로 만드는 컴퓨터에만 쓰입니다.`,
    noneSelected: '고른 스냅샷이 없습니다. 새 컴퓨터는 기본 이미지에서 시작합니다.',
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const acct = (v: unknown): Account | null => (ACCOUNTS.includes(v as Account) ? v as Account : null);
const code = (v: unknown): string | null => { const c = str(v, 64); return c ? (SAFE_CODE.test(c) ? c : 'error') : null; };

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('no crypto');
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function errorCode(body: unknown): string {
  if (!isObj(body)) return '';
  const e = body.error;
  const c = isObj(e) ? str(e.code, 64) : str(e, 64);
  return SAFE_CODE.test(c) ? c : '';
}

/** POST bodies are passed already serialised so a retry sends exactly the same bytes */
async function call(path: string, signal: AbortSignal, json?: string): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(path, json === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: json, signal });
  } catch { return { ok: false, status: 0, code: '' }; }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  if (res.ok && isObj(parsed) && parsed.ok === true && (parsed.error === undefined || parsed.error === null)) return { ok: true, status: res.status, body: parsed };
  return { ok: false, status: res.ok ? 502 : res.status, code: errorCode(parsed) };
}
/** No answer, a server-side failure or a throttle: the request may or may not have happened */
const uncertainStatus = (s: number): boolean => s === 0 || s === 408 || s === 429 || s >= 500;
const authStatus = (s: number): boolean => s === 401 || s === 403;

function normalizeItem(raw: unknown): Item | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 63), account = acct(raw.account);
  if (!NAME.test(name) || !account) return null;
  const state: ItemState = ITEM_STATES.includes(raw.state as ItemState) ? raw.state as ItemState : 'unknown';
  return { name, account, requestedAt: iso(raw.requestedAt), state, error: code(raw.error), selected: raw.selected === true, selectable: raw.selectable === true && state === 'active' };
}

function normalizeDoc(raw: unknown): Doc | null {
  if (!isObj(raw) || !Array.isArray(raw.items) || !isObj(raw.machine)) return null;
  const m = raw.machine;
  const items = raw.items.slice(0, MAX_ITEMS).map(normalizeItem).filter((i): i is Item => !!i);
  let selected: Doc['selected'] = null;
  if (isObj(raw.selected)) {
    const a = acct(raw.selected.account), n = str(raw.selected.name, 63);
    if (!a || !NAME.test(n)) return null;
    selected = { account: a, name: n };
  } else if (raw.selected !== null) return null;
  let latest: Doc['latest'] = null;
  if (isObj(raw.latest)) {
    const n = str(raw.latest.name, 63), st = raw.latest.state as LatestState;
    if (NAME.test(n)) latest = { name: n, state: st === 'waiting_stop' || ITEM_STATES.includes(st as ItemState) ? st : 'unknown', error: code(raw.latest.error) };
  }
  const id = str(m.id, 120), tpl = str(m.template, 63);
  return {
    items, selected, latest,
    machine: { status: str(m.status, 20) || 'unknown', account: acct(m.account), id: SAFE_ID.test(id) ? id : null, template: NAME.test(tpl) ? tpl : null },
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
  if (m) { el.textContent = m.text(); el.className = `cs-msg cs-${m.kind}`; }
}

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const qs = params.get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;

  const S = {
    auth: 'loading' as 'loading' | 'in' | 'out' | 'failed', doc: null as Doc | null, loading: false, loadMsg: null as Msg, listMsg: null as Msg,
    ack: false, capOp: null as Op | null, capMsg: null as Msg, selOp: null as Op | null, selMsg: null as Msg, pollPaused: false,
  };
  // gen is bumped on sign-out: every answer that arrives later is dropped and in-flight requests are aborted.
  // seq drops an older list answer that arrives after a newer one.
  let gen = 0, seq = 0, ac = new AbortController();
  let pollTimer: ReturnType<typeof setTimeout> | null = null, polls = 0;

  // ── skeleton ──
  const brand = h('strong', 'cs-brand'), brandSub = h('span', 'cs-sub');
  const backLink = link('cs-nav-link', COMPUTER_PATH);
  const langNav = h('nav', 'cs-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = button('cs-lang-btn', () => { if (lang !== l) { lang = l; render(); } });
    b.textContent = l.toUpperCase(); b.setAttribute('lang', l);
    langNav.append(b);
    return b;
  });
  const header = h('header', 'cs-header', h('div', 'cs-brand-row', brand, brandSub), h('div', 'cs-header-side', backLink, langNav));
  const h1 = h('h1'), lead = h('p', 'cs-lead');

  const loadMsg = h('p', 'cs-msg');
  loadMsg.setAttribute('role', 'status');
  const signInLink = link('cs-btn cs-primary', COMPUTER_PATH);
  const checkBtn = button('cs-btn', () => { void load(); });
  const gate = h('section', 'cs-card', loadMsg, h('div', 'cs-actions', signInLink, checkBtn));

  const aboutTitle = h('h2'), aboutList = h('ul', 'cs-about');
  const aboutCard = h('section', 'cs-card cs-note', aboutTitle, aboutList);

  const machineTitle = h('h2'), machineFacts = h('dl', 'cs-facts'), machineNote = h('p', 'cs-fine');
  const machineCard = h('section', 'cs-card', machineTitle, machineFacts, machineNote);

  // capture: name + explicit stop acknowledgement, then one POST
  const captureTitle = h('h2');
  const nameLabel = h('label', 'cs-field-label'), nameIn = h('input', 'cs-input'), nameHint = h('p', 'cs-fine');
  nameIn.id = 'cs-name'; nameLabel.setAttribute('for', 'cs-name');
  for (const [k, v] of [['autocomplete', 'off'], ['autocapitalize', 'none'], ['spellcheck', 'false'], ['maxlength', '63'], ['inputmode', 'text'], ['placeholder', 'my-setup-1']]) nameIn.setAttribute(k, v);
  nameIn.addEventListener('input', () => { S.capMsg = null; render(); });
  const ackIn = h('input'), ackText = h('span');
  ackIn.setAttribute('type', 'checkbox');
  ackIn.addEventListener('change', () => { S.ack = ackIn.checked; render(); });
  const ackRow = h('label', 'cs-check', ackIn, ackText);
  const captureBtn = button('cs-btn cs-primary', () => { void capture(); });
  const capRetry = button('cs-btn cs-primary', () => { if (S.capOp) void sendCapture(S.capOp); });
  const capForget = button('cs-btn cs-quiet', () => { S.capOp = null; S.capMsg = { text: () => T().forgot, kind: 'info' }; render(); void load(); });
  const capMsg = h('p', 'cs-msg');
  capMsg.setAttribute('role', 'status');
  const captureCard = h('section', 'cs-card', captureTitle, h('div', 'cs-field', nameLabel, nameIn, nameHint), ackRow, capMsg,
    h('div', 'cs-actions', captureBtn, capRetry, capForget));

  // list
  const listTitle = h('h2'), listMsg = h('p', 'cs-msg'), pollNote = h('p', 'cs-fine'), latestLine = h('p', 'cs-latest');
  listMsg.setAttribute('role', 'status');
  const refreshBtn = button('cs-btn cs-quiet', () => { polls = 0; S.pollPaused = false; void load(); });
  const selectedLine = h('p', 'cs-fine'), clearBtn = button('cs-btn', () => { void select(null); });
  const selRetry = button('cs-btn cs-primary', () => { if (S.selOp) void sendSelect(S.selOp); });
  const selForget = button('cs-btn cs-quiet', () => { S.selOp = null; S.selMsg = { text: () => T().forgot, kind: 'info' }; render(); void load(); });
  const selMsg = h('p', 'cs-msg');
  selMsg.setAttribute('role', 'status');
  const list = h('ul', 'cs-items');
  const listCard = h('section', 'cs-card', h('div', 'cs-head', listTitle, refreshBtn), listMsg, latestLine, pollNote, selectedLine, selMsg,
    h('div', 'cs-actions', clearBtn, selRetry, selForget), list);

  const work = h('div', 'cs-grid', h('div', 'cs-stack', machineCard, captureCard, aboutCard), listCard);
  root.replaceChildren(header, h('main', 'cs-main', h1, lead, gate, work));

  // ── data ──
  async function load(): Promise<void> {
    const g = gen, s = ++seq;
    S.loading = true; if (S.auth !== 'in') S.auth = 'loading'; render();
    const res = await call(SNAPSHOTS_API, ac.signal);
    if (g !== gen || s !== seq) return;
    S.loading = false;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    const doc = res.ok ? normalizeDoc(res.body) : null;
    if (!doc) {
      const m = res.ok ? 'odd' : res.status === 0 ? 'net' : res.code || String(res.status);
      const msg: Msg = { text: () => `${S.auth === 'in' ? T().listFailed : T().loadFailed} ${m === 'odd' ? T().odd : m === 'net' ? T().netErr : T().rejected(m)}`, kind: 'warn' };
      if (S.auth === 'in') S.listMsg = msg; else { S.loadMsg = msg; S.auth = 'failed'; }
      render(); schedule(); return;
    }
    S.doc = doc; S.auth = 'in'; S.loadMsg = null; S.listMsg = null;
    render(); schedule();
  }

  async function capture(): Promise<void> {
    const name = nameIn.value.trim();
    if (S.capOp || S.auth !== 'in' || !S.ack || !canCapture()) return;
    if (!NAME.test(name)) { S.capMsg = { text: () => T().nameBad, kind: 'warn' }; render(); return; }
    const requestId = uuid();
    await sendCapture({ requestId, json: JSON.stringify({ requestId, name, acknowledgeStop: true }), phase: 'sending', key: name });
  }

  async function sendCapture(op: Op): Promise<void> {
    // a different pending request, or this one still in flight: never a second send
    if (S.auth !== 'in' || (S.capOp && (S.capOp !== op || op.phase === 'sending'))) return;
    op.phase = 'sending'; S.capOp = op; S.capMsg = { text: () => T().capturing, kind: 'info' }; render();
    const g = gen;
    const res = await call(CAPTURE_API, ac.signal, op.json);
    if (g !== gen || S.capOp !== op) return;
    if (res.ok) {
      S.capOp = null; S.ack = false; nameIn.value = '';
      S.capMsg = { text: () => T().captureOk, kind: 'ok' };
      polls = 0; S.pollPaused = false; render(); void load(); return;
    }
    if (authStatus(res.status)) { signedOut(); return; }
    if (uncertainStatus(res.status)) { op.phase = 'uncertain'; S.capMsg = { text: () => T().uncertain, kind: 'warn' }; render(); return; }
    // a definite rejection: nothing was captured; the typed name stays for editing
    const c = res.code || String(res.status);
    S.capOp = null; S.capMsg = { text: () => T().rejected(c), kind: 'warn' }; render();
  }

  async function select(item: Item | null): Promise<void> {
    const d = S.doc;
    if (S.selOp || S.auth !== 'in' || !d) return;
    const account = item ? item.account : d.selected?.account;
    if (!account) return;
    const requestId = uuid(), name = item ? item.name : null;
    await sendSelect({ requestId, json: JSON.stringify({ requestId, account, name }), phase: 'sending', key: name === null ? '' : `${account}/${name}` });
  }

  async function sendSelect(op: Op): Promise<void> {
    if (S.auth !== 'in' || (S.selOp && (S.selOp !== op || op.phase === 'sending'))) return;
    op.phase = 'sending'; S.selOp = op; S.selMsg = null; render();
    const g = gen;
    const res = await call(SELECT_API, ac.signal, op.json);
    if (g !== gen || S.selOp !== op) return;
    if (res.ok) {
      S.selOp = null;
      const doc = normalizeDoc(res.body);
      if (doc) S.doc = doc;
      S.selMsg = { text: () => (op.key ? T().chooseOk : T().clearOk), kind: 'ok' };
      render(); if (!doc) void load(); return;
    }
    if (authStatus(res.status)) { signedOut(); return; }
    if (uncertainStatus(res.status)) { op.phase = 'uncertain'; S.selMsg = { text: () => T().uncertain, kind: 'warn' }; render(); return; }
    const c = res.code || String(res.status);
    S.selOp = null; S.selMsg = { text: () => T().rejected(c), kind: 'warn' }; render(); void load();
  }

  // Sign-out (any 401/403): abort everything in flight and forget the list and pending requests; the typed name stays.
  function signedOut(): void {
    gen++; ac.abort(); ac = new AbortController(); stopPoll();
    Object.assign(S, { auth: 'out', doc: null, loading: false, loadMsg: null, listMsg: null, ack: false, capOp: null, capMsg: null, selOp: null, selMsg: null, pollPaused: false });
    render();
  }

  // ── polling: only while visible, signed in and a capture is still unsettled; ≥ 5 s with backoff ──
  const latestBusy = (): boolean => !!S.doc?.latest && BUSY.includes(S.doc.latest.state);
  function pendingWork(): boolean {
    return latestBusy() || (S.doc?.items || []).some(i => i.state === 'requesting' || i.state === 'unknown' || i.state === 'snapshotting');
  }
  function stopPoll(): void { if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } }
  function schedule(): void {
    stopPoll();
    if (S.auth !== 'in' || document.visibilityState !== 'visible' || !pendingWork()) return;
    if (polls >= POLL_MAX) { S.pollPaused = true; render(); return; }
    const delay = Math.min(POLL_MAX_MS, Math.round(POLL_FIRST_MS * 1.5 ** Math.min(polls, 10)));
    pollTimer = setTimeout(() => { pollTimer = null; polls++; void load(); }, delay);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { polls = 0; S.pollPaused = false; if (S.auth === 'in') void load(); }
    else stopPoll();
  });

  const canCapture = (): boolean => {
    const m = S.doc?.machine;
    return !!m && !!m.account && ['running', 'starting', 'stopped', 'stopping'].includes(m.status) && !latestBusy();
  };

  // ── render ──
  function fact(dl: HTMLElement, k: string, v: string): void { dl.append(h('dt', '', k), h('dd', '', v)); }
  const when = (t: string | null): string => (t ? new Date(t).toLocaleString(lang) : '');

  function render(): void {
    const d = T();
    document.documentElement.lang = lang; document.title = d.title;
    brand.textContent = d.brand; brandSub.textContent = d.sub;
    backLink.textContent = d.back; backLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    langNav.setAttribute('aria-label', 'Language');
    for (const b of langBtns) b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    h1.textContent = d.h1; lead.textContent = d.lead;

    const inside = S.auth === 'in' && !!S.doc;
    gate.hidden = inside; work.hidden = !inside;
    showMsg(loadMsg, S.auth === 'out' ? { text: () => T().signedOut, kind: 'info' } : S.auth === 'failed' ? S.loadMsg : { text: () => T().loading, kind: 'info' });
    signInLink.textContent = d.signInLink; signInLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    signInLink.hidden = S.auth !== 'out';
    checkBtn.textContent = S.auth === 'out' ? d.checkAgain : d.retryLoad;
    checkBtn.hidden = S.auth === 'loading'; checkBtn.disabled = S.loading;
    if (!inside || !S.doc) return;
    const doc = S.doc, m = doc.machine;

    aboutTitle.textContent = d.aboutTitle;
    aboutList.replaceChildren(...d.about.map(t => h('li', '', t)));

    machineTitle.textContent = d.machineTitle;
    machineFacts.replaceChildren();
    fact(machineFacts, d.mStatus, d.status[m.status] || m.status);
    if (m.account) fact(machineFacts, d.mAccount, d.account[m.account]);
    if (m.account) fact(machineFacts, d.mTemplate, m.template || d.mPrepared);
    machineNote.textContent = d.noMachine; machineNote.hidden = !!m.account;

    captureTitle.textContent = d.captureTitle;
    nameLabel.textContent = d.nameLabel; nameHint.textContent = d.nameHint;
    const capSending = !!S.capOp;
    nameIn.disabled = capSending;
    ackText.textContent = d.ackStop; ackIn.checked = S.ack; ackIn.disabled = capSending;
    captureBtn.textContent = S.capOp?.phase === 'sending' ? d.capturing : d.capture;
    captureBtn.hidden = S.capOp?.phase === 'uncertain';
    captureBtn.disabled = capSending || !S.ack || !canCapture() || !NAME.test(nameIn.value.trim());
    capRetry.textContent = d.retrySame; capRetry.hidden = S.capOp?.phase !== 'uncertain';
    capForget.textContent = d.forget; capForget.hidden = S.capOp?.phase !== 'uncertain';
    const capHint: Msg = !canCapture() && !S.capOp ? { text: () => (latestBusy() ? T().captureBusy : T().captureNeedsMachine), kind: 'info' } : null;
    showMsg(capMsg, S.capMsg || capHint);

    listTitle.textContent = d.listTitle;
    refreshBtn.textContent = d.refresh; refreshBtn.setAttribute('aria-busy', String(S.loading));
    showMsg(listMsg, S.listMsg);
    const lt = doc.latest;
    latestLine.hidden = !lt;
    if (lt) latestLine.textContent = `${d.latestTitle}: ${d.latestLine(lt.name, d.latest[lt.state])}${lt.error ? ` · ${d.errorCode(lt.error)}` : ''}`;
    pollNote.textContent = S.pollPaused ? d.pollPaused : d.polling; pollNote.hidden = !S.pollPaused && !pendingWork();
    selectedLine.textContent = doc.selected ? d.selectedLine(doc.selected.name, d.account[doc.selected.account]) : d.noneSelected;
    const selSending = S.selOp?.phase === 'sending';
    clearBtn.textContent = selSending && S.selOp?.key === '' ? d.clearing : d.clear;
    clearBtn.hidden = !doc.selected || S.selOp?.phase === 'uncertain'; clearBtn.disabled = !!S.selOp;
    selRetry.textContent = d.retrySame; selRetry.hidden = S.selOp?.phase !== 'uncertain';
    selForget.textContent = d.forget; selForget.hidden = S.selOp?.phase !== 'uncertain';
    showMsg(selMsg, S.selMsg);
    list.replaceChildren(...(doc.items.length ? doc.items.map(item) : [h('li', 'cs-muted', d.listNone)]));
  }

  function item(i: Item): HTMLLIElement {
    const d = T();
    const head = h('div', 'cs-item-head', h('strong', '', i.name), h('span', `cs-pill cs-s-${i.state}`, d.latest[i.state]));
    const li = h('li', i.selected ? 'cs-item cs-chosen' : 'cs-item', head);
    li.setAttribute('data-snapshot', `${i.account}/${i.name}`);
    li.append(h('p', 'cs-fine', `${d.account[i.account]}${i.requestedAt ? ` · ${d.requested(when(i.requestedAt))}` : ''}`));
    if (i.error) li.append(h('p', 'cs-fine cs-bad', d.errorCode(i.error)));
    if (i.selected) li.append(h('p', 'cs-badge', d.chosen));
    if (i.selectable) {
      const b = button('cs-btn', () => { void select(i); });
      b.textContent = S.selOp?.phase === 'sending' && S.selOp.key === `${i.account}/${i.name}` ? d.choosing : d.choose;
      b.disabled = !!S.selOp;
      li.append(h('div', 'cs-actions', b));
    }
    return li;
  }

  render();
  void load();
}

const rootEl = document.getElementById('cb-computer-snapshots');
if (rootEl) mount(rootEl);

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
