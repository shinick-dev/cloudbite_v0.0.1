# Project coaching (v6 memo mode)

Opt-in mode of the existing final decision memo (`src/cloudbite-memo.ts`). It turns a rough brief into one memo plus a
**constructive revised-project proposal**, on the same single paid memo call. Nothing here calls a provider; the project
DO owns execution, the one-attempt claim, budget and storage.

## Switch

`MemoInputOptions.coaching?: boolean` — default `false`.

| | legacy (`coaching` omitted/false) | coaching (`coaching: true`) |
|---|---|---|
| brief without options | `needs-options`, no paid call | `ready` with `optionIds: []` (no invented A/B) |
| prompt / snapshot | byte-identical to the previous revision | `mode: 'coaching'` in the snapshot, coaching rules and schema in the system message |
| `MemoPrompt.mode` | absent | `'coaching'` |
| reply | 7 memo keys, `coaching` key refused | 7 memo keys **plus required** `coaching` |
| memo limits | `CB_MEMO_LIMITS` | tighter `CB_MEMO_COACHING_LIMITS` (summary/rationale 600, claim 200, option lists 2, lists 4) so the coaching object fits the same 8000-character / 8192-token reply |

Because the snapshot carries the mode, a legacy memo and a coaching memo for the same inputs never share a snapshot
(`isMemoSnapshotCurrent` is false across modes). Old saved legacy snapshots and memos stay valid unchanged.

Missing decision frames or missing decision lists read as empty arrays. With no options the reply must have
`options: []` and `recommendation: {status: 'no-recommendation', optionIds: []}`; the rationale still cites an expert
or ref (`brief:objective` is always allowed).

## Contract (`src/cloudbite-coaching.ts`, `DecisionMemo.coaching?`)

```ts
{ version: 'cloudbite-coaching/v1',
  stance: 'proceed-with-scope' | 'clarify-first' | 'rework' | 'pause',
  viablePath: MemoClaim,
  repairs: Array<{ issue: MemoClaim, kind: 'unknown' | 'adverse-evidence' | 'tradeoff' | 'constraint',
                   priority: 'now' | 'next' | 'later', change: MemoClaim, check: MemoClaim, decisionTrigger: MemoClaim }>,
  revisedProject: { objective: MemoClaim, scope: MemoClaim, nextMilestone: MemoClaim },
  questions: MemoClaim[] }
```

`MemoClaim` is the existing memo claim: `{text, expertIds, refs}`; the model sends ref strings
(`ev:` `doc:` `pkt:` `rev:` `brief:`) and the parser stores typed `MemoReference` objects, exactly like memo claims.

Standing: every coaching object is **generated advice the user has not adopted** (`CB_COACHING_STANDING =
'generated-proposal-not-adopted'`). It is never written into the brief, its decision frame or provenance as user-adopted,
and nothing starts a follow-up from it. The UI should label it as a proposal.

## Strict parsing (whole memo rejected on any deviation — coaching is never silently dropped)

- exact keys at every level; fixed `version`, `stance`, `kind`, `priority` enums;
- `repairs` 0–3, ordered `now` → `next` → `later`, no duplicate issue; `questions` 0–3, no duplicates;
- every claim: text 1–200 characters, expertIds ⊆ finished experts (≤ 8), refs ⊆ `allowedRefs` (≤ 6), well-formed;
- `viablePath` and each repair `issue` cite at least one expertId or ref;
- `adverse-evidence` must cite an expert or supplied material other than the user's own `brief:unknowns` /
  `brief:assumptions` (missing evidence is not evidence against);
- `rework`/`pause` need at least one repair, `clarify-first` at least one question;
- the existing vote/consensus heuristic runs over coaching text (viablePath, issues, revisedProject, questions as
  assertions; change/check/decisionTrigger as proposals, where a proposed future vote is allowed);
- the language check (`memoNarrative`, `defaultMemoLanguageCheck`) includes every coaching text.

Prompt rules (not mechanically checkable): no cheerleading — keep substantive blockers; no invented investor, medical,
legal, market or customer proof, statistics, deadlines or hard numeric gates; reconcile conflicting requirements in one
revised objective/scope/milestone and name remaining tradeoffs; nextActions are prioritized constructive actions.

## Budget

Coaching rules and the wider schema (~2.2 KiB) are reserved out of the expert section, like review annotations, so a
maximum-shaped 100-role Korean project with source assessments, core claims, packets and provenance still builds within
`CB_MEMO_PROMPT_MAX_BYTES` (160 KiB). `CB_MEMO_MAX_TOKENS` (8192), `CB_MEMO_LIMITS.reply` (8000) and
`CB_MEMO_MAX_ATTEMPTS` (1) are unchanged.

## UI defaults and good parse fixture

Read `memo.coaching` only when present; a legacy memo has none. Suggested empty-state defaults for drawing:
`repairs: []` → "no repair proposed", `questions: []` → "no decision-changing question". Never show a confidence.

A reply the parser accepts for a thin brief (no decision frame) with experts `role-a..c` and one document `doc-1`
(from `test/cloudbite-v6-coaching.mjs`):

```json
{
  "summary": "Three of three selected experts finished. Directions differ: one support, one concern, one conditional. No decision options were listed, so no option is recommended.",
  "recommendation": { "status": "no-recommendation", "optionIds": [], "rationale": "The brief lists no options to compare; a scoped trial question must be answered first.", "expertIds": ["role-b"], "refs": ["brief:objective"] },
  "options": [],
  "dissent": [{ "text": "role-b is concerned that staff may resist new devices.", "expertIds": ["role-b"], "refs": [] }],
  "criticalUnknowns": [{ "text": "Which intake step is slowest is not stated.", "expertIds": [], "refs": ["doc:doc-1"] }],
  "changeTriggers": [{ "text": "A clinic agreeing to host a trial would make a concrete plan possible.", "expertIds": [], "refs": [] }],
  "nextActions": [
    { "text": "Pick one clinic and map its intake steps.", "expertIds": [], "refs": [] },
    { "text": "Interview two receptionists about the paper form.", "expertIds": ["role-a"], "refs": [] }
  ],
  "coaching": {
    "version": "cloudbite-coaching/v1",
    "stance": "clarify-first",
    "viablePath": { "text": "Narrow the idea to a paper-form replacement for one clinic and test it with front-desk staff first.", "expertIds": ["role-a", "role-c"], "refs": ["doc:doc-1"] },
    "repairs": [
      { "issue": { "text": "No supplied material says which clinic or which intake step is slowest.", "expertIds": [], "refs": ["brief:objective"] },
        "kind": "unknown", "priority": "now",
        "change": { "text": "Pick one clinic and map its current intake steps.", "expertIds": [], "refs": [] },
        "check": { "text": "A written step list with the slowest step marked.", "expertIds": [], "refs": [] },
        "decisionTrigger": { "text": "If the slowest step is not the form, rework the objective.", "expertIds": [], "refs": [] } },
      { "issue": { "text": "role-b raised a concern that staff may resist new devices.", "expertIds": ["role-b"], "refs": [] },
        "kind": "adverse-evidence", "priority": "next",
        "change": { "text": "Offer a paper fallback during the trial.", "expertIds": [], "refs": [] },
        "check": { "text": "Ask staff after the first week whether they kept using it.", "expertIds": [], "refs": [] },
        "decisionTrigger": { "text": "If staff stop using it, pause and revisit the device choice.", "expertIds": [], "refs": [] } }
    ],
    "revisedProject": {
      "objective": { "text": "Shorten intake at one clinic by replacing its paper form.", "expertIds": [], "refs": ["brief:objective"] },
      "scope": { "text": "One clinic, one form, front-desk use only; patient-facing features are out of scope for now (tradeoff: less reach, faster learning).", "expertIds": [], "refs": [] },
      "nextMilestone": { "text": "A clickable form prototype reviewed by two receptionists.", "expertIds": [], "refs": [] }
    },
    "questions": [
      { "text": "Which clinic can host a first trial?", "expertIds": [], "refs": [] },
      { "text": "Is the slow part the form itself or waiting for staff?", "expertIds": [], "refs": [] }
    ]
  }
}
```

The stored `DecisionMemo.coaching` has the same shape with each `refs` entry parsed, e.g. `"doc:doc-1"` →
`{ "kind": "document", "id": "doc-1" }`, `"brief:objective"` → `{ "kind": "brief", "field": "objective" }`.

## Limitations

- The language, vote/consensus and attribution checks are mechanical: an attributed but semantically wrong or
  overly optimistic claim is not caught. Invented proof or numeric gates are prohibited by prompt only.
- Worst-case lists at every cap can exceed the 8000-character reply bound; such a reply is rejected (no retry), so
  the prompt asks for short texts.
- DO wiring (`memoOptions.coaching: true`), storage and UI are outside this module.
