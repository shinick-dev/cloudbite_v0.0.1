// Cloudbite evidence packets, peer selection and observation signals: pure helpers over the application-owned packs.
// One check runs the ACTUAL runner.py against a local fake gateway so the packet is built from a real out/knowledge.json.
// No provider network: only 127.0.0.1 is contacted.
//   node test/cloudbite-evidence-packet.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-evidence-packet-'));
const entry = `export * from './src/cloudbite-evidence-packet.ts'; export * from './src/cloudbite-cross-review.ts'; export * from './src/cloudbite-evidence.ts';
export { CLOUDBITE_EXPERTS, phaseOnePack } from './src/cloudbite-personas.ts'; export { knowledgeWorkspaceFiles, knowledgeDigest, REVIEW_ROLE_IDS, sha256Hex } from './src/cloudbite-knowledge.ts';
export { STA_PACK } from './src/cloudbite-sta-data.ts'; export { STA_EXPERT, staKnowledgeFiles } from './src/cloudbite-sta.ts';
export { CB_RUNNER_PY, CB_RUNNER_ROUNDS } from './src/cloudbite-runner.ts'; export { CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sha = (t) => createHash('sha256').update(t).digest('hex');
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

const outside = (pack) => pack.sources.find((s) => !pack.cards.slice(0, 2).some((c) => c.source_ids.includes(s.id) || s.aliases.some((a) => c.source_ids.includes(a))));
const ROLE = M.CLOUDBITE_EXPERTS.find((e) => M.phaseOnePack(e.id) && !M.REVIEW_ROLE_IDS.has(e.id) && outside(M.phaseOnePack(e.id)));
const OTHER = M.CLOUDBITE_EXPERTS.find((e) => M.phaseOnePack(e.id) && e.id !== ROLE.id);
const PACK = M.phaseOnePack(ROLE.id), OTHER_PACK = M.phaseOnePack(OTHER.id);
assert.ok(PACK && OTHER_PACK);
const brief = { title: 'Pilot', objective: 'Should we pilot?', context: 'Context', expertIds: [ROLE.id, OTHER.id], mode: 'live', requestId: 'packet-test-0001',
  documents: [{ id: 'doc-1', name: 'pilot.md', content: 'Budget: two weeks. SUPPLIED-DOC-TEXT' }, { id: 'doc-2', name: 'empty.md', content: '   ' }] };

/** Runner-shaped audit, built exactly as finish() does from the workspace manifest and its own retrieval trace. */
function auditFor(pack, cardIds, extra = {}) {
  const manifest = JSON.parse(M.knowledgeWorkspaceFiles(pack, '', false).find((f) => f.path === 'knowledge/manifest.json').content);
  const sourcesOf = (ids) => { const s = new Set(ids.flatMap((id) => pack.cards.find((c) => c.id === id).source_ids)); return pack.sources.filter((x) => s.has(x.id) || x.aliases.some((a) => s.has(a))); };
  const retrievals = [{ reason: 'initial selection', cardIds, sourceIds: sourcesOf(cardIds).map((s) => s.id) }];
  const used = new Set(retrievals.flatMap((r) => r.sourceIds));
  return { version: manifest.version, validation: 'curated-unvalidated', provenance: manifest.provenance, retrievals, sources: pack.sources.filter((s) => used.has(s.id)),
    citationIdsValidated: true, sourcePagesFetched: false, schema: manifest.schema, expertId: pack.expertId, evaluation: 'unvalidated', peerResultsVerified: false, peerInputsProvided: false, ...extra };
}
const card0 = PACK.cards[0], src0 = PACK.sources.find((s) => card0.source_ids.includes(s.id));
const uncited = PACK.sources.find((s) => !PACK.cards.slice(0, 2).some((c) => c.source_ids.includes(s.id) || s.aliases.some((a) => c.source_ids.includes(a))));
assert.ok(uncited, "the test role has a source outside its first two cards");
const opinion = (evidence, patch = {}) => ({ direction: 'conditional', confidence: 60, summary: 'S', evidence, assumptions: ['a1', 'a2'], nextActions: ['n'], ...patch });
const ROLE_OPINION = opinion([`[source:${src0.id}] card-backed claim`, '[doc:doc-1] budget claim', '[doc:doc-2] empty doc', '[doc:doc-9] removed doc',
  `[source:${uncited?.id ?? 'zz'}] catalogue only`, '[source:invented] unknown', '[source:PROJECT.md] brief', '[source:DECISION.md] frame', 'no reference']);
const avail = (p, i) => p.references.filter((r) => r.evidenceIndex === i).map((r) => r.availability);

await check('bound audit: actual cards from the application pack with provenance; availability per reference kind; originals untouched', () => {
  const audit = JSON.stringify(auditFor(PACK, [card0.id, PACK.cards[1].id]));
  const before = structuredClone({ brief, ROLE_OPINION, audit });
  const p = M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit });
  assert.equal(p.binding, 'bound'); assert.equal(p.schema, 'cloudbite.evidence-packet/v1');
  assert.deepEqual(p.pack, { version: PACK.version, cardsSha256: M.knowledgeDigest(PACK).cardsSha256, sourcesSha256: M.knowledgeDigest(PACK).sourcesSha256 });
  assert.deepEqual(p.cards.map((c) => c.id), [card0.id, PACK.cards[1].id]);
  assert.equal(p.cards[0].summary, card0.summary, 'card text from the pack, not a label'); assert.equal(p.cards[0].provenance, card0.provenance);
  assert.deepEqual(p.cards[0].retrievalReasons, ['initial selection']);
  assert.ok(p.sources.every((s) => s.originalText === 'not-fetched' && typeof s.url === 'string'));
  assert.equal(p.originalSourceTextFetched, false);
  assert.deepEqual(avail(p, 0), ['curated-card-text']);
  assert.deepEqual(avail(p, 1), ['supplied-project-text']); assert.deepEqual(avail(p, 2), ['missing-project-text']); assert.deepEqual(avail(p, 3), ['unknown-id']);
  if (uncited) assert.deepEqual(avail(p, 4), ['not-retrieved'], 'catalogue presence alone is not retrieval');
  assert.deepEqual(avail(p, 5), ['unknown-id']); assert.deepEqual(avail(p, 6), ['supplied-project-text']); assert.deepEqual(avail(p, 7), ['missing-project-text'], 'no decision frame supplied');
  assert.deepEqual(avail(p, 8), []);
  assert.ok(p.references.filter((r) => r.kind === 'knowledge').every((r) => r.originalText === 'not-fetched'));
  const { bytes, sha256, ...body } = p; assert.equal(sha256, sha(JSON.stringify(body))); assert.equal(bytes, utf8(JSON.stringify(body)));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.cards[0]));
  assert.deepEqual({ brief, ROLE_OPINION, audit }, before);
  assert.deepEqual(M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit }), p, 'deterministic');
});

await check('model-claimed sourcePagesFetched never becomes truth; audit source copies are not trusted', () => {
  const a = auditFor(PACK, [card0.id], { sourcePagesFetched: true });
  a.sources = a.sources.map((s) => ({ ...s, title: 'FORGED TITLE', url: 'https://evil.test' }));
  const p = M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit: a });
  assert.equal(p.binding, 'bound'); assert.equal(p.originalSourceTextFetched, false);
  assert.match(p.auditNotes.join(), /claimed source pages were fetched; ignored/);
  assert.ok(!JSON.stringify(p).includes('FORGED') && !JSON.stringify(p).includes('evil.test'));
});

await check('foreign pack, foreign audit, stale hash, stale version, legacy-unbound, no audit, no pack', () => {
  const ok = auditFor(PACK, [card0.id]);
  const build = (patch) => M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit: ok, ...patch });
  const foreignPack = build({ pack: OTHER_PACK });
  assert.equal(foreignPack.binding, 'foreign'); assert.deepEqual(foreignPack.cards, []); assert.equal(foreignPack.pack, null);
  const foreignAudit = build({ audit: auditFor(OTHER_PACK, [OTHER_PACK.cards[0].id]) });
  assert.equal(foreignAudit.binding, 'foreign'); assert.deepEqual(foreignAudit.cards, []);
  const stale = build({ audit: { ...ok, provenance: { ...ok.provenance, cardsSha256: 'a'.repeat(64) } } });
  assert.equal(stale.binding, 'stale'); assert.deepEqual(stale.cards, []); assert.deepEqual(stale.observed.cardIds, []); assert.equal(stale.omitted.unidentifiedIds, 1);
  assert.deepEqual(avail(stale, 0), ['retrieval-unverified']);
  assert.equal(build({ audit: { ...ok, version: 'old-version' } }).binding, 'stale');
  const legacy = build({ audit: { ...ok, provenance: { basis: 'curated-knowledge' }, retrievals: [{ reason: 'initial selection', cardIds: [card0.id, 'gone-card'], sourceIds: [src0.id, 'gone-source'] }] } });
  assert.equal(legacy.binding, 'legacy-unbound'); assert.deepEqual(legacy.cards, []); assert.deepEqual(legacy.sources, []);
  assert.deepEqual(legacy.observed.cardIds, [card0.id]); assert.ok(legacy.observed.sourceIds.includes(src0.id)); assert.equal(legacy.omitted.unidentifiedIds, 2);
  assert.deepEqual(avail(legacy, 0), ['retrieval-unverified']);
  const none = build({ audit: undefined });
  assert.equal(none.binding, 'absent'); assert.deepEqual(avail(none, 0), ['retrieval-unverified']); assert.deepEqual(avail(none, 1), ['supplied-project-text']);
  const plain = M.CLOUDBITE_EXPERTS.find((e) => !M.phaseOnePack(e.id) && e.id !== M.STA_EXPERT.id);
  const noPack = M.buildEvidencePacket({ brief, expertId: plain.id, opinion: ROLE_OPINION, audit: ok });
  assert.equal(noPack.binding, 'no-pack'); assert.match(noPack.bindingNote, /audit was ignored/); assert.deepEqual(avail(noPack, 0), ['unknown-id']);
  for (const p of [foreignPack, foreignAudit, stale, legacy, none, noPack]) assert.ok(!JSON.stringify(p.cards).includes(card0.summary.slice(0, 40)));
});

await check('malicious audits are invalid, never partially trusted', () => {
  const ok = auditFor(PACK, [card0.id]);
  const cases = [
    ['not json', '{'], ['array', '[]'], ['oversize', JSON.stringify({ ...ok, pad: 'x'.repeat(70 * 1024) })],
    ['too many retrievals', { ...ok, retrievals: Array(33).fill(ok.retrievals[0]) }],
    ['bad id', { ...ok, retrievals: [{ ...ok.retrievals[0], cardIds: ['../../ETC-MARKER'] }] }],
    ['unknown card with matching hashes', { ...ok, retrievals: [{ reason: 'x', cardIds: ['no-such-card'], sourceIds: [] }] }],
    ['inconsistent source ids', { ...ok, retrievals: [{ ...ok.retrievals[0], sourceIds: [...ok.retrievals[0].sourceIds, uncited?.id ?? 'zz'] }] }],
    ['source record never retrieved', { ...ok, sources: [...ok.sources, { id: uncited?.id ?? 'zz' }] }],
    ['malformed retrieval', { ...ok, retrievals: [{ cardIds: 'x' }] }],
    ['cyclic', (() => { const c = { ...ok }; c.self = c; return c; })()],
  ];
  for (const [name, audit] of cases) {
    const p = M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit });
    assert.equal(p.binding, 'invalid', name); assert.deepEqual(p.cards, [], name); assert.deepEqual(avail(p, 0), ['retrieval-unverified'], name);
    assert.ok(!JSON.stringify(p).includes('ETC-MARKER'), name);
  }
});

await check('STA legacy pack binds by its own cards/sources hashes', () => {
  assert.equal(M.packHashes(M.STA_PACK).cardsSha256, M.STA_PACK.provenance.cardsSha256);
  assert.equal(M.packHashes(M.STA_PACK).sourcesSha256, M.STA_PACK.provenance.sourcesSha256);
  const c = M.STA_PACK.cards[0], ids = new Set(c.source_ids), srcs = M.STA_PACK.sources.filter((s) => ids.has(s.id) || s.aliases.some((a) => ids.has(a)));
  const audit = { version: M.STA_PACK.version, validation: 'curated-unvalidated', provenance: M.STA_PACK.provenance, retrievals: [{ reason: 'initial selection', cardIds: [c.id], sourceIds: srcs.map((s) => s.id) }],
    sources: srcs, citationIdsValidated: true, sourcePagesFetched: false, commercialStaExecuted: false };
  const p = M.buildEvidencePacket({ brief, expertId: M.STA_EXPERT.id, opinion: opinion([`[source:${srcs[0].id}] sta`]), audit });
  assert.equal(p.binding, 'bound', p.bindingNote); assert.deepEqual(p.cards.map((x) => x.id), [c.id]); assert.deepEqual(avail(p, 0), ['curated-card-text']);
});

await check('bounds: large multilingual pack truncates on code points, counts omissions, stays within role and total budgets', () => {
  const big = '한국어 근거 문장과 emoji 🚀 그리고 English mixed text. '.repeat(400);
  const pack = { expertId: ROLE.id, version: 'big-1',
    cards: Array.from({ length: 12 }, (_, i) => ({ id: `big-${i}`, term: '용어 ' + i, summary: big, kind: 'method', source_ids: [`s-${i}`], provenance: 'synthetic' })),
    sources: Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, title: '출처 ' + i, url: `https://example.test/${i}`, license: 'test', aliases: [], checkStatus: 'unverified', checkedAt: '' })) };
  const ids = pack.cards.map((c) => c.id).slice(0, 8);
  const audit = { version: 'big-1', provenance: { cardsSha256: sha(JSON.stringify(pack.cards)), sourcesSha256: sha(JSON.stringify(pack.sources)) },
    retrievals: [{ reason: 'initial selection', cardIds: ids, sourceIds: ids.map((_, i) => `s-${i}`) }], sources: [] };
  const op = opinion(ids.map((_, i) => `[source:s-${i}] claim ${i}`));
  const p = M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: op, audit, pack });
  assert.equal(p.binding, 'bound');
  assert.ok(p.bytes <= M.EVIDENCE_PACKET_LIMITS.roleBytes, `${p.bytes}`);
  assert.ok(p.cards.length >= 1 && p.cards.length < 8); assert.equal(p.omitted.cards, 8 - p.cards.length);
  assert.ok(p.cards.every((c) => c.truncated && utf8(c.summary) <= M.EVIDENCE_PACKET_LIMITS.cardSummaryBytes && !/[\ud800-\udbff]$/.test(c.summary.replace(/…$/, ''))));
  assert.ok(!p.cards.some((c) => c.summary.includes('�')));
  assert.ok(p.references.some((r) => r.availability === 'curated-card-text-omitted'), 'cut text is reported, not implied');
  assert.equal(pack.cards[0].summary, big, 'original pack untouched');
  const many = M.buildEvidencePackets([0, 1, 2, 3].map(() => ({ brief, expertId: ROLE.id, opinion: op, audit, pack })));
  const total = many.reduce((n, x) => n + x.bytes, 0);
  assert.ok(total <= M.EVIDENCE_PACKET_LIMITS.totalBytes, `${total}`);
  assert.ok(many.every((x) => x.binding === 'bound' && x.bytes <= M.EVIDENCE_PACKET_LIMITS.roleBytes));
  const tiny = M.buildEvidencePacket({ brief, expertId: ROLE.id, opinion: op, audit, pack }, 900);
  assert.deepEqual(tiny.cards, []); assert.ok(tiny.omitted.cards + tiny.omitted.references + tiny.omitted.observedIds > 0);
  assert.equal(M.truncateUtf8('가나다라', 7), '가…'); assert.equal(M.truncateUtf8('🚀🚀', 6), '…'); assert.equal(M.truncateUtf8('🚀🚀', 8), '🚀🚀');
});

await check('100-role batch respects the actual serialized cap and explicitly exposes omitted packet coverage', () => {
  const roles = M.CLOUDBITE_EXPERTS.slice(0,100);
  const inputs = roles.map(r => ({brief, expertId:r.id, opinion:opinion(['[source:PROJECT.md] synthetic project statement'])}));
  const packets = M.buildEvidencePackets(inputs);
  assert.ok(utf8(JSON.stringify(packets)) <= M.EVIDENCE_PACKET_LIMITS.totalBytes);
  assert.ok(packets.length < inputs.length && packets.length > 0);
  const runs = roles.map((r,i) => ({id:`e${i}`,expertId:r.id,name:r.name,status:'completed',opinion:inputs[i].opinion,activity:[],artifacts:[],updatedAt:1}));
  const coverage = M.buildEvidenceSignals(brief,runs,{packets}).packetCoverage;
  assert.equal(coverage.total,100); assert.equal(coverage.included,packets.length);
  assert.equal(coverage.omittedExpertIds.length,100-packets.length);
  for (const cap of [0,1,64,500,1024,4096]) {
    const batch=M.buildEvidencePackets(inputs,cap);
    assert.ok(batch.length===0 || utf8(JSON.stringify(batch))<=cap,`cap=${cap}`);
  }
  assert.deepEqual(M.buildEvidencePackets(inputs,NaN),[]);
});

await check('reviewMessages carries peer packets (card text and provenance) and stays backward compatible without them', () => {
  const peerOp = { expertId: ROLE.id, name: ROLE.name, opinion: ROLE_OPINION };
  const me = { expertId: OTHER.id, name: OTHER.name, opinion: opinion(['[doc:doc-1] mine']) };
  const packets = M.buildEvidencePackets([{ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit: JSON.stringify(auditFor(PACK, [card0.id])) },
    { brief, expertId: OTHER.id, opinion: me.opinion, audit: undefined }]);
  const legacy = M.reviewMessages(me, [peerOp], brief, OTHER);
  assert.ok(!('peerEvidence' in JSON.parse(legacy[1].content.replace(/^[^\n]*\n/, ''))));
  assert.ok(!legacy[0].content.includes('peerEvidence'));
  const msgs = M.reviewMessages(me, [peerOp], brief, OTHER, packets);
  const data = JSON.parse(msgs[1].content.replace(/^[^\n]*\n/, ''));
  assert.deepEqual(data.peerEvidence.map((x) => x.expertId), [ROLE.id], 'peer packet only, never the reviewer\'s own');
  assert.equal(data.peerEvidence[0].cards[0].summary, card0.summary); assert.equal(data.peerEvidence[0].cards[0].provenance, card0.provenance);
  assert.equal(data.peerEvidence[0].packetSha256, packets[0].sha256);
  assert.match(msgs[0].content, /title, URL or license is not page text/); assert.match(msgs[0].content, /unavailable is not the same as wrong/);
  assert.equal(msgs[0].content.split('\nAssigned reviewer lens')[0], M.reviewMessages(peerOp, [me], brief, ROLE, packets)[0].content.split('\nAssigned reviewer lens')[0], 'fixed instructions');
  // Snapshot: identical to the old one without packets, carries exact hashes with them.
  const completed = [peerOp, me];
  assert.equal(M.reviewSnapshot(brief, completed), JSON.stringify({ brief: M.reviewContext(brief), opinions: completed.map((c) => ({ expertId: c.expertId, opinion: c.opinion })) }));
  assert.deepEqual(JSON.parse(M.reviewSnapshot(brief, completed, packets)).packets, packets.map((p) => ({ expertId: p.expertId, sha256: p.sha256 })));
  assert.notEqual(M.reviewSnapshot(brief, completed, packets), M.reviewSnapshot(brief, completed, [packets[1], packets[0]]));
});

await check('peer selection: disagreement, evidence gaps and domain coverage over completed order; deterministic, capped, disclosed', () => {
  const op = (id, patch = {}) => ({ expertId: id, name: id, opinion: opinion([`[doc:doc-1] ${id}`], patch) });
  const all = [op('a'), op('b'), op('c'), op('d', { direction: 'concern' }), op('e', { evidence: ['no ref'] }), op('f')];
  const sel = M.peerSelection(all[0], all, { brief });
  assert.deepEqual(sel.peers.map((p) => p.expertId), ['b', 'd', 'e'], 'disagreeing and gap opinions beat first-three order, returned in completed order');
  assert.match(sel.peers.find((p) => p.expertId === 'd').reasons.join(), /direction concern differs/);
  assert.match(sel.peers.find((p) => p.expertId === 'e').reasons.join(), /without available cited text/);
  assert.deepEqual(sel.omitted, ['c', 'f']); assert.equal(sel.considered, 5);
  assert.deepEqual(M.peersFor(all[0], all, { brief }).map((c) => c.expertId), ['b', 'd', 'e']);
  // Unbiased by input position: reordering the opinions selects the same set.
  const rev = [...all].reverse();
  assert.deepEqual(new Set(M.peersFor(all[0], rev, { brief }).map((c) => c.expertId)), new Set(['d', 'e', rev.find((c) => !['a', 'd', 'e'].includes(c.expertId)).expertId]));
  assert.deepEqual(M.peerSelection(all[0], all, { brief }), sel, 'deterministic');
  // Domain coverage with equal signals.
  const cat = [{ id: 'a', domain: 'x' }, { id: 'b', domain: 'x' }, { id: 'c', domain: 'x' }, { id: 'd', domain: 'y' }, { id: 'e', domain: 'z' }, { id: 'f', domain: 'x' }];
  const same = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => op(id));
  assert.deepEqual(M.peersFor(same[0], same, { catalogue: cat }).map((c) => c.expertId), ['b', 'd', 'e']);
  // Equal opinions with no options fall back to the first three in completed order.
  assert.deepEqual(M.peersFor(same[1], same).map((c) => c.expertId), ['a', 'c', 'd']);
  for (const r of same) { const p = M.peersFor(r, same); assert.ok(p.length === 3 && !p.includes(r)); }
  const plan = M.reviewPlan(same, cat, {});
  assert.equal(plan.reviewers.length, 3); assert.ok(plan.assignments.every((a) => a.peers.length <= 3));
  assert.equal(plan.coverage.completedOpinions, 6); assert.equal(plan.coverage.maxReviewers, 3); assert.equal(plan.coverage.maxPeersPerReviewer, 3);
  assert.match(plan.disclosure, /Selective cross-review/); assert.match(plan.disclosure, /not a review of every opinion/);
  const hundred = Array.from({ length: 100 }, (_, i) => op('r' + i, i % 7 ? {} : { direction: 'concern' }));
  const p100 = M.reviewPlan(hundred, [], { brief });
  assert.ok(p100.coverage.assignedOpinions <= 9 && p100.coverage.unassigned.length >= 91);
  assert.match(p100.disclosure, new RegExp(`${p100.coverage.assignedOpinions} of 100 completed opinions`)); assert.match(p100.disclosure, /were not reviewed/);
});

await check('observation signals: counts beside self-confidence, never a probability; cross-review counts and coverage denominator', () => {
  const runs = [{ id: 'e0', expertId: ROLE.id, name: ROLE.name, status: 'completed', activity: [], artifacts: [], updatedAt: 1, opinion: ROLE_OPINION },
    { id: 'e1', expertId: OTHER.id, name: OTHER.name, status: 'completed', activity: [], artifacts: [], updatedAt: 1, opinion: opinion(['[doc:doc-1] x', 'y'], { confidence: 90 }) },
    { id: 'e2', expertId: 'x', name: 'x', status: 'failed', activity: [], artifacts: [], updatedAt: 1 }];
  const before = structuredClone(runs);
  const packets = M.buildEvidencePackets([{ brief, expertId: ROLE.id, opinion: ROLE_OPINION, audit: auditFor(PACK, [card0.id]) }]);
  const none = M.buildEvidenceSignals(brief, runs);
  assert.match(none.interpretation, /not a calibrated probability/); assert.equal(none.review.status, 'not-run'); assert.match(none.review.disclosure, /No cross-review has run/);
  assert.equal(none.experts.length, 2); assert.equal(none.experts[0].observedRetrieval, null); assert.equal(none.experts[0].crossReview, null);
  assert.equal(none.experts[0].knowledge.retrievalUnverified + none.experts[0].knowledge.notRetrieved >= 1, true, 'catalogue presence without a packet is not retrieval');
  assert.equal(none.experts[0].knowledge.curatedCardText, 0);
  const crossReview = { status: 'completed', snapshotHash: 'h', startedAt: 1, execution: 'server-nosana', reports: [
    { reviewerExpertId: OTHER.id, summary: 's', findings: [{ targetExpertId: ROLE.id, evidenceIndex: 0, verdict: 'challenged', rationale: 'r' }, { targetExpertId: ROLE.id, evidenceIndex: 4, verdict: 'insufficient', rationale: 'r' }] }] };
  const s = M.buildEvidenceSignals(brief, runs, { packets, crossReview });
  const r = s.experts[0];
  assert.equal(r.selfAssessedConfidence, 60); assert.equal(r.evidenceItems, 9); assert.equal(r.unreferencedEvidenceItems, 1); assert.equal(r.assumptions, 2);
  assert.deepEqual(r.references, { total: 8, document: 3, workspace: 2, knowledge: 3 });
  assert.deepEqual(r.suppliedText, { available: 2, missing: 2 }); assert.equal(r.unknownReferences, 2);
  assert.equal(r.knowledge.curatedCardText, 1);
  assert.deepEqual(r.observedRetrieval, { binding: 'bound', retrievals: 1, cards: 1, sources: packets[0].observed.sourceIds.length });
  assert.deepEqual(r.crossReview, { reviewers: 1, findings: 2, supported: 0, challenged: 1, insufficient: 1, evidenceItemsReviewed: 2 });
  assert.deepEqual(s.experts[1].crossReview, { reviewers: 0, findings: 0, supported: 0, challenged: 0, insufficient: 0, evidenceItemsReviewed: 0 });
  assert.equal(s.review.completedOpinions, 2); assert.equal(s.review.reviewedOpinions, 1); assert.match(s.review.disclosure, /1 of 2 completed opinions/);
  assert.ok(!/probab|accura|calibrat/i.test(Object.keys(r).join()), 'no derived confidence field');
  assert.ok(!('dispersion' in s) && !('confidence' in s.review));
  assert.deepEqual(runs, before);
  // Finding metadata separates unavailable text from contradiction, without touching the verdict.
  const completed = runs.slice(0, 2).map((e) => ({ expertId: e.expertId, name: e.name, opinion: e.opinion }));
  const fa = M.findingTextAvailability(crossReview.reports[0], completed, brief, packets);
  assert.deepEqual(fa.map((x) => [x.verdict, x.textBasis]), [['challenged', 'available'], ['insufficient', uncited ? 'unavailable' : 'unavailable']]);
  // Legacy evidenceClaims meaning is unchanged.
  const claims = M.evidenceClaims(brief, runs);
  assert.equal(claims[0].status, 'linked'); assert.deepEqual(claims[0].references, [{ kind: 'knowledge', id: src0.id, available: true }]);
});

// ── the actual runner writes out/knowledge.json; the packet is built from those exact bytes ──
let RUN = null;
const TOKEN = 'cbw_CAPABILITY-SECRET-VALUE';
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const action = req.url.split('/').at(-1);
  if (action === 'inference') { RUN.calls.push(body.messages); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: RUN.model(RUN.calls.length) })); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await check('actual runner audit binds: initial and follow-up retrievals appear as card text; sourcePagesFetched stays false', async () => {
  const dir = mkdtempSync(join(tmp, 'sb-'));
  for (const d of ['out', 'work', '.cloudbite', 'knowledge']) mkdirSync(join(dir, d));
  const files = [...M.knowledgeWorkspaceFiles(PACK, 'unrelated query', false), { path: 'PROJECT.md', content: '# Pilot' }, { path: 'PERSONA.md', content: 'AI role' }, { path: 'INSTRUCTIONS.md', content: '# Instructions' }, { path: 'WORKORDER.md', content: 'Review.' }, { path: 'RESULT.schema.json', content: '{}' }];
  for (const f of files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
  const follow = PACK.cards.at(-1);
  writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite', 'capability.json'), JSON.stringify({ gateway: `http://127.0.0.1:${server.address().port}`, project: 'p1', run: 'r1', expertId: PACK.expertId, token: TOKEN,
    expiresAt: Date.now() + 600_000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: M.CB_INFERENCE_MAX_CALLS }));
  const op = opinion([`[source:${src0.id}] initial card claim`]);
  RUN = { calls: [], model: (n) => n === 1 ? JSON.stringify({ action: 'knowledge', query: follow.match.join(' ') }) : JSON.stringify({ action: 'final', opinion: op, report: '# Report\nok' }) };
  const code = await new Promise((resolve) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => { if (c) console.error(out, readFileSync(join(dir, 'out', 'error.txt'), 'utf8')); resolve(c); });
  });
  assert.equal(code, 0);
  const raw = readFileSync(join(dir, 'out', 'knowledge.json'), 'utf8');
  assert.equal(JSON.parse(raw).sourcePagesFetched, false);
  const p = M.buildEvidencePacket({ brief, expertId: PACK.expertId, opinion: op, audit: raw });
  assert.equal(p.binding, 'bound', p.bindingNote);
  const searched = JSON.parse(raw).retrievals.find((r) => r.reason === 'follow-up search');
  assert.ok(searched && searched.cardIds.length >= 1, 'the runner recorded a follow-up retrieval');
  for (const id of searched.cardIds) {
    const c = p.cards.find((x) => x.id === id);
    assert.ok(c && c.summary === PACK.cards.find((x) => x.id === id).summary && c.retrievalReasons.includes('follow-up search'), id);
  }
  assert.ok(p.cards.some((c) => c.id === card0.id && c.retrievalReasons.includes('initial selection')));
  assert.deepEqual(avail(p, 0), ['curated-card-text']);
  assert.ok(existsSync(join(dir, 'out', 'result.json')));
});
server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite evidence packet: ${count} checks passed`);
