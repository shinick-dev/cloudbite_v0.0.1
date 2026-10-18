// Cloudbite audience access: public QR showcase + visitor request form + owner inbox → src/cloudbite-access-page.ts and demo/ assets.
//   node tools/build-cloudbite-access.mjs          rebuild
//   node tools/build-cloudbite-access.mjs --check  fail unless every generated file is byte-identical to a fresh build
// The QR encodes Cloudbite's own request page; it grants nothing by itself (the owner approves each visitor on the server).
// client/cloudbite-access.ts is transformed once by esbuild (no bundling, no minify) into CLOUDBITE_ACCESS_JS; pages load only
// same-origin external script/style — no inline script, inline handlers, external fonts or CDN. No credential in any output.
import { renderSVG, encode } from 'uqr';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync, version } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://cloudbite.shinick.dev';
const REQUEST_URL = `${ORIGIN}/cloudbite/request`;
const OWNER_URL = `${ORIGIN}/cloudbite/requests`;
const JS_PATH = '/cloudbite/access.js';
const CSS_PATH = '/cloudbite/access.css';
const ESBUILD = '0.28.1';
const fail = (msg) => { console.error(`build-cloudbite-access: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} required (npm ci)`);

// ── QR (SVG + PNG)
const svg = renderSVG(REQUEST_URL, { ecc: 'M', border: 4, pixelSize: 16, blackColor: '#0b1425', whiteColor: '#ffffff' });
const qr = encode(REQUEST_URL, { ecc: 'M', border: 4 });
const scale = 24, width = qr.size * scale;
const raw = Buffer.alloc((width * 3 + 1) * width);
for (let y=0;y<width;y++) for (let x=0;x<width;x++) {
  const color = qr.data[Math.floor(y/scale)][Math.floor(x/scale)] ? [11,20,37] : [255,255,255];
  for (let c=0;c<3;c++) raw[y*(width*3+1)+1+x*3+c]=color[c];
}
function crc32(b) { let n=0xffffffff;for(const v of b){n^=v;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0)}return(n^0xffffffff)>>>0; }
function chunk(type,data) {const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),data.length+8);return out;}
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(width,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const pngUrl='data:image/png;base64,'+png.toString('base64');
const svgUrl='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');

// ── CSS + JS from client/
const css = readFileSync(root + 'client/cloudbite-access.css', 'utf8').replace(/\r\n/g, '\n');
const src = readFileSync(root + 'client/cloudbite-access.ts', 'utf8');
if (src.charCodeAt(0) === 0xfeff || css.charCodeAt(0) === 0xfeff) fail('source has a BOM');
if (/@import|url\(\s*['"]?https?:/i.test(css)) fail('CSS references an external resource');
const { code, warnings } = transformSync(src, { loader: 'ts', target: 'es2022', minify: false, charset: 'utf8', legalComments: 'none', sourcefile: 'client/cloudbite-access.ts', sourcemap: false });
if (warnings.length) fail(`esbuild warnings: ${warnings.map((w) => w.text).join(' / ')}`);
const UNSAFE = [
  [/^\s*(?:import|export)\b/m, 'import/export'], [/\bimport\s*\(/, 'import()'], [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b/, 'HTML string injection'], [/\bdocument\.write/, 'document.write'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/, 'browser storage or cookie access'], [/setAttribute\(\s*['"](?:style|on\w+)['"]/, 'style/on* attribute'],
  [/https?:\/\//, 'external URL'],
];
for (const [re, what] of UNSAFE) if (re.test(code)) fail(`generated JS contains ${what}`);
const js = `(() => {\n'use strict';\n${code}})();\n`;

// ── pages
const head = (title, desc, style, lang = 'en') => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title><meta name="description" content="${desc}">${style}`;
// Public QR showcase copy, one block per language. The QR only opens the request page; nothing here names an owner sign-in method.
const SHOW = {
  en: {
    title: 'Cloudbite — Request access', language: 'Language', sub: 'Expert sandboxes for one shared project', h1: 'Try Cloudbite yourself.',
    lead: 'Scan to request a short Cloudbite session. Once the host approves it, you open Cloudbite, write one project brief, choose AI experts and watch them work in separate sandboxes.',
    qrAria: 'Cloudbite access request QR code', qrImg: (u) => `QR code for ${u}`, open: 'Open request form', save: 'Save QR image', svg: 'Download SVG', print: "Use your browser's Print command for a handout.",
    howH: 'From scan to running experts',
    steps: [['Scan and request Cloudbite access.', "Enter your name and what you would like to try. Keep the request page open — it checks for the host's answer every few seconds."],
      ['The host approves.', "Your request waits in the host's Cloudbite inbox, where the owner or a temporary Cloudbite operator approves or declines it. Unanswered requests expire after 30 minutes."],
      ['Open Cloudbite, choose experts, run your projects.', "The approved session lasts one hour in the same browser: up to ten projects, each with up to five AI experts. Nothing runs until you press Run experts, then you inspect each expert's files and the synthesis."]],
    noteH: 'The QR code itself grants no access.', noteP: 'Every visitor is approved individually on the server, and an approved session is limited in time, projects and experts. The approval lives in a secure cookie in your browser; nothing is stored in the link.',
    scope: "This is Cloudbite's own visitor flow. It does not open a classroom or a terminal, and approval alone creates no sandbox or paid run.",
    foot: 'Cloudbite visitor access · Host-approved, time-limited sessions', owner: 'Owner request inbox',
  },
  ko: {
    title: 'Cloudbite — 사용 요청', language: '언어', sub: '하나의 공통 프로젝트를 위한 전문가 샌드박스', h1: 'Cloudbite를 직접 써 보세요.',
    lead: 'QR 코드를 스캔해 짧은 Cloudbite 체험 세션을 요청하세요. 호스트가 승인하면 Cloudbite를 열어 프로젝트 개요를 하나 쓰고, AI 전문가를 골라 각자의 샌드박스에서 일하는 모습을 볼 수 있습니다.',
    qrAria: 'Cloudbite 사용 요청 QR 코드', qrImg: (u) => `${u} 로 연결되는 QR 코드`, open: '요청 양식 열기', save: 'QR 이미지 저장', svg: 'SVG 다운로드', print: '배포용 인쇄물은 브라우저의 인쇄 기능을 사용하세요.',
    howH: '스캔부터 전문가 실행까지',
    steps: [['스캔하고 Cloudbite 사용을 요청합니다.', '이름과 해 보고 싶은 일을 입력하세요. 요청 페이지를 열어 두면 몇 초마다 호스트의 답을 확인합니다.'],
      ['호스트가 승인합니다.', '요청은 호스트의 Cloudbite 요청함에서 기다리며, 소유자나 임시 Cloudbite 운영자가 승인하거나 거절합니다. 답이 없는 요청은 30분 뒤 만료됩니다.'],
      ['Cloudbite를 열고 전문가를 골라 프로젝트를 실행합니다.', '승인된 세션은 같은 브라우저에서 1시간 동안 유지됩니다. 프로젝트는 최대 10개, 프로젝트마다 AI 전문가는 최대 5명입니다. 전문가 실행을 누르기 전에는 아무것도 실행되지 않으며, 실행 뒤 전문가별 파일과 종합 결과를 살펴봅니다.']],
    noteH: 'QR 코드 자체로는 아무 권한도 주어지지 않습니다.', noteP: '방문자는 서버에서 한 명씩 승인되며, 승인된 세션은 시간·프로젝트 수·전문가 수가 제한됩니다. 승인은 브라우저의 보안 쿠키에만 담기고 링크에는 아무것도 저장되지 않습니다.',
    scope: 'Cloudbite 자체의 방문자 흐름입니다. 강의실이나 터미널을 열지 않으며, 승인만으로는 샌드박스나 유료 실행이 만들어지지 않습니다.',
    foot: 'Cloudbite 방문자 접근 · 호스트 승인, 시간 제한 세션', owner: '소유자 요청함',
  },
};
const LANG_NAME = { ko: '한국어', en: 'English' };
// online: ?lang= links (the access script switches in place); standalone file: #ko / #en fragments (CSS :target, no script)
function showBlock(l, online) {
  const t = SHOW[l], q = (u) => `${u}?lang=${l}`;
  const sw = ['ko', 'en'].map((x) => `<a href="${online ? `?lang=${x}` : `#${x}`}" lang="${x}" aria-label="${LANG_NAME[x]}" data-lang-link="${x}"${x === l ? ' aria-current="true"' : ''}>${x.toUpperCase()}</a>`).join('');
  const attrs = online ? `data-lang-block="${l}" data-title="${t.title}"${l === 'en' ? '' : ' hidden'}` : `id="${l}" class="qr-lang${l === 'ko' ? ' qr-alt' : ''}"`;
  return `<div ${attrs} lang="${l}"><header><strong>Cloudbite</strong><div class="qr-top-side"><span>${t.sub}</span><nav class="ax-lang" aria-label="${t.language}">${sw}</nav></div></header><main><h1>${t.h1}</h1><p class="lead">${t.lead}</p><div class="access-grid"><section class="qr-panel" aria-label="${t.qrAria}"><figure><div role="img" aria-label="${t.qrImg(REQUEST_URL)}">${svg}</div><figcaption><a href="${q(REQUEST_URL)}" target="_blank" rel="noopener noreferrer">${REQUEST_URL}</a></figcaption></figure><div class="actions"><a class="button primary" href="${q(REQUEST_URL)}" target="_blank" rel="noopener noreferrer">${t.open}</a><a class="button secondary" href="${pngUrl}" download="cloudbite-access-request.png">${t.save}</a></div><p class="downloads"><a href="${svgUrl}" download="cloudbite-access-request.svg">${t.svg}</a> · ${t.print}</p></section><section class="instructions" aria-labelledby="how-${l}"><h2 id="how-${l}">${t.howH}</h2><ol>${t.steps.map(([a, b]) => `<li><strong>${a}</strong><span>${b}</span></li>`).join('')}</ol><div class="note"><h3>${t.noteH}</h3><p>${t.noteP}</p></div><p class="scope">${t.scope}</p></section></div><footer><span>${t.foot}</span><a class="owner" href="${q(OWNER_URL)}" target="_blank" rel="noopener noreferrer">${t.owner}</a></footer></main></div>`;
}
const DESC = 'Scan to request a short Cloudbite session. The host approves it, then you open Cloudbite and run up to ten projects with AI experts.';
// online page: both blocks; /cloudbite/access.js shows the ?lang= or browser-language one. Without script the English block shows.
const online = `${head(SHOW.en.title, DESC, `<link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script>`)}</head>
<body><div id="cb-access" data-view="qr">${showBlock('en', true)}${showBlock('ko', true)}</div></body></html>`;
// standalone file: no script at all; English by default, KO via #ko (the ko block precedes en so :target can hide en)
const standalone = `${head(`${SHOW.en.title} · ${SHOW.ko.title.replace('Cloudbite — ', '')}`, DESC, '<style>' + css + '</style>')}</head>
<body>${showBlock('ko', false)}${showBlock('en', false)}</body></html>`;
const shell = (title, desc, view) => `${head(title, desc, `<link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script>`)}</head>
<body><div id="cb-access" data-view="${view}"><p class="ax-help">Loading… · 불러오는 중…</p><noscript><p>This page requires JavaScript. · 이 페이지는 JavaScript가 필요합니다.</p></noscript></div></body></html>
`;
const requestHtml = shell('Cloudbite — Request access', 'Ask the host for a short Cloudbite session.', 'request');
const requestsHtml = shell('Cloudbite — Access requests', 'Owner inbox for Cloudbite visitor access requests.', 'owner');

const generated = `// Generated by tools/build-cloudbite-access.mjs — do not edit. Sources: client/cloudbite-access.ts · client/cloudbite-access.css.
// Public URLs only; no credential. Routes (wired by the runtime): /cloudbite/access → CLOUDBITE_ACCESS_HTML, /cloudbite/request → CLOUDBITE_REQUEST_HTML,
// /cloudbite/requests → CLOUDBITE_REQUESTS_HTML, ${CSS_PATH} → CLOUDBITE_ACCESS_CSS, ${JS_PATH} → CLOUDBITE_ACCESS_JS, /cloudbite/access-qr.svg → CLOUDBITE_ACCESS_QR.
// CSP script-src 'self'; style-src 'self' is enough (no inline script or style).
export const CLOUDBITE_ACCESS_URL = ${JSON.stringify(REQUEST_URL)};
export const CLOUDBITE_ACCESS_OWNER_URL = ${JSON.stringify(OWNER_URL)};
export const CLOUDBITE_ACCESS_JS_PATH = ${JSON.stringify(JS_PATH)};
export const CLOUDBITE_ACCESS_CSS_PATH = ${JSON.stringify(CSS_PATH)};
export const CLOUDBITE_ACCESS_HTML = ${JSON.stringify(online)};
export const CLOUDBITE_REQUEST_HTML = ${JSON.stringify(requestHtml)};
export const CLOUDBITE_REQUESTS_HTML = ${JSON.stringify(requestsHtml)};
export const CLOUDBITE_ACCESS_CSS = ${JSON.stringify(css)};
export const CLOUDBITE_ACCESS_JS = ${JSON.stringify(js)};
export const CLOUDBITE_ACCESS_QR = ${JSON.stringify(svg)};
`;
// canonical names + old names kept as byte-identical compatibility copies of the same new QR
const outputs = [['src/cloudbite-access-page.ts', generated], ['demo/access-qr.html', standalone],
  ['demo/cloudbite-access-request.svg', svg], ['demo/cloudbite-access-request.png', png],
  ['demo/cloudbite-sandbox-request.svg', svg], ['demo/cloudbite-sandbox-request.png', png]];
for (const [path, data] of outputs) {
  if (Buffer.isBuffer(data)) continue;
  if (/k\.shinick\.dev|\/lab\/request|cbo_[A-Za-z0-9_-]{20}/i.test(data)) fail(`${path} would contain a legacy URL or credential-like value`);
}
// The public QR surfaces (showcase pages, QR image, page shells) never claim a security key: scanning grants nothing and visitors never
// use one. Only the owner sign-in copy inside CLOUDBITE_ACCESS_JS may name the owner's real security-key login.
const SECURITY_KEY = /security[\s-]*keys?|보안\s*키|webauthn|passkey|패스키/i;
for (const [what, data] of [['online QR page', online], ['standalone QR page', standalone], ['QR SVG', svg], ['request page shell', requestHtml], ['owner page shell', requestsHtml]]) {
  if (SECURITY_KEY.test(data)) fail(`${what} would contain a security-key claim`);
}
if (process.argv.includes('--check')) {
  for (const [path, data] of outputs) {
    const expected = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let actual;
    try { actual = readFileSync(root + path); } catch { fail('missing generated file: ' + path); }
    if (!actual.equals(expected)) fail('stale generated file: ' + path + ' — node tools/build-cloudbite-access.mjs');
  }
  console.log('cloudbite-access: generated files current');
} else {
  mkdirSync(root + 'demo', { recursive: true });
  for (const [path, data] of outputs) writeFileSync(root + path, data);
  console.log('cloudbite-access: generated pages, JS, SVG and ' + width + 'px PNG for ' + REQUEST_URL);
}
