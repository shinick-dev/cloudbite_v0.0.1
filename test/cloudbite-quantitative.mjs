// Cloudbite quantitative checks: deterministic arithmetic with units and strict CSV summaries (no eval, no network).
//   node test/cloudbite-quantitative.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-quantitative-'));
const built = await build({ entryPoints: ['src/cloudbite-quantitative.ts'], bundle: true, write: false, platform: 'browser', format: 'esm' });
const bundle = built.outputFiles[0].text;
writeFileSync(join(tmp, 'm.mjs'), bundle);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}`); throw e; } };
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const ar = (expression, variables = {}, extra = {}) => M.runQuantitativeCheck({ kind: 'arithmetic', expression, variables, ...extra });
const err = (r, code) => { assert.equal(r.status, 'error', JSON.stringify(r)); assert.equal(r.error.code, code, r.error.message); return r; };
const close = (a, b) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1e-300), `${a} vs ${b}`);

t('bundle is browser-safe and never evaluates code', () => {
  assert.doesNotMatch(bundle, /\beval\s*\(|new Function|\bFunction\s*\(|require\(|node:|fetch\(|XMLHttpRequest|import\(/);
  const src = readFileSync('src/cloudbite-quantitative.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\beval\b|new Function|child_process|node:fs|fetch\(/);
});

t('unit normalisation and dimension-aware addition', () => {
  const r = ar('a + b', { a: { value: 1, unit: 'ns' }, b: { value: 500, unit: 'ps' } });
  assert.equal(r.status, 'completed'); close(r.result.value, 1.5e-9); assert.equal(r.result.unit, 's');
  assert.deepEqual(r.result.dimensions, { s: 1, V: 0, W: 0 });
  assert.equal(r.variables[1].baseUnit, 's'); close(r.variables[1].baseValue, 5e-10);
  close(ar('a', { a: { value: 3, unit: 'us' } }).result.value, 3e-6);
  close(ar('a', { a: { value: 3, unit: 'µs' } }).result.value, 3e-6);
  close(ar('v', { v: { value: 800, unit: 'mV' } }).result.value, 0.8);
  close(ar('p', { p: { value: 25, unit: 'mW' } }).result.value, 0.025);
  const f = ar('f', { f: { value: 2, unit: 'GHz' } }); close(f.result.value, 2e9); assert.equal(f.result.unit, 'Hz');
  assert.equal(ar('x', { x: { value: 2, unit: '' } }).result.unit, '1');
  assert.equal(ar('x', { x: { value: 2, unit: '1' } }).result.unit, '1');
});

t('additive mismatch, unknown unit, honest multiplication/division dimensions', () => {
  err(ar('a + b', { a: { value: 1, unit: 'ns' }, b: { value: 1, unit: 'V' } }), 'dimension-mismatch');
  err(ar('a - 1', { a: { value: 1, unit: 'ns' } }), 'dimension-mismatch');
  const u = err(ar('a', { a: { value: 1, unit: 'furlong' } }), 'invalid-request');
  assert.doesNotMatch(JSON.stringify(u), /furlong/);
  err(ar('a', { a: { value: 1, unit: 'MV' } }), 'invalid-request'); // case-sensitive: no megavolt
  const cyc = ar('t * f', { t: { value: 500, unit: 'ps' }, f: { value: 2, unit: 'GHz' } });
  close(cyc.result.value, 1); assert.equal(cyc.result.unit, '1');
  const per = ar('1 / t', { t: { value: 1, unit: 'ns' } }); close(per.result.value, 1e9); assert.equal(per.result.unit, 'Hz');
  const e = ar('p * t', { p: { value: 2, unit: 'W' }, t: { value: 3, unit: 'ms' } }); close(e.result.value, 6e-3); assert.equal(e.result.unit, 's*W');
  const vv = ar('v * v / p', { v: { value: 2, unit: 'V' }, p: { value: 1, unit: 'W' } }); assert.equal(vv.result.unit, 'V^2*W^-1');
  err(ar('t*t*t*t*t*t*t*t*t', { t: { value: 1, unit: 's' } }), 'dimension-too-complex');
});

t('arithmetic precedence, unary and parentheses', () => {
  assert.equal(ar('1 + 2 * 3').result.value, 7);
  assert.equal(ar('(1 + 2) * 3').result.value, 9);
  assert.equal(ar('-(2 - 5) / 3').result.value, 1);
  assert.equal(ar('--2 + +3').result.value, 5);
  assert.equal(ar('8 / 4 / 2').result.value, 1);
  assert.equal(ar('1e3 * .5').result.value, 500);
});

t('arithmetic safety limits', () => {
  err(ar('2 ** 3'), 'power-not-supported');
  err(ar('2 ^ 3'), 'power-not-supported');
  err(ar('sqrt(4)'), 'function-not-supported');
  err(ar('constructor (1)'), 'function-not-supported');
  err(ar('a.constructor', { a: { value: 1, unit: '' } }), 'property-not-supported');
  err(ar('a [0]', { a: { value: 1, unit: '' } }), 'property-not-supported');
  err(ar('(1).x'), 'property-not-supported');
  err(ar('1 // c'), 'comment-not-supported');
  err(ar('1 /* c */'), 'comment-not-supported');
  err(ar('1 # c'), 'comment-not-supported');
  err(ar('"x"'), 'disallowed-character');
  err(ar('a; b'), 'disallowed-character');
  err(ar('2ms'), 'malformed-number');
  err(ar('1.2.3'), 'malformed-number');
  err(ar('   '), 'empty-expression');
  err(ar('1 +'), 'unexpected-token');
  err(ar('(1'), 'unexpected-token');
  err(ar('1 2'), 'unexpected-token');
  err(ar('x'), 'unknown-variable');
  err(ar('__proto__'), 'unknown-variable');
  err(ar('1+'.repeat(200) + '1'), 'too-many-tokens');
  err(ar('('.repeat(40) + '1' + ')'.repeat(40)), 'too-deep');
  err(ar('-'.repeat(40) + '1'), 'too-deep');
  err(ar('1'.repeat(513)), 'invalid-request');
  err(ar('1e400'), 'nonfinite');
  err(ar('1e300 * 1e300'), 'nonfinite');
  err(ar('a', { 'a-b': { value: 1, unit: '' } }), 'invalid-request');
  err(ar('a', { a: { value: Infinity, unit: '' } }), 'invalid-request');
  err(ar('a', { a: { value: '1', unit: '' } }), 'invalid-request');
  err(ar('a', { a: { value: 1, unit: '', extra: 1 } }), 'invalid-request');
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`v${i}`, { value: 1, unit: '' }]));
  err(ar('v0', many), 'invalid-request');
  err(M.runQuantitativeCheck({ kind: 'arithmetic', expression: '1', variables: {}, code: 'x' }), 'invalid-request');
  err(M.runQuantitativeCheck(null), 'invalid-request');
  assert.equal(M.runQuantitativeCheck({ kind: 'python' }).kind, 'unknown');
});

t('division by zero, including via units', () => {
  err(ar('1 / 0'), 'division-by-zero');
  err(ar('a / (b - b)', { a: { value: 1, unit: 'V' }, b: { value: 3, unit: 'ns' } }), 'division-by-zero');
});

t('invalid errors never echo request values', () => {
  const secret = 'sk-SECRET-123';
  for (const r of [
    ar(secret), ar('a', { [secret]: { value: 1, unit: '' } }), ar('a', { a: { value: 1, unit: secret } }),
    M.runQuantitativeCheck({ kind: 'csv-summary', column: secret + '\n' }), M.runQuantitativeCheck({ kind: secret }),
    ar('x', {}, { sensitivity: { variable: secret, delta: 1 } }),
  ]) { assert.equal(r.status, 'error'); assert.doesNotMatch(JSON.stringify(r), /SECRET/); }
});

t('expected comparison with relative tolerance in base units', () => {
  const v = { t: { value: 500, unit: 'ps' }, n: { value: 4, unit: '' } };
  const within = ar('t * n', v, { expected: { value: 2, unit: 'ns' } });
  assert.equal(within.expected.status, 'within-tolerance'); assert.equal(within.expected.baseUnit, 's'); close(within.expected.baseValue, 2e-9);
  const off = ar('t * n', v, { expected: { value: 2.01, unit: 'ns' } });
  assert.equal(off.expected.status, 'outside-tolerance'); assert.ok(off.expected.relativeDifference > 0.004);
  assert.equal(ar('t * n', v, { expected: { value: 2.01, unit: 'ns' }, tolerance: 0.01 }).expected.status, 'within-tolerance');
  assert.equal(ar('t * n', v, { expected: { value: 2, unit: 'V' } }).expected.status, 'dimension-mismatch');
  assert.equal(ar('0', {}, { expected: { value: 0, unit: '' } }).expected.status, 'within-tolerance');
  assert.equal(ar('0', {}, { expected: { value: 0, unit: '' } }).expected.relativeDifference, null);
  err(ar('1', {}, { expected: { value: 1, unit: '' }, tolerance: 2 }), 'invalid-request');
  err(ar('1', {}, { expected: { value: 1, unit: '' }, tolerance: -0.1 }), 'invalid-request');
  assert.match(ar('1', {}, { tolerance: 0.1 }).warnings.join(' '), /without expected/);
});

t('sensitivity: explicit ±delta in the variable unit, finite and invalid perturbations', () => {
  const r = ar('t * f', { t: { value: 500, unit: 'ps' }, f: { value: 2, unit: 'GHz' } }, { sensitivity: { variable: 't', delta: 50 } });
  assert.equal(r.sensitivity.unit, 'ps'); assert.equal(r.sensitivity.resultUnit, '1');
  assert.equal(r.sensitivity.plus.status, 'completed'); assert.equal(r.sensitivity.plus.inputValue, 550);
  close(r.sensitivity.plus.value, 1.1); close(r.sensitivity.minus.value, 0.9); close(r.sensitivity.plus.change, 0.1);
  const z = ar('1 / x', { x: { value: 1, unit: '' } }, { sensitivity: { variable: 'x', delta: 1 } });
  assert.equal(z.status, 'completed'); assert.equal(z.sensitivity.plus.status, 'completed');
  assert.equal(z.sensitivity.minus.status, 'error'); assert.equal(z.sensitivity.minus.error.code, 'division-by-zero');
  const big = ar('x', { x: { value: 1.7e308, unit: '' } }, { sensitivity: { variable: 'x', delta: 1.7e308 } });
  assert.equal(big.sensitivity.plus.status, 'error'); assert.equal(big.sensitivity.plus.error.code, 'nonfinite');
  assert.match(ar('x', { x: { value: 1e20, unit: '' } }, { sensitivity: { variable: 'x', delta: 1 } }).warnings.join(' '), /precision/);
  assert.match(ar('1', { x: { value: 1, unit: '' } }, { sensitivity: { variable: 'x', delta: 1 } }).warnings.join(' '), /cannot change/);
  for (const s of [{ variable: 'x', delta: 0 }, { variable: 'x', delta: NaN }, { variable: 'x', delta: Infinity }, { variable: 'y', delta: 1 }, { variable: 'x', delta: 1, unit: 'ms' }, { variable: 'toString', delta: 1 }])
    err(ar('x', { x: { value: 1, unit: '' } }, { sensitivity: s }), 'invalid-request');
});

t('parseQuantitativeRequest returns a null-prototype variable map and strict shapes', () => {
  const p = M.parseQuantitativeRequest(JSON.parse('{"kind":"arithmetic","expression":"__proto__ + 1","variables":{"__proto__":{"value":2,"unit":""}}}'));
  assert.equal(Object.getPrototypeOf(p.variables), null); assert.equal(p.variables.__proto__.value, 2);
  assert.equal(M.runQuantitativeCheck(JSON.parse('{"kind":"arithmetic","expression":"__proto__ + 1","variables":{"__proto__":{"value":2,"unit":""}}}')).result.value, 3);
  assert.deepEqual(M.parseQuantitativeRequest({ kind: 'csv-summary', column: 'delay' }), { kind: 'csv-summary', column: 'delay' });
  assert.ok('invalid' in M.parseQuantitativeRequest({ kind: 'csv-summary', column: 'a', path: '/etc/passwd' }));
  assert.ok('invalid' in M.parseQuantitativeRequest({ kind: 'csv-summary', column: '' }));
});

const csv = (column, text) => M.runQuantitativeCheck({ kind: 'csv-summary', column }, text);

t('quoted CSV, CRLF, explicit omissions, formula cells never executed, unknown unit', () => {
  const text = 'name,"delay, ns",note\r\n"a ""x""",1.5,ok\r\nb,2.5,"multi\r\nline"\r\nc,,x\r\nd,=1+1,x\r\ne,NaN,x\r\nf,1e999,x\r\ng,abc,x\r\nh,-3,x\r\n';
  const r = csv('delay, ns', text);
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.equal(r.unit, 'unknown'); assert.equal(r.columnIndex, 1);
  assert.deepEqual(r.rows.excludedByReason, { empty: 1, 'non-numeric': 1, 'formula-like': 1, nonfinite: 2 });
  assert.equal(r.rows.total, 8); assert.equal(r.rows.included, 3); assert.equal(r.rows.excluded, 5);
  assert.deepEqual(r.rows.excludedRecordSample, [4, 5, 6, 7, 8]);
  assert.deepEqual(r.summary, { count: 3, sum: 1, mean: 1 / 3, min: -3, max: 2.5 });
  assert.match(r.warnings.join(' '), /never executed/); assert.match(r.warnings.join(' '), /none were treated as zero/);
  assert.equal(r.csvSha256, sha(text)); assert.equal(r.csvBytes, Buffer.byteLength(text));
  const lf = csv('v', 'v\n1\n2\n3'); assert.equal(lf.summary.sum, 6); assert.equal(lf.summary.mean, 2);
  const bom = csv('v', '﻿v\n4\n'); assert.equal(bom.summary.sum, 4); assert.match(bom.warnings.join(' '), /byte-order/);
  const none = csv('v', 'v\nx\n'); assert.equal(none.status, 'completed'); assert.equal(none.summary, null);
  assert.equal(csv('v', 'v\n0.1\n0.2\n0.3\n').summary.sum, 0.6); // compensated summation
});

t('CSV malformed, duplicate, missing and ambiguous columns', () => {
  err(csv('a', 'a,b\n1\n'), 'csv-malformed');
  err(csv('a', 'a,b\n"1,2\n'), 'csv-malformed');
  err(csv('a', 'a,b\n"1"x,2\n'), 'csv-malformed');
  err(csv('a', 'a,b\n1"2,3\n'), 'csv-malformed');
  err(csv('a', 'a,b\r1,2\n'), 'csv-malformed');
  err(csv('a', 'a,b\n1,1\n\n2,2\n'), 'csv-malformed'); // blank record
  err(csv('a', ''), 'csv-malformed');
  err(csv('a', 'a,a\n1,2\n'), 'csv-duplicate-header');
  err(csv('z', 'a,b\n1,2\n'), 'csv-column-missing');
  assert.match(err(csv('A', 'a,b\n1,2\n'), 'csv-column-missing').error.message, /case/);
  err(csv('a', 'a,A \n1,2\n'), 'csv-column-ambiguous');
  err(M.runQuantitativeCheck({ kind: 'csv-summary', column: 'a' }), 'csv-missing');
  const leak = csv('a', 'a,b\nSECRETCELL\n');
  assert.doesNotMatch(JSON.stringify(leak), /SECRETCELL/);
});

t('CSV size, row and column bounds are enforced before work', () => {
  const big = 'v\n' + '1\n'.repeat(33 * 1024);
  const r = err(csv('v', big), 'csv-too-large'); assert.equal(r.inputSha256, null);
  err(csv('v', 'v\n' + 'é\n'.repeat(22 * 1024)), 'csv-too-large'); // multi-byte UTF-8 exceeds 64 KiB
  err(csv('v', 'v\n' + '1\n'.repeat(1001)), 'csv-too-many-rows');
  assert.equal(csv('v', 'v\n' + '1\n'.repeat(1000)).summary.count, 1000);
  err(csv('c0', Array.from({ length: 33 }, (_, i) => `c${i}`).join(',') + '\n'), 'csv-too-many-columns');
  assert.equal(csv('c0', Array.from({ length: 32 }, (_, i) => `c${i}`).join(',') + '\n' + Array(32).fill(1).join(',') + '\n').summary.sum, 1);
});

t('stable input hashes bind the canonical request and the actual CSV bytes', () => {
  const a = M.runQuantitativeCheck({ kind: 'arithmetic', expression: 'a*2', variables: { a: { value: 1, unit: 'ns' } } });
  const b = M.runQuantitativeCheck({ variables: { a: { unit: 'ns', value: 1 } }, expression: 'a*2', kind: 'arithmetic' });
  assert.match(a.inputSha256, /^[0-9a-f]{64}$/); assert.equal(a.inputSha256, b.inputSha256);
  assert.equal(a.inputSha256, sha('{"request":{"expression":"a*2","kind":"arithmetic","variables":{"a":{"unit":"ns","value":1}}}}'));
  assert.notEqual(a.inputSha256, ar('a*2', { a: { value: 1, unit: 'ps' } }).inputSha256);
  const c1 = csv('v', 'v\n1\n'), c2 = csv('v', 'v\r\n1\r\n');
  assert.equal(c1.summary.sum, c2.summary.sum); assert.notEqual(c1.inputSha256, c2.inputSha256); assert.notEqual(c1.csvSha256, c2.csvSha256);
  assert.equal(c1.inputSha256, M.quantitativeInputSha256({ kind: 'csv-summary', column: 'v' }, sha('v\n1\n')));
  assert.equal(csv('v', 'v\n1\n').inputSha256, c1.inputSha256);
  assert.equal(err(ar('1/0'), 'division-by-zero').inputSha256, ar('1/0').inputSha256);
  assert.equal(M.runQuantitativeCheck({ kind: 'x' }).inputSha256, null);
});

t('every result carries limits and limitations', () => {
  for (const r of [ar('1'), csv('v', 'v\n1\n'), ar('1/0'), M.runQuantitativeCheck(7)]) {
    assert.equal(r.schema, 'cloudbite.quantitative.v1'); assert.equal(r.limits.csvBytes, 65536);
    assert.ok(Array.isArray(r.limitations) && Array.isArray(r.warnings));
  }
  assert.match(ar('1').limitations.join(' '), /does not prove/);
  assert.match(csv('v', 'v\n1\n').limitations.join(' '), /never infers/);
});

console.log(`cloudbite-quantitative: ${passed} passed`);
