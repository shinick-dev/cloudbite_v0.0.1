# Grounded retrieval v2

`src/cloudbite-retrieval.ts` is the single ranker for curated role knowledge. It is used in two places:

| Where | Code | Query |
|---|---|---|
| Initial workspace selection (phase-one packs and legacy STA) | `retrieveKnowledge` (`cloudbite-knowledge.ts`), `retrieveSta` (`cloudbite-sta.ts`) → `retrieveRanked` | brief title + objective + context, first 12,000 characters |
| Runner follow-up search (`{"action":"knowledge"}`) | `knowledge_search` in `CB_RUNNER_PY` → `retrieve_ranked` (`RETRIEVAL_PY`) | the model's query, 1-1000 characters |

The Python twin (`RETRIEVAL_PY`) is embedded in the runner and implements the same algorithm. `test/cloudbite-v7-retrieval.mjs` checks that both sides give identical rankings, scores and selections on every real pack (20 phase-one packs + STA) with queries built from the real card text.

## Ranking (`lexical-exact-bm25/v1`)

- **Exact tags**: a card's own `match` terms, with the legacy rule (Hangul terms as substrings, others on word boundaries) and the legacy weights (identifier/flag 8, phrase 5, Hangul 4, short 2, other 3).
- **Content**: BM25 (k1 1.2, b 0.75) over the card's authored `term` + `summary`. Tokens are ASCII words of 2+ characters and Hangul syllable bigrams. Stopwords are removed. A token that appears in more than half of a pack's cards (with 4+ cards) is ignored. A content hit needs one ASCII token, or Hangul bigrams from at least two different query words (counted by word text). The overlapping bigrams of one word are one piece of evidence: `결과로` gives `결과` + `과로`, and `과로` is a cross-morpheme artifact, so a one-word Korean query (or the same word repeated) never makes a content-only hit. Exact tags are unaffected. A single Korean technical word still matches through a card's tags. Content is saturated to below 6 points (`6·bm/(bm+6)`), so tags stay the main signal.
- **Score** = `exact·1000 + content`, kept as integer milli-units. Each IDF is rounded to integer micro-units first. `log` is the only libm call that could differ between JS and Python, so the rounding gives the same result on both. Ties break by pack order.
- **Selection** (top-k, at most 8): cards with identical text (same SHA-256 of term + summary) are deduplicated. If the best remaining card adds no new source, the selector takes the first lower card that does add one, as long as it scores at least half as much.

`matched` is true only when at least one card has a positive score.

## Fallback, no-hit and citations

- **Initial selection with no hit**: the role's orientation cards are used: the pack's first cards, or STA's authored `generalCards`. The run labels them `strategy: orientation-fallback`, shows a fixed note in `KNOWLEDGE.md` that they are not search evidence, and records `retrieval.matched: false` in `knowledge/manifest.json`. The runner audit keeps the reason `initial selection`, so the audit schema and evidence-packet binding are unchanged. It adds `strategy` to the entry. As before, the sources of those cards can be cited because the model was given them. The final-repair hint marks those tokens `(orientation)` unless a follow-up search hit also unlocked them, so the model is told they are not search evidence for a claim. Citation validation and budgets are unchanged.
- **Follow-up search with no hit**: the search returns `matched: false` and no cards or sources. It **unlocks no citation**. The runner keeps the gap, together with the optional `purpose`, in `knowledge_gaps`. It adds an empty `follow-up search no hit` retrieval to the audit, and the final-repair hint lists the gaps.
- **Follow-up search with a hit**: the result gives `retrieval.ranked` (`id`, `score`, `exact`, `content`, matched `terms`, up to five `contentTerms`) and a basis statement. The statement says this is ranking over authored synthesis, not original source text.
- Citation rules are unchanged. Source IDs and aliases resolve only inside the role's own pack, and a pack bound to another expert is refused.

The `purpose` field on the knowledge action is optional, at most 300 characters. The runner system prompt asks the model to search before a material claim relies on curated knowledge, to treat a no-hit as a gap, and to state the inputs, formula and assumptions behind any Python figure. Nothing forces a tool call, and searches stay limited to the role's own pack.

## Records

- `knowledge/manifest.json` → `retrieval: { schema: cloudbite.retrieval/v2, strategy, matched, ranked[], representation: authored-synthesis, originalTextIncluded: false, semantic: interface-only }`. The query is never written.
- `KNOWLEDGE.md` initial JSON adds `strategy` and `ranking`. STA adds the same fields to its `selected` object.
- `out/knowledge.json` keeps every existing key and adds `retrieval: { schema, initialStrategy, followUpStrategy, semantic, representation, noHitSearches }`. `initialStrategy` is the manifest's initial-selection strategy (`lexical-exact-bm25/v1` or `orientation-fallback`), or `null` for a legacy manifest without a retrieval record. `followUpStrategy` is the runner's search ranker. There is no single top-level `strategy`, because one label cannot describe an orientation initial selection and lexical searches at once. Retrieval entries can carry `strategy`, and the reason stays at 40 characters or fewer.

## Chunk and source metadata contract

`ChunkMetadata` contains: `chunkId`, `sourceIds`, `sourceVersion`, `parentId`, `headingPath`, `contentSha256`, `bytes`, `representation` (`authored-synthesis` | `original-excerpt`), `originalText` and `rights` (`project-authored` | `owned` | `licensed`).

- All current cards are **authored syntheses**. `cardChunkMetadata` labels them `originalText: false` and `rights: project-authored`.
- `chunkMarkdown` is for a future imported corpus that is owned or licensed. Nothing is downloaded or bundled now. An `original-excerpt` must declare `owned` or `licensed` rights.
  - Headings open parent sections; the heading path is kept.
  - Code fences, `$$` math blocks and tables are indivisible. A `#` line inside a fence is not treated as a heading.
  - Paragraphs split only at line breaks and reassemble exactly.
  - A unit larger than `maxBytes` (256 B-48 KiB, default 4 KiB) is rejected with an error that gives its line, section and size. An unclosed fence is also rejected. Nothing is truncated.

## Semantic ranking: interface only

`SEMANTIC_RANKING` is `{ status: 'interface-only', deployed: false, provider: null }`.

Implemented: `semanticRerank` takes a caller-supplied embedder (`provider`, `model`, `dimension`, `embed`). It checks the dimension and the shape of every vector, records provenance and re-orders **only the lexical hits**. So it cannot turn a no-hit into a hit or unlock a citation.

Not implemented: no embedding provider, no endpoint and no configuration. Nothing in the workspace or the runner calls the interface. Production ranking is lexical.

## Limits kept

The 48 KiB workspace-file limit, 64-card / 128-source pack bounds, the 8,000-byte manifest read, 3 cards per follow-up search, 4 initial cards, 6 turns + 2 repairs and the inference body bound are all unchanged.

## Ranking changes relative to v1

v1 scored match tags only. v2 changes the ranking in these ways:

- A card can now be found through its own text. For example, `타이밍 그래프와 제약` now ranks `sta-card-001`, which v1 missed.
- Source diversity can move a same-source card down within the top-k.
- Content from several distinct Korean words, or one ASCII word, can produce a match where v1 fell back to orientation cards.

On the 24 held-out STA prompts, expected-source overlap moved from 21/24 to 20/24. The one lost case, `sta-eval-024`, overlapped in v1 only because its fallback general cards happened to include the expected source. v2 first found content matches (`primetime`, and `결과` + `과로` from the single word `결과로`). The second was a false hit. With the distinct-word rule only `primetime` (`sta-card-041`) remains, and overlap is still 20/24. The 21→20 change reflects v1's fallback luck, not a relevance regression, and no answer-quality claim follows from it. This measures retrieval only, not answer accuracy.
