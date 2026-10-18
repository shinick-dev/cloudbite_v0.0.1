// /lab 생성 결과 복구: Edge headless + route 흉내. 실제 서버·공급자·비밀 값 없음.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { labPage, WEBAUTHN_JS } from '../src/pages.ts';

const J = JSON.stringify, ORIGIN = 'http://localhost:8799', KEY = 'labCreateOperation';
const T0 = Date.parse('2026-10-06T09:00:00Z');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let checks = 0;
const check = (label, cond) => { assert.ok(cond, label); checks++; console.log('  ok ' + label); };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const contexts = [];
try {
  async function scene(options = {}) {
    const st = { token: 'test-admin', exp: T0 + 600000, monitor: !!options.monitor, calls: [], errors: [], external: [],
      create: 'abort', result: 'running', snaps: [], labs: [] };
    const ctx = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    contexts.push(ctx);
    await ctx.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url()), p = u.pathname;
      if (u.origin !== ORIGIN) { st.external.push(u.href); return route.abort('blockedbyclient'); }
      const json = (v, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(v) });
      let body; try { body = req.postDataJSON(); } catch { body = null; }
      if (p === '/lab') return route.fulfill({ contentType: 'text/html', body: labPage() });
      if (p === '/webauthn.js') return route.fulfill({ contentType: 'application/javascript', body: WEBAUTHN_JS });
      if (p.startsWith('/__teacher/') || p === '/lab/teacher-sw.js') return route.fulfill({ status: 404, body: '' });
      st.calls.push({ p, body, token: req.headers()['x-admin-token'] });
      if (p === '/api/admin/options') return json({});
      if (p === '/api/admin/login') { st.exp = (await page.evaluate(() => Date.now())) + 600000; return json({ token: st.token, expiresAt: st.exp }); }
      if (p === '/api/lab/teacher/status') return st.monitor ? json({ now: await page.evaluate(() => Date.now()), expiresAt: T0 + 8 * 3600000, labs: st.labs }) : json({ error: 'no monitor' }, 401);
      if (p === '/api/lab/teacher/logout') { st.monitor = false; return json({ ok: true }); }
      if (p === '/api/lab/teacher/push/config') return json({ available: false, expiresAt: T0 + 8 * 3600000 });
      if (p.startsWith('/api/lab/live/')) return json({ error: 'live video is outside this recovery fixture' }, 401);
      if (req.headers()['x-admin-token'] !== st.token || (await page.evaluate(() => Date.now())) >= st.exp || st.authExpired) return json({ error: '관리 시간이 끝났습니다' }, 401);
      if (p === '/api/lab/teacher/session') { st.monitor = true; return json({ expiresAt: T0 + 8 * 3600000 }); }
      if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
      if (p === '/api/lab/list') return json({ labs: st.labs, now: await page.evaluate(() => Date.now()) });
      if (p === '/api/lab/snips') return json({ v: 1, items: [] });
      if (p === '/api/lab/screen/status') return json({ screens: {} });
      if (p === '/api/lab/snapshot') return json(st.snaps.shift() ?? { snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d' });
      const reply = async mode => {
        if (mode === 'abort') return route.abort('failed');
        if (mode === 'limit') return json({ error: 'Daytona 실습실 1개당 메모리 상한은 8 GiB입니다 (요청 9 GiB).' }, 422);
        if (mode === 'not-started') return json({ requestId: body.requestId, creationState: 'not-started' });
        if (mode === 'html500') return route.fulfill({ status: 502, contentType: 'text/html', body: '<script>window.__pwn=1</script>bad gateway' });
        if (mode === 'html401' || mode === 'html404') return route.fulfill({ status: mode === 'html401' ? 401 : 404, contentType: 'text/html', body: 'not JSON' });
        if (mode === 'wrongId') return json({ requestId: 'lc_1760000000000_' + '0'.repeat(32), creationState: 'running' }, 202);
        if (mode === 'bad404') return json({ unexpected: true }, 404);
        if (mode === 'null') return json(null);
        if (mode === 'badCount' || mode === 'badTime') return json({ ok: true, requestId: body.requestId, creationState: 'completed', lab: { id: 'L', name: 'x', createdAt: mode === 'badTime' ? -1 : T0, expiresAt: T0 + 3600000, seatCount: mode === 'badCount' ? 1000000 : 1, failedSeats: 0 } });
        if (mode === 'missing') return json({ error: 'not found' }, 404);
        if (mode === 'ended') return json({ error: 'ended' }, 410);
        if (mode === 'malformed') return json({ ok: true, requestId: body.requestId, creationState: 'completed', lab: { id: 'x', name: '<img src=x onerror=window.__pwn=2>', seatCount: 1 } });
        if (mode === 'snapshot') return json({ requestId: body.requestId, creationState: 'preparing', snapshotPreparing: true, snapshot: 'gw-lab-v4-2c8g10d', state: 'building' }, 202);
        if (mode === 'contradictory') return json({ requestId: body.requestId, creationState: 'unknown', creationPending: true, snapshotPreparing: true, snapshot: 'gw-lab-v4-2c8g10d' }, 202);
        if (mode === 'running' || mode === 'unknown') return json({ requestId: body.requestId, creationState: mode, creationPending: true }, 202);
        if (mode === 'completed') {
          st.labs = [{ id: 'L', name: '고정 수업', expiresAt: T0 + 3600000, cpu: 2, memory: 8, disk: 10, budget: 2, model: 'test/model', clip: { in: true, out: true }, share: [], seats: [{ n: 1, state: 'started', opened: 0 }] }];
          return json({ ok: true, requestId: body.requestId, creationState: 'completed', lab: { id: 'L', name: '<img src=x onerror=window.__pwn=3>', createdAt: T0, expiresAt: T0 + 3600000, seatCount: 1, failedSeats: 0 } });
        }
        throw new Error('unmocked mode ' + mode);
      };
      if (p === '/api/lab/create') return reply(typeof st.create === 'function' ? st.create(body) : st.create);
      if (p === '/api/lab/create-status') return reply(st.result);
      // Other classroom panels have independent service/UI suites.
      if (/^\/api\/lab\/(control|terminal|trial|interrupt|checkpoint|checkpoints|recovery|seat-recovery|assistant|assistants|delivery)\//.test(p)) return json({ error: 'outside recovery fixture' }, 503);
      throw new Error('unmocked path ' + p);
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => st.errors.push(e.message));
    await page.addInitScript(() => { window.__pwn = 0; });
    if (options.storage) await page.addInitScript(({ key, value }) => { sessionStorage.setItem(key, value); }, { key: KEY, value: options.storage });
    if (options.blocked) await page.addInitScript(() => { Storage.prototype.setItem = function () { throw new DOMException('blocked', 'SecurityError'); }; });
    await page.clock.install({ time: new Date(T0) });
    const until = async (fn, label) => { const end = Date.now() + 6000; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout ' + label); await sleep(25); } };
    const text = () => page.$eval('#l_msg', e => e.textContent);
    const state = () => page.$eval('#l_msg', e => e.dataset.state);
    const hits = p => st.calls.filter(x => x.p === p);
    const show = selector => page.$eval(selector, e => !e.hidden && !!e.getClientRects().length);
    const go = async () => { await page.goto(ORIGIN + '/lab'); await page.clock.pauseAt(T0 + 1000); await page.evaluate(() => { tapGet = async () => ({}); window.__pwn = 0; }); };
    const login = async () => { await page.evaluate(() => { tapGet = async () => ({}); }); await page.click(await show('#go') ? '#go' : '#reauth'); await until(() => hits('/api/lab/list').length && page.$eval('#reauth', e => !e.disabled), 'login'); await sleep(100); await page.click('#navPrep'); await page.$eval('#newLab', e => { e.open = true; }); };
    const start = async () => { await page.fill('#l_name', '고정 수업'); await page.click('#l_make'); await until(() => hits('/api/lab/create').length > 0, 'create'); await sleep(120); };
    const recover = async expected => { await page.click('#l_recheck'); await until(async () => await state() === expected && !(await page.$eval('#l_recheck', e => e.disabled)), 'recover ' + expected); };
    await go();
    return { ctx, page, st, until, text, state, hits, show, go, login, start, recover };
  }

  {
    const s = await scene(); await s.login(); s.st.create = 'limit'; await s.start();
    check('HTTP 사양 오류만으로 생성 상태를 추측해 잠금을 풀지 않음', await s.state() === 'unknown' && !(await s.show('#l_new')) && (await s.text()).includes('8 GiB'));
    s.st.result = 'not-started'; await s.recover('not-started');
    check('접수 확인 뒤 명시적 새 입력 경로를 제공하고 자동 재생성하지 않음', await s.state() === 'not-started' && await s.show('#l_new') && s.hits('/api/lab/create').length === 1);
    await s.page.click('#l_new');
    check('사양 거절 뒤 새 입력으로 돌아가도 자동 재생성하지 않음', s.hits('/api/lab/create').length === 1 && !(await s.page.$eval('#l_make', e => e.disabled)));
    s.st.create = 'abort'; await s.start(); s.st.result = 'not-started'; await s.recover('not-started');
    check('예전 자원 생성 전 실패 접수도 결과 복구로 입력 수정을 열 수 있음', await s.show('#l_new') && s.hits('/api/lab/create').length === 2 && (await s.text()).includes('자원 생성 단계 전에 중단'));
    await s.page.locator('#newLab summary').filter({hasText:'고급'}).click();
    check('개별 기본 상한과 전체 조직 한도가 별개임을 고급 설정에서 안내', (await s.page.locator('#newLab').innerText()).includes('조직 전체의 남은 용량과 별개'));
  }

  // 실제 생성이 미확정이면 입력 수정·목록 새로 읽기·반복 클릭 모두 재생성을 열지 않는다.
  {
    const s = await scene({ mobile: true }); await s.login(); await s.start();
    check('끊긴 응답은 unknown, 만들기 잠금', await s.state() === 'unknown' && await s.page.$eval('#l_make', e => e.disabled));
    const first = s.hits('/api/lab/create')[0].body;
    check('안전한 작업 ID', /^lc_[0-9]{13}_[0-9a-f]{32}$/.test(first.requestId));
    check('저장소에는 버전·ID 두 칸만', await s.page.evaluate(({ key, id }) => sessionStorage.getItem(key) === JSON.stringify({ v: 1, requestId: id }), { key: KEY, id: first.requestId }));
    await s.page.fill('#l_name', '바뀐 입력'); await s.page.evaluate(() => { $('l_make').onclick(); $('l_make').onclick(); });
    await s.recover('pending');
    check('running 조회는 한 ID만, 생성 재전송 없음', s.hits('/api/lab/create').length === 1 && s.hits('/api/lab/create-status')[0].body.requestId === first.requestId);
    s.st.result = 'html500'; await s.recover('unknown');
    s.st.result = 'malformed'; await s.recover('unknown');
    check('HTML 5xx·이상한 완료 요약도 unknown 유지', await s.page.$eval('#l_make', e => e.disabled) && !(await s.show('#l_new')) && await s.page.evaluate(() => window.__pwn === 0));
    for (const mode of ['wrongId', 'badCount', 'badTime', 'html404', 'bad404', 'null']) { s.st.result = mode; await s.recover('unknown'); }
    check('ID 불일치·초과 인원·음수 시각·JSON 아닌 404도 잠금', await s.page.$eval('#l_make', e => e.disabled) && !(await s.show('#l_new')));
    const before = s.st.calls.length;
    await s.page.reload(); await s.page.evaluate(() => { tapGet = async () => ({}); }); await sleep(150);
    check('새로고침은 ID만 복원하고 자동 생성·결과 조회 없음', s.st.calls.slice(before).every(c => !['/api/lab/create', '/api/lab/create-status'].includes(c.p)) && await s.state() === 'unknown');
    await s.until(() => s.show('#reauth'), 'monitor');
    check('모니터만 있는 동안 복구는 비활성·재인증 안내', await s.show('#l_reauth') && await s.page.$eval('#l_recheck', e => e.disabled) && !(await s.show('#newForm')));
    await s.page.evaluate(() => $('l_recheck').onclick()); await sleep(100);
    check('모니터 쿠키로 복구 요청을 보내지 않음', s.hits('/api/lab/create-status').length === 9);
    await s.login(); s.st.result = 'completed'; await s.page.click('#l_recheck'); await s.until(async () => await s.state() === 'completed', 'complete'); await sleep(150);
    check('완료는 목록만 갱신하고 명시적 새 입력 버튼', s.hits('/api/lab/create').length === 1 && s.hits('/api/lab/list').length >= 3 && await s.show('#l_new') && await s.page.$eval('#l_make', e => e.disabled));
    check('모바일 복구 상태·버튼이 화면 폭에 맞음', await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && (await s.text()).includes('만들었습니다'));
    check('완료 요약의 악성 이름은 실행·초대 생성 안 됨', await s.page.evaluate(() => window.__pwn === 0) && !s.hits('/api/lab/invite').length);
    await s.page.click('#l_new');
    check('새 작업은 명시적 버튼 뒤에만 열리고 수정 입력 보존', !(await s.page.$eval('#l_make', e => e.disabled)) && await s.page.inputValue('#l_name') === '' && await s.page.evaluate(key => sessionStorage.getItem(key) === null, KEY));
    s.st.create = 'completed'; await s.start();
    check('다음 작업은 다른 ID', s.hits('/api/lab/create')[1].body.requestId !== first.requestId);
    await s.page.clock.runFor(600001); await sleep(120);
    check('완료 뒤 관리 만료는 읽기 전용 모니터만', await s.page.$eval('#labs', e => e.dataset.mode === 'monitor') && !(await s.show('#newForm')));
    check('외부 호출·페이지 오류 없음', s.st.external.length === 0 && s.st.errors.length === 0);
  }

  // 401는 ID를 지우지 않으며 다시 보안 키를 확인할 때까지 조회하지 않는다.
  {
    const s = await scene(); await s.login(); await s.start(); s.st.authExpired = true;
    await s.page.click('#l_recheck'); await s.until(async () => await s.show('#l_reauth'), 'expired');
    const n = s.hits('/api/lab/create-status').length;
    await s.page.evaluate(() => $('l_recheck').onclick()); await sleep(100);
    check('401 뒤 복구 기록·읽기 전용 유지, 새 요청 없음', await s.page.evaluate(key => !!sessionStorage.getItem(key), KEY) && s.hits('/api/lab/create-status').length === n && !(await s.show('#newForm')));
    s.st.authExpired = false; await s.login(); s.st.result = 'ended'; await s.page.click('#l_recheck'); await s.until(async () => await s.state() === 'ended', 'ended');
    check('410는 종료 안내, 자동 생성 없음', (await s.text()).includes('끝났습니다') && s.hits('/api/lab/create').length === 1 && await s.show('#l_new'));
  }
  {
    const s = await scene(); await s.login(); await s.start(); s.st.result = 'html401';
    await s.page.click('#l_recheck'); await s.until(() => s.show('#l_reauth'), 'nonJSON 401');
    check('JSON 아닌 401도 관리 인증을 닫고 재인증 안내', !(await s.show('#newForm')) && await s.page.$eval('#l_recheck', e => e.disabled) && (await s.text()).includes('보안 키'));
    const s2 = await scene({ storage: J({ v: 1, requestId: 'lc_1760000000000_' + '0'.repeat(32) + '\n' }) }); await s2.login();
    check('ID 끝 개행은 유효 저장 기록으로 받아들이지 않음', s2.hits('/api/lab/create-status').length === 0 && (await s2.text()).includes('기록을 읽지 못했습니다'));
  }
  {
    const s = await scene(); await s.login(); await s.start();
    await s.page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (u, o) => String(u) === '/api/lab/create-status' ? (window.__signal = o.signal, new Promise(() => {})) : real(u, o);
      $('l_recheck').onclick();
    });
    await s.page.clock.runFor(10001); await s.until(async () => await s.state() === 'unknown' && !(await s.page.$eval('#l_recheck', e => e.disabled)), 'result timeout');
    check('응답 없는 결과 조회도 10초 뒤 신호를 끊고 같은 ID 복구 가능', await s.page.evaluate(() => window.__signal.aborted) && s.hits('/api/lab/create').length === 1 && await s.page.$eval('#l_make', e => e.disabled));
    const n = await scene(); await n.login(); n.st.create = 'null'; await n.start();
    check('생성 JSON null도 오류 없이 미확정 복구 상태', await n.state() === 'unknown' && n.st.errors.length === 0);
    const ambiguous = await scene(); await ambiguous.login(); ambiguous.st.create = 'contradictory'; await ambiguous.start(); await ambiguous.page.clock.runFor(6000); await sleep(100);
    check('creationPending·unknown은 snapshotPreparing과 섞어 재전송하지 않음', ambiguous.hits('/api/lab/create').length === 1 && ambiguous.hits('/api/lab/snapshot').length === 0 && await ambiguous.state() === 'unknown');
  }
  // 옛 관리 토큰의 늦은 401가 새 관리 세대를 닫지 않는다 (JSON·HTML 모두).
  for (const [path, nonJSON] of [['/api/lab/create-status', false], ['/api/lab/create-status', true], ['/api/lab/snapshot', false]]) {
    const s = await scene(); await s.login(); await s.start();
    await s.page.evaluate(path => {
      const real = window.fetch;
      window.fetch = (u, o) => String(u) === path ? new Promise(resolve => { window.__oldResolve = resolve; }) : real(u, o);
      if (path.endsWith('create-status')) $('l_recheck').onclick();
      else snapPoll({ snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10 }, 10000).catch(() => { window.__oldDone = true; });
    }, path);
    await s.until(() => s.page.evaluate(() => typeof window.__oldResolve === 'function'), 'old pending request');
    await s.page.evaluate(() => { admExpired(); });
    await s.login();
    await s.page.evaluate(nonJSON => { window.__oldResolve(new Response(nonJSON ? 'old HTML login failure' : JSON.stringify({ error: 'old token expired' }), { status: 401, headers: { 'content-type': nonJSON ? 'text/html' : 'application/json' } })); }, nonJSON);
    await s.until(() => path.endsWith('create-status') ? s.page.$eval('#l_recheck', e => !e.disabled) : s.page.evaluate(() => window.__oldDone), 'old response');
    check(`옛 ${path} ${nonJSON ? 'HTML' : 'JSON'} 401 뒤 새 관리 인증 유지`, await s.show('#newForm') && await s.page.evaluate(() => H()['x-admin-token'] === 'test-admin'));
  }

  // 스냅샷 대기 중 마지막 만들기는 동일 ID·JSON. reload 준비 상태는 원래 입력을 복원하지 않는다.
  {
    const s = await scene(); await s.login(); await s.page.selectOption('#l_spec', 'custom'); await s.page.fill('#l_memory', '8');
    s.st.create = () => s.hits('/api/lab/create').length === 1 ? 'snapshot' : 'completed';
    await s.start(); await s.until(async () => (await s.text()).includes('준비 중'), 'snapshot');
    const original = J(s.hits('/api/lab/create')[0].body);
    await s.page.fill('#l_name', '바뀜'); await s.page.fill('#l_disk', '20'); await s.page.evaluate(() => { $('l_make').onclick(); $('l_make').onclick(); });
    await s.page.clock.runFor(5001); await s.until(async () => await s.state() === 'completed', 'snapshot ready');
    check('snapshotPreparing은 조회만 하고 ready 뒤 같은 JSON·ID로 한 번 생성', s.hits('/api/lab/create').length === 2 && J(s.hits('/api/lab/create')[1].body) === original && s.hits('/api/lab/snapshot').length === 1);
    check('대기 동안 수정한 입력은 성공 뒤에도 보존', await s.page.inputValue('#l_name') === '바뀜' && await s.page.inputValue('#l_disk') === '20');
    const id = s.hits('/api/lab/create')[0].body.requestId;
    const r = await scene({ monitor: true, storage: J({ v: 1, requestId: id }) });
    await r.login(); r.st.result = 'snapshot'; await r.page.click('#l_recheck'); await r.until(async () => await r.state() === 'preparingRestored', 'restored snapshot');
    check('새로고침된 스냅샷 준비는 미생성 안내, 자동 POST 없이 명시적 새 입력', r.hits('/api/lab/create').length === 0 && r.hits('/api/lab/snapshot').length === 0 && (await r.text()).includes('수업은 아직 만들지 않았습니다') && await r.show('#l_new'));
  }

  // 준비됨 200이 늦게 와도 처음 누른 인증 의도를 새 인증으로 이어 보내지 않는다.
  for (const [source, boundary] of [['create', 'logout'], ['recovery', 'reauth'], ['create', 'expiry']]) {
    const s = await scene(); await s.login(); await s.page.selectOption('#l_spec', 'custom'); await s.page.fill('#l_memory', '8');
    if (source === 'create') s.st.create = 'snapshot';
    await s.start(); const original = J(s.hits('/api/lab/create')[0].body), id = s.hits('/api/lab/create')[0].body.requestId;
    await s.page.evaluate(() => {
      window.__snapshotRealFetch = window.fetch;
      window.fetch = (u, o) => String(u) === '/api/lab/snapshot' ? (window.__waitSignal = o.signal, new Promise(resolve => { window.__readyResolve = resolve; })) : window.__snapshotRealFetch(u, o);
    });
    if (source === 'recovery') { s.st.result = 'snapshot'; await s.page.click('#l_recheck'); await s.until(async () => (await s.text()).includes('준비 중'), 'recovery wait'); }
    await s.page.clock.runFor(5001); await s.until(() => s.page.evaluate(() => typeof window.__readyResolve === 'function'), 'held ready');
    const generation = await s.page.evaluate(() => AG);
    if (boundary === 'logout') {
      await s.page.click('#navSet'); await s.page.click('#logout'); await s.until(() => s.page.evaluate(() => !LOP), 'logout'); s.st.token = 'test-admin-next'; await s.login();
    } else if (boundary === 'reauth') {
      s.st.token = 'test-admin-next'; await s.page.evaluate(() => login());
    } else {
      await s.page.evaluate(() => { TE = Date.now(); });
      check('만료 시각만 지난 경우도 관리 세대 변경 전 확인', await s.page.evaluate(a => AG === a && !adm(), generation));
    }
    await s.page.evaluate(() => { window.__readyResolve(new Response(JSON.stringify({ snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d' }), { status: 200, headers: { 'content-type': 'application/json' } })); });
    await s.until(() => s.page.evaluate(() => !making), 'old ready stopped');
    check(`${source} 대기 중 ${boundary} 뒤 늦은 준비됨은 재생성 없이 명시적 복구 대기`, s.hits('/api/lab/create').length === 1 && await s.state() === 'unknown' && (await s.text()).includes('결과 복구') && await s.page.evaluate(id => OP.id === id && OP.sent !== null, id));
    check(`${boundary} 뒤 늦은 준비됨은 원래 입력·작업 ID 보존`, await s.page.inputValue('#l_name') === '고정 수업' && await s.page.evaluate(({ key, id }) => JSON.parse(sessionStorage.getItem(key)).requestId === id, { key: KEY, id }));
    await s.page.evaluate(() => { window.fetch = window.__snapshotRealFetch; });
    if (boundary === 'expiry') { await s.page.evaluate(() => admExpired()); s.st.token = 'test-admin-next'; await s.login(); }
    s.st.result = 'snapshot'; s.st.create = 'completed'; await s.page.click('#l_recheck');
    await s.until(async () => (await s.text()).includes('준비 중'), 'explicit recovery wait');
    await s.page.clock.runFor(5001); await s.until(async () => await s.state() === 'completed', 'explicit ready recovery');
    check(`${source} ${boundary} 중단 뒤 현재 인증의 명시적 복구만 같은 입력으로 진행`, s.hits('/api/lab/create').length === 2 && J(s.hits('/api/lab/create')[1].body) === original && s.hits('/api/lab/create')[1].token === 'test-admin-next' && s.st.errors.length === 0 && s.st.external.length === 0);
  }

  // 응답 없는 poll도 인증이 사라지면 8분 제한까지 묶어 두지 않고 신호를 끊는다.
  {
    const s = await scene(); await s.login(); await s.page.selectOption('#l_spec', 'custom'); await s.page.fill('#l_memory', '8'); s.st.create = 'snapshot';
    await s.page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (u, o) => String(u) === '/api/lab/snapshot' ? (window.__waitSignal = o.signal, new Promise(() => {})) : real(u, o);
    });
    await s.start(); await s.page.clock.runFor(5001); await s.until(() => s.page.evaluate(() => !!window.__waitSignal), 'poll pending');
    await s.page.evaluate(() => admExpired()); await s.page.clock.runFor(251); await s.until(() => s.page.evaluate(() => !making), 'poll interrupted');
    check('응답 없는 poll은 관리 만료 뒤 중단·abort, 생성 잠금과 ID 유지', await s.page.evaluate(() => window.__waitSignal.aborted && OP.state === 'unknown' && OP.sent !== null) && s.hits('/api/lab/create').length === 1 && await s.page.$eval('#l_make', e => e.disabled));
    const waiting = await scene(); await waiting.login(); await waiting.page.selectOption('#l_spec', 'custom'); await waiting.page.fill('#l_memory', '8'); waiting.st.create = 'snapshot'; await waiting.start();
    await waiting.page.evaluate(() => admExpired()); await waiting.page.clock.runFor(251); await waiting.until(() => waiting.page.evaluate(() => !making), 'timer interrupted');
    check('5초 간격을 기다리는 중 관리 만료도 poll 전 중단', waiting.hits('/api/lab/snapshot').length === 0 && waiting.hits('/api/lab/create').length === 1 && await waiting.state() === 'unknown');
  }

  // 작업이 바뀌면 옛 준비됨·완료·오류가 현재 작업·입력·안내를 덮어 쓰지 않는다.
  for (const [path, reply] of [['/api/lab/snapshot', 200], ['/api/lab/create', 200], ['/api/lab/create-status', 200], ['/api/lab/snapshot', 401], ['/api/lab/create', 401], ['/api/lab/create-status', 410], ['/api/lab/create-status', 'html401']]) {
    const s = await scene(); await s.login(); await s.page.selectOption('#l_spec', 'custom'); await s.page.fill('#l_memory', '8');
    if (path === '/api/lab/snapshot') s.st.create = 'snapshot';
    await s.page.evaluate(path => {
      const real = window.fetch;
      window.fetch = (u, o) => String(u) === path ? new Promise(resolve => { window.__staleResolve = resolve; window.__staleBody = JSON.parse(o.body); }) : real(u, o);
    }, path);
    if (path === '/api/lab/create') { await s.page.fill('#l_name', '고정 수업'); await s.page.click('#l_make'); }
    else { await s.start(); if (path === '/api/lab/create-status') await s.page.click('#l_recheck'); else await s.page.clock.runFor(5001); }
    await s.until(() => s.page.evaluate(() => typeof window.__staleResolve === 'function'), 'stale operation pending');
    const creates = s.hits('/api/lab/create').length, lists = s.hits('/api/lab/list').length;
    await s.page.evaluate(path => {
      const id = 'lc_' + Date.now() + '_' + 'a'.repeat(32);
      if (path === '/api/lab/snapshot') { OP.id = id; OP.state = 'unknown'; OP.sent = null; }
      else OP = { id, state: 'unknown', sent: null }; making = false; opSave(); opNote('현재 작업 안내', 'mut'); $('l_name').value = '새 입력';
    }, path);
    const current = await s.page.evaluate(() => OP.id);
    await s.page.evaluate(({ path, reply }) => {
      const result = path === '/api/lab/snapshot' ? { snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d' } : { ok: true, requestId: window.__staleBody.requestId, creationState: 'completed', lab: { id: 'old', name: 'old', createdAt: Date.now(), expiresAt: Date.now() + 3600000, seatCount: 1, failedSeats: 0 } };
      window.__staleResolve(new Response(reply === 'html401' ? 'old HTML failure' : JSON.stringify(reply === 200 ? result : { error: 'old failure' }), { status: reply === 'html401' ? 401 : reply, headers: { 'content-type': reply === 'html401' ? 'text/html' : 'application/json' } }));
    }, { path, reply });
    await sleep(150); await s.page.clock.runFor(251);
    check(`옛 ${path} ${reply} 응답은 바뀐 작업·안내·입력 그대로 유지`, await s.page.evaluate(id => OP.id === id && OP.state === 'unknown' && !making, current) && await s.text() === '현재 작업 안내' && await s.page.inputValue('#l_name') === '새 입력' && s.hits('/api/lab/snapshot').length === 0 && s.hits('/api/lab/create').length === creates && s.hits('/api/lab/list').length === lists && await s.show('#newForm') && s.st.errors.length === 0);
  }

  // 탭별 저장 ID, 차단·오염 저장소의 처리.
  {
    const a = await scene(), b = await scene(); await a.login(); await b.login(); await a.start(); await b.start();
    check('별도 탭은 별도 ID, 복구 대상이 섞이지 않음', a.hits('/api/lab/create')[0].body.requestId !== b.hits('/api/lab/create')[0].body.requestId);
    a.st.result = 'completed'; await a.page.click('#l_recheck'); await a.until(async () => await a.state() === 'completed', 'a');
    check('한 탭 완료가 다른 탭의 pending을 풀지 않음', await b.state() === 'unknown' && await b.page.$eval('#l_make', e => e.disabled));
    const blocked = await scene({ blocked: true }); await blocked.login(); await blocked.start();
    check('저장 차단은 메모리 복구 유지·새로고침 한계 안내', (await blocked.text()).includes('새로고침하면') && await blocked.state() === 'unknown' && blocked.st.errors.length === 0);
    const malformed = await scene({ storage: J({ v: 1, requestId: '<script>bad</script>', token: 'bad' }) }); await malformed.login();
    check('이상한 저장소는 인증·자동 POST·스크립트 실행 없이 처리', malformed.hits('/api/lab/create').length === 0 && malformed.hits('/api/lab/create-status').length === 0 && malformed.st.errors.length === 0 && (await malformed.text()).includes('기록을 읽지 못했습니다'));
  }
  console.log(`\n${checks} checks passed`);
} finally { await Promise.all(contexts.map(c => c.close())); await browser.close(); }
