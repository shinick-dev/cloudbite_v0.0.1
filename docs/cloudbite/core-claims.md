# Core-claim cross-review (v5)

The opt-in cross-review (`POST /api/cloudbite/projects/<id>/review`) now lets each reviewer judge a peer's
**summary, assumptions and nextActions** — the core claims — beside the existing per-evidence findings.
It is the same pass: the same 1–3 reviewer calls, the same `CB_CLAIM_REVIEW_MAX_TOKENS` (4096) output allowance, no
extra call, no automatic review. Code: `src/cloudbite-core-claims.ts`, wired in `src/cloudbite-cross-review.ts`.

## Contract

```ts
CrossReviewReport.claimFindings?: CoreClaimFinding[];   // absent on historical reports and when none were given
CoreClaimFinding = {
  targetExpertId: string,
  target: { kind: 'summary' | 'assumption' | 'nextAction', index: number, quote: string },
  verdict: 'supported' | 'challenged' | 'insufficient',
  issue: 'unsupported-premise' | 'causal-overreach' | 'missing-assumption' | 'other',
  rationale: string,
}
```

`summary` uses index 0; `assumption` / `nextAction` are zero-based into that array.

## Bounds

| Bound | Value |
|---|---|
| claimFindings per reviewer | ≤ 3 |
| evidence findings + claimFindings per reviewer | 1–6 (zero evidence findings allowed beside ≥ 1 claimFinding) |
| Shown targets | every peer summary, then up to 4 assumptions and 4 nextActions per peer, by depth |
| Shown text | summary ≤ 600 chars, item ≤ 300 chars (exact prefix; `truncated` flagged) |
| Target list in prompt | ≤ 12 KiB UTF-8; the rest is listed in `coreClaims.omitted` (`target-limit` / `byte-budget`) |
| quote / rationale | ≤ 300 / ≤ 500 chars |
| Parsed claimFindings | ≤ 8 KiB UTF-8 per report |

The evidence claim-support packet (24 KiB) and its rules are unchanged.

## What the parser checks — and what it cannot

Each claimFinding must name a supplied peer (never the reviewer), a target that was shown (not omitted, not out of
range), and a `quote` that is a non-empty exact substring of that target's shown text, which must still match the
peer's current field (otherwise the context is stale). Any violation rejects the whole reply, as before.

This is a **targeting** check. It proves the reviewer pointed at real text; it cannot tell whether the verdict is
right. A same-model reviewer can still accept a false premise with an exact quote. Findings are one model's reading of
the supplied material — not verification, not calibrated accuracy, not a majority view.

## Prompt rules

The reviewer is told to separate user-observed facts, the expert's interpretation and causal hypotheses; that a
temporal sequence alone is not a cause (example: a late hold violation after an ECO does not by itself prove a
process-related rather than corner-related cause); to check stated technical premises (example: "an abstract cannot be
split into sentence-level claim units" is a premise to check); that missing evidence is `insufficient`, not a
contradiction; and that it has no browsing and cannot independently prove anything.

## Consumers

`validateCoreClaimFinding(finding, reviewerExpertId, opinions)` re-checks a stored finding against current opinions
(for example in author response): stale quotes, self and foreign targets are rejected.
`reviewMessages(..., coreClaims = null)` / `parseReviewReply(..., { coreClaimContext: null })` keep the evidence-only
schema.

## 한국어 요약

교차 검토가 이제 동료 의견의 요약·가정·다음 행동(핵심 주장)도 판단합니다. 호출 수(1~3회)와 출력 한도(4096 토큰)는
그대로이며 추가 호출이나 자동 검토는 없습니다. 서버는 인용문이 해당 필드의 정확한 원문 일부인지만 기계적으로
확인합니다. 판정 자체는 같은 모델의 해석이며 검증이나 정확도 수치가 아닙니다. `responseLanguage`가 ko이면
rationale은 한국어로 쓰고 인용문은 원문 그대로 둡니다.
