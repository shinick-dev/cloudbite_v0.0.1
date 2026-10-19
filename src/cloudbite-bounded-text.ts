// Bounded body reader shared by server adapters without importing their environment or credentials.
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

