// 강사용 Web Push 핵심 — 의존성 없이 Workers WebCrypto 만 쓴다.
//   암호화: RFC 8291 (aes128gcm, RFC 8188 단일 레코드)   인증: RFC 8292 VAPID (ES256 JWT)
// 이 모듈은 저장·라우팅·재시도를 하지 않는다. 받은 구독/키/페이로드를 검증하고 한 번 보낸 결과만 돌려준다.
// 비밀(VAPID d, 구독 auth)은 반환값·오류 메시지·로그 어디에도 싣지 않는다 (로그 자체를 하지 않는다).

// ---- 상수 ----

/** 허용하는 공식 푸시 서비스 호스트 — 정확히 일치만 (접미사·하위 도메인 불가). */
export const PUSH_ENDPOINT_HOSTS: readonly string[] = Object.freeze([
  'fcm.googleapis.com', // Chrome / Android (Firebase Cloud Messaging)
  'updates.push.services.mozilla.com', // Firefox (Mozilla autopush)
  'web.push.apple.com', // Safari / iOS·iPadOS 홈 화면 웹앱 (Apple Push Notification service)
]);
export const PUSH_ENDPOINT_MAX = 2048;
/** VAPID JWT 의 sub — 클라이언트 입력이 아니라 고정값. */
export const VAPID_SUBJECT = 'https://k.shinick.dev/lab';
/** VAPID JWT 수명(초). RFC 8292 상한 24시간보다 한참 짧게. */
export const VAPID_TOKEN_TTL_SEC = 3600;
/** 평문 상한(바이트). 레코드 하나(rs 4096)에 여유 있게 들어가는 크기. */
export const PUSH_PLAINTEXT_MAX = 1024;
export const PUSH_RECORD_SIZE = 4096;
export const PUSH_TTL_SEC = 60;
/** fetch 하나에 쓰는 최대 시간(응답 헤더 도착까지). 본문은 읽지 않고 취소한다. */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** 알림을 누르면 열리는 유일한 경로. */
export const LAB_PUSH_URL = '/lab';

// ---- 타입 ----

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** 검증된 VAPID 키. privateKey 는 추출 불가 CryptoKey 라 직렬화해도 값이 나오지 않는다. */
export interface VapidKey {
  readonly publicKey: string; // applicationServerKey (base64url, 65바이트 비압축 점) — 비밀 아님
  readonly privateKey: CryptoKey;
}

export interface LabPushPayload {
  title: string;
  body: string;
  url?: typeof LAB_PUSH_URL;
  tag?: string;
}

export type PushSendResult =
  | { outcome: 'accepted'; status: number }
  | { outcome: 'gone'; status: 404 | 410 }
  | { outcome: 'retryable'; status?: number }
  | { outcome: 'failed'; status?: number };

// ---- base64url (정규형만) ----

const B64URL = /^[A-Za-z0-9_-]*$/;

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 패딩 없는 정규 base64url 만 받는다 (남는 비트가 0 이 아니면 거부). 길이가 다르면 null. */
function b64urlDecode(s: unknown, len: number): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== 'string' || s.length !== Math.ceil((len * 4) / 3) || !B64URL.test(s)) return null;
  let bin: string;
  try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); } catch { return null; }
  if (bin.length !== len) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return b64urlEncode(out) === s ? out : null;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- P-256 점 검사 (런타임 importKey 와 별개로 직접 곡선식을 확인) ----

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const toBig = (b: Uint8Array): bigint => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };

function onCurve(x: bigint, y: bigint): boolean {
  if (x >= P256_P || y >= P256_P) return false;
  const p = P256_P;
  return (y * y) % p === (((x * x % p) * x - 3n * x + P256_B) % p + p) % p;
}

/** 비압축 P-256 공개점(65바이트)인지: 0x04 접두, 좌표 범위, 곡선 위. */
function isUncompressedPoint(raw: Uint8Array): boolean {
  return raw.length === 65 && raw[0] === 4 && onCurve(toBig(raw.subarray(1, 33)), toBig(raw.subarray(33)));
}

async function importEcdhPublic(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey | null> {
  if (!isUncompressedPoint(raw)) return null;
  try { return await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []); } catch { return null; }
}

// ---- 구독 ----

/** 공식 푸시 서비스의 정규 https URL 만 통과. 이 함수는 아무것도 가져오지 않는다. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'https:'
    && u.username === '' && u.password === ''
    && u.port === ''
    && u.hash === '' && !endpoint.includes('#')
    && PUSH_ENDPOINT_HOSTS.includes(u.hostname)
    && u.pathname.length > 1
    // 정규화 결과가 입력과 같아야 한다 — 대소문자·공백·백슬래시·점 세그먼트 같은 변형은 거부.
    && u.href === endpoint;
}

/**
 * 브라우저 PushSubscription.toJSON() 결과(또는 같은 모양)를 검증해 정규 레코드로 만든다.
 * expirationTime 등 다른 필드는 버린다 (수명은 서비스가 따로 묶는다). 잘못되면 null.
 */
export async function parsePushSubscription(input: unknown): Promise<PushSubscriptionRecord | null> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };
  if (!isAllowedPushEndpoint(endpoint)) return null;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  const ua = b64urlDecode(p256dh, 65);
  if (!ua || !b64urlDecode(auth, 16)) return null;
  if (!(await importEcdhPublic(ua))) return null;
  return { endpoint, keys: { p256dh: p256dh as string, auth: auth as string } };
}

// ---- VAPID 키 ----

/**
 * 서버 비밀(JSON 문자열 또는 객체) — {kty:'EC', crv:'P-256', x, y, d} — 를 검증해 들여온다.
 * x/y/d 는 정규 base64url 32바이트, d 는 [1, n-1], (x,y) 는 곡선 위, 그리고 d 로 서명한 것을
 * (x,y) 로 검증해 공개키와 개인키가 짝인지 확인한다. 실패하면 null (이유는 싣지 않는다).
 */
export async function importVapidKey(secret: unknown): Promise<VapidKey | null> {
  let jwk: unknown = secret;
  if (typeof secret === 'string') {
    if (secret.length > 1024) return null;
    try { jwk = JSON.parse(secret); } catch { return null; }
  }
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) return null;
  const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
  if (kty !== 'EC' || crv !== 'P-256') return null;
  const xb = b64urlDecode(x, 32), yb = b64urlDecode(y, 32), db = b64urlDecode(d, 32);
  if (!xb || !yb || !db) return null;
  const dn = toBig(db);
  if (dn === 0n || dn >= P256_N) return null;
  const pub = concat(new Uint8Array([4]), xb, yb);
  if (!isUncompressedPoint(pub)) return null;
  try {
    const alg = { name: 'ECDSA', namedCurve: 'P-256' };
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: x as string, y: y as string, d: d as string, ext: false }, alg, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('raw', pub, alg, false, ['verify']);
    const probe = utf8('vapid key pair consistency');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, probe))) return null;
    return Object.freeze({ publicKey: b64urlEncode(pub), privateKey });
  } catch { return null; }
}

/** 클라이언트에 줄 applicationServerKey (비밀 아님). 키가 잘못되면 null. */
export async function vapidPublicKey(secret: unknown): Promise<string | null> {
  return (await importVapidKey(secret))?.publicKey ?? null;
}

/**
 * `Authorization: vapid t=<JWT>, k=<공개키>` 값을 만든다 (RFC 8292 §2–3).
 * aud = 엔드포인트 origin, exp = now + 1시간, sub = 고정 VAPID_SUBJECT. now 는 밀리초.
 */
export async function createVapidAuthorization(endpoint: string, key: VapidKey, now: number): Promise<string | null> {
  if (!isAllowedPushEndpoint(endpoint) || !Number.isFinite(now) || now <= 0) return null;
  const enc = (o: object) => b64urlEncode(utf8(JSON.stringify(o)));
  const signingInput = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TOKEN_TTL_SEC, sub: VAPID_SUBJECT })}`;
  try {
    // WebCrypto ECDSA 서명은 이미 JWS 가 요구하는 r||s (IEEE P1363, 64바이트) 형식이다.
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, utf8(signingInput)));
    if (sig.length !== 64) return null;
    return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${key.publicKey}`;
  } catch { return null; }
}

// ---- 페이로드 ----

const PAYLOAD_TEXT = /^[^\u0000-\u001f\u007f]*$/;
const PAYLOAD_TAG = /^[a-z0-9-]{1,32}$/;

/** 알림 페이로드를 검증해 JSON 바이트로. 링크는 /lab 고정, 짧은 제목·본문만. 잘못되면 null. */
export function encodeLabPushPayload(p: LabPushPayload): Uint8Array<ArrayBuffer> | null {
  if (typeof p !== 'object' || p === null) return null;
  const { title, body, url = LAB_PUSH_URL, tag } = p;
  if (typeof title !== 'string' || title.length < 1 || title.length > 64 || !PAYLOAD_TEXT.test(title)) return null;
  if (typeof body !== 'string' || body.length > 160 || !PAYLOAD_TEXT.test(body)) return null;
  if (url !== LAB_PUSH_URL) return null;
  if (tag !== undefined && (typeof tag !== 'string' || !PAYLOAD_TAG.test(tag))) return null;
  const bytes = utf8(JSON.stringify(tag === undefined ? { title, body, url } : { title, body, url, tag }));
  return bytes.length <= PUSH_PLAINTEXT_MAX ? bytes : null;
}

// ---- RFC 8291 암호화 ----

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

/** 테스트 전용 엔트로피 주입 지점. 운영 경로(encryptWebPush)는 항상 새 임의 값을 쓴다. */
export interface WebPushEntropy {
  salt: Uint8Array<ArrayBuffer>; // 16바이트
  ephemeral: CryptoKeyPair; // ECDH P-256, publicKey 는 raw 로 내보낼 수 있어야 함
}

/**
 * RFC 8291 §3–4 + RFC 8188: 받는 쪽 공개키(p256dh)·auth 로 aes128gcm 본문 하나를 만든다.
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   IKM   = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"||0x00||ua_public||as_public, 32)
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm"||0x00, 16)
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce"||0x00, 12)
 *   body  = salt(16) || rs=4096(u32) || idlen=65 || as_public || AES-GCM(CEK, NONCE, plaintext||0x02)
 * 레코드는 하나뿐이므로 마지막 레코드 구분자 0x02 를 쓰고 추가 패딩은 없다. 실패하면 고정 메시지로 throw.
 */
export async function encryptWebPushWithEntropy(subscription: PushSubscriptionRecord, plaintext: Uint8Array, entropy: WebPushEntropy): Promise<Uint8Array<ArrayBuffer>> {
  if (!(plaintext instanceof Uint8Array) || plaintext.length > PUSH_PLAINTEXT_MAX) throw new Error('web push: payload too large');
  const uaRaw = b64urlDecode(subscription?.keys?.p256dh, 65);
  const auth = b64urlDecode(subscription?.keys?.auth, 16);
  const uaKey = uaRaw && auth ? await importEcdhPublic(uaRaw) : null;
  if (!uaRaw || !auth || !uaKey) throw new Error('web push: invalid subscription keys');
  const { salt, ephemeral } = entropy;
  if (!(salt instanceof Uint8Array) || salt.length !== 16) throw new Error('web push: invalid salt');
  try {
    const asRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer);
    // workers-types 는 이 필드를 `$public` 으로 적지만 런타임(WebCrypto 표준) 속성 이름은 `public` 이다.
    const ecdhAlg = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlg, ephemeral.privateKey, 256));
    const ikm = await hkdf(auth, ecdh, concat(utf8('WebPush: info\0'), uaRaw, asRaw), 32);
    const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, concat(plaintext, new Uint8Array([2]))));
    const header = new Uint8Array(21);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
    header[20] = 65;
    return concat(header, asRaw, ct);
  } catch {
    throw new Error('web push: encryption failed');
  }
}

/** 운영용: 매번 새 임시 ECDH 키쌍과 16바이트 임의 salt 로 암호화한다. */
export async function encryptWebPush(subscription: PushSubscriptionRecord, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return encryptWebPushWithEntropy(subscription, plaintext, { salt: crypto.getRandomValues(new Uint8Array(16)), ephemeral });
}

// ---- 전송 ----

export interface SendPushOptions {
  /** 서버 정책용 오프라인 보관 시간. 기존 손들기 알림 기본값은 60초, 최대 1시간. */
  ttlSeconds?: number;
  now?: number; // 밀리초, 기본 Date.now()
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number; // PUSH_SEND_TIMEOUT_MS 이하로 잘린다
  /**
   * 서비스 내부 전용 허가 확인: 암호화·VAPID 서명이 끝난 뒤, fetch 를 시작하기 바로 앞에 한 번 부른다.
   * true 가 아니거나 throw 하면 fetch 없이 failed. 통과하면 그 뒤 await 없이 fetch 를 시작한다. (HTTP 입력으로 열지 않는다)
   */
  beforeSend?: () => Promise<boolean>;
}

/** 상태 코드 → 고정 분류. 3xx(리다이렉트)는 따라가지 않고 실패로 본다. */
export function classifyPushStatus(status: number): PushSendResult {
  if (status >= 200 && status < 300) return { outcome: 'accepted', status };
  if (status === 404 || status === 410) return { outcome: 'gone', status };
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return { outcome: 'retryable', status };
  return Number.isInteger(status) && status >= 100 && status < 600 ? { outcome: 'failed', status } : { outcome: 'failed' };
}

/**
 * 허용된 엔드포인트 하나에 한 번 POST 한다. 재전송하지 않는다 (재시도는 서비스 outbox 몫).
 * 응답 본문은 읽지 않고 취소한다. 어떤 실패도 throw 하지 않고 고정 결과로 돌려준다.
 *
 * redirect 는 'manual' 이다: Workers fetch 는 redirect:'error' 를 지원하지 않고 TypeError 를 낸다
 * (workerd: "use 'manual' and check the response status code"). 그래서 3xx·opaqueredirect 는 failed 로 처리한다.
 */
export async function sendPush(subscription: unknown, key: VapidKey, payload: LabPushPayload, opts: SendPushOptions = {}): Promise<PushSendResult> {
  const sub = await parsePushSubscription(subscription);
  const body = encodeLabPushPayload(payload);
  if (!sub || !body || !key || typeof key.publicKey !== 'string') return { outcome: 'failed' };
  let encrypted: Uint8Array<ArrayBuffer>;
  try { encrypted = await encryptWebPush(sub, body); } catch { return { outcome: 'failed' }; }
  const authorization = await createVapidAuthorization(sub.endpoint, key, opts.now ?? Date.now());
  if (!authorization) return { outcome: 'failed' };
  if (opts.beforeSend) {
    let ok = false;
    try { ok = (await opts.beforeSend()) === true; } catch { ok = false; }
    if (!ok) return { outcome: 'failed' };
  }

  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || PUSH_SEND_TIMEOUT_MS, 1), PUSH_SEND_TIMEOUT_MS);
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve('timeout'); }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      doFetch(sub.endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          Authorization: authorization,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(typeof opts.ttlSeconds === 'number' && Number.isInteger(opts.ttlSeconds) && opts.ttlSeconds >= 1 && opts.ttlSeconds <= 3600 ? opts.ttlSeconds : PUSH_TTL_SEC),
          Urgency: 'normal',
        },
        body: encrypted,
      }),
      timeout,
    ]);
    if (res === 'timeout') return { outcome: 'retryable' };
    try { res.body?.cancel().catch(() => {}); } catch { /* 본문은 버린다 */ }
    if ((res.type as string) === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return res.status ? { outcome: 'failed', status: res.status } : { outcome: 'failed' };
    return classifyPushStatus(res.status);
  } catch {
    return { outcome: 'retryable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
