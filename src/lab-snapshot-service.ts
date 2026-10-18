// 직접 입력 사양 스냅샷 자동 준비 — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// 관리 토큰 확인·입력 확인은 State 가 먼저 한다. 여기는 정해진 Daytona 주소(c.api)의 정해진 경로만 부른다:
//   GET  /snapshots/<목표>          목표 = <이름>-<cpu>c<mem>g<disk>d (lab-resources.ts labSnapshotName)
//   GET  /snapshots/<이름>-1c2g      원본 = 같은 조직의 기본 1/2/5 스냅샷. active·사양 1/2/5·빌드 레시피(Dockerfile)만 빌린다
//   POST /snapshots                 { name: 목표, cpu, memory, disk, buildInfo: { dockerfileContent } } — 이 목록 밖의 값은 넣지 않는다
// 저장 키:
//   snapjob:<목표>   만들기 요청 기록 { base, cpu, memory, disk, phase, at }. POST 전에 먼저 적는다 (재시작·동시 요청이 같은 목표를 두 번 POST 하지 않게).
//                    Dockerfile·공급자 응답·키·빌드 로그는 적지 않는다. 한 DO 에 끝나지 않은 기록은 하나뿐이라 저장소가 커지지 않는다.
//                    시간이 지났다고 지우지 않는다 — GET 이 알려진 끝 상태(active·error·build_failed·inactive)를 보여 줄 때만 지운다
// 결과가 애매한 POST(시간 초과·연결 끊김·5xx·408)는 다시 보내지 않는다 — GET 으로만 맞춰 보고, 끝내 못 찾으면 '확인 못 함' 으로 알린다 (기록은 남는다).
//   운영자가 Daytona 에서 확인하고 lab/snapshot.ps1 로 그 이름을 만들면(또는 실패 상태로 보이면) 다음 GET 이 기록을 푼다.
// 기존 스냅샷은 지우거나 바꾸지 않는다 (사양 다름·실패·inactive 도 알리기만). 준비가 끝났다는 판정은 언제나 GET 의 active + 사양 일치.
import { dt, DtError, type Dt } from './lab';
import { labSnapshotFits, labSnapshotName, type LabResources } from './lab-resources';
import type { Fail } from './state';

const fail = (status: number, error: string): Fail => ({ status, error });

export const SNAP_RETRY_MS = 5000;              // 화면이 다시 물을 간격 (202 응답의 retryAfterMs)
export const SNAP_GRACE = 90e3;                 // POST 뒤 GET 이 아직 404 여도 기다려 주는 시간
export const SNAP_RECIPE_MAX = 128 * 1024;      // 원본 Dockerfile 상한 (바이트)
export const SNAP_TIMEOUTS = { get: 10e3, post: 20e3 };
const SOURCE: LabResources = { cpu: 1, memory: 2, disk: 5 };
// Daytona defaults when the regional per-sandbox override is null.
// These are per-container limits, separate from the organization's total pool.
const DEFAULT_CAPS: LabResources = { cpu: 4, memory: 8, disk: 10 };
const capError = (r: LabResources, caps: Partial<LabResources>): Fail | null => {
  for (const [key, label, unit] of [['cpu', 'CPU', 'vCPU'], ['memory', '메모리', 'GiB'], ['disk', '디스크', 'GiB']] as const) {
    const max = caps[key];
    if (typeof max === 'number' && Number.isSafeInteger(max) && max > 0 && r[key] > max) {
      return fail(422, `Daytona 실습실 1개당 ${label} 상한은 ${max} ${unit}입니다 (요청 ${r[key]} ${unit}). 전체 조직의 남은 용량과는 별개입니다. 사양을 수정한 뒤 다시 요청하세요. 더 큰 사양은 Daytona의 한도 상향 승인이 필요합니다.`);
    }
  }
  return null;
};

/** Only translate known numeric resource errors; never echo provider text. */
function rejectedResource(error: unknown, r: LabResources): Fail | null {
  if (!(error instanceof DtError) || error.status !== 400) return null;
  const m = error.message.match(/^Daytona 400: (CPU|Memory|Disk) request ([1-9]\d*)(?:GB|GiB|vCPU)? exceeds maximum allowed per sandbox \(([1-9]\d*)(?:GB|GiB|vCPU)?\)(?:\.|\n|$)/);
  if (!m) return null;
  const key = ({ CPU: 'cpu', Memory: 'memory', Disk: 'disk' } as const)[m[1] as 'CPU' | 'Memory' | 'Disk'];
  return Number(m[2]) === r[key] ? capError(r, { [key]: Number(m[3]) }) : null;
}
const BUILDING = new Set(['pending', 'pulling', 'building', 'pending_validation', 'validating']);
const FAILED = new Set(['error', 'build_failed']);
const TERMINAL = new Set(['active', 'inactive', ...FAILED]); // 이 상태를 본 뒤에만 기록을 푼다 (모르는 상태·이상한 응답은 풀지 않음)

/** 화면에 주는 고정 상태 (공급자 문자열을 그대로 내보내지 않는다) */
export type SnapPhaseView = 'requested' | 'building' | 'checking';
export interface SnapPending { snapshotPreparing: true; snapshot: string; state: SnapPhaseView; retryAfterMs: number }
export interface SnapReady { snapshotReady: true; snapshot: string }
export type SnapResult = SnapPending | SnapReady | Fail;

interface SnapJob { base: string; cpu: number; memory: number; disk: number; phase: 'posting' | 'posted' | 'uncertain'; at: number }

export interface LabSnapshotDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  now(): number;
  timeouts(): { get: number; post: number };
}

type Got = { ok: true; meta: unknown } | { ok: false; status: number }; // status 0 = 연결 실패·시간 초과

export const snapPending = (snapshot: string, state: SnapPhaseView): SnapPending => ({ snapshotPreparing: true, snapshot, state, retryAfterMs: SNAP_RETRY_MS });
export const isSnapPending = (x: unknown): x is SnapPending => typeof x === 'object' && x !== null && (x as SnapPending).snapshotPreparing === true;

const stateOf = (meta: unknown) => {
  const st = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).state : undefined;
  return typeof st === 'string' ? st : '';
};

/**
 * 원본의 빌드 레시피: Dockerfile 문자열만. 바깥 컨텍스트 파일(contextHashes)·이미지에서 가져온 것(imageName)·
 * 살아 있는 샌드박스에서 뜬 것(sourceSandboxId)·컨테이너가 아닌 것(sandboxClass)이면 못 빌린다 (필드가 없거나 비었으면 괜찮다)
 */
export function snapRecipe(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  if (!empty(m.sourceSandboxId) || !empty(m.imageName)) return null;
  if (!empty(m.sandboxClass) && m.sandboxClass !== 'container') return null;
  const bi = m.buildInfo;
  if (!bi || typeof bi !== 'object' || Array.isArray(bi)) return null;
  const b = bi as Record<string, unknown>;
  const ctx = b.contextHashes;
  if (!(ctx === undefined || ctx === null || (Array.isArray(ctx) && ctx.length === 0))) return null;
  const df = b.dockerfileContent;
  if (typeof df !== 'string' || !df.trim()) return null;
  if (new TextEncoder().encode(df).byteLength > SNAP_RECIPE_MAX) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(df)) return null; // 탭·줄바꿈 밖의 제어 문자
  if (!/^\s*FROM\s+\S+/im.test(df)) return null;
  return df;
}

export class LabSnapshotService {
  constructor(private d: LabSnapshotDeps) {}
  private get s() { return this.d.storage; }
  #lock: Promise<unknown> = Promise.resolve(); // DO 안에서 한 번에 하나 (fetch 를 기다리는 동안 다른 요청이 끼어들지 않게)

  /** 목표 스냅샷을 준비한다: 있으면(active·사양 일치) ready, 만드는 중이면 pending, 없으면 원본 레시피로 한 번만 POST 하고 pending */
  ensure(c: Dt, base: string, r: LabResources): Promise<SnapResult> {
    const run = this.#lock.then(() => this.#ensure(c, base, r));
    this.#lock = run.catch(() => {});
    return run;
  }

  async #ensure(c: Dt, base: string, r: LabResources): Promise<SnapResult> {
    const target = labSnapshotName(base, r);
    const spec = `${r.cpu} vCPU · ${r.memory} GiB · 디스크 ${r.disk} GiB`;
    const jobs = await this.#jobs();
    const key = `snapjob:${target}`;
    const job = jobs.get(key);
    const g = await this.#get(c, target);
    if (g.ok) return this.#existing(g.meta, target, spec, r, job ? key : null);
    if (g.status !== 404) {
      if (job) return snapPending(target, 'checking');
      return fail(409, `스냅샷 ${target} 을 확인하지 못했습니다${g.status ? ` (Daytona ${g.status})` : ''}. 잠시 뒤 다시 해 보세요.`);
    }
    if (job) {
      if (this.d.now() - job.at < SNAP_GRACE) return snapPending(target, job.phase === 'posted' ? 'requested' : 'checking');
      return fail(409, `스냅샷 ${target} 만들기 요청의 결과를 확인하지 못했습니다. 같은 스냅샷이 두 번 만들어지지 않도록 자동으로 다시 요청하지 않습니다 — Daytona 에서 확인하고, 없으면 lab/snapshot.ps1 로 만드세요.`);
    }
    // 없음 → 새로 만들기. 진행 중인 다른 만들기가 있으면 기다린다 (한 DO 에 하나)
    for (const k of jobs.keys()) {
      if (k === key) continue;
      if (!(await this.#settled(c, k.slice('snapjob:'.length)))) {
        return fail(409, `다른 사양의 스냅샷(${k.slice('snapjob:'.length)}) 만들기가 아직 끝나지 않았습니다 (또는 결과를 확인하지 못함). 끝난 뒤 다시 해 보세요.`);
      }
      await this.s.delete(k);
    }
    const srcName = labSnapshotName(base, SOURCE);
    const src = await this.#get(c, srcName);
    if (!src.ok) {
      if (src.status === 404) return fail(409, `원본 스냅샷 ${srcName} 이 Daytona 에 없어 ${spec} 스냅샷을 자동으로 만들 수 없습니다. lab/snapshot.ps1 로 먼저 만드세요.`);
      return fail(409, `원본 스냅샷 ${srcName} 을 확인하지 못했습니다${src.status ? ` (Daytona ${src.status})` : ''}. 잠시 뒤 다시 해 보세요.`);
    }
    if (labSnapshotFits(src.meta, SOURCE) !== 'ok') return fail(409, `원본 스냅샷 ${srcName} 이 active 1 vCPU · 2 GiB · 디스크 5 GiB 가 아니라 자동으로 만들 수 없습니다. lab/snapshot.ps1 로 만드세요.`);
    const recipe = snapRecipe(src.meta);
    if (recipe === null) return fail(409, `원본 스냅샷 ${srcName} 의 빌드 정보를 쓸 수 없어 자동으로 만들 수 없습니다. lab/snapshot.ps1 로 만드세요.`);
    const limitError = await this.#limits(c, src.meta, r);
    if (limitError) return limitError;

    // POST 전에 먼저 적는다 — 여기서 죽어도 다음 요청은 GET 으로만 맞춰 본다
    const t = this.d.now();
    const rec: SnapJob = { base, cpu: r.cpu, memory: r.memory, disk: r.disk, phase: 'posting', at: t };
    await this.s.put(key, rec);
    let status = 200, resourceError: Fail | null = null;
    try {
      await dt<unknown>(c, 'POST', '/snapshots', { name: target, cpu: r.cpu, memory: r.memory, disk: r.disk, buildInfo: { dockerfileContent: recipe } }, AbortSignal.timeout(this.d.timeouts().post));
    } catch (e) { status = e instanceof DtError ? e.status : 0; resourceError = rejectedResource(e, r); }
    if (status === 200 || status === 409) { // 409: 같은 이름이 이미 있다 → GET 으로 맞춰 본다
      await this.s.put(key, { ...rec, phase: 'posted' } satisfies SnapJob);
      return snapPending(target, 'requested');
    }
    if (status >= 400 && status < 500 && status !== 408) { // Daytona 가 받지 않음 (만들어지지 않음) → 기록을 지운다, 다시 해도 된다
      await this.s.delete(key);
      if (resourceError) return resourceError;
      return fail(409, `Daytona 가 ${target} 스냅샷 만들기를 받지 않았습니다 (Daytona ${status}). 조직 한도·권한을 확인하세요.`);
    }
    await this.s.put(key, { ...rec, phase: 'uncertain' } satisfies SnapJob); // 애매함 → 다시 보내지 않는다
    return snapPending(target, 'checking');
  }

  /** Check confirmed regional policy before a new snapshot POST. Unknown policy
   * falls through to Daytona validation; never guess which region to use. */
  async #limits(c: Dt, meta: unknown, r: LabResources): Promise<Fail | null> {
    const org = (meta as Record<string, unknown>)?.organizationId;
    if (typeof org !== 'string' || !/^[a-f0-9-]{36}$/i.test(org)) return null;
    try {
      const usage = await dt<{ regionUsage?: Array<Record<string, unknown>> }>(c, 'GET', `/organizations/${org}/usage`, undefined, AbortSignal.timeout(this.d.timeouts().get));
      if (!Array.isArray(usage.regionUsage)) return null;
      const rows = usage.regionUsage.filter(x => x && x.sandboxClass === 'container' && typeof x.totalCpuQuota === 'number' && x.totalCpuQuota > 0);
      // Snapshot metadata currently has no region; a multi-region account must
      // rely on the exact provider rejection rather than an unrelated region.
      if (rows.length !== 1) return null;
      const row = rows[0], caps: Partial<LabResources> = {};
      for (const [key, field] of [['cpu', 'maxCpuPerSandbox'], ['memory', 'maxMemoryPerSandbox'], ['disk', 'maxDiskPerSandbox']] as const) {
        const value = row[field];
        if (value == null) caps[key] = DEFAULT_CAPS[key];
        else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) caps[key] = value;
      }
      return capError(r, caps);
    } catch { return null; }
  }

  /** 이름이 있는 스냅샷: active·사양 일치면 ready. 만드는 중이면 pending. 그 밖은 알리기만 (지우거나 다시 만들지 않는다) */
  async #existing(meta: unknown, target: string, spec: string, r: LabResources, jobKey: string | null): Promise<SnapResult> {
    const state = stateOf(meta);
    if (BUILDING.has(state)) return snapPending(target, 'building');
    if (jobKey && TERMINAL.has(state)) await this.s.delete(jobKey); // 끝 상태를 봤을 때만 기록을 푼다
    if (state === 'active') {
      return labSnapshotFits(meta, r) === 'ok' ? { snapshotReady: true, snapshot: target } : fail(409, `스냅샷 ${target} 의 사양이 ${spec} 와 다릅니다. 자동으로 바꾸지 않습니다.`);
    }
    if (FAILED.has(state)) return fail(409, `스냅샷 ${target} 만들기가 실패했습니다 (${state}). 자동으로 다시 만들지 않습니다 — Daytona 에서 확인하세요.`);
    if (state === 'inactive') return fail(409, `스냅샷 ${target} 이 쓸 수 있는 상태(active)가 아닙니다 (inactive). Daytona 에서 다시 켜 주세요.`);
    return fail(409, `스냅샷 ${target} 이 아직 쓸 수 있는 상태(active)가 아닙니다.`);
  }

  /** 다른 목표의 요청 기록이 끝났는가 (끝났으면 지워도 됨). 알려진 끝 상태만 true — 만드는 중·404·오류·모르는 상태는 false */
  async #settled(c: Dt, target: string) {
    const g = await this.#get(c, target);
    return g.ok && TERMINAL.has(stateOf(g.meta));
  }

  /** 남은 요청 기록. 시간으로는 지우지 않는다 (끝 상태를 봐야 풀린다) */
  #jobs() { return this.s.list<SnapJob>({ prefix: 'snapjob:' }); }

  async #get(c: Dt, name: string): Promise<Got> {
    try { return { ok: true, meta: await dt<unknown>(c, 'GET', `/snapshots/${encodeURIComponent(name)}`, undefined, AbortSignal.timeout(this.d.timeouts().get)) }; }
    catch (e) { return { ok: false, status: e instanceof DtError ? e.status : 0 }; }
  }
}
