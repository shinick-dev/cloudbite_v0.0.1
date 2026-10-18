// Independent 모임지기 sandbox. Claims precede provider effects; uncertain requests are never repeated.
import type { Fail } from './state';
import type { DemoFile } from './lab-demo-native';

export interface DemoRef {
  id: string; parentId: string; code: string; label: string; sandboxId?: string;
  expiresAt: number; ready: boolean; error?: string;
}
export interface DemoView {
  state: 'none' | 'creating' | 'ready' | 'unknown' | 'error';
  demoId?: string; message?: string; output?: string; requestId?: string;
}
interface DemoRecord {
  requestId: string; state: 'creating' | 'preparing' | 'ready' | 'unknown' | 'error';
  id?: string; at: number; commands: number; requestIds?: string[]; grantHash?: string;
}
interface CommandRecord { command: string; state: 'pending' | 'done' | 'unknown'; output?: string; sandboxId: string }
interface Grant { parentId: string; demoId: string; sandboxId: string; until: number }
export interface DemoDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  parent(id: string): Promise<boolean>;
  demo(id: string): Promise<DemoRef | undefined>;
  create(token: string, parentId: string, arm: (id: string) => Promise<void>): Promise<{ id: string } | { preparing: true } | Fail>;
  warm(ref: DemoRef): Promise<{ ready: boolean; message?: string } | Fail>;
  command(token: string, ref: DemoRef, command: string): Promise<string>;
  file?(token: string, ref: DemoRef, filename: string, save: { content: string; expectedHash: string } | null): Promise<DemoFile>;
  origin(label: string): string;
}
const fail = (status: number, error: string): Fail => ({ status, error });
const bad = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'error' in x;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[\w-]{1,100}$/;
export const demoKey = (id: string) => `labdemo:${id}`;
export const demoCommandKey = (id: string, rid: string) => `labdemocmd:${id}:${rid}`;
const grantKey = (hash: string) => `labdemogrant:${hash}`;
async function hash(s: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export class LabDemoService {
  #running = new Set<string>();
  constructor(private d: DemoDeps) {}
  async #auth(token: string, id: string) {
    if (!ID.test(id)) return fail(400, '모임 정보가 올바르지 않습니다.');
    if (!await this.d.checkAdmin(token)) return fail(401, '보안 키로 다시 확인하세요.');
    return await this.d.parent(id) ? null : fail(410, '모임이 끝났습니다.');
  }
  async #ref(id: string, r: DemoRecord) {
    const ref = r.id ? await this.d.demo(r.id) : undefined;
    return ref && ref.parentId === id && ref.expiresAt > this.d.now() ? ref : undefined;
  }
  async #view(id: string, r: DemoRecord | undefined): Promise<DemoView> {
    if (!r) return { state: 'none', message: '모임지기 전용 시연실을 아직 만들지 않았습니다.' };
    const ref = await this.#ref(id, r);
    if (ref?.error) return { state: 'error', demoId: ref.id, message: '시연실 준비 오류입니다. 모임 종료 시 자원을 함께 정리합니다.' };
    if (ref?.ready) return { state: 'ready', demoId: ref.id, message: '참여자와 분리된 모임지기 전용 실습실입니다.' };
    if (r.state === 'preparing') return { state: 'creating', message: '스냅샷을 준비하고 있습니다. 같은 만들기 요청으로 준비를 이어가세요.' };
    if (this.#running.has(id)) return { state: 'creating', demoId: r.id, message: '시연실을 준비하고 있습니다.' };
    return { state: r.state === 'error' ? 'error' : 'unknown', demoId: r.id, message: '시연실 준비 결과가 미확정입니다. 새로 만들지 말고 상태를 확인하세요.' };
  }
  async status(token: string, id: string): Promise<DemoView | Fail> {
    const a = await this.#auth(token, id); if (a) return a;
    const record = await this.d.storage.get<DemoRecord>(demoKey(id));
    const r = await this.#view(id, record);
    return await this.#auth(token, id) ?? { ...r, ...(record ? {requestId:record.requestId} : {}) };
  }
  async prepare(token: string, id: string, requestId: unknown): Promise<DemoView | Fail> {
    const a = await this.#auth(token, id); if (a) return a;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, '시연실 요청 ID가 올바르지 않습니다.');
    const key = demoKey(id);
    const claim = await this.d.storage.transaction(async tx => {
      const auth = await this.#auth(token, id); if (auth) return auth;
      const prior = await tx.get<DemoRecord>(key);
      if (prior && ((!['preparing', 'error'].includes(prior.state) || !!prior.id) || this.#running.has(id))) return { run: false as const, record: prior };
      if (prior && prior.requestId !== requestId) return fail(409, '기존 시연실 만들기 요청을 먼저 확인하세요.');
      const record: DemoRecord = prior ?? { requestId, state: 'creating', at: this.d.now(), commands: 0 };
      record.state = 'creating';
      await tx.put(key, record);
      return { run: true as const, record };
    });
    if (bad(claim)) return claim;
    if (!claim.run) return this.status(token, id);
    this.#running.add(id);
    try {
      const r = await this.d.create(token, id, async demoId => {
        const auth = await this.#auth(token, id); if (auth) throw auth;
        await this.d.storage.put(key, { ...claim.record, id: demoId });
      });
      const record = await this.d.storage.get<DemoRecord>(key);
      if (!record || record.requestId !== requestId) return fail(409, '시연실 기록이 바뀌었습니다.');
      record.state = bad(r) ? (record.id ? 'unknown' : 'error') : 'preparing' in r ? 'preparing' : 'ready';
      if (!bad(r) && 'id' in r) record.id = r.id;
      await this.d.storage.put(key, record);
      if (bad(r)) return r;
    } catch {
      const r = await this.d.storage.get<DemoRecord>(key);
      if (r) await this.d.storage.put(key, { ...r, state: 'unknown' });
      return fail(503, '시연실 만들기 결과가 미확정입니다. 상태 확인을 이용하세요.');
    } finally { this.#running.delete(id); }
    return this.status(token, id);
  }
  async send(token: string, id: string, rid: unknown, command: unknown): Promise<DemoView | Fail> {
    const a = await this.#auth(token, id); if (a) return a;
    if (typeof rid !== 'string' || !UUID.test(rid) || typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\x00-\x1f\x7f\u2028\u2029]/.test(command)) return fail(400, '한 줄 명령과 요청 ID를 확인하세요.');
    const key = demoCommandKey(id, rid);
    const claim = await this.d.storage.transaction(async tx => {
      const auth = await this.#auth(token, id); if (auth) return auth;
      const r = await tx.get<DemoRecord>(demoKey(id));
      const ref = r ? await this.#ref(id, r) : undefined;
      if (!r || !ref?.ready || !ref.sandboxId) return fail(409, '시연실 준비를 먼저 확인하세요.');
      const old = await tx.get<CommandRecord>(key);
      if (old) return old.command === command && old.sandboxId === ref.sandboxId ? { run: false as const, record: old, ref } : fail(409, '같은 요청 ID에 다른 명령이나 실습실을 쓸 수 없습니다.');
      if (r.commands >= 100) return fail(429, '이 모임의 시연 명령 한도에 도달했습니다. 전용 실습실 터미널을 이용하세요.');
      const record: CommandRecord = { command, sandboxId: ref.sandboxId, state: 'pending' };
      await tx.put({ [key]: record, [demoKey(id)]: { ...r, commands: r.commands + 1, requestIds: [...(r.requestIds ?? []), rid] } });
      return { run: true as const, record, ref };
    });
    if (bad(claim)) return claim;
    if (!claim.run) return await this.#auth(token, id) ?? { state: claim.record.state === 'done' ? 'ready' : 'unknown', demoId: claim.ref.id, output: claim.record.state === 'done' ? claim.record.output : '이 명령의 실행 결과가 미확정입니다. 같은 명령을 다시 실행하지 않았습니다.' };
    try {
      const auth = await this.#auth(token, id); if (auth) throw auth;
      const output = (await this.d.command(token, claim.ref, command)).slice(0, 12000);
      const current = await this.d.demo(claim.ref.id);
      if (!current || current.sandboxId !== claim.ref.sandboxId || current.parentId !== id) throw Error('changed');
      const auth2 = await this.#auth(token, id); if (auth2) throw auth2;
      await this.d.storage.put(key, { ...claim.record, state: 'done', output });
      return await this.#auth(token, id) ?? { state: 'ready', demoId: claim.ref.id, output };
    } catch {
      await this.d.storage.put(key, { ...claim.record, state: 'unknown' });
      return fail(503, '시연 명령의 결과가 미확정입니다. 실제 터미널에서 확인하세요. 다시 실행하지 않았습니다.');
    }
  }
  async open(token: string, id: string): Promise<{ url: string } | Fail> {
    const a = await this.#auth(token, id); if (a) return a;
    const r = await this.d.storage.get<DemoRecord>(demoKey(id));
    const ref = r ? await this.#ref(id, r) : undefined;
    if (!r || !ref?.ready || !ref.sandboxId) return fail(409, '시연실 준비를 먼저 확인하세요.');
    const tokenValue = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const digest = await hash(tokenValue);
    const auth = await this.#auth(token, id); if (auth) return auth;
    await this.d.storage.transaction(async tx => {
      const latest = await tx.get<DemoRecord>(demoKey(id));
      if (!latest || latest.id !== ref.id) throw Error('changed');
      if (latest.grantHash) await tx.delete(grantKey(latest.grantHash));
      await tx.put({ [demoKey(id)]: { ...latest, grantHash: digest }, [grantKey(digest)]: { parentId: id, demoId: ref.id, sandboxId: ref.sandboxId!, until: this.d.now() + 120000 } satisfies Grant });
    });
    return await this.#auth(token, id) ?? { url: this.d.origin(ref.label) + '/__lab/demo-open#' + tokenValue };
  }
  async claim(value: unknown, label: string): Promise<{ code: string; expiresAt: number } | { starting: true; message: string } | Fail> {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(400, '시연실 입장 정보가 올바르지 않습니다.');
    const digest = await hash(value), key = grantKey(digest);
    const grant = await this.d.storage.get<Grant>(key);
    const ref = grant ? await this.d.demo(grant.demoId) : undefined;
    if (!grant || grant.until <= this.d.now() || !ref || ref.label !== label || ref.parentId !== grant.parentId || ref.sandboxId !== grant.sandboxId || !await this.d.parent(grant.parentId)) return fail(410, '시연실 입장이 만료됐습니다. 모임지기 화면에서 다시 여세요.');
    const warm = await this.d.warm(ref);
    if (bad(warm)) return warm;
    if (!warm.ready) return { starting: true, message: warm.message ?? '시연실을 준비하는 중입니다.' };
    return this.d.storage.transaction(async tx => {
      const current = await tx.get<Grant>(key);
      const r = current ? await this.d.demo(current.demoId) : undefined;
      if (!current || current.until <= this.d.now() || !r?.ready || r.label !== label || r.sandboxId !== current.sandboxId || !await this.d.parent(current.parentId)) return fail(410, '시연실 입장이 만료됐습니다.');
      await tx.delete(key);
      return { code: r.code, expiresAt: r.expiresAt };
    });
  }
  async clear(id: string): Promise<string | undefined> {
    const record = await this.d.storage.get<DemoRecord>(demoKey(id));
    if (!record) return;
    for (const rid of record.requestIds ?? []) await this.d.storage.delete(demoCommandKey(id, rid));
    if (record.grantHash) await this.d.storage.delete(grantKey(record.grantHash));
    await this.d.storage.delete(demoKey(id));
    return record.id;
  }
  async file(token: string, id: string, filename: unknown, rid: unknown, content?: unknown, expectedHash?: unknown): Promise<{ file: DemoFile } | Fail> {
    const auth = await this.#auth(token, id); if (auth) return auth;
    if (typeof filename !== 'string' || !['결과.txt', '01_요청메모.txt', '02_진행메모.txt'].includes(filename) || !this.d.file) return fail(400, '시연 파일을 선택하세요.');
    const save = content !== undefined;
    if (save && (typeof rid !== 'string' || !UUID.test(rid) || typeof content !== 'string' || content.includes('\0') || new TextEncoder().encode(content).length > 65536 || typeof expectedHash !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(expectedHash))) return fail(400, '파일은 64KiB 이하 텍스트여야 합니다. 먼저 현재 파일을 읽으세요.');
    const record = await this.d.storage.get<DemoRecord>(demoKey(id));
    const ref = record ? await this.#ref(id, record) : undefined;
    if (!ref?.ready || !ref.sandboxId) return fail(409, '시연실 준비를 먼저 확인하세요.');
    let key = '', marker = '';
    if (save) {
      key = demoCommandKey(id, rid as string);
      marker = 'file-save:' + await hash(JSON.stringify({ filename, content, expectedHash }));
      const claim = await this.d.storage.transaction(async tx => {
        const a = await this.#auth(token, id); if (a) return a;
        const row = await tx.get<DemoRecord>(demoKey(id)), previous = await tx.get<CommandRecord>(key);
        if (!row || row.id !== ref.id) return fail(409, '시연실이 바뀌었습니다.');
        if (previous) return previous.command !== marker || previous.sandboxId !== ref.sandboxId ? fail(409, '같은 저장 ID에 다른 내용을 쓸 수 없습니다.') : previous.state === 'done' && previous.output ? previous.output : fail(409, '이 저장 결과가 미확정입니다. 다시 저장하지 말고 현재 파일을 읽어 대조하세요.');
        if (row.commands >= 100) return fail(429, '저장 요청 한도에 도달했습니다. 전용 실습실 편집기를 이용하세요.');
        await tx.put({ [key]: { command: marker, state: 'pending', sandboxId: ref.sandboxId! } satisfies CommandRecord, [demoKey(id)]: { ...row, commands: row.commands + 1, requestIds: [...(row.requestIds ?? []), rid as string] } });
        return true;
      });
      if (bad(claim)) return claim;
      if (typeof claim === 'string') {
        const current = await this.file(token, id, filename, undefined);
        if (bad(current)) return current;
        if (current.file.content !== content || current.file.hash !== claim) return fail(409, '이 저장 뒤 파일이 바뀌었습니다. 과거 저장을 현재 파일로 확인하지 않았습니다. 먼저 파일을 다시 읽으세요.');
        return current;
      }
    }
    try {
      const a = await this.#auth(token, id); if (a) throw a;
      const file = await this.d.file(token, ref, filename, save ? { content: content as string, expectedHash: expectedHash as string } : null);
      const latest = await this.#ref(id, record!);
      if (!latest?.ready || latest.sandboxId !== ref.sandboxId) throw Error('changed');
      const final = await this.#auth(token, id); if (final) throw final;
      if (save) await this.d.storage.put(key, { command: marker, state: 'done', sandboxId: ref.sandboxId, output: file.hash } satisfies CommandRecord);
      return await this.#auth(token, id) ?? { file };
    } catch {
      if (save) await this.d.storage.put(key, { command: marker, state: 'unknown', sandboxId: ref.sandboxId } satisfies CommandRecord);
      return fail(503, save ? '저장 결과가 미확정입니다. 입력은 남겨 두고 현재 파일을 다시 읽어 대조하세요.' : '파일을 읽지 못했습니다. 저장된 텍스트 파일인지 확인하고 다시 읽으세요.');
    }
  }
}
