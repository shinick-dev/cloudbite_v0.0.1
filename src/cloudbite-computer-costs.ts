// Owner-authenticated, read-only cost view for the Cloudbite computer. Call only after the root router authenticates the owner:
//   GET /api/cloudbite/computer/costs[?refresh=1] -> computerCosts(env, { refresh, ownerTag }) -> { status: 200, body: CostsView }
// Sources (official, verified read-only 2026-10-19):
//   Daytona OpenAPI https://www.daytona.io/docs/openapi.json
//     GET /sandbox?limit&cursor                     -> { items: Sandbox[], nextCursor }  (cpu, memory GiB, disk GiB, gpu, state, organizationId)
//     GET /organizations/{organizationId}/usage     -> { regionUsage: [{ regionId, sandboxClass, current*/total* Cpu·Memory·Disk, max*PerSandbox }] }
//   Daytona billing https://www.daytona.io/docs/en/billing: started = all reserved resources, stopped = reserved disk only, archived = not
//     billed. There is no balance/wallet API (dashboard only), so the balance is never fetched or guessed.
//   Nosana OpenAPI https://api.nosana.com/api/openapi.json: GET /credits/balance (Bearer key) -> { assignedCredits, reservedCredits,
//     settledCredits }; available = assigned - reserved - settled (https://learn.nosana.com/api/credits.html).
// IMPORTANT: the live API returns USD, despite its OpenAPI descriptions saying "USD cents". Verified 2026-10-19 against
// /credits/transactions amountUsd: a 50-minute $0.303 reservation is reported as 0.303 credits, not 30.3. Do not divide by 100.
// Only GETs with the explicitly configured keys at fixed URLs: no writes, credit transfers, scaling or budget enforcement. Hourly figures
// are estimates from COMPUTER_PRICING (running: CPU+RAM+disk; stopped: disk only), not bills. Snapshots, volumes, network and GPU
// sandboxes have no proven rate here and are listed as excluded rather than added to any total. A failed or refused provider call
// (e.g. Daytona 403) is "unavailable" with a fixed error code, never zero; upstream bodies, emails and keys are never returned.

import type { ComputerAccount, ComputerEnv } from './cloudbite-computer-contract';
import { computerAccounts, COMPUTER_LABEL_OWNER } from './cloudbite-computer-contract';
import { COMPUTER_PRICING, computerHourlyCost } from './cloudbite-computer-performance';

export const COSTS_NOSANA_BALANCE_URL = 'https://api.nosana.com/api/credits/balance';
export const COSTS_CACHE_MS = 60_000;
export const COSTS_MIN_REFRESH_MS = 10_000; // an explicit refresh still reuses a cache younger than this
export const COSTS_TIMEOUT_MS = 10_000;     // per upstream request
export const COSTS_PAGE_LIMIT = 100;
export const COSTS_MAX_PAGES = 2;           // per account; more is reported as truncated (partial)
export const COSTS_BODY_MAX = 1024 * 1024;
export const COSTS_MAX_REGIONS = 20;
const CACHE_MAX = 8;
const LINKS = {
  daytonaPricing: COMPUTER_PRICING.url,
  daytonaBilling: 'https://www.daytona.io/docs/en/billing',
  daytonaWallet: 'https://app.daytona.io/dashboard/billing/wallet',
  nosanaCredits: 'https://learn.nosana.com/api/credits.html',
  nosanaDashboard: 'https://dashboard.nosana.com/',
} as const;

export type CostsError = 'unauthorized' | 'forbidden' | 'timeout' | 'unreachable' | 'rate_limited' | 'upstream_error' | 'invalid_response';
export type CostsPhase = 'running' | 'stopped' | 'archived' | 'other';
export type CostsRateBasis = 'running_all' | 'stopped_disk' | 'archived_free' | 'unknown';
export interface CostsSandbox {
  id: string; name: string; state: string; phase: CostsPhase; region: string | null;
  cpu: number | null; memoryGiB: number | null; diskGiB: number | null; gpu: number | null; computer: boolean;
  usdPerHour: number | null; rateBasis: CostsRateBasis;
}
export interface CostsTotals { runningUsdPerHour: number; stoppedUsdPerHour: number; unknownRate: number }
export interface CostsUsed { used: number | null; quota: number | null }
export interface CostsRegion {
  regionId: string; sandboxClass: string; cpu: CostsUsed; memoryGiB: CostsUsed; diskGiB: CostsUsed;
  maxCpuPerSandbox: number | null; maxMemoryPerSandbox: number | null; maxDiskPerSandbox: number | null;
}
export interface CostsAccount {
  id: ComputerAccount; status: 'ok' | 'partial' | 'unavailable'; error: CostsError | null;
  sandboxes: CostsSandbox[]; truncated: boolean;
  totals: CostsTotals & { running: number; stopped: number; archived: number; other: number };
  usage: { status: 'ok' | 'unavailable' | 'unknown'; error: CostsError | null; regions: CostsRegion[] };
  balance: { status: 'not_available_via_api'; dashboardUrl: string };
}
export interface CostsNosana {
  status: 'ok' | 'not_configured' | 'unavailable' | 'invalid_response'; error: CostsError | null; unit: 'usd' | null;
  assignedUsd: number | null; reservedUsd: number | null; settledUsd: number | null; availableUsd: number | null; dashboardUrl: string;
}
export interface CostsView {
  ok: true; observedAt: string; cacheAgeMs: number; cached: boolean; partial: boolean;
  pricing: {
    daytona: { asOf: string; url: string; estimated: true; cpuPerHour: number; memoryGiBPerHour: number; diskGiBPerHour: number; freeDiskGiB: number; billingUrl: string };
    nosana: { url: string };
  };
  daytona: { accounts: CostsAccount[]; totals: CostsTotals };
  nosana: CostsNosana;
  excluded: readonly string[];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface CostsDeps { fetch: Fetcher; now(): number }
export interface CostsOptions { refresh?: boolean; ownerTag?: string | null; deps?: Partial<CostsDeps> }

const ID = /^[a-zA-Z0-9_-]{8,128}$/;
const ORG = /^[a-zA-Z0-9_-]{1,128}$/;
const EMAIL = /[^\s@]+@[^\s@]+/g;
const clean = (v: unknown, n = 128) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(EMAIL, '[redacted]').slice(0, n) : '';
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const size = (v: unknown): number | null => { const n = finite(v); return n !== null && n >= 0 ? n : null; };
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

type Got = { ok: true; json: unknown } | { ok: false; error: CostsError };
/** One bounded GET. Only the status class leaves this function; the upstream body is parsed as JSON or discarded. */
async function getJson(f: Fetcher, url: string, key: string, headers: Record<string, string> = {}): Promise<Got> {
  let r: Response;
  try {
    r = await f(url, { method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(COSTS_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: unknown })?.name;
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
  const drop = async (error: CostsError): Promise<Got> => { try { await r.body?.cancel(); } catch { /* closed */ } return { ok: false, error }; };
  if (r.status === 401) return drop('unauthorized');
  if (r.status === 403) return drop('forbidden');
  if (r.status === 408) return drop('timeout');
  if (r.status === 429) return drop('rate_limited');
  if (r.status !== 200) return drop('upstream_error');
  if (Number(r.headers?.get?.('content-length')) > COSTS_BODY_MAX) return drop('invalid_response');
  let text: string;
  try { text = await r.text(); } catch { return { ok: false, error: 'unreachable' }; }
  if (text.length > COSTS_BODY_MAX) return { ok: false, error: 'invalid_response' };
  try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, error: 'invalid_response' }; }
}

const PHASE: Record<string, CostsPhase> = { started: 'running', stopped: 'stopped', archived: 'archived' };
function sandbox(r: unknown, ownerTag: string | null): (CostsSandbox & { org: string | null }) | null {
  if (!isObj(r) || typeof r.id !== 'string' || !ID.test(r.id)) return null;
  const state = clean(r.state, 48), phase = PHASE[state] ?? 'other';
  const cpu = size(r.cpu), memoryGiB = size(r.memory), diskGiB = size(r.disk), gpu = size(r.gpu);
  let usdPerHour: number | null = null, rateBasis: CostsRateBasis = 'unknown';
  // GPU sandboxes have no rate in COMPUTER_PRICING: unknown, never the CPU-only figure
  if (gpu === 0) {
    if (phase === 'running' && cpu !== null && memoryGiB !== null && diskGiB !== null) { usdPerHour = computerHourlyCost({ cpu, memoryGiB, diskGiB }); rateBasis = 'running_all'; }
    else if (phase === 'stopped' && diskGiB !== null) { usdPerHour = computerHourlyCost({ cpu: 0, memoryGiB: 0, diskGiB }); rateBasis = 'stopped_disk'; }
    else if (phase === 'archived') { usdPerHour = 0; rateBasis = 'archived_free'; }
  }
  const labels = isObj(r.labels) ? r.labels : {};
  return {
    id: r.id, name: clean(r.name) || r.id, state: state || 'unknown', phase, region: clean(r.target ?? r.region, 48) || null,
    cpu, memoryGiB, diskGiB, gpu, computer: !!ownerTag && labels[COMPUTER_LABEL_OWNER] === ownerTag, usdPerHour, rateBasis,
    org: typeof r.organizationId === 'string' && ORG.test(r.organizationId) ? r.organizationId : null,
  };
}

function region(r: unknown): CostsRegion | null {
  if (!isObj(r)) return null;
  const regionId = clean(r.regionId, 48);
  if (!regionId) return null;
  const pair = (u: string, q: string): CostsUsed => ({ used: size(r[u]), quota: size(r[q]) });
  return {
    regionId, sandboxClass: clean(r.sandboxClass, 32), cpu: pair('currentCpuUsage', 'totalCpuQuota'), memoryGiB: pair('currentMemoryUsage', 'totalMemoryQuota'),
    diskGiB: pair('currentDiskUsage', 'totalDiskQuota'), maxCpuPerSandbox: size(r.maxCpuPerSandbox), maxMemoryPerSandbox: size(r.maxMemoryPerSandbox), maxDiskPerSandbox: size(r.maxDiskPerSandbox),
  };
}

function totals(list: CostsSandbox[]): CostsTotals {
  let run = 0, stop = 0, unknownRate = 0;
  for (const s of list) {
    if (s.usdPerHour === null) { unknownRate++; continue; }
    if (s.phase === 'running') run += s.usdPerHour; else if (s.phase === 'stopped') stop += s.usdPerHour;
  }
  return { runningUsdPerHour: round(run), stoppedUsdPerHour: round(stop), unknownRate };
}

async function account(f: Fetcher, a: { id: ComputerAccount; api: string; key: string }, ownerTag: string | null): Promise<CostsAccount> {
  const rows: Array<CostsSandbox & { org: string | null }> = [];
  let cursor: string | undefined, error: CostsError | null = null, truncated = false, pages = 0;
  for (; pages < COSTS_MAX_PAGES; pages++) {
    const q = new URLSearchParams({ limit: String(COSTS_PAGE_LIMIT) });
    if (cursor) q.set('cursor', cursor);
    const got = await getJson(f, `${a.api}/sandbox?${q}`, a.key);
    if (!got.ok) { error = got.error; break; }
    const raw = got.json;
    const items = Array.isArray(raw) ? raw : isObj(raw) ? raw.items : null;
    if (!Array.isArray(items)) { error = 'invalid_response'; break; }
    for (const r of items) { const s = sandbox(r, ownerTag); if (s) rows.push(s); }
    cursor = isObj(raw) && typeof raw.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor.slice(0, 512) : undefined;
    if (!cursor) break;
  }
  if (!error && cursor) truncated = true;

  const org = rows.find((s) => s.org)?.org ?? null;
  let usage: CostsAccount['usage'] = { status: 'unknown', error: null, regions: [] };
  if (org) {
    const got = await getJson(f, `${a.api}/organizations/${encodeURIComponent(org)}/usage`, a.key);
    if (!got.ok) usage = { status: 'unavailable', error: got.error, regions: [] };
    else if (!isObj(got.json) || !Array.isArray(got.json.regionUsage)) usage = { status: 'unavailable', error: 'invalid_response', regions: [] };
    else usage = { status: 'ok', error: null, regions: got.json.regionUsage.slice(0, COSTS_MAX_REGIONS).map(region).filter((x): x is CostsRegion => !!x) };
  }

  const sandboxes: CostsSandbox[] = rows.map(({ org: _o, ...s }) => s);
  const count = (p: CostsPhase) => sandboxes.filter((s) => s.phase === p).length;
  const listed = pages > 0 || rows.length > 0;
  return {
    id: a.id, status: error ? (listed ? 'partial' : 'unavailable') : truncated ? 'partial' : 'ok', error, sandboxes, truncated,
    totals: { ...totals(sandboxes), running: count('running'), stopped: count('stopped'), archived: count('archived'), other: count('other') },
    usage, balance: { status: 'not_available_via_api', dashboardUrl: LINKS.daytonaWallet },
  };
}

async function nosana(f: Fetcher, key: string | undefined): Promise<CostsNosana> {
  const base = { unit: null, assignedUsd: null, reservedUsd: null, settledUsd: null, availableUsd: null, dashboardUrl: LINKS.nosanaDashboard };
  if (!key) return { status: 'not_configured', error: null, ...base };
  const got = await getJson(f, COSTS_NOSANA_BALANCE_URL, key, { 'user-agent': 'CloudBiteCompute/1.0' });
  if (!got.ok) return { status: 'unavailable', error: got.error, ...base };
  const j = got.json;
  const a = isObj(j) ? finite(j.assignedCredits) : null, r = isObj(j) ? finite(j.reservedCredits) : null, s = isObj(j) ? finite(j.settledCredits) : null;
  if (a === null || r === null || s === null) return { status: 'invalid_response', error: 'invalid_response', ...base };
  const usd = (credits: number) => round(credits, 4);
  return { status: 'ok', error: null, ...base, unit: 'usd', assignedUsd: usd(a), reservedUsd: usd(r), settledUsd: usd(s), availableUsd: usd(a - r - s) };
}

async function observe(env: ComputerEnv, ownerTag: string | null, d: CostsDeps): Promise<Omit<CostsView, 'cacheAgeMs' | 'cached'>> {
  const [accounts, n] = await Promise.all([Promise.all(computerAccounts(env).map((a) => account(d.fetch, a, ownerTag))), nosana(d.fetch, env.CLOUDBITE_COMPUTER_NOSANA_API_KEY)]);
  const all = accounts.flatMap((a) => a.sandboxes);
  const p = COMPUTER_PRICING;
  return {
    ok: true, observedAt: new Date(d.now()).toISOString(),
    partial: accounts.some((a) => a.status !== 'ok' || a.usage.status === 'unavailable') || n.status === 'unavailable' || n.status === 'invalid_response',
    pricing: {
      daytona: { asOf: p.asOf, url: p.url, estimated: true, cpuPerHour: p.cpuPerHour, memoryGiBPerHour: p.memoryGiBPerHour, diskGiBPerHour: p.diskGiBPerHour, freeDiskGiB: p.freeDiskGiB, billingUrl: LINKS.daytonaBilling },
      nosana: { url: LINKS.nosanaCredits },
    },
    daytona: { accounts, totals: totals(all) },
    nosana: n,
    excluded: ['snapshots', 'volumes', 'network', 'gpu_sandboxes'],
  };
}

type Entry = { at: number; view: Omit<CostsView, 'cacheAgeMs' | 'cached'> | null; pending: Promise<Omit<CostsView, 'cacheAgeMs' | 'cached'>> | null };
const cache = new Map<string, Entry>();
/** Tests only. */
export const computerCostsCacheClear = () => cache.clear();

/** The cache key is a digest of the configuration, so different keys, accounts or owners never share an answer. */
async function cacheKey(env: ComputerEnv, ownerTag: string | null) {
  const raw = JSON.stringify([computerAccounts(env).map((a) => [a.id, a.api, a.key]), env.CLOUDBITE_COMPUTER_NOSANA_API_KEY ?? null, ownerTag]);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
  return [...d].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export async function computerCosts(env: ComputerEnv, opts: CostsOptions = {}): Promise<{ status: 200; body: CostsView }> {
  const d: CostsDeps = { fetch: opts.deps?.fetch ?? ((i, o) => fetch(i, o)), now: opts.deps?.now ?? (() => Date.now()) };
  const ownerTag = typeof opts.ownerTag === 'string' && opts.ownerTag ? opts.ownerTag : null;
  const key = await cacheKey(env, ownerTag);
  const now = d.now();
  let e = cache.get(key);
  const age = e?.view ? now - e.at : Infinity;
  const fresh = age < (opts.refresh ? COSTS_MIN_REFRESH_MS : COSTS_CACHE_MS);
  if (!(e?.view && fresh)) {
    if (!e?.pending) {
      const entry: Entry = e ?? { at: 0, view: null, pending: null };
      entry.pending = observe(env, ownerTag, d).then((v) => { entry.view = v; entry.at = d.now(); return v; }).finally(() => { entry.pending = null; });
      cache.delete(key); cache.set(key, entry);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      e = entry;
    }
    const view = await e!.pending!;
    return { status: 200, body: { ...view, cacheAgeMs: Math.max(0, d.now() - e!.at), cached: false } };
  }
  return { status: 200, body: { ...e.view!, cacheAgeMs: Math.max(0, Math.round(age)), cached: true } };
}
