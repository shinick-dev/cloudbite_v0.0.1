# 75-role extension: runtime and knowledge contract

The catalogue now has 100 selectable runtime roles. This extension adds the 75 roles that were previously planned-only, using stable ids `cb-role-NNN` matching their plan numbers. The released 25 roles retain their ids and order. Users still choose at most five experts per project; concurrency remains three and a visitor grant allows ten projects. Approval, owner login, history retention and the public hostname are unchanged.

## Knowledge coverage

| Runtime group | Roles | Knowledge |
|---|---:|---|
| Phase-one general roles | 20 | 120 authored source-linked starter cards |
| New extension | 75 | 450 authored source-linked starter cards, six per role |
| Existing PrimeTime STA pilot | 1 | Existing separate 50-card, 120-source corpus |
| Existing related-scope general roles | 4 | Registry metadata and authored role instructions; no curated pack |

Thus 96 roles have curated knowledge and four remain explicitly `metadata-derived`. All 100 have `evaluation: unvalidated`. A runnable starter persona is not equivalent to the user's document-intensive STA corpus or measured professional expertise. The extension does not make 100 simultaneous sandboxes available.

The 95 generic packs contain 286 per-role source records, referring to 204 distinct URLs. At authoring time 237 records were labelled retrieved and 49 unverified; 175 distinct URLs had been retrieved by at least one author, leaving 29 URLs without a successful identity/reachability check. These counts exclude the separate STA corpus. Retrieval here is page identity/reachability, not semantic validation of the authored cards.

## Assembly and provenance

`src/cloudbite-knowledge-registry.ts` assembles the original 20 packs and the three independently authored extension modules. It refuses duplicate plan numbers or expert ids. `cloudbite-personas.ts` validates and freezes every pack, produces role-specific workspaces and pins the entire pack SHA-256 in the prompt, so source-only changes also alter the history prompt hash. Provenance names the actual source module. The existing registry pins and the separate STA loader are preserved.

Every extension role has its own mission, questions, methods, limits, six knowledge cards, primary-source URL records and two collectable deliverables. Source records distinguish URLs actually retrieved during authoring from unverified references. A successful HTTP fetch establishes reachability and document identity, not the truth of each card or the correctness of the model's answer. No source pages or licensed vendor manuals are mirrored into a workspace.

Runtime retrieval sees only the current role's pack. The manifest binds the role id and hashes of exact card/source bytes; the Python runner refuses mismatches and unknown citation ids. Each extension declares two flat `out/` deliverables, leaving room for result, report and the automatic knowledge audit within the existing collection limit. New roles use the same authenticated execution and per-run capabilities as the existing roles.

## Review boundary

The four new review roles (95–98) join the five existing knowledge-backed review roles in the no-peer guard. Their manifests say peer inputs were not provided and their final reports must include `No peer result verification occurred.` This is a literal presence check, not semantic verification of the whole report. The existing Feedback Synthesizer at plan99 remains a related-scope metadata role. No new multi-pass cross-review pipeline is enabled by this extension.

## Evaluation and release checks

The extension's three fixture files contain 225 held-out questions: normal, missing-input and out-of-scope/adversarial cases for each new role. Together with the phase-one fixtures there are 285 generic-role evaluation cases. They are not imported by runtime modules and remain unscored. STA retains its separate evaluation suite.

`npm run test:cloudbite` includes `test/cloudbite-expansion.mjs`. It checks role mapping, source references, source check labels, substantive distinct cards, held-out separation, provenance, byte hashes, untrusted brief boundaries and workspace limits. It also loads all 75 real workspaces with the actual Python runner and writes every one of their 150 declared role deliverables. The runtime integration suite runs both a new domain role and a new reviewer through its fake Daytona/model transport with the actual Python runner. These are execution and structural checks; no model-quality score follows from them.

Before commercial quality claims: inspect sources in context, obtain domain review, score the held-out questions against predefined rubrics, compare with a single-role baseline and test actual follow-up review. Medical, legal, financial and safety-critical output requires qualified human review. Source freshness and jurisdiction remain explicit constraints.

Per-author source-check coverage and limitations: [group A](pool-expansion-a.md), [group B](pool-expansion-b.md), [group C](pool-expansion-c.md).
