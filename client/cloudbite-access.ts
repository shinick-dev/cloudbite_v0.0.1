// Cloudbite 방문자 접근 페이지 (브라우저). tools/build-cloudbite-access.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-access-page.ts 의
// CLOUDBITE_ACCESS_JS 로 고정한다. 같은 출처 외부 스크립트이며 화면은 전부 textContent·createElement 로만 그린다.
//   data-view="request"  /cloudbite/request  — 방문자가 이름·목적을 보내고, 주인 승인 상태를 5초마다 확인한다 (서버 HttpOnly 쿠키, JS 는 읽지 않음)
//   data-view="owner"    /cloudbite/requests — 주인이 보안 키로 한 번 로그인하면(서버 HttpOnly 쿠키) 로그아웃까지 승인·거절·회수한다.
//                                              등록된 키가 없으면 비공개 소유자 설정 토큰(#setup= 또는 입력)으로 첫 키를 여기서 등록한다.
//                                              임시 Cloudbite 운영자 토큰·관리자 세션은 '고급' 아래 메모리에만 두는 대안이다
//   data-view="qr"       /cloudbite/access   — 빌드가 만든 두 언어 블록 중 하나만 보이게 한다
// 승인은 서버 응답이 성공한 뒤에만 화면에 보인다. 자격 증명은 저장소·주소·쿼리에 두지 않는다.
// 화면 문구는 한국어·영어 사전(DICT)에서만 나온다. 언어는 ?lang= 쿼리로만 유지하고, 사용자 입력·서버 오류 원문은 번역하지 않는다.
import type { CloudbiteAccessRequest, CloudbiteAccessSession } from '../src/cloudbite-access-contract';

type AccessStatus = CloudbiteAccessRequest['status'];
const STATUSES: AccessStatus[] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
const LIMIT = { name: 80, purpose: 1000 };
const POLL_MS = 5000;
const MAX_POLL_FAILS = 4;
const API = '/api/cloudbite/access';
const OWNER_API = '/api/cloudbite/owner';
const CONSOLE_PATH = '/cloudbite';
const REQUEST_PATH = '/cloudbite/request';
const REGISTER_PATH = '/register';

// ───────────────────────── 언어 ─────────────────────────

type Lang = 'en' | 'ko';
const LANGS: Lang[] = ['ko', 'en'];
const LANG_NAME: Record<Lang, string> = { ko: '한국어', en: 'English' };
let lang: Lang = 'en';

/** 올바른 ?lang= 가 먼저, 없으면 브라우저 언어, 알 수 없으면 영어 */
function pickLang(search: string, browser: string): Lang {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'ko' || q === 'en') return q;
  return browser.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

const EN = {
  language: 'Language',
  status: { pending: 'Waiting for approval', approved: 'Approved', denied: 'Denied', revoked: 'Revoked', expired: 'Expired' } as Record<AccessStatus, string>,
  now: 'now',
  projects: (n: number) => `${n} ${n === 1 ? 'project' : 'projects'}`,
  experts: (n: number) => `${n} ${n === 1 ? 'AI expert' : 'AI experts'}`,
  netErr: 'Could not reach Cloudbite. Check your connection and try again.',
  httpErr: (s: number) => `Cloudbite returned an error (HTTP ${s}).`,
  tooMany: 'Too many requests. Wait a minute and try again.',
  // 방문자
  requestTitle: 'Cloudbite — Request access',
  visitorSub: 'Visitor access',
  requestH1: 'Request access to Cloudbite',
  requestLead: 'Cloudbite runs one shared project with several AI expert roles, each in its own workspace. Ask the host for a short session to try it yourself.',
  formAria: 'Request Cloudbite access',
  nameLabel: 'Your name',
  purposeLabel: 'What would you like to try with Cloudbite?',
  purposeHelp: 'For example: “Have a product, a security and a UX expert review my launch plan.”',
  yourRequest: 'Your request',
  nextH: 'What happens next',
  step1: ['Send your request.', 'Keep this page open. It checks for the host\'s answer every few seconds.'],
  step2: ['The host reviews it.', 'The host approves or declines from the owner inbox. Requests wait up to 30 minutes.'],
  step3: ['Open Cloudbite.', 'An approved session lasts one hour and allows up to ten projects. Enter a project question; Jev selects up to 100 relevant AI expert roles. Run the project and review their work.'],
  requestNote: 'Nothing runs until you press Run experts in Cloudbite. Approval does not create resources by itself.',
  nameMissing: 'Enter your name.',
  nameLong: (n: number) => `Your name must be ${n} characters or fewer.`,
  purposeMissing: 'Tell the host what you want to try.',
  purposeLong: (n: number) => `The purpose must be ${n} characters or fewer.`,
  visitorErr: (s: number): string => s === 400 ? 'The request was not accepted. Check your name and purpose.'
    : s === 409 ? 'You already have an access request in this browser.'
      : s === 413 ? 'The request is too long. Shorten the purpose.'
        : s === 503 ? 'Access requests are not available right now.' : '',
  statusOdd: 'Cloudbite sent a status in an unexpected format.',
  acceptedOdd: 'Cloudbite accepted the request but sent an unexpected reply. Reload this page to check its status.',
  checking: 'Checking for an existing request…',
  checkAgain: 'Check again',
  pendingP: 'The host has your request. This page checks every 5 seconds while it is open — you do not need to reload.',
  pendingExpires: (at: string, rem: string) => `The request expires at ${at} (${rem}) if nobody answers.`,
  approvedOk: 'You are approved. Your Cloudbite session is ready in this browser.',
  sessionEnds: (at: string, rem: string) => `Session ends at ${at} (${rem})`,
  projectsLeft: (left: number, max: number) => `${EN.projects(left)} left of ${max}`,
  expertsPer: (n: number) => `Up to ${EN.experts(n)} per project`,
  approvedHow: 'In Cloudbite: enter your question and press Run experts. Jev selects the team automatically. Review each expert\'s files and the synthesis.',
  continueBtn: 'Continue to Cloudbite',
  deniedP: 'The host declined this request.',
  revokedP: 'The host ended this session.',
  expiredP: 'This request or session has expired.',
  sendNew: 'Send a new request',
  stopped: (e: string) => `${e} Stopped checking.`,
  retrying: (e: string) => `${e} Checking again…`,
  intro: 'Tell the host who you are and what you want to try.',
  sending: 'Sending…',
  submit: 'Request access',
  // 주인
  ownerTitle: 'Cloudbite — Access requests',
  ownerSub: 'Owner request inbox',
  ownerH1: 'Cloudbite access requests',
  ownerLead: 'Approve a visitor to give them a one-hour Cloudbite session with up to ten projects and up to 100 AI experts per project. Nothing runs until the visitor starts it.',
  signInH: 'Owner sign-in',
  sessionChecking: 'Checking whether this browser is signed in…',
  signInLead: 'Sign in once with the security key registered for this Cloudbite domain. This browser then stays signed in — across reloads and new tabs — until you press Log out.',
  signInBtn: 'Sign in with security key',
  signingIn: 'Waiting for your security key…',
  keyHint: 'Insert or touch your key when the browser asks. The browser shows its own prompt, including any PIN request, in its own language.',
  signedIn: 'Signed in with your security key.',
  signedInHelp: 'Approvals work without signing in again in this browser until you log out.',
  logout: 'Log out',
  loggingOut: 'Logging out…',
  loggedOut: 'You are logged out in this browser.',
  logoutFailed: 'Logout did not complete, so you are still signed in.',
  logoutOdd: 'Cloudbite did not confirm the logout, so you may still be signed in. Try again.',
  signedOutElsewhere: 'You were signed out — the session ended in another tab or expired. Sign in again to continue.',
  noKeyH: 'No security key is registered on this Cloudbite domain yet.',
  noKeyP: 'Owner sign-in accepts only a key registered on this exact domain. Register your first key here once with the private owner setup token, then sign in with that key.',
  registerLink: 'Open key registration',
  setupLabel: 'Owner setup token',
  setupHelp: 'From your private owner setup link. Held in this tab only and sent only with the registration request. It opens registration; it does not sign you in.',
  registerBtn: 'Register security key',
  registering: 'Registering — follow your browser\'s prompt…',
  setupMissing: 'Enter the owner setup token.',
  setupInvalid: 'The owner setup token has the wrong format. Check it, or ask for a new owner setup link.',
  setupMalformed: 'The owner setup link was malformed. It was removed from the address bar; ask for a new link.',
  setupUnused: 'A security key is already registered on this domain, so the setup link was not used and was cleared.',
  regUnsupported: 'This browser cannot register a security key on this page. Open it in a current browser over HTTPS.',
  regCancelled: 'Key registration was cancelled or timed out. Press Register security key to try again.',
  regExists: 'This security key is already registered on this domain. Sign in with it, or use a different key.',
  regDomainRefused: 'The browser refused security-key registration for this address.',
  regFailed: 'The security key did not complete registration.',
  regStartFailed: 'Could not start key registration.',
  regRejected: (s: number): string => s === 400 ? 'Cloudbite did not verify this registration. Try again.'
    : s === 403 ? 'The owner setup token was rejected, has already registered two keys, or expired 30 minutes after first use. Ask for a new owner setup link.'
      : s === 503 ? 'Key registration is not available right now.' : '',
  regOdd: 'Cloudbite answered the registration in an unexpected format. No key was confirmed.',
  registered: 'Key registered. Sign in with your security key.',
  sessionFailed: 'Could not check whether this browser is signed in.',
  tryAgain: 'Try again',
  unsupported: 'This browser cannot use a security key on this page. Open it in a current browser over HTTPS, or use a temporary token under Advanced.',
  cancelled: 'Sign-in was cancelled or timed out. Press Sign in to try again.',
  domainRefused: 'The browser refused security-key sign-in for this address. Use an updated Chrome or Edge with Related Origin Requests support.',
  keyUnusable: 'This security key cannot be used here. Use the key registered for this Cloudbite domain.',
  keyFailed: 'The security key did not complete sign-in.',
  optionsFailed: 'Could not start sign-in.',
  loginOdd: 'Cloudbite answered sign-in in an unexpected format. You are not signed in.',
  loginRejected: (s: number): string => s === 400 || s === 401 || s === 403 ? 'Cloudbite did not accept this security key. Use the key registered for this Cloudbite domain.'
    : s === 503 ? 'Owner sign-in is not available right now.' : '',
  advanced: 'Advanced: temporary token',
  tokenLabel: 'Admin session or temporary operator token',
  tokenHelp: 'Held in this tab\'s memory only — never stored, put in the address, or shown on screen. While set it is used instead of the security-key session. Clearing it does not log you out.',
  useToken: 'Use token',
  clearToken: 'Clear token',
  operatorMalformed: 'The operator link was malformed. It was removed from the address bar; ask for a new link.',
  operatorTokenMalformed: 'The temporary Cloudbite operator token is malformed. Clear it and use a new link.',
  inboxH: 'Inbox',
  autoH: 'Auto-approval',
  autoHelp: 'When ON, new requests are approved immediately, even while this page is closed or you are logged out. Stays ON until you switch it OFF. Existing requests keep their status. Sessions last 1 hour, with up to 10 projects and 100 experts per project. Experts run only when the visitor starts them.',
  autoOn: 'ON · New requests are approved automatically.',
  autoOff: 'OFF · New requests need your approval.',
  autoUnknown: 'Load the inbox to check the current mode.',
  autoSaving: 'Saving…',
  autoFailed: 'Could not save the approval mode. Refresh to check the server state.',
  autoSavedOn: 'Auto-approval is ON for new requests.',
  autoSavedOff: 'Auto-approval is OFF. New requests need your approval.',
  refresh: 'Refresh',
  listAria: 'Access requests',
  stateSignIn: 'Sign in to open the inbox.',
  stateLoading: 'Loading requests…',
  stateReady: (n: number, at: string, via: string) => `${n} ${n === 1 ? 'request' : 'requests'} · updated ${at} · ${via}`,
  stateError: 'Inbox unavailable',
  viaKey: 'security-key session',
  viaOperator: 'temporary operator token in memory',
  viaAdmin: 'admin session in memory',
  empty: 'No access requests yet. New requests appear here automatically.',
  inboxOdd: 'Cloudbite sent the inbox in an unexpected format.',
  answerOdd: 'Cloudbite answered in an unexpected format. Refreshing the inbox.',
  approve: 'Approve', deny: 'Deny', revoke: 'Revoke', working: 'Working…',
  noName: '(no name)', noPurpose: '(no purpose given)',
  requested: (at: string) => `Requested ${at}`,
  requestExpires: (at: string, rem: string) => `request expires ${at} (${rem})`,
  sessionEndsRow: (at: string, rem: string) => `session ends ${at} (${rem})`,
  used: (u: number, max: number) => `${u} of ${EN.projects(max)} used`,
  upTo: (n: number) => `up to ${EN.experts(n)}`,
  couldNot: (a: 'approve' | 'deny' | 'revoke', name: string, e: string) => `Could not ${a} “${name}”: ${e}`,
  didApprove: (name: string, at: string) => `Approved “${name}”. Their session ends at ${at}.`,
  didDeny: (name: string) => `Denied “${name}”.`,
  didRevoke: (name: string) => `Revoked “${name}”.`,
  nowStatus: (name: string, s: AccessStatus) => `“${name}” is now ${EN.status[s].toLowerCase()}.`,
  ownerErr: (s: number, via: Via): string => s === 401 || s === 403 ? (via === 'operator' ? 'The temporary Cloudbite operator token was rejected or has expired. Ask for a new link.'
    : via === 'admin' ? 'The admin session was rejected or has expired. Paste a current one.' : 'Your sign-in has ended. Sign in again with your security key.')
    : s === 404 ? 'That request no longer exists.' : s === 409 ? 'That request has already changed state.' : '',
  visitorForm: 'Visitor request form',
  consoleLink: 'Cloudbite console',
  historyLink: 'Usage history and improvement report',
};
type Dict = typeof EN;
type Via = 'key' | 'operator' | 'admin';

const KO: Dict = {
  language: '언어',
  status: { pending: '승인 대기', approved: '승인됨', denied: '거절됨', revoked: '회수됨', expired: '만료됨' },
  now: '곧',
  projects: (n) => `프로젝트 ${n}개`,
  experts: (n) => `AI 전문가 ${n}명`,
  netErr: 'Cloudbite에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.',
  httpErr: (s) => `Cloudbite가 오류를 반환했습니다 (HTTP ${s}).`,
  tooMany: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  requestTitle: 'Cloudbite — 사용 요청',
  visitorSub: '방문자 접근',
  requestH1: 'Cloudbite 사용 요청',
  requestLead: 'Cloudbite는 하나의 공통 프로젝트를 여러 AI 전문가 역할이 각자의 작업 공간에서 수행하는 제품입니다. 호스트에게 짧은 체험 세션을 요청해 직접 사용해 보세요.',
  formAria: 'Cloudbite 사용 요청',
  nameLabel: '이름',
  purposeLabel: 'Cloudbite로 무엇을 해 보고 싶으신가요?',
  purposeHelp: '예: “제품·보안·UX 전문가에게 출시 계획을 검토받고 싶어요.”',
  yourRequest: '내 요청',
  nextH: '진행 순서',
  step1: ['요청을 보냅니다.', '이 페이지를 열어 두세요. 몇 초마다 호스트의 답을 확인합니다.'],
  step2: ['호스트가 검토합니다.', '호스트가 소유자 요청함에서 승인하거나 거절합니다. 요청은 최대 30분 동안 기다립니다.'],
  step3: ['Cloudbite를 엽니다.', '승인된 세션은 1시간 동안 유지되며 프로젝트를 최대 10개 만들 수 있습니다. 프로젝트 질문을 입력하면 Jev가 적합한 AI 전문가를 최대 100명 배정합니다. 실행한 뒤 결과를 살펴보세요.'],
  requestNote: 'Cloudbite에서 전문가 실행을 누르기 전에는 아무것도 실행되지 않습니다. 승인만으로는 자원이 만들어지지 않습니다.',
  nameMissing: '이름을 입력하세요.',
  nameLong: (n) => `이름은 ${n}자 이하로 입력하세요.`,
  purposeMissing: '해 보고 싶은 일을 호스트에게 알려 주세요.',
  purposeLong: (n) => `목적은 ${n}자 이하로 입력하세요.`,
  visitorErr: (s) => s === 400 ? '요청이 접수되지 않았습니다. 이름과 목적을 확인하세요.'
    : s === 409 ? '이 브라우저에는 이미 접근 요청이 있습니다.'
      : s === 413 ? '요청이 너무 깁니다. 목적을 줄여 주세요.'
        : s === 503 ? '지금은 접근 요청을 받을 수 없습니다.' : '',
  statusOdd: 'Cloudbite가 예상하지 못한 형식의 상태를 보냈습니다.',
  acceptedOdd: 'Cloudbite가 요청을 받았지만 예상하지 못한 답을 보냈습니다. 페이지를 새로 고쳐 상태를 확인하세요.',
  checking: '기존 요청을 확인하는 중…',
  checkAgain: '다시 확인',
  pendingP: '호스트가 요청을 받았습니다. 이 페이지가 열려 있는 동안 5초마다 확인하므로 새로 고칠 필요가 없습니다.',
  pendingExpires: (at, rem) => `아무도 답하지 않으면 요청은 ${at}에 만료됩니다 (${rem}).`,
  approvedOk: '승인되었습니다. 이 브라우저에서 Cloudbite 세션을 사용할 수 있습니다.',
  sessionEnds: (at, rem) => `세션 종료 ${at} (${rem})`,
  projectsLeft: (left, max) => `${max}개 중 ${KO.projects(left)} 남음`,
  expertsPer: (n) => `프로젝트마다 ${KO.experts(n)}까지`,
  approvedHow: 'Cloudbite에서 질문을 입력하고 전문가 실행을 누르세요. Jev가 팀을 자동으로 배정합니다. 전문가별 파일과 종합 결과를 살펴볼 수 있습니다.',
  continueBtn: 'Cloudbite로 이동',
  deniedP: '호스트가 이 요청을 거절했습니다.',
  revokedP: '호스트가 이 세션을 종료했습니다.',
  expiredP: '이 요청 또는 세션이 만료되었습니다.',
  sendNew: '새 요청 보내기',
  stopped: (e) => `${e} 확인을 멈췄습니다.`,
  retrying: (e) => `${e} 다시 확인하는 중…`,
  intro: '호스트에게 누구인지, 무엇을 해 보고 싶은지 알려 주세요.',
  sending: '보내는 중…',
  submit: '사용 요청 보내기',
  ownerTitle: 'Cloudbite — 접근 요청함',
  ownerSub: '소유자 요청함',
  ownerH1: 'Cloudbite 접근 요청',
  ownerLead: '방문자를 승인하면 1시간 동안 프로젝트 최대 10개, 프로젝트마다 AI 전문가 최대 100명을 쓸 수 있는 Cloudbite 세션이 주어집니다. 방문자가 시작하기 전에는 아무것도 실행되지 않습니다.',
  signInH: '소유자 로그인',
  sessionChecking: '이 브라우저의 로그인 상태를 확인하는 중…',
  signInLead: '이 Cloudbite 도메인에 등록한 보안 키로 한 번만 로그인하세요. 로그아웃을 누를 때까지 이 브라우저는 새로 고침하거나 새 탭을 열어도 로그인 상태를 유지합니다.',
  signInBtn: '보안 키로 로그인',
  signingIn: '보안 키를 기다리는 중…',
  keyHint: '브라우저가 요청하면 키를 꽂거나 터치하세요. PIN 입력을 포함한 브라우저 자체 안내는 브라우저 언어로 표시됩니다.',
  signedIn: '보안 키로 로그인되어 있습니다.',
  signedInHelp: '로그아웃하기 전까지 이 브라우저에서는 다시 로그인하지 않고 승인할 수 있습니다.',
  logout: '로그아웃',
  loggingOut: '로그아웃하는 중…',
  loggedOut: '이 브라우저에서 로그아웃했습니다.',
  logoutFailed: '로그아웃이 완료되지 않아 아직 로그인 상태입니다.',
  logoutOdd: 'Cloudbite가 로그아웃을 확인해 주지 않아 아직 로그인 상태일 수 있습니다. 다시 시도하세요.',
  signedOutElsewhere: '로그아웃되었습니다. 다른 탭에서 세션이 끝났거나 만료되었습니다. 계속하려면 다시 로그인하세요.',
  noKeyH: '이 Cloudbite 도메인에 등록된 보안 키가 아직 없습니다.',
  noKeyP: '소유자 로그인은 바로 이 도메인에 등록된 키만 받습니다. 비공개 소유자 설정 토큰으로 여기서 첫 키를 한 번 등록한 뒤, 그 키로 로그인하세요.',
  registerLink: '키 등록 페이지 열기',
  setupLabel: '소유자 설정 토큰',
  setupHelp: '비공개 소유자 설정 링크에 들어 있는 값입니다. 이 탭에만 두고 등록 요청에만 보냅니다. 등록을 열어 줄 뿐 로그인시키지는 않습니다.',
  registerBtn: '보안 키 등록',
  registering: '등록 중 — 브라우저 안내를 따르세요…',
  setupMissing: '소유자 설정 토큰을 입력하세요.',
  setupInvalid: '소유자 설정 토큰 형식이 올바르지 않습니다. 확인하거나 새 소유자 설정 링크를 요청하세요.',
  setupMalformed: '소유자 설정 링크 형식이 올바르지 않습니다. 주소창에서 지웠으니 새 링크를 요청하세요.',
  setupUnused: '이 도메인에는 이미 등록된 보안 키가 있어 설정 링크를 쓰지 않고 지웠습니다.',
  regUnsupported: '이 브라우저에서는 이 페이지에서 보안 키를 등록할 수 없습니다. 최신 브라우저에서 HTTPS 로 여세요.',
  regCancelled: '키 등록이 취소되었거나 시간이 초과되었습니다. 보안 키 등록을 눌러 다시 시도하세요.',
  regExists: '이 보안 키는 이미 이 도메인에 등록되어 있습니다. 그 키로 로그인하거나 다른 키를 쓰세요.',
  regDomainRefused: '브라우저가 이 주소에서 보안 키 등록을 거부했습니다.',
  regFailed: '보안 키 등록이 완료되지 않았습니다.',
  regStartFailed: '키 등록을 시작하지 못했습니다.',
  regRejected: (s) => s === 400 ? 'Cloudbite가 이 등록을 검증하지 못했습니다. 다시 시도하세요.'
    : s === 403 ? '소유자 설정 토큰이 거부되었거나, 이미 키 두 개를 등록했거나, 처음 쓴 지 30분이 지나 만료되었습니다. 새 소유자 설정 링크를 요청하세요.'
      : s === 503 ? '지금은 키 등록을 사용할 수 없습니다.' : '',
  regOdd: 'Cloudbite가 예상하지 못한 형식으로 등록에 답했습니다. 키 등록이 확인되지 않았습니다.',
  registered: '키를 등록했습니다. 보안 키로 로그인하세요.',
  sessionFailed: '이 브라우저의 로그인 상태를 확인하지 못했습니다.',
  tryAgain: '다시 시도',
  unsupported: '이 브라우저에서는 이 페이지에서 보안 키를 쓸 수 없습니다. 최신 브라우저에서 HTTPS 로 열거나, 고급 아래의 임시 토큰을 사용하세요.',
  cancelled: '로그인이 취소되었거나 시간이 초과되었습니다. 로그인을 눌러 다시 시도하세요.',
  domainRefused: '브라우저가 이 주소에서 보안 키 로그인을 거부했습니다. Related Origin Requests를 지원하는 최신 Chrome·Edge를 사용하세요.',
  keyUnusable: '이 보안 키는 여기서 쓸 수 없습니다. 이 Cloudbite 도메인에 등록한 키를 사용하세요.',
  keyFailed: '보안 키 로그인이 완료되지 않았습니다.',
  optionsFailed: '로그인을 시작하지 못했습니다.',
  loginOdd: 'Cloudbite가 예상하지 못한 형식으로 로그인에 답했습니다. 로그인되지 않았습니다.',
  loginRejected: (s) => s === 400 || s === 401 || s === 403 ? 'Cloudbite가 이 보안 키를 받지 않았습니다. 이 Cloudbite 도메인에 등록한 키를 사용하세요.'
    : s === 503 ? '지금은 소유자 로그인을 사용할 수 없습니다.' : '',
  advanced: '고급: 임시 토큰',
  tokenLabel: '관리자 세션 또는 임시 운영자 토큰',
  tokenHelp: '이 탭의 메모리에만 둡니다. 저장하거나 주소에 넣거나 화면에 보여 주지 않습니다. 입력해 두는 동안에는 보안 키 세션 대신 이 값을 씁니다. 지워도 로그아웃되지는 않습니다.',
  useToken: '토큰 사용',
  clearToken: '토큰 지우기',
  operatorMalformed: '운영자 링크 형식이 올바르지 않습니다. 주소창에서 지웠으니 새 링크를 요청하세요.',
  operatorTokenMalformed: '임시 Cloudbite 운영자 토큰 형식이 올바르지 않습니다. 지우고 새 링크를 사용하세요.',
  inboxH: '요청함',
  autoH: '자동승인',
  autoHelp: 'ON이면 페이지를 닫거나 로그아웃해도 새 요청을 즉시 승인합니다. 직접 OFF로 바꿀 때까지 유지됩니다. 기존 요청 상태는 바뀌지 않습니다. 체험은 1시간·최대 10회·회당 전문가 100명이며, 전문가 실행은 방문자가 직접 시작합니다.',
  autoOn: 'ON · 새 요청을 자동으로 승인합니다.',
  autoOff: 'OFF · 새 요청은 직접 승인해야 합니다.',
  autoUnknown: '요청함을 불러오면 현재 모드를 확인할 수 있습니다.',
  autoSaving: '저장 중…',
  autoFailed: '승인 모드를 저장하지 못했습니다. 새로고침으로 서버 상태를 확인하세요.',
  autoSavedOn: '새 요청에 대한 자동승인을 켰습니다.',
  autoSavedOff: '자동승인을 껐습니다. 새 요청은 직접 승인해야 합니다.',
  refresh: '새로 고침',
  listAria: '접근 요청 목록',
  stateSignIn: '로그인하면 요청함이 열립니다.',
  stateLoading: '요청을 불러오는 중…',
  stateReady: (n, at, via) => `요청 ${n}건 · ${at} 갱신 · ${via}`,
  stateError: '요청함을 열 수 없음',
  viaKey: '보안 키 세션',
  viaOperator: '메모리의 임시 운영자 토큰',
  viaAdmin: '메모리의 관리자 세션',
  empty: '아직 접근 요청이 없습니다. 새 요청은 여기에 자동으로 나타납니다.',
  inboxOdd: 'Cloudbite가 예상하지 못한 형식으로 요청함을 보냈습니다.',
  answerOdd: 'Cloudbite가 예상하지 못한 형식으로 답했습니다. 요청함을 새로 고칩니다.',
  approve: '승인', deny: '거절', revoke: '회수', working: '처리 중…',
  noName: '(이름 없음)', noPurpose: '(목적 없음)',
  requested: (at) => `${at} 요청`,
  requestExpires: (at, rem) => `요청 만료 ${at} (${rem})`,
  sessionEndsRow: (at, rem) => `세션 종료 ${at} (${rem})`,
  used: (u, max) => `프로젝트 ${max}개 중 ${u}개 사용`,
  upTo: (n) => `${KO.experts(n)}까지`,
  couldNot: (a, name, e) => `“${name}” 요청을 ${a === 'approve' ? '승인' : a === 'deny' ? '거절' : '회수'}하지 못했습니다: ${e}`,
  didApprove: (name, at) => `“${name}” 요청을 승인했습니다. 세션은 ${at}에 끝납니다.`,
  didDeny: (name) => `“${name}” 요청을 거절했습니다.`,
  didRevoke: (name) => `“${name}” 세션을 회수했습니다.`,
  nowStatus: (name, s) => `“${name}” 요청은 이제 ${KO.status[s]} 상태입니다.`,
  ownerErr: (s, via) => s === 401 || s === 403 ? (via === 'operator' ? '임시 Cloudbite 운영자 토큰이 거부되었거나 만료되었습니다. 새 링크를 요청하세요.'
    : via === 'admin' ? '관리자 세션이 거부되었거나 만료되었습니다. 유효한 값을 붙여 넣으세요.' : '로그인이 끝났습니다. 보안 키로 다시 로그인하세요.')
    : s === 404 ? '그 요청은 더 이상 없습니다.' : s === 409 ? '그 요청의 상태가 이미 바뀌었습니다.' : '',
  visitorForm: '방문자 요청 양식',
  consoleLink: 'Cloudbite 콘솔',
  historyLink: '사용 기록과 개선 리포트',
};
const DICT: Record<Lang, Dict> = { en: EN, ko: KO };
const T = (): Dict => DICT[lang];
/** 화면 문구는 그릴 때 현재 언어로 만든다. 상태에는 문자열 대신 이 함수를 둔다 */
type Msg = () => string;

const locale = () => (lang === 'ko' ? 'ko-KR' : 'en-US');
function clock(at: number): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}
function remaining(at: number, now: number): string {
  if (!at) return '';
  const min = Math.ceil((at - now) / 60_000);
  if (min <= 0) return T().now;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  return min < 60 ? rtf.format(min, 'minute') : rtf.format(Math.round(min / 60), 'hour');
}
function withRaw(base: string, raw: string): string { return raw ? `${base} — ${raw}` : base; }
/** 같은 출처 Cloudbite 링크에 현재 언어를 붙인다 */
function withLang(path: string): string { return `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`; }

/** 언어는 현재 주소의 ?lang= 에만 둔다. 해시(운영자 조각 등)는 다시 쓰지 않는다 */
function persistLang(): void {
  const g = globalThis as { location?: Location; history?: History };
  const loc = g.location;
  if (!loc || !g.history || typeof g.history.replaceState !== 'function') return;
  const q = new URLSearchParams(loc.search ?? '');
  q.set('lang', lang);
  try { g.history.replaceState(g.history.state, '', `${loc.pathname ?? ''}?${q.toString()}`); } catch { /* 주소만 못 바꾼다 */ }
}

// ───────────────────────── 값 정리 (서버가 보낸 것도 의심한다) ─────────────────────────

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function str(v: unknown, n: number, fallback = ''): string { return typeof v === 'string' ? clip(v, n) : fallback; }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function count(v: unknown, max: number): number { const n = num(v); return n !== null && n >= 0 ? Math.min(Math.floor(n), max) : 0; }

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

/** 주인 로그인 상태. 형식이 틀리면 null — 로그인된 것으로 치지 않는다 */
function normalizeOwnerSession(raw: unknown): { authenticated: boolean; hasCredentials: boolean } | null {
  if (!isObj(raw) || typeof raw.authenticated !== 'boolean') return null;
  return { authenticated: raw.authenticated, hasCredentials: raw.authenticated || raw.hasCredentials === true };
}

/** 만료 시각이 지난 승인·대기는 서버가 아직 바꾸지 않았어도 화면에서는 만료로 보인다 */
function effectiveStatus(r: CloudbiteAccessRequest, now: number): AccessStatus {
  return (r.status === 'pending' || r.status === 'approved') && r.expiresAt > 0 && r.expiresAt <= now ? 'expired' : r.status;
}

function validateRequest(name: string, purpose: string): Msg[] {
  const errors: Msg[] = [];
  if (!name.trim()) errors.push(() => T().nameMissing);
  if (name.trim().length > LIMIT.name) errors.push(() => T().nameLong(LIMIT.name));
  if (!purpose.trim()) errors.push(() => T().purposeMissing);
  if (purpose.trim().length > LIMIT.purpose) errors.push(() => T().purposeLong(LIMIT.purpose));
  return errors;
}

// 임시 Cloudbite 운영자 토큰: 콘솔(client/cloudbite-console.ts)·서버(src/cloudbite-operator.ts)와 같은 모양만 받는다
const OPERATOR_TOKEN = /^cbo_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isOperatorToken = (t: string) => t.trim().startsWith('cbo_');
// 소유자 설정 토큰(SETUP_TOKEN): 첫 보안 키 등록에만 쓰는 불투명 값. /api/register/* 본문 말고는 어디에도 보내지 않는다
const SETUP_TOKEN = /^[A-Za-z0-9_-]{20,256}$/;
type Found = { present: boolean; token: string };
/** 한 번에 두 비밀을 나눠 읽는다: setup 조각의 값이 운영자 조각으로 잘못 읽히거나 서로 덮어쓰지 않는다 */
function handoffFragment(hash: string): { operator: Found; setup: Found } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('&');
  const isSetup = (p: string) => p === 'setup' || p.startsWith('setup=');
  const rest = parts.filter(p => !isSetup(p));
  const op = rest.find(p => p === 'operator' || p.startsWith('operator='));
  const opValue = op === undefined ? null : op.slice('operator='.length);
  const su = parts.find(isSetup);
  let suValue = su === undefined ? '' : su.slice('setup='.length);
  try { suValue = decodeURIComponent(suValue); } catch { suValue = ''; } // 한 번만 푼다
  return {
    operator: { present: op !== undefined || rest.join('&').includes('cbo_'), token: opValue !== null && OPERATOR_TOKEN.test(opValue) ? opValue : '' },
    setup: { present: su !== undefined || raw.includes('setup='), token: su !== undefined && SETUP_TOKEN.test(suValue) ? suValue : '' },
  };
}
function operatorFragment(hash: string): Found { return handoffFragment(hash).operator; }
/** 운영자·설정 조각을 메모리로 옮기고 어떤 요청보다 먼저 주소창·현재 기록 항목에서 지운다 */
function takeHandoffLink(): { operator: Found; setup: Found } {
  const g = globalThis as { location?: Location; history?: History };
  const loc = g.location;
  const found = handoffFragment(loc && typeof loc.hash === 'string' ? loc.hash : '');
  if (!(found.operator.present || found.setup.present) || !loc) return found;
  const clean = `${loc.pathname ?? ''}${loc.search ?? ''}`;
  try {
    if (g.history && typeof g.history.replaceState === 'function') { g.history.replaceState(g.history.state, '', clean); return found; }
  } catch { /* 아래 대안으로 */ }
  try { if (typeof loc.replace === 'function') loc.replace(`${clean}#`); } catch { /* 지울 방법이 없다 */ }
  return found;
}

// ───────────────────────── WebAuthn (보안 키 로그인) ─────────────────────────

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
/** 서버의 PublicKeyCredentialRequestOptionsJSON → navigator.credentials.get 인자. 형식이 틀리면 null */
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
/** AuthenticationResponseJSON — @simplewebauthn/browser 가 보내는 모양 */
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
/** 서버의 PublicKeyCredentialCreationOptionsJSON → navigator.credentials.create 인자. 나머지(교차 플랫폼·UV 필수·PRF)는 그대로 둔다 */
function creationOptions(raw: unknown): PublicKeyCredentialCreationOptions | null {
  if (!isObj(raw) || typeof raw.challenge !== 'string' || !raw.challenge) return null;
  if (!isObj(raw.user) || typeof raw.user.id !== 'string' || !raw.user.id) return null;
  const exclude = raw.excludeCredentials === undefined ? [] : raw.excludeCredentials;
  if (!Array.isArray(exclude) || !exclude.every(x => isObj(x) && typeof x.id === 'string')) return null;
  try {
    return {
      ...(raw as object),
      challenge: fromB64u(raw.challenge),
      user: { ...raw.user, id: fromB64u(raw.user.id) },
      excludeCredentials: (exclude as Record<string, unknown>[]).map(x => ({ ...x, type: 'public-key', id: fromB64u(x.id as string) }) as PublicKeyCredentialDescriptor),
    } as PublicKeyCredentialCreationOptions;
  } catch { return null; }
}
type Attestation = {
  id: string; rawId: ArrayBuffer; type: string; authenticatorAttachment?: string | null;
  response: { clientDataJSON: ArrayBuffer; attestationObject: ArrayBuffer; getTransports?: () => unknown };
  getClientExtensionResults?: () => unknown;
};
/** RegistrationResponseJSON — @simplewebauthn/browser 가 보내는 모양 (선택 항목은 있을 때만) */
function attestationJSON(c: Attestation): Record<string, unknown> {
  const transports = typeof c.response.getTransports === 'function' ? c.response.getTransports() : undefined;
  return {
    id: c.id, rawId: toB64u(c.rawId), type: c.type,
    response: {
      clientDataJSON: toB64u(c.response.clientDataJSON), attestationObject: toB64u(c.response.attestationObject),
      ...(Array.isArray(transports) && transports.every(t => typeof t === 'string') ? { transports } : {}),
    },
    clientExtensionResults: typeof c.getClientExtensionResults === 'function' ? c.getClientExtensionResults() : {},
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}
function webauthnAvailable(op: 'get' | 'create' = 'get'): boolean {
  const g = globalThis as { PublicKeyCredential?: unknown; navigator?: { credentials?: { get?: unknown; create?: unknown } } };
  return typeof g.PublicKeyCredential !== 'undefined' && typeof g.navigator?.credentials?.[op] === 'function';
}
function registerError(e: unknown): Msg {
  const name = isObj(e) || e instanceof Error ? str((e as { name?: unknown }).name, 60) : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return () => T().regCancelled;
  if (name === 'SecurityError') return () => T().regDomainRefused;
  if (name === 'InvalidStateError') return () => T().regExists;
  if (name === 'NotSupportedError') return () => T().regUnsupported;
  return () => withRaw(T().regFailed, name);
}
function keyError(e: unknown): Msg {
  const name = isObj(e) || e instanceof Error ? str((e as { name?: unknown }).name, 60) : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return () => T().cancelled;
  if (name === 'SecurityError') return () => T().domainRefused;
  if (name === 'InvalidStateError') return () => T().keyUnusable;
  if (name === 'NotSupportedError') return () => T().unsupported;
  return () => withRaw(T().keyFailed, name);
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
const postJSON = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** 상태 코드별 문구 + 서버 오류 원문(번역하지 않는다) */
function failure(r: Extract<Reply, { ok: false }>, specific: (d: Dict) => string): Msg {
  return () => {
    const d = T();
    const base = r.status === 0 ? d.netErr : specific(d) || (r.status === 429 ? d.tooMany : d.httpErr(r.status));
    return withRaw(base, r.error);
  };
}
const visitorError = (r: Extract<Reply, { ok: false }>) => failure(r, d => d.visitorErr(r.status));
const ownerError = (r: Extract<Reply, { ok: false }>, via: Via) => failure(r, d => d.ownerErr(r.status, via));

// ───────────────────────── DOM ─────────────────────────

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' || k === 'disabled' || k === 'hidden' || k === 'open') (n as unknown as Record<string, unknown>)[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
function fill(n: Element, ...kids: Kid[]): void { n.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false)); }
const visible = () => (document as { visibilityState?: string }).visibilityState !== 'hidden';

// 한 번 만든 요소의 문구·속성은 언어가 바뀌면 다시 칠한다 (요소를 새로 만들지 않으므로 입력값·포커스가 남는다)
const painters: (() => void)[] = [];
function paint(f: () => void): void { painters.push(f); f(); }
function tx<E extends HTMLElement>(el: E, f: () => string): E { paint(() => { el.textContent = f(); }); return el; }
function ta<E extends HTMLElement>(el: E, attr: string, f: () => string): E { paint(() => { el.setAttribute(attr, f()); }); return el; }
/** 다시 그려지는 단추는 data-key 로 이어 받아 포커스를 되돌린다 */
function keepFocus(draw: (keyed: Map<string, HTMLElement>) => void): void {
  const a = document.activeElement as HTMLElement | null;
  const key = a && typeof a.getAttribute === 'function' ? a.getAttribute('data-key') : null;
  const keyed = new Map<string, HTMLElement>();
  draw(keyed);
  const next = key ? keyed.get(key) : undefined;
  if (next && next !== a) next.focus();
}

function langSwitch(after: () => void): HTMLElement {
  const btns = LANGS.map(l => h('button', { type: 'button', class: 'ax-lang-btn', lang: l, 'aria-label': LANG_NAME[l], onclick: () => setLang(l, after) }, l.toUpperCase()));
  paint(() => { LANGS.forEach((l, i) => btns[i].setAttribute('aria-pressed', String(l === lang))); });
  return ta(h('div', { class: 'ax-lang', role: 'group' }, ...btns), 'aria-label', () => T().language);
}
function setLang(l: Lang, after: () => void): void {
  if (l === lang) return;
  lang = l;
  persistLang();
  for (const p of painters) p();
  after();
}
function header(sub: () => string, after: () => void): HTMLElement {
  return h('header', { class: 'ax-top' },
    ta(h('a', { class: 'ax-brand' }, 'Cloudbite'), 'href', () => withLang(CONSOLE_PATH)),
    h('div', { class: 'ax-top-side' }, tx(h('span'), sub), langSwitch(after)));
}
function docLang(title: () => string): void {
  paint(() => { document.documentElement.lang = lang; document.title = title(); });
}
function counter(inp: HTMLInputElement | HTMLTextAreaElement, max: number): HTMLElement {
  const c = h('span', { class: 'ax-count', 'aria-hidden': 'true' });
  const upd = () => { c.textContent = `${inp.value.length} / ${max}`; };
  inp.addEventListener('input', upd); upd();
  return c;
}
function pill(s: AccessStatus): HTMLElement { return h('span', { class: `ax-pill s-${s}` }, T().status[s]); }

// ───────────────────────── 방문자: 요청 + 상태 ─────────────────────────

function visitorPage(root: HTMLElement): void {
  const V = {
    phase: 'loading' as 'loading' | 'ready' | 'error',
    session: null as CloudbiteAccessSession | null,
    error: null as Msg | null, submitting: false, showForm: false, pollFails: 0, formErrors: [] as Msg[],
  };
  let timer = 0, checking = false;
  docLang(() => T().requestTitle);

  const nameIn = h('input', { id: 'ax-name', type: 'text', maxlength: LIMIT.name, autocomplete: 'name', required: true });
  const purposeIn = h('textarea', { id: 'ax-purpose', rows: 4, maxlength: LIMIT.purpose, required: true });
  const submitBtn = h('button', { type: 'submit', class: 'ax-button primary' });
  const formMsg = h('div', { class: 'ax-msg', role: 'alert' });
  const form = ta(h('form', { class: 'ax-form', novalidate: true },
    h('div', { class: 'ax-field' }, tx(h('label', { for: 'ax-name' }), () => T().nameLabel), nameIn, counter(nameIn, LIMIT.name)),
    h('div', { class: 'ax-field' }, tx(h('label', { for: 'ax-purpose' }), () => T().purposeLabel), purposeIn, counter(purposeIn, LIMIT.purpose),
      tx(h('p', { class: 'ax-help' }), () => T().purposeHelp)),
    formMsg, h('div', { class: 'ax-actions' }, submitBtn)), 'aria-label', () => T().formAria);
  form.addEventListener('submit', ev => { ev.preventDefault(); void submit(); });
  const statusBox = h('div', { class: 'ax-status', 'aria-live': 'polite' });
  const panel = h('section', { class: 'ax-panel', 'aria-labelledby': 'ax-request-h' }, tx(h('h2', { id: 'ax-request-h' }), () => T().yourRequest), statusBox, form);
  const step = (f: (d: Dict) => string[]) => h('li', null, tx(h('strong'), () => f(T())[0]), tx(h('span'), () => f(T())[1]));

  root.replaceChildren(header(() => T().visitorSub, () => render()),
    h('main', { class: 'ax-main' },
      tx(h('h1'), () => T().requestH1),
      tx(h('p', { class: 'ax-lead' }), () => T().requestLead),
      h('div', { class: 'ax-grid' }, panel,
        h('section', { class: 'ax-steps', 'aria-labelledby': 'ax-how' }, tx(h('h2', { id: 'ax-how' }), () => T().nextH),
          h('ol', null, step(d => d.step1), step(d => d.step2), step(d => d.step3)),
          tx(h('p', { class: 'ax-note' }), () => T().requestNote)))));
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
      if (s) { V.session = s; V.phase = 'ready'; V.error = null; V.pollFails = 0; }
      else { V.pollFails++; V.error = () => T().statusOdd; if (!V.session) V.phase = 'error'; }
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
    const r = await postJSON(`${API}/requests`, { name, purpose });
    V.submitting = false;
    if (!r.ok) { V.formErrors = [visitorError(r)]; render(); if (r.status === 409) void check(); return; }
    const s = normalizeSession(r.body);
    if (!s || !s.request) { V.formErrors = [() => T().acceptedOdd]; render(); return; }
    V.session = s; V.phase = 'ready'; V.showForm = false; V.formErrors = []; V.pollFails = 0; V.error = null;
    render(); schedule();
  }

  function render(): void {
    const now = Date.now(), d = T();
    const req = V.session?.request ?? null;
    const st = req ? effectiveStatus(req, now) : null;
    keepFocus(keyed => {
      const btn = (key: string, label: string, onclick: () => void) => { const b = h('button', { type: 'button', class: 'ax-button', 'data-key': key, onclick }, label); keyed.set(key, b); return b; };
      const kids: Kid[] = [];
      if (V.phase === 'loading') kids.push(h('p', { class: 'ax-help' }, d.checking));
      else if (V.phase === 'error') kids.push(h('p', { class: 'ax-warn' }, V.error ? V.error() : ''), btn('check', d.checkAgain, () => { V.pollFails = 0; V.phase = 'loading'; render(); void check(); }));
      else if (req && st) {
        kids.push(h('div', { class: 'ax-req-head' }, pill(st), h('strong', { class: 'ax-req-name' }, req.name)), h('p', { class: 'ax-purpose' }, req.purpose));
        if (st === 'pending') {
          kids.push(h('p', null, d.pendingP), h('p', { class: 'ax-help' }, d.pendingExpires(clock(req.expiresAt), remaining(req.expiresAt, now))));
        } else if (st === 'approved') {
          const left = Math.max(0, req.maxProjects - req.usedProjects);
          kids.push(h('p', { class: 'ax-ok' }, d.approvedOk),
            h('ul', { class: 'ax-facts' },
              h('li', null, d.sessionEnds(clock(req.expiresAt), remaining(req.expiresAt, now))),
              h('li', null, d.projectsLeft(left, req.maxProjects)),
              h('li', null, d.expertsPer(req.maxExperts))),
            h('p', null, d.approvedHow),
            h('a', { class: 'ax-button primary', href: withLang(CONSOLE_PATH) }, d.continueBtn));
        } else {
          kids.push(h('p', { class: 'ax-warn' }, st === 'denied' ? d.deniedP : st === 'revoked' ? d.revokedP : d.expiredP));
          if (!V.showForm) kids.push(btn('new', d.sendNew, () => { V.showForm = true; render(); nameIn.focus(); }));
        }
        if (V.error) {
          const e = V.error();
          kids.push(h('p', { class: 'ax-warn' }, V.pollFails >= MAX_POLL_FAILS ? d.stopped(e) : d.retrying(e)),
            V.pollFails >= MAX_POLL_FAILS ? btn('check', d.checkAgain, () => { V.pollFails = 0; V.error = null; render(); void check(); }) : null);
        }
      } else kids.push(h('p', { class: 'ax-help' }, d.intro));
      fill(statusBox, ...kids);
    });
    const terminal = !!st && st !== 'pending' && st !== 'approved';
    form.hidden = V.phase !== 'ready' || (!!req && !(terminal && V.showForm));
    nameIn.disabled = purposeIn.disabled = submitBtn.disabled = V.submitting;
    submitBtn.textContent = V.submitting ? d.sending : d.submit;
    fill(formMsg, ...V.formErrors.map(m => h('p', null, m())));
  }

  render();
  void check();
}

// ───────────────────────── 주인: 로그인 + 요청함 ─────────────────────────

function ownerPage(root: HTMLElement): void {
  // 운영자·설정 링크는 화면·요청보다 먼저 지운다
  const handoff = takeHandoffLink();
  const link = handoff.operator;
  const O = {
    /** 서버 쿠키 세션: checking(부팅 확인 중) · in · out · unknown(확인 실패) */
    auth: 'checking' as 'checking' | 'in' | 'out' | 'unknown',
    hasCredentials: true,
    authBusy: '' as '' | 'login' | 'logout' | 'register',
    authMsg: null as Msg | null, authMsgKind: 'warn' as 'ok' | 'warn',
    token: link.token,
    rows: [] as CloudbiteAccessRequest[],
    phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: (link.present && !link.token ? () => T().operatorMalformed : null) as Msg | null,
    notice: null as Msg | null, noticeKind: 'ok' as 'ok' | 'warn',
    busy: new Set<string>(),
    loadedAt: 0,
    autoApprove: null as boolean | null,
    policyBusy: false,
  };
  // gen: 자격 증명이 바뀔 때마다 올린다 — 그 전에 떠난 응답은 화면·상태를 바꾸지 못한다. authSeq: 로그인 상태 확인·로그인·로그아웃 순서
  let gen = 0, loadSeq = 0, authSeq = 0, timer = 0, loading = false;
  docLang(() => T().ownerTitle);

  // 로그인 영역: 단추는 한 번 만들어 두고 보이기만 바꾼다 (5초 갱신에도 포커스가 남는다)
  const authText = h('p');
  const authHelp = h('p', { class: 'ax-help' });
  const signInBtn = h('button', { type: 'button', class: 'ax-button primary', onclick: () => { void login(); } });
  const logoutBtn = h('button', { type: 'button', class: 'ax-button', onclick: () => { void logout(); } });
  const retryBtn = tx(h('button', { type: 'button', class: 'ax-button', onclick: () => { void checkSession(); } }), () => T().tryAgain);
  const registerLink = ta(tx(h('a', { class: 'ax-button' }), () => T().registerLink), 'href', () => withLang(REGISTER_PATH));
  const authMsgBox = h('div', { class: 'ax-msg', 'aria-live': 'polite' });
  // 첫 키 등록: 등록된 키가 없고 로그인 전일 때만 보인다. 설정 토큰은 이 입력칸(메모리)에만 있다
  const setupIn = h('input', { id: 'ax-setup', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  setupIn.value = handoff.setup.token;
  const registerBtn = h('button', { type: 'submit', class: 'ax-button primary' });
  const enrollForm = ta(h('form', { class: 'ax-form ax-tokenform ax-enroll', novalidate: true },
    h('div', { class: 'ax-field' }, tx(h('label', { for: 'ax-setup' }), () => T().setupLabel), setupIn,
      tx(h('p', { class: 'ax-help' }), () => T().setupHelp)),
    h('div', { class: 'ax-actions' }, registerBtn)), 'aria-label', () => T().registerBtn);
  enrollForm.addEventListener('submit', ev => { ev.preventDefault(); void register(); });
  const authPanel = h('section', { class: 'ax-panel ax-auth', 'aria-labelledby': 'ax-auth-h' },
    tx(h('h2', { id: 'ax-auth-h' }), () => T().signInH), authText, authHelp, enrollForm, authMsgBox,
    h('div', { class: 'ax-actions' }, signInBtn, logoutBtn, retryBtn, registerLink));

  const tokenIn = h('input', { id: 'ax-token', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  ta(tokenIn, 'placeholder', () => T().tokenLabel);
  tokenIn.value = O.token;
  const loadBtn = tx(h('button', { type: 'submit', class: 'ax-button primary' }), () => T().useToken);
  const clearBtn = tx(h('button', { type: 'button', class: 'ax-button', onclick: () => clearToken() }), () => T().clearToken);
  const refreshBtn = tx(h('button', { type: 'button', class: 'ax-button', onclick: () => { void load(); } }), () => T().refresh);
  const tokenForm = ta(h('form', { class: 'ax-form ax-tokenform', novalidate: true },
    h('div', { class: 'ax-field' }, tx(h('label', { for: 'ax-token' }), () => T().tokenLabel), tokenIn,
      tx(h('p', { class: 'ax-help' }), () => T().tokenHelp)),
    h('div', { class: 'ax-actions' }, loadBtn, clearBtn)), 'aria-label', () => T().tokenLabel);
  tokenForm.addEventListener('submit', ev => { ev.preventDefault(); useToken(); });
  tokenIn.addEventListener('input', () => { render(); });
  const advanced = h('details', { class: 'ax-advanced', open: !!(link.present || link.token) },
    tx(h('summary'), () => T().advanced), tokenForm);
  const state = h('div', { class: 'ax-state', role: 'status' });
  const msg = h('div', { class: 'ax-msg', 'aria-live': 'polite' });
  const list = ta(h('ul', { class: 'ax-list' }), 'aria-label', () => T().listAria);
  const policyState = h('p', { class: 'ax-help', role: 'status' });
  const policyBtn = ta(h('button', { type: 'button', class: 'ax-button', role: 'switch', onclick: () => { void togglePolicy(); } }), 'aria-label', () => T().autoH);
  const policyPanel = h('section', { class: 'ax-panel ax-policy', 'aria-labelledby': 'ax-policy-h' },
    h('div', { class: 'ax-inbox-head' }, tx(h('h2', { id: 'ax-policy-h' }), () => T().autoH), policyBtn),
    policyState, tx(h('p', { class: 'ax-help' }), () => T().autoHelp));

  root.replaceChildren(header(() => T().ownerSub, () => render()),
    h('main', { class: 'ax-main' },
      tx(h('h1'), () => T().ownerH1),
      tx(h('p', { class: 'ax-lead' }), () => T().ownerLead),
      authPanel,
      policyPanel,
      h('section', { class: 'ax-panel', 'aria-labelledby': 'ax-inbox-h' },
        h('div', { class: 'ax-inbox-head' }, tx(h('h2', { id: 'ax-inbox-h' }), () => T().inboxH), state, refreshBtn), msg, list),
      advanced,
      h('p', { class: 'ax-note' },
        ta(tx(h('a'), () => T().visitorForm), 'href', () => withLang(REQUEST_PATH)), ' · ',
        ta(tx(h('a'), () => T().consoleLink), 'href', () => withLang(CONSOLE_PATH)), ' · ',
        ta(tx(h('a'), () => T().historyLink), 'href', () => withLang('/cloudbite/history')))));
  document.addEventListener('visibilitychange', () => { if (visible() && creds() && O.phase === 'ready' && !timer && !loading) void load(); });

  /** 명시한 토큰이 있으면 그것만 쓴다 (거부돼도 쿠키로 몰래 넘어가지 않는다). 없으면 로그인된 쿠키 */
  function creds(): { via: Via; headers: Record<string, string> } | null {
    if (O.token) return { via: isOperatorToken(O.token) ? 'operator' : 'admin', headers: { 'x-admin-token': O.token } };
    return O.auth === 'in' ? { via: 'key', headers: {} } : null;
  }
  /** 누른 단추가 숨겨지면 포커스가 갈 곳을 잃는다 — 그 단추(또는 아무 데도 없을 때)만 짝 단추로 옮긴다 */
  const focusWasOn = (b: HTMLElement) => { const a = document.activeElement; return !a || a === b || a === document.body; };
  function stopPoll(): void { clearTimeout(timer); timer = 0; }
  function schedule(): void {
    stopPoll();
    if (creds() && O.phase === 'ready' && visible() && O.authBusy !== 'logout') timer = setTimeout(() => { timer = 0; void load(); }, POLL_MS) as unknown as number;
  }
  /** 자격 증명이 바뀌었다: 진행 중 응답을 버리고 목록을 비운다 */
  function resetInbox(): void {
    gen++; loadSeq++; stopPoll(); loading = false;
    O.rows = []; O.phase = 'idle'; O.error = null; O.notice = null; O.busy.clear(); O.loadedAt = 0;
    O.autoApprove = null; O.policyBusy = false;
  }
  /** 쿠키 세션이 서버에서 끝났다 (다른 탭 로그아웃·만료) */
  function signedOut(): void {
    authSeq++; resetInbox();
    O.auth = 'out'; O.hasCredentials = true; O.authBusy = '';
    O.authMsgKind = 'warn'; O.authMsg = () => T().signedOutElsewhere;
    render();
  }

  /** note: 확인이 끝난 뒤 보일 안내 (설정 링크 오류·등록 완료) */
  async function checkSession(note: { msg: Msg; kind: 'ok' | 'warn' } | null = null): Promise<void> {
    const s = ++authSeq; // 진행 중이던 로그인·등록은 이것으로 버려진다
    O.auth = 'checking'; O.authBusy = ''; O.authMsg = null; render();
    const r = await call(`${OWNER_API}/session`);
    if (s !== authSeq) return; // 그 사이 로그인·로그아웃이 있었다
    const sess = r.ok ? normalizeOwnerSession(r.body) : null;
    if (!sess) {
      O.auth = 'unknown'; O.authMsgKind = 'warn';
      const base: Msg = r.ok ? () => T().sessionFailed : (() => { const f = failure(r, () => ''); return () => `${T().sessionFailed} ${f()}`; })();
      O.authMsg = note ? () => `${note.msg()} ${base()}` : base;
      render(); return;
    }
    O.auth = sess.authenticated ? 'in' : 'out'; O.hasCredentials = sess.hasCredentials;
    if (note) { O.authMsg = note.msg; O.authMsgKind = note.kind; }
    // 등록할 수 없는 상태면 설정 토큰을 메모리에 남기지 않는다
    if (O.hasCredentials && setupIn.value) {
      setupIn.value = '';
      if (!note) { O.authMsg = () => T().setupUnused; O.authMsgKind = 'warn'; }
    }
    render();
    if (O.auth === 'in' && !O.token) void load();
  }

  /** 첫 보안 키 등록. 단추를 눌렀을 때만 시작하고, 성공해도 로그인으로 치지 않는다 — 로그인은 따로 누른다 */
  async function register(): Promise<void> {
    if (O.authBusy || O.auth !== 'out' || O.hasCredentials) return;
    O.authMsgKind = 'warn';
    const setup = setupIn.value.trim();
    if (!setup) { O.authMsg = () => T().setupMissing; render(); setupIn.focus(); return; }
    if (!SETUP_TOKEN.test(setup)) { O.authMsg = () => T().setupInvalid; render(); setupIn.focus(); return; }
    if (!webauthnAvailable('create')) { O.authMsg = () => T().regUnsupported; render(); return; }
    const s = ++authSeq;
    O.authBusy = 'register'; O.authMsg = null; render();
    const done = (m: Msg) => { if (s !== authSeq) return; O.authBusy = ''; O.authMsgKind = 'warn'; O.authMsg = m; render(); };
    const opts = await postJSON('/api/register/options', { setup });
    if (s !== authSeq) return;
    if (!opts.ok) { const f = failure(opts, d => d.regRejected(opts.status)); done(() => `${T().regStartFailed} ${f()}`); return; }
    const publicKey = creationOptions(opts.body);
    if (!publicKey) { done(() => T().regOdd); return; }
    let cred: Attestation | null;
    try {
      cred = await (navigator.credentials.create({ publicKey }) as Promise<unknown>) as Attestation | null;
    } catch (e) { done(registerError(e)); return; }
    if (s !== authSeq) return;
    if (!cred || !isObj(cred.response)) { done(() => T().regCancelled); return; }
    let response: Record<string, unknown>;
    try { response = attestationJSON(cred); } catch { done(() => T().regFailed); return; }
    const r = await postJSON('/api/register/verify', { setup, response, label: 'Cloudbite owner key' });
    if (s !== authSeq) return;
    if (!r.ok) { done(failure(r, d => d.regRejected(r.status))); return; }
    if (!isObj(r.body) || r.body.ok !== true) { done(() => T().regOdd); return; }
    // 등록됨: 토큰을 지우고 서버에 상태를 다시 묻는다. 로그인 여부는 그 답만 따른다
    setupIn.value = '';
    const refocus = focusWasOn(registerBtn) || document.activeElement === setupIn;
    O.authBusy = '';
    await checkSession({ msg: () => T().registered, kind: 'ok' });
    if (refocus && !signInBtn.hidden) signInBtn.focus();
  }

  async function login(): Promise<void> {
    if (O.authBusy || O.auth === 'in') return;
    O.authMsgKind = 'warn';
    if (!webauthnAvailable()) { O.authMsg = () => T().unsupported; render(); return; }
    const s = ++authSeq;
    O.authBusy = 'login'; O.authMsg = null; render();
    const done = (m: Msg | null) => { if (s !== authSeq) return; O.authBusy = ''; O.authMsg = m; render(); };
    const opts = await postJSON(`${OWNER_API}/options`, {});
    if (s !== authSeq) return;
    if (!opts.ok) { const f = failure(opts, () => ''); done(() => `${T().optionsFailed} ${f()}`); return; }
    const publicKey = requestOptions(opts.body);
    if (!publicKey) { done(() => T().loginOdd); return; }
    let cred: Assertion | null;
    try {
      cred = await (navigator.credentials.get({ publicKey }) as Promise<unknown>) as Assertion | null;
    } catch (e) { done(keyError(e)); return; }
    if (s !== authSeq) return;
    if (!cred || !isObj(cred.response)) { done(() => T().cancelled); return; }
    let response: Record<string, unknown>;
    try { response = assertionJSON(cred); } catch { done(() => T().keyFailed); return; }
    const r = await postJSON(`${OWNER_API}/login`, { response });
    if (s !== authSeq) return;
    if (!r.ok) { done(failure(r, d => d.loginRejected(r.status))); return; }
    const sess = normalizeOwnerSession(r.body);
    if (!sess || !sess.authenticated) { done(() => T().loginOdd); return; }
    if (!O.token) resetInbox(); // 메모리 토큰이 있으면 그 목록·조회는 그대로 둔다
    O.auth = 'in'; O.hasCredentials = true;
    done(null);
    if (!O.token) void load();
    if (focusWasOn(signInBtn)) logoutBtn.focus();
  }

  /** 명시적 로그아웃: 서버 쿠키 세션과 메모리 토큰을 함께 끝낸다. 서버가 확인하기 전에는 로그아웃했다고 하지 않는다 */
  async function logout(): Promise<void> {
    if (O.authBusy) return;
    const s = ++authSeq;
    O.authBusy = 'logout'; O.authMsg = null; stopPoll(); render();
    const r = await postJSON(`${OWNER_API}/logout`, {});
    if (s !== authSeq) return;
    if (r.ok && isObj(r.body) && r.body.authenticated === false) {
      resetInbox();
      O.token = ''; tokenIn.value = '';
      O.auth = 'out'; O.authBusy = ''; O.authMsgKind = 'ok'; O.authMsg = () => T().loggedOut;
      render();
      if (focusWasOn(logoutBtn)) signInBtn.focus();
      return;
    }
    O.authBusy = ''; O.authMsgKind = 'warn';
    O.authMsg = r.ok ? () => T().logoutOdd : (() => { const f = failure(r, () => ''); return () => `${T().logoutFailed} ${f()}`; })();
    render(); schedule();
  }

  function useToken(): void {
    const t = tokenIn.value.trim();
    if (!t) return;
    resetInbox();
    O.token = t;
    render(); void load();
  }
  /** 토큰만 지운다 — 로그아웃이 아니다. 쿠키로 로그인돼 있으면 그 세션으로 요청함을 다시 연다 */
  function clearToken(): void {
    resetInbox();
    O.token = ''; tokenIn.value = '';
    render(); tokenIn.focus();
    if (O.auth === 'in') void load();
  }

  async function load(): Promise<void> {
    const c = creds();
    if (!c || loading) return;
    if (c.via === 'operator' && !OPERATOR_TOKEN.test(O.token)) { O.phase = 'error'; O.error = () => T().operatorTokenMalformed; render(); return; }
    const g = gen, seq = ++loadSeq;
    loading = true; stopPoll();
    if (O.phase !== 'ready') O.phase = 'loading';
    render();
    const r = await call(`${API}/requests`, { headers: c.headers });
    if (g !== gen) return;
    loading = false;
    if (seq !== loadSeq) { schedule(); return; } // 승인·거절 뒤라면 그 전에 떠난 목록은 버린다
    if (!r.ok) {
      if ((r.status === 401 || r.status === 403) && c.via === 'key') { signedOut(); return; }
      O.error = ownerError(r, c.via);
      // 거부된 토큰은 다시 묻지 않는다. 일시 오류면 마지막 목록을 두고 계속 확인한다
      if (r.status === 401 || r.status === 403) { O.phase = 'error'; O.rows = []; }
      else if (O.phase !== 'ready') O.phase = 'error';
      render(); schedule(); return;
    }
    const raw = isObj(r.body) && Array.isArray(r.body.requests) ? r.body.requests : null;
    if (!raw) { O.error = () => T().inboxOdd; if (O.phase !== 'ready') O.phase = 'error'; render(); schedule(); return; }
    O.rows = raw.slice(0, 200).map(normalizeRequest).filter((x): x is CloudbiteAccessRequest => x !== null);
    if (!O.policyBusy) O.autoApprove = isObj(r.body) && typeof r.body.autoApprove === 'boolean' ? r.body.autoApprove : null;
    O.phase = 'ready'; O.error = null; O.loadedAt = Date.now();
    render(); schedule();
  }

  async function togglePolicy(): Promise<void> {
    const c = creds();
    if (!c || O.policyBusy || O.autoApprove === null || O.authBusy === 'logout') return;
    const g = gen, target = !O.autoApprove;
    O.policyBusy = true; O.notice = null; render();
    const r = await postJSON(`${API}/policy`, { autoApprove: target }, c.headers);
    if (g !== gen) return;
    O.policyBusy = false;
    loadSeq++; // A list started before this save must not overwrite the new policy.
    if (!r.ok || !isObj(r.body) || r.body.autoApprove !== target) {
      if ((r.status === 401 || r.status === 403) && c.via === 'key') { signedOut(); return; }
      O.autoApprove = null; O.noticeKind = 'warn'; O.notice = () => T().autoFailed;
      render(); void load(); return;
    }
    O.autoApprove = target;
    O.noticeKind = 'ok'; O.notice = () => target ? T().autoSavedOn : T().autoSavedOff;
    render(); schedule();
  }

  async function act(row: CloudbiteAccessRequest, action: 'approve' | 'deny' | 'revoke'): Promise<void> {
    const c = creds();
    if (O.busy.has(row.id) || !c || O.authBusy === 'logout') return;
    const g = gen;
    O.busy.add(row.id); O.notice = null; render();
    const r = await postJSON(`${API}/requests/${encodeURIComponent(row.id)}/${action}`, {}, c.headers);
    if (g !== gen) return;
    O.busy.delete(row.id);
    if (!r.ok) {
      if ((r.status === 401 || r.status === 403) && c.via === 'key') { signedOut(); return; }
      const e = ownerError(r, c.via);
      O.noticeKind = 'warn'; O.notice = () => T().couldNot(action, row.name, e());
      if (r.status === 401 || r.status === 403) { O.phase = 'error'; O.error = e; O.rows = []; stopPoll(); }
      render();
      if (r.status === 404 || r.status === 409) void load();
      return;
    }
    const next = normalizeRequest(r.body);
    if (!next || next.id !== row.id) { O.noticeKind = 'warn'; O.notice = () => T().answerOdd; render(); void load(); return; }
    loadSeq++; // 이 응답 전에 떠난 목록 조회는 버린다
    O.rows = O.rows.map(x => x.id === next.id ? next : x);
    O.noticeKind = 'ok';
    O.notice = () => {
      const d = T();
      return next.status === 'approved' ? d.didApprove(next.name, clock(next.expiresAt))
        : next.status === 'denied' ? d.didDeny(next.name) : next.status === 'revoked' ? d.didRevoke(next.name) : d.nowStatus(next.name, next.status);
    };
    render();
  }

  function rowView(r: CloudbiteAccessRequest, now: number, keyed: Map<string, HTMLElement>): HTMLElement {
    const d = T(), st = effectiveStatus(r, now);
    const busy = O.busy.has(r.id) || O.authBusy === 'logout';
    const btn = (label: string, action: 'approve' | 'deny' | 'revoke', cls: string) => {
      const key = `${action}:${r.id}`;
      const b = h('button', { type: 'button', class: `ax-button ${cls}`, disabled: busy, 'data-action': action, 'data-id': r.id, 'data-key': key, onclick: () => { void act(r, action); } }, O.busy.has(r.id) ? d.working : label);
      keyed.set(key, b);
      return b;
    };
    const actions: Kid[] = st === 'pending' ? [btn(d.approve, 'approve', 'primary'), btn(d.deny, 'deny', 'danger')] : st === 'approved' ? [btn(d.revoke, 'revoke', 'danger')] : [];
    const meta = [d.requested(clock(r.createdAt))];
    if (st === 'pending') meta.push(d.requestExpires(clock(r.expiresAt), remaining(r.expiresAt, now)));
    else if (st === 'approved') meta.push(d.sessionEndsRow(clock(r.expiresAt), remaining(r.expiresAt, now)));
    if (r.status === 'approved' || r.status === 'revoked' || r.usedProjects > 0) meta.push(d.used(r.usedProjects, r.maxProjects), d.upTo(r.maxExperts));
    return h('li', { class: `ax-row s-${st}`, 'data-id': r.id },
      h('div', { class: 'ax-req-head' }, pill(st), h('strong', { class: 'ax-req-name' }, r.name || d.noName)),
      h('p', { class: 'ax-purpose' }, r.purpose || d.noPurpose),
      h('p', { class: 'ax-help' }, meta.join(' · ')),
      actions.length ? h('div', { class: 'ax-actions' }, ...actions) : null);
  }

  function render(): void {
    const now = Date.now(), d = T();
    // 로그인 영역
    const out = O.auth === 'out';
    authText.textContent = O.auth === 'checking' ? d.sessionChecking : O.auth === 'in' ? d.signedIn
      : O.auth === 'unknown' ? '' : O.hasCredentials ? d.signInLead : d.noKeyH;
    authText.className = O.auth === 'in' ? 'ax-ok' : out && !O.hasCredentials ? 'ax-strong' : O.auth === 'checking' ? 'ax-help' : '';
    authText.hidden = O.auth === 'unknown';
    authHelp.textContent = O.auth === 'in' ? d.signedInHelp : out ? (O.hasCredentials ? d.keyHint : d.noKeyP) : '';
    authHelp.hidden = !authHelp.textContent;
    signInBtn.hidden = !(out && O.hasCredentials);
    signInBtn.disabled = !!O.authBusy;
    signInBtn.textContent = O.authBusy === 'login' ? d.signingIn : d.signInBtn;
    logoutBtn.hidden = O.auth !== 'in';
    logoutBtn.disabled = !!O.authBusy;
    logoutBtn.textContent = O.authBusy === 'logout' ? d.loggingOut : d.logout;
    retryBtn.hidden = O.auth !== 'unknown';
    registerLink.hidden = !(out && !O.hasCredentials);
    enrollForm.hidden = !(out && !O.hasCredentials);
    registerBtn.disabled = setupIn.disabled = !!O.authBusy;
    registerBtn.textContent = O.authBusy === 'register' ? d.registering : d.registerBtn;
    authPanel.setAttribute('aria-busy', String(!!O.authBusy || O.auth === 'checking'));
    fill(authMsgBox, O.authMsg ? h('p', { class: O.authMsgKind === 'ok' ? 'ax-ok' : 'ax-warn' }, O.authMsg()) : null);
    // 고급: 토큰
    const typed = tokenIn.value.trim();
    loadBtn.disabled = !typed || loading;
    clearBtn.hidden = !O.token && !typed;
    // 요청함
    const c = creds();
    policyPanel.hidden = !c;
    policyBtn.disabled = !c || O.autoApprove === null || O.policyBusy || !!O.authBusy || O.phase !== 'ready';
    policyBtn.textContent = O.policyBusy ? d.autoSaving : O.autoApprove === null ? '—' : O.autoApprove ? 'ON' : 'OFF';
    policyBtn.setAttribute('aria-checked', String(O.autoApprove === true));
    policyBtn.className = `ax-button${O.autoApprove ? ' primary' : ''}`;
    policyPanel.setAttribute('aria-busy', String(O.policyBusy));
    policyState.textContent = O.autoApprove === null ? d.autoUnknown : O.autoApprove ? d.autoOn : d.autoOff;
    refreshBtn.disabled = !c || loading;
    const via = c ? (c.via === 'key' ? d.viaKey : c.via === 'operator' ? d.viaOperator : d.viaAdmin) : '';
    state.textContent = !c ? d.stateSignIn
      : O.phase === 'loading' ? d.stateLoading
        : O.phase === 'ready' ? d.stateReady(O.rows.length, clock(O.loadedAt), via)
          : O.phase === 'error' ? d.stateError : '';
    fill(msg, O.error ? h('p', { class: 'ax-warn' }, O.error()) : null, O.notice ? h('p', { class: O.noticeKind === 'ok' ? 'ax-ok' : 'ax-warn' }, O.notice()) : null);
    keepFocus(keyed => {
      if (O.phase === 'ready' && !O.rows.length) fill(list, h('li', { class: 'ax-empty' }, d.empty));
      else {
        const order: AccessStatus[] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
        const sorted = O.rows.slice().sort((a, b) => order.indexOf(effectiveStatus(a, now)) - order.indexOf(effectiveStatus(b, now)) || b.createdAt - a.createdAt);
        fill(list, ...sorted.map(r => rowView(r, now, keyed)));
      }
    });
  }

  render();
  if (O.token) void load();
  void checkSession(handoff.setup.present && !handoff.setup.token ? { msg: () => T().setupMalformed, kind: 'warn' } : null);
}

// ───────────────────────── 공개 QR 페이지 ─────────────────────────

/** 빌드가 두 언어 블록(data-lang-block)을 정적으로 만든다. 여기서는 고른 언어 하나만 보이고 주소의 ?lang= 만 바꾼다 */
function qrPage(root: HTMLElement): void {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-lang-block]'));
  paint(() => {
    let title = '';
    for (const b of blocks) { const on = b.getAttribute('data-lang-block') === lang; b.hidden = !on; if (on) title = b.getAttribute('data-title') ?? ''; }
    document.documentElement.lang = lang;
    if (title) document.title = title;
  });
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[data-lang-link]'))) {
    a.addEventListener('click', ev => {
      const l = a.getAttribute('data-lang-link');
      if (l !== 'ko' && l !== 'en') return;
      ev.preventDefault();
      setLang(l, () => {
        const target = root.querySelector<HTMLElement>(`[data-lang-block="${l}"] a[data-lang-link="${l}"]`);
        if (target) target.focus();
      });
    });
  }
}

function boot(): void {
  const root = document.getElementById('cb-access');
  if (!root) return;
  const g = globalThis as { location?: Location; navigator?: Navigator };
  lang = pickLang(g.location?.search ?? '', g.navigator?.languages?.[0] ?? g.navigator?.language ?? '');
  const view = root.getAttribute('data-view');
  if (view === 'owner') ownerPage(root); else if (view === 'request') visitorPage(root); else if (view === 'qr') qrPage(root);
}

const CloudbiteAccessCore = { normalizeRequest, normalizeSession, normalizeOwnerSession, effectiveStatus, validateRequest, operatorFragment, handoffFragment, pickLang, requestOptions, assertionJSON, creationOptions, attestationJSON, DICT };
const hook = (globalThis as { __cloudbiteAccessTestHook?: (core: typeof CloudbiteAccessCore) => void }).__cloudbiteAccessTestHook;
if (typeof hook === 'function') hook(CloudbiteAccessCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
