// 터미널 local echo 실험용 code-server 설정을 만든다 (lab/snapshot.ps1 -LocalEchoExperiment 일 때만 부른다).
// 기본 설정(lab/files/code-server-settings.json)의 키는 하나도 빼거나 바꾸지 않고, 아래 세 키만 넣는다.
// terminal.integrated.localEchoExcludePrograms 는 건드리지 않는다 → 기본값(vim·tmux 등 제외)이 그대로 남는다.
// 의존성 없음. 잘못된 JSON·객체가 아닌 값이면 실패한다 (조용히 기본값으로 넘어가지 않는다).
//   node lab/local-echo-settings.mjs <settings.json>   # 합친 JSON 의 UTF-8 바이트를 base64 한 줄로 출력

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_ECHO_SETTINGS = Object.freeze({
  'terminal.integrated.localEchoEnabled': 'on',
  'terminal.integrated.localEchoLatencyThreshold': 0,
  'terminal.integrated.localEchoStyle': 'dim',
});

/** 기본 설정 JSON 텍스트 → 실험 설정 JSON 텍스트. 잘못된 입력이면 throw */
export function mergeLocalEcho(text) {
  if (typeof text !== 'string') throw new TypeError('settings text must be a string');
  const base = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (base === null || typeof base !== 'object' || Array.isArray(base)) throw new TypeError('settings must be a JSON object');
  return `${JSON.stringify({ ...base, ...LOCAL_ECHO_SETTINGS }, null, 2)}\n`;
}

const isMain = import.meta.main ?? (!!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('usage: node lab/local-echo-settings.mjs <settings.json>');
    process.exit(2);
  }
  try {
    const merged = mergeLocalEcho(readFileSync(args[0], 'utf8'));
    process.stdout.write(`${Buffer.from(merged, 'utf8').toString('base64')}\n`);
  } catch (e) {
    console.error(`local-echo-settings: ${args[0]}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
