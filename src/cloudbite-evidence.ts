import type { EvidenceClaim, ExpertRun, ProjectBrief, ProjectCrossReview } from './cloudbite-contract';
import { applicationPack, evidenceReferences, type EvidencePacket, type RetrievalBinding, type TextAvailability } from './cloudbite-evidence-packet';
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

export const EVIDENCE_SIGNALS_SCHEMA = 'cloudbite.evidence-signals/v1';
export const EVIDENCE_SIGNALS_INTERPRETATION = 'Observed counts beside the expert\'s self-assessed confidence. They are not a calibrated probability, a factual-accuracy score or a verification; a source ID present in a catalogue is not retrieved or verified.';

/** Observable, countable facts about one completed opinion. Never a probability. */
export interface ExpertEvidenceSignals {
  expertId: string;
  /** The expert's own number, reported unchanged and labelled as self-assessment. */
  selfAssessedConfidence: number;
  evidenceItems: number;
  unreferencedEvidenceItems: number;
  references: { total: number; document: number; workspace: number; knowledge: number };
  suppliedText: { available: number; missing: number };
  knowledge: { curatedCardText: number; curatedCardTextOmitted: number; retrievalUnverified: number; notRetrieved: number };
  unknownReferences: number;
  /** As observed in the runner audit and bound to the application pack; null when no packet was built. */
  observedRetrieval: { binding: RetrievalBinding; retrievals: number; cards: number; sources: number } | null;
  assumptions: number;
  /** Findings that targeted this opinion; null when no completed cross-review report exists. */
  crossReview: { reviewers: number; findings: number; supported: number; challenged: number; insufficient: number; evidenceItemsReviewed: number } | null;
}
export interface EvidenceSignals {
  schema: typeof EVIDENCE_SIGNALS_SCHEMA;
  interpretation: string;
  experts: ExpertEvidenceSignals[];
  review: { completedOpinions: number; reviewedOpinions: number; reviewers: number; status: ProjectCrossReview['status'] | 'not-run'; disclosure: string };
}

/**
 * Pure observation ledger for UI/integration. Counts what was cited, supplied, retrieved and reviewed; it never derives
 * a confidence, dispersion or accuracy figure. packets come from buildEvidencePackets (optional).
 */
export function buildEvidenceSignals(brief: ProjectBrief, experts: readonly ExpertRun[], opts: { packets?: readonly EvidencePacket[]; crossReview?: ProjectCrossReview } = {}): EvidenceSignals {
  const completed = experts.filter(e => e.status === 'completed' && e.opinion);
  const reports = opts.crossReview?.reports ?? [];
  const out = completed.map((e): ExpertEvidenceSignals => {
    const opinion = e.opinion!, packet = opts.packets?.find(p => p.expertId === e.expertId);
    const refs = packet?.references ?? evidenceReferences(brief, opinion, applicationPack(e.expertId));
    const count = (a: TextAvailability) => refs.filter(r => r.availability === a).length;
    const findings = reports.flatMap(r => r.findings.filter(f => f.targetExpertId === e.expertId).map(f => ({ ...f, reviewer: r.reviewerExpertId })));
    return {
      expertId: e.expertId, selfAssessedConfidence: opinion.confidence, evidenceItems: opinion.evidence.length,
      unreferencedEvidenceItems: opinion.evidence.filter(t => !/\[(doc|source):[^\]]*\]/.test(t)).length,
      references: { total: refs.length, document: refs.filter(r => r.kind === 'document').length, workspace: refs.filter(r => r.kind === 'workspace').length, knowledge: refs.filter(r => r.kind === 'knowledge').length },
      suppliedText: { available: count('supplied-project-text'), missing: count('missing-project-text') },
      knowledge: { curatedCardText: count('curated-card-text'), curatedCardTextOmitted: count('curated-card-text-omitted'), retrievalUnverified: count('retrieval-unverified'), notRetrieved: count('not-retrieved') },
      unknownReferences: count('unknown-id'),
      observedRetrieval: packet ? { binding: packet.binding, retrievals: packet.observed.retrievals, cards: packet.observed.cardIds.length, sources: packet.observed.sourceIds.length } : null,
      assumptions: opinion.assumptions.length,
      crossReview: reports.length ? { reviewers: new Set(findings.map(f => f.reviewer)).size, findings: findings.length,
        supported: findings.filter(f => f.verdict === 'supported').length, challenged: findings.filter(f => f.verdict === 'challenged').length,
        insufficient: findings.filter(f => f.verdict === 'insufficient').length, evidenceItemsReviewed: new Set(findings.map(f => f.evidenceIndex)).size } : null,
    };
  });
  const reviewed = out.filter(x => x.crossReview && x.crossReview.findings > 0).length;
  return {
    schema: EVIDENCE_SIGNALS_SCHEMA, interpretation: EVIDENCE_SIGNALS_INTERPRETATION, experts: out,
    review: { completedOpinions: out.length, reviewedOpinions: reviewed, reviewers: reports.length, status: opts.crossReview?.status ?? 'not-run',
      disclosure: opts.crossReview ? `${reviewed} of ${out.length} completed opinions received at least one cross-review finding; the others were not reviewed. Findings are reviewer readings, not verification.`
        : 'No cross-review has run; no opinion was reviewed by another expert.' },
  };
}
