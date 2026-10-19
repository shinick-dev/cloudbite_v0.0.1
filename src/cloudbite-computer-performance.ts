// CloudBite computer performance: in-sandbox cgroup sample, estimated Daytona pricing and the fixed hot-increase plans.
// The sample command is fixed and read-only: isolated python (-I ignores PYTHON* env and user site, -S skips site, -B writes
// no bytecode) reads only cgroup/proc counters. Unknown values stay null; nothing is guessed as zero. The memory limit is
// the sandbox cgroup limit, or the Daytona allocation when the cgroup is unbounded; the host total is never the limit.

export interface ComputerAllocation { cpu: number; memoryGiB: number; diskGiB: number }
export interface ComputerMetrics { cpuPercent: number | null; memoryUsedGiB: number; memoryLimitGiB: number; memoryPercent: number; load1: number }
export interface ComputerPlan { cpu: number; memoryGiB: number; usdPerHour: number; deltaUsdPerHour: number }

/** https://www.daytona.io/pricing, verified 2026-10-19. Disk: the first 5 GiB are free. Estimate only. */
export const COMPUTER_PRICING = {
  asOf: '2026-10-19', url: 'https://www.daytona.io/pricing', estimated: true as const,
  cpuPerHour: 0.0504, memoryGiBPerHour: 0.0162, diskGiBPerHour: 0.000108, freeDiskGiB: 5,
};
/** Hot increases only (running machine, CPU and RAM together); disk never changes. */
export const COMPUTER_PLANS: ReadonlyArray<{ cpu: number; memoryGiB: number }> = Object.freeze([
  { cpu: 4, memoryGiB: 8 }, { cpu: 8, memoryGiB: 16 }, { cpu: 16, memoryGiB: 32 },
]);
export const COMPUTER_METRICS_CACHE_MS = 10_000;
export const COMPUTER_METRICS_TIMEOUT_S = 10;

const SCRIPT = `import json,os,time
def r(p):
 try:
  with open(p) as f:return f.read(4096).strip()
 except Exception:return None
def kv(p):
 o={}
 for l in (r(p) or "").splitlines():
  k,_,v=l.partition(" ")
  if v.strip().isdigit():o[k]=int(v)
 return o
def cpu():
 u=kv("/sys/fs/cgroup/cpu.stat").get("usage_usec")
 if u is not None:return u
 v=r("/sys/fs/cgroup/cpuacct/cpuacct.usage")
 return int(v)//1000 if v and v.isdigit() else None
u0=cpu();t0=time.monotonic();time.sleep(1);u1=cpu();t1=time.monotonic()
ms=kv("/sys/fs/cgroup/memory.stat") or kv("/sys/fs/cgroup/memory/memory.stat")
mi={}
for l in (r("/proc/meminfo") or "").splitlines():
 k,_,v=l.partition(":");p=v.split()
 if p and p[0].isdigit():mi[k]=int(p[0])*1024
print(json.dumps({"v":1,"u0":u0,"u1":u1,"dt":t1-t0,"cpuMax":r("/sys/fs/cgroup/cpu.max"),"cfsQuota":r("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),"cfsPeriod":r("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),"memCurrent":r("/sys/fs/cgroup/memory.current") or r("/sys/fs/cgroup/memory/memory.usage_in_bytes"),"memMax":r("/sys/fs/cgroup/memory.max") or r("/sys/fs/cgroup/memory/memory.limit_in_bytes"),"inactiveFile":ms.get("inactive_file",ms.get("total_inactive_file")),"hostTotal":mi.get("MemTotal"),"hostAvailable":mi.get("MemAvailable"),"load":r("/proc/loadavg"),"ncpu":os.cpu_count()}))`;
export const COMPUTER_METRICS_COMMAND = `/usr/bin/python3 -I -S -B -c '${SCRIPT}'`;

const GiB = 1024 ** 3;
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const usd = (x: number) => round(x, 6);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const ratio = (q: number | null, p: number | null) => (q && p && q > 0 && p > 0 ? q / p : null);

export function computerHourlyCost(a: ComputerAllocation): number {
  const p = COMPUTER_PRICING;
  return usd(a.cpu * p.cpuPerHour + a.memoryGiB * p.memoryGiBPerHour + Math.max(0, a.diskGiB - p.freeDiskGiB) * p.diskGiBPerHour);
}

/** Plans strictly above the current allocation in at least one of CPU/RAM and below it in neither. */
export function computerPlans(current: ComputerAllocation): ComputerPlan[] {
  const base = computerHourlyCost(current);
  return COMPUTER_PLANS.filter((p) => p.cpu >= current.cpu && p.memoryGiB >= current.memoryGiB && (p.cpu > current.cpu || p.memoryGiB > current.memoryGiB))
    .map((p) => { const usdPerHour = computerHourlyCost({ ...p, diskGiB: current.diskGiB }); return { ...p, usdPerHour, deltaUsdPerHour: usd(usdPerHour - base) }; });
}

export const isComputerPlan = (cpu: unknown, memoryGiB: unknown) => COMPUTER_PLANS.some((p) => p.cpu === cpu && p.memoryGiB === memoryGiB);

/**
 * Parse the sample. `alloc` is the Daytona allocation, used only when the cgroup does not bound the sandbox. Memory used is
 * cgroup current minus reclaimable inactive file cache; the host meminfo is a fallback for the used figure only, bounded by
 * the limit. Returns null when the memory limit or load cannot be known.
 */
export function parseComputerMetrics(raw: string, alloc: { cpu: number | null; memoryGiB: number | null }): ComputerMetrics | null {
  const line = raw.slice(-8192).split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
  if (!line) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== 'object' || j.v !== 1) return null;
  const hostTotal = num(j.hostTotal), hostAvailable = num(j.hostAvailable);
  // A cgroup limit counts only if it actually bounds the sandbox ("max" or the v1 sentinel do not).
  const cgLimit = num(j.memMax);
  const bounded = cgLimit !== null && cgLimit > 0 && cgLimit < 2 ** 60 && (hostTotal === null || cgLimit < hostTotal);
  const limit = bounded ? cgLimit : alloc.memoryGiB && alloc.memoryGiB > 0 ? alloc.memoryGiB * GiB : null;
  if (!limit) return null;
  const current = num(j.memCurrent), inactive = num(j.inactiveFile) ?? 0;
  const used = current !== null ? Math.max(0, current - inactive)
    : hostTotal !== null && hostAvailable !== null && hostTotal >= hostAvailable ? hostTotal - hostAvailable : null;
  if (used === null) return null;
  const load = typeof j.load === 'string' ? num(j.load.split(/\s+/)[0]) : null;
  if (load === null) return null;
  const memoryUsed = Math.min(used, limit);
  let cpuPercent: number | null = null;
  const u0 = num(j.u0), u1 = num(j.u1), dt = num(j.dt), ncpu = num(j.ncpu);
  const v2 = typeof j.cpuMax === 'string' ? j.cpuMax.split(/\s+/) : [];
  const cpus = [ratio(num(v2[0]), num(v2[1])), ratio(num(j.cfsQuota), num(j.cfsPeriod)), alloc.cpu, ncpu]
    .find((x): x is number => typeof x === 'number' && x > 0);
  if (u0 !== null && u1 !== null && u1 >= u0 && dt !== null && dt >= 0.2 && cpus) {
    const n = ncpu ? Math.min(cpus, ncpu) : cpus;
    cpuPercent = round(Math.min(100, ((u1 - u0) / 1e6 / dt / n) * 100), 1);
  }
  return {
    cpuPercent,
    memoryUsedGiB: round(memoryUsed / GiB, 2), memoryLimitGiB: round(limit / GiB, 2),
    memoryPercent: round((memoryUsed / limit) * 100, 1), load1: round(load, 2),
  };
}
