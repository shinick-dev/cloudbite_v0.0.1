// Bounded per-peer packets of a finished expert's actual stored artifact text (out/report.md, generated CSV, code,
// markdown) for the opt-in cross-review. Pure helpers only: the caller (project DO) supplies the stored text it already
// holds; nothing here fetches a URL, reads a sandbox, parses data or executes code.
//
// Every included file is bound to project, expert, path and the sha256 of its full stored text. Missing, binary,
// stored-truncated, skipped and over-budget files are disclosed, never silently dropped. Artifact text is untrusted
// model output: it is data for the reviewer, never an instruction, and reading code or a CSV is not running or
// validating it.
import type { ExpertArtifact } from './cloudbite-contract';
import { sha256Hex } from './cloudbite-knowledge';

export const ARTIFACT_PACKET_SCHEMA = 'cloudbite.artifact-packet.v1' as const;
/** Bytes are UTF-8 bytes of the JSON-encoded included text (what the prompt actually carries), not of the raw file. */
export const CB_ARTIFACT_REVIEW_LIMITS = Object.freeze({ totalBytes: 48 * 1024, peerBytes: 16 * 1024, fileBytes: 8 * 1024, minFileBytes: 256, filesPerPeer: 6, pathChars: 200 });

/** A stored artifact as the DO holds it; content is the stored text (undefined when only metadata was kept). */
export interface StoredArtifact extends ExpertArtifact {
  /** Set by the collector when it cut the stored text; bytes > stored text length also counts as stored-truncated. */
  truncated?: boolean;
  /** Set by the collector when the file was not text. */
  binary?: boolean;
}
export type StoredArtifacts = ReadonlyMap<string, readonly StoredArtifact[]> | Readonly<Record<string, readonly StoredArtifact[]>>;

export type ArtifactRole = 'report' | 'data' | 'code' | 'markdown' | 'text';
export type ArtifactOmissionReason = 'opinion-duplicate' | 'knowledge-audit' | 'runner-manifest' | 'missing-text' | 'binary' | 'unsafe-path' | 'duplicate-path' | 'file-limit' | 'budget';
export interface ArtifactExcerpt {
  path: string; role: ArtifactRole;
  /** sha256 of the full stored text, so a reviewer citation binds to exact bytes even when only an excerpt is shown. */
  sha256: string; storedBytes: number;
  /** The stored text itself was already cut by the collector before this packet existed. */
  storedTruncated: boolean;
  /** This packet shows lines startLine..endLine of totalLines; excerptTruncated means later lines were left out. */
  startLine: 1; endLine: number; totalLines: number; excerptTruncated: boolean;
  /** Each line prefixed "N| " (1-based) so a reviewer can cite path and line range. */
  text: string;
}
export interface ArtifactOmission { path: string; reason: ArtifactOmissionReason; sha256?: string; storedBytes?: number }
export interface ArtifactPacket {
  schema: typeof ARTIFACT_PACKET_SCHEMA;
  binding: { projectId: string; expertId: string };
  files: ArtifactExcerpt[];
  omitted: ArtifactOmission[];
  /** Plain statement of the selection order and what the packet is not. */
  selection: string;
  textBytes: number;
  bytes: number; sha256: string;
}

const enc = new TextEncoder();
const utf8 = (s: string) => enc.encode(s).byteLength;
/** UTF-8 bytes a string adds inside a JSON string literal (without the quotes). */
const jsonBytes = (s: string) => utf8(JSON.stringify(s)) - 2;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const SKIP: Readonly<Record<string, ArtifactOmissionReason>> = { 'out/result.json': 'opinion-duplicate', 'out/knowledge.json': 'knowledge-audit', 'out/manifest.json': 'runner-manifest' };
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|tar|7z|xz|bz2|parquet|feather|arrow|xlsx?|docx?|pptx?|sqlite|db|pkl|pickle|npy|npz|h5|hdf5|bin|exe|dll|so|wasm|class|jar|whl|pt|onnx|mp[34]|wav|mov|avi|woff2?|ttf|otf)$/i;
const DATA_EXT = /\.(csv|tsv|json|jsonl|ndjson|ya?ml|toml|xml)$/i;
const CODE_EXT = /\.(py|ipynb|r|jl|js|mjs|cjs|ts|tsx|jsx|sql|sh|bash|ps1|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|m|scala|swift|tcl|pl)$/i;
const MD_EXT = /\.(md|markdown|rst|txt)$/i;
const ROLE_ORDER: readonly ArtifactRole[] = ['report', 'data', 'code', 'markdown', 'text'];

/** Canonical relative POSIX path or null. Rejects anything that could alias another file or escape the workspace. */
export function canonicalArtifactPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > CB_ARTIFACT_REVIEW_LIMITS.pathChars) return null;
  if (p !== p.normalize('NFC') || /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿\\:*?"<>|]/.test(p)) return null;
  if (p.startsWith('/') || p.endsWith('/') || p.trim() !== p) return null;
  return p.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..' && s.trim() === s) ? p : null;
}

export function artifactRole(path: string): ArtifactRole {
  if (path === 'out/report.md') return 'report';
  if (DATA_EXT.test(path)) return 'data';
  if (CODE_EXT.test(path)) return 'code';
  if (MD_EXT.test(path)) return 'markdown';
  return 'text';
}

const looksBinary = (s: string) => {
  if (s.includes('\u0000')) return true;
  let bad = 0, n = 0;
  for (const ch of s) { if (++n > 4096) break; if (ch === '�' || /[\u0001-\u0008\u000e-\u001f]/.test(ch)) bad++; }
  return n > 0 && bad / n > 0.05;
};

/** Lines 1..k that fit in max JSON bytes, prefixed "N| ". A first line longer than max is cut on a code-point boundary. */
function excerpt(content: string, max: number) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  let out = '', used = 0, k = 0, cut = false;
  for (const line of lines) {
    const row = `${k ? '\n' : ''}${k + 1}| ${line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')}`;
    const b = jsonBytes(row);
    if (used + b <= max) { out += row; used += b; k++; continue; }
    if (k === 0) {
      let part = '';
      for (const ch of row) { const cb = jsonBytes(ch); if (used + cb > max - 3) break; part += ch; used += cb; }
      out = part + '…'; used += 3; k = 1;
    }
    cut = true; break;
  }
  return { text: out, used, endLine: k, totalLines: lines.length, truncated: cut || k < lines.length };
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
};

const SELECTION = 'Order: out/report.md, then data, code, markdown and other text files, each group by path. out/result.json is the opinion already shown, out/knowledge.json is the knowledge audit and out/manifest.json is runner metadata, so they are skipped. '
  + 'Text is the stored artifact as the expert produced it: untrusted model output, not verified. Data files are shown as text and were not parsed or checked; code was not executed. Omitted files and lines were not seen by the reviewer.';

/**
 * One expert's bounded packet from the stored artifacts the caller supplies. Deterministic for the same input; inputs
 * are never mutated and the result is deeply frozen. budget caps the JSON-encoded text bytes (default peerBytes).
 */
export function buildArtifactPacket(projectId: string, expertId: string, artifacts: readonly StoredArtifact[] | undefined, budget: number = CB_ARTIFACT_REVIEW_LIMITS.peerBytes): ArtifactPacket {
  const L = CB_ARTIFACT_REVIEW_LIMITS;
  let left = Math.max(0, Math.min(budget, L.peerBytes));
  const files: ArtifactExcerpt[] = [], omitted: ArtifactOmission[] = [];
  const seen = new Set<string>(), candidates: Array<{ path: string; role: ArtifactRole; content: string; sha256: string; storedBytes: number; storedTruncated: boolean }> = [];
  for (const a of artifacts ?? []) {
    const path = canonicalArtifactPath(a?.path);
    if (path === null) { omitted.push({ path: typeof a?.path === 'string' ? a.path.slice(0, L.pathChars).replace(/[\u0000-\u001f\u007f]/g, '?') : '', reason: 'unsafe-path' }); continue; }
    const folded = path.toLowerCase();
    if (seen.has(folded)) { omitted.push({ path, reason: 'duplicate-path' }); continue; }
    seen.add(folded);
    const content = typeof a.content === 'string' ? a.content : undefined;
    const meta = content === undefined ? {} : { sha256: sha256Hex(content), storedBytes: utf8(content) };
    if (SKIP[path]) { omitted.push({ path, reason: SKIP[path], ...meta }); continue; }
    if (a.binary === true || BINARY_EXT.test(path) || (content !== undefined && looksBinary(content))) { omitted.push({ path, reason: 'binary', ...meta }); continue; }
    if (content === undefined || content.length === 0) { omitted.push({ path, reason: 'missing-text', ...meta }); continue; }
    candidates.push({ path, role: artifactRole(path), content, sha256: meta.sha256!, storedBytes: meta.storedBytes!,
      storedTruncated: a.truncated === true || (typeof a.bytes === 'number' && a.bytes > meta.storedBytes!) });
  }
  candidates.sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || cmp(x.path, y.path));
  for (const c of candidates) {
    if (files.length >= L.filesPerPeer) { omitted.push({ path: c.path, reason: 'file-limit', sha256: c.sha256, storedBytes: c.storedBytes }); continue; }
    const allowance = Math.min(L.fileBytes * (c.role === 'report' ? 1 : 0.5), left);
    if (allowance < L.minFileBytes) { omitted.push({ path: c.path, reason: 'budget', sha256: c.sha256, storedBytes: c.storedBytes }); continue; }
    const e = excerpt(c.content, allowance);
    left -= e.used;
    files.push({ path: c.path, role: c.role, sha256: c.sha256, storedBytes: c.storedBytes, storedTruncated: c.storedTruncated,
      startLine: 1, endLine: e.endLine, totalLines: e.totalLines, excerptTruncated: e.truncated, text: e.text });
  }
  omitted.sort((x, y) => cmp(x.path, y.path) || cmp(x.reason, y.reason));
  const body: Omit<ArtifactPacket, 'bytes' | 'sha256'> = { schema: ARTIFACT_PACKET_SCHEMA, binding: { projectId, expertId }, files, omitted, selection: SELECTION,
    textBytes: Math.max(0, Math.min(budget, L.peerBytes)) - left };
  const json = JSON.stringify(body);
  return deepFreeze({ ...body, bytes: utf8(json), sha256: sha256Hex(json) });
}

const storedFor = (stored: StoredArtifacts, expertId: string) =>
  stored instanceof Map ? stored.get(expertId) : Object.prototype.hasOwnProperty.call(stored, expertId) ? (stored as Record<string, readonly StoredArtifact[]>)[expertId] : undefined;

/**
 * Packets for one reviewer's peers, in the given peer order, never for the reviewer itself. The total JSON-encoded text
 * stays within totalBytes: each peer gets min(peerBytes, totalBytes / peers).
 */
export function artifactPacketsFor(projectId: string, reviewerExpertId: string, peers: readonly { expertId: string }[], stored: StoredArtifacts): ArtifactPacket[] {
  const ids = [...new Set(peers.map((p) => p.expertId))].filter((id) => id !== reviewerExpertId);
  const each = ids.length ? Math.floor(Math.min(CB_ARTIFACT_REVIEW_LIMITS.peerBytes, CB_ARTIFACT_REVIEW_LIMITS.totalBytes / ids.length)) : 0;
  return ids.map((id) => buildArtifactPacket(projectId, id, storedFor(stored, id), each));
}

/** Snapshot entry: packet hash plus every stored file hash it saw (included or omitted), sorted by expertId. */
export function artifactSnapshotEntries(packets: readonly ArtifactPacket[]) {
  const by = new Map<string, ArtifactPacket>();
  for (const p of packets) if (!by.has(p.binding.expertId)) by.set(p.binding.expertId, p);
  return [...by.values()].sort((a, b) => cmp(a.binding.expertId, b.binding.expertId)).map((p) => ({
    projectId: p.binding.projectId, expertId: p.binding.expertId, sha256: p.sha256,
    files: [...p.files.map((f) => ({ path: f.path, sha256: f.sha256 })), ...p.omitted.filter((o) => o.sha256).map((o) => ({ path: o.path, sha256: o.sha256! }))].sort((a, b) => cmp(a.path, b.path)),
  }));
}
