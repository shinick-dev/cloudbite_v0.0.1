# Response language (ko / en)

Shared module: `src/cloudbite-language.ts` (pure leaf). Used by the in-sandbox runner (`src/cloudbite-runner.ts`, as an embedded Python port), cross-review (`src/cloudbite-cross-review.ts`) and the decision memo (`src/cloudbite-memo.ts`).

Test: `node test/cloudbite-language.mjs` (runs the actual `runner.py` against a local fake gateway; needs Python 3; no provider network). Its output directories are new unique folders under `.artifacts/` and are left in place.

## Selected language

`defaultResponseLanguage(brief)` (in `cloudbite-workflow.ts`): the brief's optional `responseLanguage` (`ko` | `en`) when stated, else `ko` when the objective contains Hangul, else `en`. An explicit `en` wins over a Korean objective and vice versa. The persona's or instructions' own language (expert personas are written in English) never overrides the project's language.

- **Runner**: reads the workspace's `project.json` (already written by `buildExpertWorkspace` with the brief's `objective` and `responseLanguage`) and applies the same rule. A workspace without `project.json` keeps the earlier prompt: no language rule and no check.
- **Cross-review**: `defaultResponseLanguage(brief)` of the reviewed project.
- **Memo**: `memoLanguage` — the `responseLanguage` option, else the brief's rule.

## What must be in the selected language

Narrative only: the expert's `summary`, evidence explanations, `assumptions`, `nextActions` and report prose/headings; the reviewer's `summary` and each `rationale`; the memo's `summary`, `rationale` and every claim `text`. Quoted source originals, code, file paths, URLs, IDs, names, technical terms and citation/reference tokens (`[source:ID]`, `[doc:ID]`, `ev:…`, `option-N`) stay exactly as supplied. The server never translates, rewrites or repairs generated text; a wrong-language reply is rejected, not edited.

Every prompt names the language explicitly (`responseLanguageRule`, or `MEMO_LANGUAGE_INSTRUCTIONS` for the memo) and still contains the actual user objective as data. A prompt rule alone is never reported as language verification.

## The check — a simple deterministic script heuristic

`languageIntegrity(texts, language)` → `{ status: 'consistent' | 'mismatch' | 'unknown', basis: 'script-heuristic', hangul, latin }`.

1. Remove, in order: fenced code, inline code, URLs, `[source:…]`/`[doc:…]` citations, quoted spans (`"…"`, `“…”`, `「…」`, `『…』`, `«…»`), ID-like ASCII tokens (containing a digit, `_` or `:`), and acronyms/CamelCase names (two or more capitals: `STA`, `ECO`, `PrimeTime`).
2. Count Hangul characters `h` and Latin letters `l`; score = `3h + l` (one Hangul syllable ≈ three Latin letters).
3. score < 80 → `unknown` (too little narrative: short or code-only text). Never rejected.
4. Hangul share = `3h / score`. `ko`: share < 0.2 → `mismatch`. `en`: share > 0.6 → `mismatch`. Otherwise `consistent`.

This is not calibrated language identification and gives no confidence. It catches clearly wrong dominant script only. Korean answers rich in English tool names, code and citations stay `consistent`; English answers with Korean proper names or a quoted Korean original stay `consistent`. Known limits: it cannot tell English from other Latin-script languages, and text moved entirely into quotes is excluded (it then tends to `unknown`, which is accepted). The Python port (`CB_LANGUAGE_PY`) shares the same regex sources and constants; the test checks that both give identical status and counts.

## Runner (expert finals)

- The system message gets the language rule; the last-turn message adds "Write the narrative in <language>."
- A final whose narrative (opinion fields + report, with the fixed English peer-review statement removed) is a `mismatch` is rejected with code `final_language`. Before the last turn it is rejected inside the normal turns; on the last turn it uses the existing final-repair path (`CB_RUNNER_REPAIRS` = 2). The budget is unchanged: 6 turns + 2 repairs = `CB_INFERENCE_MAX_CALLS` = 8, and every request body stays inside `CB_RUNNER_INFERENCE_MAX`.
- The rejection message names the language and the fields; it never echoes the rejected prose. A still-wrong final ends with `out/diagnostic.json` code `final_language`, rendered by `runnerFailureMessage` as "final narrative was not in the selected response language (language)".
- Accepted finals are saved byte-for-byte as the model wrote them. An activity line records the check status (`consistent` or `unknown`) as "script heuristic, not verified language identification".

## Cross-review

- `reviewMessages` appends `responseLanguageRule(language, 'summary and every rationale')` (replacing the old "same language as the objective" line).
- `reviewContext` (used by both the prompt and `reviewSnapshot`) now carries `workflow: { kind: 'user-statement-unverified', stage, responseLanguage, revision }` — data only, no authority; `stage` is `unspecified` and `revision` `null` for older briefs. Changing stage, revision or language changes the snapshot. Budget is an operational bound and is not review input.
- `parseReviewReply(reply, reviewer, peers, { language })`: with `language`, a `mismatch` over summary + rationales returns `{ invalid: 'reviewer reply is not written in the selected language (<lang>)', category: 'language' }`. Without the option the parser behaves as before; the project DO must pass `defaultResponseLanguage(brief)` to enforce it (backend wiring, outside this change). One paid attempt only: a wrong-language reply is an explicit failure, never a hidden second call.

## Decision memo

- `memoPlan` reasons (`needs-options`, `no-opinions`) are fixed code-authored text in the selected language (`MEMO_PLAN_REASONS`).
- The prompt's `brief` data carries `stage`, `responseLanguage` and `revision` (change summary bounded to 1 KiB, truncation disclosed in `coverage.brief.revisionTruncated`) as user statements.
- `memoSnapshot` includes `stage` and `revision`; changing either changes the snapshot. Documented exclusions: `budget` (operational bound enforced by the DO), `mode`, `requestId`, `expertIds` (team and opinions carry the selection).
- `defaultMemoLanguageCheck` applies `languageIntegrity` to every narrative field; a mismatch returns `{ invalid: 'memo is not written in the selected language (<lang>)', category: 'language' }` (also for a custom `languageCheck` hook's refusal).
- Agreement wording: the earlier blanket ban on the words consensus/vote/unanimous is replaced by `claimsUnsupportedAgreement`, a narrow disclosed regex heuristic. A clause that positively asserts unanimity, a reached consensus, a vote, or agreement of all/most experts (EN and KO) is refused unless the same clause negates it. Honest statements such as "No consensus can be inferred", "No vote was taken", "합의는 확인되지 않았다" are accepted. No semantic guarantee is claimed.
