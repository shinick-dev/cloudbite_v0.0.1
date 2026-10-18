// Nosana OpenAI-compatible chat completion, called server-side only. The API key never leaves this call,
// upstream bodies are never reflected, and the reply is reduced to one bounded text field.
import { CB_INFERENCE_MAX_TOKENS, CB_INFERENCE_REPLY_MAX, CB_INFERENCE_TIMEOUT, type CloudbiteConfig } from './cloudbite-config';
import type { Invalid } from './cloudbite-validate';

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

export async function nosanaChat(cfg: CloudbiteConfig['nosana'], messages: ChatMessage[]): Promise<InferenceResult> {
  let r: Response;
  try {
    r = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: CB_INFERENCE_MAX_TOKENS, temperature: 0.3, stream: false }),
      signal: AbortSignal.timeout(CB_INFERENCE_TIMEOUT),
    });
  } catch { return { error: 'inference upstream unavailable', status: 504 }; }
  if (!r.ok) { await r.body?.cancel(); return { error: `inference upstream failed (${r.status})`, status: 502 }; }
  let j: unknown;
  try { j = JSON.parse(await boundedText(r, 512 * 1024)); } catch { return { error: 'inference upstream returned invalid JSON', status: 502 }; }
  const content = (j as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return { error: 'inference upstream returned no content', status: 502 };
  return { content: content.slice(0, CB_INFERENCE_REPLY_MAX) };
}
