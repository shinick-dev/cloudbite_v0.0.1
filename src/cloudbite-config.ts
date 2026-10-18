// Cloudbite runtime configuration and limits. Only names of missing settings ever leave the server.
// Cloudbite uses its own CLOUDBITE_* secrets; it never reads gw-shinick's stored Daytona/OpenRouter providers.
import type { Env } from './state';
import { PROJECT_MAX_EXPERTS } from './cloudbite-catalogue-limits';

export const CB_MAX_EXPERTS = PROJECT_MAX_EXPERTS; // per-project bound, independent of catalogue growth
export const CB_MAX_CONCURRENT = CB_MAX_EXPERTS; // start the selected team independently by default
export const CB_MAX_ACTIVE_PROJECTS = 2;    // live projects holding sandboxes at once (registry)
export const CB_EXPERT_DEADLINE = 15 * 60_000;
export const CB_PROVISION_DEADLINE = 4 * 60_000;
export const CB_CAPABILITY_TTL = 13 * 60_000;
export const CB_RUNNER_SECONDS = 600;
export const CB_CLAIM_STALE = 3 * 60_000;    // an external step still "claimed" after this is treated as lost
export const CB_POLL = 15_000;
export const CB_RETENTION = 24 * 3600_000;   // project record + access token lifetime
export const CB_MAX_TOKENS = 4;              // access tokens per project (idempotent create retries)

export const CB_CREATE_BODY_MAX = 128 * 1024; // optional user documents (24000 characters, multi-byte, JSON-escaped)
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

/** Operator override for provider capacity; never controlled by the browser or a model decision. */
export function cbMaxConcurrent(env: Pick<Env, 'CLOUDBITE_MAX_CONCURRENT'>): number {
  const raw = env.CLOUDBITE_MAX_CONCURRENT;
  if (raw === undefined) return CB_MAX_CONCURRENT;
  return /^(?:[1-9]|[1-9][0-9]|100)$/.test(raw) ? Number(raw) : 0;
}

/** Stable internal Daytona account ids. Never derived from or exposing a key. */
export type CbAccountId = 'primary' | 'secondary' | 'tertiary';
export interface CbDaytonaAccount { id: CbAccountId; api: string; key: string; snapshot?: string }

export interface CloudbiteConfig {
  daytona: { api: string; key: string; snapshot?: string };   // the primary account (unchanged single-account shape)
  daytonaAccounts: CbDaytonaAccount[];                        // stable primary/secondary/tertiary slots; optional ones require a key
  nosana: { base: string; key: string; model: string };
  gateway: string;
}

const SNAPSHOT = /^[\w./:-]{1,128}$/;
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
  if (!cbMaxConcurrent(env)) missing.push('CLOUDBITE_MAX_CONCURRENT (must be an integer from 1 to 100)');
  if (!env.CLOUDBITE) missing.push('CLOUDBITE (Durable Object binding)');
  if (!httpsUrl(env.CLOUDBITE_DAYTONA_API_URL, local)) missing.push('CLOUDBITE_DAYTONA_API_URL');
  if (!env.CLOUDBITE_DAYTONA_API_KEY) missing.push('CLOUDBITE_DAYTONA_API_KEY');
  if (!httpsUrl(env.CLOUDBITE_NOSANA_BASE_URL, local)) missing.push('CLOUDBITE_NOSANA_BASE_URL');
  if (!env.CLOUDBITE_NOSANA_API_KEY) missing.push('CLOUDBITE_NOSANA_API_KEY');
  if (!env.CLOUDBITE_NOSANA_MODEL || !/^[\w./:@-]{1,128}$/.test(env.CLOUDBITE_NOSANA_MODEL)) missing.push('CLOUDBITE_NOSANA_MODEL');
  if (!httpsUrl(env.CLOUDBITE_GATEWAY_URL, local)) missing.push('CLOUDBITE_GATEWAY_URL');
  if (env.CLOUDBITE_DAYTONA_SNAPSHOT && !SNAPSHOT.test(env.CLOUDBITE_DAYTONA_SNAPSHOT)) missing.push('CLOUDBITE_DAYTONA_SNAPSHOT (invalid)');
  // Optional second account: absent entirely = single account. Any partial or malformed setting blocks live execution
  // (fail closed) instead of silently running on the primary account alone.
  const k2 = env.CLOUDBITE_DAYTONA_SECONDARY_API_KEY, u2 = env.CLOUDBITE_DAYTONA_SECONDARY_API_URL, s2 = env.CLOUDBITE_DAYTONA_SECONDARY_SNAPSHOT;
  if (k2 || u2 || s2) {
    if (!k2) missing.push('CLOUDBITE_DAYTONA_SECONDARY_API_KEY');
    else if (k2 === env.CLOUDBITE_DAYTONA_API_KEY) missing.push('CLOUDBITE_DAYTONA_SECONDARY_API_KEY (must be a different account key)');
    if (u2 && !httpsUrl(u2, local)) missing.push('CLOUDBITE_DAYTONA_SECONDARY_API_URL');
    if (s2 && !SNAPSHOT.test(s2)) missing.push('CLOUDBITE_DAYTONA_SECONDARY_SNAPSHOT (invalid)');
  }
  const k3 = env.CLOUDBITE_DAYTONA_TERTIARY_API_KEY, u3 = env.CLOUDBITE_DAYTONA_TERTIARY_API_URL, s3 = env.CLOUDBITE_DAYTONA_TERTIARY_SNAPSHOT;
  if (k3 || u3 || s3) {
    if (!k3) missing.push('CLOUDBITE_DAYTONA_TERTIARY_API_KEY');
    else if (k3 === env.CLOUDBITE_DAYTONA_API_KEY || k3 === k2) missing.push('CLOUDBITE_DAYTONA_TERTIARY_API_KEY (must be a different account key)');
    if (u3 && !httpsUrl(u3, local)) missing.push('CLOUDBITE_DAYTONA_TERTIARY_API_URL');
    if (s3 && !SNAPSHOT.test(s3)) missing.push('CLOUDBITE_DAYTONA_TERTIARY_SNAPSHOT (invalid)');
  }
  if (catalogueSize === 0) missing.push('expert catalogue (src/cloudbite-personas.ts)');
  return missing;
}

/** Full live configuration, or null when anything is missing. */
export function cloudbiteConfig(env: Env): CloudbiteConfig | null {
  if (cloudbiteMissing(env, 1).length) return null;
  const local = env.CLOUDBITE_ALLOW_HTTP === '1';
  const daytona = { api: httpsUrl(env.CLOUDBITE_DAYTONA_API_URL, local)!, key: env.CLOUDBITE_DAYTONA_API_KEY!, snapshot: env.CLOUDBITE_DAYTONA_SNAPSHOT || undefined };
  const accounts: CbDaytonaAccount[] = [{ id: 'primary', ...daytona }];
  if (env.CLOUDBITE_DAYTONA_SECONDARY_API_KEY) accounts.push({
    id: 'secondary', key: env.CLOUDBITE_DAYTONA_SECONDARY_API_KEY,
    api: env.CLOUDBITE_DAYTONA_SECONDARY_API_URL ? httpsUrl(env.CLOUDBITE_DAYTONA_SECONDARY_API_URL, local)! : daytona.api,
    snapshot: env.CLOUDBITE_DAYTONA_SECONDARY_SNAPSHOT || undefined, // snapshots are organization-scoped: never inherit the primary's
  });
  if (env.CLOUDBITE_DAYTONA_TERTIARY_API_KEY) accounts.push({
    id: 'tertiary', key: env.CLOUDBITE_DAYTONA_TERTIARY_API_KEY,
    api: env.CLOUDBITE_DAYTONA_TERTIARY_API_URL ? httpsUrl(env.CLOUDBITE_DAYTONA_TERTIARY_API_URL, local)! : daytona.api,
    snapshot: env.CLOUDBITE_DAYTONA_TERTIARY_SNAPSHOT || undefined,
  });
  return {
    daytona, daytonaAccounts: accounts,
    nosana: { base: httpsUrl(env.CLOUDBITE_NOSANA_BASE_URL, local)!, key: env.CLOUDBITE_NOSANA_API_KEY!, model: env.CLOUDBITE_NOSANA_MODEL! },
    gateway: new URL(httpsUrl(env.CLOUDBITE_GATEWAY_URL, local)!).origin,
  };
}

/**
 * Credential binding fingerprint persisted with each account assignment and cleanup entry: a truncated SHA-256 of
 * account id, API origin and key. A replaced key/API (or swapped accounts) no longer matches, so pinned work stops
 * instead of being sent with other credentials. Internal only; never part of a public view.
 */
export async function cbAccountBinding(a: CbDaytonaAccount): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cloudbite-daytona-binding|${a.id}|${a.api}|${a.key}`)));
  return [...d.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
