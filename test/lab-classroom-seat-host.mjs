// Seat host contract for /__lab/classroom. State methods are mocked; no provider, network, or deployment.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const out = await build({ entryPoints: [join(ROOT, 'src/labhost.ts')], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'lab-classroom-seat-host-'));
writeFileSync(join(dir, 'labhost.mjs'), out.outputFiles[0].text);
const H = await import(pathToFileURL(join(dir, 'labhost.mjs')).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok', name);
  else { failed++; console.log('  FAIL', name, typeof extra === 'string' ? extra : JSON.stringify(extra)); }
};

const LAB_ORIGIN = 'https://lab.example.test';
const SEAT_DOMAIN = 'example.test';
const ENV = { ORIGIN: 'https://k.example.test', LAB_ORIGIN, LAB_SEAT_DOMAIN: SEAT_DOMAIN };
const LABEL = 'abcdefghijklmnopqrstuvwxyz';
const ME = `https://s-${LABEL}.${SEAT_DOMAIN}`;
const COOKIE_CODE = 'seatCookieCode01';
const OTHER = 'otherSeatCode001';
const UUID = '12345678-1234-4123-8123-123456789abc';
const calls = [];
let replies = {};
const state = new Proxy({}, { get: (_, key) => (typeof key !== 'string' || key === 'then') ? undefined : async (...args) => {
  calls.push([key, ...args]);
  const reply = replies[key];
  return typeof reply === 'function' ? reply(...args) : reply;
} });
const routeOk = () => ({ origin: 'https://upstream.example.test', token: 'preview-tok', expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL });
const shape = (step = 0, completed = false) => ({ classroom: { revision: 1, title: '메모', mode: 'individual', currentStep: 1, steps: [], materials: [], recordingUrl: '', chapters: [], updatedAt: 1 }, progress: { step, completed, updatedAt: 1 }, submissions: [] });

function reset(route = routeOk) {
  calls.length = 0;
  replies = { labRoute: route, labClassroomSeatStatus: (code) => ({ ...shape(), seatCode: code }), labClassroomProgress: (code, step, completed) => shape(step, completed), labClassroomSubmit: (code) => ({ ...shape(), submitted: code }) };
}
async function seat(path, { method = 'GET', headers = {}, cookie = `__Host-lab_seat=${COOKIE_CODE}`, body } = {}) {
  const h = { 'sec-fetch-site': 'same-origin', ...headers };
  if (cookie) h.cookie = cookie;
  const req = new Request(ME + path, { method, headers: h, body });
  const res = await H.labSeatHost(req, ENV, state, new URL(req.url), LABEL);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { res, text, json };
}
const names = (...wanted) => calls.filter((c) => wanted.includes(c[0]));
const classroomCalls = () => calls.filter((c) => String(c[0]).startsWith('labClassroom'));

reset();
{
  const got = await seat(`/__lab/classroom/status?code=${OTHER}&n=4`);
  check('GET status uses the seat cookie, not query code or n', got.res.status === 200 && got.json.seatCode === COOKIE_CODE && !got.text.includes(OTHER));
  check('GET status calls labClassroomSeatStatus once with the cookie code', JSON.stringify(names('labClassroomSeatStatus')) === JSON.stringify([['labClassroomSeatStatus', COOKIE_CODE]]));
  check('status response is the seat snapshot without a peer list', got.json.progress.step === 0 && !('participants' in got.json) && !('n' in got.json));
}
reset();
{
  const a = await seat('/__lab/classroom/status', { cookie: `__Host-lab_seat=${COOKIE_CODE}` });
  const b = await seat('/__lab/classroom/status?n=2', { cookie: `__Host-lab_seat=${OTHER}` });
  check('two seats stay isolated', a.json.seatCode === COOKIE_CODE && b.json.seatCode === OTHER && names('labClassroomSeatStatus').map((c) => c[1]).join() === `${COOKIE_CODE},${OTHER}`);
}
reset(() => ({ error: '수업이 끝났습니다.', status: 410 }));
{
  const ended = '__Host-lab_seat=endedSeatCode001';
  const got = await seat('/__lab/classroom/status', { cookie: ended });
  const post = await seat('/__lab/classroom/progress', { method: 'POST', cookie: ended, headers: { origin: ME, 'content-type': 'application/json' }, body: JSON.stringify({ step: 0, completed: false }) });
  check('ended seat denies status and progress', got.res.status === 410 && post.res.status === 410 && got.json.error === '수업이 끝났습니다.');
  check('ended seat does not call classroom methods', classroomCalls().length === 0);
}
reset(() => ({ origin: 'https://upstream.example.test', token: 't', expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }));
{
  const got = await seat('/__lab/classroom/status', { cookie: '__Host-lab_seat=labelSeatCode001' });
  check('a cookie for another seat label is rejected', got.res.status === 403 && classroomCalls().length === 0);
}
reset();
{
  const none = await seat('/__lab/classroom/status', { cookie: '' });
  const bad = await seat('/__lab/classroom/status', { cookie: '__Host-lab_seat=short' });
  check('missing or malformed seat cookie is 401', none.res.status === 401 && bad.res.status === 401 && calls.length === 0);
}
reset();
{
  const cases = [
    ['POST', '/__lab/classroom/status', '{}'],
    ['PUT', '/__lab/classroom/progress', '{"step":0,"completed":false}'],
    ['DELETE', '/__lab/classroom/submit', '{}'],
    ['GET', '/__lab/classroom/progress', undefined],
    ['GET', '/__lab/classroom/submit', undefined],
  ];
  let ok = true;
  for (const [method, path, body] of cases) {
    calls.length = 0;
    const got = await seat(path, { method, headers: method === 'GET' ? {} : { origin: ME, 'content-type': 'application/json' }, body });
    if (got.res.status !== 404 || classroomCalls().length) ok = false;
  }
  check('only GET status and POST progress/submit are classroom methods', ok);
}
reset();
{
  const cross = await seat('/__lab/classroom/status', { headers: { 'sec-fetch-site': 'cross-site' } });
  const origin = await seat('/__lab/classroom/progress', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"step":0,"completed":true}' });
  const site = await seat('/__lab/classroom/submit', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ requestId: UUID, filename: '결과.txt' }) });
  const type = await seat('/__lab/classroom/progress', { method: 'POST', headers: { origin: ME, 'content-type': 'text/plain' }, body: '{"step":0,"completed":true}' });
  check('cross-site, foreign origin, and wrong content-type are rejected', cross.res.status === 403 && origin.res.status === 403 && site.res.status === 403 && type.res.status === 415);
  check('rejected origin and site do not touch the classroom API', classroomCalls().length === 0 && calls.length === 0);
}
reset();
{
  const big = await seat('/__lab/classroom/progress', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: `{"step":0,"completed":true,"pad":"${'x'.repeat(1100)}"}` });
  check('oversized classroom body is 413 before seat lookup', big.res.status === 413 && calls.length === 0, big.text);
  const bounds = [
    [{ step: 0, completed: true, code: OTHER }, 'progress'],
    [{ step: 0, completed: true, n: 1 }, 'progress'],
    [{ step: 12, completed: false }, 'progress'],
    [{ step: -1, completed: false }, 'progress'],
    [{ step: 1.5, completed: false }, 'progress'],
    [{ step: '0', completed: false }, 'progress'],
    [{ step: 0, completed: 'true' }, 'progress'],
    [{ step: 0 }, 'progress'],
    [{ requestId: UUID, filename: '다른.txt' }, 'submit'],
    [{ requestId: UUID, filename: '../결과.txt' }, 'submit'],
    [{ requestId: 'not-a-uuid', filename: '결과.txt' }, 'submit'],
    [{ requestId: UUID, filename: '결과.txt', content: 'fake', n: 1 }, 'submit'],
    [{ requestId: UUID }, 'submit'],
  ];
  let rejected = true;
  for (const [body, kind] of bounds) {
    calls.length = 0;
    const got = await seat(kind === 'progress' ? '/__lab/classroom/progress' : '/__lab/classroom/submit', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (got.res.status !== 400 || classroomCalls().length) rejected = false;
  }
  check('code, n, step, filename, uuid, and extra fields are rejected', rejected);
}
reset();
{
  const progress = await seat('/__lab/classroom/progress', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: JSON.stringify({ step: 3, completed: true }) });
  const submit = await seat('/__lab/classroom/submit', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: UUID, filename: '결과.txt' }) });
  check('progress calls labClassroomProgress(code, step, completed)', progress.res.status === 200 && JSON.stringify(names('labClassroomProgress')) === JSON.stringify([['labClassroomProgress', COOKIE_CODE, 3, true]]) && progress.json.progress.completed === true);
  check('submit calls labClassroomSubmit(code, requestId, filename)', submit.res.status === 200 && JSON.stringify(names('labClassroomSubmit')) === JSON.stringify([['labClassroomSubmit', COOKIE_CODE, UUID, '결과.txt']]));
}
reset();
{
  replies.labClassroomProgress = () => ({ error: '다른 개정입니다.', status: 409 });
  const got = await seat('/__lab/classroom/progress', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: JSON.stringify({ completed: false, step: 0 }) });
  check('revision conflict is passed through', got.res.status === 409 && got.json.error === '다른 개정입니다.');
}
reset();
{
  const asset = await seat('/__lab/classroom.js', { cookie: '' });
  const cross = await seat('/__lab/classroom.js', { cookie: '', headers: { 'sec-fetch-site': 'cross-site' } });
  check('classroom.js is a same-origin static asset without a seat cookie', asset.res.status === 200 && asset.res.headers.get('content-type') === 'text/javascript; charset=utf-8' && asset.res.headers.get('cache-control') === 'no-store' && asset.text.includes('__labClassroomSeat') && calls.length === 0);
  check('classroom.js does not embed or authorize with WebAuthn', !/webauthn|Authorization|iframe/i.test(asset.text));
  check('cross-site script fetch stays blocked', cross.res.status === 403 && calls.length === 0);
}

const rw = { before: [] };
globalThis.HTMLRewriter = class {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push([sel, handler]); return this; }
  transform(res) {
    const el = (attrs = {}) => ({ prepend() {}, append() {}, remove() {}, getAttribute: (n) => attrs[n] ?? null, onEndTag: (fn) => fn({ before: (x) => rw.before.push(x) }) });
    for (const [sel, handler] of this.h) handler.element(sel === 'script[nonce]' ? el({ nonce: 'n0nce' }) : el());
    return res;
  }
};
globalThis.fetch = async () => new Response('<html><head></head><body>editor</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
reset();
{
  rw.before = [];
  const got = await seat('/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
  const tags = rw.before.join('');
  const srcs = [...tags.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  check('document injection includes classroom.js once before perf', got.res.status === 200 && srcs.filter((s) => s === '/__lab/classroom.js').length === 1 && srcs.at(-1) === '/__lab/perf.js' && srcs.includes('/__lab/bar.js'), `status=${got.res.status} srcs=${srcs.join(',')}`);
}

if (failed) { console.log(`FAIL classroom seat host ${failed}`); process.exit(1); }
console.log('PASS classroom seat host');
