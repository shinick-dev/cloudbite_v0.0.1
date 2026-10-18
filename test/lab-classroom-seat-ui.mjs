// Participant classroom panel against a fixed in-page API. No live provider or remote origin.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { LAB_BAR_JS } from '../src/labbar.ts';
import { LAB_HELP_JS } from '../src/labhelp.ts';
import { LAB_CLASSROOM_SEAT_JS } from '../src/lab-classroom-seat.ts';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const steps = [
  { id: 's0', title: '사실 적기', instruction: '신청은 10명입니다.', prompt: '사실을 한 줄로 쓰세요.' },
  { id: 's1', title: '제안과 미정', instruction: '<img src=x onerror=alert(1)>', prompt: '제안과 미정을 나누세요.' },
  { id: 's2', title: '모임지기 예시', instruction: '모임지기 단계 안내', prompt: '예시만 봅니다.' },
];
const snap = {
  classroom: {
    revision: 3, title: '내 손으로 완성하는 5줄 보고서', mode: 'together', currentStep: 2, steps,
    materials: [{ name: '../../<img src=x>.txt', content: 'hello <script>alert(1)</script>' }],
    recordingUrl: 'https://example.com/watch/1', chapters: [{ title: '복습', seconds: 12, step: 1 }], updatedAt: 10,
  },
  progress: { step: 0, completed: false, updatedAt: 10 },
  submissions: [{ id: 'sub-1', version: 1, filename: '결과.txt', content: '<b>결과 본문</b>', submittedAt: 4, step: 0, feedback: '<i>의견</i>', feedbackAt: 5 }],
};
const emptySnap = { classroom: { revision: 1, title: '빈 수업', mode: 'individual', currentStep: 0, steps: [], materials: [], recordingUrl: '', chapters: [], updatedAt: 1 }, progress: { step: 0, completed: false, updatedAt: 1 }, submissions: [] };
const stub = `
window.__calls = []; window.__blobs = []; window.__copied = ''; window.__explorer = 0; window.__hangProgress = false; window.__submitMode = ''; window.__statusPlan = []; window.__progressMode = ''; window.__holdNextStatus = 0; window.__statusHeld = []; window.__heldDelivered = 0;
window.__releaseHeldStatus = () => { const release = window.__statusHeld.shift(); if (release) release(); };
window.__snap = ${JSON.stringify(snap).replace(/</g, '\\u003c')};
window.__emptySnap = ${JSON.stringify(emptySnap).replace(/</g, '\\u003c')};
document.getElementById('explorer').addEventListener('click', (e) => { e.preventDefault(); window.__explorer++; });
try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); } catch (e) {}
let vis = 'visible';
try { Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return vis; } }); } catch (e) {}
window.__setVis = (v) => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
const origBlob = URL.createObjectURL.bind(URL);
URL.createObjectURL = (blob) => { window.__blobs.push(blob); return origBlob(blob); };
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(data), json: async () => data });
window.fetch = async (url, opt = {}) => {
  const path = new URL(url, location.href).pathname;
  const method = opt.method || 'GET';
  const body = opt.body ? JSON.parse(opt.body) : null;
  const headers = opt.headers || {};
  window.__calls.push({ path, method, body, headers, credentials: opt.credentials || '' });
  if (path === '/__lab/me') return json({ expiresAt: Date.now() + 3600000, usage: 0, hand: false, seat: 1, name: '수업', who: '참여자', clip: { in: true, out: true }, now: Date.now() });
  if (path === '/__lab/help' && method === 'GET') return json({ enabled: true, questions: [], messages: [] });
  if (path === '/__lab/help') return json({ question: { id: 'q', question: body.question, n: 1, status: 'open', at: 1, reply: null } });
  if (path === '/__lab/hand') return json({ hand: !!(body && body.up) });
  if (path === '/__lab/files') return json({ transfer: null });
  if (path === '/__lab/checkpoints') return json({ checkpoints: [] });
  if (path === '/__lab/export') return json({ ticket: 'abcdefghijklmnopqrstuvwx', name: 'work.zip', size: 20, receiptId: '12345678-1234-4123-8123-123456789abc' });
  if (path === '/__lab/classroom/status') {
    if (location.search.includes('hold=1') && !window.__releaseStatus) return new Promise(() => {});
    if (location.search.includes('empty=1')) return json(window.__emptySnap);
    if (window.__holdNextStatus > 0) {
      window.__holdNextStatus -= 1;
      const captured = JSON.parse(JSON.stringify(window.__snap));
      return new Promise((resolve) => {
        window.__statusHeld.push(() => {
          const payload = json(captured);
          const read = payload.text;
          payload.text = async () => { window.__heldDelivered += 1; return read(); };
          resolve(payload);
        });
      });
    }
    if (window.__statusPlan.length) { const next = window.__statusPlan.shift(); if (next === 'err') return json({ error: '일시 오류' }, 500); }
    return json(window.__snap);
  }
  if (path === '/__lab/classroom/progress') {
    if (window.__progressMode === '409') return json({ error: '다른 자리에서 진행이 바뀌었습니다.' }, 409);
    if (window.__progressMode === '500') return json({ error: '일시 오류' }, 500);
    if (window.__hangProgress) {
      return new Promise((resolve) => {
        window.__releaseProgress = () => {
          window.__snap = { ...window.__snap, progress: { step: body.step, completed: body.completed, updatedAt: Date.now() } };
          resolve(json(window.__snap));
        };
      });
    }
    window.__snap = { ...window.__snap, progress: { step: body.step, completed: body.completed, updatedAt: Date.now() } };
    return json(window.__snap);
  }
  if (path === '/__lab/classroom/submit') {
    if (window.__submitMode === 'hang') {
      return new Promise((resolve) => {
        window.__releaseSubmit = () => {
          const landed = { id: 'sub-live', version: 2, filename: '결과.txt', content: '방금 제출', submittedAt: 9, step: 0, feedback: '', feedbackAt: 0 };
          window.__snap = { ...window.__snap, submissions: window.__snap.submissions.concat(landed) };
          resolve(json(window.__snap));
        };
      });
    }
    if (window.__submitMode === '400') return json({ error: '거절' }, 400);
    if (window.__submitMode === 'land') {
      const landed = { id: 'sub-land', version: 2, filename: '결과.txt', content: '새 제출', submittedAt: 8, step: 0, feedback: '', feedbackAt: 0 };
      window.__snap = { ...window.__snap, submissions: window.__snap.submissions.concat(landed) };
      return json(window.__snap);
    }
    return json(window.__snap);
  }
  return json({ error: 'unexpected ' + path }, 500);
};`;
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>.monaco-workbench{position:absolute;top:0;left:0;right:0;bottom:0;background:#18212f}</style><body>
<div class="activitybar"><a id="explorer" aria-label="Explorer (Ctrl+Shift+E)" href="#"></a></div>
<div class="monaco-workbench" id="workbench"><textarea id="editor-input"></textarea>EDITOR</div>
<script>${stub}</script>
<script src="/__lab/classroom.js"></script>
<script>${LAB_BAR_JS}</script>
<script>${LAB_HELP_JS}</script>
</body></html>`;

let passed = 0;
async function test(name, fn, { width = 1280, height = 900, query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await page.route('https://seat.invalid/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/__lab/classroom.js') return route.fulfill({ contentType: 'text/javascript', body: LAB_CLASSROOM_SEAT_JS });
      if (path.startsWith('/__lab/export/')) return route.fulfill({ contentType: 'application/zip', body: 'PK' });
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('https://seat.invalid/' + query);
    await fn(page);
    passed++;
    console.log('ok', name);
  } finally { await context.close(); }
}
const panel = (page) => page.locator('#lab-classroom-panel');
const calls = (page, path, method) => page.evaluate(({ path, method }) => window.__calls.filter((c) => c.path === path && (!method || c.method === method)), { path, method });
const doneBox = (page) => page.getByRole('checkbox', { name: '이 단계를 마친 것으로 표시' });
async function expectDone(page, checked) {
  await page.waitForFunction((checked) => {
    const node = document.getElementById('lab-classroom-done');
    return !!node && node.checked === checked && !node.disabled;
  }, checked);
}
async function tick(page) {
  await page.evaluate(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
}

try {
  await test('desktop panel reserves editor space and keeps editor input', async (page) => {
    await panel(page).getByRole('heading', { name: '이 단계 안내' }).waitFor();
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    assert.equal(await page.locator('html').evaluate((n) => n.classList.contains('lab-classroom-reserve')), true);
    const box = await page.locator('#workbench').boundingBox();
    assert.ok(box.width <= 1280 - 270, 'workbench width ' + box.width);
    await page.locator('#editor-input').focus();
    await page.keyboard.type('abc');
    assert.equal(await page.locator('#editor-input').inputValue(), 'abc');
    assert.equal(await page.locator('iframe').count(), 0);
    const status = await calls(page, '/__lab/classroom/status', 'GET');
    assert.equal(status.length, 1);
    assert.equal(status[0].credentials, 'same-origin');
    assert.equal(status[0].headers.authorization, undefined);
    assert.match(await panel(page).innerText(), /함께 실행/);
    assert.match(await panel(page).innerText(), /이 표시만으로 명령이 실행되지 않습니다/);
    assert.match(await panel(page).innerText(), /모임지기 안내 3\/3 · 모임지기 예시/);
    assert.match(await panel(page).innerText(), /내 단계 1\/3 · 사실 적기/);
  });

  await test('own next does not follow the teacher step', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await panel(page).getByRole('button', { name: '다음 단계', exact: true }).click();
    await page.getByText('내 단계 2/3 · 제안과 미정').waitFor();
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.equal(progress.length, 1);
    assert.deepEqual(progress[0].body, { step: 1, completed: false });
    assert.match(await panel(page).innerText(), /모임지기 안내 3\/3/);
  });

  await test('dirty completion survives a stale status poll', async (page) => {
    await page.getByRole('checkbox', { name: '이 단계를 마친 것으로 표시' }).waitFor();
    await page.evaluate(() => { window.__hangProgress = true; });
    await page.getByRole('checkbox', { name: '이 단계를 마친 것으로 표시' }).check();
    await page.waitForFunction(() => window.__calls.some((c) => c.path === '/__lab/classroom/progress'));
    await page.clock.runFor(5000);
    assert.equal(await page.getByRole('checkbox', { name: '이 단계를 마친 것으로 표시' }).isChecked(), true);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.deepEqual(progress[0].body, { step: 0, completed: true });
    assert.equal(Object.keys(progress[0].body).join(), 'step,completed');
  });

  await test('prompt copy, help text, and no fabricated resolution', async (page) => {
    await page.getByText('사실을 한 줄로 쓰세요.').waitFor();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); });
    await panel(page).getByRole('button', { name: '예시 문장 복사', exact: true }).click();
    await page.getByText('예시 문장을 복사했습니다.').waitFor();
    assert.equal(await page.evaluate(() => window.__copied), '사실을 한 줄로 쓰세요.');
    await panel(page).getByRole('button', { name: '이 단계로 도움 요청', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.getByRole('dialog').locator('textarea').inputValue(), /신청은 10명입니다/);
    await page.getByRole('dialog').locator('textarea').fill('이미 적은 도움');
    await panel(page).getByRole('button', { name: '이 단계로 도움 요청', exact: true }).evaluate((button) => button.click());
    assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), '이미 적은 도움');
    assert.equal((await calls(page, '/__lab/help', 'POST')).length, 0);
    assert.match(await panel(page).innerText(), /해결로 표시하지 않습니다/);
  });

  await test('hand fallback does not invent a resolution', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => { for (const b of window.__labBarUI.box.querySelectorAll('button')) if ((b.textContent || '').includes('도움 요청')) b.remove(); });
    await panel(page).getByRole('button', { name: '이 단계로 도움 요청', exact: true }).click();
    const hands = await calls(page, '/__lab/hand', 'POST');
    assert.equal(hands.length, 1);
    assert.deepEqual(hands[0].body, { up: true });
    assert.match(await panel(page).innerText(), /대신 해결하지 않습니다/);
    assert.doesNotMatch(await panel(page).innerText(), /해결했습니다/);
  });

  await test('progress write and submit cannot overlap', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => {window.__hangProgress=true});
    await panel(page).getByRole('button',{name:'다음 단계',exact:true}).click();
    assert.equal(await panel(page).getByRole('button',{name:'결과 제출',exact:true}).isDisabled(),true);
    assert.equal((await calls(page,'/__lab/classroom/submit','POST')).length,0);
    await page.evaluate(()=>window.__releaseProgress());
    await page.waitForFunction(()=>!document.querySelector('#lab-classroom-done').disabled);
    assert.equal(await panel(page).getByRole('button',{name:'결과 제출',exact:true}).isDisabled(),false);
  });

  await test('submit timeout retries the same id and a known rejection does not', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => { window.__submitMode = 'hang'; });
    await panel(page).getByRole('button', { name: '결과 제출', exact: true }).click();
    await page.clock.runFor(10000);
    await page.getByText(/제출 결과를 확인하지 못했습니다/).waitFor();
    await page.clock.runFor(3000);
    const hung = await calls(page, '/__lab/classroom/submit', 'POST');
    assert.equal(hung.length, 1);
    await page.evaluate(() => { window.__submitMode = ''; });
    await panel(page).getByRole('button', { name: '같은 제출 다시 확인', exact: true }).click();
    await page.getByRole('button', { name: '결과 제출', exact: true }).waitFor();
    const retried = await calls(page, '/__lab/classroom/submit', 'POST');
    assert.equal(retried.length, 2);
    assert.equal(retried[0].body.requestId, retried[1].body.requestId);
    assert.equal(retried[0].body.filename, '결과.txt');
    assert.deepEqual(Object.keys(retried[0].body).sort(), ['filename', 'requestId']);
  });

  await test('known submit rejection can use a new id', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => { window.__submitMode = '400'; });
    await panel(page).getByRole('button', { name: '결과 제출', exact: true }).click();
    await page.getByText('거절').waitFor();
    await page.evaluate(() => { window.__submitMode = ''; });
    await panel(page).getByRole('button', { name: '결과 제출', exact: true }).click();
    await page.waitForFunction(() => window.__calls.filter((c) => c.path === '/__lab/classroom/submit').length === 2);
    const sent = await calls(page, '/__lab/classroom/submit', 'POST');
    assert.notEqual(sent[0].body.requestId, sent[1].body.requestId);
  });

  await test('version click shows escaped feedback and does not accept it', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    const before = (await calls(page, '/__lab/classroom/submit', 'POST')).length;
    await panel(page).getByRole('button', { name: '제출 1 · 결과.txt' }).click();
    assert.match(await panel(page).innerText(), /<b>결과 본문<\/b>/);
    assert.match(await panel(page).innerText(), /<i>의견<\/i>/);
    assert.match(await panel(page).innerText(), /누르는 것으로 수락하지 않습니다/);
    assert.equal(await panel(page).getByRole('button', { name: '수락' }).count(), 0);
    assert.equal((await calls(page, '/__lab/classroom/submit', 'POST')).length, before);
    assert.equal(await panel(page).locator('b,i,script,img,iframe').count(), 0);
  });

  await test('material download is a safe blob and upload does not pretend to send a file', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await panel(page).getByRole('button', { name: '자료 내려받기', exact: true }).click();
    const saved = await page.evaluate(async () => ({ name: [...document.querySelectorAll('#lab-classroom-panel p')].map((n) => n.textContent).find((t) => t.includes('자료 파일을 내려받았습니다')) || '', text: await window.__blobs.at(-1).text() }));
    assert.equal(saved.text, 'hello <script>alert(1)</script>');
    assert.match(saved.name, /자료 파일을 내려받았습니다/);
    assert.doesNotMatch(saved.name, /\.\.\/|<img|<script/);
    assert.match(await panel(page).innerText(), /\.\.\/\.\.\/<img src=x>\.txt/);
    await panel(page).getByRole('button', { name: '다음 단계', exact: true }).click();
    await panel(page).getByRole('heading', { name: '제안과 미정', exact: true }).waitFor();
    assert.match(await panel(page).innerText(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await panel(page).locator('img,iframe,input[type="file"]').count(), 0);
    await panel(page).getByRole('button', { name: '탐색기 열기', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__explorer), 1);
    assert.match(await panel(page).innerText(), /대신 올리지 않습니다/);
    assert.match(await panel(page).innerText(), /오른쪽 클릭해 Upload/);
  });

  await test('zip and manual backup stay on the existing bar actions', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    const downloadPromise = page.waitForEvent('download');
    await panel(page).getByRole('button', { name: '내 작업 받기', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'work.zip');
    assert.equal((await calls(page, '/__lab/export', 'POST')).length, 1);
    await panel(page).getByRole('button', { name: '파일 보존 확인 열기', exact: true }).click();
    await page.getByRole('heading', { name: '내 파일 보존 확인' }).waitFor();
    assert.match(await panel(page).innerText(), /제출, ZIP 내려받기, 직접 확인은 서로 다릅니다/);
  });

  await test('recording is an external link and a chapter moves only the learner step', async (page) => {
    await page.getByRole('link', { name: '녹화 외부 링크로 열기' }).waitFor();
    const href = await page.getByRole('link', { name: '녹화 외부 링크로 열기' }).getAttribute('href');
    assert.equal(href, 'https://example.com/watch/1');
    await page.evaluate(() => { window.__snap = { ...window.__snap, classroom: { ...window.__snap.classroom, recordingUrl: 'javascript:alert(1)' } }; });
    await page.clock.runFor(5000);
    await page.waitForFunction(() => !document.querySelector('#lab-classroom-panel a[href^="javascript:"]'));
    assert.equal(await page.locator('iframe').count(), 0);
    await panel(page).getByRole('button', { name: '내 단계로 이동', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c.path === '/__lab/classroom/progress' && c.body && c.body.step === 1));
  });

  await test('poll waits five seconds, stops when hidden, and keeps a stale error', async (page) => {
    await page.getByText('신청은 10명입니다.').waitFor();
    await page.clock.runFor(4900);
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, 1);
    await page.evaluate(() => { window.__statusPlan.push('err'); });
    await page.clock.runFor(200);
    await page.getByText(/일시 오류/).waitFor();
    assert.match(await panel(page).innerText(), /신청은 10명입니다/);
    assert.match(await panel(page).innerText(), /마지막 안내/);
    const before = (await calls(page, '/__lab/classroom/status', 'GET')).length;
    await page.evaluate(() => window.__setVis('hidden'));
    await page.clock.runFor(30000);
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, before);
  });

  await test('pagehide stops polling and a hung status does not overlap', async (page) => {
    await page.getByText('신청은 10명입니다.').waitFor();
    const before = (await calls(page, '/__lab/classroom/status', 'GET')).length;
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.clock.runFor(20000);
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, before);
  }, { query: '' });

  await test('hung status times out then recovers without overlapping polls', async (page) => {
    await page.waitForFunction(() => window.__calls.filter((c) => c.path === '/__lab/classroom/status').length === 1);
    await page.evaluate(() => window.__setVis('visible'));
    await page.clock.runFor(9900);
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, 1);
    await page.clock.runFor(200);
    await page.getByText(/응답 확인 시간이 지났습니다/).waitFor();
    await page.evaluate(() => { window.__releaseStatus = true; });
    await page.clock.runFor(5100);
    await page.getByText('신청은 10명입니다.').waitFor();
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, 2);
  }, { query: '?hold=1' });

  await test('mobile starts closed and uses tabs without covering the editor', async (page) => {
    await page.getByRole('button', { name: '수업 안내', exact: true }).waitFor();
    assert.equal(await panel(page).isHidden(), true);
    assert.equal(await page.locator('html').evaluate((n) => n.classList.contains('lab-classroom-reserve')), false);
    const box = await page.locator('#workbench').boundingBox();
    assert.ok(box.width >= 370, 'mobile editor width ' + box.width);
    await page.locator('#editor-input').focus();
    await page.keyboard.type('z');
    assert.equal(await page.locator('#editor-input').inputValue(), 'z');
    await page.getByRole('button', { name: '수업 안내', exact: true }).click();
    await page.getByRole('tab', { name: '자료', exact: true }).click();
    await page.getByText('파일을 이 패널이 대신 올리지 않습니다.').waitFor();
    assert.equal(await page.locator('html').evaluate((n) => n.classList.contains('lab-classroom-reserve')), false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '수업 안내', exact: true }).waitFor();
    assert.equal(await panel(page).isHidden(), true);
  }, { width: 390, height: 844 });

  await test('empty classroom does not block the mobile editor', async (page) => {
    await page.getByRole('button', { name: '수업 안내', exact: true }).click();
    await page.getByText('아직 수업 안내가 없습니다.').waitFor();
    assert.equal(await page.getByRole('button', { name: '다음 단계', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('html').evaluate((n) => n.classList.contains('lab-classroom-reserve')), false);
  }, { width: 390, height: 844, query: '?empty=1' });

  await test('completed step is not carried to the next, previous, or chapter step', async (page) => {
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await doneBox(page).check();
    await expectDone(page, true);
    await panel(page).getByRole('button', { name: '다음 단계', exact: true }).click();
    await page.getByText('내 단계 2/3 · 제안과 미정').waitFor();
    await expectDone(page, false);
    await doneBox(page).check();
    await expectDone(page, true);
    await panel(page).getByRole('button', { name: '이전 단계', exact: true }).click();
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await expectDone(page, false);
    await doneBox(page).check();
    await expectDone(page, true);
    await panel(page).getByRole('button', { name: '내 단계로 이동', exact: true }).click();
    await page.getByText('내 단계 2/3 · 제안과 미정').waitFor();
    await expectDone(page, false);
    await doneBox(page).check();
    await expectDone(page, true);
    const beforeSame = (await calls(page, '/__lab/classroom/progress', 'POST')).length;
    await panel(page).getByRole('button', { name: '내 단계로 이동', exact: true }).click();
    await tick(page);
    await expectDone(page, true);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.equal(progress.length, beforeSame);
    assert.deepEqual(progress.map((c) => c.body), [
      { step: 0, completed: true },
      { step: 1, completed: false },
      { step: 1, completed: true },
      { step: 0, completed: false },
      { step: 0, completed: true },
      { step: 1, completed: false },
      { step: 1, completed: true },
    ]);
  });

  await test('status held before a progress post cannot revert the new cursor', async (page) => {
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await page.evaluate(() => { window.__holdNextStatus = 1; });
    await page.clock.runFor(5100);
    await page.waitForFunction(() => window.__statusHeld.length === 1);
    await doneBox(page).check();
    await expectDone(page, true);
    await page.evaluate(() => window.__releaseHeldStatus());
    await tick(page);
    assert.ok(await page.evaluate(() => window.__heldDelivered) >= 1);
    await expectDone(page, true);
    assert.equal(await page.getByText('내 단계 1/3 · 사실 적기').count(), 1);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.deepEqual(progress.at(-1).body, { step: 0, completed: true });
  });

  await test('status held before a submit post cannot revert the new submission', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => { window.__holdNextStatus = 1; });
    await page.clock.runFor(5100);
    await page.waitForFunction(() => window.__statusHeld.length === 1);
    await page.evaluate(() => { window.__submitMode = 'land'; });
    await panel(page).getByRole('button', { name: '결과 제출', exact: true }).click();
    await page.getByRole('button', { name: '제출 2 · 결과.txt' }).waitFor();
    await page.evaluate(() => window.__releaseHeldStatus());
    await tick(page);
    assert.ok(await page.evaluate(() => window.__heldDelivered) >= 1);
    await page.getByRole('button', { name: '제출 2 · 결과.txt' }).waitFor();
    await panel(page).getByRole('button', { name: '제출 2 · 결과.txt' }).click();
    await page.getByText('새 제출', { exact: true }).waitFor();
    assert.equal(await panel(page).getByRole('button', { name: '제출 1 · 결과.txt' }).count(), 1);
  });

  await test('status started during a progress write cannot apply the pre-commit cursor', async (page) => {
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await page.evaluate(() => { window.__hangProgress = true; window.__holdNextStatus = 1; });
    await doneBox(page).check();
    await page.waitForFunction(() => window.__calls.some((c) => c.path === '/__lab/classroom/progress' && c.method === 'POST'));
    await page.clock.runFor(5100);
    await page.waitForFunction(() => window.__statusHeld.length === 1);
    await page.evaluate(() => window.__releaseProgress());
    await expectDone(page, true);
    await page.evaluate(() => window.__releaseHeldStatus());
    await tick(page);
    assert.ok(await page.evaluate(() => window.__heldDelivered) >= 1);
    await expectDone(page, true);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.deepEqual(progress.at(-1).body, { step: 0, completed: true });
  });

  await test('status started during a submit write cannot apply the pre-commit submission', async (page) => {
    await page.getByText('사실 적기', { exact: true }).first().waitFor();
    await page.evaluate(() => { window.__submitMode = 'hang'; window.__holdNextStatus = 1; });
    await panel(page).getByRole('button', { name: '결과 제출', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c.path === '/__lab/classroom/submit' && c.method === 'POST'));
    await page.clock.runFor(5100);
    await page.waitForFunction(() => window.__statusHeld.length === 1);
    await page.evaluate(() => window.__releaseSubmit());
    await page.getByRole('button', { name: '제출 2 · 결과.txt' }).waitFor();
    await page.evaluate(() => window.__releaseHeldStatus());
    await tick(page);
    assert.ok(await page.evaluate(() => window.__heldDelivered) >= 1);
    await page.getByRole('button', { name: '제출 2 · 결과.txt' }).waitFor();
    await panel(page).getByRole('button', { name: '제출 2 · 결과.txt' }).click();
    await page.getByText('방금 제출', { exact: true }).waitFor();
  });

  await test('known progress conflict adopts the next status cursor', async (page) => {
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await page.evaluate(() => {
      window.__progressMode = '409';
      window.__snap = { ...window.__snap, progress: { step: 2, completed: false, updatedAt: 99 } };
    });
    await panel(page).getByRole('button', { name: '다음 단계', exact: true }).click();
    await page.getByText('내 단계 3/3 · 모임지기 예시').waitFor();
    assert.match(await panel(page).innerText(), /다른 진행과 겹쳐 이 변경은 저장하지 못했습니다\. 서버에 저장된 단계로 맞춥니다\./);
    await expectDone(page, false);
    assert.equal(await page.getByRole('button', { name: '같은 진행 다시 시도', exact: true }).isHidden(), true);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.equal(progress.length, 1);
    assert.deepEqual(progress[0].body, { step: 1, completed: false });
    assert.equal((await calls(page, '/__lab/classroom/status', 'GET')).length, 2);
  });

  await test('unknown progress failure keeps the draft for the next status', async (page) => {
    await page.getByText('내 단계 1/3 · 사실 적기').waitFor();
    await page.evaluate(() => { window.__progressMode = '500'; });
    await panel(page).getByRole('button', { name: '다음 단계', exact: true }).click();
    await page.getByText('진행 저장 결과를 확인하지 못했습니다. 같은 단계로 다시 시도하세요.').waitFor();
    await page.getByText('내 단계 2/3 · 제안과 미정').waitFor();
    assert.equal(await page.getByRole('button', { name: '같은 진행 다시 시도', exact: true }).isVisible(), true);
    await page.evaluate(() => {
      window.__progressMode = '';
      window.__snap = { ...window.__snap, progress: { step: 2, completed: true, updatedAt: 99 } };
    });
    const before = (await calls(page, '/__lab/classroom/status', 'GET')).length;
    await page.clock.runFor(5200);
    await page.waitForFunction((n) => window.__calls.filter((c) => c.path === '/__lab/classroom/status').length > n, before);
    await page.getByText('내 단계 2/3 · 제안과 미정').waitFor();
    assert.equal(await page.getByText('내 단계 3/3 · 모임지기 예시').count(), 0);
    await expectDone(page, false);
    assert.equal(await page.getByRole('button', { name: '같은 진행 다시 시도', exact: true }).isVisible(), true);
    const progress = await calls(page, '/__lab/classroom/progress', 'POST');
    assert.deepEqual(progress.at(-1).body, { step: 1, completed: false });
  });

  console.log('PASS classroom seat ui', passed);
} finally { await browser.close(); }
if (!passed) process.exit(1);
