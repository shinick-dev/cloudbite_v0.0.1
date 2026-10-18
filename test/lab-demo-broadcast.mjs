// 시연실 .class-demo 루트만 1920×1080·최대 15fps MediaStream 으로 떠는지 본다.
// getDisplayMedia·문서 전체 캡처는 0회여야 한다.
// 실행: node tools/build-lab-demo-broadcast.mjs && node test/lab-demo-broadcast.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const proofDir = path.resolve(process.env.GW_DEMO_BROADCAST_PROOF_DIR ?? path.join(repo, '../.artifacts/classroom-unified-workspace-20261016/demo-broadcast-proof'));
const ROOM = 'room-a';
const DRAFT_A = 'DRAFT_ALPHA_7F3A';
const DRAFT_B = 'DRAFT_ZULU_0000';
const TERM_A = 'TERM_ALPHA_9C2E';
const TERM_B = 'TERM_YANKEE_1111';
const SECRET = 'super-secret-password';
const HOSTILE = `${DRAFT_B} <img src=x onerror=alert(1)> data:text/html,alert-not-script`;

const build = spawnSync(process.execPath, ['tools/build-lab-demo-broadcast.mjs'], { cwd: repo, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout);
  console.error(build.stderr);
  process.exit(build.status || 1);
}
const generated = fs.readFileSync(path.join(repo, 'src/lab-demo-broadcast.generated.ts'), 'utf8');
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
const broadcastJs = exportString(generated, 'LAB_DEMO_BROADCAST_JS');
if (broadcastJs.includes('getDisplayMedia') || /\binnerHTML\b/.test(broadcastJs)) {
  console.error('generated bundle contains a forbidden call');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-demo-broadcast-'));
fs.writeFileSync(path.join(tmp, 'broadcast.js'), broadcastJs);
fs.writeFileSync(path.join(tmp, 'boot.js'), `
window.__pickerCalls = 0;
window.__fetches = [];
window.__passwordCopies = [];
window.__passwordMutations = [];
window.__xml = '';
window.__fps = null;
window.__canvas = null;
window.__errors = [];
var valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
Object.defineProperty(HTMLInputElement.prototype, 'value', { ...valueProperty, set: function(value) {
  if (this.isConnected && this.type === 'password') window.__passwordMutations.push(String(value));
  return valueProperty.set.call(this, value);
}});
var originalSet = HTMLInputElement.prototype.setAttribute;
HTMLInputElement.prototype.setAttribute = function(name, value) {
  if (String(this.getAttribute('type')).toLowerCase() === 'password' && name === 'value') window.__passwordCopies.push(String(value));
  return originalSet.call(this, name, value);
};
var media = navigator.mediaDevices;
if (media && media.getDisplayMedia) {
  var originalPicker = media.getDisplayMedia.bind(media);
  media.getDisplayMedia = function() {
    window.__pickerCalls += 1;
    return originalPicker.apply(media, arguments);
  };
}
var originalFetch = window.fetch;
window.fetch = function(url) {
  window.__fetches.push(String(url));
  return originalFetch.apply(this, arguments);
};
var originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) {
  window.__fetches.push(String(url));
  return originalOpen.apply(this, arguments);
};
var originalSerialize = XMLSerializer.prototype.serializeToString;
XMLSerializer.prototype.serializeToString = function(node) {
  var xml = originalSerialize.call(this, node);
  window.__xml = xml;
  return xml;
};
var originalCapture = HTMLCanvasElement.prototype.captureStream;
HTMLCanvasElement.prototype.captureStream = function(fps) {
  window.__fps = fps;
  window.__canvas = this;
  return originalCapture.call(this, fps);
};
`);
fs.writeFileSync(path.join(tmp, 'fixture.css'), `
html, body { margin: 0; background: #202020; }
#supportSentinel { position: fixed; left: 12px; top: 12px; width: 180px; height: 48px; background: #ff00aa; z-index: 50; color: #ff00aa; }
#adminSentinel { position: fixed; right: 12px; top: 12px; width: 180px; height: 48px; background: #00ffcc; z-index: 50; color: #00ffcc; }
.class-demo { width: 800px; height: 300px; display: block; box-sizing: border-box; padding: 12px; background-color: #fffdf8; background-image: url('/leak-capture.png'); color: #172033; font: 20px/1.4 Consolas, "Courier New", monospace; }
.class-demo::after { content: "safe"; background-image: url('/leak-pseudo.png'); }
#draft, #scrolled { display: block; width: 360px; height: 48px; margin: 8px 0 0; padding: 0; border: 0; resize: none; background: #ffffff; color: #101010; font: 24px/24px Consolas, monospace; }
#term { margin: 8px 0 0; height: 48px; overflow: auto; background: #18212f; color: #dbe6f5; white-space: pre; }
#privateBox { background: #ff8800; color: #ff8800; width: 64px; height: 24px; }
#adminBox { background: #8800ff; color: #8800ff; width: 64px; height: 24px; }
#nestedDemo { background: #0088ff; color: #0088ff; width: 80px; height: 24px; }
#inlineLeak { width: 24px; height: 24px; background-color: #fffdf8; background-image: url('/leak-inline.png'); }
`);
fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>lab demo broadcast proof</title>
<link rel="stylesheet" href="/fixture.css">
</head>
<body>
<div id="supportSentinel">SUPPORT_SENTINEL_OUTSIDE</div>
<div id="adminSentinel" data-lab-admin>ADMIN_SENTINEL_OUTSIDE</div>
<section id="demo" class="class-demo" data-demo-room="${ROOM}">
  <h2>독립 시연실</h2>
  <!-- COMMENT_SENTINEL_SECRET -->
  <textarea id="draft"></textarea>
  <pre id="term"></pre>
  <textarea id="scrolled"></textarea>
  <div id="privateBox" data-demo-private>PRIVATE_SENTINEL_INSIDE</div>
  <div id="adminBox" data-lab-admin>ADMIN_SENTINEL_INSIDE</div>
  <div id="nestedDemo" class="class-demo" data-demo-room="room-b">NESTED_ROOM_SENTINEL</div>
  <div id="inlineLeak"></div>
  <input id="secret" type="password" value="${SECRET}" autocomplete="off">
  <button type="button" onclick="window.__ran=1">보내기</button>
  <iframe title="IFRAME_SENTINEL" style="width:40px;height:40px;border:0;background:#123456"></iframe>
  <img alt="IMG_SENTINEL" width="40" height="40" style="background:#a11ee0">
  <canvas id="paint" width="40" height="40"></canvas>
</section>
<script src="/boot.js"></script>
<script src="/broadcast.js"></script>
<script>
document.getElementById('draft').value = ${JSON.stringify(DRAFT_A)};
document.getElementById('term').textContent = ${JSON.stringify(TERM_A)};
var scrolled = document.getElementById('scrolled');
scrolled.value = '\\n'.repeat(14) + 'MMMMMMMMMMMMMMMMMMMM';
scrolled.scrollTop = scrolled.scrollHeight;
var paint = document.getElementById('paint');
paint.getContext('2d').fillStyle = '#e02020';
paint.getContext('2d').fillRect(0, 0, 40, 40);
window.__state = { room: ${JSON.stringify(ROOM)}, authorized: true, root: document.getElementById('demo') };
window.__factory = window.createLabDemoBroadcast({
  root: function() { return window.__state.root; },
  selected: function() { return window.__state.room; },
  authorized: function() { return window.__state.authorized; },
  onError: function(error) { window.__errors.push(error instanceof Error ? error.message : String(error)); },
});
</script>
</body>
</html>
`);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
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
const server = http.createServer((req, res) => {
  const file = under(tmp, !req.url || req.url==='/' ? '/index.html' : req.url);
  if (!file) { res.writeHead(400); res.end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
fs.mkdirSync(proofDir, { recursive: true });

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

async function sample(page) {
  return page.evaluate(() => {
    const canvas = window.__canvas;
    if (!canvas) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    const count = (r, g, b) => {
      let n = 0;
      for (let i = 0; i < data.length; i += 16) {
        if (Math.abs(data[i] - r) < 8 && Math.abs(data[i + 1] - g) < 8 && Math.abs(data[i + 2] - b) < 8 && data[i + 3] > 200) n += 1;
      }
      return n;
    };
    for (let i = 0; i < data.length; i += 16) sum += data[i] + data[i + 1] + data[i + 2] + data[i + 3];
    const root = document.getElementById('demo');
    const target = document.getElementById('scrolled');
    let scrollMean = null;
    let bar = 0;
    if (root && target && root.offsetWidth > 0 && root.offsetHeight > 0) {
      const rb = root.getBoundingClientRect();
      const eb = target.getBoundingClientRect();
      const scale = Math.min(1920 / root.offsetWidth, 1080 / root.offsetHeight);
      const dw = Math.round(root.offsetWidth * scale);
      const dh = Math.round(root.offsetHeight * scale);
      const dx = Math.round((1920 - dw) / 2);
      const dy = Math.round((1080 - dh) / 2);
      bar = dy;
      const x0 = Math.max(0, Math.round(dx + (eb.left - rb.left) * scale) + 4);
      const y0 = Math.max(0, Math.round(dy + (eb.top - rb.top) * scale) + 4);
      const x1 = Math.min(canvas.width, x0 + Math.max(1, Math.round(eb.width * scale) - 8));
      const y1 = Math.min(canvas.height, y0 + Math.max(1, Math.round(eb.height * scale) - 8));
      let n = 0;
      let tone = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * canvas.width + x) * 4;
          tone += (data[i] + data[i + 1] + data[i + 2]) / 3;
          n += 1;
        }
      }
      scrollMean = n ? tone / n : null;
    }
    const corner = (px, py) => {
      const i = (py * canvas.width + px) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    return {
      sum,
      width: canvas.width,
      height: canvas.height,
      inDom: document.documentElement.contains(canvas),
      pink: count(255, 0, 170),
      mint: count(0, 255, 204),
      orange: count(255, 136, 0),
      purple: count(136, 0, 255),
      blue: count(0, 136, 255),
      red: count(224, 32, 32),
      img: count(161, 30, 224),
      iframe: count(18, 52, 86),
      green: count(20, 122, 50),
      paper: count(255, 253, 248),
      scrollMean,
      corner: corner(8, 8),
      center: corner(960, 540),
      bar,
    };
  });
}

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const logs = [];
  page.on('pageerror', (error) => logs.push(String(error)));
  page.on('console', (msg) => { if (msg.type() === 'error') logs.push(msg.text()); });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__factory && window.__state);

  const rejected = await page.evaluate(async () => {
    window.__errors = [];
    const saved = window.__state.authorized;
    window.__state.authorized = false;
    try {
      await window.__factory.open('room-a');
      return { rejected: false, errors: window.__errors.slice() };
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error), errors: window.__errors.slice(), tracks: window.__canvas ? 'canvas' : '' };
    } finally {
      window.__state.authorized = saved;
    }
  });
  expect(rejected.rejected === true, `unauthorized open resolved: ${JSON.stringify(rejected)}`);
  expect(rejected.errors.length === 1, `unauthorized open errors: ${JSON.stringify(rejected.errors)}`);

  const wrongRoom = await page.evaluate(async () => {
    window.__errors = [];
    try {
      await window.__factory.open('room-b');
      return { rejected: false };
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error), errors: window.__errors.slice() };
    }
  });
  expect(wrongRoom.rejected === true && wrongRoom.errors.length === 1, `wrong room open did not reject cleanly: ${JSON.stringify(wrongRoom)}`);

  const opened = await page.evaluate(async () => {
    window.__errors = [];
    window.__fetches = [];
    window.__cap = await window.__factory.open('room-a');
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:-4000px;width:320px;height:180px';
    document.body.appendChild(video);
    video.srcObject = window.__cap.stream;
    await video.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video frame timeout')), 8000);
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(true); });
      else video.onloadeddata = () => { clearTimeout(timer); resolve(true); };
    });
    const track = window.__cap.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    return {
      frames: window.__cap.stats().frames,
      stats: window.__cap.stats(),
      current: window.__cap.isCurrent(),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      kind: track.kind,
      state: track.readyState,
      settings,
      fps: window.__fps,
      picker: window.__pickerCalls,
      errors: window.__errors.slice(),
      secret: document.getElementById('secret').value,
      copies: window.__passwordCopies.slice(),
      mutations: window.__passwordMutations.slice(),
      draft: document.getElementById('draft').value,
      scrollTop: document.getElementById('scrolled').scrollTop,
      fetches: window.__fetches.slice(),
      ran: window.__ran === 1,
      inXml: {
        draft: window.__xml.includes('DRAFT_ALPHA_7F3A'),
        term: window.__xml.includes('TERM_ALPHA_9C2E'),
        support: window.__xml.includes('SUPPORT_SENTINEL_OUTSIDE'),
        adminOut: window.__xml.includes('ADMIN_SENTINEL_OUTSIDE'),
        adminIn: window.__xml.includes('ADMIN_SENTINEL_INSIDE'),
        priv: window.__xml.includes('PRIVATE_SENTINEL_INSIDE'),
        nested: window.__xml.includes('NESTED_ROOM_SENTINEL'),
        comment: window.__xml.includes('COMMENT_SENTINEL_SECRET'),
        secret: window.__xml.includes('super-secret-password'),
        leak: window.__xml.includes('leak-capture') || window.__xml.includes('leak-pseudo') || window.__xml.includes('leak-inline'),
        onclick: window.__xml.includes('onclick'),
        rawImg: window.__xml.includes('<img'),
        rawScript: window.__xml.includes('<script'),
      },
    };
  });
  const first = await sample(page);
  fs.writeFileSync(path.join(proofDir, 'open.json'), JSON.stringify({ opened: { ...opened, fetches: opened.fetches.length }, first, logs }, null, 2));
  expect(opened.frames >= 1 && opened.current === true, `first frame was not current: ${JSON.stringify(opened.stats)} current=${opened.current}`);
  expect(opened.stats.width === 1920 && opened.stats.height === 1080, `stats size ${opened.stats.width}x${opened.stats.height}`);
  expect(opened.kind === 'video' && opened.state === 'live', `track ${opened.kind}/${opened.state}`);
  expect(opened.videoWidth === 1920 && opened.videoHeight === 1080, `video ${opened.videoWidth}x${opened.videoHeight}`);
  expect(opened.fps === 15, `captureStream fps ${opened.fps}`);
  expect(!opened.settings.frameRate || opened.settings.frameRate <= 15, `track frameRate ${opened.settings.frameRate}`);
  expect(!opened.settings.width || opened.settings.width === 1920, `track width ${opened.settings.width}`);
  expect(!opened.settings.height || opened.settings.height === 1080, `track height ${opened.settings.height}`);
  expect(first && first.width === 1920 && first.height === 1080 && first.inDom === false, `output canvas ${JSON.stringify(first && { width: first.width, height: first.height, inDom: first.inDom })}`);
  expect(opened.picker === 0 && opened.errors.length === 0, `picker ${opened.picker} errors ${opened.errors.join(' | ')}`);
  expect(opened.secret === SECRET && opened.draft === DRAFT_A && opened.mutations.length === 0, 'capture mutated the live fields');
  expect(opened.copies.length === 0 || opened.copies.every((value) => value === '\u2022'.repeat(SECRET.length)), `password leaked: ${opened.copies.join(',')}`);
  expect(opened.fetches.every((url) => !url.includes('leak-')), `capture fetched ${opened.fetches.join(',')}`);
  expect(opened.inXml.draft && opened.inXml.term, `workspace text missing from clone: ${JSON.stringify(opened.inXml)}`);
  expect(!opened.inXml.support && !opened.inXml.adminOut && !opened.inXml.adminIn && !opened.inXml.priv && !opened.inXml.nested && !opened.inXml.comment && !opened.inXml.secret, `sentinel text entered the clone: ${JSON.stringify(opened.inXml)}`);
  expect(!opened.inXml.leak && !opened.inXml.onclick && !opened.inXml.rawImg && !opened.inXml.rawScript && opened.ran === false, `unsafe clone content: ${JSON.stringify(opened.inXml)} ran=${opened.ran}`);
  expect(first && first.pink === 0 && first.mint === 0 && first.orange === 0 && first.purple === 0 && first.blue === 0 && first.red === 0 && first.img === 0 && first.iframe === 0, `capture included excluded pixels: ${JSON.stringify(first)}`);
  expect(first && first.paper > 20 && first.corner[0] === 0 && first.corner[1] === 0 && first.corner[2] === 0 && first.bar > 40, `letterbox or root background missing: ${JSON.stringify(first && { paper: first.paper, corner: first.corner, bar: first.bar, center: first.center })}`);
  expect(opened.scrollTop > 40, `scrolled textarea was not actually scrolled (${opened.scrollTop})`);
  const scrolledMean = first ? first.scrollMean : 0;

  const pace = await page.evaluate(async () => {
    const before = window.__cap.stats().frames;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { before, after: window.__cap.stats().frames, current: window.__cap.isCurrent() };
  });
  expect(pace.after > pace.before && pace.after - pace.before <= 16 && pace.current === true, `frame pace ${JSON.stringify(pace)}`);

  await page.evaluate((value) => { document.getElementById('draft').value = value; }, HOSTILE);
  await page.waitForFunction((marker) => window.__xml.includes(marker), DRAFT_B);
  const edited = await page.evaluate(() => ({
    xml: window.__xml.includes('DRAFT_ZULU_0000') && !window.__xml.includes('<img') && !window.__xml.includes('<script'),
    value: document.getElementById('draft').value,
    frames: window.__cap.stats().frames,
  }));
  const editedSample = await sample(page);
  expect(edited.xml && edited.value === HOSTILE && editedSample && editedSample.sum !== first.sum, `textarea edit did not change the frame: ${JSON.stringify(edited)}`);

  await page.evaluate((value) => { document.getElementById('term').textContent = value; }, TERM_B);
  await page.waitForFunction((marker) => window.__xml.includes(marker), TERM_B);
  expect(await page.evaluate(() => window.__cap.isCurrent()), 'terminal update dropped the current root');

  await page.evaluate(() => { document.getElementById('scrolled').scrollTop = 0; });
  await page.waitForFunction((before) => {
    const canvas = window.__canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const root = document.getElementById('demo');
    const target = document.getElementById('scrolled');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const rb = root.getBoundingClientRect();
    const eb = target.getBoundingClientRect();
    const scale = Math.min(1920 / root.offsetWidth, 1080 / root.offsetHeight);
    const dw = Math.round(root.offsetWidth * scale);
    const dh = Math.round(root.offsetHeight * scale);
    const dx = Math.round((1920 - dw) / 2);
    const dy = Math.round((1080 - dh) / 2);
    const x0 = Math.max(0, Math.round(dx + (eb.left - rb.left) * scale) + 4);
    const y0 = Math.max(0, Math.round(dy + (eb.top - rb.top) * scale) + 4);
    const x1 = Math.min(canvas.width, x0 + Math.max(1, Math.round(eb.width * scale) - 8));
    const y1 = Math.min(canvas.height, y0 + Math.max(1, Math.round(eb.height * scale) - 8));
    let n = 0;
    let tone = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * canvas.width + x) * 4;
        tone += (data[i] + data[i + 1] + data[i + 2]) / 3;
        n += 1;
      }
    }
    const mean = n ? tone / n : 0;
    return Math.abs(mean - before) > 6;
  }, scrolledMean);
  const unscrolled = await sample(page);
  expect(unscrolled.scrollMean > scrolledMean + 6, `textarea scroll did not change the visible crop (${scrolledMean} -> ${unscrolled.scrollMean})`);

  const replaced = await page.evaluate(async () => {
    const next = document.createElement('section');
    next.className = 'class-demo';
    next.dataset.demoRoom = 'room-a';
    next.style.cssText = 'width:800px;height:300px;display:block;box-sizing:border-box;background:#147a32;color:#ffffff;font:20px/1.4 Consolas,monospace';
    const draft = document.createElement('textarea');
    draft.value = 'REPLACED_ROOM_MARKER';
    const term = document.createElement('pre');
    term.textContent = 'REPLACED_TERMINAL';
    next.append(draft, term);
    document.body.appendChild(next);
    window.__state.root = next;
    const old = document.getElementById('demo');
    old.remove();
    const started = window.__cap.stats().frames;
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (window.__xml.includes('REPLACED_ROOM_MARKER') && window.__cap.isCurrent()) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      current: window.__cap.isCurrent(),
      frames: window.__cap.stats().frames,
      started,
      xml: window.__xml.includes('REPLACED_ROOM_MARKER') && window.__xml.includes('REPLACED_TERMINAL') && !window.__xml.includes('SUPPORT_SENTINEL_OUTSIDE'),
    };
  });
  const green = await sample(page);
  expect(replaced.current === true && replaced.frames > replaced.started && replaced.xml && green.green > 20, `same-room replacement did not refresh: ${JSON.stringify(replaced)} green=${green.green}`);

  await page.evaluate(() => { window.__state.root.style.position = 'fixed'; window.__state.root.style.left = '-4000px'; window.__state.root.style.top = '0'; });
  expect(await page.evaluate(() => window.__cap.isCurrent()), 'offscreen display:block root was treated as gone');

  const stoppedRoom = await page.evaluate(async () => {
    window.__state.room = 'room-b';
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      const track = window.__cap.stream.getVideoTracks()[0];
      if (track.readyState === 'ended') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.__state.room = 'room-a';
    await new Promise((resolve) => setTimeout(resolve, 400));
    const track = window.__cap.stream.getVideoTracks()[0];
    return { state: track.readyState, current: window.__cap.isCurrent(), errors: window.__errors.slice() };
  });
  const zeroed = await sample(page);
  expect(stoppedRoom.state === 'ended' && stoppedRoom.current === false && zeroed.sum === 0, `room mismatch left a live frame: ${JSON.stringify(stoppedRoom)} sum=${zeroed && zeroed.sum}`);
  await page.evaluate(() => { window.__cap.stop(); window.__cap.stop(); });

  const authStop = await page.evaluate(async () => {
    window.__errors = [];
    window.__state.room = 'room-a';
    window.__state.authorized = true;
    const next = document.createElement('section');
    next.className = 'class-demo';
    next.dataset.demoRoom = 'room-a';
    next.style.cssText = 'width:800px;height:300px;display:block;background:#fffdf8';
    const draft = document.createElement('textarea');
    draft.value = 'AUTH_FRAME';
    next.append(draft);
    document.body.appendChild(next);
    window.__state.root = next;
    const session = await window.__factory.open('room-a');
    window.__state.authorized = false;
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      if (session.stream.getVideoTracks()[0].readyState === 'ended') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { state: session.stream.getVideoTracks()[0].readyState, current: session.isCurrent() };
  });
  const authPixels = await sample(page);
  expect(authStop.state === 'ended' && authStop.current === false && authPixels.sum === 0, `authorized false left a frame: ${JSON.stringify(authStop)} sum=${authPixels && authPixels.sum}`);

  const hidden = await page.evaluate(async () => {
    window.__state.authorized = true;
    const session = await window.__factory.open('room-a');
    window.dispatchEvent(new Event('pagehide'));
    return session.stream.getVideoTracks().map((track) => track.readyState);
  });
  const hiddenPixels = await sample(page);
  expect(hidden.length === 1 && hidden[0] === 'ended' && hiddenPixels.sum === 0, `pagehide did not stop: ${hidden.join(',')} sum=${hiddenPixels && hiddenPixels.sum}`);

  const external = await page.evaluate(async () => {
    const session = await window.__factory.open('room-a');
    const track = session.stream.getVideoTracks()[0];
    track.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const draft = window.__state.root.querySelector('textarea');
    draft.value = 'SHOULD_NOT_PAINT_AFTER_TRACK_STOP';
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { state: track.readyState, current: session.isCurrent() };
  });
  const externalPixels = await sample(page);
  expect(external.state === 'ended' && external.current === false && externalPixels.sum === 0, `external track.stop left the capture running: ${JSON.stringify(external)} sum=${externalPixels && externalPixels.sum}`);

  const layout = await page.evaluate(async () => {
    window.__errors = [];
    const empty = document.createElement('section');
    empty.className = 'class-demo';
    empty.dataset.demoRoom = 'room-a';
    empty.style.cssText = 'display:block;width:0;height:0;padding:0;border:0';
    document.body.appendChild(empty);
    window.__state.root = empty;
    window.__state.authorized = true;
    window.__state.room = 'room-a';
    try {
      await window.__factory.open('room-a');
      return { rejected: false, errors: window.__errors.slice() };
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error), errors: window.__errors.slice(), picker: window.__pickerCalls };
    }
  });
  expect(layout.rejected === true && /no layout/.test(`${layout.message} ${layout.errors.join(' ')}`) && layout.picker === 0, `zero-size root was not a clean render failure: ${JSON.stringify(layout)}`);
  expect(logs.every((line) => !/getDisplayMedia/.test(line)), `page errors: ${logs.join(' | ')}`);
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  if (!browser && /launch|Executable doesn't exist|channel/i.test(message)) {
    console.log(`SKIP lab-demo-broadcast: ${message.split('\n')[0]}`);
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }
  failures.push(message);
} finally {
  fs.writeFileSync(path.join(proofDir, 'failures.json'), JSON.stringify(failures, null, 2));
  if (browser) await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('lab-demo-broadcast: ok');
console.log(proofDir);
