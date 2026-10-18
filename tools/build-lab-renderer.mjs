// client/lab-renderer.ts (브라우저 TS) → src/lab-renderer.generated.ts (labPage 인라인 스크립트에 붙는 JS 문자열).
//   node tools/build-lab-renderer.mjs          다시 만들기 (npm run build:lab-renderer)
//   node tools/build-lab-renderer.mjs --check  만들어 둔 파일이 지금 소스로 만든 것과 한 바이트도 다르지 않은지만 본다 (npm run check · wrangler build)
// 실행 중에 eval·Function 으로 옮기지 않는다: 개발할 때 esbuild transform(묶지 않음·줄이지 않음) 한 번, 결과는 고정 문자열.
// 경로는 이 파일 위치 기준이라 어느 폴더에서 불러도 같다. 출력은 LF·BOM 없음.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformSync, version } from 'esbuild';

const ESBUILD = '0.28.1'; // package.json 에 고정한 버전 — 다르면 출력이 바뀔 수 있어 멈춘다
const SRC = fileURLToPath(new URL('../client/lab-renderer.ts', import.meta.url));
const OUT = fileURLToPath(new URL('../src/lab-renderer.generated.ts', import.meta.url));
const check = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-lab-renderer: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} 이 필요합니다 (npm ci)`);

const srcBytes = readFileSync(SRC);
const src = srcBytes.toString('utf8');
if (src.charCodeAt(0) === 0xfeff) fail('client/lab-renderer.ts 에 BOM 이 있습니다');
const { code, warnings } = transformSync(src, {
  loader: 'ts', target: 'es2022', minify: false, charset: 'utf8', legalComments: 'none',
  sourcefile: 'client/lab-renderer.ts', sourcemap: false,
});
if (warnings.length) fail(`esbuild 경고 ${warnings.length}개: ${warnings.map((w) => w.text).join(' / ')}`);

// 인라인 <script> 안에 들어가므로 HTML 파서가 스크립트를 끝내거나 이상하게 읽을 문자열이 있으면 안 된다.
// 또 이 조각은 DOM 만 textContent 로 다룬다 — HTML 을 문자열로 넣거나 코드를 문자열로 돌리는 길이 생기면 멈춘다
const UNSAFE = [
  [/<\/script/i, '</script'], [/<script/i, '<script'], [/<!--/, '<!--'],
  [/^\s*(?:import|export)\b/m, 'import/export (모듈 의존 없음)'], [/\bimport\s*\(/, 'import()'],
  [/\beval\s*\(/, 'eval'], [/\bFunction\s*\(/, 'Function()'], [/\.toString\s*\(\s*\)/, 'toString()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, 'HTML 문자열 넣기'], [/\bdocument\.write/, 'document.write'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, '브라우저 저장소'], [/\bfetch\s*\(/, 'fetch (서버 호출은 콜백으로만)'],
];
for (const [re, what] of UNSAFE) if (re.test(code)) fail(`만든 JS 에 ${what} 가 있습니다`);

const out = '// 만든 파일 — 직접 고치지 말 것. 소스: client/lab-renderer.ts · 다시 만들기: npm run build:lab-renderer\n'
  + `// esbuild ${ESBUILD} transform (ES2022, 묶지 않음). labPage 인라인 스크립트에 그대로 붙는다\n`
  + `// 소스 sha256 ${createHash('sha256').update(srcBytes).digest('hex')} (주석만 고쳐도 --check 가 알아챈다)\n`
  // 한 줄에 한 줄씩 (리뷰에서 diff 를 읽을 수 있게). join 하면 transform 출력과 같은 문자열이다
  + 'export const LAB_RENDERER_JS = [\n' + code.split('\n').map((l) => `  ${JSON.stringify(l)},\n`).join('') + "].join('\\n');\n";

if (check) {
  let cur = null;
  try { cur = readFileSync(OUT); } catch { fail('src/lab-renderer.generated.ts 가 없습니다 — npm run build:lab-renderer'); }
  if (!cur.equals(Buffer.from(out, 'utf8'))) fail('src/lab-renderer.generated.ts 가 client/lab-renderer.ts 와 맞지 않습니다 — npm run build:lab-renderer');
  console.log('build-lab-renderer: 최신');
} else {
  writeFileSync(OUT, out);
  console.log(`build-lab-renderer: ${OUT} (${Buffer.byteLength(out)} B)`);
}
