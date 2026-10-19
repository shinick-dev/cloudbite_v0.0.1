# Expert project workflow — v7

Cloudbite's target is a useful project decision: professionally grounded review, a feasible proposed change, a proportionate check, and the observation that would change the advice. This is the first integration milestone for that direction, not a claim of evaluated professional expertise.

## Interfaces and authority

- ProjectBrief and the optional DecisionFrame remain the mission input. Objective/stage/options/constraints/success criteria/user facts/assumptions/unknowns stay separate.
- The registered expert and code-authored operating playbook define the work. User documents, retrieved knowledge and earlier model outputs are reference data, not tool authority.
- Knowledge records distinguish authored synthesis from original excerpts. Source/version/content hashes identify the evidence used; retrieval alone does not establish claim support.
- The existing runner exposes knowledge search, bounded Python, output-file writing and final opinion. The six-field opinion schema, actual call budget and server-side credentials remain unchanged.
- Generated reports and analysis files can contribute bounded excerpts to the optional project-improvement memo. They are labelled AI-generated/unverified, not independent source material or proof of execution.
- A follow-up references only its authorized, unexpired parent. Proposed fixes stay proposals. Explicit user adoption is distinct from factual verification. No recursive import of all ancestors.
- New history prompt hashes use expert-instructions/v2: persona, both rendered playbook languages/knowledge variants, and the runner code (including lexical retrieval). Old stored hashes remain unchanged. This is a creation-time static-instruction signature, not a per-step execution attestation or a frozen runtime across intervening deployments.

## Artifact-to-memo integration

The server selects at most 12 collected files from completed experts, one per role before a second file, report first. Reserved outputs and unsafe paths are excluded. The selected file list is metadata-bound; no sandbox, arbitrary filesystem or network read occurs.

Each generated-artifact packet includes up to 4,000 UTF-16 code units without splitting a supplementary Unicode character, its expert/path, full stored-content SHA-256, original and excerpt byte counts. Missing files and selection omissions are disclosed. The existing packet fair-share budget may trim excerpts further; that is counted by memo coverage. Full reports and source pages remain labelled not reviewed.

The memo snapshot binds full selected content via the hash, including changes beyond the excerpt. Input freshness is checked using transaction-local artifact reads before reservation and before accepting the single paid result. A changed artifact invalidates that attempt; no hidden retry or new budget is granted. Already saved old memos stay as stored.

## Acceptance

1. Runtime delivery: the expert actually receives its operating method, the project decision and scoped tool instructions.
2. Retrieval: English/Korean technical terms, content-only relevance, no-hit behavior, role/source isolation, TS/Python parity and intact structured blocks.
3. Evidence: only actually retrieved allowed citations; a generated artifact does not become verified external evidence.
4. Constructive result: a concern has a useful remedy/check/decision trigger, appropriate to the stated stage.
5. Iteration: a proposed remedy and open question reach an explicit next-round draft; a changed document/fact prompts reconsideration without silently becoming an executed check.
6. Recovery: missing artifacts and stale input are visible; legacy history remains readable; budgets/auth/retention stay effective.

Items 1–3 and 5–6 have deterministic integration checks. Item 4 and the practical quality of all items need actual recorded model outputs and independent human review. Passing synthetic fixtures is not a quality improvement result.

## Evaluation

Use the existing offline evaluator with the two held-out EDA/Falsify literature-project cases in test/fixtures/cloudbite-expert-workflow.jsonl:

```
node tools/evaluate-cloudbite-quality.mjs evaluate --input RUN.json --case v7-eda-closure --cases-file test/fixtures/cloudbite-expert-workflow.jsonl --provenance observed-live --out .artifacts/product-v7/evaluation
```

For a same-input baseline/candidate comparison use the existing compare or quality-batch command with the same cases file. Keep model, question, stage, materials and selected roles fixed when isolating a persona/retrieval change. Label actual production observations, local probes and synthetic transport tests accurately. Human reviewers score relevance, evidence traceability, facts versus assumptions, alternatives, conditional next steps and fabricated execution separately; do not turn model confidence into accuracy.

For iteration acceptance, add a newly supplied runtime measurement to the EDA child or a small actual annotation disagreement sample to the Falsify child. Check that the expert revisits the relevant condition and records what remains unknown. These changed-input rounds are not a controlled baseline/candidate comparison.

## Scope remaining after the first milestone

- Large licensed/original corpora need actual import, rights/version records and evaluation.
- Production semantic embeddings/vector storage need a chosen configured provider/index and retrieval evaluation; lexical ranking must not be advertised as semantic retrieval.
- Tool permissions remain the actual runner actions; this release does not grant access to licensed EDA tools or arbitrary third-party services.
- Automatic multi-stage planning, resumable individual expert execution, and targeted dependent reviews need their own state/budget contracts and execution evidence.
- A source-supported professional quality claim requires independent domain review; runtime acceptance alone is insufficient.

