// Read-only Nosana GPU candidate discovery for the Cloudbite computer ("원격 GPU 작업": a bounded remote job, never a
// local PCIe GPU). Public, unauthenticated host-manager reservation endpoints only, at fixed URLs (no caller-supplied
// URL, no key, no paid call). Schema source: @nosana/api 2.20.0 host-manager schema and
// https://learn.nosana.com/api/reservations.html, cross-checked against live prd responses on 2026-10-19:
//   GET  /reservations/gpus                                   -> { gpus: [{ name, vramGb, nodes, available, working, markets, price }] }
//   POST /reservations/requirements { metrics:['country'], requirements:{ name } } -> { metrics: [{ key:'country', values:[{ value, nodes }] }] }
//   POST /reservations/available    { requirements:{ name, country } }             -> { total, price, nodes:[{ nodeAddress, market }] }
// Country options count hosts that report the country (queued or working), not free hosts, so every candidate's
// `available` comes from its own /reservations/available call. Distances are approximate great-circle distances between
// a fixed region reference point and a country centroid: an estimate of geography, never a measured round trip.
// Node addresses are never returned; upstream text is validated against fixed shapes and anything else is dropped.

export const CBG_API = 'https://api.nosana.com';
export const CBG_TIMEOUT = 8_000;
export const CBG_DEADLINE = 20_000;        // whole discovery
export const CBG_BODY_MAX = 256 * 1024;
export const CBG_MAX_GPUS = 40;
export const CBG_MAX_COUNTRIES = 30;       // per GPU
export const CBG_MAX_AVAILABLE_CALLS = 48; // per discovery, nearest countries first
export const CBG_CONCURRENCY = 4;
export const CBG_CACHE_TTL = 60_000;
export const CBG_CACHE_MAX = 16;
export const CBG_MAX_VRAM = 1024;
export const CBG_LOCATION_BASIS = 'region-country-estimate';

const GPU_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+\/-]{0,79}$/;
const COUNTRY = /^[A-Z]{2}$/;
const MARKET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID = /^gpu_[A-Za-z0-9_-]{4,160}$/;

export type CbGpuRegion = 'us' | 'eu' | 'asia';
export interface CbGpuCandidate {
  id: string; gpu: string; vramGb: number; available: number; country: string | null; market: string | null;
  usdPerHourMin: number | null; usdPerHourMax: number | null; distanceKm: number | null; selectable: boolean;
}
export interface CbGpuCandidates { observedAt: string; locationBasis: typeof CBG_LOCATION_BASIS; candidates: CbGpuCandidate[]; note: string }
export interface CbGpuAvailability { available: number; markets: string[]; usdPerHourMin: number | null; usdPerHourMax: number | null }
export interface CbGpuSelection { selection: { candidateId: string; gpu: string; country: string; market: string | null }; commandExample: string }

/** Fixed error codes; never upstream text. */
export class CbGpuError extends Error {
  constructor(public code: 'bad_request' | 'upstream_unavailable' | 'upstream_invalid' | 'not_available') { super(code); }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface CbGpuDeps { fetch: Fetcher; now(): number }
const defaults = (): CbGpuDeps => ({ fetch: (i, o) => fetch(i, o), now: () => Date.now() });

// Region reference points (estimates): contiguous-US centroid, central Europe, and Singapore for Asia.
const REGION: Record<CbGpuRegion, [number, number]> = { us: [39.8, -98.6], eu: [50.1, 8.7], asia: [1.35, 103.8] };
// Approximate country centroids (lat, lon), rounded to 0.1°.
const CENTROID: Record<string, [number, number]> = {
  AE: [23.4, 53.8], AR: [-38.4, -63.6], AT: [47.5, 14.6], AU: [-25.3, 133.8], BE: [50.5, 4.5], BG: [42.7, 25.5],
  BR: [-14.2, -51.9], BY: [53.7, 28.0], CA: [56.1, -106.3], CH: [46.8, 8.2], CL: [-35.7, -71.5], CN: [35.9, 104.2],
  CO: [4.6, -74.3], CY: [35.1, 33.4], CZ: [49.8, 15.5], DE: [51.2, 10.5], DK: [56.3, 9.5], EE: [58.6, 25.0],
  EG: [26.8, 30.8], ES: [40.5, -3.7], FI: [61.9, 25.7], FR: [46.2, 2.2], GB: [55.4, -3.4], GE: [42.3, 43.4],
  GR: [39.1, 21.8], HK: [22.4, 114.1], HR: [45.1, 15.2], HU: [47.2, 19.5], ID: [-0.8, 113.9], IE: [53.4, -8.2],
  IL: [31.0, 34.9], IN: [20.6, 79.0], IS: [64.9, -19.0], IT: [41.9, 12.6], JP: [36.2, 138.3], KE: [-0.0, 37.9],
  KR: [35.9, 127.8], KZ: [48.0, 66.9], LT: [55.2, 23.9], LU: [49.8, 6.1], LV: [56.9, 24.6], MA: [31.8, -7.1],
  MD: [47.4, 28.4], MX: [23.6, -102.6], MY: [4.2, 102.0], NG: [9.1, 8.7], NL: [52.1, 5.3], NO: [60.5, 8.5],
  NZ: [-40.9, 174.9], PE: [-9.2, -75.0], PH: [12.9, 121.8], PK: [30.4, 69.3], PL: [51.9, 19.1], PT: [39.4, -8.2],
  RO: [45.9, 25.0], RS: [44.0, 21.0], RU: [61.5, 105.3], SA: [23.9, 45.1], SE: [60.1, 18.6], SG: [1.35, 103.8],
  SI: [46.2, 15.0], SK: [48.7, 19.7], TH: [15.9, 101.0], TR: [39.0, 35.2], TW: [23.7, 121.0], UA: [48.4, 31.2],
  US: [37.1, -95.7], UY: [-32.5, -55.8], VE: [6.4, -66.6], VN: [14.1, 108.3], ZA: [-30.6, 22.9],
};

export function cbGpuRegion(region: unknown): CbGpuRegion | null {
  const r = typeof region === 'string' ? region.trim().toLowerCase() : '';
  return r === 'us' || r === 'eu' || r === 'asia' ? r : null;
}

/** Great-circle km between the region reference point and the country centroid, or null when either is unknown. */
export function cbGpuDistanceKm(region: CbGpuRegion | null, country: string | null): number | null {
  const a = region ? REGION[region] : undefined, b = country ? CENTROID[country] : undefined;
  if (!a || !b) return null;
  const rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) / 10) * 10;
}

const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Stable candidate id: GPU model + country, plain and bounded. Carries no availability; rediscovery validates it. */
export function cbGpuCandidateId(gpu: string, country: string | null): string { return 'gpu_' + b64u(`${gpu}|${country ?? ''}`); }
export function cbGpuParseCandidateId(id: unknown): { gpu: string; country: string } | null {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  let text: string;
  try {
    const s = id.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(s + '='.repeat(-s.length & 3)), (c) => c.charCodeAt(0)));
  } catch { return null; }
  const m = /^([^|]+)\|([A-Z]{2})$/.exec(text);
  return m && GPU_NAME.test(m[1]) && cbGpuCandidateId(m[1], m[2]) === id ? { gpu: m[1], country: m[2] } : null;
}

/** Plain GPU model and ISO country as the nested run accepts them; null when either is not plain. */
export function cbGpuValidSelection(gpu: unknown, country: unknown): { gpu: string; country: string } | null {
  return typeof gpu === 'string' && GPU_NAME.test(gpu) && typeof country === 'string' && COUNTRY.test(country) ? { gpu, country } : null;
}

const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const count = (v: unknown) => { const n = num(v, 1e6); return n !== null && Number.isInteger(n) ? n : null; };
function price(p: unknown): { min: number | null; max: number | null } {
  if (!p || typeof p !== 'object') return { min: null, max: null };
  const o = p as Record<string, unknown>;
  const min = num(o.minUsdPerHour, 1000), max = num(o.maxUsdPerHour, 1000);
  return min !== null && max !== null && min <= max ? { min, max } : { min: null, max: null };
}

/** One bounded call to a fixed reservation path. Never follows redirects; the body is size-capped and JSON-parsed. */
async function call(d: CbGpuDeps, path: '/reservations/gpus' | '/reservations/requirements' | '/reservations/available', body?: unknown, deadline?: number): Promise<unknown> {
  const left = deadline === undefined ? CBG_TIMEOUT : Math.min(CBG_TIMEOUT, deadline - d.now());
  if (left <= 0) throw new CbGpuError('upstream_unavailable');
  let r: Response;
  try {
    r = await d.fetch(CBG_API + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { accept: 'application/json', 'user-agent': 'CloudBiteCompute/1.0', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(left),
    });
  } catch { throw new CbGpuError('upstream_unavailable'); }
  const drop = async (code: 'upstream_unavailable' | 'upstream_invalid') => { try { await r.body?.cancel(); } catch { /* closed */ } throw new CbGpuError(code); };
  if (r.status !== 200) return drop(r.status >= 300 && r.status < 400 ? 'upstream_invalid' : 'upstream_unavailable');
  if (Number(r.headers.get('content-length')) > CBG_BODY_MAX) return drop('upstream_invalid');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (r.body) {
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        size += value.byteLength;
        if (size > CBG_BODY_MAX) { await rd.cancel().catch(() => {}); throw new CbGpuError('upstream_invalid'); }
        chunks.push(value);
      }
    }
  } catch (e) { throw e instanceof CbGpuError ? e : new CbGpuError('upstream_unavailable'); }
  const buf = new Uint8Array(size); let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)); } catch { throw new CbGpuError('upstream_invalid'); }
}

interface Gpu { name: string; vramGb: number; available: number; markets: string[] }
function parseGpus(j: unknown): Gpu[] {
  const list = (j as { gpus?: unknown } | null)?.gpus;
  if (!Array.isArray(list)) throw new CbGpuError('upstream_invalid');
  const out: Gpu[] = [], seen = new Set<string>();
  for (const g of list.slice(0, 200)) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const vramGb = num(o.vramGb, CBG_MAX_VRAM), available = count(o.available);
    if (typeof o.name !== 'string' || !GPU_NAME.test(o.name) || seen.has(o.name) || vramGb === null || available === null) continue;
    seen.add(o.name);
    const markets = Array.isArray(o.markets) ? o.markets.filter((m): m is string => typeof m === 'string' && MARKET.test(m)).slice(0, 8) : [];
    out.push({ name: o.name, vramGb, available, markets });
  }
  return out;
}

function parseCountries(j: unknown): string[] {
  const metrics = (j as { metrics?: unknown } | null)?.metrics;
  if (!Array.isArray(metrics)) throw new CbGpuError('upstream_invalid');
  const m = metrics.find((x) => x && (x as { key?: unknown }).key === 'country') as { values?: unknown } | undefined;
  if (!m || !Array.isArray(m.values)) return [];
  const out = new Set<string>();
  for (const v of m.values.slice(0, 300)) {
    const o = v as { value?: unknown; nodes?: unknown } | null;
    // 'missing' (and anything not ISO alpha-2) cannot be required by country, so it is not a candidate.
    if (o && typeof o.value === 'string' && COUNTRY.test(o.value) && (count(o.nodes) ?? 0) > 0) out.add(o.value);
  }
  return [...out];
}

function parseAvailable(j: unknown): CbGpuAvailability {
  if (!j || typeof j !== 'object') throw new CbGpuError('upstream_invalid');
  const o = j as Record<string, unknown>;
  const total = count(o.total);
  if (total === null) throw new CbGpuError('upstream_invalid');
  const markets = new Set<string>();
  if (Array.isArray(o.nodes)) for (const n of o.nodes.slice(0, 1000)) { const m = (n as { market?: unknown } | null)?.market; if (typeof m === 'string' && MARKET.test(m)) markets.add(m); }
  const p = price(o.price);
  return { available: total, markets: [...markets].sort(), usdPerHourMin: p.min, usdPerHourMax: p.max };
}

/** Free hosts right now for exactly this GPU model in exactly this country (one public read). */
export async function cbGpuAvailability(gpu: string, country: string, deps: CbGpuDeps = defaults()): Promise<CbGpuAvailability> {
  const sel = cbGpuValidSelection(gpu, country);
  if (!sel) throw new CbGpuError('bad_request');
  return parseAvailable(await call(deps, '/reservations/available', { requirements: { name: sel.gpu, country: sel.country } }));
}

async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await items[k](); } }));
  return out;
}

const cache = new Map<string, { at: number; value: Promise<CbGpuCandidates> }>();
/** Test hook: forget cached discoveries. */
export function cbGpuClearCache() { cache.clear(); }

/** Ranked GPU candidates near a Daytona region. Read-only; cached briefly; throws CbGpuError only when nothing is known. */
export function gpuCandidates(region: string, minVramGb?: number, deps: CbGpuDeps = defaults()): Promise<CbGpuCandidates> {
  if (minVramGb !== undefined && num(minVramGb, CBG_MAX_VRAM) === null) return Promise.reject(new CbGpuError('bad_request'));
  const r = cbGpuRegion(region), min = minVramGb ?? 0, key = `${r ?? '-'}|${min}`, now = deps.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CBG_CACHE_TTL) return hit.value;
  const value = discover(r, min, deps);
  cache.delete(key); cache.set(key, { at: now, value });
  while (cache.size > CBG_CACHE_MAX) cache.delete(cache.keys().next().value!);
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); }); // never cache a failure
  return value;
}

async function discover(region: CbGpuRegion | null, minVramGb: number, d: CbGpuDeps): Promise<CbGpuCandidates> {
  const deadline = d.now() + CBG_DEADLINE;
  const gpus = parseGpus(await call(d, '/reservations/gpus', undefined, deadline)).filter((g) => g.vramGb >= minVramGb).slice(0, CBG_MAX_GPUS);
  let partial = false;
  const candidates: CbGpuCandidate[] = [];
  const free = gpus.filter((g) => g.available > 0);
  const countries = await pool(free.map((g) => async () => {
    try { return parseCountries(await call(d, '/reservations/requirements', { metrics: ['country'], requirements: { name: g.name } }, deadline)).slice(0, CBG_MAX_COUNTRIES); }
    catch { partial = true; return []; }
  }), CBG_CONCURRENCY);
  // Spend the bounded per-country budget on the nearest pairs first (unknown distance last).
  const pairs = free.flatMap((g, i) => countries[i].map((c) => ({ g, c, km: cbGpuDistanceKm(region, c) })))
    .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || b.g.available - a.g.available);
  if (pairs.length > CBG_MAX_AVAILABLE_CALLS) partial = true;
  const avail = await pool(pairs.slice(0, CBG_MAX_AVAILABLE_CALLS).map((p) => async () => {
    try { return parseAvailable(await call(d, '/reservations/available', { requirements: { name: p.g.name, country: p.c } }, deadline)); }
    catch { partial = true; return null; }
  }), CBG_CONCURRENCY);
  pairs.slice(0, CBG_MAX_AVAILABLE_CALLS).forEach((p, i) => {
    const a = avail[i];
    if (!a || a.available < 1) return;
    candidates.push({
      id: cbGpuCandidateId(p.g.name, p.c), gpu: p.g.name, vramGb: p.g.vramGb, available: a.available, country: p.c,
      market: a.markets.length === 1 ? a.markets[0] : null, usdPerHourMin: a.usdPerHourMin, usdPerHourMax: a.usdPerHourMax,
      distanceKm: p.km, selectable: true,
    });
  });
  // GPU models with no free host anywhere stay visible, unselectable, with no location.
  for (const g of gpus) if (g.available === 0) candidates.push({
    id: cbGpuCandidateId(g.name, null), gpu: g.name, vramGb: g.vramGb, available: 0, country: null,
    market: g.markets.length === 1 ? g.markets[0] : null, usdPerHourMin: null, usdPerHourMax: null, distanceKm: null, selectable: false,
  });
  candidates.sort((a, b) => Number(b.selectable) - Number(a.selectable) || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)
    || b.available - a.available || (a.usdPerHourMin ?? Infinity) - (b.usdPerHourMin ?? Infinity) || a.id.localeCompare(b.id));
  const parts = [
    region ? `Distances are approximate: ${region} region reference point to country centroid, not measured latency.` : 'Sandbox region unknown: no distance estimate.',
    'Free hosts are a point-in-time count; selecting does not reserve or bill anything.',
    'Hourly prices are the Nosana host base price; network fees are separate.',
  ];
  if (partial) parts.push('Partial: some Nosana availability reads failed or were skipped; missing GPU/country pairs are not listed.');
  return { observedAt: new Date(d.now()).toISOString(), locationBasis: CBG_LOCATION_BASIS, candidates, note: parts.join(' ') };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** CLI example for a selection (no secrets: a Nosana job definition is public). */
export function cbGpuCommandExample(gpu: string, country: string): string {
  return `cloudbite-compute run --provider nosana --gpu ${shq(gpu)} --country ${country} --timeout 300 -- nvidia-smi`;
}

/** Validate a candidate id against current availability. No persistence, reservation or billing. */
export async function cbGpuSelect(candidateId: unknown, deps: CbGpuDeps = defaults()): Promise<CbGpuSelection> {
  const sel = cbGpuParseCandidateId(candidateId);
  if (!sel) throw new CbGpuError('bad_request');
  const a = await cbGpuAvailability(sel.gpu, sel.country, deps);
  if (a.available < 1) throw new CbGpuError('not_available');
  return {
    selection: { candidateId: candidateId as string, gpu: sel.gpu, country: sel.country, market: a.markets.length === 1 ? a.markets[0] : null },
    commandExample: cbGpuCommandExample(sel.gpu, sel.country),
  };
}
