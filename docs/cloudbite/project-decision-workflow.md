# Project decision workflow

Cloudbite offers domain-specific advice on project choices, constraints and uncertainty. Opinion counts and self-assessed confidence are not calibrated probabilities or scientific validation.

## Use the console

1. Open `/cloudbite`, enter an objective, and optionally supply choices, constraints, facts, assumptions, unknowns and readable documents. Set the project stage and expert response language independently of the console KO/EN switch.
2. Let Jev select a team or choose roles manually. Prepare the live plan and inspect assignments, omitted perspectives and maximum sandbox/model-call counts. Manual preview provisions nothing; automatic team selection makes the disclosed Jev calls.
3. Start the frozen plan. Each expert receives a dedicated Daytona workspace, persona, knowledge pack and project-specific `WORKORDER.md`. Read original opinions and files. Failed experts never count as valid opinions.
4. Inspect evidence observations separately from confidence. Curated cards differ from original source pages; missing observations are unknown. Optional cross-review covers the disclosed subset of peers and cannot change their original opinions.
5. After the run and any cross-review finish, request one decision memo for a brief with choices. It compares the exact choices, preserves dissent and lists conditions, unknowns and input omissions. It is a derived interpretation. Network-uncertain attempts use read-only status checks rather than another paid request.
6. In authorized History, start a follow-up round, describe changes and choose roles to rerun. This is a new quota-counted project. Earlier opinions remain reference material and are excluded from fresh opinion totals.

## Limits and evidence

- Project budgets cover expert, cross-review and memo calls. Failed or uncertain outbound calls remain consumed. Preview counts are maxima, not a dollar price.
- Protected PMC import resolves PMCID/DOI identity and a supported licence through fixed official endpoints. Select bounded located excerpts deliberately; import does not certify a paper's correctness or relevance.
- The local quality evaluator consumes saved run JSON and a declared case. Structural checks and heuristics run locally; absent human judgments remain `NOT_SCORED`. Authored fixtures are not measured model accuracy.
- History access stays scoped to its actor. Deletion removes retained source data and does not reset a running project's paid budget.

## Development and operations

Run `npm install`, then `npm run dev` and open `http://localhost:8808/cloudbite`. Validate with `npm run check` and `npm run test:cloudbite`.

Live mode requires the existing Daytona, Nosana, TypeSafe and owner/visitor configuration. Use `npm run deploy` from a clean worktree containing current main and the currently deployed commit. The manual GitHub workflow also requires repository deployment credentials; installing it does not configure those secrets.

Contracts: [assignments](decision-workflow.md), [budget](project-budget.md), [retrieval](evidence-packets.md), [memo](decision-memo.md), [rounds](project-rounds.md), [PMC](pmc-import.md), [evaluation](quality-evaluation.md), [language](response-language.md), [console](workflow-ui.md), [deployment](deployment.md).
