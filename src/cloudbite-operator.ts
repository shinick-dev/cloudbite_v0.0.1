// Temporary Cloudbite operator bearer (docs/cloudbite/temporary-operator.txt). The owner issues it for 8 hours when the
// security key is out of reach. It is accepted ONLY by POST /api/cloudbite/projects in place of a State admin session;
// it never reaches State and never opens /api/admin, the vault, QR approvals or participant workspaces.
// Secrets: CLOUDBITE_OPERATOR_TOKEN_HASH = lowercase hex SHA-256 of the full token text (`cbo_…`),
// CLOUDBITE_OPERATOR_EXPIRES_AT = epoch milliseconds. Anything missing, malformed or past expiry fails closed.
// @ts-ignore — nodejs_compat provides node:crypto at runtime; this repo carries no @types/node
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import type { Env } from './state';

const timingSafeEqual = nodeTimingSafeEqual as (a: Uint8Array, b: Uint8Array) => boolean;

export const CB_OPERATOR_PREFIX = 'cbo_';
/** cbo_ + canonical unpadded base64url of exactly 32 random bytes (the 43rd character carries only 4 bits). */
export const CB_OPERATOR_TOKEN = /^cbo_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const EPOCH_MS = /^[1-9][0-9]{0,15}$/;

type OperatorEnv = Pick<Env, 'CLOUDBITE_OPERATOR_TOKEN_HASH' | 'CLOUDBITE_OPERATOR_EXPIRES_AT'>;

/** The configured expiry if both secrets are well-formed, otherwise null. Never returns or logs the hash. */
export function cloudbiteOperatorExpiry(env: OperatorEnv): number | null {
  const hash = env.CLOUDBITE_OPERATOR_TOKEN_HASH, exp = env.CLOUDBITE_OPERATOR_EXPIRES_AT;
  if (typeof hash !== 'string' || !HASH_HEX.test(hash) || typeof exp !== 'string' || !EPOCH_MS.test(exp)) return null;
  const at = Number(exp);
  return Number.isSafeInteger(at) ? at : null;
}

/** true only for a well-formed, unexpired token whose SHA-256 equals the configured hash (constant-time compare). */
export async function verifyCloudbiteOperator(env: OperatorEnv, token: string, now = Date.now()): Promise<boolean> {
  const expiresAt = cloudbiteOperatorExpiry(env);
  if (expiresAt === null || now >= expiresAt || !CB_OPERATOR_TOKEN.test(token)) return false;
  const want = new Uint8Array(32);
  const hex = env.CLOUDBITE_OPERATOR_TOKEN_HASH!;
  for (let i = 0; i < 32; i++) want[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const got = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return got.length === want.length && timingSafeEqual(got, want);
}
