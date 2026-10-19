// Cloud Files domain service fault tests. In-memory CatalogStore/BlobStore live here only (test doubles, not live
// persistence); the global fetch throws so nothing reaches a network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-files-'));
const built = await build({ entryPoints: ['src/cloudbite-computer-files.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };

const enc = new TextEncoder();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const nodeSha = () => { const h = createHash('sha256'); return { write: c => { h.update(c); }, digest: async () => h.digest('hex') }; };
const streamOf = (bytes, chunk = 3) => new ReadableStream({
  start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); } });
const drain = async (s) => { const parts = []; for await (const p of s) parts.push(...p); return Uint8Array.from(parts); };

class MemCatalog {
  constructor() { this.m = new Map(); this.fault = null; this.writes = 0; }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async getMany(keys) { const out = new Map(); for (const k of keys) if (this.m.has(k)) out.set(k, structuredClone(this.m.get(k))); return out; }
  async list(prefix, { startAfter, limit }) {
    return [...this.m.keys()].filter(k => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort()
      .slice(0, limit).map(k => [k, structuredClone(this.m.get(k))]);
  }
  async write(b) {
    this.writes++;
    const f = this.fault; this.fault = null;
    if (f === 'throw-before') throw new Error('lost');
    for (const [k, rev] of b.expect) if ((this.m.get(k)?.rev ?? 0) !== rev) return false;
    for (const [k, v] of b.put) this.m.set(k, structuredClone(v));
    for (const k of b.del) this.m.delete(k);
    if (f === 'throw-after') throw new Error('response lost');
    return true;
  }
}

class MemBlobs {
  constructor({ providerSha = true, durable = true } = {}) {
    this.kind = 'memory-test'; this.o = new Map(); this.providerSha = providerSha; this.durable = durable;
    this.calls = { put: 0, head: 0, get: 0 }; this.maxChunk = 0; this.chunks = 0; this.corrupt = null;
  }
  async put(key, body, { size, sha256 }) {
    this.calls.put++;
    const parts = [];
    for await (const c of body) { this.chunks++; this.maxChunk = Math.max(this.maxChunk, c.byteLength); parts.push(...c); }
    const bytes = Uint8Array.from(parts);
    if (bytes.length !== size) throw new Error('length');
    if (this.providerSha && sha(bytes) !== sha256) throw new Error('provider checksum rejected');
    this.o.set(key, bytes);
  }
  async head(key) {
    this.calls.head++;
    const b = this.o.get(key); if (!b) return null;
    const stored = this.corrupt?.(b) ?? b;
    return { size: stored.length, sha256: this.providerSha ? sha(stored) : null, durable: this.durable };
  }
  async get(key, range) {
    this.calls.get++;
    const b = this.o.get(key); if (!b) return null;
    const stored = this.corrupt?.(b) ?? b;
    return streamOf(range ? stored.slice(range.offset, range.offset + range.length) : stored, 4);
  }
}

let n = 0;
const ids = () => { let x = n++, s = ''; for (let i = 0; i < 26; i++) { s = 'abcdefghijklmnopqrstuvwxyz234567'[x & 31] + s; x = Math.floor(x / 32); } return s; };
let clock = 1_800_000_000_000;
function make(opts = {}) {
  const catalog = opts.catalog === null ? undefined : (opts.catalog ?? new MemCatalog());
  const blobs = opts.blobs === null ? undefined : (opts.blobs ?? new MemBlobs());
  const svc = new M.FilesService({ catalog, blobs, sha256: nodeSha, now: () => clock, randomId: ids, quotaBytes: opts.quota ?? 1 << 20, maxFileBytes: opts.max ?? 1 << 16 });
  return { svc, catalog, blobs };
}
const code = async (p, c) => { await assert.rejects(p, e => { assert.equal(e.code, c, `expected ${c} got ${e.code}: ${e.message}`); return true; }); };
let rq = 0; const R = () => 'req-' + (++rq);
const A = 'owner_a', B = 'owner_b';
async function upload(svc, owner, fileId, bytes, { base = null, epoch = 1, write = true } = {}) {
  const { upload: u } = await svc.beginUpload(owner, { requestId: R(), fileId, baseVersion: base, writerEpoch: epoch, size: bytes.length, sha256: sha(bytes) });
  if (write) await svc.writeUploadBody(owner, u.uploadId, streamOf(bytes));
  return u;
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

await test('list is metadata-only, paginated, ordered by collision key, cursor bound to parent', async () => {
  const { svc, blobs } = make({ quota: 1 << 24 });
  const names = Array.from({ length: 250 }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`);
  const created = [];
  for (const name of names) created.push((await svc.create(A, { requestId: R(), parentId: 'root', name, kind: 'file' })).entry);
  for (const e of created.slice(0, 5)) await svc.commitUpload(A, { uploadId: (await upload(svc, A, e.fileId, enc.encode('body ' + e.name))).uploadId });
  const before = { ...blobs.calls };
  const seen = []; let cursor = null, pages = 0;
  do {
    const r = await svc.list(A, { parentId: 'root', cursor, limit: 100 });
    assert.ok(r.entries.length <= 100); seen.push(...r.entries); cursor = r.nextCursor; pages++;
    assert.ok(!JSON.stringify(r).includes('body '));
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen.map(e => e.name), names);
  assert.equal(new Set(seen.map(e => e.fileId)).size, 250);
  assert.deepEqual(blobs.calls, before, 'list must not touch BlobStore');
  assert.equal(seen[0].size, enc.encode('body ' + names[0]).length);
  const dir = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'd', kind: 'dir' })).entry;
  const first = await svc.list(A, { parentId: 'root', limit: 1 });
  await code(svc.list(A, { parentId: dir.fileId, cursor: first.nextCursor }), 'invalid_cursor');
  await code(svc.list(A, { parentId: 'root', cursor: 'not!base64' }), 'invalid_cursor');
  await code(svc.list(A, { parentId: 'root', cursor: 'x'.repeat(2000) }), 'invalid_cursor');
  await code(svc.list(A, { parentId: 'root', limit: 201 }), 'invalid_request');
  await code(svc.list(A, { parentId: created[0].fileId }), 'not_a_directory');
});

await test('owner isolation: ids from another owner do not resolve; bad owner ids rejected', async () => {
  const { svc } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'secret.txt', kind: 'file' })).entry;
  const u = await upload(svc, A, f.fileId, enc.encode('a-secret'));
  const { result } = await svc.commitUpload(A, { uploadId: u.uploadId });
  assert.deepEqual((await svc.list(B, { parentId: 'root' })).entries, []);
  await code(svc.open(B, { fileId: f.fileId }), 'not_found');
  await code(svc.readVersion(B, { fileId: f.fileId, versionId: result.versionId }), 'not_found');
  await code(svc.rename(B, { requestId: R(), fileId: f.fileId, expectedRev: 2, name: 'x' }), 'not_found');
  await code(svc.commitUpload(B, { uploadId: u.uploadId }), 'not_found');
  await code(svc.getUpload(B, { uploadId: u.uploadId }), 'not_found');
  await code(svc.beginUpload(B, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'not_found');
  for (const bad of ['', '../a', 'a/b', 'x'.repeat(129), 7]) await code(svc.list(bad, { parentId: 'root' }), 'invalid_request');
});

await test('names: traversal, separators, controls, trailing dot/space, surrogates, length, symlink kind', async () => {
  const { svc } = make();
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'nul\u0000', 'tab\t', 'del\u007f', 'dot.', 'space ', 'bad\uD800', 'é'.repeat(128), 5])
    await code(svc.create(A, { requestId: R(), parentId: 'root', name, kind: 'file' }), 'invalid_name');
  await code(svc.create(A, { requestId: R(), parentId: 'root', name: 'link', kind: 'symlink' }), 'unsupported_kind');
  const ok = (await svc.create(A, { requestId: R(), parentId: 'root', name: '가'.repeat(85), kind: 'file' })).entry; // 255 bytes
  assert.equal(new TextEncoder().encode(ok.name).length, 255);
});

await test('Unicode normalization and case collisions; Korean names stored NFC; case-only rename allowed', async () => {
  const { svc } = make();
  const nfd = 'café.txt', nfc = 'café.txt';
  const e = (await svc.create(A, { requestId: R(), parentId: 'root', name: nfd, kind: 'file' })).entry;
  assert.equal(e.name, nfc);
  await code(svc.create(A, { requestId: R(), parentId: 'root', name: nfc, kind: 'file' }), 'name_conflict');
  await code(svc.create(A, { requestId: R(), parentId: 'root', name: 'CAFÉ.TXT', kind: 'file' }), 'name_conflict');
  const ko = (await svc.create(A, { requestId: R(), parentId: 'root', name: '한글 보고서.hwp', kind: 'file' })).entry;
  assert.equal(ko.name, '한글 보고서.hwp');
  await code(svc.create(A, { requestId: R(), parentId: 'root', name: '한글 보고서.HWP', kind: 'file' }), 'name_conflict');
  const r = await svc.rename(A, { requestId: R(), fileId: e.fileId, expectedRev: e.rev, name: 'CAFÉ.txt' });
  assert.equal(r.entry.name, 'CAFÉ.txt'); assert.equal(r.entry.fileId, e.fileId);
  const names = (await svc.list(A, { parentId: 'root' })).entries.map(x => x.name).sort();
  assert.deepEqual(names, ['CAFÉ.txt', '한글 보고서.hwp'].sort());
});

await test('rename/move keeps identity and versions; stale rev, cycles and depth bounded', async () => {
  const { svc } = make();
  const d1 = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'd1', kind: 'dir' })).entry;
  const d2 = (await svc.create(A, { requestId: R(), parentId: d1.fileId, name: 'd2', kind: 'dir' })).entry;
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'a.txt', kind: 'file' })).entry;
  const { result } = await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('v1'))).uploadId });
  const cur = (await svc.list(A, { parentId: 'root' })).entries.find(x => x.fileId === f.fileId);
  const moved = await svc.rename(A, { requestId: R(), fileId: f.fileId, expectedRev: cur.rev, name: 'b.txt', parentId: d2.fileId });
  assert.equal(moved.entry.fileId, f.fileId); assert.equal(moved.entry.currentVersion, result.versionId);
  assert.equal((await svc.open(A, { fileId: f.fileId })).descriptor.name, 'b.txt');
  assert.deepEqual((await svc.list(A, { parentId: 'root' })).entries.map(x => x.name), ['d1']);
  assert.deepEqual((await svc.list(A, { parentId: d2.fileId })).entries.map(x => x.fileId), [f.fileId]);
  await code(svc.rename(A, { requestId: R(), fileId: f.fileId, expectedRev: cur.rev, name: 'c.txt' }), 'stale_revision');
  await code(svc.rename(A, { requestId: R(), fileId: d1.fileId, expectedRev: d1.rev, parentId: d2.fileId }), 'invalid_move');
  await code(svc.rename(A, { requestId: R(), fileId: d1.fileId, expectedRev: d1.rev, parentId: d1.fileId }), 'invalid_move');
  await code(svc.rename(A, { requestId: R(), fileId: 'root', expectedRev: 1, name: 'x' }), 'invalid_move');
  let parent = 'root';
  for (let i = 0; i < 32; i++) parent = (await svc.create(A, { requestId: R(), parentId: parent, name: 'n' + i, kind: 'dir' })).entry.fileId;
  await code(svc.create(A, { requestId: R(), parentId: parent, name: 'too-deep', kind: 'dir' }), 'depth_exceeded');
});

await test('upload -> body -> verified commit; open descriptor and ranged stream; no provider keys in responses', async () => {
  const { svc, blobs } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'doc.md', kind: 'file' })).entry;
  const bytes = enc.encode('# hello cloud files\n'.repeat(20));
  const u = await upload(svc, A, f.fileId, bytes);
  assert.ok(blobs.chunks > 10 && blobs.maxChunk <= 3, 'body streamed in bounded chunks');
  assert.equal((await svc.getUpload(A, { uploadId: u.uploadId })).upload.phase, 'body_written');
  const c = await svc.commitUpload(A, { uploadId: u.uploadId });
  assert.equal(c.result.status, 'committed'); assert.equal(c.result.durable, true); assert.equal(c.result.sha256, sha(bytes));
  const d = await svc.open(A, { fileId: f.fileId });
  assert.equal(d.descriptor.versionId, c.result.versionId); assert.equal(d.descriptor.size, bytes.length);
  const full = await svc.readVersion(A, { fileId: f.fileId, versionId: c.result.versionId });
  assert.equal(sha(await drain(full.body)), sha(bytes));
  const part = await svc.readVersion(A, { fileId: f.fileId, versionId: c.result.versionId, offset: 2, length: 5 });
  assert.equal(new TextDecoder().decode(await drain(part.body)), 'hello');
  await code(svc.readVersion(A, { fileId: f.fileId, versionId: c.result.versionId, offset: 2, length: bytes.length }), 'invalid_request');
  for (const r of [c, d, full.descriptor, await svc.getUpload(A, { uploadId: u.uploadId }), await svc.listVersions(A, { fileId: f.fileId })]) {
    const s = JSON.stringify(r); assert.ok(!s.includes('objectKey') && !s.includes(`${A}/`) && !/https?:/.test(s), s);
  }
  await code(svc.writeUploadBody(A, u.uploadId, streamOf(bytes)), 'invalid_upload_state'); // committed versions are immutable
});

await test('requestId: same args replays persisted result, altered args conflict', async () => {
  const { svc } = make();
  const id = R();
  const a = await svc.create(A, { requestId: id, parentId: 'root', name: 'x.txt', kind: 'file' });
  const b = await svc.create(A, { requestId: id, parentId: 'root', name: 'x.txt', kind: 'file' });
  assert.deepEqual(a, b);
  await code(svc.create(A, { requestId: id, parentId: 'root', name: 'y.txt', kind: 'file' }), 'request_conflict');
  const bytes = enc.encode('abc'), up = { requestId: R(), fileId: a.entry.fileId, baseVersion: null, writerEpoch: 1, size: 3, sha256: sha(bytes) };
  const u1 = await svc.beginUpload(A, up), u2 = await svc.beginUpload(A, up);
  assert.equal(u1.upload.uploadId, u2.upload.uploadId);
  assert.equal((await svc.storageStatus(A)).status.pendingUploads, 1);
  await code(svc.beginUpload(A, { ...up, sha256: sha(enc.encode('abd')) }), 'request_conflict');
  await code(svc.beginUpload(A, { ...up, size: 4 }), 'request_conflict');
  await svc.writeUploadBody(A, u1.upload.uploadId, streamOf(bytes));
  const c1 = await svc.commitUpload(A, { uploadId: u1.upload.uploadId }), c2 = await svc.commitUpload(A, { uploadId: u1.upload.uploadId });
  assert.deepEqual(c1, c2);
  assert.equal((await svc.listVersions(A, { fileId: a.entry.fileId })).versions.length, 1);
  assert.equal((await svc.beginUpload(A, up)).upload.phase, 'committed'); // replay after commit reflects current state
});

await test('unknown commit outcome reconciles on retry with the same uploadId (applied and not applied)', async () => {
  for (const fault of ['throw-after', 'throw-before']) {
    const { svc, catalog } = make();
    const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'u.bin', kind: 'file' })).entry;
    const u = await upload(svc, A, f.fileId, enc.encode('payload-' + fault));
    catalog.fault = fault;
    await code(svc.commitUpload(A, { uploadId: u.uploadId }), 'commit_unknown');
    const r = await svc.commitUpload(A, { uploadId: u.uploadId });
    assert.equal(r.result.status, 'committed');
    const vs = (await svc.listVersions(A, { fileId: f.fileId })).versions;
    assert.equal(vs.length, 1); assert.equal(vs[0].versionId, r.result.versionId);
    const st = (await svc.storageStatus(A)).status;
    assert.equal(st.pendingUploads, 0); assert.equal(st.reservedBytes, 0); assert.equal(st.usedBytes, ('payload-' + fault).length);
  }
  const { svc, catalog } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'c.txt', kind: 'file' })).entry;
  catalog.fault = 'throw-after';
  const id = R();
  await code(svc.create(A, { requestId: id, parentId: 'root', name: 'lost.txt', kind: 'file' }), 'commit_unknown');
  const again = await svc.create(A, { requestId: id, parentId: 'root', name: 'lost.txt', kind: 'file' });
  assert.equal((await svc.list(A, { parentId: 'root' })).entries.filter(e => e.name === 'lost.txt').length, 1);
  assert.notEqual(again.entry.fileId, f.fileId);
});

await test('crash between blob write and catalog: pending upload is listed, commit verifies the provider object', async () => {
  const { svc, catalog, blobs } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'crash.txt', kind: 'file' })).entry;
  const bytes = enc.encode('written before crash');
  const u = await upload(svc, A, f.fileId, bytes, { write: false });
  catalog.fault = 'throw-before'; // body stored, phase update lost
  await svc.writeUploadBody(A, u.uploadId, streamOf(bytes));
  assert.equal((await svc.getUpload(A, { uploadId: u.uploadId })).upload.phase, 'begun');
  assert.equal(blobs.o.size, 1);
  assert.deepEqual((await svc.listPendingUploads(A)).uploads.map(x => x.uploadId), [u.uploadId]);
  const r = await svc.commitUpload(A, { uploadId: u.uploadId });
  assert.equal(r.result.status, 'committed');
  assert.deepEqual((await svc.listPendingUploads(A)).uploads, []);
  const lost = await upload(svc, A, f.fileId, enc.encode('never arrived'), { base: r.result.versionId, write: false });
  await code(svc.commitUpload(A, { uploadId: lost.uploadId }), 'body_missing');
  assert.equal((await svc.open(A, { fileId: f.fileId })).descriptor.versionId, r.result.versionId);
  const ab = await svc.abortUpload(A, { uploadId: lost.uploadId });
  assert.equal(ab.upload.phase, 'aborted');
  await code(svc.commitUpload(A, { uploadId: lost.uploadId }), 'invalid_upload_state');
  assert.equal((await svc.storageStatus(A)).status.reservedBytes, 0);
});

await test('stale base / out-of-order commit never overwrites: content preserved as conflict sibling', async () => {
  const { svc } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'report.final.docx', kind: 'file' })).entry;
  const v1 = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('v1'))).uploadId })).result;
  const older = await upload(svc, A, f.fileId, enc.encode('edit from machine X'), { base: v1.versionId });
  const newer = await upload(svc, A, f.fileId, enc.encode('edit from machine Y'), { base: v1.versionId });
  const v2 = (await svc.commitUpload(A, { uploadId: newer.uploadId })).result;
  assert.equal(v2.status, 'committed'); assert.equal(v2.versionSeq, 2);
  const late = (await svc.commitUpload(A, { uploadId: older.uploadId })).result;
  assert.equal(late.status, 'conflict'); assert.equal(late.fileId, f.fileId); assert.ok(late.conflictFileId);
  assert.equal((await svc.open(A, { fileId: f.fileId })).descriptor.versionId, v2.versionId, 'canonical stays newest');
  const sib = await svc.open(A, { fileId: late.conflictFileId });
  assert.equal(sib.descriptor.name, 'report.final (conflict 1).docx');
  assert.equal(new TextDecoder().decode(await drain((await svc.readVersion(A, { fileId: late.conflictFileId, versionId: late.versionId })).body)), 'edit from machine X');
  assert.equal(sib.descriptor.baseVersion, v1.versionId);
  const nullBase = await upload(svc, A, f.fileId, enc.encode('fresh without base'));
  const r = (await svc.commitUpload(A, { uploadId: nullBase.uploadId })).result;
  assert.equal(r.status, 'conflict');
  assert.equal((await svc.open(A, { fileId: r.conflictFileId })).descriptor.name, 'report.final (conflict 2).docx');
  assert.deepEqual((await svc.commitUpload(A, { uploadId: older.uploadId })).result, late, 'conflict result is idempotent');
});

await test('writer epoch fences stale writers; their uploads remain pending (content not discarded)', async () => {
  const { svc } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'w.txt', kind: 'file' })).entry;
  const u = await upload(svc, A, f.fileId, enc.encode('old writer'));
  const adv = await svc.advanceWriter(A, { requestId: R(), expectedEpoch: 1, machineId: 'm2' });
  assert.equal(adv.writerEpoch, 2);
  await code(svc.advanceWriter(A, { requestId: R(), expectedEpoch: 1, machineId: 'm3' }), 'stale_writer');
  await code(svc.commitUpload(A, { uploadId: u.uploadId }), 'stale_writer');
  await code(svc.beginUpload(A, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'stale_writer');
  assert.equal((await svc.getUpload(A, { uploadId: u.uploadId })).upload.phase, 'body_written');
  assert.equal((await svc.open(A, { fileId: f.fileId }).catch(e => e.code)), 'not_found');
  const ok = await upload(svc, A, f.fileId, enc.encode('new writer'), { epoch: 2 });
  assert.equal((await svc.commitUpload(A, { uploadId: ok.uploadId })).result.status, 'committed');
});

await test('durability and content verification: not durable, no provider checksum -> re-read, corruption, size, missing', async () => {
  const blobs = new MemBlobs({ durable: false });
  const { svc } = make({ blobs });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'd.bin', kind: 'file' })).entry;
  const bytes = enc.encode('durable please');
  const u = await upload(svc, A, f.fileId, bytes);
  await code(svc.commitUpload(A, { uploadId: u.uploadId }), 'not_durable');
  assert.equal((await svc.open(A, { fileId: f.fileId }).catch(e => e.code)), 'not_found', 'nothing claimed before durability');
  blobs.durable = true;
  assert.equal((await svc.commitUpload(A, { uploadId: u.uploadId })).result.status, 'committed');

  const plain = new MemBlobs({ providerSha: false });
  const p = make({ blobs: plain });
  const g = (await p.svc.create(A, { requestId: R(), parentId: 'root', name: 'g.bin', kind: 'file' })).entry;
  const gu = await upload(p.svc, A, g.fileId, bytes);
  plain.corrupt = b => { const c = b.slice(); c[0] ^= 1; return c; }; // same size, different content: HEAD alone would pass
  await code(p.svc.commitUpload(A, { uploadId: gu.uploadId }), 'hash_mismatch');
  plain.corrupt = b => b.slice(1);
  await code(p.svc.commitUpload(A, { uploadId: gu.uploadId }), 'size_mismatch');
  plain.corrupt = null;
  const gets = plain.calls.get;
  assert.equal((await p.svc.commitUpload(A, { uploadId: gu.uploadId })).result.status, 'committed');
  assert.equal(plain.calls.get, gets + 1, 'without provider checksum the body is re-read and hashed');
});

await test('body bounds: longer, shorter, wrong hash rejected and nothing stored; quota, size and pending limits', async () => {
  const { svc, blobs } = make({ quota: 100, max: 64 });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'q.bin', kind: 'file' })).entry;
  const bytes = enc.encode('0123456789');
  const u = await upload(svc, A, f.fileId, bytes, { write: false });
  await code(svc.writeUploadBody(A, u.uploadId, streamOf(enc.encode('0123456789ABC'))), 'too_large');
  await code(svc.writeUploadBody(A, u.uploadId, streamOf(enc.encode('01234'))), 'size_mismatch');
  await code(svc.writeUploadBody(A, u.uploadId, streamOf(enc.encode('0123456780'))), 'hash_mismatch');
  assert.equal(blobs.o.size, 0);
  await code(svc.beginUpload(A, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 65, sha256: sha('x') }), 'too_large');
  await upload(svc, A, f.fileId, new Uint8Array(60), { write: false });
  await code(svc.beginUpload(A, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 40, sha256: sha('x') }), 'quota_exceeded');
  await svc.abortUpload(A, { uploadId: u.uploadId });
  const st = (await svc.storageStatus(A)).status;
  assert.equal(st.reservedBytes, 60); assert.equal(st.quotaBytes, 100); assert.equal(st.maxFileBytes, 64);
  const big = make({ quota: 1 << 20, max: 1 << 10 });
  const h = (await big.svc.create(A, { requestId: R(), parentId: 'root', name: 'h', kind: 'file' })).entry;
  for (let i = 0; i < 64; i++) await upload(big.svc, A, h.fileId, new Uint8Array(1), { write: false });
  await code(big.svc.beginUpload(A, { requestId: R(), fileId: h.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'too_many_uploads');
  const dir = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'dir', kind: 'dir' })).entry;
  await code(svc.beginUpload(A, { requestId: R(), fileId: dir.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'is_a_directory');
});

await test('dirty vs clean vs pinned: stale acks never erase dirty, clean needs canonical version', async () => {
  const { svc } = make();
  await svc.advanceWriter(A, { requestId: R(), expectedEpoch: 1, machineId: 'pc1' });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'notes.txt', kind: 'file' })).entry;
  const v1 = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('v1'), { epoch: 2 })).uploadId })).result;
  const st = (patch) => svc.recordLocalState(A, { machineId: 'pc1', writerEpoch: 2, fileId: f.fileId, ...patch });
  assert.equal((await st({ seq: 1, versionId: v1.versionId, dirty: false })).applied, true);
  const stateOf = async () => (await svc.list(A, { parentId: 'root' })).entries.find(e => e.fileId === f.fileId).state;
  assert.equal(await stateOf(), 'local');
  assert.equal((await st({ seq: 3, versionId: v1.versionId, dirty: true })).applied, true);
  const late = await st({ seq: 2, versionId: v1.versionId, dirty: false });
  assert.equal(late.applied, false); assert.equal(late.local.dirty, true);
  assert.equal(await stateOf(), 'dirty');
  const u = await upload(svc, A, f.fileId, enc.encode('v2'), { base: v1.versionId, epoch: 2 });
  await code(st({ seq: 4, versionId: 'v_0000000000001_' + 'q'.repeat(26), dirty: false }), 'not_verified');
  const v2 = (await svc.commitUpload(A, { uploadId: u.uploadId })).result;
  assert.equal(await stateOf(), 'dirty', 'commit alone does not clear dirty');
  await code(st({ seq: 5, versionId: v1.versionId, dirty: false }), 'not_verified'); // v1 is no longer canonical
  assert.equal(await stateOf(), 'dirty');
  assert.equal((await svc.storageStatus(A)).status.dirtyFiles, 1);
  assert.equal((await st({ seq: 6, versionId: v2.versionId, dirty: false })).applied, true);
  assert.equal(await stateOf(), 'local');
  assert.equal((await svc.storageStatus(A)).status.dirtyFiles, 0);
  await code(svc.recordLocalState(A, { machineId: 'other', writerEpoch: 2, fileId: f.fileId, seq: 9, versionId: null, dirty: true }), 'stale_writer');
  const p1 = await svc.setPinned(A, { requestId: R(), fileId: f.fileId, pinned: true });
  await svc.setPinned(A, { requestId: R(), fileId: f.fileId, pinned: true });
  assert.equal(p1.entry.pinned, true);
  const status = (await svc.storageStatus(A)).status;
  assert.equal(status.pinnedFiles, 1); assert.equal(status.writerMachine, 'pc1'); assert.equal(status.writerEpoch, 2);
  await svc.setPinned(A, { requestId: R(), fileId: f.fileId, pinned: false });
  assert.equal((await svc.storageStatus(A)).status.pinnedFiles, 0);
});

await test('store_not_configured is explicit; catalog-only operations still work without a blob store', async () => {
  const noBlob = make({ blobs: null }).svc;
  const f = (await noBlob.create(A, { requestId: R(), parentId: 'root', name: 'meta-only', kind: 'file' })).entry;
  assert.equal((await noBlob.list(A, { parentId: 'root' })).entries.length, 1);
  await code(noBlob.beginUpload(A, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'store_not_configured');
  await code(noBlob.commitUpload(A, { uploadId: 'u_' + 'q'.repeat(26) }), 'store_not_configured');
  await code(noBlob.readVersion(A, { fileId: f.fileId, versionId: 'v_0000000000001_' + 'q'.repeat(26) }), 'store_not_configured');
  const s = (await noBlob.storageStatus(A)).status;
  assert.equal(s.blobs, 'not_configured'); assert.equal(s.blobKind, null); assert.equal(s.catalog, 'configured');
  const none = make({ catalog: null, blobs: null }).svc;
  await code(none.list(A, { parentId: 'root' }), 'store_not_configured');
  assert.equal((await none.storageStatus(A)).status.catalog, 'not_configured');
  const noHash = new M.FilesService({ catalog: new MemCatalog(), blobs: new MemBlobs(), randomId: ids });
  if (!globalThis.crypto?.DigestStream) {
    const g = (await noHash.create(A, { requestId: R(), parentId: 'root', name: 'h', kind: 'file' })).entry;
    const u = await noHash.beginUpload(A, { requestId: R(), fileId: g.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') });
    await code(noHash.writeUploadBody(A, u.upload.uploadId, streamOf(enc.encode('x'))), 'store_not_configured');
  }
});

await test('Durable Object catalog adapter: conditional batch is atomic; service runs on it', async () => {
  const data = new Map();
  const storage = {
    async get(k) { if (Array.isArray(k)) { const m = new Map(); for (const x of k) if (data.has(x)) m.set(x, structuredClone(data.get(x))); return m; } return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async list({ prefix, startAfter, limit }) { return new Map([...data.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort().slice(0, limit).map(k => [k, structuredClone(data.get(k))])); },
    async transaction(fn) {
      const staged = new Map(data), txn = {
        get: async (k) => { const m = new Map(); for (const x of k) if (staged.has(x)) m.set(x, structuredClone(staged.get(x))); return m; },
        put: async (o) => { for (const [k, v] of Object.entries(o)) staged.set(k, structuredClone(v)); },
        delete: async (ks) => { for (const k of ks) staged.delete(k); },
      };
      const r = await fn(txn); if (r) { data.clear(); for (const [k, v] of staged) data.set(k, v); } return r;
    },
  };
  const cat = M.durableObjectCatalog(storage);
  assert.equal(await cat.write({ expect: [['a', 0]], put: [['a', { rev: 1 }]], del: [] }), true);
  assert.equal(await cat.write({ expect: [['a', 0]], put: [['b', { rev: 1 }]], del: [] }), false);
  assert.equal(data.has('b'), false);
  const { svc } = make({ catalog: cat });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'do.txt', kind: 'file' })).entry;
  const r = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('in DO'))).uploadId })).result;
  assert.equal(r.status, 'committed');
  assert.equal((await svc.list(A, { parentId: 'root' })).entries[0].currentVersion, r.versionId);
});

await test('R2 adapter: forwards declared sha256 for provider-side verification, reports stored checksum, ranges', async () => {
  globalThis.FixedLengthStream ??= class extends TransformStream { constructor(n) { super(); this.n = n; } };
  const seen = {};
  const bucket = {
    async put(key, body, opts) { seen.put = { key, opts, bytes: await drain(body) }; return {}; },
    async head(key) { return key === 'k' ? { size: 3, checksums: { sha256: Uint8Array.from(Buffer.from(sha('abc'), 'hex')).buffer } } : null; },
    async get(key, opts) { seen.get = opts; return key === 'k' ? { body: streamOf(enc.encode('abc')) } : null; },
  };
  const r2 = M.r2BlobStore(bucket);
  await r2.put('k', streamOf(enc.encode('abc')), { size: 3, sha256: sha('abc') });
  assert.equal(seen.put.opts.sha256, sha('abc')); assert.equal(new TextDecoder().decode(seen.put.bytes), 'abc');
  assert.deepEqual(await r2.head('k'), { size: 3, sha256: sha('abc'), durable: true });
  assert.equal(await r2.head('missing'), null);
  await r2.get('k', { offset: 1, length: 1 }); assert.deepEqual(seen.get, { range: { offset: 1, length: 1 } });
  assert.equal(await r2.get('missing'), null);
});

console.log(`\n${passed} passed`);
