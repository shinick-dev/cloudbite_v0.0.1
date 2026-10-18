// Automatic help-open fixture. Fake peers only — Aside cannot inject an RTC peer, clock, or consent server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { LAB_LIVE_TEACHER_JS } from '../src/lablive.ts';

const state = { requests: [], failRelease: false, hold: null, control: null };
const html = `<!doctype html><meta charset="utf-8"><style>body{font:16px/1.5 system-ui;margin:16px;background:#f7f7f5;color:#1c1c1a}main{max-width:1200px;margin:auto}#stage{min-height:40px}.lab-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}.lab-live-seat{min-width:0}.mut{color:#6b6b66}button{font:inherit}textarea{max-width:100%}</style><main><textarea id="editor"></textarea><div id="stage"></div><div id="root"></div></main><script>
window.__pcs=[];window.__auto=true;window.__focuses=[];window.__queues=[];window.__scrolls=0;
const origScroll=Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView=function(...args){window.__scrolls++;return origScroll.apply(this,args)};
window.RTCPeerConnection=class{constructor(){this.connectionState='new';this.localDescription={sdp:'fixture'};window.__pcs.push(this)}async createAnswer(){return{type:'answer',sdp:'fixture'}}async setRemoteDescription(){}async setLocalDescription(d){this.localDescription=d}close(){this.closed=true;this.connectionState='closed'}async getStats(){return new Map()}};
${LAB_LIVE_TEACHER_JS}
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;b.onclick=fn;return b};
window.ui=createLabLiveTeacher({
  root:document.getElementById('root'),
  stage:document.getElementById('stage'),
  btn,
  screenRow:()=>document.createElement('div'),
  canAutoOpen:()=>window.__auto!==false,
  onFocus:value=>{window.__focuses.push(value)},
  onHelpQueue:count=>{window.__queues.push(count);window.__queue=count},
  call:async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||'HTTP '+r.status),{status:r.status});return j}
});
</script>`;
function seat(id, n, who) {
  const selected = state.control && state.control.id === id && state.control.n === n;
  return { n, who, v: n, sharing: false, capable: false, width: 0, height: 0, quality: null, control: selected ? { state: 'active', requestId: state.control.requestId, expiresAt: Date.now() + 300000 } : null };
}
function statusBody() {
  return { now: Date.now(), expiresAt: Date.now() + 3600000, labs: [
    { id: 'a', name: '가 모임', seats: [seat('a', 1, '사람1'), seat('a', 2, '사람2'), seat('a', 3, '사람3')] },
    { id: 'b', name: '나 모임', seats: [seat('b', 1, '사람B')] },
  ] };
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html); return; }
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw || '{}'), action = req.url.split('/').at(-1);
  state.requests.push({ action, body });
  if(action==='release'&&state.releaseHold)await state.releaseHold;
  let result = action === 'pull' ? { sid: 'sid', sdp: 'fixture' } : { ok: true }, status = 200;
  if (action === 'release' && state.failRelease) { status = 500; result = { error: 'release failed' }; }
  else if (action === 'status') { if (state.hold) await state.hold; result = statusBody(); }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let releaseStatus = () => {};
state.hold = new Promise(r => { releaseStatus = r; });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const requests = action => state.requests.filter(x => x.action === action);
async function meta(labs) { await page.evaluate(labs => ui.setMetadata(labs), labs); }
async function focusOf() { return page.evaluate(() => ui.getFocus()); }
async function queueOf() { return page.evaluate(() => window.__queue ?? 0); }
function lab(id, seats) { return { id, seats }; }
function person(n, who, hand) { const seat = { n, who }; if (hand !== undefined) seat.hand = hand; return seat; }
try {
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => ui.setRoom('a'));
  await meta([lab('a', [person(3, 'My choice', 1000)])]);
  assert.equal(await focusOf(), null, 'workspace not running does not auto-open');
  assert.equal(requests('request').length, 0);
  await page.evaluate(() => ui.start());
  await meta([lab('a', [person(3, 'My choice', 1000)])]);
  assert.equal(await focusOf(), null, 'initial snapshot after room selection is baseline');
  const baselineEvents = await page.evaluate(() => window.__focuses.length);
  await meta([lab('a', [person(3, 'My choice', 1000)])]);
  assert.equal(await focusOf(), null, 'same timestamp is not a new hand');
  assert.equal(await page.evaluate(() => window.__focuses.length), baselineEvents);

  const opened = await page.evaluate(() => {
    const editor = document.getElementById('editor');
    editor.focus();
    const scrolls = window.__scrolls;
    ui.setMetadata([{ id: 'a', seats: [{ n: 3, who: 'My choice', hand: 2000 }] }]);
    const video = document.querySelector('[data-live-seat="3"] video');
    return {
      active: document.activeElement && document.activeElement.id,
      video: document.activeElement === video,
      title: document.activeElement && document.activeElement.tagName,
      scrolls: window.__scrolls - scrolls,
      focus: ui.getFocus(),
      mode: document.querySelector('[data-live-seat="3"]').dataset.mode,
      inStage: document.querySelector('#stage [data-live-seat="3"]') !== null,
      titleText: document.querySelector('[data-live-seat="3"] h3').textContent,
      wait: document.querySelector('[data-live-seat="3"] [data-live-wait]').textContent,
      waitHidden: document.querySelector('[data-live-seat="3"] [data-live-wait]').hidden,
      videoHidden: video.hidden,
      requestDisabled: [...document.querySelectorAll('[data-live-seat="3"] button')].find(b => b.textContent === '제어 요청').disabled,
      progress: document.querySelector('[data-live-seat="3"] [data-live-progress]').textContent,
    };
  });
  assert.equal(opened.active, 'editor');
  assert.equal(opened.video, false);
  assert.notEqual(opened.title, 'H3');
  assert.equal(opened.scrolls, 0, 'auto open does not scrollIntoView');
  assert.deepEqual(opened.focus, { id: 'a', n: 3, who: 'My choice', hand: 2000, automatic: true, support: true });
  assert.equal(opened.mode, 'support');
  assert.equal(opened.inStage, true);
  assert.equal(opened.titleText, 'My choice · 3번 좌석');
  assert.equal(opened.wait, 'My choice · 3번 좌석 · 화면 연결 대기');
  assert.equal(opened.waitHidden, false);
  assert.equal(opened.videoHidden, true);
  assert.equal(opened.requestDisabled, true);
  assert.equal(opened.progress.includes('완료'), false, 'auto open must not mark learning complete');
  assert.equal(requests('request').length, 0, 'auto open must not request control');
  assert.equal(requests('input').length, 0);
  assert.equal(await queueOf(), 0, 'active help is excluded from the queue count');
  releaseStatus(); state.hold = null;
  await page.locator('[data-live-room="a"] [data-live-seat="1"]').waitFor();
  assert.equal((await focusOf()).n, 3);
  assert.equal(await page.locator('#stage [data-live-seat="3"] video').evaluate(v => v.hidden), true);
  assert.equal(requests('request').length, 0);

  const beforeRepeat = await page.evaluate(() => window.__focuses.length);
  await meta([lab('a', [person(3, 'My choice', 2000), person(1, 'One'), person(2, 'Two')]), lab('b', [person(1, 'Bee')])]);
  assert.deepEqual(await focusOf(), { id: 'a', n: 3, who: 'My choice', hand: 2000, automatic: true, support: true });
  assert.equal(await page.evaluate(() => window.__focuses.length), beforeRepeat, 'repeated metadata with the same timestamp does not emit again');
  const polls = requests('status').length;
  await page.waitForTimeout(4000);
  assert.ok(requests('status').length > polls, 'status poll repeated');
  assert.deepEqual(await focusOf(), { id: 'a', n: 3, who: 'My choice', hand: 2000, automatic: true, support: true }, 'poll does not reopen the same hand');
  assert.equal(requests('request').length, 0);

  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  });
  assert.equal(requests('input').length, 0, 'editor keys are not forwarded');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editor');

  await meta([lab('a', [person(3, 'My choice', null), person(1, 'One'), person(2, 'Two')])]);
  assert.equal((await focusOf()).hand, null, 'clearing the active hand updates focus and does not close it');
  assert.equal(await queueOf(), 0);
  await meta([lab('a', [person(3, 'Renamed', 2100), person(1, 'One'), person(2, 'Two')])]);
  assert.deepEqual(await focusOf(), { id: 'a', n: 3, who: 'Renamed', hand: 2100, automatic: true, support: true });
  assert.equal(await queueOf(), 0, 'new timestamp on the active seat does not queue a duplicate');
  assert.equal(await page.locator('#stage [data-live-seat="3"] h3').innerText(), 'Renamed · 3번 좌석');

  await meta([lab('a', [person(3, 'Renamed', 2100), person(1, 'One'), person(2, 'Two')]), lab('b', [person(1, 'Bee', 5000)])]);
  assert.equal((await focusOf()).id, 'a');
  assert.equal(await queueOf(), 0, 'hands outside the selected room are ignored');
  assert.equal(await page.locator('[data-live-seat="1"]').first().evaluate(n => n.dataset.mode), 'watch');

  await meta([lab('a', [person(3, 'Renamed', 2100), person(1, 'One', 2400), person(2, 'Two', 2300)])]);
  assert.equal(await queueOf(), 2);
  assert.equal((await focusOf()).n, 3);
  await meta([lab('a', [person(3, 'Renamed', 2100), person(1, 'One', 2600), person(2, 'Two', 2300)])]);
  assert.equal(await queueOf(), 2, 'changed timestamp updates the queued request');
  await page.evaluate(() => {
    const box = document.querySelector('[data-live-room="a"] [data-live-seat="2"]');
    const input = document.createElement('input');
    input.id = 'seat-editor';
    box.append(input);
    input.focus();
  });
  await page.evaluate(() => ui.finishSupport());
  assert.deepEqual(await focusOf(), { id: 'a', n: 2, who: 'Two', hand: 2300, automatic: true, support: true }, 'FIFO opens the earlier timestamp first');
  assert.equal(await queueOf(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'seat-editor', 'moving the seat into the stage keeps keyboard focus');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'VIDEO');
  assert.equal(requests('request').length, 0);
  await page.evaluate(() => ui.finishSupport());
  assert.deepEqual(await focusOf(), { id: 'a', n: 1, who: 'One', hand: 2600, automatic: true, support: true });
  assert.equal(await queueOf(), 0);

  await page.evaluate(() => ui.clearFocus());
  assert.equal(await focusOf(), null);
  assert.equal(await page.locator('[data-live-seat="1"]').first().evaluate(n => n.dataset.mode), 'watch');
  await meta([lab('a', [person(3, 'Renamed', 2100), person(1, 'One', 2600), person(2, 'Two', 2300)])]);
  assert.equal(await focusOf(), null, 'clearFocus does not reopen an unchanged hand');
  await page.waitForTimeout(500);
  assert.equal(await focusOf(), null);

  await page.evaluate(() => { window.__auto = false; });
  await meta([lab('a', [person(3, 'Renamed', 3000), person(1, 'One', 2600), person(2, 'Two', 2300)])]);
  assert.equal(await focusOf(), null, 'canAutoOpen false retains the queue');
  assert.equal(await queueOf(), 1);
  await page.evaluate(() => { window.__auto = true; ui.setRoom('a'); });
  await page.waitForFunction(() => ui.getFocus() && ui.getFocus().n === 3);
  assert.deepEqual(await focusOf(), { id: 'a', n: 3, who: 'Renamed', hand: 3000, automatic: true, support: true });
  assert.equal(await queueOf(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id === 'editor' || document.activeElement.id === 'seat-editor' || document.activeElement.tagName !== 'H3'), true);

  await page.evaluate(() => ui.clearFocus());
  await page.locator('[data-live-room="a"] [data-live-seat="1"]').getByRole('button', { name: '도와주기', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H3', 'manual open still focuses the seat title');
  assert.deepEqual(await focusOf(), { id: 'a', n: 1, who: 'One', hand: 2600, automatic: false, support: true });
  const manualRequests = requests('request').length;
  await meta([lab('a', [person(3, 'Renamed', 3000), person(1, 'One', 2600), person(2, 'Two', 4000)])]);
  assert.equal((await focusOf()).n, 1, 'manual support is not replaced');
  assert.equal((await focusOf()).automatic, false);
  assert.equal(await queueOf(), 1);
  assert.equal(await page.locator('[data-live-seat="2"]').evaluate(n => n.dataset.mode), 'watch');
  assert.equal(requests('request').length, manualRequests);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H3');
  await meta([lab('a', [person(3, 'Renamed', 3000), person(1, 'One', 2600), person(2, 'Two', null)])]);
  assert.equal(await queueOf(), 0, 'clearing a queued hand removes it');

  await meta([lab('a', [person(3, 'Renamed', 4200), person(1, 'One', 2600), person(2, 'Two', 4100)])]);
  assert.equal(await queueOf(), 2);
  await meta([lab('a', [person(1, 'One', 2600), person(2, 'Two', 4100)])]);
  assert.equal(await queueOf(), 1, 'removing a queued seat drops it');
  assert.equal((await focusOf()).n, 1);

  state.control = { id: 'a', n: 1, requestId: '11111111-1111-4111-8111-111111111111' };
  await page.evaluate(() => ui.start());
  await page.getByRole('button', { name: '제어 끝내기', exact: true }).waitFor();
  const releases = requests('release').length;
  await meta([lab('a', [person(1, 'One', 2600), person(2, 'Later', 5000)])]);
  assert.equal((await focusOf()).n, 1, 'existing control is not replaced');
  assert.equal(await queueOf(), 1);
  assert.equal(requests('release').length, releases, 'a new hand does not release control');
  assert.equal(requests('request').length, manualRequests, 'a new hand does not request control');
  state.failRelease = true;
  await page.evaluate(() => ui.finishSupport());
  assert.equal((await focusOf()).n, 1, 'uncertain release holds the target');
  assert.equal(await queueOf(), 1, 'uncertain release does not advance the queue');
  assert.equal(await page.locator('[data-live-seat="1"]').first().evaluate(n => n.dataset.mode), 'support');
  assert.ok((await page.locator('[data-live-seat="1"]').first().innerText()).includes('종료 확인 필요'));
  assert.equal((await page.locator('[data-live-progress]').first().innerText()).includes('완료'), false);
  state.failRelease = false;
  state.control = null;
  await page.evaluate(() => ui.finishSupport());
  assert.deepEqual(await focusOf(), { id: 'a', n: 2, who: 'Later', hand: 5000, automatic: true, support: true }, 'safe release closes and advances');
  assert.equal(await queueOf(), 0);
  assert.ok(requests('release').some(x => x.body && x.body.n === 1));

  // A late finish may release the old control, but must not close a newly selected support.
  state.control={id:'a',n:2,requestId:'finish-race-request'};
  await page.evaluate(()=>ui.start());
  await page.waitForFunction(()=>document.querySelector('[data-live-seat="2"]')?.dataset.consent==='active');
  let releaseFinish;state.releaseHold=new Promise(r=>releaseFinish=r);
  const releaseAt=requests('release').length;
  await page.evaluate(()=>{window.__lateFinish=ui.finishSupport()});
  while(requests('release').length===releaseAt)await new Promise(r=>setTimeout(r,10));
  await page.evaluate(()=>ui.selectSeat('a',3));
  assert.equal((await focusOf()).n,3);
  state.control=null;releaseFinish();state.releaseHold=null;
  await page.evaluate(()=>window.__lateFinish);
  assert.equal((await focusOf()).n,3,'late finish cannot close newly selected support');

  await page.evaluate(() => ui.setRoom('b'));
  assert.equal(await focusOf(), null);
  assert.equal(await queueOf(), 0, 'room switch clears the selected-room queue');
  await meta([lab('b', [person(1, 'Bee', 5000)])]);
  assert.equal(await focusOf(), null, 'room switch baseline does not open an existing hand');
  await meta([lab('b', [person(1, 'Bee', 8000)])]);
  assert.deepEqual(await focusOf(), { id: 'b', n: 1, who: 'Bee', hand: 8000, automatic: true, support: true });
  await meta([lab('a', [person(4, '', 9000)]), lab('b', [person(1, 'Bee', 8000)])]);
  assert.equal((await focusOf()).id, 'b', 'fallback seat is not opened outside the selected room');
  await page.evaluate(() => ui.end());
  assert.equal(await focusOf(), null);
  assert.equal(await queueOf(), 0, 'logout resets the queue');
  assert.equal(await page.locator('#stage [data-live-seat]').count(), 0);
  await page.evaluate(() => { ui.setRoom('b'); ui.start(); });
  await meta([lab('b', [person(1, 'Bee', 8000)])]);
  assert.equal(await focusOf(), null, 'new session baselines the previous hand');
  await meta([lab('b', [person(1, '', 8001)])]);
  assert.deepEqual(await focusOf(), { id: 'b', n: 1, who: '', hand: 8001, automatic: true, support: true });
  assert.equal(await page.locator('#stage [data-live-seat="1"] h3').innerText(), '1번 좌석');
  assert.equal(requests('request').length, manualRequests);
  assert.deepEqual(errors, []);
  console.log('PASS auto help: baseline, selected room, FIFO, focus, waiting identity, release hold');
} finally {
  releaseStatus();
  state.hold = null;
  await browser.close();
  await new Promise(r => server.close(r));
}
