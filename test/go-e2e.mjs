// 빌린 PC 자동 로그인 전체 흐름: go.ps1(실제 PowerShell + 헤드리스 Edge) ↔ 폰(Edge + PRF 가상 인증기) ↔ 가짜 로그인 사이트.
//   .\run-dev.ps1 -Fresh 로 빈 상태에서 띄운 뒤:  SETUP_TOKEN=... node test/go-e2e.mjs
// 확인하는 것: 코드 일치, 폰 전용 항목은 못 보냄, 한 화면 로그인·두 단계 로그인 자동 입력,
// "다음 사이트"(가짜 Google 로그인 → 앱의 "Continue with Google" → 계정 선택 → 동의 → 앱 로그인), 끝나면 임시 프로필 삭제.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const GW = process.env.GW ?? 'http://localhost:8797';
const SETUP = process.env.SETUP_TOKEN;
const SITE = 'http://localhost:8798';   // 로그인 사이트이자 가짜 IdP
const APP = 'http://127.0.0.1:8798';    // 다른 호스트 = 다른 쿠키: IdP 로 로그인하는 앱

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

// ── 가짜 로그인 사이트 ──
const got = [];
const site = createServer(async (req, res) => {
  const u = new URL(req.url, SITE);
  let body = '';
  for await (const c of req) body += c;
  const form = Object.fromEntries(new URLSearchParams(body));
  const html = (s) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><body>${s}`); };
  if (u.pathname === '/one') return html(`<h1>Login</h1><form method=post action=/done-one>
    <input type=text name=username placeholder="아이디"><input type=password name=password><button type=submit>로그인</button></form>`);
  if (u.pathname === '/two') return html(`<form method=get action=/two/pw><input type=email name=email autocomplete=username><button type=submit>다음</button></form>`);
  if (u.pathname === '/two/pw') return html(`<form method=post action=/done-two><input type=hidden name=email value="${u.searchParams.get('email')}">
    <input type=password name=pw><button>Sign in</button></form>`);
  if (u.pathname.startsWith('/done')) { got.push({ path: u.pathname, ...form }); return html('welcome'); }
  const cookie = req.headers.cookie ?? '';
  const go = (to, set) => { res.writeHead(302, { location: to, ...(set ? { 'set-cookie': set } : {}) }); res.end(); };
  // 가짜 IdP (localhost): 아이디 → 비밀번호 → 계정 홈. OAuth: 계정 선택 → 동의 → 앱으로
  if (u.pathname === '/signin/identifier') return html(`<form method=get action=/signin/pw><input type=email name=identifier autocomplete=username><button type=submit>Next</button></form>`);
  if (u.pathname === '/signin/pw') return html(`<form method=post action=/signin/done><input type=password name=Passwd><button>Next</button></form>`);
  if (u.pathname === '/signin/done') { got.push({ path: '/signin/done', ...form }); return go('/home', 'idp=bob; Path=/'); }
  if (u.pathname === '/home') return html(cookie.includes('idp=bob') ? '<h1>계정 홈</h1>' : 'no session');
  if (u.pathname === '/oauth') return cookie.includes('idp=bob')
    ? html(`<h2>계정 선택</h2><ul><li data-identifier="bob@example.com" onclick="location='/oauth/consent'">Bob</li></ul>`)
    : html('no session');
  if (u.pathname === '/oauth/consent') return html(`<p>앱이 이메일을 봅니다</p><button onclick="location='${APP}/cb'">Continue</button><button>Cancel</button>`);
  // 앱 (127.0.0.1)
  if (u.pathname === '/cb') { got.push({ path: '/cb' }); return go('/app', 'app=1; Path=/'); }
  if (u.pathname === '/app') return cookie.includes('app=1')
    ? html('<h1>채팅</h1><textarea></textarea>')
    : html(`<h1>로그인</h1><input type=email placeholder="이메일"><button>Continue with email</button><a href="${SITE}/oauth">Continue with Google</a>`);
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(8798, r));

// ── 폰 ──
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const phone = await (await browser.newContext()).newPage();
const cdp = await phone.context().newCDPSession(phone);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
});
phone.on('dialog', (d) => d.accept());
const msg = () => phone.locator('#msg').textContent();

console.log(`\n# 준비: 키 등록 · 금고 · 항목 3개`);
await phone.goto(`${GW}/register#${SETUP}`);
await phone.fill('#label', 'virtual');
await phone.click('#go');
await phone.waitForFunction(() => document.querySelector('#msg').textContent.includes('등록됨'));
await phone.goto(`${GW}/vault`);
await phone.waitForSelector('#vSetup:not([hidden])');
const rows = phone.locator('#qaSetup .qa');
for (let i = 0; i < 2; i++) { await rows.nth(i).locator('input').nth(0).fill(`q${i}`); await rows.nth(i).locator('input').nth(1).fill(`long enough answer ${i}`); }
await phone.click('#doSetup');
await phone.waitForSelector('#vOpen:not([hidden])', { timeout: 30000 });
async function addItem(title, url, user, pw, policy, then = '') {
  await phone.click('#newItem');
  await phone.fill('#f_title', title); await phone.fill('#f_url', url); await phone.fill('#f_user', user); await phone.fill('#f_pw', pw); await phone.fill('#f_then', then);
  await phone.check(`input[name=pol][value=${policy}]`);
  await phone.click('#f_save');
  await phone.waitForFunction((t) => document.querySelector('#list').textContent.includes(t), title);
}
await addItem('한화면', `${SITE}/one`, 'alice', 'pw-one-!@#"\'<x>', 'send');
await addItem('두단계', `${SITE}/two`, 'bob@example.com', 'pw-two-한글', 'send');
await addItem('은행', `${SITE}/one`, 'carol', 'pw-bank', 'phone');
await addItem('Google 테스트', `${SITE}/signin/identifier`, 'bob@example.com', 'pw-google', 'send', `${APP}/app`);
check('항목 4개 저장', (await phone.locator('#list .card').count()) === 4);

async function runGo(title, expect) {
  console.log(`\n# go.ps1 → ${title}`);
  const before = Date.now();
  // 빌린 PC 에 흔한 Windows PowerShell 5.1 이 기본. GO_SHELL 로 pwsh 경로를 줄 수 있다
  const ps = spawn(process.env.GO_SHELL ?? 'powershell.exe', ['-NoProfile', '-Command', `irm ${GW}/go | iex`], {
    env: { ...process.env, KVGO_HEADLESS: '1', KVGO_AUTOCLOSE: '3', KVGO_DEBUG: '1' },
  });
  let out = '';
  ps.stdout.on('data', (d) => { out += d; });
  ps.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => ps.on('exit', r));
  const t0 = Date.now();
  while (!/\/a\/[\w-]{16}/.test(out) && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 300));
  const url = out.match(/https?:\/\/\S+\/a\/[\w-]{16}/)?.[0];
  const pcCode = out.match(/: ([A-Z2-9]{6})\b/)?.[1];
  check('go.ps1 이 Edge 를 띄우고 승인 주소·코드 출력', !!url && !!pcCode, out.slice(0, 400));
  if (!url) { ps.kill(); return; }

  await phone.goto(url);
  await phone.waitForURL(/\/vault#send=/);
  await phone.waitForSelector('#sendBox:not([hidden])');
  check('폰과 PC 코드가 같다', (await phone.locator('#sendCode').textContent()) === pcCode);
  await phone.click('#doOpen');
  await phone.waitForSelector('#vOpen:not([hidden])', { timeout: 15000 });
  await phone.locator('#list .card b', { hasText: '은행' }).click();
  check('폰 전용 항목에는 보내기 버튼 없음', (await phone.locator('#list .card', { hasText: '은행' }).locator('button', { hasText: '이 PC 로 보내기' }).count()) === 0);
  await phone.locator('#list .card b', { hasText: title }).click();
  await phone.locator('#list .card', { hasText: title }).locator('button', { hasText: '이 PC 로 보내기' }).click();
  await phone.waitForFunction(() => document.querySelector('#msg').textContent.includes('보냈습니다'), null, { timeout: 15000 });
  check('폰에서 보내기', true);

  const t1 = Date.now();
  while (!got.some((g) => g.path === expect.path) && Date.now() - t1 < 40000) await new Promise((r) => setTimeout(r, 300));
  const hit = got.find((g) => g.path === expect.path);
  check(`사이트에 로그인 제출됨 (${expect.path})`, !!hit && Object.entries(expect.form).every(([k, v]) => hit[k] === v), JSON.stringify(hit) + '\n' + out.slice(-600));
  if (expect.then) {
    const t2 = Date.now();
    while (!got.some((g) => g.path === '/cb') && Date.now() - t2 < 60000) await new Promise((r) => setTimeout(r, 300));
    check('다음 사이트: Google 로 계속 → 계정 선택 → 동의 → 앱 로그인', got.some((g) => g.path === '/cb'), out.slice(-600));
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 90000))]);
  if (expect.then) check('다음 사이트 결과 출력', out.includes('로그인 버튼까지 눌렀습니다'), out.slice(-1500));
  check('go.ps1 종료', ps.exitCode !== null, out.slice(-400));
  const dir = out.match(/kvgo-[0-9a-f]{32}/)?.[0];
  check('임시 프로필 삭제', out.includes('정리 완료') && (!dir || !existsSync(`${process.env.TEMP}\\${dir}`)), out.slice(-300));
  void before;
}

await runGo('한화면', { path: '/done-one', form: { username: 'alice', password: 'pw-one-!@#"\'<x>' } });
await runGo('두단계', { path: '/done-two', form: { email: 'bob@example.com', pw: 'pw-two-한글' } });
await runGo('Google 테스트', { path: '/signin/done', form: { Passwd: 'pw-google' }, then: true });

await browser.close();
site.close();
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
