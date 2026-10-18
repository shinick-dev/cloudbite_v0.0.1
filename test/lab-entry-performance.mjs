// 자리 호스트 입장 화면(labEnterPage)이 외부 스크립트(/__lab/app.js)를 기다리지 않고 곧바로 / 로 넘어가는지 본다.
// 브라우저·Worker·네트워크·loopback 없이: src/pages.ts 를 esbuild 로 메모리에서 묶고, 인라인 스크립트를 node:vm 에서 돌린다.
// 기준(baseline)은 git 의 BASE 커밋 pages.ts — 같은 방식으로 묶어 비교한다 (git 이 없으면 기준 비교만 건너뛴다).
//   node test/lab-entry-performance.mjs
// 확인하는 것: 외부 script 0개(기준 1개), watch 참/거짓 각각 sessionStorage set/remove 후 location.replace('/'),
//              sessionStorage 가 throw 해도 이동, 아이콘 머리(theme-color·icon)·한국어 안내·대체 링크 유지 — 자리 호스트 화면이라
//              manifest 는 광고하지 않는다(설치는 입장 호스트 런처에서), 인라인 이벤트 핸들러 없음, 다른 실습실 화면(초대·확인·랜딩·끝)은
//              app.js 를 그대로 쓰고, 초대·런처만 manifest 를 싣는다. 확인 화면은 manifest 한 줄만 빼면 기준과 바이트까지 같다
//              (런처·끝 화면 문구는 의도적으로 바뀌었다 — test/lab-pwa-launcher-ui.mjs 가 본다).

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const BASE = '4203f6e2c47bca1d43aee8ad76cf2ea5b8782dc7';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const skip = (name, why) => { skipN++; console.log(`  skip ${name} (${why})`); };

// pages.ts 소스 → 모듈 (#lab-renderer 는 package.json imports 로 풀린다)
async function load(contents) {
  const r = await build({
    stdin: { contents, loader: 'ts', resolveDir: SRC, sourcefile: 'pages.ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', absWorkingDir: ROOT,
  });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}

const MANIFEST_LINK = '<link rel="manifest" href="/__lab/manifest.webmanifest">';
const externalScripts = (h) => [...h.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
const inlineScripts = (h) => [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);

// 인라인 스크립트를 브라우저 대신 vm 에서 — sessionStorage·location 호출 순서를 기록한다
function run(h, { storageThrows = false, initial = {} } = {}) {
  const log = [], store = new Map(Object.entries(initial));
  const boom = (op) => { log.push(op + ':throw'); throw new DOMException('denied', 'SecurityError'); };
  const sessionStorage = {
    setItem(k, v) { if (storageThrows) boom('set'); log.push(`set:${k}=${v}`); store.set(k, String(v)); },
    removeItem(k) { if (storageThrows) boom('remove'); log.push(`remove:${k}`); store.delete(k); },
    getItem(k) { if (storageThrows) boom('get'); return store.has(k) ? store.get(k) : null; },
  };
  const ctx = { location: { replace(u) { log.push(`replace:${u}`); } }, DOMException };
  if (storageThrows) Object.defineProperty(ctx, 'sessionStorage', { get() { return boom('access'); } });
  else ctx.sessionStorage = sessionStorage;
  vm.createContext(ctx);
  let error = null;
  try { for (const s of inlineScripts(h)) vm.runInContext(s, ctx, { timeout: 1000 }); } catch (e) { error = e; }
  return { log, store, error };
}

const cur = await load(readFileSync(resolve(SRC, 'pages.ts'), 'utf8'));
let base = null;
try { base = await load(execFileSync('git', ['show', `${BASE}:src/pages.ts`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
catch (e) { skip('baseline', `git show ${BASE.slice(0, 7)} 실패: ${e.message.split('\n')[0]}`); }

console.log('[입장 화면: 외부 스크립트]');
for (const watch of [true, false]) {
  const h = cur.labEnterPage(watch);
  check(`watch=${watch}: 외부 script 0개`, externalScripts(h).length === 0, JSON.stringify(externalScripts(h)));
  check(`watch=${watch}: /__lab/app.js 참조 없음`, !h.includes('/__lab/app.js'));
  check(`watch=${watch}: 인라인 script 1개`, inlineScripts(h).length === 1, String(inlineScripts(h).length));
  if (base) {
    const b = base.labEnterPage(watch);
    check(`watch=${watch}: 기준은 외부 script 1개 (/__lab/app.js)`, JSON.stringify(externalScripts(b)) === '["/__lab/app.js"]', JSON.stringify(externalScripts(b)));
    check(`watch=${watch}: 인라인 스크립트는 기준과 같음`, JSON.stringify(inlineScripts(h)) === JSON.stringify(inlineScripts(b)));
    const strip = (x) => x.replace(/<script\b[^>]*\bsrc\s*=\s*"[^"]*"[^>]*><\/script>/gi, '');
    check(`watch=${watch}: app.js 태그·manifest 한 줄만 빼면 기준과 바이트까지 같음`, strip(h) === strip(b).replace(MANIFEST_LINK, ''));
  }
}

console.log('[입장 화면: 이동]');
{
  const r = run(cur.labEnterPage(true), { initial: {} });
  check('watch=true: set 후 replace(/)', JSON.stringify(r.log) === '["set:labWatch=1","replace:/"]', JSON.stringify(r.log));
  check('watch=true: labWatch=1 저장', r.store.get('labWatch') === '1' && !r.error);
}
{
  const r = run(cur.labEnterPage(false), { initial: { labWatch: '1' } });
  check('watch=false: remove 후 replace(/)', JSON.stringify(r.log) === '["remove:labWatch","replace:/"]', JSON.stringify(r.log));
  check('watch=false: 남은 labWatch 지움', !r.store.has('labWatch') && !r.error);
}
for (const watch of [true, false]) {
  const r = run(cur.labEnterPage(watch), { storageThrows: true });
  check(`watch=${watch}: sessionStorage throw 여도 replace(/)`, !r.error && r.log.at(-1) === 'replace:/' && r.log.filter((x) => x.startsWith('replace:')).length === 1, JSON.stringify(r.log) + ' ' + r.error);
}

console.log('[입장 화면: 머리·대체 화면·CSP]');
for (const watch of [true, false]) {
  const h = cur.labEnterPage(watch);
  check(`watch=${watch}: doctype·lang=ko·charset·viewport·noindex`, h.startsWith('<!doctype html><html lang="ko">') && h.includes('<meta charset="utf-8">') && h.includes('name="viewport"') && h.includes('<meta name="robots" content="noindex">'));
  check(`watch=${watch}: manifest 없음 · theme-color·icon·apple-touch-icon 유지`, !h.includes('rel="manifest"') && !h.includes('manifest.webmanifest') && h.includes('<meta name="theme-color" content="#0f172a">') && h.includes('<link rel="icon" href="/__lab/icon-192.png">') && h.includes('<link rel="apple-touch-icon" href="/__lab/icon-192.png">'));
  check(`watch=${watch}: 한국어 제목·안내·대체 링크`, h.includes('<title>AI 실습실</title>') && h.includes('<h1>AI 실습실</h1>') && h.includes('여는 중…') && h.includes('<a href="/">안 열리면 여기를 누르세요</a>'));
  check(`watch=${watch}: 인라인 이벤트 핸들러·javascript: 없음`, !/\son[a-z]+\s*=/i.test(h) && !/javascript:/i.test(h));
  check(`watch=${watch}: 스타일은 인라인 style 하나 (외부 stylesheet 없음)`, (h.match(/<style>/g) || []).length === 1 && !/rel="stylesheet"/.test(h));
}
check('watch 값은 고정 문자열 둘 중 하나로만 바뀜', cur.labEnterPage(true).replace("setItem('labWatch','1')", 'X') === cur.labEnterPage(false).replace("removeItem('labWatch')", 'X'));

console.log('[다른 실습실 화면은 그대로]');
const join = { code: 'abc', seatOrigin: 'https://s1.lab.example.test', name: '수업', seat: 1, who: '참가자', expiresAt: 1_800_000_000_000, model: 'test/model' };
const samples = {
  labJoinPage: [join],
  labConfirmPage: ['https://s1.lab.example.test/x'],
  labLandingPage: [],
  labEndedPage: ['끝났습니다', 'https://lab.example.test/'],
};
for (const [name, args] of Object.entries(samples)) {
  const h = cur[name](...args);
  check(`${name}: /__lab/app.js 그대로`, JSON.stringify(externalScripts(h)) === '["/__lab/app.js"]', JSON.stringify(externalScripts(h)));
  // 설치(manifest)는 입장 호스트의 초대·런처만. 자리 호스트 확인·끝 화면은 manifest 없이 아이콘·색만
  if (name === 'labJoinPage' || name === 'labLandingPage') check(`${name}: manifest 그대로`, h.includes(MANIFEST_LINK));
  else check(`${name}: manifest 없음 · theme-color·icon 유지`, !h.includes('manifest.webmanifest') && h.includes('<meta name="theme-color" content="#0f172a">') && h.includes('<link rel="icon" href="/__lab/icon-192.png">'));
  // labJoinPage 의 인라인 스크립트(깨우기 반복)는 바뀌었다 — test/lab-entry-retry.mjs 가 본다. 마크업은 기준과 같아야 한다
  const noInline = (x) => x.replace(/<script>[\s\S]*?<\/script>/gi, '');
  if (base && name === 'labJoinPage') check(`${name}: 인라인 스크립트 밖은 기준과 바이트까지 같음`, noInline(h) === noInline(base[name](...args)));
  else if (base && name === 'labConfirmPage') check(`${name}: manifest 한 줄만 빼면 기준과 바이트까지 같음`, h === base[name](...args).replace(MANIFEST_LINK, ''));
  else if (base && name !== 'labLandingPage' && name !== 'labEndedPage') check(`${name}: 기준과 바이트까지 같음`, h === base[name](...args));
}
if (base) {
  for (const name of ['borrowPage', 'registerPage', 'adminPage', 'vaultPage', 'recvPage', 'labPage']) check(`${name}: 기준과 바이트까지 같음`, cur[name]() === base[name]());
  check('approvePage: 기준과 바이트까지 같음', cur.approvePage('id1') === base.approvePage('id1'));
  check('prfPage: 기준과 바이트까지 같음', cur.prfPage('k.example.test') === base.prfPage('k.example.test'));
  check('WEBAUTHN_JS: 기준과 같음', cur.WEBAUTHN_JS === base.WEBAUTHN_JS);
}

console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`);
process.exit(failN ? 1 : 0);
