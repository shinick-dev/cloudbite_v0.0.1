// Bounded deterministic numerical reproduction: an app-owned, read-only recomputation over values the user supplied
// or over the actual stored CSV text the caller (project DO) already holds. It is not another model opinion and not
// the sandbox Python tool. Nothing here uses eval/Function, a shell, the network or the filesystem: arithmetic is a
// tiny recursive-descent parser over literals, variables, + - * / and parentheses; CSV is a strict RFC 4180 reader.
//
// The user names the calculation; the engine never extracts claims. A reproduced number shows the arithmetic over the
// given inputs, never that the inputs, their provenance or the decision built on them are correct. Source artifact
// binding (which stored file the CSV text came from) is the caller's job. Everything is synchronous and browser-safe.
import { sha256Hex } from './cloudbite-knowledge';

export const QUANTITATIVE_SCHEMA = 'cloudbite.quantitative.v1' as const;
export const CB_QUANTITATIVE_LIMITS = Object.freeze({
  expressionChars: 512, tokens: 256, depth: 32, variables: 32, nameChars: 32, unitChars: 16,
  dimensionExponent: 8, csvBytes: 64 * 1024, csvRows: 1000, csvColumns: 32, columnChars: 128, excludedRowSample: 10,
});
const L = CB_QUANTITATIVE_LIMITS;

export interface QuantityInput { value: number; unit: string }
export interface ArithmeticRequest {
  kind: 'arithmetic';
  expression: string;
  variables: Record<string, QuantityInput>;
  expected?: QuantityInput;
  /** Relative tolerance in [0, 1] for the expected comparison; default 1e-9. */
  tolerance?: number;
  /** One explicit ±delta perturbation of one variable, delta in that variable's own unit. */
  sensitivity?: { variable: string; delta: number };
}
export interface CsvSummaryRequest { kind: 'csv-summary'; column: string }
export type QuantitativeRequest = ArithmeticRequest | CsvSummaryRequest;

/** Exponents over the base units s, V, W. Hz is s^-1; W is not decomposed into V·A (there is no ampere). */
export interface Dimensions { s: number; V: number; W: number }
export interface NormalisedQuantity { value: number; unit: string; baseValue: number; baseUnit: string }
export type QuantitativeErrorCode =
  | 'invalid-request' | 'expression-too-long' | 'too-many-tokens' | 'too-deep' | 'empty-expression' | 'disallowed-character'
  | 'power-not-supported' | 'function-not-supported' | 'property-not-supported' | 'comment-not-supported' | 'malformed-number'
  | 'unexpected-token' | 'unknown-variable' | 'dimension-mismatch' | 'dimension-too-complex'
  | 'division-by-zero' | 'nonfinite' | 'csv-missing' | 'csv-too-large' | 'csv-malformed' | 'csv-too-many-rows'
  | 'csv-too-many-columns' | 'csv-duplicate-header' | 'csv-column-missing' | 'csv-column-ambiguous';
export interface QuantitativeError { code: QuantitativeErrorCode; message: string }
export type ExpectedComparison =
  | ({ status: 'within-tolerance' | 'outside-tolerance'; tolerance: number; absoluteDifference: number; relativeDifference: number | null } & NormalisedQuantity)
  | ({ status: 'dimension-mismatch'; tolerance: number } & NormalisedQuantity);
export type SensitivitySide = { status: 'completed'; inputValue: number; value: number; change: number } | { status: 'error'; inputValue: number; error: QuantitativeError };
export interface SensitivityResult { variable: string; delta: number; unit: string; resultUnit: string; plus: SensitivitySide; minus: SensitivitySide }
export type CsvExclusionReason = 'empty' | 'non-numeric' | 'formula-like' | 'nonfinite';
export interface CsvSummary { count: number; sum: number; mean: number; min: number; max: number }

interface Common { schema: typeof QUANTITATIVE_SCHEMA; engine: 'cloudbite-quantitative'; limits: typeof CB_QUANTITATIVE_LIMITS; warnings: string[]; limitations: string[] }
export interface ArithmeticResult extends Common {
  status: 'completed'; kind: 'arithmetic'; inputSha256: string;
  expression: string; variables: Array<{ name: string } & NormalisedQuantity>;
  result: { value: number; unit: string; dimensions: Dimensions };
  expected?: ExpectedComparison; sensitivity?: SensitivityResult;
}
export interface CsvSummaryResult extends Common {
  status: 'completed'; kind: 'csv-summary'; inputSha256: string; csvSha256: string; csvBytes: number;
  column: string; columnIndex: number; unit: 'unknown';
  rows: { total: number; included: number; excluded: number; excludedByReason: Record<CsvExclusionReason, number>; excludedRecordSample: number[] };
  /** null when no cell was numeric; never a silent zero. */
  summary: CsvSummary | null;
}
export interface QuantitativeErrorResult extends Common {
  status: 'error'; kind: QuantitativeRequest['kind'] | 'unknown';
  /** sha256 of the canonical request (and CSV hash), or null when the request itself was invalid. */
  inputSha256: string | null; csvSha256?: string; error: QuantitativeError;
}
export type QuantitativeResult = ArithmeticResult | CsvSummaryResult | QuantitativeErrorResult;

const LIMITATIONS = [
  'Deterministic recomputation over the supplied values or stored text only; it does not prove the assumptions, data provenance or the decision built on them.',
  'The calculation is exactly what the user specified; the engine does not extract or verify claims.',
];
const ARITH_LIMITATIONS = ['Literals are dimensionless. Hz is treated as s^-1; W is a base unit, not decomposed into V·A.'];
const CSV_LIMITATIONS = ['CSV units are unknown: the engine never infers them from headers or cells.', 'Cells are read as text; formula-looking cells are never executed.'];

// ---------- units ----------
type Dims = [number, number, number];
const ZERO: Dims = [0, 0, 0];
const UNITS: Readonly<Record<string, { f: number; d: Dims }>> = Object.freeze({
  '': { f: 1, d: ZERO }, '1': { f: 1, d: ZERO },
  s: { f: 1, d: [1, 0, 0] }, ms: { f: 1e-3, d: [1, 0, 0] }, us: { f: 1e-6, d: [1, 0, 0] }, 'µs': { f: 1e-6, d: [1, 0, 0] }, 'μs': { f: 1e-6, d: [1, 0, 0] },
  ns: { f: 1e-9, d: [1, 0, 0] }, ps: { f: 1e-12, d: [1, 0, 0] },
  V: { f: 1, d: [0, 1, 0] }, mV: { f: 1e-3, d: [0, 1, 0] },
  Hz: { f: 1, d: [-1, 0, 0] }, kHz: { f: 1e3, d: [-1, 0, 0] }, MHz: { f: 1e6, d: [-1, 0, 0] }, GHz: { f: 1e9, d: [-1, 0, 0] },
  W: { f: 1, d: [0, 0, 1] }, mW: { f: 1e-3, d: [0, 0, 1] },
});
const unitOf = (u: string) => (Object.prototype.hasOwnProperty.call(UNITS, u) ? UNITS[u] : undefined);
const sameDims = (a: Dims, b: Dims) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function formatDims(d: Dims): string {
  if (sameDims(d, [-1, 0, 0])) return 'Hz';
  const parts: string[] = [];
  (['s', 'V', 'W'] as const).forEach((n, i) => { if (d[i] === 1) parts.push(n); else if (d[i] !== 0) parts.push(`${n}^${d[i]}`); });
  return parts.length ? parts.join('*') : '1';
}
const dimsObject = (d: Dims): Dimensions => ({ s: d[0], V: d[1], W: d[2] });

// ---------- request validation ----------
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every(k => keys.includes(k));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function parseQuantity(x: unknown, what: string): QuantityInput | string {
  if (!isRecord(x) || !onlyKeys(x, ['value', 'unit'])) return `${what} must be an object with value and unit only`;
  if (!finite(x.value)) return `${what}.value must be a finite number`;
  if (typeof x.unit !== 'string' || x.unit.length > L.unitChars) return `${what}.unit must be a string of at most ${L.unitChars} characters`;
  if (!unitOf(x.unit)) return `${what}.unit is not a supported unit`;
  return { value: x.value, unit: x.unit };
}

/** Strict shape check. Messages name fields and limits only, never the submitted values. */
export function parseQuantitativeRequest(input: unknown): QuantitativeRequest | { invalid: string } {
  const bad = (invalid: string) => ({ invalid });
  if (!isRecord(input)) return bad('request must be an object');
  if (input.kind === 'csv-summary') {
    if (!onlyKeys(input, ['kind', 'column'])) return bad('csv-summary accepts only kind and column');
    const c = input.column;
    if (typeof c !== 'string' || !c.length || c.length > L.columnChars || CONTROL.test(c)) return bad(`column must be a non-empty string of at most ${L.columnChars} characters without control characters`);
    return { kind: 'csv-summary', column: c };
  }
  if (input.kind !== 'arithmetic') return bad('kind must be arithmetic or csv-summary');
  if (!onlyKeys(input, ['kind', 'expression', 'variables', 'expected', 'tolerance', 'sensitivity'])) return bad('arithmetic request has an unsupported field');
  if (typeof input.expression !== 'string') return bad('expression must be a string');
  if (input.expression.length > L.expressionChars) return bad(`expression exceeds ${L.expressionChars} characters`);
  if (!isRecord(input.variables)) return bad('variables must be an object');
  const names = Object.keys(input.variables);
  if (names.length > L.variables) return bad(`at most ${L.variables} variables are allowed`);
  const variables: Record<string, QuantityInput> = Object.create(null);
  for (const [i, name] of names.entries()) {
    if (name.length > L.nameChars || !NAME.test(name)) return bad(`variable #${i + 1} has an invalid name (letters, digits, underscore; at most ${L.nameChars})`);
    const q = parseQuantity(input.variables[name], `variable #${i + 1}`);
    if (typeof q === 'string') return bad(q);
    variables[name] = q;
  }
  const out: ArithmeticRequest = { kind: 'arithmetic', expression: input.expression, variables };
  if (input.expected !== undefined) {
    const q = parseQuantity(input.expected, 'expected');
    if (typeof q === 'string') return bad(q);
    out.expected = q;
  }
  if (input.tolerance !== undefined) {
    if (!finite(input.tolerance) || input.tolerance < 0 || input.tolerance > 1) return bad('tolerance must be a relative tolerance in [0, 1]');
    out.tolerance = input.tolerance;
  }
  if (input.sensitivity !== undefined) {
    const s = input.sensitivity;
    if (!isRecord(s) || !onlyKeys(s, ['variable', 'delta'])) return bad('sensitivity must be an object with variable and delta only');
    if (typeof s.variable !== 'string' || !Object.prototype.hasOwnProperty.call(variables, s.variable)) return bad('sensitivity.variable must name a supplied variable');
    if (!finite(s.delta) || s.delta === 0) return bad('sensitivity.delta must be a finite non-zero number');
    out.sensitivity = { variable: s.variable, delta: s.delta };
  }
  return out;
}

// ---------- arithmetic ----------
type Tok = { t: 'num'; v: number; at: number } | { t: 'id'; v: string; at: number } | { t: 'op'; v: string; at: number };
type Node = { k: 'num'; v: number } | { k: 'var'; v: string; at: number } | { k: 'neg'; e: Node } | { k: 'bin'; op: string; a: Node; b: Node; at: number };
class Fail extends Error { constructor(readonly code: QuantitativeErrorCode, message: string) { super(message); } }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (toks.length >= L.tokens) throw new Fail('too-many-tokens', `expression exceeds ${L.tokens} tokens`);
    if (c === '*' && src[i + 1] === '*') throw new Fail('power-not-supported', `power is not supported (offset ${i})`);
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) throw new Fail('comment-not-supported', `comments are not supported (offset ${i})`);
    if (c === '^') throw new Fail('power-not-supported', `power is not supported (offset ${i})`);
    if (c === '#') throw new Fail('comment-not-supported', `comments are not supported (offset ${i})`);
    if ('+-*/()'.includes(c)) { toks.push({ t: 'op', v: c, at: i }); i++; continue; }
    if (c === '.' && toks.length && (toks[toks.length - 1].t === 'id' || toks[toks.length - 1].v === ')')) throw new Fail('property-not-supported', `property access is not supported (offset ${i})`);
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      const end = i + num[0].length;
      if (end < src.length && /[A-Za-z0-9_.]/.test(src[end])) throw new Fail('malformed-number', `malformed number at offset ${i} (units are given on variables, not literals)`);
      const v = Number(num[0]);
      if (!Number.isFinite(v)) throw new Fail('nonfinite', `literal at offset ${i} is not finite`);
      toks.push({ t: 'num', v, at: i }); i = end; continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      let j = i + id[0].length;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] === '(') throw new Fail('function-not-supported', `function calls are not supported (offset ${i})`);
      if (src[j] === '.' || src[j] === '[') throw new Fail('property-not-supported', `property access is not supported (offset ${i})`);
      toks.push({ t: 'id', v: id[0], at: i }); i += id[0].length; continue;
    }
    throw new Fail('disallowed-character', `disallowed character at offset ${i}`);
  }
  return toks;
}

function parseExpression(src: string): Node {
  if (src.length > L.expressionChars) throw new Fail('expression-too-long', `expression exceeds ${L.expressionChars} characters`);
  const toks = tokenize(src);
  if (!toks.length) throw new Fail('empty-expression', 'expression is empty');
  let p = 0;
  const peek = () => toks[p];
  const unexpected = (): never => { const t = toks[p]; throw new Fail('unexpected-token', t ? `unexpected token at offset ${t.at}` : 'unexpected end of expression'); };
  const expr = (depth: number): Node => {
    let a = term(depth);
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) { const t = toks[p++]; a = { k: 'bin', op: t.v as string, a, b: term(depth), at: t.at }; }
    return a;
  };
  const term = (depth: number): Node => {
    let a = unary(depth);
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) { const t = toks[p++]; a = { k: 'bin', op: t.v as string, a, b: unary(depth), at: t.at }; }
    return a;
  };
  const unary = (depth: number): Node => {
    if (depth > L.depth) throw new Fail('too-deep', `expression nests deeper than ${L.depth}`);
    const t = peek();
    if (!t) return unexpected();
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { p++; const e = unary(depth + 1); return t.v === '-' ? { k: 'neg', e } : e; }
    if (t.t === 'op' && t.v === '(') { p++; const e = expr(depth + 1); if (peek()?.v !== ')') return unexpected(); p++; return e; }
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'id') { p++; return { k: 'var', v: t.v, at: t.at }; }
    return unexpected();
  };
  const root = expr(0);
  if (p < toks.length) unexpected();
  return root;
}

type Q = { v: number; d: Dims };
const checkFinite = (v: number) => { if (!Number.isFinite(v)) throw new Fail('nonfinite', 'an intermediate result is not finite'); return v; };
function evaluate(n: Node, env: Map<string, Q>): Q {
  switch (n.k) {
    case 'num': return { v: n.v, d: ZERO };
    case 'var': { const q = env.get(n.v); if (!q) throw new Fail('unknown-variable', `unknown variable at offset ${n.at}`); return q; }
    case 'neg': { const q = evaluate(n.e, env); return { v: -q.v, d: q.d }; }
    case 'bin': {
      const a = evaluate(n.a, env), b = evaluate(n.b, env);
      if (n.op === '+' || n.op === '-') {
        if (!sameDims(a.d, b.d)) throw new Fail('dimension-mismatch', `cannot ${n.op === '+' ? 'add' : 'subtract'} ${formatDims(a.d)} and ${formatDims(b.d)} (offset ${n.at})`);
        return { v: checkFinite(n.op === '+' ? a.v + b.v : a.v - b.v), d: a.d };
      }
      const sign = n.op === '*' ? 1 : -1;
      const d: Dims = [a.d[0] + sign * b.d[0], a.d[1] + sign * b.d[1], a.d[2] + sign * b.d[2]];
      if (d.some(e => Math.abs(e) > L.dimensionExponent)) throw new Fail('dimension-too-complex', `unit exponent exceeds ${L.dimensionExponent} (offset ${n.at})`);
      if (n.op === '/' && b.v === 0) throw new Fail('division-by-zero', `division by zero (offset ${n.at})`);
      return { v: checkFinite(n.op === '*' ? a.v * b.v : a.v / b.v), d };
    }
  }
}
const normalise = (q: QuantityInput): Q => { const u = unitOf(q.unit)!; return { v: checkFinite(q.value * u.f), d: u.d }; };
const describe = (q: QuantityInput): NormalisedQuantity => { const n = normalise(q); return { value: q.value, unit: q.unit, baseValue: n.v, baseUnit: formatDims(n.d) }; };
const variablesInTree = (n: Node, out = new Set<string>()): Set<string> => {
  if (n.k === 'var') out.add(n.v); else if (n.k === 'neg') variablesInTree(n.e, out); else if (n.k === 'bin') { variablesInTree(n.a, out); variablesInTree(n.b, out); }
  return out;
};

// ---------- hashing ----------
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (isRecord(x)) return `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
/** sha256 of the canonical (sorted-key) JSON of the validated request, plus the CSV text's sha256 when one is used. */
export function quantitativeInputSha256(request: QuantitativeRequest, csvSha256?: string): string {
  return sha256Hex(canonical(csvSha256 === undefined ? { request } : { request, csvSha256 }));
}

const common = (extra: string[]): Common => ({ schema: QUANTITATIVE_SCHEMA, engine: 'cloudbite-quantitative', limits: CB_QUANTITATIVE_LIMITS, warnings: [], limitations: [...LIMITATIONS, ...extra] });
const failure = (kind: QuantitativeErrorResult['kind'], inputSha256: string | null, error: QuantitativeError, extra: string[], csvSha256?: string): QuantitativeErrorResult =>
  ({ ...common(extra), status: 'error', kind, inputSha256, ...(csvSha256 ? { csvSha256 } : {}), error });

function runArithmetic(req: ArithmeticRequest, inputSha256: string, csvSupplied: boolean): ArithmeticResult | QuantitativeErrorResult {
  try {
    const tree = parseExpression(req.expression);
    const env = new Map<string, Q>();
    for (const name of Object.keys(req.variables)) env.set(name, normalise(req.variables[name]));
    const used = variablesInTree(tree);
    const q = evaluate(tree, env);
    const res: ArithmeticResult = { ...common(ARITH_LIMITATIONS), status: 'completed', kind: 'arithmetic', inputSha256, expression: req.expression,
      variables: Object.keys(req.variables).map(name => ({ name, ...describe(req.variables[name]) })),
      result: { value: q.v, unit: formatDims(q.d), dimensions: dimsObject(q.d) } };
    const unused = Object.keys(req.variables).filter(n => !used.has(n)).length;
    if (unused) res.warnings.push(`${unused} supplied variable(s) are not used by the expression`);
    if (csvSupplied) res.warnings.push('CSV text was supplied but arithmetic does not read it');
    const tolerance = req.tolerance ?? 1e-9;
    if (req.tolerance !== undefined && !req.expected) res.warnings.push('tolerance was supplied without expected and was not used');
    if (req.expected) {
      const e = normalise(req.expected), shown = describe(req.expected);
      if (!sameDims(e.d, q.d)) res.expected = { status: 'dimension-mismatch', tolerance, ...shown };
      else {
        const diff = Math.abs(q.v - e.v), scale = Math.max(Math.abs(q.v), Math.abs(e.v));
        res.expected = { status: diff <= tolerance * scale ? 'within-tolerance' : 'outside-tolerance', tolerance, absoluteDifference: diff,
          relativeDifference: e.v === 0 ? null : diff / Math.abs(e.v), ...shown };
      }
    }
    if (req.sensitivity) {
      const { variable, delta } = req.sensitivity, base = req.variables[variable];
      if (!used.has(variable)) res.warnings.push('sensitivity variable is not used by the expression, so the result cannot change');
      const side = (sign: 1 | -1): SensitivitySide => {
        const inputValue = base.value + sign * delta;
        try {
          if (!Number.isFinite(inputValue)) throw new Fail('nonfinite', 'perturbed input is not finite');
          const local = new Map(env); local.set(variable, normalise({ value: inputValue, unit: base.unit }));
          const v = evaluate(tree, local).v;
          return { status: 'completed', inputValue, value: v, change: checkFinite(v - q.v) };
        } catch (err) { if (err instanceof Fail) return { status: 'error', inputValue, error: { code: err.code, message: err.message } }; throw err; }
      };
      if (base.value + delta === base.value || base.value - delta === base.value) res.warnings.push('sensitivity delta is below floating-point precision for this variable');
      res.sensitivity = { variable, delta, unit: base.unit, resultUnit: res.result.unit, plus: side(1), minus: side(-1) };
    }
    return res;
  } catch (err) {
    if (err instanceof Fail) return failure('arithmetic', inputSha256, { code: err.code, message: err.message }, ARITH_LIMITATIONS);
    throw err;
  }
}

// ---------- CSV ----------
/** Strict RFC 4180 reader: comma separator, CRLF or LF records, "" escapes inside quoted fields. Throws Fail. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', i = 0, quoted = false, fieldStarted = false;
  const record = () => (rows.length + 1);
  const endField = () => { row.push(field); field = ''; quoted = false; fieldStarted = false; if (row.length > L.csvColumns) throw new Fail('csv-too-many-columns', `more than ${L.csvColumns} columns (record ${record()})`); };
  const endRow = () => { endField(); rows.push(row); row = []; if (rows.length > L.csvRows + 1) throw new Fail('csv-too-many-rows', `more than ${L.csvRows} data rows`); };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++;
        const n = text[i];
        if (n !== undefined && n !== ',' && n !== '\n' && !(n === '\r' && text[i + 1] === '\n')) throw new Fail('csv-malformed', `unexpected character after a closing quote (record ${record()})`);
        fieldStarted = true; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (fieldStarted || field.length) throw new Fail('csv-malformed', `quote inside an unquoted field (record ${record()})`);
      quoted = true; fieldStarted = true; i++; continue;
    }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { if (text[i + 1] !== '\n') throw new Fail('csv-malformed', `bare carriage return (record ${record()})`); endRow(); i += 2; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (quoted) throw new Fail('csv-malformed', `unterminated quoted field (record ${record()})`);
  if (field.length || fieldStarted || row.length) endRow();
  return rows;
}

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NONFINITE_WORD = /^[+-]?(?:nan|inf|infinity)$/i;
function classify(cell: string): number | CsvExclusionReason {
  const s = cell.trim();
  if (!s) return 'empty';
  if (NUMERIC.test(s)) { const v = Number(s); return Number.isFinite(v) ? v : 'nonfinite'; }
  if (NONFINITE_WORD.test(s)) return 'nonfinite';
  if (/^[=+\-@]/.test(s)) return 'formula-like';
  return 'non-numeric';
}

function runCsv(req: CsvSummaryRequest, csvText: string | undefined): CsvSummaryResult | QuantitativeErrorResult {
  if (typeof csvText !== 'string') return failure('csv-summary', quantitativeInputSha256(req), { code: 'csv-missing', message: 'csv-summary needs the stored CSV text' }, CSV_LIMITATIONS);
  // Bound before hashing or parsing: UTF-16 length is a lower bound on UTF-8 bytes.
  if (csvText.length > L.csvBytes) return failure('csv-summary', null, { code: 'csv-too-large', message: `CSV exceeds ${L.csvBytes} bytes` }, CSV_LIMITATIONS);
  const csvBytes = new TextEncoder().encode(csvText).byteLength;
  if (csvBytes > L.csvBytes) return failure('csv-summary', null, { code: 'csv-too-large', message: `CSV exceeds ${L.csvBytes} bytes` }, CSV_LIMITATIONS);
  const csvSha256 = sha256Hex(csvText), inputSha256 = quantitativeInputSha256(req, csvSha256);
  const warnings: string[] = [];
  try {
    let text = csvText;
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); warnings.push('a leading byte-order mark was ignored'); }
    const rows = parseCsv(text);
    if (!rows.length) throw new Fail('csv-malformed', 'CSV has no header record');
    const header = rows[0];
    rows.slice(1).forEach((r, i) => { if (r.length !== header.length) throw new Fail('csv-malformed', `record ${i + 2} has ${r.length} fields, header has ${header.length}`); });
    if (new Set(header).size !== header.length) throw new Fail('csv-duplicate-header', 'CSV has duplicate header names');
    const norm = (s: string) => s.trim().toLowerCase();
    const similar = header.filter(h => norm(h) === norm(req.column));
    if (similar.length > 1) throw new Fail('csv-column-ambiguous', `${similar.length} headers match the column after trimming and case folding`);
    const columnIndex = header.indexOf(req.column);
    if (columnIndex < 0) throw new Fail('csv-column-missing', similar.length ? 'no header matches exactly; one differs only by case or surrounding space' : 'no header matches the column');
    const byReason: Record<CsvExclusionReason, number> = { empty: 0, 'non-numeric': 0, 'formula-like': 0, nonfinite: 0 };
    const sample: number[] = [];
    let count = 0, sum = 0, comp = 0, min = Infinity, max = -Infinity;
    rows.slice(1).forEach((r, i) => {
      const v = classify(r[columnIndex]);
      if (typeof v === 'string') { byReason[v]++; if (sample.length < L.excludedRowSample) sample.push(i + 2); return; }
      count++;
      const t = sum + v; comp += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum; sum = t; // Neumaier
      if (v < min) min = v; if (v > max) max = v;
    });
    const total = rows.length - 1, excluded = total - count;
    let summary: CsvSummary | null = null;
    if (count) {
      const s = sum + comp;
      if (!Number.isFinite(s)) throw new Fail('nonfinite', 'the column sum is not finite');
      summary = { count, sum: s, mean: s / count, min, max };
    } else warnings.push('no cell in the column was numeric; no summary was computed');
    if (excluded) warnings.push(`${excluded} cell(s) were excluded and are counted by reason; none were treated as zero`);
    if (byReason['formula-like']) warnings.push('formula-looking cells were read as text and never executed');
    return { ...common(CSV_LIMITATIONS), warnings, status: 'completed', kind: 'csv-summary', inputSha256, csvSha256, csvBytes,
      column: req.column, columnIndex, unit: 'unknown',
      rows: { total, included: count, excluded, excludedByReason: byReason, excludedRecordSample: sample }, summary };
  } catch (err) {
    if (err instanceof Fail) return { ...failure('csv-summary', inputSha256, { code: err.code, message: err.message }, CSV_LIMITATIONS, csvSha256), warnings };
    throw err;
  }
}

/**
 * Synchronous and pure. Re-validates `request` with parseQuantitativeRequest, so untyped callers are safe.
 * `csvText` is the actual stored text of the CSV artifact the caller bound; only csv-summary reads it.
 */
export function runQuantitativeCheck(request: unknown, csvText?: string): QuantitativeResult {
  const parsed = parseQuantitativeRequest(request);
  if ('invalid' in parsed) {
    const kind = isRecord(request) && (request.kind === 'arithmetic' || request.kind === 'csv-summary') ? request.kind : 'unknown';
    return failure(kind, null, { code: 'invalid-request', message: parsed.invalid }, []);
  }
  if (parsed.kind === 'csv-summary') return runCsv(parsed, csvText);
  return runArithmetic(parsed, quantitativeInputSha256(parsed), csvText !== undefined);
}
