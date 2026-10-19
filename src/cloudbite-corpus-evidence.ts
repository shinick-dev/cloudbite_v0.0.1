// Resolve server-held retrieval receipts against the exact licensed corpus. Runner-authored audit copies are not authority.
import { CORPUS } from './cloudbite-corpus.generated';
import { freezeCorpusIndex } from './cloudbite-corpus-search';
import type { CorpusSearchResult } from './cloudbite-corpus-contract';
freezeCorpusIndex(CORPUS);
export interface CorpusReceipt {
  indexSha256: string; strategy: CorpusSearchResult['strategy']; model: string | null;
  degraded: string | null; hits: Array<{ chunkId: string; sha256: string }>;
}
export function corpusReceipt(result: CorpusSearchResult): CorpusReceipt {
  return { indexSha256: result.indexSha256, strategy: result.strategy, model: result.model, degraded: result.degraded,
    hits: result.hits.map(h => ({ chunkId: h.chunkId, sha256: h.sha256 })) };
}
export function corpusEvidence(expertId: string, receipts: readonly CorpusReceipt[]) {
  const allowed = new Map(CORPUS.sources.filter(s => s.roles.includes(expertId)).map(s => [s.id, s]));
  const chunks = new Map(CORPUS.chunks.filter(c => allowed.has(c.sourceId)).map(c => [c.id, c]));
  const seen = new Set<string>();
  const entries = [];
  for (const receipt of receipts.slice(0, 7)) {
    if (receipt.indexSha256 !== CORPUS.sha256 || !Array.isArray(receipt.hits)) continue;
    for (const hit of receipt.hits.slice(0, 3)) {
      const chunk = chunks.get(hit.chunkId);
      if (!chunk || hit.sha256 !== chunk.sha256 || seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      entries.push({ chunk, source: allowed.get(chunk.sourceId)!, indexSha256: CORPUS.sha256 });
    }
  }
  return entries;
}
