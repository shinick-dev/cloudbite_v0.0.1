# Final decision memo (leaf module)

`src/cloudbite-memo.ts` defines the typed final decision memo and option comparison. It is a **pure leaf**: input plan, snapshot, budgeted prompt, strict reply parser, coverage and stored-state transitions. It makes no provider call, has no storage, clock or network, and changes no contract, API, DO or client. The project DO integrates it later and owns execution, the persisted one-attempt claim, authentication, budget and storage.

Test: `node test/cloudbite-memo.mjs` (pure, no network).

## What the memo is — and is not

- A **derived interpretation** of the supplied material, labelled `basis: 'derived-interpretation'` and `confidence: 'not-calibrated'`. It has no memo confidence or accuracy score; experts' `selfAssessedConfidence` is passed as their own unverified number and never aggregated.
- Original experts stated a **direction toward the brief** (`support`/`conditional`/`concern`/`abstain`), not a choice among options. The prompt forbids claiming that an expert voted for or chose an option unless the expert's own text says so; the parser rejects vote/consensus/unanimity wording (EN and KO) outright. Contradictory directions are counted as stated (`coverage.statedDirections`) and belong in `dissent`.
- Coverage is **computed by code**, not reported by the model: selected team size vs completed (honest denominator, e.g. 1/100), per-expert included evidence indices and truncation, document/brief/review/packet truncation and omissions, and fixed `fullReportsReviewed: false`, `sourcePagesReviewed: false`.

## Inputs and source kinds

`memoMessages(brief, completed, { team?, reviews?, packets?, responseLanguage? })`

| Data | Kind told to the model |
|---|---|
| `brief.*` (objective, context, options, constraints, …) | the user's own statement, unverified |
| `brief.documents` | actual user-supplied excerpts (fair-share truncated) |
| `completed[]` | finished original opinions (read, never modified) |
| `reviews[]` (`CrossReviewReport`) | one reviewer's reading, not verification |
| `packets[]` `document-excerpt` / `source-excerpt` | actual excerpts |
| `packets[]` `source-metadata` | curated source metadata **without text**: `originalText: 'absent'` |

Packets are validated (`validateMemoPacket`): exact keys, id `[a-z0-9-]`, metadata packets may not carry text; invalid/duplicate ones are counted in `coverage.packets.invalid`, at most 24 are used and the rest are counted as omitted.

All text sits in one user message as JSON data; the system message says it is never an instruction and forbids tools, code and links.

## Options and the no-options path

Option ids are `option-1..N` in `brief.decision.options` order (`decisionOptionIds`). With no options, `memoMessages` returns a deterministic `{ kind: 'needs-options' }` (no prompt, no paid call, no invented A/B). With no completed opinion, `memoPlan` returns `no-opinions` and `memoMessages` throws; check `memoPlan` first.

## Budgets

- Prompt: all message contents ≤ `CB_MEMO_PROMPT_MAX_BYTES` = 160 KiB UTF-8, inside `CB_INFERENCE_BODY_MAX` (256 KiB). Worst case (100 maxed Korean opinions, maxed brief/decision, 6 documents, 3×6 review findings, 30 packets) measures 153,121 B (≈ 150 KiB).
- Each section has its own byte budget (`CB_MEMO_BUDGET`) and is **fair-shared**: every expert gets the same share of 80 KiB (≤ 3 KiB each), measured on the serialized entry including JSON overhead, so the first experts cannot crowd out the rest. Truncation never splits a UTF-8 code point.
- Reply: ≤ `CB_MEMO_LIMITS.reply` = 8000 characters, summary/rationale ≤ 1000, each claim ≤ 280, list sizes bounded. Output budget `CB_MEMO_MAX_TOKENS` = 8192, carried on the prompt as `maxTokens`.

## Strict reply

```json
{"summary": "...",
 "recommendation": {"status": "recommend|no-recommendation", "optionIds": ["option-2"], "rationale": "...", "expertIds": ["…"], "refs": ["ev:<expertId>:<i>"]},
 "options": [{"optionId": "option-1", "benefits": [claim], "risks": [claim], "conditions": [claim]}],
 "dissent": [claim], "criticalUnknowns": [claim], "changeTriggers": [claim], "nextActions": [claim]}
```

`claim = {"text", "expertIds", "refs"}`. Refs: `ev:<expertId>:<evidenceIndex>` (only indices actually included), `doc:<doc-n>`, `pkt:<id>`, `rev:<reviewerExpertId>:<findingIndex>`, `brief:<field>`. `parseMemoReply(reply, prompt)` rejects the whole memo on any deviation: non-JSON, extra/missing keys, invented or duplicate options, options not compared exactly once, unknown experts, references outside `prompt.allowed.refs`, oversize text/lists, duplicate claims, a recommendation without any expert or ref citation, ids inconsistent with status, vote/consensus wording, or the wrong language. Option text is attached by code from the brief. The reply is never echoed in errors.

## Language

Language = `responseLanguage` option, else `brief.responseLanguage`, else Hangul-in-objective (`defaultResponseLanguage`). `MEMO_LANGUAGE_INSTRUCTIONS.ko|en` is appended to the system message; quoted source originals stay in their language. `parseMemoReply(reply, prompt, { languageCheck })` accepts a `MemoLanguageCheck` hook for a later dedicated language worker; the default checks that summary + rationale are predominantly in the selected script.

## Snapshot and stored state

`memoSnapshot(...)` serializes all unclipped inputs (brief, opinions, team statuses, reviews, packets, language); `memoSnapshotHash` is SHA-256; `isMemoSnapshotCurrent` detects any mutation. A different snapshot is a different input, not a retry.

`ProjectMemo` (`version: 'cloudbite-memo/v1'`): `status` ∈ `idle | running | completed | failed | needs-options`, `attempts`, `snapshotHash`, `startedAt/completedAt`, `language`, `coverage`, `memo`, `reason`, `error`, `execution: 'server-nosana' | 'none'`. Transitions: `idleMemo`, `canStartMemo` (only an unattempted idle memo), `runningMemo` (persist **before** inference; `attempts: 1`), `completedMemo`, `failedMemo`, `needsOptionsMemo`, `settleStaleMemo` (a running attempt older than 5 min closes as failed, never reruns).

## Integration hooks still needed (outside this leaf)

1. `chatRequestBody` / `nosanaChat` always send `max_tokens: CB_INFERENCE_MAX_TOKENS` (1200); they need an optional `maxTokens` override so the DO can pass `prompt.maxTokens`. Without it a full memo would be cut at 1200 tokens and fail parsing.
2. Project DO: memo endpoint, `brief.budget.maxMemoCalls` gate, persisted claim via `runningMemo` before the call, `ProjectRun.memo?: ProjectMemo` in the contract, history deletion of the memo key.
3. `package.json` `test:cloudbite` should add `node test/cloudbite-memo.mjs`.

Language/snapshot update: the selected KO/EN rule applies to all generated narrative fields. The script heuristic ignores quoted originals/code/URLs, reports short ambiguous prose as unknown, and rejects only clear script mismatches. The agreement wording check is a narrow, negation- and uncertainty-aware heuristic: honest statements that no consensus or vote occurred, or that it is unclear, are allowed; quoted expert wording is ignored; proposed future votes in changeTriggers/nextActions are allowed. It is not semantic verification. Stage and revision enter both actual prompts and snapshots; operational budget/request identity remain documented exclusions. See response-language.md. Previous-round workspace text now enters the runner initial context as explicitly untrusted reference data.
