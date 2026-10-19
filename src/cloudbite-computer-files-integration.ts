// Cloud Files integration: owner browser routes that drive the VM bridge (cloudbite-computer-files-bridge.ts) with the
// real runtime grant and the canonical catalog manifest. Contract: docs/cloudbite/files-integration.md.
//   POST files/agent/configure {requestId}               install agent + private capability on the RUNNING owned machine
//   POST files/materialize     {requestId,fileId,versionId?}  prepare one file under ~/CloudFiles (no app is launched)
//   POST files/close           {leaseId}                  release the open lease that materialize took
//   GET  files/agent/status                               agent counts only (no body, no source download)
// Rules: owner auth is done by computerRoute; POSTs here need the exact public Origin (an admin token without Origin is
// not enough). Without the R2 body store, configure/materialize answer store_not_configured before any provider call or
// capability grant; status answers available:false without a provider call; the catalog listing is unaffected. No route
// starts, stops or snapshots a machine, and the capability token never appears in a response or a log line.
import { computerAccounts, computerLabels, type ComputerAccount, type ComputerMachineRef } from './cloudbite-computer-contract';
import { cbExec, cbGetSandbox, cbUpload } from './cloudbite-daytona';
import { FILES_AGENT_SOURCE } from './cloudbite-computer-files-agent-source';
import {
  filesBridgeClose, filesBridgeEndpoint, filesBridgeInstall, filesBridgeMaterialize, filesBridgeStatus,
  type FilesBridgeDeps, type FilesBridgeResult, type FilesManifestEntry,
} from './cloudbite-computer-files-bridge';
import { filesAgentGrant, stubOf, type FilesEnv } from './cloudbite-computer-files-runtime';
import type { FileManifest } from './cloudbite-computer-files-contract';

export interface FilesMachineRpc {
  computerMachine(tag: string): Promise<{ ok: true; machine: ComputerMachineRef } | { error: unknown; status: number }>;
}
/** Provider I/O seam (tests inject recorded fakes; production uses the Daytona REST helpers). */
export type FilesBridgeIo = Pick<FilesBridgeDeps, 'getSandbox' | 'exec' | 'upload'>;
const DAYTONA_IO: FilesBridgeIo = { getSandbox: cbGetSandbox, exec: cbExec, upload: cbUpload };

const H = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, 'content-type': 'application/json' } });
const fail = (code: string, status: number, retryable = false) => json({ error: { code, message: code, retryable } }, status);
const send = (r: FilesBridgeResult) => json(r.body, r.status);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTES: Record<string, 'GET' | 'POST'> = {
  'files/agent/configure': 'POST', 'files/materialize': 'POST', 'files/close': 'POST', 'files/agent/status': 'GET',
};
/** Agent status fields passed to the browser: counts and readiness only (no ids, paths or capability data). */
const STATUS_FIELDS = ['states', 'unconfirmedOps', 'openLeases', 'pinned', 'transportConfigured', 'draining', 'freeBytes', 'reserveBytes', 'autoEvict', 'eviction'];

/** Bridge manifest from the canonical catalog plan: the parent chain (top-down) then the one file. */
export function filesBridgeManifestOf(m: FileManifest): FilesManifestEntry[] {
  return [
    ...m.dirs.map((d): FilesManifestEntry => ({ kind: 'dir', fileId: d.fileId, path: d.path })),
    { kind: 'file', fileId: m.fileId, path: m.path, versionId: m.versionId, size: m.size, sha256: m.sha256 },
  ];
}

/** Bridge dependencies for this owner. `machine()` returns only the recorded RUNNING owned machine; nothing starts one. */
export function filesBridgeDeps(env: FilesEnv, tag: string, computer: FilesMachineRpc, io: FilesBridgeIo = DAYTONA_IO): FilesBridgeDeps {
  const running = async () => {
    const r = await computer.computerMachine(tag);
    return 'ok' in r && r.machine.status === 'running' ? r.machine : null;
  };
  return {
    gateway: env.CLOUDBITE_GATEWAY_URL ?? '',
    machine: async () => { const m = await running(); return m && { id: m.id, name: m.name, account: m.account }; },
    account: (id) => { const a = computerAccounts(env).find((x) => x.id === id); return a ? { api: a.api, key: a.key } : null; },
    labels: (id) => computerLabels(tag, id as ComputerAccount),
    ...io,
    agentSource: FILES_AGENT_SOURCE,
    // Re-read right before minting: the grant goes only to the same machine the bridge just proved owned and running.
    grant: async ({ machine, requestId }) => {
      const m = await running();
      if (!m || m.id !== machine.id) return { error: { code: 'not_running', message: 'not_running', retryable: false }, status: 409 };
      return filesAgentGrant(env, tag, m, requestId);
    },
  };
}

async function readJson(req: Request, keys: readonly string[]): Promise<Record<string, unknown> | null> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  if (Number(req.headers.get('content-length') ?? 0) > 4096) return null;
  let v: unknown;
  try { const text = await req.text(); if (text.length > 4096) return null; v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k))) return null;
  return v as Record<string, unknown>;
}

export async function filesIntegrationRoute(req: Request, env: FilesEnv, op: string, tag: string, computer: FilesMachineRpc,
  io: FilesBridgeIo = DAYTONA_IO): Promise<Response | null> {
  const method = ROUTES[op];
  if (!method) return null;
  if (req.headers.get('sec-fetch-site') === 'cross-site') return fail('bad_origin', 403);
  if (req.method !== method) return fail('method_not_allowed', 405);
  if (method === 'POST' && req.headers.get('origin') !== env.ORIGIN) return fail('bad_origin', 403);
  const stub = stubOf(env, tag);
  // R2 is the only body store: without it nothing is installed, granted or fetched (catalog routes are unaffected).
  const bodies = !!stub && !!env.CLOUDBITE_FILES_BUCKET;
  if (op === 'files/agent/status') {
    if (!bodies) return json({ ok: true, available: false, reason: 'store_not_configured' });
    const r = await filesBridgeStatus(filesBridgeDeps(env, tag, computer, io));
    if (r.status !== 200) return send(r);
    const agent = (r.body.agent ?? {}) as Record<string, unknown>;
    return json({ ok: true, available: true, agent: Object.fromEntries(STATUS_FIELDS.filter((k) => k in agent).map((k) => [k, agent[k]])) });
  }
  if (op === 'files/close') {
    const input = await readJson(req, ['leaseId']); if (!input) return fail('bad_request', 400);
    return send(await filesBridgeClose(filesBridgeDeps(env, tag, computer, io), { leaseId: input.leaseId }));
  }
  const input = await readJson(req, op === 'files/materialize' ? ['requestId', 'fileId', 'versionId'] : ['requestId']);
  if (!input || typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) return fail('bad_request', 400);
  if (!bodies) return fail('store_not_configured', 503);
  if (!filesBridgeEndpoint(env.CLOUDBITE_GATEWAY_URL)) return fail('not_configured', 503);
  const deps = filesBridgeDeps(env, tag, computer, io);
  if (op === 'files/agent/configure') return send(await filesBridgeInstall(deps, { requestId: input.requestId }));
  // Materialize: the manifest is resolved inside the files DO from this owner's catalog; the client names only ids.
  if (typeof input.fileId !== 'string' || (input.versionId !== undefined && input.versionId !== null && typeof input.versionId !== 'string')) return fail('bad_request', 400);
  let plan;
  try { plan = await stub!.filesManifest(tag, { fileId: input.fileId, versionId: input.versionId ?? null }); }
  catch { return fail('catalog_unavailable', 503, true); }
  if (!('ok' in plan)) return json({ error: plan.error }, plan.status);
  const m = plan.body.manifest;
  const r = await filesBridgeMaterialize(deps, { requestId: input.requestId, manifest: filesBridgeManifestOf(m), fileId: m.fileId, versionId: m.versionId });
  if (r.status !== 200) return send(r);
  // Preparation places a verified copy in the private workspace; it does not open an application.
  return json({ ...r.body, workspace: '~/CloudFiles', launched: false });
}
