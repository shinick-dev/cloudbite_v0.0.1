// One SQLite-backed index per UTC day. Full questions, answers and feedback stay in their project DO.
// Index rows contain bounded metadata; callers never supply actor identity over HTTP.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './state';
import type { HistoryIdentity, HistoryRow, HistoryFeedback, HistoryReport } from './cloudbite-history-contract';
import { HISTORY_TTL } from './cloudbite-history-contract';
import type { ProjectRun } from './cloudbite-contract';

export const historyDay = (at: number) => Math.floor(at / 86400_000);
export const historyIndex = (env: Env, at: number) => env.CLOUDBITE_HISTORY!.getByName('day:' + historyDay(at));
export function historyRow(p: ProjectRun, h: HistoryIdentity, feedback: HistoryFeedback[]): HistoryRow {
  const deleted = h.deleted === true;
  return {
    id: p.id, actor: h.actor, title: deleted ? '' : p.brief.title, mode: p.brief.mode, status: p.status,
    createdAt: p.createdAt, updatedAt: p.updatedAt, expiresAt: p.createdAt + HISTORY_TTL,
    revision: h.revision, deleted, model: h.model, roles: deleted ? [] : h.roles,
    experts: deleted ? [] : p.experts.map(e => ({ id: e.expertId, status: e.status, confidence: e.opinion?.confidence,
      // Presence of a reference is a syntax signal, not verification of its truth or the underlying source.
      referenced: e.opinion?.evidence.some(s => /https?:\/\/\S+|\[source:[a-zA-Z0-9._-]+\]/.test(s)) ?? false,
      ...(e.error ? { errorKind: errorKind(e.error) } : {}),
    })), feedback: deleted ? [] : feedback.map(({ comment: _comment, ...f }) => ({ ...f, comment: '' })),
  };
}
function errorKind(s: string) {
  if (/schema|out\/result|invalid.*json|not json|result format/i.test(s)) return 'format';
  if (/timed? ?out|deadline/i.test(s)) return 'timeout';
  if (/429|rate.limit/i.test(s)) return 'rate-limit';
  if (/402|credit|payment|budget/i.test(s)) return 'budget';
  if (/daytona|sandbox|toolbox/i.test(s)) return 'sandbox';
  if (/nosana|inference|model|upstream/i.test(s)) return 'inference';
  return 'other';
}

export class CloudbiteHistory extends DurableObject<Env> {
  private initialized = false;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.ready(); }
  private ready() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, actor TEXT NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, data TEXT NOT NULL)');
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS history_actor_date ON history(actor, created_at DESC, id DESC)');
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS history_date ON history(created_at DESC, id DESC)');
    this.initialized = true;
  }
  async upsert(row: HistoryRow) {
    this.ready();
    if (row.expiresAt <= Date.now()) return;
    this.ctx.storage.sql.exec('INSERT INTO history (id, actor, created_at, revision, deleted, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, deleted=excluded.deleted, data=excluded.data WHERE excluded.revision > history.revision AND history.actor=excluded.actor',
      row.id, row.actor, row.createdAt, row.revision, row.deleted ? 1 : 0, JSON.stringify(row));
    await this.ctx.storage.setAlarm((historyDay(row.createdAt) + 1) * 86400_000 + HISTORY_TTL);
  }
  async rows(actor: string | null, before: { at: number; id: string }, limit: number): Promise<HistoryRow[]> {
    this.ready();
    const where = 'deleted=0 AND created_at>? AND (created_at<? OR (created_at=? AND id<?))';
    const args: (number | string)[] = [Date.now() - HISTORY_TTL, before.at, before.at, before.id];
    if (actor !== null) args.push(actor);
    args.push(Math.max(1, Math.min(1001, limit)));
    return this.ctx.storage.sql.exec<{ data: string }>(`SELECT data FROM history WHERE ${where}${actor !== null ? ' AND actor=?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args).toArray().map(r => JSON.parse(r.data) as HistoryRow);
  }
  async alarm() { await this.ctx.storage.deleteAll(); this.initialized = false; }
}

/** Bounded sample of newest records; demo runs are explicitly excluded from all quality denominators. */
export function historyReport(rows: HistoryRow[], sampleLimit = 1000): HistoryReport {
  const r: HistoryReport = { sampleLimit, analyzed: rows.length, live: 0, demoExcluded: 0, pending: 0, experts: 0, completed: 0, failed: 0, cancelled: 0,
    referenced: 0, uniformConfidenceProjects: 0, confidenceBins: [0, 0, 0, 0, 0], feedback: { helpful: 0, unhelpful: 0, issues: {} }, errors: {}, roles: [], models: [], insights: [] };
  const roles = new Map<string, HistoryReport['roles'][number]>(), models = new Map<string, HistoryReport['models'][number]>();
  for (const p of rows) {
    if (p.mode === 'demo') { r.demoExcluded++; continue; }
    r.live++;
    if (p.status === 'running' || p.status === 'draft') { r.pending++; continue; }
    const model = models.get(p.model) ?? { model: p.model, projects: 0, failed: 0 }; model.projects++; models.set(p.model, model);
    const confidences: number[] = [];
    for (const e of p.experts) {
      const source = p.roles.find(x => x.id === e.id);
      const role = roles.get(e.id) ?? { id: e.id, completed: 0, failed: 0, referenced: 0, unhelpful: 0, basis: source?.basis ?? 'unknown', revisions: [] };
      if (source && !role.revisions.includes(source.promptHash)) role.revisions.push(source.promptHash);
      r.experts++;
      if (e.status === 'completed') {
        r.completed++; role.completed++; if (e.referenced) { r.referenced++; role.referenced++; }
        if (typeof e.confidence === 'number') { confidences.push(e.confidence); r.confidenceBins[Math.min(4, Math.floor(e.confidence / 20))]++; }
      } else if (e.status === 'failed') {
        r.failed++; role.failed++; model.failed++; const kind = e.errorKind ?? 'other'; r.errors[kind] = (r.errors[kind] ?? 0) + 1;
      } else if (e.status === 'cancelled') r.cancelled++;
      const f = p.feedback.find(x => x.expertId === e.id);
      if (f?.rating === 'helpful') r.feedback.helpful++;
      if (f?.rating === 'unhelpful') { r.feedback.unhelpful++; role.unhelpful++; if (f.issue) r.feedback.issues[f.issue] = (r.feedback.issues[f.issue] ?? 0) + 1; }
      roles.set(e.id, role);
    }
    if (confidences.length >= 3 && new Set(confidences).size === 1) r.uniformConfidenceProjects++;
  }
  r.roles = [...roles.values()].sort((a, b) => b.failed + b.unhelpful - a.failed - a.unhelpful || a.id.localeCompare(b.id));
  r.models = [...models.values()];
  if (r.failed) r.insights.push({ kind: 'execution', count: r.failed, total: r.experts });
  if (r.completed > r.referenced) r.insights.push({ kind: 'sources', count: r.completed - r.referenced, total: r.completed });
  if (r.uniformConfidenceProjects) r.insights.push({ kind: 'confidence', count: r.uniformConfidenceProjects, total: r.live - r.pending });
  if (r.feedback.unhelpful) r.insights.push({ kind: 'feedback', count: r.feedback.unhelpful, total: r.feedback.helpful + r.feedback.unhelpful });
  const general = r.roles.filter(x => x.basis === 'metadata-derived').reduce((n, x) => n + x.completed, 0);
  if (general) r.insights.push({ kind: 'knowledge', count: general, total: r.completed });
  return r;
}
