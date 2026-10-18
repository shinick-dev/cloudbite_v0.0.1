// 수업 만들기 입력 확인 · 샌드박스 만들기 본문 · 자리 깨우기 응답 — State(DO) 가 쓰는 순수 함수.
// 저장소·공급자·Daytona 호출·시계 읽기는 없다 (오늘 날짜·지금 시각은 State 가 함수로 넘긴다). 순서와 저장은 state.ts 의 labCreate·labJoin.
import { materials, READY, SLEEPING, WAKING, type Sandbox } from './lab';
import { labIsPreset, labResourceInt, labResourcesOf, labSnapshotName } from './lab-resources';
import { labShareEnv, type ProviderDef } from './providers';
import type { Lab, LabInput, Seat } from './state';

/** 수업 만들기 규칙 — 상수·기본값은 state.ts, 환경 플래그는 State 의 env 에서 */
export interface LabRules {
  maxSeats: number; hours: number[]; budgets: number[];
  defaults: { snapshot: string; model: string };
  allowShortTtl: boolean;  // env.ALLOW_SHORT_TTL === '1' (dev: 알람 정리 테스트)
  devHttp: boolean;        // !!env.LAB_DAYTONA_API (dev: http 게이트웨이·자료 주소)
  today: () => string;     // 이름이 비었을 때만 부른다
}

export interface LabSpec {
  seats: number; hours: number; budget: number; cpu: number; memory: number; disk: number;
  name: string; gw: string; snapshot: string; model: string;
}

/** 입력을 숫자·문자열로 (아직 확인 전) */
export function labSpecOf(input: LabInput, r: Pick<LabRules, 'defaults' | 'today'>): LabSpec {
  const seats = Number(input.seats), hours = Number(input.hours), budget = Number(input.budget);
  // 사양은 Number() 로 바꾸지 않는다 (true·[2]·"1e1" 이 숫자가 되지 않게). 틀리면 NaN → labNumbersError
  const res = labResourcesOf(input);
  const cpu = res?.cpu ?? NaN, memory = res?.memory ?? NaN, disk = res?.disk ?? NaN;
  const name = String(input.name ?? '').trim().slice(0, 40) || r.today();
  const gw = String(input.gw ?? '').trim().replace(/\/+$/, '');
  const snapshot = String(input.snapshot ?? '').trim() || r.defaults.snapshot;
  const model = String(input.model ?? '').trim() || r.defaults.model;
  return { seats, hours, budget, cpu, memory, disk, name, gw, snapshot, model };
}

/** 인원·시간·예산·사양. 틀리면 400 문구 */
export function labNumbersError(s: LabSpec, r: LabRules): string | null {
  if (!Number.isInteger(s.seats) || s.seats < 1 || s.seats > r.maxSeats) return `인원은 1~${r.maxSeats}명`;
  const shortTtl = r.allowShortTtl && s.hours > 0 && s.hours < 0.01;
  if (!r.hours.includes(s.hours) && !shortTtl) return 'hours';
  if (!r.budgets.includes(s.budget)) return 'budget';
  // 사양: 1 이상 정수 (lab-resources.ts). 기본 세 가지 밖이면 스냅샷이 있는지는 State 가 Daytona 에 묻는다
  if (![s.cpu, s.memory, s.disk].every((v) => labResourceInt(v) !== null)) return '사양이 올바르지 않습니다.';
  return null;
}

/** 게이트웨이 주소·스냅샷·모델 이름. 틀리면 400 문구 */
export function labNamesError(s: LabSpec, devHttp: boolean): string | null {
  if (!/^https:\/\/[\w.-]+$/.test(s.gw) && !(devHttp && /^http:\/\/[\w.:-]+$/.test(s.gw))) return '게이트웨이 주소는 https://<이름>.workers.dev 형식';
  if (!/^[\w./:-]{1,120}$/.test(s.snapshot) || !/^[\w./:~-]{1,120}$/.test(s.model)) return '스냅샷·모델 이름이 올바르지 않습니다.';
  // 직접 입력 사양: 붙는 이름(-<cpu>c<mem>g<disk>d)까지 120자 안 (기본 세 가지는 예전 그대로)
  if (!labIsPreset(s) && labSnapshotName(s.snapshot, s).length > 120) return '스냅샷·모델 이름이 올바르지 않습니다.';
  return null;
}

/** 수업 자료 주소 (비어 있으면 없음). 틀리면 400 문구 */
export function labMaterialsOf(raw: unknown, devHttp: boolean): { mat: string } | { error: string } {
  const mat = String(raw ?? '').trim();
  if (mat && !materials(mat, devHttp)) return { error: '자료 주소는 https:// 로 시작하는 GitHub 저장소·ZIP·구글 드라이브 공유 링크' };
  return { mat };
}

/** 동기 확인 전부 (기존 순서: 숫자 → 이름 → 자료). 공유 공급자·저장소 확인은 State */
export function labCreateInput(input: LabInput, r: LabRules): (LabSpec & { mat: string }) | { error: string } {
  const s = labSpecOf(input, r);
  const err = labNumbersError(s, r) ?? labNamesError(s, r.devHttp);
  if (err) return { error: err };
  const m = labMaterialsOf(input.materials, r.devHttp);
  return 'error' in m ? m : { ...s, mat: m.mat };
}

type SandboxLab = Pick<Lab, 'id' | 'name' | 'expiresAt' | 'budget' | 'cpu' | 'memory' | 'disk' | 'snapshot' | 'model' | 'gw'>;

/** POST /sandbox 본문. env 에는 자리 가짜 토큰과 게이트웨이 주소만 (진짜 키 없음) */
export function labSandboxBody(lab: SandboxLab, n: number, token: string, orId: string, hours: number, defs: ProviderDef[]) {
  const { gw, model } = lab;
  const base = `${gw}/p/${orId}`;
  return {
    snapshot: labSnapshotName(lab.snapshot, lab),
    labels: { 'gw-lab': lab.id, 'gw-seat': String(n) },
    env: {
      OPENROUTER_API_KEY: token, OPENROUTER_BASE_URL: `${base}/api/v1`,
      ANTHROPIC_BASE_URL: `${base}/api`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      LAB_MODEL: model, LAB_NAME: lab.name, LAB_SEAT: String(n), LAB_ENDS: String(Math.floor(lab.expiresAt / 1000)),
      LAB_BUDGET: String(lab.budget), TZ: 'Asia/Seoul',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      // 이 수업에 나눠 준 공급자: 같은 가짜 토큰 + 게이트웨이 주소. lab-status·lab-doctor 가 LAB_SHARED 를 보고 확인한다
      ...(defs.length ? { ...labShareEnv(gw, token, defs), LAB_SHARED: defs.map((d) => d.id).join(','), LAB_GW: gw } : {}),
    },
    // 쉬는 시간에 꺼지지 않게 수업 시간만큼. 꺼지면 바로 삭제(흔적 없음). 끝나는 시각에는 알람이 지운다
    autoStopInterval: Math.max(1, Math.round(hours * 60)), autoDeleteInterval: 0,
  };
}

// ── 자리 깨우기 (labJoin) ──

/** 참가자가 적은 이름: 공백 하나로, 20자 */
export const labJoinName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 20);

export type LabJoinInfo = ReturnType<typeof labJoinInfo>;
export function labJoinInfo(lab: Lab, seat: Seat) {
  return { name: lab.name, seat: seat.n, who: seat.who ?? '', expiresAt: lab.expiresAt, model: lab.model, label: seat.label! };
}

/** 샌드박스 상태 → 할 일. start: 켜고 기다림 · sleep: 꺼지는 중이라 기다림 · waking: 켜지는 중 · ready · bad: 502 */
export function labWakeStep(state: string): 'start' | 'sleep' | 'waking' | 'ready' | 'bad' {
  if (SLEEPING.has(state)) return state === 'stopped' || state === 'archived' || state === 'paused' ? 'start' : 'sleep';
  if (WAKING.has(state)) return 'waking';
  return READY.has(state) ? 'ready' : 'bad';
}

export const labWakeDetail = (step: 'start' | 'sleep' | 'waking') => step === 'waking' ? '실습실을 준비하는 중' : '실습실을 깨우는 중';

export const labStateError = (sb: Pick<Sandbox, 'state' | 'errorReason'>) =>
  `실습실 상태가 ${sb.state} 입니다. 강사에게 알려주세요.${sb.errorReason ? ' (' + sb.errorReason + ')' : ''}`;

export const labStarting = (info: LabJoinInfo, detail: string) => ({ ...info, status: 'starting', detail });

/** 자료를 (다시) 넣을 차례인가: 아직 안 넣었거나, '진행 중' 이 stale 보다 오래됨. now 는 진행 중일 때만 부른다 */
export const labSetupDue = (setup: Seat['setup'], now: () => number, stale: number) =>
  !setup || (setup.state === 'running' && now() - setup.at > stale);

export const labReady = (info: LabJoinInfo, setup: Seat['setup']) =>
  ({ ...info, status: 'ready', materials: setup?.state === 'error' ? setup.note : undefined });

/** 넣을 수업 자료 (없거나 넣을 차례가 아니면 null). 순서: 자료 주소 확인 → labSetupDue */
export function labSetupPlan(mat: string | undefined, setup: Seat['setup'], devHttp: boolean, now: () => number, stale: number) {
  const m = mat ? materials(mat, devHttp) : null;
  return m && labSetupDue(setup, now, stale) ? m : null;
}

export const labSetupRunning = (setup: Seat['setup']) => setup?.state === 'running';

export const labErrorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export const labSeatSid = (seat: Pick<Seat, 'sid'>) => seat.sid ?? null;

/** 감사 기록용 '<수업> <n>번[ 이름]' */
export const labSeatTag = (lab: Pick<Lab, 'name'>, seat: Pick<Seat, 'n' | 'who'>) => `${lab.name} ${seat.n}번${seat.who ? ' ' + seat.who : ''}`;
