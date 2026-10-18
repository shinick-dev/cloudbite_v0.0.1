// auth-security 회귀 테스트 전용 fixture. 배포 코드에는 들어가지 않는다 (test/auth-security.mjs 가 임시 wrangler 설정의 main 으로만 쓴다).
//
//   - core-security fixture 를 그대로 쓴다 (진짜 State·SQLite, 바깥 fetch 막기, /__fx/<method>).
//   - 시계: fxClock(ms) 로 Date.now 를 앞으로 민다 (Worker·DO 같은 isolate). 메모리라 재시작하면 0 — 테스트가 다시 넣는다.
//   - 출처: Cloudflare 가 넣는 cf-connecting-ip 를 흉내 낸다. 시험이 보낸 x-fx-src 를 cf-connecting-ip 로 바꾸고,
//     x-fx-src 가 없으면 cf-connecting-ip 를 지운다 (= 헤더 없는 loopback 기본값). 클라이언트가 보낸 cf-connecting-ip 는 안 넘긴다.
import { makeFixture as core } from '../core-security/fixture.js';

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

export function makeFixture(worker, Base) {
  const f = core(worker, Base);
  class State extends f.State {
    async fxClock(ms) { offset = Number(ms) || 0; return { ok: true, now: Date.now() }; }
    async fxResolve(token, provider, path, search) { return this.resolveToken(token, provider, path, search); }
  }
  const fx = {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      if (url.pathname === '/__fx/fxClock') {
        const [ms] = await req.clone().json();
        offset = Number(ms) || 0;
      }
      if (!url.pathname.startsWith('/__fx/')) {
        const h = new Headers(req.headers);
        const s = h.get('x-fx-src');
        h.delete('x-fx-src');
        if (s) h.set('cf-connecting-ip', s); else h.delete('cf-connecting-ip');
        req = new Request(req, { headers: h });
      }
      return f.worker.fetch(req, env, ctx);
    },
  };
  return { State, worker: fx };
}
