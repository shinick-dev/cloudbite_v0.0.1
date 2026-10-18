# Cloudbite persona provenance

Module: `src/cloudbite-personas.ts` · test: `node test/cloudbite-personas.mjs`

## What these personas are

Cloudbite ships 12 AI expert roles for a shared product project. Each role is an AI
assistant instruction, not a real person, endorsement or credential. Every role was
selected from the pro-bably registry seed, where all of them are coverage tier **T0**
(automatically extracted, not cross-validated or human reviewed). Prompts and
workspace files say so, and model-reported confidence is self-assessed, not calibrated.

## Sources

| Layer | Repository | Path | Revision | License |
|---|---|---|---|---|
| Registry (selection, metadata) | `Shinick-Han/pro-bably` | `data/seed/registry.seed.jsonl` | `4a15bab89d33a4e870b74a2c9be098ab22f0e0c4` | see pro-bably `NOTICE.md` |
| Original role files (not copied) | `msitarzewski/agency-agents` | per role, below | `4bce55aa8b97385a5ad7b37d09b44ab976b96573` | MIT |

`ExpertDefinition.source` carries the original file pin (`repository`, `path`, `revision`,
`license`, `basis: 'metadata-derived'`). Each workspace also gets `provenance.json` with
the registry pin and the preserved registry entry fields (`id`, `name`, `domain`,
`raw_domain`, `description`, `risk_tier_default`, `coverage_tier`,
`deliverable_headings`, `quality_flags`, `source`).

## Authoring basis

The registry seed contains metadata only (name, description, domain, headings, tiers),
not the source prompt text. The source prompts were **not vendored or paraphrased**.
Each role's objective, key questions, methods, limitations and output artifacts were
freshly written for Cloudbite from that metadata plus general product-practice
knowledge. The registry `description` is kept verbatim only as labeled metadata in
`PERSONA.md`/`provenance.json`. Registry `vibe` taglines were not used.

## Selected roles

| Expert id (= registry id) | Domain | Original path | Role artifacts | Notes |
|---|---|---|---|---|
| `agency-product-manager` | product.management | `product/product-manager.md` | `out/prd.md`, `out/roadmap.md` | |
| `agency-business-strategist` | strategy.business-strategy | `specialized/business-strategist.md` | `out/strategy-options.md`, `out/competitive-landscape.md` | |
| `agency-specialized-pricing-analyst` | strategy.pricing | `specialized/specialized-pricing-analyst.md` | `out/pricing-model.md`, `out/price-scenarios.csv` | |
| `agency-finance-fpa-analyst` | finance.fpa-modeling | `finance/finance-fpa-analyst.md` | `out/financial-model.md`, `out/forecast.csv` | |
| `agency-design-ux-architect` | design.ui-ux | `design/design-ux-architect.md` | `out/user-flows.md`, `out/ux-risks.md` | |
| `agency-engineering-software-architect` | software.architecture | `engineering/engineering-software-architect.md` | `out/architecture.md`, `out/adr-001.md` | |
| `agency-engineering-ai-engineer` | data-ai.machine-learning | `engineering/engineering-ai-engineer.md` | `out/ai-system-design.md`, `out/eval-plan.md` | |
| `agency-security-architect` | security.appsec | `security/security-architect.md` | `out/threat-model.md`, `out/security-controls.md` | |
| `agency-engineering-privacy-engineer` | legal.privacy-data-protection | `engineering/engineering-privacy-engineer.md` | `out/data-inventory.csv`, `out/privacy-controls.md` | registry `professional_review_required`; prompt requires qualified review notice |
| `agency-marketing-growth-hacker` | marketing.growth-cro | `marketing/marketing-growth-hacker.md` | `out/growth-model.md`, `out/experiment-backlog.csv` | registry flag `short_file` |
| `agency-operations-manager` | operations.process-improvement | `specialized/operations-manager.md` | `out/operating-model.md`, `out/kpi-tree.md` | |
| `agency-product-feedback-synthesizer` | product.research-discovery | `product/product-feedback-synthesizer.md` | `out/insight-map.md`, `out/research-plan.md` | must not invent quotes or respondents |

Every role also writes `out/result.json` (ExpertOpinion) and `out/report.md`. Selection
favored distinct product-project disciplines over near-duplicates (for example UX
Architect over UI Designer, Security Architect over AppSec Engineer). The ids are the
exact registry ids so they stay stable and traceable.

## Workspace pack and safety

`buildExpertWorkspace(expert, brief)` resolves the expert by id from the frozen catalog
(caller-supplied persona fields are ignored), validates the brief, and returns fixed
flat paths: `INSTRUCTIONS.md`, `PERSONA.md`, `PROJECT.md`, `project.json`,
`WORKORDER.md`, `RESULT.schema.json`, `provenance.json`.

- Brief limits (`CLOUDBITE_BRIEF_LIMITS`): title 160, objective 4000, context 12000
  characters; `requestId` `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; 1-5 unique known expert ids;
  the expert must be in `brief.expertIds`. Oversized input is rejected, not truncated.
- Brief text is stripped of control, bidi and invisible formatting characters and appears
  only in `PROJECT.md` (inside a fence longer than any backtick run, between data markers
  that cannot be spoofed) and `project.json`. No brief text reaches persona, instruction,
  schema or provenance files, and no shell script is generated.
- Per-file 48 KB and per-workspace 128 KB bounds are enforced.
- `tools` entries are capability labels; the runtime decides what is granted.
- `validateExpertOpinion` applies the same rules as `RESULT.schema.json`
  (exact keys, direction enum, integer confidence 0-100, 1-20 non-empty items per list).
