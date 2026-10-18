// 공급자 정의. 실제 공급자 목록은 DO 저장소(prov:<id>)에 있고 /admin 이나 kv.ps1 push 로 추가한다.
// 여기 PRESETS 는 자주 쓰는 공급자의 틀이다 — 값(키)만 넣으면 된다.
//
//   upstream : 프록시 대상. /p/<id>/<rest> 가 <upstream>/<rest> 로 간다
//   auth     : upstream 에 진짜 키를 실어 보내는 방식
//   envKey   : 빌린 PC 에서 가짜 토큰을 담을 환경변수
//   envBase  : base URL 환경변수 (basePath 를 붙여 gateway 주소로 채운다)
//   headers  : 비밀 아닌 고정 헤더. gateway 가 upstream 으로 보낼 때 덮어 넣는다 (예: LangSmith 서비스 키의 X-Tenant-Id)
//   kind     : proxy = 저장된 키로 대리 호출
//              openrouter-mint = 저장된 관리 키로 세션마다 $ 한도 서브키를 만들어 대리 호출

export type AuthStyle = 'bearer' | 'xi-api-key' | 'x-api-key';
export const AUTH_STYLES: AuthStyle[] = ['bearer', 'xi-api-key', 'x-api-key'];

export interface ProviderDef {
  id: string;
  label: string;
  kind: 'proxy' | 'openrouter-mint';
  upstream: string;
  auth: AuthStyle;
  envKey: string;
  envBase?: string;
  basePath?: string;
  claude?: boolean; // Claude Code 용 ANTHROPIC_* 줄도 출력 (OpenRouter Anthropic 스킨)
  note?: string;
  labShare?: boolean; // 실습실 수업에 나눠 줄 수 있음 (약관상 공유 가능 여부는 운영자가 판단). proxy 종류만, daytona 는 안 됨
  headers?: Record<string, string>; // 이름은 소문자 x-…
}

export interface Preset extends ProviderDef {
  source: string; // 로컬(User 환경변수)에서 이 값을 읽어올 이름 — kv.ps1 push 가 쓴다
}

export const PRESETS: Preset[] = [
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openrouter-mint', source: 'OPENROUTER_MANAGEMENT_KEY',
    upstream: 'https://openrouter.ai', auth: 'bearer',
    envKey: 'OPENROUTER_API_KEY', envBase: 'OPENROUTER_BASE_URL', basePath: '/api/v1', claude: true,
    note: '관리 키를 저장한다. 세션마다 한도 서브키를 만들고 끝나면 지운다',
  },
  { id: 'groq', label: 'Groq', kind: 'proxy', source: 'GROQ_API_KEY', upstream: 'https://api.groq.com', auth: 'bearer', envKey: 'GROQ_API_KEY', envBase: 'GROQ_BASE_URL', basePath: '' },
  { id: 'hf', label: 'Hugging Face (router)', kind: 'proxy', source: 'HF_TOKEN', upstream: 'https://router.huggingface.co', auth: 'bearer', envKey: 'HF_TOKEN', envBase: 'HF_BASE_URL', basePath: '/v1' },
  { id: 'tavily', label: 'Tavily', kind: 'proxy', source: 'TAVILY_API_KEY', upstream: 'https://api.tavily.com', auth: 'bearer', envKey: 'TAVILY_API_KEY', envBase: 'TAVILY_BASE_URL', basePath: '' },
  { id: 'elevenlabs', label: 'ElevenLabs', kind: 'proxy', source: 'ELEVENLABS_API_KEY', upstream: 'https://api.elevenlabs.io', auth: 'xi-api-key', envKey: 'ELEVENLABS_API_KEY', envBase: 'ELEVENLABS_BASE_URL', basePath: '' },
  { id: 'nebius', label: 'Nebius Token Factory', kind: 'proxy', source: 'NEBIUS_API_KEY', upstream: 'https://api.tokenfactory.nebius.com', auth: 'bearer', envKey: 'NEBIUS_API_KEY', envBase: 'NEBIUS_BASE_URL', basePath: '/v1' },
  { id: 'nvidia', label: 'NVIDIA NIM', kind: 'proxy', source: 'NVIDIA_API_KEY', upstream: 'https://integrate.api.nvidia.com', auth: 'bearer', envKey: 'NVIDIA_API_KEY', envBase: 'NVIDIA_BASE_URL', basePath: '/v1' },
  { id: 'openai', label: 'OpenAI', kind: 'proxy', source: 'OPENAI_API_KEY', upstream: 'https://api.openai.com', auth: 'bearer', envKey: 'OPENAI_API_KEY', envBase: 'OPENAI_BASE_URL', basePath: '/v1' },
  // LangSmith SDK 는 LANGSMITH_ENDPOINT 로 주소를 바꾼다 (x-api-key 헤더). 서비스 키는 X-Tenant-Id 가 있어야 데이터 API 가 열린다 — 올릴 때 workspace 가 하나면 채운다
  { id: 'langsmith', label: 'LangSmith', kind: 'proxy', source: 'LANGSMITH_API_KEY', upstream: 'https://api.smith.langchain.com', auth: 'x-api-key', envKey: 'LANGSMITH_API_KEY', envBase: 'LANGSMITH_ENDPOINT', basePath: '' },
  {
    id: 'daytona', label: 'Daytona', kind: 'proxy', source: 'DAYTONA_API_KEY', upstream: 'https://app.daytona.io/api', auth: 'bearer',
    envKey: 'DAYTONA_API_KEY', envBase: 'DAYTONA_API_URL', basePath: '',
    note: '샌드박스 생성·조회·삭제 같은 API 만 된다. 조직·API 키·계정 관리 API 는 승인 때 따로 켜야 한다. 샌드박스 안 명령 실행(toolbox)은 다른 주소라 안 된다',
  },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** 서브키 발급형(관리 키)이 갈 수 있는 유일한 출처. 앞부분 일치(startsWith)가 아니라 출처 전체가 같아야 한다 */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

/** https 는 늘 허용. devHttp 면 URL 이 정규화한 hostname 이 정확히 localhost·127.0.0.1 인 http 만 추가로 */
function allowedUpstreamProtocol(u: URL, devHttp: boolean) {
  if (u.protocol === 'https:') return true;
  return devHttp && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

/**
 * upstream 주소를 절대 URL 로 풀어 정규형(<origin><path>, 끝 / 없음)으로 돌려준다. 틀리면 null.
 * 사용자 정보(user@)·쿼리·조각(#)·잘못된 % 인코딩·역슬래시·공백은 거부. devHttp 면 http://localhost·127.0.0.1 만 추가로 허용 (가짜 upstream 테스트)
 */
export function canonUpstream(raw: unknown, devHttp = false): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 300) return null;
  if (/[\s\\@?#]/.test(raw) || /[^\x21-\x7e]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (!allowedUpstreamProtocol(u, devHttp)) return null;
  if (!u.hostname || u.hostname.endsWith('.')) return null;
  try { decodeURIComponent(u.pathname); } catch { return null; }
  if (/%(2f|5c|2e)/i.test(u.pathname)) return null; // 인코딩한 / \ . 로 경로를 돌리는 것
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** 서브키 발급형 공급자의 upstream 이 정확히 openrouter.ai 출처인가 (저장된 예전 기록도 이걸로 다시 본다) */
export const isOpenRouterUpstream = (upstream: unknown) => canonUpstream(upstream) === OPENROUTER_ORIGIN;

/** 저장된 키를 그대로 두고(값 없이) 바꾸면 안 되는 것: 진짜 키가 어디로(upstream)·어떻게(auth)·무엇으로(kind) 나가는지 */
export const sameDestination = (a: Pick<ProviderDef, 'upstream' | 'auth' | 'kind'>, b: Pick<ProviderDef, 'upstream' | 'auth' | 'kind'>) =>
  a.upstream === b.upstream && a.auth === b.auth && a.kind === b.kind;

/**
 * Daytona 공급자인가: id 가 daytona 이거나, upstream 호스트가 daytona.io·daytona.work 이거나, Daytona SDK env 이름을 쓴다.
 * 공급자 id 만 보지 않는다 — 직접 입력한 Daytona 정의도 같은 규칙(관리 API 분리·실습실 공유 금지)을 받는다
 */
export function isDaytona(d: Pick<ProviderDef, 'id' | 'upstream'> & Partial<Pick<ProviderDef, 'envKey' | 'envBase'>>) {
  let host = '';
  try { host = new URL(d.upstream).hostname.toLowerCase(); } catch {}
  return d.id === 'daytona' || /(^|\.)daytona\.(io|work)$/.test(host) || d.envKey === 'DAYTONA_API_KEY' || d.envBase === 'DAYTONA_API_URL';
}

/** 실습실에 나눠 줄 수 없는 공급자: 서브키 발급형(따로 처리), Daytona(참가자가 다른 자리 샌드박스를 지울 수 있음) */
export function labShareBlocked(d: Pick<ProviderDef, 'id' | 'kind' | 'upstream'> & Partial<Pick<ProviderDef, 'envKey' | 'envBase'>>) {
  return d.kind !== 'proxy' || isDaytona(d);
}

/**
 * Daytona 조직·계정 관리 API. 공식 OpenAPI(https://www.daytona.io/docs/openapi.json)의 루트 중 계정을 다루는
 * organizations(멤버·역할·한도·초대), api-keys(키 발급·삭제), users(계정) 와, 다른 루트 아래 조직 단위로 붙은
 * audit/organizations/{id}(조직 감사 로그), webhooks/organizations/{id}/…(웹훅 포털·초기화·엔드포인트) 뿐.
 * 모르는 경로를 다 막으면 SDK 데이터 경로(sandbox·snapshots·toolbox·preview·volumes …)가 깨지므로 막지 않는다.
 * (저장소의 Daytona 호출 중 이 밖의 관리 경로는 없다: lab.ts 의 /organizations/<org>/usage 는 게이트웨이 자신이 부르고 프록시를 안 지난다)
 */
const DAYTONA_MGMT = ['organizations', 'api-keys', 'users'];
const DAYTONA_MGMT_NESTED = ['audit', 'webhooks']; // 그 다음 조각이 organizations 일 때만
/** 조각이 루트 m 이거나 m 뒤에 . 같은 구분자가 붙은 것 (organizations.json) — organizations-x 같은 다른 이름은 아니다 */
const segIs = (s: string | undefined, m: string) => !!s && (s === m || (s.startsWith(m) && !/[a-z0-9_-]/.test(s[m.length])));
/**
 * 경로를 upstream 이 받아들일 법한 조각으로 보수적으로 푼다: 조각마다 %XX 를 바이트 단위로 안 바뀔 때까지 풀고
 * (proxyTarget 이 4번 넘게 바뀌는 조각은 이미 거부), ';' 매개변수를 떼고, 소문자로, 빈 조각·'.' 은 버리고 '..' 은 한 칸 올린다
 */
function looseSegments(pathname: string) {
  const segs: string[] = [];
  for (const raw of pathname.split('/')) {
    let s = raw;
    for (let i = 0; i < 6; i++) {
      const next = s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      if (next === s) break;
      s = next;
    }
    for (const part of s.split(/[/\\]/)) {
      const p = part.split(';')[0].trim().toLowerCase();
      if (!p || p === '.') continue;
      if (p === '..') { segs.pop(); continue; }
      segs.push(p);
    }
  }
  return segs;
}
/** 앞의 api·v<n> 조각만 건너뛴 첫 조각이 관리 루트이거나, audit·webhooks 다음이 organizations 면 관리 API */
function mgmtSegments(segs: string[]) {
  let i = 0;
  while (i < segs.length && /^(api|v\d+)$/.test(segs[i])) i++;
  return DAYTONA_MGMT.some((m) => segIs(segs[i], m)) || (DAYTONA_MGMT_NESTED.some((m) => segIs(segs[i], m)) && segIs(segs[i + 1], 'organizations'));
}
/**
 * 나갈 주소(proxyTarget 이 만든 최종 URL)가 Daytona 관리 API 인가. 최종 경로 전체를 본다 — upstream 경로를 떼어 내고 보면
 * upstream 을 …/api/organizations 로 잡은 직접 정의는 그 아래 모든 경로가 관리 API 가 아닌 것처럼 보인다.
 * upstream 경로 아래 부분만 따로도 본다 (자체 호스팅처럼 앞에 다른 조각이 붙은 base). 둘 중 하나라도 관리면 관리 API.
 * up = canonUpstream 정규형, target = 그 아래 주소 (proxyTarget 이 보장). 못 풀면 관리로 본다
 */
export function daytonaManagementPath(up: string, target: string) {
  let pathname: string, rel: string;
  try {
    pathname = new URL(target).pathname;
    const root = new URL(up).pathname.replace(/\/+$/, '');
    if (root && pathname !== root && !pathname.startsWith(`${root}/`)) return true;
    rel = pathname.slice(root.length);
  } catch { return true; }
  return mgmtSegments(looseSegments(pathname)) || mgmtSegments(looseSegments(rel));
}
/** upstream(base) 자체가 Daytona 관리 API 아래인가 (…/api/organizations, …/api/audit/organizations 같은 직접 정의는 저장하지 않는다) */
export function daytonaManagementBase(up: string) {
  try { return mgmtSegments(looseSegments(new URL(up).pathname)); } catch { return true; }
}
export const labShareable = (d: ProviderDef) => !!d.labShare && !labShareBlocked(d);

/** 입력값이 undefined·빈 문자열이면 preset 값으로 채운 초안 (검증 전). null·false·0 은 입력값 그대로 */
function draftDef(input: Record<string, unknown>, base: Partial<ProviderDef>): ProviderDef {
  const pick = <K extends keyof ProviderDef>(k: K) => (input[k] !== undefined && input[k] !== '' ? input[k] : base[k]) as ProviderDef[K];
  return {
    id: String(pick('id') ?? ''),
    label: String(pick('label') ?? pick('id') ?? '').slice(0, 40),
    kind: pick('kind') === 'openrouter-mint' ? 'openrouter-mint' : 'proxy',
    upstream: String(pick('upstream') ?? '').replace(/\/+$/, ''),
    auth: (pick('auth') ?? 'bearer') as AuthStyle,
    envKey: String(pick('envKey') ?? ''),
    envBase: pick('envBase') ? String(pick('envBase')) : undefined,
    basePath: pick('basePath') ? '/' + String(pick('basePath')).replace(/^\/+|\/+$/g, '') : '',
    claude: !!pick('claude'),
    note: pick('note') ? String(pick('note')).slice(0, 200) : undefined,
    labShare: pick('labShare') === true || undefined,
  };
}

/** 초안을 이 순서로 검증한다. 통과하면 d.upstream 을 정규형으로 고치고 undefined, 틀리면 에러 문자열 */
function validateDef(d: ProviderDef, devHttp: boolean): string | undefined {
  if (!ID_RE.test(d.id)) return 'id 는 소문자·숫자·- 로 24자 이내';
  const up = canonUpstream(d.upstream, devHttp);
  if (!up) return 'upstream 은 https:// 절대 주소여야 합니다 (사용자 정보·쿼리·# 없이)';
  d.upstream = up;
  if (isDaytona(d) && daytonaManagementBase(d.upstream)) return 'Daytona upstream 은 조직·계정 관리 API 경로(organizations·users·api-keys·audit/organizations·webhooks/organizations) 아래로 잡을 수 없습니다';
  if (d.labShare && labShareBlocked(d)) return 'Daytona·OpenRouter(서브키 발급형)는 실습실에 나눠 줄 수 없습니다';
  if (!AUTH_STYLES.includes(d.auth)) return 'auth 가 올바르지 않습니다';
  if (!ENV_RE.test(d.envKey)) return 'envKey 는 대문자 환경변수 이름이어야 합니다';
  if (d.envBase && !ENV_RE.test(d.envBase)) return 'envBase 는 대문자 환경변수 이름이어야 합니다';
  if (d.kind === 'openrouter-mint' && (d.upstream !== OPENROUTER_ORIGIN || d.auth !== 'bearer')) return `openrouter-mint 는 ${OPENROUTER_ORIGIN} (bearer) 전용`;
  return undefined;
}

/** 관리자가 보낸 공급자 정의를 검증·정리한다. 틀리면 에러 문자열. devHttp: dev 전용 — http://localhost upstream 허용 (가짜 upstream 테스트) */
export function normalizeDef(input: Record<string, unknown>, devHttp = false): ProviderDef | string {
  const preset = PRESETS.find((p) => p.id === input.preset);
  const base: Partial<ProviderDef> = preset ? { ...preset } : {};
  const d = draftDef(input, base);
  const h = normHeaders('headers' in input ? input.headers : base.headers);
  if (typeof h === 'string') return h;
  if (h) d.headers = h;
  return validateDef(d, devHttp) ?? d;
}

const HEADER_RE = /^x-[a-z0-9-]{1,40}$/;
const HEADER_BLOCKED = /^x-(api-key|forwarded-.*|real-ip)$/;
/** 고정 헤더: {이름: 값} 또는 "이름: 값" 줄들(또는 ; 구분). 빈 값이면 없앰. 틀리면 에러 문자열 */
export function normHeaders(v: unknown): Record<string, string> | undefined | string {
  if (v == null || v === '') return undefined;
  const pairs: [string, unknown][] = typeof v === 'string'
    ? v.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return [i < 0 ? l : l.slice(0, i), i < 0 ? '' : l.slice(i + 1)]; })
    : typeof v === 'object' ? Object.entries(v as Record<string, unknown>) : [];
  if (!pairs.length) return undefined;
  if (pairs.length > 4) return '고정 헤더는 4개까지';
  const out: Record<string, string> = {};
  for (const [k0, v0] of pairs) {
    const k = String(k0).trim().toLowerCase(), val = String(v0 ?? '').trim();
    if (!HEADER_RE.test(k) || HEADER_BLOCKED.test(k)) return `고정 헤더 이름은 x- 로 시작해야 하고 인증·전달 헤더(x-api-key 등)는 안 됩니다: ${k}`;
    if (!/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(val)) return `고정 헤더 값이 올바르지 않습니다: ${k}`;
    out[k] = val;
  }
  return out;
}

/** upstream 으로 보낼 인증 헤더 */
export function authHeader(style: AuthStyle, key: string): [string, string] {
  if (style === 'xi-api-key') return ['xi-api-key', key];
  if (style === 'x-api-key') return ['x-api-key', key];
  return ['authorization', `Bearer ${key}`];
}

// 빌린 PC 에 붙여넣을 환경변수. 값은 전부 가짜 토큰 + gateway 주소다.
export function envVars(origin: string, token: string, defs: ProviderDef[]) {
  const vars: [string, string][] = [];
  const claude: [string, string][] = [];
  for (const d of defs) {
    vars.push([d.envKey, token]);
    if (d.envBase) vars.push([d.envBase, `${origin}/p/${d.id}${d.basePath ?? ''}`]);
    if (d.claude) claude.push(['ANTHROPIC_BASE_URL', `${origin}/p/${d.id}/api`], ['ANTHROPIC_AUTH_TOKEN', token], ['ANTHROPIC_API_KEY', '']);
  }
  const ps = (v: [string, string][]) => v.map(([k, x]) => `$env:${k}='${x}'`).join('; ');
  const sh = (v: [string, string][]) => v.map(([k, x]) => `export ${k}='${x}'`).join('\n');
  return {
    powershell: ps(vars),
    bash: sh(vars),
    claudePowershell: claude.length ? ps(claude) : null,
    claudeBash: claude.length ? sh(claude) : null,
  };
}

// 실습실 샌드박스 env 에 넣을 공유 공급자 줄. 값은 자리 가짜 토큰 + 게이트웨이 주소뿐 (envVars 와 같은 규칙)
export function labShareEnv(gw: string, token: string, defs: ProviderDef[]) {
  const env: Record<string, string> = {};
  for (const d of defs) {
    env[d.envKey] = token;
    if (d.envBase) env[d.envBase] = `${gw}/p/${d.id}${d.basePath ?? ''}`;
  }
  return env;
}
