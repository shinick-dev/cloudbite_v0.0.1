// Cloudbite audience access HTTP surface (docs/cloudbite/access-service.txt). Called from cloudbiteRoute.
// A visitor is identified ONLY by an HttpOnly cookie holding a random cbv_ credential; the DO stores its SHA-256.
// Request ids appear in owner views and action paths but never authenticate anything.
import type { CloudbiteAccessSession } from './cloudbite-access-contract';
import { CB_ACCESS_ID, CB_ACCESS_INBOX, CB_ACCESS_GRANT_TTL, CB_ACCESS_PENDING_TTL, type AccessAction } from './cloudbite-access-service';
import { boundedText } from './cloudbite-inference';
import { cbHash, cbProjectId, isCbFail } from './cloudbite-project';
import type { Env } from './state';

type Json = (data: unknown, status?: number) => Response;
export const CB_ACCESS_BODY_MAX = 8 * 1024;
export const CB_ACCESS_NAME_MAX = 80;
export const CB_ACCESS_PURPOSE_MAX = 1000;
const CREDENTIAL = /^cbv_[A-Za-z0-9_-]{43}$/;
const CONTROL_NAME = /[\u0000-\u001f\u007f]/;
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Cookie lives for the pending window plus one grant hour; the server-side expiry is what actually counts.
const COOKIE_MAX_AGE = (CB_ACCESS_PENDING_TTL + CB_ACCESS_GRANT_TTL) / 1000;

/** __Host-cb-access (Secure) everywhere, except local http dev (CLOUDBITE_ALLOW_HTTP=1 + http ORIGIN): cb-access-dev. */
export function accessCookieName(env: Env) {
  return env.CLOUDBITE_ALLOW_HTTP === '1' && env.ORIGIN.startsWith('http:') ? 'cb-access-dev' : '__Host-cb-access';
}
function setCookie(env: Env, value: string) {
  const name = accessCookieName(env);
  return `${name}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${name.startsWith('__Host-') ? '; Secure' : ''}`;
}

/** The SHA-256 of this browser's well-formed access credential, or null. The plaintext never leaves this function. */
export async function accessCredentialHash(req: Request, env: Env): Promise<string | null> {
  const name = accessCookieName(env);
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    return CREDENTIAL.test(v) ? cbHash(v) : null;
  }
  return null;
}

const inbox = (env: Env) => env.CLOUDBITE_ACCESS!.getByName(CB_ACCESS_INBOX);

/**
 * This credential's session, after returning each project slot whose bound project definitively failed with zero
 * completed experts and whose cleanup is confirmed (docs/cloudbite/access-service.txt, Failed-run refund). Projects
 * are found from the scoped requestIds the access DO stored — never from anything the browser sent. Each slot is
 * checked independently; a failure to ask one project keeps that slot used (fail closed) without touching the others.
 * Idempotent: repeated calls refund at most once per run. recovery is reported only while no slot is free.
 */
export async function settledSession(env: Env, cred: string | null): Promise<CloudbiteAccessSession> {
  const box = inbox(env);
  const c = await box.refundCandidate(cred);
  if (!c.scoped.length) return c.session;
  const states = await Promise.all(c.scoped.map(async (scoped): Promise<'refundable' | 'cleanup' | 'none' | 'unavailable'> => {
    try {
      if (!env.CLOUDBITE) throw new Error('no project binding');
      return await env.CLOUDBITE.getByName(await cbProjectId(scoped)).refundState(scoped);
    } catch { return 'unavailable'; }
  }));
  const ready = c.scoped.filter((_, i) => states[i] === 'refundable');
  const session = ready.length && c.left ? await box.refund(cred, ready) : c.session;
  if (session.canCreate) return session;
  if (states.includes('unavailable')) return { ...session, recovery: 'unavailable' };
  if (states.includes('cleanup')) return { ...session, recovery: 'pending' };
  if (ready.length > c.left) return { ...session, recovery: 'limit' };
  return session;
}

/** bootstrap.access: only when the binding exists and the browser presents a credential. */
export async function accessSession(req: Request, env: Env): Promise<CloudbiteAccessSession | null> {
  if (!env.CLOUDBITE_ACCESS) return null;
  const cred = await accessCredentialHash(req, env);
  return cred ? settledSession(env, cred) : null;
}

/** Visitor brief.requestId namespace: two visitors (or a visitor and the owner) never share a project id. */
export async function visitorRequestId(accessId: string, rawRequestId: string) {
  return cbHash(`cloudbite-visitor-v1|${accessId}|${rawRequestId}`);
}

/** Visitor project-create authority: approved grant + atomic per-project slot reservation. */
export const visitorGrant = {
  async check(req: Request, env: Env) {
    if (!env.CLOUDBITE_ACCESS) return null;
    const cred = await accessCredentialHash(req, env);
    if (!cred) return null;
    const g = await inbox(env).grant(cred);
    return isCbFail(g) ? null : { cred, id: g.id };
  },
  /** Return failed projects' slots first (same rules as bootstrap), then bind atomically. */
  async reserve(env: Env, cred: string, scoped: string, experts: number) {
    await settledSession(env, cred);
    return inbox(env).reserve(cred, scoped, experts);
  },
  confirm: (env: Env, id: string, scoped: string) => inbox(env).confirm(id, scoped),
  release: (env: Env, id: string, scoped: string) => inbox(env).release(id, scoped),
};

function credential() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'cbv_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/**
 * /api/cloudbite/access/*. null = not an access path. owner decides owner authority (x-admin-token: temporary cbo_
 * operator or a State admin session; without that header the Cloudbite owner-session cookie) — evaluated only on the
 * owner paths below.
 */
export async function accessRoute(req: Request, env: Env, path: string, owner: () => Promise<boolean>, json: Json): Promise<Response | null> {
  if (!path.startsWith('/api/cloudbite/access/')) return null;
  const strictOrigin = () => req.headers.get('origin') === env.ORIGIN;
  const out = (r: unknown, status = 200) => (isCbFail(r) ? json({ error: r.error }, r.status) : json(r, status));

  if (path === '/api/cloudbite/access/status') {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!env.CLOUDBITE_ACCESS) return json({ request: null, canCreate: false } satisfies CloudbiteAccessSession);
    return json(await settledSession(env, await accessCredentialHash(req, env)));
  }

  if (path === '/api/cloudbite/access/requests') {
    if (req.method === 'GET') {
      if (!await owner()) return json({ error: 'admin session required' }, 401);
      if (!env.CLOUDBITE_ACCESS) return json({ error: 'Cloudbite access is not configured' }, 503);
      return json(await inbox(env).list());
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    const b = await readObject(req, CB_ACCESS_BODY_MAX);
    if ('error' in b) return json({ error: b.error }, b.status);
    if (Object.keys(b.ok).some((k) => k !== 'name' && k !== 'purpose')) return json({ error: 'unknown field' }, 400);
    const name = typeof b.ok.name === 'string' ? b.ok.name.trim() : '';
    const purpose = typeof b.ok.purpose === 'string' ? b.ok.purpose.trim() : '';
    if (!name || name.length > CB_ACCESS_NAME_MAX || CONTROL_NAME.test(name)) return json({ error: `name must be 1-${CB_ACCESS_NAME_MAX} characters of plain text` }, 400);
    if (!purpose || purpose.length > CB_ACCESS_PURPOSE_MAX || CONTROL_TEXT.test(purpose)) return json({ error: `purpose must be 1-${CB_ACCESS_PURPOSE_MAX} characters of plain text` }, 400);
    if (!env.CLOUDBITE_ACCESS) return json({ error: 'Cloudbite access is not configured' }, 503);
    const fresh = credential();
    const [cur, freshHash, src] = await Promise.all([
      accessCredentialHash(req, env), cbHash(fresh),
      // Hashed with MASTER_KEY: the raw address is never stored.
      cbHash(`cloudbite-access-src-v1|${env.MASTER_KEY ?? ''}|${(req.headers.get('cf-connecting-ip') ?? 'loopback').trim().toLowerCase()}`),
    ]);
    const r = await inbox(env).submit(cur, freshHash, src, name, purpose);
    if (isCbFail(r)) return json({ error: r.error }, r.status);
    const res = json(r.session, r.reused ? 200 : 201);
    // A reused request keeps the browser's existing cookie; only a new request issues a new credential.
    if (!r.reused) res.headers.append('set-cookie', setCookie(env, fresh));
    return res;
  }

  const m = path.match(/^\/api\/cloudbite\/access\/requests\/([^/]+)\/(approve|deny|revoke)$/);
  if (!m) return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
  const b = await readObject(req, 256);
  if ('error' in b) return json({ error: b.error }, b.status);
  if (Object.keys(b.ok).length) return json({ error: 'request body must be {}' }, 400);
  if (!await owner()) return json({ error: 'admin session required' }, 401);
  if (!CB_ACCESS_ID.test(m[1])) return json({ error: 'access request not found' }, 404);
  if (!env.CLOUDBITE_ACCESS) return json({ error: 'Cloudbite access is not configured' }, 503);
  return out(await inbox(env).decide(m[1], m[2] as AccessAction));
}
