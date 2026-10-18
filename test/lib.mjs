// 테스트 공용: wrangler dev 호출 + 소프트웨어 인증기(P-256) + CLI 관리 로그인
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

export const GW = process.env.GW ?? 'http://localhost:8797';
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

let pass = 0, failN = 0;
export const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
export const finish = () => { console.log(`\n${pass} passed, ${failN} failed\n`); process.exit(failN ? 1 : 0); };

export async function call(path, body, headers = {}, base = GW) {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: GW, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

export class SoftKey {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x, 'base64url');
    this.y = Buffer.from(jwk.y, 'base64url');
    this.id = randomBytes(16);
    this.counter = 0;
  }
  clientData(type, challenge) { return Buffer.from(JSON.stringify({ type, challenge, origin: GW, crossOrigin: false })); }
  create(opts) {
    const cdj = this.clientData('webauthn.create', opts.challenge);
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(opts.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.id, Buffer.from(isoCBOR.encode(cose))]);
    const att = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att), transports: ['usb', 'nfc'] },
      clientExtensionResults: {}, authenticatorAttachment: 'cross-platform',
    };
  }
  get(opts) {
    const cdj = this.clientData('webauthn.get', opts.challenge);
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(opts.rpId), Buffer.from([0x05]), ctr]);
    const sig = sign('sha256', Buffer.concat([authData, sha256(cdj)]), this.priv);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(authData), signature: b64u(sig) },
      clientExtensionResults: {},
    };
  }
}

/** SETUP_TOKEN 으로 키 등록 → CLI 관리 로그인. 관리 토큰 헤더를 돌려준다 */
export async function adminSetup(key, setup) {
  const o = await call('/api/register/options', { setup });
  const v = await call('/api/register/verify', { setup, response: key.create(o.j), label: 'soft' });
  if (!v.j?.ok) throw new Error('register failed: ' + JSON.stringify(v.j));
  return adminLogin(key);
}
export async function adminLogin(key) {
  const l = (await call('/api/cli/login', {})).j;
  const lo = (await call(`/api/approve/${l.id}/options`, {})).j;
  await call(`/api/approve/${l.id}`, { assertion: key.get(lo), choice: {} });
  const p = (await call(`/api/borrow/${l.id}/poll`, { secret: l.secret })).j;
  return { 'x-admin-token': p.adminToken };
}
