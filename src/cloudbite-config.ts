// Cloudbite runtime configuration and limits. Only names of missing settings ever leave the server.
// Cloudbite uses its own CLOUDBITE_* secrets; it never reads gw-shinick's stored Daytona/OpenRouter providers.
import type { Env } from './state';

export const CB_MAX_EXPERTS = 5;            // experts per project (first real slice)
export const CB_MAX_CONCURRENT = 3;         // experts provisioned/running at once per project
export const CB_MAX_ACTIVE_PROJECTS = 2;    // live projects holding sandboxes at once (registry)
export const CB_EXPERT_DEADLINE = 15 * 60_000;
export const CB_PROVISION_DEADLINE = 4 * 60_000;
export const CB_CAPABILITY_TTL = 13 * 60_000;
export const CB_RUNNER_SECONDS = 600;
export const CB_CLAIM_STALE = 3 * 60_000;    // an external step still "claimed" after this is treated as lost
export const CB_POLL = 15_000;
export const CB_RETENTION = 24 * 3600_000;   // project record + access token lifetime
export const CB_MAX_TOKENS = 4;              // access tokens per project (idempotent create retries)

export const CB_CREATE_BODY_MAX = 16 * 1024;
export const CB_INFERENCE_BODY_MAX = 48 * 1024;
export const CB_ACTIVITY_BODY_MAX = 4 * 1024;
export const CB_COMPLETE_BODY_MAX = 1024;
export const CB_INFERENCE_MAX_CALLS = 8;
export const CB_INFERENCE_TIMEOUT = 60_000;
export const CB_INFERENCE_MAX_TOKENS = 1200;
export const CB_INFERENCE_REPLY_MAX = 16 * 1024;
export const CB_ACTIVITY_MAX = 60;           // stored activity rows per expert
export const CB_ACTIVITY_POSTS = 80;         // runner activity posts per expert
export const CB_ARTIFACT_MAX = 64 * 1024;
export const CB_ARTIFACT_FILES = 6;          // result.json + report.md + up to 4 extra
export const CB_DAYTONA_TIMEOUT = 45_000;
export const CB_CLEANUP_MAX_TRIES = 8;

export const CB_WORKDIR = '/home/daytona/cloudbite';

export interface CloudbiteConfig {
  daytona: { api: string; key: string; snapshot?: string };
  nosana: { base: string; key: string; model: string };
  gateway: string;
}

const httpsUrl = (v: string | undefined, allowLocal: boolean) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(allowLocal && local)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
};

/** Names of settings that block live execution. Never values. */
export function cloudbiteMissing(env: Env, catalogueSize: number): string[] {
  const local = env.CLOUDBITE_ALLOW_HTTP === '1';
  const missing: string[] = [];
  if (!env.CLOUDBITE) missing.push('CLOUDBITE (Durable Object binding)');
  if (!httpsUrl(env.CLOUDBITE_DAYTONA_API_URL, local)) missing.push('CLOUDBITE_DAYTONA_API_URL');
  if (!env.CLOUDBITE_DAYTONA_API_KEY) missing.push('CLOUDBITE_DAYTONA_API_KEY');
  if (!httpsUrl(env.CLOUDBITE_NOSANA_BASE_URL, local)) missing.push('CLOUDBITE_NOSANA_BASE_URL');
  if (!env.CLOUDBITE_NOSANA_API_KEY) missing.push('CLOUDBITE_NOSANA_API_KEY');
  if (!env.CLOUDBITE_NOSANA_MODEL || !/^[\w./:@-]{1,128}$/.test(env.CLOUDBITE_NOSANA_MODEL)) missing.push('CLOUDBITE_NOSANA_MODEL');
  if (!httpsUrl(env.CLOUDBITE_GATEWAY_URL, local)) missing.push('CLOUDBITE_GATEWAY_URL');
  if (env.CLOUDBITE_DAYTONA_SNAPSHOT && !/^[\w./:-]{1,128}$/.test(env.CLOUDBITE_DAYTONA_SNAPSHOT)) missing.push('CLOUDBITE_DAYTONA_SNAPSHOT (invalid)');
  if (catalogueSize === 0) missing.push('expert catalogue (src/cloudbite-personas.ts)');
  return missing;
}

/** Full live configuration, or null when anything is missing. */
export function cloudbiteConfig(env: Env): CloudbiteConfig | null {
  if (cloudbiteMissing(env, 1).length) return null;
  const local = env.CLOUDBITE_ALLOW_HTTP === '1';
  return {
    daytona: { api: httpsUrl(env.CLOUDBITE_DAYTONA_API_URL, local)!, key: env.CLOUDBITE_DAYTONA_API_KEY!, snapshot: env.CLOUDBITE_DAYTONA_SNAPSHOT || undefined },
    nosana: { base: httpsUrl(env.CLOUDBITE_NOSANA_BASE_URL, local)!, key: env.CLOUDBITE_NOSANA_API_KEY!, model: env.CLOUDBITE_NOSANA_MODEL! },
    gateway: new URL(httpsUrl(env.CLOUDBITE_GATEWAY_URL, local)!).origin,
  };
}
