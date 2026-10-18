// Cloudbite personal-computer sign-in (phone passkeys). One Durable Object (CLOUDBITE_COMPUTER_ACCESS, getByName
// CB_COMPUTER_ACCESS_OWNER) holds the owner's phone passkeys, personal-computer sessions, one-use WebAuthn challenges and
// one-use pairing links. The session it issues authorizes the owner's personal computer ONLY — owner inbox, vault, admin
// and expert approval never read this cookie or this object. The Worker router owns Origin/CSRF checks, JSON body
// limits and the existing owner check (ownerCookieValid, passed in as legacyOwner); this module never trusts a value
// the browser could choose as authority.
//
// Relying party: the exact public Cloudbite origin, from env.CLOUDBITE_PUBLIC_ORIGIN, only when it equals
// CB_COMPUTER_ORIGIN. workers.dev, the desktop gateway and the request's own Host/Origin are never an RP.
//
// Storage keys (plaintext tokens never stored — only SHA-256 of a domain-separated string):
//   user            stable WebAuthn user handle (32 random bytes, base64url) scoped to this computer
//   cred:<id>       ComputerCredential — public key, counter, transports only
//   sess:<sha256>   ComputerSession — passkey sessions roll for 400 days of idleness; pair-born sessions last 24 h
//   chal:<challenge> ChallengeRecord — one use, 3 minutes, bound to a purpose (and a session for registration)
//   pair:<sha256>   PairingRecord — one use, at most 30 minutes, at most 2 outstanding
import { DurableObject } from 'cloudflare:workers';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Env } from './state';

export const CB_COMPUTER_ACCESS_OWNER = 'owner';
export const CB_COMPUTER_ORIGIN = 'https://cloudbite.shinick.dev';
export const CB_COMPUTER_RP_ID = 'cloudbite.shinick.dev';
export const CB_COMPUTER_URL = `${CB_COMPUTER_ORIGIN}/cloudbite/computer`;
export const CB_PC_COOKIE = '__Host-cb-pc-owner';
export const CB_PC_MAX_CREDENTIALS = 8;
export const CB_PC_MAX_SESSIONS = 8;
export const CB_PC_MAX_CHALLENGES = 16;            // per purpose
export const CB_PC_MAX_PAIRINGS = 2;
export const CB_PC_CHALLENGE_TTL = 3 * 60_000;
export const CB_PC_PAIR_MAX_TTL = 30 * 60_000;
export const CB_PC_PAIR_MIN_TTL = 60_000;
export const CB_PC_SESSION_IDLE = 400 * 24 * 3600_000; // = the browser cookie cap; renewed on use until explicit logout
export const CB_PC_PAIR_SESSION_TTL = 24 * 3600_000;   // enough to register this phone's passkey; never renewed
export const CB_PC_RESPONSE_MAX = 32 * 1024;
const TOUCH_EVERY = 3600_000;

const TOKEN = /^cbpc_[A-Za-z0-9_-]{43}$/;
const PAIR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export type ComputerFail = { ok: false; error: string; status: number };
const fail = (status: number, error: string): ComputerFail => ({ ok: false, error, status });
export const isComputerFail = (x: unknown): x is ComputerFail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

export type ComputerIdentity = { origin: string; rpId: string };
/** Issued only to the router: it goes into Set-Cookie (computerSetCookie), never into browser JSON. */
export type ComputerSessionGrant = { sessionToken: string; cookieMaxAge: number };
export type ComputerSessionView = { ok: true; authenticated: boolean; hasCredentials: boolean; renew: boolean; cookieMaxAge: number };
export type ComputerLoginResult = { ok: true; authenticated: true; hasCredentials: true } & ComputerSessionGrant;
export type ComputerRegisterResult = { ok: true; registered: true; hasCredentials: true } & ComputerSessionGrant;
export type ComputerPairResult = { ok: true; authenticated: true; hasCredentials: boolean } & ComputerSessionGrant;
export type ComputerPairing = { ok: true; token: string; url: string; expiresAt: number };
export type ComputerCredentialView = { id: string; createdAt: number; transports: string[]; backedUp: boolean };

interface ComputerCredential {
  id: string; publicKey: string; counter: number; transports: string[];
  createdAt: number; backedUp: boolean; deviceType: string;
}
interface ComputerSession {
  kind: 'pair' | 'passkey';
  createdAt: number; lastSeen: number; expiresAt: number;
  credentialId?: string; credCreatedAt?: number; // passkey sessions end with the passkey that made them
}
interface ChallengeRecord { purpose: 'reg' | 'login'; createdAt: number; expiresAt: number; bind?: string }
interface PairingRecord { createdAt: number; expiresAt: number }

// ── identity and cookie (pure; used by the router) ──

/** The public Cloudbite RP, or null when CLOUDBITE_PUBLIC_ORIGIN is anything but exactly CB_COMPUTER_ORIGIN. */
export function computerIdentity(env: Pick<Env, 'CLOUDBITE_PUBLIC_ORIGIN'>): ComputerIdentity | null {
  const configured = env.CLOUDBITE_PUBLIC_ORIGIN;
  if (configured !== CB_COMPUTER_ORIGIN) return null;
  try {
    const u = new URL(configured);
    if (u.protocol !== 'https:' || u.origin !== configured || u.hostname !== CB_COMPUTER_RP_ID || u.username || u.password || u.port) return null;
    return { origin: u.origin, rpId: u.hostname };
  } catch { return null; }
}

/** This browser's well-formed personal-computer session token, or null. */
export function computerCookieToken(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== CB_PC_COOKIE) continue;
    const value = part.slice(i + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}
/** Host-only (__Host-: no Domain, Path=/, Secure), HttpOnly, SameSite=Strict. */
export function computerSetCookie(token: string, maxAgeSeconds: number) {
  const age = Math.max(0, Math.floor(maxAgeSeconds));
  return `${CB_PC_COOKIE}=${TOKEN.test(token) ? token : ''}; Path=/; Max-Age=${TOKEN.test(token) ? age : 0}; HttpOnly; Secure; SameSite=Strict`;
}
export const computerClearCookie = () => `${CB_PC_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const sessionHash = (token: string) => sha256Hex(`cloudbite-computer-session-v1|${token}`);
const pairHash = (token: string) => sha256Hex(`cloudbite-computer-pair-v1|${token}`);
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(b as Uint8Array<ArrayBuffer>);
/** Options exactly as the browser receives them over JSON (no undefined members in the RPC result). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── browser JSON: strict shapes (unknown fields are invalid) ──

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const b64s = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && B64URL.test(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > CB_PC_RESPONSE_MAX) return null;
  try { const v: unknown = JSON.parse(text); return isRecord(v) ? v : null; } catch { return null; }
}
function credentialEnvelope(o: Record<string, unknown>, responseKeys: readonly string[]) {
  if (!onlyKeys(o, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'])) return null;
  if (!b64s(o.id, 1366) || o.rawId !== o.id || o.type !== 'public-key' || !isRecord(o.response) || !onlyKeys(o.response, responseKeys)) return null;
  if (o.clientExtensionResults !== undefined && !isRecord(o.clientExtensionResults)) return null;
  if (o.authenticatorAttachment !== undefined && o.authenticatorAttachment !== 'platform' && o.authenticatorAttachment !== 'cross-platform') return null;
  return { id: o.id, response: o.response, clientExtensionResults: (o.clientExtensionResults ?? {}) as Record<string, unknown>, authenticatorAttachment: o.authenticatorAttachment as 'platform' | 'cross-platform' | undefined };
}
export function parseAuthenticationResponse(text: unknown): AuthenticationResponseJSON | null {
  const o = parseJson(text); if (!o) return null;
  const e = credentialEnvelope(o, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']); if (!e) return null;
  const r = e.response;
  if (!b64s(r.clientDataJSON, 8192) || !b64s(r.authenticatorData, 8192) || !b64s(r.signature, 4096)) return null;
  if (r.userHandle !== undefined && !b64s(r.userHandle, 128)) return null;
  return {
    id: e.id, rawId: e.id, type: 'public-key', clientExtensionResults: e.clientExtensionResults,
    ...(e.authenticatorAttachment ? { authenticatorAttachment: e.authenticatorAttachment } : {}),
    response: { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, ...(r.userHandle ? { userHandle: r.userHandle } : {}) },
  };
}
export function parseRegistrationResponse(text: unknown): RegistrationResponseJSON | null {
  const o = parseJson(text); if (!o) return null;
  const e = credentialEnvelope(o, ['clientDataJSON', 'attestationObject', 'transports', 'authenticatorData', 'publicKey', 'publicKeyAlgorithm']); if (!e) return null;
  const r = e.response;
  if (!b64s(r.clientDataJSON, 8192) || !b64s(r.attestationObject, 24576)) return null;
  // Browsers may report transports newer than this list: kept out of storage, not a reason to refuse the passkey.
  if (r.transports !== undefined && !(Array.isArray(r.transports) && r.transports.length <= 16 && r.transports.every((t) => typeof t === 'string' && t.length <= 32))) return null;
  if (r.authenticatorData !== undefined && !b64s(r.authenticatorData, 16384)) return null;
  if (r.publicKey !== undefined && !b64s(r.publicKey, 8192)) return null;
  if (r.publicKeyAlgorithm !== undefined && !Number.isSafeInteger(r.publicKeyAlgorithm)) return null;
  return {
    id: e.id, rawId: e.id, type: 'public-key', clientExtensionResults: e.clientExtensionResults,
    ...(e.authenticatorAttachment ? { authenticatorAttachment: e.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject,
      ...(r.transports ? { transports: (r.transports as string[]).filter((t) => TRANSPORTS.has(t)) as RegistrationResponseJSON['response']['transports'] } : {}),
      ...(r.authenticatorData !== undefined ? { authenticatorData: r.authenticatorData as string } : {}),
      ...(r.publicKey !== undefined ? { publicKey: r.publicKey as string } : {}),
      ...(r.publicKeyAlgorithm !== undefined ? { publicKeyAlgorithm: r.publicKeyAlgorithm as number } : {}),
    },
  };
}
/** The challenge the browser signed over (clientDataJSON.challenge), or null. */
function signedChallenge(clientDataJSON: string): string | null {
  try {
    const c: unknown = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON));
    return isRecord(c) && typeof c.challenge === 'string' && CHALLENGE.test(c.challenge) ? c.challenge : null;
  } catch { return null; }
}

// ── service (injectable; the Durable Object below is a thin RPC shell) ──

export interface ComputerWebAuthn {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
const SDK: ComputerWebAuthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

export interface ComputerAccessDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  identity: () => ComputerIdentity | null;
  now?: () => number;
  webauthn?: ComputerWebAuthn;
}

export class ComputerAccessService {
  private readonly s: ComputerAccessDeps['storage'];
  private readonly identity: () => ComputerIdentity | null;
  private readonly now: () => number;
  private readonly wa: ComputerWebAuthn;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ComputerAccessDeps) {
    this.s = deps.storage; this.identity = deps.identity; this.now = deps.now ?? Date.now; this.wa = deps.webauthn ?? SDK;
  }

  /** One operation at a time across every await: consume-verify-store is one atomic step (no fetches inside). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }
  /** Never leak an exception text to the caller. */
  private guarded<T>(f: () => Promise<T | ComputerFail>): Promise<T | ComputerFail> {
    return this.serial(f).catch(() => fail(503, 'computer sign-in is temporarily unavailable'));
  }
  /** The RP, only when the request came from exactly the public origin. */
  private rp(origin: unknown): ComputerIdentity | ComputerFail {
    const id = this.identity();
    if (!id) return fail(503, 'computer sign-in is not configured');
    return origin === id.origin ? id : fail(403, 'bad origin');
  }

  private async credentials() { return [...(await this.s.list<ComputerCredential>({ prefix: 'cred:' })).values()]; }
  private async userId(): Promise<string> {
    const existing = await this.s.get<string>('user');
    if (existing) return existing;
    const id = b64(random32());
    await this.s.put('user', id);
    return id;
  }

  /** A live session (and its storage key) for this token, or null. Expired or orphaned sessions are deleted. */
  private async live(token: unknown): Promise<{ key: string; sess: ComputerSession } | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const key = 'sess:' + (await sessionHash(token));
    const sess = await this.s.get<ComputerSession>(key);
    if (!sess) return null;
    let ok = this.now() < sess.expiresAt;
    if (ok && sess.kind === 'passkey') {
      const cred = sess.credentialId ? await this.s.get<ComputerCredential>('cred:' + sess.credentialId) : undefined;
      ok = !!cred && cred.createdAt === sess.credCreatedAt;
    }
    if (ok) return { key, sess };
    await this.s.delete(key);
    return null;
  }
  /** Passkey sessions roll (written at most hourly); pair sessions keep their fixed end. */
  private async touch(l: { key: string; sess: ComputerSession }) {
    const now = this.now();
    if (l.sess.kind !== 'passkey' || now - l.sess.lastSeen < TOUCH_EVERY) return l.sess;
    const next = { ...l.sess, lastSeen: now, expiresAt: now + CB_PC_SESSION_IDLE };
    await this.s.put(l.key, next);
    return next;
  }
  private maxAge(sess: ComputerSession) { return Math.max(0, Math.floor((sess.expiresAt - this.now()) / 1000)); }

  /** New session; the least recently used sessions make room so at most CB_PC_MAX_SESSIONS stay active. */
  private async newSession(kind: ComputerSession['kind'], cred?: ComputerCredential): Promise<ComputerSessionGrant> {
    const now = this.now();
    const all = [...(await this.s.list<ComputerSession>({ prefix: 'sess:' }))];
    const dead = all.filter(([, x]) => now >= x.expiresAt).map(([k]) => k);
    const alive = all.filter(([k]) => !dead.includes(k)).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
    const evict = alive.slice(0, Math.max(0, alive.length - (CB_PC_MAX_SESSIONS - 1))).map(([k]) => k);
    if (dead.length || evict.length) await this.s.delete([...dead, ...evict]);
    const sessionToken = 'cbpc_' + b64(random32());
    const sess: ComputerSession = {
      kind, createdAt: now, lastSeen: now,
      expiresAt: now + (kind === 'passkey' ? CB_PC_SESSION_IDLE : CB_PC_PAIR_SESSION_TTL),
      ...(cred ? { credentialId: cred.id, credCreatedAt: cred.createdAt } : {}),
    };
    await this.s.put('sess:' + (await sessionHash(sessionToken)), sess);
    return { sessionToken, cookieMaxAge: this.maxAge(sess) };
  }

  /** Store a fresh challenge for purpose; expired ones go, and the oldest go when the purpose is at its bound. */
  private async putChallenge(challenge: string, purpose: ChallengeRecord['purpose'], bind?: string) {
    const now = this.now();
    const all = [...(await this.s.list<ChallengeRecord>({ prefix: 'chal:' }))];
    const dead = all.filter(([, c]) => now >= c.expiresAt).map(([k]) => k);
    const mine = all.filter(([k, c]) => c.purpose === purpose && !dead.includes(k)).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    const evict = mine.slice(0, Math.max(0, mine.length - (CB_PC_MAX_CHALLENGES - 1))).map(([k]) => k);
    if (dead.length || evict.length) await this.s.delete([...dead, ...evict]);
    await this.s.put('chal:' + challenge, { purpose, createdAt: now, expiresAt: now + CB_PC_CHALLENGE_TTL, ...(bind ? { bind } : {}) } satisfies ChallengeRecord);
  }
  /** One use: the challenge is deleted before anything is verified, whatever the outcome. */
  private async takeChallenge(clientDataJSON: string, purpose: ChallengeRecord['purpose']): Promise<{ challenge: string; rec: ChallengeRecord } | null> {
    const challenge = signedChallenge(clientDataJSON);
    if (!challenge) return null;
    const rec = await this.s.get<ChallengeRecord>('chal:' + challenge);
    if (!rec) return null;
    await this.s.delete('chal:' + challenge);
    return rec.purpose === purpose && this.now() < rec.expiresAt ? { challenge, rec } : null;
  }

  // ── session ──

  session(token: string | null): Promise<ComputerSessionView | ComputerFail> {
    return this.guarded(async () => {
      const hasCredentials = (await this.credentials()).length > 0;
      const l = await this.live(token);
      if (!l) return { ok: true, authenticated: false, hasCredentials, renew: false, cookieMaxAge: 0 };
      const sess = await this.touch(l);
      return { ok: true, authenticated: true, hasCredentials, renew: sess.kind === 'passkey', cookieMaxAge: this.maxAge(sess) };
    });
  }
  /** Gate for the personal-computer API. Fail closed. */
  check(token: string | null): Promise<boolean> {
    return this.serial(async () => { const l = await this.live(token); if (l) await this.touch(l); return !!l; }).catch(() => false);
  }
  /** Idempotent; the session hash is gone immediately. */
  logout(token: string | null): Promise<{ ok: true; authenticated: false } | ComputerFail> {
    return this.guarded(async () => {
      if (typeof token === 'string' && TOKEN.test(token)) await this.s.delete('sess:' + (await sessionHash(token)));
      return { ok: true, authenticated: false };
    });
  }

  // ── sign-in with a registered phone passkey (discoverable) ──

  loginOptions(origin: string): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON } | ComputerFail> {
    return this.guarded(async () => {
      const id = this.rp(origin); if (isComputerFail(id)) return id;
      if (!(await this.credentials()).length) return fail(409, 'no passkey is registered for this computer yet');
      const options = plain(await this.wa.generateAuthenticationOptions({ rpID: id.rpId, challenge: random32(), userVerification: 'required', timeout: CB_PC_CHALLENGE_TTL }));
      await this.putChallenge(options.challenge, 'login');
      return { ok: true, options };
    });
  }

  login(origin: string, responseJson: string, priorToken: string | null): Promise<ComputerLoginResult | ComputerFail> {
    return this.guarded(async () => {
      const id = this.rp(origin); if (isComputerFail(id)) return id;
      const resp = parseAuthenticationResponse(responseJson);
      if (!resp) return fail(400, 'response must be a WebAuthn assertion');
      const taken = await this.takeChallenge(resp.response.clientDataJSON, 'login');
      if (!taken) return fail(400, 'sign-in challenge is missing, used or expired');
      const cred = await this.s.get<ComputerCredential>('cred:' + resp.id);
      if (!cred) return fail(401, 'passkey verification failed');
      if (resp.response.userHandle !== undefined && resp.response.userHandle !== (await this.s.get<string>('user'))) return fail(401, 'passkey verification failed');
      let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try {
        v = await this.wa.verifyAuthenticationResponse({
          response: resp, expectedChallenge: taken.challenge, expectedOrigin: id.origin, expectedRPID: id.rpId,
          credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.publicKey), counter: cred.counter, transports: cred.transports as never },
          requireUserVerification: true,
        });
      } catch { return fail(401, 'passkey verification failed'); }
      if (!v.verified || !v.authenticationInfo.userVerified || v.authenticationInfo.credentialID !== cred.id) return fail(401, 'passkey verification failed');
      // Under the serial queue this read-compare-write is the CAS: a counter that moved meanwhile is re-checked here.
      const current = await this.s.get<ComputerCredential>('cred:' + cred.id);
      if (!current || current.createdAt !== cred.createdAt) return fail(401, 'passkey verification failed');
      const n = v.authenticationInfo.newCounter;
      if ((n > 0 || current.counter > 0) && n <= current.counter) return fail(401, 'passkey verification failed');
      await this.s.put('cred:' + cred.id, { ...current, counter: n, backedUp: v.authenticationInfo.credentialBackedUp });
      if (typeof priorToken === 'string' && TOKEN.test(priorToken)) await this.s.delete('sess:' + (await sessionHash(priorToken)));
      return { ok: true, authenticated: true, hasCredentials: true, ...(await this.newSession('passkey', current)) };
    });
  }

  // ── registration: only an existing personal-computer session, or the router-verified legacy owner ──

  /** Registration authority for this call: a live session (bound by its hash) or legacy owner — never anonymous. */
  private async enroller(token: string | null, legacyOwner: boolean): Promise<{ bind: string; l: { key: string; sess: ComputerSession } | null } | ComputerFail> {
    const l = await this.live(token);
    if (l) return { bind: l.key, l };
    if (legacyOwner === true) return { bind: 'legacy', l: null };
    return fail(401, 'sign in to this computer first');
  }

  registerOptions(origin: string, token: string | null, legacyOwner: boolean): Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON } | ComputerFail> {
    return this.guarded(async () => {
      const id = this.rp(origin); if (isComputerFail(id)) return id;
      const who = await this.enroller(token, legacyOwner); if (isComputerFail(who)) return who;
      const creds = await this.credentials();
      if (creds.length >= CB_PC_MAX_CREDENTIALS) return fail(409, `at most ${CB_PC_MAX_CREDENTIALS} passkeys; remove one first`);
      const options = plain(await this.wa.generateRegistrationOptions({
        rpName: 'CloudBite', rpID: id.rpId, userName: 'CloudBite owner', userDisplayName: 'CloudBite owner',
        userID: isoBase64URL.toBuffer(await this.userId()), challenge: random32(), timeout: CB_PC_CHALLENGE_TTL, attestationType: 'none',
        excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        supportedAlgorithmIDs: [-8, -7, -257],
      }));
      await this.putChallenge(options.challenge, 'reg', who.bind);
      return { ok: true, options };
    });
  }

  registerVerify(origin: string, token: string | null, legacyOwner: boolean, responseJson: string): Promise<ComputerRegisterResult | ComputerFail> {
    return this.guarded(async () => {
      const id = this.rp(origin); if (isComputerFail(id)) return id;
      const resp = parseRegistrationResponse(responseJson);
      if (!resp) return fail(400, 'response must be a WebAuthn registration');
      const taken = await this.takeChallenge(resp.response.clientDataJSON, 'reg');
      if (!taken) return fail(400, 'registration challenge is missing, used or expired');
      // The same authority that asked for the challenge must still hold NOW.
      const who = await this.enroller(token, legacyOwner); if (isComputerFail(who)) return who;
      if (taken.rec.bind !== who.bind && !(taken.rec.bind === 'legacy' && legacyOwner === true)) return fail(401, 'registration was started by another session');
      let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        v = await this.wa.verifyRegistrationResponse({ response: resp, expectedChallenge: taken.challenge, expectedOrigin: id.origin, expectedRPID: id.rpId, requireUserVerification: true });
      } catch { return fail(400, 'passkey registration failed'); }
      if (!v.verified || !v.registrationInfo.userVerified) return fail(400, 'passkey registration failed');
      const c = v.registrationInfo.credential;
      const creds = await this.credentials();
      if (creds.some((x) => x.id === c.id)) return fail(409, 'this passkey is already registered');
      if (creds.length >= CB_PC_MAX_CREDENTIALS) return fail(409, `at most ${CB_PC_MAX_CREDENTIALS} passkeys; remove one first`);
      const cred: ComputerCredential = {
        id: c.id, publicKey: b64(c.publicKey), counter: c.counter,
        transports: (c.transports ?? resp.response.transports ?? []).filter((t) => TRANSPORTS.has(t)),
        createdAt: this.now(), backedUp: v.registrationInfo.credentialBackedUp, deviceType: v.registrationInfo.credentialDeviceType,
      };
      await this.s.put('cred:' + cred.id, cred);
      // Rotate: the enrolling session (pair-born or older) ends; this browser continues on the new passkey's session.
      if (who.l) await this.s.delete(who.l.key);
      return { ok: true, registered: true, hasCredentials: true, ...(await this.newSession('passkey', cred)) };
    });
  }

  credentialsList(token: string | null): Promise<{ ok: true; credentials: ComputerCredentialView[] } | ComputerFail> {
    return this.guarded(async () => {
      if (!(await this.live(token))) return fail(401, 'sign in to this computer first');
      const list = (await this.credentials()).sort((a, b) => a.createdAt - b.createdAt);
      return { ok: true, credentials: list.map((c) => ({ id: c.id, createdAt: c.createdAt, transports: [...c.transports], backedUp: c.backedUp })) };
    });
  }
  /** Removes the passkey and ends every session it created. */
  revokeCredential(token: string | null, credentialId: string): Promise<{ ok: true; revoked: boolean } | ComputerFail> {
    return this.guarded(async () => {
      if (!(await this.live(token))) return fail(401, 'sign in to this computer first');
      if (!b64s(credentialId, 1366)) return fail(400, 'invalid passkey id');
      const existed = await this.s.delete('cred:' + credentialId);
      const sessions = [...(await this.s.list<ComputerSession>({ prefix: 'sess:' }))].filter(([, x]) => x.credentialId === credentialId).map(([k]) => k);
      if (sessions.length) await this.s.delete(sessions);
      return { ok: true, revoked: existed };
    });
  }

  // ── first-phone pairing (issuing is INTERNAL ONLY: never reachable from a public route) ──

  issuePairing(o: { ttlSeconds: number }): Promise<ComputerPairing | ComputerFail> {
    return this.guarded(async () => {
      if (!this.identity()) return fail(503, 'computer sign-in is not configured');
      const ttl = (isRecord(o) && Number.isSafeInteger(o.ttlSeconds) ? o.ttlSeconds : NaN) * 1000;
      if (!(ttl >= CB_PC_PAIR_MIN_TTL && ttl <= CB_PC_PAIR_MAX_TTL)) return fail(400, 'ttlSeconds must be 60..1800');
      const now = this.now();
      const all = [...(await this.s.list<PairingRecord>({ prefix: 'pair:' }))];
      const dead = all.filter(([, p]) => now >= p.expiresAt).map(([k]) => k);
      if (dead.length) await this.s.delete(dead);
      if (all.length - dead.length >= CB_PC_MAX_PAIRINGS) return fail(409, 'too many outstanding pairing links');
      const token = b64(random32());
      const expiresAt = now + ttl;
      await this.s.put('pair:' + (await pairHash(token)), { createdAt: now, expiresAt } satisfies PairingRecord);
      return { ok: true, token, url: `${CB_COMPUTER_URL}#pair=${token}`, expiresAt };
    });
  }
  revokePairings(): Promise<{ ok: true; revoked: number } | ComputerFail> {
    return this.guarded(async () => {
      const keys = [...(await this.s.list({ prefix: 'pair:' })).keys()];
      if (keys.length) await this.s.delete(keys);
      return { ok: true, revoked: keys.length };
    });
  }
  /** Redeems a pairing link exactly once into a 24 h personal-computer session (enough to register this phone's passkey). */
  pair(origin: string, pairToken: string): Promise<ComputerPairResult | ComputerFail> {
    return this.guarded(async () => {
      const id = this.rp(origin); if (isComputerFail(id)) return id;
      if (typeof pairToken !== 'string' || !PAIR_TOKEN.test(pairToken)) return fail(400, 'invalid pairing link');
      const key = 'pair:' + (await pairHash(pairToken));
      const rec = await this.s.get<PairingRecord>(key);
      if (!rec) return fail(401, 'pairing link is invalid or already used');
      await this.s.delete(key);
      if (this.now() >= rec.expiresAt) return fail(410, 'pairing link expired');
      const hasCredentials = (await this.credentials()).length > 0;
      return { ok: true, authenticated: true, hasCredentials, ...(await this.newSession('pair')) };
    });
  }
}

/** RPC shell. Every argument is a string/boolean/plain object; browser JSON arrives as a JSON string. */
export class CloudbiteComputerAccess extends DurableObject<Env> {
  readonly #svc = new ComputerAccessService({ storage: this.ctx.storage, identity: () => computerIdentity(this.env) });

  session(token: string | null) { return this.#svc.session(token); }
  check(token: string | null) { return this.#svc.check(token); }
  logout(token: string | null) { return this.#svc.logout(token); }
  loginOptions(origin: string) { return this.#svc.loginOptions(origin); }
  login(origin: string, responseJson: string, priorToken: string | null) { return this.#svc.login(origin, responseJson, priorToken); }
  registerOptions(origin: string, token: string | null, legacyOwner: boolean) { return this.#svc.registerOptions(origin, token, legacyOwner); }
  registerVerify(origin: string, token: string | null, legacyOwner: boolean, responseJson: string) { return this.#svc.registerVerify(origin, token, legacyOwner, responseJson); }
  credentials(token: string | null) { return this.#svc.credentialsList(token); }
  revokeCredential(token: string | null, credentialId: string) { return this.#svc.revokeCredential(token, credentialId); }
  issuePairing(o: { ttlSeconds: number }) { return this.#svc.issuePairing(o); }
  revokePairings() { return this.#svc.revokePairings(); }
  pair(origin: string, pairToken: string) { return this.#svc.pair(origin, pairToken); }
  /** Explicit JSON transport for WebAuthn option extension types across the Worker RPC boundary. */
  async authJson(op: string, inputJson: string): Promise<string> {
    try {
      if(inputJson.length>40*1024)throw Error();
      const a=JSON.parse(inputJson);let result;
      switch(op){
        case 'session':result=await this.#svc.session(a.token);break;
        case 'credentials':result=await this.#svc.credentialsList(a.token);break;
        case 'loginOptions':result=await this.#svc.loginOptions(a.origin);break;
        case 'login':result=await this.#svc.login(a.origin,a.responseJson,a.token);break;
        case 'logout':result=await this.#svc.logout(a.token);break;
        case 'registerOptions':result=await this.#svc.registerOptions(a.origin,a.token,a.legacyOwner===true);break;
        case 'registerVerify':result=await this.#svc.registerVerify(a.origin,a.token,a.legacyOwner===true,a.responseJson);break;
        case 'pair':result=await this.#svc.pair(a.origin,a.pairToken);break;
        case 'revokeCredential':result=await this.#svc.revokeCredential(a.token,a.credentialId);break;
        default:throw Error();
      }
      return JSON.stringify(result);
    }catch{return JSON.stringify({ok:false,error:'computer sign-in unavailable',status:503});}
  }
}
