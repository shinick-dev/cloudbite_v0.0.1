# Curated PrimeTime STA pilot

The first knowledge-grounded expert is `probably-primetime-sta` (PrimeTime STA Expert). The other twelve roles keep their existing metadata-derived prompts. No other role is labelled as having this knowledge base.

The user's local Pro-bably checkout at revision `bdb99d537330e0a55e4f1dd082cf42a6fc5faeab` contains work not yet on its GitHub main branch. This import uses its project-authored STA instructions, 50 Korean synthesis cards, 120 source metadata records, and eight subrole checklists. The source document hash and knowledge version are pinned in `src/cloudbite-sta-data.ts`. It does not copy the 64 MiB upstream corpus, commercial manuals, foundry data, tool binaries or licensed reference snippets. Individual source access and reuse policies remain attached to each citation; unknown rights stay unknown. Original sources and their authors retain their respective rights. Project-authored material is attributed to Pro-bably; no blanket MIT licence is asserted for that private project's materials.

## Use

Open Cloudbite, sign in or obtain visitor access, and select **Try the curated STA expert / 지식 기반 STA 전문가 예제**. This fills an educational brief and selects only the STA expert; it does not start a run or change the execution mode. Choose live mode and start when ready. The expert is also searchable under All experts by `STA` or `PrimeTime`.

The complete persona is uploaded to its Daytona workspace. Query-matched cards and their sources go in `KNOWLEDGE.md`; all 50 authored cards and 120 source records are available to a local `knowledge` action for follow-up retrieval. Selection uses weighted, deterministic term matching, not embeddings. Raw reference text is never executed. SHA-256 checks cover both local knowledge files before inference. Model context includes complete priority files rather than truncating the persona after 12,000 characters. Old tool exchanges can be discarded to stay within the existing inference request limit; source audit records remain in process memory.

The model must cite retrieved source IDs as `[source:education-005]`. Unknown IDs and missing citations are rejected within the existing six-turn budget. This validates source identity, not claim entailment or the current contents of a remote URL. Source pages are not fetched at run time. `out/knowledge.json` records pack provenance, retrieved card/source IDs and source URLs, scope and rights. The runner writes it automatically; a model write to that reserved path is rejected. The usual files viewer opens the actual artifact after completion.

No PrimeTime installation, licence, signoff certification or fine-tuning is implied. Python may calculate explicitly educational examples. OpenSTA/FPGA references must be distinguished from PrimeTime behaviour. Confidence remains an uncalibrated self-assessment; the report must discuss missing evidence and assumptions.

## Validation and remaining work

`test/fixtures/sta-evaluation-cases.jsonl` holds the original 24 evaluation questions and human grading criteria separately from runtime knowledge. They are not uploaded to the sandbox or included in retrieval. `node test/cloudbite-sta.mjs` checks knowledge linkage, workspace bounds, deterministic retrieval and held-out separation, and writes `.artifacts/sta-qa/retrieval-evaluation.json`. Expected-source overlap is a retrieval diagnostic, not answer accuracy.

The runtime integration test executes the real Python runner with controlled model replies and provider simulators, verifies follow-up retrieval and rejection of a fabricated citation, and collects the audit via the authenticated artifact endpoint. A live smoke test is distinct from those checks. A full blinded 24-answer model evaluation, independent domain review, live source verification and calibrated confidence are still required before describing this expert as validated.

To refresh from an explicitly selected source checkout:

```powershell
node tools/import-sta-knowledge.mjs --source <pro-bably-checkout>
node test/cloudbite-sta.mjs
npm run test:cloudbite
```

Use `--check` on the import command to verify exact agreement without rewriting the generated files. The importer reads only the authored expert JSON and held-out evaluation JSONL, never the raw corpus.
