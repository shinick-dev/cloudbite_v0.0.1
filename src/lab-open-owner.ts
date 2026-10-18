import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export interface OpenOwnerConfig {
  LAB_OPEN_ACCESS_TEAM?: string;
  LAB_OPEN_AUDIENCE?: string;
  LAB_OPEN_OWNER_EMAIL?: string;
}
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Only an Access application JWT for this owner grants inbox access. Never trust the email header. */
export async function verifyOpenOwnerJwt(token: string | null, env: OpenOwnerConfig, keys?: JWTVerifyGetKey) {
  const team = env.LAB_OPEN_ACCESS_TEAM;
  const audience = env.LAB_OPEN_AUDIENCE;
  const email = env.LAB_OPEN_OWNER_EMAIL;
  if (!token || token.length > 16384 || !team || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !audience || !email) return null;
  try {
    if (!keys) {
      let resolver = resolvers.get(team);
      if (!resolver) {
        resolver = createRemoteJWKSet(new URL(team+'/cdn-cgi/access/certs'), {timeoutDuration:5000});
        if (resolvers.size >= 2) resolvers.clear();
        resolvers.set(team, resolver);
      }
      keys = resolver;
    }
    const {payload} = await jwtVerify(token, keys, {issuer:team,audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub','email']});
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== email.toLowerCase() || typeof payload.exp !== 'number') return null;
    return {email,expiresAt:payload.exp*1000};
  } catch { return null; }
}
