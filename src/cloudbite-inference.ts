// Nosana OpenAI-compatible chat completion, called server-side only. The API key never leaves this call,
// upstream bodies are never reflected, and the reply is reduced to one bounded text field.
import { CB_INFERENCE_MAX_TOKENS, CB_INFERENCE_REPLY_MAX, CB_INFERENCE_TIMEOUT, type CloudbiteConfig } from './cloudbite-config';
import type { Invalid } from './cloudbite-validate';
import { CB_MEMO_MAX_TOKENS } from './cloudbite-memo';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** Runner request body → messages. Roles and sizes only; contents are data, never authority. */
export function chatMessages(raw: unknown): ChatMessage[] | Invalid {
  const m = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(m) || m.length < 1 || m.length > 32) return { invalid: 'messages must be 1-32 items' };
  const out: ChatMessage[] = [];
  for (const x of m) {
    if (typeof x !== 'object' || x === null || !['system', 'user', 'assistant'].includes(x.role) || typeof x.content !== 'string') return { invalid: 'invalid message' };
    out.push({ role: x.role, content: x.content });
  }
  return out;
}

/** Body text up to max bytes; throws past it (the rest is not read). */
export async function boundedText(r: Request | Response, max: number): Promise<string> {
  if (Number(r.headers.get('content-length') ?? 0) > max) throw new RangeError('too large');
  if (!r.body) return '';
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel(); throw new RangeError('too large'); }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

export type InferenceResult = { content: string } | { error: string; status: number };

// Qwen3-family chat templates think by default; on a realistic persona+workspace prompt the hidden reasoning used the
// whole max_tokens budget and left content null. The model card documents chat_template_kwargs.enable_thinking=false
// to turn it off. With thinking off the same model still emitted syntactically invalid JSON (~2200 chars, not truncated)
// on the visitor sample, so it also requests response_format json_object. That only constrains syntax: the runner's
// semantic validation and round limits stay as they are. Only these exact model ids get either flag; every other
// OpenAI-compatible model keeps the plain shape.
const THINKING_OFF_MODELS = new Set(['qwen/qwen3.8-27b']);

/** Output budgets the server may request: every role/reviewer call, and the one fixed decision-memo value. */
const MAX_TOKENS = new Set([CB_INFERENCE_MAX_TOKENS, CB_MEMO_MAX_TOKENS]);
export interface ChatOptions { /** Server-chosen only (never user input); anything but an allowed value is refused. */ maxTokens?: number }

/** The upstream request body: same budgets for every model, plus thinking-off and JSON mode for the models above. */
export function chatRequestBody(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Record<string, unknown> {
  const maxTokens = opts.maxTokens ?? CB_INFERENCE_MAX_TOKENS;
  if (!MAX_TOKENS.has(maxTokens)) throw new RangeError('unsupported max_tokens');
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens, temperature: 0.3, stream: false };
  if (THINKING_OFF_MODELS.has(model)) {
    body.chat_template_kwargs = { enable_thinking: false };
    body.response_format = { type: 'json_object' };
  }
  return body;
}

export async function nosanaChat(cfg: CloudbiteConfig['nosana'], messages: ChatMessage[], opts: ChatOptions = {}): Promise<InferenceResult> {
  const body = JSON.stringify(chatRequestBody(cfg.model, messages, opts));
  let r: Response;
  try {
    r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(CB_INFERENCE_TIMEOUT),
    });
  } catch { return { error: 'inference upstream unavailable', status: 504 }; }
  if (!r.ok) { await r.body?.cancel(); return { error: `inference upstream failed (${r.status})`, status: 502 }; }
  let j: unknown;
  try { j = JSON.parse(await boundedText(r, 512 * 1024)); } catch { return { error: 'inference upstream returned invalid JSON', status: 502 }; }
  const choice = (j as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> })?.choices?.[0];
  const content = choice?.message?.content;
  // Empty answers fail by category only: any reasoning text or other body fields are never read back or substituted.
  if (typeof content !== 'string' || !content.trim()) {
    return choice?.finish_reason === 'length'
      ? { error: 'inference upstream used its output budget before any content (finish_reason=length)', status: 502 }
      : { error: 'inference upstream returned no content', status: 502 };
  }
  return { content: content.slice(0, CB_INFERENCE_REPLY_MAX) };
}
