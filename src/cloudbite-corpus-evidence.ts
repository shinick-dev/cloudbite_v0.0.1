// Resolve server-held retrieval receipts against the exact licensed corpus. Runner-authored audit copies are not authority.
import { CORPUS } from './cloudbite-corpus.generated';
import { freezeCorpusIndex, validateCorpusIndex } from './cloudbite-corpus-search';
import type { CorpusSearchResult } from './cloudbite-corpus-contract';
try { freezeCorpusIndex(CORPUS); } catch { /* malformed deployment: left mutable, so corpusAvailableFor re-validates and reports false */ }
export interface CorpusReceipt {
  indexSha256: string; strategy: CorpusSearchResult['strategy']; model: string | null;
  degraded: string | null; hits: Array<{ chunkId: string; sha256: string }>;
}
export function corpusReceipt(result: CorpusSearchResult): CorpusReceipt {
  return { indexSha256: result.indexSha256, strategy: result.strategy, model: result.model, degraded: result.degraded,
    hits: result.hits.map(h => ({ chunkId: h.chunkId, sha256: h.sha256 })) };
}

let verdict: Promise<boolean> | undefined;
/** Share the in-flight validation as well as its verdict when experts are admitted in parallel. */
export async function corpusAvailableFor(expertId: string): Promise<boolean> {
  const validate = async () => { try { await validateCorpusIndex(CORPUS); return true; } catch { return false; } };
  const valid = await (Object.isFrozen(CORPUS) ? verdict ??= validate() : validate());
  return valid && CORPUS.sources.some(s => s.roles.includes(expertId));
}

/** Receipts and hits that could not be resolved, by category only (never query or text). Valid duplicates are not counted. */
export interface CorpusEvidenceIssues { staleReceipts: number; malformedReceipts: number; excessReceipts: number; foreignHits: number; mismatchedHits: number; unknownHits: number }
export function corpusEvidenceAudit(expertId: string, receipts: readonly CorpusReceipt[]) {
  const allowed = new Map(CORPUS.sources.filter(s => s.roles.includes(expertId)).map(s => [s.id, s]));
  const all = new Map(CORPUS.chunks.map(c => [c.id, c]));
  const seen = new Set<string>();
  const entries = [];
  const issues: CorpusEvidenceIssues = { staleReceipts: 0, malformedReceipts: 0, excessReceipts: Math.max(0, receipts.length - 7), foreignHits: 0, mismatchedHits: 0, unknownHits: 0 };
  for (const receipt of receipts.slice(0, 7)) {
    if (typeof receipt !== 'object' || receipt === null || !Array.isArray(receipt.hits) || receipt.hits.length > 3) { issues.malformedReceipts++; continue; }
    if (receipt.indexSha256 !== CORPUS.sha256) { issues.staleReceipts++; continue; }
    for (const hit of receipt.hits) {
      const chunk = typeof hit === 'object' && hit !== null ? all.get(hit.chunkId) : undefined;
      if (!chunk) { issues.unknownHits++; continue; }
      if (!allowed.has(chunk.sourceId)) { issues.foreignHits++; continue; }
      if (hit.sha256 !== chunk.sha256) { issues.mismatchedHits++; continue; }
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      entries.push({ chunk, source: allowed.get(chunk.sourceId)!, indexSha256: CORPUS.sha256 });
    }
  }
  return { entries, issues };
}
export function corpusEvidence(expertId: string, receipts: readonly CorpusReceipt[]) {
  return corpusEvidenceAudit(expertId, receipts).entries;
}
