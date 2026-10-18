// 격리된 Edge 에서 Monaco 0.57.0 + xterm 6.0.0 WebGL 을 실제로 그린 뒤,
// 그 페이지의 캡처 캔버스가 같은 글자를 담는지 본다. getDisplayMedia 는 0회여야 한다.
// 실행: node tools/build-lab-dom-capture.mjs && node test/lab-dom-capture-ui.mjs

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const vendorRoot = path.resolve(process.env.GW_LIVE_FIXTURE_MODULES ?? path.join(repo, '../.artifacts/gw-live-ui/node_modules'));
const proofDir = path.resolve(process.env.GW_DOM_PROOF_DIR ?? path.join(repo, '../.artifacts/gw-live-ui/auto-dom-proof'));
const monacoVs = path.join(vendorRoot, 'monaco-editor/min/vs');
const EDITOR_A = 'CAPTURE_EDITOR_ALPHA_7F3A';
const EDITOR_B = 'CAPTURE_EDITOR_ZULU_0000';
const TERM_A = 'CAPTURE_TERMINAL_BETA_9C2E';
const TERM_B = 'CAPTURE_TERMINAL_YANKEE_1111';
const SECRET = 'super-secret-password';

const build = spawnSync(process.execPath, ['tools/build-lab-dom-capture.mjs'], { cwd: repo, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout);
  console.error(build.stderr);
  process.exit(build.status || 1);
}

const generated = fs.readFileSync(path.join(repo, 'src/lab-dom-capture.generated.ts'), 'utf8');
function exportString(source, name) {
  const token = `export const ${name} = `;
  const at = source.indexOf(token);
  if (at < 0) throw new Error(`missing ${name}`);
  const start = at + token.length;
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '"') return JSON.parse(source.slice(start, i + 1));
    i += 1;
  }
  throw new Error(`unterminated ${name}`);
}
const preludeJs = exportString(generated, 'LAB_DOM_CAPTURE_PRELUDE_JS');
const captureJs = exportString(generated, 'LAB_DOM_CAPTURE_JS');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-dom-capture-'));
const appJs = buildSync({
  stdin: {
    contents: `
import { editor } from ${JSON.stringify(path.join(vendorRoot, 'monaco-editor/esm/vs/editor/editor.api.js'))};
import { Terminal } from ${JSON.stringify(path.join(vendorRoot, '@xterm/xterm/lib/xterm.mjs'))};
import { WebglAddon } from ${JSON.stringify(path.join(vendorRoot, '@xterm/addon-webgl/lib/addon-webgl.mjs'))};

const editorNode = document.getElementById('editor');
const termNode = document.getElementById('term');
const ed = editor.create(editorNode, {
  value: ${JSON.stringify(EDITOR_A + '\nsecond line stays\n')},
  language: 'plaintext',
  theme: 'vs',
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: 22,
  lineHeight: 30,
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  cursorBlinking: 'solid',
  scrollBeyondLastLine: false,
  scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
  renderLineHighlight: 'none',
  guides: { indentation: false },
  folding: false,
  lineNumbers: 'off',
  glyphMargin: false,
  wordWrap: 'off',
  automaticLayout: false,
  padding: { top: 12, bottom: 8 },
});
ed.layout();
const term = new Terminal({
  cols: 48,
  rows: 6,
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: 22,
  cursorBlink: false,
  disableStdin: true,
  scrollback: 0,
  theme: { background: '#1e1e1e', foreground: '#f8f8f2' },
});
term.open(termNode);
let webglError = '';
try {
  term.loadAddon(new WebglAddon());
} catch (error) {
  webglError = error && error.message ? String(error.message) : String(error);
}
term.write(${JSON.stringify(TERM_A + '\r\n')});

function canvasVariance(canvas) {
  const probe = document.createElement('canvas');
  probe.width = canvas.width;
  probe.height = canvas.height;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let n = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < data.length; i += 16) {
    const y = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += y; sum2 += y * y; n += 1;
  }
  const mean = sum / Math.max(1, n);
  return { variance: sum2 / Math.max(1, n) - mean * mean, mean, width: canvas.width, height: canvas.height };
}

window.__fixture = {
  webglError,
  setEditor(value) { ed.setValue(value); ed.layout(); },
  setTerm(value) { term.reset(); term.write(value); },
  layout() { ed.layout(); },
  editorDom() { return document.querySelector('.view-lines')?.innerText || ''; },
  webgl() {
    const canvases = [...document.querySelectorAll('#term canvas')].map((canvas) => {
      const gl = canvas.getContext('webgl2');
      if (gl) {
        const attrs = gl.getContextAttributes();
        return { kind: 'webgl2', preserve: !!(attrs && attrs.preserveDrawingBuffer), w: canvas.width, h: canvas.height };
      }
      return { kind: canvas.getContext('2d') ? '2d' : 'none', preserve: false, w: canvas.width, h: canvas.height };
    });
    const canvas = [...document.querySelectorAll('#term canvas')].find((node) => node.getContext('webgl2'));
    if (!canvas) return { error: webglError || 'no webgl canvas', canvases, prelude: HTMLCanvasElement.prototype.__labDomCapturePrelude === true };
    let pixels = null;
    let pixelError = '';
    try { pixels = canvasVariance(canvas); } catch (error) { pixelError = error && error.message ? String(error.message) : String(error); }
    const attrs = canvas.getContext('webgl2').getContextAttributes();
    return {
      error: webglError,
      pixelError,
      preserve: !!(attrs && attrs.preserveDrawingBuffer),
      pixels,
      canvases,
      prelude: HTMLCanvasElement.prototype.__labDomCapturePrelude === true,
    };
  },
  rects() {
    const lines = document.querySelector('.view-lines');
    const canvas = document.querySelector('#term canvas');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
    };
    return { editor: lines ? box(lines) : null, terminal: canvas ? box(canvas) : null };
  },
};
requestAnimationFrame(() => requestAnimationFrame(() => { window.__fixture.ready = true; }));
`,
    resolveDir: tmp,
    sourcefile: 'fixture-app.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
  loader: { '.css': 'empty', '.ttf': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty' },
});
if (appJs.warnings.length) {
  console.error(appJs.warnings);
  process.exit(1);
}
fs.writeFileSync(path.join(tmp, 'app.js'), appJs.outputFiles[0].contents);
fs.writeFileSync(path.join(tmp, 'prelude.js'), preludeJs);
fs.writeFileSync(path.join(tmp, 'capture.js'), captureJs);
fs.copyFileSync(path.join(vendorRoot, '@xterm/xterm/css/xterm.css'), path.join(tmp, 'xterm.css'));
fs.writeFileSync(path.join(tmp, 'worker.js'), 'self.onmessage = function () {};\n');
fs.writeFileSync(path.join(tmp, 'fixture.css'), [
  'html, body { margin: 0; height: 100%; background: #ffffff; overflow: hidden; color-scheme: light; }',
  '#layout { display: flex; flex-direction: column; height: 100%; }',
  '#editor { height: 58%; min-height: 0; }',
  '#term { height: 32%; min-height: 0; background: #1e1e1e; }',
  '#dock { height: 10%; display: flex; align-items: center; padding: 0 12px; background: #f3f3f3; }',
  '#secret { font: 16px Consolas, monospace; width: 280px; }',
].join('\n'));
fs.writeFileSync(path.join(tmp, 'boot.js'), `
window.__pickerCalls = 0;
window.__csp = [];
window.__passwordCopies = [];
window.__passwordMutations = [];
var valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
Object.defineProperty(HTMLInputElement.prototype, 'value', { ...valueProperty, set: function(value) {
  if (this.isConnected && this.type === 'password') window.__passwordMutations.push(value);
  valueProperty.set.call(this,value);
}});
window.__capErrors = [];
document.addEventListener('securitypolicyviolation', function (event) {
  window.__csp.push({ directive: event.violatedDirective, blocked: event.blockedURI, sample: event.sample || '' });
});
if (window.trustedTypes) {
  trustedTypes.createPolicy('default', {
    createHTML: function (value) { return value; },
    createScriptURL: function (value) { return value; },
    createScript: function (value) { return value; },
  });
  var policy = trustedTypes.createPolicy('fixture-worker', { createScriptURL: function (value) { return value; } });
  var NativeWorker = window.Worker;
  window.Worker = function (url, options) {
    var trusted = typeof url === 'string' ? policy.createScriptURL(url) : url;
    return new NativeWorker(trusted, options);
  };
  window.Worker.prototype = NativeWorker.prototype;
}
var media = navigator.mediaDevices;
if (media) {
  var originalPicker = media.getDisplayMedia ? media.getDisplayMedia.bind(media) : null;
  media.getDisplayMedia = function () {
    window.__pickerCalls += 1;
    return originalPicker ? originalPicker.apply(media, arguments) : Promise.reject(new Error('getDisplayMedia'));
  };
}
var originalSet = HTMLInputElement.prototype.setAttribute;
HTMLInputElement.prototype.setAttribute = function (name, value) {
  if (String(this.getAttribute('type')).toLowerCase() === 'password' && name === 'value') window.__passwordCopies.push(String(value));
  return originalSet.call(this, name, value);
};
window.MonacoEnvironment = { getWorker: function () { return new Worker('/worker.js'); } };
`);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function under(root, reqPath) {
  let decoded;
  try { decoded = decodeURIComponent(reqPath.split('?')[0]); } catch { return null; }
  const rel = decoded.replace(/^[/\\]+/, '');
  if (!rel || rel.includes('\0')) return null;
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  const fullKey = process.platform === 'win32' ? full.toLowerCase() : full;
  const baseKey = process.platform === 'win32' ? base.toLowerCase() : base;
  if (fullKey !== baseKey && !fullKey.startsWith(baseKey + path.sep)) return null;
  return full;
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function sendFile(res, file, extraHeaders) {
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
    res.end(body);
  });
}

const colorServer = await listen((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/c.css')) {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
    res.end('html,body{margin:0;background:#00ff40;}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'self'; base-uri 'none'" });
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/c.css"></head><body></body></html>');
});
const colorPort = colorServer.address().port;
const iframeSrc = `http://127.0.0.1:${colorPort}/color.html`;
fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lab dom capture proof</title>
<link rel="stylesheet" href="/monaco/editor/editor.main.css">
<link rel="stylesheet" href="/xterm.css">
<link rel="stylesheet" href="/fixture.css">
</head>
<body>
<!-- code-server keeps an image placeholder without src in the workbench. -->
<img id="empty-image" hidden><img id="empty-image-src" src="" hidden>
<div data-lab="screen" hidden><video></video></div>
<div id="layout">
  <div id="editor"></div>
  <div id="term"></div>
  <div id="dock"><input id="secret" type="password" value="${SECRET}" autocomplete="off"></div>
</div>
<script src="/boot.js"></script>
<script src="/prelude.js"></script>
<script src="/app.js"></script>
<script src="/capture.js"></script>
</body>
</html>
`);

const csp = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  `frame-src http://127.0.0.1:${colorPort}`,
  "trusted-types *",
  "require-trusted-types-for 'script'",
].join('; ');

const mainServer = await listen((req, res) => {
  const url = req.url || '/';
  const headers = { 'content-security-policy': csp };
  if (url === '/' || url.startsWith('/index.html')) {
    sendFile(res, path.join(tmp, 'index.html'), headers);
    return;
  }
  if (url.startsWith('/monaco/')) {
    const file = under(monacoVs, url.slice('/monaco/'.length));
    if (!file) { res.writeHead(400); res.end(); return; }
    sendFile(res, file, headers);
    return;
  }
  const file = under(tmp, url);
  if (!file) { res.writeHead(400); res.end(); return; }
  sendFile(res, file, headers);
});
const port = mainServer.address().port;
fs.mkdirSync(proofDir, { recursive: true });

function outputSize(viewportWidth, viewportHeight) {
  const scale = Math.min(1, 1920 / viewportWidth, 1200 / viewportHeight);
  return {
    width: Math.max(1, Math.round(viewportWidth * scale)),
    height: Math.max(1, Math.round(viewportHeight * scale)),
  };
}

const metrics = { gl: null, checks: [] };
const failures = [];
function expect(condition, message) {
  metrics.checks.push({ ok: !!condition, message });
  if (!condition) failures.push(message);
}

async function saveDataUrl(dataUrl, name) {
  const body = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  fs.writeFileSync(path.join(proofDir, name), body);
}

async function analyze(page, dataUrl, shot) {
  return page.evaluate(async ({ dataUrl, shot }) => {
    async function pixels(url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: canvas.width, h: canvas.height, d: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    function crop(image, rect) {
      const x0 = Math.max(0, rect.x);
      const y0 = Math.max(0, rect.y);
      const x1 = Math.min(image.w, rect.x + rect.w);
      const y1 = Math.min(image.h, rect.y + rect.h);
      let n = 0, sum = 0, sum2 = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * image.w + x) * 4;
          const v = (image.d[i] + image.d[i + 1] + image.d[i + 2]) / 3;
          sum += v; sum2 += v * v; n += 1;
        }
      }
      const mean = n ? sum / n : 0;
      return { n, mean, variance: n ? sum2 / n - mean * mean : 0 };
    }
    function mae(a, b, rect) {
      const x0 = Math.max(0, rect.x);
      const y0 = Math.max(0, rect.y);
      const x1 = Math.min(a.w, b.w, rect.x + rect.w);
      const y1 = Math.min(a.h, b.h, rect.y + rect.h);
      let n = 0, acc = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const ia = (y * a.w + x) * 4;
          const ib = (y * b.w + x) * 4;
          acc += Math.abs(a.d[ia] - b.d[ib]) + Math.abs(a.d[ia + 1] - b.d[ib + 1]) + Math.abs(a.d[ia + 2] - b.d[ib + 2]);
          n += 1;
        }
      }
      return n ? acc / (n * 3) : 999;
    }
    function count(image, r, g, b) {
      let n = 0;
      for (let i = 0; i < image.d.length; i += 4) {
        if (image.d[i] === r && image.d[i + 1] === g && image.d[i + 2] === b && image.d[i + 3] > 200) n += 1;
      }
      return n;
    }
    const capture = await pixels(dataUrl);
    const pageShot = shot ? await pixels(shot) : null;
    const rects = window.__fixture.rects();
    return {
      capture: { w: capture.w, h: capture.h },
      shot: pageShot ? { w: pageShot.w, h: pageShot.h } : null,
      rects,
      editor: rects.editor ? { capture: crop(capture, rects.editor), shot: pageShot ? crop(pageShot, rects.editor) : null, mae: pageShot ? mae(capture, pageShot, rects.editor) : null } : null,
      terminal: rects.terminal ? { capture: crop(capture, rects.terminal), shot: pageShot ? crop(pageShot, rects.terminal) : null, mae: pageShot ? mae(capture, pageShot, rects.terminal) : null } : null,
      colors: {
        capture: { pink: count(capture, 255, 0, 128), green: count(capture, 0, 255, 64), blue: count(capture, 0, 128, 255) },
        shot: pageShot ? { pink: count(pageShot, 255, 0, 128), green: count(pageShot, 0, 255, 64), blue: count(pageShot, 0, 128, 255) } : null,
      },
    };
  }, { dataUrl, shot });
}

let browser;
try {
  const attempts = [
    { name: 'default', args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] },
    { name: 'swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] },
  ];
  let page;
  let glName = '';
  for (const attempt of attempts) {
    if (browser) await browser.close();
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: attempt.args });
    const context = await browser.newContext({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1, colorScheme: 'light' });
    page = await context.newPage();
    page.setDefaultTimeout(120000);
    const logs = [];
    page.on('pageerror', (error) => logs.push(String(error)));
    page.on('console', (msg) => { if (msg.type() === 'error') logs.push(msg.text()); });
    page.on('response', (res) => { if (res.status() >= 400) logs.push(`${res.status()} ${res.url()}`); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__fixture && window.__fixture.ready, { timeout: 30000 });
    await page.waitForTimeout(400);
    const webgl = await page.evaluate(() => window.__fixture.webgl());
    const editorDom = await page.evaluate(() => window.__fixture.editorDom());
    metrics.gl = { attempt: attempt.name, webgl, editorDom, logs };
    glName = attempt.name;
    if (webgl.preserve && webgl.pixels && webgl.pixels.variance > 40 && editorDom.includes(EDITOR_A)) break;
    if (attempt.name === 'swiftshader') break;
  }
  metrics.glName = glName;
  const webgl = metrics.gl.webgl;
  const editorDom = metrics.gl.editorDom;
  expect(editorDom.includes(EDITOR_A), `monaco DOM text missing: ${JSON.stringify(editorDom).slice(0, 200)}`);
  expect(!webgl.error, `xterm WebGL addon failed: ${webgl.error}`);
  expect(webgl.preserve === true, `WebGL preserveDrawingBuffer is not true: ${JSON.stringify(webgl)}`);
  expect(webgl.pixels && webgl.pixels.variance > 40, `WebGL canvas has no readable pixels: ${JSON.stringify(webgl)}`);
  if (failures.length) throw new Error(failures.join('\n'));

  const opened = await page.evaluate(async () => {
    window.__capErrors = [];
    window.__cap = await window.__labDomCapture.open({
      onError(error) { window.__capErrors.push(error instanceof Error ? error.message : String(error)); },
    });
    const track = window.__cap.stream.getVideoTracks()[0];
    const canvas = window.__cap.snapshot();
    return {
      url: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      inDom: document.documentElement.contains(canvas),
      kind: track.kind,
      state: track.readyState,
      surface: track.getSettings().displaySurface || '',
      picker: window.__pickerCalls,
      errors: window.__capErrors.slice(),
      secret: document.getElementById('secret').value,
      copies: window.__passwordCopies.slice(),
      mutations: window.__passwordMutations.slice(),
      csp: window.__csp.slice(),
    };
  });
  await saveDataUrl(opened.url, 'capture-original.png');
  const shot = await page.screenshot({ path: path.join(proofDir, 'page-original.png'), type: 'png' });
  const shotUrl = `data:image/png;base64,${shot.toString('base64')}`;
  const original = await analyze(page, opened.url, shotUrl);
  metrics.original = { opened: { ...opened, url: undefined, copies: opened.copies.map((value) => value.length) }, original };
  const fit = outputSize(1024, 640);
  expect(opened.width === fit.width && opened.height === fit.height, `capture size ${opened.width}x${opened.height} != ${fit.width}x${fit.height}`);
  expect(opened.inDom === false, 'capture canvas is attached to the document');
  expect(opened.kind === 'video' && opened.state === 'live', `unexpected track ${opened.kind}/${opened.state}`);
  expect(opened.surface === '', `displaySurface set (${opened.surface}), capture picker path suspected`);
  expect(opened.picker === 0, `getDisplayMedia calls: ${opened.picker}`);
  expect(opened.errors.length === 0, `errors during first frame: ${opened.errors.join(' | ')}`);
  expect(opened.secret === SECRET, 'password value was not restored');
  expect(opened.mutations.length === 0, 'capture mutated the live password field');
  expect(opened.copies.length > 0 && opened.copies.every((value) => value === '\u2022'.repeat(SECRET.length)), `password leaked into clone: ${opened.copies.join(',')}`);
  expect(opened.csp.length === 0, `CSP violations: ${JSON.stringify(opened.csp)}`);
  expect(original.editor && original.editor.capture.variance > 40 && original.editor.capture.mean > 160, `editor crop is not readable text: ${JSON.stringify(original.editor)}`);
  expect(original.terminal && original.terminal.capture.variance > 40 && original.terminal.capture.mean < 90, `terminal crop is not the WebGL frame: ${JSON.stringify(original.terminal)}`);
  expect(original.editor && original.editor.mae < 55, `editor capture does not match the page (mae ${original.editor && original.editor.mae})`);
  expect(original.terminal && original.terminal.mae < 40, `terminal capture does not match the page (mae ${original.terminal && original.terminal.mae})`);
  if (failures.length) throw new Error(failures.join('\n'));

  await page.evaluate((src) => {
    const bar = document.createElement('div');
    bar.setAttribute('data-live-support', '1');
    bar.style.position = 'fixed';
    bar.style.left = '0';
    bar.style.top = '0';
    bar.style.width = '100%';
    bar.style.height = '36px';
    bar.style.background = '#ff0080';
    bar.style.zIndex = '20';
    document.body.appendChild(bar);
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = '0';
    box.style.top = '40px';
    box.style.width = '72px';
    box.style.height = '72px';
    box.style.background = '#0080ff';
    box.style.zIndex = '20';
    document.body.appendChild(box);
    window.__labBarUI = { box };
    const frame = document.createElement('iframe');
    frame.id = 'other';
    frame.src = src;
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '64px';
    frame.style.height = '64px';
    frame.style.border = '0';
    frame.style.zIndex = '20';
    document.body.appendChild(frame);
    return new Promise((resolve) => frame.addEventListener('load', () => resolve(true), { once: true }));
  }, iframeSrc);
  await page.evaluate(() => window.__cap.stop());
  const overlayOpen = await page.evaluate(async () => {
    window.__cap = await window.__labDomCapture.open({
      onError(error) { window.__capErrors.push(error instanceof Error ? error.message : String(error)); },
    });
    return window.__cap.snapshot().toDataURL('image/png');
  });
  await saveDataUrl(overlayOpen, 'capture-overlay.png');
  const overlayShot = await page.screenshot({ path: path.join(proofDir, 'page-overlay.png'), type: 'png' });
  const overlay = await analyze(page, overlayOpen, `data:image/png;base64,${overlayShot.toString('base64')}`);
  metrics.overlay = overlay;
  expect(overlay.colors.shot.pink > 200 && overlay.colors.shot.green > 200 && overlay.colors.shot.blue > 200, `page did not show injected overlays: ${JSON.stringify(overlay.colors.shot)}`);
  expect(overlay.colors.capture.pink === 0 && overlay.colors.capture.green === 0 && overlay.colors.capture.blue === 0, `capture included overlays: ${JSON.stringify(overlay.colors.capture)}`);

  await page.evaluate(() => {
    document.querySelector('[data-live-support]')?.remove();
    window.__labBarUI.box.remove();
    window.__labBarUI = { box: null };
    document.getElementById('other')?.remove();
    window.__fixture.setEditor('CAPTURE_EDITOR_ZULU_0000\nsecond line stays\n');
    window.__fixture.setTerm('CAPTURE_TERMINAL_YANKEE_1111\r\n');
  });
  await page.waitForTimeout(250);
  const changeStarted = Date.now();
  await page.waitForFunction(before => window.__cap.snapshot().toDataURL('image/png') !== before, overlayOpen, {timeout:15000});
  const changed = await page.evaluate(() => window.__cap.snapshot().toDataURL('image/png'));
  const changedMae = await page.evaluate(async ({ before, after }) => {
    async function pixels(url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: canvas.width, h: canvas.height, d: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    function mae(a, b, rect) {
      let n = 0, acc = 0;
      const x1 = Math.min(a.w, b.w, rect.x + rect.w);
      const y1 = Math.min(a.h, b.h, rect.y + rect.h);
      for (let y = rect.y; y < y1; y += 1) {
        for (let x = rect.x; x < x1; x += 1) {
          const ia = (y * a.w + x) * 4;
          const ib = (y * b.w + x) * 4;
          acc += Math.abs(a.d[ia] - b.d[ib]) + Math.abs(a.d[ia + 1] - b.d[ib + 1]) + Math.abs(a.d[ia + 2] - b.d[ib + 2]);
          n += 1;
        }
      }
      return n ? acc / (n * 3) : 0;
    }
    const a = await pixels(before);
    const b = await pixels(after);
    const rects = window.__fixture.rects();
    return { editor: mae(a, b, rects.editor), terminal: mae(a, b, rects.terminal), editorDom: window.__fixture.editorDom() };
  }, { before: overlayOpen, after: changed });
  await saveDataUrl(changed, 'capture-changed.png');
  metrics.changed = { changedMae, ms: Date.now() - changeStarted };
  expect(changedMae.editorDom.includes('ZULU_0000'), `editor DOM did not update: ${changedMae.editorDom}`);
  expect(changedMae.editor > 0.2, `editor text change did not change captured pixels (mae ${changedMae.editor})`);
  expect(changedMae.terminal > 0.8, `terminal text change did not change captured pixels (mae ${changedMae.terminal})`);

  await page.setViewportSize({ width: 1400, height: 900 });
  expect(await page.evaluate(() => !window.__cap.isCurrent()), 'resize must block control until a matching frame exists');
  await page.evaluate(() => window.__fixture.layout());
  const resized = outputSize(1400, 900);
  await page.waitForFunction(() => window.__cap.isCurrent(), null, {timeout:15000});
  const resizedSize = await page.evaluate(() => {
    const canvas = window.__cap.snapshot();
    return { width: canvas.width, height: canvas.height, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  });
  metrics.resized = resizedSize;
  expect(resizedSize.width === resized.width && resizedSize.height === resized.height, `resize capture ${JSON.stringify(resizedSize)} != ${JSON.stringify(resized)}`);
  expect(resizedSize.width === 1400 && resizedSize.height === 900, 'desktop text was unnecessarily downscaled below native viewport pixels');

  // Measure changed pixels, not a timer or a claimed frame count.
  metrics.latency = await page.evaluate(async () => {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;left:40px;top:40px;width:80px;height:80px;z-index:19';
    document.body.append(marker);
    const samples = [];
    try {
      for (let i = 0; i < 5; i++) {
        const color = i % 2 ? [32, 208, 80] : [224, 48, 96];
        marker.style.backgroundColor = 'rgb(' + color.join(',') + ')';
        const start = performance.now();
        for (;;) {
          const frame = window.__cap.snapshot();
          const ctx = frame.getContext('2d');
          const x = Math.round(70 * frame.width / innerWidth), y = Math.round(70 * frame.height / innerHeight);
          const px = ctx.getImageData(x, y, 1, 1).data;
          if (color.every((v, k) => Math.abs(px[k] - v) < 3)) break;
          if (performance.now() - start > 12000) throw Error('changed pixels did not arrive');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        samples.push(Math.round(performance.now() - start));
      }
    } finally { marker.remove(); }
    const sorted = [...samples].sort((a, b) => a - b);
    return { samplesMs: samples, medianMs: sorted[2], maxMs: sorted[4] };
  });
  console.log('LATENCY ' + JSON.stringify(metrics.latency));
  if (process.env.GW_DOM_PERF_BASELINE !== '1') expect(metrics.latency.maxMs < 2000, 'changed pixels took over 2 seconds in the local capture fixture');

  await page.setViewportSize({ width: 2560, height: 1600 });
  await page.evaluate(() => window.__fixture.layout());
  await page.waitForFunction(() => window.__cap.isCurrent(), null, {timeout:15000});
  const bounded = await page.evaluate(() => ({width:window.__cap.snapshot().width,height:window.__cap.snapshot().height}));
  metrics.bounded = bounded;
  expect(bounded.width === 1920 && bounded.height === 1200, 'large displays must keep the 1920x1200 pixel budget');

  const frozen = await page.evaluate(async () => {
    window.__cap.stop();
    window.__cap = await window.__labDomCapture.open({ onError() {} });
    return window.__cap.snapshot().toDataURL('image/png');
  });
  const stopped = await page.evaluate(() => {
    window.__cap.stop();
    window.__cap.stop();
    return window.__cap.stream.getTracks().map((track) => track.readyState);
  });
  await page.evaluate(() => window.__fixture.setEditor('SHOULD_NOT_APPEAR_AFTER_STOP\n'));
  await page.waitForTimeout(8000);
  const afterStop = await page.evaluate(() => window.__cap.snapshot().toDataURL('image/png'));
  metrics.stopped = { stopped, frozen: frozen === afterStop };
  expect(stopped.length === 1 && stopped[0] === 'ended', `tracks not stopped: ${stopped.join(',')}`);
  expect(frozen === afterStop, 'snapshot changed after stop()');

  const tainted = await page.evaluate(async () => {
    const bad = document.createElement('canvas');
    bad.width = 12;
    bad.height = 12;
    document.body.appendChild(bad);
    bad.toDataURL = () => { throw new DOMException('tainted canvas', 'SecurityError'); };
    window.__capErrors = [];
    try {
      await window.__labDomCapture.open({
        onError(error) { window.__capErrors.push(error instanceof Error ? `${error.name}:${error.message}` : String(error)); },
      });
      return { rejected: false, errors: window.__capErrors, picker: window.__pickerCalls };
    } catch (error) {
      return {
        rejected: true,
        message: error instanceof Error ? `${error.name}:${error.message}` : String(error),
        errors: window.__capErrors,
        picker: window.__pickerCalls,
      };
    }
  });
  metrics.tainted = tainted;
  expect(tainted.rejected === true, `tainted canvas was treated as success: ${JSON.stringify(tainted)}`);
  expect(/SecurityError|tainted/.test(`${tainted.message} ${tainted.errors.join(' ')}`), `tainted error was replaced: ${JSON.stringify(tainted)}`);
  expect(tainted.picker === 0, `getDisplayMedia calls after errors: ${tainted.picker}`);
  const retinaContext = await browser.newContext({ viewport:{width:1280,height:800},deviceScaleFactor:2 });
  try {
    const retina = await retinaContext.newPage();
    await retina.goto(`http://127.0.0.1:${port}/`);
    await retina.waitForFunction(() => window.__fixture?.ready);
    metrics.retina = await retina.evaluate(async () => {
      const capture = await window.__labDomCapture.open();
      const result = {width:capture.snapshot().width,height:capture.snapshot().height,picker:window.__pickerCalls};
      capture.stop(); return result;
    });
    expect(metrics.retina.width === 1920 && metrics.retina.height === 1200 && metrics.retina.picker === 0, 'retina text must retain detail within the pixel budget, without a display picker');
  } finally { await retinaContext.close(); }
  await page.screenshot({ path: path.join(proofDir, 'page-changed.png'), type: 'png' });
} finally {
  fs.writeFileSync(path.join(proofDir, 'metrics.json'), JSON.stringify({ failures, metrics }, null, 2));
  if (browser) await browser.close();
  mainServer.close();
  colorServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`lab-dom-capture-ui: ok (${metrics.glName})`);
console.log(path.join(proofDir, 'metrics.json'));
