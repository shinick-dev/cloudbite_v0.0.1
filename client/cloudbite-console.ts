// Cloudbite 프로젝트 콘솔 (브라우저). tools/build-cloudbite-console.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-page.ts 의
// CLOUDBITE_JS 로 고정한다. 같은 출처 외부 스크립트로 내려가며, 화면은 전부 textContent·createElement 로만 그린다.
// 데모는 브라우저 안 시뮬레이션이다 — 실제 Daytona 샌드박스나 Nosana 추론을 만들지 않으며 화면에서 그렇게 밝힌다.
// 실제 실행은 서버 준비 상태와 기존 관리자 토큰(메모리에만), 소유자 로그인 세션 또는 승인된 방문자 세션(둘 다 서버 HttpOnly
// 쿠키, JS 는 읽지 않음)을 요구하고, 실패해도 데모로 몰래 바꾸지 않는다.
// 화면 문구는 한국어·영어 사전(EN·KO)에서 온다 (2026-10-18 사용자 요청: 머리의 KO / EN 전환). 언어는 ?lang= 주소에만 두고,
// 서버·모델이 돌려준 내용(브리프·보고서·파일·페르소나·서버 오류)과 브라우저 데모 결과물은 받은·만든 그대로 보이고 번역하지 않는다.
import type {
  CloudbiteBootstrap, ExpertActivity, ExpertArtifact, ExpertDefinition, ExpertOpinion, ExpertRun, ExpertStatus,
  OpinionDirection, ProjectBrief, ProjectRun, ProjectStatus,
} from '../src/cloudbite-contract';
import type { CloudbiteAccessRequest, CloudbiteAccessSession } from '../src/cloudbite-access-contract';
import type { HistoryList, HistoryDetail, HistoryReport, HistoryIssue, HistoryFeedback } from '../src/cloudbite-history-contract';

type Mode = 'demo' | 'live';
type View = 'home' | 'guide' | 'help' | 'settings' | 'history';
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
const EXPERT_STATUSES = Object.keys(STATUS_LABEL) as ExpertStatus[];
const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[];
const ACTIVITY_KINDS: ExpertActivity['kind'][] = ['status', 'thought', 'tool', 'artifact', 'error'];
const TERMINAL_EXPERT: ExpertStatus[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_PROJECT: ProjectStatus[] = ['completed', 'partial', 'failed', 'cancelled'];
const LIMIT = { title: 120, objective: 1500, context: 3000 };
const STREAM_ROWS = 400;
/** 편집 영역에 처음부터 보이는 역할 수. 나머지는 All experts 접기 상자에서 찾는다 */
const CORE_ROLES = 6;

// ───────────────────────── 화면 문구 (KO / EN) ─────────────────────────
// 사전은 이 파일 안에 둔다 (빌드는 묶지 않는 변환이라 런타임 import 가 없다). KO 는 EN 과 같은 모양이어야 타입 검사를 통과한다.
// 저장해 두는 오류·안내는 글자가 아니라 Text(사전 → 글자) 로 두어, 언어를 바꾸면 같은 내용이 새 언어로 다시 그려진다.

type Lang = 'en' | 'ko';
/** 머리 전환 버튼 순서 (KO / EN) */
const LANG_ORDER: Lang[] = ['ko', 'en'];
const LANG_NAME: Record<Lang, string> = { ko: '한국어', en: 'English' };
type Text = (m: Messages) => string;

const EN = {
  docTitle: 'Cloudbite — Expert sandbox workspace',
  langGroup: 'Language',
  langChanged: 'Language: English',
  direction: DIRECTION_LABEL,
  status: STATUS_LABEL,
  projectStatus: PROJECT_STATUS_LABEL,
  kind: { status: 'status', thought: 'note', tool: 'tool', artifact: 'file', error: 'error' } as Record<ExpertActivity['kind'], string>,
  experts: (n: number) => plural(n, 'expert'),
  projects: (n: number) => plural(n, 'project'),
  // 예시 브리프 (사용자가 고치지 않았을 때만 언어를 따라 바뀐다)
  sampleTitle: 'Launch a 100-expert AI advisory room',
  sampleObjective: 'Decide whether launching a 100-expert AI advisory room for startup teams on a partially paid model within 4 weeks makes sense, and what to watch out for.',
  sampleContext: 'Early users are startup teams of 5–20 people. Every opinion should show its evidence and sources. Team data will not be uploaded.',
  staExample: 'Try the curated STA expert',
  staTitle: 'PrimeTime setup / hold review',
  staObjective: 'Explain setup and hold slack using an educational single-clock model. For setup: launch edge 0 ns, launch latency 0.20 ns, clk-to-Q 0.08 ns, data delay 0.72 ns; capture edge 1.00 ns, capture latency 0.10 ns, setup 0.07 ns, uncertainty 0.04 ns, CRPR 0. Show arrival, required and slack, cite the curated sources, and explain why positive WNS alone is not signoff.',
  staContext: 'Educational example only. No real design data or licensed PrimeTime execution. Distinguish provided facts, assumptions and version-dependent options.',
  // 폼 검증
  vTitle: 'Enter a project name.',
  vTitleLong: (n: number) => `The project name must be ${n} characters or fewer.`,
  vObjective: 'Enter an objective.',
  vObjectiveLong: (n: number) => `The objective must be ${n} characters or fewer.`,
  vContextLong: (n: number) => `The context must be ${n} characters or fewer.`,
  vMin: (n: number) => `Select at least ${plural(n, 'expert')}.`,
  vMax: (n: number) => `You can select up to ${plural(n, 'expert')}.`,
  // 종합 한 줄
  hNone: 'No completed opinions to synthesise yet.',
  hTie: 'Opinions are evenly split — narrow down the disputed points before deciding.',
  hSupport: 'Most opinions favour going ahead — you can move straight to the suggested next actions.',
  hConditional: 'Most opinions say: set the conditions first and start small.',
  hConcern: 'Concerns dominate — do not expand until the key risks are resolved.',
  hAbstain: 'Many experts abstained — more information is needed.',
  hPartial: (base: string, valid: number, total: number) => `${base} (based on ${valid} of ${total} selected experts)`,
  // Markdown 보고서
  mdDemo: '> Browser demo simulation. No real Daytona sandbox or Nosana inference was involved.',
  mdLive: '> Live run result. Confidence is each AI role\'s self-assessment, not calibrated accuracy.',
  mdObjective: 'Objective', mdContext: 'Context', mdSynthesis: 'Synthesis', mdNext: 'Next actions', mdByExpert: 'Opinions by expert', none: '(none)',
  mdStatus: (s: string) => `Status: ${s}`,
  mdCounts: (a: { selected: number; valid: number; failed: number; pending: number; cancelled: number; invalid: number }) =>
    `Selected ${a.selected} · valid opinions ${a.valid} · failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled} · invalid format ${a.invalid}`,
  mdMean: (v: string) => `Mean self-assessed confidence: ${v}`,
  mdOpinion: (d: string, c: number) => `${d} · confidence ${c}%`,
  mdError: (e: string) => `Error: ${e}`,
  mdInvalid: 'Excluded from the synthesis because the result format was invalid.',
  exportDemoNote: 'Browser simulation — no real sandbox or inference',
  exportLiveNote: 'Confidence is self-assessed, not calibrated accuracy',
  // 머리·탐색
  brandSub: 'Expert sandboxes for one shared project',
  sessionAria: 'Session',
  navAria: 'Primary', navLabel: 'Workspace',
  nav: { home: 'Home', guide: 'Guide', help: 'Help', settings: 'Settings', history: 'History' } as Record<View, string>,
  navFoot: 'Up to 5 experts per project · 3 run at once',
  requestAccess: 'Request visitor access',
  accessQr: 'Access QR',
  ownerInbox: 'Owner inbox',
  modeDemo: 'Browser demo', modeLive: 'Live run',
  bannerDemo: 'Browser demo — simulated activity and files; no Daytona or Nosana calls. Nothing runs until you start it.',
  bannerLive: 'Live run — server-reported activity. Confidence is self-assessed.',
  profileOperator: 'Operator', profileOwner: 'Owner', profileVisitor: 'Visitor',
  stateOperatorToken: 'Temporary Cloudbite operator token in memory',
  stateAdminToken: 'Admin token held in memory',
  stateOwner: 'Owner signed in',
  stateVisitor: (t: string) => `Visitor session · ends ${t}`,
  stateNone: 'No admin token',
  // 브리프 편집
  briefAria: 'Project brief',
  objectiveLabel: 'Objective — what should the experts decide or produce?',
  projectDetails: 'Project details',
  projectName: 'Project name',
  contextLabel: 'Context (optional)',
  nameRequired: 'Name required',
  chooseExperts: 'Choose experts',
  allExpertsAria: 'All experts',
  allExperts: (n: number) => `All experts (${n})`,
  searchPlaceholder: 'Search all roles',
  searchAria: 'Search all experts',
  changeInSettings: 'Change in Settings',
  openSettings: 'Open Settings',
  failSim: 'Simulate one expert failing',
  selCount: (n: number, max: number) => `${n} selected · up to ${max}`,
  alsoSelected: (names: string) => `Also selected from All experts: ${names}`,
  builtinRoles: 'The server catalogue is empty or unreachable, so the demo uses 6 built-in demo roles.',
  maxReached: (n: number) => `Maximum of ${plural(n, 'expert')} reached. Clear one to choose another.`,
  recommended: '3–5 experts are recommended.',
  catalogueEmptyLive: 'The server catalogue is empty, so a live run is not possible.',
  noRoles: 'No roles available.',
  noMatch: 'No roles match your search.',
  needExpert: 'Choose at least one expert to run.',
  nextDemo: 'Next run: browser demo, simulated in this tab.',
  nextLive: 'Next run: live run on server sandboxes.',
  nextLiveOwner: 'Next run: live run on server sandboxes, using your owner sign-in.',
  nextLiveVisitor: 'Next run: live run on server sandboxes, using your approved visitor session.',
  starting: 'Starting…', running: 'Running…',
  runExperts: 'Run experts', runAgain: 'Run again', runExpertsDemo: 'Run experts in demo mode', runAgainDemo: 'Run again in demo mode',
  stop: 'Stop', stopping: 'Stopping…',
  hideSetup: 'Hide project setup', editProject: 'Edit project',
  projectBrief: 'Project brief', untitled: 'Untitled project',
  startingPill: 'Starting',
  finished: (done: number, n: number) => [`${done} of ${plural(n, 'expert')}`, ' finished'],
  validOpinions: (n: number) => [String(n), ` valid ${n === 1 ? 'opinion' : 'opinions'}`],
  projectLabel: 'Project ',
  visitorLeftLabel: 'Visitor session: ',
  visitorLeft: (left: number, max: number) => `${left} of ${plural(max, 'project')} left`,
  visitorEach: (experts: number, t: string) => ` · up to ${plural(experts, 'expert')} each · ends ${t}`,
  visitorEnds: (t: string) => ` · ends ${t}`,
  checkStatusAgain: 'Check status again',
  liveBlocked: 'Live run is blocked until the server is ready and you sign in as the owner, enter an admin token, or have approved visitor access.',
  exportJson: 'Export JSON', exportReport: 'Export report', moreOptions: 'More options',
  // Settings: 실행 방식·세션
  settingsTitle: 'Settings',
  settingsIntro: 'Execution mode and session. The project brief and expert selection are on Home.',
  modeHeading: 'Execution mode',
  modeLocked: 'The mode is locked while a project is running.',
  tokenPlaceholder: 'Existing admin session token',
  tokenLabelOperator: 'Temporary Cloudbite operator token (Cloudbite runs only)',
  tokenLabelAdmin: 'Admin token',
  tokenHelp: 'The token stays in this tab\'s memory only and is never stored. Daytona and Nosana API keys are configured on the server, never entered here.',
  clearToken: 'Clear token',
  checkingServer: 'Checking server readiness…',
  catalogueFailed: (e: string) => `Could not load the server catalogue: ${e}`,
  checkAgain: 'Check again',
  ownerRecheck: 'Check sign-in again',
  liveNotReady: 'Live run is not ready',
  missingSettings: 'The server operator must add these settings on the server (values are never entered here):',
  notReadyGeneric: 'The server reported that live runs are not ready.',
  serverReady: (n: number) => `Server ready · up to ${plural(n, 'expert')}`,
  visitorSession: (name: string, t: string, left: number, max: number, experts: number, tokenUsed: boolean) =>
    `Visitor session for ${name || 'you'} · ends at ${t} · ${left} of ${plural(max, 'project')} left · up to ${plural(experts, 'expert')} per project${tokenUsed ? ' · the admin token is used instead while entered' : ''}`,
  ownerChecking: 'Checking owner sign-in…',
  ownerSignedIn: 'Signed in as the owner. Live runs use your owner session — no token or visitor quota needed.',
  ownerTokenWins: 'The admin token is used instead while entered.',
  ownerSignedOut: 'Owner? Sign in with your security key in the owner inbox.',
  ownerNoCredentials: 'Owner sign-in is not set up yet. Register a security key in the owner inbox.',
  ownerCheckFailed: (why: string) => `Could not check the owner sign-in: ${why}`,
  ownerRejected: `Your owner sign-in was not accepted — it may have expired or been signed out. Sign in again in the owner inbox (/cloudbite/requests). (Not switched to demo.)`,
  signOut: 'Sign out', signingOut: 'Signing out…',
  signOutFailed: (why: string) => `Could not sign out: ${why}`,
  aboutHeading: 'About this console',
  aboutText: 'Cloudbite v0.0.1 — one shared project, several expert personas, each in a separate Daytona sandbox, with inference configured on the server.',
  legacyNote: 'The legacy classroom lab is a separate product and is not part of this console.',
  legacyLink: 'Open the legacy lab',
  // 방문자 접근
  accessPending: 'Your last run failed. Run again unlocks once the server confirms its sandboxes were cleaned up — checking automatically.',
  accessUnavailable: 'Your last run failed, but the server could not confirm its cleanup yet. Select Check again in a moment.',
  accessLimit: 'Your runs failed and this visitor session has used all its retries after failed runs. Ask the host for a new session.',
  accessSpent: 'Your visitor session has no projects left. Ask the host for a new session.',
  accessWaiting: 'Your access request is still waiting for the host.',
  accessDenied: 'The host declined your access request.',
  accessRevoked: 'The host ended your visitor session.',
  accessExpired: 'Your visitor session has expired.',
  // 실행 오류 (서버가 보낸 {error} 는 뒤에 그대로 붙인다)
  operatorMalformedLink: 'The temporary Cloudbite operator link is malformed. It was removed from the address bar; ask the owner for a new link.',
  operatorMalformed: 'The temporary Cloudbite operator token is malformed. Clear it and use a new link.',
  operatorRejected: 'The temporary Cloudbite operator token was rejected or has expired. Ask the owner for a new link.',
  serverNotReady: 'The server is not ready for live runs.',
  needCredential: 'Sign in as the owner, enter the admin token in Settings, or request visitor access at /cloudbite/request.',
  visitorRejected: (path: string) => `Your visitor session was not accepted — it may have expired, been revoked or used all its projects. Request access again at ${path}. (Not switched to demo.)`,
  http401: 'Admin or project permission is missing or has expired. Check the token.',
  http404: 'The project could not be found.',
  http409: 'The same request is already being processed.',
  http413: 'The input is too long. Shorten the objective or context.',
  http429: 'Too many requests. Try again shortly.',
  http503: 'The server run configuration is not ready.',
  httpOther: (s: number) => `Server error (HTTP ${s})`,
  withServer: (base: string, server: string) => `${base} — ${server}`,
  networkCreate: 'Could not reach the server. Check the network and run again. (Not switched to demo.)',
  networkLost: 'The connection to the server was lost.',
  networkGeneric: 'Could not reach the server.',
  invalidResponse: 'The server response has an invalid format.',
  catalogueInvalid: 'The catalogue response has an invalid format',
  pollRetry: (msg: string, n: number) => `${msg} Checking again… (${n}/3)`,
  pollStopped: (msg: string) => `${msg} Stopped checking the status.`,
  stopFailed: (msg: string) => `Could not stop the project: ${msg}`,
  stopNetwork: 'Could not send the stop request. Try again.',
  fileUnexpected: 'The server returned this file in an unexpected format, so it is not shown.',
  fileNetwork: 'Could not load the file.',
  // 작업공간
  workspaceTitle: 'Expert workspace',
  workspaceSub: 'Select an expert to read its opinion, report and files.',
  fullScreen: 'Full screen', exitFullScreen: 'Exit full screen',
  clearView: 'Clear view', restoreHistory: 'Restore history',
  rosterAria: 'Experts in this project',
  activityTitle: 'Execution activity', readOnly: 'read-only',
  activityBar: 'Reported by each expert, oldest first',
  failedWith: (e: string) => ` — failed: ${e}`,
  invalidExcluded: ' — result had an invalid format and is excluded',
  failedPlain: ' — failed',
  invalidChip: 'Invalid format',
  streamState: (demo: boolean, phase: string, working: number, events: number) =>
    `${demo ? 'simulated · ' : ''}${phase} · ${working} active · ${plural(events, 'event')}`,
  phaseStopping: 'stopping',
  errorsCount: (n: number) => plural(n, 'error'),
  viewCleared: 'View cleared. New activity will appear here; the project history is unchanged.',
  noActivityYet: 'No activity reported yet.',
  hiddenRows: (n: number) => `${plural(n, 'earlier row')} hidden from this view. Restore history to show them again.`,
  latestRows: (shown: number, total: number) => `Showing the latest ${shown} of ${total} rows.`,
  tabFiles: (n: number) => `Files ${n}`, tabActivity: 'Activity', tabWorkorder: 'Work order', tabPersona: 'Persona',
  tabsAria: (name: string) => `${name} workspace`,
  noActivity: 'No activity yet.',
  workorderPreview: 'The workspace has not exported a work order yet, so this is a preview built from the brief.',
  roleMissing: 'The role definition could not be found.',
  roleNotInCatalogue: 'This role was not found in the catalogue.',
  whereDemo: (id: string) => `demo workspace ${id}`,
  whereLive: (id: string) => `sandbox ${id}`,
  wherePending: 'workspace pending',
  errorLine: (e: string) => `Error: ${e}`,
  selfAssessed: (d: string, c: number) => `${d} · self-assessed ${c}%`,
  noFiles: 'No files yet. Files appear as the expert writes them.',
  filesAria: 'Available files',
  fileContentsAria: (p: string) => `${p} contents`,
  emptyFile: '(empty file)',
  loadingFile: 'Loading file…',
  loadAgain: 'Load again',
  noContents: 'This file was reported without its contents.',
  // 오른쪽: 진행·지금 할 일·종합
  asideAria: 'Progress and decision',
  progress: 'Progress', progressDetails: 'Progress details', progressAria: 'Experts finished',
  progressNum: (done: number, n: number) => `${done} of ${n}`,
  progressTail: (status: string, working: number) => ` experts finished · ${status}${working ? ` · ${working} working` : ''}`,
  stepState: { done: 'done', active: 'active', pending: 'pending', blocked: 'blocked' } as Record<'done' | 'active' | 'pending' | 'blocked', string>,
  stepBrief: 'Brief submitted', stepWorkspaces: 'Workspaces prepared', stepWorking: 'Experts working', stepOpinions: 'Opinions submitted', stepSynth: 'Synthesis ready',
  nActive: (n: number) => `${n} active`, nValid: (n: number) => `${n} valid`, nFailed: (n: number) => `${n} failed`,
  whatNow: 'What to do now',
  tipDemoRunning: 'The simulated experts are working. Select an expert to open its files.',
  tipLiveRunning: 'Experts are working in separate sandboxes. Select an expert to read its files; the synthesis updates as valid opinions arrive.',
  tipResults: 'Results are in. Read the synthesis, check any dissent, then export a report.',
  tipNoValid: 'No valid opinions to synthesise. Check the errors shown above the experts, then edit the project and run again.',
  tipExcluded: (n: number) => `${plural(n, 'expert')} did not produce a valid opinion and ${n === 1 ? 'is' : 'are'} excluded.`,
  tipVisitorAgain: 'Your visitor session can run again. Nothing starts until you open Edit project and select Run again.',
  tipVisitorNo: 'Your visitor session cannot start another run.',
  simulated: 'Simulated',
  synthesis: 'Synthesis', confidenceDetails: 'Confidence details',
  suggestedDecision: 'Suggested decision',
  validOf: (n: number) => ` / ${n} valid opinions`,
  countsLine: (a: { failed: number; pending: number; cancelled: number; invalid: number }) =>
    `Failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled}${a.invalid ? ` · invalid format ${a.invalid}` : ''} — only completed, valid opinions are counted.`,
  nextActions: 'Suggested next actions',
  sharedBy: (n: number) => ` · shared by ${n}`,
  dissent: 'Dissent',
  noDissent: 'No point has drawn both support and concern yet.',
  noValidYet: 'No completed, valid opinions yet.',
  meanConf: (n: number) => `Mean self-assessed confidence ${n}% — not calibrated accuracy.`,
  confExplain: 'Each role reports its own confidence from 0 to 100. It is a self-assessment, not calibrated accuracy or independent agreement. Failed, pending, cancelled and invalid results are excluded.',
  confAria: (parts: string) => `Confidence distribution ${parts}`,
  announce: (status: string, valid: number, failed: number) => `${status}: ${plural(valid, 'valid opinion')}, ${failed} failed`,
  // Guide · Help
  guideTitle: 'Guide', guideIntro: 'How a Cloudbite project runs: brief, team, run, results.',
  guide: [
    ['Write the shared brief', 'On Home, start with the objective the experts should judge. Project details holds the project name and optional context. Every expert receives the same brief.'],
    ['Choose up to five experts', 'Pick roles under Choose experts; All experts lists the whole catalogue with search. Each selected expert works in its own isolated workspace with its own persona and work order. Three to five experts are recommended.'],
    ['Run in demo or live mode', 'Browser demo simulates the run inside this tab. Live run asks the server to create one Daytona sandbox per expert, with inference configured on the server. Choose the mode in Settings. Nothing runs until you select the run button.'],
    ['Read each expert\'s result', 'Select an expert to read its opinion, report and other files, activity and role definition. A work order may be shown as a labelled preview. Browser-demo files are simulated.'],
    ['Check the execution activity', 'Execution activity lists what each expert reported — status changes, tool steps, notes and files. It is read-only: you cannot type commands into it. Errors are also shown above the experts.'],
    ['Review the synthesis', 'The right panel counts only completed, valid opinions. Failed, pending and cancelled experts are listed separately. Export a report or JSON when you are done.'],
  ] as Array<[string, string]>,
  backHome: 'Back to Home',
  helpTitle: 'Help', helpIntro: 'What the console shows, and what it does not claim.',
  faq: [
    ['Is the browser demo real?', 'No. The browser demo is a deterministic simulation that runs in this tab only after you start it. It creates no Daytona sandbox and makes no Nosana inference call. Its results change with the wording of your brief, but they are scripted, and its files and activity stay in English.'],
    ['What does confidence mean?', 'Each expert reports its own confidence from 0 to 100. It is a self-assessment, not calibrated accuracy or independent agreement. Failed, pending, cancelled and invalid results are excluded from the average.'],
    ['Why is Live run disabled?', 'Live run needs the server to be configured and one of: the owner signed in with a security key (owner inbox at /cloudbite/requests), an existing admin session token, or an approved, unexpired visitor session with a project left. Visitors can request access at /cloudbite/request. If the server is not ready, Settings lists the missing setting names. API keys are never entered in this console.'],
    ['How many experts can run?', 'Up to five experts per project, with up to three working at once. The server catalogue includes a curated PrimeTime STA expert alongside the general roles. A hundred-expert room is a future concept, not a verified capacity.'],
    ['What do Clear view and Full screen do?', 'Clear view, inside Execution activity, only empties the visible activity window; new activity keeps arriving and the project history and files stay intact. Restore history brings the hidden rows back. Full screen expands the workspace with its activity; press Escape or Exit full screen to return.'],
    ['Where is my data kept?', 'Admin and operator tokens live only in this tab\'s memory. The owner sign-in and an approved visitor session are kept by the server in HttpOnly cookies that this page cannot read. The language choice lives only in the address (?lang=). Exports are generated in the browser as downloads and state whether they come from a demo or a live run.'],
  ] as Array<[string, string]>,
};
type Messages = typeof EN;

const KO: Messages = {
  docTitle: 'Cloudbite — 전문가 샌드박스 작업공간',
  langGroup: '언어',
  langChanged: '언어: 한국어',
  direction: { support: '지지', conditional: '조건부', concern: '우려', abstain: '기권' },
  status: { queued: '대기 중', provisioning: '샌드박스 준비 중', running: '작업 중', completed: '완료', failed: '실패', cancelled: '취소됨' },
  projectStatus: { draft: '초안', running: '실행 중', completed: '완료', partial: '일부 완료', failed: '실패', cancelled: '취소됨' },
  kind: { status: '상태', thought: '메모', tool: '도구', artifact: '파일', error: '오류' },
  experts: (n) => `전문가 ${n}명`,
  projects: (n) => `프로젝트 ${n}개`,
  sampleTitle: '100명 전문가 AI 자문실 출시',
  sampleObjective: '스타트업 팀을 위한 100명 전문가 AI 자문실을 4주 안에 일부 유료 모델로 출시하는 것이 타당한지, 무엇을 주의해야 하는지 판단해 주세요.',
  sampleContext: '초기 사용자는 5–20명 규모의 스타트업 팀입니다. 모든 의견은 근거와 출처를 보여야 합니다. 팀 데이터는 업로드하지 않습니다.',
  staExample: '지식 기반 STA 전문가 예제',
  staTitle: 'PrimeTime setup / hold 검토',
  staObjective: '교육용 단일 클록 모델에서 setup과 hold slack을 설명해 주세요. setup: launch edge 0 ns, launch latency 0.20 ns, clk-to-Q 0.08 ns, data delay 0.72 ns; capture edge 1.00 ns, capture latency 0.10 ns, setup 0.07 ns, uncertainty 0.04 ns, CRPR 0. arrival·required·slack을 계산하고, 지식 자료의 출처를 인용하며, positive WNS만으로 signoff할 수 없는 이유도 설명해 주세요.',
  staContext: '교육용 사례입니다. 실제 설계 데이터와 라이선스가 필요한 PrimeTime 실행은 없습니다. 주어진 사실·가정·버전별 확인이 필요한 옵션을 구분해 주세요.',
  vTitle: '프로젝트 이름을 입력하세요.',
  vTitleLong: (n) => `프로젝트 이름은 ${n}자 이하여야 합니다.`,
  vObjective: '목표를 입력하세요.',
  vObjectiveLong: (n) => `목표는 ${n}자 이하여야 합니다.`,
  vContextLong: (n) => `맥락은 ${n}자 이하여야 합니다.`,
  vMin: (n) => `전문가를 ${n}명 이상 고르세요.`,
  vMax: (n) => `전문가는 최대 ${n}명까지 고를 수 있습니다.`,
  hNone: '아직 종합할 완료된 의견이 없습니다.',
  hTie: '의견이 팽팽하게 갈립니다 — 결정 전에 쟁점을 좁히세요.',
  hSupport: '대부분 진행에 찬성합니다 — 제안된 다음 행동으로 바로 넘어가도 됩니다.',
  hConditional: '대부분 조건을 먼저 정하고 작게 시작하라고 봅니다.',
  hConcern: '우려가 우세합니다 — 핵심 위험이 해소될 때까지 확장하지 마세요.',
  hAbstain: '기권한 전문가가 많습니다 — 정보가 더 필요합니다.',
  hPartial: (base, valid, total) => `${base} (선택한 전문가 ${total}명 중 ${valid}명 기준)`,
  mdDemo: '> 브라우저 데모 시뮬레이션입니다. 실제 Daytona 샌드박스나 Nosana 추론은 쓰지 않았습니다.',
  mdLive: '> 실제 실행 결과입니다. 확신도는 각 AI 역할의 자체 평가이며 보정된 정확도가 아닙니다.',
  mdObjective: '목표', mdContext: '맥락', mdSynthesis: '종합', mdNext: '다음 행동', mdByExpert: '전문가별 의견', none: '(없음)',
  mdStatus: (s) => `상태: ${s}`,
  mdCounts: (a) => `선택 ${a.selected} · 유효 의견 ${a.valid} · 실패 ${a.failed} · 대기/작업 중 ${a.pending} · 취소 ${a.cancelled} · 형식 오류 ${a.invalid}`,
  mdMean: (v) => `평균 자체 평가 확신도: ${v}`,
  mdOpinion: (d, c) => `${d} · 확신도 ${c}%`,
  mdError: (e) => `오류: ${e}`,
  mdInvalid: '결과 형식이 잘못되어 종합에서 제외했습니다.',
  exportDemoNote: '브라우저 시뮬레이션 — 실제 샌드박스·추론 없음',
  exportLiveNote: '확신도는 자체 평가이며 보정된 정확도가 아님',
  brandSub: '하나의 공동 프로젝트를 위한 전문가 샌드박스',
  sessionAria: '세션',
  navAria: '주 메뉴', navLabel: '작업공간',
  nav: { home: '홈', guide: '안내', help: '도움말', settings: '설정', history: '사용 기록' },
  navFoot: '프로젝트당 전문가 최대 5명 · 동시에 3명 실행',
  requestAccess: '방문자 접근 요청',
  accessQr: '접근 QR',
  ownerInbox: '소유자 요청함',
  modeDemo: '브라우저 데모', modeLive: '실제 실행',
  bannerDemo: '브라우저 데모 — 활동과 파일은 시뮬레이션이며 Daytona·Nosana를 호출하지 않습니다. 직접 시작하기 전에는 아무것도 실행되지 않습니다.',
  bannerLive: '실제 실행 — 서버가 보고한 활동입니다. 확신도는 자체 평가입니다.',
  profileOperator: '운영자', profileOwner: '소유자', profileVisitor: '방문자',
  stateOperatorToken: '임시 Cloudbite 운영자 토큰이 메모리에 있음',
  stateAdminToken: '관리자 토큰이 메모리에 있음',
  stateOwner: '소유자 로그인됨',
  stateVisitor: (t) => `방문자 세션 · ${t} 종료`,
  stateNone: '관리자 토큰 없음',
  briefAria: '프로젝트 브리프',
  objectiveLabel: '목표 — 전문가들이 무엇을 판단하거나 만들어야 하나요?',
  projectDetails: '프로젝트 세부 정보',
  projectName: '프로젝트 이름',
  contextLabel: '맥락 (선택)',
  nameRequired: '이름 필요',
  chooseExperts: '전문가 고르기',
  allExpertsAria: '모든 전문가',
  allExperts: (n) => `모든 전문가 (${n})`,
  searchPlaceholder: '모든 역할 검색',
  searchAria: '모든 전문가 검색',
  changeInSettings: '설정에서 바꾸기',
  openSettings: '설정 열기',
  failSim: '전문가 한 명의 실패를 시뮬레이션',
  selCount: (n, max) => `${n}명 선택 · 최대 ${max}명`,
  alsoSelected: (names) => `모든 전문가에서 함께 선택: ${names}`,
  builtinRoles: '서버 카탈로그가 비었거나 연결되지 않아 데모는 내장 데모 역할 6개를 씁니다.',
  maxReached: (n) => `최대 ${n}명을 골랐습니다. 다른 역할을 고르려면 하나를 해제하세요.`,
  recommended: '전문가 3–5명을 권장합니다.',
  catalogueEmptyLive: '서버 카탈로그가 비어 있어 실제 실행을 할 수 없습니다.',
  noRoles: '사용할 수 있는 역할이 없습니다.',
  noMatch: '검색과 맞는 역할이 없습니다.',
  needExpert: '실행하려면 전문가를 한 명 이상 고르세요.',
  nextDemo: '다음 실행: 브라우저 데모, 이 탭 안에서 시뮬레이션합니다.',
  nextLive: '다음 실행: 서버 샌드박스에서 실제 실행합니다.',
  nextLiveOwner: '다음 실행: 소유자 로그인으로 서버 샌드박스에서 실제 실행합니다.',
  nextLiveVisitor: '다음 실행: 승인된 방문자 세션으로 서버 샌드박스에서 실제 실행합니다.',
  starting: '시작하는 중…', running: '실행 중…',
  runExperts: '전문가 실행', runAgain: '다시 실행', runExpertsDemo: '데모 모드로 전문가 실행', runAgainDemo: '데모 모드로 다시 실행',
  stop: '중지', stopping: '중지하는 중…',
  hideSetup: '프로젝트 설정 숨기기', editProject: '프로젝트 편집',
  projectBrief: '프로젝트 브리프', untitled: '이름 없는 프로젝트',
  startingPill: '시작 중',
  finished: (done, n) => [`전문가 ${n}명 중 ${done}명`, ' 완료'],
  validOpinions: (n) => [String(n), '개 유효 의견'],
  projectLabel: '프로젝트 ',
  visitorLeftLabel: '방문자 세션: ',
  visitorLeft: (left, max) => `프로젝트 ${max}개 중 ${left}개 남음`,
  visitorEach: (experts, t) => ` · 프로젝트당 전문가 최대 ${experts}명 · ${t} 종료`,
  visitorEnds: (t) => ` · ${t} 종료`,
  checkStatusAgain: '상태 다시 확인',
  liveBlocked: '서버가 준비되고, 소유자로 로그인하거나 관리자 토큰을 넣거나 방문자 접근이 승인될 때까지 실제 실행은 막혀 있습니다.',
  exportJson: 'JSON 내보내기', exportReport: '보고서 내보내기', moreOptions: '추가 옵션',
  settingsTitle: '설정',
  settingsIntro: '실행 방식과 세션입니다. 프로젝트 브리프와 전문가 선택은 홈에 있습니다.',
  modeHeading: '실행 방식',
  modeLocked: '프로젝트가 실행되는 동안에는 실행 방식을 바꿀 수 없습니다.',
  tokenPlaceholder: '기존 관리자 세션 토큰',
  tokenLabelOperator: '임시 Cloudbite 운영자 토큰 (Cloudbite 실행 전용)',
  tokenLabelAdmin: '관리자 토큰',
  tokenHelp: '토큰은 이 탭의 메모리에만 있고 저장되지 않습니다. Daytona·Nosana API 키는 서버에 설정하며 여기에 입력하지 않습니다.',
  clearToken: '토큰 지우기',
  checkingServer: '서버 준비 상태를 확인하는 중…',
  catalogueFailed: (e) => `서버 카탈로그를 불러오지 못했습니다: ${e}`,
  checkAgain: '다시 확인',
  ownerRecheck: '로그인 상태 다시 확인',
  liveNotReady: '실제 실행이 준비되지 않았습니다',
  missingSettings: '서버 운영자가 서버에 다음 설정을 추가해야 합니다 (값은 여기에 입력하지 않습니다):',
  notReadyGeneric: '서버가 실제 실행이 준비되지 않았다고 알렸습니다.',
  serverReady: (n) => `서버 준비됨 · 전문가 최대 ${n}명`,
  visitorSession: (name, t, left, max, experts, tokenUsed) =>
    `${name || '나'}의 방문자 세션 · ${t} 종료 · 프로젝트 ${max}개 중 ${left}개 남음 · 프로젝트당 전문가 최대 ${experts}명${tokenUsed ? ' · 관리자 토큰을 넣은 동안에는 토큰을 대신 씁니다' : ''}`,
  ownerChecking: '소유자 로그인을 확인하는 중…',
  ownerSignedIn: '소유자로 로그인되어 있습니다. 실제 실행은 소유자 세션을 쓰며 토큰이나 방문자 한도가 필요 없습니다.',
  ownerTokenWins: '관리자 토큰을 넣은 동안에는 토큰을 대신 씁니다.',
  ownerSignedOut: '소유자인가요? 소유자 요청함에서 보안 키로 로그인하세요.',
  ownerNoCredentials: '소유자 로그인이 아직 설정되지 않았습니다. 소유자 요청함에서 보안 키를 등록하세요.',
  ownerCheckFailed: (why) => `소유자 로그인 상태를 확인하지 못했습니다: ${why}`,
  ownerRejected: '소유자 로그인이 받아들여지지 않았습니다 — 만료되었거나 로그아웃되었을 수 있습니다. 소유자 요청함(/cloudbite/requests)에서 다시 로그인하세요. (데모로 바꾸지 않았습니다.)',
  signOut: '로그아웃', signingOut: '로그아웃하는 중…',
  signOutFailed: (why) => `로그아웃하지 못했습니다: ${why}`,
  aboutHeading: '이 콘솔에 대해',
  aboutText: 'Cloudbite v0.0.1 — 하나의 공동 프로젝트, 여러 전문가 페르소나, 각자 분리된 Daytona 샌드박스, 서버에 설정된 추론.',
  legacyNote: '기존 교실 실습실은 별개 제품이며 이 콘솔에 포함되지 않습니다.',
  legacyLink: '기존 실습실 열기',
  accessPending: '마지막 실행이 실패했습니다. 서버가 샌드박스 정리를 확인하면 다시 실행할 수 있습니다 — 자동으로 확인하는 중입니다.',
  accessUnavailable: '마지막 실행이 실패했지만 서버가 아직 정리를 확인하지 못했습니다. 잠시 뒤 다시 확인을 누르세요.',
  accessLimit: '실행이 실패했고 이 방문자 세션은 실패 뒤 재시도를 모두 썼습니다. 호스트에게 새 세션을 요청하세요.',
  accessSpent: '방문자 세션에 남은 프로젝트가 없습니다. 호스트에게 새 세션을 요청하세요.',
  accessWaiting: '접근 요청이 아직 호스트의 승인을 기다리고 있습니다.',
  accessDenied: '호스트가 접근 요청을 거절했습니다.',
  accessRevoked: '호스트가 방문자 세션을 종료했습니다.',
  accessExpired: '방문자 세션이 만료되었습니다.',
  operatorMalformedLink: '임시 Cloudbite 운영자 링크의 형식이 잘못되었습니다. 주소창에서 지웠으니 소유자에게 새 링크를 요청하세요.',
  operatorMalformed: '임시 Cloudbite 운영자 토큰의 형식이 잘못되었습니다. 토큰을 지우고 새 링크를 쓰세요.',
  operatorRejected: '임시 Cloudbite 운영자 토큰이 거부되었거나 만료되었습니다. 소유자에게 새 링크를 요청하세요.',
  serverNotReady: '서버가 실제 실행을 할 준비가 되지 않았습니다.',
  needCredential: '소유자로 로그인하거나, 설정에 관리자 토큰을 넣거나, /cloudbite/request 에서 방문자 접근을 요청하세요.',
  visitorRejected: (path) => `방문자 세션이 받아들여지지 않았습니다 — 만료·취소되었거나 프로젝트를 모두 썼을 수 있습니다. ${path} 에서 다시 접근을 요청하세요. (데모로 바꾸지 않았습니다.)`,
  http401: '관리자 또는 프로젝트 권한이 없거나 만료되었습니다. 토큰을 확인하세요.',
  http404: '프로젝트를 찾을 수 없습니다.',
  http409: '같은 요청을 이미 처리하고 있습니다.',
  http413: '입력이 너무 깁니다. 목표나 맥락을 줄이세요.',
  http429: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  http503: '서버 실행 설정이 준비되지 않았습니다.',
  httpOther: (s) => `서버 오류 (HTTP ${s})`,
  withServer: (base, server) => `${base} — ${server}`,
  networkCreate: '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 실행하세요. (데모로 바꾸지 않았습니다.)',
  networkLost: '서버와의 연결이 끊겼습니다.',
  networkGeneric: '서버에 연결하지 못했습니다.',
  invalidResponse: '서버 응답 형식이 잘못되었습니다.',
  catalogueInvalid: '카탈로그 응답 형식이 잘못되었습니다',
  pollRetry: (msg, n) => `${msg} 다시 확인하는 중… (${n}/3)`,
  pollStopped: (msg) => `${msg} 상태 확인을 멈췄습니다.`,
  stopFailed: (msg) => `프로젝트를 중지하지 못했습니다: ${msg}`,
  stopNetwork: '중지 요청을 보내지 못했습니다. 다시 시도하세요.',
  fileUnexpected: '서버가 이 파일을 예상하지 못한 형식으로 보내 보여 주지 않습니다.',
  fileNetwork: '파일을 불러오지 못했습니다.',
  workspaceTitle: '전문가 작업공간',
  workspaceSub: '전문가를 골라 의견·보고서·파일을 읽으세요.',
  fullScreen: '전체 화면', exitFullScreen: '전체 화면 끝내기',
  clearView: '화면 비우기', restoreHistory: '기록 되돌리기',
  rosterAria: '이 프로젝트의 전문가',
  activityTitle: '실행 기록', readOnly: '읽기 전용',
  activityBar: '각 전문가가 보고한 내용, 오래된 순',
  failedWith: (e) => ` — 실패: ${e}`,
  invalidExcluded: ' — 결과 형식이 잘못되어 제외됨',
  failedPlain: ' — 실패',
  invalidChip: '형식 오류',
  streamState: (demo, phase, working, events) => `${demo ? '시뮬레이션 · ' : ''}${phase} · ${working}명 작업 중 · 이벤트 ${events}개`,
  phaseStopping: '중지하는 중',
  errorsCount: (n) => `오류 ${n}개`,
  viewCleared: '화면을 비웠습니다. 새 활동은 여기에 나타나며 프로젝트 기록은 그대로입니다.',
  noActivityYet: '아직 보고된 활동이 없습니다.',
  hiddenRows: (n) => `이전 줄 ${n}개를 이 화면에서 숨겼습니다. 기록 되돌리기로 다시 볼 수 있습니다.`,
  latestRows: (shown, total) => `${total}줄 중 최근 ${shown}줄을 보여 줍니다.`,
  tabFiles: (n) => `파일 ${n}`, tabActivity: '활동', tabWorkorder: '작업 지시서', tabPersona: '페르소나',
  tabsAria: (name) => `${name} 작업공간`,
  noActivity: '아직 활동이 없습니다.',
  workorderPreview: '작업공간이 아직 작업 지시서를 내보내지 않아 브리프로 만든 미리보기입니다.',
  roleMissing: '역할 정의를 찾을 수 없습니다.',
  roleNotInCatalogue: '카탈로그에서 이 역할을 찾지 못했습니다.',
  whereDemo: (id) => `데모 작업공간 ${id}`,
  whereLive: (id) => `샌드박스 ${id}`,
  wherePending: '작업공간 준비 전',
  errorLine: (e) => `오류: ${e}`,
  selfAssessed: (d, c) => `${d} · 자체 평가 ${c}%`,
  noFiles: '아직 파일이 없습니다. 전문가가 파일을 쓰면 나타납니다.',
  filesAria: '볼 수 있는 파일',
  fileContentsAria: (p) => `${p} 내용`,
  emptyFile: '(빈 파일)',
  loadingFile: '파일을 불러오는 중…',
  loadAgain: '다시 불러오기',
  noContents: '이 파일은 내용 없이 보고되었습니다.',
  asideAria: '진행과 결정',
  progress: '진행', progressDetails: '진행 세부 정보', progressAria: '완료한 전문가',
  progressNum: (done, n) => `${n}명 중 ${done}명`,
  progressTail: (status, working) => ` 완료 · ${status}${working ? ` · ${working}명 작업 중` : ''}`,
  stepState: { done: '완료', active: '진행 중', pending: '대기', blocked: '막힘' },
  stepBrief: '브리프 제출', stepWorkspaces: '작업공간 준비', stepWorking: '전문가 작업', stepOpinions: '의견 제출', stepSynth: '종합 준비',
  nActive: (n) => `${n}명 작업 중`, nValid: (n) => `유효 ${n}`, nFailed: (n) => `실패 ${n}`,
  whatNow: '지금 할 일',
  tipDemoRunning: '시뮬레이션 전문가들이 작업 중입니다. 전문가를 골라 파일을 여세요.',
  tipLiveRunning: '전문가들이 각자의 샌드박스에서 작업 중입니다. 전문가를 골라 파일을 읽으세요. 유효한 의견이 들어오면 종합이 갱신됩니다.',
  tipResults: '결과가 나왔습니다. 종합을 읽고 이견을 확인한 뒤 보고서를 내보내세요.',
  tipNoValid: '종합할 유효한 의견이 없습니다. 전문가 위에 보이는 오류를 확인한 뒤 프로젝트를 고쳐 다시 실행하세요.',
  tipExcluded: (n) => `전문가 ${n}명이 유효한 의견을 내지 못해 제외되었습니다.`,
  tipVisitorAgain: '방문자 세션으로 다시 실행할 수 있습니다. 프로젝트 편집을 열고 다시 실행을 누르기 전에는 아무것도 시작되지 않습니다.',
  tipVisitorNo: '방문자 세션으로 더 실행할 수 없습니다.',
  simulated: '시뮬레이션',
  synthesis: '종합', confidenceDetails: '확신도 세부 정보',
  suggestedDecision: '제안 결정',
  validOf: (n) => ` / ${n} 유효 의견`,
  countsLine: (a) => `실패 ${a.failed} · 대기/작업 중 ${a.pending} · 취소 ${a.cancelled}${a.invalid ? ` · 형식 오류 ${a.invalid}` : ''} — 완료된 유효 의견만 셉니다.`,
  nextActions: '제안 다음 행동',
  sharedBy: (n) => ` · ${n}명 공통`,
  dissent: '이견',
  noDissent: '아직 지지와 우려가 함께 나온 쟁점이 없습니다.',
  noValidYet: '아직 완료된 유효 의견이 없습니다.',
  meanConf: (n) => `평균 자체 평가 확신도 ${n}% — 보정된 정확도가 아닙니다.`,
  confExplain: '각 역할이 0–100 사이의 확신도를 스스로 보고합니다. 자체 평가이며 보정된 정확도나 독립적인 합의가 아닙니다. 실패·대기·취소·형식 오류 결과는 제외합니다.',
  confAria: (parts) => `확신도 분포 ${parts}`,
  announce: (status, valid, failed) => `${status}: 유효 의견 ${valid}개, 실패 ${failed}개`,
  guideTitle: '안내', guideIntro: 'Cloudbite 프로젝트 진행 순서: 브리프, 팀, 실행, 결과.',
  guide: [
    ['공동 브리프 쓰기', '홈에서 전문가들이 판단할 목표부터 씁니다. 프로젝트 세부 정보에는 프로젝트 이름과 선택 맥락이 있습니다. 모든 전문가가 같은 브리프를 받습니다.'],
    ['전문가 최대 5명 고르기', '전문가 고르기에서 역할을 고릅니다. 모든 전문가에는 전체 카탈로그와 검색이 있습니다. 고른 전문가는 각자의 페르소나와 작업 지시서를 가지고 분리된 작업공간에서 일합니다. 3–5명을 권장합니다.'],
    ['데모 또는 실제 실행', '브라우저 데모는 이 탭 안에서 실행을 시뮬레이션합니다. 실제 실행은 서버에 전문가마다 Daytona 샌드박스 하나를 만들게 하고, 추론은 서버에 설정되어 있습니다. 실행 방식은 설정에서 고릅니다. 실행 버튼을 누르기 전에는 아무것도 실행되지 않습니다.'],
    ['전문가별 결과 읽기', '전문가를 골라 의견, 보고서와 다른 파일, 활동, 역할 정의를 읽습니다. 작업 지시서는 표시된 미리보기로 보일 수 있습니다. 브라우저 데모 파일은 시뮬레이션입니다.'],
    ['실행 기록 확인', '실행 기록은 각 전문가가 보고한 상태 변화, 도구 단계, 메모, 파일을 보여 줍니다. 읽기 전용이라 명령을 입력할 수 없습니다. 오류는 전문가 목록 위에도 보입니다.'],
    ['종합 검토', '오른쪽 패널은 완료된 유효 의견만 셉니다. 실패·대기·취소된 전문가는 따로 표시합니다. 끝나면 보고서나 JSON을 내보내세요.'],
  ],
  backHome: '홈으로 돌아가기',
  helpTitle: '도움말', helpIntro: '콘솔이 보여 주는 것과 주장하지 않는 것.',
  faq: [
    ['브라우저 데모는 진짜인가요?', '아닙니다. 브라우저 데모는 시작한 뒤에만 이 탭 안에서 도는 결정적 시뮬레이션입니다. Daytona 샌드박스를 만들지 않고 Nosana 추론도 호출하지 않습니다. 결과는 브리프 문구에 따라 바뀌지만 정해진 각본이며, 파일과 활동은 영어로 남습니다.'],
    ['확신도는 무슨 뜻인가요?', '각 전문가가 0–100 사이의 확신도를 스스로 보고합니다. 자체 평가이며 보정된 정확도나 독립적인 합의가 아닙니다. 실패·대기·취소·형식 오류 결과는 평균에서 제외합니다.'],
    ['실제 실행이 왜 꺼져 있나요?', '실제 실행에는 서버 설정과 다음 중 하나가 필요합니다: 보안 키로 로그인한 소유자(소유자 요청함 /cloudbite/requests), 기존 관리자 세션 토큰, 또는 프로젝트가 남은 승인·유효한 방문자 세션. 방문자는 /cloudbite/request 에서 접근을 요청할 수 있습니다. 서버가 준비되지 않았으면 설정에 빠진 설정 이름이 보입니다. 이 콘솔에는 API 키를 입력하지 않습니다.'],
    ['전문가는 몇 명까지 실행되나요?', '프로젝트당 최대 5명, 동시에 최대 3명이 작업합니다. 서버 카탈로그에는 일반 역할과 지식 기반 PrimeTime STA 전문가가 있습니다. 100명 전문가 자문실은 앞으로의 구상이며 검증된 규모가 아닙니다.'],
    ['화면 비우기와 전체 화면은 무엇을 하나요?', '실행 기록 안의 화면 비우기는 보이는 기록 창만 비웁니다. 새 활동은 계속 들어오고 프로젝트 기록과 파일은 그대로입니다. 기록 되돌리기로 숨긴 줄을 다시 봅니다. 전체 화면은 작업공간과 기록을 넓혀 보이며, Escape 나 전체 화면 끝내기로 돌아옵니다.'],
    ['내 데이터는 어디에 남나요?', '관리자·운영자 토큰은 이 탭의 메모리에만 있습니다. 소유자 로그인과 승인된 방문자 세션은 서버가 이 페이지에서 읽을 수 없는 HttpOnly 쿠키로 보관합니다. 언어 선택은 주소(?lang=)에만 남습니다. 내보내기는 브라우저에서 다운로드로 만들어지며 데모인지 실제 실행인지 적혀 있습니다.'],
  ],
};
const DICT: Record<Lang, Messages> = { en: EN, ko: KO };

/** 알려진 역할(서버 카탈로그 12개·내장 데모 6개)의 한국어 설명. 이름과 페르소나 원문은 그대로 둔다 */
const ROLE_KO: Record<string, string> = {
  'probably-primetime-sta': '50개 지식 카드·120개 출처·8개 분야 체크리스트로 ASIC 타이밍을 검토합니다. PrimeTime 실행이나 signoff 인증은 제공하지 않습니다.',
  'agency-product-manager': '문제·대상 사용자·성과 지표를 정리하고, 범위를 좁힌 첫 출시와 Now/Next/Later 로드맵으로 프로젝트를 나눕니다.',
  'agency-business-strategist': '프로젝트가 이길 수 있는 지점을 그리고, 서로 다른 전략안 2–4개를 비교해 각각의 트레이드오프와 중단 기준을 밝힙니다.',
  'agency-specialized-pricing-analyst': '가치 지표와 패키징을 정하고, 제공 원가와 지불 의향 가정에 비추어 가격대를 검증합니다.',
  'agency-finance-fpa-analyst': '동인 기반 첫해 예산과 단위 경제성을 만들어 소진율·손익분기점과 결과를 가장 크게 움직이는 가정을 보여 줍니다.',
  'agency-design-ux-architect': '브리프를 주요 사용자 흐름·정보 구조·구현 가능한 UX 구조로 바꾸고 사용성·접근성 위험을 짚습니다.',
  'agency-engineering-software-architect': '시스템 분해·데이터 흐름·핵심 기술 결정을 제안하고, 각 트레이드오프를 아키텍처 결정 기록으로 남깁니다.',
  'agency-engineering-ai-engineer': 'AI 기능의 모델·검색·평가 방식을 설계하고 비용·지연·실패 처리를 분명히 합니다.',
  'agency-security-architect': '신뢰 경계를 따라 위협을 모델링하고 첫 출시에 중요한 통제부터 우선순위를 매깁니다.',
  'agency-engineering-privacy-engineer': '프로젝트가 다룰 개인정보를 목록화하고 최소화·동의·보존·삭제 통제를 설계합니다. 결과물은 자격 있는 개인정보·법률 검토가 필요합니다.',
  'agency-marketing-growth-hacker': '유입부터 유지까지의 퍼널을 모델링하고 후보 채널·루프를 고른 뒤, 반증 가능한 성장 실험 백로그에 순위를 매깁니다.',
  'agency-operations-manager': '핵심 프로세스·역량·공급업체·KPI와 표준화할 실패 지점까지, 프로젝트를 매일 실제로 운영하는 방식을 설계합니다.',
  'agency-product-feedback-synthesizer': '브리프가 고객에 대해 실제로 입증하는 것과 가정을 구분하고, 가장 중요한 빈틈을 메울 조사를 설계합니다.',
  'demo-product-strategist': '대안과 비교해 출시 범위·단계·차별점을 판단합니다.',
  'demo-business-model': '가격·단위 경제성과 추론 비용을 회수하는 방식을 검토합니다.',
  'demo-ai-trust': '근거 표시·책임 한계·고위험 분야 안전장치를 확인합니다.',
  'demo-data-validation': '자료 품질과 의견 근거를 검증할 수 있는지 살펴봅니다.',
  'demo-ux-research': '첫 사용 흐름·명확성·가치에 닿기까지의 시간을 봅니다.',
  'demo-security-compliance': '데이터 처리·접근 통제·규제 요구 사항을 검토합니다.',
};

/** `?lang=ko|en` 값. 없거나 다른 값이면 null */
function langParam(search: string): Lang | null {
  for (const part of (search.startsWith('?') ? search.slice(1) : search).split('&')) {
    if (part === 'lang' || part.startsWith('lang=')) { const v = part.slice('lang='.length); return v === 'ko' || v === 'en' ? v : null; }
  }
  return null;
}
/** 처음 언어: 올바른 ?lang= → 브라우저 언어 목록에서 처음 나오는 ko·en → en */
function pickLang(search: string, prefs: readonly unknown[]): Lang {
  const q = langParam(search);
  if (q) return q;
  for (const p of prefs) {
    if (typeof p !== 'string') continue;
    const t = p.trim().toLowerCase();
    if (t === 'ko' || t.startsWith('ko-')) return 'ko';
    if (t === 'en' || t.startsWith('en-')) return 'en';
  }
  return 'en';
}
/** 다른 질의는 그대로 두고 lang 만 바꾼 `?…` */
function withLang(search: string, l: Lang): string {
  const kept = (search.startsWith('?') ? search.slice(1) : search).split('&').filter(p => p && p !== 'lang' && !p.startsWith('lang='));
  return `?${[...kept, `lang=${l}`].join('&')}`;
}

/** GET /api/cloudbite/owner/session 응답. 글자 그대로의 true 만 로그인으로 본다. 형식이 틀리면 null (로그인 아님으로 다룬다) */
function normalizeOwnerSession(raw: unknown): { authenticated: boolean; hasCredentials: boolean } | null {
  if (!isObj(raw) || typeof raw.authenticated !== 'boolean') return null;
  return { authenticated: raw.authenticated === true, hasCredentials: raw.hasCredentials === true };
}

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
/** 카탈로그의 기계용 분야 이름(strategy.pricing, design.ui-ux)을 읽을 수 있는 말로. 이미 사람이 쓴 말이면 그대로 */
function domainLabel(d: string): string {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d)) return d;
  const last = d.slice(d.lastIndexOf('.') + 1).replace(/-/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}
/** 파일 응답 봉투 {path, label, bytes, content} 에서 내용만 꺼낸다. 형식이 다르거나 다른 파일이면 null */
function artifactContent(body: unknown, path: string): string | null {
  if (!isObj(body) || typeof body.content !== 'string') return null;
  if (body.path !== undefined && body.path !== path) return null;
  return clip(body.content, 200_000);
}

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
    id, name, domain: str(raw.domain, 80, 'General'), summary: str(raw.summary, 400), prompt: str(raw.prompt, 20000),
    tools: strList(raw.tools, 80, 20), outputs: strList(raw.outputs, 120, 20),
    source: {
      repository: str(src.repository, 200), path: str(src.path, 200), revision: str(src.revision, 80),
      license: str(src.license, 120), basis: src.basis === 'curated-knowledge' ? 'curated-knowledge' : 'metadata-derived',
    },
  };
}

const ACCESS_STATUSES: CloudbiteAccessRequest['status'][] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
const ACCESS_RECOVERY: NonNullable<CloudbiteAccessSession['recovery']>[] = ['pending', 'unavailable', 'limit'];
/** 실패한 방문자 실행의 정리 확인을 기다리며 bootstrap 을 다시 읽는 횟수·간격 (그 뒤에는 Check again 으로만) */
const ACCESS_RECHECKS = 24;
const ACCESS_RECHECK_MS = 5000;
/** 방문자 접근 상태 (bootstrap.access). 자격 증명은 HttpOnly 쿠키에만 있고 여기에는 상태만 온다. 깨졌으면 없는 것으로 본다 */
function normalizeAccess(raw: unknown): CloudbiteAccessSession | undefined {
  if (!isObj(raw)) return undefined;
  const r = raw.request;
  if (r === null || r === undefined) return { request: null, canCreate: false };
  if (!isObj(r)) return undefined;
  const id = str(r.id, 120), status = r.status as CloudbiteAccessRequest['status'];
  if (!id || !ACCESS_STATUSES.includes(status)) return undefined;
  const n = (v: unknown, max: number) => { const x = num(v); return x !== null && x >= 0 ? Math.min(Math.floor(x), max) : 0; };
  const request: CloudbiteAccessRequest = {
    id, status, name: str(r.name, 80), purpose: str(r.purpose, 1000), createdAt: n(r.createdAt, Number.MAX_SAFE_INTEGER), expiresAt: n(r.expiresAt, Number.MAX_SAFE_INTEGER),
    maxExperts: n(r.maxExperts, 100), maxProjects: n(r.maxProjects, 100), usedProjects: n(r.usedProjects, 100),
  };
  const recovery = ACCESS_RECOVERY.find(x => x === raw.recovery);
  return { request, canCreate: raw.canCreate === true && status === 'approved', ...(recovery ? { recovery } : {}) };
}

/** 승인되고 만료 전인 방문자 요청만 돌려준다. URL 이 아니라 서버 bootstrap 이 알려 준 상태만 본다 */
function approvedVisitor(a: CloudbiteAccessSession | undefined, now: number): CloudbiteAccessRequest | null {
  const r = a?.request;
  return r && r.status === 'approved' && r.expiresAt > now ? r : null;
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
  const access = normalizeAccess(raw.access);
  return {
    experts,
    configuration: {
      liveReady: c.liveReady === true, missing: strList(c.missing, 80, 20),
      maxExperts: max !== null && max >= 1 ? Math.min(Math.floor(max), 100) : 5,
      ...(c.historyRetentionDays === 30 ? { historyRetentionDays: 30 } : {}),
    },
    ...(access ? { access } : {}),
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

/** 폼 오류. field 로 접힌 Project details 를 펼칠지 정하고, text 는 그릴 때의 언어로 바꾼다 */
interface FormIssue { field: 'title' | 'objective' | 'context' | 'experts' | 'run'; text: Text }
function validateForm(f: FormInput, limits: Limits): FormIssue[] {
  const errors: FormIssue[] = [];
  if (!f.title.trim()) errors.push({ field: 'title', text: m => m.vTitle });
  if (f.title.length > LIMIT.title) errors.push({ field: 'title', text: m => m.vTitleLong(LIMIT.title) });
  if (!f.objective.trim()) errors.push({ field: 'objective', text: m => m.vObjective });
  if (f.objective.length > LIMIT.objective) errors.push({ field: 'objective', text: m => m.vObjectiveLong(LIMIT.objective) });
  if (f.context.length > LIMIT.context) errors.push({ field: 'context', text: m => m.vContextLong(LIMIT.context) });
  if (f.expertIds.length < limits.min) errors.push({ field: 'experts', text: m => m.vMin(limits.min) });
  if (f.expertIds.length > limits.max) errors.push({ field: 'experts', text: m => m.vMax(limits.max) });
  return errors;
}

// ───────────────────────── 종합 (완료된 유효 의견만) ─────────────────────────

function aggregate(p: ConsoleProject, m: Messages = EN): Aggregate {
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
  let headline = m.hNone;
  if (valid > 0 && leading) {
    const base = tie ? m.hTie : leading === 'support' ? m.hSupport : leading === 'conditional' ? m.hConditional : leading === 'concern' ? m.hConcern : m.hAbstain;
    headline = valid < p.experts.length ? m.hPartial(base, valid, p.experts.length) : base;
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
      const field = domainLabel(e.domain).toLowerCase();
      summary = `${DIRECTION_LABEL[direction]} opinion from a ${field} perspective. Reviewed the premises of objective ${obj} against the role's criteria.`;
      steps = [
        ['tool', `read_file PROJECT.md — extract issues from a ${field} perspective`],
        ['thought', `List the largest uncertainty by ${field} criteria`],
        ['tool', 'write_file out/notes.md — role review notes'],
      ];
      evidence = [`Objective ${obj}`, `Context ${ctx}`];
      assumptions = ['Role definition is based on catalogue metadata'];
      nextActions = [`Validate the key ${field} assumptions`];
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

/** 머리말·제목은 화면 언어로, 브리프·의견·오류 원문은 받은 그대로 */
function markdownReport(p: ConsoleProject, demo: boolean, m: Messages = EN): string {
  const a = aggregate(p, m);
  const lines = [`# ${p.brief.title}`, '', demo ? m.mdDemo : m.mdLive, '',
    `## ${m.mdObjective}`, p.brief.objective, '', `## ${m.mdContext}`, p.brief.context || m.none, '',
    `## ${m.mdSynthesis}`, `- ${m.mdStatus(m.projectStatus[p.status])}`, `- ${m.mdCounts(a)}`,
    `- ${DIRECTIONS.map(d => `${m.direction[d]} ${a.counts[d]}`).join(' · ')}`,
    `- ${m.mdMean(a.meanConfidence === null ? '—' : a.meanConfidence + '%')}`, '', a.headline, '', `## ${m.mdNext}`,
    ...(a.actions.length ? a.actions.map((x, i) => `${i + 1}. ${x.text} (${x.names.join(', ')})`) : [m.none]), '', `## ${m.mdByExpert}`];
  for (const e of p.experts) {
    lines.push('', `### ${e.name} — ${m.status[e.status]}`);
    if (e.opinion) lines.push(m.mdOpinion(m.direction[e.opinion.direction], e.opinion.confidence), '', e.opinion.summary);
    else if (e.error) lines.push(m.mdError(e.error));
    else if (e.invalidOpinion) lines.push(m.mdInvalid);
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

/** 사람이 읽는 시:분 (방문자 세션 끝 등). 화면 언어의 Intl 형식·24시간제, Intl 이 없으면 clock 으로 */
function hhmmIn(l: Lang, at: number): string {
  try { return new Intl.DateTimeFormat(l === 'ko' ? 'ko-KR' : 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at); }
  catch { return clock(at).slice(0, 5); }
}
/** 브라우저가 알려 준 선호 언어 목록 (없으면 빈 목록) */
function navigatorLangs(nav: Navigator | undefined): readonly unknown[] {
  if (!nav) return [];
  return Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language];
}
/** 소유자 세션을 저절로(탭 포커스·Settings·Live run 전환) 다시 읽는 최소 간격. 사용자가 누른 확인은 바로 읽는다 */
const OWNER_REFRESH_MS = 30_000;
const OWNER_INBOX_PATH = '/cloudbite/requests';
const REQUEST_PATH = '/cloudbite/request';

const HISTORY_TEXT = {
  en: {
    title: 'Usage history', mine: 'My records', all: 'All users', report: 'Improvement report', refresh: 'Refresh', more: 'Load more',
    notice: 'Live-run questions and answers are stored for 30 days and can be reviewed by the owner to improve quality. You can delete finished records in History. Browser demos stay in this tab.',
    intro: 'Reopen questions, expert answers and feedback. Records stay available in this browser for 30 days; clearing browser cookies removes your access.',
    empty: 'No saved runs yet. Start a live run, then refresh here after a few seconds. Browser demos are not stored.',
    select: 'Choose a record to read the question and answers.', loading: 'Loading records…', auth: 'Run a project with approved visitor access, or sign in as the owner to see saved records.',
    error: (s: number) => s === 409 ? 'Stop the running project before deleting its record.' : `Could not load or update history (${s || 'network error'}). Try again.`,
    detail: 'Question and answers', model: 'Model', objective: 'Question', context: 'Context', sources: 'Evidence and sources', assumptions: 'Assumptions', actions: 'Next actions',
    expires: 'Available until', feedback: 'Was this expert answer useful?', helpful: 'Helpful', unhelpful: 'Not helpful', issue: 'What needs improvement?',
    noIssue: 'Choose a reason (optional)', comment: 'Comment (optional, up to 1,000 characters)', save: 'Save feedback', saved: 'Feedback saved.',
    remove: 'Delete record', confirm: 'Delete this question, answers, feedback and stored output files?', deleteYes: 'Delete permanently', cancel: 'Keep record',
    ownerNote: 'All-user records and the improvement report require the owner session. Sign in through Owner inbox.',
    reportIntro: 'Automatic signals from up to the latest 1,000 saved projects in 30 days. Only finished live runs contribute to quality metrics. No extra model calls or automatic prompt edits.',
    qualityNote: 'Source presence only checks reference formatting. It does not verify truth. Confidence is self-assessed, not accuracy.',
    sample: (n: number, live: number, demos: number, pending: number) => `${n} projects sampled · ${live} live · ${demos} server demos excluded · ${pending} live runs still in progress`,
    noSignals: 'No improvement signals in this sample yet. Collect real runs and user feedback before drawing conclusions.',
    small: 'Small sample: treat these as investigation leads, not a quality score or a ranking of expert ability.',
    counts: 'Execution and feedback', completed: 'Completed answers', failed: 'Failed experts', referenced: 'Answers with references', feedbackHelpful: 'Helpful reviews', feedbackUnhelpful: 'Unhelpful reviews',
    role: 'Expert', basis: 'Knowledge basis', revision: 'Prompt versions', knowledge: 'Curated knowledge', metadata: 'Persona metadata', unknown: 'Unknown',
    confidence: 'Self-assessed confidence distribution', errors: 'Failure categories', feedbackIssues: 'Feedback reasons', models: 'Models', projects: 'Projects', feedbackReadonly: 'Feedback is provided by the user who ran this project.',
    insights: {
      execution: (n: number, total: number) => `${n} / ${total} experts failed. Review the failure categories and affected roles before changing persona prompts.`,
      sources: (n: number, total: number) => `${n} / ${total} completed answers had no URL or source-ID reference. Review retrieval and citation instructions.`,
      confidence: (n: number, total: number) => `${n} / ${total} finished live projects gave identical confidence across at least three answers. Inspect shared examples and scoring rubrics; this alone does not prove a defect.`,
      feedback: (n: number, total: number) => `${n} / ${total} user reviews were unhelpful. Read the linked records and reasons before prioritizing changes.`,
      knowledge: (n: number, total: number) => `${n} / ${total} completed answers used metadata-only personas. Add curated domain material and retrieval where feedback shows a need.`,
    },
    issues: { incorrect: 'Incorrect', 'missing-sources': 'Missing sources', 'too-generic': 'Too generic', 'off-topic': 'Off topic', slow: 'Too slow', other: 'Other' } as Record<HistoryIssue, string>,
    errorKinds: { format: 'Result format', timeout: 'Timeout', 'rate-limit': 'Rate limit', budget: 'Budget / credit', sandbox: 'Sandbox', inference: 'Inference', other: 'Other' } as Record<string, string>,
  },
  ko: {
    title: '사용 기록', mine: '내 기록', all: '전체 사용자', report: '개선 리포트', refresh: '새로 고침', more: '더 보기',
    notice: '실제 실행의 질문·답변은 30일간 보관하며 운영자가 품질 개선을 위해 열람할 수 있습니다. 완료된 기록은 사용 기록에서 삭제할 수 있습니다. 브라우저 데모는 이 탭에만 남습니다.',
    intro: '질문·전문가 답변·피드백을 다시 살펴봅니다. 같은 브라우저에서 30일간 볼 수 있으며, 쿠키를 지우면 내 기록에 접근할 수 없습니다.',
    empty: '저장된 실행이 없습니다. 실제 실행을 시작한 뒤 몇 초 후 새로 고침하세요. 브라우저 데모는 저장하지 않습니다.',
    select: '기록을 선택하면 질문과 답변을 볼 수 있습니다.', loading: '기록을 불러오는 중…', auth: '승인된 방문자로 프로젝트를 실행하거나, 운영자 로그인 후 저장된 기록을 볼 수 있습니다.',
    error: (s: number) => s === 409 ? '실행 중인 프로젝트를 먼저 중지한 뒤 기록을 삭제하세요.' : `기록을 불러오거나 변경하지 못했습니다 (${s || '네트워크 오류'}). 다시 시도하세요.`,
    detail: '질문과 답변', model: '모델', objective: '질문', context: '맥락', sources: '근거와 출처', assumptions: '가정', actions: '다음 행동',
    expires: '보관 기한', feedback: '이 전문가의 답변이 도움이 됐나요?', helpful: '도움됨', unhelpful: '도움 안 됨', issue: '개선이 필요한 부분',
    noIssue: '이유 선택 (선택 사항)', comment: '의견 (선택 사항, 최대 1,000자)', save: '피드백 저장', saved: '피드백을 저장했습니다.',
    remove: '기록 삭제', confirm: '이 질문·답변·피드백과 저장된 결과 파일을 삭제할까요?', deleteYes: '영구 삭제', cancel: '기록 유지',
    ownerNote: '전체 사용자 기록과 개선 리포트는 운영자 로그인이 필요합니다. 소유자 요청함에서 로그인하세요.',
    reportIntro: '최근 30일 내 최신 프로젝트 최대 1,000개의 자동 집계입니다. 완료된 실제 실행만 품질 지표에 반영합니다. 추가 모델 호출이나 프롬프트 자동 변경은 하지 않습니다.',
    qualityNote: '출처 표기는 참조 형식의 유무만 확인하며 사실 여부를 검증하지 않습니다. 확신도는 자체 평가이며 정확도가 아닙니다.',
    sample: (n: number, live: number, demos: number, pending: number) => `분석 표본 ${n}개 · 실제 실행 ${live}개 · 서버 데모 ${demos}개 제외 · 실제 실행 진행 중 ${pending}개`,
    noSignals: '아직 이 표본에서 개선 신호가 발견되지 않았습니다. 실제 실행과 사용자 피드백을 더 모아 판단하세요.',
    small: '표본이 작습니다. 전문가의 능력 순위나 품질 점수가 아니라 우선 조사할 단서로 보세요.',
    counts: '실행과 피드백', completed: '완료 답변', failed: '실패 전문가', referenced: '출처 표기 답변', feedbackHelpful: '도움됨 평가', feedbackUnhelpful: '도움 안 됨 평가',
    role: '전문가', basis: '지식 기반', revision: '프롬프트 버전 수', knowledge: '문서 기반 지식', metadata: '페르소나 메타데이터', unknown: '알 수 없음',
    confidence: '자체 평가 확신도 분포', errors: '실패 유형', feedbackIssues: '개선 요청 이유', models: '모델', projects: '프로젝트', feedbackReadonly: '이 프로젝트를 실행한 사용자가 남기는 피드백입니다.',
    insights: {
      execution: (n: number, total: number) => `전문가 ${total}명 중 ${n}명이 실패했습니다. 페르소나를 바꾸기 전에 실패 유형과 해당 역할을 확인하세요.`,
      sources: (n: number, total: number) => `완료 답변 ${total}개 중 ${n}개에 URL·출처 ID 표기가 없습니다. 문서 검색과 근거 인용 지시를 점검하세요.`,
      confidence: (n: number, total: number) => `완료된 실제 실행 ${total}개 중 ${n}개에서 답변 3개 이상이 같은 확신도를 보고했습니다. 공통 예시와 평가 기준을 확인하세요. 이것만으로 결함이 입증되지는 않습니다.`,
      feedback: (n: number, total: number) => `사용자 평가 ${total}개 중 ${n}개가 도움 안 됨입니다. 해당 기록과 이유를 읽고 개선 우선순위를 정하세요.`,
      knowledge: (n: number, total: number) => `완료 답변 ${total}개 중 ${n}개가 메타데이터 중심 페르소나를 사용했습니다. 피드백에서 필요가 확인되는 분야부터 문서·검색을 보강하세요.`,
    },
    issues: { incorrect: '내용이 틀림', 'missing-sources': '출처 부족', 'too-generic': '너무 일반적임', 'off-topic': '질문과 무관함', slow: '너무 느림', other: '기타' } as Record<HistoryIssue, string>,
    errorKinds: { format: '결과 형식', timeout: '시간 초과', 'rate-limit': '호출 제한', budget: '예산·크레딧', sandbox: '샌드박스', inference: '추론', other: '기타' } as Record<string, string>,
  },
};

function boot(): void {
  // 운영자 링크는 화면·요청보다 먼저 지운다. 링크가 있으면 실제 실행 모드로 열고 자동 데모·자동 실행은 하지 않는다
  const link = takeOperatorLink();
  const root = document.getElementById('cloudbite');
  if (!root) return;
  const g = globalThis as { location?: Location; history?: History; navigator?: Navigator; addEventListener?: (t: string, f: () => void) => void };
  // 언어: 올바른 ?lang= → 브라우저 언어 → en. 저장소에 두지 않고, 바꿀 때 주소의 질의만 replaceState 로 고친다
  let lang: Lang = pickLang(g.location && typeof g.location.search === 'string' ? g.location.search : '', navigatorLangs(g.navigator));
  let M: Messages = DICT[lang];

  const S = {
    gen: 0,
    boot: { status: 'loading' as 'loading' | 'ready' | 'error', data: null as CloudbiteBootstrap | null, error: null as Text | null },
    /** 소유자 로그인 (서버 HttpOnly 쿠키). 서버 /owner/session 응답만 믿는다 — 쿠키가 있는지는 JS 가 모른다 */
    owner: { status: 'loading' as 'loading' | 'ready' | 'error', authenticated: false, hasCredentials: false, error: null as Text | null, busy: false, message: null as Text | null },
    mode: (link.present ? 'live' : 'demo') as Mode,
    adminToken: link.token,
    selected: new Set<string>(),
    failSim: false,
    run: null as null | {
      mode: Mode; phase: 'starting' | 'running' | 'cancelling' | 'done' | 'error'; project: ConsoleProject | null;
      accessToken: string; error: Text | null; startedAt: number; pollErrors: number;
      /** 승인된 방문자 쿠키로 만든 실제 실행: 끝나면 서버 접근 상태를 다시 읽는다 */
      viaVisitor: boolean;
      /** 소유자 로그인 쿠키로 만든 실제 실행 */
      viaOwner: boolean;
    },
    view: (g.location?.pathname?.replace(/\/$/, '') === '/cloudbite/history' ? 'history' : 'home') as View,
    /** 프로젝트 브리프 편집 영역. 실행 전에는 늘 열려 있고, 실행이 실제로 시작되면 접힌다 (오류가 나면 다시 열린다) */
    setupOpen: true,
    /** 사용자가 Settings 에서 실행 방식을 직접 골랐다 — 방문자·소유자 소개가 그 선택을 바꾸지 않는다 */
    modePicked: false,
    full: false,
    /** "Clear view" 때 화면에서만 숨긴 실행 기록 줄. 프로젝트 기록·파일은 그대로 둔다 */
    hiddenRows: new Set<string>(),
    focusExpert: '',
    tab: 'artifacts' as 'persona' | 'workorder' | 'activity' | 'artifacts',
    artifactPath: '',
    /** 사용자가 파일을 직접 고르기 전에는 새 파일이 생기면 가장 쓸모 있는 파일(out/report.md 우선)로 따라간다 */
    artifactPicked: false,
    artifactCache: new Map<string, { state: 'loading' } | { state: 'ok'; text: string } | { state: 'error'; text: Text }>(),
    /** 승인된 방문자를 처음 알아챘을 때 한 번만 실제 실행·프로젝트 설정으로 연다 */
    visitorIntro: false,
    /** 로그인한 소유자를 처음 알아챘을 때 한 번만 실제 실행으로 연다 (실행은 하지 않는다) */
    ownerIntro: false,
    formErrors: (link.present && !link.token ? [{ field: 'run', text: m => m.operatorMalformedLink }] : []) as FormIssue[],
  };
  let timers: number[] = [];
  let pollTimer = 0;
  let accessTimer = 0, accessTries = 0;
  let lastAnnounce = '';
  const H = {
    tab: (new URLSearchParams(g.location?.search ?? '').get('tab') === 'report' ? 'report' : 'mine') as 'mine' | 'all' | 'report',
    owner: false, busy: false, detailBusy: false, mutation: false, error: 0, unauthorized: false, message: '',
    list: null as HistoryList | null, detail: null as HistoryDetail | null, report: null as HistoryReport | null,
    deleteId: '', gen: 0, detailGen: 0, dirty: true, renderedLang: '',
    drafts: new Map<string, Omit<HistoryFeedback, 'at'>>(), opened: new Set<string>(),
  };
  const HT = () => HISTORY_TEXT[lang];
  function clearHistoryAuthority(): void {
    H.gen++; H.detailGen++; H.list = null; H.detail = null; H.report = null; H.drafts.clear(); H.opened.clear(); H.owner = false; H.busy = false; H.detailBusy = false; H.dirty = true; H.tab = 'mine';
  }

  const catalogue = (): ExpertDefinition[] => S.mode === 'live' ? S.boot.data?.experts ?? [] : (S.boot.data?.experts.length ? S.boot.data.experts : DEMO_EXPERTS);
  const catalogueIsBuiltin = () => S.mode === 'demo' && !S.boot.data?.experts.length;
  // 실제 실행 자격의 우선순위: 직접 넣은 관리자·운영자 토큰(헤더) → 소유자 로그인 쿠키 → 승인된 방문자 쿠키. JS 는 쿠키를 읽지 않는다
  const visitor = () => approvedVisitor(S.boot.data?.access, Date.now());
  const visitorLeft = () => { const v = visitor(); return v ? Math.max(0, v.maxProjects - v.usedProjects) : 0; };
  const visitorCanRun = () => !!visitor() && !!S.boot.data?.access?.canCreate && visitorLeft() > 0;
  const ownerAuthed = () => S.owner.status === 'ready' && S.owner.authenticated;
  const viaOwner = () => S.mode === 'live' && !S.adminToken.trim() && ownerAuthed();
  const viaVisitor = () => S.mode === 'live' && !S.adminToken.trim() && !ownerAuthed() && !!visitor();
  const liveCredential = () => !!S.adminToken.trim() || ownerAuthed() || visitorCanRun();
  const hhmm = (at: number) => hhmmIn(lang, at);
  /** 같은 출처 Cloudbite 화면 주소에 지금 언어를 붙인다 */
  const href = (path: string) => `${path}${withLang('', lang)}`;
  /** 쓸 수 없는 방문자 접근 상태의 설명. 쓸 수 있거나 요청이 없으면 null */
  const accessProblem = (): Text | null => {
    const r = S.boot.data?.access?.request;
    if (!r) return null;
    if (visitor()) {
      if (visitorCanRun()) return null;
      const rec = S.boot.data?.access?.recovery;
      return rec === 'pending' ? m => m.accessPending : rec === 'unavailable' ? m => m.accessUnavailable : rec === 'limit' ? m => m.accessLimit : m => m.accessSpent;
    }
    return r.status === 'pending' ? m => m.accessWaiting : r.status === 'denied' ? m => m.accessDenied : r.status === 'revoked' ? m => m.accessRevoked : m => m.accessExpired;
  };
  const limits = (): Limits => {
    const server = S.mode === 'live' ? S.boot.data?.configuration.maxExperts ?? 5 : 5;
    const session = viaVisitor() ? visitor()!.maxExperts : 5;
    return { min: 1, max: Math.max(1, Math.min(5, server, session)) };
  };
  const active = () => !!S.run && (S.run.phase === 'starting' || S.run.phase === 'running' || S.run.phase === 'cancelling'
    || (S.run.phase === 'error' && !!S.run.project && !TERMINAL_PROJECT.includes(S.run.project.status)));
  /** 실패한 실행의 정리를 아직 확인하지 못한 방문자: Check again 으로 서버 상태를 다시 읽을 수 있다 */
  const recheckable = () => { const r = S.boot.data?.access?.recovery; return !!visitor() && !visitorCanRun() && (r === 'pending' || r === 'unavailable'); };
  const checkAgain = () => h('button', { type: 'button', class: 'cb-ghost', onclick: () => refreshAccess(true) }, M.checkAgain);
  const findDef = (id: string) => catalogue().find(e => e.id === id) ?? DEMO_EXPERTS.find(e => e.id === id);

  // ── 고정 뼈대의 글자: 만들 때 지금 언어로 채우고, 언어를 바꾸면 applyLang 이 다시 채운다 (노드는 그대로라 포커스·입력·열림 상태가 남는다)
  const binds: Array<() => void> = [];
  function bind<N extends Element>(n: N, f: (n: N, m: Messages) => void): N { const run = () => f(n, M); binds.push(run); run(); return n; }
  function tx<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null, f: Text): HTMLElementTagNameMap[K] {
    return bind(h(tag, props), (n, m) => { n.textContent = f(m); });
  }
  const attr = <N extends Element>(n: N, name: string, f: Text): N => bind(n, (x, m) => x.setAttribute(name, f(m)));
  /** 같은 출처 Cloudbite 화면 링크: 글자와 ?lang= 가 화면 언어를 따른다 */
  const pageLink = (path: string, f: Text, props: Record<string, unknown> = {}) => bind(h('a', props), (n, m) => { n.textContent = f(m); n.setAttribute('href', href(path)); });

  // ── 고정 뼈대 (입력란·접기 상자는 한 번만 만들어 포커스·입력 중 글자·열림 상태를 잃지 않는다)
  const titleIn = h('input', { id: 'cb-title', type: 'text', maxlength: LIMIT.title, autocomplete: 'off', value: M.sampleTitle });
  const objectiveIn = h('textarea', { id: 'cb-objective', rows: 4, maxlength: LIMIT.objective });
  objectiveIn.value = M.sampleObjective;
  const contextIn = h('textarea', { id: 'cb-context', rows: 3, maxlength: LIMIT.context });
  contextIn.value = M.sampleContext;
  const staExampleBtn = tx('button', { type: 'button', class: 'cb-link', onclick: () => {
    if (active() || !findDef('probably-primetime-sta')) return;
    titleIn.value = M.staTitle; objectiveIn.value = M.staObjective; contextIn.value = M.staContext;
    S.selected.clear(); S.selected.add('probably-primetime-sta'); S.formErrors = [];
    for (const update of recount) update();
    keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
    objectiveIn.focus();
  } }, m => m.staExample);
  // 글자 수는 입력 중(포커스)이거나 한도에 가까울 때만 보인다 (CSS)
  const recount: Array<() => void> = [];
  const counter = (inp: HTMLInputElement | HTMLTextAreaElement, max: number) => {
    const c = h('span', { class: 'cb-count', 'aria-hidden': 'true' });
    const upd = () => { c.textContent = `${inp.value.length} / ${max}`; c.className = `cb-count${inp.value.length > max * 0.9 ? ' is-near' : ''}`; };
    inp.addEventListener('input', upd); upd(); recount.push(upd);
    return c;
  };
  for (const inp of [titleIn, objectiveIn]) inp.addEventListener('input', () => { if (!active()) renderControls(); });
  const tokenIn = attr(h('input', { id: 'cb-token', type: 'password', autocomplete: 'off', spellcheck: 'false' }), 'placeholder', m => m.tokenPlaceholder);
  tokenIn.value = S.adminToken;
  tokenIn.addEventListener('input', () => { S.adminToken = tokenIn.value; clearHistoryAuthority(); renderControls(); renderProgress(); });
  const failIn = h('input', { id: 'cb-fail', type: 'checkbox' });
  failIn.addEventListener('change', () => { S.failSim = failIn.checked; });
  const filterIn = attr(attr(h('input', { id: 'cb-filter', type: 'search', autocomplete: 'off' }), 'placeholder', m => m.searchPlaceholder), 'aria-label', m => m.searchAria);
  filterIn.addEventListener('input', () => renderCatalogue());

  const modeDemo = tx('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'true', onclick: () => setMode('demo') }, m => m.modeDemo);
  const modeLive = tx('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'false', onclick: () => setMode('live') }, m => m.modeLive);
  const startBtn = h('button', { type: 'button', class: 'cb-primary cb-start', 'data-fk': 'start', onclick: () => startRun() });
  const startLabel = h('span');
  startBtn.append(icon('play'), startLabel);
  const cancelBtn = h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'stop', onclick: () => cancelRun() });
  const cancelLabel = h('span');
  cancelBtn.append(icon('stop'), cancelLabel);
  const formMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const runMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const coreBox = h('div', { class: 'cb-catalogue', role: 'group', 'aria-labelledby': 'cb-cat-label' });
  const moreBox = attr(h('div', { class: 'cb-catalogue', role: 'group' }), 'aria-label', m => m.allExpertsAria);
  const moreLabel = h('span');
  const moreDetails = h('details', { class: 'cb-disclosure cb-more' },
    h('summary', null, icon('chevron'), moreLabel), h('div', { class: 'cb-disclosure-body' }, filterIn, moreBox));
  const alsoSel = h('p', { class: 'cb-alsosel' });
  const catalogueNote = h('p', { class: 'cb-help' });
  const selCount = h('span', { class: 'cb-selcount' });
  const liveStatus = h('div', { class: 'cb-live-status' });
  const clearTokenBtn = tx('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.adminToken = ''; tokenIn.value = ''; clearHistoryAuthority(); renderControls(); tokenIn.focus(); } }, m => m.clearToken);
  const tokenLabel = h('label', { for: 'cb-token', class: 'cb-label' });
  const liveBox = h('div', { class: 'cb-live' }, liveStatus,
    tokenLabel, tokenIn, tx('p', { class: 'cb-help' }, m => m.tokenHelp), clearTokenBtn);
  const demoBox = h('div', { class: 'cb-demoopts' },
    h('label', { class: 'cb-check' }, failIn, ' ', tx('span', null, m => m.failSim)));

  const detailsHint = h('span', { class: 'cb-summary-hint' });
  const projDetails = h('details', { class: 'cb-disclosure' },
    h('summary', null, icon('chevron'), tx('span', null, m => m.projectDetails), detailsHint),
    h('div', { class: 'cb-disclosure-body cb-fields' },
      h('div', { class: 'cb-field' }, tx('label', { for: 'cb-title', class: 'cb-label' }, m => m.projectName), titleIn, counter(titleIn, LIMIT.title)),
      h('div', { class: 'cb-field' }, tx('label', { for: 'cb-context', class: 'cb-label' }, m => m.contextLabel), contextIn, counter(contextIn, LIMIT.context))));
  const modeLine = h('span');
  const startNote = h('div', { class: 'cb-startnote' });
  const historyNotice = tx('p', { class: 'cb-help cb-history-notice' }, () => HT().notice);
  const form = attr(h('form', { class: 'cb-form', novalidate: true },
    h('div', { class: 'cb-field cb-objective' }, tx('label', { for: 'cb-objective', class: 'cb-label' }, m => m.objectiveLabel), objectiveIn, counter(objectiveIn, LIMIT.objective)),
    staExampleBtn, projDetails,
    h('div', { class: 'cb-team', role: 'group', 'aria-labelledby': 'cb-cat-label' },
      h('div', { class: 'cb-label-row' }, tx('span', { id: 'cb-cat-label', class: 'cb-label' }, m => m.chooseExperts), selCount),
      coreBox, alsoSel, moreDetails, catalogueNote),
    h('div', { class: 'cb-form-foot' }, formMsg, startNote,
      historyNotice,
      h('div', { class: 'cb-start-row' }, startBtn,
        h('p', { class: 'cb-mode-line' }, modeLine, ' ', tx('button', { type: 'button', class: 'cb-link', onclick: () => setView('settings') }, m => m.changeInSettings))))), 'aria-label', m => m.briefAria);
  form.addEventListener('submit', ev => { ev.preventDefault(); startRun(); });

  // ── 머리 (네이비 70px): 브랜드 · KO / EN · 모드 배지 · 세션 상태
  const modeBadge = h('span', { class: 'cb-badge' });
  const profileState = h('span', { class: 'cb-profile-state' });
  const profileName = h('span', { class: 'cb-profile-name' });
  const banner = h('p', { class: 'cb-banner' });
  const live = h('div', { class: 'cb-sr', 'aria-live': 'polite' });
  // 보이는 글자는 KO·EN, 읽기 프로그램에는 그 언어 이름(자기 언어로)을 함께 준다. 지금 언어는 aria-pressed
  const langBtns = LANG_ORDER.map(l => h('button', { type: 'button', class: 'cb-lang-btn', lang: l, 'data-fk': `lang:${l}`, onclick: () => setLang(l) },
    l.toUpperCase(), h('span', { class: 'cb-sr' }, ` ${LANG_NAME[l]}`)));
  const langGroup = attr(h('div', { class: 'cb-lang', role: 'group' }, ...langBtns), 'aria-label', m => m.langGroup);

  // ── 프로젝트 카드: 편집 중에는 "Project brief" 입력, 실행이 시작되면 제목·목표 요약과 상태
  const projTitle = h('h2', { id: 'cb-project-h', class: 'cb-project-title', tabindex: '-1' });
  const projObjective = h('p', { class: 'cb-project-obj' });
  const projStatus = h('span', { class: 'cb-pill' });
  const projMeta = h('div', { class: 'cb-project-meta' });
  const setupLabel = h('span');
  const setupBtn = h('button', { type: 'button', class: 'cb-secondary', 'aria-expanded': 'true', 'aria-controls': 'cb-setup', 'data-fk': 'setup',
    onclick: () => { S.setupOpen = !S.setupOpen; renderControls(); if (S.setupOpen && !active()) objectiveIn.focus(); } }, icon('edit'), setupLabel);
  const dlJson = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'export-json', onclick: () => download('json') }, icon('download'), tx('span', null, m => m.exportJson));
  const dlMd = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'export-md', onclick: () => download('md') }, icon('download'), tx('span', null, m => m.exportReport));
  const moreOpts = h('details', { class: 'cb-menu' }, h('summary', null, tx('span', null, m => m.moreOptions), icon('chevron')), h('div', { class: 'cb-menu-body' }, dlJson));
  const projActions = h('div', { class: 'cb-project-actions' }, dlMd, moreOpts);
  const projBody = h('div', { class: 'cb-project-body' }, projObjective, projMeta, projActions);
  const setup = h('div', { id: 'cb-setup', class: 'cb-setup' }, form);
  const projectCard = h('section', { class: 'cb-panel cb-project', 'aria-labelledby': 'cb-project-h' },
    h('div', { class: 'cb-project-top' }, projTitle, projStatus, h('span', { class: 'cb-spacer' }), cancelBtn, setupBtn),
    runMsg, projBody, setup);

  // ── 전문가 작업공간 (프로젝트가 생긴 뒤에만): 전문가 목록 · 의견·파일 · 접히는 실행 기록
  const wsSub = h('p', { class: 'cb-ws-sub' });
  const fullLabel = h('span'), fullIcon = h('span');
  const fullBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'full', 'aria-controls': 'cb-log', onclick: () => setFull(!S.full) }, fullIcon, fullLabel);
  const clearBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'clear', onclick: () => clearView() }, icon('clear'), tx('span', null, m => m.clearView));
  const restoreBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'restore', onclick: () => restoreView() }, icon('history'), tx('span', null, m => m.restoreHistory));
  const wsErrors = h('div', { class: 'cb-ws-errors', role: 'alert' });
  const roster = attr(h('div', { class: 'cb-roster', role: 'group' }), 'aria-label', m => m.rosterAria);
  const streamState = h('span', { class: 'cb-stream-state' });
  const streamErr = h('span', { class: 'cb-stream-err' });
  const streamLog = attr(h('ol', { class: 'cb-stream-log', role: 'log', tabindex: '0' }), 'aria-label', m => m.activityTitle);
  const streamNote = h('p', { class: 'cb-stream-note' });
  const inspector = h('div', { class: 'cb-inspector' });
  const activityLog = h('details', { class: 'cb-disclosure cb-log', id: 'cb-log' },
    h('summary', null, icon('chevron'), tx('span', { class: 'cb-log-title' }, m => m.activityTitle), tx('span', { class: 'cb-stream-ro' }, m => m.readOnly), streamErr, streamState),
    h('div', { class: 'cb-stream' }, h('div', { class: 'cb-stream-bar' }, icon('pulse'), tx('span', null, m => m.activityBar), h('span', { class: 'cb-spacer' }), clearBtn, restoreBtn),
      streamLog, streamNote));
  const wsPanel = h('section', { class: 'cb-panel cb-workspace', 'aria-labelledby': 'cb-ws-h' },
    h('div', { class: 'cb-ws-head' },
      h('div', { class: 'cb-ws-title' }, tx('h2', { id: 'cb-ws-h' }, m => m.workspaceTitle), wsSub),
      h('div', { class: 'cb-ws-actions' }, fullBtn)),
    wsErrors, roster, inspector, activityLog);

  // ── 오른쪽 (실행 뒤에만): 결과가 있으면 종합이 맨 위, 진행 · 지금 할 일
  const progressBody = h('div');
  const stepsBody = h('ol', { class: 'cb-steps' });
  const progressPanel = h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-prog-h' }, h('div', { class: 'cb-panel-head' }, tx('h2', { id: 'cb-prog-h' }, m => m.progress)), progressBody,
    h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), tx('span', null, m => m.progressDetails)), stepsBody));
  const tipBody = h('div');
  const tipPanel = h('section', { class: 'cb-tip', 'aria-labelledby': 'cb-tip-h' }, h('div', { class: 'cb-tip-head' }, icon('tip'), tx('h2', { id: 'cb-tip-h' }, m => m.whatNow)), tipBody);
  const synthTag = tx('span', { class: 'cb-badge is-demo' }, m => m.simulated);
  const synth = h('div', { class: 'cb-synth-body' });
  const confBody = h('div');
  const synthPanel = h('section', { class: 'cb-panel cb-synth', 'aria-labelledby': 'cb-synth-h' },
    h('div', { class: 'cb-panel-head' }, icon('chart'), tx('h2', { id: 'cb-synth-h' }, m => m.synthesis), synthTag), synth,
    h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), tx('span', null, m => m.confidenceDetails)), confBody));
  const aside = attr(h('aside', { class: 'cb-aside' }, progressPanel, tipPanel, synthPanel), 'aria-label', m => m.asideAria);

  // ── Guide · Help · Settings (기존 안내·설정 내용을 실제로 보여 준다)
  const guideStep = (i: number) => h('li', null, h('span', { class: 'cb-guide-n' }, String(i + 1)), tx('h3', null, m => m.guide[i][0]), tx('p', null, m => m.guide[i][1]));
  const goHome = h('button', { type: 'button', class: 'cb-primary', onclick: () => setView('home') }, icon('home'), tx('span', null, m => m.backHome));
  const guideView = h('section', { class: 'cb-view cb-page', id: 'cb-view-guide', 'aria-labelledby': 'cb-guide-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-guide-h' }, m => m.guideTitle), tx('p', null, m => m.guideIntro)),
    h('ol', { class: 'cb-guide-steps' }, ...EN.guide.map((_, i) => guideStep(i))),
    h('div', null, goHome));

  const faq = (i: number) => h('section', null, tx('h3', null, m => m.faq[i][0]), tx('p', null, m => m.faq[i][1]));
  const helpView = h('section', { class: 'cb-view cb-page', id: 'cb-view-help', 'aria-labelledby': 'cb-help-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-help-h' }, m => m.helpTitle), tx('p', null, m => m.helpIntro)),
    h('div', { class: 'cb-faq' }, ...EN.faq.map((_, i) => faq(i))));

  const settingsView = h('section', { class: 'cb-view cb-page', id: 'cb-view-settings', 'aria-labelledby': 'cb-settings-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-settings-h' }, m => m.settingsTitle), tx('p', null, m => m.settingsIntro)),
    h('div', { class: 'cb-settings' },
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-mode-h' }, tx('h2', { id: 'cb-mode-h' }, m => m.modeHeading),
        attr(h('div', { class: 'cb-segs', role: 'group' }, modeDemo, modeLive), 'aria-label', m => m.modeHeading),
        tx('p', { class: 'cb-help' }, m => m.modeLocked), demoBox, liveBox),
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-about-h' }, tx('h2', { id: 'cb-about-h' }, m => m.aboutHeading),
        tx('p', { class: 'cb-help' }, m => m.aboutText),
        tx('p', { class: 'cb-help' }, m => m.legacyNote),
        tx('a', { href: '/lab' }, m => m.legacyLink))));

  const homeView = h('div', { class: 'cb-view cb-home', id: 'cb-view-home' }, h('div', { class: 'cb-center' }, projectCard, wsPanel), aside);
  const historyBody = h('div', { class: 'cb-history-body' });
  const historyView = h('section', { class: 'cb-view cb-history', id: 'cb-view-history', 'aria-labelledby': 'cb-history-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-history-h' }, () => HT().title), tx('p', null, () => HT().intro)), historyBody);
  const views: Record<View, HTMLElement> = { home: homeView, guide: guideView, help: helpView, settings: settingsView, history: historyView };
  const NAV: View[] = ['home', 'guide', 'help', 'settings', 'history'];
  const navBtns = NAV.map(v => h('button', { type: 'button', class: 'cb-nav-btn', 'data-fk': `nav:${v}`, onclick: () => setView(v) }, icon(v === 'history' ? 'chart' : v), tx('span', null, m => m.nav[v])));

  root.replaceChildren(
    h('header', { class: 'cb-top' },
      h('div', { class: 'cb-brand' }, h('span', { class: 'cb-logo' }, icon('cloud')),
        h('div', { class: 'cb-brand-text' }, h('span', { class: 'cb-word' }, 'Cloudbite', h('small', null, 'v0.0.1')),
          tx('span', { class: 'cb-sub' }, m => m.brandSub))),
      h('div', { class: 'cb-top-right' }, langGroup, modeBadge,
        attr(h('div', { class: 'cb-profile', role: 'status' }, h('span', { class: 'cb-avatar' }, icon('user')),
          h('span', { class: 'cb-profile-text' }, profileName, profileState)), 'aria-label', m => m.sessionAria))),
    live,
    h('div', { class: 'cb-shell' },
      attr(h('nav', { class: 'cb-nav' }, tx('span', { class: 'cb-nav-label' }, m => m.navLabel),
        h('ul', { class: 'cb-nav-list' }, ...navBtns.map(b => h('li', null, b))),
        h('div', { class: 'cb-nav-foot' }, tx('span', null, m => m.navFoot), pageLink(REQUEST_PATH, m => m.requestAccess),
          pageLink('/cloudbite/access', m => m.accessQr, { target: '_blank', rel: 'noopener noreferrer' }), pageLink(OWNER_INBOX_PATH, m => m.ownerInbox))), 'aria-label', m => m.navAria),
      h('main', { class: 'cb-main' }, banner, homeView, guideView, helpView, settingsView, historyView)));

  document.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Escape' && S.full) { ev.preventDefault(); setFull(false); } });

  // ── 렌더 (동적 영역만 다시 그린다. 포커스는 data-fk 로 되돌린다. 접기 상자는 다시 만들지 않아 열림 상태가 남는다)
  function keepFocus(fn: () => void): void {
    const a = document.activeElement as HTMLElement | null;
    const key = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    fn();
    if (key) { const n = root!.querySelector(`[data-fk="${CSS.escape(key)}"]`) as HTMLElement | null; if (n) n.focus(); }
  }

  function renderAll(): void {
    keepFocus(() => {
      // 오른쪽 패널은 프로젝트가 생긴 뒤에만: 그 전에는 편집 영역 한 열
      homeView.className = `cb-view cb-home${S.run?.project ? ' has-rail' : ''}`;
      renderNav(); renderControls(); renderCatalogue(); renderWork(); renderProgress(); renderSynth(); renderHistory();
    });
  }

  function renderNav(): void {
    NAV.forEach((v, i) => { navBtns[i].setAttribute('aria-current', v === S.view ? 'page' : 'false'); views[v].hidden = v !== S.view; });
    banner.hidden = modeBadge.hidden = S.view === 'history';
    LANG_ORDER.forEach((l, i) => langBtns[i].setAttribute('aria-pressed', String(l === lang)));
  }

  /** Settings 의 소유자 로그인 줄. 서버가 돌려준 세션 상태만 보이고, 로그인 자체는 소유자 요청함(/cloudbite/requests)에서 한다 */
  function ownerKids(): Kid[] {
    const m = M, o = S.owner;
    const inbox = h('a', { href: href(OWNER_INBOX_PATH) }, m.ownerInbox);
    const kids: Kid[] = [];
    if (o.status === 'loading') kids.push(h('p', { class: 'cb-help' }, m.ownerChecking));
    else if (o.status === 'error') kids.push(h('p', { class: 'cb-warn' }, m.ownerCheckFailed(o.error ? o.error(m) : ''), ' ', inbox),
      h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'owner-recheck', onclick: () => { void loadOwner(); } }, m.ownerRecheck));
    else if (o.authenticated) kids.push(h('div', { class: 'cb-owner' },
      h('p', { class: 'cb-ok' }, m.ownerSignedIn, S.adminToken.trim() ? ` ${m.ownerTokenWins}` : ''),
      h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'owner-signout', disabled: o.busy, onclick: () => { void ownerSignOut(); } }, o.busy ? m.signingOut : m.signOut)));
    else kids.push(h('p', { class: 'cb-help' }, o.hasCredentials ? m.ownerSignedOut : m.ownerNoCredentials, ' ', inbox));
    if (o.message) kids.push(h('p', { class: 'cb-warn' }, o.message(m)));
    return kids;
  }

  function renderControls(): void {
    const m = M;
    const demo = S.mode === 'demo';
    modeDemo.setAttribute('aria-pressed', String(demo)); modeLive.setAttribute('aria-pressed', String(!demo));
    modeDemo.disabled = modeLive.disabled = active();
    const runMode = S.run?.mode ?? S.mode;
    modeBadge.textContent = runMode === 'demo' ? m.modeDemo : m.modeLive;
    modeBadge.className = `cb-badge ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    const token = S.adminToken.trim();
    const operator = isOperatorToken(S.adminToken);
    const owner = ownerAuthed();
    const v = visitor();
    profileName.textContent = token ? m.profileOperator : owner ? m.profileOwner : v ? v.name || m.profileVisitor : m.profileOperator;
    profileState.textContent = operator ? m.stateOperatorToken : token ? m.stateAdminToken
      : owner ? m.stateOwner : v ? m.stateVisitor(hhmm(v.expiresAt)) : m.stateNone;
    tokenLabel.textContent = operator ? m.tokenLabelOperator : m.tokenLabelAdmin;
    banner.textContent = runMode === 'demo' ? m.bannerDemo : m.bannerLive;
    banner.className = `cb-banner ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    modeLine.textContent = demo ? m.nextDemo : viaOwner() ? m.nextLiveOwner : viaVisitor() ? m.nextLiveVisitor : m.nextLive;
    demoBox.hidden = !demo; liveBox.hidden = demo;
    const cfg = S.boot.data?.configuration;
    historyNotice.hidden = demo || cfg?.historyRetentionDays !== 30;
    const liveKids: Kid[] = [];
    if (S.boot.status === 'loading') liveKids.push(h('p', { class: 'cb-help' }, m.checkingServer));
    else if (S.boot.status === 'error') liveKids.push(h('p', { class: 'cb-warn' }, m.catalogueFailed(S.boot.error ? S.boot.error(m) : '')),
      h('button', { type: 'button', class: 'cb-ghost', onclick: () => loadBootstrap() }, m.checkAgain));
    else if (cfg && !cfg.liveReady) liveKids.push(h('div', { class: 'cb-warn' }, h('strong', null, m.liveNotReady),
      h('p', null, cfg.missing.length ? m.missingSettings : m.notReadyGeneric),
      cfg.missing.length ? h('ul', null, ...cfg.missing.map(x => h('li', null, h('code', null, x)))) : null));
    else if (cfg) liveKids.push(h('p', { class: 'cb-ok' }, m.serverReady(cfg.maxExperts)));
    liveKids.push(...ownerKids());
    // 소유자로 로그인했으면 방문자 한도·접근 문제는 실행과 관계없으므로 보이지 않는다
    if (v && !owner) liveKids.push(h('p', { class: 'cb-help' }, m.visitorSession(v.name, hhmm(v.expiresAt), visitorLeft(), v.maxProjects, v.maxExperts, !!token)));
    const problem = owner ? null : accessProblem();
    if (problem) liveKids.push(h('p', { class: 'cb-warn' }, problem(m), ' ', h('a', { href: href(REQUEST_PATH) }, m.requestAccess)));
    if (!owner && recheckable()) liveKids.push(checkAgain());
    liveStatus.replaceChildren(...liveKids.filter((k): k is Node => !!k));
    clearTokenBtn.hidden = !S.adminToken;

    const busy = active();
    staExampleBtn.hidden = !catalogue().some(e => e.id === 'probably-primetime-sta');
    staExampleBtn.disabled = busy;
    for (const n of [titleIn, objectiveIn, contextIn, failIn, tokenIn, filterIn]) n.disabled = busy;
    const liveReady = S.boot.status === 'ready' && !!cfg?.liveReady && liveCredential();
    const none = S.selected.size === 0;
    // 시작 버튼은 편집 영역 끝의 하나뿐이다. 전문가를 고르지 않았으면 이유를 보이고 잠근다
    startBtn.disabled = busy || (!demo && !liveReady) || none;
    startLabel.textContent = S.run?.phase === 'starting' ? m.starting : busy ? m.running
      : S.run ? (demo ? m.runAgainDemo : m.runAgain) : (demo ? m.runExpertsDemo : m.runExperts);
    cancelBtn.hidden = !busy;
    cancelBtn.disabled = S.run?.phase === 'cancelling' || S.run?.phase === 'starting';
    cancelLabel.textContent = S.run?.phase === 'cancelling' ? m.stopping : m.stop;

    // 편집 영역: 실행 전·검증 오류·만들기 실패 때는 열려 있다. 접기·펴기 버튼은 실행이 있을 때만
    const p = S.run?.project;
    if (!S.run || S.formErrors.length || (S.run.phase === 'error' && !p)) S.setupOpen = true;
    setup.hidden = !S.setupOpen;
    setupBtn.hidden = !S.run;
    setupBtn.setAttribute('aria-expanded', String(S.setupOpen));
    setupLabel.textContent = S.setupOpen ? m.hideSetup : m.editProject;
    detailsHint.textContent = clip(titleIn.value.trim() || m.nameRequired, 60);

    const formKids = S.formErrors.map(e => h('p', null, e.text(m)));
    if (S.run?.error && !p) formKids.push(h('p', null, S.run.error(m)));
    fill(formMsg, ...formKids);
    const runKids: Kid[] = [];
    if (S.run?.error && p) runKids.push(h('p', null, S.run.error(m)));
    if (S.run && p && S.run.phase === 'error' && S.run.pollErrors >= 4) runKids.push(h('button', { type: 'button', class: 'cb-ghost', onclick: () => {
      const r = S.run;
      if (!r?.project || r.phase !== 'error') return;
      r.phase = 'running'; r.error = null; r.pollErrors = 0; renderAll(); void poll(S.gen);
    } }, m.checkStatusAgain));
    fill(runMsg, ...runKids);

    // 시작 버튼 옆 안내: 이유가 있을 때만 (전문가 없음, 방문자 사용량, 실제 실행을 막는 이유)
    const notes: Kid[] = [];
    if (!busy) {
      if (none) notes.push(h('p', { class: 'cb-need' }, m.needExpert));
      if (!demo && v && !token && !owner) notes.push(h('p', { class: 'cb-help' }, m.visitorLeftLabel, h('strong', null, m.visitorLeft(visitorLeft(), v.maxProjects)),
        m.visitorEach(v.maxExperts, hhmm(v.expiresAt))));
      if (!demo && S.boot.status !== 'loading' && !liveReady) notes.push(h('p', { class: 'cb-warn' },
        problem ? problem(m) : m.liveBlocked, ' ',
        h('button', { type: 'button', class: 'cb-link', onclick: () => setView('settings') }, m.openSettings)), !owner && recheckable() ? checkAgain() : null);
    }
    fill(startNote, ...notes);

    selCount.textContent = m.selCount(S.selected.size, limits().max);
    // 접힌 카드는 실행한 프로젝트의 브리프를 보인다 (편집 중에는 같은 제목·목표를 되풀이하지 않는다)
    projTitle.textContent = S.setupOpen ? m.projectBrief : clip(p?.brief.title || titleIn.value.trim() || m.untitled, 120);
    projStatus.hidden = !S.run;
    const pst = p ? p.status : S.run?.phase === 'starting' ? 'running' : S.run?.phase === 'error' ? 'failed' : 'draft';
    projStatus.textContent = S.run?.phase === 'starting' ? m.startingPill : m.projectStatus[pst];
    projStatus.className = `cb-pill p-${pst}`;
    projBody.hidden = S.setupOpen || !S.run;
    projObjective.textContent = p?.brief.objective || objectiveIn.value.trim();
    projActions.hidden = !p;
    dlJson.disabled = dlMd.disabled = !p;
    const meta: Kid[] = [];
    if (p) {
      const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
      const valid = p.experts.filter(e => e.status === 'completed' && e.opinion).length;
      const [f1, f2] = m.finished(done, p.experts.length), [v1, v2] = m.validOpinions(valid);
      meta.push(h('span', null, h('strong', null, f1), f2), h('span', null, h('strong', null, v1), v2));
    }
    if (v && !token && !owner) meta.push(h('span', null, m.visitorLeftLabel, h('strong', null, m.visitorLeft(visitorLeft(), v.maxProjects)), m.visitorEnds(hhmm(v.expiresAt))));
    if (p && S.run?.mode === 'live') meta.push(h('span', null, m.projectLabel, h('code', null, clip(p.id, 24))));
    fill(projMeta, ...meta);
  }

  /** 짧은 설명: 알려진 역할은 화면 언어의 설명, 아니면 카탈로그 요약, 없으면 기계용 분야 이름을 사람이 읽는 말로 */
  function roleBlurb(e: ExpertDefinition): string { return (lang === 'ko' && ROLE_KO[e.id]) || e.summary.trim() || domainLabel(e.domain); }

  function renderCatalogue(): void {
    const m = M;
    const list = catalogue();
    const core = list.slice(0, CORE_ROLES), rest = list.slice(CORE_ROLES);
    const q = filterIn.value.trim().toLowerCase();
    const busy = active();
    const full = S.selected.size >= limits().max;
    // prefix: 기본 역할(x) · 전체 목록(xa). 같은 역할이 두 번 보여도 선택 상태는 S.selected 하나다
    const opt = (e: ExpertDefinition, prefix: string) => {
      const on = S.selected.has(e.id);
      const id = `cb-${prefix}-${e.id}`;
      const cb = h('input', { type: 'checkbox', id, 'data-fk': `${prefix}:${e.id}`, checked: on, disabled: busy || (!on && full) });
      cb.addEventListener('change', () => {
        if (cb.checked) S.selected.add(e.id); else S.selected.delete(e.id);
        S.formErrors = []; keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
      });
      return h('label', { class: `cb-expert-opt${on ? ' is-on' : ''}`, for: id }, cb,
        h('span', { class: 'cb-opt-text' }, h('span', { class: 'cb-opt-name' }, e.name), h('span', { class: 'cb-opt-desc' }, roleBlurb(e))));
    };
    coreBox.replaceChildren(...core.map(e => opt(e, 'x')));
    if (!list.length) coreBox.append(h('p', { class: 'cb-empty' }, S.mode === 'live' ? m.catalogueEmptyLive : m.noRoles));
    moreDetails.hidden = rest.length === 0;
    moreLabel.textContent = m.allExperts(list.length);
    // 검색은 원문 요약과 화면 언어의 설명을 모두 본다
    const shown = q ? list.filter(e => `${e.name} ${e.domain} ${e.summary} ${roleBlurb(e)}`.toLowerCase().includes(q)) : rest;
    moreBox.replaceChildren(...shown.slice(0, 120).map(e => opt(e, 'xa')));
    if (!shown.length) moreBox.append(h('p', { class: 'cb-empty' }, m.noMatch));
    // 접힌 전체 목록에서 고른 역할도 늘 보이게 요약한다
    const coreIds = new Set(core.map(e => e.id));
    const hiddenSel = [...S.selected].filter(id => !coreIds.has(id)).map(id => findDef(id)?.name ?? id);
    alsoSel.textContent = hiddenSel.length ? m.alsoSelected(hiddenSel.join(', ')) : '';
    alsoSel.hidden = !hiddenSel.length;
    catalogueNote.textContent = catalogueIsBuiltin() ? m.builtinRoles : full ? m.maxReached(limits().max) : m.recommended;
  }

  function statusDot(s: ExpertStatus): HTMLElement { return h('span', { class: `cb-dot s-${s}`, 'aria-hidden': 'true' }); }

  function streamRows(p: ConsoleProject): Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string }> {
    const rows: Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string; seq: number }> = [];
    let seq = 0;
    for (const e of p.experts) for (const a of e.activity) rows.push({ key: `${e.id}\n${a.id}`, at: a.at, name: e.name, kind: a.kind, message: a.message, seq: seq++ });
    return rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function renderWork(): void {
    const m = M;
    const p = S.run?.project;
    restoreBtn.disabled = S.hiddenRows.size === 0;
    // 프로젝트가 생기기 전에는 빈 작업공간·기록을 보이지 않는다
    wsPanel.hidden = !S.run || !p;
    if (!S.run || !p) {
      if (S.full) paintFull(false);
      roster.replaceChildren(); inspector.replaceChildren(); wsErrors.replaceChildren(); streamLog.replaceChildren();
      return;
    }
    if (!S.focusExpert || !p.experts.some(e => e.id === S.focusExpert)) S.focusExpert = p.experts[0]?.id ?? '';
    // 실패는 접힌 기록 안에 숨기지 않고 전문가 목록 위에 보인다 (서버·모델 오류 원문은 그대로)
    const failed = p.experts.filter(e => e.status === 'failed' || e.invalidOpinion);
    fill(wsErrors, ...failed.map(e => h('p', { class: 'cb-warn' }, h('strong', null, e.name), e.error ? m.failedWith(e.error) : e.invalidOpinion ? m.invalidExcluded : m.failedPlain)));
    roster.replaceChildren(...p.experts.map(e => h('button', { type: 'button', class: `cb-card s-${e.status}${e.id === S.focusExpert ? ' is-focus' : ''}`, 'data-fk': `card:${e.id}`,
      'aria-pressed': String(e.id === S.focusExpert), onclick: () => { if (S.focusExpert !== e.id) S.artifactPicked = false; S.focusExpert = e.id; keepFocus(renderWork); } },
      h('span', { class: 'cb-card-head' }, statusDot(e.status), h('span', { class: 'cb-card-name' }, e.name)),
      h('span', { class: 'cb-card-foot' }, h('span', { class: 'cb-card-status' }, m.status[e.status]),
        e.opinion ? h('span', { class: `cb-chip d-${e.opinion.direction}` }, `${m.direction[e.opinion.direction]} ${e.opinion.confidence}%`) : null,
        e.invalidOpinion ? h('span', { class: 'cb-chip d-invalid' }, m.invalidChip) : null))));
    wsSub.textContent = m.workspaceSub;

    // 실행 기록: 모든 전문가가 보고한 활동을 시간순으로. 숨긴 줄은 화면에서만 뺀다
    const rows = streamRows(p);
    const visible = rows.filter(r => !S.hiddenRows.has(r.key));
    const shown = visible.slice(-STREAM_ROWS);
    const working = p.experts.filter(e => !TERMINAL_EXPERT.includes(e.status) && e.status !== 'queued').length;
    const phase = S.run.phase === 'cancelling' ? m.phaseStopping : m.projectStatus[p.status].toLowerCase();
    streamState.textContent = m.streamState(S.run.mode === 'demo', phase, working, rows.length);
    const errs = rows.filter(r => r.kind === 'error').length;
    streamErr.textContent = errs ? m.errorsCount(errs) : '';
    streamErr.hidden = !errs;
    const atBottom = streamLog.scrollHeight - streamLog.scrollTop - streamLog.clientHeight < 48;
    if (!shown.length) {
      streamLog.replaceChildren(h('li', { class: 'cb-stream-empty' }, S.hiddenRows.size ? m.viewCleared : m.noActivityYet));
    } else {
      streamLog.replaceChildren(...shown.map(r => h('li', { class: `cb-row k-${r.kind}` },
        h('time', { class: 'cb-row-at' }, clock(r.at)), h('span', { class: 'cb-row-who' }, r.name),
        h('span', { class: 'cb-row-kind' }, m.kind[r.kind]), h('span', { class: 'cb-row-msg' }, r.message))));
    }
    if (atBottom) streamLog.scrollTop = streamLog.scrollHeight;
    const hiddenCount = rows.length - visible.length;
    streamNote.textContent = hiddenCount ? m.hiddenRows(hiddenCount) : visible.length > shown.length ? m.latestRows(shown.length, visible.length) : '';
    clearBtn.disabled = visible.length === 0;
    renderDetail(p);
  }

  function renderDetail(p: ConsoleProject): void {
    const m = M;
    const e = p.experts.find(x => x.id === S.focusExpert);
    if (!e) { inspector.replaceChildren(); return; }
    const def = findDef(e.expertId);
    const tabs: Array<[typeof S.tab, string]> = [['artifacts', m.tabFiles(e.artifacts.length)], ['activity', m.tabActivity], ['workorder', m.tabWorkorder], ['persona', m.tabPersona]];
    const tabBtns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: `cb-tab-${k}`, 'data-fk': `tab:${k}`, 'aria-selected': String(S.tab === k),
      'aria-controls': 'cb-tabpanel', tabindex: S.tab === k ? '0' : '-1', class: 'cb-tab', onclick: () => { S.tab = k; keepFocus(renderWork); } }, label));
    const tablist = h('div', { class: 'cb-tabs', role: 'tablist', 'aria-label': m.tabsAria(e.name) }, ...tabBtns);
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
        h('li', { class: `k-${a.kind}` }, h('span', { class: 'cb-act-kind' }, m.kind[a.kind]),
          h('span', { class: 'cb-act-msg' }, a.message), h('time', { class: 'cb-act-at' }, clock(a.at)))))
        : h('p', { class: 'cb-empty' }, m.noActivity);
    } else if (S.tab === 'artifacts') {
      body = artifactView(p, e);
    } else if (S.tab === 'workorder') {
      const wo = e.artifacts.find(a => a.path === 'WORKORDER.md' && typeof a.content === 'string');
      body = h('div', null, !wo ? h('p', { class: 'cb-help' }, m.workorderPreview) : null,
        h('pre', { class: 'cb-file' }, wo?.content ?? (def ? workorderText(def, p.brief) : m.roleMissing)));
    } else {
      body = def ? h('div', null, h('pre', { class: 'cb-file' }, personaText(def))) : h('p', { class: 'cb-empty' }, m.roleNotInCatalogue);
    }
    const op = e.opinion;
    const where = e.sandboxId ? (S.run?.mode === 'demo' ? m.whereDemo(e.sandboxId) : m.whereLive(e.sandboxId)) : m.wherePending;
    const blurb = def ? (lang === 'ko' && ROLE_KO[def.id]) || def.summary : '';
    fill(inspector,
      h('div', { class: 'cb-detail-head' }, statusDot(e.status), h('h3', null, e.name), h('span', { class: 'cb-help' }, `${m.status[e.status]} · ${where}`)),
      blurb ? h('p', { class: 'cb-help cb-detail-sum' }, blurb) : null,
      e.error ? h('p', { class: 'cb-warn' }, m.errorLine(e.error)) : null,
      op ? h('div', { class: `cb-opinion d-${op.direction}` }, h('span', { class: `cb-chip d-${op.direction}` }, m.selfAssessed(m.direction[op.direction], op.confidence)),
        h('p', null, op.summary)) : null,
      tablist, h('div', { id: 'cb-tabpanel', role: 'tabpanel', 'aria-labelledby': `cb-tab-${S.tab}`, class: 'cb-tabpanel' }, body));
  }

  function artifactView(p: ConsoleProject, e: ConsoleExpert): Node {
    const m = M;
    if (!e.artifacts.length) return h('p', { class: 'cb-empty' }, m.noFiles);
    if (!S.artifactPicked || !e.artifacts.some(a => a.path === S.artifactPath)) S.artifactPath = (e.artifacts.find(a => a.path === 'out/report.md') ?? e.artifacts.find(a => a.path.startsWith('out/')) ?? e.artifacts[0]).path;
    const a = e.artifacts.find(x => x.path === S.artifactPath)!;
    const list = h('ul', { class: 'cb-files', 'aria-label': m.filesAria }, ...e.artifacts.map(x => h('li', null, h('button', { type: 'button', class: `cb-filebtn${x.path === a.path ? ' is-on' : ''}`,
      'data-fk': `file:${x.path}`, 'aria-pressed': String(x.path === a.path), onclick: () => { S.artifactPath = x.path; S.artifactPicked = true; keepFocus(renderWork); } },
      icon('file'), h('span', { class: 'cb-file-text' }, h('span', { class: 'cb-file-path' }, x.path), h('span', { class: 'cb-help' }, x.label))))));
    let view: Node;
    if (typeof a.content === 'string') view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': m.fileContentsAria(a.path) }, a.content || m.emptyFile);
    else if (S.run?.mode === 'live' && S.run.accessToken) {
      const key = `${p.id}\n${e.expertId}\n${a.path}`;
      const c = S.artifactCache.get(key);
      if (!c) { fetchArtifact(p.id, e.expertId, a.path, key); view = h('p', { class: 'cb-help' }, m.loadingFile); }
      else if (c.state === 'loading') view = h('p', { class: 'cb-help' }, m.loadingFile);
      else if (c.state === 'error') view = h('div', null, h('p', { class: 'cb-warn' }, c.text(m)),
        h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'file-reload', onclick: () => { S.artifactCache.delete(key); keepFocus(renderWork); } }, m.loadAgain));
      else view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': m.fileContentsAria(a.path) }, c.text || m.emptyFile);
    } else view = h('p', { class: 'cb-empty' }, m.noContents);
    return h('div', { class: 'cb-artifacts' }, list, view);
  }

  function renderProgress(): void {
    const m = M;
    const run = S.run, p = run?.project;
    aside.hidden = !run || !p;
    if (!run || !p) { progressBody.replaceChildren(); stepsBody.replaceChildren(); tipBody.replaceChildren(); return; }
    // 진행 단계는 관찰된 상태에서만 만든다 (클릭으로 완료되는 단계 없음)
    type StepState = 'done' | 'active' | 'pending' | 'blocked';
    const step = (label: string, state: StepState, n = '') => h('li', { class: `cb-step is-${state}` },
      h('span', { class: 'cb-step-mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check') : null),
      h('span', null, label, h('span', { class: 'cb-sr' }, ` — ${m.stepState[state]}`)), h('span', { class: 'cb-step-n' }, n));
    const n = p.experts.length;
    const started = p.experts.filter(e => e.status !== 'queued').length;
    const working = p.experts.filter(e => e.status === 'running' || e.status === 'provisioning').length;
    const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
    const a = aggregate(p, m);
    const terminal = TERMINAL_PROJECT.includes(p.status);
    const stopped = p.status === 'cancelled' || p.status === 'failed';
    const bar = h('div', { class: 'cb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': n, 'aria-valuenow': done, 'aria-label': m.progressAria },
      ...p.experts.map(e => h('span', { class: `cb-bar-seg s-${e.status}`, title: `${e.name}: ${m.status[e.status]}` })));
    fill(progressBody,
      h('p', { class: 'cb-progress-num' }, h('strong', null, m.progressNum(done, n)), m.progressTail(m.projectStatus[p.status].toLowerCase(), working)),
      bar);
    fill(stepsBody,
      step(m.stepBrief, 'done'),
      step(m.stepWorkspaces, started === n ? 'done' : stopped ? 'blocked' : 'active', `${started}/${n}`),
      step(m.stepWorking, done === n ? 'done' : stopped ? 'blocked' : working ? 'active' : 'pending', working ? m.nActive(working) : ''),
      step(m.stepOpinions, a.valid + a.failed + a.cancelled + a.invalid === n ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : stopped ? 'blocked' : 'pending', m.nValid(a.valid)),
      step(m.stepSynth, terminal ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : 'pending', a.failed ? m.nFailed(a.failed) : ''));
    // 지금 할 일
    const tips: Kid[] = [];
    if (active()) {
      tips.push(h('p', null, run.mode === 'demo' ? m.tipDemoRunning : m.tipLiveRunning));
      if (run.error) tips.push(h('p', null, run.error(m)));
    } else {
      tips.push(h('p', null, a.valid ? m.tipResults : m.tipNoValid));
      if (a.failed || a.invalid) tips.push(h('p', null, m.tipExcluded(a.failed + a.invalid)));
      if (run.viaVisitor && !S.adminToken.trim() && S.boot.status === 'ready') {
        const problem = accessProblem();
        tips.push(h('p', null, visitorCanRun() ? m.tipVisitorAgain : problem ? problem(m) : m.tipVisitorNo));
        if (recheckable()) tips.push(checkAgain());
      }
    }
    fill(tipBody, ...tips);
  }

  function renderSynth(): void {
    const m = M;
    const p = S.run?.project;
    if (!p) { synthPanel.hidden = true; synth.replaceChildren(); confBody.replaceChildren(); return; }
    const a = aggregate(p, m);
    const terminal = TERMINAL_PROJECT.includes(p.status);
    // 빈 종합 카드는 보이지 않는다. 유효한 의견이 생기면 종합을 맨 위로 올린다 (노드를 옮길 뿐 다시 만들지 않는다)
    synthPanel.hidden = !a.valid && !terminal;
    const order = a.valid ? [synthPanel, progressPanel, tipPanel] : [progressPanel, tipPanel, synthPanel];
    if (order.some((n, i) => aside.children[i] !== n)) aside.append(...order);
    synthTag.hidden = S.run?.mode !== 'demo';
    const total = a.valid || 1;
    const segs = DIRECTIONS.filter(d => a.counts[d] > 0).map(d => {
      const s = h('span', { class: `cb-dist-seg d-${d}` }, `${Math.round(a.counts[d] / total * 100)}%`);
      s.style.flexGrow = String(a.counts[d]);
      return s;
    });
    fill(synth,
      h('div', { class: 'cb-recommend' }, h('h3', null, m.suggestedDecision), h('p', { class: 'cb-headline' }, a.headline)),
      h('div', { class: 'cb-tally' }, h('span', { class: 'cb-big' }, String(a.valid)), h('span', null, m.validOf(a.selected))),
      h('p', { class: 'cb-counts' }, m.countsLine(a)),
      a.valid ? h('div', { class: 'cb-dist', role: 'img', 'aria-label': DIRECTIONS.map(d => `${m.direction[d]} ${a.counts[d]}`).join(', ') }, ...segs) : null,
      a.valid ? h('ul', { class: 'cb-legend' }, ...DIRECTIONS.map(d => h('li', null, h('span', { class: `cb-sw d-${d}`, 'aria-hidden': 'true' }), `${m.direction[d]} `, h('strong', null, String(a.counts[d]))))) : null,
      a.actions.length ? h('div', { class: 'cb-next' }, h('h3', null, m.nextActions), h('ol', { class: 'cb-actions-list' }, ...a.actions.map(x => h('li', null, h('span', null, x.text),
        h('span', { class: 'cb-help' }, `${x.names.join(', ')}${x.count > 1 ? m.sharedBy(x.count) : ''}`))))) : null,
      a.disagreement ? h('div', { class: 'cb-dispute' }, h('h3', null, m.dissent),
        ...a.supportVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-support' }, h('span', { class: 'cb-chip d-support' }, `${m.direction.support} · ${v.name} ${v.confidence}%`), h('p', null, v.summary))),
        ...a.concernVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-concern' }, h('span', { class: 'cb-chip d-concern' }, `${m.direction.concern} · ${v.name} ${v.confidence}%`), h('p', null, v.summary))))
        : a.valid > 1 ? h('p', { class: 'cb-help' }, m.noDissent) : null,
      h('p', { class: 'cb-help cb-conf-line' }, a.meanConfidence === null ? m.noValidYet : m.meanConf(a.meanConfidence)));
    const maxB = Math.max(1, ...a.buckets);
    fill(confBody,
      h('p', { class: 'cb-help' }, m.confExplain),
      h('div', { class: 'cb-hist', role: 'img', 'aria-label': m.confAria(a.buckets.map((n, i) => `${i * 20}–${i * 20 + 20}%: ${n}`).join(', ')) },
        ...a.buckets.map((n, i) => { const col = h('span', { class: 'cb-hist-col' }, h('span', { class: 'cb-hist-n' }, n ? String(n) : ''));
          const bar = h('span', { class: 'cb-hist-bar' }); bar.style.height = `${Math.round(n / maxB * 100)}%`; col.append(bar, h('span', { class: 'cb-hist-x' }, i === 4 ? '80–100' : `${i * 20}–${i * 20 + 19}`)); return col; })));
    const phrase = m.announce(m.projectStatus[p.status], a.valid, a.failed);
    if (terminal && phrase !== lastAnnounce) { lastAnnounce = phrase; live.textContent = phrase; }
  }

  // ── 서버 사용 기록: 기존 콘솔 안의 추가 화면. 원문은 텍스트 노드로만 그린다.
  function paintHistory(): void { H.dirty = true; keepFocus(renderHistory); }
  const historyDate = (at: number) => new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  async function historyRequest(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (S.adminToken.trim()) headers['x-admin-token'] = S.adminToken.trim();
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const r = await fetch('/api/cloudbite/history' + path, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json() };
    } catch { return { status: 0, data: null }; }
  }
  function historyDenied(status: number): void {
    H.error = status; H.unauthorized = status === 401 || status === 403;
    if (H.unauthorized) { H.list = null; H.detail = null; H.report = null; H.owner = false; H.drafts.clear(); }
  }
  async function loadHistory(more = false): Promise<void> {
    if (H.busy) return;
    const gen = ++H.gen, tab = H.tab;
    H.busy = true; H.error = 0; H.unauthorized = false; paintHistory();
    const q = '?scope=' + (tab === 'all' ? 'all' : 'mine') + (more && H.list?.next ? '&before=' + encodeURIComponent(H.list.next) : '');
    const result = await historyRequest(q);
    if (gen !== H.gen) return;
    const list = result.data as HistoryList | null;
    if (result.status !== 200 || !list || !Array.isArray(list.rows) || !list.rows.every(x => /^cb[0-9a-f]{32}$/.test(x.id))) {
      historyDenied(result.status); H.busy = false; paintHistory(); return;
    }
    H.owner = list.owner === true;
    H.list = more && H.list ? { ...list, rows: [...H.list.rows, ...list.rows] } : list;
    if (tab === 'report') {
      const r = await historyRequest('/report');
      if (gen !== H.gen) return;
      const report = r.data as HistoryReport | null;
      if (r.status === 200 && report && Array.isArray(report.insights) && Array.isArray(report.roles)) H.report = report;
      else historyDenied(r.status);
    }
    H.busy = false; paintHistory();
  }
  async function openHistory(id: string): Promise<void> {
    const gen = ++H.detailGen;
    H.detailBusy = true; H.detail = null; H.error = 0; H.message = ''; H.deleteId = ''; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id));
    if (gen !== H.detailGen) return;
    const detail = r.data as HistoryDetail | null;
    if (r.status === 200 && detail && normalizeProject(detail.project) && Array.isArray(detail.feedback)) H.detail = detail;
    else historyDenied(r.status);
    H.detailBusy = false; paintHistory();
  }
  async function saveHistoryFeedback(id: string, draft: Omit<HistoryFeedback, 'at'>): Promise<void> {
    if (H.mutation) return;
    H.mutation = true; H.error = 0; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id) + '/feedback', 'POST', draft);
    H.mutation = false;
    if (r.status === 200) { if (H.detail?.project.id === id) { H.detail.feedback = [...H.detail.feedback.filter(f => f.expertId !== draft.expertId), { ...draft, at: Date.now() }]; H.message = 'saved'; } }
    else historyDenied(r.status);
    paintHistory();
  }
  async function deleteHistory(id: string): Promise<void> {
    if (H.mutation) return;
    H.mutation = true; H.error = 0; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id), 'DELETE');
    H.mutation = false;
    if (r.status === 200) {
      H.detailGen++; H.detail = null; H.deleteId = ''; H.message = '';
      for (const key of H.drafts.keys()) if (key.startsWith(id + ':')) H.drafts.delete(key);
      await loadHistory();
    } else { historyDenied(r.status); paintHistory(); }
  }
  function historyTable(heads: string[], rows: string[][]): HTMLElement {
    return h('div', { class: 'cb-history-table' }, h('table', null,
      h('thead', null, h('tr', null, ...heads.map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, ...rows.map(row => h('tr', null, ...row.map(x => h('td', null, x)))))));
  }
  function historyDisclosure(key: string, title: string, ...content: Kid[]): HTMLDetailsElement {
    const box = h('details', { class: 'cb-disclosure cb-history-disclosure', open: H.opened.has(key) }, h('summary', null, icon('chevron'), title), ...content);
    box.addEventListener('toggle', () => { if (box.open) H.opened.add(key); else H.opened.delete(key); });
    return box;
  }
  function renderHistory(): void {
    if (S.view !== 'history' || (!H.dirty && H.renderedLang === lang)) return;
    H.dirty = false; H.renderedLang = lang;
    const t = HT();
    if (H.list && !H.owner && !S.adminToken.trim() && !ownerAuthed()) { profileName.textContent = M.profileVisitor; profileState.textContent = lang === 'ko' ? '이 브라우저의 사용 기록' : 'History for this browser'; }
    const tabs = h('div', { class: 'cb-history-toolbar', role: 'group', 'aria-label': t.title });
    for (const tab of (H.owner ? ['mine', 'all', 'report'] : ['mine']) as Array<typeof H.tab>) {
      tabs.append(h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': String(H.tab === tab), 'data-fk': 'hist-tab:' + tab, onclick: () => {
        H.gen++; H.detailGen++; H.busy = false; H.detailBusy = false; H.tab = tab; H.list = null; H.detail = null; H.error = 0; H.message = ''; void loadHistory();
      } }, t[tab]));
    }
    tabs.append(h('button', { type: 'button', class: 'cb-secondary', disabled: H.busy, 'data-fk': 'hist-refresh', onclick: () => { void loadHistory(); } }, t.refresh));
    const notices: Kid[] = [tabs];
    if (H.error || H.unauthorized) notices.push(h('p', { class: 'cb-warn', role: 'alert' }, H.unauthorized ? t.auth : t.error(H.error), ' ', pageLink(OWNER_INBOX_PATH, m => m.ownerInbox)));
    if (H.busy) notices.push(h('p', { role: 'status', class: 'cb-help' }, t.loading));
    if (H.tab === 'report' && H.report && H.owner) {
      const r = H.report;
      fill(historyBody, ...notices, h('section', { class: 'cb-panel cb-history-report' }, h('h3', null, t.report), h('p', null, t.reportIntro),
        h('p', { class: 'cb-help' }, t.sample(r.analyzed, r.live, r.demoExcluded, r.pending)), h('p', { class: 'cb-help' }, t.qualityNote),
        r.experts > 0 && r.experts < 20 ? h('p', { class: 'cb-help' }, t.small) : null,
        r.insights.length ? h('ul', { class: 'cb-history-insights' }, ...r.insights.map(x => h('li', null, t.insights[x.kind](x.count, x.total)))) : h('p', null, t.noSignals),
        r.experts ? h('h3', null, t.counts) : null, r.experts ? historyTable([t.completed, t.failed, t.referenced, t.feedbackHelpful, t.feedbackUnhelpful], [[r.completed, r.failed, r.referenced, r.feedback.helpful, r.feedback.unhelpful].map(String)]) : null,
        r.experts ? historyTable([t.role, t.basis, t.completed, t.failed, t.referenced, t.feedbackUnhelpful, t.revision], r.roles.map(x => [findDef(x.id)?.name ?? x.id, x.basis === 'curated-knowledge' ? t.knowledge : x.basis === 'metadata-derived' ? t.metadata : t.unknown, ...[x.completed, x.failed, x.referenced, x.unhelpful, x.revisions.length].map(String)])) : null,
        r.experts ? historyDisclosure('diagnostics', lang === 'ko' ? '진단 세부 정보' : 'Diagnostic details',
        h('h3', null, t.confidence), historyTable(['0–19', '20–39', '40–59', '60–79', '80–100'], [r.confidenceBins.map(String)]),
        h('h3', null, t.errors), historyTable([t.errors, t.failed], Object.entries(r.errors).map(([k, n]) => [t.errorKinds[k] ?? k, String(n)])),
        h('h3', null, t.feedbackIssues), historyTable([t.issue, t.feedbackUnhelpful], Object.entries(r.feedback.issues).map(([k, n]) => [t.issues[k as HistoryIssue] ?? k, String(n)])),
        h('h3', null, t.models), historyTable([t.model, t.projects, t.failed], r.models.map(x => [x.model, String(x.projects), String(x.failed)]))) : null));
      return;
    }
    const list = h('section', { class: 'cb-panel cb-history-list', 'aria-label': t.title });
    if (!H.list?.rows.length && !H.busy && !H.unauthorized) list.append(h('p', null, t.empty));
    for (const p of H.list?.rows ?? []) list.append(h('button', { type: 'button', class: 'cb-history-record', 'aria-pressed': String(H.detail?.project.id === p.id), 'data-fk': 'hist-record:' + p.id, onclick: () => { void openHistory(p.id); } },
      h('strong', null, p.title), h('span', null, `${M.projectStatus[p.status]} · ${p.mode === 'live' ? M.modeLive : M.modeDemo}`), h('small', null, `${historyDate(p.createdAt)} · ${M.experts(p.expertCount)}${p.browser ? ' · ' + p.browser : ''}`)));
    if (H.list?.next) list.append(h('button', { type: 'button', class: 'cb-secondary', disabled: H.busy, onclick: () => { void loadHistory(true); } }, t.more));
    const detail = h('section', { class: 'cb-panel cb-history-detail', 'aria-label': t.detail });
    if (H.detailBusy) detail.append(h('p', { role: 'status' }, t.loading));
    else if (!H.detail) detail.append(h('p', { class: 'cb-help' }, t.select));
    else {
      const d = H.detail, p = d.project;
      detail.append(h('h3', null, p.brief.title), h('p', { class: 'cb-help' }, `${M.projectStatus[p.status]} · ${t.model}: ${d.model} · ${t.expires}: ${historyDate(d.expiresAt)}`),
        h('h4', null, t.objective), h('p', { class: 'cb-history-copy' }, p.brief.objective));
      if (p.brief.context) detail.append(historyDisclosure(p.id + ':context', t.context, h('p', { class: 'cb-history-copy' }, p.brief.context)));
      if (H.message === 'saved') detail.append(h('p', { role: 'status', class: 'cb-ok' }, t.saved));
      for (const e of p.experts) {
        const article = h('article', { class: 'cb-history-answer' }, h('h4', null, e.name), h('p', { class: 'cb-help' }, M.status[e.status]));
        if (e.opinion) {
          article.append(h('p', { class: 'cb-help' }, M.mdOpinion(M.direction[e.opinion.direction], e.opinion.confidence)), h('p', { class: 'cb-history-copy' }, e.opinion.summary));
          if (d.reports?.[e.expertId]) article.append(historyDisclosure(p.id + ':' + e.id + ':report', lang === 'ko' ? '전체 보고서' : 'Full report', h('pre', { class: 'cb-history-copy' }, d.reports[e.expertId])));
          for (const [part, heading, content] of [['evidence', t.sources, e.opinion.evidence], ['assumptions', t.assumptions, e.opinion.assumptions], ['actions', t.actions, e.opinion.nextActions]] as const)
            article.append(historyDisclosure(p.id + ':' + e.id + ':' + part, heading, h('ul', { class: 'cb-history-copy' }, ...content.map(x => h('li', null, x)))));
          const prior = d.feedback.find(f => f.expertId === e.expertId);
          if (d.canFeedback) {
            const key = p.id + ':' + e.expertId;
            if (!H.drafts.has(key)) H.drafts.set(key, prior ? { expertId: prior.expertId, rating: prior.rating, issue: prior.issue, comment: prior.comment } : { expertId: e.expertId, rating: 'helpful', comment: '' });
            const draft = H.drafts.get(key)!, base = 'hist-' + e.id;
            const rating = h('select', { id: base + '-rating', 'data-fk': key + '-rating' }, h('option', { value: 'helpful', selected: draft.rating === 'helpful' }, t.helpful), h('option', { value: 'unhelpful', selected: draft.rating === 'unhelpful' }, t.unhelpful));
            rating.addEventListener('change', () => { draft.rating = rating.value === 'unhelpful' ? 'unhelpful' : 'helpful'; if (draft.rating === 'helpful') delete draft.issue; paintHistory(); });
            const reason = h('select', { id: base + '-issue', disabled: draft.rating === 'helpful', 'data-fk': key + '-issue' }, h('option', { value: '', selected: !draft.issue }, t.noIssue), ...Object.entries(t.issues).map(([k, text]) => h('option', { value: k, selected: draft.issue === k }, text)));
            reason.addEventListener('change', () => { if (reason.value in t.issues) draft.issue = reason.value as HistoryIssue; else delete draft.issue; });
            const comment = h('textarea', { id: base + '-comment', maxlength: 1000, rows: 2, value: draft.comment, 'data-fk': key + '-comment' });
            comment.addEventListener('input', () => { draft.comment = comment.value; });
            const form = h('form', { class: 'cb-history-feedback' }, h('label', { for: base + '-rating' }, t.feedback), rating,
              h('label', { for: base + '-issue' }, t.issue), reason, h('label', { for: base + '-comment' }, t.comment), comment,
              h('button', { type: 'submit', class: 'cb-secondary', disabled: H.mutation, 'data-fk': key + '-save' }, t.save));
            form.addEventListener('submit', ev => { ev.preventDefault(); void saveHistoryFeedback(p.id, { ...draft }); }); article.append(historyDisclosure(key + ':feedback', t.feedback, form));
          } else if (prior) article.append(h('p', { class: 'cb-help' }, `${prior.rating === 'helpful' ? t.helpful : t.unhelpful}${prior.issue ? ' · ' + t.issues[prior.issue] : ''}`, prior.comment ? '\n' + prior.comment : ''));
        } else if (e.error) article.append(h('p', { class: 'cb-warn' }, e.error));
        detail.append(article);
      }
      detail.append(h('p', { class: 'cb-help' }, t.qualityNote));
      if (H.deleteId === p.id) detail.append(h('div', { class: 'cb-history-delete', role: 'group', 'aria-label': t.confirm }, h('p', null, t.confirm),
        h('button', { type: 'button', class: 'cb-secondary', disabled: H.mutation, onclick: () => { void deleteHistory(p.id); } }, t.deleteYes),
        h('button', { type: 'button', class: 'cb-ghost', disabled: H.mutation, onclick: () => { H.deleteId = ''; paintHistory(); } }, t.cancel)));
      else detail.append(h('button', { type: 'button', class: 'cb-ghost', onclick: () => { H.deleteId = p.id; paintHistory(); } }, t.remove));
    }
    fill(historyBody, ...notices, h('div', { class: 'cb-history-grid' }, list, detail), h('p', { class: 'cb-help' }, t.ownerNote));
  }

  // ── 동작
  /** 언어를 그 자리에서 바꾼다: 다시 실행·새로 고침 없이 글자만 다시 그리고, 입력·선택·실행·타이머·탭·접기 상태는 그대로 둔다 */
  function setLang(l: Lang): void {
    if (l === lang) return;
    const prev = M;
    lang = l; M = DICT[l];
    // 예시 브리프는 사용자가 고치지 않은 칸만 새 언어로 바꾼다. 사용자가 쓴 글은 건드리지 않는다
    for (const [inp, k] of [[titleIn, 'sampleTitle'], [objectiveIn, 'sampleObjective'], [contextIn, 'sampleContext']] as const) if (inp.value === prev[k]) inp.value = M[k];
    for (const f of recount) f();
    applyLang();
    renderAll();
    live.textContent = M.langChanged;
    // 언어는 주소의 ?lang= 에만 남긴다 (저장소 없음, 새 기록 항목 없음). 주소를 못 바꿔도 화면 언어는 바뀐다
    const loc = g.location;
    if (loc && g.history && typeof g.history.replaceState === 'function') {
      try { g.history.replaceState(g.history.state, '', `${loc.pathname ?? ''}${withLang(loc.search ?? '', l)}${loc.hash ?? ''}`); } catch { /* 위 설명 */ }
    }
  }

  /** 문서 언어·제목과 고정 뼈대의 글자를 지금 언어로 */
  function applyLang(): void {
    for (const b of binds) b();
    const docEl = (document as { documentElement?: HTMLElement | null }).documentElement;
    if (docEl && typeof docEl.setAttribute === 'function') docEl.setAttribute('lang', lang);
    try { document.title = M.docTitle; } catch { /* 제목을 못 바꿔도 화면은 그대로 */ }
  }

  function setView(v: View): void {
    if (S.full && v !== 'home') setFull(false);
    const wasHistory = S.view === 'history';
    S.view = v; renderNav();
    navBtns[NAV.indexOf(v)].focus();
    if ((v === 'history' || wasHistory) && g.history && typeof g.history.replaceState === 'function') {
      try { g.history.replaceState(g.history.state, '', (v === 'history' ? '/cloudbite/history' : '/cloudbite') + withLang('', lang)); } catch { /* navigation still works in place */ }
    }
    if (v === 'history') { void loadHistory(); }
    if (v === 'settings') refreshOwner(false);
  }

  function setFull(on: boolean): void { paintFull(on); fullBtn.focus(); }
  /** 전체 화면은 실행 기록을 펼쳐 보이고, 끝나면 사용자가 두었던 열림 상태로 되돌린다 */
  let logWasOpen = false;
  function paintFull(on: boolean): void {
    if (on && !S.full) { logWasOpen = activityLog.open; activityLog.open = true; }
    else if (!on && S.full) activityLog.open = logWasOpen;
    S.full = on;
    wsPanel.className = `cb-panel cb-workspace${on ? ' is-full' : ''}`;
    root!.className = `cb-root${on ? ' is-fullscreen' : ''}`;
    fullIcon.className = `cb-i i-${on ? 'collapse' : 'expand'}`;
    fullIcon.setAttribute('aria-hidden', 'true');
    fullBtn.setAttribute('aria-pressed', String(on));
    paintFullLabel();
  }
  const paintFullLabel = () => { fullLabel.textContent = S.full ? M.exitFullScreen : M.fullScreen; };
  binds.push(paintFullLabel);

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

  /** 지금 카탈로그에 없는 역할을 선택에서 뺀다 */
  function pruneSelection(): void {
    const ids = new Set(catalogue().map(e => e.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
  }

  function setMode(md: Mode): void {
    if (active() || S.mode === md) return;
    S.mode = md; S.formErrors = []; S.modePicked = true;
    // 방문자의 실제 실행에는 데모 기본 선택을 넘기지 않는다 (숨은 유료 선택 없음)
    if (md === 'live' && viaVisitor()) S.selected.clear();
    pruneSelection();
    if (!S.selected.size && md === 'demo') defaultSelection();
    renderAll();
    if (md === 'live') refreshOwner(false);
  }

  function defaultSelection(): void {
    const list = catalogue();
    const want: Archetype[] = ['strategy', 'business', 'trust', 'ux'];
    for (const a of want) { const e = list.find(x => archetypeOf(x) === a && !S.selected.has(x.id)); if (e) S.selected.add(e.id); }
    for (const e of list) { if (S.selected.size >= 4) break; S.selected.add(e.id); }
  }

  function clearTimers(): void { for (const t of timers) clearTimeout(t); timers = []; clearTimeout(pollTimer); pollTimer = 0; clearTimeout(accessTimer); accessTimer = 0; }

  /** 방문자 실행이 끝나면 서버가 아는 접근 상태(canCreate)를 다시 읽는다. 실패한 실행의 정리 확인을 기다리는 동안만
   *  잠깐씩 다시 본다. 버튼만 다시 열 뿐 실행·데모는 자동으로 시작하지 않고, 실패 기록은 사용자가 다시 시작할 때까지 둔다 */
  function refreshAccess(fresh: boolean): void {
    clearTimeout(accessTimer); accessTimer = 0;
    if (fresh) accessTries = 0;
    void loadBootstrap().then(() => {
      if (active()) return;
      const r = S.boot.data?.access?.recovery;
      if ((r === 'pending' || r === 'unavailable' || S.boot.status === 'error') && ++accessTries < ACCESS_RECHECKS)
        accessTimer = setTimeout(() => refreshAccess(false), ACCESS_RECHECK_MS) as unknown as number;
    });
  }

  /** 실행은 사용자가 시작 버튼을 눌렀을 때만 시작한다 (첫 화면 자동 데모 없음) */
  function startRun(): void {
    if (active()) return;
    const f: FormInput = { title: titleIn.value.trim(), objective: objectiveIn.value.trim(), context: contextIn.value.trim(), expertIds: [...S.selected] };
    S.formErrors = validateForm(f, limits());
    if (S.mode === 'live') {
      if (!S.boot.data?.configuration.liveReady) S.formErrors.push({ field: 'run', text: m => m.serverNotReady });
      if (S.adminToken.trim()) {
        if (isOperatorToken(S.adminToken) && !OPERATOR_TOKEN.test(S.adminToken.trim())) S.formErrors.push({ field: 'run', text: m => m.operatorMalformed });
      } else if (!ownerAuthed() && !visitorCanRun()) S.formErrors.push({ field: 'run', text: accessProblem() ?? (m => m.needCredential) });
    }
    if (S.formErrors.length) {
      // 접힌 Project details 안의 입력이 문제면 펼쳐서 고칠 곳을 보인다
      if (S.formErrors.some(e => e.field === 'title' || e.field === 'context')) projDetails.open = true;
      renderControls(); return;
    }
    clearTimers();
    const gen = ++S.gen;
    const brief: ProjectBrief = { ...f, mode: S.mode, requestId: crypto.randomUUID() };
    S.artifactCache.clear(); S.hiddenRows.clear(); S.focusExpert = ''; S.artifactPath = ''; S.artifactPicked = false; lastAnnounce = '';
    S.run = { mode: S.mode, phase: 'starting', project: null, accessToken: '', error: null, startedAt: Date.now(), pollErrors: 0, viaVisitor: viaVisitor(), viaOwner: viaOwner() };
    if (S.mode === 'demo') { startDemo(gen, brief); S.setupOpen = false; } else void startLive(gen, brief);
    renderAll();
    settleFocus();
  }

  /** 편집 영역이 접혀 시작 버튼이 사라졌으면 포커스를 프로젝트 제목으로 옮긴다 */
  function settleFocus(): void {
    if (!S.setupOpen && document.activeElement === startBtn) projTitle.focus();
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

  /** 상태별 안내 + 서버가 보낸 {error} 원문. 그릴 때의 언어로 바뀐다 */
  async function errorText(res: Response): Promise<Text> {
    let server = '';
    try { const j = await res.json(); if (isObj(j)) server = str(j.error, 200); } catch { /* 본문 없음 */ }
    const s = res.status;
    const base: Text = s === 401 || s === 403 ? m => m.http401 : s === 404 ? m => m.http404 : s === 409 ? m => m.http409
      : s === 413 ? m => m.http413 : s === 429 ? m => m.http429 : s === 503 ? m => m.http503 : m => m.httpOther(s);
    return server ? m => m.withServer(base(m), server) : base;
  }

  async function startLive(gen: number, brief: ProjectBrief): Promise<void> {
    const operator = isOperatorToken(S.adminToken);
    // 토큰을 넣었으면 그 헤더만 쓴다 (거부돼도 쿠키로 넘어가지 않는다). 없으면 헤더 없이 same-origin 쿠키(소유자 → 방문자)로 요청한다.
    // 빈 x-admin-token 도 서버는 명시한 토큰으로 보므로 아예 넣지 않는다. 권한 판단은 서버가 한다
    const adminToken = S.adminToken.trim();
    const owner = !adminToken && ownerAuthed();
    const v = adminToken || owner ? null : visitor();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/projects', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: JSON.stringify(brief) });
    } catch {
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = m => m.networkCreate; renderAll(); return;
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const denied = res.status === 401 || res.status === 403;
      const msg: Text = operator && res.status === 401 ? m => m.operatorRejected
        : owner && denied ? m => m.ownerRejected
          : v && denied ? m => m.visitorRejected(REQUEST_PATH)
            : await errorText(res);
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = msg;
      // 소유자 로그인이 거부되면 로그인 상태를 내리고 서버에 다시 묻는다 (자동 데모·재시도 없음)
      if (owner && denied) { S.owner.authenticated = false; void loadOwner(); }
      renderAll();
      if (v) void loadBootstrap(); // 서버가 아는 지금 방문자 상태로 다시 그린다 (자동 데모·재시도 없음)
      return;
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen) return;
    const project = isObj(body) ? normalizeProject(body.project) : null;
    const token = isObj(body) ? str(body.accessToken, 2000) : '';
    if (!project || !token) { S.run!.phase = 'error'; S.run!.error = m => m.invalidResponse; renderAll(); return; }
    S.run!.project = project; S.run!.accessToken = token; S.setupOpen = false; // 실제로 시작됐으니 편집 영역을 접는다
    if (v) v.usedProjects = Math.min(v.maxProjects, v.usedProjects + 1); // 서버가 센 사용량을 화면에도 반영한다
    S.run!.phase = TERMINAL_PROJECT.includes(project.status) ? 'done' : 'running';
    if (S.run!.phase === 'running') schedulePoll(gen, 1200);
    renderAll();
    settleFocus();
    if (S.run!.phase === 'done' && v) refreshAccess(true);
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
      return pollFailed(gen, m => m.networkLost);
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
    if (!p || p.id !== run.project.id) return pollFailed(gen, m => m.invalidResponse);
    run.pollErrors = 0; run.error = null;
    if (p.updatedAt >= run.project.updatedAt) run.project = p; // 늦게 도착한 옛 상태는 버린다
    if (TERMINAL_PROJECT.includes(run.project.status)) run.phase = 'done'; else schedulePoll(gen, 2000);
    renderAll();
    if (run.phase === 'done' && run.viaVisitor) refreshAccess(true);
  }

  function pollFailed(gen: number, msg: Text): void {
    const run = S.run!;
    const n = ++run.pollErrors;
    if (n >= 4) { run.phase = 'error'; run.error = m => m.pollStopped(msg(m)); renderAll(); return; } // Check status again 은 renderControls 가 그린다
    run.error = m => m.pollRetry(msg(m), n);
    renderControls(); renderProgress();
    schedulePoll(gen, 1500 * 2 ** n);
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
    run.phase = 'cancelling'; run.error = null; renderAll();
    const id = run.project?.id;
    if (!id) { run.phase = 'done'; renderAll(); return; }
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: `Bearer ${run.accessToken}` } });
      if (gen !== S.gen) return;
      if (!res.ok) { const msg = await errorText(res); if (gen !== S.gen) return; run.phase = 'error'; run.error = m => m.stopFailed(msg(m)); renderAll(); return; }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 형식 오류 */ }
      if (gen !== S.gen) return;
      const p = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
      if (p && p.id === id) run.project = p;
      else if (run.project) run.project = { ...run.project, status: 'cancelled' };
      run.phase = 'done';
    } catch {
      if (gen !== S.gen) return;
      run.phase = 'error'; run.error = m => m.stopNetwork;
    }
    renderAll();
  }

  async function fetchArtifact(projectId: string, expertId: string, path: string, key: string): Promise<void> {
    const gen = S.gen, token = S.run?.accessToken ?? '';
    S.artifactCache.set(key, { state: 'loading' });
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(projectId)}/artifact?expert=${encodeURIComponent(expertId)}&path=${encodeURIComponent(path)}`,
        { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const msg = await errorText(res);
        if (gen !== S.gen) return;
        S.artifactCache.set(key, { state: 'error', text: msg });
      } else {
        // 서버는 {path, label, bytes, content} JSON 봉투를 돌려준다. 봉투를 글자로 보이지 않고 내용만 꺼낸다
        let body: unknown;
        try { body = await res.json(); } catch { body = undefined; }
        if (gen !== S.gen) return;
        const content = artifactContent(body, path);
        S.artifactCache.set(key, content === null ? { state: 'error', text: m => m.fileUnexpected } : { state: 'ok', text: content });
      }
    } catch {
      if (gen !== S.gen) return;
      S.artifactCache.set(key, { state: 'error', text: m => m.fileNetwork });
    }
    keepFocus(renderWork);
  }

  function download(kind: 'json' | 'md'): void {
    const p = S.run?.project;
    if (!p) return;
    const demo = S.run!.mode === 'demo';
    const text = kind === 'json'
      ? JSON.stringify({ kind: demo ? 'cloudbite-browser-demo' : 'cloudbite-live', note: demo ? M.exportDemoNote : M.exportLiveNote, project: p, aggregate: aggregate(p, M) }, null, 2)
      : markdownReport(p, demo, M);
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'json' ? 'application/json' : 'text/markdown' }));
    const safe = p.brief.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'cloudbite';
    const a = h('a', { href: url, download: `${safe}${demo ? '-demo' : ''}.${kind === 'json' ? 'json' : 'md'}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadBootstrap(): Promise<void> {
    S.boot = { status: 'loading', data: null, error: null }; renderControls();
    let reached = false;
    try {
      const res = await fetch('/api/cloudbite/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
      reached = true;
      S.boot = res.ok ? { status: 'ready', data: normalizeBootstrap(await res.json()), error: null } : { status: 'error', data: null, error: await errorText(res) };
    } catch {
      S.boot = { status: 'error', data: null, error: reached ? m => m.catalogueInvalid : m => m.networkGeneric };
    }
    const intro = visitorIntro();
    // 실행 중인 프로젝트는 그대로 둔다. 선택만 지금 카탈로그에 있는 역할로 맞추고, 아직 시작 전이면 기본 선택을 다시 잡는다
    if (!S.run) S.selected.clear();
    pruneSelection();
    if (!S.selected.size && !intro && (S.mode === 'demo' || link.present || ownerAuthed())) defaultSelection();
    renderAll();
  }

  /** 승인된 방문자를 처음 알아챘을 때 한 번: 실제 실행·프로젝트 설정을 연다. Settings 에서 직접 고른 실행 방식은 바꾸지 않는다.
   *  역할은 방문자가 직접 고르고(기본 선택 없음), 유료 실행·데모는 자동으로 시작하지 않는다. 사용자가 시작한 실행은 건드리지 않는다.
   *  로그인한 소유자는 방문자 한도를 쓰지 않으므로 이 소개를 건너뛴다 */
  function visitorIntro(): boolean {
    if (S.visitorIntro || link.present || S.adminToken.trim() || ownerAuthed() || !visitor() || active()) return false;
    S.visitorIntro = true;
    if (!S.modePicked) S.mode = 'live';
    S.setupOpen = true; S.formErrors = [];
    if (S.mode !== 'live') return false;
    S.selected.clear();
    return true;
  }

  /** 로그인한 소유자를 처음 알아챘을 때 한 번: 실행 전이고 실행 방식을 직접 고르지 않았으면 실제 실행 모드로 연다. 실행은 하지 않는다 */
  function ownerIntro(): void {
    if (S.ownerIntro || !ownerAuthed()) return;
    S.ownerIntro = true;
    if (link.present || S.adminToken.trim() || S.modePicked || S.run || active()) return;
    S.mode = 'live'; S.setupOpen = true;
    pruneSelection();
    if (!S.selected.size && S.boot.status === 'ready') defaultSelection();
  }

  // ── 소유자 세션 (GET /api/cloudbite/owner/session → {authenticated, hasCredentials})
  let ownerSeq = 0, ownerCheckedAt = 0, ownerPending = false;
  /** 서버에 소유자 세션을 묻는다. 응답이 실패하거나 형식이 틀리면 로그인으로 보지 않는다. 늦게 온 옛 응답은 버린다 */
  async function loadOwner(): Promise<void> {
    const seq = ++ownerSeq;
    ownerCheckedAt = Date.now(); ownerPending = true;
    let next: { status: 'ready' | 'error'; authenticated: boolean; hasCredentials: boolean; error: Text | null };
    try {
      const res = await fetch('/api/cloudbite/owner/session', { credentials: 'same-origin', cache: 'no-store' });
      let body: unknown = null;
      if (res.ok) { try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ } }
      const s = res.ok ? normalizeOwnerSession(body) : null;
      next = s ? { status: 'ready', ...s, error: null }
        : { status: 'error', authenticated: false, hasCredentials: false, error: res.ok ? m => m.invalidResponse : m => m.httpOther(res.status) };
    } catch {
      next = { status: 'error', authenticated: false, hasCredentials: false, error: m => m.networkGeneric };
    }
    if (seq !== ownerSeq) return;
    ownerPending = false;
    if (H.owner && next.status === 'ready' && !next.authenticated && !S.adminToken.trim()) {
      H.gen++; H.detailGen++; H.list = null; H.detail = null; H.report = null; H.drafts.clear(); H.owner = false; H.busy = false; H.detailBusy = false; H.dirty = true;
    }
    Object.assign(S.owner, next);
    ownerIntro();
    renderAll();
  }
  /** 저절로 다시 읽기는 OWNER_REFRESH_MS 에 한 번, 진행 중이면 건너뛴다 (포커스가 오가도 요청이 쌓이지 않는다) */
  function refreshOwner(force: boolean): void {
    if (!force && (ownerPending || Date.now() - ownerCheckedAt < OWNER_REFRESH_MS)) return;
    void loadOwner();
  }
  /** 서버에 로그아웃(POST {})을 보내고, 화면은 그 뒤 다시 읽은 서버 세션 상태로만 바꾼다 */
  async function ownerSignOut(): Promise<void> {
    if (S.owner.busy) return;
    S.owner.busy = true; S.owner.message = null; renderControls();
    try {
      const res = await fetch('/api/cloudbite/owner/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) S.owner.message = m => m.signOutFailed(m.httpOther(res.status));
    } catch {
      S.owner.message = m => m.signOutFailed(m.networkGeneric);
    }
    S.owner.busy = false;
    await loadOwner();
  }

  // 첫 화면은 예시 브리프와 기본 역할을 채운 편집 영역이다. 데모·실제 실행 모두 사용자가 시작 버튼을 눌러야 시작한다
  paintFull(false);
  applyLang();
  defaultSelection();
  renderAll();
  if (S.view === 'history') void loadHistory();
  const first = loadBootstrap();
  void loadOwner();
  // 탭으로 돌아오면 소유자 세션을 다시 읽는다 (간격 제한)
  document.addEventListener('visibilitychange', () => { if ((document as { visibilityState?: string }).visibilityState !== 'hidden') refreshOwner(false); });
  if (typeof g.addEventListener === 'function') g.addEventListener('focus', () => refreshOwner(false));
  // 이전 실행의 정리 확인을 기다리는 방문자가 페이지를 다시 열었으면 같은 방식으로 잠깐씩 다시 본다
  void first.then(() => { if (!S.run && recheckable() && !accessTimer) accessTimer = setTimeout(() => refreshAccess(true), ACCESS_RECHECK_MS) as unknown as number; });
}

const CloudbiteCore = { normalizeBootstrap, normalizeProject, normalizeOpinion, aggregate, validateForm, demoPlan, applyStep, cancelProject, statusFromExperts, markdownReport, archetypeOf, operatorFragment, artifactContent, domainLabel, DEMO_EXPERTS,
  pickLang, withLang, normalizeOwnerSession, DICT, ROLE_KO };
const hook = (globalThis as { __cloudbiteTestHook?: (core: typeof CloudbiteCore) => void }).__cloudbiteTestHook;
if (typeof hook === 'function') hook(CloudbiteCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
