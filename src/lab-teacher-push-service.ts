// 강사 Web Push (손 든 학생 알림) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다.
//   구독: 강사 보기 세션(쿠키 → 해시 주인)만. 구독 능력(endpoint + keys)은 MASTER_KEY AES-GCM 으로만 저장 (AAD 'teacher-push:<endpoint 해시>').
//         원문 endpoint·auth·p256dh 는 응답·오류·로그에 싣지 않는다. 주인 세션의 고정 expiresAt 을 그대로 (늘리지 않음). 세션당 4개·전체 64개.
//   발송: 참가자가 '새로' 손을 든 트랜잭션이 같은 저장소 쓰기로 outbox(tpush:outbox)에 일을 넣는다 (바깥 호출 없음).
//         outbox 는 일 32개·자리마다 60초 한 번·(수업, 자리, 손 든 시각)으로 중복 제거. 일 하나는 3번·120초 안에서만 다시 시도.
//         처리는 임차(lease 60초)로 일을 잡고, 받는 기기(최대 64)마다 같은 고정 알림 하나로 합쳐 보낸다 (동시 4개, 보내기 하나 10초).
//         네트워크를 시작하기 바로 앞(await 없이 fetch 직전)에 손 시각·수업·멈춤·주인 세션·구독 묶음·임차를 다시 읽어 확인한다.
//   남는 경우 (문서화된 한계): 이미 시작한 요청은 로그아웃·손 내림 뒤에 끝날 수 있다 (새 요청은 시작하지 않는다).
//         응답 전에 시간이 넘거나 프로세스가 죽으면 같은 알림이 한 번 더 갈 수 있다 — tag 가 같아 기기에서는 한 알림으로 합쳐진다.
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Fail } from './state';
import { TEACHER_PREFIX, type TeacherTok } from './lab-teacher-service';
import { isAllowedPushEndpoint, LAB_PUSH_URL, parsePushSubscription, PUSH_ENDPOINT_MAX, sendPush, type LabPushPayload, type VapidKey } from './lab-web-push';

const now = () => Date.now();
const fail = (status: number, error: string): Fail => ({ status, error });

export const PUSH_SUB_PREFIX = 'tpsub:';
export const PUSH_OUTBOX = 'tpush:outbox';
export const PUSH_PER_SESSION = 4;
export const PUSH_GLOBAL = 64;
export const PUSH_JOBS_MAX = 32;
export const PUSH_CLAIM_MAX = 8;      // 한 번에 잡는 일 (다시 읽는 키 수를 묶는다)
export const PUSH_THROTTLE = 60e3;    // 자리마다 새 알림 사이
export const PUSH_WINDOW = 120e3;     // 일 하나의 전체 수명 (넣은 때부터)
export const PUSH_TRIES = 3;
export const PUSH_LEASE = 60e3;       // 잡은 일: 이 안에 끝내지 못하면(재시작·죽음) 다른 처리가 다시 잡는다
export const PUSH_RUN = 40e3;         // 한 번 처리에서 새 보내기를 시작하는 시간 (임차보다 짧게)
export const PUSH_PARALLEL = 4;
const RETRY_DELAY = [0, 10e3, 30e3];  // tries 번째 시도 전 기다림
const THR_MAX = 64;
const RID = 16;                       // outbox 안에서 받는 기기를 가리키는 endpoint 해시 앞부분
const UNAVAILABLE = '지금은 알림을 켤 수 없습니다.';

/** 알림 내용은 고정 — 학생 이름·자리·수업 이름을 싣지 않는다 */
export const PUSH_PAYLOAD: Readonly<LabPushPayload> = Object.freeze({ title: '공부방 실습실', body: '학생이 손을 들었습니다. 강사 화면에서 확인하세요.', url: LAB_PUSH_URL, tag: 'lab-hand' });

export interface PushRef { labId: string; n: number; code: string; sandboxId: string }
export interface PushJob extends PushRef {
  id: string; hand: number; at: number;
  tries: number; due: number; lease: number;
  left: string[] | null; // 아직 받지 못한 기기 (첫 시도 때 정함)
}
export interface PushOutbox { jobs: PushJob[]; thr: Record<string, number> }
interface StoredSub { owner: string; expiresAt: number; at: number; iv: string; ct: string }
export interface TeacherOwner { owner: string; expiresAt: number }

export interface LabTeacherPushDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list' | 'transaction'>;
  /** 쿠키 토큰 → 살아 있는 보기 세션의 해시 주인 (읽기만) */
  authorize(token: string): Promise<TeacherOwner | null>;
  /** VAPID 키 (없거나 틀리면 null = 꺼짐) */
  vapid(): Promise<VapidKey | null>;
  /** MASTER_KEY 로 봉인할 수 있는가 */
  sealReady(): boolean;
  seal(aad: string, text: string): Promise<{ iv: string; ct: string }>;
  open(aad: string, iv: string, ct: string): Promise<string | null>;
  /** 손 상태를 다시 볼 저장 키들과, 그것으로 '이 손이 아직 그대로인가' (메모리 멈춤 포함, 동기) */
  handKeys(job: PushRef): string[];
  handOk(job: PushRef & { hand: number }, got: Map<string, unknown>): boolean;
  schedule(t: number): Promise<void>;
}

const subKey = (h: string) => `${PUSH_SUB_PREFIX}${h}`;
const subAad = (h: string) => `teacher-push:${h}`;
const seatKey = (labId: string, n: number) => `${labId}:${n}`;
const ownerLive = (rec: TeacherTok | undefined, t: number) => !!rec && rec.expiresAt > t;

/** 기한이 지난 일·throttle 을 뺀 복사본 */
function pruned(box: PushOutbox | undefined, t: number): PushOutbox {
  const jobs = (box?.jobs ?? []).filter((j) => j.at + PUSH_WINDOW > t).map((j) => ({ ...j, left: j.left && [...j.left] }));
  const thr = Object.fromEntries(Object.entries(box?.thr ?? {}).filter(([, at]) => at > t - PUSH_THROTTLE).sort((a, b) => b[1] - a[1]).slice(0, THR_MAX));
  return { jobs, thr };
}

/** 새로 든 손 하나를 outbox 에 (트랜잭션 안에서 부른다, 순수 함수). 넣을 것이 없으면 null (throttle·중복·상한) */
export function pushEnqueue(box0: PushOutbox | undefined, ref: PushRef, hand: number, t: number): PushOutbox | null {
  const box = pruned(box0, t);
  const k = seatKey(ref.labId, ref.n);
  const id = `${k}:${hand}`;
  if (k in box.thr || box.jobs.some((j) => j.id === id) || box.jobs.length >= PUSH_JOBS_MAX) return null;
  box.thr[k] = t;
  box.jobs.push({ id, labId: ref.labId, n: ref.n, code: ref.code, sandboxId: ref.sandboxId, hand, at: t, tries: 0, due: t, lease: 0, left: null });
  return box;
}

/** 손 내림·강사 내림: 그 자리의 일을 뺀다 (throttle 은 남긴다). 뺄 것이 없으면 null */
export function pushDropSeat(box: PushOutbox | undefined, labId: string, n: number): PushOutbox | null {
  if (!box?.jobs.some((j) => j.labId === labId && j.n === n)) return null;
  return { jobs: box.jobs.filter((j) => !(j.labId === labId && j.n === n)), thr: box.thr };
}

/** 본문: 정확히 { [key]: 값 } 하나 (다른 필드 — message·url·recipient 등 — 는 거부) */
function onlyField(text: string, key: string): unknown {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const ks = Object.keys(v);
  return ks.length === 1 && ks[0] === key ? (v as Record<string, unknown>)[key] : undefined;
}

export class LabTeacherPushService {
  constructor(private d: LabTeacherPushDeps) {}
  private get s() { return this.d.storage; }
  #running = false;

  /** 켤 수 있는가 (키·MASTER_KEY) */
  async available() {
    return this.d.sealReady() && !!(await this.d.vapid());
  }

  // ── HTTP (쿠키 토큰만. 인증 → 본문 해석·암호·저장 순서) ──

  async config(token: string) {
    const me = await this.d.authorize(token);
    if (!me) return fail(401, '강사 보기 세션이 만료됐습니다.');
    const key = this.d.sealReady() ? await this.d.vapid() : null;
    return key ? { available: true, expiresAt: me.expiresAt, applicationServerKey: key.publicKey } : { available: false, expiresAt: me.expiresAt };
  }

  async subscribe(token: string, text: string) {
    const me = await this.d.authorize(token);
    if (!me) return fail(401, '강사 보기 세션이 만료됐습니다.');
    if (!(await this.available())) return fail(409, UNAVAILABLE);
    const sub = await parsePushSubscription(onlyField(text, 'subscription'));
    if (!sub) return fail(400, '알림 구독 정보가 올바르지 않습니다.');
    const h = await sha(sub.endpoint);
    const plain = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    // 같은 세션(같은 해시 주인·같은 고정 만료)의 같은 기기·같은 키 → 그대로 둔다 (다시 봉인하지 않아 진행 중인 보내기의 묶음 확인도 안 깨진다)
    const cur = await this.s.get<StoredSub>(subKey(h));
    if (cur && cur.owner === me.owner && cur.expiresAt === me.expiresAt && (await this.d.open(subAad(h), cur.iv, cur.ct)) === plain) return { ok: true as const, expiresAt: me.expiresAt };
    const sealed = await this.d.seal(subAad(h), plain);
    const key = subKey(h);
    // 상한·주인 확인과 쓰기를 한 트랜잭션에 (확인을 다 통과해야 쓴다)
    const r = await this.s.transaction(async (txn): Promise<Fail | null> => {
      const t = now();
      if (!ownerLive(await txn.get<TeacherTok>(`${TEACHER_PREFIX}${me.owner}`), t)) return fail(401, '강사 보기 세션이 만료됐습니다.');
      const all = await txn.list<StoredSub>({ prefix: PUSH_SUB_PREFIX, limit: PUSH_GLOBAL * 2 });
      const owners = [...new Set([...all.values()].map((x) => x.owner))].slice(0, 127);
      const recs = owners.length ? await txn.get<TeacherTok>(owners.map((o) => `${TEACHER_PREFIX}${o}`)) : new Map<string, TeacherTok>();
      const alive = (x: StoredSub) => x.expiresAt > t && ownerLive(recs.get(`${TEACHER_PREFIX}${x.owner}`), t);
      const drop: string[] = [];
      const others: [string, StoredSub][] = [];
      for (const [k, x] of all) if (k !== key) (alive(x) ? others.push([k, x]) : drop.push(k));
      // 같은 세션 상한: 이 세션의 가장 오래된 기기부터 (다른 세션 것은 건드리지 않는다)
      const mine = others.filter(([, x]) => x.owner === me.owner).sort((a, b) => a[1].at - b[1].at);
      const evict = mine.slice(0, Math.max(0, mine.length - (PUSH_PER_SESSION - 1))).map(([k]) => k);
      if (others.length - evict.length >= PUSH_GLOBAL) return fail(429, '알림을 받는 기기가 너무 많습니다.');
      if (drop.length + evict.length) await txn.delete([...drop, ...evict]);
      // 같은 기기(endpoint)를 다시 구독하면 지금 세션으로 묶는다 (예전 주인 정보는 돌려주지 않는다)
      await txn.put(key, { owner: me.owner, expiresAt: me.expiresAt, at: t, iv: sealed.iv, ct: sealed.ct } satisfies StoredSub);
      return null;
    });
    if (r) return r;
    await this.d.schedule(me.expiresAt);
    return { ok: true as const, expiresAt: me.expiresAt };
  }

  /** 이 세션이 그 endpoint 의 주인인가만 (다른 세션 것이면 false) */
  async status(token: string, text: string) {
    const me = await this.d.authorize(token);
    if (!me) return fail(401, '강사 보기 세션이 만료됐습니다.');
    const ep = onlyField(text, 'endpoint');
    if (typeof ep !== 'string' || ep.length > PUSH_ENDPOINT_MAX) return fail(400, 'endpoint 가 올바르지 않습니다.');
    if (!isAllowedPushEndpoint(ep)) return { enabled: false, expiresAt: me.expiresAt };
    const x = await this.s.get<StoredSub>(subKey(await sha(ep)));
    return { enabled: !!x && x.owner === me.owner && x.expiresAt > now() && (await this.available()), expiresAt: me.expiresAt };
  }

  /** 이 세션이 묶은 그 endpoint 만 지운다. 다른 세션 것·없는 것이어도 ok (아무것도 바꾸지 않음) */
  async unsubscribe(token: string, text: string) {
    const me = await this.d.authorize(token);
    if (!me) return fail(401, '강사 보기 세션이 만료됐습니다.');
    const ep = onlyField(text, 'endpoint');
    if (typeof ep !== 'string' || ep.length > PUSH_ENDPOINT_MAX) return fail(400, 'endpoint 가 올바르지 않습니다.');
    if (isAllowedPushEndpoint(ep)) {
      const key = subKey(await sha(ep));
      await this.s.transaction(async (txn) => {
        const x = await txn.get<StoredSub>(key);
        if (x && x.owner === me.owner) await txn.delete(key);
      });
    }
    return { ok: true as const };
  }

  // ── 정리 ──

  /** 로그아웃·밀려난 세션: 그 주인의 구독을 지운다 (outbox 의 받는 기기는 보내기 전 확인에서 빠진다) */
  async dropOwners(owners: string[]) {
    if (!owners.length) return;
    const set = new Set(owners);
    const ks = [...(await this.s.list<StoredSub>({ prefix: PUSH_SUB_PREFIX })).entries()].filter(([, x]) => set.has(x.owner)).map(([k]) => k);
    for (let i = 0; i < ks.length; i += 128) await this.s.delete(ks.slice(i, i + 128));
  }

  /** 수업 끝내기·만료: 그 수업의 일을 뺀다 */
  async dropLab(labId: string) {
    await this.s.transaction(async (txn) => {
      const box = await txn.get<PushOutbox>(PUSH_OUTBOX);
      if (box?.jobs.some((j) => j.labId === labId)) await txn.put(PUSH_OUTBOX, { jobs: box.jobs.filter((j) => j.labId !== labId), thr: box.thr });
    });
  }

  /** 알람: 끝난 구독 지우기 + outbox 처리. 다음 시각 (없으면 Infinity) */
  async alarm(t: number) {
    let next = Infinity;
    const all = await this.s.list<StoredSub>({ prefix: PUSH_SUB_PREFIX });
    if (all.size) {
      const owners = [...new Set([...all.values()].map((x) => x.owner))];
      const recs = new Map<string, TeacherTok>();
      for (let i = 0; i < owners.length; i += 128) for (const [k, v] of await this.s.get<TeacherTok>(owners.slice(i, i + 128).map((o) => `${TEACHER_PREFIX}${o}`))) recs.set(k, v);
      const dead: string[] = [];
      for (const [k, x] of all) {
        if (x.expiresAt <= t || !ownerLive(recs.get(`${TEACHER_PREFIX}${x.owner}`), t)) dead.push(k);
        else next = Math.min(next, x.expiresAt);
      }
      for (let i = 0; i < dead.length; i += 128) await this.s.delete(dead.slice(i, i + 128));
    }
    return Math.min(next, await this.drain(t));
  }

  /** 새 손 뒤 (응답을 기다리게 하지 않는다): 처리하고 다음 시각을 알람에 */
  async kick() {
    try {
      const next = await this.drain(now());
      if (next < Infinity) await this.d.schedule(next);
    } catch { /* 알람이 임차 만료 뒤 다시 잡는다 */ }
  }

  /** outbox 처리 한 번. 다음에 다시 볼 시각 */
  async drain(t0: number): Promise<number> {
    if (this.#running) return t0 + PUSH_LEASE;
    this.#running = true;
    try { return await this.#drain(t0); } finally { this.#running = false; }
  }

  async #drain(t0: number): Promise<number> {
    const key = this.d.sealReady() ? await this.d.vapid() : null;
    if (!key) {
      // 꺼졌으면 쌓인 일은 보내지 않고 정리한다
      await this.s.transaction(async (txn) => {
        const box = await txn.get<PushOutbox>(PUSH_OUTBOX);
        if (box?.jobs.length) await txn.put(PUSH_OUTBOX, { jobs: [], thr: box.thr });
      });
      return Infinity;
    }
    const lease = t0 + PUSH_LEASE;
    // 1) 잡기: 때가 됐고 아무도 잡지 않은(또는 임차가 끝난) 일만
    const claimed = await this.s.transaction(async (txn) => {
      const raw = await txn.get<PushOutbox>(PUSH_OUTBOX);
      if (!raw) return [];
      const box = pruned(raw, t0);
      const mine = box.jobs.filter((j) => j.due <= t0 && j.lease <= t0).slice(0, PUSH_CLAIM_MAX);
      for (const j of mine) j.lease = lease;
      if (mine.length || box.jobs.length !== raw.jobs.length) await txn.put(PUSH_OUTBOX, box);
      return mine.map((j) => ({ ...j, left: j.left && [...j.left] }));
    });
    if (claimed.length) await this.#run(claimed, lease, key, t0);
    const box = await this.s.get<PushOutbox>(PUSH_OUTBOX);
    let next = Infinity;
    for (const j of pruned(box, now()).jobs) next = Math.min(next, j.lease > now() ? j.lease : j.due, j.at + PUSH_WINDOW);
    return next;
  }

  /** 잡은 일들: 살아 있는 손만 남기고, 받는 기기마다 고정 알림 하나 (합침). 결과를 임차가 그대로인 일에만 반영 */
  async #run(claimed: PushJob[], lease: number, key: VapidKey, t0: number) {
    const handGot = await this.s.get<unknown>([...new Set(claimed.flatMap((j) => this.d.handKeys(j)))]);
    const live = claimed.filter((j) => this.d.handOk(j, handGot));
    // 받는 기기: 만료 안 됐고 주인 세션이 살아 있는 구독
    const subs = await this.s.list<StoredSub>({ prefix: PUSH_SUB_PREFIX, limit: PUSH_GLOBAL * 2 });
    const owners = [...new Set([...subs.values()].map((x) => x.owner))].slice(0, 127);
    const recs = owners.length ? await this.s.get<TeacherTok>(owners.map((o) => `${TEACHER_PREFIX}${o}`)) : new Map<string, TeacherTok>();
    const byRid = new Map<string, string>(); // rid → endpoint 해시
    for (const [k, x] of subs) if (x.expiresAt > t0 && ownerLive(recs.get(`${TEACHER_PREFIX}${x.owner}`), t0)) byRid.set(k.slice(PUSH_SUB_PREFIX.length, PUSH_SUB_PREFIX.length + RID), k.slice(PUSH_SUB_PREFIX.length));
    for (const j of live) j.left = (j.left ?? [...byRid.keys()]).filter((r) => byRid.has(r));
    const need = [...new Set(live.flatMap((j) => j.left ?? []))];
    const result = new Map<string, 'done' | 'retry' | 'skip'>();
    const queue = [...need];
    const worker = async () => {
      for (let rid = queue.shift(); rid !== undefined; rid = queue.shift()) {
        if (now() >= t0 + PUSH_RUN || now() >= lease) return; // 남은 기기는 다음 시도로
        const jobs = live.filter((j) => j.left?.includes(rid!));
        result.set(rid, await this.#sendOne(byRid.get(rid)!, jobs, lease, key).catch(() => 'retry' as const));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_PARALLEL, queue.length) }, worker));

    // 2) 정리: 이 처리의 임차가 그대로인 일만 바꾼다 (사이에 손 내림·끝내기가 지웠으면 그대로 없어진다)
    const liveIds = new Set(live.map((j) => j.id));
    const byId = new Map(live.map((j) => [j.id, j]));
    await this.s.transaction(async (txn) => {
      const raw = await txn.get<PushOutbox>(PUSH_OUTBOX);
      if (!raw) return;
      const t = now();
      const box = pruned(raw, t);
      const mine = box.jobs.filter((j) => j.lease === lease && claimed.some((c) => c.id === j.id));
      const got = mine.length ? await txn.get<unknown>([...new Set(mine.flatMap((j) => this.d.handKeys(j)))]) : new Map<string, unknown>();
      box.jobs = box.jobs.flatMap((j) => {
        if (!mine.includes(j)) return [j];
        const c = byId.get(j.id);
        if (!c || !liveIds.has(j.id) || !this.d.handOk(j, got)) return [];
        const left = (c.left ?? []).filter((r) => { const x = result.get(r); return x !== 'done' && x !== 'skip'; });
        const tries = j.tries + 1;
        const due = t + (RETRY_DELAY[tries] ?? Infinity);
        if (!left.length || tries >= PUSH_TRIES || due >= j.at + PUSH_WINDOW) return [];
        return [{ ...j, tries, due, lease: 0, left }];
      });
      await txn.put(PUSH_OUTBOX, box);
    });
  }

  /** 기기 하나에 한 번. 풀기·암호화 뒤, fetch 를 시작하기 바로 앞에서 다시 확인한다 (그 뒤 await 없이 fetch) */
  async #sendOne(h: string, jobs: PushJob[], lease: number, key: VapidKey): Promise<'done' | 'retry' | 'skip'> {
    const pre = await this.s.get<StoredSub>(subKey(h));
    if (!pre) return 'skip';
    const text = await this.d.open(subAad(h), pre.iv, pre.ct);
    let sub: unknown = null;
    try { sub = text ? JSON.parse(text) : null; } catch { sub = null; }
    if (!sub) return 'skip';
    // 풀기·암호화·서명이 끝난 뒤 fetch 바로 앞에서 core 가 부른다 (통과 못 하면 fetch 없이 failed)
    let started = false;
    const r = await sendPush(sub, key, PUSH_PAYLOAD as LabPushPayload, {
      beforeSend: async () => (started = await this.#stillWanted(h, pre, jobs, lease)),
    });
    if (!started) return 'skip';
    if (r.outcome === 'retryable') return 'retry';
    if (r.outcome === 'gone' && started) {
      // 묶음이 그대로일 때만 지운다 (사이에 다시 구독했으면 남긴다)
      await this.s.transaction(async (txn) => {
        const cur = await txn.get<StoredSub>(subKey(h));
        if (cur && cur.iv === pre.iv) await txn.delete(subKey(h));
      });
    }
    return 'done';
  }

  /** 보내기 바로 앞: 구독 묶음(같은 봉인)·주인 세션·임차·손 하나라도 그대로인가. 한 번 읽고 나머지는 동기 */
  async #stillWanted(h: string, pre: StoredSub, jobs: PushJob[], lease: number) {
    const keys = [subKey(h), `${TEACHER_PREFIX}${pre.owner}`, PUSH_OUTBOX, ...jobs.flatMap((j) => this.d.handKeys(j))];
    const got = await this.s.get<unknown>([...new Set(keys)]);
    const t = now();
    const cur = got.get(subKey(h)) as StoredSub | undefined;
    if (!cur || cur.iv !== pre.iv || cur.owner !== pre.owner || cur.expiresAt <= t) return false;
    if (!ownerLive(got.get(`${TEACHER_PREFIX}${pre.owner}`) as TeacherTok | undefined, t)) return false;
    if (t >= lease) return false;
    const box = got.get(PUSH_OUTBOX) as PushOutbox | undefined;
    return jobs.some((j) => box?.jobs.some((x) => x.id === j.id && x.lease === lease) && j.at + PUSH_WINDOW > t && this.d.handOk(j, got));
  }
}

async function sha(s: string) {
  return isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
