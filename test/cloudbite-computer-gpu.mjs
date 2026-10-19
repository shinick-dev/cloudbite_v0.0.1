// Cloudbite GPU candidates (src/cloudbite-computer-gpu.ts): read-only Nosana reservation discovery over an injected fake
// fetch. Upstream shapes are trimmed from live public api.nosana.com responses of 2026-10-19 (node addresses replaced).
// No network leaves this process.
//   node test/cloudbite-computer-gpu.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-gpu-'));
const bundle = await build({ entryPoints: ['src/cloudbite-computer-gpu.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let count = 0;
const check = async (name, f) => { M.cbGpuClearCache(); await f(); count++; console.log('ok', name); };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const M4090 = '97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf', M3090 = 'CA5pMpqkYFKtme7K31pNB1s62X2SdhEv1nN9RdxKCpuQ', M5090 = '6Xt8hgVLLL2PSHC9NtJP8E8oTdA5ZJc95hZEnHcdqKqb';
const PRO = ['Ekro9NTNqLbnMkN7x7y2rY9AeTkazcHj2PPaTxT1Cogz', 'EuYwNdSDduvFuTTS4fEgNL23rZRaTMbecM1J6fJJoQR1'];
const NODE = 'NodeAddrSecretish1111111111111111111111111';
const GPUS = { gpus: [
  { name: 'NVIDIA GeForce RTX 4090', vramGb: 24, nodes: 95, available: 8, working: 73, markets: [M4090], price: { minUsdPerHour: 0.3636, maxUsdPerHour: 0.3636 } },
  { name: 'NVIDIA GeForce RTX 5090', vramGb: 32, nodes: 54, available: 0, working: 41, markets: [M5090], price: { minUsdPerHour: 0.4545, maxUsdPerHour: 0.4545 } },
  { name: 'NVIDIA GeForce RTX 3090', vramGb: 24, nodes: 39, available: 7, working: 19, markets: [M3090], price: { minUsdPerHour: 0.1745, maxUsdPerHour: 0.1745 } },
  { name: 'NVIDIA RTX PRO 6000 Blackwell Server Edition', vramGb: 95, nodes: 25, available: 2, working: 23, markets: PRO, price: { minUsdPerHour: 0.909, maxUsdPerHour: 1 } },
  { name: 'NVIDIA GeForce RTX 3080', vramGb: 10, nodes: 23, available: 3, working: 20, markets: [], price: null },
  { name: '<img src=x onerror=alert(1)>', vramGb: 80, nodes: 1, available: 1, markets: [], price: null },
  { name: 'NVIDIA Negative', vramGb: -1, nodes: 1, available: 1, markets: [], price: null },
] };
// Country options count hosts that report a country, not free hosts: availability is read per country.
const COUNTRIES = {
  'NVIDIA GeForce RTX 4090': [['AE', 1], ['BG', 27], ['CA', 5], ['DE', 2], ['JP', 5], ['missing', 11], ['NL', 36], ['US', 15], ['XX', 0]],
  'NVIDIA GeForce RTX 3090': [['US', 4], ['NL', 3], ['ZZ', 2]],
  'NVIDIA RTX PRO 6000 Blackwell Server Edition': [['US', 25]],
};
const FREE = { 'NVIDIA GeForce RTX 4090|US': 3, 'NVIDIA GeForce RTX 4090|NL': 2, 'NVIDIA GeForce RTX 4090|BG': 0, 'NVIDIA GeForce RTX 4090|DE': 1, 'NVIDIA GeForce RTX 4090|JP': 1,
  'NVIDIA GeForce RTX 4090|CA': 1, 'NVIDIA GeForce RTX 4090|AE': 0, 'NVIDIA GeForce RTX 3090|US': 2, 'NVIDIA GeForce RTX 3090|NL': 1, 'NVIDIA GeForce RTX 3090|ZZ': 1,
  'NVIDIA RTX PRO 6000 Blackwell Server Edition|US': 2 };

function fake(over = {}) {
  const calls = []; const clock = { t: Date.parse('2026-10-19T10:00:00Z') };
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body, redirect: init.redirect, headers: init.headers });
    if (over.handle) { const r = await over.handle(url, body); if (r) return r; }
    if (url === 'https://api.nosana.com/reservations/gpus') return json(GPUS);
    if (url === 'https://api.nosana.com/reservations/requirements') {
      const values = (COUNTRIES[body.requirements.name] ?? []).map(([value, nodes]) => ({ value, nodes }));
      return json({ nodes: 1, metrics: [{ key: 'country', group: 'network', type: 'text', match: 'exact', perInstance: false, values }] });
    }
    if (url === 'https://api.nosana.com/reservations/available') {
      const k = `${body.requirements.name}|${body.requirements.country}`, n = FREE[k] ?? 0;
      const g = GPUS.gpus.find((x) => x.name === body.requirements.name);
      const markets = body.requirements.name.includes('PRO') ? PRO : g.markets;
      return json({ total: n, price: n ? g.price : null, nodes: Array.from({ length: n }, (_, i) => ({ nodeAddress: NODE, market: markets[i % markets.length] })) });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { calls, clock, deps: { fetch, now: () => clock.t } };
}

await check('discovery: live shapes, per-country actual availability, zero-free countries dropped, sanitized, fixed URLs', async () => {
  const f = fake();
  const r = await M.gpuCandidates('us', 24, f.deps);
  assert.equal(r.locationBasis, 'region-country-estimate');
  assert.equal(r.observedAt, '2026-10-19T10:00:00.000Z');
  const ids = r.candidates.map((c) => `${c.gpu}|${c.country}`);
  assert.ok(!ids.includes('NVIDIA GeForce RTX 4090|BG') && !ids.includes('NVIDIA GeForce RTX 4090|AE'), 'country with hosts but no free host is not a candidate');
  assert.ok(!ids.some((i) => i.includes('missing') || i.includes('XX')), 'missing / zero-node countries skipped');
  assert.ok(!ids.some((i) => i.includes('3080')), 'minVramGb filter');
  assert.ok(!JSON.stringify(r).includes('img') && !JSON.stringify(r).includes('Negative'), 'invalid upstream entries dropped');
  assert.ok(!JSON.stringify(r).includes(NODE), 'node addresses never returned');
  const us4090 = r.candidates.find((c) => c.gpu === 'NVIDIA GeForce RTX 4090' && c.country === 'US');
  assert.deepEqual({ ...us4090, id: undefined, distanceKm: undefined }, { id: undefined, gpu: 'NVIDIA GeForce RTX 4090', vramGb: 24, available: 3, country: 'US', market: M4090,
    usdPerHourMin: 0.3636, usdPerHourMax: 0.3636, distanceKm: undefined, selectable: true });
  assert.ok(us4090.distanceKm < 1000);
  const pro = r.candidates.find((c) => c.gpu.includes('PRO'));
  assert.deepEqual([pro.market, pro.usdPerHourMin, pro.usdPerHourMax], [null, 0.909, 1], 'several markets: market null, price range kept');
  const z5090 = r.candidates.find((c) => c.gpu === 'NVIDIA GeForce RTX 5090');
  assert.deepEqual([z5090.available, z5090.country, z5090.selectable, z5090.distanceKm], [0, null, false, null], 'no-free GPU visible, unselectable');
  assert.equal(r.candidates.at(-1).selectable, false, 'unselectable last');
  for (const c of f.calls) {
    assert.ok(c.url.startsWith('https://api.nosana.com/reservations/'), c.url);
    assert.equal(c.redirect, 'manual');
    assert.ok(!('authorization' in c.headers), 'no credentials');
  }
  assert.ok(!f.calls.some((c) => c.body?.requirements?.name === 'NVIDIA GeForce RTX 5090'), 'zero-available GPU costs no per-country reads');
  for (const k of Object.keys(r.candidates[0])) assert.ok(!/ms|latency|rtt/i.test(k), 'no measured-latency field');
  assert.match(r.note, /approximate/); assert.match(r.note, /network fees are separate/); assert.doesNotMatch(r.note, /Partial/);
});

await check('ranking: nearest country first per region; unknown country and unknown region sort last with null distance', async () => {
  const us = await M.gpuCandidates('us', 24, fake().deps);
  const sel = us.candidates.filter((c) => c.selectable);
  assert.deepEqual(sel.slice(0, 3).map((c) => c.country), ['US', 'US', 'US']);
  assert.equal(sel.at(-1).country, 'ZZ'); assert.equal(sel.at(-1).distanceKm, null, 'unknown centroid last');
  for (let i = 1; i < sel.length; i++) assert.ok((sel[i - 1].distanceKm ?? Infinity) <= (sel[i].distanceKm ?? Infinity));
  const eu = await M.gpuCandidates('EU', 24, fake().deps);
  assert.ok(['NL', 'DE'].includes(eu.candidates[0].country), eu.candidates[0].country);
  const asia = await M.gpuCandidates('asia', 24, fake().deps);
  assert.equal(asia.candidates[0].country, 'JP');
  const unknown = await M.gpuCandidates('mars-1', 24, fake().deps);
  assert.ok(unknown.candidates.every((c) => c.distanceKm === null));
  assert.match(unknown.note, /region unknown/);
  assert.equal(unknown.candidates[0].available, 3, 'without distance, more free hosts first');
  assert.equal(M.cbGpuDistanceKm('eu', 'NL') < M.cbGpuDistanceKm('eu', 'US'), true);
});

await check('honest failures: gpus list down or invalid throws a fixed code; per-country failure is partial; failures are not cached', async () => {
  for (const [resp, code] of [[() => new Response('nope', { status: 502 }), 'upstream_unavailable'], [() => new Response('', { status: 302, headers: { location: 'https://evil.test/' } }), 'upstream_invalid'],
    [() => new Response('{not json', { status: 200 }), 'upstream_invalid'], [() => json({ gpus: 'x' }), 'upstream_invalid'],
    [() => new Response('x'.repeat(M.CBG_BODY_MAX + 10), { status: 200 }), 'upstream_invalid'], [() => { throw new TypeError('net'); }, 'upstream_unavailable']]) {
    M.cbGpuClearCache();
    const f = fake({ handle: (url) => url.endsWith('/gpus') ? resp() : null });
    await assert.rejects(M.gpuCandidates('us', 24, f.deps), (e) => e instanceof M.CbGpuError && e.code === code && !e.message.includes('nope'));
  }
  // A failure is not cached: the next call reads again.
  M.cbGpuClearCache();
  let down = true;
  const f = fake({ handle: (url) => url.endsWith('/gpus') && down ? new Response('', { status: 503 }) : null });
  await assert.rejects(M.gpuCandidates('us', 24, f.deps));
  down = false;
  assert.ok((await M.gpuCandidates('us', 24, f.deps)).candidates.length > 0);
  // One country read fails: that pair is missing and the note says partial; nothing is invented.
  M.cbGpuClearCache();
  const p = fake({ handle: (url, b) => url.endsWith('/available') && b.requirements.country === 'US' && b.requirements.name.includes('4090') ? new Response('', { status: 500 }) : null });
  const r = await M.gpuCandidates('us', 24, p.deps);
  assert.ok(!r.candidates.some((c) => c.gpu.includes('4090') && c.country === 'US'));
  assert.match(r.note, /Partial/);
  assert.equal(await M.gpuCandidates('us', -1, p.deps).catch((e) => e.code), 'bad_request');
});

await check('bounds and cache: per-country reads capped, nearest spent first; cached for the TTL then refreshed', async () => {
  const many = Object.fromEntries(['US', 'CA', 'MX', 'BR', 'AR', 'GB', 'DE', 'NL', 'FR', 'ES', 'IT', 'PL', 'SE', 'NO', 'FI', 'JP', 'KR', 'SG', 'IN', 'AU', 'ZA', 'TR', 'UA', 'RO', 'BG', 'PT', 'IE', 'CH', 'AT', 'CZ', 'HU', 'GR'].map((c) => [c, 1]));
  const f = fake({ handle: (url, b) => url.endsWith('/requirements') ? json({ metrics: [{ key: 'country', values: Object.keys(many).map((value) => ({ value, nodes: 2 })) }] })
    : url.endsWith('/available') ? json({ total: 1, price: null, nodes: [{ market: M4090 }] }) : null });
  const r = await M.gpuCandidates('us', 24, f.deps);
  const avail = f.calls.filter((c) => c.url.endsWith('/available'));
  assert.equal(avail.length, M.CBG_MAX_AVAILABLE_CALLS);
  assert.ok(avail.slice(0, 3).every((c) => c.body.requirements.country === 'US'), 'nearest first');
  assert.match(r.note, /Partial/, 'skipped pairs are disclosed');
  assert.ok(f.calls.filter((c) => c.url.endsWith('/requirements')).every((c) => c.body.metrics[0] === 'country'));
  const n = f.calls.length;
  await M.gpuCandidates('us', 24, f.deps);
  assert.equal(f.calls.length, n, 'served from cache');
  f.clock.t += M.CBG_CACHE_TTL + 1;
  await M.gpuCandidates('us', 24, f.deps);
  assert.ok(f.calls.length > n, 'refreshed after the TTL');
});

await check('candidate id: stable GPU+country, plain, tamper-evident; select verifies current availability without billing', async () => {
  const id = M.cbGpuCandidateId('NVIDIA GeForce RTX 4090', 'US');
  assert.match(id, /^gpu_[A-Za-z0-9_-]+$/);
  assert.equal(id, M.cbGpuCandidateId('NVIDIA GeForce RTX 4090', 'US'));
  assert.deepEqual(M.cbGpuParseCandidateId(id), { gpu: 'NVIDIA GeForce RTX 4090', country: 'US' });
  for (const bad of [null, 42, 'gpu_', id + 'x', id.replace('gpu_', 'gpx_'), M.cbGpuCandidateId('NVIDIA GeForce RTX 5090', null), 'gpu_' + Buffer.from('A;B|US').toString('base64url'),
    'gpu_' + Buffer.from('RTX|us').toString('base64url'), 'gpu_' + 'A'.repeat(200)]) assert.equal(M.cbGpuParseCandidateId(bad), null, String(bad));
  const f = fake();
  const s = await M.cbGpuSelect(id, f.deps);
  assert.deepEqual(s.selection, { candidateId: id, gpu: 'NVIDIA GeForce RTX 4090', country: 'US', market: M4090 });
  assert.equal(s.commandExample, "cloudbite-compute run --provider nosana --gpu 'NVIDIA GeForce RTX 4090' --country US --timeout 300 -- nvidia-smi");
  assert.deepEqual(f.calls.map((c) => c.url), ['https://api.nosana.com/reservations/available'], 'one public read, nothing paid');
  assert.equal(await M.cbGpuSelect(M.cbGpuCandidateId('NVIDIA GeForce RTX 4090', 'BG'), fake().deps).catch((e) => e.code), 'not_available');
  assert.equal(await M.cbGpuSelect('gpu_bogus!', fake().deps).catch((e) => e.code), 'bad_request');
  assert.deepEqual(M.cbGpuValidSelection('NVIDIA GeForce RTX 4090', 'US'), { gpu: 'NVIDIA GeForce RTX 4090', country: 'US' });
  assert.equal(M.cbGpuValidSelection('NVIDIA GeForce RTX 4090', 'missing'), null);
});

console.log(`cloudbite-computer-gpu: ${count} checks passed`);
