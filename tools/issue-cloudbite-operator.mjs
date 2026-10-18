// Run locally by the owner. Never put generated bearer files in public assets.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { encode } from 'uqr';

const dir = fileURLToPath(new URL('../.artifacts/production/', import.meta.url));
const secretsPath = dir + 'secrets.json';
if (!process.argv.includes('--issue')) throw new Error('Use --issue after protecting .artifacts/production with an owner-only filesystem ACL.');
if (!existsSync(secretsPath)) throw new Error('Expected protected production secrets.json; issuance does not create provider credentials.');
if (existsSync(dir + 'operator-access.html') && !process.argv.includes('--rotate')) throw new Error('Credential exists. Use --rotate intentionally, then redeploy the hash and expiry.');
const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
const token = 'cbo_' + randomBytes(32).toString('base64url');
const expiresAt = Date.now() + 8 * 3600_000;
const href = 'https://cloudbite-v001.ai-gongbu.workers.dev/#operator=' + token;
secrets.CLOUDBITE_OPERATOR_TOKEN_HASH = createHash('sha256').update(token).digest('hex');
secrets.CLOUDBITE_OPERATOR_EXPIRES_AT = String(expiresAt);

// Actual PNG QR; no third-party QR service receives the private credential.
const qr = encode(href, { ecc: 'M', border: 4 });
const scale = 12, width = qr.size * scale;
const raw = Buffer.alloc((width * 3 + 1) * width);
for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
  const color = qr.data[Math.floor(y / scale)][Math.floor(x / scale)] ? 16 : 255;
  for (let c = 0; c < 3; c++) raw[y * (width * 3 + 1) + 1 + x * 3 + c] = color;
}
function crc32(b) { let n = 0xffffffff; for (const v of b) { n ^= v; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), data.length + 8); return out; }
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const expiry = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'long' }).format(expiresAt);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Cloudbite · Private operator access</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fc;color:#142440;font:16px/1.6 'Segoe UI',sans-serif}main{max-width:600px;margin:48px auto;padding:28px;background:white;border:1px solid #dbe6f5;border-radius:16px}h1{font-size:28px;margin:8px 0 16px}.tag{font-size:12px;font-weight:bold;color:#2563eb}a{display:block;text-align:center;background:#2563eb;color:white;border-radius:8px;padding:14px;text-decoration:none;font-weight:bold}img{display:block;width:min(100%,360px);height:auto;margin:24px auto}small{display:block;color:#52647b}p{margin:16px 0}</style><main><div class="tag">PRIVATE · OWNER ONLY</div><h1>Cloudbite operator access</h1><p>Open on this computer, or scan with your phone. No physical security key is required for this temporary Cloudbite credential.</p><a href="${href}" rel="noreferrer noopener" target="_blank">Open Cloudbite</a><img src="data:image/png;base64,${png.toString('base64')}" alt="Private Cloudbite operator sign-in QR"><p><strong>Expires: ${expiry}</strong></p><small>This file and QR grant Cloudbite project creation to whoever possesses them. Keep them private. Select experts and click Run experts to start; opening the link does not start paid work. This does not unlock the existing studyroom request inbox or change its security-key approval.</small></main></html>`;
writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
writeFileSync(dir + 'operator-token.txt', token, { mode: 0o600 });
writeFileSync(dir + 'operator-access.html', html, { mode: 0o600 });
writeFileSync(dir + 'operator-access.png', png, { mode: 0o600 });
writeFileSync(dir + 'operator-expiry.json', JSON.stringify({ expiresAt, expiresAtSeoul: expiry }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ accessFile: dir + 'operator-access.html', qrFile: dir + 'operator-access.png', expiresAtSeoul: expiry, next: 'Deploy code and protected secrets.json together before opening the private file.' }));
