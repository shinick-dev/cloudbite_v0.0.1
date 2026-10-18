// Focused repair checks: grant time is revalidated after the last await on reply/template.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const source = process.env.LAB_ASSISTANT_SOURCE || 'src/lab-assistant-service.ts';
const bundled = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const { LabAssistantService } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const uuid = (n) => 'e0000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const who = { labId: 'lab', n: 1, seatCode: 'seat000000000001' };

async function world(scopes) {
  let at = 1800000000000;
  const data = new Map();
  const copy = (x) => x === undefined ? x : structuredClone(x);
  const storage = {
    data,
    hook: null,
    async get(k) {
      const v = copy(data.get(k));
      if (storage.hook) await storage.hook(k);
      return v;
    },
    async put(k, v) {
      if (typeof k === 'object') for (const [a, b] of Object.entries(k)) data.set(a, copy(b));
      else data.set(k, copy(v));
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    async list({ prefix = '' }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, copy(v)]));
    },
    async transaction(fn) {
      const snapshot = copy([...data]);
      try { return await fn(storage); }
      catch (e) { data.clear(); for (const [k, v] of snapshot) data.set(k, v); throw e; }
    },
  };
  data.set('lab:lab', { id: 'lab', name: 'fixture', expiresAt: at + 3600000, seats: [{ n: 1, code: 'seat000000000001' }] });
  const svc = new LabAssistantService({ storage, now: () => at, checkAdmin: async (t) => t === 'admin' });
  const templates = scopes.includes('template:send') ? [{ title: 'short', text: '안녕' }] : [];
  const issued = await svc.issue('admin', { id: 'lab', label: 'fixture', seats: [1], scopes, minutes: 5, templates });
  assert.ok(!issued.error);
  return { svc, storage, data, issued, expire() { at = issued.grant.expiresAt + 1; } };
}

const tests = [
  ['reply expires during the audit read and does not write', async () => {
    const w = await world(['status:read', 'help:read', 'help:reply']);
    const asked = await w.svc.ask(who, { requestId: uuid(1), question: '도와주세요' });
    assert.ok(!asked.error);
    const before = structuredClone([...w.data]);
    w.storage.hook = (k) => { if (k === 'labassist-audit:lab') w.expire(); };
    const r = await w.svc.reply(w.issued.token, 'lab', { requestId: uuid(2), questionId: asked.question.id, text: '확인했습니다' });
    assert.equal(r.status, 401);
    assert.deepEqual([...w.data], before);
  }],
  ['template expires during the audit read and does not write', async () => {
    const w = await world(['status:read', 'template:send']);
    const before = structuredClone([...w.data]);
    w.storage.hook = (k) => { if (k === 'labassist-audit:lab') w.expire(); };
    const r = await w.svc.sendTemplate(w.issued.token, 'lab', { requestId: uuid(1), templateId: w.issued.grant.templates[0].id, n: 1 });
    assert.equal(r.status, 401);
    assert.deepEqual([...w.data], before);
  }],
  ['short template still commits an audit array', async () => {
    const w = await world(['status:read', 'template:send']);
    const r = await w.svc.sendTemplate(w.issued.token, 'lab', { requestId: uuid(1), templateId: w.issued.grant.templates[0].id, n: 1 });
    assert.equal(r.message.text, '안녕');
    const audit = w.data.get('labassist-audit:lab');
    assert.ok(Array.isArray(audit));
    assert.equal(audit.at(-1).action, 'template');
    assert.equal(w.data.get('labassist-msg:lab').length, 1);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok', name); }
  catch (e) { failed++; console.error('FAIL', name, ':', e.message.split('\n')[0]); }
}
if (failed) process.exitCode = 1;
else console.log('PASS assistant repair', tests.length);
