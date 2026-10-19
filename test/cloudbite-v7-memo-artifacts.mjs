// Actual pure selection + memo snapshot/parser boundaries. Inputs are fabricated, no model calls.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const b = await build({ stdin: { contents: "export * from './src/cloudbite-memo-artifacts.ts'; export {memoMessages, memoSnapshot, isMemoSnapshotCurrent} from './src/cloudbite-memo.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const M = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
let passed = 0;
const check = (label, f) => { f(); passed++; console.log('ok', label); };
const expert = (i, status = 'completed') => ({ run: { id: `run-${i}`, expertId: `role-${i}`, status, artifacts: [
  { path: 'out/report.md', bytes: 80 }, { path: 'out/analysis.csv', bytes: 120 }, { path: 'out/result.json', bytes: 99 },
  { path: 'out/../secret.md', bytes: 1 }, { path: 'out/knowledge.json', bytes: 1 }, { path: 'out/report.md', bytes: 80 },
] } });
check('completed experts only, safe collected artifact paths, one file per role before second, bounded read keys', () => {
  const p = M.selectMemoArtifacts([...Array.from({ length: 15 }, (_, i) => expert(i)), expert(20, 'failed')]);
  assert.equal(p.entries.length, 12); assert.equal(p.eligible, 30);
  assert.deepEqual(p.entries.map(a => a.expertId), Array.from({ length: 12 }, (_, i) => `role-${i}`));
  assert.ok(p.entries.every(a => a.path === 'out/report.md' && a.key === `artifact:run-${a.expertId.slice(5)}:out/report.md`));
  const two = M.selectMemoArtifacts([expert(1), expert(2)]);
  assert.deepEqual(two.entries.map(a => a.path), ['out/report.md', 'out/report.md', 'out/analysis.csv', 'out/analysis.csv']);
});
const selection = M.selectMemoArtifacts([expert(1)]);
const content = '## Proposal\n' + '검증된 실행 결과가 아닌 계획입니다. '.repeat(300);
const contents = new Map([[selection.entries[0].key, content], [selection.entries[1].key, 'metric,proposed_check\nruntime,measure first']]);
const packets = M.memoArtifactPackets(selection, contents);
check('generated excerpt standing, full artifact hash, Unicode bound, missing and omitted metadata', () => {
  assert.equal(packets[0].kind, 'expert-artifact-excerpt'); assert.ok(packets[0].text.length <= 4000);
  assert.match(packets[0].origin, /sha256=[a-f0-9]{64}/); assert.match(packets[0].origin, /model-generated-unverified/);
  assert.ok(!packets[0].text.endsWith('\ud83d'));
  const missing = M.memoArtifactPackets({ ...selection, eligible: 9 }, new Map([[selection.entries[0].key, 'x'.repeat(65537)]]));
  assert.equal(missing.length, 1); assert.match(missing[0].label, /limit: 7; selected but unavailable: 2/);
});
const brief = { title: 'EDA project', objective: 'Compare a measured ECO regression and corner expansion plan', context: 'Quota fixed; runtime unknown', responseLanguage: 'en', expertIds: ['role-1'], mode: 'live', requestId: 'v7-artifact-test' };
const completed = [{ expertId: 'role-1', name: 'Synthetic role', opinion: { direction: 'conditional', confidence: 50, summary: 'Measure first.', evidence: ['User supplied quota.'], assumptions: ['Runtime unknown'], nextActions: ['Measure runtime.'] } }];
check('actual memo includes bounded artifacts as separately attributed packets, no original-source/full-report verification claim', () => {
  const prompt = M.memoMessages(brief, completed, { coaching: true, packets });
  assert.equal(prompt.kind, 'prompt'); const data = JSON.parse(prompt.messages[1].content.split('\n').slice(1).join('\n'));
  assert.equal(data.packets[0].kind, 'expert-artifact-excerpt'); assert.match(data.packets[0].excerpt, /Proposal/);
  assert.match(prompt.messages[0].content, /not independent sources or proof that a tool ran/);
  assert.equal(prompt.coverage.fullReportsReviewed, false); assert.equal(prompt.coverage.sourcePagesReviewed, false);
  assert.equal(prompt.coverage.packets.invalid, 0); assert.ok(prompt.allowed.refs.includes('pkt:artifact-1'));
  assert.ok(prompt.coverage.promptBytes < 160 * 1024);
});
check('snapshot binds even an artifact tail outside the model excerpt; old memo without artifact input stays unchanged', () => {
  const old = M.memoMessages(brief, completed, { coaching: true });
  const snapshot = M.memoSnapshot(brief, completed, { coaching: true, packets });
  const changed = new Map(contents); changed.set(selection.entries[0].key, content + 'new tail');
  const next = M.memoArtifactPackets(selection, changed);
  assert.equal(next[0].text, packets[0].text);
  assert.equal(M.isMemoSnapshotCurrent(snapshot, brief, completed, { coaching: true, packets: next }), false);
  assert.ok(!old.messages[0].content.includes('Expert-artifact-excerpt packets'));
  assert.equal(old.snapshot, M.memoSnapshot(brief, completed, { coaching: true }));
});
console.log(`${passed} v7 memo-artifact groups passed (synthetic inputs; no quality claim).`);
