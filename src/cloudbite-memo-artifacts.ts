// Bounded selection of already collected, model-generated artifacts for project coaching.
// A collected artifact is a model output, not an independently verified source or execution receipt.
import type { MemoEvidencePacket } from './cloudbite-memo';
import { sha256Hex } from './cloudbite-knowledge';

export const MEMO_ARTIFACT_LIMITS = Object.freeze({ files: 12, text: 4000, storedBytes: 64 * 1024 });
interface ArtifactExpert {
  run: { id: string; expertId: string; status: string; artifacts: Array<{ path: string; bytes?: number }> };
}
export interface MemoArtifactSelection {
  entries: Array<{ key: string; expertId: string; path: string; declaredBytes: number }>;
  eligible: number;
}
const PATH = /^out\/[a-z0-9][a-z0-9_-]{0,47}(\.[a-z0-9_-]{1,16})?\.(md|txt|json|csv)$/;
const RESERVED = new Set(['out/result.json', 'out/manifest.json', 'out/knowledge.json', 'out/diagnostic.json', 'out/author-response.json']);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const enc = new TextEncoder();

/** One artifact per completed expert before selecting a second. Does not read storage or arbitrary paths. */
export function selectMemoArtifacts(experts: readonly ArtifactExpert[]): MemoArtifactSelection {
  const groups = experts.filter(e => e.run.status === 'completed' && ID.test(e.run.expertId) && ID.test(e.run.id)).map(({ run }) => {
    const seen = new Set<string>();
    return run.artifacts.filter(a => PATH.test(a.path) && !RESERVED.has(a.path) && !seen.has(a.path)
      && typeof a.bytes === 'number' && Number.isInteger(a.bytes) && a.bytes > 0 && a.bytes <= MEMO_ARTIFACT_LIMITS.storedBytes && !!seen.add(a.path))
      .sort((a, b) => Number(b.path === 'out/report.md') - Number(a.path === 'out/report.md') || a.path.localeCompare(b.path))
      .map(a => ({ key: `artifact:${run.id}:${a.path}`, expertId: run.expertId, path: a.path, declaredBytes: a.bytes! }));
  });
  const eligible = groups.reduce((n, g) => n + g.length, 0), entries: MemoArtifactSelection['entries'] = [];
  for (let slot = 0; entries.length < MEMO_ARTIFACT_LIMITS.files; slot++) {
    let found = false;
    for (const group of groups) {
      if (!group[slot]) continue;
      found = true; entries.push(group[slot]);
      if (entries.length === MEMO_ARTIFACT_LIMITS.files) break;
    }
    if (!found) break;
  }
  return { entries, eligible };
}

/** Full-content hashes bind even a changed tail outside the included excerpt to the memo snapshot. */
export function memoArtifactPackets(selection: MemoArtifactSelection, contents: ReadonlyMap<string, unknown>): MemoEvidencePacket[] {
  let absent = 0;
  const packets: MemoEvidencePacket[] = [];
  for (const [index, a] of selection.entries.entries()) {
    const content = contents.get(a.key);
    if (typeof content !== 'string' || !content.trim() || enc.encode(content).length > MEMO_ARTIFACT_LIMITS.storedBytes) { absent++; continue; }
    // Array.from avoids splitting a supplementary Unicode character at the excerpt boundary.
    const text = Array.from(content).slice(0, MEMO_ARTIFACT_LIMITS.text / 2).join('');
    packets.push({ id: `artifact-${index + 1}`, kind: 'expert-artifact-excerpt', expertId: a.expertId,
      label: `Generated ${a.path} (${a.expertId}); excerpt only`, text,
      origin: `${a.path}; sha256=${sha256Hex(content)}; originalBytes=${enc.encode(content).length}; excerptBytes=${enc.encode(text).length}; model-generated-unverified` });
  }
  const omitted = Math.max(0, selection.eligible - selection.entries.length);
  if (omitted || absent) packets.push({ id: 'artifact-omissions', kind: 'source-metadata',
    label: `Generated artifacts omitted by selection limit: ${omitted}; selected but unavailable: ${absent}`,
    origin: 'Artifact selection metadata only; no omitted artifact content or original source text is included.' });
  return packets;
}
