// Integrity of held-out project-team routing fixtures against the real catalogue. Authored expectations only: no provider calls, no scoring.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
const load = async contents => {
 const b = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
 return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
};
const m = await load("export {CLOUDBITE_EXPERTS} from './src/cloudbite-personas.ts';export {CLOUDBITE_POOL} from './src/cloudbite-pool.ts'");
const FIXTURE = 'test/fixtures/cloudbite-routing-projects.json';
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const cases = fixture.cases;
const experts = new Map(m.CLOUDBITE_EXPERTS.map(e => [e.id, e]));
const category = new Map(m.CLOUDBITE_POOL.entries.map(e => [e.expertId, e.category]));
// Perspective IDs fixed by the project-team/v1 shared contract (SPEC); labels may be refined, IDs may not.
const PERSPECTIVE_IDS = ['architecture', 'implementation', 'validation', 'performance', 'security', 'privacy', 'user-value',
 'commercial', 'finance', 'delivery', 'assumptions', 'decision', 'regulatory', 'operability'];
const REQUIRED_COVERAGE = ['eda-tapeout-ko', 'sta-finite-answer', 'sta-project-advice', 'b2b-launch', 'security-privacy', 'frontend-accessibility',
 'physical-sta-rtl-distinct', 'thin-brief', 'cross-tenant-isolation', 'portfolio-broad', 'no-relevant-role', 'redundant-meta-review', 'prompt-injection'];
const OPTIONAL_COVERAGE = ['regulated-domain'];
const OUTCOMES = ['team', 'narrow-team', 'clarify', 'no-team'];
const WARNINGS = ['uncovered-perspectives', 'actor-limit'];
const CASE_KEYS = ['id', 'covers', 'brief', 'expectedOutcome', 'expectedPerspectives', 'candidateExpertIds', 'overlapGroups', 'rationale',
 'expectedWarnings', 'finiteAnswer', 'injectedExpertId'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok ' + name); };
const unique = (list, label) => assert.equal(new Set(list).size, list.length, label + ' must be unique');
const text = (v, min, max, label) => { assert.equal(typeof v, 'string', label); assert.ok(v.trim().length >= min && v.length <= max, label + ` must be ${min}-${max} characters`); };

await test('fixture is declared as authored expectations, not observed model results', () => {
 assert.deepEqual(Object.keys(fixture).sort(), ['cases', 'harnessVersion', 'kind', 'notice', 'schemaVersion']);
 assert.equal(fixture.schemaVersion, 1); assert.equal(fixture.kind, 'authored-expectations'); assert.equal(fixture.harnessVersion, 'project-team/v1');
 assert.match(fixture.notice, /NOT scored or observed model results/);
 const raw = readFileSync(FIXTURE, 'utf8');
 for (const k of ['"relevance"', '"needs"', '"coverage"', '"probabilities"', '"confidence"', '"answers"', '"passed"', '"score"']) assert.ok(!raw.includes(k), 'no provider-shaped result field ' + k);
});
await test('12-16 held-out cases with unique bounded ids and exact keys', () => {
 assert.ok(Array.isArray(cases) && cases.length >= 12 && cases.length <= 16);
 unique(cases.map(c => c.id), 'case ids');
 for (const c of cases) {
  assert.ok(ID.test(c.id) && c.id.length <= 64 && c.id.startsWith('heldout-'), c.id);
  for (const k of Object.keys(c)) assert.ok(CASE_KEYS.includes(k), `${c.id}: unknown key ${k}`);
  for (const k of CASE_KEYS.slice(0, 8)) assert.ok(k in c, `${c.id}: missing ${k}`);
 }
 unique(cases.map(c => c.brief.title), 'brief titles'); unique(cases.map(c => c.brief.objective), 'brief objectives');
});
await test('briefs satisfy the routing query bounds (title 120 no control, objective 2000, context 8000)', () => {
 for (const c of cases) {
  assert.deepEqual(Object.keys(c.brief).sort(), ['context', 'objective', 'title'], c.id);
  text(c.brief.title, 1, 120, c.id + ' title'); assert.ok(!CONTROL.test(c.brief.title), c.id + ' title control');
  text(c.brief.objective, 1, 2000, c.id + ' objective');
  assert.equal(typeof c.brief.context, 'string'); assert.ok(c.brief.context.length <= 8000, c.id + ' context');
  text(c.rationale, 20, 600, c.id + ' rationale');
 }
});
await test('every required scenario is covered and coverage tags are known', () => {
 const seen = new Set();
 for (const c of cases) {
  assert.ok(Array.isArray(c.covers) && c.covers.length >= 1); unique(c.covers, c.id + ' covers');
  for (const t of c.covers) { assert.ok(REQUIRED_COVERAGE.includes(t) || OPTIONAL_COVERAGE.includes(t), `${c.id}: unknown tag ${t}`); seen.add(t); }
 }
 for (const t of REQUIRED_COVERAGE) assert.ok(seen.has(t), 'missing coverage ' + t);
 const ko = cases.find(c => c.covers.includes('eda-tapeout-ko'));
 assert.match(ko.brief.title + ko.brief.objective + ko.brief.context, /[가-힣]/, 'Korean EDA brief');
});
await test('expected perspectives are known contract IDs and outcomes are consistent', () => {
 for (const c of cases) {
  assert.ok(OUTCOMES.includes(c.expectedOutcome), c.id);
  assert.ok(Array.isArray(c.expectedPerspectives)); unique(c.expectedPerspectives, c.id + ' perspectives');
  for (const p of c.expectedPerspectives) assert.ok(PERSPECTIVE_IDS.includes(p), `${c.id}: unknown perspective ${p}`);
  if (c.expectedWarnings !== undefined) { assert.ok(c.expectedWarnings.length >= 1); unique(c.expectedWarnings, c.id); for (const w of c.expectedWarnings) assert.ok(WARNINGS.includes(w), `${c.id}: ${w}`); }
  if (c.expectedOutcome === 'clarify' || c.expectedOutcome === 'no-team') {
   assert.equal(c.expectedPerspectives.length, 0, c.id); assert.equal(c.candidateExpertIds.length, 0, c.id); assert.equal(c.overlapGroups.length, 0, c.id);
  } else {
   assert.ok(c.expectedPerspectives.length >= 1 && c.candidateExpertIds.length >= 1, c.id);
  }
  if (c.expectedOutcome === 'narrow-team') assert.ok(c.candidateExpertIds.length <= 6, c.id + ' narrow');
 }
 const broad = cases.find(c => c.covers.includes('portfolio-broad'));
 assert.deepEqual([...broad.expectedPerspectives].sort(), [...PERSPECTIVE_IDS].sort(), 'broad case needs every perspective');
 assert.ok(broad.candidateExpertIds.length >= 15);
 const finite = cases.find(c => c.covers.includes('sta-finite-answer')), advice = cases.find(c => c.covers.includes('sta-project-advice'));
 assert.equal(finite.expectedOutcome, 'narrow-team'); assert.equal(typeof finite.finiteAnswer, 'string'); assert.equal(advice.expectedOutcome, 'team');
 assert.ok(finite.expectedPerspectives.length < advice.expectedPerspectives.length && finite.candidateExpertIds.length < advice.candidateExpertIds.length);
 assert.equal(cases.filter(c => 'finiteAnswer' in c).length, 1);
});
await test('every referenced expert ID exists in the current real catalogue with a pool category', () => {
 assert.equal(experts.size, 100);
 for (const c of cases) {
  unique(c.candidateExpertIds, c.id + ' candidates'); assert.ok(c.candidateExpertIds.length <= 100);
  for (const id of c.candidateExpertIds) { assert.ok(experts.has(id), `${c.id}: unknown expert ${id}`); assert.ok(category.get(id), `${c.id}: no category ${id}`); }
 }
 for (const id of ['probably-primetime-sta', 'cb-role-072', 'cb-role-075', 'cb-role-076']) assert.equal(category.get(id), 'semiconductor', id);
});
await test('overlap groups reference same-category candidates with bounded rationale', () => {
 for (const c of cases) for (const g of c.overlapGroups) {
  assert.deepEqual(Object.keys(g).sort(), ['expectation', 'expertIds', 'rationale'], c.id);
  assert.ok(['distinct-keep', 'possible-redundant'].includes(g.expectation), c.id);
  assert.ok(g.expertIds.length >= 2 && g.expertIds.length <= 7, c.id); unique(g.expertIds, c.id + ' group');
  for (const id of g.expertIds) assert.ok(c.candidateExpertIds.includes(id), `${c.id}: group member ${id} not a candidate`);
  assert.equal(new Set(g.expertIds.map(id => category.get(id))).size, 1, `${c.id}: overlap probes are within one category`);
  text(g.rationale, 20, 400, c.id + ' group rationale');
 }
 const distinct = cases.find(c => c.covers.includes('physical-sta-rtl-distinct'));
 const g = distinct.overlapGroups.find(x => x.expertIds.includes('probably-primetime-sta'));
 assert.equal(g.expectation, 'distinct-keep');
 for (const id of ['cb-role-072', 'cb-role-076', 'probably-primetime-sta']) assert.ok(g.expertIds.includes(id));
 const meta = cases.find(c => c.covers.includes('redundant-meta-review'));
 assert.ok(meta.overlapGroups.some(x => x.expectation === 'possible-redundant'));
 assert.ok(meta.overlapGroups.some(x => x.expectation === 'distinct-keep'));
 assert.ok(meta.candidateExpertIds.every(id => category.get(id) === 'review' || id === 'cb-role-038' || id === 'agency-specialized-pricing-analyst'));
});
await test('prompt injection case targets an invented ID that the catalogue does not contain', () => {
 const c = cases.find(x => x.covers.includes('prompt-injection'));
 assert.equal(typeof c.injectedExpertId, 'string'); assert.ok(!experts.has(c.injectedExpertId));
 assert.ok(c.brief.context.includes(c.injectedExpertId)); assert.ok(!c.candidateExpertIds.includes(c.injectedExpertId));
 assert.equal(c.expectedOutcome, 'narrow-team');
 assert.equal(cases.filter(x => 'injectedExpertId' in x).length, 1);
});
await test('no-relevant-role and thin-brief do not fabricate a fallback team', () => {
 assert.equal(cases.find(c => c.covers.includes('no-relevant-role')).expectedOutcome, 'no-team');
 assert.equal(cases.find(c => c.covers.includes('thin-brief')).expectedOutcome, 'clarify');
});
await test('held-out fixture data is not imported into production sources', () => {
 const markers = ['cloudbite-routing-projects', ...cases.map(c => c.id)];
 const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
 const files = ['src', 'client', 'tools'].filter(d => existsSync(d)).flatMap(walk).filter(p => /\.(?:ts|tsx|js|mjs|json|html)$/.test(p));
 assert.ok(files.length > 0);
 for (const f of files) { const s = readFileSync(f, 'utf8'); for (const k of markers) assert.ok(!s.includes(k), `${f} references held-out fixture ${k}`); }
});
// Optional drift check: only when the coordinator's engine exists in this tree. Absence is a skip, not a pass.
if (existsSync('src/cloudbite-routing-harness.ts')) {
 await test('fixture perspective IDs are a subset of the engine PERSPECTIVES', async () => {
  const h = await load("export {PERSPECTIVES} from './src/cloudbite-routing-harness.ts'");
  const ids = new Set(h.PERSPECTIVES.map(p => p.id));
  for (const id of PERSPECTIVE_IDS) assert.ok(ids.has(id), 'engine lacks perspective ' + id);
 });
} else console.log('skip engine PERSPECTIVES drift check: src/cloudbite-routing-harness.ts not present');
console.log(`cloudbite routing fixtures: ${passed} passed`);
