// 금고 페이지를 실제 브라우저(Edge)에서 돈다. 보안 키 대신 Chrome DevTools 가상 인증기(PRF 지원)를 쓴다.
//   .\run-dev.ps1 -Fresh 로 빈 상태에서 띄운 뒤:  SETUP_TOKEN=... node test/vault-browser.mjs
//   또는 합성 비밀·로컬 fixture 로:                 node test/e2e-local.mjs vault
// 확인하는 것: 등록 → 금고 만들기(복구 코드 표시) → 항목 저장 → 잠그고 키로 다시 열기 → 복구 코드 + 질문으로 열기(새 코드),
//              예전 코드 거부, 그리고 그동안 서버로 간 요청 어디에도 비밀번호·답·금고 키가 없는지.
//
//   node test/vault-browser.mjs --mock   서버 없이: 페이지는 src/pages.ts 그대로, /api 는 route 흉내.
//              복구 응답(200, 새 코드) 뒤 /api/vault/status 가 실패해도 새 코드가 보이고 복사되는지, 저장소에 안 남는지.

import { chromium } from 'playwright-core';

if (process.argv.includes('--mock')) {
  await import('./vault-browser-mock.mjs');
  process.exit(process.exitCode ?? 0);
}

const GW = process.env.GW ?? 'http://localhost:8797';
const SETUP = process.env.SETUP_TOKEN;
const SECRET_PW = 'Pw-' + Math.random().toString(36).slice(2) + '-zz';
const ANSWERS = ['Seoul Tower', '고양이 나비', '1998'];

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext()).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
});
page.on('dialog', (d) => d.accept());
const sent = [];
page.on('request', (r) => { if (r.method() === 'POST') sent.push(r.postData() ?? ''); });
const msg = () => page.locator('#msg').textContent();

console.log(`\n# 금고 (브라우저, ${GW})`);
await page.goto(`${GW}/register#${SETUP}`);
await page.fill('#label', 'virtual');
await page.click('#go');
await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('등록됨'), null, { timeout: 15000 });
check('가상 키 PRF 등록', (await (await fetch(`${GW}/api/vault/status`, { method: 'POST', headers: { origin: GW } })).json()).keys.some((k) => k.prf));

await page.goto(`${GW}/vault`);
await page.waitForSelector('#vSetup:not([hidden])');
check('금고 없음 → 만들기 화면', true);
const rows = page.locator('#qaSetup .qa');
for (let i = 0; i < 3; i++) {
  await rows.nth(i).locator('input').nth(0).fill(`질문 ${i + 1}`);
  await rows.nth(i).locator('input').nth(1).fill(ANSWERS[i]);
}
await page.click('#doSetup');
await page.waitForSelector('#vOpen:not([hidden])', { timeout: 30000 });
check('금고 만들기 (탭 1회 + 복구 키)', (await msg()).includes('만들었습니다'), await msg());
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/;
const RC1 = (await page.locator('#rcBox .code').textContent())?.trim();
check('새 금고 → 복구 코드 표시', CODE_RE.test(RC1 ?? ''), RC1);
await page.locator('#rcBox button', { hasText: '지우기' }).click();
check('확인하면 화면에서 지움', (await page.locator('#rcBox').count()) === 0);

await page.click('#newItem');
await page.fill('#f_title', '테스트 사이트');
await page.fill('#f_url', 'https://example.com/login');
await page.fill('#f_user', 'me@example.com');
await page.fill('#f_pw', SECRET_PW);
await page.check('input[name=pol][value=send]');
await page.click('#f_save');
await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('저장'));
check('항목 저장', (await page.locator('#list').textContent()).includes('테스트 사이트'));

await page.click('#doLock');
await page.waitForSelector('#vLocked:not([hidden])');
check('잠그면 목록 비움', (await page.locator('#list').textContent()) === '');
await page.click('#doOpen');
await page.waitForSelector('#vOpen:not([hidden])', { timeout: 15000 });
await page.locator('#list .card b', { hasText: '테스트 사이트' }).click();
await page.locator('#list button', { hasText: '보기' }).click();
check('키로 다시 열면 복호화된 비밀번호', (await page.locator('#list').textContent()).includes(SECRET_PW));
check('정책 표시', (await page.locator('#list').textContent()).includes('PC 전송 허용'));

await page.click('#doLock');
await page.waitForSelector('#vLocked:not([hidden])');
await page.click('#toRecover');
await page.waitForSelector('#vRecover:not([hidden])');
const rr = page.locator('#qaRec .qa');
check('복구 화면에 질문 3개', (await rr.count()) === 3);
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('복구 코드'), null, { timeout: 10000 });
check('코드 없이 → 복구 코드를 넣으라는 안내', (await msg()).includes('복구 코드를 넣으세요'), await msg());
await page.fill('#recCode', RC1);
for (let i = 0; i < 3; i++) await rr.nth(i).locator('input').nth(1).fill(i === 2 ? 'nope' : ANSWERS[i]);
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('틀렸'), null, { timeout: 20000 });
check('틀린 답 → 남은 시도 안내', (await msg()).includes('4회'), await msg());
// 대소문자·띄어쓰기는 무시돼야 한다
await rr.nth(0).locator('input').nth(1).fill('  seoultower ');
await rr.nth(1).locator('input').nth(1).fill('고양이나비');
await rr.nth(2).locator('input').nth(1).fill('1998');
await page.click('#doRecover');
await page.waitForSelector('#vOpen:not([hidden])', { timeout: 20000 });
check('복구 질문으로 열기 (정규화된 답)', (await page.locator('#list').textContent()).includes('테스트 사이트'));
check('복구로 열면 읽기 전용', await page.locator('#newItem').isDisabled());
const RC2 = (await page.locator('#rcBox .code').textContent())?.trim();
check('복구 성공 → 새 복구 코드 표시 (예전과 다름), 입력 칸 비움', CODE_RE.test(RC2 ?? '') && RC2 !== RC1 && (await page.inputValue('#recCode')) === '', RC2);

await page.click('#doLock');
await page.waitForSelector('#vLocked:not([hidden])');
await page.click('#toRecover');
await page.waitForSelector('#vRecover:not([hidden])');
await page.fill('#recCode', RC1);
for (let i = 0; i < 3; i++) await rr.nth(i).locator('input').nth(1).fill(ANSWERS[i]);
await page.evaluate(() => { document.querySelector('#msg').textContent = ''; });
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').className === 'bad', null, { timeout: 20000 });
check('예전 복구 코드 + 맞는 답 → 거부, 금고 안 열림', await page.locator('#vRecover').isVisible(), await msg());
const st = await (await fetch(`${GW}/api/vault/recover-info`, { method: 'POST', headers: { origin: GW, 'content-type': 'application/json' }, body: '{}' })).json();
check('예전 코드 시도는 새 코드 예산을 안 씀 (남은 5)', st.left === 5, JSON.stringify(st));
const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
check('복구 코드는 브라우저 저장소에 없음', ![RC1, RC2].some((c) => stored.includes(c)), stored);

const all = sent.join('\n');
check('서버로 간 요청에 비밀번호 없음', !all.includes(SECRET_PW));
check('서버로 간 요청에 복구 답 없음', !ANSWERS.some((a) => all.includes(a)) && !all.includes('seoultower'));
check('서버로 간 요청에 URL·아이디 평문 없음', !all.includes('example.com') && !all.includes('테스트 사이트'));

await browser.close();
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
