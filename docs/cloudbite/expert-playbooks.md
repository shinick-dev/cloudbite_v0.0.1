# Expert operating playbooks (product v7)

Each expert workspace now carries a project-authored operating playbook as the last section of its trusted
`WORKORDER.md`. The playbook says *how the role should work* on an ambiguous project: what it decides, which inputs
would change its advice, an ordered professional procedure, evidence to retrieve, how to use the runner's existing
tools, artifacts, handoffs and constructive remedies. It is guidance only: no opinion field, schema, threshold, tool,
call budget or workspace file was added, and nothing here measures or guarantees answer quality.

Source: `src/cloudbite-expert-playbooks.ts`. Wiring: `buildExpertWorkspace` in `src/cloudbite-personas.ts`.
Test: `node test/cloudbite-v7-playbooks.mjs`.

## Roles

| Playbook id | Roles | Focus |
|---|---|---|
| `sta-timing-closure-review` | `probably-primetime-sta` (PrimeTime STA Expert) | constraint validity, path decomposition, pessimism (CRPR, GBA/PBA, OCV derates), stage-based fix ladder |
| `rtl-microarchitecture-review` | `cb-role-072` RTL Design Engineer | synthesisability hazards, CDC/RDC mechanisms, reset and FSM safety, pipeline estimate |
| `synthesis-qor-review` | `cb-role-075` Logic Synthesis Engineer | constraint completeness, like-for-like baselines, QoR delta attribution, warning triage |
| `physical-closure-review` | `cb-role-076` Physical Design Engineer | floorplan, congestion, CTS, physical root cause, stage-based fixes |
| `biomedical-design-rigor-review` | `cb-role-101` Biomedical Research Methodologist | core reporting set, biological variables, resource authentication, claim-to-design map |
| `biostatistics-consistency-review` | `cb-role-105` Biomedical Biostatistician | recomputation with python, interval/P interpretation, multiplicity, missing data, subgroups |
| `evidence-synthesis-audit` | `cb-role-106` Systematic Review & Meta-analysis Specialist | protocol, PRISMA flow, risk-of-bias fit, heterogeneity, certainty alignment |
| `benchmark-curation-audit` | `cb-role-118` Research Integrity & Benchmark Curator | licence/provenance, mutant separation, abstention labels, adjudication independence |
| `generic-conservative` | every other role | restate, build the strongest feasible approach plus an alternative, label concerns, scoped recommendation |

The EDA catalogue ids were found by role name in `src/cloudbite-expansion-c.ts`; the research ids are the Falsify
research roles in `src/cloudbite-research-clinical.ts` and `src/cloudbite-research-biomedical.ts`.

## Contract

`version`, `id`, `expertIds`, `basis: project-authored`, `evaluation: unvalidated`, `decisionScope`, `minimumInputs`
(input, decision-changing question, what it changes), `procedure` (ordered), `evidence` (need + knowledge query),
`sourceIds`, `tools` (permitted existing tools plus an observation check), `artifacts`, `handoffs`, `remedies`.

- `sourceIds` are existing source records of the role's own pack (STA: `STA_PACK.sources`; others: the role's
  knowledge pack). They are records to retrieve before citing; naming them is not a citation and the existing
  `[source:ID]` retrieval rules still apply. No citation was invented and no corpus was downloaded.
- Tools are the runner's existing `knowledge`, `python` and `write` actions. The knowledge line and knowledge queries are
  rendered only for workspaces that have the knowledge action (metadata-derived roles do not).
- No playbook gives diagnosis, dosing or wet-lab steps, claims a tool run, or claims signoff.

## Rendering and trust

- The section is code-constant: no brief, decision, revision or document text enters it. Unknown brief fields
  (for example `playbook`) are dropped by `validateProjectBrief`, and caller-supplied persona objects are ignored.
- It is appended after the existing work order, assignment and decision rules, so prior text is unchanged.
- Headings and operating rules are EN/KO by `defaultResponseLanguage`; domain procedure text stays in English to keep
  professional terms exact. The existing response-language rule still governs the answer.
- Operating rules: retrieve missing evidence before calling it absent; label each concern unknown / adverse evidence /
  trade-off / constraint; compare at least two concrete alternatives; use python only when it helps and report its
  actual output; end with one actionable improvement and a verification trigger; ask only decision-changing questions
  and otherwise give provisional, scoped advice instead of blocking.
- `provenance.json` (curated and metadata roles) gains `playbook: { id, version, sha256, basis, evaluation,
  validated: false }`. The STA workspace has no `provenance.json`, so none is invented there; its work order shows the
  playbook id, version and hash prefix.

## Size

With the maximum brief, a three-option decision frame and a manual assignment in English or Korean, every pilot's
initial prompt files stay under the existing runner budget (`46 KiB − 4096`), and the actual `runner.py` request
stays within `CB_RUNNER_INFERENCE_MAX` with one call.
