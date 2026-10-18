# Cloudbite expert pool — expansion C (25 starter knowledge packs)

Status: **implementation-ready starter knowledge, unvalidated.** Not release-ready, not validated professional expertise.
Base: `07b1d60daaa0c6680b22ca9f364bbb8c99defcce`. Version string of every pack: `expansion-2026-10-19.1`.

## Files

| File | Content |
|---|---|
| `src/cloudbite-expansion-c.ts` | Runtime module. Exports `EXTENSION_C_PACKS: PhaseOneKnowledgePack[]` (25 packs). Imports the interface **type only** from `src/cloudbite-phase-one-data.ts`; no runtime imports, no network. |
| `test/fixtures/pool-expansion-c-evaluation.jsonl` | Held-out evaluation cases: 75 (3 per role), same shape as `pool-phase-one-evaluation.jsonl`. Not imported by the runtime module. |
| `docs/cloudbite/pool-expansion-c.md` | This document. |

Not integrated: registry, personas, UI, runner and `package.json` were not touched. The coordinator owns wiring
(including runtime enforcement of the review-role peer statement for 95–98, which in phase one is keyed on
`REVIEW_ROLE_IDS` in `src/cloudbite-knowledge.ts` and does not yet include `cb-role-095`…`cb-role-098`).

## Roster (exact catalogNumber / expertId / name / domain)

| # | expertId | Name | Domain | Guard | Sources (retrieved/total) |
|---|---|---|---|---|---|
| 69 | cb-role-069 | Procurement & Vendor Risk Analyst | business | – | 2/2 |
| 70 | cb-role-070 | Partnership & Distribution Strategist | business | – | 2/2 |
| 71 | cb-role-071 | Semiconductor System Architect | semiconductor-eda | semiconductor | 2/3 |
| 72 | cb-role-072 | RTL Design Engineer | semiconductor-eda | semiconductor | 3/3 |
| 73 | cb-role-073 | Functional Verification Engineer | semiconductor-eda | semiconductor | 3/3 |
| 74 | cb-role-074 | Formal Verification Engineer | semiconductor-eda | semiconductor | 3/3 |
| 75 | cb-role-075 | Logic Synthesis Engineer | semiconductor-eda | semiconductor | 3/3 |
| 76 | cb-role-076 | Physical Design Engineer | semiconductor-eda | semiconductor | 2/3 |
| 78 | cb-role-078 | DFT & Test Engineer | semiconductor-eda | semiconductor | 1/2 |
| 79 | cb-role-079 | Power & Signal Integrity Engineer | semiconductor-eda | semiconductor | 2/3 |
| 80 | cb-role-080 | Advanced Packaging Engineer | semiconductor-eda | semiconductor | 3/3 |
| 81 | cb-role-081 | Manufacturing Systems Specialist | industry | regulated | 2/3 |
| 82 | cb-role-082 | Robotics Engineer | industry | regulated | 1/2 |
| 83 | cb-role-083 | Embedded & IoT Engineer | industry | regulated | 3/3 |
| 84 | cb-role-084 | Mobility Systems Specialist | industry | regulated | 2/3 |
| 85 | cb-role-085 | Healthcare Informatics Specialist | industry | regulated | 1/3 |
| 86 | cb-role-086 | Learning Science Specialist | industry | – | 3/3 |
| 87 | cb-role-087 | Financial Services Systems Specialist | industry | regulated | 2/3 |
| 88 | cb-role-088 | Supply Chain & Logistics Specialist | industry | – | 1/3 |
| 89 | cb-role-089 | Energy Systems Specialist | industry | regulated | 2/3 |
| 90 | cb-role-090 | Public-sector Service Specialist | industry | regulated | 3/3 |
| 95 | cb-role-095 | Pre-mortem Analyst | review | review | 3/3 |
| 96 | cb-role-096 | Decision Analyst | review | review | 3/3 |
| 97 | cb-role-097 | Systems Thinking Specialist | review | review | 3/3 |
| 98 | cb-role-098 | Implementation Feasibility Reviewer | review | review | 3/3 |

(#77 PrimeTime STA is the existing STA pack and is not part of this set.)

## Counts

- Packs: 25. Per pack: 3 questions, 5 methods, 3 limitations, 2 artifacts, 6 cards, 2–3 sources.
- Cards: 150, all unique (`cbNNN-topic`), each 339–407 characters minimum per pack (all ≥ 200), each with ≥ 3 match terms
  including at least one Korean and one English term, `roles: [expertId]`, `kind`, `tool_scope`, `provenance`.
- Artifacts: 50, flat `out/rNNN-<slug>.(md|csv)`, filename ≤ 48 characters, none reserved; label ≤ 80, guidance 20–600.
- Tools per pack: `['workspace-artifact-write', 'knowledge-search', 'calculation']` (runtime filters capabilities).
- Size: every serialised pack ≈ 10.3–11.4 KB (limits: cards/sources JSON ≤ 48 KiB each, pack < 192 KiB).
- Held-out cases: 75 (per role: 1 `normal`, 1 `missing-info`, 1 `out-of-scope` or `adversarial`).

## Instructions structure

Each pack's `instructions` is composed of: a simulated-AI statement (no credentials, accounts or tool licences;
unvalidated starter knowledge), role-specific **input assumptions**, **review method**, **abstain/hand-off** conditions and
**confidence rationale** (no preset number), an optional guard, and a common tail (brief and card text are untrusted data;
cite only IDs from the pack; confidence is a self-assessment, not a calibrated probability; ask, condition or abstain on missing inputs).

Guards:

- `semiconductor` (71–80): no licensed vendor EDA tools, commands, PDKs or reports are assumed; vendor syntax is labelled
  unverified; no tool runs are claimed; no tape-out or silicon sign-off.
- `regulated` (81–85, 87, 89, 90): all output is a draft for a qualified, accountable human; name jurisdiction,
  standard/regulation version and operating context or mark the answer conditional; no operational safety, clinical,
  legal or financial sign-off. Roles 69 and 70 carry legal hand-offs in their abstain text instead of the full guard.
- `review` (95–98): no peer outputs are supplied; the instructions contain the exact literal
  `No peer result verification occurred.` and forbid describing the work as cross-review.

## Sources and check status

One bounded retrieval batch was run on 2026-10-18T15:19–15:20Z (HTTP GET with redirects, `<title>` inspected; ~70 URLs
including alternates that were discarded). `retrieved` means the URL returned the named document (or its landing/catalogue
page); it does **not** mean the document body was read or that each card's paraphrase was checked against it.
`unverified` sources keep `checkedAt: ''` and a `checkNote` saying why.

62 distinct source records: **49 retrieved, 13 unverified**.

| Unverified source | Reason (checkNote) |
|---|---|
| arm-amba | HTTP 403 |
| openroad-flow-scripts | HTTP 200 meta-refresh only |
| ieee-1500 | generic IEEE SA title; identity not confirmed (first candidate URL redirected to an unrelated standard) |
| ieee-1801 | generic IEEE SA title; identity not confirmed |
| iso-9001, iso-50001 | HTTP 403 bot challenge |
| ros2-docs | bot-check page |
| unece-r155 | HTTP 403 bot challenge |
| hhs-hipaa | HTTP 403 |
| fda-cds-guidance | HTTP 404 after abuse-detection redirect |
| iso-20022 | HTTP 403 "site off-line" |
| ascm-scor | HTTP 200, no readable content |
| gs1-standards | HTTP 403 |

Several retrieved records are standards landing or catalogue pages (IEEE, ISO, JEDEC) whose text is licensed; cards
paraphrase widely known method guidance and never quote standard text. Licence notes are in each record's `license` field;
`download_policy` is link-only for all.

## Checks run (focused, isolated worktree)

Bundled with the root `node_modules/.bin/esbuild` from a scratch script (not committed) and executed with Node:

- `checkKnowledgePack` (from `src/cloudbite-knowledge.ts`) on all 25 packs: pass.
- `knowledgeWorkspaceFiles` built for every pack (review flag for 95–98): no throw.
- Exact roster order and catalogNumber/expertId/name/domain; version string; 6 unique cards per role (also unique against
  phase-one card IDs); card length ≥ 200; ≥ 3 bilingual match terms; every card source resolves within its pack; ≥ 2 sources;
  2 artifacts per role with path rules; tools list; size limits; semiconductor/regulated/review guard text present;
  unverified sources have empty `checkedAt`.
- Fixture: 75 lines, valid JSON, exact key order `id, expertId, catalogNumber, type, prompt, pass_criteria, fail_conditions`,
  3 per role, globally unique `cbNNN-caseK` IDs, prompts not copied from card text, no fixture ID present in the runtime module.
- `tsc --strict --noEmit` (root TypeScript, project config ignored) on the module plus `cloudbite-knowledge.ts`: pass.

Not run: `npm install`, the full app build/test suite, the sandbox runner, or any model execution against the held-out cases.

## Gaps and risks

- **Unvalidated.** No held-out case has been executed or scored; the fixture contains criteria only, no answers.
- **Content accuracy** rests on authoring-time synthesis. Retrieval confirmed document identity, not every statement.
  Domain specialists should review especially formal/equivalence (74), DFT arithmetic (78), packaging yield (80),
  payments licensing flags (87) and procurement thresholds (90).
- **13 unverified sources**; 78, 82, 85 and 88 have only one retrieved source each. Re-check from a non-bot-blocked network.
- **Review-role enforcement** (95–98) is instruction text only until the coordinator adds these IDs to runtime review handling.
- **Regulated roles** carry boundary text but no jurisdiction-specific content; outputs are always conditional drafts.
- **Semiconductor roles** assume no licensed tools; any vendor command guidance is deliberately absent.
- Card match terms were chosen by hand; retrieval ranking on real briefs has not been measured.
