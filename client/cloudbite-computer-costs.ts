// Cloudbite computer costs (browser). tools/build-cloudbite-computer-costs.mjs transforms this file (no bundling) into
// src/cloudbite-computer-costs-page.ts → CLOUDBITE_COMPUTER_COSTS_JS, served same-origin at /cloudbite/computer/costs.js
// for the page /cloudbite/computer/costs (?lang=ko|en).
// Read-only: one GET /api/cloudbite/computer/costs when the page opens and again only when Refresh is pressed (?refresh=1).
// Nothing polls and nothing writes. Sign-in stays on the main computer page (/cloudbite/computer): a 401 shows a link there;
// this page never starts WebAuthn, reads storage or holds a token.
// Estimates (hourly burn from published prices) and balances (what a provider reports) are drawn in separate sections, and
// unknown values stay "unknown" — never zero. External links are a fixed list of official pricing/billing pages; server
// text is never used as a link. Everything is drawn with createElement/textContent.

const COSTS_API = '/api/cloudbite/computer/costs';
const COMPUTER_PATH = '/cloudbite/computer';
const LINKS = {
  daytonaPricing: 'https://www.daytona.io/pricing',
  daytonaBilling: 'https://www.daytona.io/docs/en/billing',
  daytonaWallet: 'https://app.daytona.io/dashboard/billing/wallet',
  nosanaCredits: 'https://learn.nosana.com/api/credits.html',
  nosanaDashboard: 'https://dashboard.nosana.com/',
};
const MAX_SANDBOXES = 400;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;

type Lang = 'en' | 'ko';
type Phase = 'running' | 'stopped' | 'archived' | 'other';
type Sandbox = { id: string; name: string; state: string; phase: Phase; region: string; cpu: number | null; memoryGiB: number | null; diskGiB: number | null; gpu: number | null; computer: boolean; usdPerHour: number | null };
type Used = { used: number | null; quota: number | null };
type Region = { regionId: string; sandboxClass: string; cpu: Used; memoryGiB: Used; diskGiB: Used; maxCpuPerSandbox: number | null };
type Totals = { runningUsdPerHour: number | null; stoppedUsdPerHour: number | null; unknownRate: number };
type Account = { id: string; status: 'ok' | 'partial' | 'unavailable'; error: string; truncated: boolean; sandboxes: Sandbox[]; totals: Totals; usage: { status: 'ok' | 'unavailable' | 'unknown'; error: string; regions: Region[] } };
type Nosana = { status: 'ok' | 'not_configured' | 'unavailable' | 'invalid_response'; error: string; assignedUsd: number | null; reservedUsd: number | null; settledUsd: number | null; availableUsd: number | null };
type View = { observedAt: string | null; cacheAgeMs: number | null; partial: boolean; asOf: string; accounts: Account[]; totals: Totals; nosana: Nosana };

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Costs', brand: 'Cloudbite', sub: 'Costs', back: 'Cloud computer',
    h1: 'Costs and credits', lead: 'Estimated hourly cost of your Daytona sandboxes and the Nosana credit balance. Read-only: nothing here starts, stops or moves anything.',
    loading: 'Loading…', refresh: 'Refresh', refreshing: 'Refreshing…', netErr: 'Network error — nothing was loaded.', httpErr: (n: number) => `Server answered ${n}.`,
    odd: 'The server answered in an unexpected way.', signedOut: 'You are not signed in to your cloud computer. Sign in on the cloud computer page, then come back.',
    signInLink: 'Sign in on the cloud computer page',
    observed: (t: string) => `Observed ${t}`, cacheAge: (s: number) => (s < 1 ? 'just now' : `cached ${s} s ago`),
    partial: 'Some providers did not answer. Totals cover only what was listed; missing parts are marked unavailable, not zero.',
    estTitle: 'Estimated hourly burn (Daytona)',
    estLead: (d: string) => `Estimate from published prices (as of ${d}), not a bill. Running sandboxes pay for CPU, RAM and disk; stopped ones for disk only; archived ones are not billed.`,
    running: 'Running now', stopped: 'Stopped (storage)', perHour: (v: string) => `${v}/h`, unknown: 'unknown',
    unknownRate: (n: number) => `${n} sandbox(es) without a known rate are not included.`,
    excluded: 'Snapshots, volumes, network and GPU sandboxes are not included in these estimates.',
    accTitle: (id: string) => `Account: ${id}`, accStatus: { ok: 'listed', partial: 'partly listed', unavailable: 'unavailable' } as Record<Account['status'], string>,
    accErr: (c: string) => `Provider error: ${c}`, truncated: 'Only the first 200 sandboxes were listed.',
    noSandboxes: 'No sandboxes listed.', computer: 'your computer',
    phase: { running: 'running', stopped: 'stopped', archived: 'archived', other: 'other' } as Record<Phase, string>,
    spec: (c: string, m: string, d: string) => `${c} vCPU · ${m} GiB RAM · ${d} GiB disk`, gpu: (n: number) => ` · ${n} GPU`,
    quotaTitle: 'Resources used vs quota', quotaUnknown: 'Quota unknown (no sandbox listed to identify the organization).',
    quotaUnavailable: (c: string) => `Quota unavailable${c ? ` (${c})` : ''}.`, quotaRow: (u: string, q: string) => `${u} of ${q}`,
    cpu: 'CPU', ram: 'RAM (GiB)', disk: 'Disk (GiB)', maxCpu: (v: string) => `max ${v} vCPU per sandbox`,
    balTitle: 'Balances (provider reported)', balLead: 'What each provider reports. Separate from the estimates above.',
    daytonaBal: 'Daytona balance', daytonaBalNote: 'Daytona has no balance API. Check the wallet in the Daytona dashboard.', wallet: 'Daytona wallet',
    nosanaBal: 'Nosana credits', available: 'Available', assigned: 'Assigned', reserved: 'Reserved', settled: 'Settled',
    nosanaNotConfigured: 'Nosana is not configured on the server.', nosanaUnavailable: (c: string) => `Nosana balance unavailable${c ? ` (${c})` : ''}.`,
    nosanaInvalid: 'Nosana answered with an unexpected balance.', nosanaDash: 'Nosana dashboard',
    sources: 'Official pricing and billing', srcPricing: 'Daytona pricing', srcBilling: 'Daytona billing', srcCredits: 'Nosana credits',
  },
  ko: {
    title: 'Cloudbite — 비용', brand: 'Cloudbite', sub: '비용', back: '클라우드 컴퓨터',
    h1: '비용과 크레딧', lead: 'Daytona 샌드박스의 예상 시간당 비용과 Nosana 크레딧 잔액입니다. 읽기 전용이며, 여기서는 아무것도 켜거나 끄거나 옮기지 않습니다.',
    loading: '불러오는 중…', refresh: '새로 고침', refreshing: '새로 고치는 중…', netErr: '네트워크 오류 — 아무것도 불러오지 못했습니다.', httpErr: (n: number) => `서버 응답 ${n}.`,
    odd: '서버가 예상과 다른 형식으로 답했습니다.', signedOut: '클라우드 컴퓨터에 로그인되어 있지 않습니다. 클라우드 컴퓨터 화면에서 로그인한 뒤 돌아오세요.',
    signInLink: '클라우드 컴퓨터 화면에서 로그인',
    observed: (t: string) => `관측 ${t}`, cacheAge: (s: number) => (s < 1 ? '방금' : `${s}초 전 캐시`),
    partial: '일부 공급자가 답하지 않았습니다. 합계는 조회된 것만 포함하며, 빠진 부분은 0이 아니라 확인 불가로 표시합니다.',
    estTitle: '예상 시간당 비용 (Daytona)',
    estLead: (d: string) => `공개 가격(${d} 기준)으로 계산한 추정치이며 청구서가 아닙니다. 실행 중은 CPU·RAM·디스크, 정지됨은 디스크만, 보관됨은 과금되지 않습니다.`,
    running: '지금 실행 중', stopped: '정지됨 (저장 공간)', perHour: (v: string) => `${v}/시간`, unknown: '알 수 없음',
    unknownRate: (n: number) => `요금을 알 수 없는 샌드박스 ${n}개는 포함하지 않았습니다.`,
    excluded: '스냅샷·볼륨·네트워크·GPU 샌드박스는 이 추정치에 포함되지 않습니다.',
    accTitle: (id: string) => `계정: ${id}`, accStatus: { ok: '조회됨', partial: '일부만 조회됨', unavailable: '확인 불가' } as Record<Account['status'], string>,
    accErr: (c: string) => `공급자 오류: ${c}`, truncated: '처음 200개 샌드박스만 조회했습니다.',
    noSandboxes: '조회된 샌드박스가 없습니다.', computer: '내 컴퓨터',
    phase: { running: '실행 중', stopped: '정지됨', archived: '보관됨', other: '기타' } as Record<Phase, string>,
    spec: (c: string, m: string, d: string) => `${c} vCPU · RAM ${m} GiB · 디스크 ${d} GiB`, gpu: (n: number) => ` · GPU ${n}`,
    quotaTitle: '사용량 대비 한도', quotaUnknown: '한도 알 수 없음 (조직을 확인할 샌드박스가 없습니다).',
    quotaUnavailable: (c: string) => `한도 확인 불가${c ? ` (${c})` : ''}.`, quotaRow: (u: string, q: string) => `${q} 중 ${u}`,
    cpu: 'CPU', ram: 'RAM (GiB)', disk: '디스크 (GiB)', maxCpu: (v: string) => `샌드박스당 최대 ${v} vCPU`,
    balTitle: '잔액 (공급자 보고)', balLead: '각 공급자가 보고한 값입니다. 위의 추정치와 별개입니다.',
    daytonaBal: 'Daytona 잔액', daytonaBalNote: 'Daytona 는 잔액 API 가 없습니다. Daytona 대시보드의 지갑에서 확인하세요.', wallet: 'Daytona 지갑',
    nosanaBal: 'Nosana 크레딧', available: '사용 가능', assigned: '배정', reserved: '예약', settled: '정산',
    nosanaNotConfigured: '서버에 Nosana 가 설정되어 있지 않습니다.', nosanaUnavailable: (c: string) => `Nosana 잔액 확인 불가${c ? ` (${c})` : ''}.`,
    nosanaInvalid: 'Nosana 가 예상과 다른 잔액을 답했습니다.', nosanaDash: 'Nosana 대시보드',
    sources: '공식 가격·청구 안내', srcPricing: 'Daytona 가격', srcBilling: 'Daytona 청구', srcCredits: 'Nosana 크레딧',
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const plain = (v: unknown, max: number): string => str(v, max).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => { const n = fin(v); return n !== null && n >= 0 ? n : null; };
const code = (v: unknown): string => { const c = str(v, 64); return SAFE_CODE.test(c) ? c : ''; };
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const PHASES: Phase[] = ['running', 'stopped', 'archived', 'other'];

function totals(raw: unknown): Totals {
  const t = isObj(raw) ? raw : {};
  return { runningUsdPerHour: pos(t.runningUsdPerHour), stoppedUsdPerHour: pos(t.stoppedUsdPerHour), unknownRate: pos(t.unknownRate) ?? 0 };
}
function used(raw: unknown): Used { const u = isObj(raw) ? raw : {}; return { used: pos(u.used), quota: pos(u.quota) }; }

function normalize(raw: unknown): View | null {
  if (!isObj(raw) || raw.ok !== true || !isObj(raw.daytona) || !Array.isArray(raw.daytona.accounts) || !isObj(raw.nosana)) return null;
  const accounts: Account[] = [];
  for (const a of raw.daytona.accounts.slice(0, 8)) {
    if (!isObj(a)) return null;
    const status = a.status === 'ok' || a.status === 'partial' || a.status === 'unavailable' ? a.status : 'unavailable';
    const u = isObj(a.usage) ? a.usage : {};
    accounts.push({
      id: plain(a.id, 40) || '?', status, error: code(a.error), truncated: a.truncated === true, totals: totals(a.totals),
      sandboxes: (Array.isArray(a.sandboxes) ? a.sandboxes.slice(0, MAX_SANDBOXES) : []).filter(isObj).map(s => ({
        id: plain(s.id, 128), name: plain(s.name, 128), state: plain(s.state, 48), phase: PHASES.includes(s.phase as Phase) ? s.phase as Phase : 'other',
        region: plain(s.region, 48), cpu: pos(s.cpu), memoryGiB: pos(s.memoryGiB), diskGiB: pos(s.diskGiB), gpu: pos(s.gpu), computer: s.computer === true, usdPerHour: pos(s.usdPerHour),
      })),
      usage: {
        status: u.status === 'ok' || u.status === 'unavailable' ? u.status : 'unknown', error: code(u.error),
        regions: (Array.isArray(u.regions) ? u.regions.slice(0, 20) : []).filter(isObj).map(r => ({
          regionId: plain(r.regionId, 48), sandboxClass: plain(r.sandboxClass, 32), cpu: used(r.cpu), memoryGiB: used(r.memoryGiB), diskGiB: used(r.diskGiB), maxCpuPerSandbox: pos(r.maxCpuPerSandbox),
        })),
      },
    });
  }
  const n = raw.nosana;
  const nStatus = n.status === 'ok' || n.status === 'not_configured' || n.status === 'unavailable' || n.status === 'invalid_response' ? n.status : 'invalid_response';
  const nosana: Nosana = { status: nStatus, error: code(n.error), assignedUsd: fin(n.assignedUsd), reservedUsd: fin(n.reservedUsd), settledUsd: fin(n.settledUsd), availableUsd: fin(n.availableUsd) };
  // an "ok" balance must carry all four finite figures; otherwise it is shown as unexpected, never as zero
  if (nosana.status === 'ok' && [nosana.assignedUsd, nosana.reservedUsd, nosana.settledUsd, nosana.availableUsd].some(v => v === null)) nosana.status = 'invalid_response';
  const p = isObj(raw.pricing) && isObj(raw.pricing.daytona) ? raw.pricing.daytona : {};
  return {
    observedAt: iso(raw.observedAt), cacheAgeMs: pos(raw.cacheAgeMs), partial: raw.partial === true, asOf: plain(p.asOf, 20),
    accounts, totals: totals(raw.daytona.totals), nosana,
  };
}

const money = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v) < 1 && v !== 0 ? Math.abs(v).toFixed(4) : Math.abs(v).toFixed(2)}`;
const amount = (v: number | null, unknown: string): string => (v === null ? unknown : String(Number(v.toFixed(2))));

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k) el.append(k);
  return el;
}
function link(cls: string, href: string, text: string, external = false): HTMLAnchorElement {
  const a = h('a', cls, text);
  a.setAttribute('href', href);
  if (external) a.setAttribute('rel', 'noopener noreferrer');
  return a;
}
function fact(dl: HTMLElement, k: string, v: string): void { dl.append(h('dt', '', k), h('dd', '', v)); }

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement): void {
  const qs = new URLSearchParams(location.search).get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;
  const S = { auth: 'loading' as 'loading' | 'in' | 'out' | 'failed', loading: false, view: null as View | null, err: '' as string | (() => string) };
  let seq = 0;

  const brand = h('strong', 'cc-brand'), brandSub = h('span', 'cc-sub');
  const backLink = link('cc-nav-link', COMPUTER_PATH, '');
  const langNav = h('nav', 'cc-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = h('button', 'cc-lang-btn', l.toUpperCase());
    b.setAttribute('type', 'button'); b.setAttribute('lang', l);
    b.addEventListener('click', () => { if (lang !== l) { lang = l; render(); } });
    langNav.append(b);
    return b;
  });
  const header = h('header', 'cc-header', h('div', 'cc-brand-row', brand, brandSub), h('div', 'cc-header-side', backLink, langNav));
  const h1 = h('h1'), lead = h('p', 'cc-lead');
  const refreshBtn = h('button', 'cc-btn cc-primary');
  refreshBtn.setAttribute('type', 'button');
  refreshBtn.addEventListener('click', () => { void load(true); });
  const meta = h('p', 'cc-fine'), msg = h('p', 'cc-msg');
  msg.setAttribute('role', 'status');
  const signIn = link('cc-btn', COMPUTER_PATH, '');
  const bar = h('section', 'cc-card', h('div', 'cc-actions', refreshBtn), meta, msg, signIn);
  const body = h('div', 'cc-grid');
  const main = h('main', 'cc-main', h1, lead, bar, body);
  root.replaceChildren(header, main);

  async function load(refresh: boolean): Promise<void> {
    const my = ++seq;
    S.loading = true; S.err = ''; render();
    let res: Response | null = null, parsed: unknown = null;
    try {
      res = await fetch(refresh ? `${COSTS_API}?refresh=1` : COSTS_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      try { parsed = await res.json(); } catch { /* no body */ }
    } catch { res = null; }
    if (my !== seq) return; // a newer press replaced this answer
    S.loading = false;
    if (!res) S.err = () => T().netErr;
    else if (res.status === 401) { S.auth = 'out'; S.view = null; }
    else if (!res.ok) { const s = res.status; S.err = () => T().httpErr(s); if (S.auth === 'loading') S.auth = 'failed'; }
    else { const v = normalize(parsed); if (v) { S.view = v; S.auth = 'in'; } else S.err = () => T().odd; }
    render();
  }

  function render(): void {
    const d = T();
    document.title = d.title; document.documentElement.lang = lang;
    langBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((['en', 'ko'] as Lang[])[i] === lang)));
    brand.textContent = d.brand; brandSub.textContent = d.sub; backLink.textContent = d.back;
    backLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    signIn.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    h1.textContent = d.h1; lead.textContent = d.lead;
    refreshBtn.textContent = S.loading ? d.refreshing : d.refresh; refreshBtn.disabled = S.loading;
    refreshBtn.setAttribute('aria-busy', String(S.loading));
    refreshBtn.hidden = S.auth === 'out';
    signIn.textContent = d.signInLink; signIn.hidden = S.auth !== 'out';
    const v = S.view;
    meta.textContent = v && v.observedAt ? `${d.observed(new Date(v.observedAt).toLocaleString(lang))} · ${d.cacheAge(Math.floor((v.cacheAgeMs ?? 0) / 1000))}` : '';
    meta.hidden = !meta.textContent;
    const text = S.auth === 'out' ? d.signedOut : S.err ? (typeof S.err === 'string' ? S.err : S.err()) : S.loading && !v ? d.loading : v?.partial ? d.partial : '';
    msg.textContent = text; msg.hidden = !text;
    msg.className = `cc-msg ${S.auth === 'out' || S.err || v?.partial ? 'cc-warn' : 'cc-info'}`;
    body.replaceChildren(...(v && S.auth === 'in' ? [estimates(v, d), balances(v, d), sources(d)] : []));
  }

  function rateLine(label: string, value: number | null, d: Dict): HTMLElement {
    return h('div', 'cc-stat', h('span', 'cc-stat-label', label), h('strong', 'cc-stat-value', value === null ? d.unknown : d.perHour(money(value))));
  }

  function estimates(v: View, d: Dict): HTMLElement {
    const card = h('section', 'cc-card', h('h2', '', d.estTitle), h('p', 'cc-fine', d.estLead(v.asOf || '?')));
    card.setAttribute('data-section', 'estimates');
    const listed = v.accounts.some(a => a.status !== 'unavailable');
    card.append(h('div', 'cc-stats', rateLine(d.running, listed ? v.totals.runningUsdPerHour : null, d), rateLine(d.stopped, listed ? v.totals.stoppedUsdPerHour : null, d)));
    if (v.totals.unknownRate) card.append(h('p', 'cc-fine', d.unknownRate(v.totals.unknownRate)));
    card.append(h('p', 'cc-fine', d.excluded));
    for (const a of v.accounts) card.append(accountBlock(a, d));
    return card;
  }

  function accountBlock(a: Account, d: Dict): HTMLElement {
    const box = h('div', 'cc-account', h('div', 'cc-head', h('h3', '', d.accTitle(a.id)), h('span', `cc-pill cc-a-${a.status}`, d.accStatus[a.status])));
    box.setAttribute('data-account', a.id);
    if (a.error) box.append(h('p', 'cc-fine cc-bad', d.accErr(a.error)));
    if (a.truncated) box.append(h('p', 'cc-fine', d.truncated));
    if (a.status !== 'unavailable') {
      box.append(h('div', 'cc-stats', rateLine(d.running, a.totals.runningUsdPerHour, d), rateLine(d.stopped, a.totals.stoppedUsdPerHour, d)));
      const list = h('ul', 'cc-list');
      if (!a.sandboxes.length) list.append(h('li', 'cc-muted', d.noSandboxes));
      for (const s of a.sandboxes) {
        const spec = d.spec(amount(s.cpu, d.unknown), amount(s.memoryGiB, d.unknown), amount(s.diskGiB, d.unknown)) + (s.gpu ? d.gpu(s.gpu) : '');
        const li = h('li', 'cc-sb',
          h('div', 'cc-sb-head', h('strong', '', s.name || s.id), h('span', `cc-pill cc-p-${s.phase}`, d.phase[s.phase])),
          h('p', 'cc-fine', `${spec}${s.region ? ` · ${s.region}` : ''}${s.computer ? ` · ${d.computer}` : ''}`),
          h('p', 'cc-rate', s.usdPerHour === null ? `${d.unknown}` : d.perHour(money(s.usdPerHour))));
        li.setAttribute('data-sandbox', s.id);
        list.append(li);
      }
      box.append(list);
    }
    const q = h('div', 'cc-quota', h('h4', '', d.quotaTitle));
    if (a.usage.status === 'unknown') q.append(h('p', 'cc-fine', d.quotaUnknown));
    else if (a.usage.status === 'unavailable') q.append(h('p', 'cc-fine cc-bad', d.quotaUnavailable(a.usage.error)));
    else for (const r of a.usage.regions) {
      const dl = h('dl', 'cc-facts');
      const row = (k: string, u: Used) => fact(dl, k, d.quotaRow(amount(u.used, d.unknown), amount(u.quota, d.unknown)));
      row(d.cpu, r.cpu); row(d.ram, r.memoryGiB); row(d.disk, r.diskGiB);
      q.append(h('p', 'cc-fine', `${r.regionId}${r.sandboxClass ? ` · ${r.sandboxClass}` : ''}${r.maxCpuPerSandbox !== null ? ` · ${d.maxCpu(amount(r.maxCpuPerSandbox, d.unknown))}` : ''}`), dl);
    }
    box.append(q);
    return box;
  }

  function balances(v: View, d: Dict): HTMLElement {
    const card = h('section', 'cc-card', h('h2', '', d.balTitle), h('p', 'cc-fine', d.balLead));
    card.setAttribute('data-section', 'balances');
    card.append(h('h3', '', d.daytonaBal), h('p', 'cc-fine', d.daytonaBalNote), link('cc-text-link', LINKS.daytonaWallet, d.wallet, true));
    const n = v.nosana, nb = h('div', 'cc-nosana', h('h3', '', d.nosanaBal));
    nb.setAttribute('data-nosana', n.status);
    if (n.status === 'ok') {
      nb.append(h('div', 'cc-stats', h('div', 'cc-stat', h('span', 'cc-stat-label', d.available), h('strong', 'cc-stat-value', money(n.availableUsd!)))));
      const dl = h('dl', 'cc-facts');
      fact(dl, d.assigned, money(n.assignedUsd!)); fact(dl, d.reserved, money(n.reservedUsd!)); fact(dl, d.settled, money(n.settledUsd!));
      nb.append(dl);
    } else nb.append(h('p', 'cc-fine cc-bad', n.status === 'not_configured' ? d.nosanaNotConfigured : n.status === 'unavailable' ? d.nosanaUnavailable(n.error) : d.nosanaInvalid));
    nb.append(link('cc-text-link', LINKS.nosanaDashboard, d.nosanaDash, true));
    card.append(nb);
    return card;
  }

  function sources(d: Dict): HTMLElement {
    return h('section', 'cc-card', h('h2', '', d.sources), h('ul', 'cc-links',
      h('li', '', link('cc-text-link', LINKS.daytonaPricing, d.srcPricing, true)),
      h('li', '', link('cc-text-link', LINKS.daytonaBilling, d.srcBilling, true)),
      h('li', '', link('cc-text-link', LINKS.nosanaCredits, d.srcCredits, true))));
  }

  render();
  void load(false);
}

const rootEl = document.getElementById('cb-computer-costs');
if (rootEl) mount(rootEl);

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
