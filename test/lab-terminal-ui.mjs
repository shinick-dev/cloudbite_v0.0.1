// In-memory DOM/API contract: no browser, server, sandbox, or network connection.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { LAB_TERMINAL_JS } from '../src/labterminal.ts';
import { LAB_BAR_JS } from '../src/labbar.ts';
import { labPage } from '../src/pages.ts';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  append(...items) { for (const item of items) { if (typeof item !== 'string') { item.remove(); item.parentElement = this; } this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children = p.children.filter(x => x !== this); this.parentElement = null; } }
  get lastChild() { return this.children.at(-1); }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(type, fn) { this['on' + type] = fn; }
  insertBefore(item, before) { item.remove(); item.parentElement = this; this.children.splice(this.children.indexOf(before), 0, item); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  contains(e) { return this === e || this.children.some(c => typeof c !== 'string' && c.contains(e)); }
  focus() { document.activeElement = this; }
}
const document = { createElement: tag => new Element(tag), addEventListener() {}, body: new Element('body') };
const ctx = vm.createContext({ document, crypto: webcrypto, setTimeout, clearTimeout });
vm.runInContext(LAB_TERMINAL_JS, ctx);
new vm.Script(LAB_BAR_JS); // Includes the inline student connection dialog.
const requests = [];
let failSend = false, failStart = false, sendGate = null, statusReply = { active: false };
const deps = {
  cleanErr: x => String(x), copy: async () => {},
  btn(t, cls, f) { const b = new Element('button'); b.textContent = t; b.onclick = f; return b; },
  async call(path, body) {
    requests.push({ path, body: structuredClone(body) });
    if (path.endsWith('/status')) return statusReply;
    if (path.endsWith('/takeover')) return { active: true, sessionId: body.sessionId, seats: [{ n: 1, status: 'ready' }, { n: 2, status: 'ready' }] };
    if (path.endsWith('/start')) { if (failStart) throw new Error('lost response'); return { active: true, sessionId: 'lesson-session', seats: [{ n: 1, status: 'ready' }, { n: 2, status: 'error', note: '<img src=x>' }] }; }
    if (path.endsWith('/send')) { if (sendGate) await sendGate; if (failSend) throw new Error('lost response'); return { requestId: body.requestId, results: [{ n: 1, status: 'sent' }, { n: 2, status: 'unknown', note: '<script>bad()</script>' }] }; }
    if (path.endsWith('/stop')) return { ok: true };
    throw new Error('unmocked path');
  },
};
const terminal = ctx.createLabTerminal(deps);
const lab = { id: 'labA', seats: [{ n: 1, who: '참가자' }, { n: 2 }, { n: 3, error: 'failed' }] };
const box = terminal.box(lab);
const all = (node, tag) => [node, ...node.children.flatMap(c => typeof c === 'string' ? [] : all(c, tag))].filter(e => e.tagName === tag);
const button = text => all(box, 'button').find(b => b.textContent === text);
const inputs = all(box, 'input');
assert.equal(requests.length, 0, 'collapsed module makes no requests');
assert.ok(inputs.every(i => !i.checked), 'all participants initially unselected');
assert.equal(inputs[2].disabled, true, 'failed seat cannot be selected');
assert.equal(button('선택한 자리에서 시작').disabled, true);
inputs[0].checked = true; inputs[1].checked = true; inputs[0].onchange();
failStart = true; await button('선택한 자리에서 시작').onclick();
assert.ok(inputs[0].disabled, 'uncertain start freezes selection');
const startId = requests.at(-1).body.requestId;
failStart = false; await button('같은 시작 요청 다시 확인').onclick();
assert.equal(requests.at(-1).body.requestId, startId, 'start retry uses same id');
assert.deepEqual(requests.at(-1).body.seats, [1, 2]);
assert.match(box.textContent, /2번 · 실패/);
const command = all(box, 'textarea')[0];
command.value = 'pwd\nls'; command.oninput();
const before = requests.length;
await button('명령 보내기').onclick();
assert.equal(requests.length, before, 'multiline is rejected before calling server');
command.value = 'pw\td'; command.oninput();
await button('명령 보내기').onclick();
assert.equal(requests.length, before, 'tab completion input is rejected before calling server');
assert.match(box.textContent, /줄바꿈·탭 없이 한 줄로/);
command.value = 'pwd'; command.oninput();
failSend = true; await button('명령 보내기').onclick();
const sendId = requests.at(-1).body.requestId;
assert.equal(command.disabled, true, 'uncertain send preserves original command');
failSend = false; await button('같은 명령 다시 확인').onclick();
assert.equal(requests.at(-1).body.requestId, sendId, 'send retry uses same id');
assert.match(box.textContent, /2번 · 확인 필요/);
assert.equal(all(box, 'script').length, 0, 'hostile server notes remain text');
assert.equal(all(box, 'img').length, 0);
assert.equal(terminal.box(lab), box, 'rerender keeps element and command draft');
assert.equal(command.value, 'pwd');
// New admin token requires an explicit takeover and keeps the exact pending command ID.
failSend = true; await button('명령 보내기').onclick();
const pendingBeforeTakeover = requests.at(-1).body.requestId;
statusReply = { active: true, sessionId: 'lesson-session', needsTakeover: true, seats: [{ n: 1, status: 'ready' }, { n: 2, status: 'ready' }] };
await button('상태 확인').onclick();
assert.equal(button('같은 명령 다시 확인').disabled, true);
assert.equal(button('이 관리 세션에서 이어받기').hidden, false);
await button('이 관리 세션에서 이어받기').onclick();
assert.equal(requests.at(-1).path, '/api/lab/terminal/takeover');
assert.equal(button('같은 명령 다시 확인').disabled, false);
// If another tab stopped it, preserve the ID and fetch only its cached result.
statusReply = { active: false, sessionId: 'lesson-session' };
await button('상태 확인').onclick();
assert.equal(button('명령 결과 확인').disabled, false);
assert.equal(command.value, 'pwd');
failSend = false; await button('명령 결과 확인').onclick();
assert.equal(requests.at(-1).body.requestId, pendingBeforeTakeover);
assert.equal(requests.at(-1).body.sessionId, 'lesson-session');
statusReply = { active: true, sessionId: 'lesson-session', seats: [{ n: 1, status: 'ready' }] };
await button('상태 확인').onclick();
let releaseSend;
sendGate = new Promise(resolve => { releaseSend = resolve; });
const sending = button('명령 보내기').onclick();
const racingId = requests.at(-1).body.requestId;
assert.equal(button('새 명령 전송 중지').disabled, false, 'stop stays enabled while send awaits response');
await button('새 명령 전송 중지').onclick();
assert.match(box.textContent, /이미 실행 중인 명령과 수업 터미널은 그대로 유지/);
releaseSend(); await sending; sendGate = null;
assert.ok(!box.textContent.includes('전송 중 · 대상'), 'late send does not reactivate a stopped session');
assert.match(box.textContent, /이미 실행 중인 명령과 수업 터미널은 그대로 유지/, 'late send keeps stop acknowledgement');
assert.equal(button('명령 결과 확인').disabled, false, 'late send preserves pending ID for cached result confirmation');
await button('명령 결과 확인').onclick();
assert.equal(requests.at(-1).body.requestId, racingId, 'post-stop confirmation uses original send ID');
assert.equal(button('명령 보내기').disabled, true);
assert.ok(!requests.some(r => /kill|interrupt/.test(r.path)), 'stop never interrupts an existing command');
const page = labPage();
assert.match(page, /createLabTerminal/);
assert.match(page, /terminalBox:lab=>LT.box/);
assert.match(LAB_BAR_JS, /value.active === true && value.selected === true && value.ready === true/);
assert.match(LAB_BAR_JS, /tmux -u attach -r -t gw-lesson/);
// Student bar reads the real /__lab/me contract and reveals a copyable connection dialog.
const intervals = [];
const studentDoc = { createElement: tag => new Element(tag), body: new Element('body'), addEventListener() {}, hasFocus: () => true, visibilityState: 'visible' };
const storage = { getItem: () => null, setItem() {} };
let lesson = { active: true, selected: true, ready: true }, copied;
const student = vm.createContext({
  document: studentDoc, window: { addEventListener() {} }, localStorage: storage, sessionStorage: storage,
  navigator: { clipboard: { async writeText(t) { copied = t; } } },
  Date, Math, JSON, AbortController, setTimeout: () => 1, clearTimeout() {}, setInterval: f => intervals.push(f),
  async fetch(path) { assert.equal(path, '/__lab/me'); return { ok: true, async json() { return { expiresAt: Date.now() + 3600000, lesson }; } }; },
});
vm.runInContext(LAB_BAR_JS, student);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
await flush();
const lessonButton = all(studentDoc.body, 'button').find(b => b.textContent === '수업 터미널');
assert.equal(lessonButton.style.display, '');
lessonButton.onclick();
const dialog = all(studentDoc.body, 'dialog')[0];
assert.equal(dialog.open, true);
assert.match(dialog.textContent, /Ctrl\+Shift\+백틱/);
assert.match(dialog.textContent, /수업 따라보기/);
await all(dialog, 'button').find(b => b.textContent === '연결 명령 복사').onclick();
assert.equal(copied, 'tmux -u attach -r -t gw-lesson');
lesson = { active: true, selected: false, ready: true };
intervals[0](); await flush();
assert.equal(lessonButton.style.display, 'none', 'nonselected student is not prompted to attach');
assert.equal(dialog.open, false);
console.log('lab-terminal-ui: selection, retry IDs, validation, partial failure, safe text, stop, student dialog syntax passed');
