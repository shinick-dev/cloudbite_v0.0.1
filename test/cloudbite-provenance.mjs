// Cloudbite epistemic provenance: claim ledger, stable IDs, strict adoption, state restore, bounded rendering, memo context.
// Pure module test, no network or provider calls. Run: node test/cloudbite-provenance.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: { contents: "export * from './cloudbite-provenance'; export { memoMessages, memoSnapshot, parseMemoReply, CB_MEMO_PROVENANCE_MAX_BYTES } from './cloudbite-memo';", resolveDir: path.join(repo, 'src'), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
globalThis.fetch = () => { throw new Error('network is not allowed'); };

const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const CRITERIA = ['Onboarding feels clearly easier to new users', 'No serious regressions in existing flows'];
const brief = (over = {}) => ({ title: 'Onboarding redesign', objective: 'Decide whether to ship the new onboarding.', context: 'Pilot ran two weeks.', expertIds: ['ux', 'qa'],
  mode: 'live', requestId: 'prov-test-01', decision: { options: ['Ship now', 'Iterate first'], constraints: ['No new headcount'], successCriteria: [...CRITERIA],
    knownFacts: ['Pilot had 40 users [doc:doc-1]'], assumptions: ['Support can absorb tickets'], unknowns: ['Long-term retention'] },
  documents: [{ id: 'doc-1', name: 'pilot.md', content: 'pilot notes' }], ...over });
const op = (over = {}) => ({ direction: 'conditional', confidence: 70, summary: 'Ship if task completion holds.',
  evidence: ['Pilot completion was 76% [doc:doc-1]', 'Heuristic review [source:nng-heuristics] [doc:doc-9]'],
  assumptions: ['Pilot users are representative'], nextActions: ['Set success threshold: >=80% task completion', 'Add >=5 regression tests before launch'], ...over });
const experts = () => [{ expertId: 'ux', name: 'UX', opinion: op() }, { expertId: 'qa', name: 'QA', opinion: op({ direction: 'concern', summary: 'Regression risk is real.' }) }];
const catalogue = { ux: ['nng-heuristics'] };
const ledger = (b = brief(), e = experts(), o = { sourceCatalogue: catalogue }) => m.buildProvenanceLedger('proj-1', b, e, o);
const server = (over = {}) => ({ projectId: 'proj-1', actor: 'owner:session-abc', at: 1_760_000_000_000, ...over });
const bad = (r, re, message) => ok('invalid' in r && re.test(r.invalid), `${message} (${JSON.stringify(r)})`);
const find = (l, f) => l.claims.find(f);

// ── ledger: origins, exact user criteria, generated thresholds stay proposals, refs are availability only ──
{
  const b = deepFreeze(brief()), e = deepFreeze(experts());
  const l = m.buildProvenanceLedger('proj-1', b, e, { sourceCatalogue: catalogue });
  ok(l.version === 'cloudbite-provenance/v1' && /^ps-[0-9a-f]{16}$/.test(l.snapshot), 'versioned ledger with snapshot');
  const crit = l.claims.filter((c) => c.kind === 'success-criterion');
  ok(crit.length === 2 && crit.every((c, i) => c.text === CRITERIA[i] && c.origin === 'user-statement'), 'qualitative user success criteria kept exactly as user statements');
  const t80 = find(l, (c) => c.text.includes('>=80%') && c.expertId === 'ux'), t5 = find(l, (c) => c.text.includes('>=5 regression') && c.expertId === 'qa');
  ok(t80 && t5 && t80.origin === 'generated-opinion' && t80.kind === 'opinion-action' && t80.numericThresholdHint && t5.numericThresholdHint, 'generated thresholds are generated opinion claims with a lexical hint');
  const empty = m.emptyProvenanceState('proj-1');
  ok(m.claimStanding(t80, []) === 'generated-proposal' && m.claimStanding(crit[0], []) === 'user-stated', 'generated threshold stands as proposal, user criterion as user-stated');
  ok(!l.claims.some((c) => c.kind === 'success-criterion' && c.origin !== 'user-statement'), 'no generated text ever becomes a success criterion');
  const ev = find(l, (c) => c.expertId === 'ux' && c.kind === 'opinion-evidence' && c.index === 1);
  ok(ev.refs.length === 2 && ev.refs[0].availability === 'catalogue-listed' && ev.refs[1].availability === 'not-found', 'source tag = catalogue-listed, unknown doc = not-found');
  ok(find(l, (c) => c.kind === 'known-fact').refs[0].availability === 'supplied-document', 'user doc tag = supplied-document');
  ok(l.coverage.factsVerified === false && l.coverage.sourcesRetrieved === false, 'ledger never claims verification or retrieval');
  ok(new Set(l.claims.map((c) => c.id)).size === l.claims.length, 'ids unique');
  ok(JSON.stringify(m.buildProvenanceLedger('proj-1', b, e, { sourceCatalogue: catalogue })) === JSON.stringify(l), 'deterministic');
  ok(m.buildProvenanceLedger('proj-2', b, e).snapshot !== l.snapshot && m.buildProvenanceLedger('proj-2', b, e).claims[0].id === l.claims[0].id, 'claim ids content-bound; snapshot project-bound');
  const changed = ledger(brief(), [{ expertId: 'ux', name: 'UX', opinion: op({ nextActions: ['Set success threshold: >=85% task completion', 'Add >=5 regression tests before launch'] }) }, experts()[1]]);
  ok(changed.snapshot !== l.snapshot && !changed.claims.some((c) => c.id === t80.id) && changed.claims.some((c) => c.id === t5.id), 'changed text → new id and snapshot; unchanged claim keeps id');
  ok(JSON.stringify(empty) === JSON.stringify({ version: 'cloudbite-provenance/v1', projectId: 'proj-1', adoptions: [] }), 'empty state');
}

// ── adoption: strict, exact, server actor only ──
{
  const l = ledger(), s0 = m.emptyProvenanceState('proj-1');
  const t80 = find(l, (c) => c.text.includes('>=80%') && c.expertId === 'ux');
  const req = { claimId: t80.id, text: t80.text, snapshot: l.snapshot };
  const a = m.validateAdoption(l, s0, req, server());
  ok(!('invalid' in a) && a.actor === 'owner:session-abc' && a.at === 1_760_000_000_000 && a.meaning === 'user-adoption-not-verification', 'valid adoption carries server actor/time and its meaning');
  bad(m.validateAdoption(l, s0, { ...req, actor: 'admin' }, server()), /client may not set/, 'client actor refused');
  bad(m.validateAdoption(l, s0, { ...req, at: 1 }, server()), /client may not set/, 'client time refused');
  bad(m.validateAdoption(l, s0, { ...req, snapshot: 'ps-0000000000000000' }, server()), /stale/, 'stale snapshot');
  bad(m.validateAdoption(l, s0, { ...req, claimId: 'cl-0000000000000000' }, server()), /unknown claim/, 'unknown claim');
  bad(m.validateAdoption(l, s0, { ...req, claimId: 'x' }, server()), /no valid claim id/, 'malformed id');
  bad(m.validateAdoption(l, s0, { ...req, text: t80.text.replace('80', '60') }, server()), /exactly/, 'forged text');
  bad(m.validateAdoption(l, s0, { ...req, text: t80.text + ' ' }, server()), /exactly/, 'whitespace-altered text');
  bad(m.validateAdoption(l, s0, req, server({ projectId: 'proj-2' })), /another project/, 'cross-project replay');
  bad(m.validateAdoption(l, s0, req, server({ actor: '' })), /server adoption context/, 'missing server actor');
  bad(m.validateAdoption(l, s0, req, server({ at: Number.NaN })), /server adoption context/, 'bad server time');
  bad(m.validateAdoption(l, s0, req, undefined), /server adoption context/, 'no server context');
  bad(m.validateAdoption(l, s0, 'adopt', server()), /object/, 'non-object');
  const crit = find(l, (c) => c.kind === 'success-criterion');
  bad(m.validateAdoption(l, s0, { claimId: crit.id, text: crit.text, snapshot: l.snapshot }, server()), /only generated/, 'user statement not re-adoptable');
  const s1 = m.applyAdoption(deepFreeze(s0), a);
  ok(s0.adoptions.length === 0 && s1.adoptions.length === 1, 'apply is pure');
  bad(m.validateAdoption(l, s1, req, server()), /already adopted/, 'double adoption');
  assert.throws(() => m.applyAdoption(s1, a)); checks++;
  ok(m.claimStanding(t80, m.effectiveAdoptions(l, s1).active) === 'user-adopted', 'explicitly adopted claim stands as user-adopted');
  const t5 = find(l, (c) => c.text.includes('>=5 regression') && c.expertId === 'qa');
  ok(m.claimStanding(t5, m.effectiveAdoptions(l, s1).active) === 'generated-proposal', 'other threshold remains a proposal');

  // truncated generated claim cannot be adopted
  const long = 'Threshold >=90% ' + 'x'.repeat(m.CB_PROVENANCE_LIMITS.text + 50);
  const lt = ledger(brief(), [{ expertId: 'ux', opinion: op({ nextActions: [long] }) }]);
  const tc = find(lt, (c) => c.textTruncated);
  ok(tc && lt.coverage.textTruncated === 1, 'truncation disclosed');
  bad(m.validateAdoption(lt, m.emptyProvenanceState('proj-1'), { claimId: tc.id, text: tc.text, snapshot: lt.snapshot }, server()), /truncated/, 'truncated claim not adoptable');

  // stale adoption after inputs change gives no standing
  const l2 = ledger(brief(), [{ expertId: 'ux', opinion: op({ nextActions: ['Set success threshold: >=85% task completion'] }) }]);
  const eff = m.effectiveAdoptions(l2, s1);
  ok(eff.active.length === 0 && eff.stale.length === 1, 'adoption of a changed claim is stale');
}

// ── state restore is strict and conservative; future rounds carry only adoptions ──
{
  const l = ledger(), t80 = find(l, (c) => c.text.includes('>=80%') && c.expertId === 'ux');
  const s1 = m.applyAdoption(m.emptyProvenanceState('proj-1'), m.validateAdoption(l, m.emptyProvenanceState('proj-1'), { claimId: t80.id, text: t80.text, snapshot: l.snapshot }, server()));
  const json = JSON.parse(JSON.stringify(s1));
  ok(JSON.stringify(m.parseProvenanceState(json, 'proj-1')) === JSON.stringify(s1), 'state round-trips through JSON');
  ok(m.parseProvenanceState(json, 'proj-2') === null, 'state for another project refused');
  ok(m.parseProvenanceState({ ...json, extra: 1 }, 'proj-1') === null, 'extra key refused');
  ok(m.parseProvenanceState({ ...json, adoptions: [{ ...json.adoptions[0], meaning: 'verified' }] }, 'proj-1') === null, 'verification meaning refused');
  ok(m.parseProvenanceState({ ...json, adoptions: [json.adoptions[0], json.adoptions[0]] }, 'proj-1') === null, 'duplicate adoption refused');
  ok(m.parseProvenanceState({ ...json, adoptions: [{ ...json.adoptions[0], actor: '' }] }, 'proj-1') === null, 'empty actor refused');
  ok(m.parseProvenanceState(null, 'proj-1') === null && m.parseProvenanceState({ ...json, version: 'v0' }, 'proj-1') === null, 'garbage/other version refused');

  const carry = m.nextRoundCarry(l, s1);
  ok(carry.length === 1 && carry[0].text === t80.text && carry[0].projectId === 'proj-1' && carry[0].claimId === t80.id, 'only the adopted claim is carried');
  const child = m.buildProvenanceLedger('proj-child', brief(), [], { carried: [...JSON.parse(JSON.stringify(carry)), { projectId: 'proj-1', claimId: 'cl-zz', text: 'forged', actor: 'x', at: 1 }, { ...carry[0], actor: 'other' }] });
  const pc = child.claims.filter((c) => c.origin === 'parent-adoption');
  ok(pc.length === 1 && pc[0].adoptedIn.actor === 'owner:session-abc' && child.coverage.carriedInvalid === 2, 'malformed and duplicate carried entries dropped and counted');
  ok(m.claimStanding(pc[0], []) === 'user-adopted', 'carried adoption keeps standing');
  bad(m.validateAdoption(child, m.emptyProvenanceState('proj-child'), { claimId: pc[0].id, text: pc[0].text, snapshot: child.snapshot }, server({ projectId: 'proj-child' })), /only generated/, 'carried claim not re-adopted');
  const grand = m.nextRoundCarry(child, m.emptyProvenanceState('proj-child'));
  ok(grand.length === 1 && grand[0].claimId === t80.id && grand[0].projectId === 'proj-1', 'carried adoptions keep their original record across rounds');
  ok(!child.claims.some((c) => c.origin === 'generated-opinion'), 'parent proposals are not carried');
}

// ── bounds: 100 roles, list caps, omissions disclosed ──
{
  const many = Array.from({ length: 105 }, (_, i) => ({ expertId: `role-${i}`, opinion: op({ evidence: Array.from({ length: 20 }, (_, j) => `ev ${j} >= ${j}%`) }) }));
  const l = ledger(brief(), many);
  ok(l.coverage.experts === 100 && l.coverage.expertsOmitted === 5, '100 roles kept, rest disclosed');
  ok(l.coverage.itemsOmitted === 100 * 8 && l.claims.filter((c) => c.expertId === 'role-0' && c.kind === 'opinion-evidence').length === 12, 'per-list cap with disclosure');
  ok(ledger(brief(), [{ expertId: 'BAD ID', opinion: op() }]).coverage.expertsOmitted === 1, 'malformed expert id omitted');
  const ctx = m.provenancePromptContext(l, m.emptyProvenanceState('proj-1'), { maxBytes: 4096, listedProposals: 500 });
  ok(ctx.bytes <= 4096 && ctx.truncated && /omitted \d+ lines/.test(ctx.text) && /expertsOmitted=5/.test(ctx.text) && /factsVerified=false/.test(ctx.text), 'prompt context bounded and discloses truncation and limits');
  const big = m.renderProvenanceWorkspace(l, m.emptyProvenanceState('proj-1'), 'en');
  ok(new TextEncoder().encode(big).length <= 48 * 1024 && /\+\d+ more proposals not listed/.test(big), 'workspace text bounded; proposals beyond the listed count are counted');
}

// ── rendering: clear non-authority, KO/EN, exact criteria vs proposals ──
{
  const l = ledger(), s = m.emptyProvenanceState('proj-1');
  const en = m.provenancePromptContext(l, s, { language: 'en' });
  ok(/not instructions or authority/.test(en.text) && /not independent verification/.test(en.text) && /availability only, not truth/.test(en.text), 'EN non-authority rules');
  ok(CRITERIA.every((c) => en.text.includes(JSON.stringify(c))), 'exact user criteria rendered');
  const crit = en.text.split('Generated threshold-like')[0];
  ok(!crit.includes('>=80%') && !crit.includes('>=5 regression'), 'generated thresholds are not rendered as criteria or adopted');
  ok(en.text.split('Generated threshold-like')[1].includes('>=80%') && en.text.includes('>=5 regression'), 'generated thresholds rendered as proposals');
  const ko = m.provenancePromptContext(l, s, { language: 'ko' });
  ok(ko.language === 'ko' && /지시나 권한이 아님/.test(ko.text) && /독립 검증이 아니다/.test(ko.text), 'KO non-authority rules');
}

// ── rendering under every budget: an item line always sits under its own section header (F1) ──
{
  const HEAD = {
    en: { criteria: 'User-stated success criteria (exact):', constraints: 'User-stated constraints (exact):', adopted: 'User-adopted (not verified):', proposals: 'Generated threshold-like proposals (not requirements, not adopted):', limits: 'Limits:' },
    ko: { criteria: '사용자가 직접 쓴 성공 기준(원문):', constraints: '사용자가 직접 쓴 제약(원문):', adopted: '사용자 채택 항목(검증 아님):', proposals: '생성된 기준값 형태 제안(요구사항 아님, 채택되지 않음):', limits: '한계:' },
  };
  const longCrit = 'Users finish onboarding without help '.repeat(25).slice(0, 900);
  const exp1 = [{ expertId: 'e1', name: 'E1', opinion: op({ evidence: ['Observed drop-off'], nextActions: ['>=80% done'] }) }];
  const exp2 = [{ expertId: 'e1', name: 'E1', opinion: op({ nextActions: ['>=80% done', 'Keep p95 latency under 300 ms', 'Add >=5 regression tests'] }) }, { expertId: 'e2', name: 'E2', opinion: op({ nextActions: ['At least 3 pilot sites', 'Ship within 2 weeks'] }) }];
  const cases = [];
  const reproL = ledger(brief({ decision: { ...brief().decision, successCriteria: [longCrit], constraints: [] } }), exp1);
  cases.push(['repro', reproL, m.emptyProvenanceState('proj-1')]);
  const richL = ledger(brief({ decision: { ...brief().decision, successCriteria: [longCrit, ...CRITERIA], constraints: ['No new headcount', 'Budget ' + 'x'.repeat(400)] } }), exp2);
  let richS = m.emptyProvenanceState('proj-1');
  for (const c of richL.claims.filter((x) => x.origin === 'generated-opinion' && x.numericThresholdHint).slice(0, 2)) richS = m.applyAdoption(richS, m.validateAdoption(richL, richS, { claimId: c.id, text: c.text, snapshot: richL.snapshot }, server()));
  ok(richS.adoptions.length === 2, 'sweep fixture has adopted and generated threshold claims');
  cases.push(['rich-adopted', richL, richS], ['rich-none', richL, m.emptyProvenanceState('proj-1')]);
  const enc = new TextEncoder();
  let budgets = 0;
  for (const [name, l, s] of cases) {
    const active = m.effectiveAdoptions(l, s).active;
    const expected = (line) => {
      if (/^- \+\d+ more proposals not listed$/.test(line)) return 'proposals';
      const c = l.claims.find((x) => line.startsWith(`- ${x.id} `));
      assert.ok(c, `${name}: item line names a ledger claim: ${line.slice(0, 40)}`);
      const st = m.claimStanding(c, active);
      return st === 'user-adopted' ? 'adopted' : st === 'generated-proposal' ? 'proposals' : c.kind === 'success-criterion' ? 'criteria' : 'constraints';
    };
    for (const language of ['en', 'ko']) for (let max = 512; max < 4000; max++) {
      const ctx = m.provenancePromptContext(l, s, { language, maxBytes: max });
      const text = ctx.text, rows = text.split('\n');
      assert.ok(enc.encode(text).length === ctx.bytes && ctx.bytes <= max, `${name}/${language}/${max}: within budget`);
      assert.ok(rows[rows.length - 1].startsWith(HEAD[language].limits) && /factsVerified=false sourcesRetrieved=false$/.test(rows[rows.length - 1]), `${name}/${language}/${max}: limits line intact and last`);
      const headers = Object.entries(HEAD[language]).filter(([k]) => k !== 'limits');
      let current = null, seen = 0, markers = 0;
      for (const row of rows) {
        const h = headers.find(([, v]) => v === row);
        if (h) { current = h[0]; continue; }
        if (row.startsWith('- ')) { assert.equal(current, expected(row), `${name}/${language}/${max}: item under wrong header: ${row.slice(0, 50)}`); seen++; }
        const sm = /^\[omitted (\d+) more lines of this section for the byte budget\]$/.exec(row);
        if (sm) { assert.ok(current, `${name}/${language}/${max}: section marker has a header`); markers += +sm[1]; }
        if (row.startsWith('[omitted ') && row.includes(' in total ')) current = null;
      }
      const total = /\[omitted (\d+) lines in total for the byte budget(?:; sections omitted whole: ([a-z, ]+))?\]/.exec(text);
      assert.equal(ctx.truncated, ctx.omittedLines > 0 || !text.includes(language === 'en' ? 'not independent verification' : '독립 검증이 아니다'), `${name}/${language}/${max}: truncated flag honest`);
      assert.equal(!!total, ctx.omittedLines > 0, `${name}/${language}/${max}: omission disclosed iff lines omitted`);
      if (total) {
        assert.equal(+total[1], ctx.omittedLines, `${name}/${language}/${max}: disclosed count matches`);
        const wholeNames = total[2] ? total[2].split(', ') : [];
        assert.ok(markers + wholeNames.length <= ctx.omittedLines, `${name}/${language}/${max}: per-section markers do not over-count`);
        for (const k of wholeNames) assert.ok(!rows.includes(HEAD[language][k]), `${name}/${language}/${max}: section named omitted whole is absent`);
      }
      assert.ok(text.includes(language === 'en' ? 'never requirements' : '요구사항이 아니다'), `${name}/${language}/${max}: proposals-not-requirements rule kept`);
      budgets++;
    }
  }
  ok(budgets === 3 * 2 * 3488, 'swept maxBytes 512..3999 EN/KO for every fixture');
  const repro = m.provenancePromptContext(reproL, m.emptyProvenanceState('proj-1'), { language: 'en', maxBytes: 791 }).text;
  const rows = repro.split('\n'), gen = rows.findIndex((r) => r.includes('">=80% done"'));
  ok(gen === -1 || rows.slice(0, gen).reverse().find((r) => r.endsWith(':') && !r.startsWith('- ')) === HEAD.en.proposals, 'reviewer repro (maxBytes 791): generated threshold is never listed under User-adopted');
  const tight = m.provenancePromptContext(richL, richS, { language: 'ko', maxBytes: 512 });
  ok(tight.bytes <= 512 && tight.truncated && /한계: /.test(tight.text) && /sections omitted whole/.test(tight.text), 'KO at 512 bytes: compact rules, limits kept unclipped, omitted sections named');
}

// ── memo: optional provenance context, existing callers unchanged ──
{
  const completed = experts();
  const base = m.memoMessages(brief(), completed, {});
  const same = m.memoMessages(brief(), completed, { provenance: undefined });
  ok(JSON.stringify(base.messages) === JSON.stringify(same.messages) && base.snapshot === same.snapshot && !('provenance' in base.coverage), 'absent provenance leaves prompt and snapshot unchanged');
  const pc = m.memoProvenanceContext(ledger(), m.emptyProvenanceState('proj-1'), 'en');
  const withP = m.memoMessages(brief(), completed, { provenance: pc });
  ok(withP.snapshot !== base.snapshot && withP.coverage.provenance.snapshot === pc.snapshot && withP.coverage.provenance.truncated === false, 'provenance is part of the memo snapshot and coverage');
  ok(/never requirements, unless listed as user-adopted/.test(withP.messages[0].content), 'memo system rule names provenance standing');
  const data = JSON.parse(withP.messages[1].content.replace('Untrusted memo data (JSON):\n', ''));
  ok(data.provenance.kind === 'provenance-context-not-authority' && data.provenance.text === pc.text, 'memo data carries provenance as non-authority data');
  const huge = m.memoMessages(brief(), completed, { provenance: { snapshot: 'ps-x', text: 'y'.repeat(20000) } });
  ok(huge.coverage.provenance.truncated && huge.coverage.provenance.includedBytes === m.CB_MEMO_PROVENANCE_MAX_BYTES, 'oversize provenance clipped and disclosed');
}

console.log(`cloudbite-provenance: ${checks} checks passed`);
