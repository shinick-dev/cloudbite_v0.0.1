// Grounded retrieval v2: one deterministic lexical ranker shared by workspace selection (TypeScript) and the sandbox
// runner's follow-up search (RETRIEVAL_PY, embedded in CB_RUNNER_PY). Both sides implement the same algorithm and are
// checked for parity on the real packs (test/cloudbite-v7-retrieval.mjs). Nothing here fetches a URL or calls a model.
//
// Score = weighted exact card tags (the legacy STA/phase-one weights) + a saturated BM25 over the card's own authored
// text (term + summary). Only libm's log differs between languages, so each IDF is quantized to integer micro-units and
// every score to integer milli-units before ranking; ties break by pack order. Current cards are authored syntheses,
// never original source excerpts; the chunk contract below keeps that distinction explicit for any future corpus.
import { sha256Hex } from './cloudbite-knowledge';

export const RETRIEVAL_SCHEMA = 'cloudbite.retrieval/v2';
export const LEXICAL_STRATEGY = 'lexical-exact-bm25/v1';
/** Initial workspace selection with no query hit: the role's entry cards, disclosed as orientation, never as search evidence. */
export const FALLBACK_STRATEGY = 'orientation-fallback';
export const RETRIEVAL_PARAMS = Object.freeze({ k1: 1.2, b: 0.75, contentCap: 6, queryTokens: 256, contentTerms: 5 });
/** Workspace files are capped at 48 KiB (KNOWLEDGE_LIMITS.fileBytes); a chunk never exceeds that. */
const CHUNK_MAX_BYTES = 48 * 1024;
// Function words carry no topic; Hangul entries are particle/ending bigrams that recur across unrelated sentences.
export const RETRIEVAL_STOPWORDS: readonly string[] = Object.freeze([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have', 'how', 'if', 'in',
  'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'our', 'should', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'these',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'no', 'any', 'all',
  '하는', '에서', '으로', '이다', '한다', '있다', '하고', '하지', '되는', '에게', '까지', '부터', '보다', '또는', '그리고', '합니다', '니다', '습니',
]);
const STOP: ReadonlySet<string> = new Set(RETRIEVAL_STOPWORDS);

export const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const WORD = /[a-z0-9_]/;
/** Legacy exact-term rule: Hangul terms match as substrings, others on word boundaries. */
export function termMatches(query: string, term: string): boolean {
  const t = norm(term);
  let p = t ? query.indexOf(t) : -1;
  if (p < 0) return false;
  if (/[가-힣]/.test(t)) return true;
  while (p >= 0) {
    const left = p === 0 || !WORD.test(query[p - 1]) || !WORD.test(t[0]);
    const right = p + t.length === query.length || !WORD.test(query[p + t.length]) || !WORD.test(t[t.length - 1]);
    if (left && right) return true;
    p = query.indexOf(t, p + 1);
  }
  return false;
}
/** Legacy tag weights on the normalized term: identifiers/flags 8, phrases 5, Hangul 4, short 2, other 3. */
export const termWeight = (t: string) => t.includes('_') || t.startsWith('-') ? 8 : /[ /-]/.test(t) ? 5 : /[가-힣]/.test(t) ? 4 : t.length <= 2 ? 2 : 3;

/** Content tokens: ASCII words (>= 2 chars) and Hangul syllable bigrams (a lone syllable stays a unigram); stopwords removed. */
export function retrievalTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of norm(text).matchAll(/[a-z0-9_]+|[가-힣]+/g)) {
    const w = m[0];
    if (/^[가-힣]/.test(w)) {
      if (w.length === 1) { if (!STOP.has(w)) out.push(w); }
      else for (let i = 0; i + 1 < w.length; i++) { const g = w.slice(i, i + 2); if (!STOP.has(g)) out.push(g); }
    } else if (w.length >= 2 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/** Each Hangul query token mapped to the distinct Hangul query words (by text) whose bigrams produced it. */
function hangulTokenWords(q: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of norm(q).matchAll(/[가-힣]+/g)) {
    for (const t of retrievalTokens(m[0])) {
      const ws = out.get(t) ?? [];
      if (!ws.includes(m[0])) ws.push(m[0]);
      out.set(t, ws);
    }
  }
  return out;
}

export interface RankableCard { id: string; term: string; summary: string; match: string[]; source_ids: string[] }
export interface RankedCard {
  id: string; index: number;
  /** Integer milli-units: exact * 1000 + content. */
  score: number;
  /** Sum of matched tag weights. */
  exact: number;
  /** Saturated BM25 over authored card text, integer milli-units (< contentCap * 1000). */
  content: number;
  /** The card's own matched tags (normalized). */
  terms: string[];
  /** Up to five card-text tokens shared with the query, sorted. */
  contentTerms: string[];
}

/** The authored text that is ranked and hashed; a minimal card without term or summary contributes nothing. */
const cardText = (c: RankableCard) => `${typeof c.term === 'string' ? c.term : ''}\n${typeof c.summary === 'string' ? c.summary : ''}`;
const q6 = (x: number) => Math.floor(x * 1e6 + 0.5);
const q3 = (x: number) => Math.floor(x * 1000 + 0.5);

/** Every card with a hit, best first (score desc, pack order). Pure and deterministic; the query is never stored. */
export function rankCards(cards: readonly RankableCard[], query: string, maxQuery = 12000): RankedCard[] {
  const { k1, b, contentCap, queryTokens } = RETRIEVAL_PARAMS;
  const q = norm(String(query ?? '').slice(0, maxQuery));
  const seen = new Set<string>();
  for (const t of retrievalTokens(q)) { if (seen.size >= queryTokens) break; seen.add(t); }
  const qt = [...seen].sort();
  const hangulWords = hangulTokenWords(q);
  const docs = cards.map(c => retrievalTokens(cardText(c)));
  const n = cards.length;
  const avgdl = (docs.reduce((s, d) => s + d.length, 0) / (n || 1)) || 1;
  const idf = new Map<string, number>();
  for (const t of qt) {
    const df = docs.reduce((s, d) => s + (d.includes(t) ? 1 : 0), 0);
    // a token in more than half of a pack's cards does not discriminate between them
    if (df === 0 || (n >= 4 && df * 2 > n)) continue;
    idf.set(t, q6(Math.log(1 + (n - df + 0.5) / (df + 0.5))));
  }
  const ranked: RankedCard[] = [];
  cards.forEach((card, index) => {
    const terms: string[] = [];
    let exact = 0;
    for (const t of card.match) if (termMatches(q, t)) { const nt = norm(t); exact += termWeight(nt); if (!terms.includes(nt)) terms.push(nt); }
    const doc = docs[index], dl = doc.length;
    let bm = 0, ascii = 0;
    const hits: string[] = [], words = new Set<string>();
    for (const t of qt) {
      const w = idf.get(t);
      if (w === undefined) continue;
      let tf = 0;
      for (const d of doc) if (d === t) tf++;
      if (!tf) continue;
      bm += (w / 1e6) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
      hits.push(t);
      if (/^[가-힣]/.test(t)) for (const w of hangulWords.get(t) ?? []) words.add(w); else ascii++;
    }
    // Hangul content needs evidence from two different query words: the overlapping bigrams of one word (결과로 →
    // 결과 + 과로) are a single piece of evidence, and the cross-morpheme bigram is often an unrelated word
    if (!(ascii >= 1 || words.size >= 2)) { bm = 0; hits.length = 0; }
    const content = bm > 0 ? q3(contentCap * bm / (bm + contentCap)) : 0;
    const score = exact * 1000 + content;
    if (score > 0) ranked.push({ id: card.id, index, score, exact, content, terms, contentTerms: hits.slice(0, RETRIEVAL_PARAMS.contentTerms) });
  });
  return ranked.sort((x, y) => y.score - x.score || x.index - y.index);
}

/** Top-k with content-hash dedup and source diversity: when the best remaining card adds no new source, the first
 *  card that does is taken instead, provided it scores at least half as much. */
export function selectRanked(cards: readonly RankableCard[], ranked: readonly RankedCard[], k: number): RankedCard[] {
  const limit = Math.max(1, Math.min(8, Math.floor(k) || 1));
  const hashes = new Set<string>();
  const rest: RankedCard[] = [];
  for (const r of ranked) {
    const h = sha256Hex(cardText(cards[r.index]));
    if (hashes.has(h)) continue;
    hashes.add(h); rest.push(r);
  }
  const seen = new Set<string>(), out: RankedCard[] = [];
  while (out.length < limit && rest.length) {
    const fresh = (r: RankedCard) => cards[r.index].source_ids.some(id => !seen.has(id));
    let pick = 0;
    if (!fresh(rest[0])) {
      for (let j = 1; j < rest.length; j++) {
        if (rest[j].score * 2 < rest[0].score) break;
        if (fresh(rest[j])) { pick = j; break; }
      }
    }
    const [r] = rest.splice(pick, 1);
    for (const id of cards[r.index].source_ids) seen.add(id);
    out.push(r);
  }
  return out;
}

export function retrieveRanked(cards: readonly RankableCard[], query: string, k: number, maxQuery = 12000): RankedCard[] {
  return selectRanked(cards, rankCards(cards, query, maxQuery), k);
}

/** Compact ranking record for manifests and KNOWLEDGE.md (no query text). */
export const rankingRecord = (r: Omit<RankedCard, 'index'>) => ({ id: r.id, score: r.score, exact: r.exact, content: r.content, terms: r.terms.slice(0, 6), contentTerms: r.contentTerms });

// ── chunk / source metadata contract ──
export type ChunkRepresentation = 'authored-synthesis' | 'original-excerpt';
export type ChunkRights = 'project-authored' | 'owned' | 'licensed';
export interface ChunkMetadata {
  schema: typeof RETRIEVAL_SCHEMA; chunkId: string; sourceIds: string[]; sourceVersion: string; parentId: string | null;
  headingPath: string[]; contentSha256: string; bytes: number; representation: ChunkRepresentation;
  /** True only for an original-excerpt from an owned or licensed import. Authored cards are never original text. */
  originalText: boolean; rights: ChunkRights;
}
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const utf8 = (s: string) => new TextEncoder().encode(s).length;

/** Metadata of one existing card: a project-authored synthesis about its sources, not a quotation of them. */
export function cardChunkMetadata(card: RankableCard, packVersion: string): ChunkMetadata {
  const text = cardText(card);
  return { schema: RETRIEVAL_SCHEMA, chunkId: card.id, sourceIds: [...card.source_ids], sourceVersion: packVersion, parentId: null, headingPath: [card.term],
    contentSha256: sha256Hex(text), bytes: utf8(text), representation: 'authored-synthesis', originalText: false, rights: 'project-authored' };
}

export interface MarkdownDocument { sourceId: string; sourceVersion: string; text: string; representation: ChunkRepresentation; rights: ChunkRights }
export interface MarkdownChunk extends ChunkMetadata { text: string }
export interface MarkdownParent { parentId: string; headingPath: string[]; contentSha256: string; chunkIds: string[] }
type Block = { kind: 'paragraph' | 'code fence' | 'math block' | 'table'; text: string; line: number };

/** Structurally bounded markdown chunking for a future imported owned/licensed corpus. Headings open parent sections;
 *  code fences, $$ math blocks and tables are indivisible, paragraphs split only at line breaks. A unit that cannot fit
 *  maxBytes is rejected with an actionable error instead of being cut. Throws on invalid input. */
export function chunkMarkdown(doc: MarkdownDocument, opts: { maxBytes?: number } = {}): { parents: MarkdownParent[]; chunks: MarkdownChunk[] } {
  const maxBytes = opts.maxBytes ?? 4096;
  const fail = (why: string): never => { throw new Error(`chunkMarkdown ${doc?.sourceId ?? '?'}: ${why}`); };
  if (!doc || !SOURCE_ID.test(doc.sourceId)) fail('sourceId must be 1-80 letters, digits, _ or -');
  if (typeof doc.sourceVersion !== 'string' || !doc.sourceVersion.trim() || doc.sourceVersion.length > 80) fail('sourceVersion is required (1-80 characters)');
  if (doc.representation === 'original-excerpt') { if (doc.rights !== 'owned' && doc.rights !== 'licensed') fail('an original-excerpt import requires rights owned or licensed'); }
  else if (doc.representation !== 'authored-synthesis' || doc.rights !== 'project-authored') fail('authored-synthesis must have rights project-authored');
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > CHUNK_MAX_BYTES) fail(`maxBytes must be an integer 256-${CHUNK_MAX_BYTES}`);
  if (typeof doc.text !== 'string') fail('text must be a string');

  const lines = doc.text.replace(/\r\n?/g, '\n').split('\n');
  const sections: Array<{ path: string[]; blocks: Block[] }> = [{ path: [], blocks: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let para: string[] = [], paraLine = 0;
  const cur = () => sections[sections.length - 1];
  const flush = () => { if (para.length) cur().blocks.push({ kind: 'paragraph', text: para.join('\n'), line: paraLine }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence || /^\s*\$\$/.test(line)) {
      flush();
      const start = i, kind = fence ? 'code fence' : 'math block';
      const close = fence ? (l: string) => new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(l) : (l: string) => /\$\$\s*$/.test(l);
      // a one-line $$...$$ block closes on its own line
      if (!(kind === 'math block' && /^\s*\$\$.*\S.*\$\$\s*$/.test(line))) {
        i++;
        while (i < lines.length && !close(lines[i])) i++;
        if (i >= lines.length) fail(`unclosed ${kind} starting at line ${start + 1}; close it in the source document`);
      }
      cur().blocks.push({ kind, text: lines.slice(start, i + 1).join('\n'), line: start + 1 });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: heading[2] });
      sections.push({ path: stack.map(s => s.title), blocks: [] });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const start = i;
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) i++;
      cur().blocks.push({ kind: 'table', text: lines.slice(start, i + 1).join('\n'), line: start + 1 });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (!para.length) paraLine = i + 1;
    para.push(line);
  }
  flush();

  const parents: MarkdownParent[] = [], chunks: MarkdownChunk[] = [];
  const meta = { schema: RETRIEVAL_SCHEMA, sourceIds: [doc.sourceId], sourceVersion: doc.sourceVersion, representation: doc.representation,
    originalText: doc.representation === 'original-excerpt', rights: doc.rights } as const;
  sections.filter(s => s.blocks.length).forEach((s, si) => {
    const parentId = `${doc.sourceId}#s${si + 1}`;
    const where = s.path.length ? `under "${s.path.join(' > ')}"` : 'before the first heading';
    // units: atomic blocks whole, paragraphs by line; sep is what joins a unit to its predecessor inside one chunk,
    // so the lines of a split paragraph keep their single line breaks
    const units: Array<{ text: string; sep: string }> = [];
    for (const blk of s.blocks) {
      if (utf8(blk.text) <= maxBytes) { units.push({ text: blk.text, sep: '\n\n' }); continue; }
      if (blk.kind !== 'paragraph') fail(`indivisible ${blk.kind} at line ${blk.line} ${where} is ${utf8(blk.text)} bytes > maxBytes ${maxBytes}; split it in the source document or raise maxBytes (at most ${CHUNK_MAX_BYTES})`);
      blk.text.split('\n').forEach((l, j) => {
        if (utf8(l) > maxBytes) fail(`line ${blk.line + j} ${where} is ${utf8(l)} bytes > maxBytes ${maxBytes} and cannot be split without cutting text; shorten it in the source or raise maxBytes`);
        units.push({ text: l, sep: j ? '\n' : '\n\n' });
      });
    }
    const texts: string[] = [];
    let acc = '';
    for (const u of units) {
      const next = acc ? acc + u.sep + u.text : u.text;
      if (acc && utf8(next) > maxBytes) { texts.push(acc); acc = u.text; } else acc = next;
    }
    if (acc) texts.push(acc);
    const ids = texts.map((t, ci) => {
      const chunkId = `${parentId}.c${ci + 1}`;
      chunks.push({ ...meta, sourceIds: [doc.sourceId], chunkId, parentId, headingPath: [...s.path], contentSha256: sha256Hex(t), bytes: utf8(t), text: t });
      return chunkId;
    });
    parents.push({ parentId, headingPath: [...s.path], contentSha256: sha256Hex(s.blocks.map(x => x.text).join('\n\n')), chunkIds: ids });
  });
  return { parents, chunks };
}

// ── optional semantic re-ranking interface (not deployed) ──
/** Implemented: the interface, validation and fusion below. Not implemented or configured: any embedding provider.
 *  Production ranking is lexical; nothing in the workspace or runner calls this. */
export const SEMANTIC_RANKING = Object.freeze({ status: 'interface-only', deployed: false, provider: null,
  note: 'No embedding provider is configured; follow-up and initial ranking are lexical (lexical-exact-bm25/v1).' });
export interface SemanticEmbedder { provider: string; model: string; dimension: number; embed(texts: string[]): number[][] }
export interface SemanticRankedCard extends RankedCard { semantic: number; fused: number; provenance: { provider: string; model: string; dimension: number } }

/** Re-rank lexical hits with a caller-supplied embedder; candidates stay the lexical hits, so a semantic score can
 *  never turn a no-hit into a hit or unlock a citation. Throws on a dimension or shape mismatch. */
export function semanticRerank(cards: readonly RankableCard[], ranked: readonly RankedCard[], query: string, embedder: SemanticEmbedder, weight = 2): SemanticRankedCard[] {
  const { provider, model, dimension } = embedder ?? ({} as SemanticEmbedder);
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) throw new Error('semantic embedder needs provider and model provenance');
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) throw new Error('semantic embedder dimension must be an integer 1-4096');
  if (!ranked.length) return [];
  const vecs = embedder.embed([String(query).slice(0, 12000), ...ranked.map(r => cardText(cards[r.index]))]);
  if (!Array.isArray(vecs) || vecs.length !== ranked.length + 1) throw new Error('semantic embedder returned the wrong number of vectors');
  for (const v of vecs) if (!Array.isArray(v) || v.length !== dimension || !v.every(Number.isFinite)) throw new Error(`semantic vector dimension mismatch: expected ${dimension}`);
  const len = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  const qv = vecs[0], ql = len(qv);
  return ranked.map((r, i) => {
    const v = vecs[i + 1];
    const semantic = q3(v.reduce((s, x, j) => s + x * qv[j], 0) / (len(v) * ql));
    return { ...r, semantic, fused: r.score + Math.max(0, semantic) * weight, provenance: { provider, model, dimension } };
  }).sort((x, y) => y.fused - x.fused || x.index - y.index);
}

// ── Python twin for the sandbox runner (stdlib only); keep in lockstep with rankCards/selectRanked above ──
export const RETRIEVAL_PY = String.raw`
RETRIEVAL_SCHEMA = '${RETRIEVAL_SCHEMA}'
LEXICAL_STRATEGY = '${LEXICAL_STRATEGY}'
RETRIEVAL_K1 = ${RETRIEVAL_PARAMS.k1}
RETRIEVAL_B = ${RETRIEVAL_PARAMS.b}
RETRIEVAL_CAP = ${RETRIEVAL_PARAMS.contentCap}
RETRIEVAL_QUERY_TOKENS = ${RETRIEVAL_PARAMS.queryTokens}
RETRIEVAL_CONTENT_TERMS = ${RETRIEVAL_PARAMS.contentTerms}
RETRIEVAL_STOP = set(${JSON.stringify(RETRIEVAL_STOPWORDS)})


def retrieval_norm(s):
    return unicodedata.normalize('NFKC', s).lower()


def retrieval_term_hit(q, term):
    t = retrieval_norm(term)
    if not t: return False
    if re.search(r'[가-힣]', t): return t in q
    return bool(re.search((r'(?<![a-z0-9_])' if re.match(r'[a-z0-9_]', t[0]) else '') + re.escape(t) + (r'(?![a-z0-9_])' if re.match(r'[a-z0-9_]', t[-1]) else ''), q))


def retrieval_weight(t):
    return 8 if '_' in t or t.startswith('-') else 5 if re.search(r'[ /-]', t) else 4 if re.search(r'[가-힣]', t) else 2 if len(t) <= 2 else 3


def retrieval_tokens(text):
    out = []
    for w in re.findall(r'[a-z0-9_]+|[가-힣]+', retrieval_norm(text)):
        if re.match(r'[가-힣]', w):
            grams = [w] if len(w) == 1 else [w[i:i + 2] for i in range(len(w) - 1)]
            out.extend(g for g in grams if g not in RETRIEVAL_STOP)
        elif len(w) >= 2 and w not in RETRIEVAL_STOP:
            out.append(w)
    return out


def retrieval_hangul_words(q):
    out = {}
    for w in re.findall(r'[가-힣]+', retrieval_norm(q)):
        for t in retrieval_tokens(w):
            ws = out.setdefault(t, [])
            if w not in ws: ws.append(w)
    return out


def retrieval_card_text(c):
    t, s = c.get('term'), c.get('summary')
    return '%s\n%s' % (t if isinstance(t, str) else '', s if isinstance(s, str) else '')


def rank_cards(cards, query, max_query=12000):
    q = retrieval_norm(str(query or '')[:max_query])
    seen = []
    for t in retrieval_tokens(q):
        if len(seen) >= RETRIEVAL_QUERY_TOKENS: break
        if t not in seen: seen.append(t)
    qt = sorted(seen)
    hangul_words = retrieval_hangul_words(q)
    docs = [retrieval_tokens(retrieval_card_text(c)) for c in cards]
    n = len(cards)
    avgdl = (sum(len(d) for d in docs) / (n or 1)) or 1
    idf = {}
    for t in qt:
        df = sum(1 for d in docs if t in d)
        if df == 0 or (n >= 4 and df * 2 > n): continue
        idf[t] = math.floor(math.log(1 + (n - df + 0.5) / (df + 0.5)) * 1e6 + 0.5)
    ranked = []
    for index, card in enumerate(cards):
        terms, exact = [], 0
        for t in card['match']:
            if retrieval_term_hit(q, t):
                nt = retrieval_norm(t)
                exact += retrieval_weight(nt)
                if nt not in terms: terms.append(nt)
        doc = docs[index]
        dl = len(doc)
        bm, ascii_hits, hits, words = 0, 0, [], set()
        for t in qt:
            if t not in idf: continue
            tf = doc.count(t)
            if not tf: continue
            bm += (idf[t] / 1e6) * (tf * (RETRIEVAL_K1 + 1)) / (tf + RETRIEVAL_K1 * (1 - RETRIEVAL_B + RETRIEVAL_B * dl / avgdl))
            hits.append(t)
            if re.match(r'[가-힣]', t): words.update(hangul_words.get(t, []))
            else: ascii_hits += 1
        if not (ascii_hits >= 1 or len(words) >= 2):
            bm, hits = 0, []
        content = math.floor(RETRIEVAL_CAP * bm / (bm + RETRIEVAL_CAP) * 1000 + 0.5) if bm > 0 else 0
        score = exact * 1000 + content
        if score > 0:
            ranked.append({'id': card['id'], 'index': index, 'score': score, 'exact': exact, 'content': content,
                           'terms': terms, 'contentTerms': hits[:RETRIEVAL_CONTENT_TERMS]})
    ranked.sort(key=lambda r: (-r['score'], r['index']))
    return ranked


def select_ranked(cards, ranked, k):
    limit = max(1, min(8, int(k) or 1))
    hashes, rest = set(), []
    for r in ranked:
        c = cards[r['index']]
        h = hashlib.sha256(retrieval_card_text(c).encode('utf-8')).hexdigest()
        if h in hashes: continue
        hashes.add(h)
        rest.append(r)
    seen, out = set(), []
    while len(out) < limit and rest:
        def fresh(r): return any(i not in seen for i in cards[r['index']]['source_ids'])
        pick = 0
        if not fresh(rest[0]):
            for j in range(1, len(rest)):
                if rest[j]['score'] * 2 < rest[0]['score']: break
                if fresh(rest[j]):
                    pick = j
                    break
        r = rest.pop(pick)
        seen.update(cards[r['index']]['source_ids'])
        out.append(r)
    return out


def retrieve_ranked(cards, query, k, max_query=12000):
    return select_ranked(cards, rank_cards(cards, query, max_query), k)
`;
