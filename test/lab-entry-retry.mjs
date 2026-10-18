// 자리 초대 화면(labJoinPage)의 깨우기 반복을 가상 시계로 돌려 본다.
// 브라우저·Worker·네트워크 없이: src/pages.ts 를 esbuild 로 메모리에서 묶고, /__lab/app.js(WEBAUTHN_JS)와 인라인 스크립트를
// node:vm 에서 가짜 DOM·fetch·performance.now·setTimeout 위에서 돌린다. 시간은 테스트가 직접 넘긴다 (실제로 기다리지 않음).
//   node test/lab-entry-retry.mjs
// 확인하는 것: 요청 시작 간격 ≥2.5초·응답 뒤 ≥0.25초(느린/빠른 응답), 동시 요청 0 (두 번 클릭 + Enter), 버튼 잠금·풀림,
//              API 거절 뒤 다시 시도, 5분 넘긴 늦은 ready·자료 경고 대기가 폼을 보내지 않음, 마감 뒤 요청 시작 없음,
//              120번 상한, POST /__lab/wake·폼 POST /__lab/enter 의 code·watch 필드, 서버 값은 textContent 로만.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

const r = await build({
  entryPoints: [resolve(SRC, 'pages.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', absWorkingDir: ROOT,
});
const pages = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
const inlineScripts = (h) => [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);

const DEADLINE = 300_000;
const JOIN = { code: 'abcdefghijklmnop', seatOrigin: 'https://s1.lab.example.test', name: '수업', seat: 3, who: '', expiresAt: 1_800_000_000_000, model: 'test/model' };

// 가짜 브라우저. reply(call) → { after: ms, status?: number, body } | null(영원히 응답 없음)
function browser({ o = JOIN, search = '', reply }) {
  let t = 0, seq = 0;
  const timers = [];
  const at = (ms, fn) => timers.push({ when: t + Math.max(0, ms), seq: seq++, fn });
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, {
      id, hidden: false, disabled: false, value: '', className: '', onclick: null, onkeydown: null,
      _text: '', htmlSet: 0,
      get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
      get innerHTML() { return this._text; }, set innerHTML(v) { this.htmlSet++; this._text = String(v); },
      // 브라우저처럼: 잠긴 버튼은 click() 해도 onclick 이 불리지 않는다
      click() { if (!this.disabled && this.onclick) this.onclick({}); },
    });
    return els.get(id);
  };
  const calls = [], submits = [];
  let inflight = 0, maxInflight = 0;
  const fetch = (path, init) => {
    const c = { path, method: init.method, headers: init.headers, body: JSON.parse(init.body), start: t, end: null };
    calls.push(c);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const p = reply(c, calls.length - 1);
    return new Promise((res) => {
      if (!p) return;
      at(p.after, () => {
        inflight--; c.end = t;
        const status = p.status ?? 200;
        res({ ok: status >= 200 && status < 300, status, json: async () => { if (p.body === undefined) throw new SyntaxError('bad json'); return p.body; } });
      });
    });
  };
  const document = {
    getElementById: el,
    createElement: (tag) => {
      const n = { tag, children: [], append(...x) { this.children.push(...x); }, submit() { submits.push({ t, method: this.method, action: this.action, fields: this.children.map((i) => [i.type, i.name, i.value]) }); } };
      return n;
    },
    body: { append() {} },
    querySelector: () => ({ prepend() {} }),
  };
  const ctx = {
    document, fetch, location: { search }, URLSearchParams, JSON, Math, Promise, Error, Date,
    performance: { now: () => t },
    setTimeout: (fn, ms) => { at(ms, fn); return seq; },
  };
  vm.createContext(ctx);
  const h = pages.labJoinPage(o);
  vm.runInContext(pages.WEBAUTHN_JS, ctx);
  for (const s of inlineScripts(h)) vm.runInContext(s, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((x) => setImmediate(x)); };
  // 가장 이른 타이머부터 하나씩: 시간을 그 시각으로 옮기고 실행, 마이크로태스크 비우기
  async function runUntil(limit) {
    await flush();
    for (;;) {
      timers.sort((a, b) => a.when - b.when || a.seq - b.seq);
      if (!timers.length || timers[0].when > limit) break;
      const x = timers.shift();
      t = Math.max(t, x.when); x.fn(); await flush();
    }
    t = Math.max(t, limit);
  }
  return { el, calls, submits, runUntil, flush, html: h, get now() { return t; }, get maxInflight() { return maxInflight; }, get pending() { return timers.length; } };
}

const preparing = (after, detail = '자리 깨우는 중') => ({ after, body: { status: 'preparing', detail } });
const ready = (after, extra = {}) => ({ after, body: { status: 'ready', ...extra } });
const gaps = (cs) => cs.slice(1).map((c, i) => c.start - cs[i].start);
const afterResp = (cs) => cs.slice(1).map((c, i) => c.start - cs[i].end);

console.log('[느린 응답: 응답 뒤 0.25초]');
{
  const b = browser({ reply: (c, i) => (i < 4 ? preparing(3000) : ready(3000)) });
  b.el('go').click(); await b.runUntil(60_000);
  check('요청 5번', b.calls.length === 5, String(b.calls.length));
  check('시작 간격 = 3000 + 250', gaps(b.calls).every((g) => g === 3250), JSON.stringify(gaps(b.calls)));
  check('응답 뒤 0.25초', afterResp(b.calls).every((g) => g === 250), JSON.stringify(afterResp(b.calls)));
  check('폼 1번 제출', b.submits.length === 1);
  const s = b.submits[0];
  check('폼: POST → 자리 출처 /__lab/enter', s.method === 'post' && s.action === JOIN.seatOrigin + '/__lab/enter', JSON.stringify(s));
  check('폼: code·watch 숨은 필드', JSON.stringify(s.fields) === JSON.stringify([['hidden', 'code', JOIN.code], ['hidden', 'watch', '']]), JSON.stringify(s.fields));
  check('깨우기는 POST JSON', b.calls.every((c) => c.path === '/__lab/wake' && c.method === 'POST' && c.headers['content-type'] === 'application/json'));
  check('이름은 첫 요청에만', b.calls[0].body.name === '' && b.calls.every((c) => c.body.code === JOIN.code && c.body.name === ''));
  // 기존(응답 뒤 고정 2.5초)이면 간격이 5500 — 응답이 느릴수록 최대 2.25초까지 덜 잔다
  check('기존 대비 간격 2250ms 짧음 (클라이언트 계산일 뿐, 실측 지연 아님)', 3000 + 2500 - gaps(b.calls)[0] === 2250);
}

console.log('[빠른 응답: 시작 간격 2.5초]');
{
  const b = browser({ reply: (c, i) => (i < 6 ? preparing(100) : ready(100)) });
  b.el('nm').value = '  철수 '; b.el('go').click(); await b.runUntil(60_000);
  check('시작 간격 정확히 2500', gaps(b.calls).every((g) => g === 2500), JSON.stringify(gaps(b.calls)));
  check('첫 요청에 이름(trim)', b.calls[0].body.name === '철수' && b.calls.slice(1).every((c) => c.body.name === ''));
  check('폼 1번 제출', b.submits.length === 1 && b.submits[0].t === 6 * 2500 + 100);
  check('진행 문구는 응답 시각 기준', b.el('st').textContent === '여는 중…');
}
{
  const b = browser({ reply: (c, i) => (i < 6 ? preparing(2400) : ready(100)) });
  b.el('go').click(); await b.runUntil(60_000);
  check('2.4초 응답: 시작 간격 2650 (응답 뒤 0.25초가 이김)', gaps(b.calls).slice(0, 5).every((g) => g === 2650), JSON.stringify(gaps(b.calls)));
}

console.log('[한 번에 하나: 두 번 클릭 + Enter]');
{
  const b = browser({ reply: (c, i) => (i < 2 ? preparing(1000) : ready(500)) });
  b.el('go').click(); b.el('go').click(); b.el('nm').onkeydown({ key: 'Enter' });
  b.el('go').onclick({}); // 잠금을 우회해 핸들러를 직접 불러도
  check('버튼 잠김', b.el('go').disabled === true);
  await b.runUntil(1);
  check('첫 순간 요청 1개', b.calls.length === 1, String(b.calls.length));
  await b.runUntil(60_000);
  check('동시 요청 최대 1', b.maxInflight === 1, String(b.maxInflight));
  check('전체 요청 3번, 폼 1번', b.calls.length === 3 && b.submits.length === 1, `${b.calls.length}/${b.submits.length}`);
}

console.log('[API 거절 → 다시 시도]');
{
  const b = browser({ reply: (c, i) => (i === 0 ? preparing(100) : i === 1 ? { after: 100, status: 503, body: { error: '<b>잠시</b> 뒤에' } } : i === 2 ? preparing(100) : ready(100)) });
  b.el('nm').value = '영희'; b.el('go').click(); await b.runUntil(10_000);
  check('거절 뒤 요청 2번에서 멈춤', b.calls.length === 2, String(b.calls.length));
  check('오류는 textContent 그대로', b.el('err').textContent === '<b>잠시</b> 뒤에' && b.el('err').htmlSet === 0);
  check('다시 누를 수 있게 복구', b.el('go').disabled === false && b.el('nameCard').hidden === false && b.el('wait').hidden === true);
  check('폼 제출 없음', b.submits.length === 0);
  b.el('go').click(); await b.runUntil(60_000);
  check('다시 누르면 이름 다시 보냄', b.calls[2].body.name === '영희' && b.calls[3].body.name === '');
  check('다시 시도는 바로 시작', b.calls[2].start === 10_000);
  check('다시 시도 후 폼 1번', b.submits.length === 1 && b.el('err').textContent === '');
}
{
  const b = browser({ reply: () => ({ after: 50, status: 502, body: undefined }) });
  b.el('go').click(); await b.runUntil(1000);
  check('JSON 아닌 거절도 복구 (HTTP 502)', b.el('err').textContent === 'HTTP 502' && b.el('go').disabled === false);
}

console.log('[마감 5분]');
{
  const b = browser({ reply: () => null }); // 영원히 응답 없음
  b.el('go').click(); await b.runUntil(DEADLINE * 3);
  check('응답 없으면 요청 1개, 동시 0', b.calls.length === 1 && b.maxInflight === 1);
  check('응답 전엔 잠금 유지 (새 요청 못 겹침)', b.el('go').disabled === true);
}
{
  const b = browser({ reply: () => preparing(100) });
  b.el('go').click(); await b.runUntil(DEADLINE * 2);
  check('계속 준비 중: 120번에서 멈춤', b.calls.length === 120, String(b.calls.length));
  check('마감 뒤 요청 시작 없음', b.calls.every((c) => c.start < DEADLINE), String(b.calls.at(-1).start));
  check('시간 초과 문구·복구', b.el('err').textContent === '시간이 오래 걸립니다. 새로고침해 보세요.' && b.el('go').disabled === false && b.el('nameCard').hidden === false);
  check('남은 타이머 없음', b.pending === 0);
  check('폼 제출 없음', b.submits.length === 0);
  const n = b.calls.length;
  b.el('go').click(); await b.runUntil(b.now + 1);
  check('새 클릭은 새 120번 (사용자 활성화마다)', b.calls.length === n + 1);
}
{
  // 응답이 4초 걸리면 시작 간격 4250 → 마감 전 71번, 상한 전에 마감이 먼저
  const b = browser({ reply: () => preparing(4000) });
  b.el('go').click(); await b.runUntil(DEADLINE * 2);
  check('느린 응답: 마감 뒤 시작 없음', b.calls.every((c) => c.start < DEADLINE) && b.calls.length === Math.ceil(DEADLINE / 4250), String(b.calls.length));
}
{
  // 마감 직전에 시작한 요청이 마감 뒤 ready 로 돌아옴
  const b = browser({ reply: (c) => (c.start < 297_000 ? preparing(100) : ready(DEADLINE + 1000 - c.start)) });
  b.el('go').click(); await b.runUntil(DEADLINE * 2);
  check('늦은 ready 는 폼을 보내지 않음', b.submits.length === 0 && b.calls.at(-1).end > DEADLINE, JSON.stringify(b.calls.at(-1)));
  check('늦은 ready 뒤 복구', b.el('go').disabled === false && b.el('err').textContent.startsWith('시간이'));
}
{
  // ready + 자료 경고: 4초 기다리는 사이 마감을 넘김
  const b = browser({ reply: (c) => (c.start < 297_000 ? preparing(100) : ready(100, { materials: '<img src=x onerror=alert(1)>' })) });
  b.el('go').click(); await b.runUntil(DEADLINE * 2);
  check('경고 대기가 마감을 넘기면 폼 없음', b.submits.length === 0);
  check('경고 대기 뒤 복구', b.el('go').disabled === false && b.el('err').textContent.startsWith('시간이'));
}
{
  const b = browser({ reply: (c, i) => (i < 1 ? preparing(100) : ready(100, { materials: '<img src=x onerror=alert(1)>' })) });
  b.el('go').click(); await b.runUntil(2600);
  check('자료 경고는 textContent', b.el('err').textContent === '수업 자료를 넣지 못했습니다: <img src=x onerror=alert(1)>' && b.el('err').htmlSet === 0);
  check('경고 보이는 4초 동안은 제출 전', b.submits.length === 0);
  await b.runUntil(60_000);
  check('마감 전 경고는 4초 뒤 제출', b.submits.length === 1 && b.submits[0].t === 2600 + 4000);
}

console.log('[주입]');
{
  const evil = '</script><script>globalThis.pwned=1</script>';
  const o = { ...JOIN, name: evil, who: evil, model: evil, code: 'abcdefghijklmnop' };
  const b = browser({ o, search: '?watch=1', reply: (c, i) => (i < 1 ? preparing(100, evil) : ready(100, { name: evil, who: evil })) });
  check('인라인 스크립트에 </script> 안 새어 나감', !inlineScripts(b.html).some((s) => s.includes('</script')) && !b.html.includes(evil));
  check('제목·자리 줄은 textContent', b.el('title').textContent === evil && b.el('seatLine').textContent.includes(evil) && b.el('title').htmlSet === 0);
  b.el('go').click(); await b.runUntil(1000);
  check('detail 은 textContent', b.el('st').textContent.startsWith(evil) && b.el('st').htmlSet === 0);
  await b.runUntil(60_000);
  check('watch=1: 이름 안 보냄·폼 watch=1', b.calls[0].body.name === '' && JSON.stringify(b.submits[0].fields[1]) === '["hidden","watch","1"]');
  const s = inlineScripts(b.html).join('\n');
  check('labJoinPage 스크립트: innerHTML·Date.now 없음, performance.now 사용', !s.includes('innerHTML') && !s.includes('Date.now') && s.includes('performance.now()'));
  check('labJoinPage: 외부 스크립트는 /__lab/app.js 하나', JSON.stringify([...b.html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)].map((m) => m[1])) === '["/__lab/app.js"]');
}

console.log(`\n${pass} ok, ${failN} fail, 0 skip`);
process.exit(failN ? 1 : 0);
