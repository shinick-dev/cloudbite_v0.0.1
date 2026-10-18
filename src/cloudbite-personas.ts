import type { ExpertDefinition } from './cloudbite-contract';
// Replaced by the persona worker with provenance and executable workspace packs.
export const CLOUDBITE_EXPERTS: readonly ExpertDefinition[] = [];
export function findExpert(id: string): ExpertDefinition | undefined {
  return CLOUDBITE_EXPERTS.find(expert => expert.id === id);
}
