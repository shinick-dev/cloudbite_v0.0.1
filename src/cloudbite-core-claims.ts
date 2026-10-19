// Core-claim targets for the opt-in cross-review: a peer's summary, assumptions and nextActions, beside the existing
// per-evidence findings. Pure helpers: no network, no storage, no model call, no extra reviewer call.
//
// The application chooses which target texts a reviewer is shown (bounded, deterministic, omissions disclosed) and the
// parser checks each claimFinding mechanically: the target must be a shown slot of a supplied peer (never the reviewer)
// and its quote must be an exact, non-empty substring of that peer's current field text. That check only proves the
// reviewer pointed at real text; it cannot tell whether the verdict is right. A claimFinding is one same-model reading,
// never verification, a calibrated accuracy figure or a majority view.
import type { CoreClaimFinding, CoreClaimIssue, CoreClaimTargetKind, ExpertOpinion } from './cloudbite-contract';

export const CORE_CLAIM_SCHEMA = 'cloudbite.core-claim-targets/v1';
export const CORE_CLAIM_KINDS = ['summary', 'assumption', 'nextAction'] as const satisfies readonly CoreClaimTargetKind[];
export const CORE_CLAIM_ISSUES = ['unsupported-premise', 'causal-overreach', 'missing-assumption', 'other'] as const satisfies readonly CoreClaimIssue[];
export const CORE_CLAIM_VERDICTS = ['supported', 'challenged', 'insufficient'] as const;
export const CORE_CLAIM_LIMITS = Object.freeze({
  /** claimFindings per reviewer, and evidence findings + claimFindings per reviewer. */
  findings: 3, totalFindings: 6,
  /** Shown targets: every peer summary, then up to this many assumptions / nextActions per peer. */
  assumptionsPerPeer: 4, nextActionsPerPeer: 4,
  /** Characters of one target text shown to the reviewer (a prefix of the stored field). */
  summaryChars: 600, itemChars: 300,
  /** UTF-8 bytes of the serialized target list put in the prompt. */
  contextBytes: 12 * 1024,
  quoteMax: 300, rationale: 500,
  /** UTF-8 bytes of the serialized parsed claimFindings of one report. */
  outputBytes: 8 * 1024,
});

const FIELD: Record<CoreClaimTargetKind, 'summary' | 'assumptions' | 'nextActions'> = { summary: 'summary', assumption: 'assumptions', nextAction: 'nextActions' };

export interface CoreClaimPeer { expertId: string; opinion: ExpertOpinion }
export interface CoreClaimTarget {
  targetExpertId: string; kind: CoreClaimTargetKind; index: number;
  /** Exact prefix of the stored field; quotes must come from this text. */
  text: string;
  /** text is shorter than the stored field (totalChars). */
  truncated: boolean; totalChars: number;
}
export interface CoreClaimContext {
  schema: typeof CORE_CLAIM_SCHEMA;
  reviewerExpertId: string;
  targets: CoreClaimTarget[];
  /** Targets the reviewer is not shown, and why; a claimFinding on one of them is rejected. */
  omitted: Array<{ targetExpertId: string; kind: CoreClaimTargetKind; index: number; reason: 'target-limit' | 'byte-budget' }>;
  disclosure: string;
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;
// Never cut a surrogate pair: a prefix must still be valid text.
const prefix = (s: string, max: number) => { let t = s.slice(0, max); if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1); return t; };
const fieldText = (op: ExpertOpinion, kind: CoreClaimTargetKind, index: number): string | undefined => {
  const v = op[FIELD[kind]];
  if (kind === 'summary') return index === 0 && typeof v === 'string' ? v : undefined;
  return Array.isArray(v) && Number.isInteger(index) && index >= 0 && index < v.length && typeof v[index] === 'string' ? v[index] : undefined;
};

/**
 * Deterministic bounded target list for one reviewer: never the reviewer's own opinion. Order: every peer summary (peer
 * order), then by depth d the d-th assumption and d-th nextAction of each peer. Empty texts are skipped. A target that
 * would push the serialized list over contextBytes is omitted (byte-budget), as is anything past the per-peer counts
 * (target-limit). reviewMessages and parseReviewReply build this from the same reviewer and peers.
 */
export function buildCoreClaimContext(reviewer: { expertId: string }, peers: readonly CoreClaimPeer[]): CoreClaimContext {
  const ps = peers.filter((p) => p.expertId !== reviewer.expertId);
  const candidates: Array<{ p: CoreClaimPeer; kind: CoreClaimTargetKind; index: number; limited: boolean }> = [];
  for (const p of ps) candidates.push({ p, kind: 'summary', index: 0, limited: false });
  const depth = Math.max(0, ...ps.map((p) => Math.max(p.opinion.assumptions?.length ?? 0, p.opinion.nextActions?.length ?? 0)));
  for (let d = 0; d < depth; d++) for (const p of ps) {
    if (d < (p.opinion.assumptions?.length ?? 0)) candidates.push({ p, kind: 'assumption', index: d, limited: d >= CORE_CLAIM_LIMITS.assumptionsPerPeer });
    if (d < (p.opinion.nextActions?.length ?? 0)) candidates.push({ p, kind: 'nextAction', index: d, limited: d >= CORE_CLAIM_LIMITS.nextActionsPerPeer });
  }
  const targets: CoreClaimTarget[] = [], omitted: CoreClaimContext['omitted'] = [];
  let bytes = 2; // []
  for (const c of candidates) {
    const full = fieldText(c.p.opinion, c.kind, c.index);
    if (full === undefined || !full.trim()) continue;
    if (c.limited) { omitted.push({ targetExpertId: c.p.expertId, kind: c.kind, index: c.index, reason: 'target-limit' }); continue; }
    const text = prefix(full, c.kind === 'summary' ? CORE_CLAIM_LIMITS.summaryChars : CORE_CLAIM_LIMITS.itemChars);
    const t: CoreClaimTarget = { targetExpertId: c.p.expertId, kind: c.kind, index: c.index, text, truncated: text.length < full.length, totalChars: full.length };
    const add = utf8(JSON.stringify(t)) + 1;
    if (bytes + add > CORE_CLAIM_LIMITS.contextBytes) { omitted.push({ targetExpertId: c.p.expertId, kind: c.kind, index: c.index, reason: 'byte-budget' }); continue; }
    bytes += add; targets.push(t);
  }
  const truncated = targets.filter((t) => t.truncated).length;
  return {
    schema: CORE_CLAIM_SCHEMA, reviewerExpertId: reviewer.expertId, targets, omitted,
    disclosure: `${targets.length} core target(s) shown`
      + (omitted.length ? `; ${omitted.length} not shown (per-peer limit or byte bound) and not reviewable in this pass` : '')
      + (truncated ? `; ${truncated} shown only as a prefix` : '') + '. Quotes are checked only as exact text; the verdict is one model\'s reading, not verification.',
  };
}

export const CORE_CLAIM_SYSTEM = [
  'coreClaims lists core claim targets of the peers, chosen and bounded by the application: each peer\'s summary (index 0) and some assumptions and nextActions (zero-based index into that array). coreClaims.omitted lists targets you were not shown; never target or guess them. A truncated target shows only a prefix.',
  'You may add claimFindings about these targets. Compare each key recommendation and assumption with the supplied project brief, workspace fields, documents and the peer\'s own evidence. You have no browsing and cannot independently prove anything; a claimFinding is your reading of the supplied text, not a verification.',
  'Keep three things apart: facts the user observed or stated in the supplied material, the expert\'s interpretation of them, and causal hypotheses. A temporal sequence alone (B was seen after A) does not show that A caused B; treating it as proof of one cause while alternatives remain open is causal-overreach. Example: a late hold violation that appears after an ECO does not by itself prove the cause is process-related rather than corner-related.',
  'A recommendation that rests on a premise the supplied text does not state is unsupported-premise; check stated technical premises instead of accepting them. Example: a claim that abstracts cannot be split into sentence-level claim units is a premise to check, not a given. A recommendation that silently depends on an unstated condition is missing-assumption.',
  'Use challenged only when supplied text contradicts the claim or the reasoning step does not follow from it. Missing or unavailable evidence is insufficient, not a contradiction. Use supported only when supplied text actually backs the claim.',
  'Each claimFinding is exactly {"targetExpertId": string, "target": {"kind": "summary"|"assumption"|"nextAction", "index": integer, "quote": string}, "verdict": "supported"|"challenged"|"insufficient", "issue": "unsupported-premise"|"causal-overreach"|"missing-assumption"|"other", "rationale": string}.',
  `quote is copied verbatim as one contiguous, non-empty piece of that target's shown text (at most ${CORE_CLAIM_LIMITS.quoteMax} characters): no paraphrase, translation, ellipsis or joined fragments. rationale at most ${CORE_CLAIM_LIMITS.rationale} characters. At most ${CORE_CLAIM_LIMITS.findings} claimFindings.`,
].join('\n');

export type CoreClaimCheck = { ok: CoreClaimFinding } | { invalid: string };

const exactKeys = (o: object, keys: string[]) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => k.includes(x)); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cleanRationale = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, CORE_CLAIM_LIMITS.rationale);

/** Shape and field bounds only; the target and quote checks need the opinions (and, for a fresh reply, the context). */
function shape(raw: unknown): { ok: CoreClaimFinding } | { invalid: string } {
  if (!isObj(raw) || !exactKeys(raw, ['targetExpertId', 'target', 'verdict', 'issue', 'rationale'])) return { invalid: 'claimFinding did not match the core-claim schema' };
  const { targetExpertId, target, verdict, issue, rationale } = raw;
  if (typeof targetExpertId !== 'string' || !targetExpertId) return { invalid: 'claimFinding targets an expert that was not supplied for review' };
  if (!isObj(target) || !exactKeys(target, ['kind', 'index', 'quote'])) return { invalid: 'claimFinding target did not match the core-claim schema' };
  if (!CORE_CLAIM_KINDS.includes(target.kind as never)) return { invalid: 'claimFinding target kind is not summary/assumption/nextAction' };
  if (!Number.isInteger(target.index) || (target.index as number) < 0) return { invalid: 'claimFinding references a target that does not exist' };
  if (target.kind === 'summary' && target.index !== 0) return { invalid: 'claimFinding summary target must use index 0' };
  if (typeof target.quote !== 'string' || !target.quote.trim() || target.quote.length > CORE_CLAIM_LIMITS.quoteMax) return { invalid: 'claimFinding quote is missing or too long' };
  if (!CORE_CLAIM_VERDICTS.includes(verdict as never)) return { invalid: 'claimFinding verdict is not supported/challenged/insufficient' };
  if (!CORE_CLAIM_ISSUES.includes(issue as never)) return { invalid: 'claimFinding issue is not one of the allowed values' };
  if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > CORE_CLAIM_LIMITS.rationale) return { invalid: 'claimFinding rationale is missing or too long' };
  return { ok: { targetExpertId, target: { kind: target.kind as CoreClaimTargetKind, index: target.index as number, quote: target.quote },
    verdict: verdict as CoreClaimFinding['verdict'], issue: issue as CoreClaimIssue, rationale: cleanRationale(rationale) } };
}

/**
 * Checks one claimFinding against current opinions, without a prompt context: shape and bounds, a target expert that is
 * one of `opinions` and not the reviewer, an existing field slot (summary index 0), and a quote that is an exact
 * non-empty substring of the CURRENT field text. A stored finding whose quoted text has since changed is stale and
 * rejected. For consumers of stored reports (for example author response); a fresh reply is parsed with checkCoreClaim.
 */
export function validateCoreClaimFinding(raw: unknown, reviewerExpertId: string, opinions: readonly CoreClaimPeer[]): CoreClaimCheck {
  const s = shape(raw);
  if ('invalid' in s) return s;
  const f = s.ok;
  if (f.targetExpertId === reviewerExpertId) return { invalid: 'claimFinding targets the reviewer itself' };
  const peer = opinions.find((p) => p.expertId === f.targetExpertId);
  if (!peer) return { invalid: 'claimFinding targets an expert that was not supplied for review' };
  const text = fieldText(peer.opinion, f.target.kind, f.target.index);
  if (text === undefined) return { invalid: 'claimFinding references a target that does not exist' };
  if (!text.includes(f.target.quote)) return { invalid: 'claimFinding quote is not exact text of the named target' };
  return s;
}

/** Fresh-reply check: validateCoreClaimFinding plus the target must be one the context showed, quoted from its shown text. */
export function checkCoreClaim(raw: unknown, reviewerExpertId: string, peers: readonly CoreClaimPeer[], ctx: CoreClaimContext): CoreClaimCheck {
  const v = validateCoreClaimFinding(raw, reviewerExpertId, peers);
  if ('invalid' in v) return v;
  const f = v.ok;
  const shown = ctx.targets.find((t) => t.targetExpertId === f.targetExpertId && t.kind === f.target.kind && t.index === f.target.index);
  if (!shown) return { invalid: ctx.omitted.some((o) => o.targetExpertId === f.targetExpertId && o.kind === f.target.kind && o.index === f.target.index)
    ? 'claimFinding targets a core claim that was not shown to the reviewer' : 'claimFinding references a target that does not exist' };
  // The context must describe the same opinions being parsed; a changed field means a stale context.
  const full = fieldText(peers.find((p) => p.expertId === f.targetExpertId)!.opinion, f.target.kind, f.target.index)!;
  if (!full.startsWith(shown.text)) return { invalid: 'claimFinding target text changed since the review prompt was built' };
  if (!shown.text.includes(f.target.quote)) return { invalid: 'claimFinding quote is not exact text of the named target' };
  return v;
}

/** Parses a reply's claimFindings array (absent = none) under the count, duplicate and total-byte bounds. */
export function parseCoreClaimFindings(raw: unknown, reviewerExpertId: string, peers: readonly CoreClaimPeer[], ctx: CoreClaimContext): { ok: CoreClaimFinding[] } | { invalid: string } {
  if (raw === undefined) return { ok: [] };
  if (!Array.isArray(raw) || raw.length > CORE_CLAIM_LIMITS.findings) return { invalid: `reviewer may give at most ${CORE_CLAIM_LIMITS.findings} claimFindings` };
  const out: CoreClaimFinding[] = [], seen = new Set<string>();
  for (const x of raw) {
    const c = checkCoreClaim(x, reviewerExpertId, peers, ctx);
    if ('invalid' in c) return c;
    const key = JSON.stringify([c.ok.targetExpertId, c.ok.target.kind, c.ok.target.index, c.ok.target.quote]);
    if (seen.has(key)) return { invalid: 'claimFindings repeat the same target quote' };
    seen.add(key); out.push(c.ok);
  }
  if (utf8(JSON.stringify(out)) > CORE_CLAIM_LIMITS.outputBytes) return { invalid: 'claimFindings exceed the output size bound' };
  return { ok: out };
}
