import type { Env } from './state';

/** Exact, explicitly configured Cloudbite alias. Never accept a Host/Origin supplied by the caller as configuration. */
export function cloudbiteIdentity(env: Env, origin: string = env.ORIGIN) {
  if (origin === env.ORIGIN) return { origin, rpId: env.RP_ID };
  const alias = env.CLOUDBITE_PUBLIC_ORIGIN;
  if (!alias || origin !== alias) return null;
  try {
    const u = new URL(alias);
    if (u.protocol !== 'https:' || u.origin !== alias || u.username || u.password) return null;
    // Related Origin Requests: retain the original RP so existing USB/NFC credentials work on both sites.
    // The original RP publishes this alias at /.well-known/webauthn; unsupported browsers retain the old URL.
    return { origin: alias, rpId: env.RP_ID };
  } catch { return null; }
}

/** The custom hostname exposes Cloudbite and its security-key registration, not the inherited classroom/vault. */
export function cloudbiteAliasPath(path: string) {
  return path === '/' || path === '/register' || path === '/webauthn.js' || path === '/cloudbite' || path.startsWith('/cloudbite/') ||
    path.startsWith('/api/cloudbite/') || path === '/api/register/options' || path === '/api/register/verify';
}
