// 두 출처 iframe 시연실. 전송 가능한 ImageBitmap postMessage 와 주입 시계는
// Playwright 가 실제 브라우저에서만 재현한다. Aside 는 이 피어를 넣지 못한다.
// 실행: node test/lab-demo-workspace.mjs

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);
const ROOM = 'room-demo';
const ROOM_B = 'room-other';

const built = await esbuild.build({
  stdin: {
    contents: fs.readFileSync(path.join(repo, 'src/lab-demo-workspace.ts'), 'utf8'),
    loader: 'ts',
    sourcefile: 'lab-demo-workspace.ts',
  },
  bundle: false,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const tempMod = path.join(os.tmpdir(), 'lab-demo-workspace-load.mjs');
fs.writeFileSync(tempMod, built.outputFiles[0].text);
const loaded = await import(pathToFileURL(tempMod).href);
const workspaceJs = loaded.LAB_DEMO_WORKSPACE_JS;
fs.rmSync(tempMod, { force: true });

function expect(condition, message) {
  if (!condition) {
    console.error('FAIL', message);
    throw new Error(message);
  }
  console.log('ok', message);
}

const banned = ['getDisplayMedia', 'contentDocument', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write', 'display:none', 'document.cookie'];
for (const token of banned) expect(!workspaceJs.includes(token), 'source omits ' + token);
for (const token of ['createLabDemoWorkspace', 'gw-demo-start', 'gw-demo-frame', 'gw-demo-ack', 'gw-demo-stop', 'gw-demo-error', 'captureStream(15)', "contentHint='text'", '모임지기 시연실', 'no-referrer', '?embed=1', 'ImageBitmap', 'ResizeObserver', 'allowedOrigin']) {
  expect(workspaceJs.includes(token), 'source has ' + token);
}

const childHtml = `<!doctype html><meta charset="utf-8"><title>demo-child</title>
<textarea id="draft" aria-label="draft"></textarea>
<script>
const incoming=[];
let nonce='';
addEventListener('message',(event)=>{
  const data=event.data||{};
  incoming.push({type:data.type,nonce:data.nonce,seq:data.seq,origin:event.origin,keys:data&&typeof data==='object'?Object.keys(data):[]});
  if(data.type==='gw-demo-start'&&typeof data.nonce==='string')nonce=data.nonce;
});
async function bitmap(w,h,color){
  const canvas=document.createElement('canvas');
  canvas.width=w;canvas.height=h;
  const g=canvas.getContext('2d',{alpha:false});
  g.fillStyle=color||'#00a86b';
  g.fillRect(0,0,w,h);
  return await createImageBitmap(canvas);
}
window.__child={
  incoming:()=>incoming.map((item)=>({type:item.type,nonce:item.nonce,seq:item.seq,origin:item.origin,keys:item.keys.slice()})),
  nonce:()=>nonce,
  async send(partial){
    let image=null;
    if(partial.make)image=await bitmap(partial.make.w,partial.make.h,partial.make.color);
    const msg={type:partial.type||'gw-demo-frame',nonce:Object.prototype.hasOwnProperty.call(partial,'nonce')?partial.nonce:nonce,seq:partial.seq};
    if(Object.prototype.hasOwnProperty.call(partial,'width'))msg.width=partial.width;
    else if(image)msg.width=image.width;
    if(Object.prototype.hasOwnProperty.call(partial,'height'))msg.height=partial.height;
    else if(image)msg.height=image.height;
    if(partial.fakeBitmap!==undefined)msg.bitmap=partial.fakeBitmap;
    else if(!partial.omitBitmap)msg.bitmap=image;
    if(typeof partial.message==='string')msg.message=partial.message;
    const transfer=[];
    if(msg.bitmap instanceof ImageBitmap)transfer.push(msg.bitmap);
    parent.postMessage(msg,'*',transfer);
  }
};
if(location.hash!=='#'+'ef'.repeat(32))parent.postMessage({type:'gw-demo-ready'},'*');
</script>`;

const spoofHtml = `<!doctype html><meta charset="utf-8"><title>spoof</title><script>
window.__spoof=async function(nonce){
  const canvas=document.createElement('canvas');
  canvas.width=8;canvas.height=8;
  const g=canvas.getContext('2d',{alpha:false});
  g.fillStyle='#ff00ff';
  g.fillRect(0,0,8,8);
  const image=await createImageBitmap(canvas);
  parent.postMessage({type:'gw-demo-frame',nonce:nonce,seq:1,bitmap:image,width:8,height:8},'*',[image]);
};
</script>`;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function originOf(server) {
  const address = server.address();
  return 'http://127.0.0.1:' + address.port;
}

const childHits = [];
const childServer = await listen((req, res) => {
  childHits.push({ url: req.url, authorization: req.headers.authorization || '', cookie: req.headers.cookie || '' });
  if (req.url.startsWith('/__lab/demo-open')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(childHtml);
    return;
  }
  res.writeHead(404);
  res.end('no');
});
const thirdServer = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(spoofHtml);
});
const childOrigin = originOf(childServer);
const thirdOrigin = originOf(thirdServer);

const parentHits = [];
const parentServer = await listen((req, res) => {
  parentHits.push(req.url);
  const route = req.url.split('?')[0];
  if (route === '/workspace.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(workspaceJs);
    return;
  }
  if (route === '/__lab/demo-open') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(childHtml);
    return;
  }
  if (route === '/spoof.html' || route === '/attacker.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(spoofHtml);
    return;
  }
  if (route === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>parent</title>
      <style>html,body{margin:0;background:#ff00ff}#magenta{width:80px;height:40px;background:#ff00ff}</style>
      <div id="sib">sibling-before</div>
      <div id="demoWorkspace"></div>
      <div id="magenta">PARENT_ONLY_PIXEL</div>
      <iframe id="evil" src="${thirdOrigin}/attacker.html"></iframe>
      <iframe id="spoof" src="/spoof.html"></iframe>
      <script src="/workspace.js"></script>`);
    return;
  }
  res.writeHead(404);
  res.end('no');
});
const parentOrigin = originOf(parentServer);

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
  await runPolicy(await browser.newPage());
  await runLive(await browser.newPage());
  expect(childHits.some((hit) => hit.url === '/__lab/demo-open?embed=1'), 'child saw embed=1 without the hash');
  expect(childHits.every((hit) => !hit.url.includes(HASH) && !hit.authorization && !hit.cookie), 'child request has no grant, cookie, or authorization');
  console.log('lab-demo-workspace: all checks passed');
} finally {
  if (browser) await browser.close();
  parentServer.close();
  childServer.close();
  thirdServer.close();
}

async function boot(page, options) {
  await page.goto(parentOrigin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof createLabDemoWorkspace === 'function');
  await page.evaluate((opts) => {
    const origCapture = HTMLCanvasElement.prototype.captureStream;
    window.__caps = [];
    window.__pixelAtCapture = null;
    HTMLCanvasElement.prototype.captureStream = function (fps) {
      const sample = this.getContext('2d').getImageData(960, 540, 1, 1).data;
      const corner = this.getContext('2d').getImageData(0, 0, 1, 1).data;
      window.__pixelAtCapture = { center: [sample[0], sample[1], sample[2]], corner: [corner[0], corner[1], corner[2]], connected: this.isConnected, w: this.width, h: this.height };
      window.__caps.push({ fps, canvas: this, connected: this.isConnected, w: this.width, h: this.height });
      return origCapture.call(this, fps);
    };
    const origClose = ImageBitmap.prototype.close;
    window.__closes = [];
    ImageBitmap.prototype.close = function () {
      window.__closes.push([this.width, this.height]);
      return origClose.call(this);
    };
    const media = navigator.mediaDevices;
    window.__picker = 0;
    if (media && media.getDisplayMedia) {
      const origPicker = media.getDisplayMedia.bind(media);
      media.getDisplayMedia = function () { window.__picker += 1; return origPicker.apply(media, arguments); };
    }
    const origPost = Window.prototype.postMessage;
    window.__out = [];
    Window.prototype.postMessage = function (message, targetOrigin, transfer) {
      const summary = message && typeof message === 'object'
        ? { type: message.type, nonce: message.nonce, seq: message.seq, keys: Object.keys(message) }
        : { raw: String(message) };
      window.__out.push({ summary, targetOrigin: String(targetOrigin) });
      return origPost.apply(this, arguments);
    };
    window.__errors = [];
    window.__status = [];
    window.__retries = [];
    window.__ready = 0;
    window.__changed = 0;
    window.__room = opts.room;
    window.__auth = true;
    window.__skew = 0;
    const deps = {
      root: document.getElementById(opts.root),
      selected: () => window.__room,
      authorized: () => window.__auth,
      onError: (error) => window.__errors.push(String(error && error.message || error)),
      onStatus: (text) => window.__status.push(String(text)),
      onReady: () => { window.__ready += 1; },
      changed: () => { window.__changed += 1; },
      retry: (id) => window.__retries.push(id),
      now: () => performance.now() + window.__skew,
    };
    if (opts.allow) deps.allowedOrigin = (origin) => window.__allow(origin);
    window.__allow = () => false;
    window.__ws = createLabDemoWorkspace(deps);
    const root = deps.root;
    root.style.position = 'relative';
    root.style.width = '960px';
    root.style.height = '540px';
    root.style.overflow = 'hidden';
  }, options);
}

async function runPolicy(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page, { room: ROOM, root: 'demoWorkspace', allow: false });
  const hashUrl = (base) => base + '/__lab/demo-open#' + HASH;
  const result = await page.evaluate(({ childOrigin, parentOrigin, hashUrlChild, hashUrlParent, hash2 }) => {
    const ws = window.__ws;
    const bad = [
      ['http-evil', 'http://evil.example/__lab/demo-open#' + hash2],
      ['upper', childOrigin + '/__lab/demo-open#' + hash2.toUpperCase()],
      ['short', childOrigin + '/__lab/demo-open#' + 'ab'.repeat(31)],
      ['creds', childOrigin.replace('http://', 'http://user:pass@') + '/__lab/demo-open#' + hash2],
      ['search', childOrigin + '/__lab/demo-open?next=/admin#' + hash2],
      ['path', childOrigin + '/__lab/demo-open/extra#' + hash2],
      ['redirect', childOrigin + '/redirect#' + hash2],
      ['blob', 'blob:http://127.0.0.1/00000000-0000-0000-0000-000000000000'],
    ];
    const rejected = bad.map(([name, url]) => [name, ws.mount(window.__room, url) === false]);
    const noIframe = document.querySelectorAll('iframe[title="모임지기 시연실"]').length === 0;
    const leaked = JSON.stringify({ errors: window.__errors, status: window.__status }).includes(hash2)
      || JSON.stringify({ errors: window.__errors, status: window.__status }).includes('user:pass');
    window.__allow = (origin) => origin === 'https://evil.example';
    const httpsEvil = createLabDemoWorkspace({
      root: document.getElementById('demoWorkspace'),
      selected: () => window.__room,
      authorized: () => true,
      allowedOrigin: (origin) => origin === 'https://evil.example',
      onError: (error) => window.__errors.push(String(error && error.message || error)),
      onStatus: (text) => window.__status.push(String(text)),
    });
    const evilMounted = httpsEvil.mount(window.__room, 'https://evil.example/__lab/demo-open#' + hash2) === true;
    const evilSrc = (document.querySelector('iframe[title="모임지기 시연실"]') || {}).src || '';
    httpsEvil.clear();
    const thrown = createLabDemoWorkspace({
      root: document.getElementById('demoWorkspace'),
      selected: () => window.__room,
      authorized: () => true,
      allowedOrigin: () => { throw Error('boom'); },
      onError: () => {},
      onStatus: () => {},
    }).mount(window.__room, hashUrlChild) === false;
    const notTrue = createLabDemoWorkspace({
      root: document.getElementById('demoWorkspace'),
      selected: () => window.__room,
      authorized: () => true,
      allowedOrigin: () => 'yes',
      onError: () => {},
      onStatus: () => {},
    }).mount(window.__room, hashUrlChild) === false;
    const local = createLabDemoWorkspace({
      root: document.getElementById('demoWorkspace'),
      selected: () => window.__room,
      authorized: () => true,
      onError: (error) => window.__errors.push(String(error && error.message || error)),
      onStatus: (text) => window.__status.push(String(text)),
    });
    const same = local.mount(window.__room, hashUrlParent) === true;
    const sameSrc = (document.querySelector('iframe[title="모임지기 시연실"]') || {}).src || '';
    local.clear();
    const loop = local.mount(window.__room, hashUrlChild) === true;
    const loopSrc = (document.querySelector('iframe[title="모임지기 시연실"]') || {}).src || '';
    local.clear();
    const localHost = createLabDemoWorkspace({
      root: document.getElementById('demoWorkspace'),
      selected: () => 'room-local',
      authorized: () => true,
      allowedOrigin: (origin) => origin === 'http://localhost' || origin === 'http://[::1]',
      onError: () => {},
      onStatus: () => {},
    });
    window.__room = 'room-local';
    const localhostOk = localHost.mount('room-local', 'http://localhost/__lab/demo-open#' + hash2) === true;
    const localhostSrc = (document.querySelector('iframe[title="모임지기 시연실"]') || {}).src || '';
    localHost.clear();
    window.__room = 'room-local';
    const ipv6Ok = localHost.mount('room-local', 'http://[::1]/__lab/demo-open#' + hash2) === true;
    const ipv6Src = (document.querySelector('iframe[title="모임지기 시연실"]') || {}).src || '';
    localHost.clear();
    local.clear();
    window.__room = 'room-demo';
    return { rejected, noIframe, leaked, evilMounted, evilSrc, thrown, notTrue, same, sameSrc, loop, loopSrc, localhostOk, localhostSrc, ipv6Ok, ipv6Src };
  }, {
    childOrigin,
    parentOrigin,
    hashUrlChild: hashUrl(childOrigin),
    hashUrlParent: hashUrl(parentOrigin),
    hash2: HASH2,
  });
  for (const [name, ok] of result.rejected) expect(ok, 'rejects ' + name);
  expect(result.noIframe, 'rejected URLs create no demo iframe');
  expect(!result.leaked, 'errors and status omit the grant and credentials');
  expect(result.evilMounted && result.evilSrc.startsWith('https://evil.example/__lab/demo-open?embed=1#' + HASH2), 'https non-loopback mounts only through allowedOrigin');
  expect(result.thrown, 'allowedOrigin throw rejects');
  expect(result.notTrue, 'allowedOrigin must return true');
  expect(result.same && result.sameSrc.startsWith(parentOrigin + '/__lab/demo-open?embed=1#'), 'same-origin fallback mounts without allowedOrigin');
  expect(result.loop && result.loopSrc.startsWith(childOrigin + '/__lab/demo-open?embed=1#'), 'loopback parent may mount loopback child without allowedOrigin');
  expect(result.localhostOk && result.localhostSrc.startsWith('http://localhost/__lab/demo-open?embed=1#'), 'localhost http test URL is accepted');
  expect(result.ipv6Ok && result.ipv6Src.startsWith('http://[::1]/__lab/demo-open?embed=1#'), 'ipv6 loopback http test URL is accepted');
  expect(errors.length === 0, 'policy page has no pageerror ' + errors.join(' | '));
}

function demoFrame(page) {
  const frames = page.frames().filter((frame) => frame.url().includes('/__lab/demo-open') && !frame.isDetached());
  return frames[frames.length - 1];
}

async function runLive(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page, { room: ROOM, root: 'demoWorkspace', allow: true });
  await page.evaluate(({ childOrigin, parentOrigin }) => { window.__allow = (value) => value === childOrigin || value === parentOrigin; }, { childOrigin, parentOrigin });
  const before = await page.evaluate(() => window.__out.length);
  const mounted = await page.evaluate(({ room, url }) => {
    const ok = window.__ws.mount(room, url);
    window.__node = document.querySelector('iframe[title="모임지기 시연실"]');
    const node = window.__node;
    const style = getComputedStyle(node);
    return {
      ok,
      title: node.title,
      referrer: node.referrerPolicy,
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
      src: node.src,
      display: style.display,
      count: document.querySelectorAll('iframe[title="모임지기 시연실"]').length,
      doc: node.contentDocument,
    };
  }, { room: ROOM, url: childOrigin + '/__lab/demo-open#' + HASH });
  expect(mounted.ok, 'cross-origin mount succeeds');
  expect(mounted.title === '모임지기 시연실' && mounted.referrer === 'no-referrer', 'iframe title and referrerPolicy');
  expect(mounted.width === '1920' && mounted.height === '1080', 'logical iframe dimensions');
  expect(mounted.src === childOrigin + '/__lab/demo-open?embed=1#' + HASH, 'src is embed=1 plus the grant hash');
  expect(mounted.count === 1, 'one demo iframe, saw ' + mounted.count);
  expect(mounted.display === 'block', 'iframe display is block, saw ' + mounted.display);
  await page.waitForFunction(() => window.__ready >= 1);
  const crossDoc = await page.evaluate(() => document.querySelector('iframe[title="모임지기 시연실"]').contentDocument);
  expect(crossDoc === null, 'parent cannot read the cross-origin document');
  expect(await page.evaluate((n) => window.__out.length === n, before), 'mount does not postMessage a start');
  await page.waitForFunction(() => window.__ready >= 1);
  const child = demoFrame(page);
  expect(!!child, 'child frame attached');
  await child.waitForFunction(() => window.__child);
  await child.locator('#draft').click();
  await child.locator('#draft').pressSequentially('alpha-draft');
  expect(await child.locator('#draft').inputValue() === 'alpha-draft', 'native typing landed in the child');

  const retained = await page.evaluate(({ room, url }) => {
    const beforeNode = window.__node;
    const src = beforeNode.src;
    document.getElementById('sib').textContent = 'sibling-after';
    const extra = document.createElement('p');
    extra.textContent = 'new sibling';
    beforeNode.parentElement.parentElement.insertBefore(extra, document.getElementById('demoWorkspace'));
    const garbage = window.__ws.mount(room, 'not a url');
    const node = document.querySelector('iframe[title="모임지기 시연실"]');
    return { garbage, same: node === beforeNode, src: node.src === src, count: document.querySelectorAll('iframe[title="모임지기 시연실"]').length };
  }, { room: ROOM, url: childOrigin + '/__lab/demo-open#' + HASH2 });
  expect(retained.garbage === false && retained.same && retained.src && retained.count === 1, 'invalid same-room grant is rejected without replacing the iframe');
  expect(await child.locator('#draft').inputValue() === 'alpha-draft', 'draft survived invalid grant and sibling render');

  await page.evaluate(() => window.__ws.setVisible(false));
  const parked = await page.evaluate(() => {
    const node = document.querySelector('iframe[title="모임지기 시연실"]');
    const style = getComputedStyle(node);
    return { same: node === window.__node, display: style.display, hidden: node.hidden, aria: node.getAttribute('aria-hidden'), inert: node.inert === true, transform: style.transform, parent: node.parentElement === document.getElementById('demoWorkspace') };
  });
  expect(parked.same && parked.display === 'block' && parked.hidden === false && parked.aria === 'true' && parked.inert && parked.transform.includes('-20000') && parked.parent, 'setVisible(false) parks the same iframe offscreen');
  expect(await child.locator('#draft').inputValue() === 'alpha-draft', 'draft survived setVisible(false)');
  await page.evaluate(() => window.__ws.setVisible(true));
  await child.locator('#draft').click();
  await child.locator('#draft').pressSequentially('-beta');
  expect(await child.locator('#draft').inputValue() === 'alpha-draft-beta', 'native typing works again after setVisible(true)');
  const scaled = await page.evaluate(() => getComputedStyle(window.__node).transform);
  expect(scaled.includes('0.5'), 'visible iframe scales to the 960x540 root');

  const opened = await page.evaluate(() => {
    window.__p1 = window.__ws.open(window.__room);
    window.__p2 = window.__ws.open(window.__room);
    window.__p1.then((handle) => { window.__handle = handle; window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
    return window.__p1 === window.__p2;
  });
  expect(opened, 'second open joins the pending promise');
  await page.waitForTimeout(1300);
  const beats = await child.evaluate((hash) => {
    const starts = window.__child.incoming().filter((item) => item.type === 'gw-demo-start');
    return {
      count: starts.length,
      nonce: starts[0] && starts[0].nonce,
      same: starts.every((item) => item.nonce === starts[0].nonce),
      keys: starts[0] && starts[0].keys.slice().sort().join(','),
      origin: starts[0] && starts[0].origin,
      leaked: JSON.stringify(starts).includes(hash),
    };
  }, HASH);
  expect(beats.count >= 2 && beats.same && beats.keys === 'nonce,type' && beats.origin === parentOrigin && !beats.leaked && await page.evaluate(()=>window.__caps.length===0), 'heartbeat repeats one nonce and captureStream is still idle');
  expect(await child.evaluate(() => window.__child.nonce().length >= 16), 'child received the start nonce');

  const closesBefore = await page.evaluate(() => window.__closes.length);
  await child.evaluate(async (nonce) => window.__child.send({ seq: 1, make: { w: 8, h: 8 }, nonce }), '0'.repeat(32));
  await child.evaluate(async () => window.__child.send({ seq: 1.5, make: { w: 8, h: 8 } }));
  await child.evaluate(async () => window.__child.send({ seq: -1, make: { w: 8, h: 8 } }));
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 8, h: 8 }, width: 7, height: 8 }));
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 1921, h: 8 } }));
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 8, h: 1201 } }));
  await child.evaluate(async () => window.__child.send({ seq: 1, fakeBitmap: 'nope', width: 8, height: 8 }));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const image = await createImageBitmap(canvas);
    window.postMessage({ type: 'gw-demo-frame', nonce: 'guess', seq: 1, bitmap: image, width: 8, height: 8 }, location.origin, [image]);
  });
  const evil = page.frames().find((frame) => frame.url().startsWith(thirdOrigin));
  await evil.evaluate(async (nonce) => window.__spoof(nonce), beats.nonce);
  const spoof = page.frames().find((frame) => frame.url().includes('/spoof.html'));
  await spoof.evaluate(async (nonce) => window.__spoof(nonce), beats.nonce);
  await page.waitForTimeout(200);
  const rejectedFrames = await page.evaluate((beforeClose) => ({
    caps: window.__caps.length,
    closes: window.__closes.length - beforeClose,
    state: window.__openState || 'pending',
  }), closesBefore);
  expect(rejectedFrames.caps === 0 && rejectedFrames.state === 'pending' && rejectedFrames.closes >= 6, 'bad, spoofed, and oversize bitmaps are closed with no stream');

  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 100, h: 50, color: '#00a86b' } }));
  await page.waitForFunction(() => window.__openState === 'ok');
  const first = await page.evaluate(() => {
    const handle = window.__handle;
    const track = handle.stream.getVideoTracks()[0];
    return {
      caps: window.__caps.map((item) => item.fps),
      pixels: window.__pixelAtCapture,
      hint: track.contentHint,
      live: track.readyState,
      stats: handle.stats(),
      current: handle.isCurrent(),
      connected: window.__caps[0].connected,
      picker: window.__picker,
    };
  });
  expect(first.caps.length === 1 && first.caps[0] === 15, 'captureStream(15) runs only after the first frame');
  expect(first.pixels.center[0] === 0 && first.pixels.center[1] === 168 && first.pixels.center[2] === 107, 'first frame is drawn before capture');
  expect(first.pixels.corner[0] === 16 && first.pixels.corner[1] === 20 && first.pixels.corner[2] === 24, 'letterbox background is deterministic and not the parent pixel');
  expect(first.pixels.w === 1920 && first.pixels.h === 1080 && first.connected === false, 'frame canvas is detached 1920x1080');
  expect(first.hint === 'text' && first.live === 'live' && first.current === true, 'text track is current');
  expect(first.stats.quality === 'detail' && first.stats.width === 1920 && first.stats.height === 1080 && first.stats.frames === 1 && first.stats.fresh === true && first.stats.seq === 1, 'stats expose detail and freshness');
  expect(first.picker === 0, 'getDisplayMedia was not used');
  expect(await child.evaluate(() => window.__child.incoming().some((item) => item.type === 'gw-demo-ack' && item.seq === 1 && item.keys.slice().sort().join(',') === 'nonce,seq,type')), 'ack contains only nonce and seq');

  const closesMid = await page.evaluate(() => window.__closes.length);
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 8, h: 8, color: '#112233' } }));
  await child.evaluate(async () => window.__child.send({ seq: 0, make: { w: 8, h: 8, color: '#112233' } }));
  await page.waitForTimeout(150);
  const ordered = await page.evaluate((beforeClose) => ({ frames: window.__handle.stats().frames, closes: window.__closes.length - beforeClose, caps: window.__caps.length }), closesMid);
  expect(ordered.frames === 1 && ordered.closes === 2 && ordered.caps === 1, 'duplicate and older seq are closed');
  await child.evaluate(async () => window.__child.send({ seq: 2, make: { w: 1920, h: 1200, color: '#00a86b' } }));
  await page.waitForFunction(() => window.__handle.stats().frames === 2);

  const reused = await page.evaluate(async () => {
    const next = await window.__ws.open(window.__room);
    return next === window.__handle && next.stream === window.__handle.stream;
  });
  expect(reused, 'a live open returns the same handle');

  await page.evaluate(() => { window.__ws.setVisible(false); document.getElementById('demoWorkspace').style.display = 'none'; });
  await child.evaluate(async () => window.__child.send({ seq: 3, make: { w: 32, h: 16, color: '#00a86b' } }));
  await page.waitForFunction(() => window.__handle.stats().frames === 3);
  const hiddenLive = await page.evaluate(() => ({
    current: window.__handle.isCurrent(),
    same: document.querySelector('iframe[title="모임지기 시연실"]') === window.__node,
    display: getComputedStyle(window.__node).display,
  }));
  expect(hiddenLive.current && hiddenLive.same && hiddenLive.display === 'block', 'parked iframe keeps the same stream without display none');
  await page.evaluate(() => { document.getElementById('demoWorkspace').style.display = ''; window.__ws.setVisible(true); });
  expect(await child.locator('#draft').inputValue() === 'alpha-draft-beta', 'draft survived the hidden stream');

  const capsAtStop = await page.evaluate(() => window.__caps.length);
  await page.evaluate(() => { window.__handle.stop(); window.__handle.stop(); });
  await child.waitForFunction(()=>window.__child.incoming().some(item=>item.type==='gw-demo-stop'));
  const stopMessages=await child.evaluate(()=>window.__child.incoming().filter(item=>item.type==='gw-demo-stop'));
  const stopped = await page.evaluate((hash) => {
    return {
      state: window.__handle.stream.getVideoTracks()[0].readyState,
      current: window.__handle.isCurrent(),
      mounted: window.__ws.isMounted(window.__room),
      leaked: JSON.stringify(window.__out).includes(hash) || window.__errors.some((item) => item.includes(hash)) || window.__status.some((item) => item.includes(hash)),
    };
  }, HASH);
  expect(stopped.state === 'ended' && stopped.current === false && stopped.mounted && stopMessages.length === 1 && stopMessages[0].keys.slice().sort().join(',') === 'nonce,type' && !stopped.leaked, 'stop is idempotent and leaves the iframe');
  expect(await child.locator('#draft').inputValue() === 'alpha-draft-beta', 'stop leaves the editor draft');
  const closesAtStale = await page.evaluate(() => window.__closes.length);
  await child.evaluate(async (nonce) => window.__child.send({ seq: 4, make: { w: 8, h: 8, color: '#ff00ff' }, nonce }), beats.nonce);
  await page.waitForTimeout(150);
  const stale = await page.evaluate((before) => ({ caps: window.__caps.length, closes: window.__closes.length - before }), closesAtStale);
  expect(stale.caps === capsAtStop && stale.closes === 1, 'old nonce after stop is closed and does not allocate a stream');

  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__ws.open(window.__room).then((handle) => { window.__handle = handle; window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 16, h: 16, color: '#00a86b' } }));
  await page.waitForFunction(() => window.__openState === 'ok');
  const capsBeforeStale = await page.evaluate(() => window.__caps.length);
  await page.evaluate(() => { window.__skew += 11000; });
  await page.waitForTimeout(500);
  const fresh = await page.evaluate(() => {
    const canvas = window.__handle.stream;
    return {
      state: window.__handle.stream.getVideoTracks()[0].readyState,
      current: window.__handle.isCurrent(),
      mounted: window.__ws.isMounted(window.__room),
      errors: window.__errors.slice(),
      caps: window.__caps.length,
    };
  });
  expect(fresh.state === 'ended' && fresh.current === false && fresh.mounted && fresh.caps === capsBeforeStale, 'freshness timeout stops tracks and keeps the iframe');
  expect(fresh.errors.some((item) => item.includes('멈춰')) && fresh.errors.every((item) => !item.includes(HASH)), 'freshness error is localized and has no grant');
  const clearedPixels = await page.evaluate(() => {
    const frame = window.__caps[window.__caps.length - 1].canvas;
    const px = frame.getContext('2d').getImageData(960, 540, 1, 1).data;
    return [px[0], px[1], px[2]];
  });
  expect(clearedPixels[0] === 16 && clearedPixels[1] === 20 && clearedPixels[2] === 24, 'freshness timeout clears the frame canvas');
  const cleared = await page.evaluate(() => {
    const node = document.querySelector('iframe[title="모임지기 시연실"]');
    return node === window.__node;
  });
  expect(cleared, 'freshness timeout does not replace the iframe');
  await child.evaluate(async () => window.__child.send({ seq: 2, make: { w: 16, h: 16, color: '#00a86b' } }));
  await page.waitForTimeout(200);
  expect(await page.evaluate((n) => window.__caps.length === n, capsBeforeStale), 'a late frame does not resurrect the stream');

  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__ws.open(window.__room).then(() => { window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  const capsBeforeTimeout = await page.evaluate(() => window.__caps.length);
  await page.evaluate(() => { window.__skew += 11000; });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__openState.includes('첫 프레임')), 'first frame timeout rejects');
  expect(await page.evaluate((n) => window.__ws.isMounted(window.__room) && window.__caps.length === n, capsBeforeTimeout), 'startup timeout keeps the iframe and does not capture');
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 8, h: 8 } }));
  await page.waitForTimeout(200);
  expect(await page.evaluate((n) => window.__caps.length === n, capsBeforeTimeout), 'frame after startup timeout does not resurrect');
  await page.evaluate(() => { window.__skew = 0; });

  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__late = window.__ws.open(window.__room).then(() => { window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); });
  await page.waitForFunction(() => window.__openState !== 'pending');
  const capsBeforeHide = await page.evaluate(() => window.__caps.length);
  expect(await page.evaluate(() => window.__openState.includes('취소') && window.__ws.isMounted(window.__room)), 'pagehide cancels the pending open and keeps the mount');
  await child.evaluate(async () => window.__child.send({ seq: 1, make: { w: 8, h: 8 } }));
  await page.waitForTimeout(200);
  expect(await page.evaluate((n) => window.__caps.length === n && window.__openState !== 'ok', capsBeforeHide), 'pagehide frame does not resurrect a stream');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));

  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__ws.open(window.__room).then(() => { window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  await page.evaluate(() => { window.__auth = false; });
  await page.waitForFunction(() => window.__openState !== 'pending', null, { timeout: 2000 });
  expect(await page.evaluate(() => window.__openState.includes('권한이 바뀌') && window.__ws.isMounted(window.__room) === false), 'auth loss cancels and does not keep the room mounted');
  expect(await page.evaluate((n) => window.__caps.length === n, capsBeforeHide), 'auth loss does not allocate a stream');
  await page.evaluate(() => { window.__auth = true; });
  const readyAfterAuth = await page.evaluate(() => window.__ready);
  expect(await page.evaluate(({ room, url }) => window.__ws.mount(room, url) === true, { room: ROOM, url: childOrigin + '/__lab/demo-open#' + HASH }), 'explicit remount works after auth returns');
  await page.waitForFunction((n) => window.__ready > n, readyAfterAuth);
  const childAgain = demoFrame(page);
  await childAgain.waitForFunction(() => window.__child);
  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__ws.open(window.__room).then(() => { window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  await page.evaluate((room) => { window.__room = room; }, ROOM_B);
  await page.waitForFunction(() => window.__openState !== 'pending', null, { timeout: 2000 });
  expect(await page.evaluate((room) => window.__openState.includes('권한이 바뀌') && window.__ws.isMounted(room) === false, ROOM), 'selection change cancels without resurrection');
  await page.evaluate((room) => { window.__room = room; }, ROOM);

  const readyBeforeSame = await page.evaluate(() => window.__ready);
  expect(await page.evaluate(({ room, url }) => window.__ws.mount(room, url) === true, { room: ROOM, url: parentOrigin + '/__lab/demo-open#' + HASH }), 'same-origin demo mount');
  await page.waitForFunction((n) => window.__ready > n, readyBeforeSame);
  const sameOriginChild = demoFrame(page);
  await sameOriginChild.locator('#draft').click();
  await sameOriginChild.locator('#draft').pressSequentially('same-origin-draft');
  await page.evaluate(() => {
    window.__openState = 'pending';
    window.__ws.open(window.__room).then((handle) => { window.__handle = handle; window.__openState = 'ok'; }, (error) => { window.__openState = String(error && error.message || error); });
  });
  await page.waitForTimeout(300);
  const sameNonce = await sameOriginChild.evaluate(() => window.__child.nonce());
  const closesBeforeSpoof = await page.evaluate(() => window.__closes.length);
  const capsBeforeSpoof = await page.evaluate(() => window.__caps.length);
  const spoofAgain = page.frames().find((frame) => frame.url().includes('/spoof.html'));
  await spoofAgain.evaluate(async (nonce) => window.__spoof(nonce), sameNonce);
  await page.evaluate(async (nonce) => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 8;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ff00ff';
    g.fillRect(0, 0, 8, 8);
    const image = await createImageBitmap(canvas);
    window.postMessage({ type: 'gw-demo-frame', nonce, seq: 1, bitmap: image, width: 8, height: 8 }, location.origin, [image]);
  }, sameNonce);
  await page.waitForTimeout(200);
  const spoofed = await page.evaluate(({ beforeClose, beforeCaps }) => ({
    closes: window.__closes.length - beforeClose,
    caps: window.__caps.length - beforeCaps,
    state: window.__openState,
  }), { beforeClose: closesBeforeSpoof, beforeCaps: capsBeforeSpoof });
  expect(spoofed.closes >= 2 && spoofed.caps === 0 && spoofed.state === 'pending', 'same-origin guessed nonce from another window is rejected');
  await page.evaluate(() => { window.__openState = 'dropped'; window.__ws.clear('nope'); });
  expect(await page.evaluate((room) => window.__ws.isMounted(room), ROOM), 'clear(other) is a no-op');
  await page.evaluate((room) => window.__ws.clear(room), ROOM);
  expect(await page.evaluate((room) => window.__ws.isMounted(room) === false && document.querySelector('iframe[title="모임지기 시연실"]') === null, ROOM), 'clear(room) removes the iframe');
  expect(await page.evaluate(() => window.__openState === 'pending' || window.__openState.includes('취소')), 'clear cancels an outstanding open');

  const readyBeforeRetry = await page.evaluate(() => window.__ready);
  await page.evaluate(({ room, url }) => { window.__ws.mount(room, url); }, { room: ROOM, url: childOrigin + '/__lab/demo-open#' + HASH });
  await page.waitForFunction((n) => window.__ready > n, readyBeforeRetry);
  await page.evaluate(() => document.querySelector('iframe[title="모임지기 시연실"]').dispatchEvent(new Event('error')));
  const retry = await page.evaluate((hash) => {
    const button = document.querySelector('[data-demo-retry]');
    const text = (document.querySelector('[data-demo-status]') || {}).textContent || '';
    if (button) button.click();
    return { text, retry: window.__retries.slice(), leaked: text.includes(hash) || window.__errors.some((item) => item.includes(hash)) };
  }, HASH);
  expect(retry.text.includes('다시 시도') && retry.retry[0] === ROOM && !retry.leaked, 'load error shows a localized retry without the grant');
  await page.evaluate(() => {
    const root = document.getElementById('demoWorkspace');
    root.style.width = '640px';
    root.style.height = '360px';
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const resized = await page.evaluate(() => getComputedStyle(document.querySelector('iframe[title="모임지기 시연실"]')).transform);
  expect(resized.includes('0.333') || resized.includes('0.33'), 'ResizeObserver updates the scale from the root bounds');

  const retryReady = await page.evaluate(() => window.__ready);
  const replaced = await page.evaluate(({room,url}) => {
    const old=document.querySelector('iframe[title="모임지기 시연실"]');
    const ok=window.__ws.mount(room,url);
    const next=document.querySelector('iframe[title="모임지기 시연실"]');
    return ok&&next!==old&&!old.isConnected&&next.src===url.replace('/__lab/demo-open#','/__lab/demo-open?embed=1#');
  }, {room:ROOM,url:childOrigin+'/__lab/demo-open#'+HASH2});
  expect(replaced,'explicit fresh grant retries by replacing the iframe');
  await page.waitForFunction(n=>window.__ready>n,retryReady);

  const deadlineReady=await page.evaluate(()=>window.__ready);
  const noReadyNavigation=page.waitForEvent('framenavigated',{predicate:frame=>frame.url().includes('#'+'ef'.repeat(32))});
  await page.evaluate(({room,url})=>window.__ws.mount(room,url),{room:ROOM,url:childOrigin+'/__lab/demo-open#'+'ef'.repeat(32)});
  const notReadyChild=await noReadyNavigation;
  await notReadyChild.waitForFunction(()=>window.__child);
  for(const spoofFrame of page.frames().filter(frame=>frame.url().includes('/spoof.html')||frame.url().includes('/attacker.html'))){
    await spoofFrame.evaluate(()=>parent.postMessage({type:'gw-demo-ready'},'*'));
  }
  await page.waitForTimeout(100);
  expect(await page.evaluate(n=>window.__ready===n,deadlineReady),'same-origin and foreign windows cannot spoof bridge readiness');
  await page.evaluate(()=>{window.__skew+=21000});
  await page.waitForTimeout(500);
  const noReady=await page.evaluate(n=>({ready:window.__ready===n,status:document.querySelector('[data-demo-status]').textContent,retry:!!document.querySelector('[data-demo-retry]'),caps:window.__caps.length}),deadlineReady);
  expect(noReady.ready&&noReady.retry&&noReady.status.includes('다시 시도'),'missing bridge handshake times out with localized retry');
  await notReadyChild.evaluate(()=>parent.postMessage({type:'gw-demo-ready'},'*'));
  await page.waitForFunction(n=>window.__ready>n,deadlineReady);
  expect(await page.evaluate(n=>window.__caps.length===n,noReady.caps),'late ready handshake recovers without automatic capture');
  expect(errors.length === 0, 'live page has no pageerror ' + errors.join(' | '));
}
