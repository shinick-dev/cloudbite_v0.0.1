// 모임지기 셸: 새로고침 없는 이동, /lab [hidden], 선택한 모임 도구의 구분.
// 네트워크·로그인 없이 labPage 와 렌더러만 연다.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { labPage, WEBAUTHN_JS } from '../src/pages.ts';
import { LAB_RENDERER_JS } from '../src/lab-renderer.generated.ts';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const html = labPage().replace('<script src="/webauthn.js"></script>', `<script>${WEBAUTHN_JS}</script>`);
  // setContent 는 보안 컨텍스트가 아니라 crypto.randomUUID 가 없다. https 문서로 연다.
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://lab.example/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no' });
  });
  await page.goto('https://lab.example/lab', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const note = document.getElementById('loginNote');
    return !!note && note.textContent.length > 0;
  });
  assert.equal(await page.$eval('#navReq', (el) => el.tagName), 'A');
  assert.equal(await page.$eval('#navReq', (el) => el.getAttribute('href')), '/lab/requests');
  assert.equal(await page.$eval('#l_custom', (el) => getComputedStyle(el).display), 'none');
  await page.$eval('#l_custom', (el) => { el.hidden = false; });
  assert.equal(await page.$eval('#l_custom', (el) => getComputedStyle(el).display), 'flex');
  await page.$eval('#l_custom', (el) => { el.hidden = true; });
  assert.equal(await page.$eval('#l_custom', (el) => getComputedStyle(el).display), 'none');
  await page.$eval('#panel', (el) => { el.hidden = false; });
  await page.$eval('#liveTools', (el) => { el.hidden = false; });
  const here = page.url();
  await page.click('#navPrep');
  assert.equal(page.url(), here);
  assert.equal(await page.$eval('#viewPrep', (el) => el.hidden), false);
  assert.equal(await page.$eval('#viewRun', (el) => el.hidden), true);
  assert.equal(await page.$eval('#newLab', (el) => !!el.closest('#viewPrep')), true);
  await page.click('#navSet');
  assert.equal(page.url(), here);
  assert.equal(await page.$eval('#pushCard', (el) => !!el.closest('#viewSet')), true);
  assert.equal(await page.$eval('#instCard', (el) => !!el.closest('#viewSet')), true);
  assert.equal(await page.$eval('#sess', (el) => !!el.closest('#viewSet')), true);
  assert.equal(await page.$eval('#reauth', (el) => !!el.closest('#roomHead')), true);
  await page.click('#navRun');
  const wide = await page.evaluate(() => {
    const live = document.getElementById('liveTools').getBoundingClientRect();
    const hands = document.getElementById('handsBar').getBoundingClientRect();
    const side = live.right <= hands.left + 1 || hands.right <= live.left + 1;
    return { side, sticky: getComputedStyle(document.getElementById('handsBar')).position, overlap: !(live.bottom <= hands.top || hands.bottom <= live.top) };
  });
  assert.equal(wide.sticky, 'static');
  assert.equal(wide.side, true);
  assert.equal(wide.overlap, true);
  await page.setViewportSize({ width: 360, height: 740 });
  const narrow = await page.evaluate(() => {
    const live = document.getElementById('liveTools').getBoundingClientRect();
    const hands = document.getElementById('handsBar').getBoundingClientRect();
    return live.bottom <= hands.top + 1 || hands.bottom <= live.top + 1;
  });
  assert.equal(narrow, true);
  const source = labPage();
  for (const token of ['setMetadata', 'setRoom', 'selectSeat', 'lab-live-room', 'roomSelect']) assert.ok(source.includes(token), token);

  const box = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await box.setContent('<style>[hidden]{display:none !important}.row{display:flex}</style><div id="box"></div><div id="live"></div>');
  await box.addScriptTag({ content: LAB_RENDERER_JS });
  const laid = await box.evaluate(() => {
    const calls = [];
    const D = {
      now: () => 1800000000000, fmt: (t) => String(t), ago: () => '방금', dur: (s) => s + 's', cleanErr: (t) => String(t),
      joined: () => '1 / 1 명 입장', usable: () => true, failed: () => [], failNote: () => '', firstErr: () => '',
      btn: (t, cls, f) => { const b = document.createElement('button'); b.textContent = t; b.className = cls; b.onclick = f; return b; },
      copy: async () => {}, say: () => {}, shareRow: () => document.createElement('div'),
      screenRow: () => { const b = document.createElement('button'); b.textContent = '🖥 화면 공유 시작'; return b; },
      sharing: () => false, omitScreen: (id) => id === 'hide', selectedId: () => 'A', helpSeat: (id, n) => calls.push([id, n]),
      snipBox: () => { const d = document.createElement('div'); d.dataset.snip = '1'; d.textContent = '코드'; return d; },
      controlBox: () => { const d = document.createElement('div'); d.dataset.labControl = '1'; d.textContent = '명령 전달 일시정지'; return d; },
      terminalBox: () => { const d = document.createElement('div'); d.dataset.labTerminal = '1'; d.textContent = '터미널'; return d; },
      trialBox: () => document.createElement('div'), checkpointBox: () => document.createElement('div'),
      recoveryBox: () => document.createElement('div'), assistantBox: () => document.createElement('button'),
      interruptBox: () => document.createElement('div'),
      inviteAll: async () => ({ seats: [] }), inviteSeat: async () => ({ n: 1, link: 'https://lab.example/j/x' }),
      showInvite: () => {}, setClip: async () => ({ clip: { in: true, out: true } }), lowerHand: async () => {}, endLab: async () => {}, reload: async () => {},
    };
    const LR = createLabRenderer(D);
    const seat = { n: 1, who: '<img src=x onerror=alert(1)>', state: 'started', opened: 1800000000000, hand: 1, presence: { state: 'active' } };
    LR.renderLabs(document.getElementById('box'), [
      { id: 'A', name: '아침 모임', cpu: 2, memory: 4, budget: 2, model: 'test/model', expiresAt: 1800003600000, clip: { in: true, out: true }, share: [], seats: [seat] },
      { id: 'hide', name: '가림', cpu: 1, memory: 1, budget: 1, model: 'm', expiresAt: 1800003600000, clip: { in: true, out: true }, share: [], seats: [{ ...seat, n: 2, hand: 0 }] },
    ]);
    const root = document.getElementById('box');
    const card = root.querySelector('[data-lab="A"]');
    const text = card.textContent;
    const order = text.indexOf('명령 전달') < text.indexOf('코드 보내기') && text.indexOf('코드 보내기') < text.indexOf('터미널 실행') && text.indexOf('터미널 실행') < text.indexOf('마무리');
    return {
      order, selected: card.dataset.selected === '1',
      heads: [...card.querySelectorAll('th')].map((th) => th.scope + ':' + th.textContent),
      seat: card.querySelector('[data-seat="1"]')?.firstElementChild?.textContent,
      shareA: card.querySelectorAll('button').length,
      shareHide: !!root.querySelector('[data-lab="hide"]'),
      images: root.querySelectorAll('img').length,
      help: !!card.querySelector('[data-help="1"]'),
      pause: text.includes('이미 실행 중인 프로그램을 끄는 버튼이 아닙니다'),
      distinct: text.includes('터미널에서 실행하지 않습니다') && text.includes('명령을 실제로 실행합니다'),
      workspace: text.includes('실습실 작업 공간') && text.includes('미리보기'),
    };
  });
  assert.equal(laid.order, true);
  assert.equal(laid.selected, true);
  assert.ok(laid.heads.includes('col:자리'));
  assert.ok(laid.heads.includes('col:참여자'));
  assert.equal(laid.seat, '1번');
  assert.equal(laid.shareHide, false);
  assert.equal(laid.images, 0);
  assert.equal(laid.help, true);
  assert.equal(laid.pause, true);
  assert.equal(laid.distinct, true);
  assert.equal(laid.workspace, true);
  assert.ok(laid.shareA > 0);
  box.once('dialog', (dialog) => { assert.match(dialog.message(), /ZIP 직접 확인/); assert.equal(dialog.message().includes('자동으로 받았습니다'), false); return dialog.dismiss(); });
  await box.locator('[data-lab="A"] summary').filter({hasText:/^마무리$/}).click();
  await box.locator('[data-lab="A"]').getByRole('button', { name: '지금 끝내기' }).click();
  console.log('lab-shell-nav-ui: navigation, hidden fields, room tools passed');
} finally { await browser.close(); }
