// Expert operating playbooks (product v7). Each playbook is project-authored, code-constant operating guidance for one
// group of roles: decision scope, decision-changing inputs, an ordered professional procedure, evidence to retrieve,
// permitted use of the runner's existing tools, artifacts, handoffs and constructive remedies. It is rendered as a
// trusted WORKORDER.md section, so the existing runner reads it in its initial context; no new workspace file, tool,
// call or threshold is added. Brief text never reaches a playbook. Playbooks are unvalidated: they describe how the
// role should work, not measured expertise, and the source ids they name are existing pack records to retrieve before
// citing, never citations by themselves.
import type { ResponseLanguage } from './cloudbite-contract';
import { sha256Hex } from './cloudbite-knowledge';

export interface PlaybookInput { input: string; question: string; changes: string }
export interface PlaybookEvidence { need: string; query: string }

export interface ExpertPlaybook {
  version: string;
  id: string;
  /** Roles this playbook applies to; empty for the generic fallback. */
  expertIds: readonly string[];
  basis: 'project-authored';
  evaluation: 'unvalidated';
  decisionScope: string;
  minimumInputs: readonly PlaybookInput[];
  procedure: readonly string[];
  evidence: readonly PlaybookEvidence[];
  /** Existing source record ids of the role's own pack; retrieve before citing. */
  sourceIds: readonly string[];
  tools: readonly string[];
  artifacts: readonly string[];
  handoffs: readonly string[];
  remedies: readonly string[];
}

const VERSION = '2026-10-19.v7.1';
const STA_ID = 'probably-primetime-sta';

const STA: ExpertPlaybook = {
  version: VERSION, id: 'sta-timing-closure-review', expertIds: [STA_ID], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether reported setup/hold/DRV timing per mode and corner can be trusted, what limits it, and the cheapest safe next step toward closure. Not signoff.',
  minimumInputs: [
    { input: 'Worst path reports', question: 'Full worst setup and hold paths (clock edges, latency, CRPR, per-stage delays)?', changes: 'separates constraint artefacts or pessimism from real path problems.' },
    { input: 'Analysis settings', question: 'Which modes/corners, ideal or propagated clocks, GBA or PBA, which OCV/AOCV/POCV derates?', changes: 'pessimism removal can move slack with no design change.' },
    { input: 'Constraint status', question: 'Generated clocks, I/O delays, clock groups, exceptions complete? Unconstrained endpoints?', changes: 'identifies which reported paths lack a justified constraint basis.' },
    { input: 'Flow stage', question: 'Pre-CTS, post-CTS, post-route with SPEF, or late ECO?', changes: 'which fixes are still cheap and which numbers are estimates.' },
  ],
  procedure: [
    'Record engine, MMMC set, clock propagation, parasitics source and derate style; mark each stated or unknown.',
    'Validate constraints first: clocks (generated, virtual), I/O delays versus interface budget, clock groups, and design intent behind every false/multicycle path.',
    'Decompose the worst path: launch/capture edges and period, latency, skew, uncertainty, CRPR credit, cell versus net delay, transition and crosstalk delta.',
    'Classify the limiter with its observation: constraint artefact, pessimism (GBA/PBA, derate), clock, logic depth, placement/wire or SI.',
    'Check the opposite check type across corners: a setup fix\'s hold impact and vice versa.',
    'Rank fixes by stage: constraint correction, justified PBA, sizing/VT/buffer ECO, useful skew, then restructure or pipeline (handoff).',
  ],
  evidence: [
    { need: 'Exceptions and clock relations', query: 'false path multicycle path clock groups generated clock' },
    { need: 'Pessimism and variation', query: 'CRPR PBA GBA OCV AOCV derate' },
    { need: 'SI and ECO options', query: 'crosstalk delta delay timing ECO hold fix' },
  ],
  sourceIds: ['constraints-002', 'constraints-004', 'constraints-013', 'primetime-005', 'constraints-019'],
  tools: [
    'knowledge: retrieve cards before citing; cite [source:ID] only for records retrieved in this run.',
    'python: recompute slack arithmetic (required minus arrival, period minus uncertainty, delay sums) from transcribed report numbers.',
    'Observation check: with no supplied report say "no timing data observed"; never claim a PrimeTime or OpenSTA run.',
  ],
  artifacts: ['Optional out/timing-review.md: path decomposition, limiter class, fix ladder. Each slack traces to a supplied report or shown python result; each fix names the checks and corners it may hurt.'],
  handoffs: ['RTL (cb-role-072) for pipelining, synthesis (cb-role-075) for constraints/QoR, physical design (cb-role-076) for placement/CTS/route; signoff stays with the user\'s team and licensed tools.'],
  remedies: [
    'Constraints in doubt: constraint review (unconstrained endpoints, exceptions) before any ECO.',
    'Pessimism-dominated: PBA recheck of top failing paths instead of design changes.',
    'Post-CTS hold: evaluate buffering on relevant fast corners, then recheck setup/hold across prescribed scenarios.',
    'Logic depth: pipeline or retime; a multicycle exception only with functional justification.',
  ],
};

const RTL: ExpertPlaybook = {
  version: VERSION, id: 'rtl-microarchitecture-review', expertIds: ['cb-role-072'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether the RTL and microarchitecture will synthesise to the intended hardware and meet the frequency, latency and area intent, and whether every clock- and reset-domain crossing is safe. Not verification closure.',
  minimumInputs: [
    { input: 'Target clock and technology', question: 'What clock frequency and target (ASIC node or FPGA family) must this block meet?', changes: 'Sets the logic-level budget per stage and so the pipeline depth.' },
    { input: 'Clock and reset domains', question: 'Which clocks and resets drive the block, and which signals move between them?', changes: 'Decides which crossings need a synchroniser, handshake or async FIFO.' },
    { input: 'Interface contract', question: 'What latency, throughput and back-pressure must the interfaces keep?', changes: 'Bounds how many pipeline stages and buffers are acceptable.' },
  ],
  procedure: [
    'Inventory clocks, resets, interfaces and parameters from the supplied RTL or block description; mark what is missing.',
    'Synthesisability scan: latches from incomplete assignments, blocking/non-blocking misuse, simulation-only constructs, unintended priority chains, combinational loops.',
    'CDC/RDC inventory: per crossing record width and mechanism (two-flop synchroniser for single-bit levels, pulse synchroniser, handshake, async FIFO with Gray pointers for multi-bit data); flag multi-bit buses through plain synchronisers.',
    'Reset strategy: synchronous versus asynchronous-assert/synchronous-deassert, which flops need reset, reset fan-out and deassertion timing.',
    'FSM review: encoding, unreachable and illegal states, and recovery to a safe state.',
    'Pipeline estimate: logic levels times an assumed per-level delay against the period gives stages; state the latency and register cost, labelled as a first-order proposal.',
  ],
  evidence: [
    { need: 'Coding hazards', query: 'latch inference synthesisability hazards' },
    { need: 'Crossing mechanisms', query: 'clock domain crossing synchroniser reset domain crossing' },
    { need: 'FSM and pipeline guidance', query: 'FSM safe state pipeline stage estimate' },
  ],
  sourceIds: ['ieee-1800', 'ieee-1076', 'yosys-docs'],
  tools: [
    'knowledge: retrieve RTL cards before citing language-standard behaviour.',
    'python: pipeline-stage arithmetic or a Gray-code sequence check on stated widths; report the printed output.',
    'Observation check: without RTL text, review only the described structure and say so; never claim lint, CDC-tool or simulation results.',
  ],
  artifacts: [
    'Crossing table (signal, from, to, width, mechanism, status) in out/report.md or an optional out/rtl-review.md.',
    'Acceptance: each hazard points to supplied code or is labelled as a question; each crossing has a named mechanism or an explicit gap.',
  ],
  handoffs: [
    'Functional Verification Engineer (cb-role-073) for test and coverage plans.',
    'Formal Verification Engineer (cb-role-074) for properties on CDC handshakes and FSMs.',
    'Logic Synthesis Engineer (cb-role-075) and the STA role for timing numbers.',
  ],
  remedies: [
    'Multi-bit crossing: async FIFO (throughput) versus handshake (low rate) versus Gray-coded counter, with their latency cost.',
    'Deep combinational path: explicit pipeline stage versus retiming-friendly coding.',
    'FSM: one-hot for speed versus binary for area, with a default branch to a safe state.',
    'Register outputs at block boundaries so later timing closure stays local.',
  ],
};

const SYNTH: ExpertPlaybook = {
  version: VERSION, id: 'synthesis-qor-review', expertIds: ['cb-role-075'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether the synthesis constraints and settings make the reported QoR meaningful, why area, power or slack changed between runs, and which synthesis warnings are design bugs.',
  minimumInputs: [
    { input: 'Constraint summary', question: 'Which clocks, generated clocks, I/O delays, loads and exceptions does the synthesis SDC define?', changes: 'Incomplete constraints make QoR comparisons unreliable.' },
    { input: 'Run-to-run differences', question: 'What changed between the two runs: RTL, constraints, settings, library/corner or tool version?', changes: 'Attribution needs one changed variable per comparison.' },
    { input: 'Reported QoR and warnings', question: 'Can you paste the area, WNS/TNS, cell count and warning summaries of both runs?', changes: 'Without numbers the delta cannot be attributed.' },
  ],
  procedure: [
    'Constraint completeness: every clock defined, I/O delays and driving cells/loads present, exceptions justified, no unconstrained paths.',
    'Baseline identity: same library, corner, wire-load or parasitic estimate and tool version; otherwise the comparison is not like for like.',
    'QoR delta attribution: list each changed variable and the metric it plausibly moved; flag deltas with no explaining change.',
    'Warning triage: inferred latches, removed constant or unloaded flops, unresolved references, multiple drivers and width mismatches are probable bugs; classify the rest as reviewed noise.',
    'Optimisation trade-offs: hierarchy flattening, retiming, area versus delay targets, multi-VT use, each with its cost.',
    'Pre-layout realism: label synthesis slack as an estimate that will move after placement; any margin you suggest is a labelled proposal.',
  ],
  evidence: [
    { need: 'Constraint checks', query: 'constraint completeness review synthesis' },
    { need: 'Delta attribution and warnings', query: 'QoR delta attribution synthesis warning triage' },
    { need: 'Limits of pre-layout numbers and open libraries', query: 'pre-layout timing realism library boundary' },
  ],
  sourceIds: ['yosys-docs', 'openroad-docs', 'skywater-pdk'],
  tools: [
    'knowledge: retrieve synthesis cards before citing tool behaviour.',
    'python: tabulate run-to-run deltas and percentages from supplied reports; report the printed table.',
    'Observation check: results on an open PDK (for example sky130) do not transfer to a licensed library; never claim a synthesis run.',
  ],
  artifacts: [
    'QoR delta table (metric, run A, run B, change, attributed cause, label) and a warning triage list.',
    'Acceptance: every attributed cause names the changed variable it rests on, or is labelled unknown.',
  ],
  handoffs: [
    'RTL Design Engineer (cb-role-072) for code-level fixes of real warnings.',
    'Physical Design Engineer (cb-role-076) once placement-based numbers exist.',
    'The STA role for multi-corner timing interpretation.',
  ],
  remedies: [
    'Rerun with exactly one variable changed to isolate a QoR regression.',
    'Add missing clocks and I/O constraints before tuning optimisation settings.',
    'Enable retiming or add a pipeline stage instead of over-tightening the clock target.',
    'Trade area for delay explicitly (multi-VT, sizing effort) with the power cost stated.',
  ],
};

const PD: ExpertPlaybook = {
  version: VERSION, id: 'physical-closure-review', expertIds: ['cb-role-076'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether the floorplan is likely to route and close timing, what physically causes a failing path, and which closure fix is cheapest and safest at the current flow stage.',
  minimumInputs: [
    { input: 'Floorplan facts', question: 'What are the core utilisation, aspect ratio, macro list and placement, and I/O pin placement?', changes: 'Decides whether the problem is the floorplan or later stages.' },
    { input: 'Congestion data', question: 'What global-route overflow or congestion hotspots were reported, and where?', changes: 'Distinguishes routing detours from logic depth.' },
    { input: 'Failing-path physical detail', question: 'For the worst path: cell versus wire delay share, placement distance, fanout and clock skew?', changes: 'Selects placement, buffering, CTS or RTL fixes.' },
    { input: 'Flow stage', question: 'Is the design at floorplan, placement, post-CTS or post-route?', changes: 'Bounds which fixes are still cheap.' },
  ],
  procedure: [
    'Floorplan sanity: utilisation against the routing layers available, macro channels and halos, pin placement relative to connected logic.',
    'Congestion diagnosis: locate overflow hotspots and attribute them (macro corners, high pin density cells, pin access, narrow channels).',
    'Clock tree review: skew, insertion delay, buffer count and non-default rules on clock nets.',
    'Failing-path root cause: compare wire delay share and placement distance with logic depth; check detours and skew.',
    'Fix ladder by stage: placement constraints or regions, buffering and sizing, useful skew, floorplan change, then RTL change (handoff).',
    'Keep IR drop, EM, DRC/LVS and parasitic signoff outside the advice unless results are supplied.',
  ],
  evidence: [
    { need: 'Floorplan and congestion practice', query: 'floorplan review congestion diagnosis utilisation' },
    { need: 'Clock tree quality', query: 'clock tree quality review skew' },
    { need: 'Stage-appropriate fixes', query: 'failing path root cause closure fix ladder' },
  ],
  sourceIds: ['openroad-docs', 'openroad-flow-scripts', 'skywater-pdk'],
  tools: [
    'knowledge: retrieve physical-design cards before citing flow behaviour.',
    'python: utilisation (cell area over core area) and wire-delay-share arithmetic from supplied numbers; report the printed result.',
    'Observation check: without layout reports, classify only from described symptoms and keep the advice provisional; never claim a place-and-route run.',
  ],
  artifacts: [
    'Root-cause table (path, wire share, distance, congestion, skew, class) and a fix ladder with the stage each fix belongs to.',
    'Acceptance: each class rests on a supplied number or is labelled as an assumption.',
  ],
  handoffs: [
    'The STA role for multi-corner signoff-style analysis.',
    'Logic Synthesis Engineer (cb-role-075) for netlist structure.',
    'Power & Signal Integrity Engineer (cb-role-079) for IR drop and EM.',
  ],
  remedies: [
    'Lower target utilisation or widen macro channels when congestion is floorplan-driven.',
    'Cell padding or partial placement blockages on pin-dense hotspots.',
    'Move macros toward the edge and re-pin I/O near the logic they connect to.',
    'A pipeline register on a long route versus repeated buffering, with the latency cost stated.',
  ],
};

const METHODOLOGIST: ExpertPlaybook = {
  version: VERSION, id: 'biomedical-design-rigor-review', expertIds: ['cb-role-101'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether the design reported in a biomedical document can support its main claim, and which missing design information must stay needs-review. Reviews documents only; no laboratory, animal or clinical procedure.',
  minimumInputs: [
    { input: 'Main claim and study type', question: 'What is the main claim and is the work in vitro, animal or human observational/interventional?', changes: 'Sets what strength of claim the design can carry.' },
    { input: 'Document text', question: 'Can you supply the methods and results text (or the relevant excerpt) rather than a summary?', changes: 'Silence can only be judged from the actual document.' },
    { input: 'Purpose of the review', question: 'Is this for your own study plan, a manuscript draft, or appraising someone else\'s paper?', changes: 'Changes whether remedies are design changes or reporting requests.' },
  ],
  procedure: [
    'Extract the main claim and its strength words (shows, suggests, causes) and the outcome it rests on.',
    'Core reporting set: randomisation, blinding, sample-size basis, and data handling (exclusions, outliers, stopping); mark each reported, silent or contradicted, with location.',
    'Scientific premise: is the prior evidence the claim builds on itself robust?',
    'Biological variables (sex, age, strain) and key resource authentication (cell lines, antibodies): reported or needs-review.',
    'Claim-to-design map: what the design can support (association, mechanism, efficacy) against what is claimed.',
    'Rank gaps by whether they could change the conclusion; silence is needs-review, not proof of a flaw.',
  ],
  evidence: [
    { need: 'Rigor areas', query: 'NIH rigor four areas scientific premise' },
    { need: 'Core reporting set', query: 'randomisation blinding sample size data exclusion' },
    { need: 'Variables, resources and claim strength', query: 'biological variables sex resource authentication claim strength' },
  ],
  sourceIds: ['nih-rigor-guidance', 'landis-2012', 'collins-tabak-2014', 'nih-reporting-principles', 'greenland-2016'],
  tools: [
    'knowledge: retrieve rigor cards before citing guidance.',
    'python: only arithmetic checks such as group sizes summing to the total; report the printed result.',
    'Observation check: an element absent from the supplied text is "not reported in the supplied text", never "not done".',
  ],
  artifacts: [
    'Design-element table (element, status, location, possible effect on the claim).',
    'Acceptance: each status quotes or locates supplied text; no protocol steps are given.',
  ],
  handoffs: [
    'Biomedical Biostatistician (cb-role-105) for recomputation and statistical interpretation.',
    'Systematic Review & Meta-analysis Specialist (cb-role-106) for evidence synthesis.',
    'Research Integrity & Benchmark Curator (cb-role-118) for integrity or benchmark questions.',
  ],
  remedies: [
    'Match claim wording to the design (association rather than mechanism) when the design cannot carry more.',
    'Prespecify exclusion and stopping rules, or report them as post hoc.',
    'Add blinded outcome assessment or say why blinding was not feasible.',
    'Replicate the key result in a second model or with sex as a variable, framed as a learning step.',
  ],
};

const BIOSTAT: ExpertPlaybook = {
  version: VERSION, id: 'biostatistics-consistency-review', expertIds: ['cb-role-105'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Which reported numbers reproduce from the numbers given, which statistical statements the data cannot support, and which analysis details are needed to resolve the rest. No fraud findings and no clinical interpretation.',
  minimumInputs: [
    { input: 'Reported numbers', question: 'Can you supply the tables with n, events, means/SDs, estimates, intervals and P values?', changes: 'Recomputation is only possible from actual numbers.' },
    { input: 'Primary analysis and estimand', question: 'What is the prespecified primary outcome, analysis set and handling of intercurrent events?', changes: 'Decides which sensitivity and missing-data analyses are aligned.' },
    { input: 'Comparison count', question: 'How many outcomes, time points and subgroups were tested, and was a correction prespecified?', changes: 'Changes how much weight a single P value can carry.' },
  ],
  procedure: [
    'Recompute percentages, totals and participant-flow counts; label each discrepancy rounding-plausible, unexplained or cannot-check.',
    'Check estimate, interval and P value consistency (ratio intervals symmetric on the log scale; P from estimate and standard error).',
    'Interpretation: no "no effect" from P above 0.05, no post hoc power as evidence, intervals read as compatible effect sizes.',
    'Multiplicity: count comparisons and check the prespecified correction or hierarchy.',
    'Missing data: amount per arm, assumed mechanism and method against the estimand; sensitivity analyses aligned to it.',
    'Subgroups: interaction evidence rather than separate P values; sample-size justification reproduced where inputs exist.',
  ],
  evidence: [
    { need: 'Recomputation and reporting', query: 'recomputation reported numbers participant flow' },
    { need: 'Interpretation of P values and intervals', query: 'P value confidence interval power interpretation' },
    { need: 'Multiplicity, missing data and subgroups', query: 'multiplicity missing data sensitivity analyses subgroup' },
  ],
  sourceIds: ['consort-2025-ee', 'greenland-2016', 'ich-e9', 'ich-e9-r1', 'landis-2012'],
  tools: [
    'knowledge: retrieve statistics cards before citing guidance.',
    'python: the primary tool here; stdlib math to recompute percentages, intervals and approximate P values from transcribed numbers; print inputs, outputs and the rounding tolerance used.',
    'Observation check: without individual data, models cannot be reproduced; say so instead of estimating them.',
  ],
  artifacts: [
    'Recomputation table (item, reported, recomputed, difference, tolerance, label), optionally in out/recomputation.md.',
    'Acceptance: every recomputed value comes from a shown python result; inconsistencies are labelled for author follow-up, never as misconduct.',
  ],
  handoffs: [
    'Biomedical Research Methodologist (cb-role-101) for design questions.',
    'Clinical Trial Methodologist (cb-role-103) for estimand definition.',
    'Systematic Review & Meta-analysis Specialist (cb-role-106) for pooling.',
  ],
  remedies: [
    'Report effect sizes with intervals instead of significance labels.',
    'Prespecify a testing hierarchy or correction for secondary outcomes.',
    'Use multiple imputation with a tipping-point or other sensitivity analysis matched to the estimand.',
    'Replace subgroup P values with an interaction estimate and interval.',
  ],
};

const SYSTEMATIC: ExpertPlaybook = {
  version: VERSION, id: 'evidence-synthesis-audit', expertIds: ['cb-role-106'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether a systematic review found, selected, appraised and combined studies auditably, and whether its conclusions respect heterogeneity and certainty. No clinical practice recommendation.',
  minimumInputs: [
    { input: 'Question and protocol', question: 'What is the review question (population, intervention, comparator, outcome) and was a protocol registered?', changes: 'Deviations can only be judged against a fixed protocol.' },
    { input: 'Search and selection records', question: 'Which databases, dates and search strings, and what are the PRISMA flow counts?', changes: 'Decides whether the evidence base is reproducible and complete.' },
    { input: 'Study-level results', question: 'Can you supply per-study estimates with intervals or standard errors?', changes: 'Allows heterogeneity and pooling to be checked rather than assumed.' },
  ],
  procedure: [
    'Compare the reported question and methods with the protocol or registration; list deviations.',
    'Search reproducibility: databases, dates, strings and grey literature.',
    'Reconcile PRISMA flow arithmetic (identified, duplicates removed, screened, excluded with reasons, included).',
    'Risk-of-bias tool fit by design (randomised versus non-randomised) and whether the synthesis uses the ratings.',
    'Pooling: clinical and methodological similarity, model choice, I-squared, tau-squared and a prediction interval; narrative synthesis when pooling is not justified.',
    'Small-study and reporting bias (funnel methods only with enough studies), outcome-level certainty downgrades, and conclusion alignment.',
  ],
  evidence: [
    { need: 'Reporting and flow', query: 'PRISMA 2020 flow protocol registration' },
    { need: 'Risk of bias and heterogeneity', query: 'risk of bias tool heterogeneity pooling' },
    { need: 'Certainty and reporting bias', query: 'certainty of evidence reporting bias conclusion alignment' },
  ],
  sourceIds: ['prisma-2020', 'cochrane-handbook', 'robins-i', 'grade-handbook', 'greenland-2016'],
  tools: [
    'knowledge: retrieve synthesis cards before citing methods.',
    'python: PRISMA arithmetic, I-squared from Q and degrees of freedom, inverse-variance pooling only from supplied study estimates; print the result.',
    'Observation check: never claim to have searched databases or confirmed that included studies exist.',
  ],
  artifacts: [
    'Flow reconciliation and per-outcome certainty table (outcome, studies, heterogeneity, downgrades, certainty, matching wording).',
    'Acceptance: each certainty statement names its downgrade reasons; pooled numbers come only from supplied data.',
  ],
  handoffs: [
    'Biomedical Biostatistician (cb-role-105) for statistical recomputation.',
    'Research Integrity & Benchmark Curator (cb-role-118) and the citation integrity role for retracted or unresolvable included studies.',
  ],
  remedies: [
    'Narrative or structured synthesis instead of pooling heterogeneous studies.',
    'Prespecified subgroup or meta-regression instead of post hoc splits.',
    'Leave-one-out and risk-of-bias-restricted sensitivity analyses.',
    'Conclusion wording matched to the certainty rating; a dated search update plan.',
  ],
};

const CURATOR: ExpertPlaybook = {
  version: VERSION, id: 'benchmark-curation-audit', expertIds: ['cb-role-118'], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'Whether an evidence-checking benchmark (for example Falsify) has lawful provenance, separated seeded errors, labels that allow abstention and adjudication independent of authorship. No misconduct findings about source authors.',
  minimumInputs: [
    { input: 'Corpus source and licences', question: 'Which corpus are items drawn from and which licence does each item carry?', changes: 'Decides which items can be redistributed or used commercially.' },
    { input: 'Item construction', question: 'Are errors seeded mutants, natural errors or both, and how are mutants marked and stored?', changes: 'Unmarked mutants risk being read as facts.' },
    { input: 'Labels and adjudication', question: 'What is the label set, is there a needs-review/abstain label, and who adjudicates?', changes: 'Determines whether scores can be interpreted.' },
  ],
  procedure: [
    'Per-item provenance: identifier, licence, retrieval record and date.',
    'Mutant construction: each seeded error marked, diffed against clean text, typed by error class and stored apart from clean items.',
    'Label taxonomy with abstention: missing evidence maps to needs-review, not false.',
    'Independence: item authors differ from adjudicators; double-label a sample and measure agreement.',
    'Leakage: held-out split and overlap with public or training data.',
    'Datasheet and FAIR release; ground truth from retrieved records, never model memory; scores reported as unvalidated unless actual scored runs are supplied.',
  ],
  evidence: [
    { need: 'Licence and provenance', query: 'corpus licence provenance open access subset' },
    { need: 'Mutants, labels and adjudication', query: 'seeded mutant separation label taxonomy abstention adjudication' },
    { need: 'Release and misconduct boundary', query: 'datasheet FAIR release misconduct boundary' },
  ],
  sourceIds: ['pmc-oa-subset', 'datasheets-for-datasets', 'go-fair-principles', 'ori-misconduct-definition', 'cope-retraction', 'crossref-rest-api'],
  tools: [
    'knowledge: retrieve curation cards before citing.',
    'python: agreement (Cohen\'s kappa) from a supplied confusion table, split counts, or a Wilson interval on accuracy only from supplied scored runs; print the result.',
    'Observation check: no access to the benchmark repository; audit only what is described or supplied.',
  ],
  artifacts: [
    'Curation audit table (control, status, evidence, gap) and an optional datasheet outline in out/datasheet-outline.md.',
    'Acceptance: no score is presented as validated; every licence statement names its source record or is labelled unknown.',
  ],
  handoffs: [
    'Biomedical Biostatistician (cb-role-105) for scoring statistics.',
    'Biomedical Research Methodologist (cb-role-101) for design-related item content.',
    'Scientific image and citation integrity roles for those error classes.',
  ],
  remedies: [
    'Pilot a small double-labelled item set before scaling.',
    'Keep seeded and natural errors in separate splits with their own scores.',
    'Add an abstain/needs-review label and score it separately.',
    'Filter the corpus to licences that permit the intended release; version the datasheet.',
  ],
};

const GENERIC: ExpertPlaybook = {
  version: VERSION, id: 'generic-conservative', expertIds: [], basis: 'project-authored', evaluation: 'unvalidated',
  decisionScope: 'The decision in the work order, judged only within this role\'s own questions.',
  minimumInputs: [
    { input: 'Decision and constraints', question: 'What exactly must be decided, and which constraints are fixed?', changes: 'Separates feasible options from excluded ones.' },
    { input: 'Success criteria', question: 'How will you judge that the result worked?', changes: 'Lets each option be compared against something stated.' },
  ],
  procedure: [
    'Restate the decision and separate user-stated facts, constraints and criteria from your assumptions.',
    'Build the strongest feasible approach and at least one concrete alternative.',
    'Compare them on the stated criteria; label each concern unknown, adverse evidence, trade-off or constraint.',
    'Recommend, scoped to what the evidence supports, with one improvement and the observation that would change it.',
  ],
  evidence: [{ need: 'Facts the recommendation depends on', query: 'role-specific terms for the decision' }],
  sourceIds: [],
  tools: [
    "knowledge: retrieve this role's cards before citing them.",
    'python: only for arithmetic on numbers supplied in the brief or documents; report the printed result.',
    'Observation check: never claim a test, measurement or tool run that did not happen in this workspace.',
  ],
  artifacts: ['Acceptance: every recommendation names the evidence or assumption it rests on.'],
  handoffs: ['Name dependencies on other selected roles instead of answering for them.'],
  remedies: ['Prefer a reversible, scoped step that tests the riskiest assumption over blocking the project.'],
};

const PILOTS: readonly ExpertPlaybook[] = [STA, RTL, SYNTH, PD, METHODOLOGIST, BIOSTAT, SYSTEMATIC, CURATOR];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value as object).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

export const EXPERT_PLAYBOOKS: readonly ExpertPlaybook[] = deepFreeze([...PILOTS, GENERIC]);
export const GENERIC_PLAYBOOK: ExpertPlaybook = GENERIC;
const BY_EXPERT = new Map<string, ExpertPlaybook>();
for (const playbook of PILOTS) for (const id of playbook.expertIds) {
  if (BY_EXPERT.has(id)) throw new Error('duplicate playbook role ' + id);
  BY_EXPERT.set(id, playbook);
}
const DIGEST = new Map(EXPERT_PLAYBOOKS.map(p => [p.id, sha256Hex(JSON.stringify(p))]));

/** The role's own playbook, or the conservative generic fallback. */
export function playbookFor(expertId: string): ExpertPlaybook {
  return BY_EXPERT.get(expertId) ?? GENERIC;
}

/** Metadata for provenance.json: identity and hash only, never a validation claim. */
export function playbookProvenance(playbook: ExpertPlaybook): Record<string, unknown> {
  return { id: playbook.id, version: playbook.version, sha256: DIGEST.get(playbook.id), basis: playbook.basis, evaluation: playbook.evaluation, validated: false };
}

interface SectionText {
  heading: string; meta(id: string, version: string, sha: string): string; scope: string;
  inputs: string; ask: string; changes: string; procedure: string; evidence: string; search: string; brief: string;
  records(ids: string): string; tools: string; artifacts: string; handoffs: string; remedies: string; rules: string;
  operating: readonly string[]; terms: string;
}

const EN: SectionText = {
  heading: '## Expert playbook',
  meta: (id, version, sha) => `Playbook \`${id}\` \`${version}\` (sha256 \`${sha}\`): project-authored, unvalidated operating procedure; not measured expertise and not evidence.`,
  scope: 'Decision scope',
  inputs: '### Decision-changing inputs (ask only if the answer changes the advice)',
  ask: 'ask', changes: 'changes',
  procedure: '### Procedure',
  evidence: '### Evidence to retrieve',
  search: 'search', brief: 'from PROJECT.md and supplied documents',
  records: ids => `Pack records to retrieve before citing: ${ids}`,
  tools: '### Tools and observation checks',
  artifacts: '### Artifacts and acceptance',
  handoffs: '### Handoffs',
  remedies: '### Remedies and alternatives',
  rules: '### Operating rules',
  operating: [
    'Retrieve missing evidence before calling it absent; label each concern unknown, adverse evidence, trade-off or constraint.',
    'Compare at least two concrete alternatives; use python only when it helps and report its actual output.',
    'End with one actionable improvement and a verification trigger; when inputs are missing give provisional, scoped advice instead of blocking.',
  ],
  terms: '',
};

const KO: SectionText = {
  heading: '## 전문가 플레이북',
  meta: (id, version, sha) => `플레이북 \`${id}\` \`${version}\` (sha256 \`${sha}\`): 프로젝트 작성·미검증 작업 절차이며, 측정된 전문성이나 증거가 아닙니다.`,
  scope: '결정 범위',
  inputs: '### 권고를 바꾸는 입력 (답이 조언을 바꿀 때만 질문)',
  ask: '질문', changes: '바뀌는 것',
  procedure: '### 절차',
  evidence: '### 확보할 증거',
  search: '검색', brief: 'PROJECT.md와 제공 문서에서',
  records: ids => `인용 전에 검색할 팩 기록: ${ids}`,
  tools: '### 도구와 관찰 점검',
  artifacts: '### 산출물과 수용 기준',
  handoffs: '### 인계',
  remedies: '### 개선안과 대안',
  rules: '### 작업 규칙',
  operating: [
    '빠진 증거는 먼저 찾고, 각 우려를 미지수·불리한 증거·트레이드오프·제약으로 표시하세요.',
    '구체적 대안을 둘 이상 비교하고, python은 도움이 될 때만 쓰며 실제 출력만 보고하세요.',
    '실행 가능한 개선안 하나와 검증 트리거로 끝내고, 입력이 부족하면 막지 말고 범위를 한정한 잠정 조언을 주세요.',
  ],
  terms: '도메인 절차는 전문 용어 보존을 위해 영어로 둡니다.',
};

const bullets = (items: readonly string[]) => items.map(item => `- ${item}`).join('\n');

/**
 * Trusted WORKORDER.md section for one role. Content is code-constant: no brief, decision or revision text enters it.
 * `knowledge` tells whether this workspace offers the knowledge action; without it, evidence comes from the brief.
 */
export function playbookWorkOrderSection(expertId: string, language: ResponseLanguage, options: { knowledge: boolean }): string {
  const p = playbookFor(expertId), t = language === 'ko' ? KO : EN;
  const tools = options.knowledge ? p.tools : p.tools.filter(tool => !tool.startsWith('knowledge:'));
  return [
    t.heading,
    '',
    t.meta(p.id, p.version, DIGEST.get(p.id)!.slice(0, 16)),
    ...(t.terms ? ['', t.terms] : []),
    '',
    `${t.scope}: ${p.decisionScope}`,
    '',
    t.inputs,
    '',
    bullets(p.minimumInputs.map(i => `${i.input} — ${t.ask}: ${i.question} — ${t.changes}: ${i.changes}`)),
    '',
    t.procedure,
    '',
    p.procedure.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    '',
    t.evidence,
    '',
    bullets(p.evidence.map(e => options.knowledge ? `${e.need} — ${t.search}: \`{"action":"knowledge","query":"${e.query}"}\`` : `${e.need} — ${t.brief}`)),
    ...(options.knowledge && p.sourceIds.length ? ['', t.records(p.sourceIds.map(id => `\`${id}\``).join(', '))] : []),
    '',
    t.tools,
    '',
    bullets(tools),
    '',
    t.artifacts,
    '',
    bullets(p.artifacts),
    '',
    t.handoffs,
    '',
    bullets(p.handoffs),
    '',
    t.remedies,
    '',
    bullets(p.remedies),
    '',
    t.rules,
    '',
    bullets(t.operating),
    '',
  ].join('\n');
}
