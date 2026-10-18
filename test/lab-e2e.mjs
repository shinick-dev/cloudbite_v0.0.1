// 공부방 실습실 흐름. Daytona 는 가짜 서버(:8799, wrangler.jsonc env.dev 의 LAB_DAYTONA_API), code-server 도 가짜(:8800),
// OpenRouter 서브키는 진짜로 만들었다 지운다.
//   .\run-dev.ps1 -Fresh 로 빈 상태에서 띄운 뒤: SETUP_TOKEN=... OPENROUTER_MANAGEMENT_KEY=... node test/lab-e2e.mjs
// 확인하는 것: 입력 검증, 자리마다 가짜 토큰(진짜 키는 샌드박스에 안 감), 일부 실패 처리, 수업 링크 하나로 자리 자동 배정,
// 깨우기 → 수업 자료 → code-server 켜기, 실습실 호스트가 미리보기 토큰을 붙여 대신 열기(WebSocket 포함, 경고 화면 없음),
// 끝내기·만료 알람이 샌드박스·토큰을 전부 지움.

import { createServer, request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { adminSetup, call, check, finish, GW, SoftKey } from './lib.mjs';

const ALT = GW.replace('localhost', '127.0.0.1'); // dev 의 LAB_ORIGIN 이자 workers.dev 역할 (ORIGIN 과 다른 호스트)
const DT_KEY = 'dt-test-key';
const CS = 'http://127.0.0.1:8800'; // 가짜 code-server (Daytona 미리보기 주소 역할)
const ORG = 'org-test';

// ── 가짜 Realtime SFU (dev 의 REALTIME_API = :8799/rtc). 호출을 적어 둔다 — lab-e2e 는 진짜 SFU 를 부르지 않는다 ──
const sfu = { calls: [], sessions: [], local: new Set(), tracks: new Map(), n: 0 };
const cfgApp = 'c29dbceb14ae7159c05ee756c190ddc2';
function fakeSfu(req, u, raw, send) {
  const body = raw.length ? JSON.parse(raw) : {};
  sfu.calls.push({ method: req.method, path: u.pathname, raw: raw.toString(), body, auth: req.headers.authorization });
  const m = u.pathname.match(/^\/rtc\/apps\/(\w+)\/sessions\/([\w-]+)(?:\/(.*))?$/);
  if (!m || m[1] !== cfgApp) return send(404, { errorCode: 'not_found' });
  if (m[2] === 'new' && req.method === 'POST') {
    if (raw.length) return send(400, { errorCode: 'bad_request' }); // 진짜 SFU 도 본문 '{}' 는 400
    const id = `sfu-sess-${++sfu.n}-${randomUUID().slice(0, 8)}`;
    sfu.sessions.push(id);
    return send(201, { sessionId: id });
  }
  const sid = m[2], t = body.tracks ?? [];
  if (m[3] === 'tracks/new' && body.sessionDescription) {
    for (const x of t) sfu.tracks.set(`${sid}/${x.trackName}`, x.mid);
    sfu.local.add(sid);
    return send(200, { sessionDescription: { type: 'answer', sdp: 'v=0\r\nfake-answer' }, tracks: t.map((x) => ({ mid: x.mid, trackName: x.trackName })) });
  }
  if (m[3] === 'tracks/new') {
    return send(200, { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'v=0\r\nfake-offer' },
      tracks: t.map((x, i) => (sfu.tracks.has(`${x.sessionId}/${x.trackName}`) ? { mid: String(i), trackName: x.trackName, sessionId: x.sessionId } : { trackName: x.trackName, errorCode: 'not_found', errorDescription: 'track not found' })) });
  }
  if (m[3] === 'renegotiate' || m[3] === 'tracks/close') return send(200, {});
  send(404, { errorCode: 'not_found' });
}

// ── 가짜 Daytona ──
const sbs = new Map();
const seen = { creates: [], auth: new Set(), spawns: [], execs: [], uploads: [], deletes: [], cs: [], up: [] };
let failCreateAt = 0, createN = 0;
const dtSrv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  // 가짜 공유 공급자 upstream: 받은 인증 헤더를 적어 둔다 (진짜 키로 바뀌어 나갔는지)
  if (u.pathname.startsWith('/fakeup/')) { seen.up.push({ path: u.pathname, headers: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  if (u.pathname.startsWith('/rtc/')) return fakeSfu(req, u, raw, send);
  if (u.pathname === '/m.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(Buffer.from('PK\x03\x04fakezip')); }
  const body = raw.length && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : {};
  seen.auth.add(req.headers.authorization);
  const p = u.pathname.split('/').filter(Boolean);
  if (req.method === 'POST' && u.pathname === '/sandbox') {
    seen.creates.push({ body, raw: raw.toString() });
    if (++createN === failCreateAt) return send(400, { statusCode: 400, message: 'Total CPU limit exceeded' });
    const sb = { id: randomUUID(), state: 'creating', labels: body.labels, organizationId: ORG, toolboxProxyUrl: 'http://localhost:8799/toolbox', cs: false };
    sbs.set(sb.id, sb);
    return send(200, sb);
  }
  if (req.method === 'GET' && u.pathname === '/sandbox') {
    const want = JSON.parse(u.searchParams.get('labels') ?? '{}');
    return send(200, { items: [...sbs.values()].filter((s) => Object.entries(want).every(([k, v]) => s.labels?.[k] === v)), nextCursor: null });
  }
  if (req.method === 'GET' && u.pathname === `/organizations/${ORG}/usage`) {
    return send(200, { regionUsage: [{ regionId: 'us', sandboxClass: 'container', totalCpuQuota: 10, totalMemoryQuota: 10, totalDiskQuota: 30, currentCpuUsage: sbs.size, currentMemoryUsage: 2 * sbs.size, currentDiskUsage: 5 * sbs.size }] });
  }
  if (p[0] === 'sandbox' && p[1]) {
    const sb = sbs.get(p[1]);
    if (!sb) return send(404, { message: 'Sandbox not found' });
    if (req.method === 'DELETE') { sbs.delete(sb.id); seen.deletes.push(sb.id); return send(200, sb); }
    if (req.method === 'POST' && p[2] === 'start') { sb.state = 'starting'; sb.cs = false; return send(200, sb); }
    if (req.method === 'GET' && p[2] === 'ports' && p[4] === 'preview-url') return send(200, { sandboxId: sb.id, url: CS, token: `pv-${sb.id}` });
    if (req.method === 'GET' && !p[2]) {
      const out = { ...sb };
      if (sb.state === 'creating' || sb.state === 'starting') sb.state = 'started'; // 한 번 조회하면 켜진다
      return send(200, out);
    }
  }
  if (p[0] === 'toolbox') {
    const sb = sbs.get(p[1]);
    if (!sb) return send(404, { message: 'no sandbox' });
    if (p[2] === 'process' && p[3] === 'execute') {
      seen.execs.push({ sb: sb.id, command: body.command });
      if (body.command.includes('healthz')) return send(200, { exitCode: 0, result: sb.cs ? '200' : '000' });
      if (body.command.includes('echo ok')) return send(200, { exitCode: 0, result: 'ok\n' });
      if (body.command.includes('zip -qr')) { sb.zipped = true; return send(200, { exitCode: 0, result: '14\n' }); }
      return send(200, { exitCode: 0, result: '' });
    }
    if (p[2] === 'files' && p[3] === 'download') {
      if (!sb.zipped || u.searchParams.get('path') !== '/tmp/work.zip') return send(404, { message: 'no file' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="work.zip"' });
      return res.end(Buffer.from('PK\x03\x04zipdata!!'));
    }
    if (p[2] === 'files' && p[3] === 'upload') { seen.uploads.push({ sb: sb.id, path: u.searchParams.get('path'), size: raw.length, multipart: (req.headers['content-type'] ?? '').startsWith('multipart/form-data') }); return send(200, {}); }
    if (p[2] === 'process' && p[3] === 'session' && !p[4]) { if (sb.session) return send(409, { message: 'exists' }); sb.session = body.sessionId; return send(200, {}); }
    if (p[2] === 'process' && p[3] === 'session' && p[5] === 'exec') { seen.spawns.push(body); if (body.command === 'lab-start') sb.cs = true; return send(202, { cmdId: 'c1' }); }
  }
  send(404, { message: `mock: ${req.method} ${u.pathname}` });
});
await new Promise((r) => dtSrv.listen(8799, r));

// ── 가짜 code-server: 미리보기 토큰으로 어느 샌드박스인지 가린다 ──
const csSrv = createServer((req, res) => {
  const tok = req.headers['x-daytona-preview-token'] ?? '';
  seen.cs.push({ url: req.url, headers: req.headers });
  if (!tok.startsWith('pv-')) { res.writeHead(401); return res.end('no token'); }
  const id = tok.slice(3);
  if (req.url === '/') { res.writeHead(302, { location: `${CS}/?folder=/home/daytona/work` }); return res.end(); }
  if (req.url === '/boom') { res.writeHead(503); return res.end('down'); }
  if (req.url === '/wb') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<html><head><script nonce="n0nce">1</script><link rel="manifest" href="./manifest.json" crossorigin="use-credentials"></head><body>seat:${id}</body></html>`); }
  res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'cs=1; Domain=127.0.0.1; Path=/' });
  res.end(`seat:${id}`);
});
csSrv.on('upgrade', (req, socket) => {
  seen.cs.push({ url: req.url, headers: req.headers, ws: true });
  if (req.headers.origin !== CS) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const msg = Buffer.from(`hi-${String(req.headers['x-daytona-preview-token']).slice(3, 11)}`);
  socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
});
await new Promise((r) => csSrv.listen(8800, '127.0.0.1', r));

const key = new SoftKey();
const ADM = await adminSetup(key, process.env.SETUP_TOKEN);
const LAB = { origin: ALT }; // 실습실 호스트 페이지가 보내는 Origin
const lab_ = (path, body, cookie) => call(path, body, { ...LAB, ...(cookie ? { cookie } : {}) }, ALT);

console.log('\n# 준비: 공급자');
const mg = process.env.OPENROUTER_MANAGEMENT_KEY;
check('OPENROUTER_MANAGEMENT_KEY 있음 (User 환경변수)', !!mg);
check('openrouter 올림', (await call('/api/admin/provider', { preset: 'openrouter', value: mg }, ADM)).status === 200);
check('daytona 올림 (가짜 키)', (await call('/api/admin/provider', { preset: 'daytona', value: DT_KEY }, ADM)).status === 200);
const cfg = (await call('/api/lab/config', {}, ADM)).j;
check('설정: 두 공급자, 기본 스냅샷 v4·모델, 실습실 호스트', cfg.daytona && cfg.openrouter && cfg.cfg.snapshot === 'gw-lab-v4' && !!cfg.cfg.model && cfg.labOrigin === ALT, JSON.stringify(cfg));

console.log('\n# 입력 검증');
const base = { name: '테스트반', seats: 3, hours: 1, budget: 1, cpu: 1, memory: 2, disk: 5, gw: ALT, materials: 'https://github.com/octo/demo', clipIn: true, clipOut: false };
check('관리 토큰 없으면 401', (await call('/api/lab/create', base, { 'x-admin-token': 'nope' })).status === 401);
check('인원 0 거부', (await call('/api/lab/create', { ...base, seats: 0 }, ADM)).status === 400);
check('없는 사양 거부', (await call('/api/lab/create', { ...base, cpu: 3 }, ADM)).status === 400);
check('스냅샷 없는 조합 거부 (2 vCPU · 8 GiB)', (await call('/api/lab/create', { ...base, cpu: 2, memory: 8, disk: 10 }, ADM)).status === 400);
check('없는 한도 거부', (await call('/api/lab/create', { ...base, budget: 50 }, ADM)).status === 400);
check('게이트웨이 주소 형식 거부', (await call('/api/lab/create', { ...base, gw: 'ftp://x' }, ADM)).status === 400);
check('자료 주소 형식 거부 (따옴표·공백)', (await call('/api/lab/create', { ...base, materials: "https://github.com/a/b' ; rm -rf ~" }, ADM)).status === 400);
const noModel = await call('/api/lab/create', { ...base, model: 'nope/not-a-model-xyz' }, ADM);
check('OpenRouter 에 없는 모델 거부 (학기 중 이름 바뀜 대비)', noModel.status === 400 && noModel.j.error.includes('nope/not-a-model-xyz'), JSON.stringify(noModel.j));
check('검증 실패 때는 Daytona 호출 없음', seen.creates.length === 0);

console.log('\n# 3자리 만들기 (3번째는 Daytona 가 한도 초과로 거부)');
failCreateAt = 3;
const made = await call('/api/lab/create', base, ADM);
check('만들기 200', made.status === 200 && made.j.ok, JSON.stringify(made.j));
const lab = made.j.lab;
const okSeats = lab.seats.filter((s) => !s.error), badSeats = lab.seats.filter((s) => s.error);
check('2자리 성공 · 1자리 실패(메시지 전달)', okSeats.length === 2 && badSeats.length === 1 && badSeats[0].error.includes('CPU limit'), JSON.stringify(lab.seats));
check('수업 코드 6자', /^[A-Z2-9]{6}$/.test(lab.cls ?? ''), lab.cls);
check('Daytona 에 저장된 키로 인증', seen.auth.has(`Bearer ${DT_KEY}`));
const c0 = seen.creates[0].body;
check('샌드박스 요청: 사양별 스냅샷(사양 필드 없음)·라벨·꺼지면 삭제',
  c0.snapshot === 'gw-lab-v4-1c2g' && !('cpu' in c0) && !('memory' in c0) && c0.labels['gw-lab'] === lab.id && c0.autoDeleteInterval === 0 && c0.autoStopInterval === 60, JSON.stringify(c0));
check('샌드박스 env: 가짜 토큰 + workers.dev 게이트웨이 주소',
  c0.env.OPENROUTER_API_KEY.startsWith('kvt_') && c0.env.ANTHROPIC_AUTH_TOKEN === c0.env.OPENROUTER_API_KEY
  && c0.env.OPENROUTER_BASE_URL === `${ALT}/p/openrouter/api/v1` && c0.env.ANTHROPIC_BASE_URL === `${ALT}/p/openrouter/api` && c0.env.ANTHROPIC_API_KEY === '');
check('샌드박스 env: lab-status 용 끝나는 시각·한도, 한국 시간', Math.abs(Number(c0.env.LAB_ENDS) * 1000 - lab.expiresAt) < 1000 && c0.env.LAB_BUDGET === '1' && c0.env.TZ === 'Asia/Seoul', JSON.stringify(c0.env));
check('샌드박스로 가는 요청 어디에도 진짜 키 없음', seen.creates.every((c) => !c.raw.includes(mg) && !/sk-or-/.test(c.raw)));
check('자리마다 다른 토큰', new Set(seen.creates.map((c) => c.body.env.OPENROUTER_API_KEY)).size === 3);
const tokens = seen.creates.slice(0, 2).map((c) => c.body.env.OPENROUTER_API_KEY);
const failedTok = seen.creates[2].body.env.OPENROUTER_API_KEY;

console.log('\n# workers.dev 쪽 (샌드박스가 부르는 곳)');
const kinfo = await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${tokens[0]}` } });
const kj = await kinfo.json().catch(() => ({}));
check('자리 토큰으로 OpenRouter /key → $1 한도 서브키 (lab-status 가 묻는 곳)', kinfo.status === 200 && kj.data?.limit === 1, `${kinfo.status} ${JSON.stringify(kj).slice(0, 200)}`);
check('실패한 자리의 토큰은 바로 폐기됨', (await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${failedTok}` } })).status === 401);
check('실습실 호스트로는 /borrow 안 열림', (await fetch(`${ALT}/borrow`)).status === 404);
check('실습실 호스트로는 관리 API 안 열림', (await fetch(`${ALT}/api/lab/list`, { method: 'POST', body: '{}' })).status === 404);

console.log('\n# 강사 목록: 수업 링크·QR·Daytona 한도');
{
  const l = (await call('/api/lab/list', {}, ADM)).j;
  const v = l.labs.find((x) => x.id === lab.id);
  check('수업 링크 = 실습실 호스트/c/<코드>, QR SVG', v.link === `${ALT}/c/${lab.cls}` && v.qr.startsWith('<svg'), v.link);
  check('Daytona 한도 (조직 id 는 샌드박스 응답에서)', l.quota?.cpu?.[1] === 10 && l.quota.cpu[0] === 2 && l.quota.memory[1] === 10, JSON.stringify(l.quota));
  check('목록에 게이트웨이 주소·토큰·미리보기 토큰 없음', !JSON.stringify(l).includes('kvt_') && !JSON.stringify(l).includes('pv-') && !('gw' in v));
}

console.log('\n# 수업 링크 하나로 자리 배정');
check('수업 링크 페이지', (await fetch(`${ALT}/c/${lab.cls}`)).status === 200);
check('소문자 코드도 됨', (await fetch(`${ALT}/c/${lab.cls.toLowerCase()}`)).status === 200);
check('다른 출처에서 POST 거부', (await call('/__lab/claim', { cls: lab.cls, name: 'x' }, { origin: 'https://evil.test' }, ALT)).status === 403);
check('없는 수업 코드 404', (await lab_('/__lab/claim', { cls: 'ZZZZZZ', name: 'x' })).status === 404);
check('처음 온 브라우저(쿠키 없음)는 이름을 물음', (await lab_('/__lab/claim', { cls: lab.cls, name: '' })).j?.needName === true);
const alice = (await lab_('/__lab/claim', { cls: lab.cls, name: '앨리스' })).j;
const bob = (await lab_('/__lab/claim', { cls: lab.cls, name: '밥' })).j;
check('들어온 순서대로 빈 자리', alice.seat === okSeats[0].n && bob.seat === okSeats[1].n && alice.code === okSeats[0].code, JSON.stringify([alice, bob]));
check('같은 이름이면 원래 자리 (다른 기기)', (await lab_('/__lab/claim', { cls: lab.cls, name: ' 앨리스 ' })).j?.code === alice.code);
check('같은 브라우저(쿠키)면 이름 없이 원래 자리', (await lab_('/__lab/claim', { cls: lab.cls, name: '' }, `lab_seat=${bob.code}`)).j?.code === bob.code);
const full = await lab_('/__lab/claim', { cls: lab.cls, name: '캐럴' });
check('빈 자리 없으면 409 (실패한 자리는 안 줌)', full.status === 409, JSON.stringify(full.j));

console.log('\n# 깨우기 → 수업 자료 → 편집기');
async function wake(code) {
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const r = await lab_('/__lab/wake', { code });
    steps.push(r.j?.detail ?? r.j?.status ?? r.status);
    if (r.status !== 200 || r.j.status === 'ready') return { r, steps };
  }
  return { r: null, steps };
}
{
  const { r, steps } = await wake(alice.code);
  check('깨우기 → 자료 → 편집기 켜기 → ready', r?.j.status === 'ready' && steps.includes('편집기를 켜는 중'), JSON.stringify(steps));
  check('자료: 샌드박스 안에서 GitHub clone (얕게)', seen.execs.some((e) => e.command.includes('git clone -q --depth 1 https://github.com/octo/demo.git demo')), JSON.stringify(seen.execs.map((e) => e.command)));
  check('code-server 를 세션에서 비동기로 켬', seen.spawns.some((s) => s.command === 'lab-start' && s.runAsync === true));
  check('참가자 응답에 수업 정보', r.j.name === '테스트반' && r.j.seat === alice.seat && r.j.who === '앨리스' && r.j.model === cfg.cfg.model);
  const again = seen.execs.filter((e) => e.command.includes('git clone')).length;
  await lab_('/__lab/wake', { code: alice.code });
  check('자료는 자리마다 한 번만', seen.execs.filter((e) => e.command.includes('git clone')).length === again);
}
{
  const sb = [...sbs.values()].find((s) => s.labels['gw-seat'] === String(bob.seat));
  sb.state = 'stopped';
  const first = await lab_('/__lab/wake', { code: bob.code });
  check('멈춘 실습실은 다시 켬', first.j?.status === 'starting' && sb.state === 'starting', JSON.stringify(first.j));
  const { r } = await wake(bob.code);
  check('다시 켠 뒤 ready', r?.j.status === 'ready');
}

console.log('\n# 실습실 호스트가 code-server 를 대신 연다');
const enter = await fetch(`${ALT}/__lab/enter/${alice.code}`, { redirect: 'manual' });
const setc = enter.headers.get('set-cookie') ?? '';
check('입장: 자리 쿠키(HttpOnly) 굽고 / 로', enter.status === 302 && enter.headers.get('location') === '/' && setc.startsWith(`lab_seat=${alice.code}`) && /HttpOnly/i.test(setc), setc);
const A = `lab_seat=${alice.code}`, B = `lab_seat=${bob.code}`;
{
  const r = await fetch(`${ALT}/`, { headers: { cookie: A }, redirect: 'manual' });
  check('/ → code-server 의 리다이렉트를 우리 호스트 기준으로', r.status === 302 && r.headers.get('location') === '/?folder=/home/daytona/work', `${r.status} ${r.headers.get('location')}`);
  const sb1 = [...sbs.values()].find((s) => s.labels['gw-seat'] === String(alice.seat)).id;
  const p = await fetch(`${ALT}/?folder=/home/daytona/work`, { headers: { cookie: `${A}; other=1`, origin: ALT } });
  const text = await p.text();
  check('자리 쿠키 → 그 자리 샌드박스', p.status === 200 && text === `seat:${sb1}`, text);
  const up = seen.cs.at(-1).headers;
  check('upstream 에 미리보기 토큰·경고 건너뛰기 헤더', up['x-daytona-preview-token'] === `pv-${sb1}` && up['x-daytona-skip-preview-warning'] === 'true');
  check('upstream 에 자리 쿠키는 안 감, 다른 쿠키는 감', up.cookie === 'other=1', up.cookie);
  check('Origin 을 upstream 출처로 바꿈', up.origin === CS, up.origin);
  check('code-server 쿠키의 Domain 은 지움', (p.headers.get('set-cookie') ?? '') === 'cs=1; Path=/', p.headers.get('set-cookie'));
  const pb = await (await fetch(`${ALT}/x`, { headers: { cookie: B } })).text();
  check('다른 쿠키 → 다른 샌드박스', pb.startsWith('seat:') && pb !== `seat:${sb1}`, pb);
  const ws = await new Promise((resolve) => {
    const q = request(`${ALT}/stable-x?reconnection=false`, { headers: { cookie: A, origin: ALT, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    q.on('upgrade', (res, socket, head) => {
      const done = (d) => { socket.destroy(); resolve({ status: res.statusCode, data: d.subarray(2).toString() }); };
      if (head.length) done(head); else socket.once('data', done); // 첫 프레임이 핸드셰이크와 같이 올 수 있다
    });
    setTimeout(() => resolve({ status: -1, data: 'timeout' }), 5000);
    q.on('response', (res) => resolve({ status: res.statusCode }));
    q.on('error', (e) => resolve({ status: 0, data: e.message }));
    q.end();
  });
  check('WebSocket 도 그대로 이어짐', ws.status === 101 && ws.data === `hi-${sb1.slice(0, 8)}`, JSON.stringify(ws));
  const boom = await fetch(`${ALT}/boom`, { headers: { cookie: A, accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
  check('꺼진 실습실(5xx) 페이지 열기 → 다시 열기 안내', boom.status === 503 && (await boom.text()).includes('again'));
  check('쿠키 없이 / → 수업 코드 입력 화면', (await fetch(`${ALT}/`)).status === 200);
  check('쿠키 없이 다른 경로 → 404', (await fetch(`${ALT}/static/x.js`)).status === 404);
  check('예전 자리 링크(k.shinick.dev/j/…) → 실습실 호스트로', (await fetch(`${GW}/j/${alice.code}`, { redirect: 'manual' })).headers.get('location') === `${ALT}/j/${alice.code}`);
}
{
  const l = (await call('/api/lab/list', {}, ADM)).j;
  const v = l.labs.find((x) => x.id === lab.id);
  check('목록: 자리마다 이름·상태·입장·자료',
    v.seats.filter((s) => s.state === 'started').length === 2 && v.seats.filter((s) => s.opened).length === 2
    && v.seats.find((s) => s.n === alice.seat).who === '앨리스' && v.seats.find((s) => s.n === alice.seat).setup?.state === 'ok', JSON.stringify(v.seats));
}

console.log('\n# VS Code 위 막대: 남은 시간·사용액, 내 작업 받기, 손 들기');
{
  const wb = await fetch(`${ALT}/wb`, { headers: { cookie: A, 'sec-fetch-dest': 'document', accept: 'text/html' } });
  const t = await wb.text();
  const expectedScripts = ['bar','snips','help','screen','rtc','dom-capture','live','classroom','perf'].map(name => `<script src="/__lab/${name}.js" defer nonce="n0nce"></script>`).join('');
  check('workbench 문서에 수업·지원 스크립트를 끼움 (code-server nonce 사용)', wb.status === 200 && t.includes(expectedScripts + '</body>'), t);
  check('<head> 맨 앞에 클립보드 경계 스크립트 (앱 코드보다 먼저)', t.includes('<head><script src="/__lab/guard.js"></script><script nonce="n0nce">'), t);
  check('PWA: code-server manifest 는 떼고 자리 주소 manifest 도 안 알림 (아이콘·테마색·경계·막대는 그대로)', !t.includes('./manifest.json') && !/rel="manifest"|webmanifest/.test(t)
    && t.includes('<meta name="theme-color" content="#0f172a"><link rel="icon" href="/__lab/icon-192.png">') && t.includes('<script src="/__lab/guard.js"></script>') && t.includes('<script src="/__lab/bar.js" defer'), t);
  const sub = await (await fetch(`${ALT}/wb`, { headers: { cookie: A, 'sec-fetch-dest': 'iframe' } })).text();
  check('iframe(웹뷰 등)에는 경계만, 막대·manifest 는 안 끼움', sub.includes('<script src="/__lab/guard.js">') && !sub.includes('bar.js') && !sub.includes('webmanifest'), sub);
  const raw = await (await fetch(`${ALT}/wb`, { headers: { cookie: A, 'sec-fetch-dest': 'script' } })).text();
  check('HTML 문서가 아닌 요청에는 안 끼움', !raw.includes('/__lab/'), raw);
  const js = await fetch(`${ALT}/__lab/bar.js`);
  check('막대 스크립트 제공 (innerHTML 없음 — Trusted Types)', js.status === 200 && (js.headers.get('content-type') ?? '').includes('javascript') && !(await js.text()).includes('innerHTML'));
  const me = await fetch(`${ALT}/__lab/me`, { headers: { cookie: A } });
  const mj = await me.json();
  check('내 정보: 자리·이름·끝나는 시각·사용액/한도', me.status === 200 && mj.seat === alice.seat && mj.who === '앨리스' && mj.expiresAt === lab.expiresAt && mj.usage === 0 && mj.limit === 1 && mj.hand === false, JSON.stringify(mj));
  check('쿠키 없으면 401', (await fetch(`${ALT}/__lab/me`)).status === 401);
  check('손 들기: 다른 출처 거부', (await call('/__lab/hand', { up: true }, { origin: 'https://evil.test', cookie: A }, ALT)).status === 403);
  check('손 들기', (await lab_('/__lab/hand', { up: true }, A)).j?.hand === true);
  let v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === lab.id);
  const sa = () => v.seats.find((s) => s.n === alice.seat);
  check('강사 목록에 ✋ · 사용액', !!sa().hand && sa().usage === 0 && sa().limit === 1 && !v.seats.find((s) => s.n === bob.seat).hand, JSON.stringify(sa()));
  check('강사가 손 내림', (await call('/api/lab/hand', { id: lab.id, n: alice.seat }, ADM)).status === 200);
  v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === lab.id);
  check('내려감', !sa().hand);
  const ex = await fetch(`${ALT}/__lab/export`, { headers: { cookie: A } });
  const buf = Buffer.from(await ex.arrayBuffer());
  check('내 작업 받기: work 를 zip 으로 (node_modules 제외) 흘려 보냄', ex.status === 200 && ex.headers.get('content-type') === 'application/zip'
    && ex.headers.get('content-disposition') === `attachment; filename="lab-${alice.seat}-work.zip"` && buf.subarray(0, 2).toString() === 'PK'
    && seen.execs.some((e) => e.command.includes('zip -qr') && e.command.includes('node_modules')), `${ex.status} ${ex.headers.get('content-disposition')} ${buf}`);
  check('쿠키 없이 받기 401', (await fetch(`${ALT}/__lab/export`)).status === 401);
}

console.log('\n# 참가자 상태 (활동 중·자리 비움·오프라인·입장 전, 강사 보기 탭 제외)');
{
  // dev(ALLOW_SHORT_TTL)는 오프라인 기준이 6초 (운영 3분). 자리 비움 5분은 막대가 보내는 경과 초(idle)로 시험한다
  const sig = (cookie, p) => lab_('/__lab/me', p, cookie);
  const pv = async () => {
    const l = (await call('/api/lab/list', {}, ADM)).j;
    const v = l.labs.find((x) => x.id === lab.id);
    return { l, a: v.seats.find((s) => s.n === alice.seat), b: v.seats.find((s) => s.n === bob.seat) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let p = await pv();
  check('신호 전: 입장 전(none) — GET /__lab/me 는 상태를 안 적음', p.a.presence?.state === 'none' && p.b.presence?.state === 'none', JSON.stringify([p.a.presence, p.b.presence]));
  check('신호: 쿠키 없으면 401', (await lab_('/__lab/me', { tab: 'tabNoCookie', idle: 0 })).status === 401);
  check('신호: 다른 출처 거부', (await call('/__lab/me', { tab: 'tabEvil01', idle: 0 }, { origin: 'https://evil.test', cookie: A }, ALT)).status === 403);
  const s1 = await sig(A, { tab: 'tabA1xx', idle: 10, vis: 'visible', focus: true, watch: false });
  check('신호(POST)도 막대 정보를 그대로 돌려줌', s1.status === 200 && s1.j.seat === alice.seat && s1.j.expiresAt === lab.expiresAt && 'clip' in s1.j, JSON.stringify(s1.j));
  p = await pv();
  check('활동 중: 입력 5분 이내', p.a.presence?.state === 'active' && p.a.presence.idleSec >= 10 && p.a.presence.idleSec < 60 && p.a.presence.tabs === 1 && p.a.presence.lastSeen > 0, JSON.stringify(p.a.presence));
  await sig(A, { tab: 'tabA2xx', idle: 400, vis: 'hidden', focus: false });
  p = await pv();
  check('여러 탭: 가장 최근 입력이 있었던 탭 기준 (한 탭이 오래 쉬어도 활동 중)', p.a.presence?.state === 'active' && p.a.presence.tabs === 2 && p.a.presence.idleSec < 60, JSON.stringify(p.a.presence));
  await sig(B, { tab: 'tabWatch1', idle: 0, vis: 'visible', focus: true, watch: true });
  p = await pv();
  check('강사 "들어가 보기" 탭(watch)은 판정에서 뺌', p.b.presence?.state === 'none' && p.b.presence.watch === 1, JSON.stringify(p.b.presence));
  await sig(B, { tab: 'tabB1xx', idle: 400, vis: 'visible', focus: true });
  p = await pv();
  check('자리 비움: 탭은 보여도 5분 넘게 입력 없음 (watch 탭의 입력은 안 셈)', p.b.presence?.state === 'away' && p.b.presence.idleSec >= 400, JSON.stringify(p.b.presence));
  check('형식이 틀린 신호는 무시 (막대 정보는 그대로)', (await sig(A, { tab: '<bad tab>', idle: 'x' })).status === 200);
  check('목록에 탭 id·토큰·미리보기 토큰 없음', !/tabA1xx|tabWatch1|kvt_|pv-/.test(JSON.stringify(p.l)));
  const t0 = Date.now();
  await sleep(6500);
  p = await pv();
  check('오프라인: 기준 넘게 신호 없음 → 마지막 신호 시각', p.a.presence?.state === 'offline' && p.a.presence.lastSeen <= t0 && p.b.presence?.state === 'offline', JSON.stringify([p.a.presence, p.b.presence]));
  await sig(A, { tab: 'tabA1xx', idle: 0, code: bob.code, seat: bob.seat, n: bob.seat });
  p = await pv();
  check('다른 자리로 위장 불가 (본문의 자리 값은 무시, 쿠키 자리만)', p.a.presence?.state === 'active' && p.a.presence.tabs === 1 && p.b.presence?.state === 'offline', JSON.stringify([p.a.presence, p.b.presence]));
  await sig(A, { tab: 'tabA1xx', idle: 297 });
  p = await pv();
  const before = p.a.presence?.state;
  await sleep(3500);
  p = await pv();
  check('신호 뒤 시간이 흐르면 경과 초가 늘어 자리 비움으로', before === 'active' && p.a.presence?.state === 'away' && p.a.presence.idleSec >= 300, `${before} ${JSON.stringify(p.a.presence)}`);
  const tok = seen.creates.find((c) => c.body.labels['gw-seat'] === String(alice.seat)).body.env.OPENROUTER_API_KEY;
  const t1 = Date.now();
  await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${tok}` } });
  p = await pv();
  check('lastAi: lab-status 의 /key 조회는 AI 사용으로 안 침', !(p.a.lastAi >= t1 - 1000), `${p.a.lastAi} ${t1}`);
  await fetch(`${ALT}/p/openrouter/api/v1/generation?id=none`, { headers: { authorization: `Bearer ${tok}` } });
  p = await pv();
  check('lastAi: 그 자리 토큰으로 게이트웨이를 부른 시각', p.a.lastAi >= t1 - 1000 && p.a.lastAi <= Date.now() + 1000 && typeof p.l.now === 'number', `${p.a.lastAi} ${t1}`);
  const bar = await (await fetch(`${ALT}/__lab/bar.js`)).text();
  check('bar.js: POST 신호·탭 id·watch·입력 경과·다시 보일 때 바로 보냄', bar.includes("method: 'POST'") && bar.includes('labTab') && bar.includes('labWatch') && bar.includes('visibilitychange') && bar.includes('idle:') && bar.includes('onInput'));
  const g = await (await fetch(`${ALT}/__lab/guard.js`, { headers: { cookie: A } })).text();
  check('guard.js: 키보드·마우스 입력 시각만 (iframe 도 top 에 모음)', ['keydown', 'pointerdown', 'wheel', 'pointermove', 'S.touch'].every((x) => g.includes(x)) && !g.includes('e.key'));
  const jp = await (await fetch(`${ALT}/j/${alice.code}?watch=1`)).text();
  check('자리 링크 ?watch=1 → 참가자 페이지가 sessionStorage 에 기억 (입장 리다이렉트 뒤에도 그 탭에 남음)', jp.includes("sessionStorage.setItem('labWatch','1')") && jp.includes('활동 중/자리 비움 여부와 시각만'));
  const lp = await (await fetch(`${GW}/lab`)).text();
  check('강사 화면: 들어가 보기는 ?watch=1, 상태 요약·점', lp.includes("+'?watch=1'") && lp.includes('자리 비움') && lp.includes('🟢'));
}

console.log('\n# 클립보드 경계 (방향별, 강사가 수업 중에 바꿈)');
{
  const guard = async (cookie) => (await fetch(`${ALT}/__lab/guard.js`, cookie ? { headers: { cookie } } : {})).text();
  let v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === lab.id);
  check('만들 때 정한 규칙 (붙여넣기 허용 · 밖으로 복사 막음)', v.clip?.in === true && v.clip?.out === false, JSON.stringify(v.clip));
  const g1 = await guard(A);
  check('guard.js: 자리 쿠키의 수업 규칙 + 경계 코드', g1.startsWith('window.__labClipPolicy={"in":true,"out":false};') && g1.includes('ClipboardEvent') && !g1.includes('innerHTML'), g1.slice(0, 120));
  check('guard.js: 쿠키 없으면 둘 다 허용', (await guard()).startsWith('window.__labClipPolicy={"in":true,"out":true};'));
  check('설정 기본값에 마지막 규칙 기억', (await call('/api/lab/config', {}, ADM)).j.cfg.clip?.out === false);
  check('관리 토큰 없이 규칙 변경 401', (await call('/api/lab/clip', { id: lab.id, in: false, out: false }, { 'x-admin-token': 'nope' })).status === 401);
  const ch = await call('/api/lab/clip', { id: lab.id, in: false, out: true }, ADM);
  check('강사가 수업 중에 바꿈', ch.status === 200 && ch.j.clip.in === false && ch.j.clip.out === true, JSON.stringify(ch.j));
  check('guard.js 에 바로 반영', (await guard(A)).startsWith('window.__labClipPolicy={"in":false,"out":true};'));
  const me2 = await (await fetch(`${ALT}/__lab/me`, { headers: { cookie: A } })).json();
  check('막대(/__lab/me)에도 반영 → 열린 화면은 30초 안에', me2.clip?.in === false && me2.clip?.out === true, JSON.stringify(me2.clip));
  check('다른 자리도 같은 수업 규칙', (await guard(B)).startsWith('window.__labClipPolicy={"in":false,"out":true};'));
}

console.log('\n# PWA');
{
  const mf = await fetch(`${ALT}/__lab/manifest.webmanifest`);
  const m = await mf.json();
  check('manifest: 독립 창, 시작 / , 192·512 아이콘', mf.headers.get('content-type') === 'application/manifest+json' && m.display === 'standalone' && m.start_url === '/' && m.scope === '/'
    && m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), JSON.stringify(m));
  for (const n of [192, 512]) {
    const ic = await fetch(`${ALT}/__lab/icon-${n}.png`);
    const b = Buffer.from(await ic.arrayBuffer());
    check(`아이콘 ${n} PNG (${n}x${n})`, ic.headers.get('content-type') === 'image/png' && b.subarray(1, 4).toString() === 'PNG' && b.readUInt32BE(16) === n && b.readUInt32BE(20) === n);
  }
  const land = await fetch(`${ALT}/`);
  const lt = await land.text();
  check('실습실 호스트 페이지: manifest 링크 + CSP manifest-src', lt.includes('/__lab/manifest.webmanifest') && (land.headers.get('content-security-policy') ?? '').includes("manifest-src 'self'"));
  check('k.shinick.dev 페이지에는 실습실 manifest 없음', !(await (await fetch(`${GW}/borrow`)).text()).includes('webmanifest'));
}

console.log('\n# 강사 화면 보기 창');
{
  const sj = await fetch(`${ALT}/__lab/screen.js`);
  const st = await sj.text();
  check('screen.js 제공: __labScreen.attach · 작은 창·크게·따로 띄우기·숨김 (innerHTML 없음 — Trusted Types)', sj.status === 200 && (sj.headers.get('content-type') ?? '').includes('javascript')
    && ['__labScreen', 'attach', 'documentPictureInPicture', 'requestPictureInPicture', 'localStorage', '__labBarUI'].every((x) => st.includes(x)) && !st.includes('innerHTML'));
}

console.log('\n# 오류 신호: 자리별 최근 오류, 여러 자리면 전체 경고');
{
  const seatTok = (n) => seen.creates.find((c) => c.body.labels['gw-seat'] === String(n)).body.env.OPENROUTER_API_KEY;
  const bad = async (n) => (await fetch(`${ALT}/p/openrouter/api/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${seatTok(n)}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nope/not-a-model-xyz', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }) })).status;
  const st = await bad(alice.seat);
  check('없는 모델로 부르면 upstream 이 4xx', st >= 400 && st < 500, String(st));
  let v;
  for (let i = 0; i < 10; i++) {
    v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === lab.id);
    if (v.seats.find((s) => s.n === alice.seat).err) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const e = v.seats.find((s) => s.n === alice.seat).err;
  check('강사 목록: 그 자리에 최근 오류(상태·메시지)', e && e.status === st && e.msg.length > 0 && !v.outage, JSON.stringify(e));
  await bad(bob.seat);
  for (let i = 0; i < 10; i++) {
    v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === lab.id);
    if (v.outage) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check('입장한 자리 대부분이 오류 → 전체 경고', !!v.outage && v.outage.startsWith('2자리'), v.outage);
}

console.log('\n# 지금 끝내기');
const beforeDel = seen.deletes.length;
const end = await call('/api/lab/end', { id: lab.id }, ADM);
check('끝내기 200', end.status === 200, JSON.stringify(end.j));
check('샌드박스 전부 삭제', seen.deletes.length - beforeDel === 2 && [...sbs.values()].filter((s) => s.labels['gw-lab'] === lab.id).length === 0);
check('자리 토큰 무효', (await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${tokens[0]}` } })).status === 401);
check('수업 링크 무효', (await lab_('/__lab/claim', { cls: lab.cls, name: '앨리스' })).status === 404);
check('자리 깨우기 무효', (await lab_('/__lab/wake', { code: alice.code })).status === 404);
check('입장 무효', (await fetch(`${ALT}/__lab/enter/${alice.code}`, { redirect: 'manual' })).status === 404);
check('목록에서 사라짐', !(await call('/api/lab/list', {}, ADM)).j.labs.some((x) => x.id === lab.id));

console.log('\n# 여러 명이 동시에 수업 링크로 들어옴 (자리 자동 배정)');
{
  failCreateAt = 0;
  const big = await call('/api/lab/create', { ...base, name: '동시반', seats: 6, materials: '' }, ADM);
  check('6자리 수업', big.status === 200 && big.j.lab.seats.every((s) => !s.error), JSON.stringify(big.j).slice(0, 300));
  const names = ['가', '나', '다', '라', '마', '바', '사', '아'];
  const rs = await Promise.all(names.map((n) => lab_('/__lab/claim', { cls: big.j.lab.cls, name: n })));
  const got = rs.filter((r) => r.status === 200).map((r) => r.j);
  check('8명 동시 → 6명은 서로 다른 자리, 2명은 409', got.length === 6 && new Set(got.map((j) => j.seat)).size === 6 && new Set(got.map((j) => j.code)).size === 6
    && rs.filter((r) => r.status === 409).length === 2, JSON.stringify(rs.map((r) => [r.status, r.j?.seat])));
  const winner = got[0];
  const again = await Promise.all([1, 2, 3].map(() => lab_('/__lab/claim', { cls: big.j.lab.cls, name: winner.who })));
  check('같은 이름으로 동시에 다시 들어와도 원래 자리', again.every((r) => r.status === 200 && r.j.code === winner.code), JSON.stringify(again.map((r) => r.j?.seat)));
  const v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === big.j.lab.id);
  check('강사 표: 6자리 모두 이름이 붙음 (겹침 없음)', new Set(v.seats.map((s) => s.who).filter(Boolean)).size === 6, JSON.stringify(v.seats.map((s) => s.who)));
  check('동시반 끝내기', (await call('/api/lab/end', { id: big.j.lab.id }, ADM)).status === 200);
}

console.log('\n# 수업별 API 키 나눠 주기 (가짜 토큰 + 게이트웨이 임시 레이어)');
{
  const UP = 'http://localhost:8799/fakeup';
  const K1 = 'real-fakeup-key-1111', K2 = 'real-fakeup-key-2222', K3 = 'real-fakeno-key-3333';
  const up1 = await call('/api/admin/provider', { id: 'fakeup', label: '가짜검색', upstream: UP + '/a', auth: 'bearer', envKey: 'FAKEUP_API_KEY', envBase: 'FAKEUP_BASE_URL', basePath: '/v1', value: K1, labShare: true }, ADM);
  check('dev: http://localhost upstream 공급자 + 실습실 공유 표시', up1.status === 200 && up1.j.provider.labShare === true, JSON.stringify(up1.j));
  const up2 = await call('/api/admin/provider', { id: 'fakeup2', label: '가짜음성', upstream: UP + '/b', auth: 'x-api-key', envKey: 'FAKEUP2_API_KEY', value: K2, labShare: true, headers: 'X-Tenant-Id: ws-1' }, ADM);
  check('공유 공급자 2 (x-api-key) + 고정 헤더', up2.status === 200 && up2.j.provider.headers?.['x-tenant-id'] === 'ws-1', JSON.stringify(up2.j));
  const badH = async (headers) => (await call('/api/admin/provider', { id: 'fakeup2', headers }, ADM)).status;
  check('고정 헤더: 인증·전달 헤더·x- 아닌 이름·줄바꿈 값 거부', await badH({ 'x-api-key': 'a' }) === 400 && await badH({ 'x-forwarded-for': '1.1.1.1' }) === 400
    && await badH({ authorization: 'a' }) === 400 && await badH({ 'x-a': 'a\nb' }) === 400 && await badH({ a: 1, b: 2, c: 3, d: 4, e: 5 }) === 400);
  check('헤더만 안 보낸 수정은 고정 헤더 유지', (await call('/api/admin/provider', { id: 'fakeup2', labShare: true }, ADM)).j.provider.headers?.['x-tenant-id'] === 'ws-1');
  check('공유 안 하는 공급자', (await call('/api/admin/provider', { id: 'fakeno', label: '비공유', upstream: UP + '/c', auth: 'bearer', envKey: 'FAKENO_API_KEY', value: K3 }, ADM)).status === 200);
  check('dev 라도 localhost 가 아닌 http upstream 은 거부', (await call('/api/admin/provider', { id: 'fakeevil', upstream: 'http://example.com', auth: 'bearer', envKey: 'X_KEY', value: 'x' }, ADM)).status === 400);
  const dtShare = await call('/api/admin/provider', { id: 'daytona', labShare: true }, ADM);
  check('daytona 는 공유 표시 거부 (서버)', dtShare.status === 400, JSON.stringify(dtShare.j));
  check('openrouter(서브키 발급형)도 공유 표시 거부', (await call('/api/admin/provider', { id: 'openrouter', labShare: true }, ADM)).status === 400);
  const cf = (await call('/api/lab/config', {}, ADM)).j;
  const ids = cf.shareable.map((x) => x.id).sort().join(',');
  check('설정: 공유 가능 목록 = 표시한 proxy 공급자만 (daytona·openrouter·비공유 없음)', ids === 'fakeup,fakeup2', ids);
  const b2 = { ...base, name: '공유반', seats: 2, materials: '' };
  const n0 = seen.creates.length;
  const rej = async (share) => (await call('/api/lab/create', { ...b2, share }, ADM));
  check('공유 안 하는 공급자 선택 거부', (await rej({ fakeno: 10 })).status === 400);
  check('daytona 선택 거부', (await rej({ daytona: 10 })).status === 400);
  check('openrouter 선택 거부', (await rej({ openrouter: 10 })).status === 400);
  check('없는 공급자 거부', (await rej({ nope: 10 })).status === 400);
  check('상한 0 · 10001 · 소수 거부', (await rej({ fakeup: 0 })).status === 400 && (await rej({ fakeup: 10001 })).status === 400 && (await rej({ fakeup: 2.5 })).status === 400);
  check('검증 실패 때 Daytona 호출 없음', seen.creates.length === n0);
  const mk = await call('/api/lab/create', { ...b2, share: { fakeup: 3, fakeup2: 500 } }, ADM);
  check('공유 키 2개로 수업 만들기', mk.status === 200 && mk.j.lab.seats.every((x) => !x.error) && mk.j.lab.share.length === 2, JSON.stringify(mk.j).slice(0, 300));
  const L = mk.j.lab;
  const cr = seen.creates.slice(n0);
  const e0 = cr[0].body.env;
  check('샌드박스 env: 공급자마다 같은 가짜 토큰 + 게이트웨이 주소, LAB_SHARED',
    e0.FAKEUP_API_KEY === e0.OPENROUTER_API_KEY && e0.FAKEUP2_API_KEY === e0.OPENROUTER_API_KEY && e0.FAKEUP_BASE_URL === `${ALT}/p/fakeup/v1`
    && e0.LAB_SHARED === 'fakeup,fakeup2' && e0.LAB_GW === ALT && !('FAKENO_API_KEY' in e0), JSON.stringify(e0));
  check('샌드박스 요청 어디에도 진짜 공유 키 없음', cr.every((c) => ![K1, K2, K3, mg, DT_KEY].some((k) => c.raw.includes(k))));
  const tokOf = (n) => cr.find((c) => c.body.labels['gw-seat'] === String(n)).body.env.FAKEUP_API_KEY;
  const t1 = tokOf(1), t2 = tokOf(2);
  const hit = (id, tok, rest = 'v1/search', hdr = 'authorization') => fetch(`${ALT}/p/${id}/${rest}`, { method: 'POST', headers: { [hdr]: hdr === 'authorization' ? `Bearer ${tok}` : tok, 'content-type': 'application/json' }, body: '{}' });
  let r = await hit('fakeup', t1);
  const u1 = seen.up.at(-1);
  check('켜진 공급자 통과 → upstream 에 진짜 키 (bearer)', r.status === 200 && u1.path === '/fakeup/a/v1/search' && u1.headers.authorization === `Bearer ${K1}`, `${r.status} ${JSON.stringify(u1?.headers)}`);
  r = await fetch(`${ALT}/p/fakeup2/tts`, { method: 'POST', headers: { 'x-api-key': t1, 'x-tenant-id': 'someone-else', 'content-type': 'application/json' }, body: '{}' });
  const u2 = seen.up.at(-1);
  check('x-api-key 로 보내도 → upstream 에 진짜 키, 가짜 토큰은 안 나감', r.status === 200 && u2.headers['x-api-key'] === K2 && !JSON.stringify(u2.headers).includes('kvt_'), JSON.stringify(u2?.headers));
  check('고정 헤더가 upstream 에 붙고 참가자가 보낸 값을 덮음', u2.headers['x-tenant-id'] === 'ws-1', JSON.stringify(u2?.headers));
  r = await hit('fakeno', t1);
  check('안 고른 공급자 403', r.status === 403);
  check('upstream 에 가짜 토큰이 나간 적 없음', seen.up.every((x) => !JSON.stringify(x.headers).includes('kvt_')));
  await hit('fakeup', t1); await hit('fakeup', t1);
  r = await hit('fakeup', t1);
  const rj = await r.json();
  check('자리당 상한(3회) 넘으면 429 + 한국어 메시지', r.status === 429 && rj.error.includes('상한(3회)'), `${r.status} ${JSON.stringify(rj)}`);
  check('상한은 자리마다 따로 (다른 자리는 통과)', (await hit('fakeup', t2)).status === 200);
  check('OpenRouter 는 공유 상한과 무관', (await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${t1}` } })).status === 200);
  const pr = await fetch(`${ALT}/p/_lab/share`, { headers: { authorization: `Bearer ${t1}` } });
  const pj = await pr.json();
  const pf = pj.providers?.find((x) => x.id === 'fakeup');
  check('샌드박스 확인용 /p/_lab/share: 공급자별 켜짐·사용/상한·환경변수 이름 (비밀 없음)', pr.status === 200 && pf.used === 3 && pf.cap === 3 && pf.on === true && pf.envKey === 'FAKEUP_API_KEY'
    && ![K1, K2, 'kvt_'].some((k) => JSON.stringify(pj).includes(k)), JSON.stringify(pj));
  check('/p/_lab/share 는 upstream 을 안 부르고 세지도 않음', (await (await fetch(`${ALT}/p/_lab/share`, { headers: { authorization: `Bearer ${t1}` } })).json()).providers.find((x) => x.id === 'fakeup').used === 3);
  check('/p/_lab/share 토큰 없으면 401', (await fetch(`${ALT}/p/_lab/share`)).status === 401);
  check('수업 중 통제: 관리 토큰 없으면 401', (await call('/api/lab/share', { id: L.id, provider: 'fakeup2', on: false }, { 'x-admin-token': 'nope' })).status === 401);
  check('수업 중 통제: 만들 때 안 고른 공급자 400', (await call('/api/lab/share', { id: L.id, provider: 'fakeno', on: true }, ADM)).status === 400);
  check('수업 중 통제: 상한 범위 밖 400', (await call('/api/lab/share', { id: L.id, provider: 'fakeup', cap: 0 }, ADM)).status === 400);
  const off = await call('/api/lab/share', { id: L.id, provider: 'fakeup2', on: false }, ADM);
  check('강사가 끔', off.status === 200 && off.j.share.on === false, JSON.stringify(off.j));
  r = await hit('fakeup2', t1, 'tts', 'x-api-key');
  check('끄면 바로 거부 (403 + 한국어)', r.status === 403 && (await r.json()).error.includes('껐습니다'));
  check('다시 켜면 통과', (await call('/api/lab/share', { id: L.id, provider: 'fakeup2', on: true }, ADM)).status === 200 && (await hit('fakeup2', t1, 'tts', 'x-api-key')).status === 200);
  const cap5 = await call('/api/lab/share', { id: L.id, provider: 'fakeup', cap: 5 }, ADM);
  check('상한 수정 반영 (3 → 5회: 막혔던 자리가 다시 통과)', cap5.j?.share?.cap === 5 && (await hit('fakeup', t1)).status === 200);
  const v = (await call('/api/lab/list', {}, ADM)).j.labs.find((x) => x.id === L.id);
  const s1 = v.seats.find((x) => x.n === 1), s2 = v.seats.find((x) => x.n === 2);
  check('강사 표: 자리별·공급자별 호출 수 / 상한', s1.counts.fakeup === 4 && s1.counts.fakeup2 === 2 && s2.counts.fakeup === 1
    && v.share.find((x) => x.id === 'fakeup').cap === 5 && v.share.every((x) => x.on), JSON.stringify([v.share, s1.counts, s2.counts]));
  check('강사 목록에 비밀 없음', ![K1, K2, K3, 'kvt_'].some((k) => JSON.stringify(v).includes(k)));
  const cfg2 = (await call('/api/lab/config', {}, ADM)).j.cfg;
  check('설정 기억: 마지막으로 고른 공급자·상한', cfg2.share?.fakeup === 3 && cfg2.share?.fakeup2 === 500 && Object.keys(cfg2.share).length === 2, JSON.stringify(cfg2.share));
  const adl = (await call('/api/admin/list', {}, ADM)).j;
  check('감사 로그: lab-share (끄기·켜기·상한)', adl.audit.filter((a) => a.event === 'lab-share').length === 3 && adl.audit.some((a) => a.event === 'lab-create' && a.detail.includes('fakeup(3회)')), JSON.stringify(adl.audit.slice(0, 5)));
  check('관리 목록 공급자에 공유 표시, 진짜 키 없음', adl.providers.find((x) => x.id === 'fakeup').labShare === true && !adl.providers.find((x) => x.id === 'fakeno').labShare && ![K1, K2, K3].some((k) => JSON.stringify(adl).includes(k)));
  check('끝내기', (await call('/api/lab/end', { id: L.id }, ADM)).status === 200);
  const after = await Promise.all([hit('fakeup', t1), hit('fakeup2', t2, 'tts', 'x-api-key'), fetch(`${ALT}/p/_lab/share`, { headers: { authorization: `Bearer ${t1}` } })]);
  check('끝내기 후 공유 키·확인 경로 전부 401', after.every((x) => x.status === 401), after.map((x) => x.status).join(','));
  const unshare = await call('/api/admin/provider', { id: 'fakeup2', labShare: false }, ADM);
  check('공유 표시 끄기 (정의만 수정, 키 유지)', unshare.status === 200 && !unshare.j.provider.labShare && unshare.j.provider.last4 === K2.slice(-4));
  check('공유 표시를 끈 공급자는 수업에 못 고름', (await rej({ fakeup2: 10 })).status === 400);
}

console.log('\n# 강사 화면 공유 (Realtime SFU 신호 — 가짜 SFU, 앱 비밀은 서버에만)');
{
  const RT = process.env.REALTIME_APP_TOKEN; // 잠금 실행기가 dev 서버와 이 프로세스에 넘긴다. 비교만 하고 출력하지 않는다
  const L = (await call('/api/lab/create', { ...base, name: '화면반', seats: 2, materials: '' }, ADM)).j?.lab;
  check('화면 공유용 2자리 수업', L?.seats.filter((s) => s.sandboxId).length === 2, JSON.stringify(L?.seats));
  const [S1, S2] = L.seats.map((s) => `lab_seat=${s.code}`);
  const texts = []; // 브라우저로 가는 응답 전부 — 앱 비밀·SFU 세션 id 가 없어야 한다
  const rec = (r) => { texts.push(JSON.stringify(r.j)); return r; };
  const adm = (p, b, h = ADM) => call(p, b, h).then(rec);
  const st = (cookie) => fetch(`${ALT}/__lab/screen`, cookie ? { headers: { cookie } } : {}).then(async (r) => { const j = await r.json().catch(() => null); texts.push(JSON.stringify(j)); return { status: r.status, j }; });
  const pull = (cookie) => lab_('/__lab/screen/pull', {}, cookie).then(rec);
  const answer = (cookie, sid, sdp = 'v=0\r\nanswer-from-student') => lab_('/__lab/screen/answer', { sid, sdp }, cookie).then(rec);
  const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nfake-offer-from-teacher';
  const tracks = [{ mid: '0', trackName: 'screen' }];
  const NO = { 'x-admin-token': 'nope' };
  check('관리 토큰 없으면 start·stop·status 401', (await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks }, NO)).status === 401
    && (await adm('/api/lab/screen/stop', { id: L.id }, NO)).status === 401 && (await adm('/api/lab/screen/status', {}, NO)).status === 401);
  check('start 입력 검증: sdp 아님 400', (await adm('/api/lab/screen/start', { id: L.id, sdp: 'hello', tracks })).status === 400);
  check('start 입력 검증: tracks 이상 400', (await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks: [{ mid: '0', trackName: 'a b' }] })).status === 400
    && (await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks: [] })).status === 400);
  check('start: 없는 수업 404', (await adm('/api/lab/screen/start', { id: 'nolab', sdp: OFFER, tracks })).status === 404);
  check('쿠키 없으면 /__lab/screen·pull·answer 401', (await st()).status === 401 && (await pull()).status === 401 && (await answer(undefined, 'x'.repeat(20))).status === 401);
  const s0 = await st(S1);
  check('공유 전: {on:false, v:0}', s0.status === 200 && s0.j.on === false && s0.j.v === 0, JSON.stringify(s0.j));
  const p0 = await pull(S1);
  check('공유 안 할 때 pull 409 (한국어)', p0.status === 409 && /[가-힣]/.test(p0.j.error), JSON.stringify(p0.j));
  check('pull·answer: 다른 출처 거부', (await call('/__lab/screen/pull', {}, { origin: 'https://evil.test', cookie: S1 }, ALT)).status === 403);
  if (!RT) {
    const r = await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks });
    check('REALTIME_APP_TOKEN 이 없으면 start 503 (한국어)', r.status === 503 && r.j.error.includes('REALTIME_APP_TOKEN') && /[가-힣]/.test(r.j.error), JSON.stringify(r.j));
    console.log('  (REALTIME_APP_TOKEN 없음 — 가짜 SFU 흐름은 건너뜀)');
  } else {
    console.log('  (REALTIME_APP_TOKEN 있음 — 503 경로는 토큰 없는 dev 에서만 확인됨)');
    const n0 = sfu.calls.length;
    const r1 = await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks });
    const c1 = sfu.calls.slice(n0);
    check('start 200 → SFU answer, v 1', r1.status === 200 && r1.j.sdp.includes('fake-answer') && r1.j.v === 1, JSON.stringify(r1.j));
    check('SFU: sessions/new(본문 없음) → tracks/new(local, 강사 offer·mid·이름)', c1[0]?.path.endsWith(`/apps/${cfgApp}/sessions/new`) && c1[0].raw === ''
      && c1[1]?.body.sessionDescription?.sdp === OFFER && c1[1].body.tracks[0].location === 'local' && c1[1].body.tracks[0].mid === '0' && c1[1].body.tracks[0].trackName === 'screen', JSON.stringify(c1.map((c) => c.path)));
    check('SFU 호출은 전부 앱 비밀 Bearer 로 (서버가 붙임)', sfu.calls.slice(n0).every((c) => c.auth === `Bearer ${RT}`));
    const pub = sfu.sessions.at(-1);
    const s1 = await st(S1);
    check('공유 중: {on:true, v:1, title}', s1.j.on === true && s1.j.v === 1 && s1.j.title === '강사 화면', JSON.stringify(s1.j));
    const lst = await adm('/api/lab/screen/status', {});
    check('강사 상태 목록: 이 수업 공유 중', lst.j.screens?.[L.id]?.on === true && lst.j.screens[L.id].startedAt > 0, JSON.stringify(lst.j));
    const p1 = await pull(S1);
    const rq = sfu.calls.filter((c) => c.path.endsWith('/tracks/new')).at(-1);
    check('pull → 우리 쪽 sid + SFU offer', p1.status === 200 && /^[\w-]{16,}$/.test(p1.j.sid) && p1.j.sdp.includes('fake-offer') && p1.j.v === 1, JSON.stringify(p1.j));
    check('SFU: 학생 새 세션에서 강사 트랙을 remote 로 요청', rq.body.tracks[0].location === 'remote' && rq.body.tracks[0].sessionId === pub && rq.body.tracks[0].trackName === 'screen' && !rq.path.includes(pub), JSON.stringify(rq));
    const stuSess = rq.path.split('/sessions/')[1].split('/')[0];
    check('다른 자리 쿠키로 그 sid 에 answer → 403', (await answer(S2, p1.j.sid)).status === 403);
    check('없는 sid → 404', (await answer(S1, 'nosuchsid0123456789')).status === 404);
    check('answer 형식 틀림 400', (await answer(S1, p1.j.sid, 'nope')).status === 400);
    const a1 = await answer(S1, p1.j.sid);
    const rn = sfu.calls.at(-1);
    check('제 자리 answer 200 → SFU renegotiate (그 학생 세션)', a1.status === 200 && rn.method === 'PUT' && rn.path.endsWith(`/sessions/${stuSess}/renegotiate`) && rn.body.sessionDescription.type === 'answer' && rn.body.sessionDescription.sdp.includes('answer-from-student'), JSON.stringify(rn));
    const p2 = await pull(S2);
    check('두 번째 자리도 받음 (다른 sid)', p2.status === 200 && p2.j.sid !== p1.j.sid);
    check('S2 는 S1 의 sid 로 못 하고 제 sid 로는 됨', (await answer(S2, p1.j.sid)).status === 403 && (await answer(S2, p2.j.sid)).status === 200);
    const nc = sfu.calls.length;
    const stop = await adm('/api/lab/screen/stop', { id: L.id });
    const closed = async (from, sess) => { for (let i = 0; i < 20 && !sfu.calls.slice(from).some((c) => c.path.endsWith(`/sessions/${sess}/tracks/close`)); i++) await new Promise((r) => setTimeout(r, 100)); }; // 닫기는 응답을 기다리지 않는다
    await closed(nc, pub);
    check('stop → v 2, SFU 강사 트랙 닫기', stop.status === 200 && stop.j.v === 2 && sfu.calls.slice(nc).some((c) => c.path.endsWith(`/sessions/${pub}/tracks/close`) && c.body.force === true && c.body.tracks[0].mid === '0'), JSON.stringify(sfu.calls.slice(nc)));
    const s2 = await st(S2);
    check('멈춘 뒤: {on:false, v:2}', s2.j.on === false && s2.j.v === 2, JSON.stringify(s2.j));
    check('멈춘 뒤 pull 409, 예전 sid 는 지워짐(404)', (await pull(S1)).status === 409 && (await answer(S1, p1.j.sid)).status === 404);
    check('stop 두 번째는 그대로 (v 안 올림)', (await adm('/api/lab/screen/stop', { id: L.id })).j?.v === 2);
    // 강사 탭이 멈추지 못하고 닫힘: SFU 에 강사 트랙이 없으면 pull 이 멈춤으로 바꾼다 (dev 는 바로, 운영은 시작 1분 뒤부터)
    const r3 = await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks });
    check('다시 start → v 3', r3.status === 200 && r3.j.v === 3);
    sfu.tracks.clear();
    const p3 = await pull(S1);
    const s3 = await st(S1);
    check('강사 트랙이 SFU 에 없으면 pull 409 + 공유 상태 멈춤(v 4)', p3.status === 409 && s3.j.on === false && s3.j.v === 4, JSON.stringify([p3.j, s3.j]));
    const r5 = await adm('/api/lab/screen/start', { id: L.id, sdp: OFFER, tracks });
    const p5 = await pull(S1);
    check('다시 start·pull (끝내기 정리 확인용)', r5.status === 200 && p5.status === 200);
    const pub5 = [...sfu.local].at(-1);
    const all = texts.join('\n');
    check('브라우저로 간 응답 어디에도 앱 비밀·Bearer·SFU 세션 id 없음', !all.includes(RT) && !/bearer/i.test(all) && !sfu.sessions.some((x) => all.includes(x)));
    const adl = (await call('/api/admin/list', {}, ADM)).j;
    const ev = adl.audit.filter((a) => a.event === 'lab-screen').map((a) => a.detail);
    check('감사 로그 lab-screen: 시작·멈춤만 (시작 3 · 멈춤 1)', ev.filter((d) => d.endsWith('시작')).length === 3 && ev.filter((d) => d.endsWith('멈춤')).length === 1 && ev.length === 4, JSON.stringify(ev));
    const ec = sfu.calls.length;
    check('끝내기 200', (await call('/api/lab/end', { id: L.id }, ADM)).status === 200);
    await closed(ec, pub5);
    check('끝내기: SFU 강사 트랙 닫기 시도', sfu.calls.slice(ec).some((c) => c.path.endsWith(`/sessions/${pub5}/tracks/close`)), JSON.stringify(sfu.calls.slice(ec).map((c) => c.path)));
    check('끝내기 뒤 /__lab/screen·answer 는 자리 없음(404)', (await st(S1)).status === 404 && (await answer(S1, p5.j.sid)).status === 404);
    check('끝내기 뒤 상태 목록에서 사라짐', !((await adm('/api/lab/screen/status', {})).j.screens ?? {})[L.id]);
  }
  if (!RT) await call('/api/lab/end', { id: L.id }, ADM);
  const js = await fetch(`${ALT}/__lab/rtc.js`);
  const jt = await js.text();
  check('/__lab/rtc.js: 강사 보기 탭 제외·__labScreen.attach·10초/30초', js.status === 200 && jt.includes("labWatch") && jt.includes('__labScreen') && jt.includes('10000 : 30000') && !jt.includes('innerHTML'));
}

console.log('\n# 만료 알람 (dev: 18초짜리 수업) + ZIP 자료');
failCreateAt = 0;
const short = await call('/api/lab/create', { ...base, name: '짧은반', seats: 1, hours: 0.005, materials: 'http://localhost:8799/m.zip' }, ADM);
check('짧은 수업 만들기', short.status === 200 && !short.j.lab.seats[0].error, JSON.stringify(short.j));
{
  const code = short.j.lab.seats[0].code;
  const { r } = await wake(code);
  const upl = seen.uploads.at(-1);
  check('ZIP 자료: 게이트웨이가 받아 올리고 압축 풂', r?.j.status === 'ready' && upl?.path === '/home/daytona/work/m.zip' && upl.multipart
    && seen.execs.some((e) => e.command.includes('unzip -oq m.zip')), JSON.stringify(upl));
}
const stok = seen.creates.at(-1).body.env.OPENROUTER_API_KEY;
const sid = [...sbs.values()].find((s) => s.labels['gw-lab'] === short.j.lab.id)?.id;
const t0 = Date.now();
while (sbs.has(sid) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 1000));
check('끝나는 시각에 알람이 샌드박스 삭제', !sbs.has(sid), `${Math.round((Date.now() - t0) / 1000)}s`);
check('토큰도 무효', (await fetch(`${ALT}/p/openrouter/api/v1/key`, { headers: { authorization: `Bearer ${stok}` } })).status === 401);
let adm;
for (let i = 0; i < 20; i++) { // 삭제 뒤 세션 폐기(서브키 삭제)·감사 기록까지 끝나기를 기다린다
  adm = (await call('/api/admin/list', {}, ADM)).j;
  if (adm.audit.some((a) => a.event === 'lab-expire')) break;
  await new Promise((r) => setTimeout(r, 500));
}
const aud = adm.audit.map((a) => a.event);
check('감사 로그: 만들기·자리받기·입장·클립보드·끝내기·만료', ['lab-create', 'lab-claim', 'lab-join', 'lab-clip', 'lab-end', 'lab-expire'].every((e) => aud.includes(e)), aud.join(','));
check('남은 OpenRouter 세션 없음', !adm.sessions.some((s) => s.ip === 'lab'), JSON.stringify(adm.sessions));

console.log('\n# 코드 보내기 → 받은 코드 (강사 → 참가자, 원문 그대로)');
{
  failCreateAt = 0;
  const mk = async (name) => (await call('/api/lab/create', { ...base, name, seats: 1, materials: '' }, ADM)).j.lab;
  const LA = await mk('코드반A'), LB = await mk('코드반B');
  check('수업 2개 (자리 1개씩)', !!LA?.seats[0].sandboxId && !!LB?.seats[0].sandboxId);
  const CA = `lab_seat=${LA.seats[0].code}`, CB = `lab_seat=${LB.seats[0].code}`;
  const get = async (cookie, v = '') => {
    const r = await fetch(`${ALT}/__lab/snips?v=${encodeURIComponent(v)}`, cookie ? { headers: { cookie } } : {});
    return { status: r.status, j: r.status === 200 ? await r.json() : null };
  };
  const NO = { 'x-admin-token': 'nope' };
  check('관리 토큰 없으면 401 (보내기·목록·지우기)', (await call('/api/lab/snip', { id: LA.id, text: 'x' }, NO)).status === 401
    && (await call('/api/lab/snips', { id: LA.id }, NO)).status === 401 && (await call('/api/lab/snip-delete', { id: LA.id, snip: 'all' }, NO)).status === 401);
  check('자리 쿠키 없으면 401', (await get(null)).status === 401);
  check('없는 수업 404', (await call('/api/lab/snip', { id: 'nolab', text: 'x' }, ADM)).status === 404);
  let g = await get(CA);
  check('처음: 빈 목록 + 버전', g.status === 200 && g.j.items.length === 0 && typeof g.j.v === 'number', JSON.stringify(g));
  const v0 = g.j.v;
  check('버전이 같으면 204', (await get(CA, String(v0))).status === 204);
  const MARK = 'BODY-MARK-' + Math.random().toString(36).slice(2);
  const TEXT = `curl -fsSL https://example.com/x.sh | bash -s -- --name "a b" 'c'\n\tif (a < b && c > d) { echo $HOME \\\\ \`id\` }\r\n# 한글 주석 ${MARK}\n  </script><img src=x onerror=alert(1)>\n\n`;
  const add = await call('/api/lab/snip', { id: LA.id, text: TEXT, title: '  설치\n명령  ' }, ADM);
  check('보내기 200 → 새 버전 + 목록', add.status === 200 && add.j.v > v0 && add.j.items.length === 1 && add.j.items[0].title === '설치 명령', JSON.stringify(add.j).slice(0, 200));
  g = await get(CA, String(v0));
  check('참가자: 바뀌었으면 200 + 원문 그대로 (공백·탭·CRLF·따옴표·태그)', g.status === 200 && g.j.v === add.j.v && g.j.items[0].text === TEXT && g.j.items[0].id === add.j.items[0].id && typeof g.j.items[0].at === 'number');
  check('참가자: 새 버전으로 물으면 204', (await get(CA, String(g.j.v))).status === 204);
  check('다른 수업 자리 쿠키로는 그 수업 것만 (B 는 비어 있음)', (await get(CB)).j?.items.length === 0);
  await call('/api/lab/snip', { id: LB.id, text: 'B only' }, ADM);
  const gb = await get(CB), ga = await get(CA);
  check('B 에 보낸 건 B 에만', gb.j.items.length === 1 && gb.j.items[0].text === 'B only' && ga.j.items.length === 1 && ga.j.items[0].text === TEXT);
  check('제목 없으면 title 없음', !('title' in gb.j.items[0]));
  const st = async (b) => (await call('/api/lab/snip', { id: LA.id, ...b }, ADM)).status;
  check('길이 제한: 빈 본문·공백만·20001자·제목 61자 400', await st({ text: '' }) === 400 && await st({ text: ' \n\t ' }) === 400 && await st({ text: 'x'.repeat(20001) }) === 400
    && await st({ text: 'x', title: 'y'.repeat(61) }) === 400 && await st({}) === 400 && await st({ text: 123 }) === 400);
  check('20000자 · 제목 60자는 됨', await st({ text: 'z'.repeat(20000), title: 't'.repeat(60) }) === 200);
  for (let i = 1; i <= 31; i++) await call('/api/lab/snip', { id: LB.id, text: `n${i}` }, ADM);
  const lb = (await call('/api/lab/snips', { id: LB.id }, ADM)).j;
  check('30개 넘으면 오래된 것부터 버림 (최신이 앞)', lb.items.length === 30 && lb.items[0].text === 'n31' && lb.items[29].text === 'n2' && !lb.items.some((x) => x.text === 'B only'), JSON.stringify(lb.items.map((x) => x.text)));
  const la = (await call('/api/lab/snips', { id: LA.id }, ADM)).j;
  const vBefore = (await get(CA)).j.v;
  check('강사 목록 = 참가자 목록', la.items.length === 2 && la.v === vBefore);
  const del = await call('/api/lab/snip-delete', { id: LA.id, snip: la.items[0].id }, ADM);
  check('하나 지우기 → 버전 오름', del.status === 200 && del.j.v > vBefore && del.j.items.length === 1 && del.j.items[0].text === TEXT);
  g = await get(CA, String(vBefore));
  check('참가자에게 삭제 반영', g.status === 200 && g.j.items.length === 1 && g.j.items[0].text === TEXT);
  check('없는 항목 지우기 404', (await call('/api/lab/snip-delete', { id: LA.id, snip: 'nope' }, ADM)).status === 404);
  const all = await call('/api/lab/snip-delete', { id: LB.id, snip: 'all' }, ADM);
  check("snip:'all' 로 전부 지우기", all.status === 200 && all.j.items.length === 0 && (await get(CB)).j.items.length === 0);
  const au = (await call('/api/admin/list', {}, ADM)).j.audit;
  const sn = au.filter((a) => a.event === 'lab-snip');
  check('감사 로그 lab-snip: 제목·글자 수만, 본문 없음', sn.length >= 30 && sn.some((a) => a.detail.includes('"설치 명령"') && a.detail.includes(`${TEXT.length}자`))
    && !JSON.stringify(au).includes(MARK) && !JSON.stringify(au).includes('onerror') && au.some((a) => a.event === 'lab-snip-delete'), JSON.stringify(sn.slice(-2)));
  const js = await (await fetch(`${ALT}/__lab/snips.js`)).text();
  check('snips.js: 막대 버튼·10초 확인·복사, innerHTML 없음', js.includes('__labBarUI') && js.includes('/__lab/snips?v=') && js.includes('clipboard.writeText') && js.includes('10000') && !js.includes('innerHTML'));
  const lp = await (await fetch(`${GW}/lab`)).text();
  check('강사 화면: 코드 보내기 칸', lp.includes('📤 코드 보내기') && lp.includes('/api/lab/snip') && lp.includes('Ctrl+Enter'));
  check('끝내기', (await call('/api/lab/end', { id: LA.id }, ADM)).status === 200);
  check('끝낸 수업: 참가자 받은 코드 404 · 강사 목록 404', (await get(CA)).status === 404 && (await call('/api/lab/snips', { id: LA.id }, ADM)).status === 404);
  check('다른 수업은 그대로', (await get(CB)).status === 200);
  check('끝내기 B', (await call('/api/lab/end', { id: LB.id }, ADM)).status === 200);
}

dtSrv.close();
csSrv.close();
finish();
