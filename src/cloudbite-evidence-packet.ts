// Bounded evidence packets for cross-review: the peer's actually retrieved curated cards, bound to the
// application-owned knowledge pack, plus per-reference text availability. Pure helpers, no network, no storage.
//
// Truth comes from the application pack, never from the audit: card text and source records are read from the pack
// only after the runner's out/knowledge.json audit is bound to it (role, version, cards/sources sha256 and a
// card→source resolution that matches the pack). The audit's own copies, and any claim such as sourcePagesFetched,
// are ignored. Source metadata (title/URL/license) is not original page text; original external source text is
// never fetched by role search, so every knowledge reference carries originalText: 'not-fetched'.
import type { ExpertOpinion, ProjectBrief } from './cloudbite-contract';
import { sha256Hex } from './cloudbite-knowledge';
import { phaseOnePack } from './cloudbite-personas';
import { STA_EXPERT } from './cloudbite-sta';
import { STA_PACK } from './cloudbite-sta-data';

export const EVIDENCE_PACKET_SCHEMA = 'cloudbite.evidence-packet/v1';
export const EVIDENCE_PACKET_LIMITS = Object.freeze({
  auditBytes: 64 * 1024, retrievals: 32, cardsPerRetrieval: 8, sourcesPerRetrieval: 32, observedIds: 64,
  roleBytes: 12 * 1024, totalBytes: 32 * 1024, cardSummaryBytes: 1500, minTruncatedSummaryBytes: 160, references: 48,
});

/** How the role's retrieval audit relates to the application pack. Only 'bound' exposes card text. */
export type RetrievalBinding = 'bound' | 'legacy-unbound' | 'stale' | 'foreign' | 'invalid' | 'absent' | 'no-pack';
/** Deterministic text availability of one cited reference; never a support or accuracy judgment. */
export type TextAvailability =
  | 'supplied-project-text'      // user-supplied project text (PROJECT.md, DECISION.md, uploaded doc) is present
  | 'missing-project-text'       // the cited project text exists as a slot but has no content
  | 'curated-card-text'          // a bound, observed-retrieved curated card citing this source is in the packet
  | 'curated-card-text-omitted'  // bound and observed, but its card text was cut by the packet bounds
  | 'retrieval-unverified'       // ID is in the role catalogue but the retrieval could not be bound (no/legacy/stale/foreign/invalid audit)
  | 'not-retrieved'              // ID is in the role catalogue but the bound audit shows no retrieval: catalogue presence only
  | 'unknown-id';                // not a supplied document, workspace file or source of this role

export interface KnowledgePackLike {
  expertId: string; version: string;
  cards: ReadonlyArray<{ id: string; term: string; summary: string; kind: string; source_ids: readonly string[]; provenance: string }>;
  sources: ReadonlyArray<{ id: string; title: string; url: string; license: string; aliases: readonly string[]; checkStatus?: unknown; checkedAt?: unknown }>;
}
export interface EvidencePacketCard { id: string; term: string; summary: string; kind: string; sourceIds: string[]; provenance: string; retrievalReasons: string[]; truncated: boolean }
export interface EvidencePacketSource { id: string; title: string; url: string; license: string; checkStatus: string; checkedAt: string; originalText: 'not-fetched' }
export interface EvidencePacketReference { evidenceIndex: number; kind: 'document' | 'workspace' | 'knowledge'; id: string; availability: TextAvailability; originalText?: 'not-fetched' }
export interface EvidencePacket {
  schema: typeof EVIDENCE_PACKET_SCHEMA;
  expertId: string;
  binding: RetrievalBinding;
  bindingNote: string;
  /** Identity of the application-owned pack the binding was checked against. */
  pack: { version: string; cardsSha256: string; sourcesSha256: string } | null;
  /** Retrieval as observed by the runner and identified in the application pack (bound or legacy-unbound only). */
  observed: { retrievals: number; cardIds: string[]; sourceIds: string[] };
  cards: EvidencePacketCard[];
  sources: EvidencePacketSource[];
  references: EvidencePacketReference[];
  omitted: { cards: number; sources: number; references: number; observedIds: number; unidentifiedIds: number; truncatedSummaries: number };
  /** Fixed: role search never fetches original source pages, whatever an audit claims. */
  originalSourceTextFetched: false;
  auditNotes: string[];
  bytes: number;
  sha256: string;
}
export interface EvidencePacketInput {
  brief: ProjectBrief;
  expertId: string;
  opinion: ExpertOpinion;
  /** Raw out/knowledge.json content as collected by the server (string), or already-parsed JSON; undefined when absent. */
  audit?: unknown;
  /** Application-owned pack; defaults to the catalogue pack of expertId. null forces no-pack. */
  pack?: KnowledgePackLike | null;
}

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const HEX = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();
const utf8 = (s: string) => enc.encode(s).byteLength;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WORKSPACE = new Set(['PROJECT.md', 'DECISION.md']);

/** Application-owned pack for a role: its phase-one/extension pack, or the legacy STA pack. Never caller data. */
export function applicationPack(expertId: string): KnowledgePackLike | undefined {
  return phaseOnePack(expertId) ?? (expertId === STA_EXPERT.id ? STA_PACK : undefined);
}

const packMemo = new WeakMap<object, { cardsSha256: string; sourcesSha256: string; packSha256: string }>();
/** sha256 of the canonical cards/sources files the runner checks; same bytes as knowledge/{cards,sources}.json. */
export function packHashes(pack: KnowledgePackLike) {
  let h = packMemo.get(pack);
  if (!h) { h = { cardsSha256: sha256Hex(JSON.stringify(pack.cards)), sourcesSha256: sha256Hex(JSON.stringify(pack.sources)), packSha256: sha256Hex(JSON.stringify(pack)) }; packMemo.set(pack, h); }
  return h;
}

/** Truncate to at most max UTF-8 bytes on a code-point boundary. */
export function truncateUtf8(s: string, max: number): string {
  if (utf8(s) <= max) return s;
  let out = '', n = 0;
  for (const ch of s) { const b = utf8(ch); if (n + b > max - 3) break; out += ch; n += b; }
  return out + '…';
}

interface ParsedAudit { version: unknown; expertId: unknown; schema: unknown; provenance: Record<string, unknown>; retrievals: Array<{ reason: string; cardIds: string[]; sourceIds: string[] }>; sourceIds: string[]; claimsFetched: boolean }
/** Strict structural parse of an untrusted audit. Returns a reason string when it cannot be read safely. */
function parseAudit(raw: unknown): ParsedAudit | string {
  let j = raw;
  if (typeof raw === 'string') {
    if (utf8(raw) > EVIDENCE_PACKET_LIMITS.auditBytes) return 'audit exceeds the size bound';
    try { j = JSON.parse(raw); } catch { return 'audit is not JSON'; }
  } else {
    let s: string | undefined;
    try { s = JSON.stringify(raw); } catch { return 'audit is not serializable'; }
    if (s === undefined || utf8(s) > EVIDENCE_PACKET_LIMITS.auditBytes) return 'audit exceeds the size bound';
  }
  if (!isObj(j)) return 'audit is not an object';
  const provenance = isObj(j.provenance) ? j.provenance : {};
  if (!Array.isArray(j.retrievals) || j.retrievals.length > EVIDENCE_PACKET_LIMITS.retrievals) return 'audit retrievals missing or over the bound';
  const retrievals: ParsedAudit['retrievals'] = [];
  for (const r of j.retrievals) {
    if (!isObj(r) || typeof r.reason !== 'string' || r.reason.length > 40 || !Array.isArray(r.cardIds) || !Array.isArray(r.sourceIds)) return 'audit retrieval entry is malformed';
    if (r.cardIds.length > EVIDENCE_PACKET_LIMITS.cardsPerRetrieval || r.sourceIds.length > EVIDENCE_PACKET_LIMITS.sourcesPerRetrieval) return 'audit retrieval entry is over the bound';
    if (![...r.cardIds, ...r.sourceIds].every((x) => typeof x === 'string' && ID.test(x))) return 'audit retrieval contains an invalid ID';
    retrievals.push({ reason: r.reason.replace(/[^\w .-]/g, ' '), cardIds: r.cardIds as string[], sourceIds: r.sourceIds as string[] });
  }
  const sources = Array.isArray(j.sources) ? j.sources : [];
  const sourceIds = sources.map((s) => (isObj(s) ? s.id : undefined));
  if (sources.length > 256 || !sourceIds.every((x): x is string => typeof x === 'string' && ID.test(x))) return 'audit source records are malformed';
  return { version: j.version, expertId: j.expertId, schema: j.schema, provenance, retrievals, sourceIds, claimsFetched: j.sourcePagesFetched === true };
}

/** Sources a set of cards resolves to in one pack (by id or alias), in pack order. */
function resolveSources(pack: KnowledgePackLike, cardIds: Iterable<string>) {
  const cards = new Map(pack.cards.map((c) => [c.id, c]));
  const ids = new Set([...cardIds].flatMap((id) => [...(cards.get(id)?.source_ids ?? [])]));
  return pack.sources.filter((s) => ids.has(s.id) || s.aliases.some((a) => ids.has(a)));
}

interface Binding { binding: RetrievalBinding; note: string; observedCards: string[]; observedSources: string[]; reasons: Map<string, string[]>; retrievals: number; unidentified: number; notes: string[] }

function bind(expertId: string, pack: KnowledgePackLike | undefined, raw: unknown): Binding {
  const b: Binding = { binding: 'absent', note: '', observedCards: [], observedSources: [], reasons: new Map(), retrievals: 0, unidentified: 0, notes: [] };
  const done = (binding: RetrievalBinding, note: string) => Object.assign(b, { binding, note });
  if (!pack) return done('no-pack', raw === undefined ? 'this role has no curated knowledge pack' : 'this role has no curated knowledge pack; the supplied audit was ignored');
  if (pack.expertId !== expertId) return done('foreign', 'the supplied knowledge pack belongs to another role');
  if (raw === undefined || raw === null) return done('absent', 'no retrieval audit was collected for this role; retrieval is unobserved');
  const a = parseAudit(raw);
  if (typeof a === 'string') return done('invalid', a);
  if (a.claimsFetched) b.notes.push('audit claimed source pages were fetched; ignored (role search never fetches original pages)');
  if (a.expertId !== undefined && a.expertId !== expertId) return done('foreign', 'the audit names another role');
  const cardIds = a.retrievals.flatMap((r) => r.cardIds), packCards = new Set(pack.cards.map((c) => c.id));
  const packSources = new Set(pack.sources.flatMap((s) => [s.id, ...s.aliases]));
  const cardsH = a.provenance.cardsSha256, sourcesH = a.provenance.sourcesSha256;
  if (typeof cardsH !== 'string' || typeof sourcesH !== 'string' || !HEX.test(cardsH) || !HEX.test(sourcesH)) {
    // Legacy audit with no pack hash: only IDs that exist in the current pack are identified, no text is exposed.
    const ids = [...new Set(cardIds)], src = [...new Set([...a.retrievals.flatMap((r) => r.sourceIds), ...a.sourceIds])];
    const known = ids.filter((id) => packCards.has(id)), knownSrc = src.filter((id) => packSources.has(id));
    b.observedCards = known.slice(0, EVIDENCE_PACKET_LIMITS.observedIds); b.observedSources = knownSrc.slice(0, EVIDENCE_PACKET_LIMITS.observedIds);
    b.unidentified = ids.length + src.length - b.observedCards.length - b.observedSources.length;
    b.retrievals = a.retrievals.length;
    return done('legacy-unbound', 'audit predates pack hashes; IDs present in the current pack are listed, card text is withheld because the retrieved version cannot be identified');
  }
  const h = packHashes(pack);
  if (a.version !== pack.version || cardsH !== h.cardsSha256 || sourcesH !== h.sourcesSha256 || (a.schema !== undefined && typeof a.provenance.packSha256 === 'string' && a.provenance.packSha256 !== h.packSha256)) {
    b.unidentified = new Set(cardIds).size;
    return done('stale', 'audit is bound to a different pack version or hash than the application pack; nothing is exposed');
  }
  for (const r of a.retrievals) {
    if (r.cardIds.some((id) => !packCards.has(id))) return done('invalid', 'audit retrieval names a card that is not in the bound pack');
    const expected = resolveSources(pack, r.cardIds).map((s) => s.id).sort().join(','), got = [...new Set(r.sourceIds)].sort().join(',');
    if (expected !== got) return done('invalid', 'audit retrieval source IDs do not match the bound cards\' sources');
  }
  const retrievedSources = new Set(a.retrievals.flatMap((r) => r.sourceIds));
  if (a.sourceIds.some((id) => !retrievedSources.has(id))) return done('invalid', 'audit source records include a source that was never retrieved');
  for (const r of a.retrievals) for (const id of r.cardIds) {
    const reasons = b.reasons.get(id) ?? [];
    if (!reasons.includes(r.reason)) reasons.push(r.reason);
    b.reasons.set(id, reasons);
  }
  const all = [...b.reasons.keys()];
  b.observedCards = all.slice(0, EVIDENCE_PACKET_LIMITS.observedIds);
  b.observedSources = resolveSources(pack, b.observedCards).map((s) => s.id).slice(0, EVIDENCE_PACKET_LIMITS.observedIds);
  b.unidentified = all.length - b.observedCards.length;
  b.retrievals = a.retrievals.length;
  return done('bound', 'audit is bound to the application pack by role, version and cards/sources sha256');
}

/** Every [doc:ID] / [source:ID] in an opinion's evidence with its deterministic text availability. Pure. */
export function evidenceReferences(brief: ProjectBrief, opinion: ExpertOpinion, pack: KnowledgePackLike | undefined,
  binding: RetrievalBinding = 'absent', observedSources: readonly string[] = [], includedSources: ReadonlySet<string> = new Set()): EvidencePacketReference[] {
  const docs = new Map((brief.documents ?? []).map((d) => [d.id, d]));
  const catalogue = new Map<string, string>();
  for (const s of pack?.sources ?? []) for (const id of [s.id, ...s.aliases]) catalogue.set(id, s.id);
  const observed = new Set(observedSources);
  const out: EvidencePacketReference[] = [];
  opinion.evidence.forEach((text, evidenceIndex) => {
    const seen = new Set<string>();
    for (const m of String(text).matchAll(/\[(doc|source):([^\]]*)\]/g)) {
      const id = m[2], key = m[1] + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key);
      if (m[1] === 'doc') {
        const d = docs.get(id);
        out.push({ evidenceIndex, kind: 'document', id, availability: !d ? 'unknown-id' : d.content.trim() ? 'supplied-project-text' : 'missing-project-text' });
      } else if (WORKSPACE.has(id)) {
        out.push({ evidenceIndex, kind: 'workspace', id, availability: id === 'DECISION.md' && !brief.decision ? 'missing-project-text' : 'supplied-project-text' });
      } else {
        const canonical = catalogue.get(id);
        const availability: TextAvailability = canonical === undefined ? 'unknown-id'
          : binding !== 'bound' ? 'retrieval-unverified'
          : !observed.has(canonical) ? 'not-retrieved'
          : includedSources.has(canonical) ? 'curated-card-text' : 'curated-card-text-omitted';
        out.push({ evidenceIndex, kind: 'knowledge', id, availability, originalText: 'not-fetched' });
      }
    }
  });
  return out;
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
};
const sealed = (body: Omit<EvidencePacket, 'bytes' | 'sha256'>): EvidencePacket => {
  const json = JSON.stringify(body);
  return deepFreeze({ ...body, bytes: utf8(json), sha256: sha256Hex(json) });
};
const sizeOf = (body: Omit<EvidencePacket, 'bytes' | 'sha256'>) => utf8(JSON.stringify(body)) + 100; // + bytes/sha256 fields

/**
 * One role's bounded packet. budget caps its UTF-8 size (default roleBytes). Inputs are never mutated; the result is
 * deeply frozen. Card text appears only for a bound audit, in observed retrieval order, until the budget is spent.
 */
export function buildEvidencePacket(input: EvidencePacketInput, budget: number = EVIDENCE_PACKET_LIMITS.roleBytes): EvidencePacket {
  const max = Math.max(0, Math.min(budget, EVIDENCE_PACKET_LIMITS.roleBytes));
  const pack = input.pack === null ? undefined : input.pack ?? applicationPack(input.expertId);
  const b = bind(input.expertId, pack, input.audit);
  const h = pack && pack.expertId === input.expertId ? packHashes(pack) : null;
  const allRefs = evidenceReferences(input.brief, input.opinion, b.binding === 'foreign' ? undefined : pack, b.binding, b.observedSources);
  const body: Omit<EvidencePacket, 'bytes' | 'sha256'> = {
    schema: EVIDENCE_PACKET_SCHEMA, expertId: input.expertId, binding: b.binding, bindingNote: b.note,
    pack: h && pack ? { version: pack.version, cardsSha256: h.cardsSha256, sourcesSha256: h.sourcesSha256 } : null,
    observed: { retrievals: b.retrievals, cardIds: [...b.observedCards], sourceIds: [...b.observedSources] },
    cards: [], sources: [], references: [],
    omitted: { cards: 0, sources: 0, references: 0, observedIds: 0, unidentifiedIds: b.unidentified, truncatedSummaries: 0 },
    originalSourceTextFetched: false, auditNotes: b.notes,
  };
  // Observed ID lists are metadata; they yield to the budget before references and cards do.
  while (sizeOf(body) > max && (body.observed.cardIds.length || body.observed.sourceIds.length)) {
    (body.observed.sourceIds.length >= body.observed.cardIds.length ? body.observed.sourceIds : body.observed.cardIds).pop();
    body.omitted.observedIds++;
  }
  const refs = allRefs.slice(0, EVIDENCE_PACKET_LIMITS.references);
  for (const r of refs) { body.references.push(r); if (sizeOf(body) > max) { body.references.pop(); break; } }
  // Cards: evidence-cited sources first, then remaining observed cards, each with its own source records.
  if (b.binding === 'bound' && pack) {
    const cardById = new Map(pack.cards.map((c) => [c.id, c]));
    const cited = new Set(refs.filter((r) => r.kind === 'knowledge').map((r) => r.id));
    const citesCited = (id: string) => resolveSources(pack, [id]).some((s) => cited.has(s.id) || s.aliases.some((a) => cited.has(a)));
    const order = [...b.observedCards.filter(citesCited), ...b.observedCards.filter((id) => !citesCited(id))];
    const sourceIds = new Set<string>();
    for (const id of order) {
      const c = cardById.get(id)!;
      const card: EvidencePacketCard = { id: c.id, term: truncateUtf8(c.term, 200), summary: truncateUtf8(c.summary, EVIDENCE_PACKET_LIMITS.cardSummaryBytes), kind: truncateUtf8(c.kind, 40),
        sourceIds: [...c.source_ids], provenance: truncateUtf8(c.provenance, 300), retrievalReasons: b.reasons.get(id) ?? [], truncated: utf8(c.summary) > EVIDENCE_PACKET_LIMITS.cardSummaryBytes };
      const newSources = resolveSources(pack, [id]).filter((s) => !sourceIds.has(s.id)).map((s): EvidencePacketSource => ({
        id: s.id, title: truncateUtf8(s.title, 200), url: truncateUtf8(s.url, 300), license: truncateUtf8(s.license, 120),
        checkStatus: typeof s.checkStatus === 'string' ? truncateUtf8(s.checkStatus, 20) : 'not-recorded', checkedAt: typeof s.checkedAt === 'string' ? truncateUtf8(s.checkedAt, 40) : '', originalText: 'not-fetched' }));
      body.cards.push(card); body.sources.push(...newSources);
      if (sizeOf(body) > max) {
        // Try a shorter summary before omitting the card entirely.
        const over = sizeOf(body) - max, keep = utf8(card.summary) - over - 8;
        if (keep >= EVIDENCE_PACKET_LIMITS.minTruncatedSummaryBytes) { card.summary = truncateUtf8(card.summary, keep); card.truncated = true; }
        if (sizeOf(body) > max) { body.cards.pop(); body.sources.splice(body.sources.length - newSources.length); body.omitted.cards++; continue; }
      }
      if (card.truncated) body.omitted.truncatedSummaries++;
      for (const s of newSources) sourceIds.add(s.id);
    }
    const included = new Set(resolveSources(pack, body.cards.map((c) => c.id)).map((s) => s.id));
    body.omitted.sources = b.observedSources.filter((id) => !included.has(id)).length;
    // Re-derive availability now that the included card set is known (omitted text is reported, never implied).
    const final = evidenceReferences(input.brief, input.opinion, pack, b.binding, b.observedSources, included).slice(0, body.references.length);
    body.references.splice(0, body.references.length, ...final);
  }
  body.omitted.references = allRefs.length - body.references.length;
  return sealed(body);
}

/**
 * Packets for several roles under one total UTF-8 budget, in the given order. The per-role budget is the smaller of
 * roleBytes and what remains; later roles may therefore carry fewer cards, and say so in omitted counts.
 */
export function buildEvidencePackets(inputs: readonly EvidencePacketInput[], totalBytes: number = EVIDENCE_PACKET_LIMITS.totalBytes): EvidencePacket[] {
  let remaining = Math.max(0, Math.min(totalBytes, EVIDENCE_PACKET_LIMITS.totalBytes));
  return inputs.map((input, i) => {
    // Fair share of what remains: bytes a small packet leaves unused carry over to the roles after it.
    const p = buildEvidencePacket(input, Math.floor(remaining / (inputs.length - i)));
    remaining = Math.max(0, remaining - p.bytes);
    return p;
  });
}
