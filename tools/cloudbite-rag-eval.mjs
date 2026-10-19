// Offline retrieval evaluation for the licensed reference corpus (src/cloudbite-corpus-contract.ts). It reads an
// authored query set (JSONL), a corpus index (local JSON, or the generated TS module bundled with esbuild in-process)
// and saved retrieval runs (CorpusSearchResult per query), re-derives every hash and reports recall@3, MRR, role
// leakage, invalid source/chunk citations, no-hit and degraded counts. Nothing is fetched and no model or embedding is
// called. Relevance labels are operator-authored annotations, not ground truth, and retrieval metrics say nothing about
// the quality of the advice built on them: that stays with human review (tools/cloudbite-quality-batch.mjs). Queries
// without an annotation give null metrics, never zero and never success. No winner is ever declared.
//
//   node tools/cloudbite-rag-eval.mjs validate [--queries Q.jsonl] [--index INDEX.json | --index-module src/X.ts]
//   node tools/cloudbite-rag-eval.mjs evaluate --run RUN.json (--index INDEX.json | --index-module src/X.ts)
//        [--baseline BASE.json] [--queries Q.jsonl] [--out DIR] [--force] [--allow-outside-repo]
//   node tools/cloudbite-rag-eval.mjs template [--queries Q.jsonl] [--out DIR] [--force] [--allow-outside-repo]
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORBIDDEN_ARG, PROVENANCES, ROOT, canonical, readBoundedFile, resolveOutput, scanSensitive, writeNew } from './evaluate-cloudbite-quality.mjs';
import { BATCH_VERSION } from './cloudbite-quality-batch.mjs';

export const RAG_EVAL_VERSION = 'cloudbite-rag-eval/v1';
export const RUN_VERSION = 'cloudbite-rag-run/v1';
export const DEFAULT_QUERIES = join(ROOT, 'test/fixtures/cloudbite-rag-queries.jsonl');
export const DEFAULT_RAG_OUT = join(ROOT, '.artifacts/rag-eval');
export const ADVICE_CASES = join(ROOT, 'test/fixtures/cloudbite-expert-workflow.jsonl');
/** Mirrors of src/cloudbite-corpus-contract.ts; the test checks drift. */
export const CORPUS = Object.freeze({ schema: 'cloudbite.corpus/v1', model: 'text-embedding-3-small', dimensions: 256, searchSchema: 'cloudbite.corpus-search/v1', strategies: ['hybrid-rrf/v1', 'corpus-lexical/v1'] });
export const RAG_LIMITS = Object.freeze({
  queriesBytes: 256 * 1024, queries: 200, query: 1000, relevant: 20, text: 500,
  indexBytes: 64 * 1024 * 1024, sources: 2000, chunks: 20000, runBytes: 4 * 1024 * 1024, hits: 10, resultSources: 20, config: 4096, degraded: 80,
});
export const K = 3;
export const NULL_METRIC = 'NO_RELEVANCE_ANNOTATION';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, HEX64 = /^[0-9a-f]{64}$/, SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const QUERY_KEYS = new Set(['caseId', 'suite', 'heldOut', 'provenance', 'purpose', 'authoring', 'expertId', 'query', 'relevantSourceIds', 'relevance']);
const RELEVANCE_KEYS = new Set(['status', 'annotatedBy', 'annotatedAt', 'basis', 'note']);
const RUN_KEYS = new Set(['version', 'runId', 'provenance', 'querySetSha256', 'retrievalConfig', 'identities', 'collection', 'results']);
const IDENTITY_KEYS = ['promptSetHash', 'instructionSetHash', 'knowledgeRevisionHash'];
const RESULT_KEYS = ['schema', 'indexSha256', 'strategy', 'model', 'matched', 'degraded', 'sources', 'hits'];
const HIT_KEYS = ['chunkId', 'sourceId', 'parentId', 'headingPath', 'text', 'sha256', 'score'];
const SOURCE_META = ['id', 'title', 'url', 'license', 'licenseUrl', 'attribution', 'version', 'retrievedAt', 'sha256'];

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const tally = (items, key) => items.reduce((o, x) => { const k = key(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});
const exactKeys = (v, keys) => isRecord(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const mean = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 1e6) / 1e6 : null;
const round = (x) => x === null ? null : Math.round(x * 1e6) / 1e6;

// ---------- query set ----------

/** Identity of what is asked: case, role and exact query text. Relevance annotations are not part of it. */
export const queryHash = (q) => sha256(canonical({ caseId: q.caseId, expertId: q.expertId, query: q.query }));
export const querySetHash = (queries) => sha256(canonical([...queries].map((q) => [q.caseId, q.expertId, queryHash(q)]).sort((a, b) => a[0] < b[0] ? -1 : 1)));
const annotationSetHash = (queries) => sha256(canonical([...queries].map((q) => [q.caseId, q.relevance.status, [...q.relevantSourceIds].sort()]).sort((a, b) => a[0] < b[0] ? -1 : 1)));

/** Strict JSONL parse of authored queries. An empty relevantSourceIds is legal only as explicitly pending relevance. */
export function parseQueries(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()), e = [], out = new Map();
  if (!lines.length || lines.length > RAG_LIMITS.queries) throw new Error(`queries must hold 1-${RAG_LIMITS.queries} lines`);
  lines.forEach((line, i) => {
    const at = `queries line ${i + 1}`;
    let q; try { q = JSON.parse(line); } catch { e.push(`${at}: not JSON`); return; }
    if (!isRecord(q)) { e.push(`${at}: not an object`); return; }
    for (const k of Object.keys(q)) if (!QUERY_KEYS.has(k)) e.push(`${at}: unknown key ${k}`);
    if (typeof q.caseId !== 'string' || !ID.test(q.caseId)) e.push(`${at}: caseId must be a safe id`);
    else if (out.has(q.caseId)) e.push(`${at}: duplicate caseId ${q.caseId}`);
    if (typeof q.expertId !== 'string' || !ID.test(q.expertId)) e.push(`${at}: expertId must be a safe id`);
    if (typeof q.query !== 'string' || !q.query.trim() || q.query.length > RAG_LIMITS.query) e.push(`${at}: query must be 1-${RAG_LIMITS.query} characters`);
    for (const k of ['suite', 'purpose', 'provenance']) if (q[k] !== undefined && (typeof q[k] !== 'string' || q[k].length > RAG_LIMITS.text)) e.push(`${at}: ${k} must be a short string`);
    if (q.heldOut !== undefined && typeof q.heldOut !== 'boolean') e.push(`${at}: heldOut must be boolean`);
    if (q.authoring !== undefined && (!isRecord(q.authoring) || JSON.stringify(q.authoring).length > RAG_LIMITS.text)) e.push(`${at}: authoring must be a small object`);
    const ids = q.relevantSourceIds;
    if (!Array.isArray(ids) || ids.length > RAG_LIMITS.relevant || ids.some((s) => typeof s !== 'string' || !ID.test(s)) || new Set(ids).size !== ids.length) e.push(`${at}: relevantSourceIds must be 0-${RAG_LIMITS.relevant} unique safe source ids`);
    const r = q.relevance;
    if (!isRecord(r)) e.push(`${at}: relevance must state status pending or annotated`);
    else {
      for (const k of Object.keys(r)) if (!RELEVANCE_KEYS.has(k)) e.push(`${at}: relevance: unknown key ${k}`);
      for (const k of ['annotatedBy', 'basis', 'note']) if (r[k] !== undefined && (typeof r[k] !== 'string' || !r[k].trim() || r[k].length > RAG_LIMITS.text)) e.push(`${at}: relevance.${k} must be a short string`);
      if (r.status === 'pending') { if (Array.isArray(ids) && ids.length) e.push(`${at}: pending relevance must not list relevantSourceIds`); }
      else if (r.status === 'annotated') {
        if (!Array.isArray(ids) || !ids.length) e.push(`${at}: annotated relevance needs at least one relevantSourceId`);
        if (typeof r.annotatedBy !== 'string') e.push(`${at}: annotated relevance needs annotatedBy`);
        if (!ISO(r.annotatedAt)) e.push(`${at}: annotated relevance needs annotatedAt (ISO timestamp)`);
        if (typeof r.basis !== 'string') e.push(`${at}: annotated relevance needs basis (how the sources were reviewed)`);
      } else e.push(`${at}: relevance.status must be pending or annotated`);
    }
    if (!e.some((m) => m.startsWith(at + ':'))) out.set(q.caseId, q);
  });
  if (e.length) throw new Error('invalid queries: ' + e.join('; '));
  return out;
}

// ---------- corpus index ----------

/** Re-derives the identity the corpus importer and search engine use: source and chunk sha256 over their exact text,
 * every chunk an excerpt of its own source, and the index sha256 over canonical {chunks, dimensions, model, schema,
 * sources} without the index's own sha256. Throws on anything that does not bind. */
export function verifyIndex(ix) {
  const fail = (m) => { throw new Error(`invalid corpus index: ${m}`); };
  if (!exactKeys(ix, ['schema', 'model', 'dimensions', 'sha256', 'sources', 'chunks'])) fail('needs exactly schema, model, dimensions, sha256, sources, chunks');
  if (ix.schema !== CORPUS.schema || ix.model !== CORPUS.model || ix.dimensions !== CORPUS.dimensions) fail(`schema/model/dimensions must be ${CORPUS.schema}/${CORPUS.model}/${CORPUS.dimensions}`);
  if (!HEX64.test(ix.sha256 ?? '')) fail('sha256 must be 64 lowercase hex');
  if (!Array.isArray(ix.sources) || !ix.sources.length || ix.sources.length > RAG_LIMITS.sources) fail(`sources must hold 1-${RAG_LIMITS.sources} items`);
  if (!Array.isArray(ix.chunks) || !ix.chunks.length || ix.chunks.length > RAG_LIMITS.chunks) fail(`chunks must hold 1-${RAG_LIMITS.chunks} items`);
  const sources = new Map(), chunks = new Map();
  ix.sources.forEach((s, i) => {
    if (!exactKeys(s, [...SOURCE_META, 'roles', 'text'])) fail(`sources[${i}] has unexpected keys`);
    if (!ID.test(s.id ?? '') || sources.has(s.id)) fail(`sources[${i}].id must be a unique safe id`);
    if (!Array.isArray(s.roles) || !s.roles.length || s.roles.some((r) => typeof r !== 'string' || !ID.test(r))) fail(`sources[${i}].roles must list role ids`);
    if (typeof s.text !== 'string' || !s.text.trim() || s.sha256 !== sha256(s.text)) fail(`sources[${i}].sha256 does not match its text`);
    sources.set(s.id, s);
  });
  ix.chunks.forEach((c, i) => {
    if (!exactKeys(c, ['id', 'sourceId', 'parentId', 'headingPath', 'text', 'sha256', 'vector'])) fail(`chunks[${i}] has unexpected keys`);
    if (!ID.test(c.id ?? '') || chunks.has(c.id)) fail(`chunks[${i}].id must be a unique safe id`);
    const src = sources.get(c.sourceId);
    if (!src) fail(`chunks[${i}].sourceId names no source`);
    if (typeof c.text !== 'string' || !c.text.trim() || c.sha256 !== sha256(c.text)) fail(`chunks[${i}].sha256 does not match its text`);
    if (!src.text.includes(c.text)) fail(`chunks[${i}].text is not an excerpt of its source`);
    if (!Array.isArray(c.headingPath) || c.headingPath.some((h) => typeof h !== 'string')) fail(`chunks[${i}].headingPath must list strings`);
    if (!Array.isArray(c.vector) || c.vector.length !== CORPUS.dimensions || c.vector.some((x) => typeof x !== 'number' || !Number.isFinite(x))) fail(`chunks[${i}].vector must hold ${CORPUS.dimensions} finite numbers`);
    chunks.set(c.id, c);
  });
  const digest = sha256(canonical({ chunks: ix.chunks.map(({ headingPath, id, parentId, sha256: h, sourceId, text, vector }) => ({ headingPath, id, parentId, sha256: h, sourceId, text, vector })),
    dimensions: ix.dimensions, model: ix.model, schema: ix.schema, sources: ix.sources.map((s) => ({ ...Object.fromEntries(SOURCE_META.map((k) => [k, s[k]])), roles: s.roles, text: s.text })) }));
  if (digest !== ix.sha256) fail('sha256 does not match the canonical index');
  return {
    sha256: ix.sha256, sources, chunks,
    identity: { schema: ix.schema, model: ix.model, dimensions: ix.dimensions, indexSha256: ix.sha256, sources: ix.sources.length, chunks: ix.chunks.length,
      sourceSetSha256: sha256(canonical(ix.sources.map((s) => [s.id, s.sha256, s.license, [...s.roles].sort()]).sort((a, b) => a[0] < b[0] ? -1 : 1))) },
  };
}

/** A path argument must be local, inside the repository (or explicitly allowed), and a regular file with no symlink. */
function localFile(p, ext, at, allowOutside) {
  if (typeof p !== 'string' || !p.trim() || p.length > 512 || /[\0-\x1f]/.test(p)) throw new Error(`${at} must be a local path`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[\\/]{2}/.test(p)) throw new Error(`${at} must be a local file (no URL or UNC path)`);
  const full = resolve(p), rel = relative(ROOT, full);
  const inside = rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
  if (!inside && !allowOutside) throw new Error(`${at} outside the repository needs --allow-outside-repo`);
  if (!ext.test(full)) throw new Error(`${at} has an unexpected file type`);
  if (!existsSync(full)) throw new Error(`${at} not found`);
  const st = lstatSync(full);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${at} is not a regular file`);
  if (inside) {
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same(realpathSync.native(full), join(realpathSync.native(ROOT), rel))) throw new Error(`${at} passes through a symlink or junction`);
  }
  return full;
}

export function loadIndexJson(path, allowOutside = false) {
  const bytes = readBoundedFile(localFile(path, /\.json$/i, '--index', allowOutside), RAG_LIMITS.indexBytes);
  let ix; try { ix = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('--index is not JSON'); }
  return { index: ix, origin: { kind: 'json', path: relative(ROOT, resolve(path)).split(sep).join('/'), fileSha256: sha256(bytes) } };
}

/** Bundles a repository TypeScript module under src/ with esbuild (as the build tools do) and takes its CORPUS export
 * (or the one named by exportName). Only repository source is executed; nothing is fetched. */
export async function loadIndexModule(path, exportName = 'CORPUS') {
  const full = localFile(path, /\.ts$/i, '--index-module', false), rel = relative(join(ROOT, 'src'), full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('--index-module must be a TypeScript file under src/');
  if (!ID.test(exportName)) throw new Error('--index-export must be an identifier');
  const { build } = await import('esbuild');
  const out = await build({ entryPoints: [full], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent', absWorkingDir: ROOT });
  const code = out.outputFiles[0].text;
  if (Buffer.byteLength(code) > RAG_LIMITS.indexBytes) throw new Error('--index-module bundle exceeds the index size limit');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  if (!Object.hasOwn(mod, exportName)) throw new Error(`--index-module has no export ${exportName}`);
  return { index: JSON.parse(JSON.stringify(mod[exportName])), origin: { kind: 'ts-module', path: relative(ROOT, full).split(sep).join('/'), export: exportName, bundleSha256: sha256(code) } };
}

// ---------- saved runs ----------

/** Parses one saved retrieval run. Shape problems refuse the whole file; binding problems are judged per query later. */
export function parseRun(bytes, at = 'run') {
  if (bytes.length > RAG_LIMITS.runBytes) throw new Error(`${at} exceeds ${RAG_LIMITS.runBytes} bytes`);
  if (scanSensitive(bytes.toString('utf8')).some((h) => h.class === 'credential')) throw new Error(`refusing ${at}: credential-like content`);
  let r; try { r = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`${at} is not JSON`); }
  const e = [];
  if (!isRecord(r)) throw new Error(`${at} must be a JSON object`);
  for (const k of Object.keys(r)) if (!RUN_KEYS.has(k)) e.push(`unknown key ${k}`);
  if (r.version !== RUN_VERSION) e.push(`version must be ${RUN_VERSION}`);
  if (typeof r.runId !== 'string' || !SLUG.test(r.runId)) e.push('runId must be 1-64 letters, digits, dot, dash or underscore');
  if (!PROVENANCES.includes(r.provenance)) e.push(`provenance must be declared as one of ${PROVENANCES.join(', ')}`);
  if (!HEX64.test(r.querySetSha256 ?? '')) e.push('querySetSha256 must be the 64-hex query set identity the run was recorded against');
  if (r.retrievalConfig !== undefined && (!isRecord(r.retrievalConfig) || canonical(r.retrievalConfig).length > RAG_LIMITS.config)) e.push(`retrievalConfig must be an object up to ${RAG_LIMITS.config} canonical characters`);
  if (r.identities !== undefined) {
    if (!isRecord(r.identities)) e.push('identities must be an object');
    else for (const [k, v] of Object.entries(r.identities)) if (!IDENTITY_KEYS.includes(k) || !HEX64.test(v ?? '')) e.push(`identities.${k} must be one of ${IDENTITY_KEYS.join(', ')} with a 64-hex value`);
  }
  if (r.collection !== undefined && (!isRecord(r.collection) || JSON.stringify(r.collection).length > RAG_LIMITS.text * 3)) e.push('collection must be a small object');
  if (!Array.isArray(r.results) || r.results.length > RAG_LIMITS.queries) e.push(`results must list 0-${RAG_LIMITS.queries} entries`);
  const seen = new Set();
  for (const [i, x] of (Array.isArray(r.results) ? r.results : []).entries()) {
    const w = `results[${i}]`;
    if (!exactKeys(x, ['caseId', 'expertId', 'queryHash', 'result'])) { e.push(`${w} needs exactly caseId, expertId, queryHash, result`); continue; }
    if (typeof x.caseId !== 'string' || !ID.test(x.caseId)) e.push(`${w}.caseId must be a safe id`);
    else if (seen.has(x.caseId)) e.push(`${w} repeats case ${x.caseId}`); else seen.add(x.caseId);
    if (typeof x.expertId !== 'string' || !ID.test(x.expertId)) e.push(`${w}.expertId must be a safe id`);
    if (!HEX64.test(x.queryHash ?? '')) e.push(`${w}.queryHash must be 64-hex`);
    const s = x.result;
    if (!exactKeys(s, RESULT_KEYS)) { e.push(`${w}.result must have exactly ${RESULT_KEYS.join(', ')}`); continue; }
    if (s.schema !== CORPUS.searchSchema) e.push(`${w}.result.schema must be ${CORPUS.searchSchema}`);
    if (!HEX64.test(s.indexSha256 ?? '')) e.push(`${w}.result.indexSha256 must be 64-hex`);
    if (!CORPUS.strategies.includes(s.strategy)) e.push(`${w}.result.strategy must be one of ${CORPUS.strategies.join(', ')}`);
    if (s.model !== null && (typeof s.model !== 'string' || s.model.length > 200)) e.push(`${w}.result.model must be null or a short string`);
    if (typeof s.matched !== 'boolean') e.push(`${w}.result.matched must be boolean`);
    if (s.degraded !== null && (typeof s.degraded !== 'string' || !s.degraded || s.degraded.length > RAG_LIMITS.degraded)) e.push(`${w}.result.degraded must be null or a short reason category`);
    if (!Array.isArray(s.sources) || s.sources.length > RAG_LIMITS.resultSources || s.sources.some((m) => !exactKeys(m, SOURCE_META))) e.push(`${w}.result.sources must list up to ${RAG_LIMITS.resultSources} source metadata records`);
    if (!Array.isArray(s.hits) || s.hits.length > RAG_LIMITS.hits) { e.push(`${w}.result.hits must list up to ${RAG_LIMITS.hits} hits`); continue; }
    s.hits.forEach((h, j) => {
      if (!exactKeys(h, HIT_KEYS)) e.push(`${w}.result.hits[${j}] must have exactly ${HIT_KEYS.join(', ')}`);
      else if (typeof h.text !== 'string' || typeof h.chunkId !== 'string' || typeof h.sourceId !== 'string' || typeof h.sha256 !== 'string' || !Array.isArray(h.headingPath) || typeof h.score !== 'number' || !Number.isFinite(h.score)) e.push(`${w}.result.hits[${j}] has wrongly typed fields`);
    });
  }
  if (e.length) throw new Error(`invalid ${at}: ` + e.slice(0, 20).join('; '));
  return r;
}

const sameMeta = (a, b) => SOURCE_META.every((k) => a[k] === b[k]);

/** Checks one hit against the verified index. Returns the problems found (empty means the citation binds). */
export function hitProblems(hit, index, listed) {
  const c = index.chunks.get(hit.chunkId), p = [];
  if (!c) return ['unknown-chunk'];
  if (hit.sourceId !== c.sourceId) p.push('source-mismatch');
  if (hit.parentId !== c.parentId || canonical(hit.headingPath) !== canonical(c.headingPath)) p.push('location-mismatch');
  if (hit.sha256 !== c.sha256) p.push('chunk-hash-mismatch');
  if (sha256(hit.text) !== hit.sha256 || hit.text !== c.text) p.push('chunk-text-mismatch');
  if (!listed.has(hit.sourceId)) p.push('source-not-listed');
  return p;
}

/** Per-query measurements. Invalid or foreign-role hits are never credited as relevant. */
export function scoreResult(q, entry, index) {
  const s = entry.result, roleOk = (sourceId) => index.sources.get(sourceId)?.roles.includes(q.expertId) === true;
  const listed = new Set(), invalidSources = [];
  for (const m of s.sources) {
    const src = index.sources.get(m.id);
    if (!src) invalidSources.push({ sourceId: m.id, problem: 'unknown-source' });
    else if (!sameMeta(m, src)) invalidSources.push({ sourceId: m.id, problem: 'source-metadata-mismatch' });
    else listed.add(m.id);
  }
  const hits = s.hits.map((h, i) => {
    const problems = hitProblems(h, index, listed), foreign = !problems.includes('unknown-chunk') && index.sources.has(h.sourceId) && !roleOk(h.sourceId);
    return { rank: i + 1, chunkId: h.chunkId, sourceId: h.sourceId, valid: problems.length === 0, problems, roleLeak: foreign };
  });
  const credited = hits.filter((h) => h.valid && !h.roleLeak);
  const consistency = [];
  if (!s.matched && s.hits.length) consistency.push('hits-without-match');
  if (s.matched && !s.hits.length) consistency.push('matched-without-hits');
  const base = {
    caseId: q.caseId, expertId: q.expertId, queryHash: entry.queryHash, strategy: s.strategy, model: s.model, degraded: s.degraded,
    noHit: s.hits.length === 0, hits: hits.map(({ rank, chunkId, sourceId, valid, problems, roleLeak }) => ({ rank, chunkId, sourceId, valid, ...(problems.length ? { problems } : {}), ...(roleLeak ? { roleLeak } : {}) })),
    roleLeakHits: hits.filter((h) => h.roleLeak).length, invalidCitationHits: hits.filter((h) => !h.valid).length, invalidSourceRecords: invalidSources, consistency,
  };
  if (q.relevance.status !== 'annotated') return { ...base, relevance: 'pending', recallAt3: null, reciprocalRank: null, metricNote: NULL_METRIC };
  const relevant = new Set(q.relevantSourceIds);
  const top = new Set(credited.filter((h) => h.rank <= K).map((h) => h.sourceId).filter((id) => relevant.has(id)));
  const first = credited.find((h) => relevant.has(h.sourceId));
  return { ...base, relevance: 'annotated', relevantSourceIds: [...relevant], recallAt3: round(top.size / relevant.size), reciprocalRank: round(first ? 1 / first.rank : 0) };
}

/** Binds a run to the query set and index, then measures each query. A run recorded against another query set or
 * another corpus index is refused as a whole (metrics null): mixing identities would make the numbers meaningless. */
export function evaluateRun(run, queries, index, { runSha256 } = {}) {
  const qsh = querySetHash([...queries.values()]), problems = [];
  if (run.querySetSha256 !== qsh) problems.push('run was recorded against a different query set (querySetSha256 mismatch)');
  const results = new Map(run.results.map((x) => [x.caseId, x]));
  for (const x of run.results) {
    const q = queries.get(x.caseId);
    if (!q) { problems.push(`result for unknown case ${x.caseId}`); continue; }
    if (x.expertId !== q.expertId) problems.push(`case ${x.caseId}: role ${x.expertId} differs from the query role ${q.expertId}`);
    if (x.queryHash !== queryHash(q)) problems.push(`case ${x.caseId}: queryHash does not match the authored query`);
    if (x.result.indexSha256 !== index.sha256) problems.push(`case ${x.caseId}: indexSha256 differs from the verified corpus index`);
  }
  const identity = runIdentity(run, runSha256);
  if (problems.length) return { runId: run.runId, status: 'REFUSED', problems, identity, metrics: null, queries: [] };
  const rows = [...queries.values()].map((q) => results.has(q.caseId) ? scoreResult(q, results.get(q.caseId), index) : { caseId: q.caseId, expertId: q.expertId, queryHash: queryHash(q), missing: true, recallAt3: null, reciprocalRank: null });
  return { runId: run.runId, status: 'EVALUATED', problems: [], identity, metrics: aggregate(rows), queries: rows };
}

function runIdentity(run, runSha256) {
  return {
    runSha256: runSha256 ?? null, provenance: { declared: run.provenance, basis: 'operator-declared; not a cryptographic provider proof' },
    querySetSha256: run.querySetSha256, strategies: tally(run.results, (x) => x.result.strategy), models: tally(run.results, (x) => String(x.result.model)),
    indexSha256: [...new Set(run.results.map((x) => x.result.indexSha256))],
    retrievalConfigSha256: run.retrievalConfig ? sha256(canonical(run.retrievalConfig)) : null,
    prior: IDENTITY_KEYS.reduce((o, k) => ({ ...o, [k]: run.identities?.[k] ?? null }), { source: run.identities ? 'operator-supplied in the run file (compare with the quality report fingerprint)' : 'not supplied' }),
    ...(run.collection ? { collection: { ...run.collection, operatorSupplied: true, verified: false } } : {}),
  };
}

export function aggregate(rows) {
  const present = rows.filter((r) => !r.missing), annotated = present.filter((r) => r.relevance === 'annotated');
  return {
    queries: rows.length, withResult: present.length, missingResults: rows.filter((r) => r.missing).map((r) => r.caseId),
    annotated: annotated.length, pendingRelevance: present.filter((r) => r.relevance === 'pending').length,
    meanRecallAt3: annotated.length ? mean(annotated.map((r) => r.recallAt3)) : null,
    mrr: annotated.length ? mean(annotated.map((r) => r.reciprocalRank)) : null,
    ...(annotated.length ? {} : { metricNote: `${NULL_METRIC}: no query with a result carries an operator relevance annotation; null is not zero and not success` }),
    noHit: present.filter((r) => r.noHit).length, degraded: present.filter((r) => r.degraded !== null).length, degradedReasons: tally(present.filter((r) => r.degraded !== null), (r) => r.degraded),
    roleLeakHits: present.reduce((a, r) => a + r.roleLeakHits, 0), queriesWithRoleLeak: present.filter((r) => r.roleLeakHits).length,
    invalidCitationHits: present.reduce((a, r) => a + r.invalidCitationHits, 0), invalidSourceRecords: present.reduce((a, r) => a + r.invalidSourceRecords.length, 0),
    inconsistentResults: present.filter((r) => r.consistency.length).length,
  };
}

const PAIR_COUNTS = [['noHit', 'higher'], ['degraded', 'higher'], ['roleLeakHits', 'higher'], ['invalidCitationHits', 'higher']];

/** Baseline vs candidate over the same query set, roles and corpus only. Deltas are prompts for review; no winner. */
export function comparePair(base, cand) {
  const out = { baselineRunId: base?.runId ?? null, candidateRunId: cand.runId, note: 'No winner is declared. Retrieval deltas are not advice quality; held-out advice quality stays pending human review.' };
  if (!base) return { ...out, status: 'BASELINE_MISSING', reason: 'no --baseline run was supplied; nothing is compared' };
  const problems = [];
  if (base.status !== 'EVALUATED') problems.push('baseline run was refused');
  if (cand.status !== 'EVALUATED') problems.push('candidate run was refused');
  if (base.identity.querySetSha256 !== cand.identity.querySetSha256) problems.push('different query sets');
  if (canonical(base.identity.indexSha256) !== canonical(cand.identity.indexSha256)) problems.push('different corpus index identity');
  if (base.identity.runSha256 && base.identity.runSha256 === cand.identity.runSha256) problems.push('baseline and candidate are the same file');
  if (!problems.length) for (const c of cand.queries) {
    const b = base.queries.find((x) => x.caseId === c.caseId);
    if (b && (b.expertId !== c.expertId || b.queryHash !== c.queryHash)) problems.push(`case ${c.caseId}: different role or query`);
  }
  if (problems.length) return { ...out, status: 'REFUSED', problems };
  const variables = {
    strategies: { baseline: base.identity.strategies, candidate: cand.identity.strategies },
    retrievalConfigSha256: { baseline: base.identity.retrievalConfigSha256, candidate: cand.identity.retrievalConfigSha256, same: base.identity.retrievalConfigSha256 === cand.identity.retrievalConfigSha256 },
    ...Object.fromEntries(IDENTITY_KEYS.map((k) => [k, { baseline: base.identity.prior[k], candidate: cand.identity.prior[k], same: base.identity.prior[k] && cand.identity.prior[k] ? base.identity.prior[k] === cand.identity.prior[k] : null }])),
  };
  const perQuery = cand.queries.map((c) => {
    const b = base.queries.find((x) => x.caseId === c.caseId);
    if (c.missing || b.missing) return { caseId: c.caseId, status: 'NOT_COMPARED', reason: b.missing ? 'baseline result missing' : 'candidate result missing' };
    if (c.relevance !== 'annotated') return { caseId: c.caseId, status: 'NOT_SCORED', reason: NULL_METRIC };
    return { caseId: c.caseId, status: 'COMPARED', recallAt3: { baseline: b.recallAt3, candidate: c.recallAt3, delta: round(c.recallAt3 - b.recallAt3) }, reciprocalRank: { baseline: b.reciprocalRank, candidate: c.reciprocalRank, delta: round(c.reciprocalRank - b.reciprocalRank) } };
  });
  const scored = perQuery.filter((p) => p.status === 'COMPARED');
  const m = (key, side) => mean(scored.map((p) => p[key][side]));
  return {
    ...out, status: 'COMPARED', variables,
    missingBaselines: perQuery.filter((p) => p.reason === 'baseline result missing').map((p) => p.caseId),
    missingCandidates: perQuery.filter((p) => p.reason === 'candidate result missing').map((p) => p.caseId),
    pairedAnnotated: scored.length,
    retrieval: scored.length ? { meanRecallAt3: { baseline: m('recallAt3', 'baseline'), candidate: m('recallAt3', 'candidate') }, mrr: { baseline: m('reciprocalRank', 'baseline'), candidate: m('reciprocalRank', 'candidate') } }
      : { status: 'NOT_SCORED', reason: `${NULL_METRIC}: no paired query has an operator relevance annotation` },
    counts: PAIR_COUNTS.map(([k, worse]) => ({ metric: k, baseline: base.metrics[k], candidate: cand.metrics[k], worseWhen: worse })),
    perQuery,
  };
}

// ---------- report ----------

export function buildReport({ queries, queriesOrigin, index, indexOrigin, candidate, baseline, pair, now }) {
  const qs = [...queries.values()];
  const report = {
    version: RAG_EVAL_VERSION, generatedAt: now.toISOString(),
    meaning: 'Retrieval measurements over saved runs against a verified licensed corpus. Relevance labels are operator-authored annotations, not ground truth; recall@3 and MRR are not answer quality, accuracy or a winner. Advice quality is judged only by human review in the quality batch.',
    identity: {
      corpus: { ...index.identity, origin: indexOrigin },
      querySet: { querySetSha256: querySetHash(qs), annotationSetSha256: annotationSetHash(qs), queries: qs.length, annotated: qs.filter((q) => q.relevance.status === 'annotated').length, origin: queriesOrigin },
    },
    relevance: { basis: 'operator-authored annotation (relevantSourceIds + relevance.annotatedBy/annotatedAt/basis)', truth: false, pendingCaseIds: qs.filter((q) => q.relevance.status === 'pending').map((q) => q.caseId) },
    metricDefinitions: {
      recallAt3: 'Distinct annotated-relevant source IDs among valid, role-eligible hits ranked 1-3, divided by the number of annotated-relevant sources. null when the query has no annotation.',
      reciprocalRank: '1 / hit rank of the first valid, role-eligible hit from an annotated-relevant source; 0 when none. MRR is the mean over annotated queries with a result; null when there are none.',
      roleLeakHits: 'Hits from a source whose roles do not include the query role (never credited).',
      invalidCitationHits: 'Hits whose chunk ID, source, location, chunk hash or exact text do not match the verified index, or whose source is not listed with matching metadata (never credited).',
      noHit: 'Results with zero hits.', degraded: 'Results with a non-null degraded reason (e.g. lexical fallback).',
    },
    candidate, baseline: baseline ?? null, comparison: pair,
    adviceQuality: { status: 'PENDING_HUMAN_REVIEW', note: 'Held-out advice quality is not measured here. Record baseline/candidate project exports and run tools/cloudbite-quality-batch.mjs with human ratings (see docs/cloudbite/rag-evaluation.md).' },
    winner: null,
  };
  const { generatedAt: _g, ...stable } = report;
  return { ...report, contentSha256: sha256(canonical(stable)) };
}

export function toMarkdown(r) {
  const run = (x) => x.status !== 'EVALUATED' ? [`Status **${x.status}**: ${x.problems.join('; ')}`] : [
    `Status EVALUATED; strategies ${JSON.stringify(x.identity.strategies)}; retrieval config ${x.identity.retrievalConfigSha256 ?? 'not supplied'}; provenance ${x.identity.provenance.declared} (operator-declared)`,
    `Prior identities: prompt set ${x.identity.prior.promptSetHash ?? 'n/a'}; instruction set ${x.identity.prior.instructionSetHash ?? 'n/a'}; knowledge ${x.identity.prior.knowledgeRevisionHash ?? 'n/a'}`, '',
    '| Metric | Value |', '|---|---|',
    ...['queries', 'withResult', 'annotated', 'pendingRelevance', 'meanRecallAt3', 'mrr', 'noHit', 'degraded', 'roleLeakHits', 'invalidCitationHits', 'invalidSourceRecords', 'inconsistentResults'].map((k) => `| ${k} | ${x.metrics[k] ?? 'null'} |`),
    ...(x.metrics.missingResults.length ? ['', `Missing results: ${x.metrics.missingResults.join(', ')}`] : []), ...(x.metrics.metricNote ? ['', x.metrics.metricNote] : [])];
  const L = [`# Cloudbite retrieval evaluation`, '', `Generated ${r.generatedAt} by ${r.version}. ${r.meaning}`, '',
    `- Corpus index \`${r.identity.corpus.indexSha256}\` (${r.identity.corpus.sources} sources, ${r.identity.corpus.chunks} chunks, ${r.identity.corpus.model}/${r.identity.corpus.dimensions}; ${r.identity.corpus.origin.kind} ${r.identity.corpus.origin.path})`,
    `- Query set \`${r.identity.querySet.querySetSha256}\` (${r.identity.querySet.queries} queries, ${r.identity.querySet.annotated} annotated); annotation set \`${r.identity.querySet.annotationSetSha256}\``,
    `- Relevance pending for: ${r.relevance.pendingCaseIds.join(', ') || 'none'}`, '', `## Candidate ${r.candidate.runId}`, '', ...run(r.candidate), ''];
  if (r.baseline) L.push(`## Baseline ${r.baseline.runId}`, '', ...run(r.baseline), '');
  L.push('## Comparison', '', `Status **${r.comparison.status}**. ${r.comparison.note}`, ...(r.comparison.problems ?? []).map((p) => `- ${p}`), ...(r.comparison.reason ? [r.comparison.reason] : []));
  if (r.comparison.status === 'COMPARED') L.push('', `Missing baselines: ${r.comparison.missingBaselines.join(', ') || 'none'}; paired annotated queries: ${r.comparison.pairedAnnotated}`, `Retrieval: ${JSON.stringify(r.comparison.retrieval)}`, `Counts: ${JSON.stringify(r.comparison.counts)}`);
  L.push('', `Advice quality: **${r.adviceQuality.status}**. Winner: none.`, '');
  return L.join('\n');
}

// ---------- template ----------

/** A recording skeleton for retrieval runs plus a quality-batch manifest for recorded baseline/candidate advice. */
export function templates(queries) {
  const qs = [...queries.values()];
  const run = { version: RUN_VERSION, runId: 'candidate-REPLACE', provenance: 'test-synthetic', querySetSha256: querySetHash(qs), retrievalConfig: {},
    collection: { method: 'REPLACE: how the results were recorded', note: 'Replace each result with the saved CorpusSearchResult; delete entries you did not run (they are reported as missing).' },
    results: qs.map((q) => ({ caseId: q.caseId, expertId: q.expertId, queryHash: queryHash(q), result: null })) };
  const manifest = { version: BATCH_VERSION, batchId: 'v8-expert-workflow-advice',
    entries: ['v7-eda-closure', 'v7-falsify-evidence'].map((caseId) => ({ caseId, input: `candidate/${caseId}.json`, provenance: 'observed-live', baseline: `baseline/${caseId}.json`, baselineProvenance: 'observed-live',
      collection: { method: 'REPLACE: fresh project per case, same model, question, stage, materials and roles; only the corpus retrieval differs', note: 'Held-out advice quality is pending human review until rating rows exist.' } })) };
  return { run, manifest };
}

// ---------- CLI ----------

function parseArgs(argv) {
  for (const a of argv) if (FORBIDDEN_ARG.test(a)) throw new Error(`refusing argument ${a.split('=')[0]}: credentials are never accepted and no live search is implemented`);
  for (const a of argv) if (scanSensitive(a).some((h) => h.class === 'credential')) throw new Error('refusing: an argument looks like a credential');
  const o = { command: argv[0], flags: new Set() };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--queries') o.queries = v(); else if (a === '--index') o.index = v(); else if (a === '--index-module') o.indexModule = v();
    else if (a === '--index-export') o.indexExport = v(); else if (a === '--run') o.run = v(); else if (a === '--baseline') o.baseline = v(); else if (a === '--out') o.out = v();
    else if (['--force', '--allow-outside-repo'].includes(a)) o.flags.add(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['validate', 'evaluate', 'template'].includes(o.command)) throw new Error('command must be validate, evaluate or template');
  if (o.index && o.indexModule) throw new Error('pass --index or --index-module, not both');
  if (o.command === 'evaluate' && (!o.run || (!o.index && !o.indexModule))) throw new Error('evaluate needs --run and --index or --index-module');
  return o;
}

function loadQueries(path, allowOutside) {
  const full = path ? localFile(path, /\.jsonl$/i, '--queries', allowOutside) : DEFAULT_QUERIES;
  const bytes = readBoundedFile(full, RAG_LIMITS.queriesBytes, /\.jsonl$/i);
  if (scanSensitive(bytes.toString('utf8')).some((h) => h.class === 'credential')) throw new Error('refusing queries: credential-like content');
  return { queries: parseQueries(bytes.toString('utf8')), origin: { path: relative(ROOT, full).split(sep).join('/'), fileSha256: sha256(bytes) } };
}

/** Annotated relevant sources must exist in the corpus and be eligible for the query role, or the label cannot be met. */
export function checkAnnotations(queries, index) {
  const issues = [];
  for (const q of queries.values()) for (const id of q.relevantSourceIds) {
    const s = index.sources.get(id);
    if (!s) issues.push(`${q.caseId}: relevant source ${id} is not in the corpus`);
    else if (!s.roles.includes(q.expertId)) issues.push(`${q.caseId}: relevant source ${id} is not eligible for role ${q.expertId}`);
  }
  return issues;
}

/** Everything is read and checked before the first file is written, so a refusal leaves no output. */
export async function runCli(argv, { log = console.log, now = new Date() } = {}) {
  const o = parseArgs(argv), allowOutside = o.flags.has('--allow-outside-repo');
  const { queries, origin: queriesOrigin } = loadQueries(o.queries, allowOutside);
  const loaded = o.index ? loadIndexJson(o.index, allowOutside) : o.indexModule ? await loadIndexModule(o.indexModule, o.indexExport) : null;
  const index = loaded ? verifyIndex(loaded.index) : null;
  const annotationIssues = index ? checkAnnotations(queries, index) : [];
  if (annotationIssues.length) throw new Error('invalid relevance annotations: ' + annotationIssues.join('; '));
  if (o.command === 'validate') {
    const qs = [...queries.values()];
    log(`${qs.length} queries, ${qs.filter((q) => q.relevance.status === 'annotated').length} annotated, query set ${querySetHash(qs)}${index ? `; corpus ${index.sha256} verified` : ''}`);
    return { exitCode: 0, querySetSha256: querySetHash(qs) };
  }
  const outDir = resolveOutput(o.out ?? DEFAULT_RAG_OUT, { allowOutsideRepo: allowOutside }), force = o.flags.has('--force');
  if (o.command === 'template') {
    const t = templates(queries);
    mkdirSync(outDir, { recursive: true });
    writeNew(join(outDir, 'retrieval-run.template.json'), JSON.stringify(t.run, null, 2) + '\n', force);
    writeNew(join(outDir, 'quality-batch-manifest.json'), JSON.stringify(t.manifest, null, 2) + '\n', force);
    log(`wrote ${relative(process.cwd(), outDir) || outDir}`);
    return { exitCode: 0, outDir, ...t };
  }
  const read = (p, at) => { const b = readBoundedFile(localFile(p, /\.json$/i, at, allowOutside), RAG_LIMITS.runBytes); return { run: parseRun(b, at), sha: sha256(b) }; };
  const c = read(o.run, '--run'), b = o.baseline ? read(o.baseline, '--baseline') : null;
  const candidate = evaluateRun(c.run, queries, index, { runSha256: c.sha }), baseline = b ? evaluateRun(b.run, queries, index, { runSha256: b.sha }) : null;
  const report = buildReport({ queries, queriesOrigin, index, indexOrigin: loaded.origin, candidate, baseline, pair: comparePair(baseline, candidate), now });
  const name = `${c.run.runId}${b ? `__vs__${b.run.runId}` : ''}`;
  if (existsSync(join(outDir, name + '.json')) && !force) throw new Error(`refusing to overwrite ${name}.json; pass --force`);
  mkdirSync(outDir, { recursive: true });
  writeNew(join(outDir, name + '.json'), JSON.stringify(report, null, 2) + '\n', force);
  writeNew(join(outDir, name + '.md'), toMarkdown(report), force);
  log(`${name}: candidate ${candidate.status}, comparison ${report.comparison.status}; wrote ${relative(process.cwd(), join(outDir, name + '.json'))}`);
  const bad = candidate.status !== 'EVALUATED' || (baseline && baseline.status !== 'EVALUATED') || report.comparison.status === 'REFUSED';
  return { exitCode: bad ? 3 : 0, report, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((r) => { process.exitCode = r.exitCode; }, (err) => { console.error('cloudbite-rag-eval: ' + err.message); process.exitCode = 2; });
}
