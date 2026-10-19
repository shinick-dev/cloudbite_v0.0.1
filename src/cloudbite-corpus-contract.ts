// Public, licensed reference corpus only. Project documents and evaluation answers never enter this index.
export const CORPUS_SCHEMA = 'cloudbite.corpus/v1' as const;
export const CORPUS_MODEL = 'text-embedding-3-small' as const;
export const CORPUS_DIMENSIONS = 256;
export interface CorpusSource {
  id: string; title: string; url: string; license: string; licenseUrl: string;
  attribution: string; version: string; retrievedAt: string; sha256: string;
  roles: string[]; text: string;
}
export interface CorpusChunk {
  id: string; sourceId: string; parentId: string; headingPath: string[];
  text: string; sha256: string; vector: number[];
}
export interface CorpusIndex {
  schema: typeof CORPUS_SCHEMA; model: typeof CORPUS_MODEL; dimensions: number;
  sha256: string; sources: CorpusSource[]; chunks: CorpusChunk[];
}
export interface CorpusHit { chunkId: string; sourceId: string; parentId: string; headingPath: string[]; text: string; sha256: string; score: number }
export interface CorpusSearchResult {
  schema: 'cloudbite.corpus-search/v1'; indexSha256: string;
  strategy: 'hybrid-rrf/v1' | 'corpus-lexical/v1'; model: string | null;
  matched: boolean; degraded: string | null;
  sources: Array<Omit<CorpusSource, 'text' | 'roles'>>; hits: CorpusHit[];
}
