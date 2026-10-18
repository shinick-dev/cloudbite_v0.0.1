// 네트워크 없이 보조 권한 서비스 번들과 직렬 메모리 저장소만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/lab-assistant-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const controlBundle = await build({ entryPoints: ['src/lab-control-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const C = await import('data:text/javascript;base64,' + Buffer.from(controlBundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };

const ADMIN = 'admin-secret-token';
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const copy = (x) => x === undefined ? x : structuredClone(x);
async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function grantInput(over = {}) {
  return {
    id: 'lab', label: '도우미', seats: [1, 2, 3], scopes: [...M.ASSISTANT_SCOPES], minutes: 30,
    templates: [{ title: '안내', text: 'template-secret-text' }], ...over,
  };
}
function who(n = 1, code = `seat-secret-${n}`, labId = 'lab') { return { labId, n, seatCode: code }; }
function world(opts = {}) {
  const data = new Map();
  const clock = { t: 1800000000000 };
  let lock = Promise.resolve();
  let adminChecks = 0;
  const lab = {
    id: 'lab', name: '수업', createdAt: clock.t, expiresAt: clock.t + 3600000,
    budget: 1, cpu: 1, memory: 1, disk: 1, snapshot: 's', model: 'm', gw: '',
    seats: Array.from({ length: opts.seats ?? 3 }, (_, i) => ({ n: i + 1, code: `seat-secret-${i + 1}` })),
  };
  data.set('lab:lab', structuredClone(lab));
  const other = structuredClone(lab);
  other.id = 'other';
  data.set('lab:other', other);
  const storage = {
    labGets: 0, failGet: false, failPut: false, failAdminOnSecond: false, armExpiryOnSecondLabGet: false,
    armGrantExpiryOnControl: false, grantExpiry: 0, leak: '',
    async get(k) {
      if (storage.failGet) throw new Error('secret ' + (storage.leak || ADMIN));
      if (storage.armExpiryOnSecondLabGet && k === 'lab:lab') {
        storage.labGets++;
        if (storage.labGets >= 2) clock.t = lab.expiresAt;
      }
      if (storage.armGrantExpiryOnControl && k === 'labctrl:lab') clock.t = storage.grantExpiry;
      return copy(data.get(k));
    },
    async put(k, v) { if (storage.failPut) throw new Error('secret ' + (storage.leak || ADMIN)); data.set(k, copy(v)); },
    async delete(k) { data.delete(k); },
    async list(opts = {}) {
      const prefix = opts.prefix ?? '';
      const out = new Map();
      for (const [k, v] of data) if (k.startsWith(prefix)) out.set(k, copy(v));
      return out;
    },
    transaction(fn) { const run = lock.then(() => fn(storage)); lock = run.catch(() => {}); return run; },
  };
  const deps = {
    storage, now: () => clock.t,
    checkAdmin: async (token) => {
      adminChecks++;
      if (storage.failAdminOnSecond && adminChecks >= 2) return false;
      return token === ADMIN;
    },
  };
  return { data, lab, clock, storage, make: () => new M.LabAssistantService(deps) };
}
function controlOf(w) {
  return new C.LabControlService({
    storage: w.storage, now: () => w.clock.t, checkAdmin: async (token) => token === ADMIN,
    lab: async (id) => {
      const row = w.data.get('lab:' + id);
      return row && row.id === id ? { id: row.id, expiresAt: row.expiresAt, ...(row.endRetry ? { endRetry: row.endRetry } : {}) } : undefined;
    },
    audit: async () => {},
  });
}
function owned(data) {
  let text = '';
  for (const [k, v] of data) if (k.startsWith('labassist') || k.startsWith('labhelp') || k.startsWith('labctrl')) text += JSON.stringify(v);
  return text;
}
const assistKeys = (data) => [...data.keys()].filter((k) => k.startsWith('labassist') || k.startsWith('labhelp') || k.startsWith('labctrl'));

let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('ok', name); }

await test('scope list and issue validation write nothing', async () => {
  assert.deepEqual([...M.ASSISTANT_SCOPES], ['status:read', 'help:read', 'help:reply', 'template:send', 'control:pause']);
  const w = world(), s = w.make();
  const reject = async (input, status = 400) => {
    const out = await s.issue(ADMIN, input);
    assert.equal(out.status, status, JSON.stringify(out));
    assert.deepEqual(assistKeys(w.data), []);
  };
  await reject({ ...grantInput(), extra: 1 });
  await reject(grantInput({ label: '' }));
  await reject(grantInput({ label: '가'.repeat(61) }));
  await reject(grantInput({ seats: [] }));
  await reject(grantInput({ seats: [1, 1] }));
  await reject(grantInput({ seats: [4] }));
  await reject(grantInput({ seats: [0] }));
  await reject(grantInput({ seats: ['1'] }));
  await reject(grantInput({ scopes: ['help:read'] }));
  await reject(grantInput({ scopes: ['status:read', 'help:reply'] }));
  await reject(grantInput({ scopes: ['status:read', 'status:read'] }));
  await reject(grantInput({ scopes: ['status:read', 'nope'] }));
  await reject(grantInput({ scopes: ['status:read', 'template:send'], templates: [] }));
  await reject(grantInput({ minutes: 4 }));
  await reject(grantInput({ minutes: 121 }));
  await reject(grantInput({ minutes: 5.5 }));
  await reject(grantInput({ templates: Array.from({ length: 9 }, () => ({ title: '제목', text: '본문' })) }));
  await reject(grantInput({ templates: [{ title: '제목', text: '본'.repeat(8001) }] }));
  await reject(grantInput({ templates: [{ title: '', text: '본문' }] }));
  await reject(grantInput({ templates: [{ title: '제목', text: '본문', extra: 1 }] }));
  await reject(grantInput({ templates: [
    { title: '가', text: '가'.repeat(8000) }, { title: '나', text: '나'.repeat(8000) },
    { title: '다', text: '다'.repeat(8000) }, { title: '라', text: '라'.repeat(4000) },
  ] }));
  await reject({ id: 'lab' }, 400);
  w.data.get('lab:lab').seats[0].error = 'failed';
  await reject(grantInput({ seats: [1] }));
  w.data.get('lab:lab').seats[0].error = undefined;
  assert.equal((await s.issue('nope', grantInput())).status, 401);
  assert.equal((await s.ask({ labId: 'lab' }, { requestId: uuid(1), question: 'q' })).status, 400);
  assert.deepEqual(assistKeys(w.data), []);
});

await test('issue keeps only the sha256 hex and returns the token once', async () => {
  const w = world(), s = w.make();
  const early = await s.issue(ADMIN, grantInput({ minutes: 5, seats: [1, 2, 3] }));
  assert.equal(early.grant.expiresAt, w.clock.t + 5 * 60_000);
  const issued = await s.issue(ADMIN, grantInput({ minutes: 120 }));
  assert.ok(issued.token);
  assert.match(issued.token, /^la_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.grant.expiresAt, w.lab.expiresAt);
  assert.equal(issued.grant.revokedAt, null);
  assert.match(issued.grant.id, /^ag_[0-9a-f-]{36}$/);
  assert.match(issued.grant.templates[0].id, /^tp_[0-9a-f-]{36}$/);
  const hash = await sha256(issued.token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(w.data.get('labassist-token:' + hash), issued.grant.id);
  const stored = w.data.get('labassist:' + issued.grant.id);
  assert.equal(stored.tokenHash, hash);
  assert.equal(stored.token, undefined);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  const listed = await s.list(ADMIN, 'lab');
  assert.equal(listed.grants.length, 2);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);
  assert.equal(JSON.stringify(listed).includes('tokenHash'), false);
  assert.deepEqual(Object.keys(listed.grants[0]).sort(), ['createdAt', 'expiresAt', 'id', 'labId', 'label', 'revokedAt', 'scopes', 'seats', 'templates']);
  const auth = await s.authorize(issued.token, 'lab', 'status:read');
  assert.equal(auth.grant.id, issued.grant.id);
  assert.equal(JSON.stringify(auth).includes(issued.token), false);
  assert.equal((await s.authorize(ADMIN, 'lab', 'status:read')).status, 401);
  assert.equal((await s.authorize(issued.token, 'lab', 'not-a-scope')).status, 400);
  const revived = w.make();
  assert.equal((await revived.authorize(issued.token, 'lab', 'help:read')).grant.id, issued.grant.id);
  const items = await revived.audit(ADMIN, 'lab');
  assert.equal(items.items.length, 2);
  assert.equal(items.items.every((item) => item.action === 'issue' && !('token' in item)), true);
  assert.equal(owned(w.data).includes(issued.token), false);
  assert.equal(owned(w.data).includes('seat-secret-1'), false);
});

await test('cross-lab and cross-seat calls are refused', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput({ seats: [1], scopes: ['status:read', 'help:read', 'help:reply', 'template:send'] }));
  const token = issued.token;
  assert.equal((await s.authorize(token, 'other', 'status:read')).status, 403);
  assert.equal((await s.questions(token, 'other')).status, 403);
  assert.equal((await s.pause(token, 'other', { requestId: uuid(1), reason: '이유' })).status, 403);
  assert.deepEqual((await s.list(ADMIN, 'other')).grants, []);
  const revoked = await s.revoke(ADMIN, 'other', issued.grant.id);
  assert.equal(revoked.status, 403);
  assert.equal(w.data.get('labassist:' + issued.grant.id).revokedAt, null);
  await s.ask(who(1), { requestId: uuid(2), question: 'question-secret-text' });
  await s.ask(who(2), { requestId: uuid(3), question: 'other-seat-question' });
  const seen = await s.questions(token, 'lab');
  assert.deepEqual(seen.questions.map((q) => q.n), [1]);
  assert.equal(JSON.stringify(seen).includes('other-seat-question'), false);
  assert.equal((await s.reply(token, 'lab', { requestId: uuid(4), questionId: (await s.participant(who(2))).questions[0].id, text: '답' })).status, 403);
  assert.equal((await s.sendTemplate(token, 'lab', { requestId: uuid(5), templateId: issued.grant.templates[0].id, n: 2 })).status, 403);
  assert.equal(w.data.has('labassist-msg:lab'), false);
});

await test('revoke is durable across reconstruction and blocks replay', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput());
  const paused = await s.pause(issued.token, 'lab', { requestId: uuid(1), reason: 'reason-secret-text' });
  assert.equal(paused.control.mode, 'paused');
  const revision = w.data.get('labctrl:lab').revision;
  const done = await s.revoke(ADMIN, 'lab', issued.grant.id);
  assert.equal(done.ok, true);
  assert.equal(typeof done.grant.revokedAt, 'number');
  const again = await w.make().revoke(ADMIN, 'lab', issued.grant.id);
  assert.equal(again.grant.revokedAt, done.grant.revokedAt);
  assert.equal((await w.make().audit(ADMIN, 'lab')).items.filter((item) => item.action === 'revoke').length, 1);
  const late = await w.make().pause(issued.token, 'lab', { requestId: uuid(1), reason: 'reason-secret-text' });
  assert.equal(late.status, 401);
  assert.equal(late.control, undefined);
  assert.equal(w.data.get('labctrl:lab').revision, revision);
  assert.equal((await w.make().authorize(issued.token, 'lab', 'status:read')).status, 401);
});

await test('expiry, class end, and stop tombstone reject live checks', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput({ minutes: 5 }));
  const asked = await s.ask(who(1), { requestId: uuid(1), question: 'question-secret-text' });
  w.data.set('labassist-stop:other', true);
  assert.equal((await s.authorize(issued.token, 'lab', 'status:read')).grant.id, issued.grant.id);
  w.data.set('labassist-stop:lab', true);
  for (const out of [
    await s.authorize(issued.token, 'lab', 'status:read'),
    await s.participant(who(1)),
    await s.ask(who(1), { requestId: uuid(2), question: '다음' }),
    await s.questions(issued.token, 'lab'),
    await s.pause(issued.token, 'lab', { requestId: uuid(3), reason: '이유' }),
  ]) {
    assert.equal(out.status, 410);
    assert.equal(JSON.stringify(out).includes('question-secret-text'), false);
    assert.equal(JSON.stringify(out).includes(issued.token), false);
  }
  w.data.delete('labassist-stop:lab');
  w.data.get('lab:lab').endRetry = 1;
  assert.equal((await s.participant(who(1))).status, 410);
  assert.equal((await s.authorize(issued.token, 'lab', 'help:read')).status, 410);
  delete w.data.get('lab:lab').endRetry;
  w.clock.t = issued.grant.expiresAt;
  const late = await s.pause(issued.token, 'lab', { requestId: uuid(4), reason: '이유' });
  assert.equal(late.status, 401);
  assert.equal(w.data.has('labctrl:lab'), false);
  const mine = await s.participant(who(1));
  assert.equal(mine.enabled, false);
  assert.equal(mine.questions[0].id, asked.question.id);
  assert.equal(JSON.stringify(mine).includes('seat-secret-1'), false);
});

await test('admin and lab expiry at the write boundary store nothing', async () => {
  const w = world(), s = w.make();
  w.storage.failAdminOnSecond = true;
  assert.equal((await s.issue(ADMIN, grantInput())).status, 401);
  assert.deepEqual(assistKeys(w.data), []);
  const w2 = world(), s2 = w2.make();
  w2.storage.armExpiryOnSecondLabGet = true;
  assert.equal((await s2.issue(ADMIN, grantInput())).status, 410);
  assert.deepEqual(assistKeys(w2.data), []);
  const w3 = world(), s3 = w3.make();
  const issued = await s3.issue(ADMIN, grantInput({ minutes: 5 }));
  w3.storage.labGets = 0;
  w3.storage.armExpiryOnSecondLabGet = true;
  assert.equal((await s3.ask(who(1), { requestId: uuid(1), question: 'question-secret-text' })).status, 410);
  assert.equal(w3.data.has('labhelp:lab'), false);
  w3.storage.armExpiryOnSecondLabGet = false;
  w3.clock.t = w3.lab.createdAt;
  w3.storage.grantExpiry = issued.grant.expiresAt;
  w3.storage.armGrantExpiryOnControl = true;
  const paused = await s3.pause(issued.token, 'lab', { requestId: uuid(2), reason: 'reason-secret-text' });
  assert.equal(paused.status, 401);
  assert.equal(w3.data.has('labctrl:lab'), false);
  assert.equal(owned(w3.data).includes('reason-secret-text'), false);
});

await test('help replies stay answered until the current participant resolves', async () => {
  const w = world(), s = w.make();
  w.data.get('lab:lab').seats[0].hand = 12345;
  const before = JSON.stringify(w.data.get('lab:lab'));
  const issued = await s.issue(ADMIN, grantInput());
  const token = issued.token;
  const first = await s.ask(who(1), { requestId: uuid(1), question: 'question-secret-text' });
  const replay = await s.ask(who(1), { requestId: uuid(1), question: 'question-secret-text' });
  assert.equal(replay.question.id, first.question.id);
  assert.equal((await s.ask(who(1), { requestId: uuid(1), question: '다른 질문' })).status, 409);
  assert.equal(w.data.get('labhelp:lab').length, 1);
  assert.equal('seatHash' in first.question, false);
  assert.equal('askRequestId' in first.question, false);
  const open = await s.resolve(who(1), { requestId: uuid(2), questionId: first.question.id });
  assert.equal(open.status, 409);
  const replied = await s.reply(token, 'lab', { requestId: uuid(3), questionId: first.question.id, text: '답변입니다' });
  assert.equal(replied.question.status, 'answered');
  assert.equal(replied.question.reply, '답변입니다');
  assert.notEqual(replied.question.status, 'resolved');
  assert.deepEqual(await s.reply(token, 'lab', { requestId: uuid(3), questionId: first.question.id, text: '답변입니다' }), replied);
  assert.equal((await s.reply(token, 'lab', { requestId: uuid(3), questionId: first.question.id, text: '다른 답' })).status, 409);
  assert.equal((await s.reply(token, 'lab', { requestId: uuid(4), questionId: first.question.id, text: '또 답' })).status, 409);
  assert.equal(w.data.get('labassist:' + issued.grant.id).operations.length, 1);
  assert.equal((await s.resolve(who(2), { requestId: uuid(5), questionId: first.question.id })).status, 404);
  assert.equal((await s.resolve(token, { requestId: uuid(5), questionId: first.question.id })).status, 400);
  const resolved = await s.resolve(who(1), { requestId: uuid(5), questionId: first.question.id });
  assert.equal(resolved.question.status, 'resolved');
  assert.deepEqual(await s.resolve(who(1), { requestId: uuid(5), questionId: first.question.id }), resolved);
  assert.equal((await s.resolve(who(1), { requestId: uuid(6), questionId: first.question.id })).status, 409);
  assert.equal(JSON.stringify(w.data.get('lab:lab')), before);
  const mine = await s.participant(who(1));
  assert.equal(mine.enabled, true);
  assert.equal(mine.questions.length, 1);
  assert.equal((await s.participant(who(2))).questions.length, 0);
  const onlyRead = await s.issue(ADMIN, grantInput({ label: '읽기', scopes: ['status:read'] }));
  assert.equal((await s.participant(who(1))).enabled, true);
  assert.equal((await s.questions(onlyRead.token, 'lab')).status, 403);
  assert.equal((await s.reply(onlyRead.token, 'lab', { requestId: uuid(7), questionId: first.question.id, text: '못 함' })).status, 403);
});

await test('a replaced seat code hides the previous occupant', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput());
  for (let n = 1; n <= 5; n++) assert.equal((await s.ask(who(1), { requestId: uuid(n), question: `question-secret-text-${n}` })).question.status, 'open');
  assert.equal((await s.ask(who(1), { requestId: uuid(6), question: '하나 더' })).status, 429);
  assert.equal(w.data.get('labhelp:lab').length, 5);
  const oldId = w.data.get('labhelp:lab')[0].id;
  w.data.get('lab:lab').seats[0].code = 'seat-secret-new';
  assert.equal((await s.participant(who(1))).status, 403);
  assert.equal((await s.resolve(who(1), { requestId: uuid(7), questionId: oldId })).status, 403);
  const fresh = await s.participant(who(1, 'seat-secret-new'));
  assert.deepEqual(fresh.questions, []);
  assert.equal(JSON.stringify(fresh).includes('question-secret-text-1'), false);
  const asked = await s.ask(who(1, 'seat-secret-new'), { requestId: uuid(8), question: '새 질문' });
  assert.equal(asked.question.question, '새 질문');
  const viewed = await s.questions(issued.token, 'lab');
  assert.deepEqual(viewed.questions.map((q) => q.question), ['새 질문']);
  assert.equal((await s.reply(issued.token, 'lab', { requestId: uuid(9), questionId: oldId, text: '늦은 답' })).status, 409);
  assert.equal(w.data.get('labhelp:lab')[0].status, 'open');
  const sent = await s.sendTemplate(issued.token, 'lab', { requestId: uuid(10), templateId: issued.grant.templates[0].id, n: 1 });
  assert.equal(sent.message.text, 'template-secret-text');
  assert.equal((await s.participant(who(1, 'seat-secret-new'))).messages.length, 1);
  w.data.get('lab:lab').seats[0].code = 'seat-secret-after';
  assert.deepEqual((await s.participant(who(1, 'seat-secret-after'))).messages, []);
  assert.equal(owned(w.data).includes('seat-secret-new'), false);
  assert.equal(owned(w.data).includes('seat-secret-1'), false);
});

await test('templates send only their frozen text to one allowed seat', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput({ seats: [1] }));
  const templateId = issued.grant.templates[0].id;
  assert.equal((await s.sendTemplate(issued.token, 'lab', { requestId: uuid(1), templateId, n: 1, text: '임의 문구' })).status, 400);
  assert.equal((await s.sendTemplate(issued.token, 'lab', { requestId: uuid(1), templateId: 'tp_' + uuid(99), n: 1 })).status, 404);
  const sent = await s.sendTemplate(issued.token, 'lab', { requestId: uuid(1), templateId, n: 1 });
  assert.equal(sent.message.text, 'template-secret-text');
  assert.equal(sent.message.n, 1);
  assert.equal(w.data.get('labassist-msg:lab')[0].text, 'template-secret-text');
  assert.equal(w.data.get('labassist-msg:lab').length, 1);
  assert.deepEqual(await s.sendTemplate(issued.token, 'lab', { requestId: uuid(1), templateId, n: 1 }), sent);
  assert.equal((await s.sendTemplate(issued.token, 'lab', { requestId: uuid(1), templateId, n: 2 })).status, 409);
  assert.equal(w.data.get('labassist-msg:lab').length, 1);
  assert.equal((await s.participant(who(1))).messages[0].text, 'template-secret-text');
  assert.equal((await s.participant(who(2))).messages.length, 0);
  const audit = JSON.stringify(await s.audit(ADMIN, 'lab'));
  assert.equal(audit.includes('template-secret-text'), false);
  assert.equal(audit.includes(issued.token), false);
  const noSend = await s.issue(ADMIN, grantInput({ label: '없음', scopes: ['status:read', 'help:read'], templates: [] }));
  assert.equal((await s.sendTemplate(noSend.token, 'lab', { requestId: uuid(2), templateId, n: 1 })).status, 403);
});

await test('pause covers every live seat and admin resume still works', async () => {
  const w = world(), s = w.make(), control = controlOf(w);
  const narrow = await s.issue(ADMIN, grantInput({ label: '일부', seats: [1], scopes: ['status:read', 'control:pause'], templates: [] }));
  assert.equal((await s.pause(narrow.token, 'lab', { requestId: uuid(1), reason: '일부' })).status, 403);
  assert.equal(w.data.has('labctrl:lab'), false);
  w.data.get('lab:lab').seats[1].error = 'bad';
  w.data.get('lab:lab').seats[2].error = 'bad';
  const partial = await s.pause(narrow.token, 'lab', { requestId: uuid(1), reason: '일부' });
  assert.equal(partial.control.mode, 'paused');
  assert.equal(partial.control.revision, 1);
  delete w.data.get('lab:lab').seats[1].error;
  delete w.data.get('lab:lab').seats[2].error;
  const issued = await s.issue(ADMIN, grantInput());
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(2), reason: '' })).status, 400);
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(2), reason: '가'.repeat(301) })).status, 400);
  const paused = await s.pause(issued.token, 'lab', { requestId: uuid(2), reason: 'reason-secret-text' });
  assert.equal(paused.control.revision, 2);
  assert.deepEqual(await s.pause(issued.token, 'lab', { requestId: uuid(2), reason: 'reason-secret-text' }), paused);
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(2), reason: '다른 이유' })).status, 409);
  const row = w.data.get(C.controlKey('lab'));
  assert.equal(row.mode, 'paused');
  assert.equal(row.revision, 2);
  assert.equal(row.actions.at(-1).id, `assistant:${issued.grant.id}:${uuid(2)}`);
  assert.equal(row.actions.at(-1).kind, 'pause');
  assert.equal(row.actions.at(-1).expectedRevision, null);
  assert.equal(JSON.stringify(row).includes('reason-secret-text'), false);
  assert.deepEqual(C.controlView(row), paused.control);
  assert.equal((await control.acquire('lab')).status, 409);
  assert.equal((await control.resume(ADMIN, 'lab', uuid(3), 1)).status, 409);
  const resumed = await control.resume(ADMIN, 'lab', uuid(4), paused.control.revision);
  assert.equal(resumed.mode, 'running');
  assert.equal(resumed.revision, 3);
  assert.equal(w.data.get('labctrl:lab').actions.some((a) => a.id.startsWith('assistant:')), true);
  assert.equal(s.resume, undefined);
  const audit = JSON.stringify(await s.audit(ADMIN, 'lab'));
  assert.equal(audit.includes('reason-secret-text'), false);
  assert.equal(audit.includes('pause'), true);
  assert.equal(owned(w.data).includes(issued.token), false);
  assert.equal(owned(w.data).includes('seat-secret-1'), false);
});

await test('ended, corrupt, and full control history reject pause', async () => {
  const w = world(), s = w.make();
  const issued = await s.issue(ADMIN, grantInput());
  w.data.set('labctrl:lab', { mode: 'nope' });
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(1), reason: '이유' })).status, 503);
  assert.deepEqual(w.data.get('labctrl:lab'), { mode: 'nope' });
  w.data.set('labctrl:lab', { mode: 'ended', revision: 4, updatedAt: 1, actions: [] });
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(1), reason: '이유' })).status, 410);
  assert.equal(w.data.get('labctrl:lab').revision, 4);
  assert.equal(w.data.get('labctrl:lab').actions.length, 0);
  const actions = Array.from({ length: 128 }, (_, i) => ({ id: uuid(i + 1), kind: 'pause', expectedRevision: null, response: { mode: 'paused', revision: 1, updatedAt: 1 } }));
  w.data.set('labctrl:lab', { mode: 'paused', revision: 9, updatedAt: 1, actions });
  assert.equal((await s.pause(issued.token, 'lab', { requestId: uuid(200), reason: '이유' })).status, 429);
  assert.equal(w.data.get('labctrl:lab').actions.length, 128);
  assert.equal(w.data.get('labctrl:lab').revision, 9);
});

await test('grant, question, message, and audit caps hold', async () => {
  const w = world(), s = w.make();
  let last;
  for (let n = 1; n <= 16; n++) last = await s.issue(ADMIN, grantInput({ label: `권한${n}` }));
  assert.equal((await s.issue(ADMIN, grantInput({ label: '초과' }))).status, 429);
  await s.revoke(ADMIN, 'lab', last.grant.id);
  assert.equal((await s.issue(ADMIN, grantInput({ label: '초과' }))).status, 429);
  assert.equal((await s.list(ADMIN, 'lab')).grants.length, 16);
  const seeded = Array.from({ length: 200 }, (_, i) => ({ at: i + 1, grantId: `ag_${uuid(i + 1)}`, action: 'issue' }));
  w.data.set('labassist-audit:lab', seeded);
  const one = await s.issue(ADMIN, grantInput({ label: '기록' }));
  assert.equal(one.status, 429);
  const auditLab = world(), audit = auditLab.make();
  auditLab.data.set('labassist-audit:lab', seeded);
  const issued = await audit.issue(ADMIN, grantInput({ label: '기록' }));
  const items = auditLab.data.get('labassist-audit:lab');
  assert.equal(items.length, 200);
  assert.equal(items[0].grantId, `ag_${uuid(2)}`);
  assert.equal(items.at(-1).grantId, issued.grant.id);
  assert.equal(items.at(-1).action, 'issue');

  const questions = world({ seats: 20 }), qs = questions.make();
  let seq = 1;
  for (let seat = 1; seat <= 20; seat++) for (let n = 0; n < 5; n++) {
    assert.equal((await qs.ask(who(seat), { requestId: uuid(seq++), question: `q-${seat}-${n}` })).question.n, seat);
  }
  assert.equal(questions.data.get('labhelp:lab').length, 100);
  assert.equal((await qs.ask(who(1), { requestId: uuid(seq), question: '초과' })).status, 429);
  assert.equal(questions.data.get('labhelp:lab').length, 100);

  const messages = world(), ms = messages.make();
  const a = await ms.issue(ADMIN, grantInput({ label: '가' }));
  const templateA = a.grant.templates[0].id;
  for (let n = 1; n <= 128; n++) assert.equal((await ms.sendTemplate(a.token, 'lab', { requestId: uuid(n), templateId: templateA, n: 1 })).message.text, 'template-secret-text');
  assert.equal((await ms.sendTemplate(a.token, 'lab', { requestId: uuid(129), templateId: templateA, n: 1 })).status, 429);
  assert.equal(messages.data.get('labassist-msg:lab').length, 128);
  assert.equal((await ms.sendTemplate(a.token, 'lab', { requestId: uuid(1), templateId: templateA, n: 1 })).message.text, 'template-secret-text');
  assert.equal(messages.data.get('labassist-msg:lab').length, 128);
  const b = await ms.issue(ADMIN, grantInput({ label: '나' }));
  const templateB = b.grant.templates[0].id;
  for (let n = 1; n <= 72; n++) assert.ok((await ms.sendTemplate(b.token, 'lab', { requestId: uuid(200 + n), templateId: templateB, n: 1 })).message);
  assert.equal(messages.data.get('labassist-msg:lab').length, 200);
  assert.equal((await ms.sendTemplate(b.token, 'lab', { requestId: uuid(400), templateId: templateB, n: 1 })).status, 429);
  assert.equal(messages.data.get('labassist-msg:lab').length, 200);
});

await test('storage failures do not echo secrets', async () => {
  const w = world(), s = w.make();
  w.storage.failPut = true;
  w.storage.leak = 'leak-admin-secret';
  const denied = await s.issue(ADMIN, grantInput());
  assert.equal(denied.status, 503);
  assert.equal(JSON.stringify(denied).includes('leak-admin-secret'), false);
  assert.equal(JSON.stringify(denied).includes('secret'), false);
  assert.deepEqual(assistKeys(w.data), []);
  w.storage.failPut = false;
  const issued = await s.issue(ADMIN, grantInput());
  w.storage.failGet = true;
  w.storage.leak = issued.token;
  const failed = await s.authorize(issued.token, 'lab', 'status:read');
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed).includes(issued.token), false);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
});

console.log(`${pass} lab assistant service scenarios passed`);
