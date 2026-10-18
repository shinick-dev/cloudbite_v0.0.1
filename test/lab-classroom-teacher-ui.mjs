// 모임지기 수업 셸. 네트워크는 계약 mock 만 쓰고, 수업 구성은 화면을 열기 전에는 요청하지 않는다.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { labPage, WEBAUTHN_JS } from '../src/pages.ts';

const MEMO_REQUEST = 'AI 공부방 모임 안내를 위한 보고서가 필요합니다.\n메모 두 개를 근거로 5줄로 정리해 주세요.\n확정된 사실과 아직 검토·제안 중인 내용을 구분해 주세요.';
const MEMO_PROGRESS = '현재 신청자: 10명\n정원 12명: 검토 중\n진행 시간 40분: 제안\n참가비: 아직 확인하지 않음';
const TEMPLATE_STEPS = [
  { id: 'memo-read', title: '메모 두 개 읽기', instruction: '어떤 자료가 있고, 무엇이 요청됐는지 확인하세요.', prompt: '01_요청메모.txt와 02_진행메모.txt를 읽고, 요청 사항과 확인된 사실을 각각 알려 주세요. 파일은 아직 만들지 마세요.' },
  { id: 'memo-draft', title: 'AI에게 초안 요청', instruction: '메모를 근거로 5줄짜리 결과.txt를 만들어 보세요.', prompt: '두 메모만 근거로 안내 보고서를 5줄로 써서 결과.txt에 저장해 주세요. 확정된 사실과 검토·제안 중인 내용을 구분하고, 없는 정보는 확인 필요로 적어 주세요.' },
  { id: 'memo-split', title: '사실과 제안 구분', instruction: '정원·진행 시간·참가비 표현을 원문과 대조하세요.', prompt: '결과.txt를 두 메모와 대조해 주세요. 12명은 검토 중, 40분은 제안입니다. 참가비는 확인 필요로 고치고 5줄을 유지해 주세요.' },
  { id: 'memo-submit', title: '결과물 제출', instruction: '직접 읽고 수정한 결과.txt를 제출하세요.', prompt: '결과.txt를 직접 열어 5줄인지 확인하세요. 없는 사실이 추가되지 않았는지 본 다음 제출하세요.' },
  { id: 'memo-keep', title: '내 컴퓨터에 보관', instruction: '내려받은 파일을 직접 열고, 다음에 연습할 곳을 남기세요.', prompt: '결과.txt를 내려받아 내 컴퓨터에서 직접 열어 보세요. 확인한 다음 보관 확인을 표시하고 복습할 단계를 골라 주세요.' },
];
const HOSTILE = '<img src=x onerror=alert(1)>';
const SCRIPT = '<script>alert(1)</script>';

const source = labPage();
assert.match(source, /createLabTerminal/);
assert.match(source, /terminalBox:lab=>LT\.box/);
assert.equal(source.includes('Pretendard'), false);

const html = source.replace('<script src="/webauthn.js"></script>', `<script>${WEBAUTHN_JS}</script>`);
const calls = [];
let classroom = null;
let participants = [];
let failUpdate = false;
let revision = 4;
let holdSend = null, holdDelivered = false;

function statusOf() {
  return { classroom: classroom ? { ...classroom, steps: classroom.steps, materials: classroom.materials, chapters: classroom.chapters } : null, participants };
}
function applyPatch(patch) {
  if (typeof patch.title === 'string') classroom.title = patch.title;
  if (Array.isArray(patch.steps)) classroom.steps = patch.steps;
  if (Array.isArray(patch.materials)) classroom.materials = patch.materials;
  if (typeof patch.recordingUrl === 'string') classroom.recordingUrl = patch.recordingUrl;
  if (Array.isArray(patch.chapters)) classroom.chapters = patch.chapters;
  if (typeof patch.mode === 'string') classroom.mode = patch.mode;
  if (typeof patch.currentStep === 'number') classroom.currentStep = patch.currentStep;
  classroom.revision = ++revision;
  classroom.updatedAt = Date.now();
}
function rich() {
  revision = 4;
  classroom = {
    revision, title: '서버 수업', mode: 'demo', currentStep: 0, updatedAt: 1,
    steps: [
      { id: 's1', title: '첫 단계', instruction: '안내 ' + HOSTILE, prompt: '요청 ' + SCRIPT },
      { id: 's2', title: '둘째 단계', instruction: '다음 안내', prompt: '계속' },
    ],
    materials: [{ name: '메모.txt', content: '자료 ' + HOSTILE }],
    recordingUrl: '',
    chapters: [{ title: '도입 ' + HOSTILE, seconds: 65, step: 0 }],
  };
  participants = [];
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.href === 'https://lab.example/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    const path = url.pathname;
    let body = null;
    if (req.method() === 'POST') { try { body = req.postDataJSON(); } catch { body = req.postData(); } }
    const admin = req.headers()['x-admin-token'] || '';
    if (path.startsWith('/api/')) calls.push({ path, body, admin });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/lab/teacher/status') return json({ error: 'fixture' }, 401);
    if (path === '/api/lab/teacher/session') return json({ error: 'fixture' }, 503);
    if (path === '/api/lab/list') return json({ now: Date.now(), labs: [{ id: 'room1', name: '메모 모임', createdAt: Date.now(), expiresAt: Date.now() + 3600000, budget: 1, cpu: 1, memory: 2, disk: 5, model: '실습 모델', share: [], clip: { in: true, out: true }, seats: [{ n: 1, who: '나무', state: 'started' }] }] });
    if (path === '/api/lab/control/status') return json({ mode: 'running', revision: 0, updatedAt: Date.now() });
    if (path === '/api/lab/terminal/status') return json({ active: false });
    if (path === '/api/lab/snips') return json({ v: 1, items: [] });
    if (path === '/api/lab/screen/status') return json({ screens: {} });
    if (path === '/api/lab/classroom/status') return json(body.id === 'archived-room' ? {...statusOf(),classroom:{...classroom,title:'지난 모임 읽기'}} : statusOf());
    if (path === '/api/lab/classroom/history') return json({courses:[{id:'archived-room',title:'지난 모임 읽기',endedAt:Date.now()-10000,retainUntil:Date.now()+86400000}]});
    if (path === '/api/lab/classroom/update') {
      if (failUpdate) {
        failUpdate = false;
        classroom = { ...classroom, revision: ++revision, title: '서버가 바꿈' };
        return json({ error: 'revision' }, 409);
      }
      applyPatch(body.patch || {});
      return json(statusOf());
    }
    if (path === '/api/lab/classroom/feedback') {
      const person = participants.find((p) => p.n === body.n);
      const sub = person && person.submissions.find((s) => s.id === body.submissionId);
      if (sub) { sub.feedback = body.feedback; sub.feedbackAt = Date.now(); }
      classroom.revision = ++revision;
      return json(statusOf());
    }
    if (path === '/api/lab/classroom/demo/prepare') return json({ state: 'unknown', message: '결과를 확인하지 못했습니다' });
    if (path === '/api/lab/classroom/demo/status') return json({ state: 'ready', message: '' });
    if (path === '/api/lab/classroom/demo/send') {const held=holdSend;if(held){await held;holdDelivered=true;return json({state:'ready',output:'OLD-ROOM-OUTPUT'})}return json({ state: 'unknown', message: '자동 재시도 없음' });}
    if (path === '/api/lab/classroom/demo/open') return json({ url: 'https://demo.example/once' });
    return json({}, path.startsWith('/api/') ? 404 : 404);
  });
  await page.goto('https://lab.example/lab', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const note = document.getElementById('loginNote'); return !!note && note.textContent.length > 0; });
  assert.equal(calls.some((c) => c.path.startsWith('/api/lab/classroom/')), false);
  await page.evaluate(async () => { T = 'fixture-token'; TE = Date.now() + 8 * 60 * 60 * 1000; $('login').hidden = true; $('panel').hidden = false; await load(); bigId = 'hold'; });
  await page.locator('#runGuide').getByText('저장된 수업 구성이 없습니다', {exact:false}).waitFor();
  assert.equal(calls.some((c) => c.path === '/api/lab/classroom/status'), true, '선택한 모임 안내를 자동으로 읽습니다');
  for (const name of ['수업 진행', '수업 준비', '제출·피드백', '복습하기', '설정']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), true, name);
  }
  assert.equal(await page.locator('#settingsDialog a[href="/lab/requests"]').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '1366 overflow before classroom');
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.equal(/pretendard/i.test(font), false);

  await page.getByText('표시할 참여자가 없습니다.', { exact: true }).waitFor();
  await page.getByText('저장된 수업 구성이 없습니다', { exact: false }).waitFor();
  const first = calls.filter((c) => c.path === '/api/lab/classroom/status');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].body, { id: 'room1' });
  assert.equal(first[0].admin, 'fixture-token');
  assert.equal((await page.locator('#classPeople').innerText()).includes('나무'), false);
  assert.equal(await page.locator('#classMain img, #classMain script, #classMain iframe, #classMain video').count(), 0);

  rich();
  await page.getByRole('button', { name: '수업 준비', exact: true }).click();
  const title = page.getByRole('textbox', { name: '수업 이름' });
  await title.waitFor();
  assert.equal(await title.inputValue(), '서버 수업');
  const values = await page.locator('#classMain input, #classMain textarea').evaluateAll((els) => els.map((el) => el.value).join('\n'));
  assert.equal(values.includes(HOSTILE), true);
  assert.equal(values.includes(SCRIPT), true);
  assert.equal(await page.locator('#viewRun img, #viewRun iframe, #viewRun video:not(#broadcastPreviewVideo), #viewRun script, #classPeople img, #classPeople script').count(), 0);

  classroom.title = '서버에서 고친 이름';
  classroom.revision = ++revision;
  await page.getByRole('button', { name: '수업 구성 다시 불러오기', exact: true }).click();
  await page.waitForFunction(() => { const input = document.querySelector('[data-field="title"]'); return input && input.value === '서버에서 고친 이름'; });

  async function reopen(name) {
    await page.getByRole('button', { name: '수업 진행', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
  }
  await page.getByRole('button', { name: '복습하기', exact: true }).click();
  await page.getByText('저장된 녹화 주소가 없습니다.', { exact: true }).waitFor();
  assert.equal((await page.locator('#classMain').innerText()).includes('01:05'), true);
  assert.equal((await page.locator('#classMain').innerText()).includes('도입 ' + HOSTILE), true);
  assert.equal(await page.locator('#classMain video, #classMain iframe').count(), 0);
  classroom.recordingUrl = 'http://insecure.example/lesson';
  classroom.revision = ++revision;
  await reopen('복습하기');
  await page.getByText('저장된 녹화 주소가 https가 아니라 열지 않습니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('#classMain a').count(), 0);
  classroom.recordingUrl = 'https://record.example/lesson';
  classroom.revision = ++revision;
  await reopen('복습하기');
  const recording = page.locator('#classMain a');
  await recording.waitFor();
  assert.equal(await recording.getAttribute('href'), 'https://record.example/lesson');
  assert.equal(await recording.getAttribute('target'), '_blank');
  assert.equal(await page.locator('#classMain video, #classMain iframe').count(), 0);

  participants = [{ n: 1, who: HOSTILE, progress: { step: 0, completed: false, updatedAt: 1 }, submissions: [] }];
  await page.getByRole('button', { name: '제출·피드백', exact: true }).click();
  await page.getByText('저장된 제출물이 없습니다.', { exact: true }).waitFor();
  assert.equal((await page.locator('#classMain').innerText()).includes(HOSTILE), true);
  assert.equal(await page.locator('#classMain img').count(), 0);
  participants[0].submissions = [{ id: 'sub-1', version: 2, filename: '결과.txt', content: '제출 ' + SCRIPT, submittedAt: 1700000000000, step: 0, feedback: '', feedbackAt: null }];
  await page.getByRole('button', { name: '수업 진행', exact: true }).click();
  await page.getByRole('button', { name: '제출·피드백', exact: true }).click();
  await page.getByText('제출 ' + SCRIPT, { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '피드백' }).fill('사실과 제안을 구분했습니다.');
  const feedbackAt = calls.length;
  await page.getByRole('button', { name: '피드백 저장', exact: true }).click();
  await page.getByText('피드백을 저장했습니다.', { exact: true }).waitFor();
  const feedback = calls.slice(feedbackAt).find((c) => c.path === '/api/lab/classroom/feedback');
  assert.deepEqual(feedback.body, { id: 'room1', n: 1, submissionId: 'sub-1', feedback: '사실과 제안을 구분했습니다.' });
  assert.equal(feedback.admin, 'fixture-token');
  await page.getByRole('button', { name: 'ZIP·보관 기록 보기', exact: true }).click();
  await page.getByText('내려받기, 내부 보관, PC에서 직접 열기 확인은 서로 다릅니다.', { exact: false }).waitFor();
  assert.equal(await page.locator('#labs [data-lab="room1"] details[data-lab-section="마무리"]').evaluate((el) => el.open), true);
  assert.equal(calls.some((c) => /zip|archive|download/i.test(c.path)), false);

  async function confirm(name, accept) {
    const message = new Promise((resolve) => {
      page.once('dialog', async (dialog) => { const text = dialog.message(); if (accept) await dialog.accept(); else await dialog.dismiss(); resolve(text); });
    });
    await page.getByRole('button', { name, exact: true }).click();
    return message;
  }
  await page.getByRole('button', { name: '수업 진행', exact: true }).click();
  await page.getByRole('button', { name: '함께 실행', exact: true }).waitFor();
  const dismissed = await confirm('함께 실행', false);
  assert.match(dismissed, /명령은 보내지 않고, 실행 중인 작업도 멈추지 않습니다/);
  assert.equal(calls.filter((c) => c.path === '/api/lab/classroom/update' && c.body.patch && c.body.patch.mode === 'together').length, 0);
  const modeAt = calls.length;
  await confirm('함께 실행', true);
  await page.locator('[data-terminal-host] [data-lab-terminal="room1"]').waitFor();
  const together = calls.slice(modeAt).filter((c) => c.path === '/api/lab/classroom/update');
  assert.equal(together.length, 1);
  assert.deepEqual(together[0].body.patch, { mode: 'together' });
  assert.equal(calls.slice(modeAt).some((c) => c.path === '/api/lab/classroom/demo/send' || c.path === '/api/lab/terminal/send'), false);
  const soloAt = calls.length;
  await confirm('개별 실습', true);
  await page.locator('#classMain .class-demo').getByRole('heading', { name: '내 시연', exact: true }).waitFor();
  assert.equal(await page.getByRole('button',{name:'개별 실습',exact:true}).getAttribute('aria-pressed'),'true','모임지기 시연은 참여자 실습 방식과 별도로 유지됩니다');
  const solo = calls.slice(soloAt).filter((c) => c.path === '/api/lab/classroom/update');
  assert.deepEqual(solo[0].body.patch, { mode: 'individual' });
  assert.equal(calls.slice(soloAt).some((c) => c.path === '/api/lab/classroom/demo/send' || c.path === '/api/lab/terminal/send'), false);
  assert.equal(await page.locator('#classMain [data-terminal-host]').count(), 0);
  assert.equal(await page.locator('#labs [data-lab-terminal="room1"]').count(), 1);
  await confirm('시연 보기', true);
  await page.getByRole('button', { name: '시연실 만들기', exact: true }).waitFor();
  const prepAt = calls.filter((c) => c.path === '/api/lab/classroom/demo/prepare').length;
  const cancelled = await confirm('시연실 만들기', false);
  assert.match(cancelled, /별도인 시연실/);
  assert.match(cancelled, /추가 자원·요금/);
  assert.equal(calls.filter((c) => c.path === '/api/lab/classroom/demo/prepare').length, prepAt);
  await confirm('시연실 만들기', true);
  await page.getByText('결과를 확인하지 못했습니다', { exact: false }).waitFor();
  const prepared = calls.filter((c) => c.path === '/api/lab/classroom/demo/prepare');
  assert.equal(prepared.length, prepAt + 1);
  assert.equal(prepared[prepAt].body.id, 'room1');
  assert.match(prepared[prepAt].body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  await page.waitForTimeout(400);
  assert.equal(calls.filter((c) => c.path === '/api/lab/classroom/demo/prepare').length, prepAt + 1);
  assert.equal(calls.some((c) => c.path === '/api/lab/classroom/demo/send'), false);
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: '시연실 새 탭으로 열기', exact: true }).click();
  const opened = page.locator('#classDemoLink');
  await opened.waitFor();
  assert.equal(await opened.getAttribute('href'), 'https://demo.example/once');
  assert.equal(await opened.innerText(), '시연실 직접 열기');
  assert.match(await page.locator('#classNote').innerText(), /새 탭을 확인/);
  assert.equal(await page.locator('#classMain iframe').count(), 0);

  const stepAt = calls.length;
  const stepMsg = await confirm('다음 단계로 안내', true);
  assert.match(stepMsg, /참여자의 진행 단계는 바꾸지 않습니다/);
  await page.getByText('지금 2 / 2', { exact: false }).waitFor();
  const stepCall = calls.slice(stepAt).find((c) => c.path === '/api/lab/classroom/update');
  assert.deepEqual(stepCall.body.patch, { currentStep: 1 });
  assert.equal(stepCall.body.n, undefined);
  assert.equal(JSON.stringify(stepCall.body).includes('progress'), false);

  await page.getByRole('button', { name: '수업 준비', exact: true }).click();
  await page.getByRole('textbox', { name: '수업 이름' }).fill('내 초안');
  failUpdate = true;
  await page.getByRole('button', { name: '준비 내용 저장', exact: true }).click();
  await page.getByText('입력 초안은 유지했습니다.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '수업 이름' }).inputValue(), '내 초안');
  assert.equal(classroom.title, '서버가 바꿈');
  const templAt = calls.filter((c) => c.path === '/api/lab/classroom/update').length;
  await confirm('메모 연습 템플릿 저장', false);
  assert.equal(calls.filter((c) => c.path === '/api/lab/classroom/update').length, templAt);
  await confirm('메모 연습 템플릿 저장', true);
  await page.getByText('수업 구성을 저장했습니다.', { exact: false }).waitFor();
  const templ = calls.filter((c) => c.path === '/api/lab/classroom/update').at(-1);
  assert.equal(templ.body.patch.mode, undefined);
  assert.equal(templ.body.patch.currentStep, undefined);
  assert.equal(templ.body.patch.title, '메모 두 개로 5줄 보고서 만들기');
  assert.deepEqual(templ.body.patch.steps.map((s) => s.id), TEMPLATE_STEPS.map((s) => s.id));
  assert.deepEqual(templ.body.patch.steps, TEMPLATE_STEPS);
  assert.deepEqual(templ.body.patch.materials, [{ name: '01_요청메모.txt', content: MEMO_REQUEST }, { name: '02_진행메모.txt', content: MEMO_PROGRESS }]);
  assert.deepEqual(Object.keys(templ.body.patch).sort(), ['materials', 'steps', 'title']);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '390 overflow');
  await page.setViewportSize({ width: 1366, height: 768 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '1366 overflow');
  const stored = await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage));
  assert.equal(stored.includes('fixture-token'), false);
  assert.equal(await page.evaluate(() => window.T), undefined);
  // Archive selection is a read-only view and never changes the actual live RID.
  await page.getByRole('button',{name:'제출·피드백',exact:true}).click();
  await page.getByRole('button',{name:'지난 모임 목록 불러오기',exact:true}).click();
  await page.waitForFunction(()=>!!document.querySelector('option[value="archived-room"]'));
  await page.getByRole('combobox',{name:'기록을 볼 모임',exact:true}).selectOption('archived-room');
  await page.getByText(/종료한 모임의 읽기 전용 기록/).waitFor();
  assert.equal(await page.getByRole('button',{name:'피드백 저장',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>RID),'room1');
  assert.equal(calls.filter(c=>c.path==='/api/lab/classroom/status').at(-1).body.id,'archived-room');
  await page.getByRole('button',{name:'수업 진행',exact:true}).click();
  await page.getByRole('button',{name:'시연 명령 보내기',exact:true}).waitFor();
  await page.locator('[data-field="demo-command"]').fill('pwd');
  await page.getByRole('button',{name:'시연 명령 보내기',exact:true}).click();
  await page.getByRole('button',{name:'같은 시연 요청 결과 확인',exact:true}).waitFor();
  await page.getByRole('button',{name:'같은 시연 요청 결과 확인',exact:true}).click();
  const sends=calls.filter(c=>c.path==='/api/lab/classroom/demo/send');
  assert.equal(sends.length,2);assert.deepEqual(sends[0].body,sends[1].body);
  // A command response from a previous room must not populate the new room.
  let releaseSend;holdSend=new Promise(resolve=>{releaseSend=resolve});
  await page.getByRole('button',{name:'같은 시연 요청 결과 확인',exact:true}).click();
  await page.evaluate(()=>{RID='room2';CLASSROOM.sync()});
  await page.waitForFunction(()=>document.querySelector('#classMain .class-demo')?.textContent.includes('내 시연'));
  releaseSend();
  for(let i=0;i<50&&!holdDelivered;i++)await page.waitForTimeout(20);
  assert.equal(holdDelivered,true);await page.waitForTimeout(50);
  assert.equal((await page.locator('#classMain').innerText()).includes('OLD-ROOM-OUTPUT'),false);
  holdSend=null;
  await page.evaluate(()=>{RID='room1';CLASSROOM.sync()});
  await page.getByRole('button',{name:'시연실 만들기',exact:true}).waitFor();
  // Refresh visible progress, without writing or replacing focused preparation.
  await page.clock.install();
  await page.evaluate(async()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'hidden',{configurable:true,value:false});await CLASSROOM.activate()});
  const pollAt=calls.filter(c=>c.path==='/api/lab/classroom/status').length;
  const writesAt=calls.filter(c=>c.path==='/api/lab/classroom/update').length;
  await page.evaluate(()=>CLASSROOM.sync());
  for(let i=0;i<3;i++){await page.clock.runFor(3500);await page.evaluate(()=>CLASSROOM.sync())}
  for(let i=0;i<50&&calls.filter(c=>c.path==='/api/lab/classroom/status').length<=pollAt;i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(calls.filter(c=>c.path==='/api/lab/classroom/status').length>pollAt);
  assert.equal(calls.filter(c=>c.path==='/api/lab/classroom/update').length,writesAt);
  await page.clock.resume();
  const readAt = calls.filter((c) => c.path === '/api/lab/classroom/status').length;
  await page.evaluate(() => { T = null; TE = 0; MON = { expiresAt: Date.now() + 60 * 60 * 1000 }; CLASSROOM.sync(); });
  const started = Date.now();
  while (calls.filter((c) => c.path === '/api/lab/classroom/status').length <= readAt) {
    if (Date.now() - started > 5000) break;
    await page.waitForTimeout(50);
  }
  const readonly = calls.filter((c) => c.path === '/api/lab/classroom/status').at(-1);
  assert.ok(calls.filter((c) => c.path === '/api/lab/classroom/status').length > readAt, 'read-only status was not requested');
  assert.equal(readonly.admin, '');
  assert.deepEqual(errors, []);
  console.log('lab-classroom-teacher-ui: shell, escape, revision, mode, demo, feedback passed');
} finally { await browser.close(); }
