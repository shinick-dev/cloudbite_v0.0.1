import type { EvidenceClaim, ExpertRun, ProjectBrief } from './cloudbite-contract';
import { phaseOnePack } from './cloudbite-personas';
import { STA_EXPERT } from './cloudbite-sta';
import { STA_PACK } from './cloudbite-sta-data';

/** A structural link ledger, not a factual entailment or retrieval-quality score.
 * available means the ID is present in the supplied documents / role's curated source catalogue.
 * Retrieval validation remains the sandbox runner's separate responsibility.
 */
export function evidenceClaims(brief: ProjectBrief, experts: readonly ExpertRun[]): EvidenceClaim[] {
  const documents = new Set((brief.documents ?? []).map(d => d.id));
  return experts.flatMap(expert => {
    if (expert.status !== 'completed' || !expert.opinion) return [];
    const pack = phaseOnePack(expert.expertId);
    const sources = new Set((pack?.sources ?? (expert.expertId === STA_EXPERT.id ? STA_PACK.sources : [])).map(s => s.id));
    return expert.opinion.evidence.map((text, index) => {
      const references: EvidenceClaim['references'] = [];
      const seen = new Set<string>();
      for (const match of text.matchAll(/\[(doc|source):([^\]]*)\]/g)) {
        const kind = match[1] === 'doc' ? 'document' : 'knowledge', id = match[2];
        const key = kind + ':' + id;
        if (seen.has(key)) continue;
        seen.add(key);
        references.push({ kind, id, available: (kind === 'document' ? documents : sources).has(id) });
      }
      return { id: `${expert.id}-claim-${index}`, expertId: expert.expertId, text, references,
        status: references.length > 0 && references.every(r => r.available) ? 'linked' : 'unlinked' };
    });
  });
}
