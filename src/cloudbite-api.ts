// Cloudbite HTTP surface (docs/cloudbite/api-contract.md). index.ts calls cloudbiteRoute after its host checks;
// public-get.ts calls cloudbitePage for the console. Errors are {error} only — never upstream bodies or secrets.
import type { CloudbiteBootstrap, CloudbiteRoutingDecision, ProjectBrief, ProjectBudget } from './cloudbite-contract';
import { CLOUDBITE_EXPERTS } from './cloudbite-personas';
import { CLOUDBITE_POOL } from './cloudbite-pool';
import { CLOUDBITE_CSS, CLOUDBITE_CSS_PATH, CLOUDBITE_HTML, CLOUDBITE_JS, CLOUDBITE_JS_PATH } from './cloudbite-page';
import { CLOUDBITE_ACCESS_HTML, CLOUDBITE_ACCESS_CSS, CLOUDBITE_ACCESS_QR, CLOUDBITE_REQUEST_HTML, CLOUDBITE_REQUESTS_HTML, CLOUDBITE_ACCESS_JS } from './cloudbite-access-page';
import { CB_ACTIVITY_BODY_MAX, CB_COMPLETE_BODY_MAX, CB_CREATE_BODY_MAX, CB_INFERENCE_BODY_MAX, CB_MAX_EXPERTS, cbMaxConcurrent, cloudbiteMissing } from './cloudbite-config';
import { cbHash, cbProjectId, isCbFail, type CbFail } from './cloudbite-project';
import { authorizeRoundParent, buildProjectRound, isRoundFail, type ProjectPreviousRound } from './cloudbite-revision';
import type { CloudbiteAccessSession } from './cloudbite-access-contract';
import type { HistoryDetail } from './cloudbite-history-contract';
import { JEV_MODEL, routingReady, routingQuery, isRoutingFailure } from './cloudbite-routing';
import { CB_OPERATOR_PREFIX, verifyCloudbiteOperator } from './cloudbite-operator';
import { boundedText } from './cloudbite-inference';
import { isInvalid, PROJECT_ID, RUN_ID, validateBrief } from './cloudbite-validate';
import { accessRoute, accessSession, visitorGrant, visitorRequestId } from './cloudbite-access-api';
import { ownerCookieValid, ownerRoute, type OwnerState } from './cloudbite-owner';
import { historyRoute, prepareHistory } from './cloudbite-history-api';
import type { Env, State } from './state';

type Json = (data: unknown, status?: number) => Response;
const CB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** GET /, /cloudbite and same-origin assets. null = not a Cloudbite page path. */
export function cloudbitePage(path: string, sec: Record<string, string>): Response | null {
  const page = (body: string, type: string, csp = false) =>
    new Response(body, { headers: { ...sec, 'content-type': type, ...(csp ? { 'content-security-policy': CB_CSP } : {}) } });
  if (path === '/cloudbite/request' || path === '/cloudbite/request/') return page(CLOUDBITE_REQUEST_HTML, 'text/html; charset=utf-8', true);
  if (path === '/cloudbite/requests' || path === '/cloudbite/requests/') return page(CLOUDBITE_REQUESTS_HTML, 'text/html; charset=utf-8', true);
  if (path === '/cloudbite/access.js') return page(CLOUDBITE_ACCESS_JS, 'text/javascript; charset=utf-8');
  if (path === '/cloudbite/access' || path === '/cloudbite/access/') return page(CLOUDBITE_ACCESS_HTML, 'text/html; charset=utf-8', true);
  if (path === '/cloudbite/access.css') return page(CLOUDBITE_ACCESS_CSS, 'text/css; charset=utf-8');
  if (path === '/cloudbite/access-qr.svg') return page(CLOUDBITE_ACCESS_QR, 'image/svg+xml; charset=utf-8');
  if (path === '/' || path === '/cloudbite' || path === '/cloudbite/' || path === '/cloudbite/history' || path === '/cloudbite/history/') return page(CLOUDBITE_HTML, 'text/html; charset=utf-8', true);
  // Asset paths are the ones the page itself references (exported next to the page by the UI build).
  if (path === CLOUDBITE_JS_PATH) return page(CLOUDBITE_JS, 'text/javascript; charset=utf-8');
  if (path === CLOUDBITE_CSS_PATH) return page(CLOUDBITE_CSS, 'text/css; charset=utf-8');
  return null;
}

export function cloudbiteBootstrap(env: Env): CloudbiteBootstrap {
  const missing = cloudbiteMissing(env, CLOUDBITE_EXPERTS.length);
  return { experts: [...CLOUDBITE_EXPERTS], configuration: { liveReady: missing.length === 0, missing, maxExperts: CB_MAX_EXPERTS, maxConcurrent: cbMaxConcurrent(env), ...(env.CLOUDBITE_HISTORY ? { historyRetentionDays: 30 } : {}),
    routing: { provider: 'typesafe', model: JEV_MODEL, ready: routingReady(env.TYPESAFE_API_KEY), maxExperts: CB_MAX_EXPERTS } }, pool: CLOUDBITE_POOL };
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
const isJsonObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const PMC_BODY_MAX = 1024;
/** Optional workflow fields an automatic (Jev) create forwards into the routing query exactly as sent. */
const ROUTED_FIELDS = ['decision', 'documents', 'stage', 'responseLanguage', 'budget', 'revision'] as const;

/**
 * The one effective team cap, used identically by /route, /preview and /projects (and part of the routing hash):
 * min(CB_MAX_EXPERTS, the visitor session's maxExperts, the stated budget's maxExperts).
 */
export function effectiveMaxExperts(session: CloudbiteAccessSession | null, budget?: Pick<ProjectBudget, 'maxExperts'>) {
  return Math.max(1, Math.min(CB_MAX_EXPERTS, session?.request?.maxExperts ?? CB_MAX_EXPERTS, budget?.maxExperts ?? CB_MAX_EXPERTS));
}

type Visitor = { cred: string; id: string };
type Prepared = { brief: ProjectBrief; routing?: CloudbiteRoutingDecision; maxExperts: number; session: CloudbiteAccessSession | null };
/**
 * Shared by preview and create (no divergent paths): visitor session binding, the cached Jev selection for automatic
 * mode (read only, never a new routing call), brief validation, live configuration and the effective team cap.
 */
async function prepareProject(req: Request, env: Env, input: unknown, visitor: Visitor | null, json: Json): Promise<Prepared | Response> {
  const ns = env.CLOUDBITE;
  const session = visitor ? await accessSession(req, env) : null;
  if (visitor && session?.request?.id !== visitor.id) return json({ error: 'approved access required' }, 401);
  let routing: CloudbiteRoutingDecision | undefined;
  if (isJsonObject(input) && 'routing' in input) {
    const { routing: kind, ...raw } = input;
    if (kind !== 'jev') return json({ error: 'unknown routing mode' }, 400);
    const query = routingQuery({ title: raw.title, objective: raw.objective, context: raw.context, requestId: raw.requestId,
      ...Object.fromEntries(ROUTED_FIELDS.filter((k) => k in raw).map((k) => [k, raw[k]])) });
    if (isRoutingFailure(query)) return json({ error: query.error }, query.status);
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    const router = ns.getByName('routing:' + await cbHash(visitor ? 'visitor:' + visitor.id : 'owner'));
    const chosen = await router.routingRead(query, effectiveMaxExperts(session, query.budget));
    if (isCbFail(chosen)) return json({ error: chosen.error }, chosen.status);
    if (raw.expertIds !== undefined && JSON.stringify(raw.expertIds) !== JSON.stringify(chosen.expertIds)) return json({ error: 'expert selection differs from the Jev routing decision' }, 409);
    routing = chosen;
    input = { ...raw, expertIds: chosen.expertIds };
  }
  const brief = validateBrief(input, visitor ? CLOUDBITE_EXPERTS : undefined);
  if (isInvalid(brief)) return json({ error: brief.invalid }, 400);
  if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
  if (brief.mode === 'live') {
    const missing = cloudbiteMissing(env, CLOUDBITE_EXPERTS.length);
    if (missing.length) return json({ error: `live execution is not configured; missing: ${missing.join(', ')}` }, 503);
  }
  return { brief, ...(routing ? { routing } : {}), maxExperts: effectiveMaxExperts(session, brief.budget), session };
}

/**
 * Follow-up round: the parent is bound ONLY by this request's own history actor (prepareHistory: owner credential or
 * the visitor's history cookie) reading the parent through parentDO.historyRead; brief.revision.parentId is a claim.
 * A foreign, deleted, expired or unfinished parent fails here, before any reservation or create.
 */
async function revisionRound(env: Env, brief: ProjectBrief, actor: string | undefined): Promise<ProjectPreviousRound | CbFail> {
  if (!brief.revision) return { error: 'not a revision', status: 400 };
  if (!actor) return { error: 'follow-up rounds need project history, which is not configured', status: 503 };
  const parentId = brief.revision.parentId, owner = actor === 'owner';
  let read: HistoryDetail | CbFail;
  try { read = PROJECT_ID.test(parentId) ? await env.CLOUDBITE!.getByName(parentId).historyRead(actor, owner) as HistoryDetail | CbFail : { error: 'parent project not found', status: 404 }; }
  catch { return { error: 'parent project could not be read; retry shortly', status: 503 }; }
  // authorizeRoundParent's WeakSet authorization cannot cross RPC: authorize and build here, pass only the built round.
  const auth = await authorizeRoundParent({ parentId, actor, owner, read, now: Date.now() });
  return isRoundFail(auth) ? auth : buildProjectRound(auth, brief);
}

/**
 * Cloudbite API and worker callbacks. null = not a Cloudbite path (legacy routing continues).
 * Live/demo creation reuses the existing State admin session (x-admin-token, State.adminList: storage reads only),
 * or a temporary Cloudbite operator token in the same header (src/cloudbite-operator.ts; this route only).
 * Without that header, a Cloudbite owner-session cookie (src/cloudbite-owner.ts) is checked before a visitor cookie;
 * State's cloudbiteOwner* methods are called only on /api/cloudbite/owner/* or when that cookie is presented.
 */
export async function cloudbiteRoute(req: Request, env: Env, url: URL, state: Pick<DurableObjectStub<State>, 'adminList'> & OwnerState, json: Json): Promise<Response | null> {
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
    const access = await accessSession(req, env);
    return json(access ? { ...cloudbiteBootstrap(env), access } : cloudbiteBootstrap(env));
  }

  // cbo_ = temporary Cloudbite operator: checked against its own secrets only, never sent to State.
  const isOwner = async (admin: string) => admin.startsWith(CB_OPERATOR_PREFIX) ? verifyCloudbiteOperator(env, admin)
    : !!admin && !isCbFail(await state.adminList(admin));
  const owned = await ownerRoute(req, env, path, state, json);
  if (owned) return owned;
  // A present x-admin-token header always decides by itself, even when empty (a wrong one never falls back to a cookie).
  const hasAdmin = req.headers.has('x-admin-token');
  const admin = req.headers.get('x-admin-token') ?? '';
  const ownerAuth = () => (hasAdmin ? isOwner(admin) : ownerCookieValid(req, env, state));
  const historyResponse = await historyRoute(req, env, url, ownerAuth, json);
  if (historyResponse) return historyResponse;
  const access = await accessRoute(req, env, path, ownerAuth, json);
  if (access) return access;

  const strictOrigin = () => req.headers.get('origin') === env.ORIGIN;

  if (path === '/api/cloudbite/route') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    const b = await readJson(req, CB_CREATE_BODY_MAX); if ('error' in b) return json({ error: b.error }, b.status);
    const owner = await ownerAuth();
    const visitor = hasAdmin || owner ? null : await visitorGrant.check(req, env);
    if (!owner && !visitor) return json({ error: 'admin session or approved access required' }, 401);
    const query = routingQuery(b.ok); if (isRoutingFailure(query)) return json({ error: query.error }, query.status);
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    const session = visitor ? await accessSession(req, env) : null;
    if (visitor && session?.request?.id !== visitor.id) return json({ error: 'approved access required' }, 401);
    const max = effectiveMaxExperts(session, query.budget);
    const router = ns.getByName('routing:' + await cbHash(owner ? 'owner' : 'visitor:' + visitor!.id));
    if (visitor && !session?.canCreate) {
      const cached = await router.routingRead(query, max);
      return isCbFail(cached) ? json({ error: 'visitor project quota exhausted' }, 429) : json(cached);
    }
    return result(json, await router.routingPlan(query, max));
  }

  if (path === '/api/cloudbite/projects' || path === '/api/cloudbite/preview') {
    const previewing = path === '/api/cloudbite/preview';
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    const b = await readJson(req, CB_CREATE_BODY_MAX);
    if ('error' in b) return json({ error: b.error }, b.status);
    // A present x-admin-token header (even empty) always takes the owner path (no fallback to a cookie when it is wrong).
    // Without one: a live owner-session cookie is the owner; otherwise an owner-approved visitor cookie may create its
    // own projects within the grant quota (docs/cloudbite/access-service.txt). A dead owner cookie grants nothing itself.
    const ownerSession = !hasAdmin && await ownerCookieValid(req, env, state);
    const visitor = hasAdmin || ownerSession ? null : await visitorGrant.check(req, env);
    if (hasAdmin ? !await isOwner(admin) : !ownerSession && !visitor) return json({ error: 'admin session required' }, 401);
    const prepared = await prepareProject(req, env, b.ok, visitor, json);
    if (prepared instanceof Response) return prepared;
    const { brief, routing, maxExperts } = prepared;
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    // Visitor: namespace the requestId by the grant (the project id derives from it).
    if (visitor) brief.requestId = await visitorRequestId(visitor.id, brief.requestId);
    const id = await cbProjectId(brief.requestId);
    const history = await prepareHistory(req, env, visitor?.cred ?? null);
    const created201 = (created: unknown) => {
      const response = json(created, 201);
      if (history?.cookie) response.headers.append('set-cookie', history.cookie);
      return response;
    };
    // Revision parent and plan are validated before any visitor slot, live slot, sandbox or project write.
    let round: ProjectPreviousRound | undefined;
    if (brief.revision) {
      const r = await revisionRound(env, brief, history?.actor);
      if (isCbFail(r)) {
        // An existing follow-up keeps its own copied reference even after its parent was deleted.
        const replay = previewing ? null : await ns.getByName(id).create(id, brief, history?.actor, routing, { maxExperts, replayOnly: true });
        if (replay && !isCbFail(replay)) return created201(replay);
        return json({ error: r.error }, r.status);
      }
      round = r;
    }
    const plan = await ns.getByName(id).preview(brief, routing, { maxExperts, ...(round ? { round } : {}) });
    if (previewing) {
      if (isCbFail(plan)) return json({ error: plan.error }, plan.status);
      if (visitor && !prepared.session?.canCreate) plan.warnings.push('This access grant has no project slot left; creating would be refused.');
      return json(plan);
    }
    if (isCbFail(plan)) {
      const replay = await ns.getByName(id).create(id, brief, history?.actor, routing, { maxExperts, replayOnly: true });
      return replay && !isCbFail(replay) ? created201(replay) : json({ error: plan.error }, plan.status);
    }
    // Visitor: atomically reserve one of the grant's project slots.
    let hold: { id: string; scoped: string } | null = null;
    if (visitor) {
      const r = await visitorGrant.reserve(env, visitor.cred, brief.requestId, brief.expertIds.length);
      if (isCbFail(r)) return json({ error: r.error }, r.status);
      hold = { id: r.id, scoped: brief.requestId };
    }
    // Only a definite "nothing was created" result frees the visitor's reservation; a thrown call keeps it (conservative).
    const refused = async (status: number, error: string) => {
      if (hold) await visitorGrant.release(env, hold.id, hold.scoped);
      return json({ error }, status);
    };
    if (brief.mode === 'live') {
      const slot = await ns.getByName('registry').registryAcquire(id);
      if (isCbFail(slot)) return refused(slot.status, slot.error);
    }
    const created = await ns.getByName(id).create(id, brief, history?.actor, routing, { maxExperts, ...(round ? { round } : {}) });
    // A failed first create must not hold a live slot. (Idempotent retries of an existing project return success.)
    if (isCbFail(created) && brief.mode === 'live' && created.status !== 409) await ns.getByName('registry').registryRelease(id);
    if (isCbFail(created)) {
      // 409 = the project already exists for this requestId: the binding stays.
      if (created.status !== 409) return refused(created.status, created.error);
      if (hold) await visitorGrant.confirm(env, hold.id, hold.scoped);
      return json({ error: created.error }, created.status);
    }
    if (hold) await visitorGrant.confirm(env, hold.id, hold.scoped);
    return created201(created);
  }

  if (path === '/api/cloudbite/pmc/import') {
    // Fixed PMC/NCBI import service only (src/cloudbite-pmc.ts); never a URL proxy. Authority before any external call.
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    const owner = await ownerAuth();
    const visitor = hasAdmin || owner ? null : await visitorGrant.check(req, env);
    if (!owner && !visitor) return json({ error: 'admin session or approved access required' }, 401);
    if (visitor) {
      const session = await accessSession(req, env);
      if (session?.request?.id !== visitor.id) return json({ error: 'approved access required' }, 401);
      if (!session.canCreate) return json({ error: 'visitor project quota exhausted' }, 429);
    }
    const b = await readJson(req, PMC_BODY_MAX);
    if ('error' in b) return json({ error: b.error }, b.status);
    if (!isJsonObject(b.ok) || Object.keys(b.ok).length !== 1 || typeof b.ok.identifier !== 'string') return json({ error: 'request body must be {identifier: string}' }, 400);
    if (!ns) return json({ error: 'Cloudbite is not configured' }, 503);
    const actor = owner ? 'owner' : 'v_' + await cbHash('cloudbite-pmc-actor|' + visitor!.id);
    const r = await ns.getByName('pmc-import').pmcImport(actor, b.ok.identifier);
    if (!isCbFail(r)) return json(r);
    const response = json({ error: r.error, code: r.code }, r.status);
    if (r.retryAfterSeconds !== undefined) response.headers.set('retry-after', String(r.retryAfterSeconds));
    return response;
  }

  const m = path.match(/^\/api\/cloudbite\/projects\/([^/]+)(\/cancel|\/artifact|\/review|\/memo)?$/);
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
  if (m[2] === '/review' || m[2] === '/memo') {
    // Opt-in paid passes (src/cloudbite-cross-review.ts, src/cloudbite-memo.ts): the body carries no options, only {}.
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!strictOrigin()) return json({ error: 'bad origin' }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    const b = await readJson(req, 256);
    if ('error' in b) return json({ error: b.error }, b.status);
    if (typeof b.ok !== 'object' || b.ok === null || Array.isArray(b.ok) || Object.keys(b.ok).length) return json({ error: 'request body must be an empty JSON object' }, 400);
    return result(json, m[2] === '/memo' ? await stub.memo(token) : await stub.crossReview(token));
  }
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (m[2] === '/artifact') return result(json, await stub.artifact(token, url.searchParams.get('expert'), url.searchParams.get('path')));
  return result(json, await stub.read(token));
}
