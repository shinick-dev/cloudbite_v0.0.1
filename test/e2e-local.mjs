// test/e2e.mjs · test/vault-browser.mjs 를 진짜 공급자·비밀 없이 로컬에서만 돌린다.
//
// 진짜 로컬 workerd(wrangler dev)에 test/fixtures/auth-security/fixture.js 를 main 으로 한 임시 설정을 띄운다
// (진짜 State·SQLite, 바깥 fetch 는 fixture 가 막고 기록). MASTER_KEY·SETUP_TOKEN 은 이번 실행에서 만든 합성 값,
// .dev.vars·User 환경변수·배포 없음. 대상 스크립트는 공급자 키가 없는 깨끗한 환경으로 띄운다 —
// e2e 의 진짜 공급자(프리셋)·만료(OpenRouter) 절은 건너뛰고 (E2E_NO_PROVIDERS·SKIP_EXPIRY), 대신 loopback 가짜 공급자 loc1·loc2 로
// 나머지(등록·승인·프록시 키 바꿔치기·범위·거절·금고·복구·관리)를 돈다.
// WebAuthn 은 IP 주소를 RP ID 로 못 쓰니 origin 은 http://localhost:<port>.
//
//   node test/e2e-local.mjs            e2e.mjs
//   node test/e2e-local.mjs vault      vault-browser.mjs (Edge headless + 가상 인증기)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] === 'vault' ? 'vault-browser.mjs' : 'e2e.mjs';
const fwd = (p) => p.replace(/\\/g, '/');
// loopback 가짜 upstream: 받은 경로·인증 헤더를 그대로 돌려준다 (e2e 의 loc1·loc2 공급자)
const mock = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url, auth: req.headers.authorization ?? '' })); });
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), INSP = await freePort();
const GW = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-e2e-local-'));
const SETUP = randomBytes(18).toString('base64url');
fs.writeFileSync(path.join(TMP, 'entry.js'),
  `import worker, { State as Base } from '${fwd(path.join(ROOT, 'src/index.ts'))}';\n` +
  `import { makeFixture } from '${fwd(path.join(ROOT, 'test/fixtures/auth-security/fixture.js'))}';\n` +
  `const f = makeFixture(worker, Base);\nexport const State = f.State;\nexport default f.worker;\n`);
fs.writeFileSync(path.join(TMP, 'wrangler.json'), JSON.stringify({
  name: 'gw-e2e-local-fixture', main: 'entry.js', compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'Text', globs: ['**/*.ps1'], fallthrough: true }],
  vars: {
    RP_ID: 'localhost', ORIGIN: GW, LAB_ORIGIN: `http://127.0.0.1:${PORT}`, LAB_GW: '', ALLOW_SHORT_TTL: '1',
    LAB_DAYTONA_API: `${MOCK}/daytona`, REALTIME_API: `${MOCK}/rtc`, MASTER_KEY: randomBytes(32).toString('base64url'), SETUP_TOKEN: SETUP,
  },
  durable_objects: { bindings: [{ name: 'STATE', class_name: 'State' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['State'] }],
}, null, 2));

// 공급자 키 같은 비밀이 대상 스크립트·wrangler 로 새지 않게: 실행에 필요한 것만 남긴다
const KEEP = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROGRAMFILES', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.includes(k)));

const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', path.join(TMP, 'wrangler.json'),
  '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', String(INSP), '--persist-to', path.join(TMP, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn'],
{ cwd: TMP, env: { ...clean, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
let up = false;
for (const until = Date.now() + 120e3; Date.now() < until && child.exitCode === null;) {
  try { if ((await fetch(`${GW}/borrow`)).status === 200) { up = true; break; } } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
let code = 1;
if (!up) console.log(log.slice(-4000), '\nwrangler dev did not start');
else {
  console.log(`e2e-local: ${target} gw=${GW} (합성 비밀, 바깥 호출 막힘)`);
  code = await new Promise((res) => {
    const t = spawn(process.execPath, [path.join(ROOT, 'test', target)], {
      cwd: ROOT, stdio: 'inherit',
      env: { ...clean, GW, RP_ID: 'localhost', SETUP_TOKEN: SETUP, SKIP_EXPIRY: '1', E2E_NO_PROVIDERS: '1', E2E_LOCAL_UPSTREAM: MOCK },
    });
    t.on('exit', (c) => res(c ?? 1));
  });
  const ob = await (await fetch(`${GW}/__fx/fxOutbound`, { method: 'POST', body: '[]' })).json();
  console.log(ob.length === 0 ? '  ok   [guard] 바깥(loopback 아닌) 호출 없음' : `  FAIL [guard] 바깥 호출 ${JSON.stringify(ob.slice(0, 3))}`);
  if (ob.length) code = 1;
}
try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch {}
await new Promise((r) => setTimeout(r, 800));
mock.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(code);
