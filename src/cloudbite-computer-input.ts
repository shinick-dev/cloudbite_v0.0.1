// CloudBite personal computer phone keyboard: the owner types locally on the phone, Send transfers the text to the
// focused remote input through the Daytona computer-use keyboard REST API (never a shell command).
// Verified against the local Daytona SDK 0.214 (daytona/_sync/computer_use.py + daytona_toolbox_api_client):
//   Keyboard.type(text)    -> POST {toolboxProxyUrl}/{sandboxId}/computeruse/keyboard/type  {"text": text}
//   Keyboard.press("enter")-> POST {toolboxProxyUrl}/{sandboxId}/computeruse/keyboard/key   {"key":"enter","modifiers":[]}
//   Sandbox lookup         -> GET  {api}/sandbox/{sandboxIdOrName}; missing toolboxProxyUrl -> GET {api}/sandbox/{id}/toolbox-proxy-url
// Toolbox calls carry the same Bearer header as the control plane (SDK copies default_headers).
// Root owns the HTTP route (desktop cookie + exact gateway Origin) and passes a trusted ComputerMachineRef from
// computer.computerMachine(ownerTag); the HTTP client never chooses the sandbox or the account.
// Ledger: requestId -> HMAC(target id/account/text/enter), phase, time, fixed error code. The text itself (possibly a
// password) is never stored, logged or returned. Anything that may have typed without confirmation is delivery_unknown
// and is never typed again automatically.
import { DurableObject } from 'cloudflare:workers';
import { COMPUTER_REQUEST_ID, computerAccounts, type ComputerEnv, type ComputerMachineRef } from './cloudbite-computer-contract';

export const COMPUTER_INPUT_PATH = '/p/_cloudbite/computer/desktop/_cloudbite-input';
export const INPUT_MAX_CHARS = 4000;
export const INPUT_MAX_BYTES = 16 * 1024;
export const INPUT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Bounded ledger: enough for a day of normal phone chat, while every exact replay record survives the full window.
export const INPUT_WINDOW_OPS = 4096;
export const INPUT_FETCH_MS = 20_000;
const TOOLBOX_HOSTS = ['.daytona.io', '.daytonaproxy01.net'];

export const INPUT_ERRORS = {
  bad_request: 'The input is not valid.',
  request_conflict: 'This request id was already used for different input.',
  not_configured: 'That Daytona account is not configured.',
  not_running: 'The computer is not running.',
  target_mismatch: 'The computer could not be verified. Nothing was typed.',
  delivery_unknown: 'Daytona did not confirm the input. Check the screen before sending again.',
  unsupported_text: 'This input path cannot reliably send emoji or supplementary Unicode characters. Remove them before sending.',
  input_rejected: 'Daytona refused the input. Nothing was confirmed as typed.',
  rate_limited: 'Too many inputs were sent recently. Try again later.',
  provider_error: 'Daytona could not be reached. Nothing was typed.',
} as const;
export type InputErrorCode = keyof typeof INPUT_ERRORS;
const INPUT_STATUS: Record<InputErrorCode, number> = {
  bad_request: 400, request_conflict: 409, not_configured: 409, not_running: 409, target_mismatch: 409,
  delivery_unknown: 409, unsupported_text: 422, input_rejected: 422, rate_limited: 429, provider_error: 502,
};

export type InputResult = { ok: true; outcome: 'sent'; replay: boolean } | { error: { code: InputErrorCode; message: string }; status: number };
export const inputError = (code: InputErrorCode): InputResult => ({ error: { code, message: INPUT_ERRORS[code] }, status: INPUT_STATUS[code] });

export type InputPhase = 'sending' | 'sent' | 'unknown' | 'rejected';
export interface InputLedgerEntry { h: string; phase: InputPhase; at: number; error: InputErrorCode | null }
export interface InputStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export type InputTransport = (url: string, init: RequestInit) => Promise<Response>;
const LEDGER = 'input:';

/** Strict body check: UUID requestId, optional text (no NUL, no lone surrogate, bounded), optional boolean enter. */
export function parseInput(input: { requestId?: unknown; text?: unknown; enter?: unknown }): { requestId: string; text: string; enter: boolean } | null {
  if (!input || typeof input !== 'object') return null;
  const { requestId, text = '', enter = false } = input;
  if (typeof requestId !== 'string' || !COMPUTER_REQUEST_ID.test(requestId)) return null;
  if (typeof text !== 'string' || typeof enter !== 'boolean') return null;
  if (text.length > INPUT_MAX_CHARS || text.includes('\0')) return null;
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return null;
  if (new TextEncoder().encode(text).length > INPUT_MAX_BYTES) return null;
  if (!text && !enter) return null;
  return { requestId: requestId.toLowerCase(), text, enter };
}

/** https only, no userinfo/query/fragment, Daytona-owned host. Returns the base without a trailing slash. */
export function toolboxBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) return null;
  if (!TOOLBOX_HOSTS.some((s) => host.endsWith(s))) return null;
  return u.href.replace(/\/+$/, '');
}

const validTarget = (t: ComputerMachineRef | null | undefined): t is ComputerMachineRef =>
  !!t && typeof t.id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(t.id) && typeof t.name === 'string' && !!t.name &&
  typeof t.account === 'string' && !!t.labels && typeof t.labels === 'object' && Object.keys(t.labels).length > 0;

async function hmac(key: string, parts: unknown[]): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(`cloudbite-computer-input-v1:${key}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const d = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(JSON.stringify(parts))));
  return [...d].map((v) => v.toString(16).padStart(2, '0')).join('');
}

type Call = { kind: 'ok' } | { kind: 'rejected' } | { kind: 'unknown' };

export class ComputerInputService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private storage: InputStorage, private env: ComputerEnv, private transport: InputTransport = (u, i) => fetch(u, i), private now = () => Date.now()) {}

  /** Batches run one at a time per owner object, so an in-memory 'sending' can only be a crashed predecessor. */
  send(target: ComputerMachineRef, input: { requestId?: unknown; text?: unknown; enter?: unknown }): Promise<InputResult> {
    const run = this.chain.then(() => this.sendNow(target, input), () => this.sendNow(target, input));
    this.chain = run.catch(() => undefined);
    return run.catch(() => inputError('delivery_unknown'));
  }

  private async sendNow(target: ComputerMachineRef, raw: { requestId?: unknown; text?: unknown; enter?: unknown }): Promise<InputResult> {
    const input = parseInput(raw);
    if (!input) return inputError('bad_request');
    if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(input.text)) return inputError('unsupported_text');
    if (!validTarget(target)) return inputError('target_mismatch');
    const account = computerAccounts(this.env).find((a) => a.id === target.account);
    if (!account) return inputError('not_configured');
    const h = await hmac(account.key, [target.id, target.account, input.text, input.enter]);
    const key = LEDGER + input.requestId;
    const prior = await this.storage.get<InputLedgerEntry>(key);
    if (prior) {
      if (prior.h !== h) return inputError('request_conflict');
      if (prior.phase === 'sent') return { ok: true, outcome: 'sent', replay: true };
      if (prior.phase === 'sending') await this.storage.put<InputLedgerEntry>(key, { ...prior, phase: 'unknown', error: 'delivery_unknown' });
      if (prior.phase === 'rejected') return inputError(prior.error ?? 'input_rejected');
      return inputError('delivery_unknown');
    }
    if (!(await this.withinBudget())) return inputError('rate_limited');
    if (target.status !== 'running') return inputError('not_running');

    const auth = { authorization: `Bearer ${account.key}` };
    const sb = await this.json(`${account.api}/sandbox/${encodeURIComponent(target.id)}`, { method: 'GET', headers: auth });
    if (!sb) return inputError('provider_error');
    const labels = (sb.labels ?? {}) as Record<string, unknown>;
    if (sb.id !== target.id || sb.name !== target.name || Object.entries(target.labels).some(([k, v]) => labels[k] !== v)) return inputError('target_mismatch');
    if (sb.state !== 'started') return inputError('not_running');
    let base = toolboxBase(sb.toolboxProxyUrl);
    if (!base && sb.toolboxProxyUrl == null) {
      const p = await this.json(`${account.api}/sandbox/${encodeURIComponent(target.id)}/toolbox-proxy-url`, { method: 'GET', headers: auth });
      if (!p) return inputError('provider_error');
      base = toolboxBase(p.url);
    }
    if (!base) return inputError('target_mismatch');

    await this.storage.put<InputLedgerEntry>(key, { h, phase: 'sending', at: this.now(), error: null });
    const box = `${base}/${encodeURIComponent(target.id)}/computeruse/keyboard`;
    const headers = { ...auth, 'content-type': 'application/json', accept: 'application/json' };
    let typed = false;
    if (input.text) {
      const r = await this.post(`${box}/type`, { text: input.text }, headers);
      if (r.kind !== 'ok') return this.finish(key, h, r.kind === 'rejected' ? 'rejected' : 'unknown');
      typed = true;
    }
    if (input.enter) {
      const r = await this.post(`${box}/key`, { key: 'enter', modifiers: [] }, headers);
      // Text already typed but Enter unconfirmed is a partial delivery: never report rejected, never retype.
      if (r.kind !== 'ok') return this.finish(key, h, r.kind === 'rejected' && !typed ? 'rejected' : 'unknown');
    }
    await this.storage.put<InputLedgerEntry>(key, { h, phase: 'sent', at: this.now(), error: null });
    return { ok: true, outcome: 'sent', replay: false };
  }

  private async finish(key: string, h: string, phase: 'rejected' | 'unknown'): Promise<InputResult> {
    const error: InputErrorCode = phase === 'rejected' ? 'input_rejected' : 'delivery_unknown';
    await this.storage.put<InputLedgerEntry>(key, { h, phase, at: this.now(), error });
    return inputError(error);
  }

  /** Prunes entries older than the window and counts the rest (every phase consumed a slot). Live entries are never
   *  evicted to make room: a full ledger refuses new input (429) so a lost response can still replay exactly. */
  private async withinBudget(): Promise<boolean> {
    const cutoff = this.now() - INPUT_WINDOW_MS;
    let live = 0;
    for (const [k, v] of await this.storage.list<InputLedgerEntry>({ prefix: LEDGER })) {
      if (v.at < cutoff) await this.storage.delete(k); else live++;
    }
    return live < INPUT_WINDOW_OPS;
  }

  private async json(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.transport(url, { ...init, signal: AbortSignal.timeout(INPUT_FETCH_MS) });
      if (!r.ok) return null;
      const v = await r.json();
      return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch { return null; }
  }

  /** 2xx ok; definitive 4xx (not 408) rejected; timeout, network, 408 and 5xx may have typed -> unknown. */
  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<Call> {
    try {
      const r = await this.transport(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(INPUT_FETCH_MS) });
      await r.body?.cancel().catch(() => undefined);
      if (r.ok) return { kind: 'ok' };
      return r.status >= 400 && r.status < 500 && r.status !== 408 ? { kind: 'rejected' } : { kind: 'unknown' };
    } catch { return { kind: 'unknown' }; }
  }
}

/** Binding CLOUDBITE_COMPUTER_INPUT, idFromName(ownerTag). Root calls send() over RPC after its own checks. */
export class CloudbiteComputerInput extends DurableObject<ComputerEnv> {
  private service: ComputerInputService;
  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    this.service = new ComputerInputService(ctx.storage as unknown as InputStorage, env);
  }
  async send(target: ComputerMachineRef, input: { requestId?: unknown; text?: unknown; enter?: unknown }): Promise<InputResult> {
    return this.service.send(target, input);
  }
}
