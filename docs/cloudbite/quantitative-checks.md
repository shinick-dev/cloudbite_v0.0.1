# Quantitative checks (`src/cloudbite-quantitative.ts`)

A bounded, deterministic numerical reproduction engine. It recomputes a calculation the **user explicitly
specified**, over values the user supplied or over the actual stored CSV text the caller already holds. It is not
another model opinion and it does not replace or change the sandbox Python tool.

- No `eval`, `Function`, shell, network or filesystem. Arithmetic is a tiny recursive-descent parser; CSV is a strict
  RFC 4180 reader written against the standard library only. Browser-safe (bundles for `platform: 'browser'`).
- Synchronous and pure. SHA-256 uses the existing pure `sha256Hex` from `cloudbite-knowledge.ts` (no `crypto.subtle`).
- The engine never extracts claims from reports. A reproduced number shows the arithmetic over the given inputs; it
  does **not** prove the assumptions, the data provenance or the decision built on them.

## API

```ts
parseQuantitativeRequest(input: unknown): QuantitativeRequest | { invalid: string }
runQuantitativeCheck(request: unknown, csvText?: string): QuantitativeResult   // re-validates request itself
quantitativeInputSha256(request: QuantitativeRequest, csvSha256?: string): string
CB_QUANTITATIVE_LIMITS, QUANTITATIVE_SCHEMA = 'cloudbite.quantitative.v1'
```

```ts
type QuantitativeRequest =
  | { kind: 'arithmetic'; expression: string; variables: Record<string, { value: number; unit: string }>;
      expected?: { value: number; unit: string }; tolerance?: number; sensitivity?: { variable: string; delta: number } }
  | { kind: 'csv-summary'; column: string };
```

Unknown fields are rejected. `parseQuantitativeRequest` returns variables in a null-prototype object.

Every result carries `schema`, `engine`, `status: 'completed' | 'error'`, `kind`, `inputSha256`, `limits`,
`warnings[]` and `limitations[]`. Errors are `{ code, message }`; messages name fields, offsets and limits only and
never echo submitted values, variable names, units or CSV cells.

## Arithmetic

Grammar: decimal literals (optional `e` exponent), variables `[A-Za-z_][A-Za-z0-9_]*`, binary `+ - * /`, unary
`+ -`, parentheses. Rejected with explicit codes: power (`**`, `^`), function calls, property/index access, comments
(`//`, `/*`, `#`), any other character, units glued to literals (`2ms`), non-finite literals or intermediates,
division by zero, unknown variables. Limits: 512 chars, 256 tokens, nesting depth 32, 32 variables, names ≤32 chars.

Units (case-sensitive; normalised to base units before computing):

| dimension | units | base |
|---|---|---|
| dimensionless | `''`, `'1'` | `1` |
| time | `s ms us µs μs ns ps` | `s` |
| voltage | `V mV` | `V` |
| frequency | `Hz kHz MHz GHz` | `Hz` = `s^-1` |
| power | `W mW` | `W` |

Literals are dimensionless. `+`/`-` require identical dimensions (else `dimension-mismatch`). `*`/`/` add/subtract
exponents over (s, V, W) honestly, so `ps * GHz` is dimensionless and `V*V/W` is `V^2*W^-1`; W is a base unit and is
not decomposed into V·A. Exponents beyond ±8 are rejected. The result reports `value` (base units), `unit`
(canonical, e.g. `s`, `Hz`, `s*W`, `1`) and `dimensions`. Each variable is echoed with `baseValue`/`baseUnit`.

**Expected comparison** — `expected` is normalised to base units. Different dimensions → `dimension-mismatch`.
Otherwise `within-tolerance` iff `|actual − expected| ≤ tolerance · max(|actual|, |expected|)`; `tolerance` is
relative, in [0, 1], default `1e-9`. `relativeDifference` is `null` when expected is 0.

**Sensitivity** — one explicit variable and a non-zero finite `delta` in **that variable's own unit**. The engine
recomputes the expression at `value + delta` and `value − delta`; each side is `completed` (value and change from the
base result) or `error` (e.g. division by zero, non-finite perturbed input) without failing the main result. Warnings
flag a delta below floating-point precision and a variable the expression does not use. This is a perturbation of the
user's own formula, not an automatic check of the user's premise.

## CSV summary

`csvText` is the actual stored text; the caller binds it to its source artifact (project/expert/path/sha256) — that
binding is the root integration's responsibility. Limits are checked before hashing/parsing: ≤64 KiB UTF-8,
≤1000 data rows, ≤32 columns.

Parsing: comma separator, CRLF or LF records, quoted fields with `""` escapes and embedded commas/newlines, leading BOM
ignored (warned). Malformed input is rejected (`csv-malformed`): quote inside an unquoted field, text after a closing
quote, unterminated quote, bare CR, records whose field count differs from the header (including blank records).
Duplicate headers → `csv-duplicate-header`. The column must match a header exactly; a name that matches more than one
header after trim/case-fold → `csv-column-ambiguous`; no exact match → `csv-column-missing` (the message says when a
header differs only by case/space, without guessing).

Cells are trimmed and must match a plain decimal/scientific number. Everything else is excluded and counted by reason:
`empty`, `non-numeric`, `formula-like` (`= + - @` prefixes that are not numbers — never executed) and `nonfinite`
(`NaN`, `Infinity`, overflow like `1e999`). Excluded cells are never treated as zero; up to 10 excluded record
numbers (header = record 1) are listed. The summary is `{ count, sum, mean, min, max }` with compensated (Neumaier)
summation, or `null` with a warning when no cell was numeric. `unit` is always `'unknown'`: units are never inferred
from headers or cells.

## Hashes

`inputSha256` = SHA-256 of the canonical (sorted-key) JSON of the validated request, `{"request": …}`, plus
`"csvSha256"` for CSV checks. `csvSha256` hashes the exact CSV text (UTF-8), so `\n` and `\r\n` files hash differently
even when the summary is equal. Invalid requests and oversize CSV return `inputSha256: null`.

## Integration notes (root)

DO/API/UI/contract wiring is owned by the coordinator: build the request from an explicit user action, pass the stored
CSV text of a user-chosen artifact and record that artifact binding next to the result, and display `limitations`
with every number. Tests: `node test/cloudbite-quantitative.mjs`.
