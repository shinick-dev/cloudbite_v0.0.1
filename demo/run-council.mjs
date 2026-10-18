#!/usr/bin/env node
/**
 * Cloudbite — 실제 Daytona 샌드박스 병렬 실행 데모
 *
 * 전문가 역할마다 독립된 Daytona 샌드박스를 만들고, 그 안에서 분석 스크립트를
 * 실행한 뒤 결과를 집계한다. 모의(mock) 실행이 아니라 실제 원격 샌드박스다.
 *
 *   node demo/run-council.mjs --brief "100인 AI 자문 서비스를 출시할까?"
 *   node demo/run-council.mjs --keep        # 샌드박스를 남겨둔다
 *
 * 산출물: demo/evidence.json (실행 증거) + 콘솔 요약
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const brief = getArg(
  '--brief',
  '100명의 AI 전문가 자문 서비스를 이번 분기에 출시할지 결정한다.',
);
const keep = args.includes('--keep');
const snapshot = getArg('--snapshot', 'daytona-small');
const runId = Date.now().toString(36);

const experts = [
  { role: 'product', name: '제품 전략가', focus: '시장 적합성과 출시 시점' },
  { role: 'security', name: '보안 책임자', focus: '자격증명·샌드박스 격리 위험' },
  { role: 'pricing', name: '가격 분석가', focus: '원가 구조와 지불 의향' },
];

function daytona(cliArgs, { timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'daytona',
      cliArgs,
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `daytona ${cliArgs.join(' ')}\n${stderr || stdout || err.message}`,
            ),
          );
          return;
        }
        resolve({ stdout: `${stdout}${stderr || ''}`, stderr });
      },
    );
  });
}

/** 샌드박스 안에서 실행할 결정론적 분석기. 실제로 원격 CPU에서 돈다. */
function analysisScript(expert, briefText) {
  const expertLiteral = JSON.stringify(JSON.stringify(expert));
  const briefLiteral = JSON.stringify(briefText);
  return [
    'import json, hashlib, platform',
    `expert = json.loads(${expertLiteral})`,
    `brief = ${briefLiteral}`,
    'payload = (expert["role"] + "|" + brief).encode()',
    'seed = int(hashlib.sha256(payload).hexdigest()[:8], 16)',
    'risk_terms = ["위험", "실패", "규제", "비용", "보안", "경쟁"]',
    'hits = sum(brief.count(t) for t in risk_terms)',
    'base = 0.55 + ((seed % 30) / 100.0)',
    'confidence = round(min(0.95, max(0.35, base - hits * 0.03)), 3)',
    'stance = "support" if confidence >= 0.7 else ("conditional" if confidence >= 0.55 else "concern")',
    'print(json.dumps({',
    '  "role": expert["role"], "name": expert["name"], "focus": expert["focus"],',
    '  "stance": stance, "confidence": confidence,',
    '  "host": platform.node(), "python": platform.python_version(),',
    '  "brief_chars": len(brief), "risk_hits": hits,',
    '  "first_action": expert["focus"] + " 관점에서 2주 파일럿 검증",',
    '}, ensure_ascii=False))',
  ].join('\n');
}

async function runExpert(expert) {
  const sandboxName = `council-${expert.role}-${runId}`;
  const startedAt = performance.now();
  await daytona([
    'sandbox', 'create',
    '--name', sandboxName,
    '--snapshot', snapshot,
    '--auto-stop', '15',
  ]);
  const createdMs = Math.round(performance.now() - startedAt);

  const scriptB64 = Buffer.from(analysisScript(expert, brief), 'utf8').toString(
    'base64',
  );
  const command = `echo ${scriptB64} | base64 -d > /tmp/analyze.py && python3 /tmp/analyze.py`;

  const execStarted = performance.now();
  let stdout = '';
  let attempt = 0;
  while (attempt < 4) {
    attempt += 1;
    ({ stdout } = await daytona(
      ['sandbox', 'exec', sandboxName, '--', 'bash', '-c', command],
      { timeout: 240_000 },
    ));
    if (stdout.split(/\r?\n/).some((l) => l.trim().startsWith('{'))) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const execMs = Math.round(performance.now() - execStarted);

  const line =
    stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('{'))
      .pop() ?? '';
  if (!line) throw new Error(`JSON 출력 없음. raw=${JSON.stringify(stdout)}`);
  const result = JSON.parse(line);
  if (!result.name) throw new Error(`결과 형식 오류: ${line}`);

  let cleaned = false;
  if (!keep) {
    try {
      await daytona(['sandbox', 'delete', sandboxName], { timeout: 120_000 });
      cleaned = true;
    } catch {
      cleaned = false;
    }
  }

  return {
    ...result,
    sandbox: sandboxName,
    createdMs,
    execMs,
    cleaned,
  };
}

const run = async () => {
  console.log(`\nCloudbite · Daytona 병렬 전문가 실행`);
  console.log(`brief: ${brief}`);
  console.log(`snapshot: ${snapshot}\n`);

  const results = await Promise.all(experts.map(runExpert));

  const mean =
    results.reduce((sum, r) => sum + r.confidence, 0) / results.length;
  const stanceCount = results.reduce((acc, r) => {
    acc[r.stance] = (acc[r.stance] ?? 0) + 1;
    return acc;
  }, {});

  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(12)} ${r.stance.padEnd(11)} conf=${r.confidence}  ` +
        `sandbox=${r.createdMs}ms exec=${r.execMs}ms  ${r.sandbox}`,
    );
  }
  console.log(
    `\n  평균 확신도 ${mean.toFixed(3)} · 분포 ${JSON.stringify(stanceCount)}`,
  );
  console.log(
    `  실제 원격 실행 ${results.length}건 (${results.map((r) => r.host.split('-')[0]).join(', ')})`,
  );

  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: 'live-daytona',
    snapshot,
    brief,
    meanConfidence: Number(mean.toFixed(3)),
    stanceCount,
    results,
  };
  await mkdir(here, { recursive: true });
  await writeFile(join(here, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n  evidence → demo/evidence.json\n`);
};

run().catch((error) => {
  console.error('\n실행 실패:', error.message);
  process.exitCode = 1;
});
