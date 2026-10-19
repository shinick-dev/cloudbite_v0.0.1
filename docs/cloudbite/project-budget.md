# Cloudbite project budget (ITEM6)

`src/cloudbite-budget.ts` is a pure leaf (no storage, network or clock): a preflight **envelope** for one project and a
versioned, serializable **call ledger** (`BudgetUsage`) that the project Durable Object persists. Test:
`node test/cloudbite-budget.mjs`. Wiring the ledger into the DO, API and client belongs to the backend integrator; this
module changes no contract, API, DO, client or package file.

## What is counted

`ProjectBudget.maxModelCalls` (1–804) is the total of **every Nosana model call** of a project:

| phase | calls | where |
|---|---|---|
| expert | each runner `inference` turn, at most 8 per role (`CB_INFERENCE_MAX_CALLS`) | one Daytona sandbox per selected expert |
| review | one call per cross-review reviewer, at most 3 | server-side, no sandbox |
| memo | the decision memo call, at most 1 | server-side, no sandbox |

Jev routing (typesafe) makes 2 separate typed calls per plan (assessment, team review). They are **not** Nosana calls and
never count against `maxModelCalls`.

No dollar or token estimate is produced: no provider receipt or pricing is known (`plan.cost.estimate === null`).

## Caps

- **Default** (brief has no `budget`): `maxModelCalls = selectedCount × 8 + 3 + 1`, `maxExperts = 100`,
  `maxReviewCalls = 3`, `maxMemoCalls = 1`. At 100 experts this is exactly 804.
- **Stated** (`budget` present, all four fields required by `validateWorkflowData`): taken as given; it can only lower.
- `maxExperts` is the minimum of the stated value, `PROJECT_MAX_EXPERTS` and the effective cap the API passes in
  (`input.maxExperts`: visitor/operator/routing limits). A budget never raises a quota.
- Review and memo calls are **earmarked**: experts share `expertPool = maxModelCalls − maxReviewCalls − maxMemoCalls`.
- The per-role cap stays 8. Neither `selectedCount × 8` nor the cap guarantees any role 8 turns: with a smaller pool,
  earlier roles can use calls that later roles then lack.
- `maxReviewCalls: 0` / `maxMemoCalls: 0` disable that phase (`phase-disabled`).

## Preflight: `planProjectBudget(input): BudgetPlan`

```ts
planProjectBudget({ brief: { expertIds, budget? }, catalogue: runnableExperts, assignments?, maxExperts? })
```

Fails **before provisioning** (never trims) with `{ ok: false, reason, message }`:
`invalid-budget`, `no-experts`, `duplicate-expert`, `unsupported-expert` (not runnable here), `too-many-experts`,
`assignment-mismatch`, `budget-too-small` (pool < one call per selected expert).

On success: `caps`, `selectedCount`, `expertIds`, `maxSandboxes` (= selectedCount), `maxNosanaCalls` (truthful upper
bound: expert ≤ min(pool, n×8), review ≤ min(maxReview, n) and 0 for a single expert since cross-review needs two
opinions, memo ≤ maxMemo, all ≤ total), `phases`, `routing { typedCalls: 2, countedInModelCalls: false }`,
`cost { estimate: null }` and human-readable `notes` explaining the caps and possible exhaustion.

## Ledger

```ts
interface BudgetUsage { version: 'cloudbite-budget/v1'; caps: BudgetCaps; experts: Record<key, number>;
  reviewers: string[]; memo: number; total: number; rev: number; migrated?: true }
createBudgetUsage(plan, keys?)          // keys = expert ids (default) or run ids, one per selected expert
parseBudgetUsage(raw)                   // undefined for other versions, corrupt counts, total ≠ sum, > 16 KiB
reserveBudget(usage, req)               // immutable; never mutates usage
reserveBudgetBatch(usage, reqs)         // all-or-nothing (one cross-review claim's reviewers)
affordableReviewers(usage, keys)        // prefix the budget can still afford
expertCanContinue(usage, key)           // { ok } | { ok: false, reason, message }
budgetMetrics(usage) / publicBudget(usage)
migrateBudgetUsage(legacy)              // pre-budget projects
budgetDenialMessage(reason)
```

Requests: `{ phase: 'expert', key, seq }`, `{ phase: 'review', key }`, `{ phase: 'memo', seq }`. `seq` is the call
number about to be made (already reserved + 1).

Denials: `invalid-usage`, `unknown-expert`, `out-of-order`, `per-expert-cap`, `expert-phase-cap`, `review-phase-cap`,
`memo-phase-cap`, `phase-disabled`, `total-cap`.

### Rules the integrator must keep

1. **Reserve before outbound, atomically.** Inside one `ctx.storage.transaction`: read the stored ledger,
   `parseBudgetUsage`, `reserveBudget`, write the returned `usage` — and only after that write send the Nosana call.
   Never reserve from a copy read outside the transaction.
2. **No refund.** A reserved call counts even when the provider fails, times out or the response is lost. The module
   exports no refund/release/reset; a stored ledger whose counts went down fails `parseBudgetUsage` (total ≠ sum).
3. **Idempotent replays.** A callback handled again with the same `seq` (or the same reviewer key) returns
   `duplicate: true` and the same usage: do not send a second upstream call for it.
4. **Fail cleanly, never loop.** On a denial, a queued/running expert is finished or failed with
   `budgetDenialMessage(reason)` (the runner already stops at 429); review trims to `affordableReviewers` or is not
   started; memo is not started. Repeated attempts get the same denial.
5. **Fail closed.** A missing or unparsable ledger on a budgeted project is `invalid-usage`; do not recreate a fresh one.

### Migration of running projects

`migrateBudgetUsage({ brief, experts: [{ key, calls: int.calls }], crossReview?: storedCrossReviewRecord, memoClaimed? })`
takes caps from the brief (or defaults) and counts conservatively: an unreadable `int.calls` counts as 8, a value above
8 as 8, a stored cross-review claim counts its reviewers (all 3 when the list is unreadable), a claimed memo counts 1.
Nothing resets to zero; a ledger above its caps simply has nothing available. Result carries `migrated: true`.

### Public projection

`publicBudget` returns caps, per-key counts and `BudgetMetrics` (`total/expert/review/memo: { used, max, available,
exhausted }`, `exhausted`, `expertsExhausted`). It copies only those fields, so claims, tokens, capability or account
data on the stored record never reach the browser.
