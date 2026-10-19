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
  // beforeWrite / beforeGetMany: one-shot barrier hooks that run another operation between a plan's reads and its write
  constructor() { this.m = new Map(); this.fault = null; this.writes = 0; this.beforeWrite = null; this.beforeGetMany = null; }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async getMany(keys) {
    const h = this.beforeGetMany; if (h) { this.beforeGetMany = null; await h(keys); }
    const out = new Map(); for (const k of keys) if (this.m.has(k)) out.set(k, structuredClone(this.m.get(k))); return out;
  }
  async list(prefix, { startAfter, limit }) {
    return [...this.m.keys()].filter(k => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort()
      .slice(0, limit).map(k => [k, structuredClone(this.m.get(k))]);
  }
  async write(b) {
    this.writes++;
    const h = this.beforeWrite; if (h) { this.beforeWrite = null; await h(b); }
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
    this.calls = { put: 0, head: 0, get: 0 }; this.maxChunk = 0; this.chunks = 0; this.corrupt = null; this.afterPut = null; this.beforeHead = null;
  }
  async put(key, body, { size, sha256 }) {
    this.calls.put++;
    const parts = [];
    for await (const c of body) { this.chunks++; this.maxChunk = Math.max(this.maxChunk, c.byteLength); parts.push(...c); }
    const bytes = Uint8Array.from(parts);
    if (bytes.length !== size) throw new Error('length');
    if (this.providerSha && sha(bytes) !== sha256) throw new Error('provider checksum rejected');
    this.o.set(key, bytes);
    const h = this.afterPut; if (h) { this.afterPut = null; await h(key); }
  }
  async head(key) {
    this.calls.head++;
    const h = this.beforeHead; if (h) { this.beforeHead = null; await h(key); }
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
  const after = (await svc.storageStatus(A)).status;
  assert.equal(after.reservedBytes, lost.size, 'abort keeps the reservation until owned-object GC (body state unknown)');
  assert.equal(after.pendingUploads, 0);
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
  assert.equal(st.reservedBytes, 70, 'aborted upload stays reserved'); assert.equal(st.quotaBytes, 100); assert.equal(st.maxFileBytes, 64);
  await code(svc.beginUpload(A, { requestId: R(), fileId: f.fileId, baseVersion: null, writerEpoch: 1, size: 31, sha256: sha('x') }), 'quota_exceeded');
  const big = make({ quota: 1 << 20, max: 1 << 10 });
  const h = (await big.svc.create(A, { requestId: R(), parentId: 'root', name: 'h', kind: 'file' })).entry;
  for (let i = 0; i < 64; i++) await upload(big.svc, A, h.fileId, new Uint8Array(1), { write: false });
  await code(big.svc.beginUpload(A, { requestId: R(), fileId: h.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'too_many_uploads');
  const dir = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'dir', kind: 'dir' })).entry;
  await code(svc.beginUpload(A, { requestId: R(), fileId: dir.fileId, baseVersion: null, writerEpoch: 1, size: 1, sha256: sha('x') }), 'is_a_directory');
});

await test('abort keeps quota reservation: repeated body+abort cannot exceed quota; late in-flight body stays accounted', async () => {
  const { svc, blobs } = make({ quota: 100, max: 64 });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'churn.bin', kind: 'file' })).entry;
  const bytes = new Uint8Array(30).fill(7);
  let aborted = 0;
  for (let i = 0; i < 10; i++) {
    let u;
    try { u = await upload(svc, A, f.fileId, bytes); } catch (e) { assert.equal(e.code, 'quota_exceeded'); break; }
    const ab = await svc.abortUpload(A, { uploadId: u.uploadId }); assert.equal(ab.upload.phase, 'aborted');
    const again = await svc.abortUpload(A, { uploadId: u.uploadId }); assert.equal(again.upload.phase, 'aborted');
    aborted++;
  }
  assert.equal(aborted, 3, 'only as many staged bodies as the quota allows');
  let st = (await svc.storageStatus(A)).status;
  assert.equal(st.reservedBytes, 90); assert.equal(st.pendingUploads, 0, 'repeated abort decrements pending once');
  const staged = [...blobs.o.values()].reduce((a, b) => a + b.length, 0);
  assert.ok(staged <= st.quotaBytes && staged <= st.usedBytes + st.reservedBytes, 'physical staged bytes never exceed the charged quota');

  // a body that is still streaming when abort lands: the object arrives anyway and its bytes remain charged
  const g = make({ quota: 100, max: 64 });
  const h = (await g.svc.create(A, { requestId: R(), parentId: 'root', name: 'late.bin', kind: 'file' })).entry;
  const late = new Uint8Array(40).fill(3);
  const u = await upload(g.svc, A, h.fileId, late, { write: false });
  let push; const body = new ReadableStream({ start(c) { push = c; } });
  const writing = g.svc.writeUploadBody(A, u.uploadId, body);
  push.enqueue(late.slice(0, 20));
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await g.svc.abortUpload(A, { uploadId: u.uploadId })).upload.phase, 'aborted');
  push.enqueue(late.slice(20)); push.close();
  assert.equal((await writing).upload.phase, 'aborted', 'late body does not revive the upload');
  assert.equal(g.blobs.o.size, 1, 'staged object landed after abort');
  st = (await g.svc.storageStatus(A)).status;
  assert.equal(st.reservedBytes, 40, 'late in-flight body remains accounted'); assert.equal(st.pendingUploads, 0);
  await code(g.svc.commitUpload(A, { uploadId: u.uploadId }), 'invalid_upload_state');
  await code(g.svc.writeUploadBody(A, u.uploadId, streamOf(late)), 'invalid_upload_state');
  await code(g.svc.beginUpload(A, { requestId: R(), fileId: h.fileId, baseVersion: null, writerEpoch: 1, size: 61, sha256: sha('x') }), 'quota_exceeded');
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

// ---- race / depth regressions (barrier hooks in the test doubles; still in-memory, not live persistence) ----

const mkdir = async (svc, parentId, name) => (await svc.create(A, { requestId: R(), parentId, name, kind: 'dir' })).entry;
const mkchain = async (svc, parentId, prefix, n) => { const out = []; for (let i = 0; i < n; i++) out.push(parentId = (await mkdir(svc, parentId, prefix + i)).fileId); return out; };
const entryOf = async (catalog, id) => catalog.get(`fs/${A}/e/${id}`);
async function depthOf(catalog, id) { let d = 0; while (id !== 'root') { if (++d > 64) return Infinity; id = (await entryOf(catalog, id)).parentId; } return d; }

await test('race: recordLocalState with no dirty delta is fenced by a writer advance between read and write', async () => {
  const { svc, catalog } = make();
  await svc.advanceWriter(A, { requestId: R(), expectedEpoch: 1, machineId: 'pc1' });
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'r.txt', kind: 'file' })).entry;
  const st = (patch) => svc.recordLocalState(A, { machineId: 'pc1', writerEpoch: 2, fileId: f.fileId, versionId: null, dirty: true, ...patch });
  await st({ seq: 1 });
  catalog.beforeWrite = () => svc.advanceWriter(A, { requestId: R(), expectedEpoch: 2, machineId: 'pc2' });
  await code(st({ seq: 2 }), 'stale_writer'); // dirty -> dirty: delta 0, must still be fenced by the workspace record
  assert.equal((await catalog.get(`fs/${A}/l/pc1/${f.fileId}`)).seq, 1, 'stale ack not applied');
});

await test('race: concurrent directory moves through descendants cannot form a cycle', async () => {
  const { svc, catalog } = make();
  // distinct old parents so the two moves share no child counter: only the ancestor chain can serialize them
  const pa = await mkdir(svc, 'root', 'PA'), pb = await mkdir(svc, 'root', 'PB');
  const a = await mkdir(svc, pa.fileId, 'A'), b = await mkdir(svc, pb.fileId, 'B'), b1 = await mkdir(svc, b.fileId, 'b1');
  // move A under B/b1 while, between its reads and its write, B is moved under A
  catalog.beforeWrite = async () => { await svc.rename(A, { requestId: R(), fileId: b.fileId, expectedRev: b.rev, parentId: a.fileId }); };
  await code(svc.rename(A, { requestId: R(), fileId: a.fileId, expectedRev: a.rev, parentId: b1.fileId }), 'invalid_move');
  for (const id of [a.fileId, b.fileId, b1.fileId]) assert.ok(await depthOf(catalog, id) < 64, 'every node still reaches root');
  assert.equal((await entryOf(catalog, a.fileId)).parentId, pa.fileId);
  assert.equal((await entryOf(catalog, b.fileId)).parentId, a.fileId);
});

await test('depth: moving a directory deeper checks the existing subtree height', async () => {
  const { svc, catalog } = make();
  const deep = await mkchain(svc, 'root', 'p', 30);                 // deep[i] at depth i+1
  const x = await mkdir(svc, 'root', 'X'), xs = await mkchain(svc, x.fileId, 'x', 2); // X/x0/x1: height 2
  await code(svc.rename(A, { requestId: R(), fileId: x.fileId, expectedRev: x.rev, parentId: deep[29] }), 'depth_exceeded'); // x1 would be 33
  assert.equal((await entryOf(catalog, x.fileId)).parentId, 'root');
  const ok = await svc.rename(A, { requestId: R(), fileId: x.fileId, expectedRev: x.rev, parentId: deep[28] }); // x1 lands exactly at 32
  assert.equal(await depthOf(catalog, xs[1]), 32);
  // moving to an equal or shallower depth never needs a subtree scan and is always allowed
  const back = await svc.rename(A, { requestId: R(), fileId: x.fileId, expectedRev: ok.entry.rev, parentId: 'root' });
  assert.equal(back.entry.parentId, 'root');
  // a file may be moved anywhere a create would be allowed
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'f', kind: 'file' })).entry;
  const deeper = await mkdir(svc, deep[28], 'q'); // depth 30
  const last = await mkdir(svc, deeper.fileId, 'r'); // depth 31
  const fm = await svc.rename(A, { requestId: R(), fileId: f.fileId, expectedRev: f.rev, parentId: last.fileId });
  assert.equal(await depthOf(catalog, fm.entry.fileId), 32);
});

await test('depth: a large subtree is not moved deeper (bounded scan), but may move sideways', async () => {
  const { svc } = make({ quota: 1 << 24 });
  const big = await mkdir(svc, 'root', 'big'), other = await mkdir(svc, 'root', 'other');
  for (let i = 0; i <= 1000; i++) // FILES_LIMITS.moveScanMax + 1 entries
    await svc.create(A, { requestId: R(), parentId: big.fileId, name: 'f' + i, kind: 'file' });
  await code(svc.rename(A, { requestId: R(), fileId: big.fileId, expectedRev: big.rev, parentId: other.fileId }), 'invalid_move');
  const sub = await mkdir(svc, 'root', 'sub');
  const inner = await svc.rename(A, { requestId: R(), fileId: sub.fileId, expectedRev: sub.rev, parentId: other.fileId });
  const side = await svc.rename(A, { requestId: R(), fileId: big.fileId, expectedRev: big.rev, name: 'renamed' });
  assert.equal(side.entry.name, 'renamed');
  assert.equal(inner.entry.parentId, other.fileId);
});

await test('race: create in a subtree racing an ancestor move deeper cannot exceed depth 32', async () => {
  const { svc, catalog } = make();
  const x = await mkdir(svc, 'root', 'X'), xs = await mkchain(svc, x.fileId, 'x', 29); // xs[28] at depth 30
  const host = await mkdir(svc, 'root', 'host');
  // create at depth 31 under xs[28]; between its reads and write, X moves under host (+1): xs[28] -> 31, new entry would be 32
  catalog.beforeWrite = async () => { await svc.rename(A, { requestId: R(), fileId: x.fileId, expectedRev: x.rev, parentId: host.fileId }); };
  const c = await svc.create(A, { requestId: R(), parentId: xs[28], name: 'leaf', kind: 'dir' });
  assert.equal(await depthOf(catalog, c.entry.fileId), 32);
  // and the next level is rejected, even if racing
  catalog.beforeWrite = null;
  await code(svc.create(A, { requestId: R(), parentId: c.entry.fileId, name: 'too-deep', kind: 'file' }), 'depth_exceeded');
  const y = await mkdir(svc, 'root', 'Y'), ys = await mkchain(svc, y.fileId, 'y', 30); // ys[29] at depth 31
  const host2 = await mkdir(svc, 'root', 'host2');
  catalog.beforeWrite = async () => { await svc.rename(A, { requestId: R(), fileId: y.fileId, expectedRev: y.rev, parentId: host2.fileId }); };
  await code(svc.create(A, { requestId: R(), parentId: ys[29], name: 'late', kind: 'file' }), 'depth_exceeded');
  assert.equal(await depthOf(catalog, ys[29]), 32);
});

await test('race: subtree growth during a deeper move is caught by the scanned child counters', async () => {
  const { svc, catalog } = make();
  const deep = await mkchain(svc, 'root', 'p', 29);
  const x = await mkdir(svc, 'root', 'X'), x0 = await mkdir(svc, x.fileId, 'x0'); // height 1
  // moving X under deep[28] puts x0 at 31; meanwhile x0/child appears (would land at 32: fine) and then x0/child/g (33: not fine)
  let child;
  catalog.beforeWrite = async () => {
    child = await mkdir(svc, x0.fileId, 'child');
    await svc.create(A, { requestId: R(), parentId: child.fileId, name: 'g', kind: 'file' });
  };
  await code(svc.rename(A, { requestId: R(), fileId: x.fileId, expectedRev: x.rev, parentId: deep[28] }), 'depth_exceeded');
  assert.equal((await entryOf(catalog, x.fileId)).parentId, 'root');
});

await test('race: body write after a writer advance is refused before and after the provider put', async () => {
  const { svc, blobs } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'b.txt', kind: 'file' })).entry;
  const bytes = enc.encode('paid body');
  const u = await upload(svc, A, f.fileId, bytes, { write: false });
  await svc.advanceWriter(A, { requestId: R(), expectedEpoch: 1, machineId: 'm2' });
  const puts = blobs.calls.put;
  await code(svc.writeUploadBody(A, u.uploadId, streamOf(bytes)), 'stale_writer');
  assert.equal(blobs.calls.put, puts, 'preflight: nothing streamed to the provider');
  const u2 = await upload(svc, A, f.fileId, bytes, { write: false, epoch: 2 });
  blobs.afterPut = () => svc.advanceWriter(A, { requestId: R(), expectedEpoch: 2, machineId: 'm3' });
  await code(svc.writeUploadBody(A, u2.uploadId, streamOf(bytes)), 'stale_writer');
  assert.equal((await svc.getUpload(A, { uploadId: u2.uploadId })).upload.phase, 'begun');
  await code(svc.commitUpload(A, { uploadId: u2.uploadId }), 'stale_writer');
  await code(svc.open(A, { fileId: f.fileId }), 'not_found'); // no canonical version was claimed
});

await test('race: upload expiring during provider verification is not committed', async () => {
  const { svc, blobs } = make();
  const f = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'e.txt', kind: 'file' })).entry;
  const u = await upload(svc, A, f.fileId, enc.encode('slow verify'));
  const saved = clock;
  blobs.beforeHead = () => { clock = u.expiresAt + 1; };
  try { await code(svc.commitUpload(A, { uploadId: u.uploadId }), 'invalid_upload_state'); } finally { clock = saved; }
  await code(svc.open(A, { fileId: f.fileId }), 'not_found');
  assert.equal((await svc.listVersions(A, { fileId: f.fileId })).versions.length, 0);
});

await test('resolveManifest: metadata-only canonical path, ownership, version mismatch, collisions, concurrent rename', async () => {
  const { svc, catalog, blobs } = make();
  const docs = await mkdir(svc, 'root', '문서'), sub = await mkdir(svc, docs.fileId, 'Sub');
  const f = (await svc.create(A, { requestId: R(), parentId: sub.fileId, name: '보고서.txt', kind: 'file' })).entry;
  const g = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'sub', kind: 'file' })).entry; // case variant of Sub, other dir
  await code(svc.create(A, { requestId: R(), parentId: docs.fileId, name: 'SUB', kind: 'dir' }), 'name_conflict');
  const v1 = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('v1'))).uploadId })).result;
  const gv = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, g.fileId, enc.encode('g'))).uploadId })).result;
  const v2 = (await svc.commitUpload(A, { uploadId: (await upload(svc, A, f.fileId, enc.encode('v2!'), { base: v1.versionId })).uploadId })).result;
  const calls = { ...blobs.calls };
  const m = (await svc.resolveManifest(A, { fileId: f.fileId })).manifest;
  assert.deepEqual(m, { rootId: 'root', fileId: f.fileId, name: '보고서.txt', path: '문서/Sub/보고서.txt', versionId: v2.versionId,
    versionSeq: 2, size: 3, sha256: sha(enc.encode('v2!')),
    dirs: [{ fileId: docs.fileId, name: '문서', path: '문서' }, { fileId: sub.fileId, name: 'Sub', path: '문서/Sub' }] });
  const old = (await svc.resolveManifest(A, { fileId: f.fileId, versionId: v1.versionId })).manifest;
  assert.equal(old.versionId, v1.versionId); assert.equal(old.size, 2); assert.equal(old.sha256, sha(enc.encode('v1')));
  assert.equal((await svc.resolveManifest(A, { fileId: g.fileId })).manifest.path, 'sub');
  assert.deepEqual(blobs.calls, calls, 'resolveManifest must not touch BlobStore');
  await code(svc.resolveManifest(A, { fileId: f.fileId, versionId: gv.versionId }), 'not_found'); // version of another file
  await code(svc.resolveManifest(A, { fileId: f.fileId, versionId: 'v_0000000000001_' + 'q'.repeat(26) }), 'not_found');
  await code(svc.resolveManifest(A, { fileId: f.fileId, versionId: 'nope' }), 'invalid_request');
  await code(svc.resolveManifest(B, { fileId: f.fileId }), 'not_found');
  await code(svc.resolveManifest(A, { fileId: sub.fileId }), 'is_a_directory');
  await code(svc.resolveManifest(A, { fileId: 'root' }), 'is_a_directory');
  const empty = (await svc.create(A, { requestId: R(), parentId: 'root', name: 'empty', kind: 'file' })).entry;
  await code(svc.resolveManifest(A, { fileId: empty.fileId }), 'not_found');
  // a rename landing between the walk and its revalidation is never mixed into the path
  catalog.beforeGetMany = async () => { await svc.rename(A, { requestId: R(), fileId: sub.fileId, expectedRev: sub.rev, name: 'Moved' }); };
  assert.equal((await svc.resolveManifest(A, { fileId: f.fileId })).manifest.path, '문서/Moved/보고서.txt');
  const noBlob = make({ blobs: null, catalog });
  assert.equal((await noBlob.svc.resolveManifest(A, { fileId: f.fileId })).manifest.path, '문서/Moved/보고서.txt');
  // deepest allowed file resolves with 31 parent dirs
  const chain = await mkchain(svc, 'root', 'd', 31);
  const leaf = (await svc.create(A, { requestId: R(), parentId: chain[30], name: 'leaf', kind: 'file' })).entry;
  await svc.commitUpload(A, { uploadId: (await upload(svc, A, leaf.fileId, enc.encode('x'))).uploadId });
  const lm = (await svc.resolveManifest(A, { fileId: leaf.fileId })).manifest;
  assert.equal(lm.dirs.length, 31); assert.equal(lm.path.split('/').length, 32);
});

console.log(`\n${passed} passed`);
