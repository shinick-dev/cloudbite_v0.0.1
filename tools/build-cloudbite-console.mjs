// client/cloudbite-console.ts + client/cloudbite-console.css → src/cloudbite-page.ts (CLOUDBITE_HTML·CLOUDBITE_JS·CLOUDBITE_CSS 고정 문자열).
//   node tools/build-cloudbite-console.mjs          다시 만들기
//   node tools/build-cloudbite-console.mjs --check  만들어 둔 파일이 지금 소스로 만든 것과 한 바이트도 다르지 않은지만 본다
// esbuild transform(묶지 않음·줄이지 않음) 한 번. 페이지는 같은 출처 외부 스크립트·스타일(CLOUDBITE_JS_PATH·CLOUDBITE_CSS_PATH)만 부른다
// — 인라인 스크립트·style 속성·외부 CDN·웹 폰트 없음. 출력은 LF·BOM 없음.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformSync, version } from 'esbuild';

const ESBUILD = '0.28.1';
const SRC = fileURLToPath(new URL('../client/cloudbite-console.ts', import.meta.url));
const CSS_SRC = fileURLToPath(new URL('../client/cloudbite-console.css', import.meta.url));
const OUT = fileURLToPath(new URL('../src/cloudbite-page.ts', import.meta.url));
const JS_PATH = '/cloudbite/console.js';
const CSS_PATH = '/cloudbite/console.css';
const check = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-cloudbite-console: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} 이 필요합니다 (npm ci)`);

const srcBytes = readFileSync(SRC), cssBytes = readFileSync(CSS_SRC);
const src = srcBytes.toString('utf8'), css = cssBytes.toString('utf8').replace(/\r\n/g, '\n');
if (src.charCodeAt(0) === 0xfeff || css.charCodeAt(0) === 0xfeff) fail('소스에 BOM 이 있습니다');
const { code, warnings } = transformSync(src, {
  loader: 'ts', target: 'es2022', minify: false, charset: 'utf8', legalComments: 'none', sourcefile: 'client/cloudbite-console.ts', sourcemap: false,
});
if (warnings.length) fail(`esbuild 경고 ${warnings.length}개: ${warnings.map((w) => w.text).join(' / ')}`);

// DOM 은 textContent·createElement 로만, 저장소·동적 코드 실행 없음. 어기면 멈춘다
const UNSAFE = [
  [/^\s*(?:import|export)\b/m, 'import/export'], [/\bimport\s*\(/, 'import()'], [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b/, 'HTML 문자열 넣기'], [/\bdocument\.write/, 'document.write'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/, '브라우저 저장소'], [/setAttribute\(\s*['"](?:style|on\w+)['"]/, 'style·on* 속성'],
  [/https?:\/\//, '외부 URL'],
];
for (const [re, what] of UNSAFE) if (re.test(code)) fail(`만든 JS 에 ${what} 가 있습니다`);
if (/@import|url\(\s*['"]?https?:/i.test(css)) fail('CSS 에 외부 자원이 있습니다');

// 엄격 모드 함수로 감싸 전역을 더럽히지 않는다
const js = `(() => {\n'use strict';\n${code}})();\n`;
const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  + '<title>Cloudbite — Expert sandbox workspace</title>\n<meta name="description" content="Several expert AI roles work on one shared project in separate workspaces, and their results are synthesised">\n'
  + `<link rel="stylesheet" href="${CSS_PATH}">\n<script src="${JS_PATH}" defer></script>\n</head>\n<body>\n`
  + '<div id="cloudbite" class="cb-root"><p class="cb-loading">Loading the Cloudbite console…</p>'
  + '<noscript><p class="cb-loading">The Cloudbite console requires JavaScript.</p></noscript></div>\n</body>\n</html>\n';

const lines = (s) => '[\n' + s.replace(/\n$/, '').split('\n').map((l) => `  ${JSON.stringify(l)},\n`).join('') + "].join('\\n') + '\\n'";
const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = '// 만든 파일 — 직접 고치지 말 것. 소스: client/cloudbite-console.ts · client/cloudbite-console.css\n'
  + '// 다시 만들기: node tools/build-cloudbite-console.mjs (--check 로 최신인지 확인)\n'
  + `// esbuild ${ESBUILD} transform (ES2022, 묶지 않음) · ts sha256 ${sha(srcBytes)} · css sha256 ${sha(Buffer.from(css))}\n`
  + '// 라우팅(런타임 담당): GET / 와 /cloudbite → CLOUDBITE_HTML, CLOUDBITE_JS_PATH → CLOUDBITE_JS (text/javascript),\n'
  + '// CLOUDBITE_CSS_PATH → CLOUDBITE_CSS (text/css). CSP 는 script-src \'self\'; style-src \'self\' 면 충분하다 (인라인 없음).\n'
  + `export const CLOUDBITE_JS_PATH = ${JSON.stringify(JS_PATH)};\n`
  + `export const CLOUDBITE_CSS_PATH = ${JSON.stringify(CSS_PATH)};\n`
  + `export const CLOUDBITE_HTML = ${lines(html)};\n`
  + `export const CLOUDBITE_CSS = ${lines(css)};\n`
  + `export const CLOUDBITE_JS = ${lines(js)};\n`;

if (check) {
  let cur = null;
  try { cur = readFileSync(OUT); } catch { fail('src/cloudbite-page.ts 가 없습니다 — node tools/build-cloudbite-console.mjs'); }
  if (!cur.equals(Buffer.from(out, 'utf8'))) fail('src/cloudbite-page.ts 가 client 소스와 맞지 않습니다 — node tools/build-cloudbite-console.mjs');
  console.log('build-cloudbite-console: 최신');
} else {
  writeFileSync(OUT, out);
  console.log(`build-cloudbite-console: ${OUT} (${Buffer.byteLength(out)} B)`);
}
