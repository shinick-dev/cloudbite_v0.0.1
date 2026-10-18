import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 진짜 Daytona 2자리 + 진짜 Realtime SFU + 진짜 code-server: 강사 화면이 보기 창에 뜨는지, 버튼 겹침, 받은 코드 → 편집기·터미널 붙여넣기, 크게/숨김/PiP
// 실행: pwsh tools/realdev.ps1 -Test tools/real-screen.mjs  (진짜 Daytona 2자리를 만들고 끝나면 지운다 — 몇 분치 비용)
import { adminLogin, adminSetup, call, check, finish, GW, SoftKey } from '../test/lib.mjs';
import { chromium } from 'playwright-core'; // 설치된 Edge 로 (test/vault-browser.mjs 와 같은 방식)

const ALT = GW.replace('localhost', '127.0.0.1');
const DT = process.env.DAYTONA_API_KEY;
const RT = process.env.REALTIME_APP_TOKEN ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
check('REALTIME_APP_TOKEN 들어옴 (값은 출력 안 함)', RT.length > 10);

const KEY = new SoftKey();
let ADM = await adminSetup(KEY, process.env.SETUP_TOKEN);
const A = async (p, b) => { let r = await call(p, b, ADM); if (r.status === 401) { ADM = await adminLogin(KEY); r = await call(p, b, ADM); } return r; };
await A('/api/admin/provider', { preset: 'openrouter', value: process.env.OPENROUTER_MANAGEMENT_KEY });
await A('/api/admin/provider', { preset: 'daytona', value: DT });
const made = await A('/api/lab/create', { name: '화면공유 실점검', seats: 2, hours: 1, budget: 1, cpu: 1, memory: 2, disk: 5, gw: ALT, materials: '' });
check('수업 만들기 (진짜 Daytona 2자리)', made.status === 200 && made.j.lab.seats.every((s) => !s.error), JSON.stringify(made.j).slice(0, 300));
const lab = made.j.lab;

const FAKE_DISPLAY = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const g = cv.getContext('2d'); let n = 0;
    const draw = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, 1920, 1080); g.fillStyle = '#000'; g.font = '48px monospace'; g.fillText('강사 화면 ' + (n++), 40, 200); g.fillRect((n * 20) % 1800, 400, 120, 120); };
    draw(); setInterval(draw, 66);
    return cv.captureStream(15);
  };
};

let browser;
const errs = [];
try {
  for (const s of lab.seats) {
    const t0 = Date.now(); let st;
    while (Date.now() - t0 < 300e3) { const r = await call('/__lab/wake', { code: s.code }, { origin: ALT }, ALT); st = r.j?.status ?? r.status; if (st === 'ready' || r.status !== 200) break; }
    check(`자리 ${s.n ?? ''} ready`, st === 'ready', String(st));
  }
  const sb0 = await (await fetch(`https://app.daytona.io/api/sandbox/${lab.seats[0].sandboxId}`, { headers: { authorization: `Bearer ${DT}` } })).json();
  const sh = async (command) => {
    const r = await fetch(`${sb0.toolboxProxyUrl}/${sb0.id}/process/execute`, { method: 'POST', headers: { authorization: `Bearer ${DT}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: `bash -lc ${JSON.stringify(command)}`, timeout: 60 }) });
    return (await r.json()).result ?? '';
  };

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  // 강사
  const tctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await tctx.addInitScript(FAKE_DISPLAY);
  const tp = await tctx.newPage(); tp.on('dialog', (d) => d.accept());
  await tp.goto(`${GW}/lab`);
  await tp.evaluate(async (t) => { T = t; $('login').hidden = true; $('panel').hidden = false; LO = location.origin.replace('localhost', '127.0.0.1'); await load(); }, ADM['x-admin-token']);

  // 학생 둘 (진짜 code-server)
  const student = async (seat, name) => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ALT });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`[${name}] ${String(e).slice(0, 200)}`));
    pg.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to|TrustedHTML|__lab/.test(t)) errs.push(`[${name}] ${t.slice(0, 200)}`); });
    await pg.goto(`${ALT}/j/${seat.code}`);
    await pg.waitForSelector('.monaco-workbench', { timeout: 180e3 });
    await pg.waitForFunction(() => window.__labScreen && window.__labBarUI && window.__labSnips, null, { timeout: 30e3 });
    return pg;
  };
  const s1 = await student(lab.seats[0], 's1');
  const s2 = await student(lab.seats[1], 's2');
  check('진짜 code-server 에 bar·snips·screen·rtc 스크립트가 다 돎 (nonce/CSP 통과)', true);

  console.log('\n# 공유 시작 → 진짜 보기 창에 영상');
  await tp.click('button:has-text("🖥 화면 공유 시작")');
  await tp.waitForSelector('text=공유 중 ·', { timeout: 20000 }).catch(() => {});
  const win = (pg) => pg.evaluate(() => { const w = document.querySelector('[data-lab="screen"]'); const v = w && w.querySelector('video'); const r = w && w.getBoundingClientRect(); return { mode: window.__labScreen.mode, disp: w ? getComputedStyle(w).display : null, vw: v ? v.videoWidth : 0, frames: v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0, r: r && { x: r.x, y: r.y, w: r.width, h: r.height } }; });
  const waitWin = async (pg, pred, ms) => { const t0 = Date.now(); let x; while (Date.now() - t0 < ms) { x = await win(pg); if (pred(x)) return { ...x, dt: Date.now() - t0 }; await sleep(300); } return { ...x, dt: -1 }; };
  const [w1, w2] = await Promise.all([waitWin(s1, (x) => x.disp === 'flex' && x.vw > 0, 30e3), waitWin(s2, (x) => x.disp === 'flex' && x.vw > 0, 30e3)]);
  check(`학생1 보기 창 작은 창으로 뜸·영상 (${(w1.dt / 1000).toFixed(1)}초, ${w1.vw}px, ${JSON.stringify(w1.r)})`, w1.dt >= 0 && w1.mode === 'small', JSON.stringify(w1));
  check(`학생2 보기 창 뜸 (${(w2.dt / 1000).toFixed(1)}초)`, w2.dt >= 0, JSON.stringify(w2));
  const f0 = (await win(s1)).frames; await sleep(2000); const f1 = (await win(s1)).frames;
  check(`보기 창 프레임 진행 (${((f1 - f0) / 2).toFixed(1)}fps)`, f1 > f0);

  console.log('\n# 버튼 겹침');
  const lay = await s1.evaluate(() => {
    const U = window.__labBarUI; const kids = [...U.box.children].filter((e) => getComputedStyle(e).display !== 'none');
    const rs = kids.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 14), x: r.x, y: r.y, w: r.width, h: r.height }; });
    const ov = []; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) ov.push(a.t + '×' + b.t); }
    const box = U.box.getBoundingClientRect();
    const w = document.querySelector('[data-lab="screen"]').getBoundingClientRect();
    const hit = kids.filter((e) => e.textContent.trim()).filter((e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(top && (top === e || e.contains(top))); }).map((e) => e.textContent.trim().slice(0, 14));
    return { rs, ov, box: { x: box.x, y: box.y, w: box.width, h: box.height }, winBottom: w.bottom, covered: hit, vw: innerWidth };
  });
  console.log('  막대 버튼:', lay.rs.map((r) => `${r.t}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}w`).join(' | '));
  check('막대 버튼끼리 안 겹침 (📥·📺 포함)', !lay.ov.length && lay.rs.some((r) => r.t.startsWith('📥')) && lay.rs.some((r) => r.t.startsWith('📺')), JSON.stringify(lay.ov));
  check('작은 창이 막대를 가리지 않음 (창 아래 < 막대 위)', lay.winBottom <= lay.box.y && !lay.covered.length, `${lay.winBottom} ${lay.box.y} ${JSON.stringify(lay.covered)}`);
  check('막대가 화면 안 (가로 넘침 없음)', lay.box.x >= 0 && lay.box.x + lay.box.w <= lay.vw);
  await s1.screenshot({ path: join(tmpdir(), 'gw-shinick-real-s1-small.png') });

  console.log('\n# 크게 보기 / 숨김 / 따로 띄우기');
  await s1.evaluate(() => { window.__labScreen.mode = 'big'; });
  const big = await win(s1);
  const barOnTop = await s1.evaluate(() => { const b = [...window.__labBarUI.box.children].find((e) => e.textContent.includes('📥')); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!t && (t === b || b.contains(t)); });
  check('크게 보기: 화면 전체 + 막대는 위에서 눌림', big.mode === 'big' && big.r.w >= 1390 && big.r.h >= 890 && barOnTop, JSON.stringify(big));
  await s1.screenshot({ path: join(tmpdir(), 'gw-shinick-real-s1-big.png') });
  await s1.evaluate(() => { window.__labScreen.mode = 'hidden'; });
  check('숨김 → 창 없음, 📺 버튼 남음', (await win(s1)).disp === 'none' && await s1.isVisible('button:has-text("📺 강사 화면")'));
  await s1.click('button:has-text("📺 강사 화면")');
  check('📺 → 다시 열림', (await waitWin(s1, (x) => x.disp === 'flex', 3000)).dt >= 0);
  const hasDpip = await s1.evaluate(() => 'documentPictureInPicture' in window);
  await s1.evaluate(() => { window.__labScreen.mode = 'pip'; });
  await sleep(1500);
  const pm = await s1.evaluate(() => ({ mode: window.__labScreen.mode, dpip: !!(window.documentPictureInPicture && documentPictureInPicture.window), vpip: !!document.pictureInPictureElement }));
  console.log(`  따로 띄우기: documentPictureInPicture API ${hasDpip ? '있음' : '없음'} → ${JSON.stringify(pm)} (headless 라 창이 안 뜰 수 있음)`);
  await s1.evaluate(() => { window.__labScreen.mode = 'small'; });

  console.log('\n# 받은 코드 → 편집기·터미널 (밖으로 복사 허용 수업)');
  const PY = 'def hello(name):\n    if name:\n        return f"안녕 {name}"  # 들여쓰기·기호 유지\n    return {"a": [1, 2], \'b\': `x`}\n';
  const TERM = `printf '%s\\n' "snip ok $((6*7)) 한글" > /tmp/snip-term.txt`;
  check('강사: 코드 보내기 (파이썬)', (await A('/api/lab/snip', { id: lab.id, text: PY, title: '파이썬 예제' })).status === 200);
  check('강사: 코드 보내기 (터미널 명령)', (await A('/api/lab/snip', { id: lab.id, text: TERM, title: '터미널' })).status === 200);
  const tb = Date.now();
  await s1.waitForFunction(() => { const b = [...window.__labBarUI.box.children].find((e) => e.textContent.includes('📥')); return b && /2$/.test(b.textContent.trim()); }, null, { timeout: 25e3 }).catch(() => {});
  check(`📥 뱃지 2 (${((Date.now() - tb) / 1000).toFixed(1)}초)`, (Date.now() - tb) < 25e3);
  const copyItem = async (pg, title) => {
    await pg.click('button:has-text("📥 받은 코드")');
    const item = pg.locator('div', { has: pg.locator(`b[title="${title}"]`) }).last();
    await item.locator('button:has-text("복사")').first().click();
    await sleep(300);
    await pg.keyboard.press('Escape').catch(() => {});
    await pg.mouse.click(700, 300).catch(() => {});
  };
  // 편집기: 새 파일 → 붙여넣기
  await copyItem(s1, '파이썬 예제');
  const sys1 = await s1.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e));
  check('시스템 클립보드에 원문 그대로 (CRLF 무시 비교)', sys1.replace(/\r\n/g, '\n') === PY, JSON.stringify(sys1));
  const folder = new URL(s1.url()).searchParams.get('folder') || (await sh('echo $HOME')).trim();
  console.log('  작업 폴더:', folder);
  await sh(`: > ${folder}/paste_check.py`);
  await s1.keyboard.press('Control+p'); await sleep(800); await s1.keyboard.type('paste_check.py'); await sleep(1500); await s1.keyboard.press('Enter');
  await s1.waitForSelector('.editor-instance .monaco-editor .view-lines', { timeout: 20e3 });
  await sleep(1000);
  await s1.keyboard.press('Control+v'); await sleep(1500); await s1.keyboard.press('Control+s'); await sleep(1500);
  const ed1 = await sh(`cat ${folder}/paste_check.py`);
  check('편집기에 붙여넣고 저장: 들여쓰기·기호·한글 그대로 (파일 내용 비교)', ed1.replace(/\r\n/g, '\n').replace(/\s+$/, '') === PY.replace(/\s+$/, ''), JSON.stringify(ed1));
  await s1.screenshot({ path: join(tmpdir(), 'gw-shinick-real-s1-editor.png') });
  // 터미널
  await copyItem(s1, '터미널');
  await s1.keyboard.press('Control+Backquote');
  await s1.waitForSelector('.terminal-wrapper .xterm', { timeout: 30e3 }); await sleep(2500);
  await s1.click('.terminal-wrapper .xterm-screen');
  await s1.keyboard.press('Control+v'); await sleep(800); await s1.keyboard.press('Enter'); await sleep(2000);
  const out1 = (await sh('cat /tmp/snip-term.txt 2>&1')).trim();
  check('터미널에 붙여넣고 실행 → 결과 파일', out1 === 'snip ok 42 한글', JSON.stringify(out1));

  console.log('\n# 밖으로 복사 막은 수업 → 실습실 안 버퍼로 붙여넣기');
  check('강사: 밖으로 복사 막기', (await A('/api/lab/clip', { id: lab.id, in: true, out: false })).status === 200);
  await s1.evaluate(() => navigator.clipboard.writeText('OUTSIDE'));
  await s1.reload(); await s1.waitForSelector('.monaco-workbench', { timeout: 120e3 });
  await s1.waitForFunction(() => window.__labClip && window.__labClip.policy ? window.__labClip.policy.out === false : true, null, { timeout: 40e3 }).catch(() => {});
  await sleep(3000);
  const TERM2 = TERM.replace('snip-term', 'snip-term2');
  await A('/api/lab/snip', { id: lab.id, text: TERM2, title: '터미널2' });
  await s1.waitForFunction(() => document.body.innerText.includes('📥'), null, { timeout: 5e3 });
  await sleep(12e3);
  await copyItem(s1, '터미널2');
  await s1.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: GW });
  const outside = await s1.context().newPage(); await outside.goto(`${GW}/borrow`); await outside.bringToFront();
  const sys2 = await outside.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e)); // 실습실 밖(가드 없는) 페이지에서 본 진짜 PC 클립보드
  await outside.close(); await s1.bringToFront();
  console.log('  밖에서 본 클립보드:', JSON.stringify(sys2));
  check('시스템 클립보드로는 안 나감 (안내 문구만)', !sys2.includes('snip-term2') && sys2.includes('막혀'), JSON.stringify(sys2).slice(0, 80));
  await s1.keyboard.press('Control+Backquote').catch(() => {});
  await s1.waitForSelector('.terminal-wrapper .xterm', { timeout: 30e3 }).catch(() => {}); await sleep(2500);
  await s1.click('.terminal-wrapper .xterm-screen');
  await s1.keyboard.press('Control+v'); await sleep(800); await s1.keyboard.press('Enter'); await sleep(2000);
  const out2 = (await sh('cat /tmp/snip-term2.txt 2>&1')).trim();
  check('막힌 수업: 실습실 안 버퍼로 터미널 붙여넣기 → 실행', out2 === 'snip ok 42 한글', JSON.stringify(out2));
  await s1.screenshot({ path: join(tmpdir(), 'gw-shinick-real-s1-term.png') });

  console.log('\n# 공유 멈춤');
  await tp.click('button:has-text("🖥 화면 공유 멈추기")');
  const [x1, x2] = await Promise.all([waitWin(s1, (x) => x.disp === 'none', 25e3), waitWin(s2, (x) => x.disp === 'none', 25e3)]);
  check(`멈춤 → 두 학생 창 닫힘 (${(x1.dt / 1000).toFixed(1)}·${(x2.dt / 1000).toFixed(1)}초)`, x1.dt >= 0 && x2.dt >= 0);
  check('📺 버튼도 사라짐', !(await s2.isVisible('button:has-text("📺 강사 화면")')));
  console.log('  페이지 오류·CSP:', errs.length ? '\n    ' + errs.join('\n    ') : '없음');
  check('페이지 오류·CSP 위반 없음', !errs.length);
} catch (e) {
  check('예외 없음', false, String(e?.stack ?? e).slice(0, 800));
} finally {
  if (browser) await browser.close();
  ADM = await adminLogin(KEY);
  const end = await call('/api/lab/end', { id: lab.id }, ADM);
  check('수업 끝내기 (샌드박스·서브키 정리)', end.status === 200, JSON.stringify(end.j).slice(0, 200));
}
finish();
