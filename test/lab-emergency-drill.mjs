// Cross-feature emergency rehearsal on real State. Provider I/O stays a strict local fixture.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b = await build({entryPoints:['src/state.ts'], bundle:true, write:false, platform:'node', format:'esm', external:['cloudflare:workers'], logLevel:'silent'});
const code = b.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const S = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const uuid = n => 'c0000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const termId = uuid(90);
function memory() {
  const data = new Map(), copy = x => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  const s = {
    data,
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, copy(data.get(x))])) : copy(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) data.set(a, copy(b)); else data.set(k, copy(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) data.delete(x); },
    async list({prefix = '', limit = Infinity} = {}) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([k, v]) => [k, copy(v)])); },
    async getAlarm() { return null; }, async setAlarm() {},
    transaction(fn) { const p = lock.then(() => fn(s)); lock = p.catch(() => {}); return p; },
  };
  return s;
}
function hidden(payload, secrets) {
  const text = JSON.stringify(payload);
  for (const secret of secrets) assert.equal(text.includes('"' + secret + '"'), false);
}
async function world() {
  const storage = memory(), effects = [], tasks = [];
  let loseCreate = false;
  class Fixture extends S.State {
    async daytona() { return {api:'https://provider.invalid', key:'fixture'}; }
    async endSession(sess) { await storage.put('sess:' + sess.id, {...sess, revoked:true}); await storage.delete('tok:' + sess.tokenHash); }
    exportTtl() { return {ticket:60000, stream:60000, pack:60000, cooldown:0}; }
  }
  const env = {ORIGIN:'https://admin.invalid', LAB_ORIGIN:'https://lab.invalid', LAB_SEAT_DOMAIN:'seat.invalid', MASTER_KEY:Buffer.alloc(32, 7).toString('base64url')};
  const fresh = () => new Fixture({storage, waitUntil:p => tasks.push(p), blockConcurrencyWhile:f => f()}, env);
  const state = fresh();
  const seat = {n:1, code:'originalcodexxxx', sid:'sid', sandboxId:'old-sandbox', label:'oldlabel', who:'참여자', opened:Date.now(), setup:{state:'ok', at:Date.now(), note:'old'}};
  const lab = {id:'lab', name:'night', createdAt:Date.now(), snapshot:'v5', model:'fixture', cpu:1, memory:2, disk:3, budget:1, gw:'https://gw.invalid', expiresAt:Date.now() + 3600000, seats:[seat]};
  const session = {id:'sid', tokenHash:'old-hash', providers:['or'], createdAt:Date.now() - 10000, expiresAt:lab.expiresAt, budget:1, lab:'lab', orProvider:'or', orKey:'REAL-KEY-MUST-STAY', orKeyHash:'real-or-hash', uses:7, counts:{shared:4}, calls:[Date.now() - 1000], leases:{inflight:{exp:Date.now() + 60000, p:'or', counted:false, at:Date.now() - 1000}}, limits:{total:50, rpm:10, concurrent:2}, gens:{or:'gen'}, ip:'lab', country:'', city:'night', ua:'fixture'};
  await storage.put({'lab:lab':lab, ['seat:' + seat.code]:{lab:'lab', n:1}, 'sess:sid':session, 'tok:old-hash':'sid',
    ['admin:' + await S.sha('admin')]:{expiresAt:Date.now() + 600000},
    'prov:or':{id:'or', kind:'openrouter-mint', gen:'gen', upstream:'https://openrouter.ai', iv:'fixture', ct:'fixture'},
    'prov:daytona':{id:'daytona', gen:'dt-gen', iv:'fixture', ct:'fixture', upstream:'https://app.daytona.io/api'},
    'labterm:lab:current':termId, ['labterm:lab:session:' + termId]:{sessionId:termId, owner:await S.sha('admin'), active:true, refs:[{labId:'lab', n:1, code:seat.code, sandboxId:seat.sandboxId}], seats:[{n:1, status:'ready'}], count:0, startedAt:Date.now()}});
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(input), method = init.method ?? 'GET';
    if (u.host === 'provider.invalid' && u.pathname === '/sandbox' && method === 'POST') {
      const body = JSON.parse(init.body);
      effects.push({kind:'create', body});
      if (loseCreate) throw Error('response lost');
      return Response.json({id:'new-sandbox', state:'started'});
    }
    if (u.host === 'provider.invalid' && u.pathname === '/sandbox' && method === 'GET') {
      const labels = u.searchParams.get('labels');
      effects.push({kind:'list', labels});
      if (JSON.parse(labels)['gw-lab'] !== 'lab') throw Error('fixture rejected list ' + labels);
      return Response.json({items:[{id:'old-sandbox', state:'started'}, {id:'new-sandbox', state:'started'}]});
    }
    if (u.host === 'provider.invalid' && u.pathname.startsWith('/sandbox/')) {
      const id = decodeURIComponent(u.pathname.split('/')[2]);
      if (method === 'DELETE') { effects.push({kind:'delete', id}); return Response.json({}); }
      if (u.pathname.endsWith('/stop')) { effects.push({kind:'stop', id}); return Response.json({}); }
      if (method === 'POST') { effects.push({kind:'wake', id}); return Response.json({}); }
      effects.push({kind:'lookup', id});
      return Response.json({id, state:'started', toolboxProxyUrl:'https://toolbox.invalid'});
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/files/upload')) {
      effects.push({kind:'upload', sb:u.pathname.split('/')[1]});
      return new Response('');
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/files/download')) {
      effects.push({kind:'download', sb:u.pathname.split('/')[1], path:u.searchParams.get('path')});
      return new Response(new Uint8Array(20));
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/process/execute')) {
      const command = JSON.parse(init.body).command;
      const kind = command.includes('/healthz') ? 'health' : command.includes('mkdir -m 700') ? 'mkdir' : command.includes('timeout -k') ? 'pack' : command.includes('rm -rf') ? 'cleanup' : 'execute';
      effects.push({kind, sb:u.pathname.split('/')[1], command});
      if (kind === 'health') return Response.json({exitCode:0, result:'200'});
      if (kind === 'pack') return Response.json({exitCode:0, result:'OK 2 4 0 20'});
      return Response.json({exitCode:0, result:'OK'});
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/process/session')) { effects.push({kind:'session'}); return Response.json({}); }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/exec')) { effects.push({kind:'editor'}); return Response.json({}); }
    throw Error('fixture rejected network ' + method + ' ' + u.href);
  };
  const kinds = name => effects.filter(x => x.kind === name);
  return {storage, state, fresh, effects, lab, seat, session, kinds,
    loseCreate() { loseCreate = true; },
    async settle() { await Promise.all(tasks); }};
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS', name); }

await test('pause, own checkpoint acknowledgement, then one replacement and class-end cleanup', async () => {
  const w = await world(), termKey = 'labterm:lab:session:' + termId;
  const paused = await w.state.labControlPause('admin', 'lab', uuid(1));
  assert.equal(paused.mode, 'paused');
  assert.equal((await w.storage.get(termKey)).active, true);
  const checkpoint = await w.state.labCheckpointCreate('admin', 'lab', uuid(2), [1], paused.revision);
  assert.equal(checkpoint.results.length, 1);
  assert.equal(checkpoint.results[0].status, 'ready');
  assert.equal(checkpoint.results[0].n, 1);
  const pack = w.effects.find(x => x.kind === 'pack');
  assert.equal(pack.command.includes('/home/daytona/.gw-export/' + uuid(2)), true);
  assert.equal(pack.command.includes('rm -rf'), false);
  assert.equal(w.effects.some(x => x.kind === 'mkdir' && x.command.includes('mkdir -m 700')), true);
  const exported = await w.state.labExportStart(w.seat.code, uuid(2));
  assert.equal((await w.state.labFileAcknowledge(w.seat.code, exported.receiptId)).status, 409);
  const response = await w.state.labExportDownload(w.seat.code, exported.ticket);
  assert.equal((await response.arrayBuffer()).byteLength, 20);
  await w.settle();
  assert.equal(w.effects.find(x => x.kind === 'download').path, '/home/daytona/.gw-export/' + uuid(2) + '/work.zip');
  assert.equal((await w.state.labFileReceipt(w.seat.code)).transfer.verifiedAt, null);
  const acked = await w.state.labFileAcknowledge(w.seat.code, exported.receiptId);
  assert.equal(typeof acked.transfer.verifiedAt, 'number');
  const ctx = await w.state.labRecoveryContext('admin', 'lab', 1);
  assert.equal(ctx.verifiedFile, true);
  assert.equal(ctx.revision, paused.revision);
  const replaced = await w.state.labRecoveryCreate('admin', 'lab', uuid(4), 1, 'replace', ctx.generation, ctx.revision, false);
  assert.equal(replaced.status, 'replaced');
  const lab = await w.storage.get('lab:lab'), seat = lab.seats[0], sess = await w.storage.get('sess:sid');
  const body = w.effects.find(x => x.kind === 'create').body;
  assert.equal(seat.sid, 'sid');
  assert.equal(sess.id, 'sid');
  assert.equal(sess.orKey, w.session.orKey);
  assert.equal(sess.orKeyHash, w.session.orKeyHash);
  assert.equal(sess.budget, w.session.budget);
  assert.equal(sess.uses, w.session.uses);
  assert.deepEqual(sess.counts, w.session.counts);
  assert.deepEqual(sess.limits, w.session.limits);
  assert.deepEqual(sess.calls, w.session.calls);
  assert.deepEqual(sess.leases, w.session.leases);
  assert.equal(sess.expiresAt, w.session.expiresAt);
  assert.equal(lab.expiresAt, w.lab.expiresAt);
  assert.equal(seat.sandboxId, 'new-sandbox');
  assert.notEqual(seat.code, w.seat.code);
  assert.notEqual(seat.label, w.seat.label);
  assert.notEqual(sess.tokenHash, w.session.tokenHash);
  assert.equal(seat.setup, undefined);
  assert.equal(seat.who, '참여자');
  assert.equal(await w.storage.get('seat:' + w.seat.code), undefined);
  assert.equal(await w.storage.get('tok:old-hash'), undefined);
  assert.equal(await w.storage.get('tok:' + sess.tokenHash), 'sid');
  assert.equal(await w.storage.get('tok:' + await S.sha(body.env.OPENROUTER_API_KEY)), 'sid');
  assert.equal(await w.storage.get('labfiles:' + w.seat.code + ':receipt'), undefined);
  assert.equal((await w.state.labFileReceipt(seat.code)).transfer, null);
  assert.equal((await w.storage.get(termKey)).active, false);
  assert.equal(await w.storage.get('labterm:lab:current'), termId);
  const ctrl = await w.storage.get('labctrl:lab');
  assert.equal(ctrl.mode, 'paused');
  assert.equal(ctrl.revision > paused.revision, true);
  assert.equal(body.labels['gw-lab'], 'lab');
  assert.equal(body.labels['gw-recovery'], uuid(4));
  assert.equal(body.autoDeleteInterval, 0);
  assert.equal(JSON.stringify(body).includes(w.session.orKey), false);
  assert.deepEqual([...w.storage.data.keys()].filter(k => k.startsWith('sess:')), ['sess:sid']);
  assert.equal(w.kinds('create').length, 1);
  assert.equal(w.kinds('health').length + w.kinds('editor').length + w.kinds('session').length + w.kinds('delete').length + w.kinds('stop').length, 0);
  assert.equal([...w.storage.data.keys()].some(k => k.startsWith('labcreatecleanup:')), false);
  const resource = await w.storage.get('labrecover-resource:lab:' + uuid(4));
  hidden([replaced, ctx], [w.session.orKey, w.session.tokenHash, w.seat.code, seat.code, resource.candidate.seal.ct, resource.candidate.seal.iv, 'ct', 'iv', 'sid']);
  const replay = await w.fresh().labRecoveryCreate('admin', 'lab', uuid(4), 1, 'replace', ctx.generation, ctx.revision, false);
  assert.equal(replay.status, 'replaced');
  assert.equal(replay.requestId, uuid(4));
  assert.equal(w.kinds('create').length, 1);
  const beforeResume = w.effects.length;
  assert.equal((await w.state.labControlResume('admin', 'lab', uuid(5), paused.revision)).status, 409);
  const resumed = await w.state.labControlResume('admin', 'lab', uuid(6), ctrl.revision);
  assert.equal(resumed.mode, 'running');
  assert.equal(w.effects.length, beforeResume);
  assert.equal((await w.storage.get(termKey)).active, false);
  assert.equal((await w.storage.get(termKey)).count, 0);
  assert.equal(w.kinds('delete').length + w.kinds('list').length, 0);
  const ended = await w.state.labEnd('admin', 'lab');
  assert.equal(ended.ok, true);
  const deleted = new Set(w.kinds('delete').map(x => x.id));
  assert.equal(deleted.has('old-sandbox'), true);
  assert.equal(deleted.has('new-sandbox'), true);
  assert.equal(JSON.parse(w.effects.find(x => x.kind === 'list').labels)['gw-lab'], 'lab');
});

await test('lost create stays unknown until inspected unlock, then one healthy repair', async () => {
  const w = await world();
  const paused = await w.state.labControlPause('admin', 'lab', uuid(1));
  assert.equal(paused.mode, 'paused');
  const ctx = await w.state.labRecoveryContext('admin', 'lab', 1);
  w.loseCreate();
  const lost = await w.state.labRecoveryCreate('admin', 'lab', uuid(2), 1, 'replace', ctx.generation, ctx.revision, true);
  assert.equal(lost.status, 'unknown');
  assert.deepEqual(await w.storage.get('sess:sid'), w.session);
  assert.equal((await w.storage.get('lab:lab')).seats[0].code, w.seat.code);
  assert.equal((await w.storage.get('lab:lab')).seats[0].sandboxId, 'old-sandbox');
  assert.equal(w.kinds('create').length, 1);
  const status = await w.fresh().labRecoveryStatus('admin', 'lab', uuid(2));
  assert.equal(status.status, 'unknown');
  const replay = await w.fresh().labRecoveryCreate('admin', 'lab', uuid(2), 1, 'replace', ctx.generation, ctx.revision, true);
  assert.equal(replay.status, 'unknown');
  assert.equal(w.kinds('create').length, 1);
  const current = await w.state.labRecoveryContext('admin', 'lab', 1);
  assert.equal(current.operation.requestId, uuid(2));
  assert.equal(current.generation, ctx.generation);
  const blocked = await w.state.labRecoveryCreate('admin', 'lab', uuid(3), 1, 'repair', current.generation, current.revision, false);
  assert.equal(blocked.status, 409);
  assert.equal((await w.state.labRecoveryUnlock('admin', 'lab', uuid(2), current.generation, false)).status, 400);
  assert.equal((await w.state.labRecoveryUnlock('admin', 'lab', uuid(2), 'stale-generation', true)).status, 409);
  const unlocked = await w.state.labRecoveryUnlock('admin', 'lab', uuid(2), current.generation, true);
  assert.equal(unlocked.released, true);
  assert.equal(w.kinds('delete').length + w.kinds('stop').length, 0);
  assert.equal([...w.storage.data.keys()].some(k => k.startsWith('labcreatecleanup:')), false);
  const again = await w.state.labRecoveryContext('admin', 'lab', 1);
  assert.equal(again.operation, null);
  assert.equal((await w.storage.get('labctrl:lab')).mode, 'paused');
  const repair = await w.state.labRecoveryCreate('admin', 'lab', uuid(4), 1, 'repair', again.generation, again.revision, false);
  assert.equal(repair.status, 'ready');
  assert.equal(w.kinds('health').length, 1);
  assert.equal(w.kinds('create').length, 1);
  assert.equal(w.kinds('delete').length + w.kinds('stop').length + w.kinds('wake').length + w.kinds('editor').length + w.kinds('session').length, 0);
  assert.deepEqual(await w.storage.get('sess:sid'), w.session);
  assert.equal((await w.storage.get('labctrl:lab')).mode, 'paused');
  const resource = await w.storage.get('labrecover-resource:lab:' + uuid(2));
  assert.equal(resource.candidate.sandboxId, undefined);
  assert.equal(typeof resource.candidate.seal.ct, 'string');
  hidden([lost, status, replay, blocked, unlocked, repair, current, again], [w.session.orKey, w.session.tokenHash, w.seat.code, resource.candidate.code, resource.candidate.seal.ct, resource.candidate.seal.iv, resource.candidate.tokenHash, 'ct', 'iv', 'sid']);
});

console.log('PASS emergency rehearsal scenarios', passed);
