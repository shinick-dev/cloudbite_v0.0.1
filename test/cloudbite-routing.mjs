// Routing policy, provider contract and durable idempotence. No real network or provider secrets.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const b = await build({ stdin: { contents: "export * from './src/cloudbite-routing.ts';export {CLOUDBITE_EXPERTS} from './src/cloudbite-personas.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const m = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok ' + name); };
const experts = m.CLOUDBITE_EXPERTS;
const q = (over = {}) => ({ title: 'Routing question', objective: 'Review frontend rendering and state.', context: '', requestId: 'routing-test-001', ...over });
const answer = (scores = {}) => ({ model: m.JEV_MODEL, answers: Object.fromEntries(experts.map(e => [e.id, { type: 'noul', noul: scores[e.id] ?? 0.05 }])) });
const good = () => answer({ 'cb-role-022': 0.94, 'cb-role-023': 0.79 });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const ask = (data = good(), max = 5) => m.askJev(q(), experts, 'TEST-KEY', max, 'a'.repeat(64), 1000, async () => response(data));
function storage() {
 const data = new Map(); let alarm = null, queue = Promise.resolve();
 return { data, async get(k) { return structuredClone(data.get(k)); }, async put(k, v) { data.set(k, structuredClone(v)); }, async delete(k) { data.delete(k); },
   async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; },
   transaction(fn) { const p = queue.then(() => fn(this)); queue = p.catch(() => {}); return p; } };
}
await test('one independent question per real role, shared untrusted brief, no full prompts or keyword prefilter', () => {
 const body = m.jevRoutingRequest(q(), experts);
 assert.equal(Object.keys(body.questions).length, 100);
 assert.deepEqual(body.state.request, { title: q().title, objective: q().objective, context: '' });
 assert.ok(Object.values(body.questions).every(x => x.type === 'noul' && x.instructions.expert.id));
 assert.ok(!JSON.stringify(body).includes(experts[0].prompt));
 assert.ok(!JSON.stringify(body).includes('TEST-KEY'));
});
await test('sort relevance and enforce max5/lower session cap without inventing candidates', async () => {
 const data = answer(Object.fromEntries(experts.slice(0, 9).map((e, i) => [e.id, 0.99 - i * 0.01])));
 assert.deepEqual((await ask(data)).expertIds, experts.slice(0, 5).map(e => e.id));
 assert.deepEqual((await ask(data, 2)).expertIds, experts.slice(0, 2).map(e => e.id));
 assert.equal((await ask()).matches[0].relevance, 0.94);
});
await test('no match returns clarification error and never a fabricated fallback team', async () => {
 const r = await ask(answer()); assert.equal(r.status, 422); assert.equal(r.expertIds, undefined);
});
await test('missing/extra/malformed decisions fail closed', async () => {
 const variants = [];
 const missing = good(); delete missing.answers[experts[0].id]; variants.push(missing);
 const extra = good(); extra.answers['../../new-role'] = { type: 'noul', noul: 1 }; variants.push(extra);
 for (const value of [-0.1, 1.01, '0.9', null]) { const a = good(); a.answers[experts[0].id].noul = value; variants.push(a); }
 const wrong = good(); wrong.answers[experts[0].id].type = 'choice'; variants.push(wrong);
 const model = good(); model.model = 'jev-TEST-KEY'; variants.push(model);
 for (const a of variants) assert.equal((await ask(a)).status, 502);
});
await test('provider failures, malformed/oversized bodies and missing config expose no keys/bodies', async () => {
 for (const status of [401, 429, 500]) {
  const r = await m.askJev(q(), experts, 'TEST-KEY', 5, 'h', 0, async () => new Response('TEST-KEY internal trace', { status }));
  assert.equal(r.status, status === 429 ? 429 : 503); assert.ok(!JSON.stringify(r).includes('TEST-KEY'));
 }
 assert.equal((await m.askJev(q(), experts, '', 5, 'h', 0, () => { throw Error('must not call'); })).status, 503);
 for (const text of ['not json', 'x'.repeat(65537)]) assert.equal((await m.askJev(q(), experts, 'TEST-KEY', 5, 'h', 0, async () => new Response(text))).status, 502);
 assert.equal((await m.askJev(q(), experts, 'TEST-KEY', 5, 'h', 0, async () => { throw Error('TEST-KEY network'); })).status, 503);
});
await test('fixed endpoint, server authorization header and deadline only', async () => {
 await m.askJev(q(), experts, ' TEST-KEY ', 5, 'h', 0, async (url, init) => {
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(init.headers.authorization, 'Bearer TEST-KEY');
  assert.ok(init.signal); assert.equal(JSON.parse(init.body).model, m.JEV_MODEL); return response(good());
 });
});
await test('exact cached decision reused, conflicting brief/limit refused and actors isolated', async () => {
 let calls = 0, now = 10000; const s = storage(), transport = async () => { calls++; return response(good()); };
 const router = new m.RoutingSession(s, experts, 'TEST-KEY', () => now, transport);
 const first = await router.plan(q(), 5); assert.equal(first.provider, 'typesafe');
 assert.deepEqual(await router.plan(q(), 5), first); assert.deepEqual(await router.read(q(), 5), first); assert.equal(calls, 1);
 assert.equal((await router.plan(q({ objective: 'Different question' }), 5)).status, 409);
 assert.equal((await router.read(q(), 2)).status, 409);
 const other = new m.RoutingSession(storage(), experts, 'TEST-KEY', () => now, transport);
 assert.equal((await other.read(q(), 5)).status, 409);
 assert.ok(!JSON.stringify([...s.data]).includes(q().objective)); assert.ok(!JSON.stringify([...s.data]).includes('TEST-KEY'));
 now += m.ROUTING_TTL + 1; assert.equal((await router.read(q(), 5)).status, 409);
 await router.cleanup(); assert.equal(await s.get('routing:state'), undefined);
});
await test('concurrent duplicate routing obtains exactly one provider claim', async () => {
 let release, count = 0, reached; const entered = new Promise(r => { reached = r; });
 const transport = async () => { count++; reached(); await new Promise(r => { release = r; }); return response(good()); };
 const router = new m.RoutingSession(storage(), experts, 'TEST-KEY', () => 10000, transport);
 const first = router.plan(q(), 5); await entered;
 assert.equal((await router.plan(q(), 5)).status, 409); assert.equal(count, 1);
 release(); assert.equal((await first).provider, 'typesafe'); assert.equal(count, 1);
});
await test('a stale provider completion cannot overwrite a newer claim', async () => {
 let now = 10000, release, count = 0, reached; const entered = new Promise(r => { reached = r; });
 const router = new m.RoutingSession(storage(), experts, 'TEST-KEY', () => now, async () => {
  if (++count === 1) { reached(); await new Promise(r => { release = r; }); return response(good()); }
  return response(answer({ 'cb-role-023': 0.98 }));
 });
 const old = router.plan(q(), 5); await entered; now += 26000;
 const current = await router.plan(q(), 5); release(); assert.equal((await old).status, 409);
 assert.deepEqual((await router.read(q(), 5)).expertIds, current.expertIds);
});
await test('bounded per-actor billable rate; cache hits free; failures do not consume project slots', async () => {
 let calls = 0; const router = new m.RoutingSession(storage(), experts, 'TEST-KEY', () => 10000, async () => { calls++; return response(good()); });
 for (let i = 0; i < 6; i++) assert.equal((await router.plan(q({ requestId: `rate-test-${i}` }), 5)).provider, 'typesafe');
 assert.equal((await router.plan(q({ requestId: 'rate-test-7' }), 5)).status, 429);
 assert.equal((await router.plan(q({ requestId: 'rate-test-0' }), 5)).provider, 'typesafe'); assert.equal(calls, 6);
});
await test('prototype-shaped ids stay ordinary cache entries; question edits invalidate hashes', async () => {
 const router = new m.RoutingSession(storage(), experts, 'TEST-KEY', () => 10000, async () => response(good()));
 for (const requestId of ['__proto__', 'constructor']) { const r = await router.plan(q({ requestId }), 5); assert.equal(r.provider, 'typesafe'); assert.deepEqual((await router.read(q({ requestId }), 5)).expertIds, r.expertIds); }
 assert.notEqual(await m.routingQueryHash(q(), experts, 5), await m.routingQueryHash(q({ context: 'new context' }), experts, 5));
 assert.equal(({}).result, undefined);
});
console.log(`cloudbite-routing: ${passed} checks passed`);
