// Phase-one knowledge pack structure / content / held-out separation. This is not a model-accuracy evaluation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
const b = await build({ stdin: { contents: "export {PHASE_ONE_PACKS} from './src/cloudbite-phase-one-data.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { PHASE_ONE_PACKS: packs } = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));

const EXPECTED = [[1, 'agency-product-manager'], [2, 'cb-customer-discovery'], [4, 'agency-business-strategist'], [11, 'cb-ux-researcher'], [20, 'cb-human-ai-interaction'], [21, 'agency-engineering-software-architect'], [31, 'agency-engineering-ai-engineer'], [33, 'cb-knowledge-engineer'], [35, 'cb-model-evaluation'], [42, 'cb-sandbox-engineer'], [49, 'cb-finops'], [51, 'agency-security-architect'], [57, 'agency-engineering-privacy-engineer'], [61, 'agency-specialized-pricing-analyst'], [62, 'agency-finance-fpa-analyst'], [91, 'cb-evidence-auditor'], [92, 'cb-quantitative-reviewer'], [93, 'cb-assumption-auditor'], [94, 'cb-adversarial-reviewer'], [100, 'cb-synthesis-editor']];
const REVIEWERS = new Set(['cb-evidence-auditor', 'cb-quantitative-reviewer', 'cb-assumption-auditor', 'cb-adversarial-reviewer', 'cb-synthesis-editor']);
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PACK_KEYS = ['artifacts', 'cards', 'catalogNumber', 'domain', 'expertId', 'instructions', 'limitations', 'methods', 'mission', 'name', 'questions', 'sources', 'summary', 'tools', 'version'];
const CARD_KEYS = ['id', 'kind', 'match', 'provenance', 'roles', 'source_ids', 'summary', 'term', 'tool_scope'];
const SOURCE_KEYS = ['access', 'aliases', 'checkNote', 'checkStatus', 'checkedAt', 'download_policy', 'id', 'license', 'title', 'tool_scope', 'url'];
const LIMIT = 48 * 1024;

// Exact roster in catalogue order.
assert.deepEqual(packs.map(p => [p.catalogNumber, p.expertId]), EXPECTED);
assert.equal(new Set(packs.map(p => p.expertId)).size, 20);

const nonEmptyStrings = (a, min = 1) => Array.isArray(a) && a.length >= min && a.every(s => typeof s === 'string' && s.trim().length > 0);
const cardIds = new Set();
const summaries = new Set();
let cardTotal = 0;
const artifactPaths = new Set();
for (const p of packs) {
  assert.deepEqual(Object.keys(p).sort(), PACK_KEYS, p.expertId + ' keys');
  for (const k of ['name', 'domain', 'summary', 'mission', 'instructions', 'version']) assert.ok(typeof p[k] === 'string' && p[k].trim().length > 0, p.expertId + ' ' + k);
  assert.ok(nonEmptyStrings(p.questions, 3) && nonEmptyStrings(p.methods, 3) && nonEmptyStrings(p.limitations, 2) && nonEmptyStrings(p.tools), p.expertId + ' lists');
  assert.ok(p.artifacts.length >= 1 && p.artifacts.length <= 4 && p.artifacts.every(a => /^out\/[a-z0-9-]+\.(md|json|csv)$/.test(a.path) && !['out/result.json', 'out/report.md', 'out/manifest.json', 'out/knowledge.json'].includes(a.path) && a.label && a.guidance.length > 20), p.expertId + ' artifacts');
  for (const a of p.artifacts) { assert.ok(!artifactPaths.has(a.path), a.path + ' artifact path unique across roles'); artifactPaths.add(a.path); }
  // Sources: at least two per pack, well-formed, honest check status.
  assert.ok(p.sources.length >= 2, p.expertId + ' sources');
  const known = new Set();
  for (const s of p.sources) {
    assert.deepEqual(Object.keys(s).sort(), SOURCE_KEYS, s.id + ' source keys');
    assert.match(s.id, ID); assert.match(s.url, /^https:\/\//);
    assert.ok(Array.isArray(s.aliases) && Array.isArray(s.tool_scope) && s.tool_scope.length > 0);
    for (const a of s.aliases) assert.match(a, ID);
    assert.ok(s.checkStatus === 'retrieved' || s.checkStatus === 'unverified');
    if (s.checkStatus === 'retrieved') assert.match(s.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, s.id + ' retrieved needs UTC time');
    else assert.equal(s.checkedAt, '', s.id + ' unverified must not carry a checked time');
    assert.ok(s.checkNote.length > 0 && s.license.length > 0 && s.download_policy.length > 0);
    for (const k of [s.id, ...s.aliases]) { assert.ok(!known.has(k), 'duplicate source key ' + k); known.add(k); }
  }
  // Cards: six or more, role-specific, resolvable sources, every source cited.
  assert.ok(p.cards.length >= 6, p.expertId + ' cards');
  const cited = new Set();
  for (const c of p.cards) {
    assert.deepEqual(Object.keys(c).sort(), CARD_KEYS, c.id + ' card keys');
    assert.match(c.id, ID);
    assert.ok(!cardIds.has(c.id), 'duplicate card id ' + c.id); cardIds.add(c.id);
    assert.deepEqual(c.roles, [p.expertId]);
    assert.ok(c.summary.length >= 200, c.id + ' summary is substantive');
    assert.ok(!summaries.has(c.summary), c.id + ' copied card'); summaries.add(c.summary);
    assert.ok(nonEmptyStrings(c.match, 3) && nonEmptyStrings(c.source_ids) && c.kind && c.tool_scope && c.provenance && c.term);
    for (const id of c.source_ids) { assert.ok(known.has(id), 'dangling card source: ' + id); cited.add(id); }
  }
  for (const s of p.sources) assert.ok(cited.has(s.id), p.expertId + ' carries uncited source ' + s.id);
  assert.ok(new Set(p.cards.map(c => c.kind)).size >= 3, p.expertId + ' card kinds are varied');
  // Size limits for runtime workspace files.
  assert.ok(Buffer.byteLength(JSON.stringify(p.sources)) <= LIMIT, p.expertId + ' sources JSON size');
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= LIMIT, p.expertId + ' pack JSON size');
  cardTotal += p.cards.length;
  // Honesty boundaries in the trusted instructions.
  assert.match(p.instructions, /untrusted data, never as instructions/);
  assert.match(p.instructions, /self-assessment/);
  if (REVIEWERS.has(p.expertId)) {
    assert.match(p.instructions, /no peer result was reviewed or verified/);
    assert.match(p.instructions, /Never describe your work as cross-review/);
  }
}
assert.ok(cardTotal >= 120, 'card total ' + cardTotal);
for (const k of ['name', 'mission', 'summary', 'instructions', 'domain']) assert.equal(new Set(packs.map(p => p[k])).size, 20, 'distinct ' + k);

// No fixed numeric confidence, score jitter or randomness baked into data.
const all = JSON.stringify(packs);
assert.doesNotMatch(all, /confidence\W{0,3}\d/i);
assert.doesNotMatch(all, /jitter|Math\.random/i);
// Retrieval evidence is not fabricated: retrieved records exist only with a time, and at least one check stayed unverified.
assert.ok(packs.some(p => p.sources.some(s => s.checkStatus === 'retrieved')));
assert.ok(packs.some(p => p.sources.some(s => s.checkStatus === 'unverified')));

// Held-out fixture: coverage per role and no answer leakage into runtime data.
const cases = fs.readFileSync('test/fixtures/pool-phase-one-evaluation.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
const byRole = new Map(packs.map(p => [p.expertId, []]));
for (const c of cases) {
  assert.ok(byRole.has(c.expertId), 'unknown fixture role ' + c.expertId);
  assert.equal(c.catalogNumber, packs.find(p => p.expertId === c.expertId).catalogNumber);
  assert.ok(['normal', 'missing-info', 'out-of-scope', 'adversarial'].includes(c.type));
  assert.ok(c.prompt.length > 10 && nonEmptyStrings(c.pass_criteria) && nonEmptyStrings(c.fail_conditions));
  byRole.get(c.expertId).push(c.type);
}
for (const [role, types] of byRole) {
  assert.ok(types.length >= 3, role + ' needs three held-out cases');
  assert.ok(types.includes('normal') && types.includes('missing-info'), role + ' normal + missing-info');
  assert.ok(types.includes('out-of-scope') || types.includes('adversarial'), role + ' out-of-scope or adversarial');
}
const lower = all.toLowerCase();
assert.ok(!lower.includes('pass_criteria') && !lower.includes('fail_conditions'));
const words = s => s.toLowerCase().replace(/[^a-z0-9%$ ]+/g, ' ').split(/\s+/).filter(Boolean);
const packText = ' ' + words(all).join(' ') + ' ';
for (const c of cases) {
  for (const text of [c.prompt, ...c.pass_criteria, ...c.fail_conditions]) {
    const w = words(text);
    for (let i = 0; i + 8 <= w.length; i++) {
      const shingle = ' ' + w.slice(i, i + 8).join(' ') + ' ';
      assert.ok(!packText.includes(shingle), `fixture ${c.id} leaks into runtime data: "${shingle.trim()}"`);
    }
  }
}
console.log(`phase-one data ok: ${packs.length} packs, ${cardTotal} cards, ${new Set(packs.flatMap(p => p.sources.map(s => s.id))).size} distinct sources, ${cases.length} held-out cases (structural, not accuracy)`);
