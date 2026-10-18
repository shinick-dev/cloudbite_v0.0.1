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
    // The original RP publishes this alias at /.well-known/webauthn; browsers must support related origins.
    return { origin: alias, rpId: env.RP_ID };
  } catch { return null; }
}

/** The custom hostname exposes Cloudbite and its security-key registration, not the inherited classroom/vault. */
export function cloudbiteAliasPath(path: string) {
  return path === '/' || path === '/register' || path === '/webauthn.js' || path === '/cloudbite' || path.startsWith('/cloudbite/') ||
    path.startsWith('/api/cloudbite/') || path === '/api/register/options' || path === '/api/register/verify';
}

/** Retire the old public app without disabling the RP document or breaking active sandbox callbacks. */
export function retiredCloudbiteOrigin(req: Request, env: Env): Response | null {
  if (env.CLOUDBITE_CANONICAL_ONLY !== '1') return null;
  const alias = env.CLOUDBITE_PUBLIC_ORIGIN && cloudbiteIdentity(env, env.CLOUDBITE_PUBLIC_ORIGIN);
  const url = new URL(req.url);
  if (!alias || alias.origin === env.ORIGIN || url.origin !== env.ORIGIN) return null;
  if (url.pathname === '/.well-known/webauthn' || url.pathname.startsWith('/p/')) return null;
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    const destination = new URL(alias.origin);
    destination.pathname = url.pathname;
    destination.search = url.search;
    return new Response(null, { status: 308, headers: { ...headers, location: destination.href } });
  }
  // Never replay a credential-bearing POST on another origin. An already-open old page must reload there.
  return Response.json({ error: 'This Cloudbite address has been retired. Open the new address.', url: alias.origin }, { status: 410, headers });
}
