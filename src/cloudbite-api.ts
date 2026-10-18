// Cloudbite HTTP surface (docs/cloudbite/api-contract.md). index.ts calls cloudbiteRoute after its host checks;
// public-get.ts calls cloudbitePage for the console. Errors are {error} only — never upstream bodies or secrets.
import type { CloudbiteBootstrap } from './cloudbite-contract';
import { CLOUDBITE_EXPERTS } from './cloudbite-personas';
import { CLOUDBITE_CSS, CLOUDBITE_HTML, CLOUDBITE_JS } from './cloudbite-page';
import { CB_ACTIVITY_BODY_MAX, CB_COMPLETE_BODY_MAX, CB_CREATE_BODY_MAX, CB_EXPERT_DEADLINE, CB_INFERENCE_BODY_MAX, CB_MAX_EXPERTS, cloudbiteMissing } from './cloudbite-config';
import { cbProjectId, isCbFail } from './cloudbite-project';
import { boundedText } from './cloudbite-inference';
import { isInvalid, PROJECT_ID, RUN_ID, validateBrief } from './cloudbite-validate';
import type { Env, State } from './state';

type Json = (data: unknown, status?: number) => Response;
const CB_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** GET /, /cloudbite and same-origin assets. null = not a Cloudbite page path. */
export function cloudbitePage(path: string, sec: Record<string, string>): Response | null {
  const page = (body: string, type: string, csp = false) =>
    new Response(body, { headers: { ...sec, 'content-type': type, ...(csp ? { 'content-security-policy': CB_CSP } : {}) } });
  if (path === '/' || path === '/cloudbite' || path === '/cloudbite/') return page(CLOUDBITE_HTML, 'text/html; charset=utf-8', true);
  if (path === '/cloudbite/app.js') return page(CLOUDBITE_JS, 'text/javascript; charset=utf-8');
  if (path === '/cloudbite/style.css') return page(CLOUDBITE_CSS, 'text/css; charset=utf-8');
  return null;
}

export function cloudbiteBootstrap(env: Env): CloudbiteBootstrap {
  const missing = cloudbiteMissing(env, CLOUDBITE_EXPERTS.length);
  return { experts: [...CLOUDBITE_EXPERTS], configuration: { liveReady: missing.length === 0, missing, maxExperts: CB_MAX_EXPERTS } };
}

function bearer(req: Request) {
  const a = req.headers.get('authorization');
  return a?.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : null;
}

async function readJson(req: Request, max: number): Promise<{ ok: unknown } | { error: string; status: number }> {
  let text: string;
  try { text = await boundedText(req, max); } catch { return { error: 'request body too large', status: 413 }; }
  try { return { ok: JSON.parse(text || 'null') }; } catch { return { error: 'request body must be JSON', status: 400 }; }
}

const result = (json: Json, r: unknown) => (isCbFail(r) ? json({ error: r.error }, r.status) : json(r));

/**
 * Cloudbite API and worker callbacks. null = not a Cloudbite path (legacy routing continues).
 * Live/demo creation reuses the existing State admin session (x-admin-token, State.adminList: storage reads only).
 */
export async function cloudbiteRoute(req: Request, env: Env, url: URL, state: Pick<DurableObjectStub<State>, 'adminList'>, json: Json): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/cloudbite/') && !path.startsWith('/p/_cloudbite/')) return null;
  const ns = env.CLOUDBITE;

  // ── sandbox runner callbacks: workers.dev gateway host, per-expert capability only ──
  const w = path.match(/^\/p\/_cloudbite\/worker\/([^/]+)\/([^/]+)\/(inference|activity|complete)$/);
  if (path.startsWith('/p/_cloudbite/')) {
    if (!w || !PROJECT_ID.test(w[1]) || !RUN_ID.test(w[2])) return json({ error: 'not found' }, 404);
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (req.headers.get('origin')) return json({ error: 'bad origin' }, 403); // runner calls are never browser requests
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    const max = w[3] === 'inference' ? CB_INFERENCE_BODY_MAX : w[3] === 'activity' ? CB_ACTIVITY_BODY_MAX : CB_COMPLETE_BODY_MAX;
    const b = await readJson(req, max);
    if ('error' in b) return json({ error: b.error }, b.status);
    return result(json, await ns.getByName(w[1]).worker(w[2], bearer(req), w[3], b.ok));
  }

  if (path === '/api/cloudbite/bootstrap') {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return json(cloudbiteBootstrap(env));
  }

  const strictOrigin = () => req.headers.get('origin') === env.ORIGIN;

  if (path === '/api/cloudbite/projects') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    const b = await readJson(req, CB_CREATE_BODY_MAX);
    if ('error' in b) return json({ error: b.error }, b.status);
    const admin = req.headers.get('x-admin-token') ?? '';
    if (!admin || isCbFail(await state.adminList(admin))) return json({ error: 'admin session required' }, 401);
    const brief = validateBrief(b.ok);
    if (isInvalid(brief)) return json({ error: brief.invalid }, 400);
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    if (brief.mode === 'live') {
      const missing = cloudbiteMissing(env, CLOUDBITE_EXPERTS.length);
      if (missing.length) return json({ error: `live execution is not configured; missing: ${missing.join(', ')}` }, 503);
    }
    const id = await cbProjectId(brief.requestId);
    if (brief.mode === 'live') {
      const slot = await ns.getByName('registry').registryAcquire(id, Date.now() + 4 * CB_EXPERT_DEADLINE);
      if (isCbFail(slot)) return json({ error: slot.error }, slot.status);
    }
    const created = await ns.getByName(id).create(id, brief);
    // A failed first create must not hold a live slot. (Idempotent retries of an existing project return success.)
    if (isCbFail(created) && brief.mode === 'live' && created.status !== 409) await ns.getByName('registry').registryRelease(id);
    return isCbFail(created) ? json({ error: created.error }, created.status) : json(created, 201);
  }

  const m = path.match(/^\/api\/cloudbite\/projects\/([^/]+)(\/cancel|\/artifact)?$/);
  if (!m || !PROJECT_ID.test(m[1])) return json({ error: 'not found' }, 404);
  if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
  const stub = ns.getByName(m[1]);
  const token = bearer(req);
  if (!token) return json({ error: 'project access token required' }, 401);
  if (m[2] === '/cancel') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    const b = await readJson(req, 256);
    if ('error' in b) return json({ error: b.error }, b.status);
    return result(json, await stub.cancel(token));
  }
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (m[2] === '/artifact') return result(json, await stub.artifact(token, url.searchParams.get('expert'), url.searchParams.get('path')));
  return result(json, await stub.read(token));
}
