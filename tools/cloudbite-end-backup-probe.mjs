// Live end-backup probe, Node half: compiles the ACTUAL src/cloudbite-computer-backups.ts manager with esbuild into an
// artifact module and drives it (begin/tick/status/summary) with a private file-backed store and a real Daytona REST
// provider. The Python half (tools/cloudbite-end-backup-probe.py) owns the sandboxes and calls this per step.
//
//   node tools/cloudbite-end-backup-probe.mjs build --out DIR
//   node tools/cloudbite-end-backup-probe.mjs run --module FILE --store FILE --ops FILE --owner TAG --op begin|tick|status|summary
//        --source SANDBOX_ID [--request FILE]
//
// The key comes from DAYTONA_API_KEY only (never argv/output). Redirects are refused; errors carry only an HTTP status and
// a short sanitized provider reason. createSnapshot is allowed only for --source; removeSnapshot is always refused here
// (403, definite) because this probe deletes its one test snapshot itself, after a fresh ownership proof.

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const API = 'https://app.daytona.io/api';
const ACCOUNT = 'probe';
const SRC = fileURLToPath(new URL('../src/cloudbite-computer-backups.ts', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

class ProviderError extends Error {
  constructor(status, op, reason) { super(`daytona ${op} ${status ? `HTTP ${status}` : 'unanswered'}${reason ? `: ${reason}` : ''}`); this.status = status; }
}

function sanitize(text) {
  let s = String(text ?? '');
  const key = process.env.DAYTONA_API_KEY;
  if (key) s = s.split(key).join('<redacted>');
  return s.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
}

function restProvider(opsFile, source) {
  const key = process.env.DAYTONA_API_KEY;
  if (!key) throw new Error('DAYTONA_API_KEY is not set');
  const log = (rec) => appendFileSync(opsFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
  async function call(op, method, path, body) {
    const t = performance.now();
    let res;
    try {
      res = await fetch(API + path, {
        method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      log({ op, method, status: 0, ms: Math.round(performance.now() - t), error: sanitize(e?.name) });
      throw new ProviderError(0, op);
    }
    const text = await res.text().catch(() => '');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    const ms = Math.round(performance.now() - t);
    if (res.status >= 300) {
      const reason = sanitize(json?.message ?? json?.error ?? '');
      log({ op, method, status: res.status, ms, reason });
      throw new ProviderError(res.status, op, reason);
    }
    const pick = json && typeof json === 'object'
      ? { id: json.id, name: json.name, state: json.state, general: json.general, sourceSandboxId: json.sourceSandboxId } : null;
    log({ op, method, status: res.status, ms, view: pick });
    return json;
  }
  return {
    async getSnapshot(account, nameOrId) {
      if (account !== ACCOUNT) throw new ProviderError(403, 'snapshot-get', 'account substitution refused');
      try { return await call('snapshot-get', 'GET', `/snapshots/${encodeURIComponent(nameOrId)}`); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },
    async createSnapshot(account, machineId, name, opts) {
      if (account !== ACCOUNT || machineId !== source) throw new ProviderError(403, 'snapshot-create', 'not the owned source');
      if (opts?.includeMemory !== false) throw new ProviderError(400, 'snapshot-create', 'includeMemory must be false');
      await call('snapshot-create', 'POST', `/sandbox/${encodeURIComponent(machineId)}/snapshot`, { name, includeMemory: false });
    },
    async removeSnapshot(_account, id) {
      log({ op: 'snapshot-delete', method: 'DELETE', status: 403, refusedLocally: true, idPresent: !!id });
      throw new ProviderError(403, 'snapshot-delete', 'probe deletes its own snapshot after proof');
    },
  };
}

function fileStore(path) {
  return {
    async get(key) { if (!existsSync(path)) return undefined; return JSON.parse(readFileSync(path, 'utf8'))[key]; },
    async put(key, value) {
      const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
      all[key] = value;
      writeFileSync(path + '.tmp', JSON.stringify(all, null, 2));
      renameSync(path + '.tmp', path);
    },
  };
}

async function build(out) {
  const { buildSync, version } = await import('esbuild');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'backups-manager.mjs');
  buildSync({ entryPoints: [SRC], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: file, logLevel: 'error' });
  return { esbuild: version, source: SRC.replace(/\\/g, '/'), sourceSha256: sha(readFileSync(SRC)), module: file.replace(/\\/g, '/'), moduleSha256: sha(readFileSync(file)) };
}

async function run(a) {
  const { ComputerBackups } = await import(pathToFileURL(a.module).href);
  const provider = restProvider(a.ops, a.source);
  const m = new ComputerBackups({
    store: fileStore(a.store), provider, now: () => Date.now(), random: () => randomInt(0, 2 ** 32) / 2 ** 32,
    protectedNames: () => (a.protect ? a.protect.split(',') : []),
  });
  switch (a.op) {
    case 'begin': return m.begin(a.owner, JSON.parse(readFileSync(a.request, 'utf8')));
    case 'tick': return m.tick(a.owner);
    case 'status': return m.status(a.owner);
    case 'summary': return m.summary(a.owner);
    default: throw new Error(`unknown op ${a.op}`);
  }
}

const a = args(process.argv.slice(2));
try {
  const cmd = a._[0];
  const out = cmd === 'build' ? await build(a.out) : cmd === 'run' ? await run(a) : (() => { throw new Error('usage: build|run'); })();
  process.stdout.write(JSON.stringify(out ?? null) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ error: sanitize(e?.message), status: e?.status ?? null }) + '\n');
  process.exitCode = 2;
}
