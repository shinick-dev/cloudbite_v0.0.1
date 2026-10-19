# PMC original-evidence import

Module: `src/cloudbite-pmc.ts`. Tests: `test/cloudbite-pmc.mjs` (mocked network; `CLOUDBITE_PMC_SMOKE=1` adds one read-only public call pair).
No route is exported. The coordinator owns the API surface, authentication, Origin checks and quotas.

```ts
importPmc(identifier: string, { fetcher?, now?, sleep?, timeoutMs? } = {})
  -> Promise<PmcImport | PmcImportError>
PmcImport      = { article: { pmcid, doi?, title, license, sourceUrl, retrievedAt },
                   documents: ProjectDocument[],            // doc-1..N, already valid for validateDecisionData
                   sections: { id, title, locator, characters }[],
                   warnings: string[] }
PmcImportError = { error: 'invalid_identifier' | 'not_found' | 'identity_mismatch' | 'source_unavailable'
                        | 'rate_limited' | 'timeout' | 'too_large' | 'redirect_blocked' | 'invalid_xml' | 'upstream_error',
                   message: string, retryAfterSeconds?: number }
isPmcImportError(r)   // type guard
```

## Sources (official, current as of 2026-10)

| Step | Endpoint | Used for |
|---|---|---|
| DOI → PMCID (DOI input only) | `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?tool=cloudbite&ids=<doi>&idtype=doi&format=json` | PMC ID Converter API |
| Full text | `https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/?verb=GetRecord&identifier=oai:pubmedcentral.nih.gov:<n>&metadataPrefix=pmc` | PMC OAI-PMH (JATS XML) |

Docs: <https://pmc.ncbi.nlm.nih.gov/tools/oai/>, <https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/>.
The retired PMC OA Web Service is not used. OAI-PMH serves full text only for records whose licence permits reuse. For any
other record it returns `cannotDisseminateFormat`, which this module reports as `source_unavailable`.

## Input and identity

- Accepted input: `PMC<digits>` (case-insensitive) or a DOI `10.<4-9 digits>/<printable ASCII>` with an optional `doi:` prefix.
  URLs and other input are rejected before any network call.
- Every identity check must pass:
  - the ID Converter returns exactly one record, with the same DOI (case-insensitive) and `live` not false;
  - the OAI header identifier equals the requested `oai:pubmedcentral.nih.gov:<n>`;
  - the JATS `article-id` PMCID equals the requested PMCID;
  - for DOI input, the JATS DOI equals the requested DOI.
  If any check fails, the result is `identity_mismatch`.

## Licence gate

The import succeeds only when both of these hold:

1. the OAI header lists `setSpec` `pmc-open`;
2. the article-level `front/article-meta/permissions/license` names exactly one licence supported by this importer's
   initial product policy: CC BY or CC0. The licence can appear in `ali:license_ref`, `@xlink:href`, or a licence `ext-link`.

Otherwise the result is `source_unavailable`. That covers a missing licence, publisher-specific "open access" wording,
conflicting licences, and figure or table permissions with no article licence. The module does not assume that a public
article is reusable. `article.license` and each document header give the licence and its URL. Other Creative Commons
variants are explicitly unavailable under this product policy pending separate review; this is not a legal judgment
about every possible use of those variants. Attribution obligations remain applicable to CC BY excerpts.

## Retrieval bounds

- Requests run serially through one module-level queue, at least 350 ms apart (NCBI allows at most 3 requests per second
  and no concurrent requests). One import makes 1 request for PMCID input and 2 for DOI input, plus at most 1 retry.
- 429 or 503: if `Retry-After` is 5 s or less, the module waits once and retries once. Otherwise it returns `rate_limited` with `retryAfterSeconds`.
- Each request has a 15 s timeout, which also covers reading the body. A hung request or a stalled body returns `timeout`.
- The module counts decoded bytes while streaming and stops reading at the cap: 6 MiB for OAI, 64 KiB for the ID Converter
  (`too_large`). A `content-length` header over the cap fails before the body is read.
- Redirects are handled manually. The module follows only `https://pmc.ncbi.nlm.nih.gov` on port 443, with no userinfo and
  the same endpoint path, for at most 2 hops. Any other target returns `redirect_blocked` and is never requested.
- Request headers are built fresh for every call: `accept` and a fixed product `user-agent` only. No cookies, Authorization
  or caller headers are sent, and no email is sent to NCBI (the ID Converter adds a warning, which is harmless). A fixed
  User-Agent is needed: anonymous clients get a 403 HTML page or a very slow body.
- An HTML error page, a wrong content type, invalid UTF-8 or invalid JSON returns `upstream_error`. The error message
  never includes the upstream body.

## XML handling

The module includes a small strict parser (the repository has no XML dependency):

- No DOCTYPE or DTD is accepted, so no internal, external or expanding entity can exist.
- Only the five predefined entities and numeric character references are decoded. Any other entity, a bare `&`, or a
  reference to a disallowed code point (NUL, surrogates) returns `invalid_xml`.
- Malformed input returns `invalid_xml`: mismatched tags, duplicate attributes, more than one root, nesting deeper than 512.
- More than 400k elements returns `too_large`.
- C0/C1 control characters and bidi override characters in the text are replaced with spaces, and a warning gives the count.
- Markup-like text such as `<script>` stays plain data.

## Bounded excerpts

The output can hold up to five documents, in this order. Parts with no text are skipped.

| Document | Content |
|---|---|
| `PMCxxxx-abstract.md` | Main abstract |
| `PMCxxxx-methods.md` | Top-level body sections whose title or `sec-type` matches methods, materials, patients, participants, design and similar |
| `PMCxxxx-results.md` | Results sections |
| `PMCxxxx-tables.md` | Table caption, rows (`\| cell \| cell \|`) and footnotes. The table budget is split across tables. |
| `PMCxxxx-discussion.md` | Discussion, conclusions and limitations |

How the excerpts are built:

- **Not imported:** the introduction and other unclassified sections, figures, supplementary files and alternative abstracts.
  Each one is named in `warnings`.
- **Verbatim text:** text is copied as it appears in the record. Only ASCII whitespace is normalised. Formulas become
  their MathML text.
- **Block locators:** every block starts with its `[locator]`, for example `[§ Methods > Design ¶2]`,
  `[Table 1 (t1) row 3]` or `[Abstract > Results ¶1]`.
- **Document header:** each document header states the PMCID, DOI, article URL, licence, retrieval time, OAI identifier
  and coverage. Coverage is either "all N text block(s) …" or "PARTIAL — k of N …". The header always says "This is NOT
  the full paper".
- **Truncation:** a paragraph cut to fit the budget is cut at a word boundary and marked
  `[… paragraph truncated: x of y characters shown]`. Blocks that do not fit are listed in
  `[… omitted from this excerpt: n block(s), c characters — <locator ranges>]`.
- **Warnings:** `warnings` gives a per-part summary of what was included and omitted.
- **`origin` field:** every document has a single-line `origin` of at most 500 characters:
  `PMC OAI-PMH GetRecord oai:pubmedcentral.nih.gov:<n> metadataPrefix=pmc · PMC<n> · doi:<doi> · part=<part> · <licence> · retrieved <ISO>`.
- **Limits:** the documents fit the existing ProjectDocument limits: at most 6 documents, at most 8000 characters each,
  at most 24000 in total, and `evidence/documents.json` at most 48 KiB in UTF-8. Before returning, the module runs the
  set through `validateDecisionData`. If it fails, every budget is scaled down and the set rebuilt, up to 4 times.
  If it still fails, the result is `too_large`.
- **`sections` field:** lists the abstract, every body section (recursively) and every table, each with its stable `id`,
  `title`, `locator` and full `characters` (subsections included), up to 200 entries.

## Caller notes

- When merging with existing user documents, the caller renumbers IDs to stay within `doc-1..doc-6` and the total limits.
  The `origin` field keeps the identity of each source.
- The imported text is untrusted article content. It is not medical advice, not a ranking and not a verified claim.
  The existing `[doc:ID]` evidence ledger links claims to it, but does not verify them.
- Node or test hosts can pass `fetcher`. Workers use the global `fetch`. All waits run through `sleep`, which tests
  replace so that runs are deterministic.

## Limitations

- Section classification uses headings. Unusual titles fall into "other" and are not imported, but `warnings` names them.
- Table cells are flattened row by row, so row and column spans are not reconstructed.
- Formula text is approximate, figures and supplements are never imported, and full articles beyond the 6 MiB response cap are rejected.
- The 350 ms spacing applies within one Worker isolate. Spacing across isolates and quotas belong to the coordinator's route.
