// Cloudbite persistent owner session (docs/cloudbite/owner-session.txt). Called from cloudbiteRoute.
// The owner taps a registered security key ONCE (WebAuthn purpose 'cloudbite-owner' in State, never the generic admin
// challenge); the browser then holds an HttpOnly cookie with a random cbown_ credential until an explicit logout.
// State stores only its SHA-256 and checks on every use that the security key that created it is still registered.
// The cookie authorizes the Cloudbite access inbox and Cloudbite project creation only — nothing outside cloudbiteRoute reads it.
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { boundedText } from './cloudbite-inference';
import { cbHash, isCbFail } from './cloudbite-project';
import type { Env, State } from './state';

type Json = (data: unknown, status?: number) => Response;
export type OwnerState = Pick<DurableObjectStub<State>, 'cloudbiteOwnerStatus' | 'cloudbiteOwnerOptions' | 'cloudbiteOwnerLogin' | 'cloudbiteOwnerCheck' | 'cloudbiteOwnerLogout'>;
export const CB_OWNER_BODY_MAX = 32 * 1024; // a WebAuthn assertion is a few KB
const CREDENTIAL = /^cbown_[A-Za-z0-9_-]{43}$/;
// Browsers cap cookie lifetime at 400 days; GET /owner/session renews it. The server session itself never expires.
const COOKIE_MAX_AGE = 400 * 24 * 3600;

/** __Host-cb-owner (Secure) everywhere, except local http dev (CLOUDBITE_ALLOW_HTTP=1 + http ORIGIN): cb-owner-dev. */
export function ownerCookieName(env: Env) {
  return env.CLOUDBITE_ALLOW_HTTP === '1' && env.ORIGIN.startsWith('http:') ? 'cb-owner-dev' : '__Host-cb-owner';
}
function setCookie(env: Env, value: string, maxAge: number) {
  const name = ownerCookieName(env);
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${name.startsWith('__Host-') ? '; Secure' : ''}`;
}

/** This browser's well-formed owner credential: its plaintext (for cookie renewal only) and the hash State knows. */
async function presented(req: Request, env: Env): Promise<{ value: string; hash: string } | null> {
  const name = ownerCookieName(env);
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    return CREDENTIAL.test(value) ? { value, hash: await sessionHash(value) } : null;
  }
  return null;
}
const sessionHash = (value: string) => cbHash(`cloudbite-owner-session-v1|${value}`);

/**
 * true only for a live owner session. State is asked only when the browser presents a well-formed owner cookie, and a
 * failed check is false (fail closed) — it never falls through to another kind of authority by itself.
 */
export async function ownerCookieValid(req: Request, env: Env, state: OwnerState): Promise<boolean> {
  const p = await presented(req, env);
  if (!p) return false;
  try { return (await state.cloudbiteOwnerCheck(p.hash)) === true; } catch { return false; }
}

function credential() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'cbown_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Request-source key for State's per-source challenge cap: keyed hash, IPv6 grouped by /64. Never the raw address. */
async function sourceOf(req: Request, env: Env) {
  let ip = (req.headers.get('cf-connecting-ip') ?? '').trim().toLowerCase() || 'loopback';
  if (ip.includes(':') && /^[0-9a-f:]{2,39}$/.test(ip) && (ip.match(/::/g)?.length ?? 0) <= 1) {
    const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
    const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    ip = `6:${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
  }
  return (await cbHash(`cloudbite-owner-src-v1|${env.MASTER_KEY ?? ''}|${ip}`)).slice(0, 32);
}

async function readObject(req: Request, max: number): Promise<{ ok: Record<string, unknown> } | { error: string; status: number }> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return { error: 'content-type must be application/json', status: 415 };
  let text: string;
  try { text = await boundedText(req, max); } catch { return { error: 'request body too large', status: 413 }; }
  let v: unknown;
  try { v = JSON.parse(text || 'null'); } catch { return { error: 'request body must be JSON', status: 400 }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'request body must be a JSON object', status: 400 };
  return { ok: v as Record<string, unknown> };
}

/** /api/cloudbite/owner/*. null = not an owner-session path. */
export async function ownerRoute(req: Request, env: Env, path: string, state: OwnerState, json: Json): Promise<Response | null> {
  if (!path.startsWith('/api/cloudbite/owner/')) return null;
  const unavailable = () => json({ error: 'owner session is temporarily unavailable' }, 503);

  if (path === '/api/cloudbite/owner/session') {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const p = await presented(req, env);
    let s: { authenticated: boolean; hasCredentials: boolean };
    try { s = await state.cloudbiteOwnerStatus(p?.hash ?? null); } catch { return unavailable(); }
    const res = json({ authenticated: s.authenticated === true, hasCredentials: s.hasCredentials === true });
    // A live session renews only the browser's retention of the same credential (no new credential, no server expiry).
    if (p && s.authenticated === true) res.headers.append('set-cookie', setCookie(env, p.value, COOKIE_MAX_AGE));
    return res;
  }

  const action = path.match(/^\/api\/cloudbite\/owner\/(options|login|logout)$/)?.[1];
  if (!action) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (req.headers.get('origin') !== env.ORIGIN) return json({ error: 'bad origin' }, 403);
  const b = await readObject(req, action === 'login' ? CB_OWNER_BODY_MAX : 256);
  if ('error' in b) return json({ error: b.error }, b.status);

  if (action === 'options') {
    if (Object.keys(b.ok).length) return json({ error: 'request body must be {}' }, 400);
    const r = await state.cloudbiteOwnerOptions(await sourceOf(req, env), env.ORIGIN);
    return isCbFail(r) ? json({ error: r.error }, r.status) : json(r);
  }

  if (action === 'login') {
    if (Object.keys(b.ok).some((k) => k !== 'response')) return json({ error: 'unknown field' }, 400);
    const resp = b.ok.response;
    if (typeof resp !== 'object' || resp === null || Array.isArray(resp)) return json({ error: 'response must be a WebAuthn assertion' }, 400);
    const fresh = credential();
    const [hash, prior] = await Promise.all([sessionHash(fresh), presented(req, env)]);
    const r = await state.cloudbiteOwnerLogin(resp as AuthenticationResponseJSON, hash, prior?.hash ?? null);
    if (isCbFail(r)) return json({ error: r.error }, r.status);
    const res = json({ authenticated: true, hasCredentials: true });
    res.headers.append('set-cookie', setCookie(env, fresh, COOKIE_MAX_AGE));
    return res;
  }

  // logout: end the server session first; the cookie is cleared only once that succeeded. Repeating it is harmless.
  if (Object.keys(b.ok).length) return json({ error: 'request body must be {}' }, 400);
  const p = await presented(req, env);
  if (p) {
    try { await state.cloudbiteOwnerLogout(p.hash); } catch { return unavailable(); }
  }
  const res = json({ authenticated: false });
  res.headers.append('set-cookie', setCookie(env, '', 0));
  return res;
}
