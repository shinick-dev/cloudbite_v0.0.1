// Selected response language (ko/en) for generated narrative: prompt rules and a simple deterministic script check.
// Pure leaf, shared by the in-sandbox runner (as an embedded Python port), cross-review and the decision memo.
//
// The check is a script-share heuristic, not calibrated language identification: it counts Hangul syllables/jamo and
// Latin letters in narrative text after removing what must never be translated (fenced and inline code, URLs,
// [source:ID]/[doc:ID] citations, ID-like tokens, acronyms/CamelCase product names and quoted spans). Text with too
// little evidence left is reported as 'unknown' and is never rejected; only clearly wrong dominant script is a mismatch.
// A prompt instruction alone is never reported as language verification.
import type { ResponseLanguage } from './cloudbite-contract';

export const LANGUAGE_CHECK_BASIS = 'script-heuristic' as const;
export type LanguageIntegrityStatus = 'consistent' | 'mismatch' | 'unknown';
export interface LanguageIntegrity {
  language: ResponseLanguage; status: LanguageIntegrityStatus; basis: typeof LANGUAGE_CHECK_BASIS;
  /** Counted after exclusions: Hangul characters and Latin letters. */
  hangul: number; latin: number;
}
/** Parser failure category for a reply rejected for its language (bounded; never carries reply text). */
export const LANGUAGE_FAILURE_CATEGORY = 'language' as const;

/** One Hangul character carries roughly a short syllable of an English word; weighted before comparing shares. */
export const LANGUAGE_CHECK = Object.freeze({ hangulWeight: 3, minScore: 80, koMinShare: 0.2, enMaxShare: 0.6 });

// Regex sources shared verbatim with the Python port (no \b, no flags: JS and Python agree on these constructs).
export const LANGUAGE_PATTERNS = Object.freeze({
  hangul: '[\\u1100-\\u11ff\\u3130-\\u318f\\ua960-\\ua97f\\uac00-\\ud7af\\ud7b0-\\ud7ff]',
  latin: '[A-Za-z]',
  /** Removed in this order before counting. */
  strip: [
    '```[\\s\\S]*?```',
    '`[^`\\n]*`',
    '(?:https?://|www\\.)[^\\s<>\\]\\)]+',
    '\\[(?:source|doc):[^\\]\\n]*\\]',
    '"[^"\\n]{1,600}"|\u201c[^\u201d\\n]{0,600}\u201d|\u300c[^\u300d]{0,600}\u300d|\u300e[^\u300f]{0,600}\u300f|\u00ab[^\u00bb]{0,600}\u00bb',
    '(?<![A-Za-z0-9])[A-Za-z0-9]*[0-9_:][A-Za-z0-9_:.\\-]*',
    '(?<![A-Za-z])[A-Za-z]*[A-Z][a-z]*[A-Z][A-Za-z]*(?![A-Za-z])',
  ],
});

const STRIP = LANGUAGE_PATTERNS.strip.map((s) => new RegExp(s, 'g'));
const HANGUL = new RegExp(LANGUAGE_PATTERNS.hangul, 'g'), LATIN = new RegExp(LANGUAGE_PATTERNS.latin, 'g');

/** Narrative left for the check after removing code, URLs, citations, IDs, acronyms and quoted originals. */
export function narrativeText(texts: readonly string[]): string {
  let t = texts.filter((x) => typeof x === 'string').join('\n');
  for (const r of STRIP) t = t.replace(r, ' ');
  return t;
}

export function languageIntegrity(texts: readonly string[], language: ResponseLanguage): LanguageIntegrity {
  const t = narrativeText(texts), C = LANGUAGE_CHECK;
  const hangul = t.match(HANGUL)?.length ?? 0, latin = t.match(LATIN)?.length ?? 0;
  const score = C.hangulWeight * hangul + latin;
  const base = { language, basis: LANGUAGE_CHECK_BASIS, hangul, latin };
  if (score < C.minScore) return { ...base, status: 'unknown' };
  const share = (C.hangulWeight * hangul) / score;
  return { ...base, status: (language === 'ko' ? share < C.koMinShare : share > C.enMaxShare) ? 'mismatch' : 'consistent' };
}

export const RESPONSE_LANGUAGE_NAMES: Readonly<Record<ResponseLanguage, string>> = Object.freeze({ ko: 'Korean (한국어)', en: 'English' });

/** Fixed bounded message for a parser rejection; what names the generated artifact, never its text. */
export function languageMismatchMessage(what: string, language: ResponseLanguage): string {
  return `${what} is not written in the selected language (${language})`;
}

/** Prompt rule naming the selected language explicitly; the persona's or instructions' own language never overrides it. */
export function responseLanguageRule(language: ResponseLanguage, fields: string): string {
  const name = RESPONSE_LANGUAGE_NAMES[language];
  return [
    `Response language: ${language} — ${name}, selected for this project (its responseLanguage, else Hangul in the objective).`,
    `Write ${fields} in ${name}, even when the persona, instructions or supplied material are in another language.`,
    'Keep quoted source text, code, file paths, URLs, IDs, names, technical terms and citation/reference tokens exactly as supplied: never translate, paraphrase inside quotes or alter them.',
    ...(language === 'ko' ? ['서술은 한국어로 쓰고, 인용한 원문·코드·URL·ID·고유명사·[source:ID]/[doc:ID] 토큰은 원문 그대로 둔다.'] : []),
    `A simple script check rejects a reply whose narrative is clearly not in ${name}.`,
  ].join('\n');
}

/** Python port for the in-sandbox runner (stdlib only). Must stay equivalent to languageIntegrity above. */
export const CB_LANGUAGE_PY = [
  `LANG_HANGUL = re.compile(${JSON.stringify(LANGUAGE_PATTERNS.hangul)})`,
  `LANG_LATIN = re.compile(${JSON.stringify(LANGUAGE_PATTERNS.latin)})`,
  `LANG_STRIP = [re.compile(p) for p in ${JSON.stringify(LANGUAGE_PATTERNS.strip)}]`,
  `LANG_WEIGHT, LANG_MIN_SCORE, LANG_KO_MIN, LANG_EN_MAX = ${LANGUAGE_CHECK.hangulWeight}, ${LANGUAGE_CHECK.minScore}, ${LANGUAGE_CHECK.koMinShare}, ${LANGUAGE_CHECK.enMaxShare}`,
  '',
  '',
  'def narrative_text(texts):',
  "    t = '\\n'.join(x for x in texts if isinstance(x, str))",
  '    for p in LANG_STRIP:',
  "        t = p.sub(' ', t)",
  '    return t',
  '',
  '',
  'def language_integrity(texts, language):',
  '    """(status, hangul, latin): consistent, mismatch, or unknown when too little narrative remains."""',
  '    t = narrative_text(texts)',
  '    h, l = len(LANG_HANGUL.findall(t)), len(LANG_LATIN.findall(t))',
  '    score = LANG_WEIGHT * h + l',
  '    if score < LANG_MIN_SCORE:',
  "        return 'unknown', h, l",
  '    share = LANG_WEIGHT * h / score',
  "    bad = share < LANG_KO_MIN if language == 'ko' else share > LANG_EN_MAX",
  "    return ('mismatch' if bad else 'consistent'), h, l",
].join('\n');
