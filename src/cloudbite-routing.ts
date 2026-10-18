// Jev judges semantic suitability; code owns identities, authorization, quotas and execution.
// This module never fetches a user-supplied URL and never returns provider bodies or credentials.
import type { ExpertDefinition, CloudbiteRoutingDecision, CloudbiteRoutingQuery } from './cloudbite-contract';
import { CLOUDBITE_POOL } from './cloudbite-pool';
import { boundedText } from './cloudbite-inference';
import { CB_MAX_EXPERTS } from './cloudbite-config';
import { CATALOGUE_MAX_ROLES } from './cloudbite-catalogue-limits';
import { HARNESS_VERSION, harnessAssessmentRequest, parseHarnessAssessment, harnessReviewRequest, parseHarnessReview, composeHarnessTeam, type HarnessCandidate } from './cloudbite-routing-harness';

export const JEV_MODEL = 'jev-1.13.0';
export const ROUTING_POLICY = 'jev-routing/v2';
export const ROUTING_THRESHOLD = 0.65;
export const ROUTING_TTL = 10 * 60_000;
const REQUEST_TIMEOUT = 20_000;
const LEASE = 50_000; // two bounded 20-second provider calls plus local composition
const MAX_RECORDS = 20;
const PER_MINUTE = 6;
const KEY = 'routing:state';
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const plans = new Map(CLOUDBITE_POOL.entries.filter(e => e.expertId).map(e => [e.expertId!, e]));
export interface RoutingFailure { error: string; status: number }
const fail = (status: number, error: string): RoutingFailure => ({ status, error });
export const isRoutingFailure = (r: unknown): r is RoutingFailure => !!r && typeof r === 'object' && 'error' in r && 'status' in r;
export function routingReady(key: unknown): boolean { return typeof key === 'string' && key.trim().length > 0; }

export function routingQuery(raw: unknown): CloudbiteRoutingQuery | RoutingFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'routing query must be an object');
  const q = raw as Record<string, unknown>;
  if (Object.keys(q).some(k => !['title', 'objective', 'context', 'requestId'].includes(k))) return fail(400, 'unknown routing query field');
  if (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 120 || /[\u0000-\u001f\u007f]/.test(q.title)) return fail(400, 'title must be 1-120 characters');
  if (typeof q.objective !== 'string' || !q.objective.trim() || q.objective.length > 2000) return fail(400, 'objective must be 1-2000 characters');
  if (typeof q.context !== 'string' || q.context.length > 8000) return fail(400, 'context must be at most 8000 characters');
  if (typeof q.requestId !== 'string' || !ID.test(q.requestId)) return fail(400, 'invalid routing requestId');
  return { title: q.title, objective: q.objective, context: q.context, requestId: q.requestId };
}

/** Every runnable role, never a silent prefix. A catalogue above CATALOGUE_MAX_ROLES is refused by askJev instead. */
export function routingCandidates(experts: readonly ExpertDefinition[]): HarnessCandidate[] {
  return experts.map(expert => ({ id: expert.id, name: expert.name, domain: expert.domain,
    mission: plans.get(expert.id)?.mission ?? expert.summary.slice(0, 240), summary: expert.summary.slice(0, 600),
    category: plans.get(expert.id)?.category ?? expert.domain }));
}
async function hash(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function routingQueryHash(query: CloudbiteRoutingQuery, experts: readonly ExpertDefinition[], max: number) {
  return hash(JSON.stringify({ title: query.title, objective: query.objective, context: query.context, max,
    policy: ROUTING_POLICY, harness: HARNESS_VERSION, model: JEV_MODEL, candidates: routingCandidates(experts) }));
}

/** All registered candidates are evaluated; code, not a generated team list, owns composition. */
export function jevRoutingRequest(query: CloudbiteRoutingQuery, experts: readonly ExpertDefinition[]) {
  return harnessAssessmentRequest(query, routingCandidates(experts));
}

async function evaluateJev(body: unknown, key: string, transport: typeof fetch): Promise<{ raw: unknown } | RoutingFailure> {
  let response: Response;
  try {
    response = await transport('https://api.typesafe.ai/v1/systemone', { method: 'POST',
      headers: { authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
  } catch { return fail(503, 'Jev routing is temporarily unavailable'); }
  if (!response.ok) {
    await response.body?.cancel();
    return fail(response.status === 429 ? 429 : 503, response.status === 429 ? 'Jev routing rate limit reached; retry later' : 'Jev routing is temporarily unavailable');
  }
  try { return { raw: JSON.parse(await boundedText(response, 256 * 1024)) }; }
  catch { return fail(502, 'Jev returned an invalid routing decision'); }
}

/** Assessment and team review are one durable actor claim. No partial/fallback team is executable. */
export async function askJev(query: CloudbiteRoutingQuery, experts: readonly ExpertDefinition[], key: string, max: number,
  queryHash: string, now: number, transport: typeof fetch = fetch): Promise<CloudbiteRoutingDecision | RoutingFailure> {
  if (!routingReady(key)) return fail(503, 'Jev routing is not configured');
  if (!Number.isInteger(max) || max < 1 || max > CB_MAX_EXPERTS) return fail(400, 'invalid routing selection limit');
  const catalogue = routingCandidates(experts);
  if (catalogue.length > CATALOGUE_MAX_ROLES) return fail(503, 'Jev routing catalogue exceeds its bound');
  if (!catalogue.length) return fail(422, 'No relevant expert matched; add a specific question and context');
  const assessmentResponse = await evaluateJev(harnessAssessmentRequest(query, catalogue), key, transport);
  if (isRoutingFailure(assessmentResponse)) return assessmentResponse;
  let assessment;
  try { assessment = parseHarnessAssessment(assessmentResponse.raw, catalogue); }
  catch { return fail(502, 'Jev returned an invalid project assessment'); }
  if (!catalogue.some(c => assessment.relevance[c.id] >= ROUTING_THRESHOLD)) return fail(422, 'No relevant expert matched; add a specific question and context');
  const reviewBody = harnessReviewRequest(query, catalogue, assessment);
  // A single expert with no requested perspectives or overlap pairs needs no paid empty review request.
  const reviewResponse = Object.keys(reviewBody.questions).length
    ? await evaluateJev(reviewBody, key, transport)
    : { raw: { model: JEV_MODEL, answers: {} } };
  if (isRoutingFailure(reviewResponse)) return reviewResponse;
  try {
    const review = parseHarnessReview(reviewResponse.raw, catalogue, assessment);
    const team = composeHarnessTeam(catalogue, assessment, review, max);
    if (!team.expertIds.length) return fail(422, 'No relevant expert matched; add a specific question and context');
    return { provider: 'typesafe', model: JEV_MODEL, policyVersion: ROUTING_POLICY, evaluatedCount: catalogue.length,
      threshold: ROUTING_THRESHOLD, ...team, queryHash, expiresAt: now + ROUTING_TTL };
  } catch { return fail(502, 'Jev returned an invalid team review'); }
}

interface RoutingRecord { queryHash: string; claim: string; leaseUntil: number; expiresAt: number; result?: CloudbiteRoutingDecision }
interface RoutingState { calls: number[]; records: { [requestId: string]: RoutingRecord } }
/** One actor-specific DO, no raw brief or credential persisted. Claims precede network I/O. */
export class RoutingSession {
  constructor(private storage: DurableObjectStorage, private experts: readonly ExpertDefinition[], private key: string | undefined,
    private clock: () => number = Date.now, private transport: typeof fetch = fetch) {}
  async plan(raw: CloudbiteRoutingQuery, max: number): Promise<CloudbiteRoutingDecision | RoutingFailure> {
    const query = routingQuery(raw); if (isRoutingFailure(query)) return query;
    if (!routingReady(this.key)) return fail(503, 'Jev routing is not configured');
    if (!Number.isInteger(max) || max < 1 || max > CB_MAX_EXPERTS) return fail(400, 'invalid routing selection limit');
    const queryHash = await routingQueryHash(query, this.experts, max), now = this.clock(), claim = crypto.randomUUID();
    const recordId = 'r:' + query.requestId; // never use attacker-chosen __proto__/constructor as object keys
    const reserved = await this.storage.transaction(async tx => {
      const state = await tx.get<RoutingState>(KEY) ?? { calls: [], records: {} };
      const existing = state.records[recordId];
      if (existing && existing.expiresAt > now) {
        if (existing.queryHash !== queryHash) return fail(409, 'routing requestId belongs to a different question');
        if (existing.result) return existing.result;
        if (existing.leaseUntil > now) return fail(409, 'Jev routing is already in progress');
      }
      state.calls = state.calls.filter(t => t > now - 60_000);
      if (state.calls.length >= PER_MINUTE) return fail(429, 'at most 6 new routing requests per minute');
      state.records = Object.fromEntries(Object.entries(state.records).filter(([, r]) => r.expiresAt > now));
      if (Object.keys(state.records).length >= MAX_RECORDS && !state.records[recordId]) return fail(429, 'routing session is full; retry after earlier decisions expire');
      state.calls.push(now);
      state.records[recordId] = { queryHash, claim, leaseUntil: now + LEASE, expiresAt: now + ROUTING_TTL };
      await tx.put(KEY, state);
      await tx.put('routing:instance', true);
      return null;
    });
    if (reserved) return reserved;
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > now + ROUTING_TTL) await this.storage.setAlarm(now + ROUTING_TTL);
    const result = await askJev(query, this.experts, this.key!, max, queryHash, now, this.transport);
    return this.storage.transaction(async tx => {
      const state = await tx.get<RoutingState>(KEY);
      const record = state?.records[recordId];
      if (!state || !record || record.claim !== claim || record.expiresAt <= this.clock()) return fail(409, 'routing decision expired; route the question again');
      if (isRoutingFailure(result)) { delete state.records[recordId]; await tx.put(KEY, state); return result; }
      record.result = result; record.leaseUntil = 0;
      await tx.put(KEY, state);
      return result;
    });
  }
  async read(raw: CloudbiteRoutingQuery, max: number): Promise<CloudbiteRoutingDecision | RoutingFailure> {
    const query = routingQuery(raw); if (isRoutingFailure(query)) return query;
    const state = await this.storage.get<RoutingState>(KEY), record = state?.records['r:' + query.requestId];
    if (!record?.result || record.expiresAt <= this.clock()) return fail(409, 'route this question with Jev before starting');
    if (record.queryHash !== await routingQueryHash(query, this.experts, max)) return fail(409, 'question or selection limit changed; route it again');
    return record.result;
  }
  async cleanup() {
    const state = await this.storage.get<RoutingState>(KEY); if (!state) return;
    const now = this.clock();
    state.calls = state.calls.filter(t => t > now - 60_000);
    state.records = Object.fromEntries(Object.entries(state.records).filter(([, r]) => r.expiresAt > now));
    if (!state.calls.length && !Object.keys(state.records).length) await this.storage.delete(KEY);
    else { await this.storage.put(KEY, state); await this.storage.setAlarm(Math.min(...Object.values(state.records).map(r => r.expiresAt), now + ROUTING_TTL)); }
  }
}
