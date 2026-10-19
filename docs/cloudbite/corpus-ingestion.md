# Licensed corpus ingestion (V8)

`src/cloudbite-corpus.generated.ts` exports `CORPUS: CorpusIndex` (contract: `src/cloudbite-corpus-contract.ts`): the
complete original text of six openly licensed documents, chunked and embedded for EDA/STA tradeoff and Falsify
evidence-methodology roles. Nothing in it is project-authored: no summaries, no project documents, no evaluation cases
or answers.

```
node tools/import-cloudbite-corpus.mjs           # validate, chunk, embed new/changed chunks, write the generated file
node tools/import-cloudbite-corpus.mjs --check   # offline: re-derive everything, no key, no network
node test/cloudbite-v8-corpus.mjs                # focused test (offline; the embeddings endpoint is a local stub)
```

## Sources

| Source id | Document | License | Roles |
|---|---|---|---|
| `orig-openroad-rsz-readme` | OpenROAD `src/rsz/README.md` (Gate Resizer: repair_design, repair_timing) | BSD-3-Clause | probably-primetime-sta, cb-role-072, cb-role-075, cb-role-076 |
| `orig-openroad-gpl-readme` | OpenROAD `src/gpl/README.md` (timing/routability-driven global placement) | BSD-3-Clause | probably-primetime-sta, cb-role-076 |
| `orig-openroad-cts-readme` | OpenROAD `src/cts/README.md` (clock tree synthesis) | BSD-3-Clause | probably-primetime-sta, cb-role-076 |
| `orig-pmc1182327-ioannidis-2005` | Ioannidis (2005) Why Most Published Research Findings Are False, PLoS Med 2(8): e124 | CC-BY (version unspecified) | cb-role-101, 105, 106, 118 |
| `orig-pmc4359000-head-2015` | Head et al. (2015) The Extent and Consequences of P-Hacking in Science, PLoS Biol 13(3): e1002106 | CC-BY-4.0 | cb-role-101, 105, 106, 118 |
| `orig-pmc3812051-sandve-2013` | Sandve et al. (2013) Ten Simple Rules for Reproducible Computational Research, PLoS Comput Biol 9(10): e1003285 | CC-BY-4.0 | cb-role-101, 106, 118 |

OpenROAD files are pinned at commit `1cf774db3ab22c72df2bc3605e1b4662d27523ed` (retrieved 2026-10-19 from
raw.githubusercontent.com); the repository `LICENSE` (BSD 3-Clause, "Copyright (c) 2018-2025, The OpenROAD Authors") is
kept beside them and each README's own `## License` section is quoted as evidence. OpenSTA (GPL-3.0, an OpenROAD
submodule) and every vendor manual, including PrimeTime documentation, are deliberately excluded.

The papers are Europe PMC `fullTextXML` (JATS) retrieved 2026-10-19. Rights evidence per paper: the article's own
`<license-p>` statement, the Europe PMC metadata record (`"license":"cc by"`, saved under `rights/`), and the publisher's
statement (the PLOS article page links CC BY 4.0 for Head 2015; Sandve 2013's XML carries an explicit CC BY 4.0
`ali:license_ref`). Ioannidis 2005 names "the Creative Commons Attribution License" without a version, so it is recorded
as `CC-BY (version unspecified)` with `licenseUrl` pointing to the article and its own license statement; no exact
version is inferred from PLOS's current publishing policy. That license is accepted only on pinned-file evidence (the
article XML and the Europe PMC record), none of which may name a version. The statement grants unrestricted use,
distribution and reproduction with credit, which permits redistributing the complete text with attribution. Each
source's `attribution` is a short display line (author, title, source, copyright, license and changes, at most 500
characters, the runtime index limit); the complete copyright and license text stays in the pinned XML and rights files. The overlap check found none of these documents in the
project's evaluation or human-review material.

## Inputs and validation

`knowledge/cloudbite-corpus/manifest.json` (≤64 KiB, ≤32 sources) names each original file by a relative path inside
that directory and pins it by `sha256`. It also pins `textSha256`, the hash of the derived source text, so a converter change
cannot silently change the corpus. The importer never fetches the manifest's URLs; they are provenance only. It rejects:

- a path that is absolute, drive-qualified, backslashed, contains `..`, is a link, or resolves outside the directory;
- `rights` other than `licensed`, or a license outside the allow-list (`BSD-3-Clause`, `CC-BY-4.0`, `CC-BY (version unspecified)`) — so a proprietary
  manual or a CC BY-NC/SA/ND paper cannot enter;
- license evidence whose pinned file hash mismatches or whose quote is absent, evidence that never quotes the license's
  own clause, or no evidence from inside the original document itself;
- a BSD attribution without the copyright notice, or a CC BY attribution that does not state the changes made;
- a title or attribution over 500 characters (`CORPUS_LIMITS.metaChars` of the runtime validator), at import and `--check`;
- source ids outside `orig-[a-z0-9][a-z0-9_-]{0,64}`, duplicates, roles outside the eight allowed role ids;
- more than 2 MiB of original text, more than 512 chunks, any chunk over 2500 bytes;
- unclosed code fences or math blocks, malformed or unclosed XML, unknown entities, DOCTYPE internal subsets, and any
  JATS element the converter does not handle. An unknown element fails the import; it is never dropped silently.

## Text derivation

- **Markdown** is used verbatim, except that a table longer than 2500 bytes is emitted as consecutive tables that each
  repeat the header and separator rows. No row or cell is cut.
- **JATS XML** is converted structurally. The output has the title, author names, the copyright and license statement,
  the abstracts, `body` and `back`. Sections become nested headings. Paragraphs become one sentence per line (a Markdown
  soft break), so long paragraphs chunk at sentence boundaries. Lists, definition lists, quotes, boxes, footnotes and
  references are kept, and figure, table and supplementary-material labels and captions are kept as paragraphs. XML tables
  become Markdown tables (a `rowspan` fails the import). Images, including Ioannidis's table images, have no text and
  are not included. Adjacent citation fields with no whitespace between them in the XML get one space. The converter
  adds no other text.

Chunking is the shared `chunkMarkdown` (`src/cloudbite-retrieval.ts`, bundled with esbuild into the ignored
`.artifacts/corpus-import/`) with `maxBytes: 2500`, `representation: 'original-excerpt'`, `rights: 'licensed'`. Headings open
parents. Code fences, math blocks and tables are indivisible. Chunk ids are `<sourceId>-s<n>-c<m>` and parent ids are
`<sourceId>-s<n>`.

Every stored chunk text is an exact contiguous substring of its source text (the runtime validator requires this). When
the chunker's output differs from the source only in its runs of newlines (it can rejoin blocks with a blank line where
the original has a single newline), the importer locates the single original span matching it with those separators
normalized and stores, hashes and embeds that span instead, provided it is at most 2500 bytes. No match, more than one
match, or any other difference (joined, reordered or rewritten lines) fails the import naming the chunk. `--check`, the
vector cache and the generated-file verification apply the same exact-substring rule.

## Embeddings and identity

Embeddings are real OpenAI `text-embedding-3-small` vectors with `dimensions: 256` and `encoding_format: float`. They
come from `POST https://api.openai.com/v1/embeddings` (see https://developers.openai.com/api/docs/guides/embeddings), in
batches of at most 16, with exactly the chunk text as input. The key is read only from `process.env.OPENAI_API_KEY`. Each
batch gets one attempt and no retry. A failure reports only the HTTP status, never the key, the request or response body,
or the underlying error. Vectors are rounded to 6 decimals.

- `CORPUS_EMBEDDINGS.bindings[chunkId] = sha256("cloudbite.corpus-vector/v1\n<model>\n<dimensions>\n<chunk.sha256>\n<vector>")`.
  Regeneration reuses a cached vector only when the same chunk text has a valid binding under the same model and
  dimensions, so an unchanged corpus re-imports byte-identically with zero calls.
- `CorpusSource.sha256` is the sha256 of `CorpusSource.text`, and `CorpusChunk.sha256` is the sha256 of `CorpusChunk.text`.
- `CORPUS.sha256` is the sha256 of the sorted-key canonical JSON of `{schema, model, dimensions, sources, chunks}`,
  excluding itself.
- `--check` re-derives sources and chunks from the pinned originals. It verifies the index hash, every chunk and source
  against the derivation, every vector (256 finite numbers) against its binding, and the canonical byte form of the
  generated file.

## Current output

There are 6 sources, 186 chunks (181 distinct texts embedded, 43,089 tokens) and 186,081 bytes of original text. The generated
file is about 905 KB. Index sha256: `8ccccdb5d538a6d0adb5c43b008116dd22fb60aa469b5a822767e47ddd089ce8`.
