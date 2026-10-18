// 보안 회귀 묶음 실행: 기존 보안 테스트 5개를 전부(좁히기 인자 없이) 하나씩 돌리고 결과를 모은다.
//   npm run test:security        (인자를 받지 않는다 — --only·--baseline·--src 로 좁힐 수 없음)
// 각 테스트는 자기 임시 포트·합성 fixture 로 로컬에서만 돈다 (배포·진짜 upstream·User 환경변수 없음).
// 하나가 실패해도 나머지를 계속 돌리고, 종료 코드는 하나라도 실패면 1. 실행 실패·시그널·시간 초과·요약 줄 없음도 실패.
// skip 은 통과로 세지 않고 줄 그대로 요약에 다시 적는다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SUITES = Object.freeze(['core-security', 'auth-security', 'lab-security', 'resource-security', 'login-origin-security']
  .map((name) => Object.freeze({ name, file: path.join(ROOT, 'test', `${name}.mjs`) })));
const TIMEOUT_MS = 30 * 60e3;

// 자식에게는 자격 증명처럼 보이는 환경변수를 넘기지 않는다 (테스트는 합성 값만 쓴다)
export const scrubEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/(KEY|TOKEN|SECRET|PASSWORD)$/i.test(k)));

function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    .on('error', () => child.kill()).on('exit', (c) => { if (c) child.kill(); });
  else child.kill('SIGKILL');
}

function runOne(suite, { node, cwd, env, timeoutMs, out }) {
  return new Promise((resolve) => {
    let text = '', settled = false, timedOut = false, child, timer;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ name: suite.name, text, ...r }); } };
    try { child = spawn(node, [suite.file], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return finish({ error: String(e?.message ?? e) }); }
    timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const tee = (d) => { text += d; out.write(d); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.on('error', (e) => finish({ error: String(e?.message ?? e) }));
    child.on('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

// 결과 판정: 종료 코드 0 + 시그널 없음 + 마지막 요약 줄이 있고 failed 0 일 때만 통과
export function judge(r) {
  const sums = [...r.text.matchAll(/^(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/gm)];
  const last = sums.at(-1);
  const skips = r.text.split(/\r?\n/).filter((l) => /^\s*skip\b/i.test(l)).map((l) => l.trim());
  const why = r.error ? `실행 실패: ${r.error}`
    : r.timedOut ? '시간 초과 (프로세스 트리 종료)'
    : r.signal ? `시그널 ${r.signal}`
    : r.code !== 0 ? `종료 코드 ${r.code}`
    : !last ? '요약 줄 없음'
    : Number(last[2]) > 0 ? `failed ${last[2]}` : '';
  return { name: r.name, ok: !why, why, passed: last ? Number(last[1]) : null, failed: last ? Number(last[2]) : null, skips };
}

export async function runSuites({ suites = SUITES, node = process.execPath, cwd = ROOT, env = scrubEnv(process.env), timeoutMs = TIMEOUT_MS, out = process.stdout } = {}) {
  const results = [];
  for (const s of suites) {
    out.write(`\n===== ${s.name} (${path.relative(cwd, s.file) || s.file}) =====\n`);
    const started = Date.now();
    const j = judge(await runOne(s, { node, cwd, env, timeoutMs, out }));
    results.push({ ...j, seconds: Math.round((Date.now() - started) / 1000) });
  }
  out.write('\n===== 보안 회귀 요약 =====\n');
  for (const r of results) {
    out.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.passed ?? '?'} passed, ${r.failed ?? '?'} failed, skip ${r.skips.length}  (${r.seconds}s)${r.why ? `  — ${r.why}` : ''}\n`);
    for (const l of r.skips) out.write(`        SKIP (통과 아님): ${l}\n`);
  }
  const bad = results.filter((r) => !r.ok).length;
  out.write(`\n${results.length - bad}/${results.length} 묶음 통과${bad ? `, ${bad} 실패` : ''}. skip 항목은 이번 실행에서 확인되지 않은 것이다.\n`);
  return { ok: bad === 0, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error(`인자를 받지 않는다 (전체 보안 묶음만 돈다): ${process.argv.slice(2).join(' ')}`);
    process.exit(2);
  }
  const { ok } = await runSuites();
  process.exit(ok ? 0 : 1);
}
