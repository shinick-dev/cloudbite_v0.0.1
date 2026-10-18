// node test/vault-browser.mjs --mock 가 부른다. 서버·SETUP_TOKEN·네트워크 없이 금고 복구 화면을 Edge headless 로 돈다.
// 페이지는 src/pages.ts 를 그대로 그리고, /api 는 전부 route 로 흉내 낸다 (바깥 주소는 막고 센다).
// 확인하는 것: 복구가 200 + 새 코드를 돌려준 뒤 이어지는 /api/vault/status 가 끊기거나 500 이어도 새 코드가 보이고 복사된다,
//              틀린 코드·없는 코드는 아무것도 안 바꾸고 코드 상자도 안 띄운다, 성공하면 코드가 바뀌고 예전 코드는 거부된다,
//              복구 코드가 브라우저 저장소(localStorage·sessionStorage·cookie)에 안 남는다.
import { chromium } from 'playwright-core';
import { randomBytes, webcrypto } from 'node:crypto';
import { vaultPage, WEBAUTHN_JS } from '../src/pages.ts';

const ORIGIN = 'http://localhost:8798'; // route 로만 응답한다
const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(randomBytes(24), (b) => A[b % 32]).join('').match(/.{4}/g).join('-');
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[\s-]/g, '');

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

// 페이지와 같은 방식으로 복구 키를 만든다 (norm → PBKDF2-SHA256 512비트 → 앞 32 = KEK, 뒤 32 = 검증값)
const QS = ['첫 질문', '둘째 질문'], ANS = ['Seoul Tower', '나비'];
const SALT = randomBytes(16), ITER = 1000;
const norm = (a) => a.normalize('NFKC').toLowerCase().split(/\s+/).join('');
const base = await subtle.importKey('raw', enc.encode(ANS.map(norm).join('|')), 'PBKDF2', false, ['deriveBits']);
const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITER }, base, 512));
const kek = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt']);
const VERIFIER = b64u(bits.slice(32));
const VK = randomBytes(32), IV = randomBytes(12);
const WRAP = { iv: b64u(IV), ct: b64u(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: IV, additionalData: enc.encode('vrec') }, kek, VK))) };

const s = { code: newCode(), issued: [], statusMode: 'ok', statusHits: 0, statusFails: 0, recoverHits: 0, external: [], unknown: [] };
const first = s.code;
async function handler(route) {
  const req = route.request();
  const u = new URL(req.url());
  if (u.origin !== ORIGIN) { s.external.push(req.url()); return route.abort(); }
  const p = u.pathname;
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/vault') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: vaultPage() });
  if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
  if (p === '/api/vault/status') {
    s.statusHits++;
    if (s.statusMode === 'abort') { s.statusFails++; return route.abort('internetdisconnected'); }
    if (s.statusMode === '500') { s.statusFails++; return json({ error: '잠시 문제가 있습니다.' }, 500); }
    return json({ initialized: true, keys: [{ id: 'k1', label: 'key', prf: true, linked: true }] });
  }
  if (p === '/api/vault/recover-info') return json({ questions: QS, salt: b64u(SALT), iter: ITER, codeRequired: true, hasCode: true, left: 5 });
  if (p === '/api/vault/recover') {
    s.recoverHits++;
    const b = req.postDataJSON() ?? {};
    if (normCode(b.code) !== normCode(s.code)) return json({ error: '복구 코드가 틀렸습니다.' }, 403);
    if (b.verifier !== VERIFIER) return json({ error: '답이 틀렸습니다.' }, 403);
    s.code = newCode(); // 서버처럼: 성공하는 순간 코드가 바뀐다
    s.issued.push(s.code);
    return json({ wrap: WRAP, items: [], recoveryCode: s.code });
  }
  s.unknown.push(p);
  return json({ error: 'not mocked' }, 404);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
await ctx.route('**/*', handler);
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const msg = () => page.locator('#msg').textContent();
const rcText = async () => (await page.locator('#rcBox .code').count()) ? (await page.locator('#rcBox .code').textContent()).trim() : null;
async function toRecover(code) {
  await page.waitForSelector('#vLocked:not([hidden])');
  await page.click('#toRecover');
  await page.waitForSelector('#vRecover:not([hidden])');
  const rr = page.locator('#qaRec .qa');
  for (let i = 0; i < ANS.length; i++) await rr.nth(i).locator('input').nth(1).fill(ANS[i]);
  if (code !== undefined) await page.fill('#recCode', code);
}
const clearMsg = () => page.evaluate(() => { document.querySelector('#msg').textContent = ''; document.querySelector('#msg').className = ''; });

console.log('\n# 금고 복구 화면 (route 흉내, 서버 없음)');
await page.goto(`${ORIGIN}/vault`);
await toRecover('');
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').textContent.includes('복구 코드'));
check('코드 없음 → 안내, 요청 안 보냄', (await msg()).includes('복구 코드를 넣으세요') && s.recoverHits === 0, await msg());

await page.fill('#recCode', newCode());
await clearMsg();
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').className === 'bad');
check('틀린 코드 → 403 안내, 코드 상자 없음, 서버 코드 그대로', (await msg()).includes('틀렸') && (await rcText()) === null && s.code === first, await msg());

// F1: 복구는 200 + 새 코드, 그 뒤 status 는 연결 끊김
s.statusMode = 'abort';
await page.fill('#recCode', first.toLowerCase().replace(/-/g, ' '));
await clearMsg();
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').className !== '' && !document.querySelector('#msg').textContent.includes('확인 중'), null, { timeout: 30000 });
const c1 = await rcText();
check('복구 200 뒤 status 실패해도 새 코드가 보임', s.statusFails >= 1 && c1 === s.issued[0], `fails=${s.statusFails} shown=${c1} issued=${s.issued[0]}`);
check('실패 안내가 새 코드를 적으라고 함, 입력 칸 비움', (await msg()).includes('새 복구 코드') && (await page.inputValue('#recCode')) === '', await msg());
await page.click('#rcCopy');
await page.waitForFunction(() => /복사/.test(document.querySelector('#rcCopy').textContent) && document.querySelector('#rcCopy').textContent !== '복사');
const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
check('복사 버튼 → 새 코드가 클립보드에', clip === s.issued[0], clip);
const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
check('복구 코드는 브라우저 저장소에 없음', ![first, ...s.issued].some((c) => stored.includes(c) || stored.includes(c.replace(/-/g, ''))), stored);

// 500 도 같다 + 회전: 예전 코드는 거부, 새 코드로 다시
s.statusMode = 'ok';
await page.reload();
await toRecover(first);
await clearMsg();
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').className === 'bad', null, { timeout: 30000 });
check('예전 코드 → 거부, 코드 안 바뀜', (await msg()).includes('틀렸') && s.issued.length === 1 && (await rcText()) === null, await msg());
s.statusMode = '500';
await page.fill('#recCode', s.issued[0]);
await clearMsg();
await page.click('#doRecover');
await page.waitForFunction(() => document.querySelector('#msg').className !== '' && !document.querySelector('#msg').textContent.includes('확인 중'), null, { timeout: 30000 });
check('새 코드로 복구 → 또 새 코드, status 500 이어도 보임', s.issued.length === 2 && (await rcText()) === s.issued[1] && s.issued[1] !== s.issued[0], `${await rcText()} ${s.issued.join(',')}`);

// 정상 경로: status 도 성공하면 금고가 열리고 코드도 보인다
s.statusMode = 'ok';
await page.reload();
await toRecover(s.issued[1]);
await clearMsg();
await page.click('#doRecover');
await page.waitForSelector('#vOpen:not([hidden])', { timeout: 30000 });
check('status 성공 → 금고 열림 + 새 코드 + 성공 안내', (await rcText()) === s.issued[2] && (await msg()).includes('열었습니다'), await msg());
await page.locator('#rcBox button', { hasText: '지우기' }).click();
check('확인하면 화면에서 지움', (await rcText()) === null);
check('흉내 안 된 API·바깥 호출 없음', s.unknown.length === 0 && s.external.length === 0, JSON.stringify([s.unknown, s.external]));

await browser.close();
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
