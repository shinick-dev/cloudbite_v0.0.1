// client/cloudbite-computer-costs.ts + client/cloudbite-computer-costs.css → src/cloudbite-computer-costs-page.ts
// (CLOUDBITE_COMPUTER_COSTS_HTML·CLOUDBITE_COMPUTER_COSTS_JS·CLOUDBITE_COMPUTER_COSTS_CSS fixed strings).
//   node tools/build-cloudbite-computer-costs.mjs          rebuild
//   node tools/build-cloudbite-computer-costs.mjs --check  only verify the generated file is byte-identical to a fresh build
// One esbuild transform (no bundling, no minify). The page loads only same-origin external script and style
// (CLOUDBITE_COMPUTER_COSTS_JS_PATH·CLOUDBITE_COMPUTER_COSTS_CSS_PATH) — no inline script, style attribute, CDN or web font. Output is LF, no BOM.
// Independent of tools/build-cloudbite-computer.mjs: the main computer page and its generated module are not touched.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformSync, version } from 'esbuild';

const ESBUILD = '0.28.1';
const SRC = fileURLToPath(new URL('../client/cloudbite-computer-costs.ts', import.meta.url));
const CSS_SRC = fileURLToPath(new URL('../client/cloudbite-computer-costs.css', import.meta.url));
const OUT = fileURLToPath(new URL('../src/cloudbite-computer-costs-page.ts', import.meta.url));
const PAGE_PATH = '/cloudbite/computer/costs';
const JS_PATH = '/cloudbite/computer/costs.js';
const CSS_PATH = '/cloudbite/computer/costs.css';
// The script calls only same-origin APIs; these fixed official pricing/billing pages are its only absolute URLs (links, never fetched).
const ALLOWED_URLS = [
  'https://www.daytona.io/pricing', 'https://www.daytona.io/docs/en/billing', 'https://app.daytona.io/dashboard/billing/wallet',
  'https://learn.nosana.com/api/credits.html', 'https://dashboard.nosana.com/',
];
const MODULE_MARKER = '\nexport {};\n';
const check = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-cloudbite-computer-costs: ${msg}`); process.exit(1); };
if (version !== ESBUILD) fail(`esbuild ${version} — ${ESBUILD} is required (npm ci)`);

const srcBytes = readFileSync(SRC), cssBytes = readFileSync(CSS_SRC);
const src = srcBytes.toString('utf8'), css = cssBytes.toString('utf8').replace(/\r\n/g, '\n');
if (src.charCodeAt(0) === 0xfeff || css.charCodeAt(0) === 0xfeff) fail('source has a BOM');
const { code: raw, warnings } = transformSync(src, {
  loader: 'ts', target: 'es2022', minify: false, charset: 'utf8', legalComments: 'none', sourcefile: 'client/cloudbite-computer-costs.ts', sourcemap: false,
});
if (warnings.length) fail(`esbuild warnings ${warnings.length}: ${warnings.map((w) => w.text).join(' / ')}`);
// `export {}` only makes tsc treat the file as a module; it must be the last statement and is removed here
if (!raw.endsWith(MODULE_MARKER)) fail('expected the trailing `export {};` module marker');
const code = raw.slice(0, -MODULE_MARKER.length + 1);

// DOM only through textContent·createElement; no storage, no dynamic code. Any violation stops the build.
let scan = code;
for (const u of ALLOWED_URLS) scan = scan.split(JSON.stringify(u).slice(1, -1)).join('');
const UNSAFE = [
  [/^\s*(?:import|export)\b/m, 'import/export'], [/\bimport\s*\(/, 'import()'], [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b/, 'HTML string injection'], [/\bdocument\.write/, 'document.write'],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/, 'browser storage'], [/setAttribute\(\s*['"](?:style|on\w+|srcdoc)['"]/, 'style·on* attribute'],
  [/\.style\b/, 'inline style'], [/\b(?:iframe|postMessage)\b/, 'iframe/postMessage'],
  [/https?:\/\//, 'external URL'], [/\bnavigator\.credentials\b|\bPublicKeyCredential\b/, 'WebAuthn (sign-in stays on the main page)'],
  [/\bAuthorization\b|\bBearer\b/i, 'authorization header'],
];
for (const [re, what] of UNSAFE) if (re.test(scan)) fail(`generated JS contains ${what}`);
if (/@import|url\(\s*['"]?(?:https?:|\/\/)/i.test(css)) fail('CSS has an external resource');

// wrap in a strict IIFE so nothing leaks into the page's global scope
const js = `(() => {\n'use strict';\n${code}})();\n`;
const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + '<meta name="color-scheme" content="light">\n<meta name="theme-color" content="#142440">\n<meta name="referrer" content="no-referrer">\n'
  + '<title>Cloudbite — Costs</title>\n<meta name="description" content="Estimated Daytona hourly cost and Nosana credit balance, read-only">\n'
  + `<link rel="stylesheet" href="${CSS_PATH}">\n<script src="${JS_PATH}" defer></script>\n</head>\n<body>\n`
  + '<div id="cb-computer-costs"><p class="cc-loading">Loading costs…</p>'
  + '<noscript><p class="cc-loading">This page requires JavaScript.</p></noscript></div>\n</body>\n</html>\n';

const lines = (s) => '[\n' + s.replace(/\n$/, '').split('\n').map((l) => `  ${JSON.stringify(l)},\n`).join('') + "].join('\\n') + '\\n'";
const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = '// Generated file — do not edit. Sources: client/cloudbite-computer-costs.ts · client/cloudbite-computer-costs.css\n'
  + '// Rebuild: node tools/build-cloudbite-computer-costs.mjs (--check verifies it is current)\n'
  + `// esbuild ${ESBUILD} transform (ES2022, unbundled) · ts sha256 ${sha(srcBytes)} · css sha256 ${sha(Buffer.from(css))}\n`
  + '// Routing (runtime): GET CLOUDBITE_COMPUTER_COSTS_PATH → CLOUDBITE_COMPUTER_COSTS_HTML, CLOUDBITE_COMPUTER_COSTS_JS_PATH → CLOUDBITE_COMPUTER_COSTS_JS (text/javascript),\n'
  + '// CLOUDBITE_COMPUTER_COSTS_CSS_PATH → CLOUDBITE_COMPUTER_COSTS_CSS (text/css). CSP script-src \'self\'; style-src \'self\' suffices (no inline).\n'
  + '// The script calls only GET /api/cloudbite/computer/costs same-origin with the existing cookie; it links to /cloudbite/computer and fixed official pricing pages.\n'
  + `export const CLOUDBITE_COMPUTER_COSTS_PATH = ${JSON.stringify(PAGE_PATH)};\n`
  + `export const CLOUDBITE_COMPUTER_COSTS_JS_PATH = ${JSON.stringify(JS_PATH)};\n`
  + `export const CLOUDBITE_COMPUTER_COSTS_CSS_PATH = ${JSON.stringify(CSS_PATH)};\n`
  + `export const CLOUDBITE_COMPUTER_COSTS_HTML = ${lines(html)};\n`
  + `export const CLOUDBITE_COMPUTER_COSTS_CSS = ${lines(css)};\n`
  + `export const CLOUDBITE_COMPUTER_COSTS_JS = ${lines(js)};\n`;

if (check) {
  let cur = null;
  try { cur = readFileSync(OUT); } catch { fail('src/cloudbite-computer-costs-page.ts is missing — node tools/build-cloudbite-computer-costs.mjs'); }
  if (!cur.equals(Buffer.from(out, 'utf8'))) fail('src/cloudbite-computer-costs-page.ts does not match client sources — node tools/build-cloudbite-computer-costs.mjs');
  console.log('build-cloudbite-computer-costs: current');
} else {
  writeFileSync(OUT, out);
  console.log(`build-cloudbite-computer-costs: ${OUT} (${Buffer.byteLength(out)} B)`);
}
