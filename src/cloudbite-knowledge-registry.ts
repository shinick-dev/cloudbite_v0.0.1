// Authored starter knowledge, not a claim of measured professional competence.
// Held-out evaluation cases stay under test/fixtures and never enter a sandbox.
import { PHASE_ONE_PACKS, type PhaseOneKnowledgePack } from './cloudbite-phase-one-data';
import { EXTENSION_A_PACKS } from './cloudbite-expansion-a';
import { EXTENSION_B_PACKS } from './cloudbite-expansion-b';
import { EXTENSION_C_PACKS } from './cloudbite-expansion-c';

const groups: Array<[string, PhaseOneKnowledgePack[]]> = [
  ['src/cloudbite-phase-one-data.ts', PHASE_ONE_PACKS],
  ['src/cloudbite-expansion-a.ts', EXTENSION_A_PACKS],
  ['src/cloudbite-expansion-b.ts', EXTENSION_B_PACKS],
  ['src/cloudbite-expansion-c.ts', EXTENSION_C_PACKS],
];
export const KNOWLEDGE_PACKS: readonly PhaseOneKnowledgePack[] = Object.freeze(groups.flatMap(([, packs]) => packs));
const paths = new Map<string, string>();
const numbers = new Set<number>();
for (const [path, packs] of groups) for (const pack of packs) {
  if (paths.has(pack.expertId) || numbers.has(pack.catalogNumber)) throw new Error('Duplicate knowledge catalogue mapping');
  paths.set(pack.expertId, path);
  numbers.add(pack.catalogNumber);
}
export function knowledgeSourcePath(expertId: string): string {
  const path = paths.get(expertId);
  if (!path) throw new Error('Unknown knowledge role');
  return path;
}
