// wrangler dev 에 대고 전체 흐름을 돈다. 보안 키 대신 소프트웨어 인증기(P-256)를 쓴다.
//   GW=http://localhost:8797 SETUP_TOKEN=... node test/e2e.mjs
// 실제 upstream 을 부른다. 공급자 키는 이 프로세스의 환경변수(프리셋 source 이름)에서 읽어 CLI 로그인 흐름으로 올린다.
// OpenRouter 는 $1 한도 서브키를 만들었다 지운다.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const GW = process.env.GW ?? 'http://localhost:8797';
const RP_ID = process.env.RP_ID ?? new URL(GW).hostname;
const SETUP = process.env.SETUP_TOKEN;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

async function call(path, body, headers = {}) {
  const r = await fetch(GW + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: GW, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

// ── 소프트웨어 인증기 ──
class SoftKey {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x, 'base64url');
    this.y = Buffer.from(jwk.y, 'base64url');
    this.id = randomBytes(16);
    this.counter = 0;
  }
  clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: GW, crossOrigin: false }));
  }
  create(opts) {
    const cdj = this.clientData('webauthn.create', opts.challenge);
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(opts.rp.id), Buffer.from([0x45]), Buffer.alloc(4), // UP|UV|AT, counter 0
      Buffer.alloc(16), idLen, this.id, Buffer.from(isoCBOR.encode(cose)),
    ]);
    const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att), transports: ['usb', 'nfc'] },
      clientExtensionResults: this.prf ? { prf: { enabled: true } } : {}, authenticatorAttachment: 'cross-platform',
    };
  }
  get(opts, { uv = true } = {}) {
    const cdj = this.clientData('webauthn.get', opts.challenge);
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(opts.rpId), Buffer.from([uv ? 0x05 : 0x01]), ctr]);
    const sig = sign('sha256', Buffer.concat([authData, sha256(cdj)]), this.priv);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(authData), signature: b64u(sig) },
      clientExtensionResults: {},
    };
  }
}

const key = new SoftKey();
const stranger = new SoftKey();

console.log(`\n# 등록 (${GW})`);
{
  const bad = await call('/api/register/options', { setup: 'wrong-wrong-wrong-wrong' });
  check('틀린 setup token 거부', bad.status === 403);
  const o = await call('/api/register/options', { setup: SETUP });
  check('등록 options', o.status === 200 && o.j.rp.id === RP_ID, JSON.stringify(o.j));
  const v = await call('/api/register/verify', { setup: SETUP, response: key.create(o.j), label: 'soft' });
  check('등록 verify', v.status === 200 && v.j.ok, JSON.stringify(v.j));
}

console.log('\n# CLI 관리 로그인 → 공급자 올리기 (kv.ps1 push 와 같은 흐름)');
const presets = (await call('/api/presets')).j;
{
  const bogus = await call('/api/admin/provider', { preset: 'groq', value: 'x' }, { 'x-admin-token': 'nope' });
  check('관리 토큰 없이 공급자 추가 401', bogus.status === 401);
  const l = (await call('/api/cli/login', {})).j;
  const info = (await call(`/api/approve/${l.id}`)).j;
  check('승인 페이지가 관리 요청임을 앎', info.kind === 'admin' && info.code === l.code);
  const lo = (await call(`/api/approve/${l.id}/options`, {})).j;
  check('관리 승인 (탭)', (await call(`/api/approve/${l.id}`, { assertion: key.get(lo), choice: {} })).j?.ok === true);
  const p = (await call(`/api/borrow/${l.id}/poll`, { secret: l.secret })).j;
  check('CLI 가 관리 토큰 수령 (env 블록 없음)', p.status === 'approved' && !!p.adminToken && !p.env && !p.token);
  var ADM = { 'x-admin-token': p.adminToken };
  check('새 공급자에 값 없으면 400', (await call('/api/admin/provider', { preset: 'tavily', id: 'tavily-x' }, ADM)).status === 400);
  check('http upstream 거부', (await call('/api/admin/provider', { id: 'bad', upstream: 'http://x.test', envKey: 'X', value: 'v' }, ADM)).status === 400);
  const pushed = [];
  for (const pr of presets) {
    const v = process.env[pr.source];
    if (!v) continue;
    const r = await call('/api/admin/provider', { preset: pr.id, value: v }, ADM);
    if (r.status === 200 && r.j.provider.last4 === v.trim().slice(-4) && !('ct' in r.j.provider)) pushed.push(pr.id);
    else check(`공급자 ${pr.id} 올리기`, false, JSON.stringify(r.j));
  }
  if (process.env.E2E_NO_PROVIDERS) {
    // test/e2e-local.mjs: 진짜 공급자 키 없이 — loopback 가짜 upstream 에 합성 키로 공급자 둘
    console.log('       진짜 공급자 건너뜀 (E2E_NO_PROVIDERS) — loopback 가짜 공급자 loc1·loc2');
    for (const id of ['loc1', 'loc2']) {
      const r = await call('/api/admin/provider', { id, label: id, upstream: `${process.env.E2E_LOCAL_UPSTREAM}/${id}`, auth: 'bearer', envKey: `${id.toUpperCase()}_KEY`, value: `synthetic-${id}-key` }, ADM);
      if (r.status === 200) pushed.push(id);
    }
    check(`가짜 공급자 ${pushed.length}개 올림`, pushed.length === 2);
  } else check(`공급자 ${pushed.length}개 올림: ${pushed.join(', ')}`, pushed.length > 0);
  const lst = (await call('/api/admin/list', {}, ADM)).j;
  check('목록에 암호문·키 없음', lst.providers.length >= pushed.length && !JSON.stringify(lst.providers).match(/"(ct|iv|value)"/));
}

console.log('\n# 빌린 PC → 승인');
const req = (await call('/api/borrow', {})).j;
check('요청 생성 (코드·QR)', /^[A-Z2-9]{6}$/.test(req.code) && req.qr.startsWith('<svg') && req.approveUrl.endsWith(req.id));
check('다른 origin POST 거부', (await call('/api/borrow', {}, { origin: 'https://evil.example' })).status === 403);
check('틀린 poll secret 거부', (await call(`/api/borrow/${req.id}/poll`, { secret: 'nope' })).status === 403);
check('승인 전 pending', (await call(`/api/borrow/${req.id}/poll`, { secret: req.secret })).j.status === 'pending');
const info = (await call(`/api/approve/${req.id}`)).j;
check('승인 페이지 정보에 같은 코드', info.code === req.code);
console.log(`       사용 가능 공급자: ${info.providers.map((p) => p.id).join(', ')}`);
const providers = info.providers.map((p) => p.id);
const choice = { providers, ttlHours: 1, budget: 1 };

{
  const o = (await call(`/api/approve/${req.id}/options`, {})).j;
  const r = await call(`/api/approve/${req.id}`, { assertion: stranger.get(o), choice });
  check('등록 안 된 키 거부', r.status === 401);
  const o2 = (await call(`/api/approve/${req.id}/options`, {})).j;
  const r2 = await call(`/api/approve/${req.id}`, { assertion: key.get(o2, { uv: false }), choice });
  check('PIN(UV) 없는 탭 거부', r2.status === 401);
}
const o = (await call(`/api/approve/${req.id}/options`, {})).j;
const assertion = key.get(o);
const ok = await call(`/api/approve/${req.id}`, { assertion, choice });
check('NFC 탭 승인', ok.status === 200 && ok.j.ok, JSON.stringify(ok.j));
check('같은 서명 재전송 거부', (await call(`/api/approve/${req.id}`, { assertion, choice })).status === 409);

const got = (await call(`/api/borrow/${req.id}/poll`, { secret: req.secret })).j;
check('빌린 PC 가 토큰 수령', got.status === 'approved' && got.token.startsWith('kvt_'));
const realVals = presets.map((p) => process.env[p.source]).filter(Boolean);
check('env 블록에 진짜 키 없음', !realVals.some((v) => JSON.stringify(got).includes(v.trim())));
console.log('       ' + got.env.powershell.replace(/kvt_[\w-]+/g, 'kvt_…'));
check('토큰은 한 번만', (await call(`/api/borrow/${req.id}/poll`, { secret: req.secret })).j.token === undefined);
const T = { authorization: `Bearer ${got.token}` };

console.log('\n# 프록시');
if (providers.includes('loc1')) {
  const r = await call('/p/loc1/v1/ok?x=1', undefined, T);
  check('가짜 공급자: 진짜(합성) 키로 바꿔 upstream 에', r.status === 200 && r.j?.path === '/loc1/v1/ok?x=1' && r.j?.auth === 'Bearer synthetic-loc1-key', JSON.stringify(r.j));
  check('가짜 공급자: 인코딩된 / 로 base 밖 → 400', (await call('/p/loc1/v1/..%2F..%2Floc2', undefined, T)).status === 400);
}
if (providers.includes('openrouter')) {
  const k = await call('/p/openrouter/api/v1/key', undefined, T);
  check('OpenRouter: 서브키로 통과 ($1 한도)', k.status === 200 && k.j.data?.limit === 1, JSON.stringify(k.j));
  const c = await call('/p/openrouter/api/v1/chat/completions', {
    model: 'meta-llama/llama-3.1-8b-instruct', max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }],
  }, T);
  check('OpenRouter: chat completion', c.status === 200 && !!c.j.choices, JSON.stringify(c.j).slice(0, 200));
  const a = await fetch(GW + '/p/openrouter/api/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': got.token, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'meta-llama/llama-3.1-8b-instruct', max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }] }),
  });
  check('OpenRouter: Anthropic 스킨 (x-api-key)', a.status === 200, String(a.status));
}
if (providers.includes('groq')) {
  const g = await call('/p/groq/openai/v1/models', undefined, T);
  check('Groq: 모델 목록 (인증 필요)', g.status === 200 && Array.isArray(g.j.data), JSON.stringify(g.j).slice(0, 200));
  const model = (g.j.data.find((m) => /llama|gpt-oss|qwen/.test(m.id) && !/guard|whisper|tts/.test(m.id)) ?? g.j.data[0]).id;
  console.log(`       groq 모델: ${model}`);
  const s = await fetch(GW + '/p/groq/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...T },
    body: JSON.stringify({ model, max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'Say OK' }] }),
  });
  const txt = await s.text();
  check('Groq: 스트리밍 SSE 통과', s.status === 200 && txt.includes('data:'), txt.slice(0, 200));
}
if (providers.includes('hf')) {
  const h = await call('/p/hf/v1/models', undefined, T);
  check('HF: router 모델 목록', h.status === 200, String(h.status));
}
if (providers.includes('tavily')) {
  const r = await call('/p/tavily/usage', undefined, T);
  check('Tavily: usage', r.status === 200, String(r.status));
}
if (providers.includes('elevenlabs')) {
  // ElevenLabs SDK 처럼 xi-api-key 헤더로 가짜 토큰을 보낸다
  const r = await call('/p/elevenlabs/v1/user', undefined, { 'xi-api-key': got.token });
  check('ElevenLabs: user (xi-api-key)', r.status === 200, String(r.status));
}
for (const id of ['nebius', 'nvidia', 'openai']) {
  if (!providers.includes(id)) continue;
  const r = await call(`/p/${id}/v1/models`, undefined, T);
  check(`${id}: 모델 목록`, r.status === 200 && Array.isArray(r.j?.data), String(r.status));
}
if (providers.includes('daytona')) {
  // 보통 승인 토큰은 조직·키·계정 관리 API 를 못 부른다 (승인 때 따로 허용해야) — 샌드박스 목록 같은 데이터 경로만
  const r = await call('/p/daytona/sandbox', undefined, T);
  check('Daytona: 샌드박스 목록', r.status === 200, String(r.status));
  check('Daytona: 관리 API(api-keys) 는 거부', (await call('/p/daytona/api-keys/current', undefined, T)).status === 403);
}
if (providers.includes('tavily')) {
  const u = await call('/api/admin/provider', { id: 'tavily', label: 'Tavily (renamed)' }, ADM);
  check('정의만 수정 (값 비움) → 기존 키 유지', u.status === 200 && u.j.provider.label === 'Tavily (renamed)' && (await call('/p/tavily/usage', undefined, T)).status === 200);
  await call('/api/admin/provider', { id: 'tavily', label: 'Tavily' }, ADM); // 이름 되돌리기
}
if (providers.includes('nvidia')) {
  check('공급자 삭제', (await call('/api/admin/provider-delete', { id: 'nvidia' }, ADM)).j?.ok === true);
  check('삭제된 공급자 즉시 404', (await call('/p/nvidia/v1/models', undefined, T)).status === 404);
  if (process.env.NVIDIA_API_KEY) await call('/api/admin/provider', { preset: 'nvidia', value: process.env.NVIDIA_API_KEY }, ADM);
}
check('가짜 토큰 아니면 401', (await call('/p/groq/openai/v1/models', undefined, { authorization: 'Bearer kvt_fake' })).status === 401);
check('범위 밖 공급자 403', (await call('/p/nope/x', undefined, T)).status === 403);

console.log('\n# 범위 제한 세션');
{
  const r = (await call('/api/borrow', {})).j;
  const oo = (await call(`/api/approve/${r.id}/options`, {})).j;
  const [only, out, onlyPath] = providers.includes('loc1') ? ['loc1', '/p/loc2/x', '/p/loc1/x'] : ['groq', '/p/openrouter/api/v1/key', '/p/groq/openai/v1/models'];
  await call(`/api/approve/${r.id}`, { assertion: key.get(oo), choice: { providers: [only], ttlHours: 1, budget: 1 } });
  const t = (await call(`/api/borrow/${r.id}/poll`, { secret: r.secret })).j.token;
  check(`${only} 전용 토큰으로 다른 공급자 403`, (await call(out, undefined, { authorization: `Bearer ${t}` })).status === 403);
  check('빌린 PC 에서 "다 썼어요"', (await call('/api/end', {}, { authorization: `Bearer ${t}` })).j?.ok === true);
  check('종료 후 즉시 401', (await call(onlyPath, undefined, { authorization: `Bearer ${t}` })).status === 401);
}

console.log('\n# 거절');
{
  const r = (await call('/api/borrow', {})).j;
  check('거절', (await call(`/api/approve/${r.id}/deny`, {})).j?.ok === true);
  check('빌린 PC 에 denied', (await call(`/api/borrow/${r.id}/poll`, { secret: r.secret })).j.status === 'denied');
}

console.log('\n# 자동 만료 (dev 전용 18초 TTL)');
if (process.env.SKIP_EXPIRY) console.log('       건너뜀 (SKIP_EXPIRY)');
else {
  const r = (await call('/api/borrow', {})).j;
  const oo = (await call(`/api/approve/${r.id}/options`, {})).j;
  const a = await call(`/api/approve/${r.id}`, { assertion: key.get(oo), choice: { providers: ['openrouter'], ttlHours: 0.005, budget: 1 } });
  const t = (await call(`/api/borrow/${r.id}/poll`, { secret: r.secret })).j.token;
  const ET = { authorization: `Bearer ${t}` };
  check('짧은 세션 동작', (await call('/p/openrouter/api/v1/key', undefined, ET)).status === 200);
  const ao = (await call('/api/admin/options', {})).j;
  const at = (await call('/api/admin/login', { assertion: key.get(ao) })).j.token;
  const expHash = (await call('/api/admin/list', {}, { 'x-admin-token': at })).j.sessions.find((s) => s.id === a.j.sessionId)?.orKeyHash;
  await new Promise((res) => setTimeout(res, 25_000));
  check('만료 후 401', (await call('/p/openrouter/api/v1/key', undefined, ET)).status === 401);
  if (expHash && process.env.OPENROUTER_MANAGEMENT_KEY) {
    const k = await fetch(`https://openrouter.ai/api/v1/keys/${expHash}`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY}` } });
    check('alarm 이 OpenRouter 서브키 삭제', k.status === 404, String(k.status));
  }
}

console.log('\n# 금고 (서버 쪽: 탭 검증·암호문 보관·복구 제한. 실제 암호화는 test/vault-browser.mjs)');
{
  const rb = () => b64u(randomBytes(32));
  const cli = (await call('/api/cli/login', {})).j;
  const co = (await call(`/api/approve/${cli.id}/options`, {})).j;
  await call(`/api/approve/${cli.id}`, { assertion: key.get(co), choice: {} });
  const cliTok = (await call(`/api/borrow/${cli.id}/poll`, { secret: cli.secret })).j.adminToken;
  check('CLI 관리 토큰으로는 키 등록 불가', (await call('/api/register/options', {}, { 'x-admin-token': cliTok })).status === 403);
  const lo = (await call('/api/admin/options', {})).j;
  const W = { 'x-admin-token': (await call('/api/admin/login', { assertion: key.get(lo) })).j.token };
  const pk = new SoftKey(); pk.prf = true;
  const ro = (await call('/api/register/options', {}, W)).j;
  check('등록 options 에 prf 확장', ro.extensions?.prf !== undefined, JSON.stringify(ro.extensions));
  const rv = (await call('/api/register/verify', { response: pk.create(ro), label: 'soft-prf' }, W)).j;
  check('웹 관리 로그인 직후 PRF 키 등록', rv?.ok && rv.prf === true, JSON.stringify(rv));
  const st = (await call('/api/vault/status', {})).j;
  check('상태: 금고 없음, PRF 키 1개', st.initialized === false && st.keys.filter((k) => k.prf).length === 1, JSON.stringify(st));
  const vo = (await call('/api/vault/options', {})).j;
  check('금고 options 는 PRF 키만', vo.allowCredentials.length === 1 && vo.allowCredentials[0].id === b64u(pk.id));
  const op = (await call('/api/vault/open', { assertion: pk.get(vo) })).j;
  check('금고 열기 (탭 검증 → 토큰, 감싼 키 없음)', !!op.token && op.initialized === false && op.wrap === null);
  const V = { 'x-admin-token': op.token };
  const rec = { salt: rb(), iter: 1_000_000, questions: ['q1', 'q2'], iv: rb(), ct: rb(), verifier: rb() };
  check('반복 횟수 적으면 거부', (await call('/api/vault/init', { credId: b64u(pk.id), wrap: { iv: rb(), ct: rb() }, rec: { ...rec, iter: 1000 } }, V)).status === 400);
  check('PRF 없는 키에 감싸기 거부', (await call('/api/vault/init', { credId: b64u(key.id), wrap: { iv: rb(), ct: rb() }, rec }, V)).status === 400);
  const wrap = { iv: rb(), ct: rb() };
  const made = (await call('/api/vault/init', { credId: b64u(pk.id), wrap, rec }, V)).j;
  const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/;
  check('금고 만들기 → 복구 코드 한 번', made?.ok === true && CODE_RE.test(made.recoveryCode ?? ''), JSON.stringify(made));
  let C = made?.recoveryCode;
  check('두 번 만들기 거부', (await call('/api/vault/init', { credId: b64u(pk.id), wrap, rec }, V)).status === 409);
  const item = { id: b64u(randomBytes(12)), iv: rb(), ct: rb(), policy: 'send' };
  check('항목 저장', (await call('/api/vault/item', { item }, V)).j?.item?.policy === 'send');
  check('토큰 없이 항목 저장 401', (await call('/api/vault/item', { item }, {})).status === 401);
  const vo2 = (await call('/api/vault/options', {})).j;
  const op2 = (await call('/api/vault/open', { assertion: pk.get(vo2) })).j;
  check('다시 열면 감싼 키·항목 암호문', op2.wrap?.ct === wrap.ct && op2.items.length === 1 && op2.items[0].ct === item.ct);
  const info = (await call('/api/vault/recover-info', {})).j;
  check('복구 정보에 질문·salt 만 (검증값·코드 없음), 코드 필요', info.questions.length === 2 && info.salt === rec.salt && !JSON.stringify(info).includes(rec.verifier)
    && !JSON.stringify(info).includes(C) && info.codeRequired === true && info.hasCode === true && info.left === 5, JSON.stringify(info));
  const left = async () => (await call('/api/vault/recover-info', {})).j.left;
  const recover = (b) => call('/api/vault/recover', b);
  const other = C.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  check('코드 없이 맞는 답 → 403', (await recover({ verifier: rec.verifier })).status === 403);
  check('틀린 코드 + 맞는 답 → 403', (await recover({ code: other, verifier: rec.verifier })).status === 403);
  check('없는·틀린 코드는 소유자 예산 안 씀 (남은 5)', (await left()) === 5);
  check('맞는 코드 + 틀린 답 → 403, 남은 4', (await recover({ code: C, verifier: rb() })).status === 403 && (await left()) === 4);
  const good = await recover({ code: C.toLowerCase().replace(/-/g, ' '), verifier: rec.verifier });
  check('맞는 코드(소문자·띄어쓰기) + 맞는 답 → 복구용 감싼 키 + 항목 + 새 코드', good.status === 200 && good.j.wrap?.ct === rec.ct && good.j.items.length === 1 && !good.j.token
    && CODE_RE.test(good.j.recoveryCode ?? '') && good.j.recoveryCode !== C, JSON.stringify(good.j).slice(0, 200));
  check('쓴 코드 다시 → 403', (await recover({ code: C, verifier: rec.verifier })).status === 403);
  C = good.j.recoveryCode;
  check('새 코드는 예산 새로 (남은 5)', (await left()) === 5);
  for (let i = 0; i < 5; i++) await recover({ code: C, verifier: rb() });
  check('이 코드로 24시간 5회 오답이면 잠김 (맞는 답도 429)', (await recover({ code: C, verifier: rec.verifier })).status === 429);
  check('복구 질문 바꾸면 잠금 풀림', (await call('/api/vault/recovery', { rec: { ...rec, verifier: rb() } }, V)).j?.ok === true
    && (await left()) === 5);
  // 빌린 PC 로 보내기 (서버는 중계·정책 검사만)
  check('공개키 없는 받기 요청 거부', (await call('/api/recv', { pub: 'x' })).status === 400);
  const rq = (await call('/api/recv', { pub: b64u(randomBytes(65)) })).j;
  check('받기 요청 → 승인 페이지는 금고로', (await call(`/api/approve/${rq.id}`)).j.kind === 'send');
  check('보내기 요청은 일반 승인으로 못 넘김', (await call(`/api/approve/${rq.id}`, { assertion: {}, choice: {} })).status === 400);
  const phoneOnly = { id: b64u(randomBytes(12)), iv: rb(), ct: rb(), policy: 'phone' };
  await call('/api/vault/item', { item: phoneOnly }, V);
  const box = { epk: rb(), iv: rb(), ct: rb() };
  check('폰 전용 항목 보내기 403', (await call('/api/vault/send', { id: rq.id, itemId: phoneOnly.id, box }, V)).status === 403);
  check('토큰 없이 보내기 401', (await call('/api/vault/send', { id: rq.id, itemId: item.id, box }, {})).status === 401);
  check('허용 항목 보내기', (await call('/api/vault/send', { id: rq.id, itemId: item.id, box }, V)).j?.ok === true);
  check('두 번 보내기 409', (await call('/api/vault/send', { id: rq.id, itemId: item.id, box }, V)).status === 409);
  const rp = (await call(`/api/borrow/${rq.id}/poll`, { secret: rq.secret })).j;
  check('PC 가 암호문 수령 (한 번만)', rp.status === 'approved' && rp.ct === box.ct && (await call(`/api/borrow/${rq.id}/poll`, { secret: rq.secret })).j.ct === undefined);
  await call('/api/vault/item-delete', { id: phoneOnly.id }, V);
  check('항목 삭제', (await call('/api/vault/item-delete', { id: item.id }, V)).j?.ok === true);
  await call('/api/admin/cred-delete', { id: b64u(pk.id) }, W);
  check('키 삭제하면 감싼 키도 삭제', (await call('/api/vault/status', {})).j.keys.every((k) => !k.linked));
}

console.log('\n# 관리');
{
  check('토큰 없이 목록 401', (await call('/api/admin/list', {})).status === 401);
  const oo = (await call('/api/admin/options', {})).j;
  const login = (await call('/api/admin/login', { assertion: key.get(oo) })).j;
  const A = { 'x-admin-token': login.token };
  const list = (await call('/api/admin/list', {}, A)).j;
  const mine = list.sessions.find((s) => s.id === got.sessionId);
  check('세션 목록에 보임, 비밀 필드 없음', !!mine && !('orKey' in mine) && !('tokenHash' in mine));
  check('감사 로그', list.audit.some((x) => x.event === 'approve'));
  const orHash = mine?.orKeyHash;
  const rv = (await call('/api/admin/revoke', { target: 'all' }, A)).j;
  check('전부 끊기', rv.ok && rv.revoked >= 1 && rv.cleaned === rv.revoked, JSON.stringify(rv));
  check('끊은 뒤 프록시 401', (await call('/p/groq/openai/v1/models', undefined, T)).status === 401);
  if (orHash && process.env.OPENROUTER_MANAGEMENT_KEY) {
    const r = await fetch(`https://openrouter.ai/api/v1/keys/${orHash}`, { headers: { authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY}` } });
    check('OpenRouter 서브키 실제 삭제됨', r.status === 404, String(r.status));
  }
  const creds = (await call('/api/admin/list', {}, A)).j.creds;
  for (const c of creds) await call('/api/admin/cred-delete', { id: c.id }, A); // 테스트 키 정리
}

console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
