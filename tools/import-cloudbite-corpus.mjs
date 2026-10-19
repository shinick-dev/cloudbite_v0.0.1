// Licensed original-text corpus → src/cloudbite-corpus.generated.ts (CORPUS: CorpusIndex, contract src/cloudbite-corpus-contract.ts).
//   node tools/import-cloudbite-corpus.mjs           validate, chunk, embed new/changed chunks (OPENAI_API_KEY), write
//   node tools/import-cloudbite-corpus.mjs --check   offline: re-derive everything from the saved originals and fail unless
//                                                    the generated file is byte-identical and every vector binding holds
// Inputs are only the bounded local manifest (knowledge/cloudbite-corpus/manifest.json) and the original files it names,
// each pinned by sha256 and confined to that directory; no URL in the manifest is ever fetched. The one network call is
// the fixed OpenAI embeddings endpoint, made only for chunks whose (text, model, dimensions) has no cached vector. Source
// text is the original document: Markdown verbatim, JATS XML converted structurally (no text is written by this tool).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MANIFEST_SCHEMA = 'cloudbite.corpus-manifest/v1';
export const CORPUS_SCHEMA = 'cloudbite.corpus/v1';
export const MODEL = 'text-embedding-3-small';
export const DIMENSIONS = 256;
export const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
export const VECTOR_BINDING_SCHEMA = 'cloudbite.corpus-vector/v1';
export const LIMITS = Object.freeze({ manifestBytes: 64 * 1024, sources: 32, fileBytes: 1024 * 1024, textBytes: 2 * 1024 * 1024, chunks: 512, chunkBytes: 2500, batch: 16, decimals: 6 });
export const ROLES = Object.freeze(['probably-primetime-sta', 'cb-role-072', 'cb-role-075', 'cb-role-076', 'cb-role-101', 'cb-role-105', 'cb-role-106', 'cb-role-118']);
/** Licenses that permit redistributing the complete text with attribution, and the clause each license proof must quote. */
export const LICENSES = Object.freeze({
  'BSD-3-Clause': 'Redistributions of source code must retain the above copyright notice',
  'CC-BY-4.0': 'Creative Commons Attribution License',
  'CC-BY (version unspecified)': 'Creative Commons Attribution License',
});
/** A license recorded without a version is accepted only on pinned-file evidence, none of which names a version. */
export const UNVERSIONED = 'CC-BY (version unspecified)';
/** Display metadata limit shared with the runtime index validator (src/cloudbite-corpus-search.ts CORPUS_LIMITS.metaChars). */
export const META_CHARS = 500;
const SOURCE_ID = /^orig-[a-z0-9][a-z0-9_-]{0,64}$/;
const SHA = /^[0-9a-f]{64}$/;
const FORMATS = new Set(['markdown', 'jats-xml']);

export const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
class CorpusError extends Error {}
const fail = (why) => { throw new CorpusError(why); };

/** Sorted-key JSON; the index sha256 is taken over this form. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  if (typeof v === 'number' && !Number.isFinite(v)) fail('non-finite number in index');
  return JSON.stringify(v);
}
export const indexSha256 = (ix) => sha256(canonical({ schema: ix.schema, model: ix.model, dimensions: ix.dimensions, sources: ix.sources, chunks: ix.chunks }));
export const vectorBinding = (chunkSha, vector) => sha256(`${VECTOR_BINDING_SCHEMA}\n${MODEL}\n${DIMENSIONS}\n${chunkSha}\n${vector.join(',')}`);
const quantize = (x) => { const q = Number(x.toFixed(LIMITS.decimals)); return Object.is(q, -0) ? 0 : q; };

// ── bounded file access: relative paths that stay inside the manifest directory, no links ──
function containedFile(baseDir, rel, what) {
  if (typeof rel !== 'string' || !rel || rel.length > 200 || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes('\\') || rel.split('/').some(p => p === '..' || p === '.' || !p))
    fail(`${what}: path must be a relative forward-slash path inside the corpus directory, got ${JSON.stringify(rel)}`);
  const abs = path.resolve(baseDir, rel);
  const relBack = path.relative(baseDir, abs);
  if (!relBack || relBack.startsWith('..') || path.isAbsolute(relBack)) fail(`${what}: ${rel} escapes the corpus directory`);
  let st;
  try { st = fs.lstatSync(abs); } catch { fail(`${what}: ${rel} does not exist`); }
  if (st.isSymbolicLink() || !st.isFile()) fail(`${what}: ${rel} must be a regular file, not a link or directory`);
  const real = fs.realpathSync(abs), realBase = fs.realpathSync(baseDir), r = path.relative(realBase, real);
  if (r.startsWith('..') || path.isAbsolute(r)) fail(`${what}: ${rel} resolves outside the corpus directory`);
  if (st.size > LIMITS.fileBytes) fail(`${what}: ${rel} is ${st.size} bytes > ${LIMITS.fileBytes}`);
  return fs.readFileSync(abs);
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
/** The exact contiguous span of `text` that `chunk` stands for. A chunk that is not a substring is accepted only when it
 *  differs from exactly one source span in its runs of newlines (blank-line separators); that span is returned so the
 *  chunk carries the original text. Anything else (joined, reordered or rewritten lines) fails. */
export function exactSpan(text, chunk, what, maxBytes = LIMITS.chunkBytes) {
  if (text.includes(chunk)) return chunk;
  const pattern = chunk.split(/\n+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n+');
  const spans = [...text.matchAll(new RegExp(pattern, 'g'))].map(m => m[0]);
  if (spans.length !== 1) fail(`${what} is not an exact contiguous span of its source (${spans.length} newline-normalized matches); fix the source or chunker rather than storing non-original text`);
  if (bytes(spans[0]) > maxBytes) fail(`${what}: its original span is ${bytes(spans[0])} bytes > ${maxBytes}`);
  return spans[0];
}

// ── manifest ──
const STR = (o, k, max, what) => { const v = o[k]; if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${what}.${k} must be a non-empty string of at most ${max} characters`); return v; };
export function loadManifest(manifestPath) {
  const baseDir = path.dirname(path.resolve(manifestPath));
  let raw;
  try { raw = fs.readFileSync(manifestPath); } catch { fail(`manifest ${manifestPath} is not readable`); }
  if (raw.length > LIMITS.manifestBytes) fail(`manifest is ${raw.length} bytes > ${LIMITS.manifestBytes}`);
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { fail('manifest is not valid JSON'); }
  if (!m || m.schema !== MANIFEST_SCHEMA) fail(`manifest schema must be ${MANIFEST_SCHEMA}`);
  if (!Array.isArray(m.sources) || !m.sources.length || m.sources.length > LIMITS.sources) fail(`manifest needs 1-${LIMITS.sources} sources`);
  const ids = new Set();
  const sources = m.sources.map((s, i) => {
    const what = `sources[${i}]`;
    if (!s || typeof s !== 'object') fail(`${what} must be an object`);
    if (typeof s.id !== 'string' || !SOURCE_ID.test(s.id)) fail(`${what}.id must match ${SOURCE_ID} (orig- prefix, lower-case)`);
    if (ids.has(s.id)) fail(`${what}.id ${s.id} is duplicated`);
    ids.add(s.id);
    const w = `source ${s.id}`;
    for (const [k, max] of [['title', 200], ['url', 300], ['licenseUrl', 300], ['attribution', META_CHARS], ['version', 80], ['retrievedAt', 10]]) STR(s, k, max, w);
    for (const k of ['url', 'licenseUrl']) if (!/^https:\/\/[^\s]+$/.test(s[k])) fail(`${w}: ${k} must be an https URL`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.retrievedAt)) fail(`${w}: retrievedAt must be YYYY-MM-DD`);
    if (s.rights !== 'licensed') fail(`${w}: rights must be "licensed" (original text needs a redistribution license; project-authored or proprietary text is not corpus material)`);
    if (!Object.hasOwn(LICENSES, s.license)) fail(`${w}: license ${JSON.stringify(s.license)} is not an accepted redistribution license (${Object.keys(LICENSES).join(', ')})`);
    if (!FORMATS.has(s.format)) fail(`${w}: format must be one of ${[...FORMATS].join(', ')}`);
    if (!Array.isArray(s.roles) || !s.roles.length || new Set(s.roles).size !== s.roles.length || !s.roles.every(r => ROLES.includes(r))) fail(`${w}: roles must be a non-empty unique subset of ${ROLES.join(', ')}`);
    if (!SHA.test(s.sha256 ?? '')) fail(`${w}: sha256 (of the original file) must be 64 lower-case hex`);
    if (!SHA.test(s.textSha256 ?? '')) fail(`${w}: textSha256 (of the derived source text) must be 64 lower-case hex`);
    const original = containedFile(baseDir, s.file, `${w}.file`);
    if (sha256(original) !== s.sha256) fail(`${w}: ${s.file} sha256 mismatch (expected ${s.sha256}, got ${sha256(original)})`);
    // rights proof: every evidence file is pinned and contains its quote; one quote is the license's own clause and
    // one is the license statement inside the original document itself
    if (!Array.isArray(s.licenseEvidence) || !s.licenseEvidence.length || s.licenseEvidence.length > 8) fail(`${w}: licenseEvidence needs 1-8 entries`);
    let clause = false, inDocument = false;
    for (const [j, e] of s.licenseEvidence.entries()) {
      const ew = `${w}.licenseEvidence[${j}]`;
      if (!e || typeof e.quote !== 'string' || e.quote.trim().length < 12 || e.quote.length > 600) fail(`${ew}.quote must be 12-600 characters`);
      if (typeof e.file === 'string') {
        const buf = containedFile(baseDir, e.file, `${ew}.file`);
        if (!SHA.test(e.sha256 ?? '') || sha256(buf) !== e.sha256) fail(`${ew}: ${e.file} sha256 mismatch`);
        if (!squash(buf.toString('utf8')).includes(squash(e.quote))) fail(`${ew}: quote not found in ${e.file}`);
        if (e.file === s.file) inDocument = true;
      } else if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url) || !/^\d{4}-\d{2}-\d{2}$/.test(e.retrievedAt ?? '')) fail(`${ew} needs a pinned file or an https url with retrievedAt`);
      if (squash(e.quote).includes(LICENSES[s.license])) clause = true;
    }
    if (s.license === UNVERSIONED && s.licenseEvidence.some(e => typeof e.file !== 'string' || /\b\d\.\d\b|licenses\/by\/\d/.test(e.quote)))
      fail(`${w}: ${UNVERSIONED} needs pinned-file license evidence only, and no quote may name a license version`);
    if (!clause) fail(`${w}: no license evidence quotes the ${s.license} clause "${LICENSES[s.license]}"`);
    if (!inDocument) fail(`${w}: license evidence must include the license statement inside the original document ${s.file}`);
    if (s.license === 'BSD-3-Clause' && !/Copyright \(c\)/.test(s.attribution)) fail(`${w}: BSD-3-Clause redistribution must retain the copyright notice in attribution`);
    if (s.license.startsWith('CC-BY') && !/changes/i.test(s.attribution)) fail(`${w}: CC BY attribution must state the changes made`);
    return { ...s, original };
  });
  return { baseDir, sources };
}

// ── JATS XML → Markdown (structural conversion only; unknown block elements fail instead of being dropped) ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function parseXml(xml, what = 'xml') {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const text = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);|&/g, (m, e) => {
    if (!e) fail(`${what}: bare & at offset ${i}`);
    if (e[0] === '#') { const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (!(cp > 0 && cp <= 0x10ffff)) fail(`${what}: bad character reference &${e};`); return String.fromCodePoint(cp); }
    if (!Object.hasOwn(ENT, e)) fail(`${what}: unknown entity &${e};`);
    return ENT[e];
  });
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { if (xml.slice(i).trim()) stack[stack.length - 1].children.push(text(xml.slice(i))); break; }
    if (lt > i) stack[stack.length - 1].children.push(text(xml.slice(i, lt)));
    const skip = (open, close) => { const e = xml.indexOf(close, lt + open.length); if (e < 0) fail(`${what}: unclosed ${open} at offset ${lt}`); i = e + close.length; };
    if (xml.startsWith('<!--', lt)) { skip('<!--', '-->'); continue; }
    if (xml.startsWith('<?', lt)) { skip('<?', '?>'); continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); if (e < 0) fail(`${what}: unclosed CDATA at offset ${lt}`); stack[stack.length - 1].children.push(xml.slice(lt + 9, e)); i = e + 3; continue; }
    if (xml.startsWith('<!DOCTYPE', lt)) { if (stack.length > 1) fail(`${what}: DOCTYPE inside an element`); const e = xml.indexOf('>', lt); if (e < 0 || xml.slice(lt, e).includes('[')) fail(`${what}: unsupported DOCTYPE (internal subsets are rejected)`); i = e + 1; continue; }
    const m = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(xml.slice(lt, lt + 4096));
    if (!m) fail(`${what}: malformed tag at offset ${lt}`);
    i = lt + m[0].length;
    if (m[1]) {
      const top = stack.pop();
      if (!top || top.name !== m[2] || top === root) fail(`${what}: closing </${m[2]}> at offset ${lt} does not match <${top?.name ?? '?'}>`);
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = text(a[2] ?? a[3]);
    const el = { name: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  if (stack.length !== 1) fail(`${what}: unclosed element <${stack[stack.length - 1].name}>`);
  const els = root.children.filter(c => typeof c !== 'string');
  if (els.length !== 1 || root.children.some(c => typeof c === 'string' && c.trim())) fail(`${what}: document must have exactly one root element`);
  return els[0];
}
const kids = (el, name) => el.children.filter(c => typeof c !== 'string' && (!name || c.name === name));
const kid = (el, name) => kids(el, name)[0];
const textOf = (el) => typeof el === 'string' ? el : el.children.map(textOf).join('');

const INLINE_PLAIN = new Set(['named-content', 'styled-content', 'abbrev', 'monospace', 'sc', 'underline', 'overline', 'roman', 'sans-serif', 'span', 'email', 'uri', 'source', 'year', 'volume', 'issue', 'fpage', 'lpage', 'surname', 'given-names', 'name', 'person-group', 'etal', 'string-name', 'collab', 'publisher-name', 'publisher-loc', 'edition', 'comment', 'chapter-title', 'elocation-id', 'article-title', 'date-in-citation', 'conf-name', 'season', 'month', 'day', 'suffix', 'prefix', 'role', 'trans-title', 'part-title', 'size', 'patent', 'gov', 'std', 'institution', 'data-title', 'version', 'pub-id', 'tex-math', 'mml:math']);
function inline(node) {
  if (typeof node === 'string') return node;
  const inner = () => node.children.map(inline).join('');
  switch (node.name) {
    case 'italic': { const t = inner(); return t.trim() ? `*${t.trim()}*` : t; }
    case 'bold': { const t = inner(); return t.trim() ? `**${t.trim()}**` : t; }
    case 'sup': return `<sup>${inner()}</sup>`;
    case 'sub': return `<sub>${inner()}</sub>`;
    case 'xref': return inner();
    case 'ext-link': {
      const t = squash(inner()), href = node.attrs['xlink:href'];
      return href && /^https?:\/\//.test(href) && squash(href) !== t ? `[${t}](${href})` : t;
    }
    case 'inline-formula': return inner();
    case 'break': return ' ';
    case 'inline-graphic': case 'graphic': case 'object-id': return '';
    default:
      if (INLINE_PLAIN.has(node.name)) return inner();
      fail(`unsupported inline JATS element <${node.name}>`);
  }
}
/** One paragraph as Markdown lines: one sentence per line (a Markdown soft break), so long paragraphs can be chunked
 *  at line boundaries without cutting a sentence; a sentence over 1000 bytes wraps at a space. */
function paragraph(text) {
  const t = squash(text);
  if (!t) return '';
  // no break after an initial ("John P. A.") or a reference number ("20.")
  const sentences = t.split(/(?<=[.?!][)\]”"’']?)(?<!(?:^|\s)[A-Z]\.)(?<!^\d{1,4}\.)\s+(?=[A-Z(“"\[])/);
  const out = [];
  for (const s of sentences) {
    if (bytes(s) <= 1000) { out.push(s); continue; }
    let line = '';
    for (const w of s.split(' ')) { if (line && bytes(line) + 1 + bytes(w) > 1000) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
    if (line) out.push(line);
  }
  // a line that would read as Markdown block syntax keeps its literal meaning
  return out.map(l => /^\d+[.)]\s/.test(l) ? l.replace(/^(\d+)/, '$1\\') : /^(#{1,6}\s|[-*+]\s|>|\||```|~~~|\$\$)/.test(l) ? `\\${l}` : l).join('\n');
}
const cell = (c) => squash(c.children.map(x => typeof x === 'string' ? x : x.name === 'p' ? ` ${x.children.map(inline).join('')} ` : x.name === 'list' ? ` ${textOf(x)} ` : inline(x)).join('')).replace(/\|/g, '\\|') || ' ';
function table(tbl, maxBytes) {
  const rows = [];
  let head = 0;
  for (const part of kids(tbl)) {
    if (part.name === 'col' || part.name === 'colgroup') continue;
    const trs = part.name === 'tr' ? [part] : ['thead', 'tbody', 'tfoot'].includes(part.name) ? kids(part, 'tr') : fail(`unsupported table child <${part.name}>`);
    for (const tr of trs) {
      const cells = [];
      for (const c of kids(tr)) {
        if (c.name !== 'td' && c.name !== 'th') fail(`unsupported table row child <${c.name}>`);
        if (Number(c.attrs.rowspan ?? 1) !== 1) fail('table rowspan > 1 cannot be represented in a Markdown table; convert this table by hand');
        cells.push(cell(c));
        for (let k = 1; k < Number(c.attrs.colspan ?? 1); k++) cells.push(' ');
      }
      rows.push(cells);
      if (part.name === 'thead') head = rows.length;
    }
  }
  if (!rows.length) return [];
  const width = Math.max(...rows.map(r => r.length));
  const line = (r) => `| ${[...r, ...Array(width - r.length).fill(' ')].join(' | ')} |`;
  const hdr = rows.slice(0, Math.max(1, head));
  const header = [line(hdr[0]), `|${' --- |'.repeat(width)}`, ...hdr.slice(1).map(line)].join('\n');
  // a table over the chunk bound is emitted as consecutive tables that each repeat the header rows (no cell is cut)
  const out = [];
  let cur = header;
  for (const r of rows.slice(hdr.length)) {
    const l = line(r);
    if (bytes(header) + 1 + bytes(l) > maxBytes) fail(`table row of ${bytes(l)} bytes cannot fit a ${maxBytes}-byte chunk with its header`);
    if (bytes(cur) + 1 + bytes(l) > maxBytes) { out.push(cur); cur = header; }
    cur += `\n${l}`;
  }
  out.push(cur);
  return out;
}
/** Citation fields: adjacent elements with no whitespace between them in the XML ("<surname>Goecks</surname><given-names>J")
 *  are rendered with one space between them; no punctuation or text is added. */
const spaced = (node) => typeof node === 'string' ? node : !INLINE_PLAIN.has(node.name) ? inline(node)
  : node.children.map((c, k) => (k && typeof c !== 'string' && typeof node.children[k - 1] !== 'string' ? ' ' : '') + spaced(c)).join('');
const citation = (el) => squash(spaced({ ...el, name: 'named-content' }));
/** A Markdown table over the chunk bound becomes consecutive tables that each repeat the header and separator rows; no
 *  cell or row is cut. Code fences are left untouched. */
export function splitMarkdownTables(text, maxBytes, what = 'markdown') {
  const lines = text.split('\n'), out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null; out.push(line); continue; }
    if (f) { fence = f[1]; out.push(line); continue; }
    if (!/^\s*\|/.test(line)) { out.push(line); continue; }
    const start = i;
    while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) i++;
    const block = lines.slice(start, i + 1);
    if (bytes(block.join('\n')) <= maxBytes) { out.push(...block); continue; }
    if (block.length < 3 || !/^\s*\|[\s:|-]+$/.test(block[1])) fail(`${what}: oversized table at line ${start + 1} has no header separator row`);
    const header = block.slice(0, 2).join('\n');
    let cur = header;
    block.slice(2).forEach((row, k) => {
      if (bytes(header) + 1 + bytes(row) > maxBytes) fail(`${what}: table row at line ${start + 3 + k} cannot fit a ${maxBytes}-byte chunk with its header`);
      if (bytes(cur) + 1 + bytes(row) > maxBytes) { out.push(cur, ''); cur = header; }
      cur += `\n${row}`;
    });
    out.push(cur);
  }
  if (fence) fail(`${what}: unclosed code fence`);
  return out.join('\n');
}
const SKIP_BLOCKS =new Set(['graphic', 'media', 'object-id', 'alternatives', 'alt-text', 'long-desc', 'permissions', 'attrib']);
function blocks(nodes, depth, out, maxBytes) {
  for (const n of nodes) {
    if (typeof n === 'string') { if (n.trim()) out.push(paragraph(n)); continue; }
    switch (n.name) {
      case 'sec': case 'app': case 'ack': case 'glossary': case 'notes': case 'abstract': case 'trans-abstract': {
        const title = kid(n, 'title'), label = kid(n, 'label');
        const heading = squash([label && textOf(label), title && title.children.map(inline).join('')].filter(Boolean).join(' '));
        if (heading) out.push(`${'#'.repeat(Math.min(6, depth + 1))} ${heading}`);
        blocks(n.children.filter(c => c !== title && c !== label), heading ? depth + 1 : depth, out, maxBytes);
        break;
      }
      case 'title': out.push(paragraph(`**${squash(n.children.map(inline).join(''))}**`)); break;
      case 'p': {
        // a <p> may carry block children (lists, tables, quotes); keep them as their own blocks in order
        let acc = '';
        for (const c of n.children) {
          if (typeof c !== 'string' && ['list', 'table-wrap', 'disp-quote', 'fig', 'disp-formula', 'boxed-text', 'def-list'].includes(c.name)) { if (squash(acc)) out.push(paragraph(acc)); acc = ''; blocks([c], depth, out, maxBytes); }
          else acc += inline(c);
        }
        if (squash(acc)) out.push(paragraph(acc));
        break;
      }
      case 'list': {
        const ordered = n.attrs['list-type'] === 'order';
        kids(n, 'list-item').forEach((li, k) => {
          const parts = [];
          blocks(li.children, depth, parts, maxBytes);
          const body = parts.join(' ').replace(/\s*\n\s*/g, ' ');
          out.push(`${ordered ? `${k + 1}.` : '-'} ${body}`);
        });
        if (kids(n).some(c => c.name !== 'list-item' && c.name !== 'title')) fail('unsupported <list> child');
        break;
      }
      case 'def-list':
        for (const di of kids(n, 'def-item')) out.push(`- **${squash(textOf(kid(di, 'term') ?? { children: [] }))}**: ${squash(kids(di, 'def').map(d => d.children.map(c => typeof c === 'string' ? c : c.name === 'p' ? c.children.map(inline).join('') : textOf(c)).join(' ')).join(' '))}`);
        break;
      case 'disp-quote': { const parts = []; blocks(n.children, depth, parts, maxBytes); out.push(parts.join('\n\n').split('\n').map(l => `> ${l}`).join('\n')); break; }
      case 'boxed-text': blocks(n.children, depth, out, maxBytes); break;
      case 'fig': case 'table-wrap': case 'supplementary-material': {
        const label = kid(n, 'label'), caption = kid(n, 'caption');
        const capParts = caption ? kids(caption).map(c => squash(c.children.map(inline).join(''))).filter(Boolean) : [];
        const head = [label && `**${squash(textOf(label))}.**`, ...capParts].filter(Boolean).join(' ');
        if (head) out.push(paragraph(head));
        if (n.name === 'table-wrap') {
          for (const t of kids(n, 'table')) out.push(...table(t, maxBytes));
          for (const alt of kids(n, 'alternatives')) for (const t of kids(alt, 'table')) out.push(...table(t, maxBytes));
          const foot = kid(n, 'table-wrap-foot');
          if (foot) blocks(foot.children, depth, out, maxBytes);
        }
        break;
      }
      case 'fn-group': case 'ref-list': {
        const title = kid(n, 'title');
        if (title) out.push(`${'#'.repeat(Math.min(6, depth + 1))} ${squash(textOf(title))}`);
        for (const c of kids(n)) {
          if (c === title) continue;
          if (c.name === 'fn') { const parts = []; blocks(c.children.filter(x => x.name !== 'label'), depth, parts, maxBytes); const l = kid(c, 'label'); out.push(paragraph(`${l ? `${squash(textOf(l))} ` : ''}${parts.join(' ')}`)); }
          else if (c.name === 'ref') {
            const l = kid(c, 'label'), cit = kids(c).filter(x => x.name.endsWith('citation'));
            if (!cit.length) fail(`ref ${c.attrs.id ?? '?'} has no citation`);
            out.push(paragraph(`${l ? `${squash(textOf(l))}. ` : ''}${cit.map(citation).join(' ')}`));
          } else if (c.name === 'ref-list' || c.name === 'fn-group') blocks([c], depth, out, maxBytes);
          else fail(`unsupported <${n.name}> child <${c.name}>`);
        }
        break;
      }
      case 'fn': { const parts = []; blocks(n.children.filter(x => x.name !== 'label'), depth, parts, maxBytes); const l = kid(n, 'label'); out.push(paragraph(`${l ? `${squash(textOf(l))} ` : ''}${parts.join(' ')}`)); break; }
      case 'disp-formula': { const t = squash(textOf(n)); if (t) out.push(`$$\n${t}\n$$`); break; }
      case 'label': case 'caption': case 'table-wrap-foot': blocks(n.children, depth, out, maxBytes); break;
      default:
        if (SKIP_BLOCKS.has(n.name)) break;
        fail(`unsupported JATS block element <${n.name}>; extend the converter rather than dropping text`);
    }
  }
}
/** Title, authors, copyright and license statement, abstracts, body and back matter of one JATS article. */
export function jatsToMarkdown(xml, what = 'jats', maxBytes = LIMITS.chunkBytes) {
  const art = parseXml(xml, what);
  if (art.name !== 'article') fail(`${what}: root element must be <article>`);
  const front = kid(art, 'front'), meta = front && kid(front, 'article-meta');
  if (!meta) fail(`${what}: missing front/article-meta`);
  const title = squash(textOf(kid(kid(meta, 'title-group') ?? { children: [] }, 'article-title') ?? { children: [] }));
  if (!title) fail(`${what}: missing article-title`);
  const out = [`# ${title}`];
  const authors = kids(meta, 'contrib-group').flatMap(g => kids(g, 'contrib')).filter(c => c.attrs['contrib-type'] === 'author')
    .map(c => { const n = kid(c, 'name'); return n ? squash(`${textOf(kid(n, 'given-names') ?? { children: [] })} ${textOf(kid(n, 'surname') ?? { children: [] })}`) : squash(textOf(kid(c, 'collab') ?? { children: [] })); }).filter(Boolean);
  if (authors.length) out.push(paragraph(authors.join(', ')));
  const perm = kid(meta, 'permissions');
  if (!perm) fail(`${what}: missing permissions (license statement)`);
  const cs = kid(perm, 'copyright-statement'), lic = kid(perm, 'license');
  if (!lic) fail(`${what}: missing permissions/license`);
  out.push(paragraph([cs && textOf(cs), ...kids(lic, 'license-p').map(textOf)].filter(Boolean).join(' ')));
  blocks(kids(meta).filter(c => c.name === 'abstract'), 1, out, maxBytes);
  for (const part of ['body', 'back']) { const el = kid(art, part); if (el) blocks(el.children, 1, out, maxBytes); }
  return `${out.filter(b => b.trim()).join('\n\n')}\n`;
}

export function sourceText(src) {
  if (src.format === 'markdown') {
    const t = src.original.toString('utf8');
    if (t.charCodeAt(0) === 0xfeff) fail(`source ${src.id}: remove the byte-order mark`);
    if (Buffer.from(t, 'utf8').compare(src.original) !== 0) fail(`source ${src.id}: not valid UTF-8`);
    return splitMarkdownTables(t.replace(/\r\n?/g, '\n'), LIMITS.chunkBytes, `source ${src.id}`);
  }
  return jatsToMarkdown(src.original.toString('utf8'), `source ${src.id}`);
}

// chunkMarkdown is the shared TypeScript implementation (src/cloudbite-retrieval.ts), bundled once into ignored .artifacts
let chunker;
export async function loadChunker() {
  if (chunker) return chunker;
  const dir = path.join(ROOT, '.artifacts', 'corpus-import');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'retrieval.mjs');
  await build({ entryPoints: [path.join(ROOT, 'src/cloudbite-retrieval.ts')], bundle: true, write: true, outfile: out, platform: 'node', format: 'esm', logLevel: 'silent' });
  chunker = (await import(`${pathToFileURL(out).href}?v=${sha256(fs.readFileSync(out))}`)).chunkMarkdown;
  return chunker;
}

/** Validated sources and chunks without vectors; every failure is a CorpusError naming the source. */
export async function buildCorpus(manifestPath) {
  const { sources: srcs } = loadManifest(manifestPath);
  const chunkMarkdown = await loadChunker();
  let total = 0;
  const sources = [], chunks = [];
  for (const s of srcs) {
    const text = sourceText(s);
    total += bytes(text);
    if (total > LIMITS.textBytes) fail(`original text exceeds ${LIMITS.textBytes} bytes at source ${s.id}`);
    if (sha256(text) !== s.textSha256) fail(`source ${s.id}: derived text sha256 ${sha256(text)} does not match manifest textSha256 ${s.textSha256}`);
    let parts;
    try { parts = chunkMarkdown({ sourceId: s.id, sourceVersion: s.version, text, representation: 'original-excerpt', rights: 'licensed' }, { maxBytes: LIMITS.chunkBytes }); }
    catch (e) { fail(`source ${s.id}: ${e.message}`); }
    sources.push({ id: s.id, title: s.title, url: s.url, license: s.license, licenseUrl: s.licenseUrl, attribution: s.attribution, version: s.version, retrievedAt: s.retrievedAt, sha256: sha256(text), roles: [...s.roles], text });
    for (const c of parts.chunks) {
      const id = c.chunkId.replace('#', '-').replace('.', '-'), parentId = c.parentId.replace('#', '-');
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) fail(`chunk id ${id} is not a 1-80 character identifier`);
      if (c.bytes > LIMITS.chunkBytes || c.contentSha256 !== sha256(c.text) || c.originalText !== true) fail(`chunk ${id} violates the chunk contract`);
      const exact = exactSpan(text, c.text, `chunk ${id} of source ${s.id}`);
      chunks.push({ id, sourceId: s.id, parentId, headingPath: [...c.headingPath], text: exact, sha256: sha256(exact) });
    }
  }
  if (chunks.length > LIMITS.chunks) fail(`${chunks.length} chunks > ${LIMITS.chunks}`);
  if (new Set(chunks.map(c => c.id)).size !== chunks.length) fail('duplicate chunk id');
  return { sources, chunks };
}

// ── generated file ──
const HEADER = `// Generated by tools/import-cloudbite-corpus.mjs from knowledge/cloudbite-corpus/manifest.json — do not edit by hand.
// Complete original text of openly licensed sources (license, licenseUrl and attribution on each source); vectors are
// OpenAI ${MODEL} (${DIMENSIONS} dimensions, rounded to ${LIMITS.decimals} decimals) of exactly each chunk's text.
`;
const PREFIX = 'export const CORPUS: CorpusIndex = ';
const EMB_PREFIX = 'export const CORPUS_EMBEDDINGS = ';
export function render(index, embeddings) {
  const top = (o, listKeys) => `{\n${Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${listKeys.includes(k) ? `[\n${v.map(x => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : JSON.stringify(v)}`).join(',\n')}\n}`;
  return `${HEADER}import type { CorpusIndex } from './cloudbite-corpus-contract';\n\n`
    + `/** Embedding provenance: binding[chunkId] = sha256("${VECTOR_BINDING_SCHEMA}\\nmodel\\ndimensions\\nchunk.sha256\\nvector"). */\n`
    + `${EMB_PREFIX}${top(embeddings, [])} as const;\n\n${PREFIX}${top(index, ['sources', 'chunks'])};\n`;
}
export function parseGenerated(file) {
  const t = fs.readFileSync(file, 'utf8');
  const e0 = t.indexOf(EMB_PREFIX), c0 = t.indexOf(PREFIX);
  if (e0 < 0 || c0 < 0) fail(`${file} is not a generated corpus file`);
  const embJson = t.slice(e0 + EMB_PREFIX.length, t.indexOf(' as const;', e0));
  const ixJson = t.slice(c0 + PREFIX.length, t.lastIndexOf(';'));
  try { return { embeddings: JSON.parse(embJson), index: JSON.parse(ixJson) }; } catch { fail(`${file} does not parse`); }
}

function validVector(v) { return Array.isArray(v) && v.length === DIMENSIONS && v.every(x => typeof x === 'number' && Number.isFinite(x)); }
/** Reuse a cached vector only when the same chunk text was embedded with the same model and dimensions. */
function cachedVectors(prev, chunks) {
  const out = new Map();
  if (!prev || prev.embeddings.model !== MODEL || prev.embeddings.dimensions !== DIMENSIONS) return out;
  for (const c of prev.index.chunks ?? []) {
    const src = prev.index.sources?.find(s => s.id === c.sourceId);
    if (typeof src?.text === 'string' && src.text.includes(c.text) && validVector(c.vector) && c.sha256 === sha256(c.text) && prev.embeddings.bindings?.[c.id] === vectorBinding(c.sha256, c.vector)) out.set(c.sha256, c.vector);
  }
  return out;
}

/** Real embeddings call: fixed endpoint/model/dimensions, one attempt, no retry; nothing about the key or body is logged. */
export async function embed(texts, { fetchImpl = fetch, key = process.env.OPENAI_API_KEY } = {}) {
  if (!key) fail('OPENAI_API_KEY is not set; new chunks need embeddings (use --check for offline validation)');
  if (!texts.length || texts.length > LIMITS.batch) fail(`embedding batch must hold 1-${LIMITS.batch} inputs`);
  let res;
  try {
    res = await fetchImpl(EMBEDDINGS_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIMENSIONS, encoding_format: 'float' }) });
  } catch { fail('embeddings request failed before a response (network)'); }
  if (!res.ok) fail(`embeddings request failed: HTTP ${res.status}`);
  let j;
  try { j = await res.json(); } catch { fail('embeddings response is not JSON'); }
  const data = Array.isArray(j?.data) ? [...j.data].sort((a, b) => a.index - b.index) : [];
  if (data.length !== texts.length || data.some((d, k) => d.index !== k || !validVector(d.embedding))) fail(`embeddings response does not hold ${texts.length} finite ${DIMENSIONS}-dimension vectors`);
  if (j.model && !String(j.model).startsWith(MODEL)) fail('embeddings response names a different model');
  return { vectors: data.map(d => d.embedding.map(quantize)), usage: { promptTokens: j.usage?.prompt_tokens ?? 0, totalTokens: j.usage?.total_tokens ?? 0 } };
}

export function assemble(sources, chunks, vectors, usage) {
  const index = { schema: CORPUS_SCHEMA, model: MODEL, dimensions: DIMENSIONS, sha256: '', sources, chunks: chunks.map(c => ({ ...c, vector: vectors.get(c.sha256) })) };
  index.sha256 = indexSha256(index);
  const bindings = Object.fromEntries(index.chunks.map(c => [c.id, vectorBinding(c.sha256, c.vector)]));
  return { index, embeddings: { schema: VECTOR_BINDING_SCHEMA, model: MODEL, dimensions: DIMENSIONS, encodingFormat: 'float', decimals: LIMITS.decimals, input: 'chunk.text', usage, bindings } };
}

/** Offline identity check of a generated file against freshly derived sources/chunks. */
export function verifyGenerated(gen, sources, chunks) {
  const { index, embeddings } = gen;
  if (index.schema !== CORPUS_SCHEMA || index.model !== MODEL || index.dimensions !== DIMENSIONS) fail('generated index schema/model/dimensions mismatch');
  if (embeddings.model !== MODEL || embeddings.dimensions !== DIMENSIONS) fail('generated embedding provenance mismatch');
  if (index.sha256 !== indexSha256(index)) fail('generated index sha256 does not cover its content');
  if (canonical(index.sources) !== canonical(sources)) fail('generated sources differ from the manifest originals');
  if (index.chunks.length !== chunks.length) fail(`generated file has ${index.chunks.length} chunks, inputs derive ${chunks.length}`);
  index.chunks.forEach((c, k) => {
    const { vector, ...rest } = c;
    if (canonical(rest) !== canonical(chunks[k])) fail(`generated chunk ${c.id} differs from the derived chunk ${chunks[k].id}`);
    if (!validVector(vector)) fail(`chunk ${c.id} vector is not ${DIMENSIONS} finite numbers`);
    if (embeddings.bindings?.[c.id] !== vectorBinding(c.sha256, vector)) fail(`chunk ${c.id} vector binding does not match its text/model/dimensions`);
    const src = index.sources.find(s => s.id === c.sourceId);
    if (!src || !src.text.includes(c.text)) fail(`chunk ${c.id} is not an exact excerpt of its source text`);
  });
  if (Object.keys(embeddings.bindings ?? {}).length !== index.chunks.length) fail('embedding bindings do not cover exactly the chunks');
  for (const s of index.sources) for (const k of ['title', 'attribution']) if (typeof s[k] !== 'string' || s[k].length > META_CHARS) fail(`source ${s.id}.${k} exceeds ${META_CHARS} characters`);
  return index;
}

export async function run({ manifest, out, check, fetchImpl, key, log = console.log }) {
  const { sources, chunks } = await buildCorpus(manifest);
  const prev = fs.existsSync(out) ? parseGenerated(out) : null;
  if (check) {
    if (!prev) fail(`${out} does not exist; run without --check to generate it`);
    verifyGenerated(prev, sources, chunks);
    if (render(prev.index, prev.embeddings) !== fs.readFileSync(out, 'utf8')) fail(`${out} is not in canonical generated form`);
    return { checked: true, sources: sources.length, chunks: chunks.length, sha256: prev.index.sha256, embedded: 0 };
  }
  const vectors = cachedVectors(prev, chunks);
  const todo = [...new Set(chunks.map(c => c.sha256).filter(h => !vectors.has(h)))];
  const byHash = new Map(chunks.map(c => [c.sha256, c.text]));
  let usage = todo.length ? { promptTokens: 0, totalTokens: 0 } : (prev?.embeddings.usage ?? { promptTokens: 0, totalTokens: 0 });
  for (let k = 0; k < todo.length; k += LIMITS.batch) {
    const batch = todo.slice(k, k + LIMITS.batch);
    const r = await embed(batch.map(h => byHash.get(h)), { fetchImpl, key });
    batch.forEach((h, j) => vectors.set(h, r.vectors[j]));
    usage = { promptTokens: usage.promptTokens + r.usage.promptTokens, totalTokens: usage.totalTokens + r.usage.totalTokens };
  }
  const gen = assemble(sources, chunks, vectors, usage);
  verifyGenerated(gen, sources, chunks);
  const text = render(gen.index, gen.embeddings);
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, out);
  log(`import-cloudbite-corpus: ${sources.length} sources, ${chunks.length} chunks, ${todo.length} embedded (${usage.totalTokens} tokens), ${bytes(text)} bytes, sha256 ${gen.index.sha256}`);
  return { checked: false, sources: sources.length, chunks: chunks.length, sha256: gen.index.sha256, embedded: todo.length, usage };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  try {
    const r = await run({ manifest: path.resolve(opt('--manifest', path.join(ROOT, 'knowledge/cloudbite-corpus/manifest.json'))),
      out: path.resolve(opt('--out', path.join(ROOT, 'src/cloudbite-corpus.generated.ts'))), check: args.includes('--check') });
    if (r.checked) console.log(`import-cloudbite-corpus --check: ${r.sources} sources, ${r.chunks} chunks, sha256 ${r.sha256} OK`);
  } catch (e) {
    console.error(`import-cloudbite-corpus: ${e instanceof CorpusError ? e.message : 'unexpected failure'}`);
    process.exit(1);
  }
}
