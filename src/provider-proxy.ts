// ANY /p/<provider>/<path> 프록시 본체: kvt_ 토큰으로 DO 에 호출을 예약하고 진짜 키를 실어 upstream 으로.
// index.ts 가 호스트·/p/_lab/share·토큰 형식(kvt_) 검사를 지난 뒤에만 부른다

import { authHeader } from './providers';
import { isFail, type State } from './state';

type Stub = DurableObjectStub<State>;

// 프록시할 때 upstream 으로 넘기지 않을 헤더
const STRIP = ['host', 'cookie', 'authorization', 'x-api-key', 'xi-api-key', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'true-client-ip'];

/**
 * upstream 응답 본문을 받는 쪽이 읽는 만큼만 넘기는 감싸기. 끝·오류면 settle 한 번, 받는 쪽이 끊으면(cancel)
 * upstream 호출을 끊고(abort) reader 를 취소한 뒤 settle 한 번
 */
function leasedBody(src: ReadableStream<Uint8Array>, abort: () => void, settle: () => void) {
  const reader = src.getReader();
  let over = false;
  const end = () => { if (!over) { over = true; settle(); } };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { end(); c.close(); } else c.enqueue(value);
      } catch (e) { end(); c.error(e); }
    },
    async cancel(reason) {
      abort();
      await reader.cancel(reason).catch(() => {});
      end();
    },
  });
}

/**
 * 예약(lease): 키가 upstream 에 가기 전 실패면 통째로 돌려주고(refund), 간 뒤에는 센 채로 동시 자리만 푼다(release). 둘 다 한 번만.
 * 키를 실은 fetch 와 응답 본문이 살아 있는 동안 자리를 늘린다 (fetch 전에 시작, 정산하면 멈춤).
 * 세션·자리가 없어졌다고 하면(끊김·만료·수명 지남) upstream 호출을 끊는다. Worker 가 죽으면 늘리기도 멈춰 자리는 수명 뒤 풀린다
 */
function holdLease(state: Stub, ctx: ExecutionContext, sid: string, lease: string, renew: number) {
  let settled = false;
  let wake = () => {};
  const stopped = new Promise<void>((res) => { wake = res; });
  const settle = (refund: boolean) => {
    if (settled) return Promise.resolve();
    settled = true;
    wake(); // 늘리기 멈춤
    return (refund ? state.refundUse(sid, lease) : state.releaseUse(sid, lease)).catch(() => {});
  };
  const ac = new AbortController();
  ctx.waitUntil((async () => {
    while (!settled) {
      let tm = 0;
      await Promise.race([stopped, new Promise<void>((res) => { tm = setTimeout(res, renew) as unknown as number; })]);
      clearTimeout(tm);
      if (settled) return;
      let ok = true;
      try { ok = await state.renewUse(sid, lease); } catch {} // DO 가 잠깐 안 받으면 다음 차례에 (그 사이 수명이 지나면 false)
      if (!ok && !settled) {
        ac.abort(new Error('gateway lease ended'));
        await settle(false);
        return;
      }
    }
  })());
  return { ac, settle };
}

export async function providerProxy(
  req: Request, state: Stub, ctx: ExecutionContext,
  provider: string, path: string, search: string, token: string,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  // 나갈 주소(공급자 upstream 과 같은 출처·그 경로 아래)는 DO 가 호출 수를 예약하기 전에 정한다 — 틀린 경로는 세지 않고 400
  const r = await state.resolveToken(token, provider, path, search);
  if (isFail(r)) return json({ error: r.error }, r.status);
  const { ac, settle } = holdLease(state, ctx, r.sid, r.lease, r.renew);
  let target: URL, headers: Headers;
  try {
    target = new URL(r.target);
    headers = new Headers(req.headers);
    for (const h of STRIP) headers.delete(h);
    headers.set(...authHeader(r.auth, r.key));
    for (const [k, v] of Object.entries(r.headers ?? {})) headers.set(k, v); // 공급자의 고정 헤더가 이긴다 (다른 workspace 로 못 돌림)
  } catch {
    await settle(true);
    return json({ error: 'provider request could not be built' }, 503);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method, headers, body: req.body, redirect: 'manual', signal: ac.signal,
    });
  } catch (e) {
    ctx.waitUntil(settle(false));
    if (ac.signal.aborted) return json({ error: 'gateway call slot ended (token revoked or expired)' }, 503);
    const msg = `upstream 연결 실패: ${e instanceof Error ? e.message : String(e)}`;
    ctx.waitUntil(state.noteError(r.sid, 502, msg));
    return json({ error: msg }, 502);
  }
  // 오류는 세션에 적어 둔다 → /lab 표의 '최근 오류'·전체 경고 (한도 소진 402, 모델 없음 404, 과부하 429·5xx …)
  if (upstream.status >= 400) {
    const peek = upstream.clone();
    ctx.waitUntil(peek.text().then((t) => {
      let msg = t.slice(0, 300);
      try { const j = JSON.parse(t); msg = String(j.error?.message ?? j.error ?? j.message ?? msg); } catch {}
      return state.noteError(r.sid, upstream.status, msg);
    }).catch(() => {}));
  }
  const rh = new Headers(upstream.headers);
  rh.delete('set-cookie');
  // 동시 자리는 응답 본문이 끝나거나(정상·오류) 받는 쪽이 끊을 때 푼다 (스트리밍 응답 동안은 잡혀 있다)
  if (!upstream.body) {
    ctx.waitUntil(settle(false));
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: rh });
  }
  const body = leasedBody(upstream.body, () => { ac.abort(new Error('downstream cancelled')); }, () => { ctx.waitUntil(settle(false)); });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: rh });
}
