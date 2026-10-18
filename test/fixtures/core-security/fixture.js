// core-security 회귀 테스트 전용 fixture. 배포 코드에는 들어가지 않는다 (test/core-security.mjs 가 임시 wrangler 설정의 main 으로만 쓴다).
//
//   - 진짜 State(DO)를 상속하고 진짜 SQLite 저장소를 그대로 쓴다. 바꾸는 것은 decrypt 앞의 barrier 하나뿐
//     (시험이 켰을 때만): 호출 수 확인과 복호화 사이에 다른 요청이 끼는 옛 경쟁을 결정적으로 재현한다.
//   - /__fx/<method> 는 이 fixture Worker 에만 있다 (저장소에 합성 기록 넣기·읽기, barrier 켜기, 바깥 호출 기록).
//   - 바깥(loopback 이 아닌) fetch 는 전부 막고 적어 둔다 → 테스트가 진짜 공급자·유료 API 를 부를 수 없다.
//   - #13: lease 수명을 짧게(fxLeaseTtl — 이 fixture 의 leaseTtl 덮어쓰기, 배포 코드는 늘 15분), renewUse 호출 기록,
//     /__fxw/cancel: 진짜 프록시 응답 본문을 이 Worker 안에서 읽다가 cancel (로컬 wrangler dev 가 클라이언트 끊김을 넘기지 않아서)

const realFetch = globalThis.fetch;
const outbound = [];
const loopback = (h) => h === 'localhost' || h === '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// hold: 주소에 match 가 든 바깥 호출 left 개를 release 까지(최대 timeout) 붙잡는다 — await 중인 요청 사이에 다른 요청을 끼우는 데 쓴다
let hold = null;
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (loopback(u.hostname)) return realFetch(input, init);
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  outbound.push({ method: init?.method ?? (input instanceof Request ? input.method : 'GET'), url: href, auth: h.get('authorization') ?? h.get('x-api-key') ?? h.get('xi-api-key') ?? '' });
  const hd = hold;
  if (hd && hd.left > 0 && href.includes(hd.match)) {
    hd.left--;
    hd.arrived++;
    await Promise.race([hd.released, sleep(hd.timeout)]);
  }
  return new Response(JSON.stringify({ error: 'blocked by core-security fixture' }), { status: 503 });
};

export function makeFixture(worker, Base) {
  class State extends Base {
    fxBarrier = null;
    fxLease = null;  // ms — null 이면 배포 값
    fxRenews = [];   // renewUse 기록 { sid, t, ok }
    fxFlags = {};

    leaseTtl() { return this.fxLease ?? super.leaseTtl(); }
    async renewUse(sid, lease) {
      const ok = await super.renewUse(sid, lease);
      this.fxRenews.push({ sid, t: Date.now(), ok });
      if (this.fxRenews.length > 5000) this.fxRenews.splice(0, 1000);
      return ok;
    }
    async fxLeaseTtl(ms) { this.fxLease = ms; return { ok: true }; }
    async fxRenewLog(sid) { return this.fxRenews.filter((x) => x.sid === sid); }
    async fxRenew(sid, lease) { return { ok: await this.renewUse(sid, lease) }; }
    async fxFlagSet(name, v = true) { this.fxFlags[name] = v; return { ok: true }; }
    async fxFlag(name) { return !!this.fxFlags[name]; }

    // resolveToken 이 부르는 decrypt 앞에서 need 개가 모일 때까지(최대 timeout) 기다린다
    async decrypt(p) {
      const b = this.fxBarrier;
      if (b && b.provider === p.id) {
        b.arrived++;
        if (b.arrived >= b.need) b.open();
        await Promise.race([b.opened, sleep(b.timeout)]);
      }
      return super.decrypt(p);
    }

    async fxBarrierSet(provider, need, timeout) {
      let open;
      const opened = new Promise((r) => { open = r; });
      this.fxBarrier = provider ? { provider, need, timeout, arrived: 0, open, opened } : null;
      return { ok: true };
    }
    async fxBarrierInfo() { return { arrived: this.fxBarrier?.arrived ?? 0 }; }
    async fxHoldSet(match, left, timeout) {
      hold?.release();
      let release;
      const released = new Promise((r) => { release = r; });
      hold = match ? { match, left, timeout, arrived: 0, release, released } : null;
      return { ok: true };
    }
    async fxHoldInfo() { return { arrived: hold?.arrived ?? 0 }; }
    async fxHoldRelease() { hold?.release(); hold = null; return { ok: true }; }
    async fxPut(entries) { await this.ctx.storage.put(entries); return { ok: true }; }
    async fxGet(keys) { return Object.fromEntries(await this.ctx.storage.get(keys)); }
    async fxList(prefix) { return Object.fromEntries(await this.ctx.storage.list({ prefix })); }
    async fxDelete(keys) { return { n: await this.ctx.storage.delete(keys) }; }
    async fxOutbound() { return outbound.slice(); }
    async fxAlarm() { await this.alarm(); return { ok: true }; }
    // #13: 프록시가 부르는 돌려주기·풀기를 직접 (두 번 불러도 한 번만인지)
    async fxRefund(sid, lease) { await this.refundUse(sid, lease); return { ok: true }; }
    async fxRelease(sid, lease) { await this.releaseUse(sid, lease); return { ok: true }; }
  }

  const fx = {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      // 진짜 프록시 경로(worker.fetch)로 스트리밍 응답을 받아 첫 조각을 읽고, DO 의 flag 가 켜지면 본문을 cancel 한다
      // (받는 쪽 끊김 = 배포 Cloudflare 가 응답 스트림을 취소하는 것과 같은 길). 한 요청 안에서 끝낸다
      if (url.pathname === '/__fxw/cancel' && req.method === 'POST') {
        const { path, token, flag, timeout } = await req.json();
        const stub = env.STATE.get(env.STATE.idFromName('main'));
        const res = await worker.fetch(new Request(new URL(`/p/${path}`, url.origin), { headers: { authorization: `Bearer ${token}` } }), env, ctx);
        if (!res.body) return Response.json({ status: res.status, first: null, cancelled: false });
        const reader = res.body.getReader();
        const first = await reader.read();
        const until = Date.now() + (timeout ?? 30000);
        while (Date.now() < until && !(await stub.fxFlag(flag))) await sleep(50);
        await reader.cancel('core-security fixture cancel');
        return Response.json({ status: res.status, first: first.value ? new TextDecoder().decode(first.value) : null, cancelled: true });
      }
      if (url.pathname.startsWith('/__fx/') && req.method === 'POST') {
        const stub = env.STATE.get(env.STATE.idFromName('main'));
        const args = await req.json();
        const m = url.pathname.slice(6);
        if (!/^fx[A-Za-z]+$/.test(m)) return new Response('no', { status: 404 });
        return Response.json(await stub[m](...args));
      }
      return worker.fetch(req, env, ctx);
    },
  };
  return { State, worker: fx };
}
