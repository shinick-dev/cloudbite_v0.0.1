// Cloudbite personal cloud computer (browser). tools/build-cloudbite-computer.mjs transforms this file (no bundling) into
// src/cloudbite-computer-page.ts → CLOUDBITE_COMPUTER_JS, served same-origin at /cloudbite/computer.js for the page /cloudbite/computer.
// Sign-in is a passkey scoped to this computer (/api/cloudbite/computer/auth/*, HttpOnly cookie — this script never sees a secret):
// the phone's own biometric passkey, or the owner's existing security key as a fallback. A one-use #pair= setup link (first phone)
// is lifted out of the URL before anything renders or fetches, sent once, and then enrollment of this phone's passkey is offered.
// WebAuthn create/get run only from a button press; a registration counts only after the server verified it.
// Machine state comes only from GET /api/cloudbite/computer/state; nothing here starts, provisions or switches accounts on its own.
// Mutations carry a requestId that is kept in memory until the server gives a definite answer, so a retry after a lost response
// repeats the same request instead of creating a second one. Polling runs only while the tab is visible and something is pending.
// The desktop itself runs on the separate gateway origin; native tools run on the remote Linux machine, never on this device.
// Everything is drawn with createElement/textContent. Text comes from DICT (EN/KO, ?lang=); server error codes are shown verbatim.

const API = '/api/cloudbite/computer';
const AUTH_API = `${API}/auth`;
const WORKBENCH_PATH = '/cloudbite';
const OWNER_SETUP_PATH = '/cloudbite/requests';
const GATEWAY_ORIGIN = 'https://cloudbite-desktop.ai-gongbu.workers.dev';
const DESKTOP_PATH = '/p/_cloudbite/computer/desktop';
const BROKER_URL = 'https://k.shinick.dev/borrow';
const VAULT_URL = 'https://k.shinick.dev/vault';
const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 8000;
const POLL_FAST_COUNT = 20;
const POLL_MAX = 90;
const SNAPSHOT_NAME = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
// optional short prefix, then 32 random bytes as canonical unpadded base64url (43 chars)
const PAIR_TOKEN = /^(?:[a-z][a-z0-9]{0,15}_)?([A-Za-z0-9_-]{43})$/;
const PRICING_HOSTS = ['daytona.io', 'www.daytona.io'];
const VRAM_CHOICES = [16, 24, 48, 80];
const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_ACCOUNT = /^[A-Za-z0-9_-]{1,40}$/;

type Status = 'absent' | 'starting' | 'running' | 'stopped' | 'stopping' | 'snapshotting' | 'error' | 'unknown';
const STATUSES: Status[] = ['absent', 'starting', 'running', 'stopped', 'stopping', 'snapshotting', 'error', 'unknown'];
const TRANSITIONAL: Status[] = ['starting', 'stopping', 'snapshotting', 'unknown'];
type AccountId = 'primary' | 'secondary' | 'tertiary';
const ACCOUNT_IDS: AccountId[] = ['primary', 'secondary', 'tertiary'];
type Machine = { id: string; name: string; account: string; region: string; cpu: number | null; memoryGiB: number | null; diskGiB: number | null };
type Snapshot = { name: string; state: string; error: string | null };
type Account = { id: AccountId; label: string; available: boolean };
type ToolStatus = 'installed' | 'not_installed' | 'unprobed' | 'web' | 'api_broker';
const TOOL_STATUSES: ToolStatus[] = ['installed', 'not_installed', 'unprobed', 'web', 'api_broker'];
type ToolState = { status: ToolStatus | null; version: string; connected: boolean | null };
type NestedJob = { id: string; provider: string; status: string };
type MachineState = {
  status: Status; error: string | null; machine: Machine | null; sessionEndsAt: string | null; snapshot: Snapshot | null;
  tools: Map<string, ToolState> | null; configuredAccounts: Account[]; ready: boolean;
};
type OpKind = 'start' | 'stop' | 'extend' | 'snapshot' | 'nested/configure' | 'resize';
type Op = { kind: OpKind; requestId: string; body: Record<string, unknown>; phase: 'sending' | 'uncertain' };
// Performance card (GET performance, POST resize): live usage is null when the machine did not report it — never a fake zero
type Plan = { cpu: number; memoryGiB: number; usdPerHour: number; deltaUsdPerHour: number };
type Metrics = { cpuPercent: number | null; memoryUsedGiB: number; memoryLimitGiB: number; memoryPercent: number; load1: number };
type ResizeStatus = 'idle' | 'pending' | 'failed';
type Perf = {
  machineId: string; sampledAt: string | null; metrics: Metrics | null; current: { cpu: number; memoryGiB: number; diskGiB: number; usdPerHour: number };
  plans: Plan[]; resize: { status: ResizeStatus; cpu: number | null; memoryGiB: number | null; error: string | null }; pricing: { asOf: string; url: string | null };
};
type Review = Plan & { machineId: string; fromCpu: number; fromMemoryGiB: number; fromUsdPerHour: number; diskGiB: number; asOf: string };
// Remote GPU card (GET compute/sandboxes, GET gpu/candidates, POST gpu/select): choosing never rents or starts anything
type Sandbox = { id: string; account: string; name: string; region: string; state: string; cpu: number | null; memoryGiB: number | null };
type Candidate = {
  id: string; gpu: string; vramGb: number | null; available: number | null; country: string | null; market: string | null;
  usdPerHourMin: number | null; usdPerHourMax: number | null; distanceKm: number | null; selectable: boolean;
};
type Candidates = { key: string; region: string; observedAt: string | null; note: string; list: Candidate[] };
type GpuChoice = { candidateId: string; gpu: string; country: string | null; market: string | null; command: string };
type GpuOp = { requestId: string; key: string; body: Record<string, unknown>; phase: 'sending' | 'uncertain' };
type Reply = { ok: true; status: number; body: unknown } | { ok: false; status: number; code: string };
type Lang = 'en' | 'ko';
type Msg = { text: () => string; kind: 'ok' | 'warn' | 'info' } | null;

// ───────────────────────── Catalogue (what each service offers — never whether it is set up) ─────────────────────────

// Each service maps to the server's catalogue row ids (src/cloudbite-computer-tools.ts → state.tools rows
// {id, kind: native_cli|web|api_broker, status: installed|not_installed|unprobed|web|api_broker, version}).
type Surface = 'native' | 'web' | 'api';
type Tool = { id: string; name: string; rows: Partial<Record<Surface, string>>; nested?: boolean; about: { en: string; ko: string } };
const TOOLS: Tool[] = [
  { id: 'claude', name: 'Claude', rows: { native: 'claude-code', web: 'claude-web' }, about: {
    en: 'Claude Code CLI in the desktop terminal — sign in there with your Claude subscription or an API key. claude.ai opens in the desktop browser.',
    ko: '데스크톱 터미널의 Claude Code CLI — 거기서 Claude 구독이나 API 키로 로그인합니다. claude.ai 는 데스크톱 브라우저에서 엽니다.' } },
  { id: 'codex', name: 'Codex', rows: { native: 'codex', web: 'chatgpt', api: 'openai-api' }, about: {
    en: 'Codex CLI in the desktop terminal — `codex login` signs in with ChatGPT in the desktop browser, or use an OpenAI API key.',
    ko: '데스크톱 터미널의 Codex CLI — `codex login` 이 데스크톱 브라우저에서 ChatGPT 로그인을 열거나, OpenAI API 키를 씁니다.' } },
  { id: 'cursor', name: 'Cursor', rows: { native: 'cursor-agent' }, about: {
    en: 'Cursor Agent CLI in the desktop terminal — `cursor-agent login` opens the desktop browser. The Cursor editor app is not part of the image.',
    ko: '데스크톱 터미널의 Cursor Agent CLI — `cursor-agent login` 이 데스크톱 브라우저를 엽니다. Cursor 편집기 앱은 이미지에 없습니다.' } },
  { id: 'grok', name: 'Grok', rows: { web: 'grok' }, about: {
    en: 'grok.com in the desktop browser. No API integration is claimed here.',
    ko: '데스크톱 브라우저의 grok.com. 여기서 API 연동을 주장하지 않습니다.' } },
  { id: 'antigravity', name: 'Google Antigravity', rows: { native: 'antigravity', web: 'antigravity-web' }, about: {
    en: 'Antigravity CLI (agy) in the desktop terminal, signed in with Google on first run. The Antigravity desktop app is not installed.',
    ko: '데스크톱 터미널의 Antigravity CLI (agy). 처음 실행할 때 Google 로 로그인합니다. Antigravity 데스크톱 앱은 설치되지 않습니다.' } },
  { id: 'opencode', name: 'OpenCode', rows: { native: 'opencode' }, about: {
    en: 'OpenCode CLI in the desktop terminal — `opencode auth login` for providers such as OpenRouter.',
    ko: '데스크톱 터미널의 OpenCode CLI — OpenRouter 등 공급자는 `opencode auth login` 으로 연결합니다.' } },
  { id: 'openrouter', name: 'OpenRouter', rows: { web: 'openrouter', api: 'openrouter-api' }, about: {
    en: 'Web console in the desktop browser; the API key comes from the k broker and is never stored in the image.',
    ko: '데스크톱 브라우저의 웹 콘솔. API 키는 k 중계에서 받으며 이미지에 저장하지 않습니다.' } },
  { id: 'genspark', name: 'Genspark', rows: { web: 'genspark' }, about: {
    en: 'Web app in the desktop browser. No API integration is claimed here.',
    ko: '데스크톱 브라우저의 웹앱. 여기서 API 연동을 주장하지 않습니다.' } },
  { id: 'lovable', name: 'Lovable', rows: { web: 'lovable' }, about: {
    en: 'Web app in the desktop browser, signed in there. No API integration is claimed here.',
    ko: '데스크톱 브라우저의 웹앱이며 거기서 로그인합니다. API 연동을 주장하지 않습니다.' } },
  { id: 'tavily', name: 'Tavily', rows: { api: 'tavily' }, about: {
    en: 'Search API key from the k broker for agents on the machine; never stored in the image.',
    ko: '머신의 에이전트가 쓰는 검색 API 키를 k 중계에서 받습니다. 이미지에 저장하지 않습니다.' } },
  { id: 'elevenlabs', name: 'ElevenLabs', rows: { api: 'elevenlabs' }, about: {
    en: 'Voice API key from the k broker; never stored in the image.',
    ko: '음성 API 키를 k 중계에서 받습니다. 이미지에 저장하지 않습니다.' } },
  { id: 'nebius', name: 'Nebius', rows: { api: 'nebius' }, about: {
    en: 'Nebius Token Factory API key from the k broker; never stored in the image.',
    ko: 'Nebius Token Factory API 키를 k 중계에서 받습니다. 이미지에 저장하지 않습니다.' } },
  { id: 'daytona', name: 'Daytona', rows: { web: 'daytona' }, nested: true, about: {
    en: 'Web console in the desktop browser. Nested sandboxes from this machine are set up below, only as the server reports.',
    ko: '데스크톱 브라우저의 웹 콘솔. 이 머신에서 띄우는 중첩 샌드박스는 아래에서 설정하며, 서버가 알려 준 대로만 보여 줍니다.' } },
  { id: 'nosana', name: 'Nosana', rows: { web: 'nosana' }, nested: true, about: {
    en: 'Web dashboard in the desktop browser. Nested GPU jobs from this machine are set up below, only as the server reports.',
    ko: '데스크톱 브라우저의 웹 대시보드. 이 머신에서 띄우는 중첩 GPU 작업은 아래에서 설정하며, 서버가 알려 준 대로만 보여 줍니다.' } },
];

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Cloud computer', brand: 'Cloudbite', sub: 'Your cloud computer', workbench: 'Expert workbench', langLabel: 'Language',
    h1: 'Your Linux desktop in the cloud', lead: 'One persistent machine you open from this phone or any browser. Your tools run there, not on this device.',
    signInTitle: 'Sign in', signInLead: 'Use this phone\'s passkey (fingerprint, face or screen lock) or the security key already registered for Cloudbite. The session lives in a secure cookie.',
    signIn: 'Sign in with passkey', signingIn: 'Waiting for your passkey…', noKey: 'No passkey is registered yet. Open the one-time phone setup link, or use the owner page.', setupLink: 'Register a security key on the owner page',
    unsupported: 'This browser cannot use passkeys.', cancelled: 'Sign-in was cancelled.', keyFailed: 'The passkey did not respond.',
    loginFailed: 'Sign-in failed.', signOut: 'Sign out', signedOut: 'Signed out.', checking: 'Checking your session…', pairing: 'Checking the one-time setup link…',
    pairBad: 'This setup link is not valid, so it was not used. Sign in with a passkey, or ask for a new link.',
    pairGone: (c: string) => `This setup link has expired or was already used (${c}). Sign in with a passkey, or ask for a new link.`,
    pairUnknown: 'Could not confirm the setup link. It works only once, so it was not sent again. Sign in with a passkey, or ask for a new link.',
    pairOk: 'This phone is now signed in to this cloud computer only. Register its passkey below so that next time the phone alone signs you in.',
    phoneTitle: 'This phone\'s passkey',
    phoneLead: 'One-time setup: save a passkey on this phone. After that, this phone alone signs in with its fingerprint, face or screen lock — no security key needed. It opens only this cloud computer; the owner page and key vault still use the security key.',
    phoneRegister: 'Register this phone\'s passkey', phoneAdd: 'Add this phone\'s passkey', phoneBusy: 'Waiting for this phone…',
    phoneDone: 'Passkey saved for this phone. Next time, sign in with it.', phoneCancelled: 'Passkey setup was cancelled. Nothing was changed.',
    phoneExists: 'This phone already has a Cloudbite passkey.', phoneDevice: 'This phone did not create a passkey.', phoneUnsupported: 'This browser cannot create passkeys.',
    phoneFailed: 'The passkey was not saved.', phoneUnknown: 'The server did not confirm the passkey, so treat it as not saved. Sign in with it once before relying on it.',
    sessionFailed: 'Could not check the session.', netErr: 'Network error — nothing was confirmed.', httpErr: (n: number) => `Server answered ${n}.`,
    machine: 'Machine', status: {
      absent: 'No machine yet', starting: 'Starting', running: 'Running', stopped: 'Stopped', stopping: 'Stopping',
      snapshotting: 'Saving environment', error: 'Error', unknown: 'State unknown',
    } as Record<Status, string>,
    statusLead: {
      absent: 'No machine exists yet. Start creates it only when you press it — opening this page never does.',
      starting: 'The machine is booting. The desktop opens once the server reports it ready.',
      running: 'The machine is on. Open the desktop, or stop it to end the paid session.',
      stopped: 'Stopped. Files, installed tools and the browser profile are kept. Resume when you need it.',
      stopping: 'Stopping. Your files and browser profile are kept.',
      snapshotting: 'Writing a private copy of the disk. This can take several minutes.',
      error: 'The last action failed. Nothing else is done automatically.',
      unknown: 'The server could not confirm the machine state. Refresh before acting.',
    } as Record<Status, string>,
    loadingState: 'Loading machine state…', stateFailed: 'Could not load the machine state.', refresh: 'Refresh', refreshing: 'Refreshing…',
    name: 'Name', account: 'Account', region: 'Region', resources: 'Resources', cpuMem: (c: string, m: string, d: string) => `${c} vCPU · ${m} GiB RAM · ${d} GiB disk`,
    session: 'Paid session', sessionEnds: (t: string, mins: number) => `Ends ${t} (${mins < 1 ? 'under a minute' : `${mins} min`} left). The machine then stops; data is kept.`,
    sessionOver: 'Session time is up; the machine should be stopping.', noSession: 'No paid session is running.',
    sessionNote: 'Cost depends on your provider account and usage. Cloudbite does not guarantee a price.',
    chooseAccount: 'Provider account', accountUnavailable: 'not available', noAccounts: 'No provider account is configured on the server.',
    start: 'Start machine', resume: 'Resume', open: 'Open desktop', stop: 'Stop', extend: 'Extend session',
    starting: 'Starting…', stopping: 'Stopping…', extending: 'Extending…', opening: 'Getting a desktop ticket…',
    openReady: 'Desktop ticket ready — open it now. It works once and expires shortly.', openLink: 'Open the desktop', openNewTab: 'Opens the separate desktop site.',
    openBad: 'The server returned an unexpected desktop address; it was not opened.', notReady: 'The desktop is not reported ready yet.',
    accountMissing: (a: string) => `The machine belongs to the ${a} account, which is not available now. Cloudbite will not switch accounts.`,
    done: { start: 'Start accepted.', stop: 'Stop accepted.', extend: 'Session extended.', snapshot: 'Snapshot accepted.', 'nested/configure': 'Nested compute setup accepted.',
      resize: 'Size change sent. It counts only once the machine reports the new size — press Check now to see.' } as Record<OpKind, string>,
    rejected: (code: string) => `Rejected: ${code}`,
    uncertain: 'No definite answer from the server. Retry sends the same request again, so it will not run twice.',
    retry: 'Retry same request', forget: 'Forget it', pending: 'Request in flight…',
    keepTitle: 'What stop keeps', keep: 'Stop keeps the disk: your files, installed tools, sign-ins saved by the apps and the Chromium profile. Deleting the machine is a separate, confirmed owner action and is not on this page.',
    snapTitle: 'Save environment (private snapshot)', snapLead: 'A cold copy of the disk for this machine only. The machine is stopped first; open windows and memory (RAM) are not saved.',
    snapWarn: 'The copy includes everything on disk — including credentials and sign-ins stored by your apps. It stays private to your provider account and is never offered as a download.',
    snapName: 'Snapshot name', snapHint: '3–48 lowercase letters, digits or hyphens.', snapBad: 'Use 3–48 lowercase letters, digits or hyphens, starting and ending with a letter or digit.',
    snapSave: 'Save environment', snapSaving: 'Saving…', snapLast: (n: string, s: string) => `Last snapshot: ${n} — ${s}`, snapErr: (e: string) => `Snapshot error: ${e}`,
    snapNeedsMachine: 'Available once a machine exists and is running or stopped.',
    snapUnconfirmed: (n: string) => `Last snapshot: ${n} — not confirmed. The provider has not reported it, so it may not exist.`,
    snapExists: 'A snapshot with this name already exists. Nothing was overwritten — choose another name.',
    termTitle: 'Terminal and phone keyboard', termBtn: 'How to type on the remote desktop',
    termSteps: [
      'Open the desktop, then open Terminal from the desktop menu. Commands run on the cloud machine, never on this phone.',
      'To type on a phone, open the side panel of the desktop viewer and turn on its on-screen keyboard; your phone keyboard then sends keys to the remote desktop.',
      'Sign-ins (Claude, Codex, Cursor…) happen inside the remote desktop. Copy sign-in links into the desktop browser if a CLI prints one.',
    ],
    appsTitle: 'Apps on the machine', appsLead: 'What each service offers and what the running machine reports. Nothing is shown as connected unless the server says so.',
    surf: { native: 'Native CLI', web: 'Web in desktop browser', api: 'API key via k broker' } as Record<Surface, string>,
    installed: 'CLI installed', notInstalled: 'CLI not installed', unprobed: 'CLI not checked yet', notInImage: 'CLI not in image', notReported: 'Not reported',
    webLauncher: 'Web launcher on desktop', brokerKey: 'Key via broker — not checked', signInNote: 'Sign-in happens in the desktop and is not tracked here.',
    connected: 'Signed in / key set', notConnected: 'Not connected',
    machineOffNote: 'Install status comes from the running machine; start it to check.',
    nestedTitle: 'Nested compute (Daytona, Nosana)', nestedLead: 'Asks the server to set up scoped Daytona and Nosana command-line access inside this machine. Only the server\'s answer says whether it worked.',
    nestedConfigure: 'Set up nested compute', nestedConfiguring: 'Setting up…', nestedJobs: 'Show nested jobs', nestedLoading: 'Loading jobs…',
    nestedNone: 'The server reports no nested jobs.', nestedFailed: 'Could not load nested jobs.', nestedNeedsRunning: 'Available while the machine is running.',
    keysTitle: 'Accounts and keys', keysLead: 'Borrow API keys and approve brokered access on k.shinick.dev. The approval link opens on this same phone — no QR code or second device needed.',
    broker: 'Open k broker', vault: 'Open key vault',
    perfTitle: 'Performance and size', perfLead: 'Live CPU and memory use of this machine, and what a bigger size would cost. Nothing is checked until you press Check now.',
    perfCheck: 'Check now', perfChecking: 'Checking…', perfFailed: 'Could not load performance.', perfNeedsMachine: 'Available once a machine exists.',
    perfNotLoaded: 'Not checked yet.', sampled: (t: string) => `Measured ${t}`, notSampled: 'The machine did not report live usage (it may be stopped or still starting).',
    cpuUse: 'CPU use', memUse: 'Memory use', load: 'Load (1 min)', unknownVal: 'unknown',
    memOf: (u: string, l: string, p: string) => `${u} of ${l} GiB (${p}%)`, nowSize: 'Current size', sizeLine: (c: number, m: number) => `${c} vCPU · ${m} GiB RAM`,
    perHour: (u: string) => `about ${u} per hour`, priceNote: (a: string) => `Estimated from Daytona list prices as of ${a}. Not a quote or guarantee; disk is unchanged.`,
    pricingLink: 'Daytona pricing', upgradeLabel: 'Bigger size', pickPlan: 'Choose a size…', noPlans: 'No bigger size is offered for this machine.',
    planOption: (s: string, delta: string) => `${s} — ${delta} per hour more`, review: 'Review cost', needsRunning: 'Size changes are available while the machine is running.',
    reviewTitle: 'Confirm the size change', reviewFrom: 'Now', reviewTo: 'After', reviewDelta: 'Extra cost', reviewDeltaVal: (u: string) => `${u} more per hour while the machine runs`,
    reviewKeep: (dk: string) => `Files stay. Disk stays ${dk} GiB. The change may be refused if the provider has no room.`,
    apply: 'Apply upgrade', applying: 'Applying…', cancel: 'Cancel', reviewStale: 'The machine or prices changed. Review again before applying.',
    resizePending: (s: string) => `A size change to ${s} is in progress. Press Check now to see when the machine reports it.`,
    resizeFailed: (c: string) => `The last size change failed: ${c}`, resizeCheck: 'Press Check now to see whether the last size change was applied before asking for another.',
    resizeDone: (s: string) => `The machine reports ${s}.`,
    gpuTitle: 'Remote GPU jobs', gpuLead: 'A remote GPU job runs on a separate rented Nosana GPU host. It is not a CUDA device in this machine — nvidia-smi or PyTorch on the desktop will not see it.',
    gpuNoSwitch: 'Picking a sandbox here only sets where distance is measured from. It does not switch your desktop.',
    gpuSandboxes: 'Load my sandboxes', gpuSandboxesLoading: 'Loading sandboxes…', gpuSandbox: 'Measure from sandbox', gpuPickSandbox: 'Choose a sandbox…',
    gpuSandboxesFailed: 'Could not load sandboxes.', gpuNoSandboxes: 'No sandbox was reported.', gpuPartial: 'Some provider accounts did not answer, so this list may be incomplete.',
    gpuVram: 'Minimum GPU memory', gpuVramOpt: (n: number) => `${n} GB or more`, gpuFind: 'Find GPUs', gpuFinding: 'Searching…', gpuFailed: 'Could not load GPUs.',
    gpuNone: 'No GPU matched.', gpuObserved: (t: string) => `Checked ${t}`, gpuFrom: (n: string, r: string) => `From ${n} (${r || '–'})`,
    gpuVramVal: (n: string) => `${n} GB GPU memory`, gpuHosts: (n: string) => `${n} free hosts`,
    gpuWhere: (c: string, km: string) => `${c} · about ${km} km away (estimate)`, gpuWhereNoKm: (c: string) => `${c} · distance unknown`, gpuWhereUnknown: 'Location unknown',
    gpuPrice: (lo: string, hi: string) => (lo === hi ? `Base price ${lo}/h` : `Base price ${lo}–${hi}/h`), gpuNoPrice: 'Price not reported', gpuFee: 'Network fee is separate.',
    gpuDistanceNote: 'Distance is a rough guess between the country centre and the sandbox region. It is not measured network latency.',
    gpuChoose: 'Choose', gpuChoosing: 'Choosing…', gpuUnavailable: 'Not available now', gpuOdd: 'The server answered in an unexpected way, so the choice is not confirmed.',
    gpuChosen: (g: string, c: string) => `Chosen for remote GPU jobs: ${g} · ${c}. Nothing is rented and no job is running.`,
    gpuRun: 'A paid job starts only when you run this command on the machine:', gpuCmd: 'Command', copy: 'Copy', copied: 'Copied.', copyFailed: 'Copy did not work — select the text and copy it.',
    gpuJobs: 'Job status shows under Nested compute → Show nested jobs.',
  },
  ko: {
    title: 'Cloudbite — 클라우드 컴퓨터', brand: 'Cloudbite', sub: '나의 클라우드 컴퓨터', workbench: '전문가 작업대', langLabel: '언어',
    h1: '클라우드의 내 리눅스 데스크톱', lead: '이 휴대폰이나 어느 브라우저에서든 여는 영구 머신 하나. 도구는 이 기기가 아니라 그 머신에서 돕니다.',
    signInTitle: '로그인', signInLead: '이 휴대폰의 패스키(지문·얼굴·화면 잠금)나 Cloudbite 에 이미 등록한 보안 키를 씁니다. 세션은 보안 쿠키에만 있습니다.',
    signIn: '패스키로 로그인', signingIn: '패스키를 기다리는 중…', noKey: '등록된 패스키가 아직 없습니다. 1회용 휴대폰 설정 링크를 열거나 소유자 화면을 쓰세요.', setupLink: '소유자 화면에서 보안 키 등록하기',
    unsupported: '이 브라우저는 패스키를 쓸 수 없습니다.', cancelled: '로그인을 취소했습니다.', keyFailed: '패스키가 응답하지 않았습니다.',
    loginFailed: '로그인에 실패했습니다.', signOut: '로그아웃', signedOut: '로그아웃했습니다.', checking: '세션 확인 중…', pairing: '1회용 설정 링크 확인 중…',
    pairBad: '설정 링크 형식이 올바르지 않아 쓰지 않았습니다. 패스키로 로그인하거나 새 링크를 받으세요.',
    pairGone: (c: string) => `설정 링크가 만료됐거나 이미 쓰였습니다 (${c}). 패스키로 로그인하거나 새 링크를 받으세요.`,
    pairUnknown: '설정 링크 결과를 확인하지 못했습니다. 한 번만 쓰이는 링크라 다시 보내지 않았습니다. 패스키로 로그인하거나 새 링크를 받으세요.',
    pairOk: '이 휴대폰이 이 클라우드 컴퓨터에만 로그인됐습니다. 다음부터 휴대폰만으로 로그인하도록 아래에서 패스키를 등록하세요.',
    phoneTitle: '이 휴대폰의 패스키',
    phoneLead: '1회 설정: 이 휴대폰에 패스키를 저장합니다. 그 뒤에는 보안 키 없이 이 휴대폰의 지문·얼굴·화면 잠금만으로 로그인합니다. 이 클라우드 컴퓨터만 열며, 소유자 화면과 키 금고는 계속 보안 키를 씁니다.',
    phoneRegister: '이 휴대폰의 패스키 등록', phoneAdd: '이 휴대폰의 패스키 추가', phoneBusy: '휴대폰을 기다리는 중…',
    phoneDone: '이 휴대폰의 패스키를 저장했습니다. 다음부터 이것으로 로그인하세요.', phoneCancelled: '패스키 설정을 취소했습니다. 바뀐 것은 없습니다.',
    phoneExists: '이 휴대폰에는 이미 Cloudbite 패스키가 있습니다.', phoneDevice: '휴대폰이 패스키를 만들지 않았습니다.', phoneUnsupported: '이 브라우저는 패스키를 만들 수 없습니다.',
    phoneFailed: '패스키를 저장하지 않았습니다.', phoneUnknown: '서버가 패스키를 확인해 주지 않았으므로 저장되지 않은 것으로 보세요. 믿고 쓰기 전에 한 번 로그인해 보세요.',
    sessionFailed: '세션을 확인하지 못했습니다.', netErr: '네트워크 오류 — 확인된 것은 없습니다.', httpErr: (n: number) => `서버 응답 ${n}.`,
    machine: '머신', status: {
      absent: '머신 없음', starting: '시작 중', running: '실행 중', stopped: '중지됨', stopping: '중지 중',
      snapshotting: '환경 저장 중', error: '오류', unknown: '상태 모름',
    } as Record<Status, string>,
    statusLead: {
      absent: '아직 머신이 없습니다. 시작을 눌렀을 때만 만들며, 이 화면을 여는 것만으로는 만들지 않습니다.',
      starting: '머신이 부팅 중입니다. 서버가 준비됐다고 알리면 데스크톱을 열 수 있습니다.',
      running: '머신이 켜져 있습니다. 데스크톱을 열거나, 중지해 유료 세션을 끝내세요.',
      stopped: '중지됨. 파일·설치한 도구·브라우저 프로필은 남아 있습니다. 필요할 때 재개하세요.',
      stopping: '중지 중. 파일과 브라우저 프로필은 남습니다.',
      snapshotting: '디스크의 비공개 사본을 쓰는 중입니다. 몇 분 걸릴 수 있습니다.',
      error: '마지막 작업이 실패했습니다. 자동으로 다른 일을 하지 않습니다.',
      unknown: '서버가 머신 상태를 확인하지 못했습니다. 조작 전에 새로 고치세요.',
    } as Record<Status, string>,
    loadingState: '머신 상태를 불러오는 중…', stateFailed: '머신 상태를 불러오지 못했습니다.', refresh: '새로 고침', refreshing: '새로 고치는 중…',
    name: '이름', account: '계정', region: '지역', resources: '자원', cpuMem: (c: string, m: string, d: string) => `vCPU ${c} · RAM ${m} GiB · 디스크 ${d} GiB`,
    session: '유료 세션', sessionEnds: (t: string, mins: number) => `${t} 종료 (${mins < 1 ? '1분 미만' : `${mins}분`} 남음). 그때 머신이 중지되며 데이터는 남습니다.`,
    sessionOver: '세션 시간이 끝났습니다. 머신이 중지되는 중이어야 합니다.', noSession: '진행 중인 유료 세션이 없습니다.',
    sessionNote: '비용은 공급자 계정과 사용량에 따릅니다. Cloudbite 는 가격을 보장하지 않습니다.',
    chooseAccount: '공급자 계정', accountUnavailable: '사용 불가', noAccounts: '서버에 설정된 공급자 계정이 없습니다.',
    start: '머신 시작', resume: '재개', open: '데스크톱 열기', stop: '중지', extend: '세션 연장',
    starting: '시작 중…', stopping: '중지 중…', extending: '연장 중…', opening: '데스크톱 티켓 받는 중…',
    openReady: '데스크톱 티켓 준비됨 — 지금 여세요. 한 번만 쓰이고 곧 만료됩니다.', openLink: '데스크톱 열기', openNewTab: '별도의 데스크톱 사이트를 엽니다.',
    openBad: '서버가 예상과 다른 데스크톱 주소를 보내 열지 않았습니다.', notReady: '데스크톱이 아직 준비됐다고 보고되지 않았습니다.',
    accountMissing: (a: string) => `이 머신은 ${a} 계정 소속인데 지금 사용할 수 없습니다. Cloudbite 는 계정을 바꾸지 않습니다.`,
    done: { start: '시작 요청이 접수됐습니다.', stop: '중지 요청이 접수됐습니다.', extend: '세션을 연장했습니다.', snapshot: '스냅샷 요청이 접수됐습니다.', 'nested/configure': '중첩 컴퓨트 설정 요청이 접수됐습니다.',
      resize: '크기 변경을 보냈습니다. 머신이 새 크기를 보고해야 적용된 것입니다 — 지금 확인을 눌러 보세요.' } as Record<OpKind, string>,
    rejected: (code: string) => `거부됨: ${code}`,
    uncertain: '서버에서 확실한 답을 받지 못했습니다. 다시 시도는 같은 요청을 보내므로 두 번 실행되지 않습니다.',
    retry: '같은 요청 다시 보내기', forget: '잊기', pending: '요청 처리 중…',
    keepTitle: '중지해도 남는 것', keep: '중지는 디스크를 남깁니다: 파일, 설치한 도구, 앱이 저장한 로그인, Chromium 프로필. 머신 삭제는 별도로 확인하는 소유자 작업이며 이 화면에는 없습니다.',
    snapTitle: '환경 저장 (비공개 스냅샷)', snapLead: '이 머신 전용 디스크 콜드 사본입니다. 먼저 머신을 중지하며, 열린 창과 메모리(RAM)는 저장하지 않습니다.',
    snapWarn: '사본에는 디스크의 모든 것 — 앱이 저장한 자격 증명과 로그인 포함 — 이 들어갑니다. 공급자 계정 안에서 비공개로 남고, 내려받기로 제공하지 않습니다.',
    snapName: '스냅샷 이름', snapHint: '소문자·숫자·하이픈 3–48자.', snapBad: '소문자·숫자·하이픈 3–48자, 처음과 끝은 문자나 숫자여야 합니다.',
    snapSave: '환경 저장', snapSaving: '저장 중…', snapLast: (n: string, s: string) => `마지막 스냅샷: ${n} — ${s}`, snapErr: (e: string) => `스냅샷 오류: ${e}`,
    snapNeedsMachine: '머신이 있고 실행 중이거나 중지됐을 때 쓸 수 있습니다.',
    snapUnconfirmed: (n: string) => `마지막 스냅샷: ${n} — 확인 안 됨. 공급자가 보고하지 않아 없을 수도 있습니다.`,
    snapExists: '같은 이름의 스냅샷이 이미 있습니다. 덮어쓰지 않았습니다 — 다른 이름을 고르세요.',
    termTitle: '터미널과 휴대폰 키보드', termBtn: '원격 데스크톱에서 입력하는 법',
    termSteps: [
      '데스크톱을 연 뒤 데스크톱 메뉴에서 터미널을 엽니다. 명령은 이 휴대폰이 아니라 클라우드 머신에서 실행됩니다.',
      '휴대폰에서 입력하려면 데스크톱 뷰어의 옆 패널을 열고 화면 키보드를 켜세요. 그러면 휴대폰 키보드가 원격 데스크톱으로 키를 보냅니다.',
      '로그인(Claude, Codex, Cursor…)은 원격 데스크톱 안에서 합니다. CLI 가 로그인 링크를 보여 주면 데스크톱 브라우저에 붙여 넣으세요.',
    ],
    appsTitle: '머신의 앱', appsLead: '각 서비스가 제공하는 방식과 실행 중인 머신이 보고한 상태입니다. 서버가 알려 주지 않으면 연결됐다고 표시하지 않습니다.',
    surf: { native: '네이티브 CLI', web: '데스크톱 브라우저 웹', api: 'k 중계 API 키' } as Record<Surface, string>,
    installed: 'CLI 설치됨', notInstalled: 'CLI 설치 안 됨', unprobed: 'CLI 아직 확인 안 됨', notInImage: '이미지에 CLI 없음', notReported: '보고 없음',
    webLauncher: '데스크톱 웹 실행기', brokerKey: '중계 키 — 확인 안 됨', signInNote: '로그인은 데스크톱 안에서 하며 여기서 추적하지 않습니다.',
    connected: '로그인 / 키 설정됨', notConnected: '연결 안 됨',
    machineOffNote: '설치 상태는 실행 중인 머신이 알려 줍니다. 확인하려면 시작하세요.',
    nestedTitle: '중첩 컴퓨트 (Daytona, Nosana)', nestedLead: '이 머신 안에 범위가 제한된 Daytona·Nosana 명령줄 접근을 설정해 달라고 서버에 요청합니다. 성공 여부는 서버 응답으로만 압니다.',
    nestedConfigure: '중첩 컴퓨트 설정', nestedConfiguring: '설정 중…', nestedJobs: '중첩 작업 보기', nestedLoading: '작업 불러오는 중…',
    nestedNone: '서버가 보고한 중첩 작업이 없습니다.', nestedFailed: '중첩 작업을 불러오지 못했습니다.', nestedNeedsRunning: '머신이 실행 중일 때 쓸 수 있습니다.',
    keysTitle: '계정과 키', keysLead: 'k.shinick.dev 에서 API 키를 빌리고 중계 접근을 승인합니다. 승인 링크는 이 휴대폰에서 바로 열리므로 QR 코드나 다른 기기가 필요 없습니다.',
    broker: 'k 중계 열기', vault: '키 금고 열기',
    perfTitle: '성능과 크기', perfLead: '이 머신의 실제 CPU·메모리 사용량과 더 큰 크기의 예상 비용입니다. 지금 확인을 누르기 전에는 확인하지 않습니다.',
    perfCheck: '지금 확인', perfChecking: '확인 중…', perfFailed: '성능 정보를 불러오지 못했습니다.', perfNeedsMachine: '머신이 있어야 쓸 수 있습니다.',
    perfNotLoaded: '아직 확인하지 않았습니다.', sampled: (t: string) => `${t} 측정`, notSampled: '머신이 실시간 사용량을 보고하지 않았습니다 (중지됐거나 시작 중일 수 있음).',
    cpuUse: 'CPU 사용률', memUse: '메모리 사용량', load: '부하 (1분)', unknownVal: '모름',
    memOf: (u: string, l: string, p: string) => `${l} GiB 중 ${u} (${p}%)`, nowSize: '현재 크기', sizeLine: (c: number, m: number) => `vCPU ${c} · RAM ${m} GiB`,
    perHour: (u: string) => `시간당 약 ${u}`, priceNote: (a: string) => `${a} 기준 Daytona 공시 가격으로 추정했습니다. 견적이나 보장이 아니며 디스크는 그대로입니다.`,
    pricingLink: 'Daytona 가격', upgradeLabel: '더 큰 크기', pickPlan: '크기를 고르세요…', noPlans: '이 머신에 제공되는 더 큰 크기가 없습니다.',
    planOption: (s: string, delta: string) => `${s} — 시간당 ${delta} 추가`, review: '비용 확인', needsRunning: '크기 변경은 머신이 실행 중일 때 할 수 있습니다.',
    reviewTitle: '크기 변경 확인', reviewFrom: '지금', reviewTo: '변경 후', reviewDelta: '추가 비용', reviewDeltaVal: (u: string) => `머신이 켜져 있는 동안 시간당 ${u} 추가`,
    reviewKeep: (dk: string) => `파일은 남습니다. 디스크는 ${dk} GiB 그대로입니다. 공급자에 여유가 없으면 거절될 수 있습니다.`,
    apply: '업그레이드 적용', applying: '적용 중…', cancel: '취소', reviewStale: '머신이나 가격이 바뀌었습니다. 적용하기 전에 다시 확인하세요.',
    resizePending: (s: string) => `${s}(으)로 크기를 바꾸는 중입니다. 머신이 보고했는지 지금 확인을 눌러 보세요.`,
    resizeFailed: (c: string) => `마지막 크기 변경 실패: ${c}`, resizeCheck: '다른 변경을 요청하기 전에 지금 확인을 눌러 마지막 크기 변경이 적용됐는지 보세요.',
    resizeDone: (s: string) => `머신이 ${s}(으)로 보고합니다.`,
    gpuTitle: '원격 GPU 작업', gpuLead: '원격 GPU 작업은 따로 빌린 Nosana GPU 호스트에서 돕니다. 이 머신에 꽂힌 CUDA 장치가 아니므로 데스크톱의 nvidia-smi 나 PyTorch 에는 보이지 않습니다.',
    gpuNoSwitch: '여기서 샌드박스를 고르면 거리 기준만 바뀝니다. 데스크톱을 바꾸지 않습니다.',
    gpuSandboxes: '내 샌드박스 불러오기', gpuSandboxesLoading: '샌드박스 불러오는 중…', gpuSandbox: '거리 기준 샌드박스', gpuPickSandbox: '샌드박스를 고르세요…',
    gpuSandboxesFailed: '샌드박스를 불러오지 못했습니다.', gpuNoSandboxes: '보고된 샌드박스가 없습니다.', gpuPartial: '일부 공급자 계정이 답하지 않아 목록이 빠졌을 수 있습니다.',
    gpuVram: '최소 GPU 메모리', gpuVramOpt: (n: number) => `${n} GB 이상`, gpuFind: 'GPU 찾기', gpuFinding: '찾는 중…', gpuFailed: 'GPU 를 불러오지 못했습니다.',
    gpuNone: '맞는 GPU 가 없습니다.', gpuObserved: (t: string) => `${t} 확인`, gpuFrom: (n: string, r: string) => `기준: ${n} (${r || '–'})`,
    gpuVramVal: (n: string) => `GPU 메모리 ${n} GB`, gpuHosts: (n: string) => `빈 호스트 ${n}대`,
    gpuWhere: (c: string, km: string) => `${c} · 약 ${km} km (추정)`, gpuWhereNoKm: (c: string) => `${c} · 거리 모름`, gpuWhereUnknown: '위치 모름',
    gpuPrice: (lo: string, hi: string) => (lo === hi ? `기본 가격 시간당 ${lo}` : `기본 가격 시간당 ${lo}–${hi}`), gpuNoPrice: '가격 보고 없음', gpuFee: '네트워크 수수료는 따로입니다.',
    gpuDistanceNote: '거리는 국가 중심점과 샌드박스 지역 사이의 대략적인 추정입니다. 실제로 잰 네트워크 지연이 아닙니다.',
    gpuChoose: '선택', gpuChoosing: '선택 중…', gpuUnavailable: '지금 쓸 수 없음', gpuOdd: '서버 응답 형식이 예상과 달라 선택이 확인되지 않았습니다.',
    gpuChosen: (g: string, c: string) => `원격 GPU 작업용으로 선택: ${g} · ${c}. 아무것도 빌리지 않았고 실행 중인 작업도 없습니다.`,
    gpuRun: '유료 작업은 머신에서 이 명령을 실행할 때만 시작됩니다:', gpuCmd: '명령', copy: '복사', copied: '복사했습니다.', copyFailed: '복사하지 못했습니다 — 글자를 선택해 복사하세요.',
    gpuJobs: '작업 상태는 중첩 컴퓨트 → 중첩 작업 보기에서 봅니다.',
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;

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

/** {error:{code,message}} (computer API) or {error:'text'} (owner API) → a short, safe code */
function errorCode(body: unknown): string {
  if (!isObj(body)) return '';
  const e = body.error;
  if (isObj(e)) { const c = str(e.code, 64); return SAFE_CODE.test(c) ? c : ''; }
  return str(e, 120);
}

async function call(path: string, body?: unknown): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { return { ok: false, status: 0, code: '' }; }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  if (res.ok && !(isObj(parsed) && parsed.error !== undefined && parsed.error !== null)) return { ok: true, status: res.status, body: parsed };
  return { ok: false, status: res.ok ? 502 : res.status, code: errorCode(parsed) };
}

function normalizeState(raw: unknown): MachineState | null {
  if (!isObj(raw)) return null;
  const status: Status = STATUSES.includes(raw.status as Status) ? raw.status as Status : 'unknown';
  let machine: Machine | null = null;
  if (isObj(raw.machine)) {
    const m = raw.machine;
    machine = { id: str(m.id, 120), name: str(m.name, 120), account: str(m.account, 40), region: str(m.region, 40), cpu: num(m.cpu), memoryGiB: num(m.memoryGiB), diskGiB: num(m.diskGiB) };
  }
  let snapshot: Snapshot | null = null;
  if (isObj(raw.snapshot)) snapshot = { name: str(raw.snapshot.name, 64), state: str(raw.snapshot.state, 40), error: str(raw.snapshot.error, 64) || null };
  let tools: Map<string, ToolState> | null = null;
  const t = raw.tools;
  const entries: [string, unknown][] = Array.isArray(t) ? t.filter(isObj).map(x => [str(x.id, 40), x]) : isObj(t) ? Object.entries(t) : [];
  if (Array.isArray(t) || isObj(t)) {
    tools = new Map();
    for (const [id, v] of entries) {
      if (!id || !isObj(v)) continue;
      // status from the catalogue row; a bare {installed:boolean} probe row is read the same way. Anything else stays unknown
      const status = TOOL_STATUSES.includes(v.status as ToolStatus) ? v.status as ToolStatus
        : v.installed === true ? 'installed' : v.installed === false ? 'not_installed' : null;
      tools.set(id, { status, version: status === 'installed' ? str(v.version, 40) : '', connected: bool(v.connected) });
    }
  }
  const configuredAccounts: Account[] = Array.isArray(raw.configuredAccounts)
    ? raw.configuredAccounts.filter(isObj).filter(a => ACCOUNT_IDS.includes(a.id as AccountId))
      .map(a => ({ id: a.id as AccountId, label: str(a.label, 60) || String(a.id), available: a.available === true }))
    : [];
  const sessionEndsAt = typeof raw.sessionEndsAt === 'string' && Number.isFinite(Date.parse(raw.sessionEndsAt)) ? raw.sessionEndsAt : null;
  const errRaw = str(raw.error, 64);
  return { status, error: errRaw && SAFE_CODE.test(errRaw) ? errRaw : (errRaw ? 'error' : null), machine, sessionEndsAt, snapshot, tools, configuredAccounts, ready: raw.ready === true };
}

/** Only the separate desktop gateway, only the computer path, https, no embedded credentials */
function safeDesktopUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.origin !== GATEWAY_ORIGIN || u.username || u.password || (u.pathname !== DESKTOP_PATH && !u.pathname.startsWith(`${DESKTOP_PATH}/`))) return null;
  return u.href;
}

const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const country = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : null);
/** printable text only (no control characters) — server text is still drawn with textContent */
const plain = (v: unknown, max: number): string => str(v, max).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

/** GET performance → Perf, or null when the answer is not the documented shape. Only size increases are kept as plans. */
function normalizePerf(raw: unknown): Perf | null {
  if (!isObj(raw) || !isObj(raw.current)) return null;
  const machineId = str(raw.machineId, 120), c = raw.current;
  const cur = { cpu: num(c.cpu), memoryGiB: num(c.memoryGiB), diskGiB: num(c.diskGiB), usdPerHour: num(c.usdPerHour) };
  if (!machineId || cur.cpu === null || cur.memoryGiB === null || cur.diskGiB === null || cur.usdPerHour === null) return null;
  const current = { cpu: cur.cpu, memoryGiB: cur.memoryGiB, diskGiB: cur.diskGiB, usdPerHour: cur.usdPerHour };
  let metrics: Metrics | null = null;
  if (isObj(raw.metrics)) {
    const m = raw.metrics;
    const used = num(m.memoryUsedGiB), limit = num(m.memoryLimitGiB), pct = num(m.memoryPercent), load1 = num(m.load1);
    if (used !== null && limit !== null && pct !== null && load1 !== null) metrics = { cpuPercent: num(m.cpuPercent), memoryUsedGiB: used, memoryLimitGiB: limit, memoryPercent: pct, load1 };
  }
  const plans: Plan[] = [];
  for (const p of Array.isArray(raw.plans) ? raw.plans.filter(isObj).slice(0, 8) : []) {
    const cpu = num(p.cpu), memoryGiB = num(p.memoryGiB), usdPerHour = num(p.usdPerHour), deltaUsdPerHour = num(p.deltaUsdPerHour);
    if (cpu === null || memoryGiB === null || usdPerHour === null || deltaUsdPerHour === null || deltaUsdPerHour <= 0) continue;
    if (cpu < current.cpu || memoryGiB < current.memoryGiB || (cpu === current.cpu && memoryGiB === current.memoryGiB)) continue;
    if (!plans.some(x => x.cpu === cpu && x.memoryGiB === memoryGiB)) plans.push({ cpu, memoryGiB, usdPerHour, deltaUsdPerHour });
  }
  const rz = isObj(raw.resize) ? raw.resize : {};
  const status: ResizeStatus = rz.status === 'pending' || rz.status === 'failed' ? rz.status : 'idle';
  const rzErr = str(rz.error, 64);
  const pr = isObj(raw.pricing) ? raw.pricing : {};
  return {
    machineId, sampledAt: iso(raw.sampledAt), metrics, current, plans,
    resize: { status, cpu: num(rz.cpu), memoryGiB: num(rz.memoryGiB), error: rzErr ? (SAFE_CODE.test(rzErr) ? rzErr : 'error') : null },
    pricing: { asOf: plain(pr.asOf, 40), url: safePricingUrl(pr.url) },
  };
}
function safePricingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && PRICING_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port ? u.href : null;
  } catch { return null; }
}

function normalizeSandboxes(raw: unknown): { list: Sandbox[]; partial: boolean } | null {
  if (!isObj(raw) || !Array.isArray(raw.sandboxes)) return null;
  const list: Sandbox[] = [];
  for (const s of raw.sandboxes.filter(isObj).slice(0, 60)) {
    const id = str(s.id, 120), account = str(s.account, 40);
    if (!SAFE_ID.test(id) || !SAFE_ACCOUNT.test(account) || list.some(x => x.id === id && x.account === account)) continue;
    list.push({ id, account, name: plain(s.name, 80), region: plain(s.region, 40), state: plain(s.state, 30), cpu: num(s.cpu), memoryGiB: num(s.memoryGiB) });
  }
  return { list, partial: raw.partial === true };
}
const sandboxKey = (s: { id: string; account: string }) => `${s.account}/${s.id}`;

/** GET gpu/candidates → only accepted when it answers for exactly the sandbox that was asked about */
function normalizeCandidates(raw: unknown, want: Sandbox): Candidates | null {
  if (!isObj(raw) || !isObj(raw.sandbox) || !Array.isArray(raw.candidates)) return null;
  if (raw.sandbox.id !== want.id || raw.sandbox.account !== want.account) return null;
  const list: Candidate[] = [];
  for (const c of raw.candidates.filter(isObj).slice(0, 50)) {
    const id = str(c.id, 120);
    if (!SAFE_ID.test(id) || list.some(x => x.id === id)) continue;
    const available = num(c.available);
    list.push({
      id, gpu: plain(c.gpu, 80) || id, vramGb: num(c.vramGb), available, country: country(c.country), market: plain(c.market, 80) || null,
      usdPerHourMin: num(c.usdPerHourMin), usdPerHourMax: num(c.usdPerHourMax), distanceKm: num(c.distanceKm),
      selectable: c.selectable === true && available !== null && available > 0,
    });
  }
  return { key: sandboxKey(want), region: plain(raw.sandbox.region, 40) || want.region, observedAt: iso(raw.observedAt), note: plain(raw.note, 400), list };
}

const shellWord = (s: string) => (/^[A-Za-z0-9._:/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** POST gpu/select → the recorded choice; the command shown is the server's only when it is one plain cloudbite-compute line */
function normalizeChoice(raw: unknown, candidateId: string): GpuChoice | null {
  if (!isObj(raw) || !isObj(raw.selection) || raw.selection.candidateId !== candidateId) return null;
  const s = raw.selection, gpu = plain(s.gpu, 80);
  if (!gpu) return null;
  const c = country(s.country);
  const cmd = typeof raw.commandExample === 'string' && raw.commandExample.length <= 400 && /^cloudbite-compute [\x20-\x7e]+$/.test(raw.commandExample) ? raw.commandExample
    : `cloudbite-compute run --provider nosana --gpu ${shellWord(gpu)}${c ? ` --country ${c}` : ''} -- <command>`;
  return { candidateId, gpu, country: c, market: plain(s.market, 80) || null, command: cmd };
}

function fromB64u(s: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function toB64u(v: ArrayBuffer | ArrayBufferView): string {
  const u = ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function requestOptions(raw: unknown): PublicKeyCredentialRequestOptions | null {
  if (!isObj(raw) || typeof raw.challenge !== 'string' || !raw.challenge) return null;
  const allow = raw.allowCredentials === undefined ? [] : raw.allowCredentials;
  if (!Array.isArray(allow) || !allow.every(x => isObj(x) && typeof x.id === 'string')) return null;
  try {
    return {
      ...(raw as object),
      challenge: fromB64u(raw.challenge),
      allowCredentials: (allow as Record<string, unknown>[]).map(x => ({ ...x, type: 'public-key', id: fromB64u(x.id as string) }) as PublicKeyCredentialDescriptor),
    } as PublicKeyCredentialRequestOptions;
  } catch { return null; }
}
type Assertion = {
  id: string; rawId: ArrayBuffer; type: string; authenticatorAttachment?: string | null;
  response: { clientDataJSON: ArrayBuffer; authenticatorData: ArrayBuffer; signature: ArrayBuffer; userHandle: ArrayBuffer | null };
  getClientExtensionResults?: () => unknown;
};
function assertionJSON(c: Assertion): Record<string, unknown> {
  return {
    id: c.id, rawId: toB64u(c.rawId), type: c.type,
    response: {
      clientDataJSON: toB64u(c.response.clientDataJSON), authenticatorData: toB64u(c.response.authenticatorData),
      signature: toB64u(c.response.signature), ...(c.response.userHandle ? { userHandle: toB64u(c.response.userHandle) } : {}),
    },
    clientExtensionResults: typeof c.getClientExtensionResults === 'function' ? c.getClientExtensionResults() : {},
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}
/** register/options JSON (bare or {publicKey}) → creation options with challenge, user.id and excludeCredentials ids decoded */
function creationOptions(raw: unknown): PublicKeyCredentialCreationOptions | null {
  const o = isObj(raw) && isObj(raw.publicKey) ? raw.publicKey : raw;
  if (!isObj(o) || typeof o.challenge !== 'string' || !o.challenge || !isObj(o.user) || typeof o.user.id !== 'string' || !o.user.id) return null;
  const exclude = o.excludeCredentials === undefined ? [] : o.excludeCredentials;
  if (!Array.isArray(exclude) || !exclude.every(x => isObj(x) && typeof x.id === 'string')) return null;
  try {
    return {
      ...(o as object),
      challenge: fromB64u(o.challenge),
      user: { ...(o.user as object), id: fromB64u(o.user.id) },
      excludeCredentials: (exclude as Record<string, unknown>[]).map(x => ({ ...x, type: 'public-key', id: fromB64u(x.id as string) }) as PublicKeyCredentialDescriptor),
    } as PublicKeyCredentialCreationOptions;
  } catch { return null; }
}
type Attestation = {
  id: string; rawId: ArrayBuffer; type: string; authenticatorAttachment?: string | null;
  response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer; getTransports?: () => unknown };
  getClientExtensionResults?: () => unknown;
};
function attestationJSON(c: Attestation): Record<string, unknown> {
  const t = typeof c.response.getTransports === 'function' ? c.response.getTransports() : [];
  return {
    id: c.id, rawId: toB64u(c.rawId), type: c.type,
    response: {
      attestationObject: toB64u(c.response.attestationObject), clientDataJSON: toB64u(c.response.clientDataJSON),
      transports: Array.isArray(t) ? t.filter(x => typeof x === 'string') : [],
    },
    clientExtensionResults: typeof c.getClientExtensionResults === 'function' ? c.getClientExtensionResults() : {},
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}

/** prefix + canonical base64url of exactly 32 bytes; anything else is never sent */
function validPairToken(t: string): boolean {
  const m = PAIR_TOKEN.exec(t);
  if (!m) return false;
  try { const b = fromB64u(m[1]); return b.byteLength === 32 && toB64u(b) === m[1]; } catch { return false; }
}
type PairLink = { present: boolean; token: string | null };
/** Runs before mount: a #pair= fragment leaves the address bar (and history) before any render or fetch. */
function takePairLink(): PairLink {
  const raw = typeof location.hash === 'string' ? location.hash : '';
  if (!raw.startsWith('#pair=')) return { present: false, token: null };
  try { history.replaceState(history.state, '', `${location.pathname}${location.search}`); } catch { location.hash = ''; }
  const t = raw.slice('#pair='.length);
  return { present: true, token: validPairToken(t) ? t : null };
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
function link(cls: string, href: string, external: boolean): HTMLAnchorElement {
  const a = h('a', cls);
  a.setAttribute('href', href);
  if (external) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
  return a;
}

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement, pair: PairLink): void {
  const qs = new URLSearchParams(location.search).get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;

  const S = {
    auth: 'checking' as 'checking' | 'in' | 'out' | 'failed', hasCredentials: false, authBusy: false, authMsg: null as Msg,
    pairing: pair.present, paired: false, enrollBusy: false, enrollMsg: null as Msg,
    state: null as MachineState | null, loading: false, loadMsg: null as Msg,
    account: '' as AccountId | '', op: null as Op | null, opMsg: null as Msg,
    launching: false, launchUrl: '', launchMsg: null as Msg, snapName: '', snapMsg: null as Msg, termOpen: false,
    jobs: null as NestedJob[] | null, jobsLoading: false, jobsMsg: null as Msg,
    // performance card: fetched only from Check now (or right after a size change answer), never by polling
    perf: null as Perf | null, perfLoading: false, perfMsg: null as Msg, plan: '', review: null as Review | null, reviewMsg: null as Msg,
    resizeCheck: false, // a size change ended without a confirmed answer: Check now must succeed before another one is offered
    sent: null as { cpu: number; memoryGiB: number } | null,
    // remote GPU card
    sandboxes: null as Sandbox[] | null, sbPartial: false, sbLoading: false, sbMsg: null as Msg, sandbox: '', vram: 24,
    cands: null as Candidates | null, candLoading: false, candMsg: null as Msg, gpuOp: null as GpuOp | null, gpuMsg: null as Msg, choice: null as GpuChoice | null, copyMsg: null as Msg,
  };
  let pollTimer: ReturnType<typeof setTimeout> | null = null, polls = 0, clockTimer: ReturnType<typeof setTimeout> | null = null, loadSeq = 0;
  // bumped on sign-out and on every selection change, so an answer that arrives late is dropped instead of drawn
  let perfSeq = 0, sbSeq = 0, candSeq = 0, gpuSeq = 0;

  // ── skeleton ──
  const brandSub = h('span', 'cc-sub');
  const workbench = link('cc-nav-link', WORKBENCH_PATH, false);
  const langNav = h('nav', 'cc-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = button('cc-lang-btn', () => { if (lang !== l) { lang = l; render(); } });
    b.textContent = l.toUpperCase(); b.setAttribute('lang', l);
    langNav.append(b);
    return b;
  });
  const brand = h('strong', 'cc-brand');
  const header = h('header', 'cc-header', h('div', 'cc-brand-row', brand, brandSub), h('div', 'cc-header-side', workbench, langNav));

  const h1 = h('h1'), lead = h('p', 'cc-lead');

  const authTitle = h('h2'), authLead = h('p', 'cc-muted'), authMsg = h('p', 'cc-msg');
  authMsg.setAttribute('role', 'status');
  const signInBtn = button('cc-btn cc-primary', () => { void login(); });
  const setupNote = h('p', 'cc-muted'), setupLink = link('cc-text-link', OWNER_SETUP_PATH, false);
  const authCard = h('section', 'cc-card cc-auth', authTitle, authLead, signInBtn, h('div', '', setupNote, setupLink), authMsg);

  const statusPill = h('span', 'cc-pill'), statusLead = h('p', 'cc-muted'), machineH = h('h2');
  const facts = h('dl', 'cc-facts');
  const sessionLine = h('p', 'cc-session'), sessionNote = h('p', 'cc-fine');
  const accountLabel = h('label', 'cc-field-label'), accountSel = h('select', 'cc-select');
  accountSel.id = 'cc-account'; accountLabel.setAttribute('for', 'cc-account');
  accountSel.addEventListener('change', () => { S.account = ACCOUNT_IDS.includes(accountSel.value as AccountId) ? accountSel.value as AccountId : ''; render(); });
  const accountWrap = h('div', 'cc-field', accountLabel, accountSel);
  const accountNote = h('p', 'cc-msg cc-warn');
  const startBtn = button('cc-btn cc-primary', () => { startOrResume(); });
  const openBtn = button('cc-btn cc-primary', () => { void launch(); });
  const stopBtn = button('cc-btn', () => { begin('stop', {}); });
  const extendBtn = button('cc-btn', () => { begin('extend', {}); });
  const refreshBtn = button('cc-btn cc-quiet', () => { polls = 0; void loadState(); });
  const actions = h('div', 'cc-actions', startBtn, openBtn, stopBtn, extendBtn, refreshBtn);
  const launchMsg = h('p', 'cc-msg'), launchLink = link('cc-btn cc-primary cc-launch', '#', true), launchHint = h('p', 'cc-fine');
  launchMsg.setAttribute('role', 'status');
  launchLink.addEventListener('click', () => { setTimeout(() => { S.launchUrl = ''; render(); }, 0); });
  const launchBox = h('div', 'cc-launch-box', launchMsg, launchLink, launchHint);
  const opMsg = h('p', 'cc-msg'), retryBtn = button('cc-btn', () => { if (S.op) void send(S.op); }), forgetBtn = button('cc-btn cc-quiet', () => { forgetOp(); });
  opMsg.setAttribute('role', 'status');
  const opBox = h('div', 'cc-op', opMsg, h('div', 'cc-actions', retryBtn, forgetBtn));
  const loadMsg = h('p', 'cc-msg');
  loadMsg.setAttribute('role', 'status');
  const keepTitle = h('h3'), keepText = h('p', 'cc-muted');
  const machineCard = h('section', 'cc-card cc-machine',
    h('div', 'cc-machine-head', machineH, statusPill), statusLead, loadMsg, facts, sessionLine, sessionNote,
    accountWrap, accountNote, actions, opBox, launchBox, h('div', 'cc-keep', keepTitle, keepText));

  const phoneTitle = h('h2'), phoneLead = h('p', 'cc-muted'), phonePaired = h('p', 'cc-msg cc-ok'), phoneMsg = h('p', 'cc-msg');
  phoneMsg.setAttribute('role', 'status');
  const phoneBtn = button('cc-btn', () => { void enroll(); });
  const phoneCard = h('section', 'cc-card cc-phone', phoneTitle, phonePaired, phoneLead, phoneBtn, phoneMsg);

  const termTitle = h('h2'), termBtn = button('cc-btn cc-quiet cc-term-btn', () => { S.termOpen = !S.termOpen; render(); });
  const termList = h('ol', 'cc-steps');
  termList.id = 'cc-term-steps'; termBtn.setAttribute('aria-controls', 'cc-term-steps');
  const termCard = h('section', 'cc-card', termTitle, termBtn, termList);

  const snapTitle = h('h2'), snapLead = h('p', 'cc-muted'), snapWarn = h('p', 'cc-callout');
  const snapLabel = h('label', 'cc-field-label'), snapIn = h('input', 'cc-input'), snapHint = h('p', 'cc-fine');
  snapIn.id = 'cc-snap-name'; snapLabel.setAttribute('for', 'cc-snap-name');
  snapIn.setAttribute('autocomplete', 'off'); snapIn.setAttribute('autocapitalize', 'none'); snapIn.setAttribute('spellcheck', 'false');
  snapIn.setAttribute('maxlength', '48'); snapIn.setAttribute('inputmode', 'text');
  snapIn.addEventListener('input', () => { S.snapName = snapIn.value; S.snapMsg = null; render(); });
  const snapBtn = button('cc-btn', () => { saveSnapshot(); });
  const snapMsg = h('p', 'cc-msg'), snapLast = h('p', 'cc-fine');
  snapMsg.setAttribute('role', 'status');
  const snapCard = h('section', 'cc-card', snapTitle, snapLead, snapWarn, h('div', 'cc-field', snapLabel, snapIn, snapHint), snapBtn, snapMsg, snapLast);

  const appsTitle = h('h2'), appsLead = h('p', 'cc-muted'), appsNote = h('p', 'cc-fine'), appsGrid = h('ul', 'cc-apps');
  const appsSignIn = h('p', 'cc-fine');
  const appsCard = h('section', 'cc-card cc-apps-card', appsTitle, appsLead, appsNote, appsSignIn, appsGrid);

  const nestedTitle = h('h2'), nestedLead = h('p', 'cc-muted'), nestedMsg = h('p', 'cc-msg'), jobsList = h('ul', 'cc-jobs');
  nestedMsg.setAttribute('role', 'status');
  const nestedBtn = button('cc-btn', () => { begin('nested/configure', {}); });
  const jobsBtn = button('cc-btn cc-quiet', () => { void loadJobs(); });
  const nestedCard = h('section', 'cc-card', nestedTitle, nestedLead, h('div', 'cc-actions', nestedBtn, jobsBtn), nestedMsg, jobsList);

  const keysTitle = h('h2'), keysLead = h('p', 'cc-muted');
  const brokerLink = link('cc-btn', BROKER_URL, true), vaultLink = link('cc-btn', VAULT_URL, true);
  const keysCard = h('section', 'cc-card', keysTitle, keysLead, h('div', 'cc-actions', brokerLink, vaultLink));

  // performance and size
  const perfTitle = h('h2'), perfLead = h('p', 'cc-muted'), perfMsg = h('p', 'cc-msg'), perfSampled = h('p', 'cc-fine');
  perfMsg.setAttribute('role', 'status');
  const perfBtn = button('cc-btn cc-quiet', () => { void loadPerf(); });
  const perfFacts = h('dl', 'cc-facts');
  const priceNote = h('p', 'cc-fine'), pricingLink = link('cc-text-link', '#', true);
  const planLabel = h('label', 'cc-field-label'), planSel = h('select', 'cc-select');
  planSel.id = 'cc-plan'; planLabel.setAttribute('for', 'cc-plan');
  planSel.addEventListener('change', () => { S.plan = planSel.value; S.review = null; S.reviewMsg = null; render(); });
  const planWrap = h('div', 'cc-field', planLabel, planSel);
  const reviewBtn = button('cc-btn', () => { openReview(); });
  const reviewTitle = h('h3'), reviewFacts = h('dl', 'cc-facts'), reviewKeep = h('p', 'cc-fine');
  const applyBtn = button('cc-btn cc-primary', () => { applyResize(); });
  const cancelBtn = button('cc-btn cc-quiet', () => { S.review = null; render(); });
  const reviewBox = h('div', 'cc-review', reviewTitle, reviewFacts, reviewKeep, h('div', 'cc-actions', applyBtn, cancelBtn));
  reviewBox.setAttribute('role', 'group');
  const reviewMsg = h('p', 'cc-msg');
  reviewMsg.setAttribute('role', 'status');
  // an uncertain size change is retried with the same requestId from here too (same handlers as the machine card)
  const rzRetry = button('cc-btn', () => { if (S.op?.kind === 'resize') void send(S.op); }), rzForget = button('cc-btn cc-quiet', () => { forgetOp(); });
  const rzRetryRow = h('div', 'cc-actions', rzRetry, rzForget);
  const perfCard = h('section', 'cc-card cc-perf', perfTitle, perfLead, h('div', 'cc-actions', perfBtn), perfMsg, perfSampled, perfFacts,
    h('div', 'cc-price', priceNote, pricingLink), planWrap, reviewBtn, reviewMsg, rzRetryRow, reviewBox);

  // remote GPU jobs
  const gpuTitle = h('h2'), gpuLead = h('p', 'cc-muted'), gpuNoSwitch = h('p', 'cc-fine');
  const sbBtn = button('cc-btn cc-quiet', () => { void loadSandboxes(); });
  const sbMsg = h('p', 'cc-msg');
  sbMsg.setAttribute('role', 'status');
  const sbLabel = h('label', 'cc-field-label'), sbSel = h('select', 'cc-select');
  sbSel.id = 'cc-gpu-sandbox'; sbLabel.setAttribute('for', 'cc-gpu-sandbox');
  sbSel.addEventListener('change', () => { if (S.gpuOp) { render(); return; } S.sandbox = sbSel.value; dropCandidates(); render(); });
  const vramLabel = h('label', 'cc-field-label'), vramSel = h('select', 'cc-select');
  vramSel.id = 'cc-gpu-vram'; vramLabel.setAttribute('for', 'cc-gpu-vram');
  vramSel.addEventListener('change', () => {
    if (S.gpuOp) { render(); return; }
    const n = Number(vramSel.value); S.vram = VRAM_CHOICES.includes(n) ? n : 24; dropCandidates(); render();
  });
  const sbWrap = h('div', 'cc-field', sbLabel, sbSel), vramWrap = h('div', 'cc-field', vramLabel, vramSel);
  const findBtn = button('cc-btn', () => { void loadCandidates(); });
  const candMsg = h('p', 'cc-msg'), candHead = h('p', 'cc-fine'), candNote = h('p', 'cc-fine'), distNote = h('p', 'cc-fine'), candList = h('ul', 'cc-gpus');
  candMsg.setAttribute('role', 'status');
  const gpuMsg = h('p', 'cc-msg');
  gpuMsg.setAttribute('role', 'status');
  const gpuRetry = button('cc-btn', () => { if (S.gpuOp) void sendChoice(S.gpuOp); });
  const gpuForget = button('cc-btn cc-quiet', () => { S.gpuOp = null; S.gpuMsg = null; gpuSeq++; render(); });
  const gpuRetryRow = h('div', 'cc-actions', gpuRetry, gpuForget);
  const chosenText = h('p', 'cc-msg cc-ok'), runText = h('p', 'cc-fine'), cmdLabel = h('label', 'cc-field-label'), cmdIn = h('input', 'cc-input cc-cmd');
  cmdIn.id = 'cc-gpu-cmd'; cmdLabel.setAttribute('for', 'cc-gpu-cmd');
  cmdIn.setAttribute('readonly', ''); cmdIn.setAttribute('autocomplete', 'off'); cmdIn.setAttribute('autocapitalize', 'none'); cmdIn.setAttribute('spellcheck', 'false');
  cmdIn.addEventListener('focus', () => { cmdIn.select(); });
  const copyBtn = button('cc-btn', () => { void copyCommand(); });
  const copyMsg = h('p', 'cc-msg');
  copyMsg.setAttribute('role', 'status');
  const jobsNote = h('p', 'cc-fine');
  const chosenBox = h('div', 'cc-chosen', chosenText, runText, h('div', 'cc-field', cmdLabel, cmdIn), copyBtn, copyMsg, jobsNote);
  const gpuCard = h('section', 'cc-card cc-gpu', gpuTitle, gpuLead, gpuNoSwitch, h('div', 'cc-actions', sbBtn), sbMsg, sbWrap, vramWrap, findBtn,
    candMsg, candHead, distNote, candNote, candList, gpuMsg, gpuRetryRow, chosenBox);

  const signOutBtn = button('cc-btn cc-quiet', () => { void logout(); });
  const footer = h('footer', 'cc-footer', signOutBtn);

  const signedIn = h('div', 'cc-grid', phoneCard, machineCard, perfCard, gpuCard, h('div', 'cc-side', termCard, snapCard, keysCard, nestedCard), appsCard);
  const main = h('main', 'cc-main', h1, lead, authCard, signedIn, footer);
  root.replaceChildren(header, main);

  // ── render ──
  function setMsg(el: HTMLElement, m: Msg): void {
    el.hidden = !m;
    el.textContent = m ? m.text() : '';
    el.className = `cc-msg${m ? ` cc-${m.kind}` : ''}`;
  }
  function fact(label: string, value: string): Node[] { return [h('dt', '', label), h('dd', '', value)]; }
  const fmt = (n: number | null) => (n === null ? '–' : String(n));

  function render(): void {
    const d = T(), st = S.state, status = st?.status ?? null;
    document.documentElement.lang = lang;
    document.title = d.title;
    brand.textContent = d.brand; brandSub.textContent = d.sub; workbench.textContent = d.workbench;
    langNav.setAttribute('aria-label', d.langLabel);
    for (const b of langBtns) b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    h1.textContent = d.h1; lead.textContent = d.lead;

    // auth
    authCard.hidden = S.auth === 'in';
    signedIn.hidden = S.auth !== 'in';
    signOutBtn.hidden = S.auth !== 'in';
    signOutBtn.textContent = d.signOut; signOutBtn.disabled = S.authBusy;
    authTitle.textContent = d.signInTitle; authLead.textContent = d.signInLead;
    signInBtn.textContent = S.authBusy ? d.signingIn : d.signIn;
    signInBtn.disabled = S.authBusy || S.auth === 'checking';
    signInBtn.hidden = S.auth === 'out' && !S.hasCredentials;
    setupNote.textContent = d.noKey; setupLink.textContent = d.setupLink;
    setupNote.parentElement!.hidden = !(S.auth === 'out' && !S.hasCredentials);
    setMsg(authMsg, S.auth === 'checking' ? { text: () => (S.pairing ? d.pairing : d.checking), kind: 'info' } : S.authMsg);
    if (S.auth !== 'in') return;

    // this phone's passkey: offered while signed in, only ever started by the button
    phoneCard.className = `cc-card cc-phone${S.paired ? ' cc-phone-paired' : ''}`;
    phoneTitle.textContent = d.phoneTitle; phoneLead.textContent = d.phoneLead;
    phonePaired.textContent = d.pairOk; phonePaired.hidden = !S.paired;
    phoneBtn.className = `cc-btn${S.paired || !S.hasCredentials ? ' cc-primary' : ''}`;
    phoneBtn.textContent = S.enrollBusy ? d.phoneBusy : S.paired || !S.hasCredentials ? d.phoneRegister : d.phoneAdd;
    phoneBtn.disabled = S.enrollBusy;
    setMsg(phoneMsg, S.enrollMsg);

    // machine
    machineH.textContent = d.machine;
    statusPill.textContent = status ? d.status[status] : d.loadingState;
    statusPill.className = `cc-pill cc-s-${status ?? 'loading'}`;
    statusLead.textContent = status ? d.statusLead[status] : '';
    statusLead.hidden = !status;
    setMsg(loadMsg, S.loadMsg ?? (st?.error ? { text: () => (st.error === 'snapshot_exists' ? d.snapExists : d.rejected(st.error as string)), kind: 'warn' } : null));

    const m = st?.machine ?? null;
    facts.hidden = !m;
    if (m) facts.replaceChildren(
      ...fact(d.name, m.name || m.id || '–'), ...fact(d.account, m.account || '–'), ...fact(d.region, m.region || '–'),
      ...fact(d.resources, d.cpuMem(fmt(m.cpu), fmt(m.memoryGiB), fmt(m.diskGiB))));
    const ends = st?.sessionEndsAt ? Date.parse(st.sessionEndsAt) : NaN;
    if (Number.isFinite(ends)) {
      const mins = Math.floor((ends - Date.now()) / 60000);
      const t = new Date(ends).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
      sessionLine.textContent = `${d.session}: ${ends <= Date.now() ? d.sessionOver : d.sessionEnds(t, mins)}`;
    } else sessionLine.textContent = `${d.session}: ${d.noSession}`;
    sessionLine.hidden = !st;
    sessionNote.textContent = d.sessionNote; sessionNote.hidden = !st;

    // accounts: choose only when there is no machine; an existing machine keeps its account
    const accounts = st?.configuredAccounts ?? [];
    const needAccount = !!st && !m && (status === 'absent' || status === 'error');
    accountWrap.hidden = !needAccount || accounts.length === 0;
    accountLabel.textContent = d.chooseAccount;
    if (needAccount) {
      if (!S.account || !accounts.some(a => a.id === S.account && a.available)) S.account = accounts.find(a => a.available)?.id ?? '';
      accountSel.replaceChildren(...accounts.map(a => {
        const o = h('option', '', a.available ? a.label : `${a.label} (${d.accountUnavailable})`);
        o.value = a.id; o.disabled = !a.available;
        return o;
      }));
      accountSel.value = S.account;
    }
    const machineAccount = m ? accounts.find(a => a.id === m.account) : undefined;
    const accountGone = !!m && accounts.length > 0 && (!machineAccount || !machineAccount.available);
    accountNote.hidden = !(needAccount && !accounts.some(a => a.available)) && !(accountGone && status === 'stopped');
    accountNote.textContent = accountGone ? d.accountMissing(machineAccount?.label || m?.account || '?') : d.noAccounts;

    const busy = !!S.op;
    startBtn.hidden = !(status === 'absent' || status === 'stopped' || (status === 'error' && !m));
    startBtn.textContent = S.op?.kind === 'start' && S.op.phase === 'sending' ? d.starting : status === 'stopped' ? d.resume : d.start;
    startBtn.disabled = busy || (status === 'stopped' ? accountGone : !S.account);
    openBtn.hidden = status !== 'running';
    openBtn.textContent = S.launching ? d.opening : d.open;
    openBtn.disabled = S.launching || !st?.ready;
    openBtn.title = st?.ready ? '' : d.notReady;
    stopBtn.hidden = !(status === 'running' || status === 'starting' || (status === 'error' && !!m));
    stopBtn.textContent = S.op?.kind === 'stop' && S.op.phase === 'sending' ? d.stopping : d.stop;
    stopBtn.disabled = busy;
    extendBtn.hidden = status !== 'running';
    extendBtn.textContent = S.op?.kind === 'extend' && S.op.phase === 'sending' ? d.extending : d.extend;
    extendBtn.disabled = busy;
    refreshBtn.textContent = S.loading ? d.refreshing : d.refresh;
    refreshBtn.disabled = S.loading;

    opBox.hidden = !S.opMsg && !S.op;
    setMsg(opMsg, S.op?.phase === 'uncertain' ? { text: () => d.uncertain, kind: 'warn' } : S.op ? { text: () => d.pending, kind: 'info' } : S.opMsg);
    retryBtn.textContent = d.retry; forgetBtn.textContent = d.forget;
    retryBtn.hidden = forgetBtn.hidden = S.op?.phase !== 'uncertain';

    launchBox.hidden = !S.launchUrl && !S.launchMsg;
    setMsg(launchMsg, S.launchUrl ? { text: () => d.openReady, kind: 'ok' } : S.launchMsg);
    launchLink.hidden = !S.launchUrl;
    launchLink.setAttribute('href', S.launchUrl || '#');
    launchLink.textContent = d.openLink; launchHint.textContent = d.openNewTab; launchHint.hidden = !S.launchUrl;
    keepTitle.textContent = d.keepTitle; keepText.textContent = d.keep;

    // terminal help
    termTitle.textContent = d.termTitle; termBtn.textContent = d.termBtn;
    termBtn.setAttribute('aria-expanded', String(S.termOpen));
    termList.hidden = !S.termOpen;
    termList.replaceChildren(...d.termSteps.map(s => h('li', '', s)));

    // snapshot
    snapTitle.textContent = d.snapTitle; snapLead.textContent = d.snapLead; snapWarn.textContent = d.snapWarn;
    snapLabel.textContent = d.snapName; snapHint.textContent = d.snapHint;
    if (snapIn.value !== S.snapName) snapIn.value = S.snapName;
    const canSnap = !!m && (status === 'running' || status === 'stopped');
    snapIn.disabled = !canSnap || busy;
    snapBtn.disabled = !canSnap || busy || !S.snapName;
    snapBtn.textContent = S.op?.kind === 'snapshot' && S.op.phase === 'sending' ? d.snapSaving : d.snapSave;
    setMsg(snapMsg, S.snapMsg ?? (!canSnap && st ? { text: () => d.snapNeedsMachine, kind: 'info' } : null));
    const snap = st?.snapshot;
    snapLast.hidden = !snap;
    snapLast.textContent = !snap ? '' : snap.error === 'snapshot_exists' ? d.snapExists : snap.error ? d.snapErr(snap.error)
      : snap.state === 'unconfirmed' ? d.snapUnconfirmed(snap.name || '–') : d.snapLast(snap.name || '–', snap.state || '–');

    // apps
    appsTitle.textContent = d.appsTitle; appsLead.textContent = d.appsLead;
    const reported = st?.tools ?? null;
    appsNote.textContent = d.machineOffNote;
    appsNote.hidden = !!reported;
    appsGrid.replaceChildren(...TOOLS.map(t => appCard(t, reported, d)));
    appsSignIn.textContent = d.signInNote;

    // nested compute
    nestedTitle.textContent = d.nestedTitle; nestedLead.textContent = d.nestedLead;
    const nestedOk = status === 'running';
    nestedBtn.textContent = S.op?.kind === 'nested/configure' && S.op.phase === 'sending' ? d.nestedConfiguring : d.nestedConfigure;
    nestedBtn.disabled = busy || !nestedOk;
    jobsBtn.textContent = S.jobsLoading ? d.nestedLoading : d.nestedJobs;
    jobsBtn.disabled = S.jobsLoading || !nestedOk;
    setMsg(nestedMsg, !nestedOk && st ? { text: () => d.nestedNeedsRunning, kind: 'info' } : S.jobsMsg);
    jobsList.hidden = !S.jobs || S.jobs.length === 0;
    jobsList.replaceChildren(...(S.jobs ?? []).map(j => h('li', '', `${j.provider || '–'} · ${j.id || '–'} · ${j.status || '–'}`)));

    keysTitle.textContent = d.keysTitle; keysLead.textContent = d.keysLead;
    brokerLink.textContent = d.broker; vaultLink.textContent = d.vault;

    renderPerf(d, m, status);
    renderGpu(d);
  }

  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  const when = (t: string | null) => (t ? new Date(Date.parse(t)).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : T().unknownVal);
  const planKey = (p: { cpu: number; memoryGiB: number }) => `${p.cpu}/${p.memoryGiB}`;
  const round1 = (n: number) => String(Math.round(n * 10) / 10);

  function renderPerf(d: Dict, m: Machine | null, status: Status | null): void {
    perfTitle.textContent = d.perfTitle; perfLead.textContent = d.perfLead;
    perfBtn.textContent = S.perfLoading ? d.perfChecking : d.perfCheck;
    perfBtn.disabled = S.perfLoading || !m;
    const p = S.perf;
    setMsg(perfMsg, S.perfMsg ?? (!m && S.state ? { text: () => d.perfNeedsMachine, kind: 'info' } : !p && !S.perfLoading ? { text: () => d.perfNotLoaded, kind: 'info' } : null));
    perfSampled.hidden = perfFacts.hidden = !p;
    if (p) {
      const mt = p.metrics;
      perfSampled.textContent = mt ? d.sampled(when(p.sampledAt)) : d.notSampled;
      perfFacts.replaceChildren(
        ...fact(d.nowSize, `${d.sizeLine(p.current.cpu, p.current.memoryGiB)} · ${d.perHour(money(p.current.usdPerHour))}`),
        ...fact(d.cpuUse, mt && mt.cpuPercent !== null ? `${round1(mt.cpuPercent)}%` : d.unknownVal),
        ...fact(d.memUse, mt ? d.memOf(round1(mt.memoryUsedGiB), round1(mt.memoryLimitGiB), round1(mt.memoryPercent)) : d.unknownVal),
        ...fact(d.load, mt ? String(Math.round(mt.load1 * 100) / 100) : d.unknownVal));
    }
    priceNote.parentElement!.hidden = !p;
    priceNote.textContent = p ? d.priceNote(p.pricing.asOf || d.unknownVal) : '';
    pricingLink.hidden = !p?.pricing.url;
    pricingLink.setAttribute('href', p?.pricing.url || '#');
    pricingLink.textContent = d.pricingLink;

    // a size change is offered only on fresh data, while running, with nothing else in flight
    const resizeOp = S.op?.kind === 'resize' ? S.op : null;
    const canResize = !!p && status === 'running' && !S.op && !S.perfLoading && !S.resizeCheck && p.resize.status !== 'pending';
    const plans = p?.plans ?? [];
    if (!plans.some(x => planKey(x) === S.plan)) S.plan = '';
    planWrap.hidden = !p;
    planLabel.textContent = d.upgradeLabel;
    const none = h('option', '', plans.length ? d.pickPlan : d.noPlans);
    none.value = '';
    planSel.replaceChildren(none, ...plans.map(x => {
      const o = h('option', '', d.planOption(d.sizeLine(x.cpu, x.memoryGiB), money(x.deltaUsdPerHour)));
      o.value = planKey(x);
      return o;
    }));
    planSel.value = S.plan;
    planSel.disabled = !canResize || !plans.length;
    reviewBtn.textContent = d.review;
    reviewBtn.hidden = !p || !plans.length;
    reviewBtn.disabled = !canResize || !S.plan || !!S.review;

    const target = p && p.resize.cpu !== null && p.resize.memoryGiB !== null ? d.sizeLine(p.resize.cpu, p.resize.memoryGiB) : '–';
    const reached = !!p && !!S.sent && p.resize.status === 'idle' && p.current.cpu === S.sent.cpu && p.current.memoryGiB === S.sent.memoryGiB;
    setMsg(reviewMsg, resizeOp?.phase === 'uncertain' ? { text: () => d.uncertain, kind: 'warn' }
      : S.reviewMsg ?? (S.resizeCheck && !resizeOp ? { text: () => d.resizeCheck, kind: 'warn' }
        : p?.resize.status === 'pending' ? { text: () => d.resizePending(target), kind: 'info' }
        : p?.resize.status === 'failed' ? { text: () => d.resizeFailed(p.resize.error || 'error'), kind: 'warn' }
        : reached && p ? { text: () => d.resizeDone(d.sizeLine(p.current.cpu, p.current.memoryGiB)), kind: 'ok' }
        : p && plans.length && status !== 'running' ? { text: () => d.needsRunning, kind: 'info' } : null));
    rzRetryRow.hidden = resizeOp?.phase !== 'uncertain';
    rzRetry.textContent = d.retry; rzForget.textContent = d.forget;

    const rv = S.review;
    reviewBox.hidden = !rv;
    if (rv) {
      reviewTitle.textContent = d.reviewTitle;
      reviewFacts.replaceChildren(
        ...fact(d.reviewFrom, `${d.sizeLine(rv.fromCpu, rv.fromMemoryGiB)} · ${d.perHour(money(rv.fromUsdPerHour))}`),
        ...fact(d.reviewTo, `${d.sizeLine(rv.cpu, rv.memoryGiB)} · ${d.perHour(money(rv.usdPerHour))}`),
        ...fact(d.reviewDelta, d.reviewDeltaVal(money(rv.deltaUsdPerHour))));
      reviewKeep.textContent = `${d.reviewKeep(String(rv.diskGiB))} ${d.priceNote(rv.asOf || d.unknownVal)}`;
      applyBtn.textContent = resizeOp?.phase === 'sending' ? d.applying : d.apply;
      applyBtn.disabled = cancelBtn.disabled = !!S.op;
      cancelBtn.textContent = d.cancel;
    }
  }

  function renderGpu(d: Dict): void {
    gpuTitle.textContent = d.gpuTitle; gpuLead.textContent = d.gpuLead; gpuNoSwitch.textContent = d.gpuNoSwitch;
    const locked = !!S.gpuOp;
    sbBtn.textContent = S.sbLoading ? d.gpuSandboxesLoading : d.gpuSandboxes;
    sbBtn.disabled = S.sbLoading || locked;
    const sbs = S.sandboxes ?? [];
    setMsg(sbMsg, S.sbMsg ?? (S.sandboxes && !sbs.length ? { text: () => d.gpuNoSandboxes, kind: 'info' } : S.sandboxes && S.sbPartial ? { text: () => d.gpuPartial, kind: 'warn' } : null));
    if (!sbs.some(s => sandboxKey(s) === S.sandbox)) S.sandbox = '';
    sbWrap.hidden = vramWrap.hidden = findBtn.hidden = !sbs.length;
    sbLabel.textContent = d.gpuSandbox; vramLabel.textContent = d.gpuVram;
    const blank = h('option', '', d.gpuPickSandbox);
    blank.value = '';
    sbSel.replaceChildren(blank, ...sbs.map(s => {
      const o = h('option', '', `${s.name || s.id} · ${s.region || '–'} · ${s.state || '–'} · ${s.account}`);
      o.value = sandboxKey(s);
      return o;
    }));
    sbSel.value = S.sandbox; sbSel.disabled = locked;
    vramSel.replaceChildren(...VRAM_CHOICES.map(n => { const o = h('option', '', d.gpuVramOpt(n)); o.value = String(n); return o; }));
    vramSel.value = String(S.vram); vramSel.disabled = locked;
    findBtn.textContent = S.candLoading ? d.gpuFinding : d.gpuFind;
    findBtn.disabled = !S.sandbox || S.candLoading || locked;

    const cs = S.cands && S.cands.key === S.sandbox ? S.cands : null;
    setMsg(candMsg, S.candMsg ?? (cs && !cs.list.length ? { text: () => d.gpuNone, kind: 'info' } : null));
    const sb = sbs.find(s => sandboxKey(s) === S.sandbox);
    candHead.hidden = distNote.hidden = !cs;
    candHead.textContent = cs ? `${d.gpuFrom(sb?.name || sb?.id || '–', cs.region)} · ${d.gpuObserved(when(cs.observedAt))}` : '';
    distNote.textContent = `${d.gpuDistanceNote} ${d.gpuFee}`;
    candNote.hidden = !cs?.note; candNote.textContent = cs?.note ?? '';
    candList.hidden = !cs || !cs.list.length;
    candList.replaceChildren(...(cs?.list ?? []).map(c => candidateItem(c, d)));

    setMsg(gpuMsg, S.gpuOp?.phase === 'uncertain' ? { text: () => d.uncertain, kind: 'warn' } : S.gpuOp ? { text: () => d.pending, kind: 'info' } : S.gpuMsg);
    gpuRetryRow.hidden = S.gpuOp?.phase !== 'uncertain';
    gpuRetry.textContent = d.retry; gpuForget.textContent = d.forget;

    const ch = S.choice;
    chosenBox.hidden = !ch;
    if (ch) {
      chosenText.textContent = d.gpuChosen(ch.market ? `${ch.gpu} · ${ch.market}` : ch.gpu, ch.country ?? d.gpuWhereUnknown);
      runText.textContent = d.gpuRun; cmdLabel.textContent = d.gpuCmd;
      if (cmdIn.value !== ch.command) cmdIn.value = ch.command;
      copyBtn.textContent = d.copy;
      setMsg(copyMsg, S.copyMsg);
      jobsNote.textContent = d.gpuJobs;
    }
  }

  function candidateItem(c: Candidate, d: Dict): HTMLElement {
    const where = !c.country ? d.gpuWhereUnknown : c.distanceKm === null ? d.gpuWhereNoKm(c.country) : d.gpuWhere(c.country, String(Math.round(c.distanceKm)));
    const lo = c.usdPerHourMin ?? c.usdPerHourMax, hi = c.usdPerHourMax ?? c.usdPerHourMin;
    const price = lo === null || hi === null ? d.gpuNoPrice : d.gpuPrice(money(lo), money(hi));
    const sending = S.gpuOp?.body.candidateId === c.id;
    const b = button(`cc-btn${c.selectable ? '' : ' cc-quiet'}`, () => { choose(c); });
    b.textContent = !c.selectable ? d.gpuUnavailable : sending && S.gpuOp?.phase === 'sending' ? d.gpuChoosing : d.gpuChoose;
    b.disabled = !c.selectable || !!S.gpuOp;
    const chosen = S.choice?.candidateId === c.id;
    const li = h('li', `cc-gpu-item${c.selectable ? '' : ' cc-gpu-off'}${chosen ? ' cc-gpu-chosen' : ''}`,
      h('div', 'cc-app-head', h('strong', '', c.market ? `${c.gpu} · ${c.market}` : c.gpu), h('span', 'cc-chip', d.gpuVramVal(c.vramGb === null ? '–' : String(c.vramGb)))),
      h('p', 'cc-fine', where), h('p', 'cc-fine', `${d.gpuHosts(c.available === null ? '–' : String(c.available))} · ${price}`), b);
    li.setAttribute('data-candidate', c.id);
    if (chosen) li.setAttribute('aria-current', 'true');
    return li;
  }

  function appCard(t: Tool, rows: Map<string, ToolState> | null, d: Dict): HTMLElement {
    const surfaces = (['native', 'web', 'api'] as Surface[]).filter(k => t.rows[k]);
    const chips = h('div', 'cc-chips', ...surfaces.map(k => h('span', `cc-chip cc-chip-${k}`, d.surf[k])));
    const state = h('div', 'cc-app-state');
    const ind = (label: string, kind: 'yes' | 'no' | 'none') => h('span', `cc-ind cc-ind-${kind}`, label);
    const row = (k: Surface) => (rows && t.rows[k] ? rows.get(t.rows[k] as string) ?? null : null);
    if (t.rows.native) {
      const r = row('native');
      state.append(!rows ? ind(`${d.installed}: ${d.notReported}`, 'none')
        : !r ? ind(d.notInImage, 'no')
        : r.status === 'installed' ? ind(r.version ? `${d.installed} · ${r.version}` : d.installed, 'yes')
        : r.status === 'not_installed' ? ind(d.notInstalled, 'no') : ind(d.unprobed, 'none'));
    }
    if (t.rows.web && row('web')?.status === 'web') state.append(ind(d.webLauncher, 'none'));
    if (t.rows.api && row('api')?.status === 'api_broker' && row('api')?.connected == null) state.append(ind(d.brokerKey, 'none'));
    for (const surface of surfaces) {
      const connection=row(surface)?.connected;
      if(connection!==null && connection!==undefined)state.append(ind(`${d.surf[surface]} · ${connection?d.connected:d.notConnected}`,connection?'yes':'no'));
    }
    const li = h('li', 'cc-app', h('div', 'cc-app-head', h('strong', '', t.name), chips), h('p', 'cc-fine', t.about[lang]), state);
    if (!state.children.length) state.hidden = true;
    li.setAttribute('data-tool', t.id);
    return li;
  }

  // ── polling: only while visible and something is pending ──
  function pendingWork(): boolean {
    const s = S.state?.status;
    return !!S.op || (!!s && TRANSITIONAL.includes(s)) || (s === 'running' && !S.state?.ready);
  }
  function stopPoll(): void { if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } }
  function schedule(): void {
    stopPoll();
    if (S.auth !== 'in' || document.visibilityState !== 'visible' || !pendingWork() || polls >= POLL_MAX) return;
    pollTimer = setTimeout(() => { pollTimer = null; polls++; void loadState(); }, polls < POLL_FAST_COUNT ? POLL_FAST_MS : POLL_SLOW_MS);
  }
  function tickClock(): void {
    if (clockTimer !== null) { clearTimeout(clockTimer); clockTimer = null; }
    if (S.auth !== 'in' || document.visibilityState !== 'visible' || !S.state?.sessionEndsAt) return;
    clockTimer = setTimeout(() => { clockTimer = null; render(); tickClock(); }, 30000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { polls = 0; if (S.auth === 'in') void loadState(); }
    else { stopPoll(); if (clockTimer !== null) { clearTimeout(clockTimer); clockTimer = null; } }
  });

  // ── server calls ──
  function signedOut(): void {
    stopPoll(); resetCapacity();
    S.auth = 'out'; S.state = null; S.launchUrl = ''; S.paired = false; S.enrollMsg = null;
    void checkSession();
  }

  /** forget everything the performance and GPU cards loaded; answers still in flight are dropped by the bumped counters */
  function resetCapacity(): void {
    perfSeq++; sbSeq++; candSeq++; gpuSeq++;
    Object.assign(S, {
      perf: null, perfLoading: false, perfMsg: null, plan: '', review: null, reviewMsg: null, resizeCheck: false, sent: null,
      sandboxes: null, sbPartial: false, sbLoading: false, sbMsg: null, sandbox: '', cands: null, candLoading: false, candMsg: null,
      gpuOp: null, gpuMsg: null, choice: null, copyMsg: null,
    });
  }

  async function checkSession(): Promise<boolean> {
    const r = await call(`${AUTH_API}/session`);
    if (!r.ok || !isObj(r.body)) { S.auth = 'failed'; S.authMsg = { text: () => (r.ok ? T().sessionFailed : r.status === 0 ? T().netErr : `${T().sessionFailed} ${T().httpErr(r.status)}`), kind: 'warn' }; S.hasCredentials = true; render(); return false; }
    const authed = r.body.authenticated === true;
    S.hasCredentials = r.body.hasCredentials === true || (authed && r.body.hasCredentials === undefined);
    S.auth = authed ? 'in' : 'out';
    render();
    if (authed) void loadState();
    return authed;
  }

  // One-use setup link: sent exactly once, never retried. An unknown outcome is reconciled with GET session only.
  async function pairDevice(): Promise<void> {
    let token = pair.token;
    pair.token = null;
    if (!token) { S.pairing = false; S.authMsg = { text: () => T().pairBad, kind: 'warn' }; await checkSession(); return; }
    let r: Reply;
    try { r = await call(`${AUTH_API}/pair`, { token }); } finally { token = null; }
    S.pairing = false;
    if (r.ok && isObj(r.body) && r.body.authenticated === true) {
      S.auth = 'in'; S.paired = true; S.hasCredentials = r.body.hasCredentials === true; S.authMsg = null;
      render(); void loadState(); return;
    }
    if (!r.ok && r.status !== 0 && r.status < 500 && r.status !== 408) {
      const code = r.code || String(r.status);
      S.authMsg = { text: () => T().pairGone(code), kind: 'warn' };
      await checkSession(); return;
    }
    S.authMsg = { text: () => T().pairUnknown, kind: 'warn' };
    if (await checkSession()) { S.paired = true; S.authMsg = null; render(); }
  }

  async function enroll(): Promise<void> {
    if (S.enrollBusy || S.auth !== 'in') return;
    const done = (m: Msg) => { S.enrollBusy = false; S.enrollMsg = m; render(); };
    const warn = (text: () => string) => done({ text, kind: 'warn' });
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials || typeof navigator.credentials.create !== 'function') { warn(() => T().phoneUnsupported); return; }
    S.enrollBusy = true; S.enrollMsg = null; render();
    const opts = await call(`${AUTH_API}/register/options`, {});
    if (!opts.ok && (opts.status === 401 || opts.status === 403)) { S.enrollBusy = false; signedOut(); return; }
    if (!opts.ok) { warn(() => `${T().phoneFailed} ${opts.status === 0 ? T().netErr : T().rejected(opts.code || String(opts.status))}`); return; }
    const publicKey = creationOptions(opts.body);
    if (!publicKey) { warn(() => T().phoneFailed); return; }
    let cred: Attestation | null;
    try { cred = await (navigator.credentials.create({ publicKey }) as Promise<unknown>) as Attestation | null; }
    catch (e) {
      const n = isObj(e) ? e.name : '';
      warn(() => (n === 'NotAllowedError' || n === 'AbortError' ? T().phoneCancelled : n === 'InvalidStateError' ? T().phoneExists : T().phoneDevice)); return;
    }
    if (!cred || !isObj(cred.response)) { warn(() => T().phoneCancelled); return; }
    let response: Record<string, unknown>;
    try { response = attestationJSON(cred); } catch { warn(() => T().phoneDevice); return; }
    const r = await call(`${AUTH_API}/register/verify`, { response });
    if (r.ok && isObj(r.body) && (r.body.registered === true || r.body.verified === true)) {
      S.hasCredentials = true; S.paired = false;
      done({ text: () => T().phoneDone, kind: 'ok' }); return;
    }
    if (!r.ok && (r.status === 401 || r.status === 403)) { S.enrollBusy = false; signedOut(); return; }
    if (r.ok || r.status === 0 || r.status >= 500 || r.status === 408) { warn(() => T().phoneUnknown); return; }
    const code = r.code || String(r.status);
    warn(() => `${T().phoneFailed} ${T().rejected(code)}`);
  }

  async function loadState(): Promise<void> {
    const seq = ++loadSeq;
    S.loading = true; render();
    const r = await call(`${API}/state`);
    if (seq !== loadSeq) return;
    S.loading = false;
    if (r.ok) {
      const st = normalizeState(r.body);
      if (st) { S.state = st; S.loadMsg = null; }
      else S.loadMsg = { text: () => T().stateFailed, kind: 'warn' };
    } else if (r.status === 401 || r.status === 403) { signedOut(); return; }
    else S.loadMsg = { text: () => `${T().stateFailed} ${r.status === 0 ? T().netErr : r.code ? T().rejected(r.code) : T().httpErr(r.status)}`, kind: 'warn' };
    render(); schedule(); tickClock();
  }

  function begin(kind: OpKind, extra: Record<string, unknown>): void {
    if (S.op) return; // one mutation at a time; an uncertain one must be retried or forgotten first
    let requestId: string;
    try { requestId = uuid(); } catch { S.opMsg = { text: () => T().netErr, kind: 'warn' }; render(); return; }
    S.launchUrl = ''; S.launchMsg = null;
    void send({ kind, requestId, body: { requestId, ...extra }, phase: 'sending' });
  }

  async function send(op: Op): Promise<void> {
    op.phase = 'sending'; S.op = op; S.opMsg = null; render();
    const r = await call(`${API}/${op.kind}`, op.body);
    if (S.op !== op) return;
    // a size change is never taken as done from the POST answer alone: the card re-reads performance (a GET) before offering another
    const settleResize = () => { if (op.kind === 'resize') { S.review = null; S.resizeCheck = true; void loadPerf(); } };
    if (r.ok) {
      S.op = null; S.opMsg = { text: () => T().done[op.kind], kind: 'ok' };
      if (op.kind === 'snapshot') { S.snapName = ''; S.snapMsg = null; }
      const st = isObj(r.body) && typeof r.body.status === 'string' ? normalizeState(r.body) : null;
      if (st) S.state = st;
      settleResize();
      polls = 0; render(); void loadState(); return;
    }
    if (r.status === 0 || r.status >= 500 || r.status === 408) {
      // Lost or ambiguous: the server may have acted. Keep the same requestId for a retry; never mint a new one silently.
      op.phase = 'uncertain'; settleResize(); render(); polls = 0; void loadState(); return;
    }
    S.op = null;
    if (r.status === 401 || r.status === 403) { signedOut(); return; }
    const code = r.code || T().httpErr(r.status);
    S.opMsg = { text: () => (op.kind === 'snapshot' && code === 'snapshot_exists' ? T().snapExists : T().rejected(code)), kind: 'warn' };
    if (op.kind === 'snapshot') S.snapMsg = S.opMsg;
    if (op.kind === 'resize') { settleResize(); S.reviewMsg = S.opMsg; }
    render(); void loadState();
  }

  /** dropping an uncertain request; for a size change, performance is re-read before another can be asked for */
  function forgetOp(): void {
    const kind = S.op?.kind;
    S.op = null; S.opMsg = null;
    if (kind === 'resize') { S.resizeCheck = true; void loadPerf(); }
    render();
  }

  async function loadPerf(): Promise<void> {
    if (S.auth !== 'in') return;
    const seq = ++perfSeq;
    S.perfLoading = true; S.perfMsg = null; render();
    const r = await call(`${API}/performance`);
    if (seq !== perfSeq || S.auth !== 'in') return;
    S.perfLoading = false;
    if (r.ok) {
      const p = normalizePerf(r.body);
      if (p) {
        const rv = S.review;
        if (rv && (p.machineId !== rv.machineId || !p.plans.some(x => x.cpu === rv.cpu && x.memoryGiB === rv.memoryGiB && x.usdPerHour === rv.usdPerHour && x.deltaUsdPerHour === rv.deltaUsdPerHour))) {
          S.review = null; S.reviewMsg = { text: () => T().reviewStale, kind: 'warn' };
        }
        S.perf = p;
        if (!S.op || S.op.kind !== 'resize') S.resizeCheck = false;
      } else S.perfMsg = { text: () => T().perfFailed, kind: 'warn' };
    } else if (r.status === 401 || r.status === 403) { signedOut(); return; }
    else S.perfMsg = { text: () => `${T().perfFailed} ${r.status === 0 ? T().netErr : r.code ? T().rejected(r.code) : T().httpErr(r.status)}`, kind: 'warn' };
    render();
  }

  function openReview(): void {
    const p = S.perf, plan = p?.plans.find(x => planKey(x) === S.plan);
    if (!p || !plan || S.op || S.perfLoading || S.resizeCheck || p.resize.status === 'pending' || S.state?.status !== 'running') return;
    S.review = { ...plan, machineId: p.machineId, fromCpu: p.current.cpu, fromMemoryGiB: p.current.memoryGiB, fromUsdPerHour: p.current.usdPerHour, diskGiB: p.current.diskGiB, asOf: p.pricing.asOf };
    S.reviewMsg = null;
    render();
  }

  /** the explicit Apply: sends exactly the reviewed size, only if the loaded prices still match what was reviewed */
  function applyResize(): void {
    const rv = S.review, p = S.perf;
    if (!rv || S.op) return;
    const plan = p?.plans.find(x => x.cpu === rv.cpu && x.memoryGiB === rv.memoryGiB);
    if (!p || !plan || p.machineId !== rv.machineId || plan.usdPerHour !== rv.usdPerHour || plan.deltaUsdPerHour !== rv.deltaUsdPerHour
      || S.perfLoading || S.resizeCheck || p.resize.status === 'pending' || S.state?.status !== 'running') {
      S.review = null; S.reviewMsg = { text: () => T().reviewStale, kind: 'warn' }; render(); return;
    }
    S.sent = { cpu: rv.cpu, memoryGiB: rv.memoryGiB }; S.reviewMsg = null;
    begin('resize', { cpu: rv.cpu, memoryGiB: rv.memoryGiB, acknowledgeCost: true });
  }

  // ── remote GPU: sandboxes and candidates are read only on a button press; a choice records a preference, never a rental ──
  function dropCandidates(): void {
    candSeq++;
    S.cands = null; S.candLoading = false; S.candMsg = null; S.choice = null; S.copyMsg = null; S.gpuMsg = null;
  }

  async function loadSandboxes(): Promise<void> {
    if (S.auth !== 'in' || S.sbLoading || S.gpuOp) return;
    const seq = ++sbSeq;
    S.sbLoading = true; S.sbMsg = null; render();
    const r = await call(`${API}/compute/sandboxes`);
    if (seq !== sbSeq || S.auth !== 'in') return;
    S.sbLoading = false;
    if (r.ok) {
      const got = normalizeSandboxes(r.body);
      if (got) {
        S.sandboxes = got.list; S.sbPartial = got.partial;
        if (!got.list.some(s => sandboxKey(s) === S.sandbox)) { S.sandbox = ''; dropCandidates(); }
      } else S.sbMsg = { text: () => T().gpuSandboxesFailed, kind: 'warn' };
    } else if (r.status === 401 || r.status === 403) { signedOut(); return; }
    else S.sbMsg = { text: () => `${T().gpuSandboxesFailed} ${r.status === 0 ? T().netErr : r.code ? T().rejected(r.code) : T().httpErr(r.status)}`, kind: 'warn' };
    render();
  }

  async function loadCandidates(): Promise<void> {
    const sb = S.sandboxes?.find(s => sandboxKey(s) === S.sandbox);
    if (S.auth !== 'in' || !sb || S.candLoading || S.gpuOp) return;
    const seq = ++candSeq, key = sandboxKey(sb), vram = S.vram;
    S.candLoading = true; S.candMsg = null; render();
    const q = new URLSearchParams({ sandboxId: sb.id, account: sb.account, minVramGb: String(vram) });
    const r = await call(`${API}/gpu/candidates?${q.toString()}`);
    if (seq !== candSeq || S.auth !== 'in' || S.sandbox !== key || S.vram !== vram) return;
    S.candLoading = false;
    if (r.ok) {
      const c = normalizeCandidates(r.body, sb);
      if (c) S.cands = c; else { S.cands = null; S.candMsg = { text: () => T().gpuFailed, kind: 'warn' }; }
    } else if (r.status === 401 || r.status === 403) { signedOut(); return; }
    else S.candMsg = { text: () => `${T().gpuFailed} ${r.status === 0 ? T().netErr : r.code ? T().rejected(r.code) : T().httpErr(r.status)}`, kind: 'warn' };
    render();
  }

  function choose(c: Candidate): void {
    const sb = S.sandboxes?.find(s => sandboxKey(s) === S.sandbox);
    if (S.gpuOp || !sb || !c.selectable || S.cands?.key !== S.sandbox || !S.cands.list.some(x => x.id === c.id)) return;
    let requestId: string;
    try { requestId = uuid(); } catch { S.gpuMsg = { text: () => T().netErr, kind: 'warn' }; render(); return; }
    S.choice = null; S.copyMsg = null;
    void sendChoice({ requestId, key: S.sandbox, body: { requestId, sandboxId: sb.id, account: sb.account, candidateId: c.id }, phase: 'sending' });
  }

  async function sendChoice(op: GpuOp): Promise<void> {
    const seq = ++gpuSeq;
    op.phase = 'sending'; S.gpuOp = op; S.gpuMsg = null; render();
    const r = await call(`${API}/gpu/select`, op.body);
    if (seq !== gpuSeq || S.gpuOp !== op || S.auth !== 'in') return;
    if (r.ok) {
      S.gpuOp = null;
      const ch = normalizeChoice(r.body, op.body.candidateId as string);
      if (ch && S.sandbox === op.key) S.choice = ch; else S.gpuMsg = { text: () => T().gpuOdd, kind: 'warn' };
    } else if (r.status === 0 || r.status >= 500 || r.status === 408) {
      op.phase = 'uncertain'; // same requestId on retry
    } else {
      S.gpuOp = null;
      if (r.status === 401 || r.status === 403) { signedOut(); return; }
      const code = r.code || T().httpErr(r.status);
      S.gpuMsg = { text: () => T().rejected(code), kind: 'warn' };
    }
    render();
  }

  async function copyCommand(): Promise<void> {
    const text = S.choice?.command;
    if (!text) return;
    const clip = (navigator as { clipboard?: { writeText?: (t: string) => Promise<void> } }).clipboard;
    let ok = false;
    try { if (clip && typeof clip.writeText === 'function') { await clip.writeText(text); ok = true; } } catch { ok = false; }
    S.copyMsg = ok ? { text: () => T().copied, kind: 'ok' } : { text: () => T().copyFailed, kind: 'warn' };
    render();
  }

  function startOrResume(): void {
    const st = S.state;
    if (!st || S.op) return;
    const account = st.machine ? st.machine.account : S.account;
    if (!ACCOUNT_IDS.includes(account as AccountId)) return;
    begin('start', { account });
  }

  function saveSnapshot(): void {
    const name = S.snapName.trim();
    if (!SNAPSHOT_NAME.test(name)) { S.snapMsg = { text: () => T().snapBad, kind: 'warn' }; render(); return; }
    S.snapMsg = null;
    begin('snapshot', { name });
  }

  async function launch(): Promise<void> {
    if (S.launching || S.state?.status !== 'running') return;
    S.launching = true; S.launchUrl = ''; S.launchMsg = null; render();
    const r = await call(`${API}/launch`, {});
    S.launching = false;
    if (r.ok) {
      const url = isObj(r.body) ? safeDesktopUrl(r.body.url) : null;
      if (url) S.launchUrl = url; else S.launchMsg = { text: () => T().openBad, kind: 'warn' };
    } else if (r.status === 401 || r.status === 403) { signedOut(); return; }
    else S.launchMsg = { text: () => (r.status === 0 ? T().netErr : T().rejected(r.code || String(r.status))), kind: 'warn' };
    render();
  }

  async function loadJobs(): Promise<void> {
    if (S.jobsLoading) return;
    S.jobsLoading = true; S.jobsMsg = null; render();
    const r = await call(`${API}/nested/jobs`);
    S.jobsLoading = false;
    if (r.ok && isObj(r.body) && Array.isArray(r.body.jobs)) {
      S.jobs = r.body.jobs.filter(isObj).slice(0, 50).map(j => ({ id: str(j.id, 80), provider: str(j.provider, 20), status: str(j.status, 40) }));
      S.jobsMsg = S.jobs.length ? null : { text: () => T().nestedNone, kind: 'info' };
    } else if (!r.ok && (r.status === 401 || r.status === 403)) { signedOut(); return; }
    else { S.jobs = null; S.jobsMsg = { text: () => `${T().nestedFailed} ${r.ok ? '' : r.status === 0 ? T().netErr : r.code ? T().rejected(r.code) : T().httpErr(r.status)}`, kind: 'warn' }; }
    render();
  }

  async function login(): Promise<void> {
    if (S.authBusy) return;
    const fail = (text: () => string) => { S.authBusy = false; S.authMsg = { text, kind: 'warn' }; render(); };
    if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials || typeof navigator.credentials.get !== 'function') { fail(() => T().unsupported); return; }
    S.authBusy = true; S.authMsg = null; render();
    const opts = await call(`${AUTH_API}/options`, {});
    if (!opts.ok) { fail(() => `${T().loginFailed} ${opts.status === 0 ? T().netErr : opts.code || T().httpErr(opts.status)}`); return; }
    const publicKey = requestOptions(opts.body);
    if (!publicKey) { fail(() => T().loginFailed); return; }
    let cred: Assertion | null;
    try { cred = await (navigator.credentials.get({ publicKey }) as Promise<unknown>) as Assertion | null; }
    catch (e) { fail(() => (isObj(e) && e.name === 'NotAllowedError' ? T().cancelled : T().keyFailed)); return; }
    if (!cred || !isObj(cred.response)) { fail(() => T().cancelled); return; }
    let response: Record<string, unknown>;
    try { response = assertionJSON(cred); } catch { fail(() => T().keyFailed); return; }
    const r = await call(`${AUTH_API}/login`, { response });
    if (!r.ok || !isObj(r.body) || r.body.authenticated !== true) { fail(() => `${T().loginFailed} ${r.ok ? '' : r.status === 0 ? T().netErr : r.code || T().httpErr(r.status)}`); return; }
    S.authBusy = false; S.auth = 'in'; S.hasCredentials = true; S.authMsg = null;
    render(); void loadState();
  }

  async function logout(): Promise<void> {
    if (S.authBusy) return;
    S.authBusy = true; stopPoll(); render();
    const r = await call(`${AUTH_API}/logout`, {});
    S.authBusy = false;
    if (r.ok && isObj(r.body) && r.body.authenticated === false) {
      resetCapacity();
      S.auth = 'out'; S.state = null; S.op = null; S.opMsg = null; S.launchUrl = ''; S.paired = false; S.enrollMsg = null; S.authMsg = { text: () => T().signedOut, kind: 'ok' };
    } else {
      S.authMsg = { text: () => (r.ok ? T().sessionFailed : r.status === 0 ? T().netErr : T().httpErr(r.status)), kind: 'warn' };
      S.opMsg = S.authMsg;
    }
    render(); schedule();
  }

  render();
  void (pair.present ? pairDevice() : checkSession());
}

// The setup fragment is taken (and cleared from the URL) before mount renders or fetches anything.
const pairLink = takePairLink();
const rootEl = document.getElementById('cb-computer');
if (rootEl) mount(rootEl, pairLink);
else pairLink.token = null;

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
