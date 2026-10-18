// 강사 화면 공유 브라우저 점검 — 진짜 Cloudflare Realtime SFU.
// dev 게이트웨이(:8797)의 REALTIME_API 는 :8799/rtc → 여기서 진짜 SFU(rtc.live.cloudflare.com/v1)로 그대로 넘긴다 (Authorization 은 서버가 붙인 것을 전달만, 출력 안 함).
// 가짜 Daytona(:8799) + 가짜 code-server(:8800). 강사 /lab 의 getDisplayMedia 는 canvas.captureStream(움직이는 글자 + 시각 비트 블록)으로 바꾼다.
// 실행: pwsh tools/test-locked.ps1 -Test tools/rtc-browser.mjs  (REALTIME_APP_TOKEN User 환경변수 필요)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { adminSetup, call, check, finish, GW, SoftKey } from '../test/lib.mjs';
import { chromium } from 'playwright-core'; // 설치된 Edge 로 (test/vault-browser.mjs 와 같은 방식)

const ALT = GW.replace('localhost', '127.0.0.1');
const CS = 'http://127.0.0.1:8800';
const RT = process.env.REALTIME_APP_TOKEN ?? ''; // 비교용으로만
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
check('REALTIME_APP_TOKEN 이 잠금 실행기로 들어옴 (값은 출력 안 함)', RT.length > 10);

// ── 가짜 Daytona + SFU 중계 ──
const sbs = new Map();
const sfuLog = [];
const dtSrv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (u.pathname.startsWith('/rtc/')) {
    const t0 = Date.now();
    try {
      const r = await fetch('https://rtc.live.cloudflare.com/v1' + u.pathname.slice(4) + u.search, {
        method: req.method, body: raw.length ? raw : undefined,
        headers: { authorization: req.headers.authorization ?? '', ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}) },
      });
      const txt = await r.text();
      sfuLog.push({ method: req.method, path: u.pathname.replace(/^\/rtc\/apps\/\w+/, ''), status: r.status, ms: Date.now() - t0, err: r.ok ? '' : txt.slice(0, 200) });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      return res.end(txt);
    } catch (e) { sfuLog.push({ method: req.method, path: u.pathname, status: 0, err: String(e) }); return send(502, { errorCode: 'proxy', errorDescription: String(e) }); }
  }
  const body = raw.length ? JSON.parse(raw) : {};
  const p = u.pathname.split('/').filter(Boolean);
  if (req.method === 'POST' && u.pathname === '/sandbox') { const sb = { id: randomUUID(), state: 'started', labels: body.labels, organizationId: 'org-test' }; sbs.set(sb.id, sb); return send(200, sb); }
  if (req.method === 'GET' && u.pathname === '/sandbox') { const want = JSON.parse(u.searchParams.get('labels') ?? '{}'); return send(200, { items: [...sbs.values()].filter((s) => Object.entries(want).every(([k, v]) => s.labels?.[k] === v)) }); }
  if (u.pathname.startsWith('/organizations/')) return send(200, { regionUsage: [] });
  if (p[0] === 'sandbox' && p[1]) {
    const sb = sbs.get(p[1]);
    if (!sb) return send(404, { message: 'Sandbox not found' });
    if (req.method === 'DELETE') { sbs.delete(sb.id); return send(200, sb); }
    if (p[2] === 'ports') return send(200, { url: CS, token: `pv-${sb.id}` });
    return send(200, sb);
  }
  send(404, { message: 'mock' });
});
await new Promise((r) => dtSrv.listen(8799, r));
const csSrv = createServer((req, res) => {
  if (!String(req.headers['x-daytona-preview-token'] ?? '').startsWith('pv-')) { res.writeHead(401); return res.end('no token'); }
  if (req.url !== '/') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>fake code-server</title><script nonce="n0nce">1</script></head><body style="margin:0;background:#1e1e1e;height:100vh"></body></html>');
});
await new Promise((r) => csSrv.listen(8800, '127.0.0.1', r));

const ADM = await adminSetup(new SoftKey(), process.env.SETUP_TOKEN);
await call('/api/admin/provider', { preset: 'openrouter', value: process.env.OPENROUTER_MANAGEMENT_KEY }, ADM);
await call('/api/admin/provider', { preset: 'daytona', value: 'dt-test-key' }, ADM);
const LAB = (await call('/api/lab/create', { name: '화면공유반', seats: 3, hours: 1, budget: 1, cpu: 1, memory: 2, disk: 5, gw: ALT, materials: '' }, ADM)).j.lab;
check('수업 3자리 (학생 2 + 강사 보기 탭 1)', LAB?.seats.filter((s) => s.sandboxId).length === 3);

// 강사: 화면 = 1920x1080 canvas. 맨 위 24칸 = Date.now() 하위 24비트 (학생 쪽에서 읽어 지연을 잰다)
const FAKE_DISPLAY = () => {
  navigator.mediaDevices.getDisplayMedia = async (c) => {
    window.__gdm = c;
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const g = cv.getContext('2d'); let n = 0;
    const draw = () => {
      const t = Date.now();
      g.fillStyle = '#fff'; g.fillRect(0, 0, 1920, 1080);
      for (let i = 0; i < 24; i++) { g.fillStyle = (t >> (23 - i)) & 1 ? '#000' : '#fff'; g.fillRect(i * 64, 0, 64, 64); }
      g.fillStyle = '#000'; g.font = '40px monospace'; g.fillText('강사 화면 ' + (n++) + ' ' + new Date(t).toISOString(), 40, 160);
      for (let y = 240; y < 1080; y += 36) g.fillText('const line' + y + ' = "글자 읽기 테스트 ' + n + '";', 40 + (n % 20), y);
    };
    draw(); setInterval(draw, 66);
    return cv.captureStream(15);
  };
};
// 학생: 강사 화면 보기 창 대신 기록용 가짜 (__labScreen.attach → video)
const FAKE_SCREEN = () => {
  window.__rec = [];
  window.__labScreen = { attach(s, info) {
    let v = window.__vid;
    if (!v) { v = window.__vid = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;z-index:9'; }
    if (!v.isConnected) (document.body || document.documentElement).append(v);
    v.srcObject = s; if (s) v.play().catch(() => {});
    window.__rec.push({ t: Date.now(), on: !!s, title: info && info.title });
  } };
  // 받은 프레임의 맨 위 비트 블록 → 강사 쪽 시각. 지연(ms) = 지금 - 그 시각
  window.__lag = () => {
    const v = window.__vid; if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    const k = v.videoWidth / 1920; let t = 0;
    for (let i = 0; i < 24; i++) { const d = g.getImageData(Math.floor((i * 64 + 32) * k), Math.floor(32 * k), 1, 1).data; t = t * 2 + (d[0] < 128 ? 1 : 0); }
    return ((Date.now() & 0xffffff) - t + 0x1000000) % 0x1000000;
  };
};

const bodies = []; // 브라우저가 받은 화면 공유 관련 응답 — 앱 비밀이 없어야 한다
const pulls = new Map();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const watchResp = (pg, name) => {
    pg.on('pageerror', (e) => console.log(`  [${name}] pageerror`, String(e).slice(0, 200)));
    pg.on('request', (r) => { if (r.url().includes('/__lab/screen/pull')) pulls.set(name, (pulls.get(name) ?? 0) + 1); });
    pg.on('response', async (r) => { if (/\/__lab\/screen|\/api\/lab\/screen|\/__lab\/rtc\.js/.test(r.url())) { try { bodies.push(await r.text()); } catch {} } });
  };
  const student = async (seat, name, watch) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(FAKE_SCREEN);
    if (watch) await ctx.addInitScript(() => { try { sessionStorage.setItem('labWatch', '1'); } catch {} });
    const pg = await ctx.newPage(); watchResp(pg, name);
    await pg.goto(`${ALT}/__lab/enter/${seat.code}`);
    if (!(await pg.evaluate(() => document.title)).includes('fake')) { await ctx.addCookies([{ name: 'lab_seat', value: seat.code, url: ALT }]); await pg.goto(`${ALT}/`); }
    await pg.waitForFunction(() => !!window.__labRtc || !!document.querySelector('script[src="/__lab/rtc.js"]'), null, { timeout: 15000 });
    return pg;
  };
  const got = (pg) => pg.evaluate(() => { const v = window.__vid, r = window.__rec.at(-1); const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0; return { on: !!(r && r.on), n: window.__rec.length, title: r && r.title, w: v ? v.videoWidth : 0, h: v ? v.videoHeight : 0, frames: q }; });
  const waitFor = async (pg, pred, ms) => { const t0 = Date.now(); let x; while (Date.now() - t0 < ms) { x = await got(pg); if (pred(x)) return { ...x, dt: Date.now() - t0 }; await sleep(250); } return { ...x, dt: -1 }; };
  const moving = async (pg) => { const a = (await got(pg)).frames; await sleep(1500); const b = await got(pg); return { ok: b.frames > a, fps: (b.frames - a) / 1.5 }; };
  const lagOf = async (pg) => { const xs = []; for (let i = 0; i < 7; i++) { const l = await pg.evaluate(() => window.__lag()); if (l != null && l < 60000) xs.push(l); await sleep(300); } xs.sort((a, b) => a - b); return xs.length ? xs[Math.floor(xs.length / 2)] : null; };

  // 강사
  const tctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await tctx.addInitScript(FAKE_DISPLAY);
  const tp = await tctx.newPage(); watchResp(tp, 'teacher');
  tp.on('dialog', (d) => d.accept());
  await tp.goto(`${GW}/lab`);
  await tp.evaluate(async (t) => { T = t; $('login').hidden = true; $('panel').hidden = false; LO = location.origin.replace('localhost', '127.0.0.1'); await load(); }, ADM['x-admin-token']);
  check('강사 수업 카드에 🖥 화면 공유 시작', await tp.isVisible('button:has-text("🖥 화면 공유 시작")'));

  const s1 = await student(LAB.seats[0], 's1');
  const s2 = await student(LAB.seats[1], 's2');
  const s3 = await student(LAB.seats[2], 'watch', true);
  await sleep(1500);
  check('공유 전: 학생에게 attach 없음', (await got(s1)).n === 0 && (await got(s2)).n === 0);

  console.log('\n# 시작 → 학생 둘 다 받음');
  const t0 = Date.now();
  await tp.click('button:has-text("🖥 화면 공유 시작")');
  await tp.waitForSelector('text=공유 중 ·', { timeout: 20000 }).catch(() => {});
  const tStart = Date.now() - t0;
  const gdm = await tp.evaluate(() => window.__gdm);
  check('getDisplayMedia 제약: 15fps 이하·1920 이하·소리 없음', gdm?.video?.frameRate?.max === 15 && gdm.video.width?.max === 1920 && gdm.audio === false, JSON.stringify(gdm));
  check(`강사: "공유 중" + 멈추기 버튼 (${tStart}ms)`, await tp.isVisible('button:has-text("🖥 화면 공유 멈추기")') && (await tp.textContent('body')).includes('이 탭을 닫으면 공유가 끊깁니다'), (await tp.textContent('#msg')) ?? '');
  const snd = await tp.evaluate(async () => { const id = Object.keys(SH)[0]; const pc = SH[id].pc; const sd = pc.getSenders()[0]; const p = sd.getParameters(); return { hint: sd.track.contentHint, maxBitrate: p.encodings[0].maxBitrate, maxFramerate: p.encodings[0].maxFramerate, deg: p.degradationPreference ?? null, dir: pc.getTransceivers()[0].direction }; });
  check('강사 송신: contentHint text · 2.5Mbps · 15fps · sendonly', snd.hint === 'text' && snd.maxBitrate === 2500000 && snd.maxFramerate === 15 && snd.dir === 'sendonly', JSON.stringify(snd));
  console.log('  degradationPreference =', snd.deg);
  const [g1, g2] = await Promise.all([waitFor(s1, (x) => x.on && x.w > 0 && x.frames > 0, 30000), waitFor(s2, (x) => x.on && x.w > 0 && x.frames > 0, 30000)]);
  check(`학생1 영상 받음 (시작 후 ${((g1.dt + tStart) / 1000).toFixed(1)}초, ${g1.w}x${g1.h}, title=${g1.title})`, g1.dt >= 0 && g1.title === '강사 화면', JSON.stringify(g1));
  check(`학생2 영상 받음 (시작 후 ${((g2.dt + tStart) / 1000).toFixed(1)}초, ${g2.w}x${g2.h})`, g2.dt >= 0, JSON.stringify(g2));
  await sleep(4000);
  const m1 = await moving(s1), m2 = await moving(s2);
  check(`프레임 진행 (학생1 ${m1.fps.toFixed(1)}fps · 학생2 ${m2.fps.toFixed(1)}fps)`, m1.ok && m2.ok);
  const r1 = await got(s1);
  console.log(`  4초 뒤 해상도: 학생1 ${r1.w}x${r1.h} · 학생2 ${(await got(s2)).w}x${(await got(s2)).h}`);
  const l1 = await lagOf(s1), l2 = await lagOf(s2);
  console.log(`  화면→화면 지연(중앙값): 학생1 ${l1}ms · 학생2 ${l2}ms`);
  check('지연 측정됨 (2초 미만)', l1 != null && l1 < 2000 && l2 != null && l2 < 2000, `${l1} ${l2}`);
  const tstats = await tp.evaluate(async () => { const pc = SH[Object.keys(SH)[0]].pc; let o = {}; (await pc.getStats()).forEach((x) => { if (x.type === 'outbound-rtp' && x.kind === 'video') o = { w: x.frameWidth, h: x.frameHeight, fps: x.framesPerSecond, kbps: null, bytes: x.bytesSent, lim: x.qualityLimitationReason, enc: x.encoderImplementation }; }); return o; });
  console.log('  강사 송신 통계:', JSON.stringify(tstats));

  console.log('\n# 강사 멈춤 → 학생 둘 다 attach(null)');
  const t1 = Date.now();
  await tp.click('button:has-text("🖥 화면 공유 멈추기")');
  const [o1, o2] = await Promise.all([waitFor(s1, (x) => !x.on && x.n >= 2, 20000), waitFor(s2, (x) => !x.on && x.n >= 2, 20000)]);
  check(`멈춤 → 학생1 attach(null) (${(o1.dt / 1000).toFixed(1)}초)`, o1.dt >= 0, JSON.stringify(o1));
  check(`멈춤 → 학생2 attach(null) (${(o2.dt / 1000).toFixed(1)}초)`, o2.dt >= 0, JSON.stringify(o2));
  await tp.waitForSelector('button:has-text("🖥 화면 공유 시작")', { timeout: 5000 }).catch(() => {});
  check('강사 버튼이 다시 "시작"', await tp.isVisible('button:has-text("🖥 화면 공유 시작")'));

  console.log('\n# 다시 시작 → 다시 받음');
  const t2 = Date.now();
  await tp.click('button:has-text("🖥 화면 공유 시작")');
  const [a1, a2] = await Promise.all([waitFor(s1, (x) => x.on && x.w > 0 && x.n >= 3, 30000), waitFor(s2, (x) => x.on && x.w > 0 && x.n >= 3, 30000)]);
  check(`다시 시작 → 학생1 받음 (${((Date.now() - t2) / 1000).toFixed(1)}초 안)`, a1.dt >= 0, JSON.stringify(a1));
  check('다시 시작 → 학생2 받음', a2.dt >= 0, JSON.stringify(a2));
  await sleep(1500);
  check('다시 받은 영상도 프레임 진행', (await moving(s1)).ok && (await moving(s2)).ok);

  console.log('\n# 학생 새로고침 → 다시 받음');
  const t3 = Date.now();
  await s1.reload();
  const rr = await waitFor(s1, (x) => x.on && x.w > 0 && x.frames > 0, 30000);
  check(`새로고침 후 다시 받음 (${((Date.now() - t3) / 1000).toFixed(1)}초, ${rr.w}x${rr.h})`, rr.dt >= 0, JSON.stringify(rr));
  check('새로고침 후 프레임 진행', (await moving(s1)).ok);

  console.log('\n# 강사 보기 탭 · 비밀');
  check('강사 "들어가 보기" 탭(labWatch)은 pull 안 함·attach 없음', !pulls.get('watch') && (await got(s3)).n === 0, JSON.stringify([...pulls]));
  check('학생 탭은 pull 함', (pulls.get('s1') ?? 0) >= 2 && (pulls.get('s2') ?? 0) >= 2, JSON.stringify([...pulls]));
  check('브라우저가 받은 화면 공유 응답 어디에도 앱 비밀 없음', bodies.length > 5 && bodies.every((b) => !b.includes(RT)) && !bodies.some((b) => /bearer/i.test(b)), String(bodies.length));
  // tracks/close 는 강사 PC 를 먼저 닫은 뒤라 410(session disconnected)이 정상 — 서버는 기다리지 않고 시도만
  const sfuBad = sfuLog.filter((x) => (x.status >= 400 || x.status === 0) && !(x.path.endsWith('/tracks/close') && x.status === 410));
  console.log('  SFU 호출:', sfuLog.map((x) => `${x.method} ${x.path.replace(/sessions\/[\w-]+/, 'sessions/…')} ${x.status} ${x.ms}ms`).join(' | '));
  const tStop = await (async () => { const t = Date.now(); await tp.click('button:has-text("🖥 화면 공유 멈추기")'); await tp.waitForSelector('button:has-text("🖥 화면 공유 시작")', { timeout: 10000 }).catch(() => {}); return Date.now() - t; })();
  check(`멈춤 버튼 → 강사 화면 복귀 ${tStop}ms (SFU 닫기를 기다리지 않음)`, tStop < 2500);
  await tp.click('button:has-text("🖥 화면 공유 시작")');
  await tp.waitForSelector('text=공유 중 ·', { timeout: 20000 }).catch(() => {});
  check('진짜 SFU 호출 전부 성공 (tracks/close 410 제외)', sfuLog.length >= 8 && !sfuBad.length, JSON.stringify(sfuBad));

  await tp.click('button:has-text("🖥 화면 공유 멈추기")');
  await waitFor(s1, (x) => !x.on, 20000);
} catch (e) {
  check('예외 없이 끝남', false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser?.close();
  check('수업 끝내기', (await call('/api/lab/end', { id: LAB.id }, ADM)).status === 200);
  dtSrv.close(); csSrv.close();
}
finish();
