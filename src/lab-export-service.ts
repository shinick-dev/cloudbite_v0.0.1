// 내 작업 받기 (#11) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// State 하나에 하나씩 만들고, 저장소·자리 확인·Daytona·알람 예약·감사 기록·시간/크기 상한은 State 가 넘겨 준 것만 쓴다 (만들 때 I/O 없음).
// 저장 키·흐름 설명은 state.ts 의 '내 작업 받기' 절.
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { download, dt, DtError, EXPORT_ID, exportStage, packWork, READY, removeStage, type Dt, type ExportLimits, type Sandbox } from './lab';
import type { Fail } from './state';
import type { FileTransfer } from './lab-file-receipt-service';

interface ExportLease {
  id: string; code: string; lab: string; sandboxId: string; at: number; exp: number;
  state: 'packing' | 'ready' | 'streaming';
  ticket?: string; // 한 번 쓰는 내려받기 표의 해시 (ready 에서만)
  size?: number;
  n?: number;
  sourceId?: string; // A preserved checkpoint: streaming cleanup must never remove it.
}
interface ExportClean { sandboxId: string; tries: number; next: number }
export const EXPORT_COOLDOWN = 60e3;
export const EXPORT_TICKET_TTL = 60e3;
export const EXPORT_STREAM_MAX = 30 * 60e3;
const EXPORT_CLEAN_TRIES = 5;

// state.ts 의 같은 이름 도우미와 똑같다 (state.ts 를 런타임에 들여오지 않으려고 따로 둔다)
const now = () => Date.now();
const rand = (n: number) => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(n)));
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 묶기가 알린 zip 크기가 표를 줄 만한가 (안전한 정수·0 이상·상한 이하). 상한은 앞 검사를 통과했을 때만 읽는다 */
const zipSizeOk = (size: number, d: Pick<LabExportDeps, 'zipMax'>) => Number.isSafeInteger(size) && size >= 0 && size <= d.zipMax();
async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return isoBase64URL.fromBuffer(new Uint8Array(d));
}

/** 이 서비스가 보는 수업·자리 필드 (State 의 Lab·Seat 이 그대로 맞는다) */
interface ExpLab { id: string; name: string }
interface ExpSeat { n: number; sid?: string; sandboxId: string }
export interface CheckpointArchive { id: string; labId: string; n: number; code: string; sandboxId: string; entries: number; bytes: number; skipped: number; size: number }

/** State 가 넘겨 주는 것. 콜백은 State 의 메서드를 그대로 부른다 (receiver 는 State — fixture 가 바꾼 상한·Daytona 도 그대로) */
export interface LabExportDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  waitUntil(p: Promise<unknown>): void;
  seatOf(code: string): Promise<{ lab: ExpLab; seat: ExpSeat } | Fail>;
  daytona(): Promise<Dt | Fail>;
  schedule(t: number): Promise<void>;
  audit(event: string, sid: string | null, ip: string | null, detail?: string): Promise<void>;
  ttl(): { ticket: number; stream: number; pack: number; cooldown: number };
  limits(): ExportLimits;
  zipMax(): number;
  checkpoint?(code: string, id: string): Promise<CheckpointArchive | Fail>;
  perform?<T>(code: string, sandboxId: string, effect: () => Promise<T>): Promise<T>;
  transferred?(item: FileTransfer): Promise<void>;
}

export class LabExportService {
  private aborts = new Map<string, AbortController>();
  private ending = new Set<string>(); // 같은 받기를 둘이 함께 끝내지 않게 (스트림 끝 + 주인 없는 기록 정리·알람이 겹칠 때)
  private cleaning = new Set<string>();
  constructor(private d: LabExportDeps) {}
  private get s() { return this.d.storage; }

  /** 이 자리에 진행 중인 받기가 있는가. 주인 없는 streaming 기록은 정리(한 번)하고 없다고 본다 (살아 있는 받기는 건드리지 않음) */
  private async busy(code: string) {
    const l = await this.s.get<ExportLease>(`exp:${code}`);
    if (!l) return false;
    if (l.state !== 'streaming' || this.aborts.has(l.id)) return true;
    await this.end(code, l.id, 'orphan');
    return !!(await this.s.get<ExportLease>(`exp:${code}`)); // 다른 쪽이 끝내는 중이면 아직 남아 있다 → 409
  }

  async start(code: string, checkpointId?: unknown) {
    const got = await this.d.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    if (checkpointId !== undefined && (typeof checkpointId !== 'string' || !EXPORT_ID.test(checkpointId))) return fail(400, '체크포인트를 다시 선택하세요.');
    const T = this.d.ttl();
    if (await this.busy(code)) return fail(409, '이미 묶는 중이거나 받는 중입니다. 끝난 뒤 다시 누르세요.');
    const last = (await this.s.get<number>(`expcd:${code}`)) ?? 0;
    if (now() - last < T.cooldown) return fail(429, `조금 전에 받았습니다. ${Math.ceil((last + T.cooldown - now()) / 1000)}초 뒤에 다시 누르세요.`);
    const c = await this.d.daytona();
    if (isFail(c)) return c;
    let sb: Sandbox;
    try { sb = await dt<Sandbox>(c, 'GET', `/sandbox/${seat.sandboxId}`); }
    catch (e) { return fail(502, errText(e)); }
    if (!READY.has(sb.state)) return fail(409, '실습실이 켜져 있지 않습니다. 새로고침해서 다시 연 뒤 받으세요.');
    const source = typeof checkpointId === 'string' ? await this.d.checkpoint?.(code, checkpointId) : undefined;
    if (isFail(source)) return source;
    if (checkpointId !== undefined && (!source || source.id !== checkpointId || source.labId !== lab.id || source.n !== seat.n || source.code !== code || source.sandboxId !== seat.sandboxId || !zipSizeOk(source.size, this.d))) return fail(409, '현재 자리의 체크포인트를 확인하지 못했습니다.');
    // 샌드박스를 건드리기 전에 기록 (재시작·시간 초과면 알람이 이 id 의 폴더를 지운다). 위에서 확인한 뒤 SFU·Daytona 를 부르기 전이라 다른 요청이 못 끼었다
    if (await this.busy(code)) return fail(409, '이미 묶는 중이거나 받는 중입니다. 끝난 뒤 다시 누르세요.');
    if (now() - ((await this.s.get<number>(`expcd:${code}`)) ?? 0) < T.cooldown) return fail(429, '조금 전에 받았습니다. 잠시 뒤에 다시 누르세요.');
    const id = crypto.randomUUID();
    const lease: ExportLease = { id, code, lab: lab.id, n: seat.n, sandboxId: seat.sandboxId, at: now(), exp: now() + T.pack, state: 'packing', ...(source ? { sourceId: source.id } : {}) };
    await this.s.put({ [`exp:${code}`]: lease, [`expcd:${code}`]: lease.at });
    await this.d.schedule(lease.exp);
    let packed: Awaited<ReturnType<typeof packWork>>;
    try {
      packed = source ? { ...source, path: `${exportStage(source.id)}/work.zip` } : await packWork(c, sb, id, this.d.limits(), this.d.perform ? effect => this.d.perform!(code, seat.sandboxId, effect) : undefined);
    }
    catch (e) {
      await this.end(code, id, 'error');
      return fail(502, errText(e));
    }
    const cur = await this.s.get<ExportLease>(`exp:${code}`);
    if (cur?.id !== id) return fail(410, '받기가 취소됐습니다 (수업이 끝났거나 시간이 지남).'); // 지운 쪽이 폴더도 지웠다
    if (!zipSizeOk(packed.size, this.d)) {
      await this.end(code, id, 'error');
      return fail(502, '묶기 실패: 묶은 파일 크기가 한도를 넘습니다.');
    }
    const ticket = rand(18);
    await this.s.put(`exp:${code}`, { ...cur, state: 'ready', ticket: await sha(ticket), exp: now() + T.ticket, size: packed.size } satisfies ExportLease);
    await this.d.schedule(now() + T.ticket);
    await this.d.audit('lab-export', seat.sid ?? null, null, `${lab.name} ${seat.n}번 ${packed.entries}개 ${packed.bytes}B${packed.skipped ? ` 건너뜀 ${packed.skipped}` : ''}`);
    return { ticket, receiptId: id, name: `lab-${seat.n}-${source ? 'checkpoint' : 'work'}.zip`, size: packed.size, entries: packed.entries, skipped: packed.skipped };
  }

  /** 한 번 쓰는 표로 내려받기. 표는 쓰는 순간 지운다 */
  async download(code: string, ticket: string): Promise<Response> {
    const err = (status: number, msg: string) => new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    const gone = () => err(410, '내려받기 표가 없거나 이미 썼습니다. ⬇ 내 작업 받기를 다시 누르세요.');
    // 표 형식·해시는 기록을 읽기 전에. 읽기 → 비교 → streaming 쓰기 사이에는 저장소 호출만 (입력 게이트가 닫혀 같은 표로 두 요청이 함께 ready 를 못 본다)
    if (typeof ticket !== 'string' || !/^[\w-]{24}$/.test(ticket)) return gone();
    const th = await sha(ticket);
    const got = await this.d.seatOf(code);
    if (isFail(got)) return err(got.status, got.error);
    const lease = await this.s.get<ExportLease>(`exp:${code}`);
    if (!lease || lease.state !== 'ready' || !lease.ticket || th !== lease.ticket) return gone();
    if (got.lab.id !== lease.lab || got.seat.sandboxId !== lease.sandboxId || lease.sourceId !== undefined && !EXPORT_ID.test(lease.sourceId)) return gone();
    if (lease.exp <= now()) { await this.end(code, lease.id, 'expire'); return err(410, '내려받기 표가 만료됐습니다. 다시 누르세요.'); }
    const T = this.d.ttl();
    const streaming: ExportLease = { ...lease, state: 'streaming', ticket: undefined, exp: now() + T.stream };
    const ac = new AbortController();
    this.aborts.set(lease.id, ac); // 기록보다 먼저 — 이 인스턴스에서 산 받기 (busy 가 주인 없는 기록으로 보지 않게)
    await this.s.put(`exp:${code}`, streaming);
    await this.d.schedule(streaming.exp);
    // 바이트 상한: 묶을 때 알린 zip 크기와 설정 상한 중 작은 것. 묶은 뒤 work.zip 이 바뀌어도(큰 sparse 파일·링크) 이만큼만, 헤더를 믿지 않고 센다
    const cap = Math.min(lease.size ?? Infinity, this.d.zipMax());
    const failDl = async (why: string, msg: string) => {
      await this.end(code, lease.id, why);
      this.aborts.delete(lease.id);
      return err(502, `받지 못했습니다: ${msg}`);
    };
    let r: Response;
    try {
      const c = await this.d.daytona();
      if (isFail(c)) throw new Error(c.error);
      const sb = await dt<Sandbox>(c, 'GET', `/sandbox/${lease.sandboxId}`);
      const effect = () => download(c, sb, `${exportStage(lease.sourceId ?? lease.id)}/work.zip`, ac.signal);
      r = this.d.perform ? await this.d.perform(code, lease.sandboxId, effect) : await effect();
    } catch (e) {
      return await failDl('error', errText(e));
    }
    const cl = r.headers.get('content-length');
    if (cl !== null && !(Number(cl) <= cap)) {
      ac.abort(new Error('export too big'));
      await r.body?.cancel().catch(() => {});
      return await failDl('too-big', '묶은 파일이 한도보다 큽니다.');
    }
    const reader = r.body!.getReader();
    let over = false, n = 0;
    // 끝내기는 end 한 번 (aborts 는 end 가 지운다 — 끝나는 중에도 산 받기로 보이게)
    const end = (why: string) => {
      if (over) return;
      over = true;
      this.d.waitUntil((async () => {
        if (why === 'ok' && typeof lease.n === 'number') await this.d.transferred?.({ id: lease.id, startedAt: lease.at, labId: lease.lab, n: lease.n, code, sandboxId: lease.sandboxId, ...(lease.sourceId ? { checkpointId: lease.sourceId } : {}) }).catch(() => {});
        await this.end(code, lease.id, why);
      })());
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (lease.size !== undefined && n !== lease.size) { end('short'); ctl.error(new Error('export size mismatch')); return; }
            end('ok'); ctl.close(); return;
          }
          n += value.byteLength;
          if (n > cap) {
            ac.abort(new Error('export too big'));
            reader.cancel().catch(() => {});
            end('too-big');
            ctl.error(new Error('export too big'));
            return;
          }
          ctl.enqueue(value);
        } catch (e) { end('error'); ctl.error(e); }
      },
      async cancel(reason) {
        ac.abort(new Error('downstream cancelled'));
        await reader.cancel(reason).catch(() => {});
        end('cancel');
      },
    });
    // x-export-size: 자리 호스트(labhost)가 이 길이로 Content-Length 를 붙인다 — 상한·크기 불일치로 중간에 끊긴 받기를 브라우저가 완료로 보지 않게
    return new Response(body, { headers: {
      ...(lease.size !== undefined ? { 'x-export-size': String(lease.size) } : {}),
      'content-type': 'application/zip', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="lab-${got.seat.n}-work.zip"`,
    } });
  }

  /** 받기 하나를 끝낸다: 기록을 지운 쪽만 폴더를 지운다 (한 번). 지우기가 실패하면 expq 로 남겨 알람이 다시 */
  private async end(code: string, id: string, why: string) {
    if (this.ending.has(id)) return false;
    this.ending.add(id);
    try {
      const lease = await this.s.get<ExportLease>(`exp:${code}`);
      if (!lease || lease.id !== id) return false;
      this.aborts.get(id)?.abort(new Error(`export ${why}`));
      this.aborts.delete(id);
      await this.s.delete(`exp:${code}`);
      if (lease.sourceId) return true; // Archive remains available until the class ends.
      await this.s.put(`expq:${id}`, { sandboxId: lease.sandboxId, tries: 0, next: now() + 60e3 } satisfies ExportClean);
    } finally { this.ending.delete(id); }
    await this.clean(id);
    return true;
  }

  private async clean(id: string) {
    if (this.cleaning.has(id)) return;
    const q = await this.s.get<ExportClean>(`expq:${id}`);
    if (!q) return;
    this.cleaning.add(id);
    try {
      await this.s.put(`expq:${id}`, { ...q, next: now() + 60e3 }); // 도는 동안 알람이 같은 것을 또 집지 않게
      let ok = false;
      const c = await this.d.daytona();
      if (!isFail(c)) {
        try {
          const sb = await dt<Sandbox>(c, 'GET', `/sandbox/${q.sandboxId}`);
          await removeStage(c, sb, id);
          ok = true;
        } catch (e) { if (e instanceof DtError && e.status === 404) ok = true; } // 샌드박스가 없으면 폴더도 없다
      }
      if (ok || q.tries + 1 >= EXPORT_CLEAN_TRIES) {
        await this.s.delete(`expq:${id}`);
        if (!ok) await this.d.audit('lab-export-clean-fail', null, null, id);
      } else {
        const next = now() + 60e3;
        await this.s.put(`expq:${id}`, { ...q, tries: q.tries + 1, next } satisfies ExportClean);
        await this.d.schedule(next);
      }
    } finally { this.cleaning.delete(id); }
  }

  /** 끝내기·만료: 자리마다 받는 중이면 끊고 묶은 폴더 지우기를 남긴다 (샌드박스가 지워졌으면 404 → 끝). 그다음 시작 사이 기록을 지운다 */
  async clear(codes: string[], why: string) {
    for (const code of codes) {
      const l = await this.s.get<ExportLease>(`exp:${code}`);
      if (l) await this.end(code, l.id, why);
    }
    await this.s.delete(codes.map((code) => `expcd:${code}`));
  }

  /** 알람: 시간이 지난 받기(묶기·표·받기)를 끝내고, 못 지운 묶은 폴더를 다시 지운다 (재시작으로 끊긴 받기도 여기서). 다음 시각을 돌려준다 */
  async alarm(t: number) {
    let next = Infinity;
    for (const [k, l] of await this.s.list<ExportLease>({ prefix: 'exp:' })) {
      if (l.exp <= t) await this.end(k.slice(4), l.id, 'expire');
      else next = Math.min(next, l.exp);
    }
    for (const [k, q] of await this.s.list<ExportClean>({ prefix: 'expq:' })) {
      if (q.next <= t) await this.clean(k.slice(5));
      else next = Math.min(next, q.next);
    }
    return next;
  }
}
