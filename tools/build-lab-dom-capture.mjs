// client/lab-dom-capture.ts → src/lab-dom-capture.generated.ts
//   node tools/build-lab-dom-capture.mjs          다시 만들기 (npm run build:lab-dom-capture)
//   node tools/build-lab-dom-capture.mjs --check  만들어 둔 파일이 지금 소스로 만든 것과 한 바이트도 다르지 않은지만 본다
// html-to-image@1.11.13 을 이 페이지용 스크립트 하나로 묶는다. CDN·eval·innerHTML 은 넣지 않는다.
// textarea 값 복사는 라이브러리가 innerHTML 에 쓰므로, 번들할 때만 textContent 로 바꿔 Trusted Types 에 닿지 않게 한다.
// 비밀번호는 복사본만 마스킹한다. 참여자가 입력 중인 원본 필드는 변경하지 않는다.
// 디코딩 완료 뒤의 이미지별 rAF 대기는 송출에 불필요하므로 번들에서만 제거한다.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, version } from 'esbuild';

const ESBUILD = '0.28.1';
const HTML_TO_IMAGE = '1.11.13';
const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = fileURLToPath(new URL('../client/lab-dom-capture.ts', import.meta.url));
const OUT = fileURLToPath(new URL('../src/lab-dom-capture.generated.ts', import.meta.url));
const check = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-lab-dom-capture: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} 이 필요합니다 (npm ci)`);

const srcBytes = readFileSync(SRC);
const src = srcBytes.toString('utf8');
if (src.charCodeAt(0) === 0xfeff) fail('client/lab-dom-capture.ts 에 BOM 이 있습니다');

function exportString(name) {
  const token = `export const ${name} = `;
  const at = src.indexOf(token);
  if (at < 0) fail(`${name} 이 없습니다`);
  const start = at + token.length;
  if (src[start] !== '"') fail(`${name} 은 JSON 문자열이어야 합니다`);
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '"') {
      if (src[i + 1] !== ';') fail(`${name} 은 세미콜론으로 끝나야 합니다`);
      return JSON.parse(src.slice(start, i + 1));
    }
    i += 1;
  }
  fail(`${name} 문자열이 닫히지 않았습니다`);
}

const prelude = exportString('LAB_DOM_CAPTURE_PRELUDE_JS');
let patches = 0;
let passwordPatches = 0;
let decodePatches = 0;
const built = await build({
  stdin: {
    contents: "import { installLabDomCapture } from './client/lab-dom-capture.ts';\ninstallLabDomCapture();\n",
    resolveDir: root,
    sourcefile: 'lab-dom-capture-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  charset: 'utf8',
  write: false,
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `/*! html-to-image@${HTML_TO_IMAGE} MIT. Copyright (c) 2017-2025 W.Y. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */`,
  },
  plugins: [{
    name: 'html-to-image-textcontent',
    setup(build) {
      build.onLoad({ filter: /[\\/]html-to-image[\\/].+\.js$/ }, (args) => {
        const contents = readFileSync(args.path, 'utf8').replaceAll(
          'clonedNode.innerHTML = nativeNode.value',
          () => { patches += 1; return 'clonedNode.textContent = nativeNode.value'; },
        ).replaceAll(
          "clonedNode.setAttribute('value', nativeNode.value)",
          () => { passwordPatches += 1; return "clonedNode.setAttribute('value', nativeNode.type === 'password' ? '\\u2022'.repeat(nativeNode.value.length) : nativeNode.value)"; },
        );
        // decode() already makes the pixels usable. Waiting for a browser
        // animation frame per image can add seconds in an obscured lab tab.
        const decoded = contents.replaceAll('requestAnimationFrame(() => resolve(img));',
          () => { decodePatches += 1; return 'resolve(img);'; });
        return { contents: decoded, loader: 'js' };
      });
    },
  }],
});
if (built.warnings.length) fail(`esbuild 경고 ${built.warnings.length}개: ${built.warnings.map((w) => w.text).join(' / ')}`);
if (patches < 1) fail('html-to-image textarea innerHTML 경로를 바꾸지 못했습니다');
if (passwordPatches !== 1) fail('html-to-image 비밀번호 복사 경로를 바꾸지 못했습니다');
if (decodePatches !== 1) fail('html-to-image 이미지 디코딩 대기 경로를 바꾸지 못했습니다');
const code = built.outputFiles[0].text.replace(/\r\n/g, '\n');
const UNSAFE = [
  [/<\/script/i, '</script'], [/<script/i, '<script'], [/<!--/, '<!--'],
  [/\beval\s*\(/, 'eval'], [/\bFunction\s*\(/, 'Function()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, 'HTML 문자열 넣기'],
  [/\bdocument\.write/, 'document.write'], [/\bgetDisplayMedia\b/, 'getDisplayMedia'],
  [/\bimport\s*\(/, 'import()'],
];
for (const source of [code, prelude]) {
  for (const [re, what] of UNSAFE) if (re.test(source)) fail(`만든 JS 에 ${what} 가 있습니다`);
}

const notice = [
  '// 만든 파일 — 직접 고치지 말 것. 소스: client/lab-dom-capture.ts · 다시 만들기: npm run build:lab-dom-capture',
  `// esbuild ${ESBUILD} bundle (ES2022, minify, iife). html-to-image@${HTML_TO_IMAGE} MIT`,
  `// 소스 sha256 ${createHash('sha256').update(srcBytes).digest('hex')}`,
  '/*',
  'MIT License',
  'Copyright (c) 2017-2025 W.Y.',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '*/',
  `export const LAB_DOM_CAPTURE_PRELUDE_JS = ${JSON.stringify(prelude)};`,
  `export const LAB_DOM_CAPTURE_JS = ${JSON.stringify(code)};`,
  '',
].join('\n');

if (check) {
  let cur = null;
  try { cur = readFileSync(OUT); } catch { fail('src/lab-dom-capture.generated.ts 가 없습니다 — npm run build:lab-dom-capture'); }
  if (!cur.equals(Buffer.from(notice, 'utf8'))) fail('src/lab-dom-capture.generated.ts 가 client/lab-dom-capture.ts 와 맞지 않습니다 — npm run build:lab-dom-capture');
  console.log('build-lab-dom-capture: 최신');
} else {
  writeFileSync(OUT, notice);
  console.log(`build-lab-dom-capture: ${OUT} (${Buffer.byteLength(notice)} B)`);
}
