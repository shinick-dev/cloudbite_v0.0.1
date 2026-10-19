# CloudBite V8: licensed original references in the expert workflow

CloudBite keeps the V7 expert playbooks, constructive advice, project continuity, curated knowledge packs and Nosana answer generation. V8 adds a second evidence channel: independently licensed original reference text, chunked and embedded ahead of deployment, searched through the existing per-expert capability gateway.

## What actually runs

1. The offline importer reads pinned local originals and their rights records. It preserves source/version/attribution, hashes and heading structure, derives chunks, and obtains real `text-embedding-3-small` vectors with 256 dimensions. Unchanged chunks reuse their bound vectors. Offline `--check` does not contact a provider.
2. A covered expert receives the current corpus index hash in its existing short-lived runner capability. Its initial objective (at most 1,000 characters) is searched before the first answer call. Later `knowledge` actions search both the existing curated pack and the original corpus.
3. The Worker embeds only the bounded search query through the fixed OpenAI endpoint. Eligible role-specific chunks participate in both lexical and semantic ranking; RRF combines the lists. At most three exact excerpts are returned, at most two from one source. A similarity threshold is a retrieval heuristic, not claim support or calibrated accuracy.
4. Missing credentials or embedding outages use explicitly labelled lexical retrieval. An unavailable original-corpus request does not prevent curated search or the expert's final answer. No-hit searches unlock no original citation.
5. The Worker reserves at most seven searches per expert before external I/O, separately from the unchanged eight-call Nosana answer budget. A lost reply consumes a search slot. One request may be in flight for that expert; cancellation, expiry or a replaced claim prevents late publication. Provider keys stay on the Worker.
6. The server persists a receipt containing index/strategy/model/degradation and returned chunk IDs/hashes. It stores no search query in that receipt. The runner's own audit is descriptive and cannot manufacture an original-text evidence packet.
7. Completed experts' original snippets are reconstructed from those server receipts, the role allowlist and the exact index/chunk hashes. Bounded evidence packets distinguish original snippets from authored summary cards. Cross-review can quote those snippets using the existing exact-quote checks. The memo receives actual `source-excerpt` packets, after source disclosures/metadata and before generated expert artifacts. Omissions remain explicit.

Preview discloses in KO/EN that original semantic search sends up to 1,000 query characters to OpenAI and that its search calls are separate from Nosana answer calls. Public reference text alone enters the shared index; user briefs, uploaded documents, prior advice and evaluation answers do not.

## Operating the feature

Use the existing `npm run dev` and guarded `npm run deploy` workflows and the independent `wrangler.cloudbite.jsonc` configuration. `CLOUDBITE_EMBEDDING_API_KEY` is the server-only secret for query embeddings. `OPENAI_API_KEY` is read only by the offline importer. Neither value belongs in source, a manifest, command arguments, a browser, or a sandbox.

See [corpus ingestion](corpus-ingestion.md), [search semantics](corpus-search.md), and [retrieval evaluation](rag-evaluation.md) for exact commands, rights requirements and limits. `npm run test:cloudbite:v8` exercises ingestion/index integrity, search, gateway lifetime/budgets, evidence binding, the actual Python retrieval adapter and evaluation arithmetic.

## Scope and limits

This is a bounded, versioned reference corpus for the eight EDA/STA and Falsify pilot roles, not unrestricted web browsing or an enterprise document service. The importer caps the corpus at 512 chunks and 2 MiB of converted original text. Exact search over this small deployed index avoids an unnecessary new storage service; it is not a claim that an in-bundle index scales to millions of documents. A larger corpus will require external source storage, incremental indexing jobs, a vector index, deletion/version propagation and their operational tests.

The first corpus contains six documents and 186 chunks: three pinned OpenROAD implementation/timing documents and three openly licensed research-method papers. It contains 186,081 bytes of converted original text. Full source and license records remain in `knowledge/cloudbite-corpus/`; excerpts alone are returned to an expert. Ioannidis (2005) states CC BY without a version, so that source is labelled **CC-BY (version unspecified)** rather than inferring a historical version from a current publishing policy.

OpenROAD timing/implementation guidance is not a proprietary PrimeTime manual and cannot establish version-specific PrimeTime behavior. Licensed research-method papers do not establish clinical validity. Search scores do not validate claims, and an AI expert's confidence remains a self-assessment.

An in-flight expert is pinned to its uploaded index hash. If a deployment replaces that index mid-run, later searches fail closed for that snapshot; already-finalized sealed evidence retains its stored excerpts. Embedding cost accounting is a separate bounded search count, not a provider invoice or part of the Nosana call ledger.

Automated tests demonstrate mechanics and invariants. Live embedding probes demonstrate provider connectivity and ranking on the real corpus. Neither demonstrates better project advice. Advice-quality comparison still requires saved baseline/candidate outputs on the held-out EDA/Falsify cases and blinded independent human ratings. Synthetic replies, unannotated relevance and provider smoke probes must not be reported as those ratings.

On 2026-10-19, all ten authored retrieval queries were run directly through the actual search engine with the real corpus and real OpenAI query embeddings (313 input tokens). The saved lexical baseline and hybrid candidate had no role leakage or invalid source/chunk citations; the hybrid candidate had no embedding degradation. All ten relevance annotations remain pending, so recall/MRR are **null**, and advice quality remains **PENDING_HUMAN_REVIEW**. These were retrieval probes, not live Daytona expert runs.
