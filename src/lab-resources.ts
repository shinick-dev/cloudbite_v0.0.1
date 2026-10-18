// 실습실 사양(vCPU · GiB · 디스크 GiB) — 입력 확인·스냅샷 이름·스냅샷 정보 맞춰 보기. 순수 함수 (저장소·호출 없음).
// Daytona 는 스냅샷으로 만들 때 사양을 따로 못 준다 → 사양마다 스냅샷이 따로 있다 (lab/snapshot.ps1 와 같은 이름 규칙):
//   기본 세 가지(1/2/5 · 2/4/5 · 4/8/10)  <이름>-<cpu>c<mem>g        (예전 그대로)
//   그 밖 (직접 입력)                    <이름>-<cpu>c<mem>g<disk>d  (예: 2/8/10 → <이름>-2c8g10d)
// 상한 RES_MAX 는 숫자를 읽는 한계일 뿐 — 실제 조직·샌드박스 한도는 Daytona 가 지킨다.

export const RES_MAX = 2147483647;
export const LAB_PRESETS: readonly (readonly [number, number, number])[] = [[1, 2, 5], [2, 4, 5], [4, 8, 10]];

export interface LabResources { cpu: number; memory: number; disk: number }

/** 사양 한 항목: 정수 숫자 또는 십진수 문자열("8")만, 1 ~ RES_MAX. 그 밖(불리언·배열·객체·"1e1"·"1.0"·" 2"·"08"·음수·0·NaN)은 null */
export function labResourceInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= RES_MAX ? v : null;
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,9}$/.test(v)) return null;
  const n = Number(v);
  return String(n) === v && n <= RES_MAX ? n : null; // 문자열 전체가 그 수 그대로일 때만 (끝 줄바꿈 등 없음)
}

/** 세 항목 모두 맞으면 { cpu, memory, disk }, 하나라도 틀리면 null */
export function labResourcesOf(input: { cpu?: unknown; memory?: unknown; disk?: unknown }): LabResources | null {
  const cpu = labResourceInt(input.cpu), memory = labResourceInt(input.memory), disk = labResourceInt(input.disk);
  return cpu === null || memory === null || disk === null ? null : { cpu, memory, disk };
}

export const labIsPreset = (r: LabResources) => LAB_PRESETS.some(([c, m, d]) => c === r.cpu && m === r.memory && d === r.disk);

/** 이 사양으로 만들 스냅샷 이름. 저장된 예전 수업에 disk 가 없으면 예전 이름 그대로 */
export function labSnapshotName(base: string, r: { cpu: number; memory: number; disk?: number }) {
  const legacy = `${base}-${r.cpu}c${r.memory}g`;
  return typeof r.disk !== 'number' || labIsPreset(r as LabResources) ? legacy : `${legacy}${r.disk}d`;
}

/** Daytona GET /snapshots/<이름> 응답이 이 사양으로 쓸 수 있는가: active + cpu·mem·disk 가 정확히 같은 정수 */
export function labSnapshotFits(meta: unknown, r: LabResources): 'ok' | 'inactive' | 'mismatch' {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'mismatch';
  const m = meta as Record<string, unknown>;
  if (m.state !== 'active') return 'inactive';
  const same = (v: unknown, want: number) => typeof v === 'number' && Number.isInteger(v) && v === want;
  // 메모리: Daytona 는 mem. mem·memory 중 있는 것은 전부 맞아야 하고, 하나는 있어야 한다 (lab/snapshot.ps1 와 같게)
  const mems = (['mem', 'memory'] as const).filter((k) => m[k] !== undefined).map((k) => m[k]);
  const memOk = mems.length > 0 && mems.every((v) => same(v, r.memory));
  return same(m.cpu, r.cpu) && memOk && same(m.disk, r.disk) ? 'ok' : 'mismatch';
}
