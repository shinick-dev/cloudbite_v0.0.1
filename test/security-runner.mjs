// tools/test-security.mjs 회귀 테스트: 실패 전파·나머지 계속·실행 실패·시간 초과·요약 판정·skip 표시·인자 거부.
// 진짜 보안 묶음은 돌리지 않는다 (가짜 테스트 스크립트를 임시 폴더에 만들어 넣는다).
//   node test/security-runner.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, runSuites, scrubEnv } from '../tools/test-security.mjs';

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-secrun-'));
const fake = (name, body) => { const file = path.join(TMP, `${name}.mjs`); fs.writeFileSync(file, body); return { name, file }; };
const sink = () => { const o = { text: '', write: (d) => { o.text += d; } }; return o; };

const okS = fake('ok suite & x', `console.log('argv=' + JSON.stringify(process.argv.slice(2)));\nconsole.log('  skip 이 PC 에서 못 함');\nconsole.log('\\n3 passed, 0 failed, 1 skipped\\n');\n`);
const failS = fake('fail', `console.log('  FAIL x');\nconsole.log('\\n1 passed, 1 failed\\n');\nprocess.exit(1);\n`);
const crashS = fake('crash', `throw new Error('boom');\n`);
const lieS = fake('lie', `console.log('\\n2 passed, 1 failed\\n');\n`);
const silentS = fake('silent', `console.log('nothing');\n`);
const hangS = fake('hang', `setInterval(() => {}, 1000);\n`);

{
  const out = sink();
  const { ok, results } = await runSuites({ suites: [failS, okS, crashS, lieS, silentS], out });
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  check('하나라도 실패면 전체 실패', ok === false);
  check('실패 뒤에도 나머지를 전부 돈다 (5개 기록)', results.length === 5 && out.text.includes('argv=[]'), results.length);
  check('통과 스크립트: 인자 없이 파일 하나만 (셸 없이 공백·& 포함 경로 그대로)', by['ok suite & x'].ok && out.text.includes('argv=[]'));
  check('종료 코드 1 → 실패', !by.fail.ok && by.fail.why === '종료 코드 1', by.fail.why);
  check('예외로 죽음 → 실패', !by.crash.ok && /종료 코드/.test(by.crash.why), by.crash.why);
  check('종료 코드 0 이어도 요약 failed>0 → 실패', !by.lie.ok && by.lie.why === 'failed 1', by.lie.why);
  check('종료 코드 0 이어도 요약 줄 없으면 실패', !by.silent.ok && by.silent.why === '요약 줄 없음', by.silent.why);
  check('skip 은 요약에 따로 적힘 (통과로 세지 않음)', by['ok suite & x'].skips.length === 1 && out.text.includes('SKIP (통과 아님): skip 이 PC 에서 못 함'));
  check('자식 출력 전체가 로그에 남음', out.text.includes('FAIL x') && out.text.includes('boom'));
}
{
  const out = sink();
  const { ok, results } = await runSuites({ suites: [okS, okS], node: path.join(TMP, 'no-such-node.exe'), out });
  check('실행 파일 없음 (spawn 오류) → 실패, 다음도 기록', !ok && results.length === 2 && results.every((r) => !r.ok && r.why.startsWith('실행 실패')), JSON.stringify(results.map((r) => r.why)));
}
{
  // spawn 이 동기로 던지는 경우 (잘못된 실행 파일 타입): ReferenceError 로 새지 않고 실패 기록 후 다음 묶음을 돈다
  const out = sink();
  const { ok, results } = await runSuites({ suites: [okS, okS], node: 123, out });
  check('spawn 동기 예외 → 실패 기록, 다음도 기록', !ok && results.length === 2 && results.every((r) => !r.ok && r.why.startsWith('실행 실패') && !/timer/.test(r.why)), JSON.stringify(results.map((r) => r.why)));
}
{
  const out = sink();
  const t0 = Date.now();
  const { ok, results } = await runSuites({ suites: [hangS, okS], timeoutMs: 1500, out });
  check('시간 초과 → 프로세스 종료 후 실패, 다음 묶음 계속', !ok && results[0].why.startsWith('시간 초과') && results[1].ok && Date.now() - t0 < 20e3, JSON.stringify(results.map((r) => r.why)));
}
{
  const { ok } = await runSuites({ suites: [okS], out: sink() });
  check('전부 통과면 ok', ok === true);
}

check('기본 묶음은 보안 테스트 5개 고정', SUITES.map((s) => s.name).join() === 'core-security,auth-security,lab-security,resource-security,login-origin-security' && Object.isFrozen(SUITES) && SUITES.every((s) => Object.isFrozen(s) && fs.existsSync(s.file)));
const env = scrubEnv({ PATH: 'p', SystemRoot: 'r', DAYTONA_API_KEY: 'x', OPENROUTER_MANAGEMENT_KEY: 'x', REALTIME_APP_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'x', MY_SECRET: 'x' });
check('자식 환경에서 자격 증명 이름은 빠짐', JSON.stringify(env) === JSON.stringify({ PATH: 'p', SystemRoot: 'r' }), JSON.stringify(env));

const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/test-security.mjs'), '--only=2'], { encoding: 'utf8', timeout: 30e3 });
check('좁히기 인자는 거부 (종료 2, 묶음 실행 안 함)', r.status === 2 && !r.stdout.includes('====='), `${r.status} ${r.stdout}${r.stderr}`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
