import type { Env } from './state';
import { cbHash, isCbFail } from './cloudbite-project';
import { historyDay, historyReport } from './cloudbite-history';
import { HISTORY_DAYS, HISTORY_TTL, HISTORY_ISSUES, type HistoryFeedback, type HistoryRow } from './cloudbite-history-contract';
import { PROJECT_ID } from './cloudbite-validate';
import { boundedText } from './cloudbite-inference';

type Json = (data: unknown, status?: number) => Response;
const COOKIE = /^cbh_[a-f0-9]{64}$/;
const cookieName = (env: Env) => env.CLOUDBITE_ALLOW_HTTP === '1' && env.ORIGIN.startsWith('http:') ? 'cb-history-dev' : '__Host-cb-history';
function viewer(req: Request, env: Env) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() === cookieName(env)) { const value = part.slice(i + 1).trim(); return COOKIE.test(value) ? value : null; }
  }
  return null;
}
/** A separate 30-day read-only history credential survives the one-hour visitor grant. It never authorizes runs. */
export async function prepareHistory(req: Request, env: Env, visitorCred: string | null) {
  if (!env.CLOUDBITE_HISTORY) return undefined;
  if (visitorCred === null) return { actor: 'owner', cookie: null };
  // Deterministic for first-create retries whose response (and Set-Cookie) was lost. Subsequent grants retain
  // an existing history cookie; its random secret is never placed in a URL, JSON response, index, or log.
  const token = viewer(req, env) ?? 'cbh_' + await cbHash('cloudbite-history-viewer-v1|' + visitorCred);
  const name = cookieName(env);
  return { actor: 'v_' + await cbHash(token), cookie: `${name}=${token}; Path=/; Max-Age=${HISTORY_TTL / 1000}; HttpOnly; SameSite=Strict${name.startsWith('__Host-') ? '; Secure' : ''}` };
}

const cursor = (row: HistoryRow) => btoa(JSON.stringify({ at: row.createdAt, id: row.id }));
async function newest(env: Env, actor: string | null, before: { at: number; id: string }, limit: number) {
  const out: HistoryRow[] = [], now = Date.now();
  for (let day = Math.min(historyDay(before.at), historyDay(now)); day >= historyDay(now - HISTORY_TTL) && out.length < limit; day--) {
    out.push(...await env.CLOUDBITE_HISTORY!.getByName('day:' + day).rows(actor, before, limit - out.length));
  }
  return out;
}
export async function historyRoute(req: Request, env: Env, url: URL, owner: () => Promise<boolean>, json: Json): Promise<Response | null> {
  const path = url.pathname;
  if (path !== '/api/cloudbite/history' && !path.startsWith('/api/cloudbite/history/')) return null;
  if (!env.CLOUDBITE_HISTORY || !env.CLOUDBITE) return json({ error: 'history is not configured' }, 503);
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return json({ error: 'method not allowed' }, 405);
  if (req.method !== 'GET' && req.headers.get('origin') !== env.ORIGIN) return json({ error: 'bad origin' }, 403);
  const isOwner = await owner();
  // Explicit operator-token headers never fall back to a history cookie when the token is rejected.
  const token = !req.headers.has('x-admin-token') && !isOwner ? viewer(req, env) : null;
  if (!isOwner && !token) return json({ error: 'history session required' }, 401);
  const actor = isOwner ? 'owner' : 'v_' + await cbHash(token!);
  try {
    if (path === '/api/cloudbite/history/report') {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (!isOwner) return json({ error: 'owner session required' }, 403);
      return json(historyReport(await newest(env, null, { at: Date.now() + 1, id: '~' }, 1000)));
    }
    if (path === '/api/cloudbite/history') {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const scope = url.searchParams.get('scope') ?? 'mine';
      if (!['mine', 'all'].includes(scope)) return json({ error: 'invalid scope' }, 400);
      if (scope === 'all' && !isOwner) return json({ error: 'owner session required' }, 403);
      let before = { at: Date.now() + 1, id: '~' };
      if (url.searchParams.has('before')) {
        try { before = JSON.parse(atob(url.searchParams.get('before')!)); } catch { return json({ error: 'invalid cursor' }, 400); }
        if (!before || !Number.isSafeInteger(before.at) || before.at < 1 || !PROJECT_ID.test(before.id)) return json({ error: 'invalid cursor' }, 400);
      }
      const rows = await newest(env, scope === 'all' ? null : actor, before, 51), shown = rows.slice(0, 50);
      return json({ rows: shown.map(({ actor: _actor, roles: _roles, experts, feedback, revision: _revision, deleted: _deleted, ...p }) => ({ ...p, expertCount: experts.length, feedbackCount: feedback.length, ...(isOwner ? { browser: _actor === 'owner' ? 'owner' : 'browser-' + _actor.slice(2, 14) } : {}) })),
        next: rows.length > 50 ? cursor(shown[shown.length - 1]) : null, owner: isOwner, retentionDays: HISTORY_DAYS });
    }
    const m = path.match(/^\/api\/cloudbite\/history\/(cb[0-9a-f]{32})(\/feedback|\/adopt)?$/);
    if (!m) return json({ error: 'not found' }, 404);
    const project = env.CLOUDBITE.getByName(m[1]);
    if (req.method === 'GET' && !m[2]) {
      const r = await project.historyRead(actor, isOwner);
      return isCbFail(r) ? json({ error: r.error }, r.status) : json(r);
    }
    if (req.method === 'DELETE' && !m[2]) {
      const r = await project.historyDelete(actor, isOwner);
      return isCbFail(r) ? json({ error: r.error }, r.status) : json(r);
    }
    if (req.method !== 'POST' || !m[2]) return json({ error: 'method not allowed' }, 405);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415);
    let b: Record<string, unknown>;
    try {
      const raw = await boundedText(req, 8 * 1024);
      b = JSON.parse(raw);
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
    } catch { return json({ error: `${m[2] === '/adopt' ? 'adoption' : 'feedback'} must be a JSON object within 8 KiB` }, 400); }
    if (m[2] === '/adopt') {
      const r = await project.historyAdopt(actor, isOwner, b);
      return isCbFail(r) ? json({ error: r.error }, r.status) : json(r);
    }
    const issue = HISTORY_ISSUES.find(x => x === b.issue);
    if (Object.keys(b).some(k => !['expertId', 'rating', 'issue', 'comment'].includes(k)) || typeof b.expertId !== 'string' ||
      (b.rating !== 'helpful' && b.rating !== 'unhelpful') || typeof b.comment !== 'string' || b.comment.length > 1000 ||
      (b.issue !== undefined && !issue)) return json({ error: 'invalid feedback' }, 400);
    const feedback: Omit<HistoryFeedback, 'at'> = { expertId: b.expertId, rating: b.rating, comment: b.comment, ...(issue ? { issue } : {}) };
    const r = await project.historyFeedback(actor, feedback);
    return isCbFail(r) ? json({ error: r.error }, r.status) : json(r);
  } catch { return json({ error: 'history is temporarily unavailable; retry shortly' }, 503); }
}
