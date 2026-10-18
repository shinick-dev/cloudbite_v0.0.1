// 공부방 보안 회귀 테스트 (#11 내 작업 받기, #14 자리 초대, #16 화면 공유 SFU, #18 자리 호스트, #19 입장, /__lab 본문 상한, 수업 끝내기·만료 정리).
//
// 진짜 로컬 workerd(wrangler dev)에 test/fixtures/lab-security/fixture.js 를 main 으로 한 임시 설정을 띄운다.
// 진짜 State(DO)·SQLite 저장소를 쓰고, 설정·비밀은 전부 이번 실행에서 만든 합성 값이다 (배포·진짜 Daytona/Realtime/OpenRouter 없음).
// Daytona·toolbox·code-server·SFU 는 이 스크립트의 loopback 가짜 서버 하나가 맡는다. 바깥 호출은 fixture 가 막고 기록한다.
// 호스트는 Host 헤더로 고른다: 입장 lab.gw.localhost, 자리 s-<label>.gw.localhost (같은 사이트), 관리 127.0.0.1.
//
//   node test/lab-security.mjs                 이 저장소 src 로
//   node test/lab-security.mjs --src=<dir> --baseline   다른 src 로 (FAIL = 재현, 종료 코드 0)
//   --only=setup,entry,host,browser,invite,body,export,zip,sfu,lifecycle   일부만 (browser: 설치된 Edge 로 초대 → 입장, 없으면 skip)
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const SRC = path.resolve(arg('src') ?? path.join(ROOT, 'src'));
const BASELINE = process.argv.includes('--baseline');
const ONLY = new Set((arg('only') ?? 'setup,entry,host,browser,invite,body,export,zip,sfu,lifecycle').split(','));
const fwd = (p) => p.replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), INSP = await freePort();
const GW = `http://127.0.0.1:${PORT}`;
const ENTRY_HOST = `lab.gw.localhost:${PORT}`, ENTRY = `http://${ENTRY_HOST}`;
const SEAT_DOMAIN = `gw.localhost:${PORT}`;
const seatHost = (label) => `s-${label}.${SEAT_DOMAIN}`;
const seatOrigin = (label) => `http://${seatHost(label)}`;

let pass = 0, failN = 0, skipN = 0, section = '';
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   [${section}] ${name}`); }
  else { failN++; console.log(`  FAIL [${section}] ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`.slice(0, 1500)); }
};

// ── 가짜 Daytona·toolbox·code-server·SFU (loopback) ──
const hits = [];     // { path, method, headers }
const execs = [];    // { sb, command }
const uploads = [];  // { sb, path, size }
const sfu = [];      // { method, path, body }
const M = {
  sandboxes: new Set(['sb1', 'sb2', 'sb3', 'sb4']),
  pack: '',                        // node export.cjs 의 출력 (OK … 이면 0, 아니면 3). 아래 PACK_OK
  rmFail: 0,                       // rm -rf 를 이만큼 실패
  zip: Buffer.from('PK-fake-zip-body-'.repeat(64)),
  slowZip: false,                  // 다운로드를 첫 조각만 보내고 붙잡기
  zipMode: 'ok',                   // 'ok' | 'bigHeader' (Content-Length 가 큼) | 'chunkedOver' (헤더 없이 더 보냄) | 'lyingSmall' (헤더는 작고 더 보냄) | 'chunked' (헤더 없이 정확히)
  zipExtra: 5000,                  // 묶은 뒤 바뀐 work.zip 이 더 가진 바이트
  sfuFail: {},                     // 'local' | 'remote' | 'renegotiate' | 'close' | 'new' → 남은 실패 수
  sfuHold: null,                   // { match, release, arrived }
  sess: 0,
  delFail: {},                     // 샌드박스 id → 남은 DELETE 실패 수 (500)
  listFail: 0,                     // 라벨 목록 조회(GET /sandbox?labels=)를 이만큼 실패 (500)
  labelled: {},                    // 수업 id → 라벨 목록이 돌려줄 [{ id, state }] (없으면 [])
};
const PACK_OK = `OK 3 11 1 ${M.zip.length}`; // zip 크기 = 실제로 내려보낼 바이트
M.pack = PACK_OK;
const held = [];
function body(req) { return new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); }); }
function jres(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const b = await body(req);
  hits.push({ path: req.url, method: req.method, headers: req.headers });
  let g;
  // Daytona API
  if ((g = u.pathname.match(/^\/daytona\/sandbox\/([\w-]+)\/ports\/8080\/preview-url$/))) return jres(res, 200, { url: `${MOCK}/cs/${g[1]}`, token: `pv-${g[1]}` });
  if ((g = u.pathname.match(/^\/daytona\/sandbox\/([\w-]+)$/))) {
    if (!M.sandboxes.has(g[1])) return jres(res, 404, { message: 'not found' });
    if (req.method === 'DELETE' && M.delFail[g[1]] > 0) { M.delFail[g[1]]--; return jres(res, 500, { message: 'delete failed' }); }
    if (req.method === 'DELETE') { M.sandboxes.delete(g[1]); return jres(res, 200, {}); }
    return jres(res, 200, { id: g[1], state: 'started', toolboxProxyUrl: `${MOCK}/tb` });
  }
  if (u.pathname === '/daytona/sandbox' && req.method === 'GET' && u.searchParams.has('labels')) {
    if (M.listFail > 0) { M.listFail--; return jres(res, 500, { message: 'list failed' }); }
    let lab; try { lab = JSON.parse(u.searchParams.get('labels'))['gw-lab']; } catch {}
    return jres(res, 200, (M.labelled[lab] ?? []).filter((s) => s.state === 'destroyed' || M.sandboxes.has(s.id)));
  }
  if (u.pathname.startsWith('/daytona/sandbox')) return jres(res, 200, []);
  // toolbox
  if ((g = u.pathname.match(/^\/tb\/([\w-]+)\/process\/execute$/))) {
    const { command } = JSON.parse(b.toString() || '{}');
    execs.push({ sb: g[1], command });
    if (command.includes('/healthz')) return jres(res, 200, { exitCode: 0, result: '200' });
    if (command.includes('rm -rf')) { if (M.rmFail > 0) { M.rmFail--; return jres(res, 200, { exitCode: 1, result: 'busy' }); } return jres(res, 200, { exitCode: 0, result: '' }); }
    if (command.includes('export.cjs')) { const ok = M.pack.startsWith('OK'); return jres(res, 200, { exitCode: ok ? 0 : 3, result: M.pack }); }
    return jres(res, 200, { exitCode: 0, result: '' });
  }
  if ((g = u.pathname.match(/^\/tb\/([\w-]+)\/files\/upload$/))) { uploads.push({ sb: g[1], path: u.searchParams.get('path'), size: b.length }); return jres(res, 200, {}); }
  if ((g = u.pathname.match(/^\/tb\/([\w-]+)\/files\/download$/))) {
    const big = Buffer.concat([M.zip, Buffer.alloc(M.zipExtra, 0x41)]);
    if (M.zipMode === 'bigHeader') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length }); return res.end(big); }
    if (M.zipMode === 'chunkedOver' || M.zipMode === 'chunked') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); // Content-Length 없음 → chunked
      const b = M.zipMode === 'chunked' ? M.zip : big;
      for (let o = 0; o < b.length; o += 256) { res.write(b.subarray(o, o + 256)); await sleep(2); }
      return res.end();
    }
    if (M.zipMode === 'lyingSmall') { // 헤더를 손으로: Content-Length 50 인데 더 보낸다
      res.socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: 50\r\nconnection: close\r\n\r\n`);
      res.socket.end(big);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', ...(M.slowZip ? {} : { 'content-length': M.zip.length }) });
    if (M.slowZip) { res.write(M.zip.subarray(0, 100)); held.push(res); res.gone = new Promise((ok) => res.on('close', () => ok(true))); return; }
    return res.end(M.zip);
  }
  // SFU
  if (u.pathname.startsWith('/rtc/')) {
    const p = u.pathname.replace(/^\/rtc\/apps\/[\w-]+/, '');
    const j = b.length ? JSON.parse(b.toString()) : undefined;
    sfu.push({ method: req.method, path: p, body: j });
    const h = M.sfuHold;
    if (h && p.includes(h.match)) { h.arrived++; await h.released; }
    const failing = (k) => (M.sfuFail[k] > 0 ? (M.sfuFail[k]--, true) : false);
    if (p === '/sessions/new') return failing('new') ? jres(res, 500, { errorCode: 'x' }) : jres(res, 200, { sessionId: `S${++M.sess}` });
    if ((g = p.match(/^\/sessions\/(S\d+)\/tracks\/new$/))) {
      const local = j.tracks?.[0]?.location === 'local';
      if (failing(local ? 'local' : 'remote')) return jres(res, 500, { errorCode: 'boom', errorDescription: 'mock failure' });
      if (local) return jres(res, 200, { sessionDescription: { type: 'answer', sdp: 'v=0 answer' }, tracks: j.tracks.map((t) => ({ mid: t.mid, trackName: t.trackName })) });
      return jres(res, 200, { sessionDescription: { type: 'offer', sdp: 'v=0 offer' }, tracks: j.tracks.map((t, i) => ({ mid: `r${g[1]}-${i}`, trackName: t.trackName })) });
    }
    if ((g = p.match(/^\/sessions\/(S\d+)\/renegotiate$/))) return failing('renegotiate') ? jres(res, 500, { errorCode: 'neg' }) : jres(res, 200, {});
    if ((g = p.match(/^\/sessions\/(S\d+)\/tracks\/close$/))) return failing('close') ? jres(res, 500, { errorCode: 'close' }) : jres(res, 200, { tracks: [] });
    if ((g = p.match(/^\/sessions\/(S\d+)$/))) return jres(res, 200, { tracks: [{ mid: `found-${g[1]}`, status: 'active' }] });
    return jres(res, 404, {});
  }
  // code-server (그 밖 전부)
  if (u.pathname === '/setcookie') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': ['a=1; Domain=gw.localhost; Path=/; domain=.gw.localhost', '__Host-lab_seat=EVIL; Path=/; Secure', 'lab_seat=EVIL; Path=/', '__HOST-LAB_SEAT=EVIL2; Path=/; Secure', 'b=2; Path=/'],
      'clear-site-data': '"cookies", "storage"',
    });
    return res.end('ok');
  }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head></head><body>code-server</body></html>'); }
  return jres(res, 200, { echo: true, path: req.url, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, pv: req.headers['x-daytona-preview-token'] ?? null });
});
// WebSocket (code-server) — 손으로 101
mock.on('upgrade', (req, sock) => {
  hits.push({ path: req.url, method: 'UPGRADE', headers: req.headers });
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  setTimeout(() => sock.destroy(), 300);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ── 임시 설정 + fixture entry ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-lab-sec-'));
fs.writeFileSync(path.join(TMP, 'entry.js'),
  `import worker, { State as Base } from '${fwd(path.join(SRC, 'index.ts'))}';\n` +
  `import { makeFixture } from '${fwd(path.join(ROOT, 'test/fixtures/lab-security/fixture.js'))}';\n` +
  `const f = makeFixture(worker, Base);\nexport const State = f.State;\nexport default f.worker;\n`);
fs.writeFileSync(path.join(TMP, 'wrangler.json'), JSON.stringify({
  name: 'gw-lab-security-fixture', main: 'entry.js', compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'Text', globs: ['**/*.ps1'], fallthrough: true }],
  vars: {
    RP_ID: '127.0.0.1', ORIGIN: GW, LAB_ORIGIN: ENTRY, LAB_SEAT_DOMAIN: SEAT_DOMAIN, LAB_GW: '', ALLOW_SHORT_TTL: '1',
    LAB_DAYTONA_API: `${MOCK}/daytona`, REALTIME_API: `${MOCK}/rtc`, REALTIME_APP_ID: 'fxapp', REALTIME_APP_TOKEN: randomBytes(12).toString('hex'),
    MASTER_KEY: randomBytes(32).toString('base64url'),
  },
  durable_objects: { bindings: [{ name: 'STATE', class_name: 'State' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['State'] }],
}, null, 2));

let child = null;
async function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', path.join(TMP, 'wrangler.json'),
    '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', String(INSP), '--persist-to', path.join(TMP, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn'],
  { cwd: TMP, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const tee = (d) => { log += d; if (process.env.LS_LOG) fs.appendFileSync(process.env.LS_LOG, d); };
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);
  const until = Date.now() + 120e3;
  while (Date.now() < until) {
    try { if ((await fetch(`${GW}/borrow`)).status === 200) return; } catch {}
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  console.log(log.slice(-4000));
  throw new Error('wrangler dev did not start');
}
const outboundAll = [];
async function stop() {
  if (!child) return;
  try { outboundAll.push(...(await fx('fxOutbound'))); } catch {}
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch {}
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  child = null;
  await sleep(800);
}
const fx = async (m, ...args) => {
  const r = await fetch(`${GW}/__fx/${m}`, { method: 'POST', body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`fixture ${m} → ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
};

/** Host 헤더를 고른 원시 HTTP 요청. chunked: 본문을 Content-Length 없이 나눠 보낸다.
 *  wrangler dev 앞단(miniflare entry)은 본문을 다 읽지 않고 끝낸 요청(413) 다음 요청을 'Network connection lost' 500 평문으로 떨굴 수 있다 —
 *  게이트웨이 응답이 아닌 그 평문일 때만 한 번 다시 보낸다 (로그에 남김) */
let retried = 0;
async function raw(host, method, p, opts = {}) {
  const r = await raw1(host, method, p, opts);
  if (r.status === 500 && !opts.firstChunkThenClose && String(r.text).startsWith('Error: Network connection lost') && !/json|html/.test(r.headers['content-type'] ?? '')) {
    retried++;
    console.log(`  (wrangler 앞단 연결 끊김 → ${method} ${p.slice(0, 40)} 다시)`);
    return raw1(host, method, p, opts);
  }
  return r;
}
function raw1(host, method, p, opts = {}) {
  const { headers = {}, body: b, chunked = false, firstChunkThenClose = false } = opts;
  return new Promise((resolve, reject) => {
    const h = Object.fromEntries(Object.entries({ host, ...headers }).filter(([, v]) => v !== undefined));
    if (b !== undefined && !chunked) h['content-length'] = Buffer.byteLength(b);
    if (chunked) h['transfer-encoding'] = 'chunked';
    const rq = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h, agent: false }, (rs) => {
      const parts = [];
      if (firstChunkThenClose) { rs.once('data', (d) => { rq.destroy(); resolve({ status: rs.statusCode, headers: rs.headers, first: d }); }); return; }
      let ended = false;
      const fin = (aborted) => { if (ended) return; ended = true; const buf = Buffer.concat(parts); let j = null; try { j = JSON.parse(buf.toString()); } catch {} resolve({ status: rs.statusCode, headers: rs.headers, buf, text: buf.toString(), j, aborted }); };
      rs.on('data', (d) => parts.push(d));
      rs.on('end', () => fin(false));
      // 본문 중간에 끊김 (응답 스트림 오류) — end 없이 닫힘
      rs.on('error', () => fin(true));
      rs.on('close', () => fin(!rs.complete));
    });
    rq.on('error', (e) => (opts.tolerateClose ? resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), text: '', aborted: true, error: String(e) }) : reject(e)));
    rq.on('upgrade', (rs, sock) => { sock.destroy(); resolve({ status: rs.statusCode, headers: rs.headers, text: '' }); });
    if (b !== undefined) {
      if (chunked) { const B = Buffer.from(b); for (let o = 0; o < B.length; o += 512) rq.write(B.subarray(o, o + 512)); }
      else rq.write(b);
    }
    rq.end();
  });
}
// 페이지 안 인라인 스크립트가 문법 오류 없이 읽히는지 (브라우저 없이)
const scriptsOk = (html) => { const xs = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); try { for (const x of xs) new vm.Script(x); return xs.length > 0; } catch (e) { return false; } };
const cookieOf = (r) => [].concat(r.headers['set-cookie'] ?? []);
const SEAT_SAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
/** 자리 호스트의 /__lab API (그 자리 출처·JSON) */
const seatApi = (label, code, p, b, extra = {}) => raw(seatHost(label), b === undefined ? 'GET' : 'POST', p, {
  headers: { cookie: `__Host-lab_seat=${code}`, ...SEAT_SAME, ...(b === undefined ? {} : { origin: seatOrigin(label), 'content-type': 'application/json' }), ...extra },
  body: b === undefined ? undefined : JSON.stringify(b),
});
const adminCall = (p, b, token) => raw(`127.0.0.1:${PORT}`, 'POST', p, { headers: { origin: GW, 'content-type': 'application/json', 'x-admin-token': token }, body: JSON.stringify(b) });

// ── 합성 수업 ──
const code = () => randomBytes(12).toString('base64url');
const label = () => { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let s = ''; for (const x of randomBytes(26)) s += A[x & 31]; return s; };
const C1 = code(), C2 = code(), C3 = code(), C4 = code();
const L1 = label(), L2 = label(), L4 = label();
const LAB = 'lab1', LABB = 'lab2';
async function seed() {
  const t = Date.now();
  const lab = {
    id: LAB, name: '보안수업', createdAt: t, expiresAt: t + 3 * 3600e3, budget: 1, cpu: 1, memory: 1, disk: 3, snapshot: 's', model: 'm/x', gw: '', cls: 'K7Q2XA',
    seats: [
      { n: 1, code: C1, sandboxId: 'sb1', label: L1, who: 'Alice' },
      { n: 2, code: C2, sandboxId: 'sb2', label: L2 },
      { n: 3, code: C3, sandboxId: 'sb3' }, // 자리 호스트 전에 만든 자리 (label 없음)
    ],
  };
  const labB = { ...lab, id: LABB, name: '다른수업', cls: undefined, seats: [{ n: 1, code: C4, sandboxId: 'sb4', label: L4 }] };
  await fx('fxPut', {
    [`lab:${LAB}`]: lab, [`seat:${C1}`]: { lab: LAB, n: 1 }, [`seat:${C2}`]: { lab: LAB, n: 2 }, [`seat:${C3}`]: { lab: LAB, n: 3 }, 'cls:K7Q2XA': LAB,
    [`lab:${LABB}`]: labB, [`seat:${C4}`]: { lab: LABB, n: 1 },
  });
}
const labRec = async (id = LAB) => (await fx('fxGet', [`lab:${id}`]))[`lab:${id}`];
const csHits = (since) => hits.slice(since).filter((h) => h.path.startsWith('/cs/') || (!/^\/(daytona|tb|rtc)\//.test(h.path)));

await start();
await seed();
const ADMIN = (await fx('fxAdmin')).token;

try {
  // ───────────────────────── 수업 만들기 입력 검사 ─────────────────────────
  // 틀린 입력은 OpenRouter·Daytona·저장소에 닿기 전에 거부. 이 fixture 에는 OpenRouter 관리 키가 없어
  // 올바른 입력은 409 에서 멈춘다 (자리·세션·샌드박스를 만들지 않음 — 가짜 Daytona 에 POST /sandbox 도 없다)
  if (ONLY.has('setup')) {
    section = 'setup';
    const create = (b, token = ADMIN) => adminCall('/api/lab/create', b, token);
    const OR409 = [409, 'OpenRouter(관리 키) 공급자가 없습니다. kv.ps1 push 로 올리세요.'];
    const E = {
      seats: [400, '인원은 1~20명'], hours: [400, 'hours'], budget: [400, 'budget'], spec: [400, '사양이 올바르지 않습니다.'],
      gw: [400, '게이트웨이 주소는 https://<이름>.workers.dev 형식'], name: [400, '스냅샷·모델 이름이 올바르지 않습니다.'],
      mat: [400, '자료 주소는 https:// 로 시작하는 GitHub 저장소·ZIP·구글 드라이브 공유 링크'], share: [400, 'share 는 { 공급자: 상한 } 형식'],
    };
    const is = (r, [status, error]) => r.status === status && r.j?.error === error;
    const V = { name: '입력검사', seats: 2, hours: 1, budget: 1, cpu: 1, memory: 2, disk: 5, gw: 'https://gw-x.workers.dev', snapshot: 'gw-lab-v4', model: 'deepseek/deepseek-v4.1-flash' };
    const BAD = { seats: 0, hours: 5, budget: 4, cpu: 1, memory: 2, disk: 0, gw: 'ftp://x', snapshot: 'a b', model: 'm', materials: 'ftp://x', share: [1] };
    const snap = async () => JSON.stringify(await Promise.all([...['lab:', 'seat:', 'sess:'].map(async (p) => Object.keys(await fx('fxList', p)).sort()), fx('fxGet', ['labcfg', 'audit'])]));
    const st0 = await snap(), h0 = hits.length, o0 = (await fx('fxOutbound')).length;

    let r = await create(BAD, ''), r2 = await create(V, 'bad-token');
    check('관리 토큰 없음·틀림 → 입력 검사보다 먼저 401', r.status === 401 && r2.status === 401, `${r.status} ${r2.status}`);
    // 전부 틀린 입력에서 앞 항목부터 하나씩 고치면 다음 항목의 오류가 나온다
    const fixes = [['seats', { seats: 2 }], ['hours', { hours: 1 }], ['budget', { budget: 1 }], ['spec', { disk: 5 }], ['gw', { gw: V.gw }], ['name', { snapshot: V.snapshot }], ['mat', { materials: '' }], ['share', { share: null }]];
    const ladder = [];
    let cur = { ...BAD };
    for (const [k, fix] of fixes) { ladder.push([k, is(await create(cur), E[k])]); cur = { ...cur, ...fix }; }
    ladder.push(['409', is(await create(cur), OR409)]);
    check('오류 순서: 인원 → 시간 → 예산 → 사양 → 게이트웨이 → 스냅샷·모델 → 자료 → share → OpenRouter 409', ladder.every(([, ok]) => ok), JSON.stringify(ladder));

    // 하나만 바꾼 입력 (나머지는 V)
    const cases = [
      ['숫자 문자열(인원 "20"=상한, 시간 "2", 예산 "10", 사양 "4/8/10")은 Number 로 받아 409 까지', { seats: '20', hours: '2', budget: '10', cpu: '4', memory: '8', disk: '10' }, OR409],
      ['인원 21 (상한 넘음)', { seats: 21 }, E.seats],
      ['인원 1.5 (정수 아님)', { seats: 1.5 }, E.seats],
      ['인원 없음 (Number(undefined)=NaN)', { seats: undefined }, E.seats],
      ['시간 5 (목록 밖)', { hours: 5 }, E.hours],
      ['dev 짧은 수업 0.005h (ALLOW_SHORT_TTL) → 통과', { hours: 0.005 }, OR409],
      ['dev 짧은 수업 경계 0.01h (미만만) → 거부', { hours: 0.01 }, E.hours],
      ['사양 2/2/5 (직접 입력) → 형식은 통과, OpenRouter 409 에서 멈춤 (스냅샷 조회·Daytona 호출 없음)', { cpu: 2, memory: 2, disk: 5 }, OR409],
      ['사양 0 → 거부', { cpu: 0 }, E.spec],
      ['사양 음수 → 거부', { memory: -4 }, E.spec],
      ['사양 1.5 → 거부', { cpu: 1.5 }, E.spec],
      ['사양 true (Number(true)=1) → 거부', { cpu: true }, E.spec],
      ['사양 [2] → 거부', { cpu: [2] }, E.spec],
      ['사양 {} → 거부', { disk: {} }, E.spec],
      ['사양 "1e1" → 거부', { disk: '1e1' }, E.spec],
      ['사양 "2.0" → 거부', { cpu: '2.0' }, E.spec],
      ['사양 " 2" (공백) → 거부', { cpu: ' 2' }, E.spec],
      ['사양 "2\\n" (줄바꿈) → 거부', { cpu: '2\n' }, E.spec],
      ['사양 2147483648 (상한 넘음) → 거부', { disk: 2147483648 }, E.spec],
      ['사양 없음 → 거부', { memory: undefined }, E.spec],
      ['직접 입력 사양 + 스냅샷 이름이 붙인 뒤 120자 넘음 → 거부', { cpu: 3, snapshot: 's'.repeat(115) }, E.name],
      ['기본 사양은 스냅샷 120자 그대로 통과 (예전 규칙)', { snapshot: 's'.repeat(120) }, OR409],
      ['게이트웨이 끝 / 는 떼고 받음', { gw: 'https://gw-x.workers.dev//' }, OR409],
      ['게이트웨이에 경로 → 거부', { gw: 'https://gw-x.workers.dev/p' }, E.gw],
      ['모델엔 ~ 허용 → 통과', { model: '~vendor/m:free' }, OR409],
      ['스냅샷에 ~ → 거부', { snapshot: 'gw~lab' }, E.name],
      ['모델 121자 → 거부', { model: 'm'.repeat(121) }, E.name],
      ['자료 GitHub 저장소 주소 → 통과', { materials: 'https://github.com/a/b' }, OR409],
      ['자료 경로 없는 주소 → 거부', { materials: 'https://github.com' }, E.mat],
      ['share 에 없는 공급자 → 거부', { share: { nope: 1 } }, [400, '없는 공급자입니다: nope']],
      ['share 공급자 11개 (상한 10) → 조회 전에 거부', { share: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, 1])) }, [400, '나눠 줄 공급자는 10개까지']],
    ];
    for (const [name, patch, want] of cases) {
      r = await create({ ...V, ...patch });
      check(name, is(r, want), `${r.status} ${r.text.slice(0, 120)}`);
    }
    const st1 = await snap(), o1 = (await fx('fxOutbound')).length;
    check('거부·409 모두: 가짜 Daytona·바깥 호출 없음, 수업·자리·세션·labcfg·감사 기록 그대로', hits.length === h0 && o1 === o0 && st1 === st0, `${hits.length - h0} ${o1 - o0} ${st0 === st1}`);
  }

  // ───────────────────────── #19 입장 · #14 초대 ─────────────────────────
  if (ONLY.has('entry')) {
    section = 'entry';
    let r = await raw(ENTRY_HOST, 'GET', `/j/${C1}`, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    check('GET /j/<code>: 200, 쿠키 없음', r.status === 200 && cookieOf(r).length === 0, r.status + ' ' + cookieOf(r));
    check('GET /j/<code>: form-action 은 그 자리 출처 하나', (r.headers['content-security-policy'] ?? '').includes(`form-action ${seatOrigin(L1)};`), r.headers['content-security-policy']);
    check('GET /j/<code>: Referrer-Policy strict-origin (no-referrer 면 폼 POST 의 Origin 이 null)', r.headers['referrer-policy'] === 'strict-origin', r.headers['referrer-policy']);
    check('초대 화면에 자리 출처', r.text.includes(seatOrigin(L1)));
    check('초대 화면: 자동 미리보기 안내, 제어는 별도 허용', r.text.includes('data-auto-view-notice') && r.text.includes('자동으로 보입니다') && r.text.includes('먼저 허용을 요청'));
    check('초대 화면 스크립트 문법', scriptsOk(r.text));
    r = await raw(ENTRY_HOST, 'GET', `/__lab/enter/${C1}`);
    check('예전 GET /__lab/enter/<code>: 쿠키 없이 /j/ 로', r.status === 302 && r.headers.location === `/j/${C1}` && cookieOf(r).length === 0, JSON.stringify(r.headers));
    r = await raw(ENTRY_HOST, 'GET', '/');
    check('초대 화면 밖(입장 호스트 /)은 그대로 no-referrer', r.headers['referrer-policy'] === 'no-referrer', r.headers['referrer-policy']);
    r = await raw(seatHost(L1), 'GET', `/__lab/enter?code=${C1}`, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    check('자리 호스트 GET /__lab/enter: 쿠키 없음', r.status === 405 && cookieOf(r).length === 0, r.status);

    const enter = (lbl, c, h = {}, extra = {}) => raw(seatHost(lbl), 'POST', '/__lab/enter', {
      headers: { origin: ENTRY, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...h },
      body: `code=${c}&watch=`, ...extra,
    });
    r = await enter(L1, C1);
    const ck = cookieOf(r).join('\n');
    check('입장 POST (정상): __Host-lab_seat, Strict, Domain 없음', r.status === 200 && ck.startsWith(`__Host-lab_seat=${C1};`) && /SameSite=Strict/i.test(ck) && /Secure/i.test(ck) && /HttpOnly/i.test(ck) && !/domain=/i.test(ck), r.status + ' ' + ck);
    check('입장 POST: 문서는 / 로 이동만', r.text.includes("location.replace('/')") && scriptsOk(r.text) && r.text.includes("removeItem('labWatch')"));
    r = await raw(seatHost(L1), 'POST', '/__lab/enter', { headers: { origin: ENTRY, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, body: `code=${C1}&watch=1` });
    check('강사 보기 입장 (watch=1): 막대에 알릴 표시', r.status === 200 && r.text.includes("setItem('labWatch','1')") && scriptsOk(r.text), r.status);
    for (const p of ['/', '/c/K7Q2XA', `/j/${code()}`]) { const x = await raw(ENTRY_HOST, 'GET', p); check(`입장 호스트 ${p.slice(0, 4)} 페이지 스크립트 문법`, scriptsOk(x.text), x.status); }
    r = await enter(L1, C1, { origin: undefined });
    check('Origin 없음 → 403, 쿠키 없음', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { origin: 'http://evil.example' });
    check('다른 Origin → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { origin: 'null' });
    check('Origin: null → 403 (null 은 허용 안 함), 쿠키 없음', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { origin: seatOrigin(L2) });
    check('다른 자리 호스트 Origin → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { origin: seatOrigin(L1) });
    check('자기 자리 호스트 Origin(입장 호스트 아님) → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { 'sec-fetch-site': 'cross-site' });
    check('Sec-Fetch-Site cross-site → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { 'sec-fetch-mode': 'cors' });
    check('Sec-Fetch-Mode cors (fetch) → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L2, C1);
    check('다른 자리 호스트로 내 코드 (cross-seat) → 403, 쿠키 없음', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L4, C1);
    check('다른 수업 자리 호스트로 내 코드 → 403', r.status === 403 && cookieOf(r).length === 0, r.status);
    r = await enter(L1, C1, { 'content-type': 'application/json' });
    check('입장 POST JSON → 415', r.status === 415 && cookieOf(r).length === 0, r.status);
    r = await raw(seatHost(L1), 'POST', '/__lab/enter', { headers: { origin: ENTRY, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, body: `code=${C1}&x=${'a'.repeat(2000)}` });
    check('입장 POST 1KiB 넘음 (Content-Length) → 413', r.status === 413 && cookieOf(r).length === 0, r.status);
    r = await raw(seatHost(L1), 'POST', '/__lab/enter', { headers: { origin: ENTRY, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }, body: `code=${C1}&x=${'a'.repeat(2000)}`, chunked: true });
    check('입장 POST 1KiB 넘음 (chunked) → 413', r.status === 413 && cookieOf(r).length === 0, r.status);

    // 수업 코드·이름 (#14)
    const ej = (p, b, h = {}) => raw(ENTRY_HOST, 'POST', p, { headers: { origin: ENTRY, 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
    r = await ej('/__lab/claim', { cls: 'K7Q2XA', name: 'Alice' });
    check('예전 수업 코드 claim (남의 이름) → 410, 코드·쿠키 없음', r.status === 410 && !r.text.includes(C1) && cookieOf(r).length === 0, r.status + r.text);
    r = await ej('/__lab/claim', { cls: 'K7Q2XA', name: 'Newbie' });
    check('예전 수업 코드 claim (새 이름) → 410, 자리 안 줌', r.status === 410 && ![C1, C2, C3].some((c) => r.text.includes(c)), r.status);
    r = await raw(ENTRY_HOST, 'GET', '/c/K7Q2XA');
    check('GET /c/<수업 코드> → 410 안내, 코드·쿠키 없음', r.status === 410 && ![C1, C2, C3].some((c) => r.text.includes(c)) && cookieOf(r).length === 0, r.status);
    r = await ej('/__lab/wake', { code: C2, name: 'Alice' });
    let lab = await labRec();
    check('이름 Alice 로 다른 자리 깨우기 → 그 자리(2번)만, 1번은 그대로', r.status === 200 && r.j.seat === 2 && lab.seats[0].who === 'Alice' && lab.seats[1].who === 'Alice', JSON.stringify(r.j));
    r = await ej('/__lab/wake', { code: C1, name: 'Mallory' });
    lab = await labRec();
    check('이름이 있는 자리에 다른 이름 → 바뀌지 않음', r.status === 200 && lab.seats[0].who === 'Alice', JSON.stringify(lab.seats[0]));
    check('wake 응답: ready + label 만 (다른 자리 코드 없음)', r.j.status === 'ready' && r.j.label === L1 && !r.text.includes(C2));
    r = await ej('/__lab/wake', { code: C1 }, { origin: undefined });
    check('wake Origin 없음 → 403', r.status === 403, r.status);
    r = await ej('/__lab/wake', { code: C1 }, { origin: seatOrigin(L1) });
    check('wake 자리 호스트 Origin → 403', r.status === 403, r.status);
    r = await raw(ENTRY_HOST, 'POST', '/__lab/wake', { headers: { origin: ENTRY, 'content-type': 'text/plain' }, body: JSON.stringify({ code: C1 }) });
    check('wake text/plain → 415', r.status === 415, r.status);
    r = await raw(ENTRY_HOST, 'POST', '/__lab/wake', { headers: { origin: ENTRY, 'content-type': 'application/json' }, body: JSON.stringify({ code: C1, name: 'x'.repeat(1100) }) });
    check('wake 1KiB 넘음 → 413', r.status === 413, r.status);
    r = await raw(ENTRY_HOST, 'POST', '/__lab/wake', { headers: { origin: ENTRY, 'content-type': 'application/json' }, body: JSON.stringify({ code: C1, name: 'x'.repeat(1100) }), chunked: true });
    check('wake chunked 1KiB 넘음 → 413', r.status === 413, r.status);

    // 예전 쿠키
    const before = hits.length;
    r = await raw(ENTRY_HOST, 'GET', '/', { headers: { cookie: `lab_seat=${C1}`, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    check('입장 호스트 + 예전 lab_seat: 안내 화면 + 쿠키 지움, code-server 안 감', r.status === 200 && cookieOf(r).some((c) => /^lab_seat=;.*Max-Age=0/i.test(c)) && csHits(before).length === 0, r.status + ' ' + cookieOf(r));
    r = await raw(ENTRY_HOST, 'GET', '/some/vscode/path', { headers: { cookie: `lab_seat=${C1}` } });
    check('입장 호스트 다른 경로 + 예전 쿠키 → 프록시 안 함', r.status === 404 && csHits(before).length === 0, r.status);
    r = await raw(seatHost(L1), 'GET', '/', { headers: { cookie: `lab_seat=${C1}`, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    check('자리 호스트 + 예전 lab_seat 만 → 401, 프록시 안 함', r.status === 401 && csHits(before).length === 0, r.status);
  }

  // ───────────────────────── #18 자리 호스트 ─────────────────────────
  if (ONLY.has('host')) {
    section = 'host';
    const nav = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    let n = hits.length;
    let r = await raw(seatHost(L1), 'GET', '/', { headers: { cookie: `__Host-lab_seat=${C1}; cs=1`, ...nav } });
    const up = csHits(n).find((h) => h.path === '/');
    check('정상: 자리 쿠키 → code-server, 우리 쿠키는 안 넘김', r.status === 200 && r.text.includes('code-server') && up && up.headers.cookie === 'cs=1' && up.headers['x-daytona-preview-token'] === 'pv-sb1', JSON.stringify(up?.headers ?? {}));
    check('정상: 막대·경계 스크립트 끼움', r.text.includes('/__lab/guard.js') && r.text.includes('/__lab/bar.js'));
    check('자동 화면: head의 WebGL 보존 prelude와 live보다 먼저 오는 캡처 번들', /<head[^>]*>[\s\S]*?dom-capture-prelude\.js[\s\S]*?<\/head>/i.test(r.text) && r.text.indexOf('/__lab/dom-capture.js') > 0 && r.text.indexOf('/__lab/dom-capture.js') < r.text.indexOf('/__lab/live.js'));
    n = hits.length;
    r = await raw(seatHost(L2), 'GET', '/', { headers: { cookie: `__Host-lab_seat=${C1}`, ...nav } });
    check('다른 자리 호스트 + 내 쿠키 → 403, 프록시 안 함', r.status === 403 && csHits(n).length === 0, r.status);
    r = await raw(seatHost(label()), 'GET', '/', { headers: { cookie: `__Host-lab_seat=${C1}`, ...nav } });
    check('없는 label 호스트 + 쿠키 → 403', r.status === 403 && csHits(n).length === 0, r.status);
    for (const h of [`s-${L1.toUpperCase().slice(0, 5)}.${SEAT_DOMAIN}`, `s-abc.${SEAT_DOMAIN}`, `x.s-${L1}.${SEAT_DOMAIN}`, `evil.${SEAT_DOMAIN}`]) {
      r = await raw(h, 'GET', '/p/openrouter/x', { headers: { cookie: `__Host-lab_seat=${C1}` } });
      const r2 = await raw(h, 'GET', '/', { headers: { cookie: `__Host-lab_seat=${C1}`, ...nav } });
      check(`형식이 틀린 자리 호스트 ${h.split('.')[0]} → /p/·/ 모두 404`, r.status === 404 && r2.status === 404, `${r.status} ${r2.status}`);
    }
    check('틀린 호스트들은 프록시 안 함', csHits(n).length === 0);
    // Sec-Fetch
    r = await raw(seatHost(L1), 'GET', '/x.js', { headers: { cookie: `__Host-lab_seat=${C1}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
    check('다른 자리(same-site) fetch → 403', r.status === 403, r.status);
    r = await raw(seatHost(L1), 'GET', '/x.js', { headers: { cookie: `__Host-lab_seat=${C1}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
    check('cross-site script → 403', r.status === 403, r.status);
    // 자리 A → 자리 B (same-site) 최상위 이동: B 의 Strict 쿠키가 실려 와도 upstream 에 닿기 전에 확인 화면
    const pvHits = (since, sb) => csHits(since).filter((h) => h.headers['x-daytona-preview-token'] === `pv-${sb}`);
    const ssNav = { cookie: `__Host-lab_seat=${C2}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' };
    n = hits.length;
    r = await raw(seatHost(L2), 'GET', '/?folder=/home/daytona/work', { headers: ssNav });
    check('A→B same-site 문서 이동: 확인 화면 (200), B upstream 안 감', r.status === 200 && r.text.includes('계속') && r.text.includes(JSON.stringify(`${seatOrigin(L2)}/?folder=/home/daytona/work`)) && pvHits(n, 'sb2').length === 0 && csHits(n).length === 0, `${r.status} ${csHits(n).length}`);
    check('확인 화면: 쿠키 안 건드림·스크립트 문법·frame 금지', cookieOf(r).length === 0 && scriptsOk(r.text) && r.headers['x-frame-options'] === 'DENY', cookieOf(r));
    r = await raw(seatHost(L2), 'HEAD', '/', { headers: ssNav });
    check('A→B same-site HEAD 이동 → 확인 화면, upstream 안 감', r.status === 200 && csHits(n).length === 0, r.status);
    r = await raw(seatHost(L2), 'GET', '//evil.example/x', { headers: ssNav });
    check('확인 화면의 계속 주소는 이 자리 출처 절대 주소 (// 경로로 밖에 못 나감)', r.status === 200 && r.text.includes(JSON.stringify(`${seatOrigin(L2)}//evil.example/x`)) && csHits(n).length === 0, r.status);
    r = await raw(seatHost(L2), 'GET', '/__lab/leave', { headers: ssNav });
    check('A→B same-site 로 /__lab/leave → 확인 화면, 쿠키 안 지움', r.status === 200 && cookieOf(r).length === 0 && r.text.includes('계속'), `${r.status} ${cookieOf(r)}`);
    r = await raw(seatHost(L2), 'GET', '/', { headers: { ...ssNav, 'sec-fetch-site': 'same-origin' } });
    check('확인 뒤 같은 출처 이동 → B upstream 으로', r.status === 200 && r.text.includes('code-server') && pvHits(n, 'sb2').length === 1, `${r.status} ${pvHits(n, 'sb2').length}`);
    n = hits.length;
    r = await raw(seatHost(L2), 'GET', '/', { headers: { ...ssNav, 'sec-fetch-site': 'none' } });
    check('직접 연 것(북마크, none) → B upstream 으로', r.status === 200 && pvHits(n, 'sb2').length === 1, r.status);
    n = hits.length;
    r = await raw(seatHost(L2), 'GET', '/', { headers: { ...ssNav, 'sec-fetch-dest': 'iframe' } });
    check('same-site iframe → 403, upstream 안 감', r.status === 403 && csHits(n).length === 0, r.status);
    r = await raw(seatHost(L2), 'GET', '/static/x.js', { headers: { ...ssNav, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
    check('same-site 자산(script) → 403, upstream 안 감', r.status === 403 && csHits(n).length === 0, r.status);
    r = await raw(seatHost(L2), 'GET', '/', { headers: { ...ssNav, 'sec-fetch-site': 'cross-site' } });
    check('cross-site 문서 이동 → 403, upstream 안 감', r.status === 403 && csHits(n).length === 0 && (r.headers['content-type'] ?? '').includes('text/html'), r.status);
    r = await raw(seatHost(L2), 'GET', `/__lab/export/${'a'.repeat(24)}`, { headers: ssNav });
    check('same-site 이동으로 /__lab/export/<표> → 확인 화면 (받기 안 함)', r.status === 200 && r.text.includes('계속') && !hits.slice(n).some((h) => h.path.includes('/files/download')), r.status);
    r = await raw(seatHost(L1), 'POST', '/upload', { headers: { cookie: `__Host-lab_seat=${C1}`, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: seatOrigin(L2) }, body: 'x' });
    check('same-site 폼 POST → 403', r.status === 403, r.status);
    n = hits.length;
    r = await raw(seatHost(L1), 'GET', '/static/app.js', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME, 'sec-fetch-dest': 'script' } });
    check('같은 출처 자산 → 통과', r.status === 200 && r.j?.echo, r.status);
    r = await raw(seatHost(L1), 'POST', '/api/x', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME, origin: seatOrigin(L1), 'content-type': 'application/json' }, body: '{}' });
    check('같은 출처 POST → Origin 을 upstream 출처로 바꿔 넘김', r.status === 200 && r.j?.origin === MOCK, JSON.stringify(r.j));
    r = await raw(seatHost(L1), 'POST', '/api/x', { headers: { cookie: `__Host-lab_seat=${C1}`, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    check('다른 Origin POST → 403 (바꿔 넘기지 않음)', r.status === 403, r.status);
    r = await raw(seatHost(L1), 'POST', '/api/x', { headers: { cookie: `__Host-lab_seat=${C1}`, origin: seatOrigin(L2), 'content-type': 'application/json' }, body: '{}' });
    check('다른 자리 Origin POST → 403', r.status === 403, r.status);
    check('막힌 POST 는 code-server 에 안 감', csHits(n).filter((h) => h.path === '/api/x').length === 1);
    // WebSocket
    const wsh = (o) => ({ cookie: `__Host-lab_seat=${C1}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...SEAT_SAME, 'sec-fetch-mode': 'websocket', ...(o ? { origin: o } : {}) });
    n = hits.length;
    r = await raw(seatHost(L1), 'GET', '/ws', { headers: wsh(null) });
    check('WebSocket Origin 없음 → 403', r.status === 403, r.status);
    r = await raw(seatHost(L1), 'GET', '/ws', { headers: wsh(seatOrigin(L2)) });
    check('WebSocket 다른 자리 Origin → 403', r.status === 403, r.status);
    r = await raw(seatHost(L1), 'GET', '/ws', { headers: wsh(ENTRY) });
    check('WebSocket 입장 호스트 Origin → 403', r.status === 403, r.status);
    check('막힌 WebSocket 은 upstream 에 안 감', !hits.slice(n).some((h) => h.method === 'UPGRADE'));
    r = await raw(seatHost(L1), 'GET', '/ws', { headers: wsh(seatOrigin(L1)) });
    const wu = hits.slice(n).find((h) => h.method === 'UPGRADE');
    check('WebSocket 같은 출처 → 101, upstream Origin 은 code-server 출처', r.status === 101 && wu?.headers.origin === MOCK && !String(wu?.headers.cookie ?? '').includes('lab_seat'), `${r.status} ${wu?.headers.origin}`);
    r = await raw(seatHost(L2), 'GET', '/ws', { headers: { ...wsh(seatOrigin(L2)) } });
    check('WebSocket 다른 자리 호스트 + 내 쿠키 → 막힘', r.status !== 101, r.status);
    // Set-Cookie·Clear-Site-Data
    r = await raw(seatHost(L1), 'GET', '/setcookie', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME } });
    const sc = cookieOf(r);
    check('upstream Set-Cookie: Domain 전부 뗌', sc.length === 2 && sc.every((c) => !/domain/i.test(c)) && sc[0].startsWith('a=1') && sc[1].startsWith('b=2'), JSON.stringify(sc));
    check('upstream 의 __Host-lab_seat·lab_seat(대소문자 무관) 버림', !sc.some((c) => /lab_seat/i.test(c)), JSON.stringify(sc));
    check('upstream Clear-Site-Data 버림', !('clear-site-data' in r.headers), JSON.stringify(r.headers));
    // /__lab 갈래 순서: 모르는 경로·다른 쿠키·다른 출처는 자리 기록·upstream·본문 읽기 전에 끊는다
    const own = (m, p, ck = C1, o = {}) => raw(seatHost(L1), m, p, { ...o, headers: { ...(ck ? { cookie: `__Host-lab_seat=${ck}` } : {}), ...SEAT_SAME, ...o.headers } });
    const onlyErr = (x) => x.j && Object.keys(x.j).join() === 'error';
    n = hits.length;
    let st = [];
    for (const m of ['GET', 'HEAD']) for (const ck of ['', C1]) st.push((await own(m, '/__lab/nope', ck)).status);
    check('모르는 /__lab GET·HEAD: 쿠키 없음 401 · 내 자리 404', JSON.stringify(st) === '[401,404,401,404]', JSON.stringify(st));
    const pj = { origin: seatOrigin(L1), 'content-type': 'application/json' };
    st = [];
    for (const [p, b, ck, m, chunked] of [['/__lab/nope', 'x'.repeat(4000), C1], ['/__lab/nope', 'x'.repeat(4000), C1, 'POST', true], ['/__lab/nope', '{bad', C1], ['/__lab/nope', '{bad', ''], ['/__lab/me', 'x'.repeat(4000), C1, 'PUT']]) {
      st.push((await own(m ?? 'POST', p, ck, { headers: pj, body: b, chunked })).status);
    }
    check('모르는 POST·PUT /__lab: 상한 넘음·깨진 JSON·쿠키 없음보다 먼저 404', st.every((s) => s === 404), JSON.stringify(st));
    check('모르는 /__lab 요청은 upstream·Daytona 에 안 감', hits.length === n, hits.slice(n).map((h) => h.path));
    const apis = ['/__lab/screen', '/__lab/me', '/__lab/snips', `/__lab/export/${'b'.repeat(24)}`];
    let rs = [];
    for (const p of apis) rs.push(await own('GET', p, C2));
    check('다른 자리 쿠키로 GET screen·me·snips·export → 403, 오류 말고 아무것도 없음', rs.every((x) => x.status === 403 && onlyErr(x)), rs.map((x) => `${x.status} ${x.text.slice(0, 60)}`));
    rs = [];
    for (const p of apis) rs.push(await raw(seatHost(label()), 'GET', p, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME } }));
    check('없는 label 호스트 + 내 쿠키로 GET screen·me·snips·export → 403, 본문 없음', rs.every((x) => x.status === 403 && onlyErr(x)), rs.map((x) => x.status));
    rs = [];
    for (const p of apis) rs.push(await own('GET', p, ''));
    check('쿠키 없이 GET screen·me·snips·export → 401', rs.every((x) => x.status === 401 && onlyErr(x)), rs.map((x) => x.status));
    n = hits.length;
    rs = [];
    for (const p of ['/__lab/bar.js', '/__lab/guard.js', '/__lab/icon-192.png', '/__lab/dom-capture.js', '/__lab/dom-capture-prelude.js']) {
      rs.push(await own('GET', p, C1, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } }));
      rs.push(await own('GET', p, C1, { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } }));
    }
    check('공개 자산(bar·guard·icon)도 다른 사이트·다른 자리에서 → 403 JSON', rs.every((x) => x.status === 403 && x.j?.error === 'cross-site request blocked'), rs.map((x) => x.status));
    r = await own('GET', '/__lab/bar.js', '');
    check('공개 자산은 같은 출처면 쿠키 없이도 200 script', r.status === 200 && /javascript/.test(r.headers['content-type'] ?? ''), r.status);
    for (const p of ['/__lab/dom-capture.js', '/__lab/dom-capture-prelude.js']) {
      r = await own('GET', p, '');
      check(`${p}: 같은 출처 자체 제공·no-store, upstream 안 감`, r.status === 200 && /javascript/.test(r.headers['content-type'] ?? '') && r.headers['cache-control'] === 'no-store' && hits.length === n, r.status);
    }
    rs = [await own('GET', '/__lab/guard.js', ''), await own('GET', '/__lab/guard.js', C2)];
    check('guard.js: 쿠키 없음·다른 자리 쿠키 → 기본 클립 규칙(둘 다 막음), no-store, upstream 안 감', rs.every((x) => x.status === 200 && x.text.startsWith('window.__labClipPolicy={"in":true,"out":true};') && x.headers['cache-control'] === 'no-store') && hits.length === n, rs.map((x) => `${x.status} ${x.text.slice(0, 50)}`));
    rs = [];
    for (const p of ['/__lab/me', `/__lab/export/${'b'.repeat(24)}`, '/static/x.js']) {
      rs.push(await own('GET', p, C1, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } }));
      rs.push(await own('GET', p, C1, { headers: { origin: 'http://evil.example' } }));
    }
    check('GET 경계(Sec-Fetch·Origin)가 자리 API·export·upstream 보다 먼저 → 403, 아무 데도 안 감', rs.every((x) => x.status === 403 && onlyErr(x)) && hits.length === n, `${rs.map((x) => x.status)} ${hits.length - n}`);
    for (const p of ['/__lab/snips', `/__lab/export/${'b'.repeat(24)}`]) {
      const g = await own('GET', p), h = await own('HEAD', p);
      check(`HEAD ${p.split('/')[2]} 은 GET 과 같은 갈래 (${g.status}), 본문 없음, 받기 없음`, h.status === g.status && [200, 204, 410].includes(g.status) && h.buf.length === 0 && !hits.slice(n).some((x) => x.path.includes('/files/download')), `${g.status} ${h.status} ${h.buf.length}`);
    }
    // 떠나기
    r = await raw(seatHost(L1), 'GET', '/__lab/leave', { headers: { cookie: `__Host-lab_seat=${C1}`, ...nav } });
    check('/__lab/leave: 자리 쿠키 지우고 입장 호스트로', r.status === 302 && r.headers.location === `${ENTRY}/` && cookieOf(r).some((c) => /^__Host-lab_seat=;.*Max-Age=0/.test(c)), JSON.stringify(r.headers));
    // 예전 수업 자리 label 채우기 (lazy)
    r = await raw(ENTRY_HOST, 'GET', `/j/${C3}`);
    const lab = await labRec();
    const L3 = lab.seats[2].label;
    check('label 없는 예전 자리: 처음 열 때 label 저장 (코드와 무관한 26자)', r.status === 200 && /^[a-z2-7]{26}$/.test(L3 ?? '') && r.text.includes(seatOrigin(L3)) && !L3.includes(C3.toLowerCase()), L3);
    r = await raw(ENTRY_HOST, 'GET', `/j/${C3}`);
    check('label 은 한 번 정하면 그대로', (await labRec()).seats[2].label === L3 && r.text.includes(seatOrigin(L3)));
    r = await raw(seatHost(L3), 'GET', '/', { headers: { cookie: `__Host-lab_seat=${C3}`, ...nav } });
    check('예전 자리도 자기 label 호스트에서 열림', r.status === 200, r.status);
  }

  // ───────────────────────── #19 진짜 브라우저 입장 (설치된 Edge) ─────────────────────────
  // 초대 화면에서 "입장" 을 눌러 자리 호스트로 폼 POST → Origin 이 입장 출처인지 (Worker 가 받은 헤더), 쿠키·이동, 자리 A→B 확인 화면
  if (ONLY.has('browser')) {
    section = 'browser';
    let browser = null;
    try { const { chromium } = await import('playwright-core'); browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 60e3 }); }
    catch (e) { skipN++; console.log(`  skip [browser] Edge 를 띄우지 못함: ${String(e?.message ?? e).split('\n')[0]}`); }
    if (browser) {
      // 상한 120초: 넘으면 브라우저를 닫아 기다리던 Playwright 호출이 바로 실패하게 (서버는 아래 stop() 이 항상 끈다)
      const guard = setTimeout(() => { failN++; console.log('  FAIL [browser] 120초 넘음 → 브라우저 닫음'); browser.close().catch(() => {}); }, 120e3);
      try {
        const enters = async () => (await fetch(`${GW}/__fx-enters`)).json();
        const pvHits = (since, sb) => csHits(since).filter((h) => h.headers['x-daytona-preview-token'] === `pv-${sb}`);
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const join = async (c, lbl, sb) => {
          const e0 = (await enters()).length;
          const n = hits.length;
          const resp = await page.goto(`${ENTRY}/j/${c}`);
          check(`초대 화면 응답 Referrer-Policy strict-origin (${sb})`, resp.status() === 200 && resp.headers()['referrer-policy'] === 'strict-origin', `${resp.status()} ${resp.headers()['referrer-policy']}`);
          await page.click('#go');
          await page.waitForURL(`${seatOrigin(lbl)}/`, { timeout: 30e3 });
          await page.waitForFunction(() => document.body?.textContent.includes('code-server'), null, { timeout: 15e3 });
          const seen = (await enters()).slice(e0);
          check(`입장 POST 를 자리 호스트가 받음: Origin = 입장 출처, same-site·navigate (${sb})`, seen.length === 1 && seen[0].method === 'POST' && seen[0].host === seatHost(lbl) && seen[0].origin === ENTRY && seen[0].site === 'same-site' && seen[0].mode === 'navigate', JSON.stringify(seen));
          check(`Referer 는 출처만 (경로·자리 코드 없음) (${sb})`, seen[0]?.referer === null || seen[0]?.referer === `${ENTRY}/`, seen[0]?.referer);
          const ck = (await ctx.cookies(seatOrigin(lbl))).find((x) => x.name === '__Host-lab_seat');
          check(`자리 쿠키 = 이 자리 코드, Strict·HttpOnly, 이 호스트만 (${sb})`, ck?.value === c && ck.sameSite === 'Strict' && ck.httpOnly && ck.domain === `s-${lbl}.gw.localhost`, JSON.stringify(ck));
          check(`입장 뒤 / → code-server (같은 출처 이동, 확인 화면 없음) (${sb})`, pvHits(n, sb).some((h) => h.path === '/' && h.headers['sec-fetch-site'] === 'same-origin'), JSON.stringify(pvHits(n, sb).map((h) => [h.path, h.headers['sec-fetch-site']])));
        };
        await join(C2, L2, 'sb2');
        await join(C1, L1, 'sb1');
        // 자리 A(L1) 화면에서 자리 B(L2) 링크를 누름 → B 의 Strict 쿠키가 실리는 same-site 이동 → 확인 화면, B upstream 안 감
        const n = hits.length;
        await page.evaluate((to) => { const a = document.createElement('a'); a.href = to; a.id = 'xseat'; a.textContent = 'x'; document.body.append(a); }, `${seatOrigin(L2)}/?from=a`);
        await page.click('#xseat');
        await page.waitForURL(`${seatOrigin(L2)}/?from=a`, { timeout: 15e3 });
        await page.waitForSelector('#go', { timeout: 15e3 });
        check('브라우저 A→B 링크: 확인 화면, B upstream 안 감', (await page.textContent('body')).includes('계속') && pvHits(n, 'sb2').length === 0, pvHits(n, 'sb2').length);
        await page.click('#go');
        await page.waitForFunction(() => document.body?.textContent.includes('code-server'), null, { timeout: 15e3 });
        const after = pvHits(n, 'sb2');
        check('계속 누름 → 같은 출처 이동으로 B upstream', after.length >= 1 && after[0].path === '/?from=a' && after[0].headers['sec-fetch-site'] === 'same-origin', JSON.stringify(after.map((h) => [h.path, h.headers['sec-fetch-site']])));
        await ctx.close();
      } finally { clearTimeout(guard); await browser.close().catch(() => {}); }
    }
  }

  // ───────────────────────── #14 강사 초대 ─────────────────────────
  if (ONLY.has('invite')) {
    section = 'invite';
    let r = await adminCall('/api/lab/list', {}, ADMIN);
    const all = JSON.stringify(r.j);
    check('목록: 자리 코드·수업 링크·QR 없음', r.status === 200 && ![C1, C2, C3].some((c) => all.includes(c)) && !all.includes('/c/K7Q2XA') && !('qr' in (r.j.labs?.[0] ?? {})), all.slice(0, 300));
    r = await adminCall('/api/lab/invite', { id: LAB, n: 1 }, ADMIN);
    check('자리 초대 1번: 링크 + QR', r.status === 200 && r.j.link === `${ENTRY}/j/${C1}` && String(r.j.qr).startsWith('<svg') && r.j.n === 1, JSON.stringify(r.j).slice(0, 200));
    r = await adminCall('/api/lab/invite', { id: LAB }, ADMIN);
    check('자리 초대 전부: 자리마다 다른 링크', r.status === 200 && r.j.seats.length === 3 && new Set(r.j.seats.map((x) => x.link)).size === 3, JSON.stringify(r.j).slice(0, 200));
    r = await adminCall('/api/lab/invite', { id: LAB, n: 1 }, 'bad-token');
    check('관리 토큰 없음 → 401', r.status === 401, r.status);
    r = await adminCall('/api/lab/invite', { id: LAB, n: 9 }, ADMIN);
    check('없는 자리 → 404', r.status === 404, r.status);
    r = await raw(`127.0.0.1:${PORT}`, 'POST', '/api/lab/invite', { headers: { origin: ENTRY, 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify({ id: LAB, n: 1 }) });
    check('입장 호스트 Origin 으로 관리 API → 403', r.status === 403, r.status);
  }

  // ───────────────────────── /__lab 본문 상한·형식 ─────────────────────────
  if (ONLY.has('body')) {
    section = 'body';
    let r = await seatApi(L1, C1, '/__lab/hand', { up: true });
    check('정상 손 들기', r.status === 200 && r.j.hand === true, r.status);
    r = await seatApi(L1, C1, '/__lab/hand', { up: false }, { origin: undefined });
    check('Origin 없음 → 403', r.status === 403, r.status);
    r = await seatApi(L1, C1, '/__lab/hand', { up: false }, { origin: ENTRY });
    check('입장 호스트 Origin → 403', r.status === 403, r.status);
    r = await seatApi(L1, C1, '/__lab/hand', { up: false }, { 'content-type': 'text/plain' });
    check('text/plain → 415', r.status === 415, r.status);
    const big = JSON.stringify({ up: false, pad: 'x'.repeat(2000) });
    r = await raw(seatHost(L1), 'POST', '/__lab/me', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME, origin: seatOrigin(L1), 'content-type': 'application/json' }, body: big });
    check('1KiB 넘음 (Content-Length) → 413', r.status === 413, r.status);
    r = await raw(seatHost(L1), 'POST', '/__lab/me', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME, origin: seatOrigin(L1), 'content-type': 'application/json' }, body: big, chunked: true });
    check('1KiB 넘음 (chunked) → 413', r.status === 413, r.status);
    const sdp = 'v=0\r\n' + ('a=' + 'x'.repeat(60) + '\r\n').repeat(1500); // 원문 ~96KB, JSON ~99KB (브라우저 SDP 처럼 긴 줄)
    r = await seatApi(L1, C1, '/__lab/screen/answer', { sid: 'abcdefgh12', sdp });
    check('SDP answer 100KB → 상한 안 (413 아님)', r.status !== 413 && r.status !== 415, r.status);
    r = await raw(seatHost(L1), 'POST', '/__lab/screen/answer', { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME, origin: seatOrigin(L1), 'content-type': 'application/json' }, body: JSON.stringify({ sid: 'abcdefgh12', sdp: sdp + 'a=y\r\n'.repeat(6000) }), chunked: true });
    check('SDP answer 128KiB 넘음 (chunked) → 413', r.status === 413, r.status);
    r = await seatApi(L1, C1, '/__lab/hand', undefined);
    check('GET 으로 POST API → 404', r.status === 404, r.status);
    r = await seatApi(L1, C2, '/__lab/hand', { up: true });
    check('다른 자리 쿠키로 이 호스트 API → 403', r.status === 403, r.status);
  }

  // ───────────────────────── #11 내 작업 받기 ─────────────────────────
  if (ONLY.has('export')) {
    section = 'export';
    const stages = () => execs.filter((e) => e.command.includes('mkdir -m 700')).map((e) => e.command.match(/\.gw-export\/([0-9a-f-]{36})/)[1]);
    const rms = (id) => execs.filter((e) => e.command.includes('rm -rf') && e.command.includes(id)).length;
    const exp = (body = {}) => seatApi(L1, C1, '/__lab/export', body);
    await fx('fxTimes', {});
    let r = await exp();
    const id1 = stages().at(-1);
    check('시작: 한 번 쓰는 표 + 이름', r.status === 200 && /^[\w-]{24}$/.test(r.j.ticket) && r.j.name === 'lab-1-work.zip' && r.j.size === M.zip.length && r.j.entries === 3, JSON.stringify(r.j));
    const mk = execs.find((e) => e.command.includes(id1) && e.command.includes('mkdir'));
    check('묶는 곳: 매번 새 uuid 폴더, umask 077·0700, 링크 루트 거부', !!mk && /umask 077/.test(mk.command) && /mkdir -m 700 \/home\/daytona\/\.gw-export\/[0-9a-f-]{36}/.test(mk.command) && /test ! -L/.test(mk.command), mk?.command);
    const run = execs.find((e) => e.command.includes('export.cjs') && e.command.includes('node'));
    check('묶기: 1GiB·50,000·시간 제한 인자 + timeout', !!run && run.command.includes(' 1073741824 50000 240') && /timeout -k 5 245 node/.test(run.command), run?.command);
    check('묶기 스크립트를 그 폴더에 올림', uploads.some((u) => u.path === `/home/daytona/.gw-export/${id1}/export.cjs` && u.size > 1000));
    const t1 = r.j.ticket;
    r = await exp();
    check('진행 중에 또 → 409 (자리마다 하나)', r.status === 409, r.status);
    const n0 = execs.length;
    r = await seatApi(L1, C1, `/__lab/export/${t1}`, undefined, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' });
    check('표로 받기: zip 스트림 그대로 + 첨부', r.status === 200 && r.buf.equals(M.zip) && /attachment; filename="lab-1-work.zip"/.test(r.headers['content-disposition'] ?? '') && r.headers['content-type'] === 'application/zip', r.status);
    await sleep(300);
    check('다 받으면 묶은 폴더 한 번 지움', rms(id1) === 1, rms(id1));
    check('받기 기록 지워짐', Object.keys(await fx('fxList', `exp:${C1}`)).length === 0);
    r = await seatApi(L1, C1, `/__lab/export/${t1}`, undefined);
    check('같은 표 다시 → 410', r.status === 410, r.status);
    r = await seatApi(L2, C2, `/__lab/export/${t1}`, undefined, { cookie: `__Host-lab_seat=${C2}` });
    check('다른 자리에서 남의 표 → 410', r.status === 410, r.status);
    r = await exp();
    check('60초 안에 또 → 429', r.status === 429, r.status);
    check('429·409 는 샌드박스를 안 건드림', execs.slice(n0).filter((e) => e.command.includes('mkdir')).length === 0);

    await fx('fxTimes', { cooldown: 0 });
    M.pack = 'ERR 너무 큼 (읽은 바이트가 한도 1073741824 를 넘음)';
    r = await exp();
    const id2 = stages().at(-1);
    check('한도 넘음(묶기 실패) → 502, 이유 표시', r.status === 502 && r.j.error.includes('너무 큼'), JSON.stringify(r.j));
    check('실패해도 폴더 한 번 지움, 기록 없음', rms(id2) === 1 && Object.keys(await fx('fxList', `exp:${C1}`)).length === 0);
    M.pack = 'ERR 항목이 너무 많음 (한도 50000개)';
    r = await exp();
    check('항목 한도 → 502', r.status === 502 && r.j.error.includes('항목'), JSON.stringify(r.j));
    M.pack = PACK_OK;

    // 표 만료 (알람)
    await fx('fxTimes', { cooldown: 0, ticket: 50 });
    r = await exp();
    const id3 = stages().at(-1);
    await sleep(120);
    await fx('fxAlarm');
    check('표를 안 쓰고 만료 → 알람이 폴더 지움', rms(id3) === 1 && Object.keys(await fx('fxList', `exp:${C1}`)).length === 0, rms(id3));
    r = await seatApi(L1, C1, `/__lab/export/${r.j.ticket}`, undefined);
    check('만료된 표 → 410', r.status === 410, r.status);

    // 받는 중 취소 (DO 의 스트림을 Worker 안에서 읽다 cancel)
    await fx('fxTimes', { cooldown: 0 });
    r = await exp();
    const id4 = stages().at(-1);
    M.slowZip = true;
    const dl = await raw(seatHost(L1), 'GET', `/__lab/export/${r.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME }, firstChunkThenClose: true });
    check('받는 중 첫 조각', dl.status === 200 && dl.first?.length > 0, dl.status);
    let st = await fx('fxGet', [`exp:${C1}`]);
    check('받는 중 기록 = streaming (표 지워짐)', st[`exp:${C1}`]?.state === 'streaming' && !st[`exp:${C1}`]?.ticket, JSON.stringify(st));
    // 로컬 wrangler dev 는 클라이언트 끊김을 DO 스트림 cancel 로 넘기지 않을 수 있다 → 넘기면 바로, 아니면 만료 알람으로
    await sleep(800);
    let viaCancel = rms(id4) === 1;
    if (!viaCancel) {
      st = await fx('fxGet', [`exp:${C1}`]);
      await fx('fxPut', { [`exp:${C1}`]: { ...st[`exp:${C1}`], exp: 1 } });
      await fx('fxAlarm');
      await sleep(300);
    }
    check(`받는 중 끊김 → 폴더 한 번 지움 (${viaCancel ? 'cancel' : '알람 만료 경로'})`, rms(id4) === 1 && Object.keys(await fx('fxList', `exp:${C1}`)).length === 0, rms(id4));
    for (const h of held.splice(0)) h.end();
    M.slowZip = false;
    await sleep(300);
    check('끊긴 뒤 스트림이 끝나도 두 번 지우지 않음', rms(id4) === 1, rms(id4));

    // 바이트 상한 (#11): 묶은 뒤 work.zip 이 바뀌어도(큰 sparse 파일·링크) 알린 크기·설정 상한 중 작은 것까지만. 헤더를 믿지 않는다
    const dlHits = () => hits.filter((h) => h.path.includes('/files/download')).length;
    const leaseGone = async () => Object.keys(await fx('fxList', `exp:${C1}`)).length === 0;
    const dlCase = async (mode, zipMax) => {
      await fx('fxTimes', { cooldown: 0 });
      const s = await exp();
      const id = stages().at(-1);
      if (zipMax !== undefined) await fx('fxZipMax', zipMax);
      M.zipMode = mode;
      const d0 = dlHits();
      const d = await raw(seatHost(L1), 'GET', `/__lab/export/${s.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME }, tolerateClose: true });
      M.zipMode = 'ok';
      await fx('fxZipMax', null);
      await sleep(400);
      return { s, d, id, downloads: dlHits() - d0 };
    };
    let c = await dlCase('bigHeader');
    check('Content-Length 가 알린 크기보다 큼 → 스트림 전에 502, 받기 1번', c.s.status === 200 && c.d.status === 502 && c.downloads === 1, `${c.d.status} ${c.d.text?.slice(0, 80)}`);
    check('  → 정리 한 번, 기록 없음', rms(c.id) === 1 && (await leaseGone()), rms(c.id));
    c = await dlCase('ok', 500);
    check('설정 상한(작게 500)보다 큰 Content-Length → 502 (알린 크기보다 작아도)', c.d.status === 502 && rms(c.id) === 1 && (await leaseGone()), `${c.d.status} ${rms(c.id)}`);
    c = await dlCase('chunkedOver');
    check('헤더 없이(chunked) 알린 크기를 넘게 보냄 → 끊김, 받은 바이트 ≤ 알린 크기', c.d.status === 200 && c.d.aborted === true && c.d.buf.length <= M.zip.length, `${c.d.status} aborted=${c.d.aborted} ${c.d.buf?.length} cl=${c.d.headers?.['content-length']} te=${c.d.headers?.['transfer-encoding']}`);
    check('  → 정리 한 번, 기록 없음', rms(c.id) === 1 && (await leaseGone()), rms(c.id));
    c = await dlCase('chunked', 500);
    check('헤더 없이 설정 상한(500) 넘김 → 끊김, 받은 바이트 ≤ 500', c.d.aborted === true && c.d.buf.length <= 500 && rms(c.id) === 1 && (await leaseGone()), `aborted=${c.d.aborted} ${c.d.buf?.length} ${rms(c.id)}`);
    c = await dlCase('lyingSmall');
    check('작은 Content-Length(50)로 속이고 더 보냄 → 알린 크기와 달라 끊김 (완료로 안 끝남)', c.d.aborted === true && c.d.buf.length <= 50, `${c.d.status} aborted=${c.d.aborted} ${c.d.buf?.length} cl=${c.d.headers?.['content-length']} te=${c.d.headers?.['transfer-encoding']}`);
    check('  → 정리 한 번, 기록 없음', rms(c.id) === 1 && (await leaseGone()), rms(c.id));
    c = await dlCase('chunked');
    check('헤더 없이 정확히 알린 크기 → 200 완료, 내용 그대로', c.d.status === 200 && c.d.aborted === false && c.d.buf.equals(M.zip), `${c.d.status} aborted=${c.d.aborted} ${c.d.buf?.length} cl=${c.d.headers?.['content-length']} te=${c.d.headers?.['transfer-encoding']}`);
    check('  → 정리 한 번, 기록 없음', rms(c.id) === 1 && (await leaseGone()), rms(c.id));
    c = await dlCase('ok');
    check('Content-Length 정확 → 200 완료, 내용 그대로, 정리 한 번', c.d.status === 200 && c.d.aborted === false && c.d.buf.equals(M.zip) && rms(c.id) === 1 && (await leaseGone()), `${c.d.status} ${rms(c.id)}`);
    await fx('fxTimes', { cooldown: 0 });
    M.pack = `OK 3 11 1 ${(await fx('fxZipMaxReal')).n + 1}`;
    r = await exp();
    const idBig = stages().at(-1);
    check('묶기가 알린 zip 크기가 설정 상한을 넘음 → 502, 표 없음, 정리 한 번', r.status === 502 && !r.j.ticket && rms(idBig) === 1 && (await leaseGone()), JSON.stringify(r.j));

    // 묶기 한도(exportLimits)를 바꾸면 묶기 인자와 거기서 나온 zip 상한이 같이 따른다 (상한을 따로 정하지 않았을 때)
    const lim = { bytes: 1000, entries: 2, seconds: 30 };
    const limMax = lim.bytes + Math.ceil(lim.bytes / 1024) + lim.entries * 1024;
    await fx('fxLimits', lim);
    M.pack = `OK 1 11 0 ${limMax + 1}`;
    r = await exp();
    const idLim = stages().at(-1);
    const runLim = execs.findLast((e) => e.command.includes('export.cjs') && e.command.includes(idLim) && e.command.includes('node'));
    check('바꾼 한도 → 묶기 인자·timeout 도 그 값', !!runLim && runLim.command.includes(' 1000 2 30') && /timeout -k 5 35 node/.test(runLim.command), runLim?.command);
    check('바꾼 한도에서 나온 zip 상한 + 1 → 502, 표 없음, 정리 한 번', r.status === 502 && !r.j.ticket && rms(idLim) === 1 && (await leaseGone()), JSON.stringify(r.j));
    await fx('fxTimes', { cooldown: 0, ticket: 50 });
    M.pack = `OK 1 11 0 ${limMax}`;
    r = await exp();
    const idLim2 = stages().at(-1);
    check('바꾼 한도에서 나온 zip 상한 그대로 → 200 표', r.status === 200 && r.j.size === limMax && /^[\w-]{24}$/.test(r.j.ticket ?? ''), JSON.stringify(r.j));
    await fx('fxLimits', null);
    M.pack = PACK_OK;
    await sleep(120);
    await fx('fxAlarm');
    check('  → 표 만료 알람이 정리 한 번, 기록 없음', rms(idLim2) === 1 && (await leaseGone()), rms(idLim2));
    await fx('fxTimes', { cooldown: 0 });

    // 같은 표로 동시에 두 번 (#11 TOCTOU): 하나만 200, 다른 하나는 410, Daytona 받기는 한 번
    for (let round = 1; round <= 3; round++) {
      await fx('fxTimes', { cooldown: 0 });
      const s = await exp();
      const id = stages().at(-1);
      const d0 = dlHits();
      const both = await Promise.all([0, 1].map(() => raw(seatHost(L1), 'GET', `/__lab/export/${s.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME } })));
      await sleep(300);
      const st = both.map((x) => x.status).sort();
      check(`같은 표 동시 두 요청 (${round}회): 200 하나·410 하나, Daytona 받기 1번, 정리 1번`, st[0] === 200 && st[1] === 410 && dlHits() - d0 === 1 && rms(id) === 1, `${st} ${dlHits() - d0} ${rms(id)}`);
    }

    // 이 인스턴스에서 산 받기(streaming)는 새 시작이 건드리지 않는다
    await fx('fxTimes', { cooldown: 0 });
    r = await exp();
    const idLive = stages().at(-1);
    M.slowZip = true;
    const live = raw(seatHost(L1), 'GET', `/__lab/export/${r.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME }, tolerateClose: true });
    for (let i = 0; i < 100 && held.length === 0; i++) await sleep(50);
    r = await exp();
    st = await fx('fxGet', [`exp:${C1}`]);
    check('받는 중(이 인스턴스) 새 시작 → 409, 받기 기록 그대로, 정리 안 함', r.status === 409 && st[`exp:${C1}`]?.state === 'streaming' && st[`exp:${C1}`]?.id === idLive && rms(idLive) === 0, `${r.status} ${JSON.stringify(st)}`);
    for (const h of held.splice(0)) h.end(M.zip.subarray(100));
    M.slowZip = false;
    const liveR = await live;
    await sleep(300);
    check('붙잡은 받기 마저 보내면 → 200 완료, 정리 한 번', liveR.status === 200 && liveR.buf.equals(M.zip) && rms(idLive) === 1 && (await leaseGone()), `${liveR.status} ${liveR.buf?.length} ${rms(idLive)}`);

    // 받는 시간(stream) 초과: 알람이 산 받기를 끊고 폴더를 한 번 지운다. 붙잡은 Daytona 쪽이 늦게 끝나도 완료로 안 끝나고 두 번 안 지움
    await fx('fxTimes', { cooldown: 0, stream: 300 });
    r = await exp();
    const idSt = stages().at(-1);
    M.slowZip = true;
    const stDl = raw(seatHost(L1), 'GET', `/__lab/export/${r.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME }, tolerateClose: true });
    for (let i = 0; i < 100 && held.length === 0; i++) await sleep(50);
    st = await fx('fxGet', [`exp:${C1}`]);
    check('받는 중 기록의 만료 = 바꾼 받기 시간', st[`exp:${C1}`]?.state === 'streaming' && st[`exp:${C1}`].exp - Date.now() <= 300, JSON.stringify(st));
    await sleep(400);
    await fx('fxAlarm');
    await sleep(300);
    check('받기 시간 지나 알람 → 정리 한 번, 기록 없음', rms(idSt) === 1 && (await leaseGone()), rms(idSt));
    for (const h of held.splice(0)) h.end(M.zip.subarray(100));
    M.slowZip = false;
    const stR = await stDl;
    await sleep(300);
    check('  → 끊긴 받기는 완료로 안 끝나고, 두 번 지우지 않음', !(stR.status === 200 && stR.aborted === false && stR.buf?.equals(M.zip)) && rms(idSt) === 1, `${stR.status} aborted=${stR.aborted} ${stR.buf?.length} ${rms(idSt)}`);
    await fx('fxTimes', { cooldown: 0 });

    // 재시작: 묶어 둔 채로(ready) 프로세스를 끈다 → 다시 켜고 알람
    r = await exp();
    const id5 = stages().at(-1);
    await stop();
    await start();
    st = await fx('fxGet', [`exp:${C1}`]);
    check('재시작 뒤에도 받기 기록·묶은 폴더 id 가 남음', st[`exp:${C1}`]?.id === id5, JSON.stringify(st));
    await fx('fxPut', { [`exp:${C1}`]: { ...st[`exp:${C1}`], exp: 1 } });
    await fx('fxAlarm');
    check('재시작 뒤 알람 → 폴더 한 번 지움', rms(id5) === 1, rms(id5));

    // 재시작: 받는 중(streaming)에 프로세스를 끈다 → 새 인스턴스에는 그 받기의 AbortController 가 없다 (주인 없는 기록)
    await fx('fxTimes', { cooldown: 0 });
    r = await exp();
    const idOrph = stages().at(-1);
    M.slowZip = true;
    const orphDl = raw(seatHost(L1), 'GET', `/__lab/export/${r.j.ticket}`, { headers: { cookie: `__Host-lab_seat=${C1}`, ...SEAT_SAME }, tolerateClose: true });
    for (let i = 0; i < 100 && held.length === 0; i++) await sleep(50);
    check('끄기 전: 받는 중 기록', (await fx('fxGet', [`exp:${C1}`]))[`exp:${C1}`]?.state === 'streaming');
    await stop();
    await orphDl;
    for (const h of held.splice(0)) h.destroy();
    M.slowZip = false;
    await start(); // fxTimes 는 새 인스턴스라 비어 있다 → 배포 값 (쿨다운 60초)
    st = await fx('fxGet', [`exp:${C1}`, `expcd:${C1}`]);
    const lastStart = st[`expcd:${C1}`];
    check('재시작 뒤: streaming 기록이 남아 있음 (예전 코드면 30분 동안 409)', st[`exp:${C1}`]?.state === 'streaming' && st[`exp:${C1}`]?.id === idOrph && rms(idOrph) === 0, JSON.stringify(st));
    r = await exp();
    const left0 = Math.ceil((lastStart + 60e3 - Date.now()) / 1000);
    check('재시작 뒤 새 시작: 주인 없는 기록 정리(폴더 한 번) → 409 아님, 쿨다운 안이면 429', r.status === 429 && rms(idOrph) === 1 && (await leaseGone()), `${r.status} ${JSON.stringify(r.j)} rm=${rms(idOrph)} left=${left0}`);
    r = await exp();
    check('또 눌러도 다시 지우지 않음 (429)', r.status === 429 && rms(idOrph) === 1, `${r.status} ${rms(idOrph)}`);
    // 정책 시각(마지막 시작 + 60초)까지 실제로 기다린다 — 시험용 시간 줄이기 없음
    const wait = lastStart + 60e3 - Date.now();
    if (wait > 1500) { await sleep(wait - 1500); r = await exp(); check('정책 시각 1.5초 전 → 아직 429', r.status === 429, r.status); }
    await sleep(Math.max(0, lastStart + 60e3 - Date.now()) + 300);
    r = await exp();
    const idNew = stages().at(-1);
    check('정책 시각(마지막 시작 + 60초) 뒤 → 새 받기 200', r.status === 200 && /^[\w-]{24}$/.test(r.j.ticket ?? '') && idNew !== idOrph, `${r.status} ${JSON.stringify(r.j)}`);
    r = await seatApi(L1, C1, `/__lab/export/${r.j.ticket}`, undefined);
    await sleep(300);
    check('  그 받기도 정상 (200, 정리 한 번)', r.status === 200 && r.buf.equals(M.zip) && rms(idNew) === 1 && rms(idOrph) === 1, `${r.status} ${rms(idNew)}`);

    // 지우기 실패 → 재시도 (알람), 한 번만 성공
    await fx('fxTimes', { cooldown: 0 });
    M.rmFail = 1;
    r = await exp();
    const id6 = stages().at(-1);
    r = await seatApi(L1, C1, `/__lab/export/${r.j.ticket}`, undefined);
    await sleep(300);
    let q = await fx('fxGet', [`expq:${id6}`]);
    check('지우기 실패 → expq 에 재시도 기록 (tries 1)', q[`expq:${id6}`]?.tries === 1, JSON.stringify(q));
    await fx('fxAlarm');
    q = await fx('fxGet', [`expq:${id6}`]);
    check('재시도 시각 전 알람 → 안 지움', rms(id6) === 1 && !!q[`expq:${id6}`]);
    await fx('fxPut', { [`expq:${id6}`]: { ...q[`expq:${id6}`], next: 1 } });
    await fx('fxAlarm');
    q = await fx('fxGet', [`expq:${id6}`]);
    check('재시도 → 성공하면 기록 지움', rms(id6) === 2 && !q[`expq:${id6}`], rms(id6));
    await fx('fxAlarm');
    check('그 뒤 알람은 더 안 지움 (한 번 성공)', rms(id6) === 2);

    // 수업 끝내기 중 받기
    r = await seatApi(L4, C4, '/__lab/export', {});
    const id7 = stages().at(-1);
    check('다른 수업 자리 받기 시작', r.status === 200);
    const e = await fx('fxEnd', LABB);
    await sleep(300);
    const left = await fx('fxList', 'exp');
    check('수업 끝내기 → 받기 기록·쿨다운 지움', e.ok && !Object.keys(left).some((k) => k.includes(C4)), JSON.stringify(Object.keys(left)));
    check('수업 끝내기 → 묶은 폴더 정리 (샌드박스 지운 뒤 404 = 끝)', !(`expq:${id7}` in (await fx('fxList', 'expq:'))));
  }

  // ───────────────────────── #11 묶기 스크립트 (로컬 node) ─────────────────────────
  if (ONLY.has('zip')) {
    section = 'zip';
    const src = fs.readFileSync(path.join(SRC, 'lab.ts'), 'utf8');
    const js = src.slice(src.indexOf('export const EXPORT_JS = String.raw`') + 'export const EXPORT_JS = String.raw`'.length, src.indexOf('\n`;', src.indexOf('export const EXPORT_JS')) + 1);
    const D = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-lab-zip-'));
    const script = path.join(D, 'export.cjs');
    fs.writeFileSync(script, js);
    let work = path.join(D, 'work');
    fs.mkdirSync(path.join(work, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(work, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(work, 'hello.txt'), 'hello world\n');
    fs.writeFileSync(path.join(work, 'a', 'b', 'data.bin'), randomBytes(5000));
    fs.writeFileSync(path.join(work, 'node_modules', 'x', 'big'), 'x');
    const secret = path.join(D, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-OUTSIDE');
    fs.mkdirSync(path.join(D, 'outside'));
    fs.writeFileSync(path.join(D, 'outside', 'o.txt'), 'OUTSIDE-DIR');
    let links = 0;
    try { fs.symlinkSync(path.join(D, 'outside'), path.join(work, 'escape'), 'junction'); links++; } catch {}
    try { fs.symlinkSync(secret, path.join(work, 'leak.txt'), 'file'); links++; } catch {}
    const runZip = (out, maxB = 1e9, maxE = 1000, secs = 30) => {
      try { return { code: 0, out: execFileSync(process.execPath, [script, work, out, String(maxB), String(maxE), String(secs)], { encoding: 'utf8' }) }; }
      catch (e) { return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
    };
    const out1 = path.join(D, 'o1.zip');
    let r = runZip(out1);
    const m = r.out.match(/^OK (\d+) (\d+) (\d+) (\d+)/m);
    check('묶기 성공: OK 항목·바이트', r.code === 0 && !!m && Number(m[2]) === 12 + 5000, r.out);
    // zip 을 직접 읽어 이름·내용 확인 (central directory)
    const z = fs.readFileSync(out1);
    const names = [];
    const eo = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let p = z.readUInt32LE(eo + 16);
    const total = z.readUInt16LE(eo + 10);
    const files = {};
    for (let i = 0; i < total; i++) {
      const nl = z.readUInt16LE(p + 28), el = z.readUInt16LE(p + 30), cl = z.readUInt16LE(p + 32);
      const name = z.subarray(p + 46, p + 46 + nl).toString('utf8');
      const method = z.readUInt16LE(p + 10), csize = z.readUInt32LE(p + 20), lho = z.readUInt32LE(p + 42);
      names.push(name);
      if (!name.endsWith('/')) {
        const lnl = z.readUInt16LE(lho + 26), lel = z.readUInt16LE(lho + 28);
        const data = z.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
        files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
      }
      p += 46 + nl + el + cl;
    }
    check('zip 항목 수 = OK 의 항목 수', total === Number(m?.[1]), `${total} ${m?.[1]}`);
    check('zip 내용 그대로 (deflate + data descriptor)', files['work/hello.txt']?.toString() === 'hello world\n' && files['work/a/b/data.bin']?.length === 5000, JSON.stringify(names));
    check('node_modules 건너뜀', !names.some((n) => n.includes('node_modules')));
    check('모든 이름이 work/ 아래, .. 없음', names.every((n) => n.startsWith('work/') && !n.split('/').includes('..')));
    if (links) {
      check(`링크(junction·symlink ${links}개)는 따라가지도 넣지도 않음`, !names.some((n) => n.includes('escape') || n.includes('leak')) && !z.includes(Buffer.from('TOP-SECRET-OUTSIDE')) && !z.includes(Buffer.from('OUTSIDE-DIR')), JSON.stringify(names));
    } else { skipN++; console.log('  skip [zip] 링크 만들기 권한 없음 (junction·symlink 둘 다 실패)'); }
    r = runZip(out1);
    check('같은 출력 파일이 있으면 덮지 않음 (wx)', r.code !== 0 && fs.statSync(out1).size === z.length, r.out);
    const out2 = path.join(D, 'o2.zip');
    r = runZip(out2, 1000);
    check('실제 읽은 바이트 한도 → ERR + 종료 3, zip 지움', r.code === 3 && /^ERR 너무 큼/m.test(r.out) && !fs.existsSync(out2), r.out);
    r = runZip(out2, 1e9, 3);
    check('항목 한도 → ERR + 종료 3, zip 지움', r.code === 3 && /^ERR 항목이 너무 많음/m.test(r.out) && !fs.existsSync(out2), r.out);
    work = path.join(D, 'work-link'); // 지우지 않고 링크 하나를 새로 만든다
    fs.symlinkSync(path.join(D, 'outside'), work, 'junction');
    r = runZip(out2);
    check('작업 폴더 자체가 링크 → 거부', r.code === 3 && !fs.existsSync(out2), r.out);
    console.log('  note [zip] 리눅스 /proc/self/fd + O_NOFOLLOW 경로와 FIFO·장치 파일은 Windows node 에서 돌릴 수 없어 여기서 증명하지 못함');
    console.log(`  note [zip] 임시 폴더는 지우지 않고 남김: ${D}`);
  }

  // ───────────────────────── #16 화면 공유 SFU ─────────────────────────
  if (ONLY.has('sfu')) {
    section = 'sfu';
    await fx('fxTimes', {});
    const closes = (sid) => sfu.filter((x) => x.method === 'PUT' && x.path === `/sessions/${sid}/tracks/close`);
    const okCloses = new Map(); // 성공한 닫기 수 (모의 서버 응답 기준)
    const startScr = () => adminCall('/api/lab/screen/start', { id: LAB, sdp: 'v=0 offer', tracks: [{ mid: '0', trackName: 'screen' }] }, ADMIN);
    const pull = (lbl = L1, c = C1) => seatApi(lbl, c, '/__lab/screen/pull', {});
    const answer = (sid, lbl = L1, c = C1) => seatApi(lbl, c, '/__lab/screen/answer', { sid, sdp: 'v=0 answer' });
    const pulls = async () => Object.entries(await fx('fxList', 'scrp:'));
    const news = () => sfu.filter((x) => x.path === '/sessions/new').length;
    // 공유 전용 다른 수업 (앞 구간이 LABB 를 끝냈을 수 있음)
    const LABS = 'lab3', C5 = code(), L5 = label(), t5 = Date.now();
    await fx('fxPut', {
      [`lab:${LABS}`]: { id: LABS, name: '공유다른수업', createdAt: t5, expiresAt: t5 + 3 * 3600e3, budget: 1, cpu: 1, memory: 1, disk: 3, snapshot: 's', model: 'm/x', gw: '', seats: [{ n: 1, code: C5, sandboxId: 'sb5', label: L5 }] },
      [`seat:${C5}`]: { lab: LABS, n: 1 },
    });
    const leaks = (o, ...ids) => ['sessionId', 'mids', 'sessionDescription'].some((k) => JSON.stringify(o).includes(`"${k}"`)) || ids.some((id) => JSON.stringify(o).includes(`"${id}"`));
    {
      const n = sfu.length, tr = [{ mid: '0', trackName: 'screen' }];
      let x = await adminCall('/api/lab/screen/start', { id: LAB, sdp: 'v=0 offer', tracks: tr }, 'not-a-token');
      check('관리 토큰 없이 공유 시작 → 401', x.status === 401, x.status);
      x = await adminCall('/api/lab/screen/status', {}, 'not-a-token');
      check('관리 토큰 없이 공유 목록 → 401', x.status === 401, x.status);
      const bad = [['sdp 아님', 'hello', tr], ['sdp 숫자', 1, tr], ['트랙 0개', 'v=0 offer', []], ['트랙 3개', 'v=0 offer', [...tr, ...tr, ...tr]],
        ['mid 이상', 'v=0 offer', [{ mid: '../x', trackName: 'screen' }]], ['trackName 김', 'v=0 offer', [{ mid: '0', trackName: 'a'.repeat(65) }]], ['tracks 객체', 'v=0 offer', { mid: '0' }]];
      const st = [];
      for (const [, sdp, tracks] of bad) st.push((await adminCall('/api/lab/screen/start', { id: LAB, sdp, tracks }, ADMIN)).status);
      check('형식이 틀린 공유 시작 → 모두 400', st.every((c) => c === 400), JSON.stringify(st));
      x = await adminCall('/api/lab/screen/start', { id: 'nolab', sdp: 'v=0 offer', tracks: tr }, ADMIN);
      check('없는 수업 공유 시작 → 404', x.status === 404, x.status);
      x = await pull();
      check('공유 안 하는 중 받기 → 409', x.status === 409, x.status);
      x = await seatApi(L1, '', '/__lab/screen/pull', {}, { cookie: '' });
      const y = await seatApi(L2, C1, '/__lab/screen/pull', {});
      const z = await seatApi(L2, C1, '/__lab/screen');
      check('쿠키 없음 401 · 남의 자리 호스트 받기·상태 403', x.status === 401 && y.status === 403 && z.status === 403, `${x.status} ${y.status} ${z.status}`);
      const as = [];
      for (const [sid, sdp] of [['short', 'v=0 a'], ['a/b/../../c/d', 'v=0 a'], [12345678, 'v=0 a'], ['x'.repeat(65), 'v=0 a'], ['abcdefgh12', 'nope']]) as.push((await seatApi(L1, C1, '/__lab/screen/answer', { sid, sdp })).status);
      x = await answer('abcdefgh12345678');
      check('형식이 틀린 answer → 400 · 없는 sid → 404', as.every((c) => c === 400) && x.status === 404, `${JSON.stringify(as)} ${x.status}`);
      check('위 거절은 SFU 를 한 번도 부르지 않고 받기 기록도 없음', sfu.length === n && (await pulls()).length === 0, `${sfu.length - n}`);
    }

    let r = await startScr();
    const s0 = r.j;
    const S0 = `S${M.sess}`;
    check('강사 공유 시작', r.status === 200 && r.j.sdp === 'v=0 answer', JSON.stringify(r.j));
    r = await pull();
    const p1 = r.j;
    let rec = (await fx('fxGet', [`scrp:${p1.sid}`]))[`scrp:${p1.sid}`];
    check('받기: SFU 세션 id·remote mid·만료 저장 (offered)', r.status === 200 && rec?.state === 'offered' && /^S\d+$/.test(rec.sessionId) && rec.mids?.length === 1 && rec.exp > Date.now(), JSON.stringify(rec));
    const sP1 = rec.sessionId;
    {
      const n = sfu.length;
      const st = await seatApi(L1, C1, '/__lab/screen');
      const ls = await adminCall('/api/lab/screen/status', {}, ADMIN);
      check('공유 상태(참가자)·목록(강사)·시작·받기 응답에 SFU 세션 id·mid 없음', st.status === 200 && st.j.on === true && ls.status === 200 && ls.j.screens?.[LAB]?.on === true
        && !leaks(st.j, S0, sP1) && !leaks(ls.j, S0, sP1) && !leaks(s0, S0, sP1) && !leaks(p1, S0, sP1) && p1.sid !== sP1, JSON.stringify([st.j, ls.j, s0, p1]));
      const o = await seatApi(L5, C5, '/__lab/screen');
      const op = await seatApi(L5, C5, '/__lab/screen/pull', {});
      const oa = await answer(p1.sid, L5, C5);
      check('다른 수업 자리: 공유 꺼짐으로 보임 · 받기 409 · 남의 sid answer 403, SFU 안 부름', o.j?.on === false && !leaks(o.j, S0) && op.status === 409 && oa.status === 403 && sfu.length === n,
        `${JSON.stringify(o.j)} ${op.status} ${oa.status} ${sfu.length - n}`);
    }
    r = await pull();
    const p2 = r.j;
    const n0 = news();
    r = await pull();
    check('기다리는 받기 2개 넘음 → 429, SFU 안 부름 (먼저 자리 잡기)', r.status === 429 && news() === n0, `${r.status} ${news()} ${n0}`);
    r = await answer(p1.sid, L2, C2);
    check('다른 자리가 남의 sid 로 answer → 403', r.status === 403, r.status);
    r = await answer(p1.sid);
    check('answer → live', r.status === 200 && (await fx('fxGet', [`scrp:${p1.sid}`]))[`scrp:${p1.sid}`]?.state === 'live', r.status);
    r = await answer(p1.sid);
    check('같은 sid 두 번째 answer → 409', r.status === 409, r.status);
    r = await answer(p2.sid);
    r = await pull(); await answer(r.j.sid);
    r = await pull(); await answer(r.j.sid);
    check('자리당 4개까지', (await pulls()).filter(([, p]) => p.code === C1).length === 4);
    r = await pull();
    await sleep(300);
    const after = (await pulls()).filter(([, p]) => p.code === C1);
    check('5번째 → 가장 오래된 연결 밀어냄 (4개 유지)', r.status === 200 && after.length === 4 && !after.some(([k]) => k === `scrp:${p1.sid}`), after.length);
    check('밀려난 받기의 remote mid 를 닫음 (한 번)', closes(sP1).length === 1 && JSON.stringify(closes(sP1)[0].body) === JSON.stringify({ tracks: [{ mid: `r${sP1}-0` }], force: true }), JSON.stringify(closes(sP1)));
    const p5 = r.j;

    // answer 시간 초과 (요청 쪽 · 알람 쪽)
    await fx('fxTimes', { answer: 50 });
    rec = (await fx('fxGet', [`scrp:${p5.sid}`]))[`scrp:${p5.sid}`];
    await fx('fxPut', { [`scrp:${p5.sid}`]: { ...rec, exp: Date.now() - 1 } });
    r = await answer(p5.sid);
    await sleep(300);
    check('만료 뒤 answer → 410 + 트랙 닫음', r.status === 410 && closes(rec.sessionId).length === 1 && !(await fx('fxGet', [`scrp:${p5.sid}`]))[`scrp:${p5.sid}`], `${r.status} ${closes(rec.sessionId).length}`);
    // 하나를 비우고 알람 만료
    const live = (await pulls()).filter(([, p]) => p.code === C1);
    r = await pull();
    const p6 = r.j;
    const s6 = (await fx('fxGet', [`scrp:${p6.sid}`]))[`scrp:${p6.sid}`]?.sessionId;
    await sleep(120);
    await fx('fxAlarm');
    await sleep(300);
    check('answer 가 안 오면 알람이 닫음 (한 번)', !(await fx('fxGet', [`scrp:${p6.sid}`]))[`scrp:${p6.sid}`] && closes(s6).length === 1, closes(s6).length);
    await fx('fxAlarm');
    check('알람을 또 돌려도 다시 닫지 않음', closes(s6).length === 1);
    void live;
    await fx('fxTimes', {});

    // 받기 실패: tracks/new 가 500 → mid 를 모름 → 세션 조회 후 닫기
    M.sfuFail.remote = 1;
    r = await seatApi(L2, C2, '/__lab/screen/pull', {});
    await sleep(400);
    const sF = `S${M.sess}`;
    const got = sfu.filter((x) => x.method === 'GET' && x.path === `/sessions/${sF}`);
    check('tracks/new 실패 → 기록 없음 + 세션 조회로 mid 찾아 닫음', r.status === 502 && got.length === 1 && closes(sF).length === 1 && closes(sF)[0].body.tracks[0].mid === `found-${sF}`, `${r.status} ${got.length} ${JSON.stringify(closes(sF))}`);
    check('실패한 받기는 기록이 안 남음', !(await pulls()).some(([, p]) => p.sessionId === sF));
    // renegotiate 실패 → 닫기
    r = await seatApi(L2, C2, '/__lab/screen/pull', {});
    const sR = (await fx('fxGet', [`scrp:${r.j.sid}`]))[`scrp:${r.j.sid}`].sessionId;
    M.sfuFail.renegotiate = 1;
    r = await answer(r.j.sid, L2, C2);
    await sleep(300);
    check('answer(renegotiate) 실패 → 그 받기 닫음', r.status === 502 && closes(sR).length === 1, `${r.status} ${closes(sR).length}`);
    // 닫기 실패 → 재시도 (알람)
    r = await seatApi(L2, C2, '/__lab/screen/pull', {});
    const sC = (await fx('fxGet', [`scrp:${r.j.sid}`]))[`scrp:${r.j.sid}`].sessionId;
    M.sfuFail.close = 1;
    await fx('fxPut', { [`scrp:${r.j.sid}`]: { ...(await fx('fxGet', [`scrp:${r.j.sid}`]))[`scrp:${r.j.sid}`], exp: 1 } });
    await fx('fxAlarm');
    await sleep(300);
    let q = Object.entries(await fx('fxList', 'scrq:')).find(([, v]) => v.sessionId === sC);
    check('닫기 실패 → scrq 에 재시도 (mid 그대로)', !!q && q[1].tries === 1 && q[1].mids?.[0] === `r${sC}-0`, JSON.stringify(q));
    await fx('fxPut', { [q[0]]: { ...q[1], next: 1 } });
    await fx('fxAlarm');
    await sleep(300);
    q = Object.entries(await fx('fxList', 'scrq:')).find(([, v]) => v.sessionId === sC);
    check('재시도 성공 → 기록 지움 (실패 1 + 성공 1)', !q && closes(sC).length === 2, closes(sC).length);
    await fx('fxAlarm');
    check('그 뒤 더 안 닫음', closes(sC).length === 2);

    // SFU 호출 중 멈춤: 붙잡힌 tracks/new 가 끝나면 그 요청이 닫는다
    let release;
    M.sfuHold = { match: '/tracks/new', arrived: 0, released: new Promise((ok) => { release = ok; }) };
    const pending = seatApi(L2, C2, '/__lab/screen/pull', {});
    for (let i = 0; i < 100 && M.sfuHold.arrived === 0; i++) await sleep(50);
    const sH = `S${M.sess}`;
    const busy = (await pulls()).find(([, p]) => p.sessionId === sH);
    check('호출 중 기록: busy + 세션 id 먼저 저장', !!busy && busy[1].busy > 0 && busy[1].state === 'reserving', JSON.stringify(busy));
    r = await adminCall('/api/lab/screen/stop', { id: LAB }, ADMIN);
    check('멈춤 응답', r.status === 200, r.status);
    check('호출 중이라 closing 표시만 (아직 안 닫음)', closes(sH).length === 0 && (await pulls()).find(([, p]) => p.sessionId === sH)?.[1].closing === true);
    M.sfuHold = null; release();
    r = await pending;
    await sleep(400);
    check('호출이 끝나면 그 요청이 닫음 (한 번, 받은 mid 로)', r.status === 409 && closes(sH).length === 1 && closes(sH)[0].body.tracks[0].mid === `r${sH}-0`, `${r.status} ${JSON.stringify(closes(sH))}`);
    check('멈춤 → 강사 세션 닫음 (한 번)', closes(S0).length === 1, closes(S0).length);
    check('멈춤 → 모든 받기 기록 없음', (await pulls()).length === 0);

    // 시작 실패: local tracks/new 실패 → 새 세션 닫음
    M.sfuFail.local = 1;
    r = await startScr();
    const sL = `S${M.sess}`;
    await sleep(300);
    check('공유 시작 실패 → 만든 세션의 local mid 닫음', r.status === 502 && closes(sL).length === 1 && closes(sL)[0].body.tracks[0].mid === '0', `${r.status} ${JSON.stringify(closes(sL))}`);
    // 다시 시작 → 이전 공유 닫힘
    r = await startScr();
    const SA = `S${M.sess}`;
    r = await pull();
    const sPA = (await fx('fxGet', [`scrp:${r.j.sid}`]))[`scrp:${r.j.sid}`].sessionId;
    r = await startScr();
    await sleep(300);
    check('새로 시작 → 이전 강사 세션·받기 닫음', closes(SA).length === 1 && closes(sPA).length === 1 && (await pulls()).length === 0, `${closes(SA).length} ${closes(sPA).length}`);
    const SB = `S${M.sess}`;
    // 끝내기
    r = await pull();
    const sPB = (await fx('fxGet', [`scrp:${r.j.sid}`]))[`scrp:${r.j.sid}`].sessionId;
    await answer(r.j.sid);
    await fx('fxEnd', LAB);
    await sleep(400);
    check('수업 끝내기 → 강사 세션·받기 닫음, 기록 없음', closes(SB).length === 1 && closes(sPB).length === 1 && (await pulls()).length === 0 && Object.keys(await fx('fxList', 'scr:')).length === 0, `${closes(SB).length} ${closes(sPB).length}`);
    // 기록된 할당은 모두 한 번씩만 (성공 기준)
    const sessions = [...new Set(sfu.filter((x) => x.path === '/sessions/new').map((_, i) => `S${i + 1}`))];
    const twice = sessions.filter((s) => closes(s).length > (s === sC ? 2 : 1));
    check('어떤 세션도 두 번 성공해 닫지 않음', twice.length === 0, JSON.stringify(twice));
    check('닫기 대기열 비어 있음', Object.keys(await fx('fxList', 'scrq:')).length === 0);
    {
      let n = sfu.length;
      const st = [(await startScr()).status, (await pull()).status, (await answer('abcdefgh12345678')).status];
      check('끝낸 수업(기록 지워짐): 시작·받기·answer 거절 (404·410), SFU 안 부름', st.every((c) => c === 404 || c === 410) && sfu.length === n, `${JSON.stringify(st)} ${sfu.length - n}`);
      let x = await adminCall('/api/lab/screen/start', { id: LABS, sdp: 'v=0 offer', tracks: [{ mid: '0', trackName: 'screen' }] }, ADMIN);
      const SX = `S${M.sess}`;
      let release;
      M.sfuHold = { match: '/tracks/new', arrived: 0, released: new Promise((ok) => { release = ok; }) };
      const pending = seatApi(L5, C5, '/__lab/screen/pull', {});
      for (let i = 0; i < 100 && M.sfuHold.arrived === 0; i++) await sleep(50);
      const sD = `S${M.sess}`;
      const d = (await pulls()).find(([, p]) => p.sessionId === sD);
      await fx('fxPut', { [d[0]]: { ...d[1], busy: Date.now() - 46e3 } }); // 호출이 죽은 지 오래됨
      await fx('fxAlarm');
      await sleep(300);
      check('죽은 SFU 호출 → 알람이 기록 지우고 세션 조회로 닫음 (한 번)', x.status === 200 && !(await pulls()).length && closes(sD).length === 1, closes(sD).length);
      M.sfuHold = null; release();
      x = await pending;
      await sleep(300);
      await fx('fxAlarm');
      check('늦게 끝난 호출은 409, 다시 닫지 않음', x.status === 409 && closes(sD).length === 1, `${x.status} ${closes(sD).length}`);
      // 닫기가 계속 실패해도 정해진 횟수 뒤 그만둔다
      M.sfuFail.close = 99;
      x = await adminCall('/api/lab/screen/stop', { id: LABS }, ADMIN);
      await sleep(300);
      const tries = [closes(SX).length];
      for (let i = 0; i < 4; i++) {
        for (const [k, q] of Object.entries(await fx('fxList', 'scrq:'))) await fx('fxPut', { [k]: { ...q, next: 1 } });
        await fx('fxAlarm'); await sleep(200);
        tries.push(closes(SX).length);
      }
      M.sfuFail.close = 0;
      check('닫기 계속 실패 → 몇 번(3) 뒤 대기열에서 지우고 더 안 부름', x.status === 200 && closes(SX).length === 3 && tries[4] === tries[2] && Object.keys(await fx('fxList', 'scrq:')).length === 0, JSON.stringify(tries));
    }
    void okCloses;
  }

  // ───────────────────────── 수업 끝내기·만료 정리 (endLab · 알람) ─────────────────────────
  // 앞 구간과 겹치지 않는 합성 수업 둘(lcA·lcB)과 샌드박스. 가짜 Daytona 의 DELETE·라벨 목록 실패로 재시도 경로를 본다
  if (ONLY.has('lifecycle')) {
    section = 'lifecycle';
    const A = 'lcA', B = 'lcB', t = Date.now();
    const CA = [code(), code(), code()], CB = code(), LA = [label(), label(), label()], LB = label();
    const base = { createdAt: t, expiresAt: t + 3 * 3600e3, budget: 1, cpu: 1, memory: 1, disk: 3, snapshot: 's', model: 'm/x', gw: '' };
    // A: 1번 DELETE 500 한 번 · 2번 정상 · 3번 이미 없음(404). 라벨 목록에 응답 못 받은 샌드박스 하나와 이미 destroyed 하나
    for (const id of ['lcA-sb1', 'lcA-sb2', 'lcA-orph', 'lcB-sb1', 'lcB-orph']) M.sandboxes.add(id);
    M.labelled = { [A]: [{ id: 'lcA-orph', state: 'started' }, { id: 'lcA-gone', state: 'destroyed' }], [B]: [{ id: 'lcB-orph', state: 'started' }] };
    M.delFail = { 'lcA-sb1': 1 };
    const side = (id, c) => ({ [`snips:${id}`]: [], [`snipv:${id}`]: 1, [`scr:${id}`]: { tracks: [], v: 1 }, [`cls:${id.toUpperCase()}CLS`]: id, [`pres:${c}`]: { t }, [`expcd:${c}`]: t });
    await fx('fxPut', {
      [`lab:${A}`]: { ...base, id: A, name: '수명A', cls: 'LCACLS', seats: CA.map((c, i) => ({ n: i + 1, code: c, sandboxId: `lcA-sb${i + 1}`, label: LA[i] })) },
      [`lab:${B}`]: { ...base, id: B, name: '수명B', cls: 'LCBCLS', seats: [{ n: 1, code: CB, sandboxId: 'lcB-sb1', label: LB }] },
      ...Object.fromEntries(CA.map((c, i) => [`seat:${c}`, { lab: A, n: i + 1 }])), [`seat:${CB}`]: { lab: B, n: 1 },
      ...side(A, CA[0]), ...side(B, CB),
    });
    const dels = (id) => hits.filter((h) => h.method === 'DELETE' && h.path === `/daytona/sandbox/${id}`).length;
    const lists = (id) => hits.filter((h) => h.method === 'GET' && h.path.startsWith('/daytona/sandbox?') && decodeURIComponent(h.path).includes(`"gw-lab":"${id}"`)).length;
    const keysOf = (id, c) => [`lab:${id}`, `seat:${c}`, `snips:${id}`, `snipv:${id}`, `scr:${id}`, `cls:${id.toUpperCase()}CLS`, `pres:${c}`, `expcd:${c}`];
    const auditOf = async (name) => ((await fx('fxGet', ['audit'])).audit ?? []).filter((x) => x.detail === name).map((x) => x.event);
    const bAll = async () => Object.keys(await fx('fxGet', keysOf(B, CB))).length === keysOf(B, CB).length;

    let r = await raw(ENTRY_HOST, 'GET', `/j/${CA[1]}`);
    check('끝내기 전: 초대 화면 200', r.status === 200, r.status);

    // 1차 끝내기: 1번 DELETE 실패 → false, 수업 기록은 endRetry 로 남고 나머지 정리는 다 함
    const t1 = Date.now();
    let e = await fx('fxEnd', A);
    let lab = await labRec(A);
    check('샌드박스 지우기 실패 → 끝내기 false, 수업 기록에 endRetry(약 5분 뒤)',
      e.ok === false && !!lab && lab.endRetry >= t1 + 5 * 60e3 - 1000 && lab.endRetry <= Date.now() + 5 * 60e3 + 1000, JSON.stringify({ e, endRetry: lab?.endRetry && lab.endRetry - t1 }));
    check('  실패한 1번만 sandboxId 남김 (2번 지움·3번 404 는 지운 것으로)', lab?.seats.map((s) => s.sandboxId ?? null).join() === 'lcA-sb1,,' && dels('lcA-sb1') === 1 && dels('lcA-sb2') === 1 && dels('lcA-sb3') === 1,
      `${JSON.stringify(lab?.seats.map((s) => s.sandboxId))} ${dels('lcA-sb1')} ${dels('lcA-sb2')} ${dels('lcA-sb3')}`);
    check('  실패면 라벨 목록 정리는 미룸 (조회 없음)', lists(A) === 0 && dels('lcA-orph') === 0, lists(A));
    let st = await fx('fxGet', keysOf(A, CA[0]).concat(CA.map((c) => `seat:${c}`)));
    check('  실패해도 자리 코드·접속·공유·수업 코드·받은 코드·받기 쿨다운 기록 지움 (수업 기록만 남음)', JSON.stringify(Object.keys(st)) === JSON.stringify([`lab:${A}`]), JSON.stringify(Object.keys(st)));
    check('  다른 수업(lcB) 샌드박스·기록은 그대로', dels('lcB-sb1') === 0 && dels('lcB-orph') === 0 && lists(B) === 0 && (await bAll()), `${dels('lcB-sb1')} ${dels('lcB-orph')}`);
    check('  감사: lab-end-retry', (await auditOf('수명A'))[0] === 'lab-end-retry', JSON.stringify(await auditOf('수명A')));

    // 정리 중(endRetry) 수업: 참가자 접근 거부 — 자리 코드 기록을 다시 넣어도 endRetry 가 막는다
    const h0 = hits.length;
    const deny = [];
    deny.push((await raw(ENTRY_HOST, 'GET', `/j/${CA[0]}`)).status);
    deny.push((await raw(seatHost(LA[0]), 'GET', '/__lab/me', { headers: { cookie: `__Host-lab_seat=${CA[0]}`, ...SEAT_SAME } })).status);
    await fx('fxPut', { [`seat:${CA[0]}`]: { lab: A, n: 1 } });
    const gate = [(await raw(ENTRY_HOST, 'GET', `/j/${CA[0]}`)).status, (await raw(seatHost(LA[0]), 'GET', '/__lab/me', { headers: { cookie: `__Host-lab_seat=${CA[0]}`, ...SEAT_SAME } })).status,
      (await raw(ENTRY_HOST, 'POST', '/__lab/wake', { headers: { origin: ENTRY, 'content-type': 'application/json' }, body: JSON.stringify({ code: CA[0] }) })).status];
    check('정리 중 수업: 자리 기록 없음 → 404 · 자리 기록을 되살려도 endRetry 로 410 (초대·막대·깨우기), Daytona·code-server 안 감',
      deny.every((s) => s === 404) && gate.every((s) => s === 410) && hits.length === h0, `${deny} ${gate} ${hits.slice(h0).map((h) => h.path)}`);

    // 재시도 시각 전 알람 → 안 건드림
    await fx('fxAlarm');
    const lab2 = await labRec(A);
    check('재시도 시각 전 알람 → 다시 안 지움, endRetry 그대로', dels('lcA-sb1') === 1 && lists(A) === 0 && lab2?.endRetry === lab.endRetry, `${dels('lcA-sb1')} ${lab2?.endRetry - lab.endRetry}`);

    // 2차 (알람, 시각 지남): 1번 지우기는 성공, 라벨 목록 조회 실패 → 아직 false (endRetry 새로)
    M.listFail = 1;
    await fx('fxPut', { [`lab:${A}`]: { ...lab2, endRetry: 1 } });
    const t2 = Date.now();
    await fx('fxAlarm');
    lab = await labRec(A);
    check('재시도(알람): 1번 지움, 라벨 목록 실패 → 수업 기록·endRetry(새 5분) 유지, 2·3번은 다시 안 지움',
      dels('lcA-sb1') === 2 && lists(A) === 1 && !!lab && lab.endRetry >= t2 + 5 * 60e3 - 1000 && lab.seats.every((s) => !s.sandboxId) && dels('lcA-sb2') === 1 && dels('lcA-sb3') === 1 && dels('lcA-orph') === 0,
      `${dels('lcA-sb1')} ${lists(A)} ${lab?.endRetry && lab.endRetry - t2} ${dels('lcA-sb2')} ${dels('lcA-sb3')}`);
    check('  감사: 수업 끝내기 재시도 두 번째 lab-end-retry', JSON.stringify((await auditOf('수명A')).slice(0, 2)) === '["lab-end-retry","lab-end-retry"]', JSON.stringify(await auditOf('수명A')));

    // 3차: 라벨로 찾은 응답 못 받은 샌드박스만 한 번 지우고 끝 (destroyed 는 건너뜀, 다른 수업 라벨은 안 봄)
    await fx('fxPut', { [`lab:${A}`]: { ...lab, endRetry: 1 } });
    await fx('fxAlarm');
    st = await fx('fxGet', keysOf(A, CA[0]).concat(CA.map((c) => `seat:${c}`)));
    check('재시도 성공: 라벨 샌드박스 한 번 지움 (destroyed 건너뜀), 수업 기록·되살린 자리 기록 지움, 감사 lab-expire',
      dels('lcA-orph') === 1 && dels('lcA-gone') === 0 && dels('lcA-sb1') === 2 && Object.keys(st).length === 0 && (await auditOf('수명A'))[0] === 'lab-expire',
      `${dels('lcA-orph')} ${dels('lcA-gone')} ${dels('lcA-sb1')} ${JSON.stringify(Object.keys(st))} ${JSON.stringify(await auditOf('수명A'))}`);
    const n3 = hits.filter((h) => h.method === 'DELETE' || h.path.startsWith('/daytona/sandbox?')).length;
    await fx('fxAlarm');
    check('끝난 뒤 알람·다시 끝내기 → 아무것도 안 지움 (한 번만)', hits.filter((h) => h.method === 'DELETE' || h.path.startsWith('/daytona/sandbox?')).length === n3 && (await fx('fxEnd', A)).ok === false, n3);
    check('  내내 다른 수업(lcB)은 그대로', dels('lcB-sb1') === 0 && dels('lcB-orph') === 0 && lists(B) === 0 && (await bAll()) && !(await labRec(B)).endRetry);

    // lcB 정상 끝내기: 자기 샌드박스·라벨 샌드박스 한 번씩, A 쪽은 다시 안 건드림
    e = await fx('fxEnd', B);
    check('다른 수업 정상 끝내기 → true, 자기 것만 한 번씩 지움, 기록 없음',
      e.ok === true && dels('lcB-sb1') === 1 && dels('lcB-orph') === 1 && lists(B) === 1 && dels('lcA-orph') === 1 && dels('lcA-sb1') === 2 && Object.keys(await fx('fxGet', keysOf(B, CB))).length === 0 && (await auditOf('수명B'))[0] === 'lab-end',
      `${e.ok} ${dels('lcB-sb1')} ${dels('lcB-orph')} ${lists(B)}`);
    M.labelled = {};
    M.delFail = {};
  }

  section = 'all';
  const ob = [...outboundAll, ...(await fx('fxOutbound'))];
  check('바깥(loopback 아님) 호출 0', ob.length === 0, JSON.stringify(ob.slice(0, 5)));
} catch (e) {
  failN++;
  console.log(`  FAIL [${section}] 예외: ${e?.stack ?? e}`);
}

await stop();
mock.close();
console.log(`임시 wrangler 설정·저장소는 지우지 않고 남김: ${TMP}`);
console.log(`\n${pass} passed, ${failN} failed, ${skipN} skipped (wrangler 앞단 끊김 재전송 ${retried}회)\n`);
process.exit(BASELINE ? 0 : failN ? 1 : 0);
