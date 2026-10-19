// Cloudbite project budget: pure preflight planner and call ledger (src/cloudbite-budget.ts). No network, no storage:
// the DO transaction is simulated by a serialized in-memory store so concurrent last-slot reservations are exercised.
//   node test/cloudbite-budget.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(process.cwd(), '.artifacts'); mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(out, 'cloudbite-budget-test-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-budget.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'budget.mjs'), built.outputFiles[0].text);
const B = await import(pathToFileURL(join(tmp, 'budget.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const ids = (n) => Array.from({ length: n }, (_, i) => `expert-${i + 1}`);
const catalogue = ids(120).map((id) => ({ id }));
const plan = (expertIds, budget, extra = {}) => B.planProjectBudget({ brief: { expertIds, ...(budget ? { budget } : {}) }, catalogue, ...extra });
const freeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
const budget = (maxExperts, maxModelCalls, maxReviewCalls, maxMemoCalls) => ({ maxExperts, maxModelCalls, maxReviewCalls, maxMemoCalls });

await check('default caps = selected*8 + 3 review + 1 memo; envelope is truthful', () => {
  const p = plan(ids(3));
  assert.equal(p.ok, true); assert.equal(p.source, 'default');
  assert.deepEqual(p.caps, { maxExperts: 100, maxModelCalls: 28, maxReviewCalls: 3, maxMemoCalls: 1, perExpertCalls: 8, expertPool: 24 });
  assert.equal(p.maxSandboxes, 3); assert.equal(p.maxNosanaCalls, 28);
  assert.deepEqual(p.phases, { expert: { max: 24 }, review: { max: 3 }, memo: { max: 1 } });
  assert.deepEqual(p.routing, { provider: 'typesafe', typedCalls: 2, countedInModelCalls: false });
  assert.ok(p.notes.some((n) => /neither the pool nor the cap guarantees/.test(n)));
  // A single expert cannot be cross-reviewed: the envelope says so instead of promising 3 review calls.
  const one = plan(ids(1));
  assert.equal(one.caps.maxModelCalls, 12); assert.equal(one.phases.review.max, 0); assert.equal(one.maxNosanaCalls, 9);
});

await check('total 804 at 100 experts; no $ or token estimate', () => {
  const p = plan(ids(100));
  assert.equal(p.caps.maxModelCalls, 804); assert.equal(p.maxNosanaCalls, 804); assert.equal(p.maxSandboxes, 100);
  assert.equal(p.cost.estimate, null);
  assert.ok(!/\$|usd|token/i.test(JSON.stringify({ ...p, cost: undefined, notes: undefined })));
  assert.ok(!/\$\s*\d|usd/i.test(p.cost.reason));
  const s = plan(ids(100), budget(100, 804, 3, 1));
  assert.equal(s.ok, true); assert.equal(s.source, 'stated'); assert.equal(s.maxNosanaCalls, 804);
});

await check('explicit lower caps respected; too small, invalid, unsupported fail before provisioning', () => {
  const p = plan(ids(4), budget(4, 10, 2, 0));
  assert.equal(p.ok, true);
  assert.deepEqual(p.caps, { maxExperts: 4, maxModelCalls: 10, maxReviewCalls: 2, maxMemoCalls: 0, perExpertCalls: 8, expertPool: 8 });
  assert.equal(p.phases.expert.max, 8); assert.equal(p.maxNosanaCalls, 10);
  assert.ok(p.notes.some((n) => /memo is disabled/.test(n)));
  assert.equal(plan(ids(4), budget(4, 7, 3, 1)).reason, 'budget-too-small');
  assert.equal(plan(ids(4), budget(4, 8, 3, 1)).ok, true); // exactly one call each
  assert.equal(plan(ids(4), budget(3, 100, 3, 1)).reason, 'too-many-experts');
  assert.equal(plan(ids(4), budget(4, 805, 3, 1)).reason, 'invalid-budget');
  assert.equal(plan(ids(4), budget(4, 100, 4, 1)).reason, 'invalid-budget');
  assert.equal(plan(ids(4), { maxExperts: 4, maxModelCalls: 40 }).reason, 'invalid-budget');
  assert.equal(plan([]).reason, 'no-experts');
  assert.equal(plan(['expert-1', 'expert-1']).reason, 'duplicate-expert');
  assert.equal(plan(['expert-1', 'not-runnable']).reason, 'unsupported-expert');
  assert.equal(plan(ids(2), undefined, { assignments: [{ expertId: 'expert-9' }] }).reason, 'assignment-mismatch');
  assert.equal(plan(ids(2), undefined, { assignments: [{ expertId: 'expert-2' }] }).ok, true);
  // Visitor/operator caps from the API are taken as a minimum; a budget never raises them.
  assert.equal(plan(ids(5), undefined, { maxExperts: 4 }).reason, 'too-many-experts');
  assert.equal(plan(ids(5), budget(100, 100, 3, 1), { maxExperts: 5 }).caps.maxExperts, 5);
  for (const p of [plan([]), plan(ids(4), budget(4, 7, 3, 1))]) assert.equal(p.message, B.budgetDenialMessage(p.reason));
});

await check('per-role cap 8 vs global expert pool', () => {
  let u = B.createBudgetUsage(plan(ids(2), budget(2, 12, 1, 1)));
  assert.deepEqual(u.experts, { 'expert-1': 0, 'expert-2': 0 });
  for (let seq = 1; seq <= 8; seq++) { const r = B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq }); assert.equal(r.ok, true); u = r.usage; }
  const cap = B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq: 9 });
  assert.equal(cap.reason, 'per-expert-cap'); assert.equal(cap.usage, u);
  for (let seq = 1; seq <= 2; seq++) u = B.reserveBudget(u, { phase: 'expert', key: 'expert-2', seq }).usage;
  // Pool = 12 - 1 - 1 = 10, used: the second role is denied at 2 turns though its own cap is 8.
  assert.equal(B.reserveBudget(u, { phase: 'expert', key: 'expert-2', seq: 3 }).reason, 'expert-phase-cap');
  assert.deepEqual(B.expertCanContinue(u, 'expert-2'), { ok: false, reason: 'expert-phase-cap', message: B.budgetDenialMessage('expert-phase-cap') });
  const m = B.budgetMetrics(u);
  assert.equal(m.expertsExhausted, true); assert.equal(m.exhausted, false);
  assert.deepEqual(m.review, { used: 0, max: 1, available: 1, exhausted: false });
  // Earmarked review and memo calls are still reservable; then everything is exhausted.
  u = B.reserveBudget(u, { phase: 'review', key: 'expert-1' }).usage;
  u = B.reserveBudget(u, { phase: 'memo', seq: 1 }).usage;
  assert.equal(B.budgetMetrics(u).exhausted, true); assert.equal(u.total, 12);
  assert.equal(B.reserveBudget(u, { phase: 'memo', seq: 2 }).reason, 'memo-phase-cap');
  assert.equal(B.reserveBudget(u, { phase: 'review', key: 'expert-2' }).reason, 'review-phase-cap');
  assert.equal(B.reserveBudget(u, { phase: 'expert', key: 'nobody', seq: 1 }).reason, 'unknown-expert');
});

await check('global total denies when a migrated ledger is over its caps', () => {
  const u = B.migrateBudgetUsage({ brief: { expertIds: ids(2), budget: budget(2, 6, 0, 0) }, experts: [{ key: 'expert-1', calls: 5 }, { key: 'expert-2', calls: 3 }] });
  assert.equal(u.total, 8);
  const r = B.reserveBudget(u, { phase: 'expert', key: 'expert-2', seq: 4 });
  assert.equal(r.ok, false); assert.ok(['expert-phase-cap', 'total-cap'].includes(r.reason));
  const m = B.budgetMetrics(u);
  assert.equal(m.total.available, 0); assert.equal(m.expert.available, 0); assert.equal(m.exhausted, true);
});

await check('immutable reserve; idempotent replay never double-reserves; out-of-order refused', () => {
  const u0 = freeze(B.createBudgetUsage(plan(ids(2))));
  const r1 = B.reserveBudget(u0, { phase: 'expert', key: 'expert-1', seq: 1 });
  assert.equal(r1.ok, true); assert.equal(r1.duplicate, false); assert.equal(u0.total, 0); assert.equal(r1.usage.total, 1); assert.equal(r1.usage.rev, 1);
  const again = B.reserveBudget(freeze(r1.usage), { phase: 'expert', key: 'expert-1', seq: 1 });
  assert.equal(again.ok, true); assert.equal(again.duplicate, true); assert.equal(again.usage, r1.usage);
  assert.equal(B.reserveBudget(r1.usage, { phase: 'expert', key: 'expert-1', seq: 3 }).reason, 'out-of-order');
  assert.equal(B.reserveBudget(r1.usage, { phase: 'expert', key: 'expert-1', seq: 0 }).reason, 'out-of-order');
  const rv = B.reserveBudget(r1.usage, { phase: 'review', key: 'expert-2' }).usage;
  assert.equal(B.reserveBudget(rv, { phase: 'review', key: 'expert-2' }).duplicate, true);
  const batch = B.reserveBudgetBatch(rv, [{ phase: 'review', key: 'expert-2' }, { phase: 'review', key: 'expert-1' }]);
  assert.equal(batch.ok, true); assert.deepEqual(batch.usage.reviewers, ['expert-2', 'expert-1']); assert.equal(batch.usage.total, 3);
  assert.equal(B.reserveBudgetBatch(batch.usage, [{ phase: 'review', key: 'expert-2' }, { phase: 'review', key: 'expert-1' }]).duplicate, true);
});

await check('review 0 / memo 0 disable their phases; batch is all-or-nothing', () => {
  const u = B.createBudgetUsage(plan(ids(3), budget(3, 10, 0, 0)));
  assert.equal(B.reserveBudget(u, { phase: 'review', key: 'expert-1' }).reason, 'phase-disabled');
  assert.equal(B.reserveBudget(u, { phase: 'memo', seq: 1 }).reason, 'phase-disabled');
  const v = B.createBudgetUsage(plan(ids(3), budget(3, 10, 2, 0)));
  const b = B.reserveBudgetBatch(v, ['expert-1', 'expert-2', 'expert-3'].map((key) => ({ phase: 'review', key })));
  assert.equal(b.ok, false); assert.equal(b.reason, 'review-phase-cap'); assert.equal(b.usage, v); assert.equal(v.total, 0);
  assert.deepEqual(B.affordableReviewers(v, ['expert-1', 'expert-2', 'expert-3']), ['expert-1', 'expert-2']);
});

await check('upstream failure / lost response stays consumed; no refund or reset exported', () => {
  let u = B.createBudgetUsage(plan(ids(1), budget(1, 2, 0, 0)));
  u = B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq: 1 }).usage; // reserved, then upstream 504
  const upstreamFailed = true; assert.ok(upstreamFailed);
  u = B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq: 2 }).usage; // reserved, response lost
  assert.equal(u.total, 2);
  const stop = B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq: 3 });
  assert.equal(stop.ok, false); assert.equal(B.expertCanContinue(u, 'expert-1').ok, false);
  // No infinite retries: every further attempt is the same denial, never a fresh allowance.
  for (let i = 0; i < 50; i++) assert.equal(B.reserveBudget(u, { phase: 'expert', key: 'expert-1', seq: 3 }).ok, false);
  assert.ok(!Object.keys(B).some((k) => /refund|release|reset|restore/i.test(k)));
  // A stored ledger whose counts were edited downward no longer matches total and fails closed.
  assert.equal(B.parseBudgetUsage({ ...u, experts: { 'expert-1': 0 } }), undefined);
  assert.equal(B.reserveBudget({ ...u, experts: { 'expert-1': 0 } }, { phase: 'expert', key: 'expert-1', seq: 1 }).reason, 'invalid-usage');
});

await check('concurrent last slot under a serialized DO transaction', async () => {
  // Storage whose transaction runs one callback at a time, like a DO input gate around storage.transaction.
  let stored = B.createBudgetUsage(plan(ids(2), budget(2, 3, 0, 0))), chain = Promise.resolve(), sent = 0;
  stored = B.reserveBudget(stored, { phase: 'expert', key: 'expert-1', seq: 1 }).usage;
  const tx = (f) => (chain = chain.then(async () => { const r = await f(structuredClone(stored)); if (r.ok && !r.duplicate) stored = r.usage; return r; }));
  const call = (key, seq) => tx(async (u) => { await new Promise((res) => setTimeout(res, 5)); return B.reserveBudget(u, { phase: 'expert', key, seq }); })
    .then((r) => { if (r.ok && !r.duplicate) sent++; return r; });
  const [a, b] = await Promise.all([call('expert-1', 2), call('expert-2', 1)]); // pool 3: one slot left after these two? 1+2=3
  assert.equal(a.ok && b.ok, true);
  const [c, d] = await Promise.all([call('expert-1', 3), call('expert-2', 2)]);
  assert.equal([c, d].filter((r) => r.ok).length, 0); assert.equal(sent, 2); assert.equal(stored.total, 3);
  // Two handlers racing for the single remaining slot: exactly one wins.
  stored = B.createBudgetUsage(plan(ids(2), budget(2, 2, 0, 0))); stored = B.reserveBudget(stored, { phase: 'expert', key: 'expert-1', seq: 1 }).usage; sent = 0;
  const race = await Promise.all([call('expert-1', 2), call('expert-2', 1)]);
  assert.equal(race.filter((r) => r.ok).length, 1); assert.equal(sent, 1); assert.equal(stored.total, 2);
  assert.equal(B.parseBudgetUsage(stored).total, 2);
});

await check('migration from running pre-budget projects is conservative', () => {
  const u = B.migrateBudgetUsage({ brief: { expertIds: ids(3) }, experts: [{ key: 'run-a', calls: 3 }, { key: 'run-b', calls: 'x' }, { key: 'run-c', calls: 12 }], crossReview: { reviewers: ['expert-1', 'expert-2'] } });
  assert.equal(u.migrated, true);
  assert.deepEqual(u.experts, { 'run-a': 3, 'run-b': 8, 'run-c': 8 });
  assert.deepEqual(u.reviewers, ['expert-1', 'expert-2']); assert.equal(u.total, 21);
  assert.equal(u.caps.maxModelCalls, 28);
  assert.deepEqual(B.parseBudgetUsage(u), u);
  assert.equal(B.reserveBudget(u, { phase: 'expert', key: 'run-a', seq: 4 }).ok, true);
  assert.equal(B.reserveBudget(u, { phase: 'expert', key: 'run-a', seq: 3 }).duplicate, true);
  assert.equal(B.reserveBudget(u, { phase: 'review', key: 'expert-3' }).ok, true);
  // A claim whose reviewer list is unreadable counts as every review call; nothing is reset to zero.
  const lost = B.migrateBudgetUsage({ brief: { expertIds: ids(2) }, experts: [{ key: 'run-a', calls: 0 }, { key: 'run-b', calls: 1 }], crossReview: {}, memoClaimed: true });
  assert.equal(lost.reviewers.length, 3); assert.equal(lost.memo, 1); assert.equal(lost.total, 5);
  assert.equal(B.reserveBudget(lost, { phase: 'review', key: 'expert-1' }).reason, 'review-phase-cap');
  assert.equal(B.reserveBudget(lost, { phase: 'memo', seq: 1 }).duplicate, true);
  assert.equal(B.migrateBudgetUsage({ brief: { expertIds: ids(1) }, experts: [{ key: 'run-a', calls: 2 }] }).reviewers.length, 0);
});

await check('versioned, byte-bounded, browser-safe projection', () => {
  const p = plan(ids(100));
  const keys = Array.from({ length: 100 }, (_, i) => `r${String(i).padStart(3, '0')}`.padEnd(64, 'x'));
  let u = B.createBudgetUsage(p, keys);
  for (const key of keys) for (let seq = 1; seq <= 8; seq++) u = B.reserveBudget(u, { phase: 'expert', key, seq }).usage;
  u = B.reserveBudgetBatch(u, keys.slice(0, 3).map((key) => ({ phase: 'review', key }))).usage;
  u = B.reserveBudget(u, { phase: 'memo', seq: 1 }).usage;
  assert.equal(u.total, 804); assert.equal(B.budgetMetrics(u).exhausted, true);
  const bytes = new TextEncoder().encode(JSON.stringify(u)).length;
  assert.ok(bytes <= B.CB_BUDGET_USAGE_MAX_BYTES, `${bytes} bytes`);
  assert.deepEqual(B.parseBudgetUsage(JSON.parse(JSON.stringify(u))), u);
  assert.equal(B.parseBudgetUsage({ ...u, version: 'cloudbite-budget/v0' }), undefined);
  assert.equal(B.parseBudgetUsage({ ...u, caps: { ...u.caps, perExpertCalls: 9 } }), undefined);
  assert.equal(B.parseBudgetUsage({ ...u, pad: 'x'.repeat(B.CB_BUDGET_USAGE_MAX_BYTES) }), undefined);
  assert.throws(() => B.createBudgetUsage(p, ['bad key']));
  const pub = B.publicBudget({ ...u, claim: 'secret-claim', token: 'cbw_x' });
  assert.ok(!/secret-claim|cbw_|claim|token|account|binding/i.test(JSON.stringify(pub)));
  assert.equal(pub.total.used, 804); assert.equal(pub.caps.maxModelCalls, 804);
});

await check('review reservations never exceed the planned phases.review.max = min(cap, experts); run-id ledgers still work', () => {
  const p = plan(ids(2));
  assert.equal(p.phases.review.max, 2); assert.equal(p.maxNosanaCalls, 19);
  for (const keys of [undefined, ['e0', 'e1']]) {
    let u = B.createBudgetUsage(p, keys);
    for (const key of Object.keys(u.experts)) for (let seq = 1; seq <= 8; seq++) u = B.reserveBudget(u, { phase: 'expert', key, seq }).usage;
    // Review keys are expert ids even when the expert ledger is keyed by run id; membership is not required.
    u = B.reserveBudget(u, { phase: 'review', key: 'expert-1' }).usage;
    assert.equal(B.reserveBudget(u, { phase: 'review', key: 'expert-1' }).duplicate, true, 'idempotent replay');
    u = B.reserveBudget(u, { phase: 'review', key: 'x' }).usage;
    assert.equal(u.reviewers.length, 2);
    assert.equal(B.reserveBudget(u, { phase: 'review', key: 'expert-2' }).reason, 'review-phase-cap', 'no third reviewer for two experts, even a foreign key');
    assert.equal(B.reserveBudgetBatch(u, [{ phase: 'review', key: 'y' }]).ok, false);
    assert.equal(B.reserveBudget(u, { phase: 'review', key: 'x' }).duplicate, true, 'replay still idempotent at the cap');
    u = B.reserveBudget(u, { phase: 'memo', seq: 1 }).usage;
    assert.ok(u.total <= p.maxNosanaCalls, `${u.total} <= ${p.maxNosanaCalls}`); assert.equal(u.total, 19);
  }
  // A single expert has no cross-review, as the plan says.
  const one = B.createBudgetUsage(plan(ids(1)));
  assert.equal(B.reserveBudget(one, { phase: 'review', key: 'expert-1' }).reason, 'review-phase-cap');
});

console.log(`${count} checks passed`);
