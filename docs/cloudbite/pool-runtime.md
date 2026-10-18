# 100-role pool and phase-one knowledge runtime

Phase one of [`expert-pool-100.md`](expert-pool-100.md). It adds a catalogue of 100 planned roles and runs 20 of them with authored, source-linked knowledge packs. It does not add 100 validated specialists, cross-review, or new execution capacity: the per-project selection limit stays at 5, live concurrency and visitor quotas are unchanged, and every role remains an unvalidated T0 AI role.

## Runnable catalogue (25 roles)

`CLOUDBITE_EXPERTS` keeps the original 13 ids in their original order, then appends 12 new phase-one roles by plan number.

| Group | Ids | Basis |
|---|---|---|
| Original roles with a phase-one pack (8) | `agency-product-manager`, `agency-business-strategist`, `agency-specialized-pricing-analyst`, `agency-finance-fpa-analyst`, `agency-engineering-software-architect`, `agency-engineering-ai-engineer`, `agency-security-architect`, `agency-engineering-privacy-engineer` | `curated-knowledge`; runtime name, domain and registry pin (repository, path, commit) kept |
| Original metadata roles (4) | `agency-design-ux-architect`, `agency-marketing-growth-hacker`, `agency-operations-manager`, `agency-product-feedback-synthesizer` | `metadata-derived`, unchanged |
| STA pilot (1) | `probably-primetime-sta` | `curated-knowledge`, unchanged legacy path (50 cards / 120 sources exact-count check) |
| New phase-one roles (12) | `cb-customer-discovery`, `cb-ux-researcher`, `cb-human-ai-interaction`, `cb-knowledge-engineer`, `cb-model-evaluation`, `cb-sandbox-engineer`, `cb-finops`, `cb-evidence-auditor`, `cb-quantitative-reviewer`, `cb-assumption-auditor`, `cb-adversarial-reviewer`, `cb-synthesis-editor` | `curated-knowledge`; source path `src/cloudbite-phase-one-data.ts`, revision = first 40 hex of the pack's SHA-256 |

Pack content (role definition, cards, sources) is owned by `src/cloudbite-phase-one-data.ts`. The persona prompt embeds the pack version, the full pack SHA-256 and the cards SHA-256, so the existing history `promptHash` also changes for source-only metadata updates; history also records `basis` and `revision`.

## Optional bootstrap pool

`GET /api/cloudbite/bootstrap` adds `pool: ExpertPool` (`src/cloudbite-pool.ts`, version `expert-pool-100/2026-10-18`). Clients without the field keep the legacy expert list.

- `pool-001` … `pool-100` follow the plan numbers, names and ten categories (KO/EN labels).
- `availability: 'available'` only when `findExpert` resolves the mapped runtime id; `knowledge` is that expert's real `source.basis`. Everything else is `planned` with `knowledge: 'none'` and no `expertId`.
- 25 entries are available: the 20 phase-one numbers, STA at 77, and existing roles mapped as related scope at 14 (UX Architect), 65 (Growth Hacker), 67 (Operations Manager) and 99 (Feedback Synthesizer), each with a `mappingNote`.
- `evaluation` is `unvalidated` for every entry. Text is length-capped and the object is deep-frozen. No user data is included.
- `pool-NNN` ids are never expert ids: both the Worker gate and the project Durable Object reject them, and the 1–5 selection limit applies as before.

## Knowledge workspace and retrieval

For a phase-one role `buildExpertWorkspace` writes the usual files plus `KNOWLEDGE.md`, `knowledge/cards.json`, `knowledge/sources.json` and `knowledge/manifest.json` (`src/cloudbite-knowledge.ts`).

- Retrieval uses the STA weighted term matching but only over the role's own cards; with no match it falls back to the pack's first cards. Up to 4 cards are preselected, the `knowledge` action returns up to 3 more.
- Brief text is only the query. It is never written into a knowledge file, persona, work order or manifest.
- The manifest (`schema: cloudbite.knowledge/v1`) binds `expertId`, version, card/source counts, and SHA-256 of the exact uploaded `cards.json` and `sources.json` bytes, plus `validation: curated-unvalidated`, `evaluation: unvalidated`, `rawCorpusIncluded: false`, `evaluationCasesIncluded: false`.
- Packs are checked when the module loads: 1–64 cards, 1–128 sources, unique card ids, unique source ids and aliases (`[a-zA-Z0-9_-]`), every card source resolvable within the same pack.

## Sandbox runner

`load_knowledge` keeps the legacy STA branch. For a `cloudbite.knowledge/v1` manifest it:

1. refuses a pack whose `expertId` differs from the run capability's expert;
2. verifies both SHA-256 values (any byte change fails the run: `knowledge pack integrity check failed`);
3. checks counts against the manifest and the 64/128 bounds.

At `final`, every closed `[source:...]` token in the opinion or report is audited: an ID that is not 1-80 letters, digits, `_` or `-` (for example `[source: foo]`, `[source:]` or an over-long ID) is rejected as malformed, and a well-formed ID must have been retrieved in this run. Either way the final is rejected and the model may retry. Unlike STA, a phase-one role may answer without a citation. The six-file collection limit reserves result.json, report.md and knowledge.json; each pack therefore declares 1-3 role deliverables as flat `out/<name>.md|json|csv` paths, unique across roles and never a runtime-reserved file (`out/result.json`, `out/report.md`, `out/manifest.json`, `out/knowledge.json`); `checkKnowledgePack` refuses any other path, so every declared deliverable is one the runner's `write_file` can write and the server collects. `out/knowledge.json` records retrievals, used source records, hashes, `evaluation: unvalidated`, `sourcePagesFetched: false` and `peerResultsVerified: false`.

## Review roles and cross-review

`cb-evidence-auditor`, `cb-quantitative-reviewer`, `cb-assumption-auditor`, `cb-adversarial-reviewer` and `cb-synthesis-editor` run independently like every other role. No peer output is delivered to their workspaces, so the manifest sets `peerReview.peerInputsProvided: false` and the runner rejects a final report that does not contain `No peer result verification occurred.` Selecting a reviewer next to domain roles is not cross-review. This check is a literal substring test, not a semantic guarantee: the audit (`peerInputsProvided: false`, `peerResultsVerified: false`) describes which inputs the system provided, and the presence of the statement does not prove that the rest of the report is free of contradicting claims such as "I verified the pricing result". Reports from review roles should be read with that limitation in mind. A review pipeline that passes completed outputs to reviewers, with its own budget, remains a separate future phase.

## Checks

```
npx tsc --noEmit
node test/cloudbite-personas.mjs
node test/cloudbite-pool.mjs
node test/cloudbite-knowledge.mjs
node test/cloudbite-sta.mjs
node test/cloudbite-runtime.mjs
```

These tests cover structure, retrieval, integrity and runtime behaviour with a fake model. They do not measure answer quality or expertise.
