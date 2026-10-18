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
const ORIGIN = 'https://cloudbite-v001.ai-gongbu.workers.dev';
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
const head = (title, desc, style) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title><meta name="description" content="${desc}">${style}`;
function showcase(style) { return `${head('Cloudbite — Request access', 'Scan to request a short Cloudbite session. The host approves it, then you open Cloudbite and run up to ten projects with AI experts.', style)}</head>
<body><header><strong>Cloudbite</strong><span>Expert sandboxes for one shared project</span></header><main><h1>Try Cloudbite yourself.</h1><p class="lead">Scan to request a short Cloudbite session. Once the host approves it, you open Cloudbite, write one project brief, choose AI experts and watch them work in separate sandboxes.</p><div class="access-grid"><section class="qr-panel" aria-label="Cloudbite access request QR code"><figure><div role="img" aria-label="QR code for ${REQUEST_URL}">${svg}</div><figcaption><a href="${REQUEST_URL}" target="_blank" rel="noopener noreferrer">${REQUEST_URL}</a></figcaption></figure><div class="actions"><a class="button primary" href="${REQUEST_URL}" target="_blank" rel="noopener noreferrer">Open request form</a><a class="button secondary" href="${pngUrl}" download="cloudbite-access-request.png">Save QR image</a></div><p class="downloads"><a href="${svgUrl}" download="cloudbite-access-request.svg">Download SVG</a> · Use your browser's Print command for a handout.</p></section><section class="instructions" aria-labelledby="how"><h2 id="how">From scan to running experts</h2><ol><li><strong>Scan and request Cloudbite access.</strong><span>Enter your name and what you would like to try. Keep the request page open — it checks for the host's answer every few seconds.</span></li><li><strong>The host approves.</strong><span>Your request waits in the host's Cloudbite inbox, where the owner or a temporary Cloudbite operator approves or declines it. Unanswered requests expire after 30 minutes.</span></li><li><strong>Open Cloudbite, choose experts, run your projects.</strong><span>The approved session lasts one hour in the same browser: up to ten projects, each with up to five AI experts. Nothing runs until you press Run experts, then you inspect each expert's files and the synthesis.</span></li></ol><div class="note"><h3>The QR code itself grants no access.</h3><p>Every visitor is approved individually on the server, and an approved session is limited in time, projects and experts. The approval lives in a secure cookie in your browser; nothing is stored in the link.</p></div><p class="scope">This is Cloudbite's own visitor flow. It does not open a classroom or a terminal, and approval alone creates no sandbox or paid run.</p></section></div><footer><span>Cloudbite visitor access · Host-approved, time-limited sessions</span><a class="owner" href="${OWNER_URL}" target="_blank" rel="noopener noreferrer">Owner request inbox</a></footer></main></body></html>`; }
const shell = (title, desc, view) => `${head(title, desc, `<link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script>`)}</head>
<body><div id="cb-access" data-view="${view}"><p class="ax-help">Loading…</p><noscript><p>This page requires JavaScript.</p></noscript></div></body></html>
`;
const online = showcase(`<link rel="stylesheet" href="${CSS_PATH}">`);
const requestHtml = shell('Cloudbite — Request access', 'Ask the host for a short Cloudbite session.', 'request');
const requestsHtml = shell('Cloudbite — Access requests', 'Owner inbox for Cloudbite visitor access requests.', 'owner');
const standalone = showcase('<style>' + css + '</style>');

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
  if (/k\.shinick\.dev|\/lab\/request|cbo_[A-Za-z0-9_-]{20}|security key/i.test(data)) fail(`${path} would contain a legacy URL, credential-like value or security-key claim`);
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
