// 실습실 개설 요청 Web Push — 알림만 보내는 등록·아웃박스. State(DO) 안에서만 쓴다.
//
// 권한 경계: register·remove·test·acknowledgeTest·status·devices·config 를 부르기 전에
//   State 가 WebAuthn·관리자 검증을 끝냈다고 본다. 이 서비스는 세션 쿠키를 읽지 않고,
//   관리자 세션을 만들거나 늘리지 않으며, 요청을 승인·거절하지 않는다. 승인 권한은 없다.
//   register 만은 그 검증 뒤에도 credentialExists 를 await 앞뒤로 직접 확인한다.
//   alarm 은 사람이 아니므로 세션 인증이 없다.
//
// 수명: 기기 등록은 관리자 세션(8시간)과 무관하다. 고정 TTL 이 없다.
//   지워지는 때: remove, 푸시 서비스 404/410, 등록된 자격 증명 삭제.
//   등록된 기기가 없어도 요청은 사라지지 않는다. pending() 은 읽기만 한다.
//   나중에 기기를 등록하면 schedule(now) 를 부르고, alarm 이 pending() 을 다시 읽어 채운다.
//
// 저장: endpoint·p256dh·auth 는 seal 로만 저장한다. AAD 는 기기·세대·자격 증명마다 다르다.
//   응답·오류에는 endpoint·키·비밀을 싣지 않는다.
//
// 전달: accepted 는 푸시 서비스가 HTTP 로 받았다는 뜻만이다. 기기가 보여 줬는지,
//   사람이 받았는지는 Web Push 로 알 수 없다. testAcknowledgedAt 는 acknowledgeTest
//   (사람이 폰에서 받았다고 누름) 로만 기록하며, accepted 에서 추론하지 않는다.
//
// 이미 beforeSend 를 지나 fetch 를 시작한 요청은 remove·세대 교체·자격 증명 삭제 뒤에도
//   그 한 번은 끝날 수 있다. 그 뒤의 보내기는 시작하지 않는다.
// 저장소 트랜잭션 안에서는 get/put/delete/list 만 한다. seal·open·credentialExists·
//   pending·vapid·schedule·send·now 는 트랜잭션 밖에서만 부른다.
import { isAllowedPushEndpoint, LAB_PUSH_URL, parsePushSubscription, PUSH_ENDPOINT_MAX, sendPush, type PushSendResult, type PushSubscriptionRecord, type VapidKey } from './lab-web-push';

export const LAB_OPEN_PUSH_SUB_PREFIX = 'labopen:pushsub:';
export const LAB_OPEN_PUSH_JOB_PREFIX = 'labopen:pushjob:';

/** 알림 내용은 고정. 이름·요청 id·외부 링크·비밀을 싣지 않는다. tag 가 같아 기기에서 한 알림으로 겹친다. */
export const LAB_OPEN_PUSH_PAYLOAD = Object.freeze({
  title: '공부방 실습실',
  body: '실습실 개설 요청이 있습니다. 요청함에서 확인하세요.',
  url: LAB_PUSH_URL,
  tag: 'lab-open-request',
});

const DEVICE_MAX = 8;
const PENDING_MAX = 128;
const SENDS_PER_ALARM = 4;
const LEASE_MS = 60_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const REMIND_FIRST_MS = 15 * 60 * 1000;
const REMIND_EVERY_MS = 60 * 60 * 1000;
const VAPID_RETRY_MS = 5 * 60 * 1000;
const ATTEMPT_CAP = 32;
const LABEL_MAX = 40;
const CRED_MAX = 200;
const PENDING_ID_MAX = 200;
const RETRY_MS = [10_000, 30_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000] as const;

export type LabOpenPushOutcome = 'accepted' | 'retryable' | 'failed' | 'gone';
export interface LabOpenPushFail { status: number; error: string }
export interface LabOpenPushDevice {
  deviceId: string;
  label: string;
  lastAttemptAt?: number;
  lastOutcome?: LabOpenPushOutcome;
  testAcknowledgedAt?: number;
}

export interface LabOpenPushDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list' | 'transaction'>;
  now(): number;
  credentialExists(id: string): Promise<boolean>;
  vapid(): Promise<VapidKey | null>;
  seal(aad: string, text: string): Promise<{ iv: string; ct: string }>;
  open(aad: string, iv: string, ct: string): Promise<string | null>;
  schedule(t: number): Promise<void>;
  /** 지금 승인되지 않은 요청 id. 최대 128개. 이름·PII 가 아니다. */
  pending(): Promise<string[]>;
  send?: typeof sendPush;
}

interface StoredDevice {
  deviceId: string;
  generation: string;
  credentialId: string;
  label: string;
  iv: string;
  ct: string;
  at: number;
  lastAttemptAt?: number;
  lastOutcome?: LabOpenPushOutcome;
  testAcknowledgedAt?: number;
  needsReregistration?: true;
}

/** 기기마다 하나. version 은 그 구간의 pending id 집합이다. 요청×기기 행렬로 보내지 않는다. */
interface PushJob {
  deviceId: string;
  generation: string;
  credentialId: string;
  version: string;
  openedAt: number;
  due: number;
  attempts: number;
  leaseUntil: number;
  leaseToken: string;
  accepts: number;
  exhausted: boolean;
}

interface Snap {
  deviceId: string;
  generation: string;
  credentialId: string;
  iv: string;
  ct: string;
  leaseToken: string;
}

type Guard = 'ok' | 'device' | 'credential' | 'pending' | 'lease';

const fail = (status: number, error: string): LabOpenPushFail => ({ status, error });
const isFail = (v: unknown): v is LabOpenPushFail => {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as { status?: unknown; error?: unknown };
  return typeof rec.status === 'number' && typeof rec.error === 'string';
};
const subKey = (deviceId: string) => `${LAB_OPEN_PUSH_SUB_PREFIX}${deviceId}`;
const jobKey = (deviceId: string) => `${LAB_OPEN_PUSH_JOB_PREFIX}${deviceId}`;
const aadOf = (deviceId: string, generation: string, credentialId: string) => `labopen:pushsub:${deviceId}:${generation}:${credentialId}`;

function retryDelay(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), RETRY_MS.length) - 1;
  return RETRY_MS[i] ?? RETRY_MS[RETRY_MS.length - 1];
}

function credOk(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= CRED_MAX && /^[A-Za-z0-9_-]+$/.test(id);
}

function labelOk(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const chars = [...label];
  if (chars.length > LABEL_MAX) return null;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029) return null;
  }
  return label;
}

/** pending() 결과를 정렬·중복 제거·상한. 호출자가 준 배열은 바꾸지 않는다. */
export function normalizePendingIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const all: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.length < 1 || id.length > PENDING_ID_MAX) continue;
    if (/[\u0000-\u001f\u007f-\u009f]/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    all.push(id);
  }
  all.sort();
  return all.slice(0, PENDING_MAX);
}

function canonical(sub: PushSubscriptionRecord): string {
  return JSON.stringify({ endpoint: sub.endpoint, keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh } });
}

function present(d: StoredDevice): LabOpenPushDevice {
  const out: LabOpenPushDevice = { deviceId: d.deviceId, label: d.label };
  if (typeof d.lastAttemptAt === 'number') out.lastAttemptAt = d.lastAttemptAt;
  if (d.lastOutcome) out.lastOutcome = d.lastOutcome;
  if (typeof d.testAcknowledgedAt === 'number') out.testAcknowledgedAt = d.testAcknowledgedAt;
  return out;
}

function isDevice(v: unknown): v is StoredDevice {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as StoredDevice;
  return typeof d.deviceId === 'string' && typeof d.generation === 'string' && typeof d.credentialId === 'string'
    && typeof d.label === 'string' && typeof d.iv === 'string' && typeof d.ct === 'string' && typeof d.at === 'number';
}

function isJob(v: unknown): v is PushJob {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as PushJob;
  return typeof j.deviceId === 'string' && typeof j.generation === 'string' && typeof j.credentialId === 'string'
    && typeof j.version === 'string' && typeof j.leaseToken === 'string'
    && Number.isFinite(j.openedAt) && Number.isFinite(j.due) && Number.isFinite(j.attempts)
    && Number.isFinite(j.leaseUntil) && Number.isFinite(j.accepts) && typeof j.exhausted === 'boolean';
}

function copyDevice(d: StoredDevice, patch: Partial<StoredDevice> & { clearReregistration?: boolean } = {}): StoredDevice {
  const needs = patch.clearReregistration ? false : patch.needsReregistration === true || d.needsReregistration === true;
  const lastAttemptAt = patch.lastAttemptAt ?? d.lastAttemptAt;
  const lastOutcome = patch.lastOutcome ?? d.lastOutcome;
  const testAcknowledgedAt = patch.testAcknowledgedAt ?? d.testAcknowledgedAt;
  const out: StoredDevice = {
    deviceId: d.deviceId,
    generation: patch.generation ?? d.generation,
    credentialId: patch.credentialId ?? d.credentialId,
    label: patch.label ?? d.label,
    iv: patch.iv ?? d.iv,
    ct: patch.ct ?? d.ct,
    at: patch.at ?? d.at,
  };
  if (typeof lastAttemptAt === 'number') out.lastAttemptAt = lastAttemptAt;
  if (lastOutcome) out.lastOutcome = lastOutcome;
  if (typeof testAcknowledgedAt === 'number') out.testAcknowledgedAt = testAcknowledgedAt;
  if (needs) out.needsReregistration = true;
  return out;
}

async function digest(text: string): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function outcomeBody(r: PushSendResult): { outcome: string; status?: number } {
  return typeof r.status === 'number' ? { outcome: r.outcome, status: r.status } : { outcome: r.outcome };
}

export class LabOpenPushService {
  constructor(private d: LabOpenPushDeps) {}
  #running = false;

  async config(): Promise<{ available: true; applicationServerKey: string } | { available: false }> {
    const key = await this.d.vapid();
    return key && typeof key.publicKey === 'string' && key.publicKey ? { available: true, applicationServerKey: key.publicKey } : { available: false };
  }

  /**
   * 기기를 등록한다. 같은 endpoint·같은 키·같은 자격 증명은 세대를 유지한다.
   * 주인이나 키가 바뀌면 세대 UUID 를 갈아 AAD 와 진행 중 임차를 끊는다.
   */
  async register(credentialId: string, subscription: unknown, label: unknown): Promise<{ ok: true; deviceId: string } | LabOpenPushFail> {
    if (!credOk(credentialId)) return fail(400, '보안 키가 올바르지 않습니다.');
    const labelText = labelOk(label);
    if (labelText === null) return fail(400, '기기 이름이 올바르지 않습니다.');
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const sub = await parsePushSubscription(subscription);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    if (!sub) return fail(400, '알림 구독 정보가 올바르지 않습니다.');
    const deviceId = await digest(sub.endpoint);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const plain = canonical(sub);
    const cur = await this.d.storage.get<StoredDevice>(subKey(deviceId));
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');

    let samePlain = false;
    if (isDevice(cur) && cur.credentialId === credentialId) {
      const opened = await this.d.open(aadOf(cur.deviceId, cur.generation, cur.credentialId), cur.iv, cur.ct);
      if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
      samePlain = opened === plain;
    }
    if (isDevice(cur) && samePlain && cur.credentialId === credentialId && cur.label === labelText && cur.needsReregistration !== true) {
      return this.#scheduled(credentialId, deviceId);
    }

    const listed = await this.d.storage.list<StoredDevice>({ prefix: LAB_OPEN_PUSH_SUB_PREFIX });
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const dead: { key: string; credentialId: string; generation: string }[] = [];
    for (const [key, rec] of listed) {
      if (key === subKey(deviceId) || !isDevice(rec)) continue;
      if (!(await this.d.credentialExists(rec.credentialId))) dead.push({ key, credentialId: rec.credentialId, generation: rec.generation });
      if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    }

    const keepSeal = isDevice(cur) && samePlain && cur.credentialId === credentialId;
    const generation = keepSeal ? cur.generation : crypto.randomUUID();
    const sealed = keepSeal ? { iv: cur.iv, ct: cur.ct } : await this.d.seal(aadOf(deviceId, generation, credentialId), plain);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const at = this.d.now();
    const wrote = await this.d.storage.transaction(async (txn) => {
      for (const d of dead) {
        const still = await txn.get<StoredDevice>(d.key);
        if (isDevice(still) && still.credentialId === d.credentialId && still.generation === d.generation) {
          await txn.delete(d.key);
          await txn.delete(jobKey(still.deviceId));
        }
      }
      const freshAll = await txn.list<StoredDevice>({ prefix: LAB_OPEN_PUSH_SUB_PREFIX });
      const mine = subKey(deviceId);
      let others = 0;
      for (const [key, rec] of freshAll) if (key !== mine && isDevice(rec)) others++;
      const exists = isDevice(freshAll.get(mine));
      if (!exists && others >= DEVICE_MAX) return 'cap' as const;
      const fresh = exists ? await txn.get<StoredDevice>(mine) : undefined;
      if (keepSeal && isDevice(fresh)) {
        // 같은 키를 다시 등록하면 실패로 멈춰 둔 보내기를 풀되, 세대·봉인은 유지한다.
        const kept = copyDevice(fresh, { label: labelText, clearReregistration: true });
        if (fresh.needsReregistration === true) {
          delete kept.lastAttemptAt;
          delete kept.lastOutcome;
        }
        await txn.put(mine, kept);
        return 'ok' as const;
      }
      const next: StoredDevice = {
        deviceId,
        generation,
        credentialId,
        label: labelText,
        iv: sealed.iv,
        ct: sealed.ct,
        at: isDevice(fresh) ? fresh.at : at,
      };
      await txn.put(mine, next);
      await txn.delete(jobKey(deviceId));
      return 'ok' as const;
    });
    if (!(await this.#owns(credentialId))) {
      if (wrote === 'ok') await this.#dropDevice(deviceId);
      return fail(403, '등록된 보안 키가 없습니다.');
    }
    if (wrote === 'cap') return fail(429, '알림을 받는 기기가 너무 많습니다.');
    return this.#scheduled(credentialId, deviceId);
  }

  async status(endpoint: unknown): Promise<{ enabled: boolean; deviceId?: string; label?: string; lastAttemptAt?: number; lastOutcome?: LabOpenPushOutcome; testAcknowledgedAt?: number } | LabOpenPushFail> {
    const ep = this.#endpoint(endpoint);
    if (isFail(ep)) return ep;
    const deviceId = await digest(ep);
    const cur = await this.d.storage.get<StoredDevice>(subKey(deviceId));
    if (!isDevice(cur)) return { enabled: false };
    if (!(await this.d.credentialExists(cur.credentialId))) return { enabled: false };
    return { enabled: cur.needsReregistration !== true, ...present(cur) };
  }

  /**
   * 이 endpoint 의 기기와 아직 시작하지 않은 보내기만 지운다.
   * beforeSend 를 지나 이미 시작한 요청은 그 한 번이 끝날 수 있다. 다음 보내기는 시작하지 않는다.
   */
  async remove(endpoint: unknown): Promise<{ ok: true } | LabOpenPushFail> {
    const ep = this.#endpoint(endpoint);
    if (isFail(ep)) return ep;
    await this.#dropDevice(await digest(ep));
    return { ok: true };
  }

  async devices(): Promise<{ devices: LabOpenPushDevice[]; available: boolean }> {
    const key = await this.d.vapid();
    const all = await this.#devices();
    const devices: LabOpenPushDevice[] = [];
    for (const rec of all) {
      if ((await this.d.credentialExists(rec.credentialId)) === true) devices.push(present(rec));
    }
    return { devices, available: !!(key && typeof key.publicKey === 'string' && key.publicKey) };
  }

  /** Caller must validate the sole owner's Access session before using this method. */
  async testRegistered(endpoint:unknown) {
    const ep=this.#endpoint(endpoint);if(isFail(ep))return ep;
    const cur=await this.d.storage.get<StoredDevice>(subKey(await digest(ep)));
    return isDevice(cur)?this.test(cur.credentialId,ep):fail(404,'등록된 기기가 없습니다.');
  }

  /** 고른 등록 기기에 고정 요청 알림을 한 번 보낸다. 대기 요청이 없어도 된다. 수신 확인은 acknowledgeTest. */
  async test(credentialId: string, endpoint: unknown): Promise<{ outcome: string; status?: number } | LabOpenPushFail> {
    if (!credOk(credentialId)) return fail(400, '보안 키가 올바르지 않습니다.');
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const ep = this.#endpoint(endpoint);
    if (isFail(ep)) return ep;
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const deviceId = await digest(ep);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const cur = await this.d.storage.get<StoredDevice>(subKey(deviceId));
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    if (!isDevice(cur) || cur.credentialId !== credentialId) return fail(404, '등록된 기기가 없습니다.');
    const key = await this.d.vapid();
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    if (!key || typeof key.publicKey !== 'string' || !key.publicKey) return fail(409, '지금은 알림을 켤 수 없습니다.');
    const opened = await this.d.open(aadOf(cur.deviceId, cur.generation, cur.credentialId), cur.iv, cur.ct);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    const sub = await this.#subscription(opened, deviceId);
    if (!(await this.#owns(credentialId))) return fail(403, '등록된 보안 키가 없습니다.');
    if (!sub) return fail(409, '알림 구독을 확인하지 못했습니다.');
    const now = this.d.now();
    const leaseToken = crypto.randomUUID();
    const claimed = await this.d.storage.transaction(async (txn) => {
      const fresh = await txn.get<StoredDevice>(subKey(deviceId));
      if (!isDevice(fresh) || fresh.generation !== cur.generation || fresh.credentialId !== credentialId || fresh.iv !== cur.iv) return 'stale' as const;
      const job = await txn.get<PushJob>(jobKey(deviceId));
      if (isJob(job) && job.leaseUntil > now && job.leaseToken) return 'leased' as const;
      const next: PushJob = {
        deviceId,
        generation: fresh.generation,
        credentialId,
        version: isJob(job) ? job.version : '',
        openedAt: isJob(job) ? job.openedAt : now,
        due: now,
        attempts: isJob(job) ? job.attempts : 0,
        leaseUntil: now + LEASE_MS,
        leaseToken,
        accepts: isJob(job) ? job.accepts : 0,
        exhausted: false,
      };
      await txn.put(jobKey(deviceId), next);
      return 'ok' as const;
    });
    if (!(await this.#owns(credentialId))) {
      await this.#releaseLease(deviceId, leaseToken);
      return fail(403, '등록된 보안 키가 없습니다.');
    }
    if (claimed === 'stale') return fail(404, '등록된 기기가 없습니다.');
    if (claimed === 'leased') return { outcome: 'retryable' };
    const snap: Snap = { deviceId, generation: cur.generation, credentialId, iv: cur.iv, ct: cur.ct, leaseToken };
    return this.#dispatch(snap, sub, key, false);
  }

  /** 사람이 폰에서 받았다고 눌렀을 때만 시각을 남긴다. 푸시 수락으로 호출하지 않는다. */
  async acknowledgeTest(endpoint: unknown): Promise<{ ok: true } | LabOpenPushFail> {
    const ep = this.#endpoint(endpoint);
    if (isFail(ep)) return ep;
    const deviceId = await digest(ep);
    const cur = await this.d.storage.get<StoredDevice>(subKey(deviceId));
    if (!isDevice(cur)) return { ok: true };
    if (!(await this.d.credentialExists(cur.credentialId))) return { ok: true };
    const at = this.d.now();
    const generation = cur.generation;
    await this.d.storage.transaction(async (txn) => {
      const fresh = await txn.get<StoredDevice>(subKey(deviceId));
      if (!isDevice(fresh) || fresh.generation !== generation) return;
      await txn.put(subKey(deviceId), copyDevice(fresh, { testAcknowledgedAt: at }));
    });
    return { ok: true };
  }

  /**
   * 알람. 세션을 보지 않는다. pending() 으로 빠졌던 등록을 다시 채운다.
   * 다음으로 볼 시각. 더 없으면 Infinity.
   */
  async alarm(t: number): Promise<number> {
    if (!Number.isFinite(t)) return Infinity;
    if (this.#running) return this.#clock() + LEASE_MS;
    this.#running = true;
    try { return await this.#alarm(); }
    finally { this.#running = false; }
  }

  async #alarm(): Promise<number> {
    const now = this.#clock();
    if (!Number.isFinite(now)) return Infinity;
    await this.#dropDead();
    const devices = await this.#devices();
    const ids = normalizePendingIds(await this.d.pending());
    if (!devices.length) return Infinity;
    const usable = devices.filter((d) => d.needsReregistration !== true);
    if (!ids.length) {
      await this.#clearIdle(now);
      return Infinity;
    }
    if (!usable.length) return Infinity;
    const key = await this.d.vapid();
    if (!key || typeof key.publicKey !== 'string' || !key.publicKey) return now + VAPID_RETRY_MS;
    const version = await digest(ids.join('\n'));
    await this.#plan(now, version, devices);
    for (let n = 0; n < SENDS_PER_ALARM; n++) {
      const claimed = await this.#claim(this.#clock(), version);
      if (!claimed) break;
      await this.#dispatch(claimed.snap, claimed.sub, key, true);
    }
    return this.#soonest(this.#clock());
  }

  async #dispatch(snap: Snap, sub: PushSubscriptionRecord | null, key: VapidKey, requirePending: boolean): Promise<{ outcome: string; status?: number }> {
    let opened = sub;
    if (!opened) {
      const text = await this.d.open(aadOf(snap.deviceId, snap.generation, snap.credentialId), snap.iv, snap.ct);
      opened = await this.#subscription(text, snap.deviceId);
    }
    if (!opened) {
      await this.#markReregistration(snap, this.#clock());
      return { outcome: 'failed' };
    }
    let ran = false;
    const fence: { reason: Guard } = { reason: 'lease' };
    let result: PushSendResult;
    const send = this.d.send ?? sendPush;
    try {
      result = await send(opened, key, { ...LAB_OPEN_PUSH_PAYLOAD }, {
        now: this.d.now(),
        beforeSend: async () => {
          ran = true;
          fence.reason = await this.#guard(snap, requirePending);
          return fence.reason === 'ok';
        },
      });
    } catch {
      if (!ran || fence.reason !== 'ok') {
        await this.#abort(fence.reason, snap);
        return { outcome: 'failed' };
      }
      result = { outcome: 'retryable' };
    }
    if (!ran) return { outcome: 'failed' };
    if (fence.reason !== 'ok') {
      await this.#abort(fence.reason, snap);
      return { outcome: 'failed' };
    }
    await this.#finish(snap, result, this.#clock());
    return outcomeBody(result);
  }

  /** fetch 직전. 세대·자격 증명·(요청 알림이면) 대기 요청·임차 주인이 모두 맞을 때만 true. */
  async #guard(snap: Snap, requirePending: boolean): Promise<Guard> {
    const cur = await this.d.storage.get<StoredDevice>(subKey(snap.deviceId));
    if (!isDevice(cur) || cur.generation !== snap.generation || cur.iv !== snap.iv || cur.credentialId !== snap.credentialId) return 'device';
    const job = await this.d.storage.get<PushJob>(jobKey(snap.deviceId));
    if (!isJob(job) || job.leaseToken !== snap.leaseToken || job.generation !== snap.generation || !(job.leaseUntil > this.#clock())) return 'lease';
    if ((await this.d.credentialExists(cur.credentialId)) !== true) return 'credential';
    if (requirePending && !normalizePendingIds(await this.d.pending()).length) return 'pending';
    const cur2 = await this.d.storage.get<StoredDevice>(subKey(snap.deviceId));
    const job2 = await this.d.storage.get<PushJob>(jobKey(snap.deviceId));
    if (!isDevice(cur2) || cur2.generation !== snap.generation || cur2.iv !== snap.iv || cur2.credentialId !== snap.credentialId) return 'device';
    if (!isJob(job2)) return 'lease';
    const sameLease = job2.leaseToken === snap.leaseToken;
    const sameGeneration = job2.generation === snap.generation;
    if (!sameLease || !sameGeneration || !(job2.leaseUntil > this.#clock())) return 'lease';
    const stillEnrolled = await this.d.credentialExists(cur2.credentialId);
    if (stillEnrolled !== true) return 'credential';
    return 'ok';
  }

  async #finish(snap: Snap, result: PushSendResult, now: number) {
    if (result.outcome === 'gone') {
      await this.#dropIfSame(snap);
      return;
    }
    const ids = normalizePendingIds(await this.d.pending());
    const version = ids.length ? await digest(ids.join('\n')) : '';
    await this.d.storage.transaction(async (txn) => {
      const cur = await txn.get<StoredDevice>(subKey(snap.deviceId));
      const job = await txn.get<PushJob>(jobKey(snap.deviceId));
      const own = isJob(job) && job.leaseToken === snap.leaseToken && job.generation === snap.generation;
      const sameDevice = isDevice(cur) && cur.generation === snap.generation && cur.iv === snap.iv;
      if (!sameDevice || !own || !isDevice(cur) || !isJob(job)) return;
      if (result.outcome === 'failed') {
        await txn.put(subKey(snap.deviceId), copyDevice(cur, { lastAttemptAt: now, lastOutcome: 'failed', needsReregistration: true }));
        await txn.delete(jobKey(snap.deviceId));
        return;
      }
      if (result.outcome === 'retryable') {
        await txn.put(subKey(snap.deviceId), copyDevice(cur, { lastAttemptAt: now, lastOutcome: 'retryable' }));
        if (!version) {
          await txn.delete(jobKey(snap.deviceId));
          return;
        }
        const same = job.version === version;
        const attempts = (same ? job.attempts : 0) + 1;
        const openedAt = same ? job.openedAt : now;
        const delay = retryDelay(attempts);
        const due = now + delay;
        const exhausted = attempts >= ATTEMPT_CAP || now > openedAt + WINDOW_MS || due > openedAt + WINDOW_MS;
        await txn.put(jobKey(snap.deviceId), {
          deviceId: cur.deviceId, generation: cur.generation, credentialId: cur.credentialId, version,
          openedAt, due: exhausted ? openedAt + WINDOW_MS : due, attempts, leaseUntil: 0, leaseToken: '', accepts: same ? job.accepts : 0, exhausted,
        } satisfies PushJob);
        return;
      }
      if (result.outcome !== 'accepted') return;
      await txn.put(subKey(snap.deviceId), copyDevice(cur, { lastAttemptAt: now, lastOutcome: 'accepted', clearReregistration: true }));
      if (!version) {
        await txn.delete(jobKey(snap.deviceId));
        return;
      }
      const same = job.version === version && job.generation === cur.generation;
      const openedAt = same ? job.openedAt : now;
      const accepts = (same ? job.accepts : 0) + 1;
      const due = now + (accepts === 1 ? REMIND_FIRST_MS : REMIND_EVERY_MS);
      const exhausted = now > openedAt + WINDOW_MS || due > openedAt + WINDOW_MS;
      await txn.put(jobKey(snap.deviceId), {
        deviceId: cur.deviceId, generation: cur.generation, credentialId: cur.credentialId, version, openedAt,
        due: exhausted ? openedAt + WINDOW_MS : due, attempts: 0, leaseUntil: 0, leaseToken: '', accepts, exhausted,
      } satisfies PushJob);
    });
  }

  async #plan(now: number, version: string, devices: StoredDevice[]) {
    const live = new Set(devices.map((d) => d.deviceId));
    const jobs = await this.d.storage.list<PushJob>({ prefix: LAB_OPEN_PUSH_JOB_PREFIX });
    for (const [key, job] of jobs) {
      if (!isJob(job) || live.has(job.deviceId)) continue;
      await this.d.storage.transaction(async (txn) => {
        const fresh = await txn.get<PushJob>(key);
        if (isJob(fresh) && !(fresh.leaseUntil > now)) await txn.delete(key);
      });
    }
    for (const dev of devices) {
      await this.d.storage.transaction(async (txn) => {
        const key = jobKey(dev.deviceId);
        const job = await txn.get<PushJob>(key);
        if (isJob(job) && job.leaseUntil > now) return;
        if (dev.needsReregistration === true) {
          if (isJob(job)) await txn.delete(key);
          return;
        }
        if (isJob(job) && job.generation === dev.generation && job.version === version && job.credentialId === dev.credentialId) {
          if (job.exhausted || now > job.openedAt + WINDOW_MS) {
            if (!job.exhausted) await txn.put(key, { ...job, exhausted: true, leaseToken: '', leaseUntil: 0 });
            return;
          }
          return;
        }
        const next: PushJob = {
          deviceId: dev.deviceId, generation: dev.generation, credentialId: dev.credentialId, version,
          openedAt: now, due: now, attempts: 0, leaseUntil: 0, leaseToken: '', accepts: 0, exhausted: false,
        };
        await txn.put(key, next);
      });
    }
  }

  async #claim(now: number, version: string): Promise<{ snap: Snap; sub: null } | null> {
    const leaseToken = crypto.randomUUID();
    const leaseUntil = now + LEASE_MS;
    return this.d.storage.transaction(async (txn) => {
      const jobs = await txn.list<PushJob>({ prefix: LAB_OPEN_PUSH_JOB_PREFIX });
      const candidates: PushJob[] = [];
      for (const job of jobs.values()) {
        if (!isJob(job) || job.exhausted || job.version !== version) continue;
        if (job.leaseUntil > now || job.due > now) continue;
        if (now > job.openedAt + WINDOW_MS) continue;
        candidates.push(job);
      }
      candidates.sort((a, b) => a.due - b.due || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
      for (const job of candidates) {
        const dev = await txn.get<StoredDevice>(subKey(job.deviceId));
        if (!isDevice(dev) || dev.needsReregistration === true || dev.generation !== job.generation || dev.credentialId !== job.credentialId) continue;
        const next: PushJob = { ...job, leaseToken, leaseUntil };
        await txn.put(jobKey(job.deviceId), next);
        const snap: Snap = { deviceId: dev.deviceId, generation: dev.generation, credentialId: dev.credentialId, iv: dev.iv, ct: dev.ct, leaseToken };
        return { snap, sub: null };
      }
      return null;
    });
  }

  async #abort(reason: Guard, snap: Snap) {
    if (reason === 'credential') {
      await this.#dropIfSame(snap);
      return;
    }
    if (reason === 'pending' || reason === 'device') await this.#releaseLease(snap.deviceId, snap.leaseToken);
  }

  async #releaseLease(deviceId: string, leaseToken: string) {
    await this.d.storage.transaction(async (txn) => {
      const job = await txn.get<PushJob>(jobKey(deviceId));
      if (isJob(job) && job.leaseToken === leaseToken) await txn.delete(jobKey(deviceId));
    });
  }

  async #markReregistration(snap: Snap, now: number) {
    await this.d.storage.transaction(async (txn) => {
      const cur = await txn.get<StoredDevice>(subKey(snap.deviceId));
      if (isDevice(cur) && cur.generation === snap.generation && cur.iv === snap.iv) {
        await txn.put(subKey(snap.deviceId), copyDevice(cur, { lastAttemptAt: now, lastOutcome: 'failed', needsReregistration: true }));
      }
      const job = await txn.get<PushJob>(jobKey(snap.deviceId));
      if (isJob(job) && job.leaseToken === snap.leaseToken) await txn.delete(jobKey(snap.deviceId));
    });
  }

  async #dropIfSame(snap: Snap) {
    await this.d.storage.transaction(async (txn) => {
      const cur = await txn.get<StoredDevice>(subKey(snap.deviceId));
      if (!isDevice(cur) || cur.generation !== snap.generation || cur.iv !== snap.iv) return;
      await txn.delete(subKey(snap.deviceId));
      await txn.delete(jobKey(snap.deviceId));
    });
  }

  async #dropDevice(deviceId: string) {
    await this.d.storage.transaction(async (txn) => {
      await txn.delete(subKey(deviceId));
      await txn.delete(jobKey(deviceId));
    });
  }

  async #dropDead() {
    const all = await this.d.storage.list<StoredDevice>({ prefix: LAB_OPEN_PUSH_SUB_PREFIX });
    const dead: { key: string; credentialId: string; generation: string }[] = [];
    for (const [key, rec] of all) {
      if (!isDevice(rec)) continue;
      if ((await this.d.credentialExists(rec.credentialId)) !== true) dead.push({ key, credentialId: rec.credentialId, generation: rec.generation });
    }
    if (!dead.length) return;
    await this.d.storage.transaction(async (txn) => {
      for (const d of dead) {
        const still = await txn.get<StoredDevice>(d.key);
        if (isDevice(still) && still.credentialId === d.credentialId && still.generation === d.generation) {
          await txn.delete(d.key);
          await txn.delete(jobKey(still.deviceId));
        }
      }
    });
  }

  async #clearIdle(now: number) {
    await this.d.storage.transaction(async (txn) => {
      const jobs = await txn.list<PushJob>({ prefix: LAB_OPEN_PUSH_JOB_PREFIX });
      for (const [key, job] of jobs) {
        if (!isJob(job) || !(job.leaseUntil > now)) await txn.delete(key);
      }
    });
  }

  async #soonest(now: number): Promise<number> {
    const jobs = await this.d.storage.list<PushJob>({ prefix: LAB_OPEN_PUSH_JOB_PREFIX });
    let next = Infinity;
    let immediate = false;
    for (const job of jobs.values()) {
      if (!isJob(job) || job.exhausted) continue;
      if (job.leaseUntil > now) next = Math.min(next, job.leaseUntil);
      else if (job.due > now) next = Math.min(next, job.due);
      else immediate = true;
    }
    return immediate ? now : next;
  }

  async #devices(): Promise<StoredDevice[]> {
    const all = await this.d.storage.list<StoredDevice>({ prefix: LAB_OPEN_PUSH_SUB_PREFIX });
    return [...all.values()].filter(isDevice).sort((a, b) => a.at - b.at || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  }

  async #subscription(text: string | null, deviceId: string): Promise<PushSubscriptionRecord | null> {
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const sub = await parsePushSubscription(parsed);
    if (!sub || await digest(sub.endpoint) !== deviceId) return null;
    return sub;
  }

  async #owns(credentialId: string): Promise<boolean> {
    return (await this.d.credentialExists(credentialId)) === true;
  }

  async #scheduled(credentialId: string, deviceId: string): Promise<{ ok: true; deviceId: string } | LabOpenPushFail> {
    await this.d.schedule(this.#clock());
    if (!(await this.#owns(credentialId))) {
      await this.#dropDevice(deviceId);
      return fail(403, '등록된 보안 키가 없습니다.');
    }
    return { ok: true, deviceId };
  }

  #endpoint(endpoint: unknown): string | LabOpenPushFail {
    if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > PUSH_ENDPOINT_MAX || !isAllowedPushEndpoint(endpoint)) return fail(400, 'endpoint 가 올바르지 않습니다.');
    return endpoint;
  }

  #clock(): number {
    const t = this.d.now();
    return typeof t === 'number' && Number.isFinite(t) ? t : Number.NaN;
  }
}
