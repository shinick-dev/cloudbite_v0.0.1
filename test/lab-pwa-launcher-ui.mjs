// 실습실 런처(입장 호스트 /) 화면 회귀 테스트 — 브라우저·네트워크·Worker 없이 node:vm 과 가짜 DOM 으로.
//   1) 초대 입력 허용 목록: 런처와 출처가 똑같은 http(s)…/j/<16자>, /j/<16자>, 16자 코드만. 그 밖은 거절
//   2) 누를 때(submit)만 이동하고, 이동 주소는 location.origin + 검증된 코드. 그 전후로 요청·저장소 접근 없음
//   3) 접근성(label·maxlength·aria-describedby·role=alert), 오류는 textContent, 설치 안내(standalone·설치 불가에서도 보임)
//   4) 끝 화면의 "다른 실습실 열기"(/__lab/home)·예전 앱 안내, 자리 호스트 화면(입장·확인·끝)은 manifest 를 광고하지 않음
//   node test/lab-pwa-launcher-ui.mjs
import vm from 'node:vm';
import { labConfirmPage, labEndedPage, labEnterPage, labJoinPage, labLandingPage, WEBAUTHN_JS } from '../src/pages.ts';

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const MANIFEST = /<link rel="manifest"/;
const CODE = 'Ab3_-xYz09QwErTy'; // 16자 base64url

// ── 가짜 DOM: id 로 찾는 요소만. 처음 hidden 은 HTML 속성에서 읽는다 ──
function run(html, { origin = 'https://lab.shinick.dev', standalone = false } = {}) {
  const log = { fetch: [], storage: [], nav: [], focus: 0 };
  const els = new Map();
  const el = (id) => {
    if (els.has(id)) return els.get(id);
    const tag = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
    if (!tag) return null;
    const attrs = new Map();
    const listeners = {};
    const e = {
      id, value: '', textContent: '', hidden: /\shidden(\s|>|=)/.test(tag[0]), onclick: null,
      setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => attrs.has(k) ? attrs.get(k) : null,
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      focus: () => { log.focus++; },
      dispatch(t, ev = {}) { let prevented = false; const evt = { type: t, preventDefault: () => { prevented = true; }, ...ev }; for (const f of listeners[t] || []) f(evt); return prevented; },
    };
    els.set(id, e);
    return e;
  };
  const winListeners = {};
  const trap = (name) => new Proxy({}, { get(_, k) { log.storage.push(`${name}.${String(k)}`); return () => null; } });
  const location = {
    origin,
    get href() { return origin + '/'; }, set href(v) { log.nav.push(['href', v]); },
    assign: (v) => log.nav.push(['assign', v]), replace: (v) => log.nav.push(['replace', v]),
  };
  const ctx = {
    document: { getElementById: el, createElement: () => ({ append() {}, submit() { log.nav.push(['form']); } }), body: { append() {} }, querySelector: () => null },
    location, URL, URLSearchParams, console, setTimeout, performance,
    navigator: { standalone: false, credentials: {}, clipboard: {} },
    matchMedia: (q) => ({ matches: standalone && q.includes('standalone') }),
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    fetch: (...a) => { log.fetch.push(a); return Promise.reject(new Error('no network')); },
    get localStorage() { return trap('localStorage'); }, get sessionStorage() { return trap('sessionStorage'); }, get indexedDB() { return trap('indexedDB'); },
    get cookieStore() { return trap('cookieStore'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const inline = html.split('<script>')[1].split('</script>')[0];
  vm.runInContext(WEBAUTHN_JS + '\n' + inline, ctx);
  const fire = (t, ev = {}) => { for (const f of winListeners[t] || []) f({ preventDefault() {}, ...ev }); };
  return { ctx, el, log, fire, invCode: (raw, o = origin) => vm.runInContext('invCode', ctx)(raw, o) };
}

const L = labLandingPage();

// ── 1. 허용 목록 ──
console.log('초대 입력 허용 목록');
{
  const h = run(L);
  const ok = [
    [`https://lab.shinick.dev/j/${CODE}`, 'https 절대 주소'],
    [`https://lab.shinick.dev/j/${CODE}/`, '끝 /'],
    [`HTTPS://LAB.SHINICK.DEV/j/${CODE}`, '대문자 scheme·host (같은 출처로 정규화)'],
    [`https://lab.shinick.dev:443/j/${CODE}`, '기본 포트 명시'],
    [`  https://lab.shinick.dev/j/${CODE}\n`, '앞뒤 공백·줄바꿈 다듬기'],
    [`/j/${CODE}`, '/j/<코드>'],
    [`/j/${CODE}/`, '/j/<코드>/'],
    [CODE, '코드만'],
    [`\t${CODE} `, '코드 앞뒤 공백'],
  ];
  for (const [s, why] of ok) check(`허용: ${why}`, h.invCode(s) === CODE, h.invCode(s));
  const bad = [
    [`https://lab.shinick.dev.evil.com/j/${CODE}`, '닮은 호스트(접미)'],
    [`https://evil-lab.shinick.dev/j/${CODE}`, '다른 하위 도메인'],
    [`https://lab.shinick.dev./j/${CODE}`, '끝 점 호스트'],
    [`https://lab.shinlck.dev/j/${CODE}`, '철자 닮은 호스트'],
    [`http://lab.shinick.dev/j/${CODE}`, 'scheme 다름(https 런처)'],
    [`https://lab.shinick.dev:8443/j/${CODE}`, '포트 다름'],
    [`//lab.shinick.dev/j/${CODE}`, '// 프로토콜 상대'],
    [`https://lab.shinick.dev//j/${CODE}`, '경로 //'],
    [`javascript:alert(1)//j/${CODE}`, 'javascript:'],
    [`JaVaScRiPt:location='https://evil'`, 'javascript: 대소문자'],
    [`data:text/html,${CODE}`, 'data:'],
    [`https://lab.shinick.dev/j/${CODE.slice(0, 15)}%41`, '퍼센트 인코딩'],
    [`https://lab.shinick.dev/%6a/${CODE}`, '인코딩된 /j'],
    [`https://lab.shinick.dev/x/../j/${CODE}`, '점 세그먼트'],
    [`https://lab.shinick.dev\\j\\${CODE}`, '백슬래시'],
    [`/j\\${CODE}`, '백슬래시 경로'],
    [`https://lab.shinick.dev/j/${CODE}\u0000`, 'NUL'],
    [`https://lab.shinick.dev/j/\t${CODE}`, '가운데 탭'],
    [`https://lab.shinick.dev/j/ ${CODE}`, '가운데 공백'],
    [`https://user:pw@lab.shinick.dev/j/${CODE}`, '계정 정보'],
    [`https://lab.shinick.dev@evil.com/j/${CODE}`, '@ 로 호스트 바꾸기'],
    [`https://lab.shinick.dev/j/${CODE}?x=1`, '쿼리'],
    [`https://lab.shinick.dev/j/${CODE}?`, '빈 쿼리'],
    [`https://lab.shinick.dev/j/${CODE}#a`, '해시'],
    [`https://lab.shinick.dev/j/${CODE}#`, '빈 해시'],
    [`https://lab.shinick.dev/j/${CODE}x`, '17자'],
    [`https://lab.shinick.dev/j/${CODE.slice(1)}`, '15자'],
    [`https://lab.shinick.dev/j/${CODE}//`, '끝 //'],
    [`https://lab.shinick.dev/c/ABC234`, '수업 코드 경로'],
    [`https://lab.shinick.dev/`, '경로 없음'],
    [`https://lab.shinick.dev/j/${CODE.slice(0, 15)}=`, 'base64url 밖 문자'],
    [`https://lab.shinіck.dev/j/${CODE}`, '키릴 문자 호스트'],
    [`ftp://lab.shinick.dev/j/${CODE}`, 'ftp'],
    [`j/${CODE}`, '앞 / 없는 경로'],
    [`${CODE}/`, '코드 뒤 /'],
    [`https://lab.shinick.dev/j/${CODE}`.padEnd(201, ' '), '200자 넘는 입력(공백 포함)'],
    ['x'.repeat(5000), '아주 긴 입력'],
    ['', '빈 입력'],
    ['   ', '공백만'],
  ];
  for (const [s, why] of bad) check(`거절: ${why}`, h.invCode(s) === null, h.invCode(s));
  check('거절: 문자열 아닌 값', h.invCode(undefined) === null && h.invCode(null) === null);

  // 출처는 런처 자신에 묶인다 — shinick 을 박아 두지 않는다
  const dev = run(L, { origin: 'http://localhost:8787' });
  check('localhost 런처: 같은 출처 허용', dev.invCode(`http://localhost:8787/j/${CODE}`) === CODE);
  check('localhost 런처: 운영 주소는 거절', dev.invCode(`https://lab.shinick.dev/j/${CODE}`) === null);
  check('localhost 런처: 포트 다르면 거절', dev.invCode(`http://localhost:8788/j/${CODE}`) === null);
  check('localhost 런처: 코드만은 허용', dev.invCode(CODE) === CODE);
  check('런처 출처가 null 이면 절대 주소 거절', h.invCode(`https://lab.shinick.dev/j/${CODE}`, 'null') === null);
}

// ── 2. 누를 때만 이동 ──
console.log('누를 때만 이동 · 요청·저장 없음');
{
  const h = run(L);
  const inv = h.el('inv'), err = h.el('invErr'), form = h.el('joinForm');
  check('불러온 직후: 이동·요청·저장소 접근 없음', !h.log.nav.length && !h.log.fetch.length && !h.log.storage.length, JSON.stringify(h.log));
  inv.value = `https://lab.shinick.dev/j/${CODE}`;
  check('값만 넣어서는 이동 없음', !h.log.nav.length);
  inv.value = `https://lab.shinick.dev.evil.com/j/${CODE}`;
  const prevented = form.dispatch('submit');
  check('submit 은 기본 동작(폼 전송)을 막는다', prevented);
  check('거절: 이동 없음', !h.log.nav.length, JSON.stringify(h.log.nav));
  check('거절: 한국어 오류를 textContent 로', /초대 링크가 아닙니다/.test(err.textContent), err.textContent);
  check('거절: 입력을 오류 문구에 비추지 않는다', !err.textContent.includes('evil'));
  check('거절: aria-invalid=true · 입력에 초점', inv.getAttribute('aria-invalid') === 'true' && h.log.focus === 1);
  inv.value = `<img src=x onerror=alert(1)>`;
  form.dispatch('submit');
  check('거절: 위험한 입력도 이동 없음', !h.log.nav.length);
  inv.value = `  https://lab.shinick.dev/j/${CODE}/  `;
  form.dispatch('submit');
  check('허용: 한 번만 assign', h.log.nav.length === 1 && h.log.nav[0][0] === 'assign', JSON.stringify(h.log.nav));
  check('허용: 주소는 origin + /j/ + 코드 (입력 그대로가 아님)', h.log.nav[0]?.[1] === `https://lab.shinick.dev/j/${CODE}`, h.log.nav[0]?.[1]);
  check('허용: 오류 지움 · aria-invalid 없앰', err.textContent === '' && inv.getAttribute('aria-invalid') === null);
  check('끝까지 요청·저장소 접근 없음', !h.log.fetch.length && !h.log.storage.length, JSON.stringify(h.log));

  const d = run(L, { origin: 'http://localhost:8787' });
  d.el('inv').value = `/j/${CODE}`;
  d.el('joinForm').dispatch('submit');
  check('dev 출처: 이동 주소도 런처 출처', d.log.nav[0]?.[1] === `http://localhost:8787/j/${CODE}`, JSON.stringify(d.log.nav));
  check('설치 이벤트만으로는 이동 없음', (() => { const x = run(L); x.fire('beforeinstallprompt', { prompt() {}, userChoice: Promise.resolve() }); x.fire('appinstalled'); return !x.log.nav.length && !x.log.fetch.length; })());
}

// ── 3. 접근성·설치 안내 ──
console.log('접근성 · 설치 안내');
{
  check('label for=inv', /<label for="inv">/.test(L));
  const input = L.match(/<input[^>]*id="inv"[^>]*>/)?.[0] || '';
  check('입력: maxlength=200 · aria-describedby(도움말·오류)', /maxlength="200"/.test(input) && /aria-describedby="invHelp invErr"/.test(input), input);
  check('입력: name 없음 (스크립트가 죽어도 코드가 주소에 붙지 않게)', !/\bname=/.test(input));
  check('입력·버튼이 한 폼 안 (Enter 로도 제출), 버튼 type=submit', /<form[^>]*id="joinForm"[\s\S]*id="inv"[\s\S]*<button type="submit" id="invGo">[\s\S]*<\/form>/.test(L));
  check('오류 칸: role=alert · aria-live', /id="invErr"[^>]*role="alert"[^>]*aria-live="polite"/.test(L));
  check('오류는 innerHTML 을 쓰지 않는다', !/innerHTML/.test(L.split('<script>')[1]));
  check('런처는 manifest 를 싣는다', MANIFEST.test(L));
  check('런처 설치 문구: 새 링크 재사용', /새 초대 링크를 받아도/.test(L));
  check('런처 설치 문구: 실습 화면 창 모양이 다를 수 있음', /모양이 달라질 수 있습니다/.test(L));
  check('같은 창 유지를 약속하지 않는다', !/같은 창/.test(L));

  const h = run(L);
  check('브라우저: 설치 카드가 보이고, 설치 불가 안내가 보인다', !h.el('instCard').hidden && !h.el('instMsg').hidden && h.el('inst').hidden);
  h.fire('beforeinstallprompt', { prompt() {}, userChoice: Promise.resolve() });
  check('설치 가능: 설치 버튼 보임', !h.el('inst').hidden);
  h.fire('appinstalled');
  check('설치 뒤: 버튼 숨김, 안내 보임', h.el('inst').hidden && !h.el('instMsg').hidden && /설치했습니다/.test(h.el('instMsg').textContent));

  const s = run(L, { standalone: true });
  check('설치된 앱(standalone): 안내가 보인다', !s.el('instCard').hidden && !s.el('instMsg').hidden && /설치된 앱으로 열려/.test(s.el('instMsg').textContent), s.el('instMsg').textContent);
  s.fire('beforeinstallprompt', { prompt() {}, userChoice: Promise.resolve() });
  check('standalone: 설치 버튼은 띄우지 않는다', s.el('inst').hidden);
}

// ── 4. 끝 화면 · 자리 호스트 화면 ──
console.log('끝 화면 · manifest 광고');
{
  const e1 = labEndedPage('끝났습니다');
  const e2 = labEndedPage('끝났습니다', `https://lab.shinick.dev/j/${CODE}`);
  for (const [n, e] of [['다시 열기 없음', e1], ['다시 열기 있음', e2]]) {
    check(`끝(${n}): "다른 실습실 열기" → /__lab/home`, /<a id="home" href="\/__lab\/home">다른 실습실 열기<\/a>/.test(e));
    check(`끝(${n}): 예전 /__lab/leave 링크 없음`, !/__lab\/leave/.test(e));
    check(`끝(${n}): 예전 설치 앱 안내`, /실습실 첫 화면을 열어 그곳에서 다시 설치/.test(e) && /"다른 실습실 열기"로 새 초대 링크/.test(e));
    check(`끝(${n}): manifest 없음 · 아이콘·색은 유지`, !MANIFEST.test(e) && /theme-color/.test(e) && /rel="icon"/.test(e));
  }
  check('끝: 다시 열기 버튼은 그대로', /<button id="again">다시 열기<\/button>/.test(e2) && !/id="again"/.test(e1));
  const r = run(e2);
  r.el('again').onclick();
  check('끝: 다시 열기 누르면 again 으로', r.log.nav[0]?.[1] === `https://lab.shinick.dev/j/${CODE}`, JSON.stringify(r.log.nav));
  check('끝: 메시지는 textContent', r.el('m').textContent === '끝났습니다');
  const r1 = run(e1);
  check('끝: 불러오기만으로는 이동 없음', !r1.log.nav.length && !r1.log.fetch.length);

  for (const w of [false, true]) {
    const p = labEnterPage(w);
    check(`입장(watch=${w}): manifest 없음 · 아이콘 유지 · / 로 이동 그대로`, !MANIFEST.test(p) && /rel="icon"/.test(p) && /location\.replace\('\/'\)/.test(p));
  }
  const c = labConfirmPage(`https://s-abc.lab.shinick.dev/x?y=1`);
  check('확인: manifest 없음 · 아이콘 유지', !MANIFEST.test(c) && /rel="icon"/.test(c));
  const j = labJoinPage({ code: CODE, seatOrigin: 'https://s-abc.lab.shinick.dev', name: '', seat: 3, who: '', expiresAt: 0, model: 'm' });
  check('초대(/j): manifest 유지', MANIFEST.test(j));
  check('초대(/j): 두 번째 "입장" 버튼 그대로', /<button id="go">입장<\/button>/.test(j));
  const jr = run(j);
  check('초대(/j): 불러오기만으로는 깨우기·이동 없음', !jr.log.nav.length && !jr.log.fetch.length);
}

console.log(`\n${pass} ok, ${failN} fail`);
if (failN) process.exit(1);
