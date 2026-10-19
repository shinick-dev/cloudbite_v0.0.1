# Licensed-corpus hybrid search (v8)

`src/cloudbite-corpus-search.ts` searches a caller-supplied index of **public, licensed reference text**
(`src/cloudbite-corpus-contract.ts`). Project documents, user input and evaluation answers are never indexed. The
module has no generated-data dependency; the root wires it into the gateway, session budgets and audit.

```ts
searchCorpus(index: CorpusIndex, expertId: string, query: string, key: string | undefined, fetcher = fetch): Promise<CorpusSearchResult>
validateCorpusIndex(index): Promise<{ sha256, sources, chunks, cached }>   // throws CorpusIndexError
corpusIndexSha256(index): Promise<string>                                  // for index builders
freezeCorpusIndex(index): index                                             // deep freeze so validation can be cached
```

## Index validation

Every search validates the index first (or reuses a cached validation, below). Errors name the field path and the
rule only, never content. Checked:

- `schema` `cloudbite.corpus/v1`, `model` exactly `text-embedding-3-small`, `dimensions` exactly 256; exactly the
  contract's keys on the index, every source and every chunk (no extra or missing fields).
- Sources: 1-256, unique safe ids (`[A-Za-z0-9][A-Za-z0-9_-]{0,79}`), 1-64 unique safe role ids, https `url` and
  `licenseUrl` without credentials, bounded title/license/attribution/version, ISO `retrievedAt`,
  text ≤ 1 MiB each and ≤ 8 MiB total, `sha256` = SHA-256 of the UTF-8 text.
- Chunks: 1-4096, unique safe ids, `sourceId` naming a source, safe `parentId`, heading path ≤ 8 × 200 chars,
  text 1-4096 UTF-8 bytes that is an **exact excerpt of its own source text**, `sha256` = SHA-256 of the text, vector a
  plain array of exactly 256 finite numbers with non-zero norm.
- Index `sha256` = SHA-256 of the canonical JSON of the index **without** its `sha256` field: object keys sorted at
  every level, JavaScript `JSON.stringify` number formatting. Builders compute it with `corpusIndexSha256`.

Validation reads each field once into a private snapshot (vectors copied into `Float64Array`), and searches use only
that snapshot. The snapshot is cached by object identity **only when the whole index graph was frozen** at validation
time (`freezeCorpusIndex`); a mutable or shallowly frozen index is re-validated on every call, so a later mutation is
caught instead of silently trusted.

## Search

1. Query must be a string of 1-1000 characters with non-whitespace (`RangeError` otherwise, no request).
2. **Eligibility first:** only chunks of sources whose `roles` include `expertId`. No eligible source → no request,
   `degraded: 'no-eligible-sources'`. There is no fallback to other roles.
3. A query with no content terms (only stopwords/punctuation under the shared tokenizer) → no request,
   `degraded: 'no-query-terms'`.
4. **Lexical:** the shared ranker (`rankCards` from `cloudbite-retrieval.ts`, saturated BM25) over the eligible chunks
   (heading path + chunk text).
5. **Semantic:** with a key, one `POST https://api.openai.com/v1/embeddings` with exactly
   `{ model: 'text-embedding-3-small', input: <query>, dimensions: 256, encoding_format: 'float' }`, an 8 s
   `AbortSignal.timeout` (covers the body read) and **no retry**. Cosine similarity is computed against **every**
   eligible chunk (not a re-rank of lexical candidates); chunks at or above the floor (0.40) form the semantic list.
6. **Fusion:** reciprocal rank fusion, `Σ 1 / (60 + rank)` over the lists a chunk appears in; ties by index order.
7. **Selection:** at most 3 hits, at most 2 chunks per source, identical chunk text once.

The response must be ≤ 64 KiB with `object: 'list'`, exactly one item, `object: 'embedding'`, `index: 0`, exactly 256
finite numbers with non-zero norm, and `model` exactly `text-embedding-3-small`; anything else is
`upstream-invalid`.

### Result

`strategy: 'hybrid-rrf/v1'` and `model: 'text-embedding-3-small'` only when the embedding was received and validated;
otherwise `strategy: 'corpus-lexical/v1'`, `model: null`, and `degraded` gives the category:

| `degraded` | meaning |
|---|---|
| `no-eligible-sources` | the expert has no licensed source; nothing searched |
| `no-query-terms` | nothing searchable in the query; nothing searched |
| `missing-key` / `invalid-key` | no usable key; lexical results only |
| `upstream-unavailable` | network error or timeout |
| `upstream-rejected` | non-2xx status (body discarded unread) |
| `upstream-invalid` | malformed, oversized or mismatched response |

Hits carry the exact original chunk text, ids, heading path, text hash and the fused rank score. Sources carry
metadata only (no `text`, no `roles`). No vectors are ever returned. `matched` is `hits.length > 0`; a no-hit result
has empty `hits` and `sources` and unlocks nothing. The key, the query and upstream bodies never appear in a result
or an error.

## Scores are rankings, not support

`score` is an RRF value (at most `2/61`). Cosine similarity is used only to order and admit candidates; neither it nor
the fused score is evidence that a chunk supports a claim, nor a confidence. Claim support is decided elsewhere.

## Similarity floor: 0.40

The embeddings guide (<https://developers.openai.com/api/docs/guides/embeddings>) recommends cosine similarity
(embeddings are length-normalized) and documents `dimensions` shortening, but gives no relevance threshold. For the
`text-embedding-3` family, unrelated text is commonly reported to score well below 0.3, so 0.40 was chosen a priori
as a conservative admission floor: a chunk must be clearly on-topic to enter on semantic grounds alone. It was not
fitted to any evaluation or held-out case; lexical hits are unaffected by it. Recalibrate only on a separate,
non-evaluation sample.

## Tests

`node test/cloudbite-v8-search.mjs` uses deterministic fake embeddings (concept axes, so paraphrases share direction
without sharing words). `CLOUDBITE_CORPUS_LIVE=1` with `OPENAI_API_KEY` adds one real query that must reach
`api.openai.com` and pass the strict response checks (the fake index means its hits are not meaningful); nothing about
the key, query or provider error is printed.
