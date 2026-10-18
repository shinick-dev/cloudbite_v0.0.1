// Cloudbite 방문자 접근 페이지 (브라우저). tools/build-cloudbite-access.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-access-page.ts 의
// CLOUDBITE_ACCESS_JS 로 고정한다. 같은 출처 외부 스크립트이며 화면은 전부 textContent·createElement 로만 그린다.
//   data-view="request"  /cloudbite/request  — 방문자가 이름·목적을 보내고, 주인 승인 상태를 5초마다 확인한다 (서버 HttpOnly 쿠키, JS 는 읽지 않음)
//   data-view="owner"    /cloudbite/requests — 주인이 관리자 세션 또는 임시 Cloudbite 운영자 토큰(메모리에만)으로 승인·거절·회수한다
// 승인은 서버 응답이 성공한 뒤에만 화면에 보인다. 자격 증명은 저장소·주소·쿼리에 두지 않는다. 화면 문구는 영어다.
import type { CloudbiteAccessRequest, CloudbiteAccessSession } from '../src/cloudbite-access-contract';

type AccessStatus = CloudbiteAccessRequest['status'];
const STATUSES: AccessStatus[] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
const STATUS_LABEL: Record<AccessStatus, string> = { pending: 'Waiting for approval', approved: 'Approved', denied: 'Denied', revoked: 'Revoked', expired: 'Expired' };
const LIMIT = { name: 80, purpose: 1000 };
const POLL_MS = 5000;
const MAX_POLL_FAILS = 4;
const API = '/api/cloudbite/access';
const CONSOLE_PATH = '/cloudbite';
const REQUEST_PATH = '/cloudbite/request';

// ───────────────────────── 값 정리 (서버가 보낸 것도 의심한다) ─────────────────────────

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function str(v: unknown, n: number, fallback = ''): string { return typeof v === 'string' ? clip(v, n) : fallback; }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function count(v: unknown, max: number): number { const n = num(v); return n !== null && n >= 0 ? Math.min(Math.floor(n), max) : 0; }
function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

function normalizeRequest(raw: unknown): CloudbiteAccessRequest | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 120);
  const status = raw.status as AccessStatus;
  if (!id || !STATUSES.includes(status)) return null;
  return {
    id, status, name: str(raw.name, LIMIT.name), purpose: str(raw.purpose, LIMIT.purpose),
    createdAt: count(raw.createdAt, Number.MAX_SAFE_INTEGER), expiresAt: count(raw.expiresAt, Number.MAX_SAFE_INTEGER),
    maxExperts: count(raw.maxExperts, 100), maxProjects: count(raw.maxProjects, 100), usedProjects: count(raw.usedProjects, 100),
  };
}

/** null = 형식이 틀린 응답. request 가 있는데 깨졌으면 없는 것으로 치지 않고 형식 오류로 본다 */
function normalizeSession(raw: unknown): CloudbiteAccessSession | null {
  if (!isObj(raw)) return null;
  const has = raw.request !== null && raw.request !== undefined;
  const request = has ? normalizeRequest(raw.request) : null;
  if (has && !request) return null;
  return { request, canCreate: raw.canCreate === true };
}

/** 만료 시각이 지난 승인·대기는 서버가 아직 바꾸지 않았어도 화면에서는 만료로 보인다 */
function effectiveStatus(r: CloudbiteAccessRequest, now: number): AccessStatus {
  return (r.status === 'pending' || r.status === 'approved') && r.expiresAt > 0 && r.expiresAt <= now ? 'expired' : r.status;
}

function validateRequest(name: string, purpose: string): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push('Enter your name.');
  if (name.trim().length > LIMIT.name) errors.push(`Your name must be ${LIMIT.name} characters or fewer.`);
  if (!purpose.trim()) errors.push('Tell the host what you want to try.');
  if (purpose.trim().length > LIMIT.purpose) errors.push(`The purpose must be ${LIMIT.purpose} characters or fewer.`);
  return errors;
}

// 임시 Cloudbite 운영자 토큰: 콘솔(client/cloudbite-console.ts)·서버(src/cloudbite-operator.ts)와 같은 모양만 받는다
const OPERATOR_TOKEN = /^cbo_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isOperatorToken = (t: string) => t.trim().startsWith('cbo_');
function operatorFragment(hash: string): { present: boolean; token: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const hit = raw.split('&').find(p => p === 'operator' || p.startsWith('operator='));
  const value = hit === undefined ? null : hit.slice('operator='.length);
  return { present: hit !== undefined || raw.includes('cbo_'), token: value !== null && OPERATOR_TOKEN.test(value) ? value : '' };
}
/** 운영자 조각을 메모리로 옮기고 어떤 요청보다 먼저 주소창·현재 기록 항목에서 지운다 */
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

function clock(at: number): string {
  if (!at) return '—';
  const d = new Date(at), p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function remaining(at: number, now: number): string {
  if (!at) return '';
  const min = Math.ceil((at - now) / 60_000);
  return min <= 0 ? 'now' : min < 60 ? `in ${plural(min, 'minute')}` : `in ${plural(Math.round(min / 60), 'hour')}`;
}

// ───────────────────────── 요청 ─────────────────────────

type Reply = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };
async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) });
  } catch {
    return { ok: false, status: 0, error: '' };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* 본문 없음·형식 오류 */ }
  if (res.ok) return { ok: true, status: res.status, body };
  return { ok: false, status: res.status, error: isObj(body) ? str(body.error, 200) : '' };
}

function visitorError(r: Extract<Reply, { ok: false }>): string {
  const base = r.status === 0 ? 'Could not reach Cloudbite. Check your connection and try again.'
    : r.status === 400 ? 'The request was not accepted. Check your name and purpose.'
      : r.status === 409 ? 'You already have an access request in this browser.'
        : r.status === 413 ? 'The request is too long. Shorten the purpose.'
          : r.status === 429 ? 'Too many requests. Wait a minute and try again.'
            : r.status === 503 ? 'Access requests are not available right now.'
              : `Cloudbite returned an error (HTTP ${r.status}).`;
  return r.error ? `${base} — ${r.error}` : base;
}

function ownerError(r: Extract<Reply, { ok: false }>, operator: boolean): string {
  const base = r.status === 0 ? 'Could not reach Cloudbite. Check the connection and try again.'
    : r.status === 401 || r.status === 403 ? (operator ? 'The temporary Cloudbite operator token was rejected or has expired. Ask for a new link.' : 'The admin session was rejected or has expired. Paste a current one.')
      : r.status === 404 ? 'That request no longer exists.'
        : r.status === 409 ? 'That request has already changed state.'
          : r.status === 429 ? 'Too many requests. Wait a moment and try again.'
            : `Cloudbite returned an error (HTTP ${r.status}).`;
  return r.error ? `${base} — ${r.error}` : base;
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
    else if (k === 'value' || k === 'disabled' || k === 'hidden') (n as unknown as Record<string, unknown>)[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
function fill(n: Element, ...kids: Kid[]): void { n.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false)); }
const visible = () => (document as { visibilityState?: string }).visibilityState !== 'hidden';
function header(sub: string): HTMLElement {
  return h('header', { class: 'ax-top' }, h('a', { class: 'ax-brand', href: CONSOLE_PATH }, 'Cloudbite'), h('span', null, sub));
}
function counter(inp: HTMLInputElement | HTMLTextAreaElement, max: number): HTMLElement {
  const c = h('span', { class: 'ax-count', 'aria-hidden': 'true' });
  const upd = () => { c.textContent = `${inp.value.length} / ${max}`; };
  inp.addEventListener('input', upd); upd();
  return c;
}
function pill(s: AccessStatus): HTMLElement { return h('span', { class: `ax-pill s-${s}` }, STATUS_LABEL[s]); }

// ───────────────────────── 방문자: 요청 + 상태 ─────────────────────────

function visitorPage(root: HTMLElement): void {
  const V = {
    phase: 'loading' as 'loading' | 'ready' | 'error',
    session: null as CloudbiteAccessSession | null,
    error: '', submitting: false, showForm: false, pollFails: 0, formErrors: [] as string[],
  };
  let timer = 0, checking = false;

  const nameIn = h('input', { id: 'ax-name', type: 'text', maxlength: LIMIT.name, autocomplete: 'name', required: true });
  const purposeIn = h('textarea', { id: 'ax-purpose', rows: 4, maxlength: LIMIT.purpose, required: true });
  const submitBtn = h('button', { type: 'submit', class: 'ax-button primary' });
  const formMsg = h('div', { class: 'ax-msg', role: 'alert' });
  const form = h('form', { class: 'ax-form', novalidate: true, 'aria-label': 'Request Cloudbite access' },
    h('div', { class: 'ax-field' }, h('label', { for: 'ax-name' }, 'Your name'), nameIn, counter(nameIn, LIMIT.name)),
    h('div', { class: 'ax-field' }, h('label', { for: 'ax-purpose' }, 'What would you like to try with Cloudbite?'), purposeIn, counter(purposeIn, LIMIT.purpose),
      h('p', { class: 'ax-help' }, 'For example: “Have a product, a security and a UX expert review my launch plan.”')),
    formMsg, h('div', { class: 'ax-actions' }, submitBtn));
  form.addEventListener('submit', ev => { ev.preventDefault(); void submit(); });
  const statusBox = h('div', { class: 'ax-status', 'aria-live': 'polite' });
  const panel = h('section', { class: 'ax-panel', 'aria-labelledby': 'ax-request-h' }, h('h2', { id: 'ax-request-h' }, 'Your request'), statusBox, form);

  root.replaceChildren(header('Visitor access'),
    h('main', { class: 'ax-main' },
      h('h1', null, 'Request access to Cloudbite'),
      h('p', { class: 'ax-lead' }, 'Cloudbite runs one shared project with several AI expert roles, each in its own workspace. Ask the host for a short session to try it yourself.'),
      h('div', { class: 'ax-grid' }, panel,
        h('section', { class: 'ax-steps', 'aria-labelledby': 'ax-how' }, h('h2', { id: 'ax-how' }, 'What happens next'),
          h('ol', null,
            h('li', null, h('strong', null, 'Send your request.'), h('span', null, 'Keep this page open. It checks for the host\'s answer every few seconds.')),
            h('li', null, h('strong', null, 'The host reviews it.'), h('span', null, 'The host approves or declines from the owner inbox. Requests wait up to 30 minutes.')),
            h('li', null, h('strong', null, 'Open Cloudbite.'), h('span', null, 'An approved session lasts one hour: write one project brief, choose up to five AI experts, then run and inspect their work.'))),
          h('p', { class: 'ax-note' }, 'Nothing runs until you press Run experts in Cloudbite. Approval does not create resources by itself.')))));
  document.addEventListener('visibilitychange', () => { if (visible() && pending() && !timer && !checking) void check(); });

  function pending(): boolean { const r = V.session?.request; return !!r && effectiveStatus(r, Date.now()) === 'pending'; }
  function stopPoll(): void { clearTimeout(timer); timer = 0; }
  function schedule(): void {
    stopPoll();
    if (pending() && visible() && V.pollFails < MAX_POLL_FAILS) timer = setTimeout(() => { timer = 0; void check(); }, POLL_MS) as unknown as number;
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    const r = await call(`${API}/status`);
    checking = false;
    if (r.ok) {
      const s = normalizeSession(r.body);
      if (s) { V.session = s; V.phase = 'ready'; V.error = ''; V.pollFails = 0; }
      else { V.pollFails++; V.error = 'Cloudbite sent a status in an unexpected format.'; if (!V.session) V.phase = 'error'; }
    } else {
      V.pollFails++; V.error = visitorError(r);
      if (!V.session) V.phase = 'error';
    }
    render(); schedule();
  }

  async function submit(): Promise<void> {
    if (V.submitting) return;
    const name = nameIn.value.trim(), purpose = purposeIn.value.trim();
    V.formErrors = validateRequest(name, purpose);
    if (V.formErrors.length) { render(); return; }
    V.submitting = true; render();
    const r = await call(`${API}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, purpose }) });
    V.submitting = false;
    if (!r.ok) { V.formErrors = [visitorError(r)]; render(); if (r.status === 409) void check(); return; }
    const s = normalizeSession(r.body);
    if (!s || !s.request) { V.formErrors = ['Cloudbite accepted the request but sent an unexpected reply. Reload this page to check its status.']; render(); return; }
    V.session = s; V.phase = 'ready'; V.showForm = false; V.formErrors = []; V.pollFails = 0; V.error = '';
    render(); schedule();
  }

  function render(): void {
    const now = Date.now();
    const req = V.session?.request ?? null;
    const st = req ? effectiveStatus(req, now) : null;
    const kids: Kid[] = [];
    if (V.phase === 'loading') kids.push(h('p', { class: 'ax-help' }, 'Checking for an existing request…'));
    else if (V.phase === 'error') kids.push(h('p', { class: 'ax-warn' }, V.error), h('button', { type: 'button', class: 'ax-button', onclick: () => { V.pollFails = 0; V.phase = 'loading'; render(); void check(); } }, 'Check again'));
    else if (req && st) {
      kids.push(h('div', { class: 'ax-req-head' }, pill(st), h('strong', { class: 'ax-req-name' }, req.name)), h('p', { class: 'ax-purpose' }, req.purpose));
      if (st === 'pending') {
        kids.push(h('p', null, 'The host has your request. This page checks every 5 seconds while it is open — you do not need to reload.'),
          h('p', { class: 'ax-help' }, `The request expires at ${clock(req.expiresAt)} (${remaining(req.expiresAt, now)}) if nobody answers.`));
      } else if (st === 'approved') {
        const left = Math.max(0, req.maxProjects - req.usedProjects);
        kids.push(h('p', { class: 'ax-ok' }, 'You are approved. Your Cloudbite session is ready in this browser.'),
          h('ul', { class: 'ax-facts' },
            h('li', null, `Session ends at ${clock(req.expiresAt)} (${remaining(req.expiresAt, now)})`),
            h('li', null, `${plural(left, 'project')} left of ${req.maxProjects}`),
            h('li', null, `Up to ${plural(req.maxExperts, 'AI expert')} per project`)),
          h('p', null, 'In Cloudbite: write the project brief, choose your AI experts, then press Run experts and inspect each expert\'s files and the synthesis.'),
          h('a', { class: 'ax-button primary', href: CONSOLE_PATH }, 'Continue to Cloudbite'));
      } else {
        kids.push(h('p', { class: 'ax-warn' }, st === 'denied' ? 'The host declined this request.' : st === 'revoked' ? 'The host ended this session.' : 'This request or session has expired.'));
        if (!V.showForm) kids.push(h('button', { type: 'button', class: 'ax-button', onclick: () => { V.showForm = true; render(); nameIn.focus(); } }, 'Send a new request'));
      }
      if (V.error) kids.push(h('p', { class: 'ax-warn' }, V.pollFails >= MAX_POLL_FAILS ? `${V.error} Stopped checking.` : `${V.error} Checking again…`),
        V.pollFails >= MAX_POLL_FAILS ? h('button', { type: 'button', class: 'ax-button', onclick: () => { V.pollFails = 0; V.error = ''; render(); void check(); } }, 'Check again') : null);
    } else kids.push(h('p', { class: 'ax-help' }, 'Tell the host who you are and what you want to try.'));
    fill(statusBox, ...kids);
    const terminal = !!st && st !== 'pending' && st !== 'approved';
    form.hidden = V.phase !== 'ready' || (!!req && !(terminal && V.showForm));
    nameIn.disabled = purposeIn.disabled = submitBtn.disabled = V.submitting;
    submitBtn.textContent = V.submitting ? 'Sending…' : 'Request access';
    fill(formMsg, ...V.formErrors.map(m => h('p', null, m)));
  }

  render();
  void check();
}

// ───────────────────────── 주인: 요청함 ─────────────────────────

function ownerPage(root: HTMLElement): void {
  // 운영자 링크는 화면·요청보다 먼저 지운다
  const link = takeOperatorLink();
  const O = {
    token: link.token,
    rows: [] as CloudbiteAccessRequest[],
    phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: link.present && !link.token ? 'The operator link was malformed. It was removed from the address bar; ask for a new link.' : '',
    notice: '', noticeKind: 'ok' as 'ok' | 'warn',
    busy: new Set<string>(),
    loadedAt: 0,
  };
  let gen = 0, loadSeq = 0, timer = 0, loading = false;

  const tokenIn = h('input', { id: 'ax-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Admin session or temporary operator token' });
  tokenIn.value = O.token;
  const loadBtn = h('button', { type: 'submit', class: 'ax-button primary' }, 'Open inbox');
  const clearBtn = h('button', { type: 'button', class: 'ax-button', onclick: () => clearToken() }, 'Clear token');
  const refreshBtn = h('button', { type: 'button', class: 'ax-button', onclick: () => { void load(); } }, 'Refresh');
  const tokenForm = h('form', { class: 'ax-form ax-tokenform', novalidate: true, 'aria-label': 'Owner credential' },
    h('div', { class: 'ax-field' }, h('label', { for: 'ax-token' }, 'Owner credential'), tokenIn,
      h('p', { class: 'ax-help' }, 'Held in this tab\'s memory only. It is never stored, put in the address, or shown on screen.')),
    h('div', { class: 'ax-actions' }, loadBtn, clearBtn));
  tokenForm.addEventListener('submit', ev => { ev.preventDefault(); O.token = tokenIn.value.trim(); O.error = ''; O.notice = ''; void load(); });
  tokenIn.addEventListener('input', () => { render(); });
  const state = h('div', { class: 'ax-state', role: 'status' });
  const msg = h('div', { class: 'ax-msg', 'aria-live': 'polite' });
  const list = h('ul', { class: 'ax-list', 'aria-label': 'Access requests' });

  root.replaceChildren(header('Owner request inbox'),
    h('main', { class: 'ax-main' },
      h('h1', null, 'Cloudbite access requests'),
      h('p', { class: 'ax-lead' }, 'Approve a visitor to give them a one-hour Cloudbite session with one project and up to five AI experts. Nothing runs until the visitor starts it.'),
      h('section', { class: 'ax-panel', 'aria-label': 'Owner credential' }, tokenForm),
      h('section', { class: 'ax-panel', 'aria-labelledby': 'ax-inbox-h' },
        h('div', { class: 'ax-inbox-head' }, h('h2', { id: 'ax-inbox-h' }, 'Inbox'), state, refreshBtn), msg, list),
      h('p', { class: 'ax-note' }, h('a', { href: REQUEST_PATH }, 'Visitor request form'), ' · ', h('a', { href: CONSOLE_PATH }, 'Cloudbite console'))));
  document.addEventListener('visibilitychange', () => { if (visible() && O.token && O.phase === 'ready' && !timer && !loading) void load(); });

  const operator = () => isOperatorToken(O.token);
  function stopPoll(): void { clearTimeout(timer); timer = 0; }
  function schedule(): void {
    stopPoll();
    if (O.token && O.phase === 'ready' && visible()) timer = setTimeout(() => { timer = 0; void load(); }, POLL_MS) as unknown as number;
  }

  function clearToken(): void {
    gen++; loadSeq++; stopPoll();
    O.token = ''; tokenIn.value = ''; O.rows = []; O.phase = 'idle'; O.error = ''; O.notice = ''; O.busy.clear(); O.loadedAt = 0;
    render(); tokenIn.focus();
  }

  async function load(): Promise<void> {
    if (!O.token || loading) return;
    if (operator() && !OPERATOR_TOKEN.test(O.token)) { O.phase = 'error'; O.error = 'The temporary Cloudbite operator token is malformed. Clear it and use a new link.'; render(); return; }
    const g = gen, seq = ++loadSeq;
    loading = true; stopPoll();
    if (O.phase !== 'ready') O.phase = 'loading';
    render();
    const r = await call(`${API}/requests`, { headers: { 'x-admin-token': O.token } });
    loading = false;
    if (g !== gen) return;
    if (seq !== loadSeq) { schedule(); return; } // 승인·거절 뒤라면 그 전에 떠난 목록은 버린다
    if (!r.ok) {
      O.error = ownerError(r, operator());
      // 거부된 자격 증명은 다시 묻지 않는다. 일시 오류면 마지막 목록을 두고 계속 확인한다
      if (r.status === 401 || r.status === 403) { O.phase = 'error'; O.rows = []; }
      else if (O.phase !== 'ready') O.phase = 'error';
      render(); schedule(); return;
    }
    const raw = isObj(r.body) && Array.isArray(r.body.requests) ? r.body.requests : null;
    if (!raw) { O.error = 'Cloudbite sent the inbox in an unexpected format.'; if (O.phase !== 'ready') O.phase = 'error'; render(); schedule(); return; }
    O.rows = raw.slice(0, 200).map(normalizeRequest).filter((x): x is CloudbiteAccessRequest => x !== null);
    O.phase = 'ready'; O.error = ''; O.loadedAt = Date.now();
    render(); schedule();
  }

  async function act(row: CloudbiteAccessRequest, action: 'approve' | 'deny' | 'revoke'): Promise<void> {
    if (O.busy.has(row.id) || !O.token) return;
    const g = gen;
    O.busy.add(row.id); O.notice = ''; render();
    const r = await call(`${API}/requests/${encodeURIComponent(row.id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': O.token }, body: '{}' });
    if (g !== gen) return;
    O.busy.delete(row.id);
    const verb = action === 'approve' ? 'approve' : action === 'deny' ? 'deny' : 'revoke';
    if (!r.ok) {
      O.noticeKind = 'warn'; O.notice = `Could not ${verb} “${row.name}”: ${ownerError(r, operator())}`;
      if (r.status === 401 || r.status === 403) { O.phase = 'error'; O.error = ownerError(r, operator()); O.rows = []; stopPoll(); }
      render();
      if (r.status === 404 || r.status === 409) void load();
      return;
    }
    const next = normalizeRequest(r.body);
    if (!next || next.id !== row.id) { O.noticeKind = 'warn'; O.notice = 'Cloudbite answered in an unexpected format. Refreshing the inbox.'; render(); void load(); return; }
    loadSeq++; // 이 응답 전에 떠난 목록 조회는 버린다
    O.rows = O.rows.map(x => x.id === next.id ? next : x);
    O.noticeKind = 'ok';
    O.notice = next.status === 'approved' ? `Approved “${next.name}”. Their session ends at ${clock(next.expiresAt)}.`
      : next.status === 'denied' ? `Denied “${next.name}”.` : next.status === 'revoked' ? `Revoked “${next.name}”.` : `“${next.name}” is now ${STATUS_LABEL[next.status].toLowerCase()}.`;
    render();
  }

  function rowView(r: CloudbiteAccessRequest, now: number): HTMLElement {
    const st = effectiveStatus(r, now);
    const busy = O.busy.has(r.id);
    const btn = (label: string, action: 'approve' | 'deny' | 'revoke', cls: string) =>
      h('button', { type: 'button', class: `ax-button ${cls}`, disabled: busy, 'data-action': action, 'data-id': r.id, onclick: () => { void act(r, action); } }, busy ? 'Working…' : label);
    const actions: Kid[] = st === 'pending' ? [btn('Approve', 'approve', 'primary'), btn('Deny', 'deny', 'danger')] : st === 'approved' ? [btn('Revoke', 'revoke', 'danger')] : [];
    const meta = [`Requested ${clock(r.createdAt)}`];
    if (st === 'pending') meta.push(`request expires ${clock(r.expiresAt)} (${remaining(r.expiresAt, now)})`);
    else if (st === 'approved') meta.push(`session ends ${clock(r.expiresAt)} (${remaining(r.expiresAt, now)})`);
    if (r.status === 'approved' || r.status === 'revoked' || r.usedProjects > 0) meta.push(`${r.usedProjects} of ${plural(r.maxProjects, 'project')} used`, `up to ${plural(r.maxExperts, 'expert')}`);
    return h('li', { class: `ax-row s-${st}`, 'data-id': r.id },
      h('div', { class: 'ax-req-head' }, pill(st), h('strong', { class: 'ax-req-name' }, r.name || '(no name)')),
      h('p', { class: 'ax-purpose' }, r.purpose || '(no purpose given)'),
      h('p', { class: 'ax-help' }, meta.join(' · ')),
      actions.length ? h('div', { class: 'ax-actions' }, ...actions) : null);
  }

  function render(): void {
    const now = Date.now();
    const typed = tokenIn.value.trim();
    loadBtn.disabled = !typed || loading;
    clearBtn.hidden = !O.token && !typed;
    refreshBtn.disabled = !O.token || loading;
    state.textContent = !O.token ? 'Enter the owner credential to open the inbox.'
      : O.phase === 'loading' ? 'Loading requests…'
        : O.phase === 'ready' ? `${plural(O.rows.length, 'request')} · updated ${clock(O.loadedAt)} · ${operator() ? 'temporary operator token' : 'admin session'} in memory`
          : O.phase === 'error' ? 'Inbox unavailable' : '';
    fill(msg, O.error ? h('p', { class: 'ax-warn' }, O.error) : null, O.notice ? h('p', { class: O.noticeKind === 'ok' ? 'ax-ok' : 'ax-warn' }, O.notice) : null);
    if (O.phase === 'ready' && !O.rows.length) fill(list, h('li', { class: 'ax-empty' }, 'No access requests yet. New requests appear here automatically.'));
    else {
      const order: AccessStatus[] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
      const sorted = O.rows.slice().sort((a, b) => order.indexOf(effectiveStatus(a, now)) - order.indexOf(effectiveStatus(b, now)) || b.createdAt - a.createdAt);
      fill(list, ...sorted.map(r => rowView(r, now)));
    }
  }

  render();
  if (O.token) void load();
}

function boot(): void {
  const root = document.getElementById('cb-access');
  if (!root) return;
  const view = root.getAttribute('data-view');
  if (view === 'owner') ownerPage(root); else if (view === 'request') visitorPage(root);
}

const CloudbiteAccessCore = { normalizeRequest, normalizeSession, effectiveStatus, validateRequest, operatorFragment };
const hook = (globalThis as { __cloudbiteAccessTestHook?: (core: typeof CloudbiteAccessCore) => void }).__cloudbiteAccessTestHook;
if (typeof hook === 'function') hook(CloudbiteAccessCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
