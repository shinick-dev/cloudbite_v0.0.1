# Constructive expert instructions (product v6)

User-approved priorities, in order: (1) constructive criticism with concrete repairs, (2) clarification of sparse input,
(3) one revised project proposal. These are **prompt instructions only**. No opinion field, schema, check or score was
added, and nothing here guarantees answer quality.

## Where the guidance lives

| Route | Carrier | Language |
|---|---|---|
| Every role, every route (incl. no assignment, STA) | `CONSTRUCTIVE_RULES` appended to the runner `SYSTEM` prompt (`src/cloudbite-runner.ts`) | English; the existing response-language rule still applies |
| Jev-routed and manual-scope assignments | `WORKORDER.md` → `## Assignment` (`src/cloudbite-workorders.ts`) | EN/KO templates |

Assignment changes:

- **Deliverables**: a constructive-concern item (start from the strongest feasible approach within stated constraints;
  in the compact final report lead with the one most consequential concern, labeled missing information / observed
  adverse evidence / trade-off / actual constraint, with impact, a concrete change, the smallest proportionate check and
  what would change the view; up to two more only if they fit; none is valid). The compare/recommend item now ends with
  one revised project proposal, labeled as a proposal.
- **Required evidence**: conditional recommendation only when *decisive* information is missing; unknowns are not
  failure evidence; optional detail is not a launch blocker; at most three decision-changing clarifying questions plus a
  reversible step meanwhile.
- **Boundaries**: no concern quota and no forced positive direction; nextActions actionable; optional fuller detail
  may go to `out/constructive-plan.md` before the final, which must stand alone; any suggested
  threshold/customer/scope/example is a labeled proposal; at `discovery`, `design` and unstated stages no
  launch/go-no-go/sign-off gate or numeric threshold is invented or imposed merely because detail is absent, user-stated
  requirements are kept, and an unstated stage is not called early; constructive framing never softens security,
  privacy, medical or other actual safety constraints, or the citation/source rules.
- **Validation stage**: pass/fail thresholds come from the success criteria or are labeled as proposed.
- **Perspective ownership**: when owned perspectives no longer fit the 8-item limit, they collapse into one item that
  keeps every perspective name (previously the overflow was dropped).

Compact-final budget: `BUDGET_RULES` (final report under 100 words, whole reply under 2500 characters) is unchanged,
so the system rules ask for the single most consequential concern in the final and further concerns only if they fit.
`out/constructive-plan.md` is an ordinary optional supporting artifact (existing `write` action, same turns and
tokens); nothing requires it, no extra call is added, and citation validation still applies to the final.

Unchanged: the six-field opinion, `ASSIGNMENT_LIMITS`, `CB_RUNNER_ROUNDS` (6), `CB_RUNNER_REPAIRS` (2),
`CB_INFERENCE_MAX_CALLS` (8), runner budget and diagnostics, citation, peer-review and language checks.

## Tests

`node test/cloudbite-v6-constructive.mjs` checks delivery only: the templates reach assignments for EN/KO × all six
stages × Jev/manual routes unclipped and within bounds, `WORKORDER.md` of generic, curated and STA roles, and the actual
`runner.py` system/user messages against a local fake gateway, with the saved `out/result.json` still exactly six fields.
It does not measure whether model answers become more constructive; that needs a separate quality evaluation.
