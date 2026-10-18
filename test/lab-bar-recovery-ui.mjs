// Student bar recovery under a virtual clock/DOM/fetch: no browser, server, keys or network.
// LAB_BAR_SOURCE=C:/.../src/labbar.ts node test/lab-bar-recovery-ui.mjs can check an older source.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.LAB_BAR_SOURCE ? pathToFileURL(resolve(process.env.LAB_BAR_SOURCE)).href : new URL('../src/labbar.ts', import.meta.url).href;
const { LAB_BAR_JS } = await import(source);
const T0 = Date.parse('2026-10-06T09:00:00Z'), SHORT = 10000, EXPORT = 300000;
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('  ok ' + label); };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function scene(options = {}) {
  let now = T0, seq = 0;
  const timers = new Map(), calls = [], downloads = [], nodes = [], winEvents = {}, docEvents = {};
  const plans = { '/__lab/me': [], '/__lab/hand': [], '/__lab/export': [] };
  const state = { expiresAt: T0 + 24 * 3600000, usage: 0.25, limit: 2, hand: false, seat: 3, name: '수업', who: '참가자', clip: { in: false, out: true } };
  const schedule = (fn, ms, repeat = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  const storage = new Map([['labTab', 'known-tab'], ['labWatch', '1'], ['labBarFolded', options.folded ? '1' : '0']]);
  const store = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.textContent = ''; this.disabled = false; nodes.push(this); }
    set innerHTML(_) { throw new Error('Trusted Types: innerHTML forbidden'); }
    setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
    addEventListener(type, fn) { (this.events ||= {})[type] = fn; }
    get lastElementChild() { return this.children.at(-1); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child, before) { child.parent = this; this.children.splice(this.children.indexOf(before), 0, child); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    click() { if (this.disabled) return; if (this.tag === 'a') downloads.push({ href: this.href, name: this.download }); else return this.onclick?.({}); }
  }
  const policy = { in: false, out: true }, clipUpdates = [];
  const clip = { policy, input: T0, touch() {}, onInput: [], listeners: [], set(p) { this.policy = { ...p }; clipUpdates.push({ ...p }); } };
  const document = { body: new Element('body'), visibilityState: 'visible', hasFocus: () => true, createElement: tag => new Element(tag), addEventListener: (type, fn) => (docEvents[type] ||= []).push(fn) };
  const fetch = (path, init) => {
    const plan = plans[path]?.shift() || {};
    assert.ok(path in plans, 'Only fixed same-origin bar endpoints');
    const f = deferred(), body = deferred();
    const call = { path, init, body: JSON.parse(init.body), start: now, jsonCalls: 0, signal: init.signal, aborts: 0,
      respond(value, status = 200) { f.resolve({ ok: status >= 200 && status < 300, status, json: () => { call.jsonCalls++; return plan.json === 'hang' ? body.promise : plan.json === 'bad' ? Promise.reject(new SyntaxError('bad JSON')) : Promise.resolve(value); } }); },
      resolveJSON: body.resolve, reject: f.reject };
    calls.push(call);
    if (init.signal) init.signal.addEventListener('abort', () => { call.aborts++; if (plan.respectAbort) f.reject(new DOMException('aborted', 'AbortError')); });
    const value = plan.value ?? (path === '/__lab/me' ? structuredClone(state) : path === '/__lab/hand' ? { hand: call.body.up } : { ticket: 'test-ticket', name: 'work.zip', size: 2048, skipped: 1 });
    if (plan.fetch === 'reject') f.reject(new Error('offline'));
    else if (plan.fetch !== 'hang') { if (plan.after) schedule(() => call.respond(value, plan.status ?? 200), plan.after); else call.respond(value, plan.status ?? 200); }
    return f.promise;
  };
  const context = { document, fetch, localStorage: store, sessionStorage: store, location: { href: '' }, AbortController, Date: class extends Date { static now() { return now; } }, Math, JSON, Number, Promise, Error, Object,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => schedule(fn, ms, ms),
    addEventListener: (type, fn) => (winEvents[type] ||= []).push(fn) };
  context.window = context;
  if (!options.noClip) context.__labClip = clip;
  if (options.initial) plans['/__lab/me'].push(options.initial);
  vm.runInNewContext(LAB_BAR_JS, context, { timeout: 1000 });
  const [time, money, uploadHelp, clipLabel, download, hand, home] = context.__labBarUI.box.children;
  const fold = context.__labBarUI.box.children.find(x => x.tag === 'button' && ['–', '+'].includes(x.textContent));
  const message = document.body.children[1];
  const hits = path => calls.filter(c => c.path === path);
  const advance = async ms => {
    const target = now + ms; await flush();
    while (true) {
      let chosen;
      for (const [id, task] of timers) if (task.at <= target && (!chosen || task.at < chosen.task.at || (task.at === chosen.task.at && id < chosen.id))) chosen = { id, task };
      if (!chosen) break;
      now = chosen.task.at;
      if (chosen.task.repeat) chosen.task.at += chosen.task.repeat; else timers.delete(chosen.id);
      chosen.task.fn(); await flush();
    }
    now = target; await flush();
  };
  const visible = () => { for (const f of docEvents.visibilitychange || []) f(); };
  return { context, document, nodes, timers, calls, plans, state, clip, clipUpdates, time, money, clipLabel, download, hand, home, fold, message, downloads, hits, advance, visible, winEvents, flush };
}

// Normal behavior, the public extension point and the privacy-preserving presence payload.
{
  const s = scene(); await s.flush();
  check('normal status paints time, usage, hand and restricted clipboard', s.time.textContent.includes('남음') && s.money.textContent === '$0.25 / $2' && s.hand.textContent.includes('손 들기') && s.clipLabel.textContent.includes('붙여넣기 막힘'));
  const c = s.hits('/__lab/me')[0];
  check('presence fields and existing values unchanged', JSON.stringify(c.body) === JSON.stringify({ tab: 'known-tab', idle: 0, vis: 'visible', focus: true, watch: true }));
  check('fixed POST and cookie auth without custom authority', c.init.method === 'POST' && c.init.cache === 'no-store' && Object.keys(c.init.headers).join() === 'content-type' && !('credentials' in c.init));
  check('public __labBarUI contract unchanged', Object.keys(s.context.__labBarUI).join() === 'box,note,el,BTN');
  s.fold.click(); check('fold still hides actions and persists choice', s.download.style.display === 'none' && s.fold.textContent === '+');
  s.fold.click(); s.home.click(); check('home stays fixed same-origin with no query', s.context.location.href === '/__lab/home' && s.download.style.display === '');
  s.hand.click(); s.hand.onclick(); await s.flush();
  check('hand posts captured intended state once and refreshes status', s.hits('/__lab/hand').length === 1 && s.hits('/__lab/hand')[0].body.up === true && s.hits('/__lab/me').length === 2 && !s.hand.disabled);
  s.download.click(); s.download.onclick(); await s.flush();
  check('normal export preserves fixed encoded-ticket download and restores button', s.hits('/__lab/export').length === 1 && s.downloads.length === 1 && s.downloads[0].href === '/__lab/export/test-ticket' && s.downloads[0].name === 'work.zip' && s.download.textContent === '⬇ 내 작업 받기' && !s.download.disabled);
  check('ticket not added to notification or presence', !s.message.textContent.includes('test-ticket') && s.hits('/__lab/me').every(x => !JSON.stringify(x.body).includes('test-ticket')));
  s.state.name = '<img src=x onerror=oops()>'; await s.advance(30000);
  check('server text remains literal DOM text', s.context.__labBarUI.box.title.includes('<img src=x') && s.nodes.every(n => n.tag !== 'img'));
}
// Status singleflight, hung fetch, ignored abort and old response after newer status.
{
  const s = scene({ initial: { fetch: 'hang' } });
  await s.advance(9000); s.visible(); s.visible(); await s.flush();
  check('visibility cannot overlap pending status', s.hits('/__lab/me').length === 1);
  await s.advance(1000); const old = s.hits('/__lab/me')[0];
  check('hung fetch closes at 10 seconds and aborts', old.signal.aborted && old.aborts === 1 && s.time.textContent.includes('지연'));
  check('failed initial poll retains previous enforced and displayed clip restriction', s.clip.policy.in === false && s.clipLabel.textContent.includes('붙여넣기 막힘') && s.clipUpdates.length === 0);
  await s.advance(1001); s.state.usage = 0.5; s.state.clip = { in: false, out: false }; s.visible(); await s.flush();
  check('next status recovers time and usage', s.hits('/__lab/me').length === 2 && s.time.textContent.includes('남음') && s.money.textContent === '$0.50 / $2');
  old.respond({ ...s.state, usage: 99, hand: true, clip: { in: true, out: true } }); await s.flush();
  check('ignored-abort late fetch never reads body or overwrites recovered status', old.jsonCalls === 0 && s.money.textContent === '$0.50 / $2' && s.clip.policy.in === false && s.clip.policy.out === false && s.hand.textContent.includes('손 들기'));
}
// Slow headers consume the same budget as JSON, rather than granting a new body deadline.
{
  const s = scene({ initial: { after: 9000, json: 'hang' } });
  await s.advance(9000); const status = s.hits('/__lab/me')[0];
  check('slow status headers begin body reading inside original budget', status.jsonCalls === 1 && !status.signal.aborted);
  await s.advance(1000); check('slow headers plus hung status body still stop at total 10s', status.signal.aborted && s.time.textContent.includes('지연'));
  s.plans['/__lab/export'].push({ after: EXPORT - 1000, json: 'hang' }); s.download.click(); await s.flush();
  await s.advance(EXPORT - 1000); const exp = s.hits('/__lab/export')[0];
  check('slow ZIP headers begin body reading with only remaining budget', exp.jsonCalls === 1 && s.download.disabled && !exp.signal.aborted);
  await s.advance(1000); check('slow headers plus hung export body stop at total 5min', exp.signal.aborted && !s.download.disabled && s.downloads.length === 0);
}
// One deadline spans both headers and JSON; an older body cannot win an out-of-order race.
{
  const s = scene({ initial: { json: 'hang' } }); await s.flush(); const old = s.hits('/__lab/me')[0];
  check('body reading is included in the pending request', old.jsonCalls === 1);
  await s.advance(SHORT); check('hung status JSON is bounded', old.signal.aborted && s.time.textContent.includes('지연'));
  await s.advance(1001); s.state.usage = 0.75; s.visible(); await s.flush();
  old.resolveJSON({ ...s.state, usage: 88, clip: { in: true, out: true } }); await s.flush();
  check('late old JSON cannot overwrite newer usage or loosen clipboard', s.money.textContent === '$0.75 / $2' && s.clip.policy.in === false);
  s.plans['/__lab/me'].push({ status: 503, value: { error: 'down' } }); await s.advance(19000);
  check('failed poll clears stale time, money and identity while policy stays enforced', s.time.textContent.includes('지연') && s.money.textContent === '' && !s.context.__labBarUI.box.title.includes('참가자') && s.clip.policy.in === false && s.clipLabel.title.includes('마지막'));
  s.plans['/__lab/me'].push({ value: { ...s.state, clip: {} } }); await s.advance(30000);
  check('malformed clipboard status cannot turn previous restriction into permission', s.clip.policy.in === false && s.time.textContent.includes('지연'));
  await s.advance(30000); check('fresh success clears stale poll display', s.time.textContent.includes('남음') && s.clipLabel.title.includes('모임지기가 정한'));
}
// A status started before a hand mutation cannot repaint hand, usage or policy afterwards.
{
  const s = scene(); await s.flush();
  s.plans['/__lab/me'].push({ json: 'hang' }); await s.advance(30000); const old = s.hits('/__lab/me')[1];
  s.state.hand = true; s.state.usage = 1; s.state.clip = { in: false, out: false };
  s.hand.click(); await s.flush();
  check('hand success shows captured intended state and restores action immediately', !s.hand.disabled && s.hand.textContent.includes('손 내리기') && s.hits('/__lab/hand')[0].body.up === true);
  check('post-hand status refresh waits for existing singleflight', s.hits('/__lab/me').length === 2);
  old.resolveJSON({ ...s.state, hand: false, usage: 99, clip: { in: true, out: true } }); await s.flush();
  check('old status discarded then exactly one fresh post-hand read', s.hits('/__lab/me').length === 3 && s.hand.textContent.includes('손 내리기') && s.money.textContent === '$1.00 / $2' && s.clip.policy.in === false && s.clip.policy.out === false);
}
// Polls during a pending mutation cannot change the captured toggle target.
{
  const s = scene(); await s.flush(); await s.advance(29000);
  s.plans['/__lab/hand'].push({ fetch: 'hang' }); s.hand.click(); await s.flush();
  s.state.hand = true; s.state.usage = 9; await s.advance(1000);
  check('status during hand mutation does not repaint pending state', s.hand.disabled && s.hand.textContent.includes('손 들기') && s.money.textContent === '$0.25 / $2');
  s.hits('/__lab/hand')[0].respond({ hand: true }); await s.flush();
  check('hand completion uses captured up instead of toggling mutable poll result', !s.hand.disabled && s.hand.textContent.includes('손 내리기') && s.hits('/__lab/hand')[0].body.up === true);
}
// Aborting is a bounded wait, not proof that a mutating request failed on the server.
for (const bodyHang of [false, true]) {
  const s = scene(); await s.flush();
  s.plans['/__lab/hand'].push(bodyHang ? { json: 'hang' } : { fetch: 'hang', respectAbort: true });
  s.hand.click(); s.hand.onclick(); await s.flush(); const old = s.hits('/__lab/hand')[0]; s.state.hand = true;
  await s.advance(SHORT);
  check('hung hand ' + (bodyHang ? 'JSON' : 'fetch') + ' restores button and marks result uncertain', !s.hand.disabled && old.signal.aborted && s.message.textContent.includes('확인하지 못했습니다') && s.message.textContent.includes('바뀌었을 수도'));
  check('hand timeout reads server status without automatic mutation retry', s.hits('/__lab/hand').length === 1 && s.hits('/__lab/me').length === 2 && s.hand.textContent.includes('손 내리기'));
  s.state.hand = false; s.hand.click(); await s.flush();
  if (bodyHang) old.resolveJSON({ hand: true }); else old.respond({ hand: true }); await s.flush();
  check('late timed-out hand never overwrites next confirmed action', s.hits('/__lab/hand').length === 2 && s.hand.textContent.includes('손 들기') && !s.hand.disabled);
}
// Export has a longer bound matching ZIP preparation and includes hung bodies; no late download.
for (const bodyHang of [false, true]) {
  const s = scene(); await s.flush(); s.plans['/__lab/export'].push(bodyHang ? { json: 'hang' } : { fetch: 'hang' });
  s.download.click(); s.download.onclick(); await s.flush(); const old = s.hits('/__lab/export')[0];
  await s.advance(260000);
  check('ZIP ' + (bodyHang ? 'JSON' : 'fetch') + ' allowed more time than server 240s packaging', s.download.disabled && !old.signal.aborted && s.hits('/__lab/export').length === 1);
  await s.advance(EXPORT - 260000);
  check('hung export ' + (bodyHang ? 'JSON' : 'fetch') + ' restores button after 5min with uncertainty message', !s.download.disabled && s.download.textContent === '⬇ 내 작업 받기' && old.signal.aborted && s.message.textContent.includes('확인하지 못했습니다') && s.message.textContent.includes('끝났을 수도') && s.downloads.length === 0);
  check('export timeout never retries POST automatically', s.hits('/__lab/export').length === 1);
  s.download.click(); await s.flush();
  if (bodyHang) old.resolveJSON({ ticket: 'late-ticket', name: 'late.zip' }); else old.respond({ ticket: 'late-ticket', name: 'late.zip' }); await s.flush();
  check('late export result ignored after successful explicit retry', s.downloads.length === 1 && s.downloads[0].name === 'work.zip' && !s.download.disabled);
}
// Rejection and malformed-body paths restore both actions, without network or authority changes.
for (const plan of [{ fetch: 'reject' }, { json: 'bad' }, { status: 403, value: { error: '거절' } }]) {
  const s = scene(); await s.flush(); s.plans['/__lab/hand'].push(plan); s.hand.click(); await s.flush();
  check('hand error restores button and performs one status read', !s.hand.disabled && s.hits('/__lab/hand').length === 1 && s.hits('/__lab/me').length === 2 && s.message.textContent.length > 0);
  s.plans['/__lab/export'].push(plan); s.download.click(); await s.flush();
  check('export error restores label without a download', !s.download.disabled && s.download.textContent === '⬇ 내 작업 받기' && s.downloads.length === 0);
}
// Existing activity callbacks report elapsed time only; fallback listeners never capture input content.
{
  const s = scene({ noClip: true, folded: true }); await s.flush();
  check('saved folding survives initialization', s.fold.textContent === '+' && s.hand.style.display === 'none');
  await s.advance(12000); for (const f of s.winEvents.keydown || []) f({ isTrusted: false, key: 'secret' }); s.visible(); await s.flush();
  check('untrusted input does not update idle', s.hits('/__lab/me').at(-1).body.idle === 12);
  await s.advance(11000); for (const f of s.winEvents.keydown || []) f({ isTrusted: true, key: 'secret' }); s.visible(); await s.flush();
  check('trusted input sends activity time only with unchanged presence fields', s.hits('/__lab/me').at(-1).body.idle === 0 && s.hits('/__lab/me').every(c => Object.keys(c.body).join() === 'tab,idle,vis,focus,watch' && !JSON.stringify(c.body).includes('secret')));
}
// The server clock controls file-saving reminders even when the laptop clock differs.
{
  const serverNow = T0 - 3600000;
  const s = scene({ initial: { value: { now: serverNow, expiresAt: serverNow + 240000, seat: 1, usage: null, hand: false } } }); await s.flush();
  check('server clock offset preserves remaining time and the unverified five-minute reminder', s.time.textContent.includes('4분 남음') && s.message.textContent.includes('5분 안에'));
  const verified = scene({ initial: { value: { now: serverNow, expiresAt: serverNow + 59000, seat: 1, usage: null, hand: false, files: { transfer: { id: 'e0000000-0000-4000-8000-000000000001', at: serverNow - 1000, verifiedAt: serverNow - 500, checkpoint: false } } } } }); await verified.flush();
  check('final minute still reminds a previously verified participant to save later edits', verified.message.textContent.includes('1분 안에') && verified.message.textContent.includes('확인 표시 이후'));
}
console.log(`\nlab-bar-recovery-ui: ${checks}/${checks} passed (VM; no network)`);
