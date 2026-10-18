// A completed HTTP transfer and a person's ZIP inspection are distinct records.
// No claim is made that bytes were saved to a local disk or include later edits.
import type { Fail } from './state';

export interface FileRef { labId: string; n: number; code: string; sandboxId: string }
export interface FileTransfer extends FileRef { id: string; startedAt: number; checkpointId?: string }
interface Receipt extends FileTransfer { transferredAt: number; verifiedAt: number | null }
export interface FileReceiptView { id: string; at: number; verifiedAt: number | null; checkpoint: boolean }
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'transaction'>;
  now(): number;
  ref(code: string): Promise<FileRef | Fail>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'error' in x;
const same = (a: FileRef, b: FileRef) => a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId;
export const fileReceiptKey = (code: string) => `labfiles:${code}:receipt`;
const view = (r: Receipt): FileReceiptView => ({ id: r.id, at: r.transferredAt, verifiedAt: r.verifiedAt, checkpoint: !!r.checkpointId });
const valid = (r: Receipt | undefined, ref: FileRef, now: number): r is Receipt => !!r && same(r, ref) && UUID.test(r.id)
  && Number.isFinite(r.startedAt) && r.startedAt >= 0 && r.startedAt <= r.transferredAt
  && Number.isFinite(r.transferredAt) && r.transferredAt <= now
  && (r.verifiedAt === null || Number.isFinite(r.verifiedAt) && r.verifiedAt >= r.transferredAt && r.verifiedAt <= now);
export function verifiedFileReceiptId(row: unknown, ref: FileRef, now: number): string | null {
  const r = row as Receipt | undefined;
  return valid(r, ref, now) && r.verifiedAt !== null ? r.id : null;
}

export class LabFileReceiptService {
  constructor(private d: Deps) {}
  /** Called only after the upstream stream provided exactly the announced bytes. */
  async transferred(item: FileTransfer): Promise<void> {
    if (!UUID.test(item.id) || item.checkpointId !== undefined && !UUID.test(item.checkpointId) || !Number.isFinite(item.startedAt) || item.startedAt < 0 || item.startedAt > this.d.now()) return;
    await this.d.storage.transaction(async tx => {
      const old = await tx.get<Receipt>(fileReceiptKey(item.code)), current = await this.d.ref(item.code);
      if (isFail(current) || !same(current, item)) return;
      if (valid(old, current, this.d.now()) && (old.startedAt > item.startedAt || old.id === item.id)) return;
      const row: Receipt = { labId: item.labId, n: item.n, code: item.code, sandboxId: item.sandboxId,
        id: item.id, startedAt: item.startedAt, ...(item.checkpointId ? { checkpointId: item.checkpointId } : {}), transferredAt: this.d.now(), verifiedAt: null };
      await tx.put(fileReceiptKey(item.code), row);
    });
  }
  async read(code: string): Promise<{ transfer: FileReceiptView | null } | Fail> {
    try {
      const ref = await this.d.ref(code); if (isFail(ref)) return ref;
      const row = await this.d.storage.get<Receipt>(fileReceiptKey(code)), fresh = await this.d.ref(code);
      if (isFail(fresh)) return fresh;
      return { transfer: same(ref, fresh) && valid(row, fresh, this.d.now()) ? view(row) : null };
    } catch { return { status: 503, error: '파일 확인 기록을 읽지 못했습니다. 잠시 뒤 다시 확인하세요.' }; }
  }
  async acknowledge(code: string, id: unknown): Promise<{ transfer: FileReceiptView } | Fail> {
    if (typeof id !== 'string' || !UUID.test(id)) return { status: 400, error: '확인할 다운로드 기록을 선택하세요.' };
    try {
      return await this.d.storage.transaction(async tx => {
        const row = await tx.get<Receipt>(fileReceiptKey(code)), current = await this.d.ref(code);
        if (isFail(current)) return current;
        if (!valid(row, current, this.d.now()) || row.id !== id) return { status: 409, error: '다운로드 전송 기록을 아직 확인하지 못했거나 새 다운로드가 있습니다. 상태를 다시 확인하세요.' };
        if (row.verifiedAt === null) { row.verifiedAt = this.d.now(); await tx.put(fileReceiptKey(code), row); }
        return { transfer: view(row) };
      });
    } catch { return { status: 503, error: '파일 확인 기록을 저장하지 못했습니다. 같은 기록으로 다시 확인하세요.' }; }
  }
  async clear(codes: string[]) { if (codes.length) await this.d.storage.delete(codes.map(fileReceiptKey)); }
}
