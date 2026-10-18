import type { ExpertDefinition, ProjectBrief } from './cloudbite-contract';
// Replaced by the persona worker with provenance and executable workspace packs.
export const CLOUDBITE_EXPERTS: readonly ExpertDefinition[] = [];
export function findExpert(id: string): ExpertDefinition | undefined {
  return CLOUDBITE_EXPERTS.find(expert => expert.id === id);
}
export function buildExpertWorkspace(_expert: ExpertDefinition, _brief: ProjectBrief): Array<{path:string;content:string}> {
  return [];
}
