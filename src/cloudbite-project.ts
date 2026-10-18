// Cloudbite project Durable Object: one instance per project (getByName(projectId)), plus one 'registry'
// instance that bounds how many live projects hold sandboxes at once.
//
// Storage keys (project instance):
//   project                     ProjectRecord — brief, status, access-token hashes, retention deadline
//   expert:<run>                ExpertRecord — public ExpertRun + internal execution state (phase, claim, sandbox, capability hash)
//   cleanup:<run>:<kind>:<ref>  CleanupEntry — owned sandbox id or creation label to delete; one key each (no lost updates)
//   artifact:<run>:<path>       collected text artifact (≤ 64 KiB)
// Registry instance: reg → { [projectId]: expiresAt }
//
// Execution state machine per expert (alarm-driven, every external call bracketed by a claim):
//   queued → creating → booting → uploading → starting → running → collecting → final
// A claim id is persisted before external I/O; results are applied only if the same claim is still current and
// the project is still running, so cancellation and lost/duplicate ticks cannot resurrect or double-apply work.
// Sandbox creation records a unique label first: a lost create response is resolved by label lookup, never by a blind retry.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './state';
import type { ExpertActivity, ExpertArtifact, ExpertDefinition, ExpertRun, ProjectBrief, ProjectRun, ProjectStatus } from './cloudbite-contract';
import { CLOUDBITE_EXPERTS, buildExpertWorkspace } from './cloudbite-personas';
import {
  CB_ACTIVITY_MAX, CB_ACTIVITY_POSTS, CB_ARTIFACT_FILES, CB_ARTIFACT_MAX, CB_CAPABILITY_TTL, CB_CLAIM_STALE, CB_CLEANUP_MAX_TRIES,
  CB_EXPERT_DEADLINE, CB_INFERENCE_MAX_CALLS, CB_INFERENCE_TIMEOUT, CB_MAX_ACTIVE_PROJECTS, CB_MAX_CONCURRENT, CB_MAX_TOKENS, CB_POLL,
  CB_PROVISION_DEADLINE, CB_RETENTION, CB_WORKDIR, cloudbiteConfig, type CloudbiteConfig,
} from './cloudbite-config';
import { artifactPath, extraArtifactPath, isInvalid, PROJECT_ID, validateBrief, validateResult, validateWorkspace } from './cloudbite-validate';
import { CbDaytonaError, CB_LABEL_CLAIM, CB_LABEL_PROJECT, CB_LABEL_RUN, cbCreateSandbox, cbDeleteSandbox, cbDownload, cbExec, cbFindByLabels, cbGetSandbox, cbStartRunner, cbUpload, type CbSandbox } from './cloudbite-daytona';
import { chatMessages, nosanaChat } from './cloudbite-inference';
import { CB_RUNNER_PY, runnerCapability } from './cloudbite-runner';

export type CbFail = { error: string; status: number };
const fail = (status: number, error: string): CbFail => ({ error, status });
export const isCbFail = (x: unknown): x is CbFail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;

type Phase = 'queued' | 'creating' | 'booting' | 'uploading' | 'starting' | 'running' | 'collecting' | 'final';
interface Internal {
  phase: Phase;
  claim?: string; claimAt?: number;
  label: string;                 // random value of the cloudbite-claim label for this expert's one sandbox
  createIntentAt?: number;       // create was (or may have been) sent; resolve by label lookup
  lookups: number;
  sandboxId?: string; toolbox?: string;
  capHash?: string; capExp?: number;
  calls: number; inflightUntil?: number; posts: number;
  admittedAt?: number; deadline?: number; nextAt: number; doneSignal?: boolean;
  seq: number; failures: number;
}
interface ExpertRecord { run: ExpertRun; int: Internal }
interface ProjectRecord {
  id: string; brief: ProjectBrief; briefHash: string; status: ProjectStatus;
  createdAt: number; updatedAt: number; finishedAt?: number; purgeAt: number;
  tokens: string[]; runs: string[]; released?: boolean;
}
interface CleanupEntry { run: string; sandboxId?: string; label?: string; tries: number; nextAt: number; done?: boolean; stuck?: boolean }

const TERMINAL_PROJECT = new Set<ProjectStatus>(['completed', 'partial', 'failed', 'cancelled']);
const REGISTRY = 'registry';
const SANDBOX_BAD = new Set(['error', 'build_failed', 'destroyed', 'destroying']);

const rand = (bytes: number) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export async function cbHash(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Deterministic project id for a create requestId: a retried/lost create maps to the same project. */
export async function cbProjectId(requestId: string) { return 'cb' + (await cbHash(`cloudbite-project|${requestId}`)).slice(0, 32); }
const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max);

export class CloudbiteProject extends DurableObject<Env> {
  // ── overridable seams (tests inject a catalogue/clock; production uses the persona module) ──
  protected catalogue(): readonly ExpertDefinition[] { return CLOUDBITE_EXPERTS; }
  protected workspace(expert: ExpertDefinition, brief: ProjectBrief) { return buildExpertWorkspace(expert, brief); }
  protected clock() { return Date.now(); }
  protected config(): CloudbiteConfig | null { return cloudbiteConfig(this.env); }

  // ── registry instance ──
  async registryAcquire(projectId: string, until: number): Promise<{ ok: true } | CbFail> {
    const now = this.clock();
    const reg = Object.fromEntries(Object.entries((await this.ctx.storage.get<Record<string, number>>('reg')) ?? {}).filter(([, t]) => t > now));
    if (!reg[projectId] && Object.keys(reg).length >= CB_MAX_ACTIVE_PROJECTS) return fail(429, `at most ${CB_MAX_ACTIVE_PROJECTS} live Cloudbite projects may run at once`);
    reg[projectId] = Math.max(reg[projectId] ?? 0, until);
    await this.ctx.storage.put('reg', reg);
    return { ok: true };
  }
  async registryRelease(projectId: string) {
    const reg = (await this.ctx.storage.get<Record<string, number>>('reg')) ?? {};
    delete reg[projectId];
    await this.ctx.storage.put('reg', reg);
    return { ok: true };
  }

  // ── storage helpers ──
  private async load(): Promise<{ p: ProjectRecord; experts: ExpertRecord[] } | null> {
    const p = await this.ctx.storage.get<ProjectRecord>('project');
    if (!p) return null;
    const m = await this.ctx.storage.get<ExpertRecord>(p.runs.map((r) => `expert:${r}`));
    return { p, experts: p.runs.map((r) => m.get(`expert:${r}`)!).filter(Boolean) };
  }
  private view(p: ProjectRecord, experts: ExpertRecord[]): ProjectRun {
    return { id: p.id, brief: p.brief, status: p.status, experts: experts.map((e) => e.run), createdAt: p.createdAt, updatedAt: p.updatedAt };
  }
  private log(e: ExpertRecord, kind: ExpertActivity['kind'], message: string) {
    const at = this.clock();
    e.run.activity.push({ id: `${e.run.id}-${++e.int.seq}`, at, kind, message: clean(message, 400) });
    if (e.run.activity.length > CB_ACTIVITY_MAX) e.run.activity.splice(1, e.run.activity.length - CB_ACTIVITY_MAX);
    e.run.updatedAt = at;
  }
  private finish(e: ExpertRecord, status: 'completed' | 'failed' | 'cancelled', message: string) {
    e.run.status = status;
    if (status === 'failed') e.run.error = clean(message, 300);
    e.int.phase = 'final';
    e.int.capHash = undefined; e.int.capExp = undefined; e.int.inflightUntil = undefined; // revoke worker authority
    e.int.claim = undefined; e.int.claimAt = undefined;
    this.log(e, status === 'failed' ? 'error' : 'status', message);
  }
  private async addCleanup(entry: Omit<CleanupEntry, 'tries' | 'nextAt'>) {
    const key = `cleanup:${entry.run}:${entry.sandboxId ? `id:${entry.sandboxId}` : `label:${entry.label}`}`;
    if (await this.ctx.storage.get(key)) return;
    await this.ctx.storage.put(key, { ...entry, tries: 0, nextAt: 0 } satisfies CleanupEntry);
  }
  private async wake(at: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * Apply a mutation only if the project is still running and this claim is current. No await between
   * read and write, so the check and the update are one atomic step for this object.
   */
  private async commit(run: string, claim: string | null, mutate: (e: ExpertRecord, p: ProjectRecord) => void): Promise<boolean> {
    const [p, e] = await Promise.all([this.ctx.storage.get<ProjectRecord>('project'), this.ctx.storage.get<ExpertRecord>(`expert:${run}`)]);
    if (!p || !e || p.status !== 'running' || e.int.phase === 'final' || (claim !== null && e.int.claim !== claim)) return false;
    mutate(e, p);
    p.updatedAt = this.clock();
    await this.ctx.storage.put({ project: p, [`expert:${run}`]: e });
    return true;
  }

  // ── create / read / cancel / artifact (Worker has already checked admin, Origin and body size) ──
  async create(projectId: string, rawBrief: unknown): Promise<{ project: ProjectRun; accessToken: string } | CbFail> {
    if (!PROJECT_ID.test(projectId)) return fail(400, 'invalid project id');
    const catalogue = this.catalogue();
    if (!catalogue.length) return fail(503, 'expert catalogue is not integrated yet');
    const brief = validateBrief(rawBrief, catalogue);
    if (isInvalid(brief)) return fail(400, brief.invalid);
    if (projectId !== await cbProjectId(brief.requestId)) return fail(400, 'project id does not match requestId');
    if (brief.mode === 'live') {
      if (!this.config()) return fail(503, 'live execution is not configured');
      for (const id of brief.expertIds) {
        const w = validateWorkspace(this.workspace(catalogue.find((x) => x.id === id)!, brief));
        if (isInvalid(w)) return fail(503, `expert workspace pack unavailable for ${id}: ${w.invalid}`);
      }
    }
    const token = `cbt_${rand(32)}`;
    const [tokenHash, briefHash] = await Promise.all([cbHash(token), cbHash(JSON.stringify(brief))]);
    const now = this.clock();
    // From here: storage only, no other awaits — concurrent duplicate creates serialize on the input gate.
    const existing = await this.ctx.storage.get<ProjectRecord>('project');
    if (existing) {
      if (existing.briefHash !== briefHash) return fail(409, 'requestId was already used for a different brief');
      if (existing.tokens.length >= CB_MAX_TOKENS) return fail(409, 'this project has issued its maximum number of access tokens');
      existing.tokens.push(tokenHash);
      await this.ctx.storage.put('project', existing);
      const s = (await this.load())!;
      return { project: this.view(s.p, s.experts), accessToken: token };
    }
    const runs = brief.expertIds.map((_, i) => `e${i}`);
    const experts: ExpertRecord[] = brief.expertIds.map((id, i) => {
      const def = catalogue.find((x) => x.id === id)!;
      const rec: ExpertRecord = {
        run: { id: runs[i], expertId: id, name: def.name, status: 'queued', activity: [], artifacts: [], updatedAt: now },
        int: { phase: 'queued', label: rand(18).replace(/[-_]/g, 'x'), lookups: 0, calls: 0, posts: 0, nextAt: 0, seq: 0, failures: 0 },
      };
      this.log(rec, 'status', brief.mode === 'demo' ? '[demo] queued — simulated run, no sandbox or model is contacted' : 'queued for an independent Daytona sandbox');
      return rec;
    });
    const p: ProjectRecord = { id: projectId, brief, briefHash, status: 'running', createdAt: now, updatedAt: now, purgeAt: now + CB_RETENTION, tokens: [tokenHash], runs };
    await this.ctx.storage.put({ project: p, ...Object.fromEntries(experts.map((e) => [`expert:${e.run.id}`, e])) });
    await this.ctx.storage.setAlarm(now);
    return { project: this.view(p, experts), accessToken: token };
  }

  private async authorize(token: unknown) {
    if (typeof token !== 'string' || !/^cbt_[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, 'project access token required');
    const h = await cbHash(token);
    const s = await this.load();
    if (!s || !s.p.tokens.includes(h)) return fail(401, 'project access token is not valid');
    return s;
  }

  async read(token: unknown): Promise<ProjectRun | CbFail> {
    const s = await this.authorize(token);
    return isCbFail(s) ? s : this.view(s.p, s.experts);
  }

  async cancel(token: unknown): Promise<ProjectRun | CbFail> {
    const s = await this.authorize(token);
    if (isCbFail(s)) return s;
    if (TERMINAL_PROJECT.has(s.p.status)) return this.view(s.p, s.experts);
    const now = this.clock();
    s.p.status = 'cancelled'; s.p.finishedAt = now; s.p.updatedAt = now;
    const writes: Record<string, unknown> = { project: s.p };
    for (const e of s.experts) {
      if (e.int.phase !== 'final') this.finish(e, 'cancelled', 'cancelled — worker capability revoked, sandbox scheduled for deletion');
      writes[`expert:${e.run.id}`] = e;
    }
    // One atomic write: status, revocation and claims. Cleanup entries are written by whoever learned the ids.
    await this.ctx.storage.put(writes);
    await this.ctx.storage.setAlarm(now);
    return this.view(s.p, s.experts);
  }

  async artifact(token: unknown, expert: unknown, path: unknown): Promise<ExpertArtifact | CbFail> {
    const s = await this.authorize(token);
    if (isCbFail(s)) return s;
    if (!artifactPath(path)) return fail(400, 'artifact path is not allowed');
    const e = s.experts.find((x) => x.run.id === expert || x.run.expertId === expert);
    const meta = e?.run.artifacts.find((a) => a.path === path);
    if (!e || !meta) return fail(404, 'artifact not found');
    const content = await this.ctx.storage.get<string>(`artifact:${e.run.id}:${path}`);
    if (content === undefined) return fail(404, 'artifact not found');
    return { ...meta, content };
  }

  // ── /p/_cloudbite/worker/<project>/<run>/<action> (sandbox runner, per-expert capability) ──
  async worker(run: string, token: unknown, action: string, body: unknown): Promise<unknown | CbFail> {
    if (typeof token !== 'string' || !/^cbw_[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, 'worker capability required');
    const h = await cbHash(token);
    const now = this.clock();
    const s = await this.load();
    const e = s?.experts.find((x) => x.run.id === run);
    if (!s || !e || !e.int.capHash || e.int.capHash !== h || (e.int.capExp ?? 0) <= now) return fail(401, 'worker capability is not valid');
    if (s.p.status !== 'running' || e.int.phase === 'final') return fail(410, 'this expert run has ended');
    const save = () => this.ctx.storage.put({ project: { ...s.p, updatedAt: now }, [`expert:${run}`]: e });

    if (action === 'activity') {
      const b = body as { kind?: unknown; message?: unknown } | null;
      const kinds = ['status', 'thought', 'tool', 'artifact', 'error'];
      if (!b || !kinds.includes(b.kind as string) || typeof b.message !== 'string') return fail(400, 'activity must be {kind, message}');
      if (e.int.posts >= CB_ACTIVITY_POSTS) return fail(429, 'activity limit reached');
      e.int.posts++;
      this.log(e, b.kind as ExpertActivity['kind'], `sandbox: ${b.message}`);
      await save();
      return { ok: true };
    }
    if (action === 'complete') {
      e.int.doneSignal = true; e.int.nextAt = now;
      this.log(e, 'status', 'runner reported completion; collecting outputs from the sandbox');
      await save();
      await this.wake(now);
      return { ok: true };
    }
    if (action !== 'inference') return fail(404, 'unknown worker action');

    const messages = chatMessages(body);
    if (isInvalid(messages)) return fail(400, messages.invalid);
    if ((e.int.inflightUntil ?? 0) > now) return fail(429, 'one inference call at a time');
    if (e.int.calls >= CB_INFERENCE_MAX_CALLS) return fail(429, 'inference call budget exhausted');
    const cfg = this.config();
    if (!cfg) return fail(503, 'inference is not configured');
    // Reserve before the upstream call: a lost response still counts against the budget.
    e.int.calls++; e.int.inflightUntil = now + CB_INFERENCE_TIMEOUT + 5000;
    const n = e.int.calls;
    this.log(e, 'thought', `model call ${n}/${CB_INFERENCE_MAX_CALLS} via server-side Nosana endpoint`);
    await save();
    const r = await nosanaChat(cfg.nosana, messages);
    const after = this.clock();
    let ended = false;
    await this.commit(run, null, (x) => {
      if (x.int.capHash !== h) { ended = true; return; }
      x.int.inflightUntil = undefined;
      if ('error' in r) this.log(x, 'error', `model call ${n} failed: ${r.error}`);
    }).then((ok) => { if (!ok) ended = true; });
    if (ended || after > (e.int.capExp ?? 0)) return fail(410, 'this expert run has ended');
    return 'error' in r ? fail(r.status, r.error) : { content: r.content };
  }

  // ── alarm: advance experts, clean up owned sandboxes, finalize, purge ──
  async alarm() {
    await this.tick();
  }

  async tick() {
    const s = await this.load();
    if (!s) return;
    if (s.p.status === 'running') {
      if (s.p.brief.mode === 'demo') await this.demoTick(s.experts);
      else await this.liveTick(s.experts);
    }
    await this.cleanupTick();
    await this.finalize();
  }

  private async liveTick(experts: ExpertRecord[]) {
    const now = this.clock();
    const cfg = this.config();
    for (const e of experts.filter((x) => x.int.phase !== 'final')) {
      if (!cfg) await this.commit(e.run.id, null, (x) => this.finish(x, 'failed', 'live configuration is no longer available'));
      else if (e.int.deadline && now > e.int.deadline) await this.commit(e.run.id, null, (x) => this.finish(x, 'failed', 'timed out'));
    }
    if (!cfg) return;
    const fresh = (await this.load())!.experts;
    let active = fresh.filter((x) => x.int.phase !== 'queued' && x.int.phase !== 'final').length;
    for (const e of fresh.filter((x) => x.int.phase === 'queued')) {
      if (active >= CB_MAX_CONCURRENT) break;
      active++;
      await this.commit(e.run.id, null, (x) => {
        x.int.phase = 'creating'; x.int.admittedAt = now; x.int.deadline = now + CB_EXPERT_DEADLINE; x.int.nextAt = now;
        x.run.status = 'provisioning';
        this.log(x, 'status', 'provisioning a dedicated Daytona sandbox');
      });
    }
    const due = (await this.load())!.experts.filter((x) => !['queued', 'final'].includes(x.int.phase) && x.int.nextAt <= now && (!x.int.claim || (x.int.claimAt ?? 0) + CB_CLAIM_STALE < now));
    await Promise.allSettled(due.map((x) => this.step(cfg, x.run.id)));
  }

  private async step(cfg: CloudbiteConfig, run: string) {
    const claim = crypto.randomUUID();
    const now = this.clock();
    let phase = 'queued' as Phase;
    const got = await this.commit(run, null, (e) => {
      if (e.int.claim && (e.int.claimAt ?? 0) + CB_CLAIM_STALE >= now) { phase = 'final'; return; }
      e.int.claim = claim; e.int.claimAt = now; phase = e.int.phase;
    });
    if (!got || phase === 'final') return;
    const e = (await this.ctx.storage.get<ExpertRecord>(`expert:${run}`))!;
    const c = { api: cfg.daytona.api, key: cfg.daytona.key };
    const release = (mutate: (x: ExpertRecord) => void) => this.commit(run, claim, (x) => { mutate(x); x.int.claim = undefined; x.int.claimAt = undefined; });
    try {
      await this.advance(cfg, c, e, claim, release);
    } catch (err) {
      const status = err instanceof CbDaytonaError ? err.message : 'internal step error';
      await release((x) => {
        x.int.failures++;
        if (x.int.failures >= 5) this.finish(x, 'failed', `giving up after repeated errors (${status})`);
        else { x.int.nextAt = this.clock() + 5000 * x.int.failures; this.log(x, 'error', `${x.int.phase}: ${status}; retrying`); }
      });
    }
  }

  private async advance(cfg: CloudbiteConfig, c: { api: string; key: string }, e: ExpertRecord, claim: string, release: (m: (x: ExpertRecord) => void) => Promise<boolean>) {
    const run = e.run.id, pid = (await this.ctx.storage.get<ProjectRecord>('project'))!.id;
    const now = this.clock();
    const labels = { [CB_LABEL_PROJECT]: pid, [CB_LABEL_RUN]: run, [CB_LABEL_CLAIM]: e.int.label };
    const sb = (): CbSandbox => ({ id: e.int.sandboxId!, state: 'started', toolboxProxyUrl: e.int.toolbox });

    switch (e.int.phase) {
      case 'creating': {
        if (e.int.createIntentAt) {
          // A create may have reached Daytona without us seeing the answer. Adopt it by label; never create a second one.
          const found = await cbFindByLabels(c, labels);
          if (found.length) {
            for (const f of found) await this.addCleanup({ run, sandboxId: f.id });
            await release((x) => { x.int.sandboxId = found[0].id; x.int.toolbox = found[0].toolboxProxyUrl; x.int.createIntentAt = undefined; x.int.phase = 'booting'; x.run.sandboxId = found[0].id; this.log(x, 'status', `adopted sandbox ${found[0].id} after an unconfirmed create`); });
            return;
          }
          await release((x) => {
            x.int.lookups++;
            if (x.int.lookups >= 3) this.finish(x, 'failed', 'sandbox creation outcome could not be confirmed; no duplicate sandbox was created');
            else x.int.nextAt = now + 10_000;
          });
          return;
        }
        await this.addCleanup({ run, label: e.int.label });
        const marked = await this.commit(run, claim, (x) => { x.int.createIntentAt = now; });
        if (!marked) return;
        let created: CbSandbox;
        try { created = await cbCreateSandbox(c, labels, cfg.daytona.snapshot); }
        catch (err) {
          if (err instanceof CbDaytonaError && !err.uncertain) {
            await release((x) => { x.int.createIntentAt = undefined; this.finish(x, 'failed', `Daytona rejected sandbox creation (HTTP ${err.status})`); });
            return;
          }
          await release((x) => { x.int.nextAt = this.clock() + 10_000; this.log(x, 'error', 'sandbox create response was not received; checking by label'); });
          return;
        }
        await this.addCleanup({ run, sandboxId: created.id });
        await release((x) => {
          x.int.sandboxId = created.id; x.int.toolbox = created.toolboxProxyUrl; x.int.createIntentAt = undefined; x.int.phase = 'booting'; x.int.nextAt = this.clock();
          x.run.sandboxId = created.id;
          this.log(x, 'status', `sandbox ${created.id} created (${created.state})`);
        });
        return;
      }
      case 'booting': {
        const s = await cbGetSandbox(c, e.int.sandboxId!);
        if (s.state === 'started') {
          await release((x) => { x.int.toolbox = s.toolboxProxyUrl ?? x.int.toolbox; x.int.phase = 'uploading'; x.int.nextAt = this.clock(); this.log(x, 'status', 'sandbox started'); });
        } else if (SANDBOX_BAD.has(s.state)) {
          await release((x) => this.finish(x, 'failed', `sandbox entered state ${clean(String(s.state), 40)}`));
        } else if (now > (e.int.admittedAt ?? now) + CB_PROVISION_DEADLINE) {
          await release((x) => this.finish(x, 'failed', 'sandbox did not start in time'));
        } else await release((x) => { x.int.nextAt = this.clock() + 4000; });
        return;
      }
      case 'uploading': {
        const p = (await this.ctx.storage.get<ProjectRecord>('project'))!;
        const def = this.catalogue().find((x) => x.id === e.run.expertId);
        const files = def && validateWorkspace(this.workspace(def, p.brief));
        if (!files || isInvalid(files)) { await release((x) => this.finish(x, 'failed', 'expert workspace pack unavailable')); return; }
        const token = `cbw_${rand(32)}`;
        const capHash = await cbHash(token);
        // Persist the capability hash before it leaves this object; any earlier capability is replaced (revoked).
        if (!await this.commit(run, claim, (x) => { x.int.capHash = capHash; x.int.capExp = now + CB_CAPABILITY_TTL; })) return;
        const cap = runnerCapability(cfg.gateway, pid, run, e.run.expertId, token, now);
        const all = [...files, { path: 'runner.py', content: CB_RUNNER_PY }, { path: '.cloudbite/capability.json', content: JSON.stringify(cap) }];
        // Paths are validated plain names ([A-Za-z0-9_.-]), safe inside single quotes.
        const dirs = [...new Set(['.cloudbite', 'out', 'work', ...all.map((f) => f.path.split('/').slice(0, -1).join('/')).filter(Boolean)])];
        const mk = await cbExec(c, sb(), `bash -c 'umask 077 && mkdir -p ${dirs.map((d) => `${CB_WORKDIR}/${d}`).join(' ')}'`, 15);
        if (mk.exitCode !== 0) throw new CbDaytonaError(500, 'mkdir');
        for (const f of all) await cbUpload(c, sb(), `${CB_WORKDIR}/${f.path}`, f.content);
        await release((x) => { x.int.phase = 'starting'; x.int.nextAt = this.clock(); this.log(x, 'artifact', `workspace uploaded: ${files.map((f) => f.path).join(', ')} + runner.py`); });
        return;
      }
      case 'starting': {
        await cbStartRunner(c, sb(), `cloudbite-${run}`);
        await release((x) => { x.int.phase = 'running'; x.run.status = 'running'; x.int.nextAt = this.clock() + CB_POLL; this.log(x, 'status', 'python runner started inside the sandbox'); });
        return;
      }
      case 'running': {
        const r = await cbExec(c, sb(), `cat ${CB_WORKDIR}/out/done 2>/dev/null || true`, 10);
        const done = String(r.result ?? '').trim();
        if (done !== 'ok' && done !== 'error') { await release((x) => { x.int.nextAt = this.clock() + CB_POLL; }); return; }
        await release((x) => {
          if (done === 'error') this.finish(x, 'failed', 'runner finished without a valid final opinion');
          else { x.int.phase = 'collecting'; x.int.nextAt = this.clock(); }
        });
        return;
      }
      case 'collecting': {
        const read = (path: string, max = CB_ARTIFACT_MAX) => cbDownload(c, sb(), `${CB_WORKDIR}/${path}`, max);
        const [result, report, manifest] = [await read('out/result.json'), await read('out/report.md'), await read('out/manifest.json', 4096)];
        const opinion = result === null ? { invalid: 'out/result.json missing' } : validateResult(result, e.run.expertId);
        if (isInvalid(opinion) || !report?.trim()) {
          const why = isInvalid(opinion) ? opinion.invalid : 'out/report.md missing or empty';
          await release((x) => this.finish(x, 'failed', `malformed result: ${why}`));
          return;
        }
        let extra: string[] = [];
        try { const m = JSON.parse(manifest ?? '{}'); if (Array.isArray(m.files)) extra = m.files.filter(extraArtifactPath); } catch {}
        extra = [...new Set(extra)].slice(0, CB_ARTIFACT_FILES - 2);
        const contents: Array<[string, string]> = [['out/result.json', result!], ['out/report.md', report]];
        for (const path of extra) { const t = await read(path, 32 * 1024).catch(() => null); if (t !== null) contents.push([path, t]); }
        const bytes = (t: string) => new TextEncoder().encode(t).byteLength;
        const p = (await this.ctx.storage.get<ProjectRecord>('project'))!;
        const x = (await this.ctx.storage.get<ExpertRecord>(`expert:${run}`))!;
        // Same atomic check as commit(), but the artifact bodies go in the same write.
        if (p.status !== 'running' || x.int.phase === 'final' || x.int.claim !== claim) return;
        x.run.opinion = opinion;
        x.run.artifacts = contents.map(([path, t]) => ({ path, label: path === 'out/result.json' ? 'Structured opinion' : path === 'out/report.md' ? 'Expert report' : path.slice(4), bytes: bytes(t) }));
        this.finish(x, 'completed', `completed: ${opinion.direction}, self-assessed confidence ${opinion.confidence}`);
        p.updatedAt = this.clock();
        await this.ctx.storage.put({ project: p, [`expert:${run}`]: x, ...Object.fromEntries(contents.map(([path, t]) => [`artifact:${run}:${path}`, t])) });
        return;
      }
      default:
        await release(() => {});
    }
  }

  // Simulated run: no fetch, no sandbox. Every row says [demo].
  private async demoTick(experts: ExpertRecord[]) {
    let active = experts.filter((x) => x.run.status === 'provisioning' || x.run.status === 'running').length;
    for (const [i, e] of experts.entries()) {
      if (e.int.phase === 'final') continue;
      if (e.int.phase === 'queued' && active >= CB_MAX_CONCURRENT) continue;
      if (e.int.phase === 'queued') active++;
      let artifacts: Array<[string, string]> = [];
      await this.commit(e.run.id, null, (x, p) => {
        if (x.int.phase === 'queued') { x.int.phase = 'creating'; x.run.status = 'provisioning'; this.log(x, 'status', '[demo] simulated workspace prepared (no Daytona sandbox)'); }
        else if (x.int.phase === 'creating') { x.int.phase = 'running'; x.run.status = 'running'; this.log(x, 'tool', '[demo] simulated tool step: read PERSONA.md, PROJECT.md, WORKORDER.md'); }
        else {
          const directions = ['support', 'conditional', 'concern', 'conditional', 'abstain'] as const;
          const opinion = {
            direction: directions[i % 5], confidence: 40 + ((i * 13) % 45),
            summary: `[demo] Simulated ${x.run.name} view on "${p.brief.title}". Not produced by a model.`,
            evidence: ['[demo] simulated evidence'], assumptions: ['[demo] no live execution took place'], nextActions: ['Run in live mode for a real sandbox result'],
          };
          const report = `# [demo] ${x.run.name}\n\nThis is a simulated report. No Daytona sandbox or Nosana model was used.\n`;
          artifacts = [['out/result.json', JSON.stringify({ schema: 'cloudbite.expert-result/v1', expertId: x.run.expertId, opinion }, null, 2)], ['out/report.md', report]];
          x.run.opinion = opinion;
          x.run.artifacts = artifacts.map(([path, t]) => ({ path, label: `[demo] ${path}`, bytes: t.length }));
          this.finish(x, 'completed', '[demo] simulated completion');
        }
      });
      if (artifacts.length) await this.ctx.storage.put(Object.fromEntries(artifacts.map(([path, t]) => [`artifact:${e.run.id}:${path}`, t])));
    }
  }

  private async cleanupTick() {
    const entries = await this.ctx.storage.list<CleanupEntry>({ prefix: 'cleanup:' });
    if (!entries.size) return;
    const s = await this.load();
    const finalRuns = new Set(s?.experts.filter((e) => e.int.phase === 'final').map((e) => e.run.id));
    const cfg = this.config();
    const now = this.clock();
    await Promise.allSettled([...entries].map(async ([key, entry]) => {
      if (entry.done || entry.stuck || entry.nextAt > now || !finalRuns.has(entry.run)) return;
      if (!cfg || !s) return;
      const c = { api: cfg.daytona.api, key: cfg.daytona.key };
      try {
        if (entry.sandboxId) await cbDeleteSandbox(c, entry.sandboxId);
        else {
          const found = await cbFindByLabels(c, { [CB_LABEL_PROJECT]: s.p.id, [CB_LABEL_RUN]: entry.run, [CB_LABEL_CLAIM]: entry.label! });
          for (const f of found) await this.addCleanup({ run: entry.run, sandboxId: f.id });
        }
        await this.ctx.storage.put(key, { ...entry, done: true });
      } catch {
        const tries = entry.tries + 1;
        await this.ctx.storage.put(key, { ...entry, tries, nextAt: now + Math.min(30 * 60_000, 15_000 * 2 ** tries), stuck: tries >= CB_CLEANUP_MAX_TRIES });
      }
    }));
    // Entries added during this pass (ids found by label) are deleted on the next alarm.
  }

  private async finalize() {
    const s = await this.load();
    if (!s) return;
    const now = this.clock();
    const { p, experts } = s;
    if (p.status === 'running' && experts.every((e) => e.int.phase === 'final')) {
      const done = experts.filter((e) => e.run.status === 'completed').length;
      p.status = done === experts.length ? 'completed' : done > 0 ? 'partial' : 'failed';
      p.finishedAt = now; p.updatedAt = now;
      await this.ctx.storage.put('project', p);
    }
    const cleanup = [...(await this.ctx.storage.list<CleanupEntry>({ prefix: 'cleanup:' })).values()];
    const pending = cleanup.filter((x) => !x.done && !x.stuck);
    if (TERMINAL_PROJECT.has(p.status) && !pending.length && !p.released && p.brief.mode === 'live') {
      await this.env.CLOUDBITE?.getByName(REGISTRY).registryRelease(p.id).catch(() => {});
      p.released = true;
      await this.ctx.storage.put('project', p);
    }
    if (now >= p.purgeAt && (!pending.length || now >= p.purgeAt + CB_RETENTION)) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const times = [p.purgeAt];
    if (p.status === 'running') {
      for (const e of experts) if (e.int.phase !== 'final') times.push(e.int.phase === 'queued' ? now + 2000 : Math.max(e.int.nextAt, (e.int.claimAt ?? 0) + CB_CLAIM_STALE * (e.int.claim ? 1 : 0)));
      if (p.brief.mode === 'demo') times.push(now + 1500);
    }
    for (const x of pending) times.push(x.nextAt);
    if (pending.length && !this.config()) times.push(now + 10 * 60_000);
    await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...times)));
  }
}
