// Static instruction identity for new history records. Existing records keep their original hashes.
// The project question/materials are fingerprinted separately by the evaluator. This identifies the selected role,
// operating instructions and runner implementation at creation, not a claim that model advice is reproducible.
import type { ExpertDefinition } from './cloudbite-contract';
import { playbookWorkOrderSection } from './cloudbite-expert-playbooks';
import { sha256Hex } from './cloudbite-knowledge';
import { CB_RUNNER_PY } from './cloudbite-runner';

export const EXPERT_INSTRUCTION_IDENTITY = 'expert-instructions/v2';
let runnerDigest: string | undefined;
export function expertInstructionComponents(expert: ExpertDefinition) {
  runnerDigest ??= sha256Hex(CB_RUNNER_PY);
  // Include both languages and both knowledge variants, so every authored playbook rule is represented without
  // importing the persona registry back into this module. The actual workspace chooses one appropriate variant.
  const operating = (['en', 'ko'] as const).flatMap(lang => [false, true].map(knowledge =>
    playbookWorkOrderSection(expert.id, lang, { knowledge })));
  return { schema: EXPERT_INSTRUCTION_IDENTITY, expertId: expert.id,
    personaSha256: sha256Hex(expert.prompt), playbookSha256: sha256Hex(JSON.stringify(operating)), runnerSha256: runnerDigest };
}
export function expertInstructionHash(expert: ExpertDefinition): string {
  return sha256Hex(JSON.stringify(expertInstructionComponents(expert)));
}
