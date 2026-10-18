// Selected-support observation fixture. Fake peers only — Aside cannot inject an RTC peer, clock, or consent server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { LAB_LIVE_TEACHER_JS } from '../src/lablive.ts';

const artifact = path.resolve('C:/Users/user/source/.artifacts/operator-ux-audit-20261016/support-ui');
await mkdir(artifact, { recursive: true });
const state = { requests: [], failRelease: false, holdRequest: null, control: null, sharing: { a1: false, a2: false, a3: false, b1: true } };
const html = `<!doctype html><meta charset="utf-8"><style>body{font:16px/1.5 system-ui;margin:16px;background:#f7f7f5;color:#1c1c1a}main{max-width:1200px;margin:auto}.row{display:flex;gap:8px;flex-wrap:wrap}.lab-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}.lab-live-seat{min-width:0}.mut{color:#6b6b66}button{font:inherit}textarea{max-width:100%}</style><main><div id="root"></div></main><script>
window.__pcs=[];
window.RTCPeerConnection=class{constructor(){this.connectionState='new';this.localDescription={sdp:'fixture'};window.__pcs.push(this)}async createAnswer(){return{type:'answer',sdp:'fixture'}}async setRemoteDescription(){}async setLocalDescription(d){this.localDescription=d}close(){this.closed=true;this.connectionState='closed'}async getStats(){return new Map()}};
${LAB_LIVE_TEACHER_JS}
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;b.onclick=fn;return b};
window.ui=createLabLiveTeacher({root:document.getElementById('root'),btn,screenRow:()=>document.createElement('div'),call:async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||'HTTP '+r.status),{status:r.status});return j}});
</script>`;
function seat(id, n, sharing, control) {
  return { n, who: '사람' + n, v: n, sharing, capable: sharing, width: sharing ? 1280 : 0, height: sharing ? 800 : 0, quality: sharing ? 'preview' : null, control };
}
function statusBody() {
  const on = state.sharing;
  return { now: Date.now(), expiresAt: Date.now() + 3600000, labs: [
    { id: 'a', name: '가 모임', seats: [seat('a', 1, on.a1, null), seat('a', 2, on.a2, null), seat('a', 3, on.a3, null)] },
    { id: 'b', name: '나 모임', seats: [seat('b', 1, on.b1, state.control)] },
  ] };
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html); return; }
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}'), action = req.url.split('/').at(-1);
  state.requests.push({ action, body });
  if (action === 'request' && state.holdRequest) await state.holdRequest;
  let result = action === 'pull' ? { sid: 'sid', sdp: 'fixture' } : { ok: true }, status = 200;
  if (action === 'release' && state.failRelease) { status = 500; result = { error: 'release failed' }; }
  else if (action === 'status') result = statusBody();
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const visibleButtons = seat => seat.locator('button').evaluateAll(nodes => nodes.filter(n => {
  for (let p = n; p; p = p.parentElement) { if (p.hidden || (p.tagName === 'DETAILS' && !p.open)) return false; }
  const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && n.getClientRects().length > 0;
}).map(n => n.textContent));
try {
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => ui.start());
  await page.locator('[data-live-room="a"]').waitFor();
  await page.locator('[data-live-room="b"]').waitFor();
  assert.equal(await page.locator('[data-live-room="a"]').isVisible(), true);
  assert.equal(await page.locator('[data-live-room="b"]').isVisible(), true, 'no setRoom keeps every live room');
  await page.evaluate(() => ui.setMetadata([
    { id: 'a', name: '<b>주입</b>', seats: [
      { n: 1, who: '<img src=x onerror=alert(1)>', presence: { state: 'none' }, preparation: { state: 'ready' }, delivery: { status: 'unknown', at: null } },
      { n: 2, who: '오프라인', presence: { state: 'offline', lastSeen: Date.now() - 60000 }, opened: Date.now() - 3600000 },
      { n: 3, who: '접속', presence: { state: 'active' }, opened: Date.now() - 1000, preparation: { state: 'ready', at: Date.now() } },
    ] },
    { id: 'b', seats: [{ n: 1, who: '지원', presence: { state: 'active' }, opened: Date.now() - 1000 }] },
  ]));
  const one = page.locator('[data-live-seat="1"]').first();
  const two = page.locator('[data-live-room="a"] [data-live-seat="2"]');
  const three = page.locator('[data-live-room="a"] [data-live-seat="3"]');
  await page.waitForFunction(() => document.querySelector('[data-live-room="a"] [data-live-seat="1"] [data-live-state]').textContent.includes('입장 전'));
  assert.equal((await one.locator('[data-live-state]').innerText()).includes('현재 오프라인'), false);
  assert.ok((await two.locator('[data-live-state]').innerText()).includes('현재 오프라인'));
  assert.equal((await two.locator('[data-live-state]').innerText()).includes('입장 전'), false);
  assert.ok((await three.locator('[data-live-state]').innerText()).includes('화면 연결 대기'));
  assert.equal((await three.innerText()).includes('학습'), false);
  assert.equal(await one.locator('img').count(), 0);
  assert.ok((await one.locator('h3').innerText()).includes('<img src=x onerror=alert(1)>'));
  assert.ok((await one.locator('[data-live-prep]').textContent()).includes('서버 준비 확인 안 됨'));
  assert.equal((await one.locator('[data-live-prep]').textContent()).includes('마지막 서버 준비 확인'), false);
  assert.ok((await one.locator('[data-live-delivery]').textContent()).includes('결과 확인 필요'));
  assert.ok((await one.locator('[data-live-spend]').textContent()).includes('사용액 확인 안 됨'));
  assert.equal((await one.locator('[data-live-spend]').textContent()).includes('$0.00'), false);
  for (const card of [one, two, three]) {
    assert.equal(await card.locator('video').evaluate(v => v.hidden), true);
    assert.equal(await card.locator('video').evaluate(v => v.getBoundingClientRect().height), 0);
    assert.deepEqual(await visibleButtons(card), ['도와주기']);
  }
  const before = state.requests.filter(x => x.action === 'request').length;
  await one.getByRole('button', { name: '도와주기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-live-room="a"] [data-live-seat="1"]').dataset.mode === 'support');
  assert.equal(state.requests.filter(x => x.action === 'request').length, before, '도와주기 must not request control');
  assert.equal(await one.getByRole('button', { name: '제어 요청', exact: true }).isVisible(), true);
  assert.equal(await one.locator('form').isVisible(), false);
  assert.equal(await one.locator('[data-live-consent]').innerText(), '제어 없음 · 제어 요청은 참여자 허용이 있어야 시작합니다');
  await page.screenshot({ path: path.join(artifact, 'support-desktop.png'), fullPage: true });
  await one.getByRole('button', { name: '지원 닫기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-live-room="a"] [data-live-seat="1"]').dataset.mode === 'watch');

  state.requests.length = 0;
  state.sharing = { a1: false, a2: false, a3: false, b1: true };
  await page.evaluate(() => ui.setRoom('b'));
  await page.waitForFunction(() => document.querySelector('[data-live-room="a"]').hidden && !document.querySelector('[data-live-room="b"]').hidden);
  await page.waitForFunction(() => window.__pcs.some(pc => !pc.closed));
  assert.ok(state.requests.filter(x => x.action === 'pull').every(x => x.body.id === 'b'));
  assert.equal(state.requests.some(x => x.action === 'pull' && x.body.id === 'a'), false);
  await page.evaluate(() => { window.__roomDetail = null; document.addEventListener('lab-live-room', e => { window.__roomDetail = e.detail; }, { once: true }); });
  await page.evaluate(() => ui.selectSeat('a', 2));
  assert.deepEqual(await page.evaluate(() => window.__roomDetail), { id: 'a' });
  await page.waitForFunction(() => document.querySelector('[data-live-room="a"] [data-live-seat="2"]').dataset.mode === 'support');
  assert.equal(await page.locator('[data-live-room="b"]').evaluate(n => n.hidden), true);
  await page.waitForFunction(() => window.__pcs.every(pc => pc.closed));
  assert.equal(await page.evaluate(() => window.__pcs.filter(pc => !pc.closed).length), 0, 'hidden room must drop receive connections');

  await page.evaluate(() => ui.end());
  state.requests.length = 0;
  state.sharing.b1 = true;
  state.control = { state: 'active', requestId: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 300000 };
  await page.evaluate(() => { ui.setRoom('b'); ui.start(); });
  await page.waitForFunction(() => document.querySelector('[data-live-consent]')?.dataset.kind === 'active' || document.querySelector('.lab-live-endbar') && !document.querySelector('.lab-live-endbar').hidden);
  const endVisible = await page.getByRole('button', { name: '제어 끝내기', exact: true }).isVisible();
  assert.equal(endVisible, true);
  await page.evaluate(() => ui.setMetadata([{ id: 'b', seats: [{ n: 1, who: '지원', presence: { state: 'offline', lastSeen: Date.now() - 10000 }, opened: Date.now() - 10000 }] }]));
  state.sharing.b1 = false; state.control = null;
  await page.evaluate(() => ui.setRoom('b'));
  await page.waitForFunction(() => document.querySelector('[data-live-room="b"] [data-live-state]').textContent.includes('현재 오프라인'));
  assert.equal((await page.locator('[data-live-room="b"] [data-live-state]').innerText()).includes('입장 전'), false);
  assert.equal(await page.getByRole('button', { name: '제어 끝내기', exact: true }).isVisible(), true, 'source loss keeps a terminate action');
  assert.equal(await page.locator('[data-live-room="b"] video').evaluate(v => v.getBoundingClientRect().height), 0);

  state.failRelease = true;
  state.requests.length = 0;
  await page.evaluate(() => ui.setRoom('a'));
  await page.locator('[data-live-room="a"] [data-live-seat="3"]').getByRole('button', { name: '도와주기', exact: true }).click();
  await page.getByRole('button', { name: '종료 다시 확인', exact: true }).waitFor();
  assert.ok((await page.locator('.lab-live-endbar').innerText()).includes('다른 참여자 제어를 시작하지 않습니다'));
  assert.ok(state.requests.some(x => x.action === 'release' && x.body.id === 'b'));
  assert.equal(state.requests.some(x => x.action === 'request'), false);
  const ask = page.locator('[data-live-room="a"] [data-live-seat="3"]').getByRole('button', { name: '제어 요청', exact: true });
  assert.equal(await ask.isEnabled(), false, 'uncertain release must not enable another participant');
  await ask.click({ force: true });
  await page.waitForTimeout(200);
  assert.equal(state.requests.some(x => x.action === 'request'), false);

  state.failRelease = false;
  await page.getByRole('button', { name: '종료 다시 확인', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.lab-live-endbar') || document.querySelector('.lab-live-endbar').hidden);
  state.sharing.a3 = true;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-live-room="a"] [data-live-seat="3"] button')].some(x => x.textContent === '제어 요청' && !x.disabled));
  let held; state.holdRequest = new Promise(r => { held = r; });
  const sent = state.requests.filter(x => x.action === 'request').length;
  await page.locator('[data-live-room="a"] [data-live-seat="3"]').getByRole('button', { name: '제어 요청', exact: true }).click();
  for (let i = 0; i < 40 && state.requests.filter(x => x.action === 'request').length === sent; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(state.requests.filter(x => x.action === 'request').length, sent + 1, 'request reached the fixture before support closed');
  await page.locator('[data-live-room="a"] [data-live-seat="3"]').getByRole('button', { name: '지원 닫기', exact: true }).click();
  held(); state.holdRequest = null;
  for (let i = 0; i < 40 && !state.requests.some(x => x.action === 'release' && x.body.n === 3); i++) await new Promise(r => setTimeout(r, 50));
  const reqs = state.requests.filter(x => x.action === 'request' || x.action === 'release');
  assert.ok(reqs.some(x => x.action === 'request' && x.body.n === 3));
  assert.ok(reqs.some(x => x.action === 'release' && x.body.requestId && x.body.requestId === reqs.find(r => r.action === 'request')?.body.requestId), 'stale consent request is released');
  assert.equal(await page.locator('[data-live-room="a"] [data-live-seat="3"]').evaluate(n => n.dataset.control), 'none');

  await page.evaluate(() => ui.setRoom('missing'));
  await page.waitForFunction(() => document.querySelector('[data-live-empty]')?.textContent.includes('다른 모임에는 연결하지 않습니다'));
  const pulls = state.requests.filter(x => x.action === 'pull').length;
  await page.waitForTimeout(200);
  assert.equal(state.requests.filter(x => x.action === 'pull').length, pulls);
  await page.screenshot({ path: path.join(artifact, 'support-empty.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  state.sharing = { a1: false, a2: false, a3: false, b1: false };
  await page.evaluate(() => {
    ui.setMetadata([
      { id: 'a', seats: [
        { n: 1, who: '사람1', presence: { state: 'none' }, preparation: { state: 'ready' }, delivery: { status: 'unknown', at: null } },
        { n: 2, who: '오프라인', presence: { state: 'offline', lastSeen: Date.now() - 60000 }, opened: Date.now() - 3600000 },
        { n: 3, who: '접속', presence: { state: 'active' }, opened: Date.now() - 1000, preparation: { state: 'ready', at: Date.now() } },
      ] },
    ]);
    ui.setRoom('a');
  });
  await page.locator('[data-live-room="a"]').waitFor();
  await page.waitForFunction(() => {
    const room = document.querySelector('[data-live-room="a"]');
    const videos = [...room.querySelectorAll('video')];
    return videos.length === 3 && videos.every(v => v.hidden) && room.querySelector('[data-live-seat="1"] [data-live-state]').textContent.includes('입장 전');
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(artifact, 'support-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS support observation: metadata states, no implicit control, room isolation, terminate survives source loss');
} finally {
  state.holdRequest = null;
  await browser.close();
  await new Promise(r => server.close(r));
}
