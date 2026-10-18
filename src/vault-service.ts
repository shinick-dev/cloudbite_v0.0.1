// 금고 전부 (상태·탭 열기·키 잇기·항목·보내기·만들기·복구 코드·복구) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// 공개 RPC 는 State 의 같은 이름 메서드가 그대로 이리로 넘긴다. State 하나에 하나씩 만들고 (만들 때 I/O 없음),
// 저장소·blockConcurrencyWhile·관리 세션 확인·키 목록·탭 의식·관리 토큰·감사 기록은 State 가 넘겨 준 것만 쓴다 (인증 의식 자체는 State 에 남는다).
// 저장 키(vault:meta·vault:rcode·vwrap:·vitem:) 설명은 state.ts 맨 위 '금고' 절. 보내기는 req:<id> (승인 요청) 하나만 고친다.
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { ApprovalRequest, Cred, Fail } from './state';

export interface Sealed { iv: string; ct: string }
export interface VaultMeta {
  createdAt: number;
  rec: Sealed & { salt: string; iter: number; questions: string[]; verifier: string }; // verifier = sha(클라이언트가 만든 검증값)
  fails: number[];
}
export interface VWrap extends Sealed { credId: string; createdAt: number }
export interface VItem extends Sealed { id: string; policy: 'phone' | 'send'; updatedAt: number }
interface RecCode { hash: string; createdAt: number; fails: number[] }

const REC_MAX_FAILS = 5;      // 복구 코드 하나로 낼 수 있는 복구 답 오답 (24시간). 예전 전역 5회/24시간을 코드마다로 옮긴 것
const REC_WINDOW = 24 * 3600e3;
const RC_LEN = 24;            // 복구 코드 글자 수 (32자 알파벳 → 120비트). 4자씩 '-' 로 끊어 보여 준다
const ITEM_MAX = 64 * 1024;   // 항목 암호문 (보내기 상자도 같은 상한)
const ID16 = /^[\w-]{8,64}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32자, 헷갈리는 0/O/1/I 제외 (state.ts 의 shortCode 와 같은 알파벳)

// state.ts 의 같은 이름 도우미와 똑같다 (state.ts 를 런타임에 들여오지 않으려고 따로 둔다)
const now = () => Date.now();
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;
async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return isoBase64URL.fromBuffer(new Uint8Array(d));
}

/** 복구 코드: 4자씩 '-' 로 끊은 24자 */
function newRecoveryCode() {
  const s = Array.from(crypto.getRandomValues(new Uint8Array(RC_LEN)), (b) => CODE_ALPHABET[b % 32]).join('');
  return s.match(/.{4}/g)!.join('-');
}
/** 사람이 친 복구 코드 → 대문자 24자 (띄어쓰기·'-' 무시). 형식이 아니면 null */
function rcNorm(x: unknown) {
  if (typeof x !== 'string' || x.length > 64) return null;
  const s = x.toUpperCase().replace(/[\s-]/g, '');
  return s.length === RC_LEN && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}
const rcHash = (norm: string) => sha(`vault-rc-v1|${norm}`);

function recLimit(fails: number[]) {
  const recent = fails.filter((t) => t > now() - REC_WINDOW);
  return { left: Math.max(0, REC_MAX_FAILS - recent.length), unlockAt: recent.length ? Math.min(...recent) + REC_WINDOW : 0 };
}

function checkRec(rec: VaultMeta['rec']): VaultMeta['rec'] | string {
  if (!rec || typeof rec !== 'object') return '복구 정보가 없습니다.';
  const qs = Array.isArray(rec.questions) ? rec.questions.map((q) => String(q).trim().slice(0, 200)).filter(Boolean) : [];
  if (qs.length < 2 || qs.length > 10) return '복구 질문은 2~10개여야 합니다.';
  if (![rec.salt, rec.iv, rec.ct, rec.verifier].every((x) => typeof x === 'string' && x.length >= 16 && x.length < 512)) return '복구 정보 형식이 올바르지 않습니다.';
  if (!Number.isInteger(rec.iter) || rec.iter < 600_000) return 'PBKDF2 반복 횟수가 너무 적습니다.';
  return { salt: rec.salt, iter: rec.iter, questions: qs, iv: rec.iv, ct: rec.ct, verifier: rec.verifier };
}

/**
 * State 가 넘겨 주는 것. 콜백은 State 의 메서드를 그대로 부른다 (receiver 는 State). blockConcurrencyWhile 은 State 의 ctx 에 묶인 그것.
 * O = State.authOptions 의 결과 (vaultOptions 결과 타입을 그대로 두려고)
 */
export interface VaultDeps<O> {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  reqTtl: number; // state.ts 의 REQ_TTL — 보낸 상자를 빌린 PC 가 받아갈 시간
  checkAdmin(token: string): Promise<boolean>;
  freshWebAdmin(token: string): Promise<boolean>;
  creds(): Promise<Cred[]>;
  authOptions(purpose: 'vault', src: string, only: (c: Cred) => boolean): Promise<O>;
  verifyTap(purpose: 'vault', resp: AuthenticationResponseJSON): Promise<Cred | null>;
  newAdminToken(src: 'web'): Promise<{ token: string; expiresAt: number }>;
  audit(event: string, sid: string | null, ip: string | null, detail?: string): Promise<void>;
}

// 서버가 하는 일: 탭 검증 결과 확인, 암호문 보관·중계, 복구 답 검증값 비교와 횟수 제한, 복구 코드 해시 보관.
// 금고 키·평문·복구 코드 원문은 저장하지 않는다.
export class VaultService<O> {
  constructor(private d: VaultDeps<O>) {}
  private get s() { return this.d.storage; }

  async status() {
    const creds = await this.d.creds();
    const wraps = await this.s.list<VWrap>({ prefix: 'vwrap:' });
    return {
      initialized: !!(await this.s.get('vault:meta')),
      keys: creds.map((c) => ({ id: c.id, label: c.label, prf: !!c.prf, linked: wraps.has(`vwrap:${c.id}`) })),
    };
  }

  async options(credId: string | undefined, src: string) {
    return this.d.authOptions('vault', src, (c) => !!c.prf && (!credId || c.id === credId));
  }

  /** 탭 검증 → 관리 토큰 + 그 키의 감싼 금고 키 + 항목 암호문. 금고를 푸는 건 브라우저가 PRF 로 한다. */
  async open(resp: AuthenticationResponseJSON) {
    const cred = await this.d.verifyTap('vault', resp);
    if (!cred) return fail(401, '보안 키 확인에 실패했습니다.');
    const { token, expiresAt } = await this.d.newAdminToken('web');
    const meta = await this.s.get<VaultMeta>('vault:meta');
    await this.d.audit('vault-open', null, null, cred.label);
    // 복구 코드가 없는 예전 금고: 보안 키로 연 이 응답에 한 번만 실어 준다 (금고 화면이 보여 주고, 저장하지 않는다)
    const rc = meta ? await this.issueRecoveryCode(false) : undefined;
    return {
      token, expiresAt, credId: cred.id, initialized: !!meta,
      wrap: (await this.s.get<VWrap>(`vwrap:${cred.id}`)) ?? null,
      items: await this.items(),
      ...(rc ? { recoveryCode: rc } : {}),
    };
  }

  async init(token: string, credId: string, wrap: Sealed, rec: VaultMeta['rec']) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 다시 여세요.');
    const r = checkRec(rec);
    if (typeof r === 'string') return fail(400, r);
    r.verifier = await sha(r.verifier); // 검증값 원문은 저장하지 않는다
    const w = await this.checkWrap(credId, wrap);
    if (typeof w === 'string') return fail(400, w);
    // 새 금고는 복구 코드를 같이 만든다. 원문은 이 응답에만
    const code = newRecoveryCode();
    const rc: RecCode = { hash: await rcHash(rcNorm(code)!), createdAt: now(), fails: [] };
    const made = await this.d.blockConcurrencyWhile(async () => {
      if (await this.s.get('vault:meta')) return false;
      await this.s.put({ 'vault:meta': { createdAt: now(), rec: r, fails: [] } satisfies VaultMeta, [`vwrap:${credId}`]: w, 'vault:rcode': rc });
      return true;
    });
    if (!made) return fail(409, '금고가 이미 있습니다.');
    await this.d.audit('vault-init', null, null, `질문 ${r.questions.length}개 · 복구 코드 발급`);
    return { ok: true, recoveryCode: code };
  }

  /**
   * 복구 코드 발급. force=false 면 금고가 있고 코드가 아직 없을 때만 (동시에 로그인해도 한 응답만 받는다).
   * 원문은 돌려주기만 하고 저장하지 않는다 — 해시만 남긴다. 새 코드는 예전 코드와 그 오답 기록을 대신한다
   */
  async issueRecoveryCode(force: boolean) {
    const code = newRecoveryCode();
    const rc: RecCode = { hash: await rcHash(rcNorm(code)!), createdAt: now(), fails: [] };
    const ok = await this.d.blockConcurrencyWhile(async () => {
      if (!(await this.s.get('vault:meta'))) return false;
      if (!force && (await this.s.get('vault:rcode'))) return false;
      await this.s.put('vault:rcode', rc);
      return true;
    });
    if (!ok) return undefined;
    await this.d.audit('vault-rcode-issue', null, null, force ? '새로 받음' : '처음 발급');
    return code;
  }

  /** 복구 코드 새로 받기 (잃어버렸을 때). 키를 탭한 지 3분 안의 웹 세션만 — 예전 코드는 바로 무효 */
  async rotateRecoveryCode(token: string) {
    if (!(await this.d.freshWebAdmin(token))) return fail(401, '보안 키로 다시 연 뒤 3분 안에 하세요.');
    const rc = await this.issueRecoveryCode(true);
    if (!rc) return fail(409, '금고가 없습니다.');
    return { ok: true, recoveryCode: rc };
  }

  async link(token: string, credId: string, wrap: Sealed) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 다시 여세요.');
    const w = await this.checkWrap(credId, wrap);
    if (typeof w === 'string') return fail(400, w);
    await this.s.put(`vwrap:${credId}`, w);
    await this.d.audit('vault-link', null, null, credId.slice(0, 8));
    return { ok: true };
  }

  async setRecovery(token: string, rec: VaultMeta['rec']) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 다시 여세요.');
    const meta = await this.s.get<VaultMeta>('vault:meta');
    if (!meta) return fail(409, '금고가 없습니다.');
    const r = checkRec(rec);
    if (typeof r === 'string') return fail(400, r);
    r.verifier = await sha(r.verifier); // 검증값 원문은 저장하지 않는다
    await this.d.blockConcurrencyWhile(async () => {
      const rc = await this.s.get<RecCode>('vault:rcode');
      await this.s.put({ 'vault:meta': { ...meta, rec: r, fails: [] } satisfies VaultMeta, ...(rc ? { 'vault:rcode': { ...rc, fails: [] } } : {}) });
    });
    await this.d.audit('vault-recovery-set', null, null, `질문 ${r.questions.length}개`);
    return { ok: true };
  }

  async putItem(token: string, item: { id?: unknown; iv?: unknown; ct?: unknown; policy?: unknown }) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 다시 여세요.');
    if (!(await this.s.get('vault:meta'))) return fail(409, '금고가 없습니다.');
    const id = String(item.id ?? '');
    if (!ID16.test(id) || typeof item.iv !== 'string' || typeof item.ct !== 'string') return fail(400, '형식이 올바르지 않습니다.');
    if (item.ct.length > ITEM_MAX) return fail(413, '항목이 너무 큽니다.');
    const exists = await this.s.get(`vitem:${id}`);
    if (!exists && (await this.s.list({ prefix: 'vitem:' })).size >= 500) return fail(409, '항목은 500개까지입니다.');
    const v: VItem = { id, iv: item.iv, ct: item.ct, policy: item.policy === 'send' ? 'send' : 'phone', updatedAt: now() };
    await this.s.put(`vitem:${id}`, v);
    await this.d.audit(exists ? 'vault-item-update' : 'vault-item-add', null, null, id.slice(0, 6));
    return { ok: true, item: v };
  }

  async deleteItem(token: string, id: string) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 다시 여세요.');
    if (!(await this.s.delete(`vitem:${id}`))) return fail(404, '없는 항목입니다.');
    await this.d.audit('vault-item-delete', null, null, id.slice(0, 6));
    return { ok: true };
  }

  /** 금고에서 고른 항목을 빌린 PC 공개키로 암호화한 것을 전달. 서버는 중계만 한다 (평문·금고 키 없음). */
  async sendDeliver(token: string, id: string, itemId: string, box: { epk?: unknown; iv?: unknown; ct?: unknown }) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '세션이 만료됐습니다. 금고를 다시 여세요.');
    const r = await this.s.get<ApprovalRequest>(`req:${id}`);
    if (!r || r.kind !== 'send' || r.expiresAt <= now() || r.status !== 'pending') return fail(409, '보낼 수 없는 요청입니다 (만료·처리됨).');
    const item = await this.s.get<VItem>(`vitem:${itemId}`);
    if (!item) return fail(404, '없는 항목입니다.');
    if (item.policy !== 'send') return fail(403, '"폰에서만 보기" 항목은 보낼 수 없습니다.');
    if (![box.epk, box.iv, box.ct].every((x) => typeof x === 'string') || String(box.ct).length > ITEM_MAX) return fail(400, '형식이 올바르지 않습니다.');
    r.status = 'approved';
    r.delivery = { kind: 'send', epk: String(box.epk), iv: String(box.iv), ct: String(box.ct) };
    r.expiresAt = now() + this.d.reqTtl;
    await this.s.put(`req:${id}`, r);
    await this.d.audit('vault-send', null, r.ip, `${itemId.slice(0, 6)} → ${[r.city, r.country].filter(Boolean).join(', ')}`);
    return { ok: true };
  }

  /** 복구 화면용. 질문과 KDF 파라미터, 지금 복구 코드의 남은 시도만 — 답·코드를 검증할 수 있는 건 주지 않는다. */
  async recoverInfo() {
    const meta = await this.s.get<VaultMeta>('vault:meta');
    if (!meta) return fail(404, '금고가 없습니다.');
    const rc = await this.s.get<RecCode>('vault:rcode');
    return { questions: meta.rec.questions, salt: meta.rec.salt, iter: meta.rec.iter, codeRequired: true, hasCode: !!rc, ...recLimit(rc?.fails ?? []) };
  }

  /**
   * 복구 = 복구 코드(소유자 능력) + 복구 답. 코드가 틀리거나 없으면 아무것도 쓰지 않고 거부한다 (소유자의 시도 횟수를 못 깎는다).
   * 코드가 맞으면 그 코드의 오답 예산(REC_MAX_FAILS / 24시간)을 확인·차감·검증·성공 처리까지 다른 요청 없이 한 덩어리로 한다 —
   * 동시에 보내도 예산을 넘지 못하고, 같은 코드로 두 번 성공하지 못한다. 성공하면 코드를 바로 바꿔 새 코드를 이 응답에만 싣는다
   * (예전 코드는 무효, 예산도 새 코드로 새로 시작). 오답으로 깎인 예산은 돌려주지 않는다.
   */
  async recover(code: unknown, verifier: unknown, ip: string) {
    const n = rcNorm(code);
    const vh = typeof verifier === 'string' && verifier.length >= 16 && verifier.length < 512 ? await sha(verifier) : '';
    const ch = n ? await rcHash(n) : '';
    const next = newRecoveryCode();
    const nextRc: RecCode = { hash: await rcHash(rcNorm(next)!), createdAt: now(), fails: [] };
    const r = await this.d.blockConcurrencyWhile(() => this.recoverStep(ch, vh, nextRc));
    if (isFail(r)) return r;
    if ('wrong' in r) {
      await this.d.audit('vault-recover-fail', null, ip);
      return fail(403, `답이 틀렸습니다. 이 복구 코드로 남은 시도 ${r.wrong}회 (24시간)`);
    }
    await this.d.audit('vault-recover', null, ip, '복구 코드 바뀜');
    return { wrap: { iv: r.ok.rec.iv, ct: r.ok.rec.ct }, items: await this.items(), recoveryCode: next };
  }

  /** recover 의 한 덩어리 (blockConcurrencyWhile 안): 코드 확인 → 예산 확인 → 답 확인 → 오답 기록 또는 코드 바꾸기 */
  private async recoverStep(ch: string, vh: string, nextRc: RecCode): Promise<Fail | { wrong: number } | { ok: VaultMeta }> {
    const meta = await this.s.get<VaultMeta>('vault:meta');
    if (!meta) return fail(404, '금고가 없습니다.');
    const rc = await this.s.get<RecCode>('vault:rcode');
    if (!rc) return fail(403, '복구 코드가 아직 없습니다. 보안 키로 금고를 한 번 열면 발급됩니다.');
    if (!ch || ch !== rc.hash) return fail(403, '복구 코드가 틀렸습니다.');
    const lim = recLimit(rc.fails);
    if (lim.left <= 0) return fail(429, `이 복구 코드로 오답이 많아 잠겼습니다. ${new Date(lim.unlockAt).toISOString()} 이후 다시 시도하세요.`);
    if (!vh || vh !== meta.rec.verifier) {
      await this.s.put('vault:rcode', { ...rc, fails: [...rc.fails.filter((t) => t > now() - REC_WINDOW), now()] } satisfies RecCode);
      return { wrong: lim.left - 1 };
    }
    nextRc.createdAt = now();
    await this.s.put('vault:rcode', nextRc);
    return { ok: meta };
  }

  private async items() { return [...(await this.s.list<VItem>({ prefix: 'vitem:' })).values()]; }

  private async checkWrap(credId: string, wrap: Sealed): Promise<VWrap | string> {
    const cred = await this.s.get<Cred>(`cred:${credId}`);
    if (!cred?.prf) return 'PRF 로 등록된 키가 아닙니다.';
    if (typeof wrap?.iv !== 'string' || typeof wrap?.ct !== 'string' || wrap.ct.length > 512) return '형식이 올바르지 않습니다.';
    return { credId, iv: wrap.iv, ct: wrap.ct, createdAt: now() };
  }
}
