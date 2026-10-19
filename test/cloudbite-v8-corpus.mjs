// V8 licensed corpus: the generated index (src/cloudbite-corpus.generated.ts) against its saved originals, and the importer's
// rejection paths (rights, hash tamper, path escape, broken structure) on temporary copies. Offline: the embeddings
// endpoint is only ever a local stub here, and the real CLI --check runs with OPENAI_API_KEY removed.
//   node test/cloudbite-v8-corpus.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORPUS_DIR = path.join(ROOT, 'knowledge/cloudbite-corpus');
const GENERATED = path.join(ROOT, 'src/cloudbite-corpus.generated.ts');
const imp = await import(pathToFileURL(path.join(ROOT, 'tools/import-cloudbite-corpus.mjs')).href);
const b = await build({ stdin: { contents: "export * from './src/cloudbite-corpus.generated.ts'; export * from './src/cloudbite-corpus-contract.ts'; export { validateCorpusIndex } from './src/cloudbite-corpus-search.ts';", resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const g = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
const rejects = async (fn, re, message) => { await assert.rejects(fn, re, message); checks++; };
const sha = s => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudbite-v8-corpus-'));
let n = 0;
/** A private copy of the corpus directory plus the generated file, optionally edited. */
function copy(edit = () => {}) {
  const dir = path.join(tmp, `c${++n}`);
  fs.cpSync(CORPUS_DIR, dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json'), out = path.join(dir, 'generated.ts');
  fs.copyFileSync(GENERATED, out);
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  edit(m, dir);
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  return { dir, manifest, out };
}
/** Re-pin an edited original (the source hash and its in-document license evidence). */
const rehash = (s, buf) => { s.sha256 = sha(buf); for (const e of s.licenseEvidence) if (e.file === s.file) e.sha256 = s.sha256; };
const noNetwork = () => { throw new Error('network must not be used'); };

try {
  const C = g.CORPUS;
  // ── 1. generated index: identity, rights, structure, real vectors ──
  ok(C.schema === g.CORPUS_SCHEMA && C.model === g.CORPUS_MODEL && C.dimensions === g.CORPUS_DIMENSIONS && C.dimensions === 256, 'index schema/model/dimensions follow the contract');
  ok(C.sha256 === imp.indexSha256(C) && /^[0-9a-f]{64}$/.test(C.sha256), 'index sha256 covers canonical {schema,model,dimensions,sources,chunks}');
  ok(C.sources.length >= 4 && C.chunks.length >= 50 && C.chunks.length <= 200, `4+ sources and 50-200 chunks (${C.sources.length}, ${C.chunks.length})`);
  const eda = C.sources.filter(s => s.roles.some(r => ['probably-primetime-sta', 'cb-role-072', 'cb-role-075', 'cb-role-076'].includes(r)));
  const fal = C.sources.filter(s => s.roles.some(r => ['cb-role-101', 'cb-role-105', 'cb-role-106', 'cb-role-118'].includes(r)));
  ok(eda.length >= 2 && fal.length >= 2, 'both domains (EDA/STA and Falsify methodology) have sources');
  ok(Buffer.byteLength(C.sources.map(s => s.text).join('')) <= 2 * 1024 * 1024, 'original text is at most 2 MiB');
  for (const s of C.sources) {
    ok(/^orig-[a-z0-9][a-z0-9_-]{0,64}$/.test(s.id) && s.sha256 === sha(s.text), `${s.id}: id format and text-bound sha256`);
    ok(Object.hasOwn(imp.LICENSES, s.license) && s.licenseUrl.startsWith('https://') && s.attribution.length > 40 && s.roles.every(r => imp.ROLES.includes(r)), `${s.id}: license, licenseUrl, attribution and roles present`);
    ok(!/primetime|synopsys/i.test(s.url + s.title + s.attribution), `${s.id}: not a proprietary vendor manual`);
  }
  ok(C.sources.filter(s => s.license === 'BSD-3-Clause').every(s => s.attribution.includes('Copyright (c) 2018-2025, The OpenROAD Authors')), 'BSD sources retain the copyright notice');
  const ids = new Set();
  for (const c of C.chunks) {
    const src = C.sources.find(s => s.id === c.sourceId);
    ok(src && /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) && /^[a-zA-Z0-9_-]{1,80}$/.test(c.parentId) && !ids.has(c.id), `${c.id}: unique identifier resolving to its source`);
    ids.add(c.id);
    ok(c.sha256 === sha(c.text) && Buffer.byteLength(c.text) <= 2500 && src.text.includes(c.text), `${c.id}: bounded, hashed, an exact contiguous excerpt of the source text`);
    ok(c.vector.length === 256 && c.vector.every(Number.isFinite) && g.CORPUS_EMBEDDINGS.bindings[c.id] === imp.vectorBinding(c.sha256, c.vector), `${c.id}: 256 finite dimensions bound to its text/model/dimensions`);
    ok(((c.text.match(/^ {0,3}```/gm) ?? []).length) % 2 === 0, `${c.id}: code fences are never cut`);
  }
  const norms = C.chunks.map(c => Math.sqrt(c.vector.reduce((a, x) => a + x * x, 0)));
  ok(norms.every(x => Math.abs(x - 1) < 1e-3), 'vectors are unit-length OpenAI embeddings, not placeholders');
  ok(new Set(C.chunks.map(c => c.vector.slice(0, 4).join())).size >= C.chunks.length - 10, 'vectors differ between chunks');
  const cos = (a, b2) => a.reduce((s, x, i) => s + x * b2[i], 0);
  const byId = id => C.chunks.find(c => c.id === id);
  const rszTiming = C.chunks.find(c => c.sourceId === 'orig-openroad-rsz-readme' && c.headingPath.at(-1) === 'Repair Timing');
  const ppv = C.chunks.find(c => c.sourceId === 'orig-pmc1182327-ioannidis-2005' && c.headingPath.at(-1) === 'Modeling the Framework for False Positive Findings');
  const sameDomain = C.chunks.find(c => c.sourceId === 'orig-openroad-rsz-readme' && c.headingPath.at(-1) === 'Repair Design');
  ok(rszTiming && ppv && sameDomain && cos(rszTiming.vector, sameDomain.vector) > cos(rszTiming.vector, ppv.vector), 'semantic geometry: two resizer sections are closer to each other than to Ioannidis');
  ok(byId(rszTiming.id) === rszTiming && rszTiming.text.includes('repair_timing'), 'heading path is preserved (Gate Resizer > Commands > Repair Timing)');
  ok(C.chunks.some(c => /^```tcl\n[\s\S]*\n```$/m.test(c.text) && c.text.includes('repair_timing')), 'Tcl code blocks are carried whole');
  const tables = C.chunks.filter(c => c.sourceId.startsWith('orig-openroad') && /^\| Switch Name \| Description \|$/m.test(c.text));
  ok(tables.length > 3 && tables.every(c => c.text.split('\n').filter(l => l.startsWith('|')).length >= 3), 'split option tables each repeat their header row');
  ok(C.chunks.some(c => c.sourceId === 'orig-pmc4359000-head-2015' && /^\| Discipline \|/m.test(c.text)), 'JATS tables become Markdown tables');
  const io = C.sources.find(s => s.id === 'orig-pmc1182327-ioannidis-2005');
  ok(io.license === 'CC-BY (version unspecified)' && !/creativecommons/.test(io.licenseUrl) && C.sources.filter(s => s.id !== io.id && s.url.includes('10.1371')).every(s => s.license === 'CC-BY-4.0'), 'Ioannidis 2005 records CC BY without an inferred version; Head/Sandve keep their explicit 4.0');
  ok(C.sources.every(s => s.attribution.length <= imp.META_CHARS && s.title.length <= imp.META_CHARS), 'display metadata fits the runtime 500-character limit');
  {
    const v = await g.validateCorpusIndex(C);
    ok(v.sha256 === C.sha256 && v.sources === C.sources.length && v.chunks === C.chunks.length, 'runtime validateCorpusIndex accepts the actual generated index with the same canonical sha256');
    const long = structuredClone(C); long.sources[0].attribution = 'x'.repeat(501); long.sha256 = imp.indexSha256(long);
    await rejects(() => g.validateCorpusIndex(long), /attribution/, 'runtime rejects a 501-character attribution');
    const glued = structuredClone(C), gc = glued.chunks.find(c => /\n\n/.test(c.text));
    gc.text = gc.text.replace('\n\n', '\n\n\n'); gc.sha256 = sha(gc.text); glued.sha256 = imp.indexSha256(glued);
    await rejects(() => g.validateCorpusIndex(glued), /not an excerpt of its source/, 'runtime rejects a chunk whose separators differ from its source');
  }
  ok(C.sources.find(s => s.id === 'orig-pmc1182327-ioannidis-2005').text.includes('It can be proven that most claimed research findings are false'), 'Ioannidis original sentence present verbatim');

  // ── 2. offline --check with no key, and deterministic regeneration with no network ──
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools/import-cloudbite-corpus.mjs'), '--check'], { cwd: ROOT, env, encoding: 'utf8' });
  ok(out.includes(`sha256 ${C.sha256} OK`), 'CLI --check passes offline without OPENAI_API_KEY');
  {
    const c = copy();
    const r = await imp.run({ manifest: c.manifest, out: c.out, check: false, fetchImpl: noNetwork, key: 'unused', log: () => {} });
    ok(r.embedded === 0 && fs.readFileSync(c.out, 'utf8') === fs.readFileSync(GENERATED, 'utf8'), 'regeneration reuses every cached vector and is byte-identical');
  }

  // ── 3. rights rejection ──
  const first = (m) => m.sources[0];
  const pmcSrc = (m) => m.sources.find(s => s.format === 'jats-xml');
  const cases = [
    [m => { first(m).license = 'LicenseRef-Synopsys-PrimeTime-Manual'; }, /not an accepted redistribution license/, 'proprietary manual license'],
    [m => { pmcSrc(m).license = 'CC-BY-NC-4.0'; }, /not an accepted redistribution license/, 'non-commercial CC license'],
    [m => { first(m).rights = 'project-authored'; }, /rights must be "licensed"/, 'project-authored text'],
    [m => { pmcSrc(m).licenseEvidence = pmcSrc(m).licenseEvidence.filter(e => e.file !== pmcSrc(m).file); }, /license statement inside the original document|quotes the .* clause/, 'missing in-document license statement'],
    [m => { first(m).licenseEvidence[1].quote = 'Licensed under the Apache License, Version 2.0.'; }, /quote not found/, 'license quote absent from the document'],
    [m => { first(m).attribution = 'The OpenROAD Authors.'; }, /retain the copyright notice/, 'BSD attribution without copyright notice'],
    [m => { pmcSrc(m).attribution = 'Ioannidis 2005.'; }, /state the changes/, 'CC BY attribution without changes'],
    [m => { first(m).attribution = `Copyright (c) ${'x'.repeat(490)}`; }, /attribution must be a non-empty string of at most 500/, 'attribution over the runtime 500-character limit'],
    [m => { pmcSrc(m).license = 'CC-BY (version unspecified)'; pmcSrc(m).licenseEvidence.push({ url: 'https://example.org/policy', retrievedAt: '2026-10-19', quote: 'Creative Commons Attribution License' }); }, /pinned-file license evidence only/, 'unversioned CC BY on unpinned evidence'],
    [m => { pmcSrc(m).license = 'CC-BY (version unspecified)'; pmcSrc(m).licenseEvidence.push(m.sources.find(s => s.id === 'orig-pmc3812051-sandve-2013').licenseEvidence[2]); }, /no quote may name a license version/, 'unversioned CC BY quoting a version'],
    [m => { first(m).roles = ['cb-role-999']; }, /roles must be/, 'unknown role'],
    [m => { first(m).id = 'rsz'; }, /orig- prefix/, 'source id without orig- prefix'],
    [m => { m.sources[1].id = m.sources[0].id; }, /duplicated/, 'duplicate source id'],
  ];
  for (const [edit, re, what] of cases) { const c = copy(edit); await rejects(() => imp.buildCorpus(c.manifest), re, `rejects ${what}`); }

  // ── 4. hash tamper ──
  {
    const c = copy((m, dir) => { const f = path.join(dir, first(m).file); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Gate Resizer', 'Gate Resizer!')); });
    await rejects(() => imp.buildCorpus(c.manifest), /sha256 mismatch/, 'tampered original file');
    const d = copy(m => { pmcSrc(m).textSha256 = '0'.repeat(64); });
    await rejects(() => imp.buildCorpus(d.manifest), /derived text sha256/, 'drifted derived text');
    const e = copy((m, dir) => { const f = path.join(dir, 'sources/openroad/LICENSE'); fs.appendFileSync(f, '\nextra'); });
    await rejects(() => imp.buildCorpus(e.manifest), /sha256 mismatch/, 'tampered license proof file');
    const { sources, chunks } = await imp.buildCorpus(path.join(CORPUS_DIR, 'manifest.json'));
    const gen = imp.parseGenerated(GENERATED);
    const vec = structuredClone(gen); vec.index.chunks[3].vector[7] += 0.01; vec.index.sha256 = imp.indexSha256(vec.index);
    assert.throws(() => imp.verifyGenerated(vec, sources, chunks), /vector binding/); checks++;
    const txt = structuredClone(gen); txt.index.chunks[5].text += ' invented'; txt.index.chunks[5].sha256 = sha(txt.index.chunks[5].text); txt.index.sha256 = imp.indexSha256(txt.index);
    assert.throws(() => imp.verifyGenerated(txt, sources, chunks), /differs from the derived chunk/); checks++;
    const ix = structuredClone(gen); ix.index.sources[0].title += ' (edited)';
    assert.throws(() => imp.verifyGenerated(ix, sources, chunks), /index sha256/); checks++;
    const far = structuredClone(gen), fc = far.index.chunks.find(c => /\n\n/.test(c.text));
    fc.text = fc.text.replace('\n\n', '\n'); fc.sha256 = sha(fc.text); far.embeddings.bindings[fc.id] = imp.vectorBinding(fc.sha256, fc.vector); far.index.sha256 = imp.indexSha256(far.index);
    assert.throws(() => imp.verifyGenerated(far, sources, chunks), /differs from the derived chunk|not an exact excerpt/); checks++;
    const meta = structuredClone(gen); meta.index.sources[0].attribution = 'x'.repeat(501); meta.index.sha256 = imp.indexSha256(meta.index);
    assert.throws(() => imp.verifyGenerated(meta, sources.map((s, k) => k ? s : { ...s, attribution: 'x'.repeat(501) }), chunks), /exceeds 500 characters/); checks++;
    // --check on a generated file whose chunk is rebound to non-contiguous text
    const h = copy(); fs.writeFileSync(h.out, imp.render(far.index, far.embeddings));
    await rejects(() => imp.run({ manifest: h.manifest, out: h.out, check: true }), /differs from the derived chunk|not an exact excerpt/, '--check rejects a rebound non-contiguous chunk');
    // the vector cache never reuses a vector whose cached chunk is not an exact excerpt of its cached source
    const k = copy(), cached = structuredClone(gen), kc = cached.index.chunks[0], ks = cached.index.sources.find(s => s.id === kc.sourceId);
    ks.text = ks.text.replace(kc.text, ''); ks.sha256 = sha(ks.text); cached.index.sha256 = imp.indexSha256(cached.index);
    fs.writeFileSync(k.out, imp.render(cached.index, cached.embeddings));
    const sent = [], stub = async (url, init) => { const body = JSON.parse(init.body); sent.push(...body.input); return { ok: true, status: 200, json: async () => ({ data: body.input.map((_, i) => ({ index: i, embedding: kc.vector })), usage: { prompt_tokens: 1, total_tokens: 1 } }) }; };
    const kr = await imp.run({ manifest: k.manifest, out: k.out, check: false, fetchImpl: stub, key: 'k', log: () => {} });
    ok(kr.embedded === 1 && sent.length === 1 && sent[0] === kc.text, 'cache rejects a vector whose chunk is not an excerpt of its cached source');
    // exact-span recovery: only blank-line separators may differ, from exactly one bounded contiguous source span
    ok(imp.exactSpan('a\nb\n```\nc\n', 'b\n```\n\nc', 'x') === 'b\n```\nc', 'separator-normalized chunk resolves to the exact original span');
    assert.throws(() => imp.exactSpan('one\ntwo\nthree\n', 'one\nthree', 'x'), /not an exact contiguous span/); checks++;
    assert.throws(() => imp.exactSpan('a b\nc\n', 'a\nb', 'x'), /not an exact contiguous span/); checks++;
    assert.throws(() => imp.exactSpan('p\nq\n\np\n\nq', 'p\n\n\nq', 'x'), /2 newline-normalized matches/); checks++;
    assert.throws(() => imp.exactSpan(`a\n${'\n'.repeat(30)}b`, 'a\nb', 'x', 20), /bytes > 20/); checks++;
    const f = copy(); fs.writeFileSync(f.out, fs.readFileSync(f.out, 'utf8').replace('"dimensions": 256', '"dimensions": 512'));
    await rejects(() => imp.run({ manifest: f.manifest, out: f.out, check: true }), /model\/dimensions|provenance mismatch/, '--check rejects changed dimensions');
  }

  // ── 5. path containment ──
  for (const [p, what] of [['../manifest.json', 'parent escape'], ['sources/../../x.md', 'nested escape'], ['C:/Windows/win.ini', 'drive path'], ['/etc/passwd', 'absolute path'], ['sources\\openroad\\LICENSE', 'backslash path']]) {
    const c = copy(m => { first(m).file = p; });
    await rejects(() => imp.buildCorpus(c.manifest), /relative forward-slash path|escapes/, `rejects ${what}`);
  }
  {
    let linked = false;
    const c = copy((m, dir) => { try { fs.symlinkSync(path.join(ROOT, 'package.json'), path.join(dir, 'sources/link.md'), 'file'); first(m).file = 'sources/link.md'; linked = true; } catch {} });
    if (linked) await rejects(() => imp.buildCorpus(c.manifest), /not a link/, 'rejects a symlinked source');
  }

  // ── 6. structure: unclosed/unsupported input fails explicitly; tables split without cutting rows ──
  assert.throws(() => imp.parseXml('<article><front></article>'), /does not match/); checks++;
  assert.throws(() => imp.parseXml('<article><body>'), /unclosed element <body>/); checks++;
  assert.throws(() => imp.parseXml('<!DOCTYPE a [<!ENTITY x "y">]><article/>'), /internal subsets/); checks++;
  assert.throws(() => imp.parseXml('<article>&custom;</article>'), /unknown entity/); checks++;
  const jats = (body) => `<article><front><article-meta><title-group><article-title>T</article-title></title-group><permissions><license><license-p>CC BY</license-p></license></permissions></article-meta></front><body>${body}</body></article>`;
  assert.throws(() => imp.jatsToMarkdown(jats('<sec><title>A</title><mystery>text</mystery></sec>')), /unsupported JATS block element <mystery>/); checks++;
  ok(imp.jatsToMarkdown(jats('<sec><title>A</title><p>One. Two <italic>x</italic>.</p><sec><title>B</title><p>Three.</p></sec></sec>')) === '# T\n\nCC BY\n\n## A\n\nOne.\nTwo *x*.\n\n### B\n\nThree.\n', 'JATS sections become nested headings, one sentence per line');
  assert.throws(() => imp.splitMarkdownTables('# A\n\n```tcl\nopen', 2500), /unclosed code fence/); checks++;
  {
    const c = copy((m, dir) => { const f = path.join(dir, first(m).file); fs.appendFileSync(f, '\n```tcl\nrepair_timing\n'); rehash(first(m), fs.readFileSync(f)); });
    await rejects(() => imp.buildCorpus(c.manifest), /unclosed code fence/, 'importer rejects an unclosed fence in a source');
  }
  const rows = Array.from({ length: 60 }, (_, i) => `| -opt${i} | ${'description '.repeat(4)}${i} |`);
  const split = imp.splitMarkdownTables(`| Switch | Description |\n| --- | --- |\n${rows.join('\n')}`, 600);
  const parts = split.split('\n\n');
  ok(parts.length > 1 && parts.every(p => p.startsWith('| Switch | Description |\n| --- | --- |\n') && Buffer.byteLength(p) <= 600) && parts.flatMap(p => p.split('\n').slice(2)).join('\n') === rows.join('\n'), 'oversized table splits into header-repeating tables with every row intact');

  // ── 7. embeddings request shape, one attempt, nothing secret in errors ──
  {
    const calls = [];
    const fake = async (url, init) => { calls.push({ url, init }); const body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ model: 'text-embedding-3-small', data: body.input.map((_, i) => ({ index: i, embedding: Array.from({ length: 256 }, (_, j) => Math.sin(i + j) / 16) })), usage: { prompt_tokens: 5, total_tokens: 5 } }) }; };
    const r = await imp.embed(['a', 'b'], { fetchImpl: fake, key: 'sk-test-SECRET' });
    const body = JSON.parse(calls[0].init.body);
    ok(calls.length === 1 && calls[0].url === 'https://api.openai.com/v1/embeddings' && calls[0].init.headers.authorization === 'Bearer sk-test-SECRET'
      && body.model === 'text-embedding-3-small' && body.dimensions === 256 && body.encoding_format === 'float' && r.vectors.length === 2 && r.vectors[0].length === 256, 'request: fixed endpoint, model, 256 dimensions, float encoding');
    await rejects(() => imp.embed(Array(17).fill('x'), { fetchImpl: fake, key: 'k' }), /1-16 inputs/, 'batches are at most 16');
    let attempts = 0;
    const failing = async () => { attempts++; return { ok: false, status: 500, json: async () => ({ error: 'sk-test-SECRET leaked body' }) }; };
    await assert.rejects(() => imp.embed(['a'], { fetchImpl: failing, key: 'sk-test-SECRET' }), e => attempts === 1 && e.message === 'embeddings request failed: HTTP 500' && !e.message.includes('SECRET')); checks++;
    const thrown = async () => { throw new Error('connect failed sk-test-SECRET'); };
    await assert.rejects(() => imp.embed(['a'], { fetchImpl: thrown, key: 'sk-test-SECRET' }), e => !e.message.includes('SECRET')); checks++;
    const short = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }) });
    await rejects(() => imp.embed(['a'], { fetchImpl: short, key: 'k' }), /finite 256-dimension/, 'wrong-dimension response rejected');
    await rejects(() => imp.embed(['a'], { fetchImpl: fake, key: '' }), /OPENAI_API_KEY is not set/, 'no key, no call');
    // a changed chunk is the only one sent for embedding
    const c = copy((m, dir) => { const f = path.join(dir, first(m).file); fs.appendFileSync(f, '\n## Appendix\n\nOne more original line.\n'); rehash(first(m), fs.readFileSync(f)); });
    const mm = JSON.parse(fs.readFileSync(c.manifest, 'utf8'));
    const { sources: s2 } = imp.loadManifest(c.manifest);
    mm.sources[0].textSha256 = sha(imp.sourceText(s2[0])); fs.writeFileSync(c.manifest, JSON.stringify(mm));
    calls.length = 0;
    const rr = await imp.run({ manifest: c.manifest, out: c.out, check: false, fetchImpl: fake, key: 'k', log: () => {} });
    ok(rr.embedded === 1 && calls.length === 1 && JSON.parse(calls[0].init.body).input.join() === 'One more original line.', 'only the new chunk is embedded');
  }
  console.log(`cloudbite-v8-corpus: ${checks} checks passed (${C.sources.length} sources, ${C.chunks.length} chunks, index ${C.sha256.slice(0, 12)})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
