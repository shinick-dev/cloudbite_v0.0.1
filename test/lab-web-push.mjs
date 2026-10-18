// 강사용 Web Push 핵심(src/lab-web-push.ts) 단위 테스트. 설치된 esbuild 로 번들해 그대로 부른다.
// 네트워크·실제 구독·브라우저 권한·비밀 값 없음 — fetch 는 막고, 보내기는 가짜 fetch 로만 확인한다.
// 확인하는 것: RFC 8291 부록 예시와 바이트 단위 일치, node:crypto 로 따로 짠 수신자 복호화,
//              VAPID JWT 를 공개키로 따로 검증, 구독·키·엔드포인트 거부, 상태 분류, 시간 제한, 리다이렉트 안 따름,
//              결과·오류·로그에 비밀 없음.
//   node test/lab-web-push.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as nodeCrypto from 'node:crypto';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({ entryPoints: [join(ROOT, 'src/lab-web-push.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'lab-push-'));
writeFileSync(join(dir, 'push.mjs'), bundled.outputFiles[0].text);
let M;
try { M = await import(pathToFileURL(join(dir, 'push.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const {
  parsePushSubscription, isAllowedPushEndpoint, importVapidKey, vapidPublicKey, createVapidAuthorization,
  encodeLabPushPayload, encryptWebPush, encryptWebPushWithEntropy, sendPush, classifyPushStatus,
  VAPID_SUBJECT, VAPID_TOKEN_TTL_SEC, PUSH_SEND_TIMEOUT_MS, PUSH_PLAINTEXT_MAX,
} = M;

globalThis.fetch = async (u) => { throw new Error(`network blocked in test: ${u}`); };
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { if (!String(a[0]).startsWith('  ok') && !String(a[0]).startsWith('  FAIL') && !String(a[0]).startsWith('lab-web-push')) logged.push(a.join(' ')); orig(...a); };
}

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); }
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

// ---- RFC 8291 §5 / 부록 A 값 (공개 예시 키 — 실제 구독 아님) ----
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow — RFC 8291 공개 예시 auth secret (비밀 아님): https://www.rfc-editor.org/rfc/rfc8291#section-5 (값은 부록 A)
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`.replace(/\s+/g, ''),
};
const FCM = 'https://fcm.googleapis.com/fcm/send/fake-token-for-tests';
const rfcSub = { endpoint: FCM, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

/** node:crypto 로 따로 구현한 RFC 8291 수신자 (WebCrypto 코드와 공유하는 것 없음). */
function receiverDecrypt(body, uaPrivateB64u, uaPublicB64u, authB64u) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(uaPrivateB64u));
  const secret = ecdh.computeSecret(asPublic);
  const uaPublic = unb64u(uaPublicB64u);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', secret, unb64u(authB64u), keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = rec.length - 1;
  while (end >= 0 && rec[end] === 0) end--;
  return { salt, rs, idlen, asPublic, delimiter: rec[end], plaintext: rec.subarray(0, end), recordLen: ct.length };
}

console.log('lab-web-push: RFC 8291 known vector');
{
  const asPub = unb64u(RFC.asPublic);
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u(asPub.subarray(1, 33)), y: b64u(asPub.subarray(33)), d: RFC.asPrivate }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const out = await encryptWebPushWithEntropy(rfcSub, new TextEncoder().encode(RFC.plaintext), { salt: new Uint8Array(unb64u(RFC.salt)), ephemeral: { publicKey: pub, privateKey: priv } });
  // §5 의 'Content-Length: 145' 는 본문(86 + 41 + 1 + 16 = 144 옥텟)과 맞지 않는다 — 본문 바이트를 기준으로 비교한다.
  check('RFC 8291 §5 body byte-identical (144 octets)', b64u(out) === RFC.body && out.length === 144, b64u(out));
  const r = receiverDecrypt(Buffer.from(unb64u(RFC.body)), RFC.uaPrivate, RFC.uaPublic, RFC.auth);
  check('independent receiver decrypts the RFC body', r.plaintext.toString() === RFC.plaintext && r.delimiter === 2 && r.rs === 4096 && r.idlen === 65);
}

console.log('lab-web-push: random encryption, independent receiver');
{
  const msg = encodeLabPushPayload({ title: '학생 도움 요청', body: '실습실을 확인하세요', tag: 'lab-help' });
  const a = Buffer.from(await encryptWebPush(rfcSub, msg));
  const b = Buffer.from(await encryptWebPush(rfcSub, msg));
  const ra = receiverDecrypt(a, RFC.uaPrivate, RFC.uaPublic, RFC.auth);
  const rb = receiverDecrypt(b, RFC.uaPrivate, RFC.uaPublic, RFC.auth);
  check('decrypts to exact payload JSON', ra.plaintext.equals(Buffer.from(msg)) && JSON.parse(ra.plaintext).url === '/lab');
  check('header rs=4096 idlen=65 uncompressed as_public, delimiter 0x02, single record', ra.rs === 4096 && ra.idlen === 65 && ra.asPublic[0] === 4 && ra.delimiter === 2 && ra.recordLen === msg.length + 1 + 16);
  check('fresh salt and ephemeral key per message', !ra.salt.equals(rb.salt) && !ra.asPublic.equals(rb.asPublic) && !a.equals(b));
  check('body well below 4096', a.length < 4096 && a.length === 86 + msg.length + 17);
  let tamper = false;
  try { const t = Buffer.from(a); t[t.length - 1] ^= 1; receiverDecrypt(t, RFC.uaPrivate, RFC.uaPublic, RFC.auth); } catch { tamper = true; }
  check('tampered ciphertext rejected by receiver', tamper);
  let wrongAuth = false;
  try { receiverDecrypt(a, RFC.uaPrivate, RFC.uaPublic, b64u(Buffer.alloc(16, 7))); } catch { wrongAuth = true; }
  check('wrong auth secret cannot decrypt', wrongAuth);
  let big = '';
  try { await encryptWebPush(rfcSub, new Uint8Array(PUSH_PLAINTEXT_MAX + 1)); } catch (e) { big = e.message; }
  check('oversized plaintext refused', big === 'web push: payload too large');
  let badKeys = '';
  try { await encryptWebPush({ endpoint: FCM, keys: { p256dh: RFC.uaPublic.slice(0, -1) + 'A', auth: RFC.auth } }, msg); } catch (e) { badKeys = e.message; }
  check('invalid ua key refused with fixed message', badKeys === 'web push: invalid subscription keys');
}

console.log('lab-web-push: parsePushSubscription');
{
  const ok = await parsePushSubscription({ endpoint: FCM, expirationTime: 123, keys: { p256dh: RFC.uaPublic, auth: RFC.auth, extra: 'x' }, other: 1 });
  check('browser toJSON accepted, canonical shape only', JSON.stringify(ok) === JSON.stringify(rfcSub), ok);
  for (const ep of [
    'https://fcm.googleapis.com/wp/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtoken',
    'https://web.push.apple.com/QGuQyavXutnMH9oNZJdDx4fF?x=1',
  ]) check(`allowed endpoint ${new URL(ep).hostname}`, (await parsePushSubscription({ endpoint: ep, keys: rfcSub.keys }))?.endpoint === ep);
  const badEndpoints = [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://user:pw@fcm.googleapis.com/fcm/send/x',
    'https://user@fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:443/fcm/send/x',
    'https://fcm.googleapis.com:8443/fcm/send/x',
    'https://fcm.googleapis.com/fcm/send/x#frag',
    'https://fcm.googleapis.com/fcm/send/x#',
    'https://fcm.googleapis.com/',
    'https://fcm.googleapis.com',
    'https://FCM.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com./fcm/send/x',
    'https://fcm.googleapis.com.evil.example/fcm/send/x',
    'https://evilfcm.googleapis.com/fcm/send/x',
    'https://sub.fcm.googleapis.com/fcm/send/x',
    'https://evil.example/https://fcm.googleapis.com/x',
    'https://evil.example/?u=fcm.googleapis.com',
    'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://169.254.169.254/x',
    'https://push.example.net/push/x',
    ' https://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com/fcm/send/x\n',
    'https://fcm.googleapis.com\\fcm/send/x',
    'https://fcm.googleapis.com/fcm/../send/x',
    'wss://fcm.googleapis.com/x', 'data:text/plain,x', '//fcm.googleapis.com/x', '/fcm/send/x', '',
    'https://fcm.googleapis.com/' + 'a'.repeat(2048),
  ];
  let allBad = true;
  for (const ep of badEndpoints) {
    if (isAllowedPushEndpoint(ep) || await parsePushSubscription({ endpoint: ep, keys: rfcSub.keys })) { allBad = false; console.log('    accepted:', JSON.stringify(ep)); }
  }
  check(`${badEndpoints.length} hostile/non-canonical endpoints rejected`, allBad);
  check('endpoint length boundary 2048 ok / 2049 refused',
    isAllowedPushEndpoint(FCM.slice(0, 27) + 'a'.repeat(2048 - 27)) && !isAllowedPushEndpoint(FCM.slice(0, 27) + 'a'.repeat(2049 - 27)));

  const uaRaw = unb64u(RFC.uaPublic);
  const offCurve = Buffer.from(uaRaw); offCurve[64] ^= 1;
  const compressed = Buffer.concat([Buffer.from([2 + (uaRaw[64] & 1)]), uaRaw.subarray(1, 33)]);
  const xTooBig = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 0xff), uaRaw.subarray(33)]);
  const nonCanonAuth = RFC.auth.slice(0, -1) + String.fromCharCode(RFC.auth.charCodeAt(RFC.auth.length - 1) + 1); // 남는 비트가 0 이 아님
  const badKeys = [
    { p256dh: b64u(offCurve), auth: RFC.auth },
    { p256dh: b64u(compressed), auth: RFC.auth },
    { p256dh: b64u(xTooBig), auth: RFC.auth },
    { p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)])), auth: RFC.auth },
    { p256dh: b64u(uaRaw.subarray(0, 64)), auth: RFC.auth },
    { p256dh: RFC.uaPublic + '=', auth: RFC.auth },
    { p256dh: Buffer.from(uaRaw).toString('base64'), auth: RFC.auth },
    { p256dh: RFC.uaPublic, auth: b64u(Buffer.alloc(15, 1)) },
    { p256dh: RFC.uaPublic, auth: b64u(Buffer.alloc(17, 1)) },
    { p256dh: RFC.uaPublic, auth: RFC.auth + '==' },
    { p256dh: RFC.uaPublic, auth: nonCanonAuth },
    { p256dh: RFC.uaPublic },
    { p256dh: 42, auth: RFC.auth },
  ];
  let keysBad = true;
  for (const keys of badKeys) if (await parsePushSubscription({ endpoint: FCM, keys })) { keysBad = false; console.log('    accepted keys:', JSON.stringify(keys)); }
  check(`${badKeys.length} invalid p256dh/auth rejected (curve, length, encoding)`, keysBad);
  const junk = [null, undefined, 1, 'x', [], [rfcSub], { endpoint: FCM }, { endpoint: FCM, keys: [] }, { endpoint: FCM, keys: null }, { keys: rfcSub.keys }, { endpoint: new URL(FCM), keys: rfcSub.keys }];
  let junkBad = true;
  for (const j of junk) if (await parsePushSubscription(j)) junkBad = false;
  check('non-object / missing-field inputs rejected', junkBad);
}

console.log('lab-web-push: VAPID key');
const gen = () => nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const jwk = gen(); // 테스트 안에서만 만든 일회용 키
const other = gen();
let key;
{
  key = await importVapidKey(JSON.stringify(jwk));
  const expectPub = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  check('JSON secret imports, publicKey = 0x04||x||y', key && key.publicKey === expectPub);
  check('object secret imports too', (await importVapidKey(jwk))?.publicKey === expectPub);
  check('vapidPublicKey derives applicationServerKey', (await vapidPublicKey(JSON.stringify(jwk))) === expectPub);
  check('private key non-extractable and not serialized', key.privateKey.extractable === false && !JSON.stringify(key).includes(jwk.d) && Object.isFrozen(key));
  const n = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
  const bad = [
    { ...jwk, x: other.x, y: other.y },
    { ...jwk, d: other.d },
    { ...jwk, d: b64u(Buffer.alloc(32)) },
    { ...jwk, d: b64u(Buffer.from(n, 'hex')) },
    { ...jwk, d: b64u(Buffer.alloc(32, 0xff)) },
    { ...jwk, y: b64u(Buffer.from(unb64u(jwk.y)).map((v, i) => (i === 31 ? v ^ 1 : v))) },
    { ...jwk, x: jwk.x + '=' },
    { ...jwk, d: b64u(Buffer.concat([Buffer.alloc(1), unb64u(jwk.d)])) },
    { ...jwk, crv: 'P-384' },
    { ...jwk, kty: 'RSA' },
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    'not json', '{"kty":"EC"', JSON.stringify(jwk) + ' '.repeat(1100), null, 7, [],
  ];
  let allNull = true;
  for (const b of bad) if (await importVapidKey(b)) { allNull = false; console.log('    accepted:', JSON.stringify(b).slice(0, 80)); }
  check(`${bad.length} invalid / mismatched VAPID secrets rejected`, allNull);
}

console.log('lab-web-push: VAPID Authorization (RFC 8292)');
{
  const now = 1_790_000_000_123;
  const h = await createVapidAuthorization(FCM, key, now);
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(h ?? '');
  check('header shape vapid t=<jwt>, k=<key>', !!m, h);
  const [, eh, ep, es, k] = m;
  const header = JSON.parse(unb64u(eh)), claims = JSON.parse(unb64u(ep)), sig = unb64u(es);
  check('JWT header {typ:JWT, alg:ES256}', header.typ === 'JWT' && header.alg === 'ES256' && Object.keys(header).length === 2);
  check('aud = endpoint origin, sub fixed https', claims.aud === 'https://fcm.googleapis.com' && claims.sub === VAPID_SUBJECT && VAPID_SUBJECT === 'https://k.shinick.dev/lab');
  check('exp = now + 1h, within 24h', claims.exp === Math.floor(now / 1000) + 3600 && VAPID_TOKEN_TTL_SEC <= 86400 && Object.keys(claims).length === 3);
  check('k is the applicationServerKey', k === key.publicKey);
  const pubKey = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  check('ES256 signature is raw P1363 64 bytes', sig.length === 64);
  check('node:crypto verifies JWT with public key k', nodeCrypto.verify('sha256', Buffer.from(`${eh}.${ep}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, sig));
  const otherPub = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: other.x, y: other.y }, format: 'jwk' });
  check('signature does not verify under another key', !nodeCrypto.verify('sha256', Buffer.from(`${eh}.${ep}`), { key: otherPub, dsaEncoding: 'ieee-p1363' }, sig));
  const moz = await createVapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/t?x=1', key, now);
  check('aud excludes path/query', JSON.parse(unb64u(moz.split('.')[1])).aud === 'https://updates.push.services.mozilla.com');
  check('disallowed endpoint / bad time → null', (await createVapidAuthorization('https://evil.example/x', key, now)) === null && (await createVapidAuthorization(FCM, key, NaN)) === null);
}

console.log('lab-web-push: payload');
{
  check('generic payload ok, url defaults /lab', JSON.parse(new TextDecoder().decode(encodeLabPushPayload({ title: '도움 요청', body: '' }))).url === '/lab');
  const bad = [
    { title: '', body: '' }, { title: 'x'.repeat(65), body: '' }, { title: 't', body: 'x'.repeat(161) },
    { title: 'a\nb', body: '' }, { title: 't', body: 'x\u0000' }, { title: 't', body: '', url: '/lab?invite=abc' },
    { title: 't', body: '', url: 'https://evil.example/lab' }, { title: 't', body: '', tag: 'Bad Tag' }, { title: 7, body: '' }, null,
  ];
  check(`${bad.length} non-generic payloads refused`, bad.every((p) => encodeLabPushPayload(p) === null));
}

console.log('lab-web-push: sendPush transport');
{
  const calls = [];
  const fakeFetch = (status, extra = {}) => async (url, init) => {
    calls.push({ url, init });
    let pulled = false, cancelled = false;
    const body = new ReadableStream({ pull() { pulled = true; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const res = new Response(status === 0 ? null : body, { status: status || 200, ...extra });
    if (status === 0) Object.defineProperty(res, 'type', { value: 'opaqueredirect' }), Object.defineProperty(res, 'status', { value: 0 });
    calls.at(-1).stream = () => ({ pulled, cancelled });
    return res;
  };
  const now = 1_790_000_000_000;
  const r = await sendPush(rfcSub, key, { title: '도움 요청', body: '실습실 확인' }, { fetch: fakeFetch(201), now });
  const c = calls[0];
  check('accepted 201, one fetch', r.outcome === 'accepted' && r.status === 201 && calls.length === 1);
  check('POST to exact endpoint, redirect manual (Workers has no redirect:error), abort signal', c.url === FCM && c.init.method === 'POST' && c.init.redirect === 'manual' && c.init.signal instanceof AbortSignal);
  const hd = c.init.headers;
  check('headers: aes128gcm, octet-stream, TTL 60, Urgency normal, vapid auth', hd['Content-Encoding'] === 'aes128gcm' && hd['Content-Type'] === 'application/octet-stream' && hd.TTL === '60' && hd.Urgency === 'normal' && hd.Authorization.startsWith('vapid t=') && hd.Authorization.endsWith(`, k=${key.publicKey}`));
  // 리다이렉트: Location 이 있어도 따라가지 않는다 — fetch 는 정확히 한 번, 결과는 failed.
  let redirectOk = true;
  for (const s of [301, 302, 303, 307, 308]) {
    const seen = [];
    const res = await sendPush(rfcSub, key, { title: 't', body: '' }, { now, fetch: async (url, init) => { seen.push({ url, redirect: init.redirect }); return new Response(null, { status: s, headers: { Location: 'https://evil.example/steal' } }); } });
    if (res.outcome !== 'failed' || res.status !== s || seen.length !== 1 || seen[0].url !== FCM || seen[0].redirect !== 'manual') { redirectOk = false; console.log('    redirect', s, res, seen); }
  }
  check('3xx with Location → failed, never followed (single fetch to original endpoint)', redirectOk);
  const dec = receiverDecrypt(Buffer.from(c.init.body), RFC.uaPrivate, RFC.uaPublic, RFC.auth);
  check('sent body decrypts independently to generic /lab payload', JSON.stringify(JSON.parse(dec.plaintext)) === JSON.stringify({ title: '도움 요청', body: '실습실 확인', url: '/lab' }));
  check('response body cancelled, never read', c.stream().cancelled && !c.stream().pulled);

  const expect = { 200: 'accepted', 202: 'accepted', 404: 'gone', 410: 'gone', 429: 'retryable', 500: 'retryable', 503: 'retryable', 408: 'retryable', 400: 'failed', 401: 'failed', 403: 'failed', 413: 'failed', 301: 'failed', 302: 'failed', 307: 'failed' };
  let mapped = true;
  for (const [s, o] of Object.entries(expect)) {
    const res = await sendPush(rfcSub, key, { title: 't', body: '' }, { fetch: fakeFetch(Number(s)), now });
    if (res.outcome !== o || res.status !== Number(s)) { mapped = false; console.log('    status', s, res); }
  }
  check('status classification (2xx/404,410/429,408,5xx/other,3xx)', mapped);
  const opq = await sendPush(rfcSub, key, { title: 't', body: '' }, { fetch: fakeFetch(0), now });
  check('opaqueredirect → failed without status', opq.outcome === 'failed' && !('status' in opq));
  check('classifyPushStatus garbage → failed', classifyPushStatus(NaN).outcome === 'failed' && !('status' in classifyPushStatus(NaN)));

  const before = calls.length;
  const thrown = await sendPush(rfcSub, key, { title: 't', body: '' }, { fetch: async () => { throw new Error(`boom ${jwk.d}`); }, now });
  check('fetch error → retryable, no message leaked', thrown.outcome === 'retryable' && Object.keys(thrown).length === 1);
  const inv = await sendPush({ endpoint: 'https://evil.example/x', keys: rfcSub.keys }, key, { title: 't', body: '' }, { fetch: fakeFetch(201), now });
  const invPayload = await sendPush(rfcSub, key, { title: 't', body: '', url: '/lab?code=1' }, { fetch: fakeFetch(201), now });
  check('invalid subscription / payload → failed, no fetch', inv.outcome === 'failed' && invPayload.outcome === 'failed' && calls.length === before);

  // 시간 제한: 끝나지 않는 fetch
  let aborted = false;
  const hang = (url, init) => new Promise(() => { init.signal.addEventListener('abort', () => { aborted = true; }); });
  const t0 = Date.now();
  const to = await sendPush(rfcSub, key, { title: 't', body: '' }, { fetch: hang, now, timeoutMs: 50 });
  check('hanging fetch → retryable after timeout, signal aborted', to.outcome === 'retryable' && aborted && Date.now() - t0 < 2000);
  const origST = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return origST(fn, 0, ...a); };
  try { await sendPush(rfcSub, key, { title: 't', body: '' }, { fetch: hang, now, timeoutMs: 600_000 }); }
  finally { globalThis.setTimeout = origST; }
  check('timeout clamped to ≤ 10s', delays.length === 1 && delays[0] === PUSH_SEND_TIMEOUT_MS && PUSH_SEND_TIMEOUT_MS <= 10_000, delays);

  const blocked = await sendPush(rfcSub, key, { title: 't', body: '' }, { now });
  check('default fetch path (blocked here) → retryable, no throw', blocked.outcome === 'retryable');

  const all = JSON.stringify([r, opq, thrown, inv, to, blocked]);
  check('results contain no key/auth material', !all.includes(jwk.d) && !all.includes(RFC.auth) && !all.includes(key.publicKey));
  await sendPush(rfcSub,key,{title:'t',body:''},{now,fetch:fakeFetch(201),ttlSeconds:3600});
  check('request notification may stay at push service for one hour',calls.at(-1).init.headers.TTL==='3600');
  const ttls=[];
  for(const ttlSeconds of [0,-1,3601,NaN,1.5,'3600']){await sendPush(rfcSub,key,{title:'t',body:''},{now,ttlSeconds,fetch:async(_,init)=>{ttls.push(init.headers.TTL);return new Response(null,{status:201})}})}
  check('invalid TTL never extends the allowed window',ttls.every(x=>x==='60'));
}

console.log('lab-web-push: beforeSend (after crypto, immediately before fetch)');
{
  const now = 1_790_000_000_000;
  const order = [];
  const origSign = crypto.subtle.sign.bind(crypto.subtle);
  const origEnc = crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.sign = async (...a) => { order.push('sign'); return origSign(...a); };
  crypto.subtle.encrypt = async (...a) => { order.push('encrypt'); return origEnc(...a); };
  let fetched = 0;
  const f = async () => { order.push('fetch'); fetched++; return new Response(null, { status: 201 }); };
  try {
    const ok = await sendPush(rfcSub, key, { title: 't', body: '' }, { now, fetch: f, beforeSend: async () => { order.push('check'); return true; } });
    const iCheck = order.indexOf('check');
    check('beforeSend true → sent; check runs after encrypt+sign, right before fetch',
      ok.outcome === 'accepted' && fetched === 1 && iCheck > order.lastIndexOf('encrypt') && iCheck > order.lastIndexOf('sign') && order[iCheck + 1] === 'fetch', order);
    // 경쟁: 암호화 중에 권한이 사라짐 → 재확인이 막고 fetch 0
    let revoked = false;
    order.length = 0; fetched = 0;
    crypto.subtle.encrypt = async (...a) => { revoked = true; return origEnc(...a); };
    const raced = await sendPush(rfcSub, key, { title: 't', body: '' }, { now, fetch: f, beforeSend: async () => !revoked });
    check('revoked during crypto → failed, zero fetch', raced.outcome === 'failed' && fetched === 0 && Object.keys(raced).length === 1);
    crypto.subtle.encrypt = async (...a) => origEnc(...a);
    const thrown = await sendPush(rfcSub, key, { title: 't', body: '' }, { now, fetch: f, beforeSend: async () => { throw new Error(`x ${jwk.d}`); } });
    const truthy = await sendPush(rfcSub, key, { title: 't', body: '' }, { now, fetch: f, beforeSend: async () => 'yes' });
    check('beforeSend throw / non-true → failed, zero fetch, nothing leaked', thrown.outcome === 'failed' && truthy.outcome === 'failed' && fetched === 0 && !JSON.stringify([thrown, truthy]).includes(jwk.d));
    let called = 0;
    const badSub = await sendPush({ endpoint: 'https://evil.example/x', keys: rfcSub.keys }, key, { title: 't', body: '' }, { now, fetch: f, beforeSend: async () => { called++; return true; } });
    check('invalid input fails before beforeSend (never authorizes a bad request)', badSub.outcome === 'failed' && called === 0 && fetched === 0);
  } finally {
    crypto.subtle.sign = origSign; crypto.subtle.encrypt = origEnc;
  }
}

check('module logged nothing', logged.length === 0, logged);
console.log(`\nlab-web-push: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
