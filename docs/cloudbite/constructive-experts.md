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
  up to three material concerns by priority, none is valid; each labeled missing information / observed adverse
  evidence / trade-off / actual constraint, with impact, a concrete change, the smallest proportionate check and what
  would change the view). The compare/recommend item now ends with one revised project proposal, labeled as a proposal.
- **Required evidence**: conditional recommendation only when *decisive* information is missing; unknowns are not
  failure evidence; optional detail is not a launch blocker; at most three decision-changing clarifying questions plus a
  reversible step meanwhile.
- **Boundaries**: no concern quota and no forced positive direction; nextActions actionable, detail in the report; any
  suggested threshold/customer/scope/example is a labeled proposal; at `discovery`, `design` and unstated stages no
  launch/go-no-go/sign-off gate and no invented numeric threshold; constructive framing never softens security,
  privacy, medical or other actual safety constraints, or the citation/source rules.
- **Validation stage**: pass/fail thresholds come from the success criteria or are labeled as proposed.
- **Perspective ownership**: when owned perspectives no longer fit the 8-item limit, they collapse into one item that
  keeps every perspective name (previously the overflow was dropped).

Unchanged: the six-field opinion, `ASSIGNMENT_LIMITS`, `CB_RUNNER_ROUNDS` (6), `CB_RUNNER_REPAIRS` (2),
`CB_INFERENCE_MAX_CALLS` (8), runner budget and diagnostics, citation, peer-review and language checks.

## Tests

`node test/cloudbite-v6-constructive.mjs` checks delivery only: the templates reach assignments for EN/KO × all six
stages × Jev/manual routes unclipped and within bounds, `WORKORDER.md` of generic, curated and STA roles, and the actual
`runner.py` system/user messages against a local fake gateway, with the saved `out/result.json` still exactly six fields.
It does not measure whether model answers become more constructive; that needs a separate quality evaluation.
