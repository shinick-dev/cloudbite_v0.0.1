// Cloudbite input/output validation. Pure functions: no storage, network or clock.
import type { ExpertDefinition, ExpertOpinion, ProjectBrief } from './cloudbite-contract';
import { CB_ARTIFACT_MAX, CB_MAX_EXPERTS } from './cloudbite-config';
import { CLOUDBITE_BRIEF_LIMITS, validateExpertOpinion } from './cloudbite-personas';

export type Invalid = { invalid: string };
export const isInvalid = (x: unknown): x is Invalid => typeof x === 'object' && x !== null && 'invalid' in x;

const text = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const PROJECT_ID = /^cb[0-9a-f]{32}$/;
export const RUN_ID = /^e(?:[0-9]|[1-9][0-9])$/;
const LIMITS = CLOUDBITE_BRIEF_LIMITS;
export const REQUEST_ID = new RegExp(`^[A-Za-z0-9_-]{${LIMITS.requestIdMin},${LIMITS.requestId}}$`);
export const EXPERT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Structural brief validation. Expert ids are checked against the catalogue when one is given. */
export function validateBrief(raw: unknown, catalogue?: readonly ExpertDefinition[]): ProjectBrief | Invalid {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { invalid: 'brief must be a JSON object' };
  const b = raw as Record<string, unknown>;
  const allowed = new Set(['title', 'objective', 'context', 'expertIds', 'mode', 'requestId']);
  if (Object.keys(b).some((k) => !allowed.has(k))) return { invalid: 'unknown brief field' };
  if (!text(b.title, 1, LIMITS.title) || CONTROL.test(b.title as string)) return { invalid: `title must be 1-${LIMITS.title} characters` };
  if (!text(b.objective, 1, LIMITS.objective)) return { invalid: `objective must be 1-${LIMITS.objective} characters` };
  if (typeof b.context !== 'string' || b.context.length > LIMITS.context) return { invalid: `context must be at most ${LIMITS.context} characters` };
  if (b.mode !== 'demo' && b.mode !== 'live') return { invalid: 'mode must be demo or live' };
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) return { invalid: `requestId must be ${LIMITS.requestIdMin}-${LIMITS.requestId} of [A-Za-z0-9_-]` };
  if (!Array.isArray(b.expertIds) || b.expertIds.length < 1 || b.expertIds.length > CB_MAX_EXPERTS) return { invalid: `select 1-${CB_MAX_EXPERTS} experts` };
  if (b.expertIds.some((id) => typeof id !== 'string' || !EXPERT_ID.test(id))) return { invalid: 'invalid expert id' };
  if (new Set(b.expertIds).size !== b.expertIds.length) return { invalid: 'duplicate expert id' };
  if (catalogue && b.expertIds.some((id) => !catalogue.some((e) => e.id === id))) return { invalid: 'unknown expert id' };
  return { title: b.title as string, objective: b.objective as string, context: b.context, expertIds: [...b.expertIds] as string[], mode: b.mode, requestId: b.requestId };
}

/**
 * Final opinion: the persona workspace's RESULT.schema.json rules (validateExpertOpinion), the one canonical
 * ExpertOpinion check. Confidence is a self-assessed 0–100 integer, not calibrated accuracy.
 */
export function validateOpinion(raw: unknown): ExpertOpinion | Invalid {
  const r = validateExpertOpinion(raw);
  return r.ok ? r.opinion : { invalid: r.errors[0] };
}

/**
 * Runner result file out/result.json: a flat ExpertOpinion. It carries no identity; which expert it belongs to
 * comes from the sandbox/run the server created and downloaded it from.
 */
export function validateResult(raw: string): ExpertOpinion | Invalid {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { invalid: 'out/result.json is not JSON' }; }
  return validateOpinion(j);
}

const RESERVED = new Set(['out/result.json', 'out/report.md', 'out/manifest.json', 'out/done']);
/** Extra generated artifacts the server may collect: flat out/<name>.<md|txt|json|csv>. */
export function extraArtifactPath(p: unknown): p is string {
  return typeof p === 'string' && /^out\/[a-z0-9][a-z0-9_-]{0,47}(\.[a-z0-9_-]{1,16})?\.(md|txt|json|csv)$/.test(p) && !RESERVED.has(p);
}
/** Paths a client may request: the two required outputs or an extra artifact path. */
export function artifactPath(p: unknown): p is string {
  return p === 'out/result.json' || p === 'out/report.md' || extraArtifactPath(p);
}

/** Workspace files from buildExpertWorkspace(): relative, plain names, bounded, no runtime-reserved locations. */
export function validateWorkspace(files: unknown): Array<{ path: string; content: string }> | Invalid {
  if (!Array.isArray(files) || files.length === 0 || files.length > 24) return { invalid: 'workspace must contain 1-24 files' };
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f !== 'object' || f === null || typeof f.path !== 'string' || typeof f.content !== 'string') return { invalid: 'workspace file must be {path, content}' };
    const segs = f.path.split('/');
    if (segs.length > 3 || segs.some((s: string) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s) || s.includes('..'))) return { invalid: 'workspace path is not a plain relative path' };
    if (/^(out|\.cloudbite|work)$/.test(segs[0]) || f.path === 'runner.py') return { invalid: 'workspace path is reserved by the runtime' };
    if (seen.has(f.path)) return { invalid: 'duplicate workspace path' };
    seen.add(f.path);
    const bytes = new TextEncoder().encode(f.content).byteLength;
    if (bytes > CB_ARTIFACT_MAX) return { invalid: 'workspace file too large' };
    total += bytes;
  }
  if (total > 256 * 1024) return { invalid: 'workspace too large' };
  for (const required of ['PERSONA.md', 'PROJECT.md', 'WORKORDER.md']) if (!seen.has(required)) return { invalid: `workspace lacks ${required}` };
  return files.map((f) => ({ path: f.path, content: f.content }));
}
