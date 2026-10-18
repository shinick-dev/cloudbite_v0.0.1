// The planning catalogue (released 100 + research roles 101–120): built from the authoritative runtime catalogue, bounded and frozen.
// Roles 101–120 are 'available' only once a deployment registers cb-role-101..120; until then they are 'planned'.
// A catalogue entry is not a runnable expert; this is a structural test, not an expertise evaluation.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const out = await build({ stdin: { contents: "export * from './src/cloudbite-pool.ts'; export { CLOUDBITE_EXPERTS, findExpert, validateProjectBrief, CLOUDBITE_BRIEF_LIMITS } from './src/cloudbite-personas.ts'; export { validateBrief, isInvalid } from './src/cloudbite-validate.ts'; export * from './src/cloudbite-catalogue-limits.ts'; export { CB_MAX_EXPERTS } from './src/cloudbite-config.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { CLOUDBITE_POOL: pool, POOL_LIMITS, PRIORITY_NUMBERS, CLOUDBITE_EXPERTS, findExpert } = m;
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };

ok(Object.isFrozen(pool) && Object.isFrozen(pool.entries) && Object.isFrozen(pool.entries[0]) && Object.isFrozen(pool.entries[0].keywords), 'pool is deeply frozen');
ok(pool.entries.length === 120 && pool.entries.length <= POOL_LIMITS.entries, '120 planned catalogue entries');
ok(POOL_LIMITS.entries === m.CATALOGUE_MAX_ROLES && m.CATALOGUE_MAX_ROLES === 200, 'catalogue bound is 200');
ok(m.PROJECT_MAX_EXPERTS === 100 && m.CB_MAX_EXPERTS === m.PROJECT_MAX_EXPERTS, 'project selection bound stays 100 and matches the runtime config');
ok(pool.version !== 'expert-pool-100/2026-10-19', 'catalogue version changed');
assert.deepEqual(pool.entries.map(e => e.catalogNumber), Array.from({ length: 120 }, (_, i) => i + 1)); checks++;
assert.deepEqual(pool.entries.map(e => e.id), Array.from({ length: 120 }, (_, i) => `pool-${String(i + 1).padStart(3, '0')}`)); checks++;
ok(new Set(pool.entries.map(e => e.name)).size === 120, 'plan names are unique');
assert.deepEqual(pool.priorityNumbers, [1, 2, 4, 11, 20, 21, 31, 33, 35, 42, 49, 51, 57, 61, 62, 91, 92, 93, 94, 100]); checks++;
assert.deepEqual(pool.priorityNumbers, [...PRIORITY_NUMBERS]); checks++;

const keys = ['availability', 'catalogNumber', 'category', 'categoryLabel', 'domain', 'evaluation', 'id', 'keywords', 'knowledge', 'mission', 'name', 'priority'];
for (const e of pool.entries) {
  const own = Object.keys(e).filter(k => k !== 'expertId' && k !== 'mappingNote').sort();
  assert.deepEqual(own, keys, `${e.id} keys`); checks++;
  ok(e.evaluation === 'unvalidated', `${e.id} is unvalidated`);
  ok(e.name.length <= POOL_LIMITS.name && e.mission.length <= POOL_LIMITS.mission && e.mission.length > 0 && (e.mappingNote ?? '').length <= POOL_LIMITS.note, `${e.id} text is bounded`);
  ok(e.keywords.length >= 1 && e.keywords.length <= POOL_LIMITS.keywords && e.keywords.every(k => k.length <= POOL_LIMITS.keyword && k === k.toLowerCase()), `${e.id} keywords bounded and normalised`);
  ok(typeof e.categoryLabel.ko === 'string' && typeof e.categoryLabel.en === 'string' && e.categoryLabel.ko && e.categoryLabel.en, `${e.id} has KO/EN category labels`);
  if (e.catalogNumber <= 100) ok(e.category === pool.entries[Math.floor((e.catalogNumber - 1) / 10) * 10].category, `${e.id} category follows the plan's groups of ten`);
  ok(e.priority === pool.priorityNumbers.includes(e.catalogNumber), `${e.id} priority flag`);
  const expert = e.expertId ? findExpert(e.expertId) : undefined;
  if (e.availability === 'available') {
    ok(expert && expert.id === e.expertId && e.knowledge === expert.source.basis && e.domain === expert.domain, `${e.id} maps to an actual runnable expert and its real knowledge basis`);
  } else {
    ok(e.availability === 'planned' && !('expertId' in e) && e.knowledge === 'none', `${e.id} planned entry carries no runtime id`);
  }
  ok(!findExpert(e.id), `${e.id} is never a runtime expert id`);
}
const released = pool.entries.slice(0, 100), research = pool.entries.slice(100);
ok(new Set(released.map(e => e.category)).size === 10, 'ten original plan categories');
assert.deepEqual([...new Set(research.map(e => e.category))].sort(), ['biomedical-research', 'chemistry', 'clinical-medicine', 'pharmaceutical-science']); checks++;
ok(research.every(e => !released.some(r => r.category === e.category)), 'research roles use new categories, original ten untouched');
const RESEARCH = { 101: ['Biomedical Research Methodologist', 'biomedical-research'], 102: ['Clinical Evidence Reviewer', 'clinical-medicine'], 103: ['Clinical Trial Methodologist', 'clinical-medicine'],
  104: ['Epidemiologist', 'clinical-medicine'], 105: ['Biomedical Biostatistician', 'biomedical-research'], 106: ['Systematic Review & Meta-analysis Specialist', 'clinical-medicine'],
  107: ['Pharmacology & Pharmacokinetics Scientist', 'pharmaceutical-science'], 108: ['Medicinal Chemist', 'chemistry'], 109: ['Analytical Chemist', 'chemistry'],
  110: ['Chemical Identity & Structure Reviewer', 'chemistry'], 111: ['Molecular & Cell Biologist', 'biomedical-research'], 112: ['Biochemist', 'biomedical-research'],
  113: ['Genomics & Bioinformatics Reviewer', 'biomedical-research'], 114: ['Preclinical & Translational Scientist', 'biomedical-research'], 115: ['Toxicology Evidence Reviewer', 'pharmaceutical-science'],
  116: ['Scientific Image Integrity Reviewer', 'biomedical-research'], 117: ['Biomedical Citation & Retraction Reviewer', 'biomedical-research'], 118: ['Research Integrity & Benchmark Curator', 'biomedical-research'],
  119: ['Immunology Research Reviewer', 'biomedical-research'], 120: ['Chemical Biology Scientist', 'chemistry'] };
for (const e of research) {
  const [name, category] = RESEARCH[e.catalogNumber], runtime = findExpert(`cb-role-${e.catalogNumber}`);
  ok(e.name === name && e.category === category && !e.priority, `${e.id} is the specified research role`);
  // Integrated deployments register cb-role-NNN; this worktree may not yet, and then the entry stays planned with no id
  if (runtime) ok(e.availability === 'available' && e.expertId === runtime.id, `${e.id} runs as cb-role-${e.catalogNumber}`);
  else ok(e.availability === 'planned' && !('expertId' in e) && /not in this deployment/.test(e.mappingNote), `${e.id} is planned until cb-role-${e.catalogNumber} is registered`);
}

const available = pool.entries.filter(e => e.availability === 'available');
ok(available.length === CLOUDBITE_EXPERTS.length && available.length >= 100, 'available entries = the runnable catalogue');
assert.deepEqual(new Set(available.map(e => e.expertId)), new Set(CLOUDBITE_EXPERTS.map(e => e.id))); checks++;
ok(new Set(available.map(e => e.expertId)).size === available.length, 'each runtime role maps to one plan number');
ok(released.every(e => e.availability === 'available'), 'all 100 released roles stay runnable');
const byNumber = n => pool.entries[n - 1];
for (const [n, id] of [[14, 'agency-design-ux-architect'], [65, 'agency-marketing-growth-hacker'], [67, 'agency-operations-manager'], [99, 'agency-product-feedback-synthesizer']])
  ok(byNumber(n).expertId === id && byNumber(n).knowledge === 'metadata-derived' && /related/.test(byNumber(n).mappingNote), `plan ${n} maps to existing ${id} as related scope`);
ok(byNumber(77).expertId === 'probably-primetime-sta' && byNumber(77).knowledge === 'curated-knowledge', 'plan 77 is the STA pilot');
ok(byNumber(31).name === 'AI Systems Engineer' && byNumber(31).expertId === 'agency-engineering-ai-engineer' && /AI Engineer/.test(byNumber(31).mappingNote), 'plan names are preserved; runtime name shown separately');
for (const n of pool.priorityNumbers) ok(byNumber(n).availability === 'available' && byNumber(n).knowledge === 'curated-knowledge', `priority ${n} is available with curated knowledge`);
ok(released.filter(e => e.availability === 'planned').length === 0, 'all 75 extension entries now have real runtime roles');

// Catalogue display ids can never launch through either validator; the selection limit is unchanged
const brief = ids => ({ title: 'Pool check', objective: 'Check planned roles.', context: '', expertIds: ids, mode: 'demo', requestId: 'pool-check-1' });
for (const e of pool.entries.slice(0, 10)) {
  assert.throws(() => m.validateProjectBrief(brief([e.id])), /unknown expert/); checks++;
  ok(m.isInvalid(m.validateBrief(brief([e.id]), CLOUDBITE_EXPERTS)), `${e.id} rejected by the runtime gate`);
}
ok(!m.isInvalid(m.validateBrief(brief(available.slice(0, m.PROJECT_MAX_EXPERTS).map(e => e.expertId)), CLOUDBITE_EXPERTS)), 'a full 100-role team can be selected');
ok(m.isInvalid(m.validateBrief(brief(Array(101).fill(available[0].expertId)), CLOUDBITE_EXPERTS)), '101 selections rejected');
if (available.length > 100) ok(m.isInvalid(m.validateBrief(brief(available.map(e => e.expertId)), CLOUDBITE_EXPERTS)), 'a catalogue above 100 still selects at most 100');
ok(!JSON.stringify(pool).match(/v_[a-f0-9]{64}|cbt_|@/), 'catalogue contains no user, token or account data');

console.log(`cloudbite-pool: ${checks} checks passed`);
