// Licensed-corpus hybrid search (docs/cloudbite/corpus-search.md). The index is public, licensed reference text only
// and is supplied by the caller; it is validated (identity, limits, hashes, vectors) before any search. The only
// network call is one OpenAI embedding of the bounded search query; the key never appears in a result or an error,
// upstream bodies are never reflected, and a missing key or any upstream failure degrades honestly to the lexical
// ranker. Semantic similarity is a ranking signal only: it is never claim support or confidence.
import { CORPUS_DIMENSIONS, CORPUS_MODEL, CORPUS_SCHEMA, type CorpusHit, type CorpusIndex, type CorpusSearchResult, type CorpusSource } from './cloudbite-corpus-contract';
import { boundedText } from './cloudbite-bounded-text';
import { sha256Hex } from './cloudbite-knowledge';
import { rankCards, retrievalTokens, type RankableCard } from './cloudbite-retrieval';

export const CORPUS_SEARCH_SCHEMA = 'cloudbite.corpus-search/v1' as const;
export const HYBRID_STRATEGY = 'hybrid-rrf/v1' as const;
export const CORPUS_LEXICAL_STRATEGY = 'corpus-lexical/v1' as const;
export const CORPUS_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
/** similarityFloor: a chunk enters the semantic list only at cosine >= 0.40 (see the doc for why this is conservative). */
export const CORPUS_SEARCH_PARAMS = Object.freeze({ rrfK: 60, maxHits: 3, perSource: 2, similarityFloor: 0.4, maxQueryChars: 1000, timeoutMs: 8000, responseBytes: 64 * 1024 });
export const CORPUS_LIMITS = Object.freeze({
  sources: 256, roles: 64, sourceBytes: 1024 * 1024, totalSourceBytes: 8 * 1024 * 1024,
  chunks: 4096, chunkBytes: 4096, headingDepth: 8, headingChars: 200, metaChars: 500, urlChars: 2048,
});
/** Why semantic ranking did not run (or the reason nothing was searched). Categories only; never an upstream body. */
export type CorpusDegraded = 'no-eligible-sources' | 'no-query-terms' | 'missing-key' | 'invalid-key' | 'upstream-unavailable' | 'upstream-rejected' | 'upstream-invalid';

export class CorpusIndexError extends Error { constructor(where: string) { super(`invalid corpus index: ${where}`); this.name = 'CorpusIndexError'; } }

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const SOURCE_KEYS = ['attribution', 'id', 'license', 'licenseUrl', 'retrievedAt', 'roles', 'sha256', 'text', 'title', 'url', 'version'];
const CHUNK_KEYS = ['headingPath', 'id', 'parentId', 'sha256', 'sourceId', 'text', 'vector'];
const INDEX_KEYS = ['chunks', 'dimensions', 'model', 'schema', 'sha256', 'sources'];
const utf8 = (s: string) => new TextEncoder().encode(s).length;

type SourceMeta = Omit<CorpusSource, 'text' | 'roles'>;
interface Snapshot {
  sha256: string;
  sources: Array<{ meta: SourceMeta; roles: ReadonlySet<string>; text: string }>;
  chunks: Array<{ id: string; sourceId: string; parentId: string; headingPath: string[]; text: string; sha256: string; vector: Float64Array; norm: number }>;
}
/** Only deeply frozen indexes are cached: their data cannot change after validation. A mutable index is re-validated on every call. */
const VALIDATED = new WeakMap<object, Snapshot>();

function plain(v: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) throw new CorpusIndexError(`${where} must be a plain object`);
  const own = Object.keys(v).sort();
  if (own.length !== keys.length || own.some((k, i) => k !== keys[i])) throw new CorpusIndexError(`${where} must have exactly ${keys.join(', ')}`);
  return v as Record<string, unknown>;
}
function list(v: unknown, max: number, where: string, min = 0): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) throw new CorpusIndexError(`${where} must be an array`);
  if (v.length < min || v.length > max) throw new CorpusIndexError(`${where} must have ${min}-${max} items`);
  return v;
}
function str(v: unknown, max: number, where: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CorpusIndexError(`${where} must be a 1-${max} character string`);
  return v;
}
function httpsUrl(v: unknown, where: string): string {
  const s = str(v, CORPUS_LIMITS.urlChars, where);
  let u: URL;
  try { u = new URL(s); } catch { throw new CorpusIndexError(`${where} must be an https URL`); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new CorpusIndexError(`${where} must be an https URL`);
  return s;
}
const safeId = (v: unknown, where: string) => { if (typeof v !== 'string' || !SAFE_ID.test(v)) throw new CorpusIndexError(`${where} must be a safe id`); return v; };

/** Canonical JSON: object keys sorted at every level, JavaScript number serialization. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, x => x.toString(16).padStart(2, '0')).join('');
}

/** Reads every field exactly once into a private snapshot, checking it on the way; also reports whether the whole graph is frozen. */
async function snapshot(index: unknown, checkHash: boolean): Promise<{ snap: Snapshot; frozen: boolean }> {
  const ix = plain(index, INDEX_KEYS, 'index');
  let frozen = Object.isFrozen(ix);
  if (ix.schema !== CORPUS_SCHEMA) throw new CorpusIndexError(`schema must be ${CORPUS_SCHEMA}`);
  if (ix.model !== CORPUS_MODEL) throw new CorpusIndexError(`model must be ${CORPUS_MODEL}`);
  if (ix.dimensions !== CORPUS_DIMENSIONS) throw new CorpusIndexError(`dimensions must be ${CORPUS_DIMENSIONS}`);
  const indexSha = ix.sha256;
  if (checkHash && (typeof indexSha !== 'string' || !SHA256.test(indexSha))) throw new CorpusIndexError('sha256 must be 64 lowercase hex characters');
  const rawSources = list(ix.sources, CORPUS_LIMITS.sources, 'sources', 1), rawChunks = list(ix.chunks, CORPUS_LIMITS.chunks, 'chunks', 1);
  frozen &&= Object.isFrozen(rawSources) && Object.isFrozen(rawChunks);

  const canonicalSources: Record<string, unknown>[] = [], canonicalChunks: Record<string, unknown>[] = [];
  const sources: Snapshot['sources'] = [], byId = new Map<string, string>();
  let totalBytes = 0;
  for (const [i, raw] of rawSources.entries()) {
    const w = `sources[${i}]`, s = plain(raw, SOURCE_KEYS, w);
    const id = safeId(s.id, `${w}.id`);
    if (byId.has(id)) throw new CorpusIndexError(`${w}.id is not unique`);
    const rawRoles = list(s.roles, CORPUS_LIMITS.roles, `${w}.roles`, 1);
    frozen &&= Object.isFrozen(s) && Object.isFrozen(rawRoles);
    const roles = rawRoles.map((r, j) => safeId(r, `${w}.roles[${j}]`));
    if (new Set(roles).size !== roles.length) throw new CorpusIndexError(`${w}.roles must be unique`);
    const text = s.text;
    if (typeof text !== 'string' || !text.trim()) throw new CorpusIndexError(`${w}.text must be non-empty text`);
    const bytes = utf8(text);
    totalBytes += bytes;
    if (bytes > CORPUS_LIMITS.sourceBytes || totalBytes > CORPUS_LIMITS.totalSourceBytes) throw new CorpusIndexError(`${w}.text exceeds the source byte limits`);
    const hash = s.sha256;
    if (typeof hash !== 'string' || hash !== await sha256(text)) throw new CorpusIndexError(`${w}.sha256 does not match its text`);
    const retrievedAt = str(s.retrievedAt, 40, `${w}.retrievedAt`);
    if (!DATE.test(retrievedAt)) throw new CorpusIndexError(`${w}.retrievedAt must be an ISO date`);
    const meta: SourceMeta = {
      id, title: str(s.title, CORPUS_LIMITS.metaChars, `${w}.title`), url: httpsUrl(s.url, `${w}.url`),
      license: str(s.license, 80, `${w}.license`), licenseUrl: httpsUrl(s.licenseUrl, `${w}.licenseUrl`),
      attribution: str(s.attribution, CORPUS_LIMITS.metaChars, `${w}.attribution`), version: str(s.version, 80, `${w}.version`), retrievedAt, sha256: hash,
    };
    byId.set(id, text);
    sources.push({ meta: Object.freeze(meta), roles: new Set(roles), text });
    canonicalSources.push({ ...meta, roles, text });
  }

  const chunks: Snapshot['chunks'] = [], chunkIds = new Set<string>();
  rawChunks.forEach((raw, i) => {
    const w = `chunks[${i}]`, c = plain(raw, CHUNK_KEYS, w);
    const id = safeId(c.id, `${w}.id`);
    if (chunkIds.has(id)) throw new CorpusIndexError(`${w}.id is not unique`);
    chunkIds.add(id);
    const sourceId = safeId(c.sourceId, `${w}.sourceId`), parentId = safeId(c.parentId, `${w}.parentId`);
    const sourceText = byId.get(sourceId);
    if (sourceText === undefined) throw new CorpusIndexError(`${w}.sourceId names no source`);
    const rawHeading = list(c.headingPath, CORPUS_LIMITS.headingDepth, `${w}.headingPath`), rawVector = list(c.vector, CORPUS_DIMENSIONS, `${w}.vector`, CORPUS_DIMENSIONS);
    frozen &&= Object.isFrozen(c) && Object.isFrozen(rawHeading) && Object.isFrozen(rawVector);
    const headingPath = rawHeading.map((h, j) => str(h, CORPUS_LIMITS.headingChars, `${w}.headingPath[${j}]`));
    const text = c.text;
    if (typeof text !== 'string' || !text.trim() || utf8(text) > CORPUS_LIMITS.chunkBytes) throw new CorpusIndexError(`${w}.text must be 1-${CORPUS_LIMITS.chunkBytes} bytes of text`);
    // a chunk is an exact excerpt of its own licensed source, never authored or user text
    if (!sourceText.includes(text)) throw new CorpusIndexError(`${w}.text is not an excerpt of its source`);
    const hash = c.sha256;
    if (typeof hash !== 'string' || hash !== sha256Hex(text)) throw new CorpusIndexError(`${w}.sha256 does not match its text`);
    const vector = new Float64Array(CORPUS_DIMENSIONS);
    let sq = 0;
    for (let j = 0; j < CORPUS_DIMENSIONS; j++) {
      const x = rawVector[j];
      if (typeof x !== 'number' || !Number.isFinite(x)) throw new CorpusIndexError(`${w}.vector must hold finite numbers`);
      vector[j] = x; sq += x * x;
    }
    const norm = Math.sqrt(sq);
    if (!(norm > 0) || !Number.isFinite(norm)) throw new CorpusIndexError(`${w}.vector must be a finite non-zero vector`);
    chunks.push({ id, sourceId, parentId, headingPath, text, sha256: hash, vector, norm });
    canonicalChunks.push({ headingPath, id, parentId, sha256: hash, sourceId, text, vector: Array.from(vector) });
  });

  const digest = await sha256(canonical({ chunks: canonicalChunks, dimensions: CORPUS_DIMENSIONS, model: CORPUS_MODEL, schema: CORPUS_SCHEMA, sources: canonicalSources }));
  if (checkHash && digest !== indexSha) throw new CorpusIndexError('sha256 does not match the canonical index');
  return { snap: { sha256: digest, sources, chunks }, frozen };
}

async function trusted(index: CorpusIndex): Promise<{ snap: Snapshot; cached: boolean }> {
  const hit = typeof index === 'object' && index !== null ? VALIDATED.get(index) : undefined;
  if (hit) return { snap: hit, cached: true };
  const { snap, frozen } = await snapshot(index, true);
  if (frozen) VALIDATED.set(index, snap);
  return { snap, cached: false };
}

/** Throws CorpusIndexError (field path and rule only, never content) unless the index is fully valid. A deeply frozen
 *  index is remembered by identity afterwards; anything else is re-validated by every search. */
export async function validateCorpusIndex(index: CorpusIndex): Promise<{ sha256: string; sources: number; chunks: number; cached: boolean }> {
  const { snap, cached } = await trusted(index);
  return { sha256: snap.sha256, sources: snap.sources.length, chunks: snap.chunks.length, cached };
}

/** The canonical index hash for builders: every field checked except `sha256`, which is excluded from the hash. */
export async function corpusIndexSha256(index: Omit<CorpusIndex, 'sha256'> & { sha256?: string }): Promise<string> {
  return (await snapshot({ ...index, sha256: '' }, false)).snap.sha256;
}

/** Deep-freezes an index in place so validation can be cached; returns the same object. */
export function freezeCorpusIndex<T extends CorpusIndex>(index: T): T {
  for (const s of index.sources) { Object.freeze(s.roles); Object.freeze(s); }
  for (const c of index.chunks) { Object.freeze(c.headingPath); Object.freeze(c.vector); Object.freeze(c); }
  Object.freeze(index.sources); Object.freeze(index.chunks);
  return Object.freeze(index);
}

type Embedding = { vector: Float64Array; norm: number } | { degraded: CorpusDegraded };

/** One embedding of the bounded query; no retry. Any failure is a category, and the upstream body is never read back. */
async function embedQuery(query: string, key: string, fetcher: typeof fetch): Promise<Embedding> {
  let r: Response;
  try {
    r = await fetcher(CORPUS_EMBEDDINGS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: CORPUS_MODEL, input: query, dimensions: CORPUS_DIMENSIONS, encoding_format: 'float' }),
      signal: AbortSignal.timeout(CORPUS_SEARCH_PARAMS.timeoutMs),
    });
  } catch { return { degraded: 'upstream-unavailable' }; }
  if (!(r instanceof Response)) return { degraded: 'upstream-invalid' };
  if (!r.ok) { try { await r.body?.cancel(); } catch { /* already closed */ } return { degraded: 'upstream-rejected' }; }
  let j: unknown;
  try { j = JSON.parse(await boundedText(r, CORPUS_SEARCH_PARAMS.responseBytes)); }
  catch (e) { return { degraded: e instanceof SyntaxError || e instanceof RangeError ? 'upstream-invalid' : 'upstream-unavailable' }; }
  const body = j as { object?: unknown; model?: unknown; data?: unknown } | null;
  if (typeof body !== 'object' || body === null || body.object !== 'list' || body.model !== CORPUS_MODEL || !Array.isArray(body.data) || body.data.length !== 1) return { degraded: 'upstream-invalid' };
  const d = body.data[0] as { object?: unknown; index?: unknown; embedding?: unknown } | null;
  if (typeof d !== 'object' || d === null || d.object !== 'embedding' || d.index !== 0 || !Array.isArray(d.embedding) || d.embedding.length !== CORPUS_DIMENSIONS) return { degraded: 'upstream-invalid' };
  const vector = new Float64Array(CORPUS_DIMENSIONS);
  let sq = 0;
  for (let i = 0; i < CORPUS_DIMENSIONS; i++) {
    const x = d.embedding[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return { degraded: 'upstream-invalid' };
    vector[i] = x; sq += x * x;
  }
  const norm = Math.sqrt(sq);
  return norm > 0 && Number.isFinite(norm) ? { vector, norm } : { degraded: 'upstream-invalid' };
}

/**
 * Search the expert's licensed sources. Only sources whose roles include expertId are eligible, before any ranking and
 * with no fallback to other roles. Lexical BM25 (the shared ranker) and, when an embedding is available, cosine over
 * every eligible chunk are fused by reciprocal rank (k=60); at most 3 hits, at most 2 per source. Throws RangeError for
 * a query outside 1-1000 characters and CorpusIndexError for an invalid index; never throws for upstream trouble.
 */
export async function searchCorpus(index: CorpusIndex, expertId: string, query: string, key: string | undefined, fetcher: typeof fetch = fetch): Promise<CorpusSearchResult> {
  const P = CORPUS_SEARCH_PARAMS;
  if (typeof query !== 'string' || !query.trim() || query.length > P.maxQueryChars) throw new RangeError(`corpus search query must be 1-${P.maxQueryChars} characters`);
  const { snap } = await trusted(index);
  const empty = (degraded: CorpusDegraded): CorpusSearchResult => ({ schema: CORPUS_SEARCH_SCHEMA, indexSha256: snap.sha256, strategy: CORPUS_LEXICAL_STRATEGY, model: null, matched: false, degraded, sources: [], hits: [] });

  const eligibleSources = new Set(typeof expertId === 'string' ? snap.sources.filter(s => s.roles.has(expertId)).map(s => s.meta.id) : []);
  const eligible = snap.chunks.filter(c => eligibleSources.has(c.sourceId));
  if (!eligible.length) return empty('no-eligible-sources');
  if (!retrievalTokens(query).length) return empty('no-query-terms');

  const cards: RankableCard[] = eligible.map(c => ({ id: c.id, term: c.headingPath.join(' / '), summary: c.text, match: [], source_ids: [c.sourceId] }));
  const lexical = rankCards(cards, query, P.maxQueryChars).map(r => r.index);

  let degraded: CorpusDegraded | null = null, semantic: number[] | null = null;
  if (typeof key !== 'string' || !key) degraded = 'missing-key';
  else if (!/^[\x21-\x7e]{1,512}$/.test(key)) degraded = 'invalid-key';
  else {
    const e = await embedQuery(query, key, fetcher);
    if ('degraded' in e) degraded = e.degraded;
    else {
      const sims = eligible.map((c, i) => {
        let dot = 0;
        for (let j = 0; j < CORPUS_DIMENSIONS; j++) dot += c.vector[j] * e.vector[j];
        return { i, cos: dot / (c.norm * e.norm) };
      });
      semantic = sims.filter(s => s.cos >= P.similarityFloor).sort((x, y) => y.cos - x.cos || x.i - y.i).map(s => s.i);
    }
  }

  const fused = new Map<number, number>();
  for (const ranks of semantic ? [lexical, semantic] : [lexical]) ranks.forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + 1 / (P.rrfK + r + 1)));
  const order = [...fused].sort((x, y) => y[1] - x[1] || x[0] - y[0]);

  const hits: CorpusHit[] = [], perSource = new Map<string, number>(), texts = new Set<string>();
  for (const [i, score] of order) {
    if (hits.length >= P.maxHits) break;
    const c = eligible[i], n = perSource.get(c.sourceId) ?? 0;
    if (n >= P.perSource || texts.has(c.sha256)) continue;
    perSource.set(c.sourceId, n + 1); texts.add(c.sha256);
    hits.push({ chunkId: c.id, sourceId: c.sourceId, parentId: c.parentId, headingPath: [...c.headingPath], text: c.text, sha256: c.sha256, score: Math.round(score * 1e6) / 1e6 });
  }
  const sources = snap.sources.filter(s => perSource.has(s.meta.id)).map(s => ({ ...s.meta }));
  return { schema: CORPUS_SEARCH_SCHEMA, indexSha256: snap.sha256, strategy: semantic ? HYBRID_STRATEGY : CORPUS_LEXICAL_STRATEGY, model: semantic ? CORPUS_MODEL : null, matched: hits.length > 0, degraded, sources, hits };
}
