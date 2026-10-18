// 참여자가 허용한 화면만 모임지기에게 송출. SFU 수명·정리 로직은 기존 화면 서비스와 공유한다.
import { LabScreenService, SCR_ANSWER_TTL } from './lab-screen-service';
import type { Env, Fail, Lab, Seat } from './state';

type Store = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
type SeatRef = { lab: Lab; seat: Seat };
interface Source { lab: string; n: number; code: string; sandboxId?: string; tab: string; slot: string; v: number; at: number; capable?: boolean; width?: number; height?: number; quality?: 'preview' | 'detail' }
interface Input { seq: number; id: string; event: RemoteInput }
interface Control { requestId: string; owner: string; tab: string; sourceV: number; state: 'requested' | 'active' | 'denied' | 'stopped'; expiresAt: number; seq?: number; ack?: number; inputs?: Input[] }
type RemoteInput = { kind: 'text'; text: string } | { kind: 'key'; key: string; code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } |
  { kind: 'click' | 'wheel'; x: number; y: number; width: number; height: number; button: number; count: number; dx: number; dy: number };
export interface LiveDeps {
  storage: Store;
  env: Pick<Env, 'REALTIME_APP_ID' | 'REALTIME_APP_TOKEN' | 'REALTIME_API' | 'ALLOW_SHORT_TTL'>;
  seatOf(code: string): Promise<SeatRef | Fail>;
  authorize(token: string): Promise<{ owner: string; expiresAt: number } | null>;
  schedule(t: number): Promise<void>;
  waitUntil(p: Promise<unknown>): void;
  audit(event: string, sid: string | null, ip: string | null, detail?: string): Promise<void>;
}
const fail = (status: number, error: string): Fail => ({ status, error });
const bad = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x;
const now = () => Date.now();
const TAB = /^[a-zA-Z0-9_-]{16,64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SOURCE_TTL = 120_000;
const CONTROL_TTL = 5 * 60_000;
const START_WINDOW = 10_000;
interface Starts { lab: string; until: number; count: number }
interface QualityLease { owner: string; revision: number; until: number; keepUntil: number; focus: { code: string; lab: string; n: number; v: number; tab: string } | null }
const QUALITY_PREFIX = 'live-quality:';
const QUALITY_TTL = 15_000, QUALITY_KEEP = 60_000, QUALITY_WINDOW = 30_000;
const sourceKey = (code: string) => `live-source:${code}`;
const controlKey = (code: string) => `live-control:${code}`;
function inputValue(value: unknown): RemoteInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (e.kind === 'text') return typeof e.text === 'string' && e.text.length > 0 && e.text.length <= 1000 ? { kind: 'text', text: e.text } : null;
  if (e.kind === 'key') {
    if (typeof e.key !== 'string' || e.key.length > 30 || typeof e.code !== 'string' || !/^[A-Za-z0-9]{0,24}$/.test(e.code)) return null;
    if (!['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key) && !(e.ctrl === true || e.alt === true || e.meta === true)) return null;
    return { kind: 'key', key: e.key, code: e.code, ctrl: e.ctrl === true, alt: e.alt === true, shift: e.shift === true, meta: e.meta === true };
  }
  if (e.kind !== 'click' && e.kind !== 'wheel') return null;
  if (![e.x,e.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) || ![e.width,e.height].every(v => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 16384)) return null;
  if (e.button !== undefined && e.button !== 0 && e.button !== 2 || e.count !== undefined && e.count !== 1 && e.count !== 2) return null;
  if ([e.dx ?? 0,e.dy ?? 0].some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 2000)) return null;
  return { kind: e.kind, x: e.x as number, y: e.y as number, width: e.width as number, height: e.height as number, button: Number(e.button ?? 0), count: Number(e.count ?? 1), dx: Number(e.dx ?? 0), dy: Number(e.dy ?? 0) };
}

export class LabLiveService {
  private screen: LabScreenService;
  private turns = new Map<string, Promise<void>>();
  constructor(private d: LiveDeps) {
    // screen 서비스의 가상 수업 id = 실제 수업/자리. 저장 키는 기존 모임지기 송출과 완전히 분리.
    const storage = {
      get: async (key: string) => key.startsWith('lab:') ? this.slot(key.slice(4)) : d.storage.get(`live-media:${key}`),
      put: (key: string, value: unknown) => d.storage.put(`live-media:${key}`, value),
      delete: (key: string) => d.storage.delete(`live-media:${key}`),
      list: async (options: { prefix: string }) => new Map([...(await d.storage.list({ prefix: `live-media:${options.prefix}` }))].map(([k, v]) => [k.slice(11), v])),
    } as Store;
    this.screen = new LabScreenService({ storage, env: d.env, waitUntil: p => d.waitUntil(p),
      // 이 객체는 외부 RPC가 아니다. 아래 공개 경계에서 참가자/모임지기 권한과 대상을 먼저 검증한다.
      checkAdmin: async () => true,
      seatOf: async (viewer) => {
        const lab = await this.slot(viewer.slice(viewer.indexOf(':') + 1));
        return lab ? { lab } : fail(410, '모임 또는 자리가 끝났습니다.');
      }, schedule: t => d.schedule(t), audit: (...args) => d.audit(...args), answerTtl: () => SCR_ANSWER_TTL });
  }
  private get s() { return this.d.storage; }
  private async slot(slot: string) {
    const split = slot.lastIndexOf('/'), id = slot.slice(0, split), n = Number(slot.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(n)) return undefined;
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab || lab.endRetry || lab.expiresAt <= now() || !lab.seats.some(s => s.n === n && !s.error)) return undefined;
    return { id: slot, name: lab.name, expiresAt: lab.expiresAt };
  }
  private fresh(s: Source | undefined): s is Source { return !!s && now() - s.at < SOURCE_TTL; }
  /** 같은 자리의 메타데이터 기록만 직렬화한다. 화면 시작(SFU) 대기는 밖에 둔다 */
  private async turn<T>(code: string, run: () => Promise<T>): Promise<T> {
    const prev = this.turns.get(code) ?? Promise.resolve();
    let settle!: () => void;
    const gate = new Promise<void>(resolve => { settle = resolve; });
    const tail = prev.then(() => gate);
    this.turns.set(code, tail);
    await prev;
    try { return await run(); }
    finally { settle(); if (this.turns.get(code) === tail) this.turns.delete(code); }
  }
  /** 샌드박스·폐지된 자리에 묶인 공유는 더 이상 그 동의로 제어할 수 없다 */
  private unbound(source: Source, seat: { sandboxId?: string; error?: string }) {
    return source.sandboxId !== seat.sandboxId || !!seat.error;
  }
  private async target(token: string, id: string, n: number) {
    const auth = await this.d.authorize(token);
    if (!auth) return fail(401, '모임 화면 세션이 끝났습니다. 보안 키로 다시 확인하세요.');
    const lab = await this.s.get<Lab>(`lab:${id}`), seat = lab?.seats.find(s => s.n === n);
    if (!lab || lab.endRetry || lab.expiresAt <= now()) return fail(410, '모임이 끝났습니다.');
    if (!seat || seat.error) return fail(404, '사용 가능한 자리가 아닙니다.');
    return { auth, lab, seat };
  }
  async start(code: string, tab: unknown, sdp: unknown, tracks: unknown) {
    const ref = await this.d.seatOf(code);
    if (bad(ref)) return ref;
    if (ref.seat.error) return fail(409, '이 자리는 지금은 공유할 수 없습니다.');
    if (typeof tab !== 'string' || !TAB.test(tab)) return fail(400, '화면 탭을 확인할 수 없습니다.');
    // 참여자에게 열린 SFU 생성 경로: 빠른 재시도도 자리당 10초에 네 번까지만 허용한다.
    const until = await this.turn(code, async () => {
      const key = `live-start:${code}`, prior = await this.s.get<Starts>(key);
      const current = prior && prior.until > now() ? prior : { lab: ref.lab.id, until: now() + START_WINDOW, count: 0 };
      if (current.count >= 4) return 0;
      await this.s.put(key, { ...current, count: current.count + 1 });
      return current.until;
    });
    if (!until) return fail(429, '화면 공유를 여러 번 요청했습니다. 10초 뒤 다시 시도해 주세요.');
    await this.d.schedule(until);
    const slot = `${ref.lab.id}/${ref.seat.n}`;
    const result = await this.screen.start('', slot, sdp, tracks);
    if (bad(result)) return result;
    // seatOf 가 돌아온 뒤에도 result.v 가 아직 활성 발행일 때만 탭·동의를 기록한다. 더 새 시작은 지우지 않는다.
    const fresh = await this.d.seatOf(code);
    if (bad(fresh) || fresh.seat.error || fresh.lab.id !== ref.lab.id || fresh.seat.n !== ref.seat.n || fresh.seat.code !== ref.seat.code || fresh.seat.sandboxId !== ref.seat.sandboxId) {
      const published = await this.screen.generation(slot);
      if (published.on && published.v === result.v) await this.screen.clear(slot, result.v);
      return fail(409, '실습실이 바뀌어 공유를 취소했습니다.');
    }
    const committed = await this.turn(code, async () => {
      const published = await this.screen.generation(slot);
      if (!published.on || published.v !== result.v) return false;
      const current = await this.s.get<Source>(sourceKey(code));
      if (current && current.v > result.v) return false;
      await this.s.delete(controlKey(code));
      await this.s.put(sourceKey(code), { lab: fresh.lab.id, n: fresh.seat.n, code, sandboxId: fresh.seat.sandboxId, slot, tab, v: result.v, at: now() } satisfies Source);
      return true;
    });
    if (!committed) return fail(409, '더 최근 화면 공유가 있어 이 시작은 반영하지 않았습니다.');
    await this.d.schedule(now() + SOURCE_TTL);
    return result;
  }
  async stop(code: string, tab: unknown) {
    const ref = await this.d.seatOf(code); if (bad(ref)) return ref;
    const dropped = await this.turn(code, async () => {
      const source = await this.s.get<Source>(sourceKey(code));
      if (source && source.tab !== tab) return 'mismatch' as const;
      if (source) { await this.s.delete(sourceKey(code)); await this.s.delete(controlKey(code)); }
      return source;
    });
    if (dropped === 'mismatch') return fail(409, '공유한 탭에서 멈춰 주세요.');
    const slot = dropped?.slot ?? `${ref.lab.id}/${ref.seat.n}`;
    const published = await this.screen.generation(slot);
    if (!dropped || published.v <= dropped.v) await this.screen.clear(slot, dropped?.v);
    return { ok: true };
  }
  /** One selected seat per viewer tab. Short leases fall back without a browser callback. */
  async quality(token: string, viewerTab: unknown, revision: unknown, at: unknown, focus: unknown) {
    const auth = await this.d.authorize(token);
    if (!auth) return fail(401, '모임 화면 세션이 끝났습니다.');
    if (typeof viewerTab !== 'string' || !TAB.test(viewerTab) || !Number.isSafeInteger(revision) || Number(revision) < 1 || Number(revision) > 1e9 || !Number.isSafeInteger(at)) return fail(400, '화질 요청 형식이 올바르지 않습니다.');
    if (focus !== null && (!focus || typeof focus !== 'object' || Array.isArray(focus) || Object.keys(focus).some(k => !['id','n','v'].includes(k)))) return fail(400, '화질 대상이 올바르지 않습니다.');
    const requested = focus as { id: string; n: number; v: number } | null;
    if (requested && (typeof requested.id !== 'string' || requested.id.length > 128 || !Number.isSafeInteger(requested.n) || requested.n < 1 || !Number.isSafeInteger(requested.v) || requested.v < 1)) return fail(400, '화질 대상이 올바르지 않습니다.');
    return this.turn('@quality', async () => {
      const t = now();
      // The timestamp uses the offset returned by status(). Retain revisions for
      // longer than this window, so an expired delayed request cannot resurrect focus.
      if (Math.abs(t - Number(at)) > QUALITY_WINDOW) return fail(409, '화질 요청 시간이 지났습니다. 화면 상태를 다시 확인하세요.');
      const key = QUALITY_PREFIX + auth.owner + ':' + viewerTab;
      const leases = await this.s.list<QualityLease>({ prefix: QUALITY_PREFIX, limit: 65 });
      for (const [k, lease] of leases) if (lease.keepUntil <= t) { await this.s.delete(k); leases.delete(k); }
      const prior = leases.get(key);
      if (prior && prior.revision >= Number(revision)) return { ok: true, stale: true };
      if (!prior && (leases.size >= 64 || [...leases.values()].filter(x => x.owner === auth.owner).length >= 8)) return fail(429, '모임 화면 탭이 많습니다. 잠시 뒤 기존 탭에서 다시 시도하세요.');
      let selected: QualityLease['focus'] = null;
      if (requested) {
        const target = await this.target(token, requested.id, requested.n); if (bad(target)) return target;
        const source = await this.s.get<Source>(sourceKey(target.seat.code));
        if (!this.fresh(source) || this.unbound(source, target.seat) || source.v !== requested.v) return fail(409, '참여자 화면이 바뀌었습니다. 최신 화면에서 다시 선택하세요.');
        selected = { code: target.seat.code, lab: target.lab.id, n: target.seat.n, v: source.v, tab: source.tab };
      }
      const lease: QualityLease = { owner: auth.owner, revision: Number(revision), until: Math.min(t + QUALITY_TTL, auth.expiresAt), keepUntil: Math.min(t + QUALITY_KEEP, auth.expiresAt), focus: selected };
      await this.s.put(key, lease);
      await this.d.schedule(selected ? lease.until : lease.keepUntil);
      return { ok: true };
    });
  }
  private async wantedQuality(source: Source | undefined): Promise<'preview' | 'detail'> {
    if (!this.fresh(source)) return 'preview';
    for (const lease of (await this.s.list<QualityLease>({ prefix: QUALITY_PREFIX, limit: 65 })).values()) {
      const f = lease.focus;
      if (lease.until <= now() || !f || f.code !== source.code || f.v !== source.v || f.tab !== source.tab) continue;
      const owner = await this.s.get<{ expiresAt: number }>('live-auth:' + lease.owner);
      if (owner && owner.expiresAt > now()) return 'detail';
    }
    return 'preview';
  }
  async seatState(code: string, tab?: unknown, ack?: unknown, viewport?: unknown, ackRequest?: unknown) {
    const ref = await this.d.seatOf(code); if (bad(ref)) return ref;
    let source = await this.s.get<Source>(sourceKey(code));
    if (source && (now() - source.at >= SOURCE_TTL || this.unbound(source, ref.seat))) { await this.stop(code, source.tab); source = undefined; }
    if (source && source.tab === tab) {
      const view = viewport && typeof viewport === 'object' ? viewport as Record<string, unknown> : {};
      source = { ...source, at: now(), capable: view.capable === true, width: Number.isSafeInteger(view.width) ? Number(view.width) : 0, height: Number.isSafeInteger(view.height) ? Number(view.height) : 0, quality: view.quality === 'detail' ? 'detail' : view.quality === 'preview' ? 'preview' : undefined };
      await this.s.put(sourceKey(code), source);
    }
    const control = await this.s.get<Control>(controlKey(code));
    const owner = control && await this.s.get<{ expiresAt: number }>(`live-auth:${control.owner}`);
    const valid = this.fresh(source) && control && control.tab === source.tab && control.sourceV === source.v && control.expiresAt > now() && owner && owner.expiresAt > now();
    if (valid && source?.tab === tab && ackRequest === control.requestId && Number.isSafeInteger(ack) && Number(ack) > (control.ack ?? 0) && Number(ack) <= (control.seq ?? 0)) {
      control.ack = Number(ack); await this.s.put(controlKey(code), control);
    }
    return { now: now(), sharing: this.fresh(source), own: !!source && source.tab === tab, v: source?.v ?? 0, quality: source?.tab === tab ? await this.wantedQuality(source) : 'preview',
      control: valid ? { requestId: control.requestId, state: control.state, expiresAt: control.expiresAt,
        inputs: source?.tab === tab && control.state === 'active' && source?.capable ? (control.inputs ?? []).filter(i => i.seq > (control.ack ?? 0)) : [] } : null };
  }
  async status(token: string) {
    const auth = await this.d.authorize(token);
    if (!auth) return fail(401, '모임 화면 세션이 끝났습니다. 보안 키로 다시 확인하세요.');
    const labs = [...(await this.s.list<Lab>({ prefix: 'lab:' })).values()].filter(l => l.expiresAt > now() && !l.endRetry && !l.teacherDemoFor);
    const views = [];
    for (const lab of labs) {
      const seats = [];
      for (const seat of lab.seats) {
        let source = await this.s.get<Source>(sourceKey(seat.code));
        if (source && this.unbound(source, seat)) { await this.stop(seat.code, source.tab); source = undefined; }
        const control = await this.s.get<Control>(controlKey(seat.code));
        const live = this.fresh(source) && source.sandboxId === seat.sandboxId && !seat.error ? source : undefined;
        const current = live && control && control.expiresAt > now() && control.owner === auth.owner && control.tab === live.tab && control.sourceV === live.v;
        seats.push({ n: seat.n, who: seat.who ?? '', sharing: !!live, v: live ? live.v : 0,
          capable: !!live && live.capable === true, width: live?.width ?? 0, height: live?.height ?? 0, quality: live?.quality ?? null,
          control: current ? { requestId: control.requestId, state: control.state, expiresAt: control.expiresAt } : null });
      }
      views.push({ id: lab.id, name: lab.name, expiresAt: lab.expiresAt, seats });
    }
    return { now: now(), expiresAt: auth.expiresAt, labs: views };
  }
  async pull(token: string, id: string, n: number, sid?: unknown, sdp?: unknown) {
    const t = await this.target(token, id, n); if (bad(t)) return t;
    const source = await this.s.get<Source>(sourceKey(t.seat.code));
    if (!this.fresh(source) || source.sandboxId !== t.seat.sandboxId) return fail(409, '실습실 자동 화면 연결을 기다리는 중입니다. 참여자 탭 연결을 확인하세요.');
    const viewer = `${t.auth.owner}:${source.slot}`;
    return sid === undefined ? this.screen.pull(viewer) : this.screen.answer(viewer, sid, sdp);
  }
  async requestControl(token: string, id: string, n: number, requestId: unknown) {
    const t = await this.target(token, id, n); if (bad(t)) return t;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, '제어 요청 번호가 올바르지 않습니다.');
    const source = await this.s.get<Source>(sourceKey(t.seat.code));
    if (!this.fresh(source) || source.sandboxId !== t.seat.sandboxId) return fail(409, '실습실 자동 미리보기가 연결된 뒤 요청하세요.');
    if (!source.capable) return fail(409, '현재 실습실 화면의 연결을 확인한 뒤 클릭·키보드를 지원할 수 있습니다.');
    const prior = await this.s.get<Control>(controlKey(t.seat.code));
    if (prior?.requestId === requestId) return prior.owner === t.auth.owner ? { ok: true } : fail(409, '다른 제어 요청입니다.');
    if (prior && prior.expiresAt > now() && (prior.state === 'requested' || prior.state === 'active') && prior.tab === source.tab && prior.sourceV === source.v) return fail(409, '기존 제어 요청을 먼저 끝내세요.');
    const expiresAt = Math.min(now() + CONTROL_TTL, t.auth.expiresAt, t.lab.expiresAt);
    await this.s.put(controlKey(t.seat.code), { requestId, owner: t.auth.owner, tab: source.tab, sourceV: source.v, state: 'requested', expiresAt } satisfies Control);
    await this.d.schedule(expiresAt);
    await this.d.audit('lab-support-request', null, null, `${id} ${n}번`);
    return { ok: true };
  }
  async consent(code: string, tab: unknown, requestId: unknown, allow: unknown) {
    const ref = await this.d.seatOf(code); if (bad(ref)) return ref;
    const source = await this.s.get<Source>(sourceKey(code)), c = await this.s.get<Control>(controlKey(code));
    if (!this.fresh(source) || this.unbound(source, ref.seat) || source.tab !== tab || !c || c.tab !== tab || c.sourceV !== source.v || c.requestId !== requestId || c.expiresAt <= now()) return fail(409, '현재 공유 탭의 제어 요청이 아닙니다.');
    if (allow === true && (c.state !== 'requested' || !source.capable)) return fail(409, '이미 끝났거나 제어할 수 없는 탭입니다.');
    const state = allow === true ? 'active' : c.state === 'requested' ? 'denied' : 'stopped';
    const owner = await this.s.get<{expiresAt:number}>(`live-auth:${c.owner}`);
    if (allow === true && (!owner || owner.expiresAt <= now())) return fail(401, '모임지기 화면 세션이 끝났습니다.');
    const expiresAt = allow === true ? Math.min(now() + CONTROL_TTL, owner!.expiresAt, ref.lab.expiresAt) : c.expiresAt;
    await this.s.put(controlKey(code), { ...c, state, expiresAt, inputs: [] });
    await this.d.schedule(expiresAt);
    await this.d.audit('lab-support-consent', null, null, `${ref.lab.id} ${ref.seat.n}번 ${state}`);
    return { ok: true };
  }
  async release(token: string, id: string, n: number, requestId: unknown) {
    const t = await this.target(token, id, n); if (bad(t)) return t;
    const c = await this.s.get<Control>(controlKey(t.seat.code));
    if (c && c.requestId === requestId && c.owner === t.auth.owner) await this.s.put(controlKey(t.seat.code), { ...c, state: 'stopped', inputs: [] });
    return { ok: true };
  }
  async input(token: string, id: string, n: number, requestId: unknown, eventId: unknown, value: unknown) {
    const t = await this.target(token, id, n); if (bad(t)) return t;
    const event = inputValue(value);
    if (!event || typeof eventId !== 'string' || !UUID.test(eventId)) return fail(400, '허용되지 않은 입력입니다.');
    const source = await this.s.get<Source>(sourceKey(t.seat.code)), c = await this.s.get<Control>(controlKey(t.seat.code));
    if (!this.fresh(source) || source.sandboxId !== t.seat.sandboxId || !source.capable || !c || c.owner !== t.auth.owner || c.tab !== source.tab || c.sourceV !== source.v || c.requestId !== requestId || c.state !== 'active' || c.expiresAt <= now()) return fail(403, '참여자가 허용한 제어가 아닙니다. 다시 요청하세요.');
    if ((event.kind === 'click' || event.kind === 'wheel') && (event.width !== source.width || event.height !== source.height)) return fail(409, '참여자 화면 크기가 바뀌었습니다. 최신 화면에서 다시 조작하세요.');
    if (c.inputs?.some(i => i.id === eventId)) return { ok: true };
    if ((c.seq ?? 0) - (c.ack ?? 0) >= 16) return fail(429, '참여자 입력 확인을 기다리는 중입니다.');
    const seq = (c.seq ?? 0) + 1;
    await this.s.put(controlKey(t.seat.code), { ...c, seq, inputs: [...(c.inputs ?? []).slice(-31), { seq, id: eventId, event }] });
    return { ok: true };
  }
  async close(token: string, id: string, n: number) {
    const auth = await this.d.authorize(token); if (!auth) return fail(401, '모임 화면 세션이 끝났습니다.');
    await this.screen.releaseReceiver(`${auth.owner}:${id}/${n}`); return { ok: true };
  }
  async dropOwners(owners: string[]) {
    await this.turn('@quality', async () => { for (const [k, lease] of await this.s.list<QualityLease>({ prefix: QUALITY_PREFIX })) if (owners.includes(lease.owner)) await this.s.delete(k); });
    for (const owner of owners) await this.screen.releaseReceiver(`${owner}:`, true);
    for (const [k, c] of await this.s.list<Control>({ prefix: 'live-control:' })) if (owners.includes(c.owner)) await this.s.delete(k);
  }
  async clear(id: string) {
    await this.turn('@quality', async () => { for (const [k, lease] of await this.s.list<QualityLease>({ prefix: QUALITY_PREFIX })) if (lease.focus?.lab === id) await this.s.delete(k); });
    for (const [k, start] of await this.s.list<Starts>({ prefix: 'live-start:' })) if (start.lab === id) await this.s.delete(k);
    for (const [k, source] of await this.s.list<Source>({ prefix: 'live-source:' })) if (source.lab === id) {
      await this.s.delete(k); await this.s.delete(controlKey(source.code)); await this.screen.clear(source.slot);
    }
  }
  async alarm(t: number) {
    let next = await this.screen.alarm(t);
    await this.turn('@quality', async () => { for (const [k, lease] of await this.s.list<QualityLease>({ prefix: QUALITY_PREFIX })) {
      if (lease.keepUntil <= t) await this.s.delete(k); else next = Math.min(next, lease.until > t ? lease.until : lease.keepUntil);
    } });
    for (const [k, start] of await this.s.list<Starts>({ prefix: 'live-start:' })) {
      if (start.until <= t) await this.s.delete(k); else next = Math.min(next, start.until);
    }
    for (const [k, source] of await this.s.list<Source>({ prefix: 'live-source:' })) {
      const cur = await this.s.get<Source>(k);
      if (!cur || cur.v !== source.v || cur.at !== source.at) { if (cur) next = Math.min(next, cur.at + SOURCE_TTL); continue; }
      if (!await this.slot(cur.slot) || cur.at + SOURCE_TTL <= t) {
        await this.s.delete(k); await this.s.delete(controlKey(cur.code)); await this.screen.clear(cur.slot, cur.v);
      } else next = Math.min(next, cur.at + SOURCE_TTL);
    }
    for (const [k, c] of await this.s.list<Control>({ prefix: 'live-control:' })) {
      if (c.expiresAt <= t) await this.s.delete(k); else next = Math.min(next, c.expiresAt);
    }
    return next;
  }
}
