// lab-security 회귀 테스트 전용 fixture. 배포 코드에는 들어가지 않는다 (test/lab-security.mjs 가 임시 wrangler 설정의 main 으로만 쓴다).
//
//   - 진짜 State(DO)를 상속하고 진짜 SQLite 저장소를 그대로 쓴다. 바꾸는 것:
//       daytona()      저장된 공급자 키 대신 합성 { api: LAB_DAYTONA_API(loopback 가짜), key } (키 암호화 경로는 core-security 가 본다)
//       answerTtl()·exportTtl()·exportLimits()   시험이 짧게 바꿀 수 있게 (배포 값은 그대로)
//   - /__fx/<method> 는 이 fixture Worker 에만 있다 (합성 기록 넣기·읽기, 관리 토큰, 알람 직접 돌리기, 바깥 호출 기록).
//   - 바깥(loopback 이 아닌) fetch 는 전부 막고 적어 둔다 → 진짜 Daytona·Realtime·OpenRouter 를 부를 수 없다.

const realFetch = globalThis.fetch;
const outbound = [];
const loopback = (h) => h === 'localhost' || h === '127.0.0.1';
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (loopback(new URL(href).hostname)) return realFetch(input, init);
  outbound.push({ method: init?.method ?? (input instanceof Request ? input.method : 'GET'), url: href });
  return new Response(JSON.stringify({ error: 'blocked by lab-security fixture' }), { status: 503 });
};

export function makeFixture(worker, Base) {
  class State extends Base {
    fxT = {};      // answer, ticket, stream, pack, cooldown (ms)
    fxLim = null;  // { bytes, entries, seconds }
    fxZip = null;  // 내려받기 바이트 상한 (작게 바꿔 넘침을 본다)

    async daytona() { return { api: this.env.LAB_DAYTONA_API, key: 'fx-daytona-key' }; }
    answerTtl() { return this.fxT.answer ?? super.answerTtl(); }
    exportTtl() { return { ...super.exportTtl(), ...Object.fromEntries(Object.entries(this.fxT).filter(([k]) => k !== 'answer')) }; }
    exportLimits() { return this.fxLim ?? super.exportLimits(); }
    exportZipMax() { return this.fxZip ?? super.exportZipMax(); }

    async fxTimes(t) { this.fxT = t ?? {}; return { ok: true }; }
    async fxLimits(l) { this.fxLim = l; return { ok: true }; }
    async fxZipMax(n) { this.fxZip = n; return { ok: true }; }
    async fxZipMaxReal() { return { n: super.exportZipMax() }; }
    async fxAdmin() { return await this.newAdminToken('web'); }
    async fxPut(entries) { await this.ctx.storage.put(entries); return { ok: true }; }
    async fxGet(keys) { return Object.fromEntries(await this.ctx.storage.get(keys)); }
    async fxList(prefix) { return Object.fromEntries(await this.ctx.storage.list({ prefix })); }
    async fxDelete(keys) { return { n: await this.ctx.storage.delete(keys) }; }
    async fxOutbound() { return outbound.slice(); }
    async fxAlarm() { await this.alarm(); return { ok: true }; }
    async fxEnd(id) { const lab = await this.ctx.storage.get(`lab:${id}`); return { ok: lab ? await this.endLab(lab, 'end') : false }; }
    // 기다리던 정리(waitUntil)가 끝나게 잠깐
    async fxIdle(ms) { await new Promise((r) => setTimeout(r, ms ?? 200)); return { ok: true }; }
  }

  // 브라우저 시험: 자리 호스트가 받은 /__lab/enter 요청의 출처 헤더 (Worker 쪽에서 적는다)
  const enters = [];
  const fx = {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      if (url.pathname === '/__fx-enters') return Response.json(enters);
      if (url.pathname === '/__lab/enter') {
        const h = (k) => req.headers.get(k);
        enters.push({ host: url.host, method: req.method, origin: h('origin'), site: h('sec-fetch-site'), mode: h('sec-fetch-mode'), dest: h('sec-fetch-dest'), referer: h('referer') });
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
