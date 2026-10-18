// 공부방 입장 시간 재기(P1) 회귀 테스트. src/lab-timing.ts·src/labhost.ts 를 설치된 esbuild 로 번들해 그대로 부른다:
//   - labTiming 값 정리: 정한 이름·유한 숫자만, 0..상한 정수 ms (ID·코드·주소·문구는 버린다)
//   - POST /__lab/wake: 성공 결과의 labTiming 은 공개 JSON 에서 빠지고 Server-Timing 헤더로만. 실패 응답은 그대로
//   - 자리 호스트 프록시: HTML 최상위 문서에만 upstream;dur=, 본문은 버퍼에 담지 않음. 101(WebSocket)·자산·오류 경로는 그대로
//   - /__lab/perf.js 는 자리 없이 같은 출처 정적 스크립트, 막대 스크립트 순서 맨 뒤 (nonce 같은 값)
//   - state.ts labJoin 순서: 자리 확인 → 이름 → Daytona 키 → #prep.ensure → ready 일 때만 다시 확인하며 opened → 감사
//     (자료가 진행 중이면 starting, 끝났는지 모르면 opened·감사 없이 502),
//     실패 return 에 labTiming 없음, 시계는 total 만 (소스 구조 검사). 준비 서비스는 who·opened·pv·감사를 쓰지 않음
// 네트워크·비밀 값 없음 (fetch 는 가짜, 값은 전부 더미).  node test/lab-server-timing.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
async function load(entry, name) {
  const out = await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
  const dir = mkdtempSync(join(tmpdir(), 'lab-server-timing-'));
  writeFileSync(join(dir, name), out.outputFiles[0].text);
  try { return await import(pathToFileURL(join(dir, name)).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const T = await load('src/lab-timing.ts', 'timing.mjs');
const H = await load('src/labhost.ts', 'labhost.mjs');

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`); }
};
const ST_RE = /^(sandbox|materials|health|start|total|prep_(queue|wait|elapsed|sandbox|wake|materials|health|start));dur=\d+(, (sandbox|materials|health|start|total|prep_(queue|wait|elapsed|sandbox|wake|materials|health|start));dur=\d+)*$/;

// ── 1. 값 정리 ──
console.log('lab-timing 정리');
check('labDur 유한 숫자 → 정수', T.labDur(12.6) === 13 && T.labDur(0) === 0);
check('labDur 음수 → 0', T.labDur(-5) === 0);
check('labDur 상한', T.labDur(1e12) === 600000);
check('labDur 숫자 아님·NaN·Infinity → null', [NaN, Infinity, -Infinity, '12', null, undefined, {}, 12n].every((x) => T.labDur(x) === null));
const dirty = { sandbox: 5.4, materials: '9', health: -3, start: NaN, total: Infinity, code: 'ABCDEFGHIJKLMNOP', url: 'https://sb.example.test/x?token=t', error: 'boom' };
const clean = T.labTimingClean(dirty);
check('labTimingClean: 정한 이름·숫자만', JSON.stringify(clean) === JSON.stringify({ sandbox: 5, health: 0 }), JSON.stringify(clean));
check('labTimingClean: 객체 아님 → {}', [null, 'x', 5, undefined].every((x) => JSON.stringify(T.labTimingClean(x)) === '{}'));
const proto = Object.create({ total: 7 });
check('labTimingClean: 상속된 키는 안 본다', JSON.stringify(T.labTimingClean(proto)) === '{}');
check('serverTiming: 고정 순서·형식', T.serverTiming({ total: 9, sandbox: 1, start: 2 }) === 'sandbox;dur=1, start;dur=2, total;dur=9');
check('serverTiming: 비면 빈 문자열', T.serverTiming({}) === '');
check('upstreamTiming', T.upstreamTiming(41.2) === 'upstream;dur=41' && T.upstreamTiming(NaN) === '' && T.upstreamTiming('5') === '' && T.upstreamTiming(-1) === 'upstream;dur=0');
{
  let clk = 1000;
  const t = T.labTimer(() => clk);
  let at = t.now(); clk += 30; t.add('sandbox', at);
  at = t.now(); clk += 5; t.add('start', at);
  at = t.now(); clk += 7; t.add('start', at);
  clk += 100;
  const d = T.withLabTiming({ status: 'ready', name: 'x' }, t);
  check('labTimer: 단계 합·total', JSON.stringify(d.labTiming) === JSON.stringify({ sandbox: 30, start: 12, total: 142 }), JSON.stringify(d.labTiming));
  check('withLabTiming: 원래 필드 유지', d.status === 'ready' && d.name === 'x');
  const { body, header } = T.takeLabTiming(d);
  check('takeLabTiming: 떼어 냄', !('labTiming' in body) && body.status === 'ready' && header === 'sandbox;dur=30, start;dur=12, total;dur=142');
  const shared = T.withLabTiming({ status: 'ready' }, t, { prep_queue: 2000, prep_elapsed: 3000, prep_materials: 23, total: 99, sandbox: 888, description: 'secret', prep_health: Infinity });
  check('withLabTiming: 요청 total은 따로, prep 고정 숫자만', T.takeLabTiming(shared).header === 'sandbox;dur=30, start;dur=12, total;dur=142, prep_queue;dur=2000, prep_elapsed;dur=3000, prep_materials;dur=23', shared.labTiming);
}

// ── 2. 입장 호스트 POST /__lab/wake ──
console.log('입장 호스트 /__lab/wake');
const LAB_ORIGIN = 'https://lab.example.test', SEAT_DOMAIN = 'example.test';
const ENV = { ORIGIN: 'https://k.example.test', LAB_ORIGIN, LAB_SEAT_DOMAIN: SEAT_DOMAIN };
const CODE = 'abcdEFGH1234_-xy';
const calls = [];
let replies = {};
const state = new Proxy({}, { get: (_, k) => (typeof k !== 'string' || k === 'then') ? undefined : async (...args) => {
  calls.push([k, ...args]);
  const r = replies[k];
  return typeof r === 'function' ? r(...args) : r;
} });
async function wake(body = { code: CODE, name: 'n' }, path = '/__lab/wake', extra = {}) {
  calls.length = 0;
  const req = new Request(LAB_ORIGIN + path, { method: 'POST', headers: { origin: LAB_ORIGIN, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const res = await H.labHost(req, ENV, state, new URL(req.url));
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch {}
  return { res, raw, j, st: res.headers.get('server-timing') };
}
const secureJson = (res) => res.headers.get('cache-control') === 'no-store' && res.headers.get('x-content-type-options') === 'nosniff'
  && res.headers.get('referrer-policy') === 'no-referrer' && res.headers.get('x-frame-options') === 'DENY'
  && res.headers.get('content-type') === 'application/json' && !!res.headers.get('content-security-policy');

replies.labJoin = () => ({ name: '수업', seat: 3, status: 'ready', label: 'l', labTiming: { ...dirty, total: 812.4 } });
{
  const r = await wake();
  check('ready: 200·보안 헤더', r.res.status === 200 && secureJson(r.res));
  check('ready: JSON 에 labTiming 없음', r.j && !('labTiming' in r.j) && !/labTiming|dur|ABCDEFGHIJKLMNOP|token|boom/.test(r.raw), r.raw);
  check('ready: 공개 필드 그대로', r.j?.status === 'ready' && r.j?.seat === 3 && r.j?.name === '수업');
  check('ready: Server-Timing 정한 이름·숫자만', r.st === 'sandbox;dur=5, health;dur=0, total;dur=812' && ST_RE.test(r.st), r.st);
  check('ready: labJoin 인자 그대로', JSON.stringify(calls) === JSON.stringify([['labJoin', CODE, 'n']]), JSON.stringify(calls));
}
replies.labJoin = () => ({ status: 'starting', detail: '편집기를 켜는 중', labTiming: { sandbox: 1e15, materials: 3, health: 4, start: 5, total: 6, sandboxId: 'sb-123' } });
{
  const r = await wake();
  check('starting: 상한·고정 이름', r.st === 'sandbox;dur=600000, materials;dur=3, health;dur=4, start;dur=5, total;dur=6', r.st);
  check('starting: JSON 에 labTiming·id 없음', JSON.stringify(r.j) === JSON.stringify({ status: 'starting', detail: '편집기를 켜는 중' }), r.raw);
}
replies.labJoin = () => ({ status: 'starting', detail: 'x' });
{
  replies.labJoin = () => ({ status: 'starting', detail: 'x', labTiming: { total: 5, prep_queue: 123, prep_elapsed: 456, prep_sandbox: 7, prep_materials: 'unknown', prep_health: NaN, error: 'private', token: 'private' } });
  const r = await wake();
  check('공유 준비 시간: 헤더 고정 이름·숫자, 공개 JSON에서 제거', r.st === 'total;dur=5, prep_queue;dur=123, prep_elapsed;dur=456, prep_sandbox;dur=7' && ST_RE.test(r.st) && r.raw === '{"status":"starting","detail":"x"}', r);
}
replies.labJoin = () => ({ status: 'starting', detail: 'x' });
{
  const r = await wake();
  check('labTiming 없으면 헤더 없음·본문 그대로', r.st === null && r.raw === JSON.stringify({ status: 'starting', detail: 'x' }));
}
replies.labJoin = () => ({ status: 'ready', labTiming: 'sandbox;dur=1, evil=https://x' });
{
  const r = await wake();
  check('labTiming 이 객체 아니면 헤더 없음·본문에서도 뗌', r.st === null && r.raw === JSON.stringify({ status: 'ready' }), `${r.st} ${r.raw}`);
}
for (const [label, f] of [['502', { error: 'Daytona 오류 sb-123', status: 502 }], ['404', { error: '자리 없음', status: 404 }], ['labTiming 붙은 실패', { error: 'e', status: 503, labTiming: { total: 5 } }]]) {
  replies.labJoin = () => f;
  const r = await wake();
  check(`실패(${label}): 상태·본문 그대로, 헤더 없음`, r.res.status === f.status && r.raw === JSON.stringify({ error: f.error }) && r.st === null && secureJson(r.res), `${r.res.status} ${r.raw} ${r.st}`);
}
{
  replies.labJoin = () => { throw new Error('should not be called'); };
  const bad = await wake({ code: 'short' });
  check('형식 오류: labJoin 전에 400', bad.res.status === 400 && calls.length === 0 && bad.st === null);
  const origin = await wake(undefined, '/__lab/wake', { origin: 'https://evil.example' });
  check('출처 오류: 403 그대로', origin.res.status === 403 && calls.length === 0 && origin.st === null);
  replies.labClaim = () => ({ error: '끝남', status: 410 });
  const claim = await wake({}, '/__lab/claim');
  check('claim: 410 그대로', claim.res.status === 410 && claim.raw === JSON.stringify({ error: '끝남' }) && claim.st === null);
}
{
  replies.labJoin = () => ({ status: 'ready', labTiming: { total: 3 } });
  calls.length = 0;
  const req = new Request(LAB_ORIGIN + '/__lab/wake', { method: 'POST', headers: { origin: LAB_ORIGIN, 'content-type': 'application/json', cookie: 'lab_seat=old' }, body: JSON.stringify({ code: CODE }) });
  const res = await H.labHost(req, ENV, state, new URL(req.url));
  check('예전 쿠키 지우기와 함께 헤더 유지', res.headers.get('server-timing') === 'total;dur=3' && /lab_seat=;/.test(res.headers.get('set-cookie') ?? ''));
}

// ── 3. 자리 호스트 ──
console.log('자리 호스트');
const LABEL = 'abcdefghijklmnopqrstuvwxyz';
const ME = `https://s-${LABEL}.${SEAT_DOMAIN}`;
const UP = 'https://upstream.example.test';
replies.labRoute = () => ({ origin: UP, token: 'preview-tok', expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL });

// HTMLRewriter 가짜: 핸들러를 모아 두고 transform 때 가짜 요소로 부른다 (본문은 그대로 넘김)
const rw = { prepend: [], append: [], before: [], removed: 0, bodyUsedAtTransform: null, given: null };
globalThis.HTMLRewriter = class {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push([sel, handler]); return this; }
  transform(res) {
    rw.bodyUsedAtTransform = res.bodyUsed; rw.given = res;
    const el = (attrs = {}) => ({ prepend: (x) => rw.prepend.push(x), append: (x) => rw.append.push(x), remove: () => rw.removed++, getAttribute: (n) => attrs[n] ?? null,
      onEndTag: (fn) => fn({ before: (x) => rw.before.push(x) }) });
    for (const [sel, h] of this.h) if (sel === 'script[nonce]') h.element(el({ nonce: 'n0nce"><x' }));
    for (const [sel, h] of this.h) if (sel !== 'script[nonce]') h.element(el());
    return res;
  }
};
let clk = 5_000_000;
const realNow = Date.now;
Date.now = () => clk;
let upstream;
const fetched = [];
globalThis.fetch = async (u, init) => { fetched.push(String(u)); clk += upstream.ms ?? 0; if (upstream.throw) throw new Error('upstream down https://secret.example/token'); return upstream.make(init); };

async function seat(path, { headers = {}, method = 'GET' } = {}) {
  calls.length = 0; fetched.length = 0;
  for (const k of Object.keys(rw)) rw[k] = Array.isArray(rw[k]) ? [] : rw[k] === 0 ? 0 : null;
  rw.removed = 0;
  const req = new Request(ME + path, { method, headers: { cookie: `__Host-lab_seat=${CODE}`, 'sec-fetch-site': 'same-origin', ...headers } });
  return H.labSeatHost(req, ENV, state, new URL(req.url), LABEL);
}
const DOC = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const htmlUp = (extra = {}) => () => new Response('<html><head></head><body>hi</body></html>', { status: 200, headers: {
  'content-type': 'text/html; charset=utf-8', 'content-security-policy': "script-src 'self' 'nonce-abc'", 'cache-control': 'no-cache', 'set-cookie': 'cs=1; Domain=upstream.example.test; Path=/', ...extra } });

upstream = { ms: 1234, make: htmlUp() };
{
  const res = await seat('/?folder=/home', { headers: DOC });
  check('HTML 문서: 200', res.status === 200);
  check('HTML 문서: Server-Timing upstream 만', res.headers.get('server-timing') === 'upstream;dur=1234', res.headers.get('server-timing'));
  check('HTML 문서: upstream 헤더 그대로 (CSP·cache-control·쿠키 Domain 뗌)', res.headers.get('content-security-policy') === "script-src 'self' 'nonce-abc'"
    && res.headers.get('cache-control') === 'no-cache' && res.headers.get('set-cookie') === 'cs=1; Path=/', [...res.headers].join(' | '));
  check('HTML 문서: 본문은 버퍼 없이 HTMLRewriter 로', rw.bodyUsedAtTransform === false && (await res.text()).includes('hi'));
  check('guard 와 캡처 사전 스크립트는 앱 스크립트보다 먼저 head 에', rw.prepend.includes('<script src="/__lab/guard.js"></script>') && rw.prepend.length === 2);
  const tags = rw.before.join('');
  const order = [...tags.matchAll(/src="\/__lab\/([\w-]+)\.js" defer nonce="([^"]*)"/g)];
  const scripts = ['bar','snips','help','screen','rtc','dom-capture','live','classroom','perf'];
  check('수업·지원 스크립트 순서와 perf 맨 뒤', order.map(m => m[1]).join(',') === scripts.join(','), tags);
  check('수업 안내·perf 에도 같은 nonce (정리된 값)', order.length === scripts.length && order.every((m) => m[2] === 'n0ncex') && !/n0nce"|[<>]x/.test(tags), tags);
  check('upstream 주소·토큰은 헤더에 없음', !/upstream\.example|preview-tok/.test(res.headers.get('server-timing') ?? ''));
}
upstream = { ms: 9e9, make: htmlUp() };
{
  const res = await seat('/', { headers: DOC });
  check('HTML 문서: 상한', res.headers.get('server-timing') === 'upstream;dur=600000', res.headers.get('server-timing'));
}
upstream = { ms: 7, make: htmlUp({ 'server-timing': 'cs;dur=2' }) };
{
  const res = await seat('/', { headers: DOC });
  check('upstream 자기 Server-Timing 은 그대로 두고 덧붙임', res.headers.get('server-timing') === 'cs;dur=2, upstream;dur=7', res.headers.get('server-timing'));
}
upstream = { ms: 7, make: htmlUp() };
{
  const res = await seat('/x', { headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } });
  check('iframe: guard 넣지만 Server-Timing 없음', res.headers.get('server-timing') === null && rw.prepend.length === 1 && rw.before.length === 0);
}
upstream = { ms: 7, make: () => new Response('body{}', { status: 200, headers: { 'content-type': 'text/css', 'server-timing': 'cs;dur=1' } }) };
{
  const res = await seat('/static/a.css', { headers: { 'sec-fetch-dest': 'style' } });
  check('자산: 그대로 (우리 헤더 없음)', res.status === 200 && res.headers.get('server-timing') === 'cs;dur=1' && rw.given === null && (await res.text()) === 'body{}');
}
upstream = { ms: 7, make: () => new Response('<html></html>', { status: 404, headers: { 'content-type': 'text/html' } }) };
{
  const res = await seat('/missing', { headers: DOC });
  check('HTML 문서 404: 그대로, Server-Timing 없음', res.status === 404 && res.headers.get('server-timing') === null && rw.given === null);
}
upstream = { ms: 7, make: () => new Response('down', { status: 502, headers: { 'content-type': 'text/html' } }) };
{
  const res = await seat('/', { headers: DOC });
  check('upstream 5xx 문서: 503 안내 그대로, Server-Timing 없음', res.status === 503 && res.headers.get('server-timing') === null && res.headers.get('cache-control') === 'no-store');
}
upstream = { ms: 7, throw: true };
{
  const res = await seat('/', { headers: DOC });
  const t = await res.text();
  check('upstream 연결 실패: 502 그대로, Server-Timing·오류 문구 없음', res.status === 502 && res.headers.get('server-timing') === null && !/secret\.example/.test(t));
}
// WebSocket: 101 은 받은 응답 그대로 (Node Response 는 101 을 못 만들어서 가짜 객체)
const ws101 = { status: 101, headers: new Headers({ upgrade: 'websocket' }), webSocket: {} };
upstream = { ms: 7, make: () => ws101 };
{
  const res = await seat('/stable-x', { headers: { upgrade: 'websocket', origin: ME } });
  check('WebSocket 101: 같은 객체 그대로', res === ws101 && !res.headers.has('server-timing'));
  check('WebSocket: upstream 으로 한 번', fetched.length === 1 && fetched[0] === UP + '/stable-x');
}
{
  const res = await seat('/stable-x', { headers: { upgrade: 'websocket', origin: 'https://evil.example' } });
  check('WebSocket 다른 출처: 403 그대로 (upstream 안 감)', res.status === 403 && fetched.length === 0);
}
{
  const res = await seat('/__lab/perf.js', { headers: { cookie: '' } });
  const t = await res.text();
  check('/__lab/perf.js: 자리 없이 정적 스크립트', res.status === 200 && calls.length === 0 && fetched.length === 0 && typeof t === 'string');
  check('/__lab/perf.js: 스크립트 헤더 (nosniff·CSP·text/javascript)', res.headers.get('content-type') === 'text/javascript; charset=utf-8'
    && res.headers.get('x-content-type-options') === 'nosniff' && !!res.headers.get('content-security-policy') && res.headers.get('cache-control') === 'max-age=300');
  const x = await seat('/__lab/perf.js', { headers: { 'sec-fetch-site': 'cross-site' } });
  check('/__lab/perf.js: 다른 사이트는 출처 검사가 먼저 (403)', x.status === 403);
}
Date.now = realNow;

// ── 4. labJoin 순서 (소스 구조): 자리 확인 → 이름 → Daytona 키 → 준비(#prep.ensure) → ready 일 때만 다시 확인하며 opened → 감사 ──
console.log('state.ts labJoin 구조');
{
  const src = readFileSync(join(ROOT, 'src/state.ts'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf(src.includes('  async #demoJoin(') ? '  async #demoJoin(' : '  async labJoin(code: string');
  const b = src.indexOf('\n  }\n', a);
  const body = src.slice(a, b);
  const awaits = [...body.matchAll(/await ([\w.#]+(?:<\w+>)?)\(/g)].map((m) => m[1]).filter(name => name !== 'this.#demoLiveLab');
  const want = ['this.seatOf', 'this.#seatPatch', 'this.audit', 'this.daytona', 'this.#prep.ensure', 'this.#seatPatch', 'this.audit'];
  check('await 순서: seatOf → 이름 → daytona → ensure → opened → 감사', a > 0 && JSON.stringify(awaits) === JSON.stringify(want), JSON.stringify(awaits));
  const at = (re) => body.search(re);
  check('자리 확인(seatOf)이 맨 앞, 실패는 바로 return', /^\s*async (?:labJoin|#demoJoin)[^\n]*\n[^\n]*labTimer\(\)[^\n]*\n\s*const got = await this\.seatOf\(code\);\n\s*if \(isFail\(got\)\) return got;/.test(body));
  check('Daytona 키 확인이 준비보다 먼저', at(/if \(isFail\(c\)\) return c;/) > 0 && at(/if \(isFail\(c\)\) return c;/) < at(/this\.#prep\.ensure\(/));
  check('ready 가 아니면 opened 전에 return (gone 410·error 502·starting)', [/r\.status === 'gone'\) return fail\(410/, /r\.status === 'error'\) return fail\(502, r\.message\)/, /r\.status === 'starting'\) return withLabTiming\(/]
    .every((re) => at(re) > at(/this\.#prep\.ensure\(/) && at(re) < at(/s\.opened = now\(\)/)));
  // 트랜잭션 콜백은 다시 불릴 수 있다: 같은 콜백 안에서 진행 중·알 수 없음·이미 opened 를 먼저 보고 keep, 콜백 밖 변수(busy·unsure)에 적지 않는다
  check('opened 는 ensure 뒤 #seatPatch 안에서만, 진행 중·알 수 없는 자료면 안 적음', (body.match(/\.opened\s*=(?!=)/g) ?? []).length === 1
    && /const open = await this\.#seatPatch\(ref,[\s\S]*s\.setup\?\.state === 'running' \|\| prepUncertain\(s\.setup\) \|\| s\.opened \? 'keep' : \(s\.opened = now\(\), 'write'\)/.test(body)
    && at(/s\.opened = now\(\)/) > at(/this\.#prep\.ensure\(/) && !/\b(?:busy|unsure)\s*=/.test(body));
  // 판정은 커밋된 결과(open.seat.setup)로: 알 수 없으면 opened 쓰기 뒤, lab-join 감사·ready 응답 전에 502
  const unsure = /if \(prepUncertain\(open\.seat\.setup\)\) return fail\(502, PREP_UNCERTAIN\);/;
  check('알 수 없는 자료는 lab-join 감사·ready 전에 502 (fail closed)', at(unsure) > at(/s\.opened = now\(\)/)
    && at(unsure) < at(/'lab-join'/) && at(unsure) < at(/return withLabTiming\(labReady\(/));
  check('lab-join 감사는 opened 를 새로 쓴 때만', /if \(open\.wrote\) await this\.audit\('lab-join'/.test(body) && at(/'lab-join'/) > at(/s\.opened = now\(\)/));
  check('labJoin 이 자리를 통째로 저장하지 않음 (saveSeat·putMaterials·exec·spawn 없음)', !/saveSeat|putMaterials|\bexec\(|\bspawn\(|dt</.test(body));
  const rets = [...body.matchAll(/return ([^;]+);/g)].map((m) => m[1]);
  const bare = rets.filter((r) => !r.startsWith('withLabTiming('));
  const gone = "fail(410, '수업이 끝났습니다.')";
  const denied = "fail(403, '모임지기 화면에서 시연실을 여세요.')";
  check('실패 return 은 labTiming 없음', JSON.stringify(bare) === JSON.stringify(['got', ...(body.includes('allowDemo') ? [denied] : []), gone, 'c', 'fail(502, labErrorText(e))', gone, 'fail(502, r.message)', gone, 'fail(502, PREP_UNCERTAIN)']), JSON.stringify(bare));
  check('성공 return 3곳(starting·자료 진행 중·ready) 모두 withLabTiming', rets.filter((r) => r.startsWith('withLabTiming(')).length === 3);
  check('시계는 await 를 감싸지 않음', !/await\s+t\.|t\.add\([^)]*await/.test(body));
  check('labJoin 은 total 만 잰다 (단계 t.add 없음)', /const t = labTimer\(\);/.test(body) && !/\bt\.add\(/.test(body));
  const svc = readFileSync(join(ROOT, 'src/lab-preparation-service.ts'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  check('준비 서비스는 who·opened·pv·감사 기록을 쓰지 않음', !/\.(who|opened|pv)\s*=(?!=)|\baudit\(/.test(svc));
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
