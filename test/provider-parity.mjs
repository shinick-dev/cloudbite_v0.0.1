// 공급자 정의 정규화(canonUpstream·normalizeDef) 회귀 테스트. src/providers.ts 를 설치된 esbuild 로 번들해 그대로 부른다.
// 기대값은 손으로 적은 표다 (구현을 베끼지 않는다). 네트워크·서버·비밀 값은 쓰지 않는다.
//   node test/provider-parity.mjs [다른 providers.ts 경로 — 기준 커밋 비교용]

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'src/providers.ts');
const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'provider-parity-'));
writeFileSync(join(dir, 'providers.mjs'), bundled.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(join(dir, 'providers.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const { canonUpstream, normalizeDef, PRESETS } = mod;

globalThis.fetch = async (u) => { throw new Error(`network blocked in test: ${u}`); };

let pass = 0, failN = 0;
const check = (name, actual, expected) => {
  if (isDeepStrictEqual(actual, expected)) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`); }
};
const presetsBefore = structuredClone(PRESETS);

console.log('canonUpstream');
const UP = [
  // [입력, devHttp, 기대]
  ['https://API.Example.com/v1//', false, 'https://api.example.com/v1'],
  ['https://a.example/a%20b', false, 'https://a.example/a%20b'],
  ['https://a.example:8443/', true, 'https://a.example:8443'],
  ['http://localhost:8787/x/', true, 'http://localhost:8787/x'],
  ['http://LOCALHOST/', true, 'http://localhost'],
  ['http://127.0.0.1:9/', true, 'http://127.0.0.1:9'],
  ['http://127.1/', true, 'http://127.0.0.1'], // URL 이 정규화한 hostname 으로 본다
  ['http://localhost:8787/x', false, null],
  ['http://example.com/', true, null],
  ['http://[::1]:8/', true, null],
  ['http://localhost.example/', true, null],
  ['ftp://a.example/', true, null],
  [123, false, null], ['', false, null], [`https://a.example/${'a'.repeat(300)}`, false, null],
  ['https://a.example/ x', false, null], ['https://a.example\\x', false, null], ['https://u@a.example/', false, null],
  ['https://a.example/?q=1', false, null], ['https://a.example/#f', false, null], ['https://é.example/', false, null],
  ['https://a.example./', false, null], ['https://a.example/%ZZ', false, null],
  ['https://a.example/a%2fb', false, null], ['https://a.example/a%5Cb', false, null], ['https://a.example/a%2Eb', false, null],
];
for (const [raw, dev, want] of UP) check(`${JSON.stringify(raw).slice(0, 50)} dev=${dev}`, canonUpstream(raw, dev), want);

console.log('normalizeDef — preset 대체 규칙 (undefined·빈 문자열만 대체, null·false·0 은 입력값)');
const groq = (extra) => normalizeDef({ preset: 'groq', ...extra });
const GROQ = { id: 'groq', label: 'Groq', kind: 'proxy', upstream: 'https://api.groq.com', auth: 'bearer', envKey: 'GROQ_API_KEY', envBase: 'GROQ_BASE_URL', basePath: '', claude: false, note: undefined, labShare: undefined };
check('preset 그대로', groq({}), GROQ);
check('id·label undefined/빈 문자열 → preset', groq({ id: '', label: undefined }), GROQ);
check('label null → id 로', groq({ label: null }), { ...GROQ, label: 'groq' });
check('label false·0 → 문자열', [groq({ label: false }).label, groq({ label: 0 }).label], ['false', '0']);
check('envBase 빈 문자열 → preset, null·0 → 없음', [groq({ envBase: '' }).envBase, groq({ envBase: null }).envBase, groq({ envBase: 0 }).envBase], ['GROQ_BASE_URL', undefined, undefined]);
check('basePath hf: 빈 문자열 → /v1, null → "", /x/ → /x', [normalizeDef({ preset: 'hf', basePath: '' }).basePath, normalizeDef({ preset: 'hf', basePath: null }).basePath, normalizeDef({ preset: 'hf', basePath: '/x/' }).basePath], ['/v1', '', '/x']);
check('claude openrouter: 빈 문자열 → true, false·0 → false', [normalizeDef({ preset: 'openrouter', claude: '' }).claude, normalizeDef({ preset: 'openrouter', claude: false }).claude, normalizeDef({ preset: 'openrouter', claude: 0 }).claude], [true, false, false]);
check('note 자르기·null', [groq({ note: 'n'.repeat(250) }).note.length, groq({ note: null }).note], [200, undefined]);
check('label 40자', groq({ label: 'L'.repeat(50) }).label.length, 40);
check('labShare 는 true 만', [groq({ labShare: true }).labShare, groq({ labShare: 'true' }).labShare, groq({ labShare: 1 }).labShare], [true, undefined, undefined]);
check('kind 은 openrouter-mint 아니면 proxy', groq({ kind: 'weird' }).kind, 'proxy');
check('upstream 끝 / 정리', groq({ upstream: 'https://Api.Groq.com/openai/v1/' }).upstream, 'https://api.groq.com/openai/v1');
check('devHttp localhost', normalizeDef({ preset: 'groq', upstream: 'http://localhost:9999' }, true).upstream, 'http://localhost:9999');
check('devHttp 없이 http 거부', typeof normalizeDef({ preset: 'groq', upstream: 'http://localhost:9999' }), 'string');

console.log('normalizeDef — headers (\'headers\' in input)');
check('headers 없음', 'headers' in groq({}), false);
check('headers undefined·null → 없음', ['headers' in groq({ headers: undefined }), 'headers' in groq({ headers: null })], [false, false]);
check('headers 문자열', groq({ headers: 'X-Tenant-Id: t1; x-b: 2' }).headers, { 'x-tenant-id': 't1', 'x-b': '2' });
const inherited = Object.assign(Object.create({ headers: 'x-from-proto: 1' }), { preset: 'groq' });
check('상속된 headers 도 in 으로 본다', normalizeDef(inherited).headers, { 'x-from-proto': '1' });

console.log('normalizeDef — 에러 우선순위');
const E = (input) => { const r = normalizeDef(input); return typeof r === 'string' ? r : null; };
const bad = { id: 'BAD!', upstream: 'http://x', auth: 'nope', envKey: 'low', envBase: 'low', kind: 'openrouter-mint', labShare: true };
check('headers 에러가 먼저', E({ ...bad, headers: 'authorization: x' }), '고정 헤더 이름은 x- 로 시작해야 하고 인증·전달 헤더(x-api-key 등)는 안 됩니다: authorization');
check('그다음 id', E(bad), 'id 는 소문자·숫자·- 로 24자 이내');
check('그다음 upstream', E({ ...bad, id: 'ok' }).startsWith('upstream 은'), true);
check('그다음 Daytona 관리 base', E({ ...bad, id: 'ok', upstream: 'https://app.daytona.io/api/organizations' }).startsWith('Daytona upstream'), true);
check('그다음 labShare 막힘', E({ ...bad, id: 'ok', upstream: 'https://a.example' }).startsWith('Daytona·OpenRouter'), true);
check('그다음 auth', E({ ...bad, id: 'ok', upstream: 'https://a.example', labShare: false }), 'auth 가 올바르지 않습니다');
check('그다음 envKey', E({ ...bad, id: 'ok', upstream: 'https://a.example', labShare: false, auth: 'x-api-key' }).startsWith('envKey'), true);
check('그다음 envBase', E({ ...bad, id: 'ok', upstream: 'https://a.example', labShare: false, auth: 'x-api-key', envKey: 'K' }).startsWith('envBase'), true);
check('마지막 openrouter-mint 제한', E({ ...bad, id: 'ok', upstream: 'https://a.example', labShare: false, auth: 'x-api-key', envKey: 'K', envBase: 'B' }), 'openrouter-mint 는 https://openrouter.ai (bearer) 전용');
check('openrouter preset 은 통과', typeof normalizeDef({ preset: 'openrouter' }), 'object');
check('Daytona preset labShare 거부', E({ preset: 'daytona', labShare: true }).startsWith('Daytona·OpenRouter'), true);

console.log('입력·PRESETS 를 바꾸지 않는다');
const input = Object.freeze({ preset: 'groq', upstream: 'https://api.groq.com/v1/', headers: Object.freeze({ 'X-A': ' 1 ' }) });
const r = normalizeDef(input);
r.label = 'changed'; r.headers['x-a'] = 'changed';
check('입력 그대로', input, { preset: 'groq', upstream: 'https://api.groq.com/v1/', headers: { 'X-A': ' 1 ' } });
check('PRESETS 그대로', PRESETS, presetsBefore);
check('결과는 PRESETS 객체가 아니다', PRESETS.includes(groq({})), false);

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
