// client/lab-demo-broadcast.ts → src/lab-demo-broadcast.generated.ts
//   node tools/build-lab-demo-broadcast.mjs          다시 만들기
//   node tools/build-lab-demo-broadcast.mjs --check  만들어 둔 파일이 지금 소스로 만든 것과 한 바이트도 다르지 않은지만 본다
// html-to-image@1.11.13 을 이 페이지용 스크립트 하나로 묶는다. CDN·eval·innerHTML 은 넣지 않는다.
// textarea 값 복사는 라이브러리가 innerHTML 에 쓰므로, 번들할 때만 textContent 로 바꿔 Trusted Types 에 닿지 않게 한다.
// 비밀번호는 복사본만 마스킹한다. 참여자가 입력 중인 원본 필드는 변경하지 않는다.
// 디코딩 완료 뒤의 이미지별 rAF 대기는 송출에 불필요하므로 번들에서만 제거한다.
// 클론 CSS 의 url() 은 원격 이미지를 가져오므로 none 으로 바꾸고, 문서 밖의 SVG symbol 은 끌어오지 않는다.
// 스크롤은 원본이 아니라 클론에서만 자른다. textarea·pre 글자는 칸을 유지한 채 옮기고, 원본 레이아웃은 그대로 둔다.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, version } from 'esbuild';

const ESBUILD = '0.28.1';
const HTML_TO_IMAGE = '1.11.13';
const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = fileURLToPath(new URL('../client/lab-demo-broadcast.ts', import.meta.url));
const OUT = fileURLToPath(new URL('../src/lab-demo-broadcast.generated.ts', import.meta.url));
const HTML_PKG = fileURLToPath(new URL('../node_modules/html-to-image/package.json', import.meta.url));
const check = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-lab-demo-broadcast: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} 이 필요합니다 (npm ci)`);
const installed = JSON.parse(readFileSync(HTML_PKG, 'utf8')).version;
if (installed !== HTML_TO_IMAGE) fail(`html-to-image ${installed} — ${HTML_TO_IMAGE} 이 필요합니다 (npm ci)`);

const srcBytes = readFileSync(SRC);
const src = srcBytes.toString('utf8');
if (src.charCodeAt(0) === 0xfeff) fail('client/lab-demo-broadcast.ts 에 BOM 이 있습니다');
if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML|getDisplayMedia|eval\s*\(|document\.write)\b/.test(src)) {
  fail('client/lab-demo-broadcast.ts 에 금지된 호출이 있습니다');
}

const STRIP = `function labStripCss(css) {
    return String(css == null ? '' : css)
        .replace(/url\\(\\s*(?:"[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi, 'none')
        .replace(/image-set\\(\\s*(?:"[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi, 'none')
        .replace(/(?:-webkit-)?image\\(\\s*(?:"[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi, 'none')
        .replace(/expression\\([^)]*\\)/gi, 'none');
}`;

const SCROLL = `function labWrapScroll(nativeNode, clonedNode) {
    if (!clonedNode || !nativeNode) return clonedNode;
    var top = nativeNode.scrollTop || 0;
    var left = nativeNode.scrollLeft || 0;
    if (!top && !left) return clonedNode;
    var tag = String(nativeNode.tagName || '').toUpperCase();
    var textLike = tag === 'TEXTAREA' || tag === 'PRE' || !clonedNode.children || clonedNode.children.length === 0;
    if (!textLike) {
        for (var i = 0; i < clonedNode.children.length; i++) {
            var child = clonedNode.children[i];
            if (!child || !child.style) continue;
            var prev = child.style.transform && child.style.transform !== 'none' ? child.style.transform : '';
            child.style.transform = 'translate(' + (-left) + 'px,' + (-top) + 'px)' + (prev ? ' ' + prev : '');
            child.style.transformOrigin = '0 0';
        }
        clonedNode.style.overflowX = 'hidden';
        clonedNode.style.overflowY = 'hidden';
        return clonedNode;
    }
    var wrap = document.createElement('div');
    var view = window.getComputedStyle(nativeNode);
    wrap.style.boxSizing = view.boxSizing;
    wrap.style.display = view.display;
    wrap.style.position = view.position;
    wrap.style.top = view.top;
    wrap.style.right = view.right;
    wrap.style.bottom = view.bottom;
    wrap.style.left = view.left;
    wrap.style.zIndex = view.zIndex;
    wrap.style.float = view.float;
    wrap.style.clear = view.clear;
    wrap.style.width = view.width;
    wrap.style.height = view.height;
    wrap.style.margin = view.margin;
    wrap.style.flex = view.flex;
    wrap.style.flexGrow = view.flexGrow;
    wrap.style.flexShrink = view.flexShrink;
    wrap.style.flexBasis = view.flexBasis;
    wrap.style.alignSelf = view.alignSelf;
    wrap.style.order = view.order;
    wrap.style.gridColumn = view.gridColumn;
    wrap.style.gridRow = view.gridRow;
    wrap.style.verticalAlign = view.verticalAlign;
    wrap.style.overflow = 'hidden';
    wrap.style.borderTop = view.borderTopWidth + ' ' + view.borderTopStyle + ' ' + view.borderTopColor;
    wrap.style.borderRight = view.borderRightWidth + ' ' + view.borderRightStyle + ' ' + view.borderRightColor;
    wrap.style.borderBottom = view.borderBottomWidth + ' ' + view.borderBottomStyle + ' ' + view.borderBottomColor;
    wrap.style.borderLeft = view.borderLeftWidth + ' ' + view.borderLeftStyle + ' ' + view.borderLeftColor;
    wrap.style.borderRadius = view.borderRadius;
    wrap.style.backgroundColor = view.backgroundColor;
    wrap.style.maxWidth = view.maxWidth;
    wrap.style.minWidth = '0';
    clonedNode.style.margin = '0';
    clonedNode.style.border = '0';
    clonedNode.style.boxShadow = 'none';
    clonedNode.style.backgroundColor = 'transparent';
    clonedNode.style.backgroundImage = 'none';
    clonedNode.style.position = 'relative';
    clonedNode.style.top = 'auto';
    clonedNode.style.right = 'auto';
    clonedNode.style.bottom = 'auto';
    clonedNode.style.left = 'auto';
    clonedNode.style.float = 'none';
    clonedNode.style.zIndex = 'auto';
    clonedNode.style.flex = 'none';
    var existing = clonedNode.style.transform && clonedNode.style.transform !== 'none' ? clonedNode.style.transform : '';
    clonedNode.style.transform = 'translate(' + (-left) + 'px,' + (-top) + 'px)' + (existing ? ' ' + existing : '');
    clonedNode.style.transformOrigin = '0 0';
    clonedNode.style.width = Math.max(nativeNode.scrollWidth || 0, nativeNode.clientWidth || 0) + 'px';
    clonedNode.style.height = Math.max(nativeNode.scrollHeight || 0, nativeNode.clientHeight || 0) + 'px';
    clonedNode.style.overflow = 'hidden';
    wrap.appendChild(clonedNode);
    return wrap;
}`;

let patches = 0;
let passwordPatches = 0;
let decodePatches = 0;
let cssPatches = 0;
let pseudoPatches = 0;
let propPatches = 0;
let symbolPatches = 0;
let handlerPatches = 0;
let scrollPatches = 0;
const built = await build({
  stdin: {
    contents: "import { installLabDemoBroadcast } from './client/lab-demo-broadcast.ts';\ninstallLabDemoBroadcast();\n",
    resolveDir: root,
    sourcefile: 'lab-demo-broadcast-entry.ts',
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
    name: 'html-to-image-demo-broadcast',
    setup(build) {
      build.onLoad({ filter: /[\\/]html-to-image[\\/].+\.js$/ }, (args) => {
        let contents = readFileSync(args.path, 'utf8').replaceAll(
          'clonedNode.innerHTML = nativeNode.value',
          () => { patches += 1; return 'clonedNode.textContent = nativeNode.value'; },
        ).replaceAll(
          "clonedNode.setAttribute('value', nativeNode.value)",
          () => { passwordPatches += 1; return "clonedNode.setAttribute('value', nativeNode.type === 'password' ? '\\u2022'.repeat(nativeNode.value.length) : nativeNode.value)"; },
        );
        contents = contents.replaceAll('requestAnimationFrame(() => resolve(img));',
          () => { decodePatches += 1; return 'resolve(img);'; });
        if (contents.includes('function cloneCSSStyle(')) {
          contents = contents.replace(
            'import { resourceToDataURL } from \'./dataurl\';',
            () => { scrollPatches += 1; return `import { resourceToDataURL } from './dataurl';\n${STRIP}\n${SCROLL}\n`; },
          ).replaceAll(
            'targetStyle.cssText = sourceStyle.cssText',
            () => { cssPatches += 1; return 'targetStyle.cssText = labStripCss(sourceStyle.cssText)'; },
          ).replaceAll(
            'targetStyle.setProperty(name, value, sourceStyle.getPropertyPriority(name));',
            () => { propPatches += 1; return 'targetStyle.setProperty(name, labStripCss(value), sourceStyle.getPropertyPriority(name));'; },
          ).replaceAll(
            'const definition = document.querySelector(id);',
            () => { symbolPatches += 1; return 'const definition = null;'; },
          ).replace(
            'cloneSelectValue(nativeNode, clonedNode);\n    }',
            () => {
              handlerPatches += 1;
              return `cloneSelectValue(nativeNode, clonedNode);
        if (clonedNode.attributes) {
            for (var labI = clonedNode.attributes.length - 1; labI >= 0; labI--) {
                var labAttr = clonedNode.attributes[labI];
                var labName = String(labAttr.name || '').toLowerCase();
                var labValue = String(labAttr.value || '');
                if (labName.indexOf('on') === 0 || ((labName === 'href' || labName === 'src' || labName === 'xlink:href') && /^\\s*(?:javascript:|data:text\\/html)/i.test(labValue))) clonedNode.removeAttribute(labAttr.name);
            }
        }
    }`;
            },
          ).replace(
            '.then((clonedNode) => ensureSVGSymbols(clonedNode, options));',
            '.then((clonedNode) => ensureSVGSymbols(clonedNode, options))\n        .then((clonedNode) => labWrapScroll(node, clonedNode));',
          );
        }
        if (contents.includes('function formatCSSText(')) {
          contents = contents.replace(
            'import { uuid, getStyleProperties } from \'./util\';',
            () => { pseudoPatches += 1; return `import { uuid, getStyleProperties } from './util';\n${STRIP}\n`; },
          ).replace(
            'function formatCSSText(style) {\n    const content = style.getPropertyValue(\'content\');\n    return `${style.cssText} content: \'${content.replace(/\'|"/g, \'\')}\';`;\n}',
            `function formatCSSText(style) {
    const content = String(style.getPropertyValue('content') || '');
    const safeContent = content.replace(/['"\\\\]/g, '').replace(/url\\(\\s*(?:"[^"]*"|'[^']*'|[^)]*)\\s*\\)/gi, '');
    return \`\${labStripCss(style.cssText)} content: '\${safeContent}';\`;
}`,
          ).replace(
            "if (content === '' || content === 'none') {\n        return;\n    }",
            "if (content === '' || content === 'none' || /url\\(|expression\\(|javascript:/i.test(content)) {\n        return;\n    }",
          );
        }
        return { contents, loader: 'js' };
      });
    },
  }],
});
if (built.warnings.length) fail(`esbuild 경고 ${built.warnings.length}개: ${built.warnings.map((w) => w.text).join(' / ')}`);
if (patches !== 1) fail('html-to-image textarea innerHTML 경로를 바꾸지 못했습니다');
if (passwordPatches !== 1) fail('html-to-image 비밀번호 복사 경로를 바꾸지 못했습니다');
if (decodePatches !== 1) fail('html-to-image 이미지 디코딩 대기 경로를 바꾸지 못했습니다');
if (cssPatches !== 1 || propPatches !== 1 || pseudoPatches !== 1) fail('html-to-image CSS url 경로를 바꾸지 못했습니다');
if (symbolPatches !== 1) fail('html-to-image 문서 밖 SVG 경로를 바꾸지 못했습니다');
if (handlerPatches !== 1 || scrollPatches !== 1) fail('html-to-image 클론 수명 경로를 바꾸지 못했습니다');
const code = built.outputFiles[0].text.replace(/\r\n/g, '\n');
const UNSAFE = [
  [/<\/script/i, '</script'], [/<script/i, '<script'], [/<!--/, '<!--'],
  [/\beval\s*\(/, 'eval'], [/\bFunction\s*\(/, 'Function()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, 'HTML 문자열 넣기'],
  [/\bdocument\.write/, 'document.write'], [/\bgetDisplayMedia\b/, 'getDisplayMedia'],
  [/\bimport\s*\(/, 'import()'],
];
for (const [re, what] of UNSAFE) if (re.test(code)) fail(`만든 JS 에 ${what} 가 있습니다`);
if (!code.includes('createLabDemoBroadcast')) fail('createLabDemoBroadcast 설치가 없습니다');
if (!code.includes('captureStream(15)')) fail('captureStream(15) 가 없습니다');

const notice = [
  '// 만든 파일 — 직접 고치지 말 것. 소스: client/lab-demo-broadcast.ts · 다시 만들기: node tools/build-lab-demo-broadcast.mjs',
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
  `export const LAB_DEMO_BROADCAST_JS = ${JSON.stringify(code)};`,
  '',
].join('\n');

if (check) {
  let cur = null;
  try { cur = readFileSync(OUT); } catch { fail('src/lab-demo-broadcast.generated.ts 가 없습니다 — node tools/build-lab-demo-broadcast.mjs'); }
  if (!cur.equals(Buffer.from(notice, 'utf8'))) fail('src/lab-demo-broadcast.generated.ts 가 client/lab-demo-broadcast.ts 와 맞지 않습니다 — node tools/build-lab-demo-broadcast.mjs');
  console.log('build-lab-demo-broadcast: 최신');
} else {
  writeFileSync(OUT, notice);
  console.log(`build-lab-demo-broadcast: ${OUT} (${Buffer.byteLength(notice)} B)`);
}
