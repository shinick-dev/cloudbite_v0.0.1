// Cloudbite 프로젝트 콘솔 (브라우저). tools/build-cloudbite-console.mjs 가 이 파일을 묶지 않고 변환해 src/cloudbite-page.ts 의
// CLOUDBITE_JS 로 고정한다. 같은 출처 외부 스크립트로 내려가며, 화면은 전부 textContent·createElement 로만 그린다.
// 데모는 브라우저 안 시뮬레이션이다 — 실제 Daytona 샌드박스나 Nosana 추론을 만들지 않으며 화면에서 그렇게 밝힌다.
// 실제 실행은 서버 준비 상태와 기존 관리자 토큰(메모리에만), 소유자 로그인 세션 또는 승인된 방문자 세션(둘 다 서버 HttpOnly
// 쿠키, JS 는 읽지 않음)을 요구하고, 실패해도 데모로 몰래 바꾸지 않는다.
// 화면 문구는 한국어·영어 사전(EN·KO)에서 온다 (2026-10-18 사용자 요청: 머리의 KO / EN 전환). 언어는 ?lang= 주소에만 두고,
// 서버·모델이 돌려준 내용(브리프·보고서·파일·페르소나·서버 오류)과 브라우저 데모 결과물은 받은·만든 그대로 보이고 번역하지 않는다.
import type {
  CloudbiteBootstrap, CloudbiteRoutingHarness, CrossReviewFinding, CrossReviewReport, DecisionFrame, EvidenceClaim, ExpertActivity, ExpertArtifact,
  ExpertDefinition, ExpertOpinion, ExpertRun, ExpertStatus, OpinionDirection, ProjectBrief, ProjectCrossReview, ProjectDocument, ProjectRun, ProjectStatus,
  ExpertAssignment, ProjectBudget, ProjectPreview, ProjectRevision, ProjectStage, ResponseLanguage,
} from '../src/cloudbite-contract';
// 결정 메모·예산·검토 범위는 공개 계약의 브라우저용 거울 타입, 신호·이전 라운드는 잎 모듈 타입이다 (타입만 — 실행 import 없음)
import type { BudgetPhaseView, CrossReviewCoverage, CrossReviewTextAvailability, DecisionMemo, MemoClaim, MemoCoverage, MemoReference, ProjectMemo } from '../src/cloudbite-contract';
type MemoStatus = ProjectMemo['status'];
import type { EvidenceSignals, ExpertEvidenceSignals } from '../src/cloudbite-evidence';
import type { PmcArticle, PmcImport, PmcImportErrorCode, PmcSection } from '../src/cloudbite-pmc';
import type { ProjectPreviousRound, RoundOmission, RoundOption } from '../src/cloudbite-revision';
import type { CloudbiteAccessRequest, CloudbiteAccessSession } from '../src/cloudbite-access-contract';
import type { HistoryList, HistoryDetail, HistoryReport, HistoryIssue, HistoryFeedback } from '../src/cloudbite-history-contract';
import type { CatalogueMaxRoles, ProjectMaxExperts } from '../src/cloudbite-catalogue-limits';
import type { ClaimAdoption, ClaimStanding, LedgerClaim, ProvenanceLedger, ProvenanceState } from '../src/cloudbite-provenance';
import type { AuthorResponseParsed, AuthorResponsePlan } from '../src/cloudbite-author-response';

type Mode = 'demo' | 'live';
type View = 'home' | 'guide' | 'help' | 'settings' | 'history';
/** invalidAuthorResponse: 서버가 보낸 작성자 응답을 읽을 수 없다 (서버가 거부한 응답 { invalid } 와는 다르다) */
type ConsoleExpert = ExpertRun & { invalidOpinion?: boolean; invalidAuthorResponse?: boolean };
type ConsoleReview = ProjectCrossReview & { invalidArtifactCoverage?: boolean };
type Provenance = { ledger: ProvenanceLedger; state: ProvenanceState };
/** 서버가 저장한 결정 메모. 모양을 검사해 그대로 받으며, 원문 의견은 따로 그대로 남는다 */
type ConsoleMemo = ProjectMemo;
/** invalidCrossReview / invalidMemo / invalidSignals: 서버가 이 콘솔이 읽을 수 없는 값을 보냈다 (그리지 않고 그렇다고 밝힌다).
 *  memoBudget: 서버 사용량 장부의 메모 칸 (없으면 모름 — 서버가 판단한다) */
type ConsoleProject = Omit<ProjectRun, 'experts' | 'crossReview'> & {
  experts: ConsoleExpert[]; crossReview?: ConsoleReview; invalidCrossReview?: boolean;
  memo?: ConsoleMemo; invalidMemo?: boolean; evidenceSignals?: EvidenceSignals; invalidSignals?: boolean;
  previousRound?: ProjectPreviousRound; invalidRound?: boolean; invalidAuthorPlan?: boolean; memoBudget?: BudgetPhaseView;
  invalidProvenance?: boolean;
};
interface Limits { min: number; max: number }
interface FormInput { title: string; objective: string; context: string; expertIds: string[] }
interface DemoStep {
  at: number; expert: number; status?: ExpertStatus; activity?: Omit<ExpertActivity, 'id' | 'at'>;
  artifacts?: ExpertArtifact[]; opinion?: ExpertOpinion; error?: string; sandboxId?: string;
}
interface Aggregate {
  selected: number; completed: number; valid: number; invalid: number; failed: number; pending: number; cancelled: number;
  counts: Record<OpinionDirection, number>; meanConfidence: number | null; buckets: number[];
  leading: OpinionDirection | null; disagreement: boolean;
  supportVoices: Array<{ name: string; confidence: number; summary: string }>;
  concernVoices: Array<{ name: string; confidence: number; summary: string }>;
  actions: Array<{ text: string; count: number; names: string[] }>;
  headline: string;
}
type PoolShow = 'all' | 'available' | 'planned';
type PoolKnowledge = 'curated-knowledge' | 'metadata-derived' | 'none';
/** bootstrap.pool 항목. 런타임 계약(ExpertPoolEntry)과 같은 모양이며, 통합 전에도 화면이 따로 타입 검사되도록 여기에 둔다 */
interface PoolEntry {
  id: string; catalogNumber: number; name: string; domain: string; category: string; categoryLabel: { ko: string; en: string };
  mission: string; expertId?: string; availability: 'available' | 'planned'; knowledge: PoolKnowledge; evaluation: 'unvalidated';
  priority: boolean; keywords: string[]; mappingNote?: string;
}
interface Pool { version: string; entries: PoolEntry[]; priorityNumbers: number[] }
/** bootstrap.configuration.routing (선택): 서버가 TypeSafe Jev 로 브리프에 맞는 역할을 고를 수 있는지. 키는 서버에만 있다.
 *  공유 계약에 들어오기 전까지 여기 둔다 (조정자의 계약과 같은 모양) */
interface Routing { provider: 'typesafe'; model: string; ready: boolean; maxExperts: number }
/** POST /api/cloudbite/route 응답. relevance 는 역할별 선택 적합도이지 전문가의 확신도·정확도가 아니다.
 *  v1 은 팀 설명이 없고, v2 는 검증된 project-team/v1 설명(harness)이 반드시 붙는다 */
interface RouteResult {
  provider: 'typesafe'; model: string; policyVersion: 'jev-routing/v1' | 'jev-routing/v2'; evaluatedCount: number; threshold: number;
  expertIds: string[]; matches: Array<{ expertId: string; relevance: number }>; queryHash: string; expiresAt: number;
  harness?: CloudbiteRoutingHarness;
}
type HarnessStatus = CloudbiteRoutingHarness['perspectives'][number]['status'];
type HarnessReason = CloudbiteRoutingHarness['excluded'][number]['reason'];
/** 팀 설명의 고정 코드. 여기 없는 경고·상태·이유가 오면 v2 팀 전체를 쓰지 않는다 (모르는 코드를 짐작해 그리지 않는다) */
const HARNESS_WARNINGS = ['uncovered-perspectives', 'no-project-perspectives', 'actor-limit', 'coverage-rescue'] as const;
type HarnessWarning = typeof HARNESS_WARNINGS[number];
const HARNESS_STATUSES: HarnessStatus[] = ['covered', 'limited', 'uncovered'];
const HARNESS_REASONS: HarnessReason[] = ['overlap', 'limit', 'below-threshold'];
/** pool·routing 은 선택 필드다 — 없는 옛 bootstrap 이면 화면은 예전 역할 고르기만 보인다 */
type ConsoleBootstrap = CloudbiteBootstrap & { pool?: Pool; configuration: CloudbiteBootstrap['configuration'] & { routing?: Routing } };
/** 규칙 기반 팀 제안의 한 줄: 브리프에서 찾은 카탈로그 키워드가 근거다 (모델 판단·점수 아님) */
interface PoolPick { entryId: string; expertId: string; matched: string[] }

const DIRECTIONS: OpinionDirection[] = ['support', 'conditional', 'concern', 'abstain'];
const DIRECTION_LABEL: Record<OpinionDirection, string> = { support: 'Support', conditional: 'Conditional', concern: 'Concern', abstain: 'Abstain' };
const STATUS_LABEL: Record<ExpertStatus, string> = {
  queued: 'Queued', provisioning: 'Preparing sandbox', running: 'Working', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: 'Draft', running: 'Running', completed: 'Completed', partial: 'Partially complete', failed: 'Failed', cancelled: 'Cancelled',
};
const EXPERT_STATUSES = Object.keys(STATUS_LABEL) as ExpertStatus[];
const PROJECT_STATUSES = Object.keys(PROJECT_STATUS_LABEL) as ProjectStatus[];
const ACTIVITY_KINDS: ExpertActivity['kind'][] = ['status', 'thought', 'tool', 'artifact', 'error'];
const TERMINAL_EXPERT: ExpertStatus[] = ['completed', 'failed', 'cancelled'];
const TERMINAL_PROJECT: ProjectStatus[] = ['completed', 'partial', 'failed', 'cancelled'];
const LIMIT = { title: 120, objective: 1500, context: 3000 };
const STREAM_ROWS = 400;
/** 편집 영역에 처음부터 보이는 역할 수. 나머지는 All experts 접기 상자에서 찾는다 */
const CORE_ROLES = 6;
/** 역할 카탈로그를 펼쳤을 때 한 번에 보이는 줄 수 (Show more 로 늘린다) */
const POOL_PAGE = 24;
/** 결정 세부 정보(선택): 칸마다 한 줄에 한 항목, 최대 8줄·줄마다 300자. 서버 계약 DecisionFrame 과 같은 여섯 칸 */
type DecisionField = keyof DecisionFrame;
const DECISION_FIELDS: DecisionField[] = ['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'];
const DECISION = { items: 8, chars: 300 };
/** 프로젝트 근거 파일(선택): 글자 파일만, 최대 6개·파일마다 8,000자·합계 24,000자. id 는 남은 순서대로 doc-1..doc-6 */
const DOCS = { files: 6, chars: 8000, total: 24000, bytes: 48 * 1024 };
// ── 워크플로 선택 필드 (src/cloudbite-workflow.ts 와 같은 값). 서버가 다시 검증하며 화면 값은 상한일 뿐 권한이 아니다
const STAGES: ProjectStage[] = ['unspecified', 'discovery', 'design', 'validation', 'launch', 'operation'];
const RESPONSE_LANGS: ResponseLanguage[] = ['ko', 'en'];
type BudgetField = keyof ProjectBudget;
const BUDGET_FIELDS: BudgetField[] = ['maxExperts', 'maxModelCalls', 'maxReviewCalls', 'maxMemoCalls'];
const BUDGET_LIMITS: Record<BudgetField, [number, number]> = { maxExperts: [1, 100], maxModelCalls: [1, 804], maxReviewCalls: [0, 3], maxMemoCalls: [0, 1] };
/** 서버 기본 예산: 역할마다 8회 + 교차 검토 3 + 메모 1 (cloudbite-budget.ts budgetCapsFor). 화면 안내·채우기용 */
const BUDGET_DEFAULT = { perExpert: 8, review: 3, memo: 1 };
const REVISION = { parentId: /^cb[0-9a-f]{32}$/, changeSummary: 2000 };
const OPTION_ID = /^option-[1-8]$/;
/** 서버 parsePmcIdentifier 와 같은 모양 (화면은 먼저 걸러 쓸데없는 요청을 막을 뿐, 판단은 서버가 한다) */
const PMC_ID = /^(?:PMC[1-9]\d{0,9}|(?:doi:)?10\.\d{4,9}\/[\x21-\x7e]{1,200})$/i;
const PMC_ID_BAD = /[<>"'\\{}|^`]/;
const PMC_ERRORS: PmcImportErrorCode[] = ['invalid_identifier', 'not_found', 'identity_mismatch', 'source_unavailable', 'rate_limited', 'timeout', 'too_large', 'redirect_blocked', 'invalid_xml', 'upstream_error'];
const MEMO_STATUSES: MemoStatus[] = ['idle', 'running', 'completed', 'failed', 'needs-options'];
const DOC_EXT = /\.(?:txt|md|csv|json)$/i;
/** 확장자가 맞아도 브라우저가 알려 준 형식이 글자가 아니면 받지 않는다 (Windows 는 .csv 를 vnd.ms-excel 로 알린다) */
const DOC_TYPES = ['', 'application/json', 'application/vnd.ms-excel'];
const VERDICTS: CrossReviewFinding['verdict'][] = ['supported', 'challenged', 'insufficient'];
const VERDICT_CHIP: Record<CrossReviewFinding['verdict'], string> = { supported: 'd-support', challenged: 'd-concern', insufficient: 'd-conditional' };

// ───────────────────────── 화면 문구 (KO / EN) ─────────────────────────
// 사전은 이 파일 안에 둔다 (빌드는 묶지 않는 변환이라 런타임 import 가 없다). KO 는 EN 과 같은 모양이어야 타입 검사를 통과한다.
// 저장해 두는 오류·안내는 글자가 아니라 Text(사전 → 글자) 로 두어, 언어를 바꾸면 같은 내용이 새 언어로 다시 그려진다.

type Lang = 'en' | 'ko';
/** 머리 전환 버튼 순서 (KO / EN) */
const LANG_ORDER: Lang[] = ['ko', 'en'];
const LANG_NAME: Record<Lang, string> = { ko: '한국어', en: 'English' };
type Text = (m: Messages) => string;
/** 서버와 같은 두 한도. 화면은 묶지 않고 변환되므로 값을 가져올 수 없어, 공유 리터럴 타입으로 어긋나면 타입 검사가 실패하게 한다.
 *  카탈로그(보여 주고 Jev 가 평가하는 역할 수)와 프로젝트당 선택 인원은 서로 다른 한도다 */
const CATALOGUE_MAX: CatalogueMaxRoles = 200;
const PROJECT_MAX: ProjectMaxExperts = 100;

// ── 워크플로 2단계 문구 (결정 메모 · 관찰 신호 · 후속 라운드). EN.p2 / KO.p2 로 붙고, KO 는 같은 모양이어야 타입 검사를 통과한다
const P2_EN = {
  memoTitle: 'Decision memo',
  memoExplain: 'Optional final memo: one server-side Nosana call reads the completed, valid opinions of this live project, finished cross-review findings and evidence metadata. It is a derived interpretation, not a vote count, an accuracy score or calibrated confidence. The original opinions stay unchanged.',
  memoBtn: 'Write decision memo (1 model call)',
  memoOneAttempt: 'Each project gets one memo attempt and it is never retried. For another round, start a follow-up from History; it runs as a new project.',
  memoNeedOpinion: 'The memo needs a finished, non-cancelled live run with at least one completed, valid opinion.',
  memoNoBudget: 'This project has no memo call left (its memo cap is 0 or already used), so a memo cannot be requested.',
  memoRunning: 'Writing the decision memo on the server…',
  memoServerRunning: 'The server reports a decision memo in progress.',
  memoNetwork: 'Could not confirm the server response. The memo may still be running or already saved. The paid request is not sent again; check its saved status.',
  memoNotFound: 'The server has no memo record for this project yet. The earlier request is not sent again; check again later.',
  memoCheck: 'Check memo status',
  memoRequestFailed: (e: string) => `The memo request was refused: ${e}`,
  memoDeferred: (e: string) => `The server did not start the memo and shows no memo attempt for this project, so it can still be requested${e ? `: ${e}` : '.'}`,
  memoReadFailed: 'Could not read the saved project status. This check sends no memo request; try again.',
  memoWaitReview: 'A cross-review is running for this project. The memo can be requested after it finishes.',
  reviewWaitMemo: 'A decision memo is running for this project. The cross-review can be requested after it finishes.',
  memoInvalid: 'The server returned a decision memo this console cannot read, so it is not shown.',
  memoPollStopped: 'Stopped checking the memo status. Reopen the project from History to see the saved result.',
  memoFailed: (e: string) => `The decision memo failed${e ? `: ${e}` : '.'}`,
  memoNeedsOptions: (r: string) => `No memo was written: the brief has no decision options to compare${r ? ` (${r})` : ''}. No model call was made. Add options in a follow-up round.`,
  memoIdle: 'No memo has been written for this project.',
  memoNone: 'No decision memo was written for this project.',
  memoSaved: 'Saved memo (read-only). History shows what the server stored and never requests a memo.',
  memoDone: (t: string, l: string) => `Completed at ${t}${l ? ` · written in ${l}` : ''}.`,
  memoSummary: 'Summary',
  memoRecommendation: 'Recommendation',
  memoRecNote: 'A derived interpretation of the opinions — not a vote count, accuracy or calibrated confidence.',
  memoNoRec: 'No recommendation',
  memoComparison: 'Option comparison',
  memoOption: 'Option', memoBenefits: 'Benefits', memoRisks: 'Risks', memoConditions: 'Conditions',
  memoDissent: 'Dissent', memoUnknowns: 'Critical unknowns', memoTriggers: 'What would change this', memoActions: 'Next actions',
  memoEmpty: 'None stated.',
  memoBy: (names: string) => `Attributed to: ${names}`,
  memoCoverage: 'Input coverage and omissions',
  memoCovTeam: (c: number, t: number) => `${c} of ${t} selected roles had a completed opinion behind this memo.`,
  memoCovDirections: (s: string) => `Stated directions (counts, not a vote): ${s}`,
  memoCovReviews: (i: number, t: number, tr: number, o: number, r: number) => `Cross-review findings: ${i} of ${t} included (${tr} shortened, ${o} omitted) from ${plural(r, 'report')}.`,
  memoCovPackets: (i: number, t: number, tr: number, o: number, inv: number, meta: number) => `Evidence metadata: ${i} of ${t} items included (${tr} shortened, ${o} omitted, ${inv} invalid, ${meta} metadata only).`,
  memoCovDocs: (t: number, n: number) => `Documents: ${t} supplied, ${n} shortened for the memo input.`,
  memoCovExperts: (n: number) => `${plural(n, 'opinion')} shortened for the memo input.`,
  memoCovBrief: (n: number, o: number) => `Brief: ${n} decision items shortened, ${o} omitted.`,
  memoCovRevision: 'Follow-up change summary: shortened for the memo input.',
  memoCovLimits: 'The memo did not read full reports or original source pages.',
  refOpinion: (name: string, n: number) => `${name} · evidence ${n}`,
  refDocument: (id: string, name: string) => `Document ${id}${name ? ` · ${name}` : ''}`,
  refPacket: (id: string) => `Evidence metadata ${id}`,
  refReview: (name: string, n: number) => `Cross-review by ${name} · finding ${n}`,
  refBrief: (f: string) => `Brief · ${f}`,
  unknown: 'UNKNOWN',
  sigTitle: 'Observed evidence signals',
  sigNote: 'Counts of what each opinion cited and what was observed, shown beside its self-assessed confidence. A curated card is a short summary card, not the original source page. A source ID being present is not accuracy, and these counts do not calibrate confidence.',
  sigMissing: 'Evidence signals: UNKNOWN — the server sent none for this project (not observed, which is not zero).',
  sigInvalid: 'The server sent evidence signals this console cannot read, so they are not shown.',
  sigPackets: (i: number, t: number) => `Evidence packets: ${i} of ${t} completed opinions have one.`,
  sigPacketsUnknown: 'Evidence packets: UNKNOWN — none were recorded for this project.',
  sigOmitted: (n: number, names: string) => `${n} omitted by the packet size bound: ${names}. An omitted packet does not mean nothing was retrieved.`,
  sigReview: (r: number, c: number, n: number, s: string) => `Cross-review: ${r} of ${c} completed opinions received at least one finding · ${plural(n, 'reviewer report')} · ${s}.`,
  sigReviewStatus: { running: 'running', completed: 'completed', failed: 'failed', 'not-run': 'not run' } as Record<ProjectCrossReview['status'] | 'not-run', string>,
  sigSelf: 'Self-assessed confidence',
  sigEvidence: 'Evidence items', sigEvidenceVal: (n: number, u: number) => `${n} (${u} without a source ID)`,
  sigRefs: 'Cited IDs', sigRefsVal: (t: number, d: number, w: number, k: number) => `${t}: ${d} document · ${w} workspace · ${k} knowledge`,
  sigSupplied: 'Supplied project text', sigSuppliedVal: (a: number, x: number) => `${a} present · ${x} missing`,
  sigKnowledge: 'Knowledge citations', sigKnowledgeVal: (c: number, o: number, u: number, n: number) => `${c} with curated card text · ${o} card text omitted · ${u} retrieval unverified · ${n} not retrieved`,
  sigUnknownIds: 'Unknown IDs', sigAssumptions: 'Assumptions',
  sigRetrieval: 'Observed retrieval', sigRetrievalVal: (b: string, r: number, c: number, s: number) => `${r} retrievals · ${c} cards · ${s} sources (binding: ${b})`,
  sigCross: 'Cross-review findings', sigCrossVal: (f: number, r: number, s: number, c: number, i: number, e: number) => `${f} from ${plural(r, 'reviewer')}: ${s} supported · ${c} challenged · ${i} insufficient · ${e} evidence items read`,
  revCoverage: (r: number, maxR: number, peers: number, assigned: number, completed: number) => `Planned coverage: ${plural(r, 'reviewer')} (cap ${maxR}), each reading up to ${peers} other opinions; ${assigned} of ${completed} completed opinions were assigned to a reviewer.`,
  revCap: 'The cap is at most 3 reviewers × 3 peers each, so not every role is reviewed.',
  revUnassigned: (names: string) => `Not assigned to any reviewer: ${names}`,
  revBasis: { available: 'cited text was in the reviewer input', partial: 'cited text partly in the reviewer input', unavailable: 'cited text not in the reviewer input', uncited: 'no source cited' } as Record<'available' | 'partial' | 'unavailable' | 'uncited', string>,
  roundTitle: 'Follow-up round',
  roundOf: (id: string) => `Follows project ${id}`,
  roundChange: 'What changed (user summary)',
  roundNote: 'This is a new project. Earlier opinions are previous-round reference only: they are not new results and are not counted in this round.',
  roundStage: (a: string, b: string, changed: boolean) => `Stage: ${a} → ${b}${changed ? '' : ' (unchanged)'}`,
  roundLang: (a: string, b: string, changed: boolean) => `Response language: ${a} → ${b}${changed ? '' : ' (unchanged)'}`,
  roundPrev: 'Previous options', roundCur: 'Current options',
  roundMatches: (s: string) => `Exact text matches: ${s}`, roundNoMatches: 'No option text matches exactly.',
  roundPositional: 'Option IDs are positional within each round, so option-1 before and after may be different options. Only identical text is matched; meaning is not analyzed.',
  roundList: (label: string, a: number, r: number, u: number) => `${label}: ${a} added · ${r} removed · ${u} unchanged`,
  roundDocs: (a: string, r: string, c: string, u: string) => `Documents: added ${a} · removed ${r} · changed ${c} · unchanged ${u}`,
  roundRoles: (a: string, r: string, k: string) => `Roles: added ${a} · removed ${r} · kept ${k}`,
  roundRefs: (n: number) => `Previous-round opinions (${n}, reference only)`,
  roundAgain: 'selected again',
  roundExcluded: (s: string) => `No completed opinion, not used as reference: ${s}`,
  roundOmissions: (n: number, s: string) => `${plural(n, 'part')} shortened or omitted from the reference: ${s}`,
  roundOpinion: (dir: string, conf: number) => `${dir} · self-assessed confidence ${conf}% (previous round)`,
  fuStart: 'Start follow-up round',
  fuStartHelp: 'Copies this brief into the editor for a new project. You edit it, prepare a plan and run it yourself; nothing runs automatically and earlier opinions are shown as reference only.',
  fuTitle: 'Follow-up round (new project)',
  fuParent: (title: string, id: string) => `Follows “${title}” · ${id}`,
  fuNote: 'The server checks that you can read the earlier project and builds the previous-round reference itself. Your usual project limits apply.',
  fuSummary: 'What changed since the previous round (required)',
  fuSummaryHelp: (n: number) => `Up to ${group(n)} characters.`,
  fuRoles: 'Roles: the previous team is preselected for manual choice. Change it, or let Jev select within the limit.',
  fuCancel: 'Cancel follow-up',
  fuDiff: 'Changes so far (exact text only)',
  fuNeedSummary: 'Follow-up: describe what changed since the previous round.',
  fuSummaryLong: (n: number) => `Follow-up: the change summary is longer than ${group(n)} characters.`,
  fuNeedLive: 'Follow-up rounds run as live projects only. Choose Live run in Settings.',
  fuParentMissing: 'The earlier project was not found or you cannot read it (it may have been deleted or expired). Cancel the follow-up or edit the brief as a new project.',
  fuCleared: 'The project was deleted, so the follow-up draft that referenced it was cleared.',
  roundInvalid: 'The server sent a previous-round record this console cannot read, so it is not shown.',
  memoReading: 'Reading the saved memo status (no new memo request is sent)…',
};
const P2_KO: typeof P2_EN = {
  memoTitle: '결정 메모',
  memoExplain: '선택 기능인 최종 메모입니다. 서버의 Nosana 호출 한 번이 이 실제 실행의 완료된 유효 의견, 끝난 교차 검토 판정, 근거 메타데이터를 읽습니다. 투표 집계·정확도 점수·보정된 확신도가 아니라 해석입니다. 원래 의견은 바뀌지 않습니다.',
  memoBtn: '결정 메모 쓰기 (모델 호출 1회)',
  memoOneAttempt: '프로젝트마다 메모는 한 번만 시도하며 다시 시도하지 않습니다. 다음 라운드는 사용 기록에서 후속 라운드를 시작해 새 프로젝트로 실행합니다.',
  memoNeedOpinion: '메모는 취소되지 않고 끝난 실제 실행에 완료된 유효 의견이 하나 이상 있어야 합니다.',
  memoNoBudget: '이 프로젝트에는 남은 메모 호출이 없어(메모 상한 0 또는 이미 사용) 메모를 요청할 수 없습니다.',
  memoRunning: '서버에서 결정 메모를 쓰는 중…',
  memoServerRunning: '서버가 결정 메모를 진행 중이라고 알렸습니다.',
  memoNetwork: '서버 응답을 확인하지 못했습니다. 메모가 아직 진행 중이거나 이미 저장되었을 수 있습니다. 유료 요청은 다시 보내지 않으니 저장된 상태를 확인하세요.',
  memoNotFound: '서버에 아직 이 프로젝트의 메모 기록이 없습니다. 앞선 요청은 다시 보내지 않습니다. 나중에 다시 확인하세요.',
  memoCheck: '메모 상태 확인',
  memoRequestFailed: (e) => `메모 요청이 거절되었습니다: ${e}`,
  memoDeferred: (e) => `서버가 메모를 시작하지 않았고 이 프로젝트의 메모 시도 기록도 없어 아직 요청할 수 있습니다${e ? `: ${e}` : '.'}`,
  memoReadFailed: '저장된 프로젝트 상태를 읽지 못했습니다. 이 확인은 메모 요청을 보내지 않습니다. 다시 시도하세요.',
  memoWaitReview: '이 프로젝트의 교차 검토가 진행 중입니다. 끝난 뒤 메모를 요청할 수 있습니다.',
  reviewWaitMemo: '이 프로젝트의 결정 메모가 진행 중입니다. 끝난 뒤 교차 검토를 요청할 수 있습니다.',
  memoInvalid: '서버가 이 콘솔이 읽을 수 없는 결정 메모를 보내 표시하지 않습니다.',
  memoPollStopped: '메모 상태 확인을 멈췄습니다. 사용 기록에서 프로젝트를 다시 열어 저장된 결과를 보세요.',
  memoFailed: (e) => `결정 메모가 실패했습니다${e ? `: ${e}` : '.'}`,
  memoNeedsOptions: (r) => `메모를 쓰지 않았습니다: 브리프에 비교할 결정 선택지가 없습니다${r ? ` (${r})` : ''}. 모델 호출은 없었습니다. 후속 라운드에서 선택지를 더하세요.`,
  memoIdle: '이 프로젝트에는 아직 메모가 없습니다.',
  memoNone: '이 프로젝트에는 결정 메모가 작성되지 않았습니다.',
  memoSaved: '저장된 메모(읽기 전용). 사용 기록은 서버가 저장한 것만 보이며 메모를 요청하지 않습니다.',
  memoDone: (t, l) => `${t}에 완료${l ? ` · ${l}로 작성` : ''}.`,
  memoSummary: '요약',
  memoRecommendation: '권고',
  memoRecNote: '의견에서 끌어낸 해석입니다 — 투표 집계·정확도·보정된 확신도가 아닙니다.',
  memoNoRec: '권고 없음',
  memoComparison: '선택지 비교',
  memoOption: '선택지', memoBenefits: '이점', memoRisks: '위험', memoConditions: '조건',
  memoDissent: '이견', memoUnknowns: '핵심 미지수', memoTriggers: '판단을 바꿀 조건', memoActions: '다음 행동',
  memoEmpty: '밝힌 내용 없음.',
  memoBy: (names) => `출처 역할: ${names}`,
  memoCoverage: '입력 범위와 빠진 부분',
  memoCovTeam: (c, t) => `선택한 역할 ${t}개 중 ${c}개의 완료 의견이 이 메모의 바탕입니다.`,
  memoCovDirections: (s) => `밝힌 방향(개수일 뿐 투표가 아님): ${s}`,
  memoCovReviews: (i, t, tr, o, r) => `교차 검토 판정: 보고서 ${r}개의 ${t}개 중 ${i}개 포함 (${tr}개 줄임, ${o}개 뺌).`,
  memoCovPackets: (i, t, tr, o, inv, meta) => `근거 메타데이터: ${t}개 중 ${i}개 포함 (${tr}개 줄임, ${o}개 뺌, ${inv}개 형식 오류, ${meta}개 메타데이터만).`,
  memoCovDocs: (t, n) => `문서: ${t}개 제공, 메모 입력에서 ${n}개 줄임.`,
  memoCovExperts: (n) => `메모 입력에서 의견 ${n}개를 줄였습니다.`,
  memoCovBrief: (n, o) => `브리프: 결정 항목 ${n}개 줄임, ${o}개 뺌.`,
  memoCovRevision: '후속 라운드 변경 요약: 메모 입력에서 줄임.',
  memoCovLimits: '메모는 전체 보고서나 원문 출처 페이지를 읽지 않았습니다.',
  refOpinion: (name, n) => `${name} · 근거 ${n}`,
  refDocument: (id, name) => `문서 ${id}${name ? ` · ${name}` : ''}`,
  refPacket: (id) => `근거 메타데이터 ${id}`,
  refReview: (name, n) => `${name}의 교차 검토 · 판정 ${n}`,
  refBrief: (f) => `브리프 · ${f}`,
  unknown: '알 수 없음(UNKNOWN)',
  sigTitle: '관찰된 근거 신호',
  sigNote: '각 의견이 인용한 것과 관찰된 것을 센 값이며, 자체 평가 확신도 옆에 보입니다. 정리 카드는 짧은 요약 카드이지 원문 출처 페이지가 아닙니다. 출처 ID가 있다는 것은 정확도가 아니며, 이 숫자는 확신도를 보정하지 않습니다.',
  sigMissing: '근거 신호: 알 수 없음(UNKNOWN) — 서버가 이 프로젝트에 보내지 않았습니다 (관찰되지 않음이며 0이 아님).',
  sigInvalid: '서버가 이 콘솔이 읽을 수 없는 근거 신호를 보내 표시하지 않습니다.',
  sigPackets: (i, t) => `근거 묶음: 완료 의견 ${t}개 중 ${i}개에 있음.`,
  sigPacketsUnknown: '근거 묶음: 알 수 없음(UNKNOWN) — 이 프로젝트에는 기록되지 않았습니다.',
  sigOmitted: (n, names) => `묶음 크기 한도로 ${n}개 빠짐: ${names}. 묶음이 빠졌다고 아무것도 찾지 않았다는 뜻은 아닙니다.`,
  sigReview: (r, c, n, s) => `교차 검토: 완료 의견 ${c}개 중 ${r}개가 판정을 하나 이상 받음 · 검토 보고서 ${n}개 · ${s}.`,
  sigReviewStatus: { running: '진행 중', completed: '완료', failed: '실패', 'not-run': '실행 안 함' },
  sigSelf: '자체 평가 확신도',
  sigEvidence: '근거 항목', sigEvidenceVal: (n, u) => `${n}개 (출처 ID 없는 것 ${u}개)`,
  sigRefs: '인용한 ID', sigRefsVal: (t, d, w, k) => `${t}개: 문서 ${d} · 작업공간 ${w} · 지식 ${k}`,
  sigSupplied: '제공한 프로젝트 글', sigSuppliedVal: (a, x) => `있음 ${a} · 없음 ${x}`,
  sigKnowledge: '지식 인용', sigKnowledgeVal: (c, o, u, n) => `정리 카드 글 있음 ${c} · 카드 글 빠짐 ${o} · 검색 확인 안 됨 ${u} · 검색 안 됨 ${n}`,
  sigUnknownIds: '알 수 없는 ID', sigAssumptions: '가정',
  sigRetrieval: '관찰된 검색', sigRetrievalVal: (b, r, c, s) => `검색 ${r}회 · 카드 ${c}개 · 출처 ${s}개 (연결: ${b})`,
  sigCross: '교차 검토 판정', sigCrossVal: (f, r, s, c, i, e) => `검토자 ${r}명의 ${f}개: 뒷받침 ${s} · 반박 ${c} · 근거 부족 ${i} · 읽은 근거 항목 ${e}`,
  revCoverage: (r, maxR, peers, assigned, completed) => `계획된 범위: 검토자 ${r}명(상한 ${maxR}), 각자 다른 의견을 최대 ${peers}개 읽음; 완료 의견 ${completed}개 중 ${assigned}개가 검토자에게 배정됨.`,
  revCap: '상한은 검토자 최대 3명 × 각 3개 의견이라 모든 역할이 검토되지는 않습니다.',
  revUnassigned: (names) => `어느 검토자에게도 배정되지 않음: ${names}`,
  revBasis: { available: '인용한 글이 검토자 입력에 있었음', partial: '인용한 글 일부만 검토자 입력에 있었음', unavailable: '인용한 글이 검토자 입력에 없었음', uncited: '인용한 출처 없음' },
  roundTitle: '후속 라운드',
  roundOf: (id) => `프로젝트 ${id}의 후속`,
  roundChange: '바뀐 점 (사용자 요약)',
  roundNote: '새 프로젝트입니다. 이전 의견은 이전 라운드 참고 자료일 뿐 새 결과가 아니며 이번 라운드 집계에 들어가지 않습니다.',
  roundStage: (a, b, changed) => `단계: ${a} → ${b}${changed ? '' : ' (같음)'}`,
  roundLang: (a, b, changed) => `응답 언어: ${a} → ${b}${changed ? '' : ' (같음)'}`,
  roundPrev: '이전 선택지', roundCur: '지금 선택지',
  roundMatches: (s) => `글이 똑같은 선택지: ${s}`, roundNoMatches: '글이 똑같은 선택지가 없습니다.',
  roundPositional: '선택지 ID는 라운드마다 순서로 매겨져, 앞뒤의 option-1이 다른 선택지일 수 있습니다. 글이 똑같은 것만 짝짓고 의미는 분석하지 않습니다.',
  roundList: (label, a, r, u) => `${label}: 추가 ${a} · 삭제 ${r} · 같음 ${u}`,
  roundDocs: (a, r, c, u) => `문서: 추가 ${a} · 삭제 ${r} · 바뀜 ${c} · 같음 ${u}`,
  roundRoles: (a, r, k) => `역할: 추가 ${a} · 제외 ${r} · 유지 ${k}`,
  roundRefs: (n) => `이전 라운드 의견 (${n}개, 참고용)`,
  roundAgain: '다시 선택됨',
  roundExcluded: (s) => `완료 의견이 없어 참고에 쓰지 않음: ${s}`,
  roundOmissions: (n, s) => `참고 자료에서 ${n}개 부분을 줄이거나 뺌: ${s}`,
  roundOpinion: (dir, conf) => `${dir} · 자체 평가 확신도 ${conf}% (이전 라운드)`,
  fuStart: '후속 라운드 시작',
  fuStartHelp: '이 브리프를 편집 영역에 새 프로젝트로 복사합니다. 직접 고치고 계획을 준비해 실행합니다. 자동으로 실행되는 것은 없으며 이전 의견은 참고로만 보입니다.',
  fuTitle: '후속 라운드 (새 프로젝트)',
  fuParent: (title, id) => `“${title}”의 후속 · ${id}`,
  fuNote: '서버가 이전 프로젝트를 읽을 수 있는지 확인하고 이전 라운드 참고 자료를 직접 만듭니다. 평소의 프로젝트 한도가 적용됩니다.',
  fuSummary: '이전 라운드 뒤 바뀐 점 (필수)',
  fuSummaryHelp: (n) => `최대 ${group(n)}자.`,
  fuRoles: '역할: 직접 고르기에는 이전 팀이 미리 선택되어 있습니다. 바꾸거나 한도 안에서 Jev가 고르게 하세요.',
  fuCancel: '후속 라운드 취소',
  fuDiff: '지금까지 바뀐 점 (글이 같은지만 봄)',
  fuNeedSummary: '후속 라운드: 이전 라운드 뒤 바뀐 점을 적어 주세요.',
  fuSummaryLong: (n) => `후속 라운드: 바뀐 점 요약이 ${group(n)}자를 넘습니다.`,
  fuNeedLive: '후속 라운드는 실제 실행으로만 돕니다. 설정에서 실제 실행을 고르세요.',
  fuParentMissing: '이전 프로젝트를 찾지 못했거나 읽을 수 없습니다 (삭제되었거나 만료되었을 수 있습니다). 후속 라운드를 취소하거나 새 프로젝트로 브리프를 고치세요.',
  fuCleared: '프로젝트가 삭제되어 그 프로젝트를 가리키던 후속 라운드 초안을 지웠습니다.',
  roundInvalid: '서버가 보낸 이전 라운드 기록을 이 화면이 읽을 수 없어 표시하지 않습니다.',
  memoReading: '저장된 메모 상태를 읽는 중입니다 (새 메모 요청은 보내지 않습니다)…',
};

// ── 제품 v3 문구 (주장 출처·채택 · 검토가 읽은 산출물 · 작성자 응답). EN.p3 / KO.p3, KO 는 같은 모양
const P3_EN = {
  provTitle: 'Claim provenance',
  provNote: 'Who wrote each claim and whether you adopted it. This is structure, not fact-checking: nothing here verifies a claim, retrieves a source or reads full reports.',
  provCounts: (stated: number, proposals: number, hinted: number, adopted: number) => `${stated} user statements · ${proposals} generated proposals (${hinted} with numbers or thresholds) · ${adopted} adopted by a user`,
  provStale: (n: number) => `${plural(n, 'earlier adoption')} no longer match the current claim text and give no standing.`,
  provCoverage: (experts: number, omitted: number, items: number, cut: number, refs: number) => `Read ${plural(experts, 'role')} (${omitted} omitted); ${items} items omitted, ${cut} claims shortened, ${refs} references omitted.`,
  provCarried: (n: number, bad: number) => `${plural(n, 'adoption')} carried from the previous round${bad ? `, ${bad} unreadable dropped` : ''}.`,
  provInvalid: 'The server sent claim provenance this console cannot read, so it is not shown and nothing can be adopted.',
  provGroup: { hinted: 'Generated proposals with numbers or thresholds', adopted: 'Adopted by a user', proposals: 'Other generated proposals', stated: 'Your own statements' },
  provStanding: { 'user-stated': 'User statement', 'generated-proposal': 'Generated proposal', 'user-adopted': 'User-adopted' },
  provHint: 'Contains a number or threshold — a proposal, not a requirement',
  provMore: (n: number) => `Show ${n} more`,
  provOrigin: 'Origin and standing',
  provOriginName: { 'user-statement': 'Written by the user in the brief', 'generated-opinion': 'Written by an expert model', 'parent-adoption': 'Adopted in the previous round' },
  provField: (field: string, index: number) => `Field: ${field} · item ${index + 1}`,
  provExpert: (name: string) => `Role: ${name}`,
  provRef: { 'supplied-document': 'document supplied with this project', 'catalogue-listed': 'listed in the role catalogue (not retrieved)', 'not-found': 'not found' },
  provAdoptedIn: (project: string, at: string) => `Adopted in ${project} at ${at} (recorded by the server)`,
  provTruncated: 'This claim was shortened, so its full text was never shown and it cannot be adopted.',
  provAdopt: 'Adopt…',
  provAdoptConfirm: 'Adopt this exact text',
  provAdoptCancel: 'Keep as proposal',
  provAdoptAsk: 'You are adopting exactly this text as your own requirement. Adoption is your decision, not verification. The original memo stays unchanged and is not regenerated.',
  provAdopting: 'Saving the adoption…',
  provReading: 'Checking the saved state before anything else is sent…',
  provAdopted: 'Adopted. The saved project was read again.',
  provAdoptedSeen: 'The saved project already shows this adoption.',
  provAdoptFailed: (why: string) => `Not adopted: ${why}`,
  provAdoptUnknown: 'The server\'s answer did not arrive or could not be read. The saved state was read again; adopt again only if it still shows a proposal.',
  provAdoptUnreconciled: 'The server\'s answer did not arrive and the saved state could not be read again, so it is unknown whether this claim was adopted. Read the saved state again (or reload the page) before adopting again.',
  provReread: 'Read the saved state again',
  provAdoptReread: 'The saved state was read again and does not show this adoption. Adopt again only if it still shows a proposal.',
  provAdoptForeign: 'This project was not found or is not yours.',
  provAdoptNotOwn: 'Only the project\'s own user can adopt its claims. You can read this project, but it is not yours.',
  provAdoptSignedOut: 'The server did not accept your sign-in for saved records (expired or missing). Nothing was adopted; sign in again, then adopt.',
  provAdoptCheckFailed: 'The saved record could not be read to confirm this is your project, so nothing was sent. Try again.',
  provAdoptWait: 'Adoption is possible once the project has finished and no review or memo is running.',
  provMemoNote: 'The decision memo is a saved snapshot: adopting a claim later does not change or regenerate it.',
  mdProvTitle: 'Claim provenance',
  artTitle: (roles: number, files: number) => `Artifact text the reviewers read (${plural(roles, 'role')}, ${plural(files, 'file')})`,
  artNote: 'Reviewers read these stored text excerpts. No code was run, no data was parsed and nothing was independently verified.',
  artFile: (path: string, a: number, b: number, total: number) => `${path} · lines ${a}–${b} of ${total}`,
  artExcerptCut: 'excerpt cut at the reading limit',
  artStoredCut: 'stored copy was already truncated',
  artOmitted: (path: string, reason: string) => `${path}: not read (${reason})`,
  artReason: { 'opinion-duplicate': 'duplicate of the opinion', 'knowledge-audit': 'knowledge audit file', 'runner-manifest': 'runner manifest', 'missing-text': 'no stored text',
    binary: 'binary', 'unsafe-path': 'unsafe path', 'duplicate-path': 'duplicate path', 'file-limit': 'file limit', budget: 'reading budget' } as Record<string, string>,
  artNone: 'No stored artifact text was given to the reviewers.',
  artInvalid: 'The server sent artifact coverage this console cannot read, so it is not shown.',
  arTitle: 'Author response',
  arNote: 'Authors answered the review findings on their own evidence. A response is the author’s position, not a verification or a ruling on the reviewer. The original opinions and memo of the earlier project are unchanged.',
  arFinding: (reviewer: string, verdict: string, author: string, n: number) => `${reviewer} · ${verdict} · ${author}, evidence ${n}`,
  arOriginal: (dir: string, conf: number) => `Original opinion (earlier project, unchanged): ${dir} · self-assessed confidence ${conf}%`,
  arDisposition: { revise: 'Revise', withdraw: 'Withdraw', maintain: 'Maintain' },
  arMissing: 'No response to this finding',
  arPending: 'No response yet (the role has not completed)',
  arStatus: { complete: 'All findings answered', partial: 'Some findings answered', none: 'No findings answered' },
  arAnswered: (a: number, e: number) => `${a} of ${e} answered`,
  arInvalid: (why: string) => `Response rejected by the server: ${why}`,
  arUnreadable: 'The server sent a response this console cannot read, so it is not shown.',
  arSeparate: 'This is separate from the role’s opinion status above.',
  arCapped: (included: number, eligible: number) => `${included} of ${eligible} eligible findings were included.`,
  arUnselected: (s: string) => `Affected authors not selected: ${s}`,
  arPlanInvalid: 'The server sent an author-response plan this console cannot read, so it is not shown.',
  arReviewer: 'Reviewer’s rationale',
  arEvidence: 'Author’s original evidence',
  arAsk: 'Ask authors to respond',
  arAskHelp: 'Opens a new follow-up project for the authors whose evidence was challenged or found insufficient. You choose which of them run, prepare a plan and confirm the run; nothing runs or is paid for automatically, and this project stays unchanged.',
  arNone: 'No completed author has a challenged or insufficient finding, so there is nothing to answer.',
  fuAuthor: (names: string) => `Author response round. Only these affected authors can be selected: ${names}. The child project uses its own normal budget.`,
  fuAuthorOnly: 'Author response: select only affected authors (manual selection; Jev routing is not used).',
  fuAuthorNone: 'Author response: select at least one affected author.',
};
const P3_KO: typeof P3_EN = {
  provTitle: '주장 출처',
  provNote: '각 주장을 누가 썼고 사용자가 채택했는지를 보입니다. 구조일 뿐 사실 확인이 아닙니다. 여기서는 주장을 검증하거나 출처를 가져오거나 전체 보고서를 읽지 않습니다.',
  provCounts: (stated: number, proposals: number, hinted: number, adopted: number) => `사용자 진술 ${stated}개 · 생성된 제안 ${proposals}개(숫자·기준 포함 ${hinted}개) · 사용자 채택 ${adopted}개`,
  provStale: (n: number) => `이전 채택 ${n}개는 지금 주장 글과 맞지 않아 효력이 없습니다.`,
  provCoverage: (experts: number, omitted: number, items: number, cut: number, refs: number) => `역할 ${experts}개를 읽었습니다(${omitted}개 빠짐). 항목 ${items}개 빠짐, 주장 ${cut}개 줄임, 참조 ${refs}개 빠짐.`,
  provCarried: (n: number, bad: number) => `이전 라운드에서 넘어온 채택 ${n}개${bad ? `, 읽을 수 없어 버린 것 ${bad}개` : ''}.`,
  provInvalid: '서버가 보낸 주장 출처를 이 화면이 읽을 수 없어 표시하지 않으며 채택할 수 없습니다.',
  provGroup: { hinted: '숫자·기준이 있는 생성된 제안', adopted: '사용자가 채택함', proposals: '그 밖의 생성된 제안', stated: '사용자가 쓴 진술' },
  provStanding: { 'user-stated': '사용자 진술', 'generated-proposal': '생성된 제안', 'user-adopted': '사용자 채택' },
  provHint: '숫자나 기준이 있습니다 — 요구 사항이 아니라 제안입니다',
  provMore: (n: number) => `${n}개 더 보기`,
  provOrigin: '출처와 지위',
  provOriginName: { 'user-statement': '사용자가 브리프에 쓴 글', 'generated-opinion': '전문가 모델이 쓴 글', 'parent-adoption': '이전 라운드에서 채택한 글' },
  provField: (field: string, index: number) => `칸: ${field} · ${index + 1}번째 항목`,
  provExpert: (name: string) => `역할: ${name}`,
  provRef: { 'supplied-document': '이 프로젝트에 넣은 자료', 'catalogue-listed': '역할 카탈로그에 있음(가져오지 않음)', 'not-found': '찾지 못함' },
  provAdoptedIn: (project: string, at: string) => `${project} 에서 ${at} 에 채택(서버 기록)`,
  provTruncated: '이 주장은 줄여 저장되어 전체 글이 보인 적이 없으므로 채택할 수 없습니다.',
  provAdopt: '채택…',
  provAdoptConfirm: '이 글 그대로 채택',
  provAdoptCancel: '제안으로 두기',
  provAdoptAsk: '이 글을 정확히 그대로 사용자의 요구 사항으로 채택합니다. 채택은 사용자의 결정이며 검증이 아닙니다. 원래 메모는 바뀌지 않고 다시 만들지 않습니다.',
  provAdopting: '채택을 저장하는 중…',
  provReading: '다른 요청을 보내기 전에 저장된 상태를 확인하는 중…',
  provAdopted: '채택했습니다. 저장된 프로젝트를 다시 읽었습니다.',
  provAdoptedSeen: '저장된 프로젝트에 이미 이 채택이 있습니다.',
  provAdoptFailed: (why: string) => `채택하지 못했습니다: ${why}`,
  provAdoptUnknown: '서버의 응답이 오지 않았거나 읽을 수 없었습니다. 저장된 상태를 다시 읽었으니, 여전히 제안으로 보일 때만 다시 채택하세요.',
  provAdoptUnreconciled: '서버의 응답이 오지 않았고 저장된 상태도 다시 읽지 못해, 이 주장이 채택되었는지 알 수 없습니다. 다시 채택하기 전에 저장된 상태를 다시 읽거나 페이지를 새로 고치세요.',
  provReread: '저장된 상태 다시 읽기',
  provAdoptReread: '저장된 상태를 다시 읽었고 이 채택은 없습니다. 여전히 제안으로 보일 때만 다시 채택하세요.',
  provAdoptForeign: '이 프로젝트를 찾을 수 없거나 사용자의 프로젝트가 아닙니다.',
  provAdoptNotOwn: '이 프로젝트의 주장은 프로젝트를 만든 사용자만 채택할 수 있습니다. 읽을 수는 있지만 사용자의 프로젝트가 아닙니다.',
  provAdoptSignedOut: '저장된 기록에 대한 로그인을 서버가 받아들이지 않았습니다(만료되었거나 없음). 채택된 것은 없습니다. 다시 로그인한 뒤 채택하세요.',
  provAdoptCheckFailed: '사용자의 프로젝트인지 확인하려고 저장된 기록을 읽지 못해 아무것도 보내지 않았습니다. 다시 시도하세요.',
  provAdoptWait: '프로젝트가 끝나고 진행 중인 검토·메모가 없을 때 채택할 수 있습니다.',
  provMemoNote: '결정 메모는 저장된 시점의 기록입니다. 나중에 주장을 채택해도 메모는 바뀌거나 다시 만들어지지 않습니다.',
  mdProvTitle: '주장 출처',
  artTitle: (roles: number, files: number) => `검토자가 읽은 산출물 글 (역할 ${roles}개, 파일 ${files}개)`,
  artNote: '검토자는 저장된 글 발췌를 읽었습니다. 코드를 실행하거나 데이터를 분석하지 않았고 아무것도 따로 검증하지 않았습니다.',
  artFile: (path: string, a: number, b: number, total: number) => `${path} · ${total}줄 중 ${a}–${b}줄`,
  artExcerptCut: '읽기 한도에서 발췌가 잘림',
  artStoredCut: '저장본이 이미 잘려 있음',
  artOmitted: (path: string, reason: string) => `${path}: 읽지 않음 (${reason})`,
  artReason: { 'opinion-duplicate': '의견과 중복', 'knowledge-audit': '지식 감사 파일', 'runner-manifest': '실행기 목록', 'missing-text': '저장된 글 없음',
    binary: '바이너리', 'unsafe-path': '안전하지 않은 경로', 'duplicate-path': '중복 경로', 'file-limit': '파일 수 한도', budget: '읽기 한도' },
  artNone: '검토자에게 저장된 산출물 글이 주어지지 않았습니다.',
  artInvalid: '서버가 보낸 산출물 범위를 이 화면이 읽을 수 없어 표시하지 않습니다.',
  arTitle: '작성자 응답',
  arNote: '작성자가 자기 근거에 대한 검토 지적에 답했습니다. 응답은 작성자의 입장일 뿐 검증이나 검토자에 대한 판정이 아닙니다. 이전 프로젝트의 원래 의견과 메모는 바뀌지 않습니다.',
  arFinding: (reviewer: string, verdict: string, author: string, n: number) => `${reviewer} · ${verdict} · ${author}, 근거 ${n}`,
  arOriginal: (dir: string, conf: number) => `원래 의견(이전 프로젝트, 바뀌지 않음): ${dir} · 자체 평가 확신도 ${conf}%`,
  arDisposition: { revise: '수정', withdraw: '철회', maintain: '유지' },
  arMissing: '이 지적에 대한 응답 없음',
  arPending: '아직 응답 없음 (역할이 끝나지 않음)',
  arStatus: { complete: '모든 지적에 응답', partial: '일부 지적에 응답', none: '응답한 지적 없음' },
  arAnswered: (a: number, e: number) => `${e}개 중 ${a}개 응답`,
  arInvalid: (why: string) => `서버가 응답을 거부했습니다: ${why}`,
  arUnreadable: '서버가 보낸 응답을 이 화면이 읽을 수 없어 표시하지 않습니다.',
  arSeparate: '위의 역할 의견 상태와는 별개입니다.',
  arCapped: (included: number, eligible: number) => `해당 지적 ${eligible}개 중 ${included}개를 넣었습니다.`,
  arUnselected: (s: string) => `고르지 않은 해당 작성자: ${s}`,
  arPlanInvalid: '서버가 보낸 작성자 응답 계획을 이 화면이 읽을 수 없어 표시하지 않습니다.',
  arReviewer: '검토자의 근거',
  arEvidence: '작성자의 원래 근거',
  arAsk: '작성자에게 응답 요청',
  arAskHelp: '근거가 반박되었거나 부족하다고 지적된 작성자들을 위한 새 후속 프로젝트를 엽니다. 어떤 작성자를 실행할지 고르고 계획을 준비해 실행을 확인합니다. 자동으로 실행되거나 비용이 드는 것은 없으며 이 프로젝트는 바뀌지 않습니다.',
  arNone: '반박되었거나 부족하다고 지적된 완료 작성자가 없어 응답할 것이 없습니다.',
  fuAuthor: (names: string) => `작성자 응답 라운드. 해당 작성자만 고를 수 있습니다: ${names}. 새 프로젝트에는 별도의 실행 예산이 적용됩니다.`,
  fuAuthorOnly: '작성자 응답: 해당 작성자만 직접 고르세요 (Jev 경로 선택은 쓰지 않습니다).',
  fuAuthorNone: '작성자 응답: 해당 작성자를 한 명 이상 고르세요.',
};

const EN = {
  p2: P2_EN, p3: P3_EN,
  docTitle: 'Cloudbite — Expert sandbox workspace',
  langGroup: 'Language',
  langChanged: 'Language: English',
  direction: DIRECTION_LABEL,
  status: STATUS_LABEL,
  projectStatus: PROJECT_STATUS_LABEL,
  kind: { status: 'status', thought: 'note', tool: 'tool', artifact: 'file', error: 'error' } as Record<ExpertActivity['kind'], string>,
  experts: (n: number) => plural(n, 'expert'),
  projects: (n: number) => plural(n, 'project'),
  // 예시 브리프 (사용자가 고치지 않았을 때만 언어를 따라 바뀐다)
  sampleTitle: 'Launch a 100-expert AI advisory room',
  sampleObjective: 'Decide whether launching a 100-expert AI advisory room for startup teams on a partially paid model within 4 weeks makes sense, and what to watch out for.',
  sampleContext: 'Early users are startup teams of 5–20 people. Every opinion should show its evidence and sources. Team data will not be uploaded.',
  staExample: 'Try the curated STA expert',
  staTitle: 'PrimeTime setup / hold review',
  staObjective: 'Explain setup and hold slack using an educational single-clock model. For setup: launch edge 0 ns, launch latency 0.20 ns, clk-to-Q 0.08 ns, data delay 0.72 ns; capture edge 1.00 ns, capture latency 0.10 ns, setup 0.07 ns, uncertainty 0.04 ns, CRPR 0. Show arrival, required and slack, cite the curated sources, and explain why positive WNS alone is not signoff.',
  staContext: 'Educational example only. No real design data or licensed PrimeTime execution. Distinguish provided facts, assumptions and version-dependent options.',
  // 폼 검증
  vTitle: 'Enter a project name.',
  vTitleLong: (n: number) => `The project name must be ${n} characters or fewer.`,
  vObjective: 'Enter an objective.',
  vObjectiveLong: (n: number) => `The objective must be ${n} characters or fewer.`,
  vContextLong: (n: number) => `The context must be ${n} characters or fewer.`,
  vMin: (n: number) => `Select at least ${plural(n, 'expert')}.`,
  vMax: (n: number) => `You can select up to ${plural(n, 'expert')}.`,
  // 종합 한 줄
  hNone: 'No completed opinions to synthesise yet.',
  hTie: 'Opinions are evenly split — narrow down the disputed points before deciding.',
  hSupport: 'Most opinions favour going ahead — you can move straight to the suggested next actions.',
  hConditional: 'Most opinions say: set the conditions first and start small.',
  hConcern: 'Concerns dominate — do not expand until the key risks are resolved.',
  hAbstain: 'Many experts abstained — more information is needed.',
  hPartial: (base: string, valid: number, total: number) => `${base} (based on ${valid} of ${total} selected experts)`,
  // Markdown 보고서
  mdDemo: '> Browser demo simulation. No real Daytona sandbox or Nosana inference was involved.',
  mdLive: '> Live run result. Confidence is each AI role\'s self-assessment, not calibrated accuracy.',
  mdObjective: 'Objective', mdContext: 'Context', mdSynthesis: 'Synthesis', mdNext: 'Next actions', mdByExpert: 'Opinions by expert', none: '(none)',
  mdStatus: (s: string) => `Status: ${s}`,
  mdCounts: (a: { selected: number; valid: number; failed: number; pending: number; cancelled: number; invalid: number }) =>
    `Selected ${a.selected} · valid opinions ${a.valid} · failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled} · invalid format ${a.invalid}`,
  mdMean: (v: string) => `Mean self-assessed confidence: ${v}`,
  mdOpinion: (d: string, c: number) => `${d} · confidence ${c}%`,
  mdError: (e: string) => `Error: ${e}`,
  mdInvalid: 'Excluded from the synthesis because the result format was invalid.',
  exportDemoNote: 'Browser simulation — no real sandbox or inference',
  exportLiveNote: 'Confidence is self-assessed, not calibrated accuracy',
  // 머리·탐색
  brandSub: 'Expert sandboxes for one shared project',
  sessionAria: 'Session',
  navAria: 'Primary', navLabel: 'Workspace',
  nav: { home: 'Home', guide: 'Guide', help: 'Help', settings: 'Settings', history: 'History' } as Record<View, string>,
  navFoot: (roles: number, max: number) => roles ? `Independent workspaces · ${roles} catalogue roles · up to ${max} per project` : `Independent workspaces · Up to ${max} experts per project`,
  requestAccess: 'Request visitor access',
  accessQr: 'Access QR',
  ownerInbox: 'Owner inbox',
  modeDemo: 'Browser demo', modeLive: 'Live run',
  bannerDemo: 'Browser demo — simulated activity and files; no Daytona or Nosana calls. Nothing runs until you start it.',
  bannerLive: 'Live run — server-reported activity. Confidence is self-assessed.',
  profileOperator: 'Operator', profileOwner: 'Owner', profileVisitor: 'Visitor',
  stateOperatorToken: 'Temporary Cloudbite operator token in memory',
  stateAdminToken: 'Admin token held in memory',
  stateOwner: 'Owner signed in',
  stateVisitor: (t: string) => `Visitor session · ends ${t}`,
  stateNone: 'No admin token',
  // 브리프 편집
  briefAria: 'Project brief',
  objectiveLabel: 'Objective — what should the experts decide or produce?',
  projectDetails: 'Project details',
  projectName: 'Project name',
  contextLabel: 'Context (optional)',
  nameRequired: 'Name required',
  chooseExperts: 'Choose experts',
  allExpertsAria: 'All experts',
  allExperts: (n: number) => `All experts (${n})`,
  searchPlaceholder: 'Search all roles',
  searchAria: 'Search all experts',
  changeInSettings: 'Change in Settings',
  openSettings: 'Open Settings',
  failSim: 'Simulate one expert failing',
  selCount: (n: number, max: number) => `${n} selected · up to ${max}`,
  alsoSelected: (names: string) => `Also selected from All experts: ${names}`,
  builtinRoles: 'The server catalogue is empty or unreachable, so the demo uses 6 built-in demo roles.',
  maxReached: (n: number) => `Maximum of ${plural(n, 'expert')} reached. Clear one to choose another.`,
  recommended: '3–5 experts are recommended.',
  catalogueEmptyLive: 'The server catalogue is empty, so a live run is not possible.',
  noRoles: 'No roles available.',
  noMatch: 'No roles match your search.',
  // 역할 카탈로그 (서버 bootstrap.pool 이 있을 때만)
  poolSummary: (n: number, avail: number) => `Browse the role catalogue (${n} entries · ${avail} runnable now)`,
  poolNote: 'Numbers come from the planning list. Only roles marked Available run today; planned roles cannot be selected or run. No role has been evaluated yet, and the size of the catalogue is not evidence of expertise.',
  poolSearchLabel: 'Search the catalogue',
  poolSearchPlaceholder: 'Role, number or keyword',
  poolCategoryLabel: 'Category',
  poolCategoryAll: 'All categories',
  poolShowLabel: 'Show',
  poolShow: { all: 'All roles', available: 'Available now', planned: 'Planned only' } as Record<PoolShow, string>,
  poolListAria: 'Role catalogue',
  poolAvailable: 'Available',
  poolPlanned: 'Planned — not runnable yet',
  poolKnowledge: { 'curated-knowledge': 'Curated knowledge', 'metadata-derived': 'Metadata-derived', none: 'No knowledge pack' } as Record<PoolKnowledge, string>,
  poolUnvalidated: 'Unvalidated',
  poolRunsAs: (name: string) => `runs as ${name}`,
  poolSelectedGroup: 'Selected (kept visible while filtering)',
  poolCount: (shown: number, total: number) => `${shown} of ${total} matching roles shown`,
  poolShowMore: (n: number) => `Show ${n} more`,
  poolNoMatch: 'No catalogue roles match these filters.',
  // 규칙 기반 팀 제안
  suggestTitle: 'Team suggestion',
  suggestBtn: 'Suggest a team from the brief',
  suggestHelp: (max: number) => `Rule-based: matches catalogue keywords in your objective, name and context, and picks up to ${plural(max, 'available role')}. It is not a model judgement or a quality score. Your selection changes only when you press Apply.`,
  suggestEmpty: 'No catalogue keyword appears in the brief, so there is no suggestion. Choose roles yourself or describe the objective in more detail.',
  suggestBriefEmpty: 'Write the objective first — the suggestion reads only the brief.',
  suggestListAria: 'Suggested roles',
  suggestMatched: (words: string) => `Matched keywords: ${words}`,
  suggestStale: 'The brief or catalogue changed after this suggestion. Suggest again to refresh it.',
  suggestApply: (n: number) => `Apply — replace selection with ${plural(n, 'role')}`,
  suggestDismiss: 'Dismiss',
  suggestApplied: (n: number) => `Selection replaced with ${plural(n, 'suggested role')}. Nothing has started.`,
  suggestCurrent: 'This is already your selection.',
  // Jev 경로 (bootstrap.configuration.routing 이 있을 때만)
  jevTitle: 'Jev selects your experts',
  jevHelp: (max: number, model: string) => `When you run, the server uses TypeSafe Jev (${model}) to assess roles, assign needed perspectives and review overlapping contributions, then starts up to ${plural(max, 'expert')}. You can see assignments and gaps. Suitability is not answer quality. The first pass is independent; optional cross-review is available after it finishes.`,
  jevDemoNote: 'Choosing the team is a real Jev call on the server even in browser demo mode; the demo run itself stays simulated, with no Daytona or Nosana calls.',
  jevRouting: 'Jev is choosing experts for this brief…',
  jevChosen: (n: number) => `Jev chose ${plural(n, 'expert')} for this brief`,
  jevListAria: 'Experts chosen by Jev',
  jevSuitability: (v: string) => `selection suitability ${v}`,
  jevStale: 'The brief changed after this choice. Jev will choose again when you run.',
  jevUnavailable: 'Jev routing is not available on the server right now, so experts cannot be chosen automatically. No rule-based team is substituted — you can choose experts manually instead.',
  jevNeedAccess: 'Jev runs on the server and needs the owner sign-in, an admin token or approved visitor access. You can still choose experts manually for a browser demo.',
  jevManualBtn: 'Choose experts manually instead',
  jevAutoBtn: 'Let Jev choose the experts',
  jevManualNote: 'Manual selection — Jev is not used for the next run.',
  nextJev: (max: number) => ` Jev chooses up to ${plural(max, 'expert')} first.`,
  routingLabel: 'Choosing experts…', routingPill: 'Routing',
  routeNone: 'Jev found no role relevant enough to this brief. Nothing was started. Describe the objective in more detail, or choose experts manually.',
  routeUnavailable: 'Jev routing is unavailable right now. Nothing was started.',
  routeConflict: 'A routing request for this brief is already in progress or conflicts with an earlier one. Wait a moment and run again.',
  routeInvalid: 'Jev returned a team this console cannot use (unknown roles, duplicates or more than the allowed number). Nothing was started.',
  routeCancelled: 'Routing stopped. Nothing was started.',
  routeNetwork: 'Could not reach the server to choose experts. Nothing was started. (Not switched to manual selection or demo.)',
  stepRouted: 'Experts chosen by Jev',
  // Jev 팀 설명 (jev-routing/v2 의 project-team/v1). 고정 코드만 이 사전으로 옮기고, 모델이 쓴 글은 근거로 보이지 않는다
  teamCoverage: (covered: number, limited: number, uncovered: number) => `Perspectives: ${covered} assigned · ${limited} excluded by limit · ${uncovered} unassigned`,
  teamGaps: (names: string) => `Not covered by this team: ${names}`,
  teamLimitedList: (names: string) => `Excluded by the expert limit: ${names}`,
  teamWarning: {
    'uncovered-perspectives': 'Some needed perspectives have no suitable role in the catalogue, so this team does not cover them.',
    'no-project-perspectives': 'No project decision perspectives were identified. Add goals, constraints or alternatives for project advice.',
    'coverage-rescue': 'A needed perspective added a specialist missed by initial screening; initial suitability scores are unchanged.',
    'actor-limit': 'The expert limit was reached, so some suitable roles were left out.',
  } as Record<HarnessWarning, string>,
  teamCovers: (names: string) => `covers ${names}`,
  teamAdditional: 'additional domain',
  teamWhy: 'Why this team',
  teamRationale: 'These are team-composition judgments. Each percentage is how well a role suits this brief — not how confident or accurate its answer will be.',
  teamNoPeer: 'No peer verification happened: every selected role runs as an independent advisor and does not see or review the work of the others.',
  teamEligible: (eligible: number, evaluated: number) => `${eligible} of ${plural(evaluated, 'evaluated role')} were eligible.`,
  teamPerspectivesTitle: 'Perspectives',
  teamPerspective: (name: string, need: string, status: string) => `${name} — need ${need}, ${status}`,
  teamStatus: { covered: 'assigned', limited: 'excluded by limit', uncovered: 'unassigned' } as Record<HarnessStatus, string>,
  teamBy: (names: string) => ` by ${names}`,
  teamExcludedTitle: 'Left out',
  teamReason: { overlap: 'overlaps with', limit: 'expert limit reached', 'below-threshold': 'below the suitability threshold' } as Record<HarnessReason, string>,
  teamPerspectiveName: {
    architecture: 'Architecture', implementation: 'Implementation', validation: 'Validation', performance: 'Performance', security: 'Security',
    privacy: 'Privacy', 'user-value': 'User value', commercial: 'Commercial', finance: 'Finance', delivery: 'Delivery', assumptions: 'Assumptions',
    decision: 'Decision', regulatory: 'Regulatory', operability: 'Operability',
  } as Record<string, string>,
  needExpert: 'Choose at least one expert to run.',
  nextDemo: 'Next run: browser demo, simulated in this tab.',
  nextLive: 'Next run: live run on server sandboxes.',
  nextLiveOwner: 'Next run: live run on server sandboxes, using your owner sign-in.',
  nextLiveVisitor: 'Next run: live run on server sandboxes, using your approved visitor session.',
  starting: 'Starting…', running: 'Running…',
  runExperts: 'Run experts', runAgain: 'Run again', runExpertsDemo: 'Run experts in demo mode', runAgainDemo: 'Run again in demo mode',
  stop: 'Stop', stopping: 'Stopping…',
  hideSetup: 'Hide project setup', editProject: 'Edit project',
  projectBrief: 'Project brief', untitled: 'Untitled project',
  startingPill: 'Starting',
  finished: (done: number, n: number) => [`${done} of ${plural(n, 'expert')}`, ' finished'],
  validOpinions: (n: number) => [String(n), ` valid ${n === 1 ? 'opinion' : 'opinions'}`],
  projectLabel: 'Project ',
  visitorLeftLabel: 'Visitor session: ',
  visitorLeft: (left: number, max: number) => `${left} of ${plural(max, 'project')} left`,
  visitorEach: (experts: number, t: string) => ` · up to ${plural(experts, 'expert')} each · ends ${t}`,
  visitorEnds: (t: string) => ` · ends ${t}`,
  checkStatusAgain: 'Check status again',
  liveBlocked: 'Live run is blocked until the server is ready and you sign in as the owner, enter an admin token, or have approved visitor access.',
  exportJson: 'Export JSON', exportReport: 'Export report', moreOptions: 'More options',
  // 결정 세부 정보 (선택, 접힌 채로 시작)
  decisionDetails: 'Decision details (optional)',
  decisionHint: (n: number) => n ? plural(n, 'item') : 'not used',
  decisionHelp: (items: number, chars: number) => `One item per line — up to ${items} lines per field, ${chars} characters each. Every selected expert receives the same details. Leave empty to skip.`,
  decisionField: {
    options: 'Options being considered', constraints: 'Constraints', successCriteria: 'Success criteria',
    knownFacts: 'Known facts', assumptions: 'Assumptions', unknowns: 'Unknowns — open questions',
  } as Record<DecisionField, string>,
  vDecisionItems: (field: string, n: number) => `${field}: use at most ${n} lines.`,
  vDecisionLong: (field: string, n: number) => `${field}: each line must be ${n} characters or fewer.`,
  // 프로젝트 근거 파일 (선택, 브라우저 메모리에만)
  docsTitle: 'Project evidence (optional)',
  docsHint: (n: number) => n ? plural(n, 'file') : 'none',
  docsHelp: (files: number, each: string, total: string) => `Add plain-text TXT, MD, CSV or JSON files — up to ${files}, ${each} characters each, ${total} in total. Review the text below and remove anything you do not want to share before you run.`,
  docsCopy: 'Each file\'s text is copied into every selected expert\'s sandbox and kept with the project and its history. Experts treat it as material you provided — not as instructions, and not as verified fact. PDFs, repositories and web links are not imported.',
  docsDemo: 'In the browser demo the text stays in this tab and appears in each simulated PROJECT.md.',
  docsPick: 'Add files',
  // ── 계획 준비 (stage·응답 언어·예산 상한 → 서버 미리보기 → 확인 후 실행) 와 PMC 원문 가져오기
  wfStage: 'Project stage (optional)', wfStageNone: 'Not stated',
  wfStageName: { unspecified: 'Not stated', discovery: 'Discovery', design: 'Design', validation: 'Validation', launch: 'Launch', operation: 'Operation' } as Record<ProjectStage, string>,
  wfLang: 'Response language (optional)', wfLangNone: 'Not stated (server default)',
  wfLangName: { ko: 'Korean', en: 'English' } as Record<ResponseLanguage, string>,
  wfLangHelp: 'The language experts write in. This is separate from the console language above.',
  budgetTitle: 'Advanced: call caps (optional)',
  budgetHint: (set: boolean): string => set ? 'custom caps' : 'server defaults',
  budgetHelp: (per: number, review: number, memo: number) => `Upper bounds only. Leave all four blank for the server default (${per} model calls per role, up to ${review} review calls and ${memo} memo call). The server checks them again.`,
  budgetField: { maxExperts: 'Max roles', maxModelCalls: 'Max model calls in total', maxReviewCalls: 'Max cross-review calls', maxMemoCalls: 'Max memo calls' } as Record<keyof ProjectBudget, string>,
  budgetFill: 'Fill server defaults', budgetClear: 'Clear caps',
  vBudget: (label: string, min: number, max: number) => `${label}: enter a whole number from ${min} to ${max}.`,
  vBudgetPartial: 'Call caps: fill all four or leave all four blank.',
  prepareLabel: 'Prepare plan', preparingLabel: 'Preparing plan…', runPlanLabel: 'Run this plan',
  planTitle: 'Prepared plan',
  planNote: 'A checked plan, not a reservation. Running it creates the project from exactly this brief, and the server checks it again.',
  planDiscard: 'Discard plan', planCancelled: 'Plan preparation stopped. Nothing was started.',
  planStale: 'The brief changed after the plan was prepared, so that plan was discarded. Prepare a new plan.',
  planRoles: (n: number) => `${plural(n, 'role')} in the team`,
  planStage: (s: string) => `Stage: ${s}`, planLang: (s: string) => `Response language: ${s}`,
  planEnvelope: 'Call envelope (upper bounds, not a forecast)',
  planSandboxes: (n: number) => `Sandboxes: up to ${n}`,
  planNosana: (n: number, e: number, r: number, mm: number) => `Nosana model calls: up to ${n} (experts ${e} · cross-review ${r} · memo ${mm})`,
  planJev: (n: number) => n ? `Jev routing calls: ${n}, separate from the Nosana budget` : 'Jev routing calls: none (team chosen by you)',
  planCaps: (b: ProjectBudget) => `Caps after the server check: ${b.maxExperts} roles · ${b.maxModelCalls} model calls · ${b.maxReviewCalls} review · ${b.maxMemoCalls} memo`,
  planNoCost: 'No price is estimated here: providers bill actual use, and these are only upper bounds.',
  planAssignments: 'Team assignments', planWarnings: 'Server notes',
  planQuestion: 'Question', planOptions: 'Options', planDeliverables: 'Deliverables', planEvidence: 'Required evidence', planBoundaries: 'Boundaries',
  planSource: { 'jev-coverage': 'Jev coverage', 'manual-scope': 'Your selection' } as Record<ExpertAssignment['source'], string>,
  planNetwork: 'Could not reach the server to prepare the plan. Nothing was started.',
  planInvalid: 'The server sent a plan this console cannot read. Nothing was started.',
  planMismatch: 'The plan does not match the routed team. Nothing was started; prepare a new plan.',
  pmcTitle: 'Import from PubMed Central (optional)',
  pmcHelp: 'Enter one PMCID (PMC1234567) or DOI. The server fetches licence-checked excerpts from the official PMC service. Nothing is added until you pick excerpts and press Add.',
  pmcLabel: 'PMCID or DOI', pmcBtn: 'Look up', pmcBusy: 'Looking up…',
  pmcBad: 'Enter a PMCID such as PMC1234567 or a DOI such as 10.1234/abcd.',
  pmcError: { invalid_identifier: 'The server did not accept this identifier.', not_found: 'No PMC article was found for this identifier.',
    identity_mismatch: 'The article PMC returned does not match this identifier.', source_unavailable: 'PMC has no reusable full text for this article.',
    rate_limited: 'PMC is limiting requests right now.', timeout: 'PMC did not answer in time.', too_large: 'The article is too large to import.',
    redirect_blocked: 'PMC answered with a redirect that is not allowed.', invalid_xml: 'PMC sent a record that could not be read.',
    upstream_error: 'PMC returned an error.' } as Record<PmcImportErrorCode, string>,
  pmcRetry: (s: number) => `Try again in ${s} s.`,
  pmcNetwork: 'Could not reach the server for the PMC lookup.',
  pmcInvalid: 'The server sent a PMC result this console cannot read. Nothing was added.',
  pmcHttp: (s: number) => `The PMC lookup failed (HTTP ${s}).`,
  pmcLicense: 'Licence', pmcRetrieved: 'Retrieved', pmcSourceLink: 'Source record',
  pmcSections: (n: number) => `Sections found: ${n}`, pmcSectionChars: (n: string) => `${n} characters`,
  pmcOmissions: 'Omissions and warnings', pmcNoOmissions: 'The server reported no omissions.',
  pmcExcerpts: 'Excerpts', pmcExcerpt: (chars: string) => `Preview excerpt (${chars} characters)`,
  pmcPick: (name: string) => `Select ${name}`,
  pmcAdd: (n: number) => n ? `Add ${plural(n, 'selected excerpt')}` : 'Select excerpts to add',
  pmcAdded: (n: number) => `${plural(n, 'excerpt')} added to the project evidence.`,
  pmcDup: (name: string) => `${name}: already in the project evidence.`,
  docBytes: (name: string, kib: number) => `${name}: adding it would make the evidence file larger than ${kib} KiB, so it was not added.`,
  docsReading: 'Reading files…',
  docsUsage: (n: number, max: number, chars: string, total: string) => `${n} of ${max} files · ${chars} of ${total} characters`,
  docsReview: (chars: string) => `Review text (${chars} characters)`,
  docsRemove: 'Remove',
  docsRemoveAria: (id: string, name: string) => `Remove ${id} ${name}`,
  docType: (name: string) => `${name}: only TXT, MD, CSV and JSON files can be added. PDF and other binary files are not imported.`,
  docBinary: (name: string) => `${name}: this file does not look like plain text, so it was not added.`,
  docLong: (name: string, n: string) => `${name}: longer than ${n} characters, so it was not added. Shorten or split it.`,
  docTotal: (name: string, n: string) => `${name}: adding it would exceed ${n} characters in total, so it was not added.`,
  docCount: (name: string, n: number) => `${name}: at most ${plural(n, 'file')} can be added, so it was not added.`,
  docEmpty: (name: string) => `${name}: the file is empty, so it was not added.`,
  docRead: (name: string) => `${name}: the file could not be read.`,
  vDocsBusy: 'Wait until the files finish loading.',
  // 근거 장부 · 교차 검토 (결과)
  evidencePanel: 'Claims and evidence',
  docsList: (n: number) => `Project documents (${n})`,
  ledgerSummary: (n: number, linked: number) => `Claim ledger — ${plural(n, 'claim')}, ${linked} linked`,
  ledgerNote: 'Linked means a cited source ID was found in this project\'s documents or in the expert\'s knowledge pack. It does not mean the claim is true, and it is not a calibrated quality score.',
  ledgerEmpty: 'The server reported no claims for this project.',
  claimStatus: { linked: 'Source ID found', unlinked: 'No source ID found' } as Record<EvidenceClaim['status'], string>,
  refDoc: (id: string, name: string) => `${id} · ${name} — show source text`,
  refDocMissing: (id: string) => `${id} — not among this project's documents`,
  refKnowledge: (id: string, available: boolean) => `Knowledge source ${id} — ${available ? 'listed in the knowledge pack (metadata only; not checked against the claim)' : 'not found in the knowledge pack'}`,
  demoNoLedger: 'Browser demo: no claim ledger or cross-review is produced. The documents stay with this simulated project in this tab.',
  reviewTitle: 'Cross-review',
  reviewExplain: 'Optional server-side second pass on Nosana: up to 3 reviewers each read up to 3 other opinions and the supplied documents. This is a partial review, with up to 3 extra model calls. It creates no sandbox and leaves original opinions unchanged. Verdicts are model judgments, not verified facts.',
  reviewBtn: 'Run cross-review', reviewRetry: 'Check or request cross-review', reviewRunning: 'Cross-review running…',
  reviewNeed: 'Cross-review needs a finished live run with at least 2 completed experts.',
  reviewServerRunning: 'The server reports a cross-review in progress.',
  reviewDone: (t: string) => `Cross-review completed at ${t}. The original opinions are unchanged.`,
  reviewFailed: (e: string) => `Cross-review failed${e ? `: ${e}` : '.'} The original opinions are unchanged. Each project gets one cross-review attempt.`,
  reviewRequestFailed: (e: string) => `Could not confirm the cross-review: ${e} Check its saved status before requesting it again.`,
  reviewNetwork: 'Could not confirm the server response. The cross-review may still be running; check its saved status.',
  reviewInvalid: 'The server returned a cross-review this console cannot read, so it is not shown.',
  reviewPollStopped: 'Stopped checking the cross-review status. Reopen the project from History to see the result.',
  reviewSaved: 'Saved cross-review (read-only).',
  reviewBy: (name: string) => `Reviewer: ${name}`,
  reviewFinding: (target: string, n: number) => `${target} · evidence ${n}`,
  verdict: { supported: 'Supported', challenged: 'Challenged', insufficient: 'Insufficient' } as Record<CrossReviewFinding['verdict'], string>,
  reviewNoFindings: 'No findings in this report.',
  // Settings: 실행 방식·세션
  settingsTitle: 'Settings',
  settingsIntro: 'Execution mode and session. The project brief and expert selection are on Home.',
  modeHeading: 'Execution mode',
  modeLocked: 'The mode is locked while a project is running.',
  tokenPlaceholder: 'Existing admin session token',
  tokenLabelOperator: 'Temporary Cloudbite operator token (Cloudbite runs only)',
  tokenLabelAdmin: 'Admin token',
  tokenHelp: 'The token stays in this tab\'s memory only and is never stored. Daytona and Nosana API keys are configured on the server, never entered here.',
  clearToken: 'Clear token',
  checkingServer: 'Checking server readiness…',
  catalogueFailed: (e: string) => `Could not load the server catalogue: ${e}`,
  checkAgain: 'Check again',
  ownerRecheck: 'Check sign-in again',
  liveNotReady: 'Live run is not ready',
  missingSettings: 'The server operator must add these settings on the server (values are never entered here):',
  notReadyGeneric: 'The server reported that live runs are not ready.',
  serverReady: (n: number) => `Server ready · up to ${plural(n, 'expert')}`,
  visitorSession: (name: string, t: string, left: number, max: number, experts: number, tokenUsed: boolean) =>
    `Visitor session for ${name || 'you'} · ends at ${t} · ${left} of ${plural(max, 'project')} left · up to ${plural(experts, 'expert')} per project${tokenUsed ? ' · the admin token is used instead while entered' : ''}`,
  ownerChecking: 'Checking owner sign-in…',
  ownerSignedIn: 'Signed in as the owner. Live runs use your owner session — no token or visitor quota needed.',
  ownerTokenWins: 'The admin token is used instead while entered.',
  ownerSignedOut: 'Owner? Sign in with your security key in the owner inbox.',
  ownerNoCredentials: 'Owner sign-in is not set up yet. Register a security key in the owner inbox.',
  ownerCheckFailed: (why: string) => `Could not check the owner sign-in: ${why}`,
  ownerRejected: `Your owner sign-in was not accepted — it may have expired or been signed out. Sign in again in the owner inbox (/cloudbite/requests). (Not switched to demo.)`,
  signOut: 'Sign out', signingOut: 'Signing out…',
  signOutFailed: (why: string) => `Could not sign out: ${why}`,
  aboutHeading: 'About this console',
  aboutText: 'Cloudbite v0.0.1 — one shared project, several expert personas, each in a separate Daytona sandbox, with inference configured on the server.',
  legacyNote: 'The legacy classroom lab is a separate product and is not part of this console.',
  legacyLink: 'Open the legacy lab',
  // 방문자 접근
  accessPending: 'Your last run failed. Run again unlocks once the server confirms its sandboxes were cleaned up — checking automatically.',
  accessUnavailable: 'Your last run failed, but the server could not confirm its cleanup yet. Select Check again in a moment.',
  accessLimit: 'Your runs failed and this visitor session has used all its retries after failed runs. Ask the host for a new session.',
  accessSpent: 'Your visitor session has no projects left. Ask the host for a new session.',
  accessWaiting: 'Your access request is still waiting for the host.',
  accessDenied: 'The host declined your access request.',
  accessRevoked: 'The host ended your visitor session.',
  accessExpired: 'Your visitor session has expired.',
  // 실행 오류 (서버가 보낸 {error} 는 뒤에 그대로 붙인다)
  operatorMalformedLink: 'The temporary Cloudbite operator link is malformed. It was removed from the address bar; ask the owner for a new link.',
  operatorMalformed: 'The temporary Cloudbite operator token is malformed. Clear it and use a new link.',
  operatorRejected: 'The temporary Cloudbite operator token was rejected or has expired. Ask the owner for a new link.',
  serverNotReady: 'The server is not ready for live runs.',
  needCredential: 'Sign in as the owner, enter the admin token in Settings, or request visitor access at /cloudbite/request.',
  visitorRejected: (path: string) => `Your visitor session was not accepted — it may have expired, been revoked or used all its projects. Request access again at ${path}. (Not switched to demo.)`,
  http401: 'Admin or project permission is missing or has expired. Check the token.',
  http404: 'The project could not be found.',
  http409: 'The same request is already being processed.',
  http413: 'The input is too long. Shorten the objective or context.',
  http429: 'Too many requests. Try again shortly.',
  http503: 'The server run configuration is not ready.',
  httpOther: (s: number) => `Server error (HTTP ${s})`,
  withServer: (base: string, server: string) => `${base} — ${server}`,
  networkCreate: 'Could not reach the server. Check the network and run again. (Not switched to demo.)',
  networkLost: 'The connection to the server was lost.',
  networkGeneric: 'Could not reach the server.',
  invalidResponse: 'The server response has an invalid format.',
  catalogueInvalid: 'The catalogue response has an invalid format',
  pollRetry: (msg: string, n: number) => `${msg} Checking again… (${n}/3)`,
  pollStopped: (msg: string) => `${msg} Stopped checking the status.`,
  stopFailed: (msg: string) => `Could not stop the project: ${msg}`,
  stopNetwork: 'Could not send the stop request. Try again.',
  fileUnexpected: 'The server returned this file in an unexpected format, so it is not shown.',
  fileNetwork: 'Could not load the file.',
  // 작업공간
  workspaceTitle: 'Expert workspace',
  workspaceSub: 'Select an expert to read its opinion, report and files.',
  fullScreen: 'Full screen', exitFullScreen: 'Exit full screen',
  clearView: 'Clear view', restoreHistory: 'Restore history',
  rosterAria: 'Experts in this project',
  activityTitle: 'Execution activity', readOnly: 'read-only',
  activityBar: 'Reported by each expert, oldest first',
  failedWith: (e: string) => ` — failed: ${e}`,
  invalidExcluded: ' — result had an invalid format and is excluded',
  failedPlain: ' — failed',
  invalidChip: 'Invalid format',
  streamState: (demo: boolean, phase: string, working: number, events: number) =>
    `${demo ? 'simulated · ' : ''}${phase} · ${working} active · ${plural(events, 'event')}`,
  phaseStopping: 'stopping',
  errorsCount: (n: number) => plural(n, 'error'),
  viewCleared: 'View cleared. New activity will appear here; the project history is unchanged.',
  noActivityYet: 'No activity reported yet.',
  hiddenRows: (n: number) => `${plural(n, 'earlier row')} hidden from this view. Restore history to show them again.`,
  latestRows: (shown: number, total: number) => `Showing the latest ${shown} of ${total} rows.`,
  tabFiles: (n: number) => `Files ${n}`, tabActivity: 'Activity', tabWorkorder: 'Work order', tabPersona: 'Persona',
  tabsAria: (name: string) => `${name} workspace`,
  noActivity: 'No activity yet.',
  workorderPreview: 'The workspace has not exported a work order yet, so this is a preview built from the brief.',
  roleMissing: 'The role definition could not be found.',
  roleNotInCatalogue: 'This role was not found in the catalogue.',
  whereDemo: (id: string) => `demo workspace ${id}`,
  whereLive: (id: string) => `sandbox ${id}`,
  wherePending: 'workspace pending',
  errorLine: (e: string) => `Error: ${e}`,
  selfAssessed: (d: string, c: number) => `${d} · self-assessed ${c}%`,
  noFiles: 'No files yet. Files appear as the expert writes them.',
  filesAria: 'Available files',
  fileContentsAria: (p: string) => `${p} contents`,
  emptyFile: '(empty file)',
  loadingFile: 'Loading file…',
  loadAgain: 'Load again',
  noContents: 'This file was reported without its contents.',
  // 오른쪽: 진행·지금 할 일·종합
  asideAria: 'Progress and decision',
  progress: 'Progress', progressDetails: 'Progress details', progressAria: 'Experts finished',
  progressNum: (done: number, n: number) => `${done} of ${n}`,
  progressTail: (status: string, working: number) => ` experts finished · ${status}${working ? ` · ${working} working` : ''}`,
  stepState: { done: 'done', active: 'active', pending: 'pending', blocked: 'blocked' } as Record<'done' | 'active' | 'pending' | 'blocked', string>,
  stepBrief: 'Brief submitted', stepWorkspaces: 'Workspaces prepared', stepWorking: 'Experts working', stepOpinions: 'Opinions submitted', stepSynth: 'Synthesis ready',
  nActive: (n: number) => `${n} active`, nValid: (n: number) => `${n} valid`, nFailed: (n: number) => `${n} failed`,
  whatNow: 'What to do now',
  tipDemoRunning: 'The simulated experts are working. Select an expert to open its files.',
  tipLiveRunning: 'Experts are working in separate sandboxes. Select an expert to read its files; the synthesis updates as valid opinions arrive.',
  tipResults: 'Results are in. Read the synthesis, check any dissent, then export a report.',
  tipNoValid: 'No valid opinions to synthesise. Check the errors shown above the experts, then edit the project and run again.',
  tipExcluded: (n: number) => `${plural(n, 'expert')} did not produce a valid opinion and ${n === 1 ? 'is' : 'are'} excluded.`,
  tipVisitorAgain: 'Your visitor session can run again. Nothing starts until you open Edit project, prepare a plan and run it.',
  tipVisitorNo: 'Your visitor session cannot start another run.',
  simulated: 'Simulated',
  synthesis: 'Synthesis', confidenceDetails: 'Confidence details',
  suggestedDecision: 'Suggested decision',
  validOf: (n: number) => ` / ${n} valid opinions`,
  countsLine: (a: { failed: number; pending: number; cancelled: number; invalid: number }) =>
    `Failed ${a.failed} · queued/working ${a.pending} · cancelled ${a.cancelled}${a.invalid ? ` · invalid format ${a.invalid}` : ''} — only completed, valid opinions are counted.`,
  nextActions: 'Suggested next actions',
  sharedBy: (n: number) => ` · shared by ${n}`,
  dissent: 'Dissent',
  noDissent: 'No point has drawn both support and concern yet.',
  noValidYet: 'No completed, valid opinions yet.',
  meanConf: (n: number) => `Mean self-assessed confidence ${n}% — not calibrated accuracy.`,
  confExplain: 'Each role reports its own confidence from 0 to 100. It is a self-assessment, not calibrated accuracy or independent agreement. Failed, pending, cancelled and invalid results are excluded.',
  confAria: (parts: string) => `Confidence distribution ${parts}`,
  announce: (status: string, valid: number, failed: number) => `${status}: ${plural(valid, 'valid opinion')}, ${failed} failed`,
  // Guide · Help
  guideTitle: 'Guide', guideIntro: 'How a Cloudbite project runs: brief, team, run, results.',
  guide: [
    ['Write the shared brief', 'On Home, start with the objective the experts should judge. Project details holds the project name and optional context. Every expert receives the same brief.'],
    ['Let Jev choose your experts', 'Enter a question and context. Jev evaluates the catalogue and selects relevant roles. You can also choose roles manually. Each selected expert has an isolated workspace, persona and work order.'],
    ['Run in demo or live mode', 'Browser demo simulates the run inside this tab. Live run asks the server to create one Daytona sandbox per expert, with inference configured on the server. Choose the mode in Settings. Nothing runs until you select the run button.'],
    ['Read each expert\'s result', 'Select an expert to read its opinion, report and other files, activity and role definition. A work order may be shown as a labelled preview. Browser-demo files are simulated.'],
    ['Check the execution activity', 'Execution activity lists what each expert reported — status changes, tool steps, notes and files. It is read-only: you cannot type commands into it. Errors are also shown above the experts.'],
    ['Review the synthesis', 'The right panel counts only completed, valid opinions. Failed, pending and cancelled experts are listed separately. Export a report or JSON when you are done.'],
  ] as Array<[string, string]>,
  backHome: 'Back to Home',
  helpTitle: 'Help', helpIntro: 'What the console shows, and what it does not claim.',
  faq: [
    ['Is the browser demo real?', 'No. The browser demo is a deterministic simulation that runs in this tab only after you start it. It creates no Daytona sandbox and makes no Nosana inference call. Its results change with the wording of your brief, but they are scripted, and its files and activity stay in English.'],
    ['What does confidence mean?', 'Each expert reports its own confidence from 0 to 100. It is a self-assessment, not calibrated accuracy or independent agreement. Failed, pending, cancelled and invalid results are excluded from the average.'],
    ['Why is Live run disabled?', 'Live run needs the server to be configured and one of: the owner signed in with a security key (owner inbox at /cloudbite/requests), an existing admin session token, or an approved, unexpired visitor session with a project left. Visitors can request access at /cloudbite/request. If the server is not ready, Settings lists the missing setting names. API keys are never entered in this console.'],
    ['How many experts can run?', 'A project can select up to 100 roles from the current catalogue. Selected experts start independently, subject to the operator concurrency setting and provider capacity. This selection limit is not a verified 100-sandbox throughput claim.'],
    ['What do Clear view and Full screen do?', 'Clear view, inside Execution activity, only empties the visible activity window; new activity keeps arriving and the project history and files stay intact. Restore history brings the hidden rows back. Full screen expands the workspace with its activity; press Escape or Exit full screen to return.'],
    ['Where is my data kept?', 'Admin and operator tokens live only in this tab\'s memory. The owner sign-in and an approved visitor session are kept by the server in HttpOnly cookies that this page cannot read. The language choice lives only in the address (?lang=). Exports are generated in the browser as downloads and state whether they come from a demo or a live run.'],
  ] as Array<[string, string]>,
};
type Messages = typeof EN;

const KO: Messages = {
  p2: P2_KO, p3: P3_KO,
  docTitle: 'Cloudbite — 전문가 샌드박스 작업공간',
  langGroup: '언어',
  langChanged: '언어: 한국어',
  direction: { support: '지지', conditional: '조건부', concern: '우려', abstain: '기권' },
  status: { queued: '대기 중', provisioning: '샌드박스 준비 중', running: '작업 중', completed: '완료', failed: '실패', cancelled: '취소됨' },
  projectStatus: { draft: '초안', running: '실행 중', completed: '완료', partial: '일부 완료', failed: '실패', cancelled: '취소됨' },
  kind: { status: '상태', thought: '메모', tool: '도구', artifact: '파일', error: '오류' },
  experts: (n) => `전문가 ${n}명`,
  projects: (n) => `프로젝트 ${n}개`,
  sampleTitle: '100명 전문가 AI 자문실 출시',
  sampleObjective: '스타트업 팀을 위한 100명 전문가 AI 자문실을 4주 안에 일부 유료 모델로 출시하는 것이 타당한지, 무엇을 주의해야 하는지 판단해 주세요.',
  sampleContext: '초기 사용자는 5–20명 규모의 스타트업 팀입니다. 모든 의견은 근거와 출처를 보여야 합니다. 팀 데이터는 업로드하지 않습니다.',
  staExample: '지식 기반 STA 전문가 예제',
  staTitle: 'PrimeTime setup / hold 검토',
  staObjective: '교육용 단일 클록 모델에서 setup과 hold slack을 설명해 주세요. setup: launch edge 0 ns, launch latency 0.20 ns, clk-to-Q 0.08 ns, data delay 0.72 ns; capture edge 1.00 ns, capture latency 0.10 ns, setup 0.07 ns, uncertainty 0.04 ns, CRPR 0. arrival·required·slack을 계산하고, 지식 자료의 출처를 인용하며, positive WNS만으로 signoff할 수 없는 이유도 설명해 주세요.',
  staContext: '교육용 사례입니다. 실제 설계 데이터와 라이선스가 필요한 PrimeTime 실행은 없습니다. 주어진 사실·가정·버전별 확인이 필요한 옵션을 구분해 주세요.',
  vTitle: '프로젝트 이름을 입력하세요.',
  vTitleLong: (n) => `프로젝트 이름은 ${n}자 이하여야 합니다.`,
  vObjective: '목표를 입력하세요.',
  vObjectiveLong: (n) => `목표는 ${n}자 이하여야 합니다.`,
  vContextLong: (n) => `맥락은 ${n}자 이하여야 합니다.`,
  vMin: (n) => `전문가를 ${n}명 이상 고르세요.`,
  vMax: (n) => `전문가는 최대 ${n}명까지 고를 수 있습니다.`,
  hNone: '아직 종합할 완료된 의견이 없습니다.',
  hTie: '의견이 팽팽하게 갈립니다 — 결정 전에 쟁점을 좁히세요.',
  hSupport: '대부분 진행에 찬성합니다 — 제안된 다음 행동으로 바로 넘어가도 됩니다.',
  hConditional: '대부분 조건을 먼저 정하고 작게 시작하라고 봅니다.',
  hConcern: '우려가 우세합니다 — 핵심 위험이 해소될 때까지 확장하지 마세요.',
  hAbstain: '기권한 전문가가 많습니다 — 정보가 더 필요합니다.',
  hPartial: (base, valid, total) => `${base} (선택한 전문가 ${total}명 중 ${valid}명 기준)`,
  mdDemo: '> 브라우저 데모 시뮬레이션입니다. 실제 Daytona 샌드박스나 Nosana 추론은 쓰지 않았습니다.',
  mdLive: '> 실제 실행 결과입니다. 확신도는 각 AI 역할의 자체 평가이며 보정된 정확도가 아닙니다.',
  mdObjective: '목표', mdContext: '맥락', mdSynthesis: '종합', mdNext: '다음 행동', mdByExpert: '전문가별 의견', none: '(없음)',
  mdStatus: (s) => `상태: ${s}`,
  mdCounts: (a) => `선택 ${a.selected} · 유효 의견 ${a.valid} · 실패 ${a.failed} · 대기/작업 중 ${a.pending} · 취소 ${a.cancelled} · 형식 오류 ${a.invalid}`,
  mdMean: (v) => `평균 자체 평가 확신도: ${v}`,
  mdOpinion: (d, c) => `${d} · 확신도 ${c}%`,
  mdError: (e) => `오류: ${e}`,
  mdInvalid: '결과 형식이 잘못되어 종합에서 제외했습니다.',
  exportDemoNote: '브라우저 시뮬레이션 — 실제 샌드박스·추론 없음',
  exportLiveNote: '확신도는 자체 평가이며 보정된 정확도가 아님',
  brandSub: '하나의 공동 프로젝트를 위한 전문가 샌드박스',
  sessionAria: '세션',
  navAria: '주 메뉴', navLabel: '작업공간',
  nav: { home: '홈', guide: '안내', help: '도움말', settings: '설정', history: '사용 기록' },
  navFoot: (roles, max) => roles ? `독립 작업공간 · 카탈로그 역할 ${roles}종 · 프로젝트당 최대 ${max}명` : `독립 작업공간 · 프로젝트당 전문가 최대 ${max}명`,
  requestAccess: '방문자 접근 요청',
  accessQr: '접근 QR',
  ownerInbox: '소유자 요청함',
  modeDemo: '브라우저 데모', modeLive: '실제 실행',
  bannerDemo: '브라우저 데모 — 활동과 파일은 시뮬레이션이며 Daytona·Nosana를 호출하지 않습니다. 직접 시작하기 전에는 아무것도 실행되지 않습니다.',
  bannerLive: '실제 실행 — 서버가 보고한 활동입니다. 확신도는 자체 평가입니다.',
  profileOperator: '운영자', profileOwner: '소유자', profileVisitor: '방문자',
  stateOperatorToken: '임시 Cloudbite 운영자 토큰이 메모리에 있음',
  stateAdminToken: '관리자 토큰이 메모리에 있음',
  stateOwner: '소유자 로그인됨',
  stateVisitor: (t) => `방문자 세션 · ${t} 종료`,
  stateNone: '관리자 토큰 없음',
  briefAria: '프로젝트 브리프',
  objectiveLabel: '목표 — 전문가들이 무엇을 판단하거나 만들어야 하나요?',
  projectDetails: '프로젝트 세부 정보',
  projectName: '프로젝트 이름',
  contextLabel: '맥락 (선택)',
  nameRequired: '이름 필요',
  chooseExperts: '전문가 고르기',
  allExpertsAria: '모든 전문가',
  allExperts: (n) => `모든 전문가 (${n})`,
  searchPlaceholder: '모든 역할 검색',
  searchAria: '모든 전문가 검색',
  changeInSettings: '설정에서 바꾸기',
  openSettings: '설정 열기',
  failSim: '전문가 한 명의 실패를 시뮬레이션',
  selCount: (n, max) => `${n}명 선택 · 최대 ${max}명`,
  alsoSelected: (names) => `모든 전문가에서 함께 선택: ${names}`,
  builtinRoles: '서버 카탈로그가 비었거나 연결되지 않아 데모는 내장 데모 역할 6개를 씁니다.',
  maxReached: (n) => `최대 ${n}명을 골랐습니다. 다른 역할을 고르려면 하나를 해제하세요.`,
  recommended: '전문가 3–5명을 권장합니다.',
  catalogueEmptyLive: '서버 카탈로그가 비어 있어 실제 실행을 할 수 없습니다.',
  noRoles: '사용할 수 있는 역할이 없습니다.',
  noMatch: '검색과 맞는 역할이 없습니다.',
  poolSummary: (n, avail) => `역할 카탈로그 보기 (${n}개 항목 · 지금 실행 가능 ${avail}개)`,
  poolNote: '번호는 계획 목록의 번호입니다. 실행 가능으로 표시된 역할만 지금 실행되며, 계획 중인 역할은 고르거나 실행할 수 없습니다. 아직 평가를 거친 역할은 없으며, 카탈로그의 규모가 전문성을 증명하지 않습니다.',
  poolSearchLabel: '카탈로그 검색',
  poolSearchPlaceholder: '역할·번호·키워드',
  poolCategoryLabel: '분야',
  poolCategoryAll: '모든 분야',
  poolShowLabel: '보기',
  poolShow: { all: '모든 역할', available: '지금 실행 가능', planned: '계획 중만' },
  poolListAria: '역할 카탈로그',
  poolAvailable: '실행 가능',
  poolPlanned: '계획 중 — 아직 실행 불가',
  poolKnowledge: { 'curated-knowledge': '정리된 지식 자료', 'metadata-derived': '메타데이터 기반', none: '지식 자료 없음' },
  poolUnvalidated: '평가 전',
  poolRunsAs: (name) => `실행 역할: ${name}`,
  poolSelectedGroup: '선택한 역할 (검색·필터와 관계없이 보임)',
  poolCount: (shown, total) => `조건에 맞는 역할 ${total}개 중 ${shown}개 표시`,
  poolShowMore: (n) => `${n}개 더 보기`,
  poolNoMatch: '이 조건에 맞는 카탈로그 역할이 없습니다.',
  suggestTitle: '팀 제안',
  suggestBtn: '브리프로 팀 제안 받기',
  suggestHelp: (max) => `규칙 기반: 목표·이름·맥락에 나오는 카탈로그 키워드를 찾아 실행 가능한 역할을 최대 ${max}명 고릅니다. 모델의 판단이나 품질 점수가 아닙니다. 적용을 누르기 전에는 선택이 바뀌지 않습니다.`,
  suggestEmpty: '브리프에 카탈로그 키워드가 없어 제안이 없습니다. 역할을 직접 고르거나 목표를 더 자세히 적어 주세요.',
  suggestBriefEmpty: '먼저 목표를 적어 주세요 — 제안은 브리프만 읽습니다.',
  suggestListAria: '제안된 역할',
  suggestMatched: (words) => `찾은 키워드: ${words}`,
  suggestStale: '이 제안 뒤에 브리프나 카탈로그가 바뀌었습니다. 다시 제안을 받아 새로 고치세요.',
  suggestApply: (n) => `적용 — 선택을 ${n}명으로 바꾸기`,
  suggestDismiss: '닫기',
  suggestApplied: (n) => `선택을 제안된 역할 ${n}명으로 바꿨습니다. 아무것도 시작하지 않았습니다.`,
  suggestCurrent: '이미 지금 선택과 같습니다.',
  jevTitle: 'Jev가 전문가를 고릅니다',
  jevHelp: (max, model) => `실행하면 서버가 TypeSafe Jev(${model})로 역할 적합도·필요한 관점·기여 중복을 검토해 최대 ${max}명의 팀을 시작합니다. 담당 관점과 빈 곳도 확인할 수 있습니다. 선택 적합도는 답변 품질이 아닙니다. 첫 의견은 독립적으로 작성하며, 완료 후 교차 검토를 선택할 수 있습니다.`,
  jevDemoNote: '브라우저 데모에서도 팀 고르기는 서버의 실제 Jev 호출입니다. 데모 실행 자체는 시뮬레이션이며 Daytona·Nosana를 호출하지 않습니다.',
  jevRouting: 'Jev가 이 브리프에 맞는 전문가를 고르는 중…',
  jevChosen: (n) => `Jev가 이 브리프에 전문가 ${n}명을 골랐습니다`,
  jevListAria: 'Jev가 고른 전문가',
  jevSuitability: (v) => `선택 적합도 ${v}`,
  jevStale: '이 선택 뒤에 브리프가 바뀌었습니다. 실행하면 Jev가 다시 고릅니다.',
  jevUnavailable: '지금 서버에서 Jev 경로를 쓸 수 없어 전문가를 자동으로 고를 수 없습니다. 규칙 기반 팀으로 대신하지 않습니다 — 대신 전문가를 직접 고를 수 있습니다.',
  jevNeedAccess: 'Jev는 서버에서 돌며 소유자 로그인, 관리자 토큰 또는 승인된 방문자 접근이 필요합니다. 브라우저 데모는 전문가를 직접 골라 실행할 수 있습니다.',
  jevManualBtn: '대신 전문가 직접 고르기',
  jevAutoBtn: 'Jev가 전문가 고르기',
  jevManualNote: '직접 선택 — 다음 실행에는 Jev를 쓰지 않습니다.',
  nextJev: (max) => ` 먼저 Jev가 전문가를 최대 ${max}명 고릅니다.`,
  routingLabel: '전문가를 고르는 중…', routingPill: '전문가 고르는 중',
  routeNone: 'Jev가 이 브리프에 충분히 맞는 역할을 찾지 못했습니다. 아무것도 시작하지 않았습니다. 목표를 더 자세히 적거나 전문가를 직접 고르세요.',
  routeUnavailable: '지금 Jev 경로를 쓸 수 없습니다. 아무것도 시작하지 않았습니다.',
  routeConflict: '이 브리프의 경로 요청이 이미 처리 중이거나 이전 요청과 충돌합니다. 잠시 뒤 다시 실행하세요.',
  routeInvalid: 'Jev가 이 콘솔에서 쓸 수 없는 팀을 돌려주었습니다 (모르는 역할, 중복 또는 허용 인원 초과). 아무것도 시작하지 않았습니다.',
  routeCancelled: '전문가 고르기를 멈췄습니다. 아무것도 시작하지 않았습니다.',
  routeNetwork: '전문가를 고르려고 서버에 연결하지 못했습니다. 아무것도 시작하지 않았습니다. (직접 선택이나 데모로 바꾸지 않았습니다.)',
  stepRouted: 'Jev가 전문가 선택',
  teamCoverage: (covered, limited, uncovered) => `관점: 담당 배정 ${covered} · 한도로 제외 ${limited} · 미배정 ${uncovered}`,
  teamGaps: (names) => `이 팀이 다루지 못하는 관점: ${names}`,
  teamLimitedList: (names) => `전문가 한도로 제외된 관점: ${names}`,
  teamWarning: {
    'uncovered-perspectives': '필요한 관점 가운데 카탈로그에 맞는 역할이 없는 것이 있어, 이 팀은 그 관점을 다루지 않습니다.',
    'no-project-perspectives': '프로젝트 판단 관점이 확인되지 않았습니다. 목표·제약·선택지를 보완하면 프로젝트 자문에 도움이 됩니다.',
    'actor-limit': '전문가 인원 한도에 닿아 맞는 역할 일부를 뺐습니다.',
    'coverage-rescue': '초기 선별에서 빠진 전문가를 필요한 관점의 담당자로 추가했습니다. 초기 적합도 수치는 그대로 표시합니다.',
  },
  teamCovers: (names) => `담당: ${names}`,
  teamAdditional: '추가 분야',
  teamWhy: '이 팀을 고른 이유',
  teamRationale: '팀 구성에 대한 판단입니다. 각 백분율은 역할이 이 브리프에 얼마나 맞는지이며, 그 역할 답변의 확신도나 정확도가 아닙니다.',
  teamNoPeer: '서로 검증하지 않았습니다: 고른 역할은 모두 독립 자문으로 실행되며 다른 역할의 결과를 보거나 검토하지 않습니다.',
  teamEligible: (eligible, evaluated) => `평가한 역할 ${evaluated}명 가운데 ${eligible}명이 후보였습니다.`,
  teamPerspectivesTitle: '관점',
  teamPerspective: (name, need, status) => `${name} — 필요도 ${need}, ${status}`,
  teamStatus: { covered: '담당 배정', limited: '한도로 제외', uncovered: '미배정' },
  teamBy: (names) => ` · ${names}`,
  teamExcludedTitle: '뺀 역할',
  teamReason: { overlap: '역할이 겹침:', limit: '인원 한도', 'below-threshold': '적합도 기준 미달' },
  teamPerspectiveName: {
    architecture: '아키텍처', implementation: '구현', validation: '검증', performance: '성능', security: '보안',
    privacy: '개인정보', 'user-value': '사용자 가치', commercial: '사업성', finance: '재무', delivery: '일정·전달', assumptions: '가정',
    decision: '의사결정', regulatory: '규제', operability: '운영성',
  },
  needExpert:'실행하려면 전문가를 한 명 이상 고르세요.',
  nextDemo: '다음 실행: 브라우저 데모, 이 탭 안에서 시뮬레이션합니다.',
  nextLive: '다음 실행: 서버 샌드박스에서 실제 실행합니다.',
  nextLiveOwner: '다음 실행: 소유자 로그인으로 서버 샌드박스에서 실제 실행합니다.',
  nextLiveVisitor: '다음 실행: 승인된 방문자 세션으로 서버 샌드박스에서 실제 실행합니다.',
  starting: '시작하는 중…', running: '실행 중…',
  runExperts: '전문가 실행', runAgain: '다시 실행', runExpertsDemo: '데모 모드로 전문가 실행', runAgainDemo: '데모 모드로 다시 실행',
  stop: '중지', stopping: '중지하는 중…',
  hideSetup: '프로젝트 설정 숨기기', editProject: '프로젝트 편집',
  projectBrief: '프로젝트 브리프', untitled: '이름 없는 프로젝트',
  startingPill: '시작 중',
  finished: (done, n) => [`전문가 ${n}명 중 ${done}명`, ' 완료'],
  validOpinions: (n) => [String(n), '개 유효 의견'],
  projectLabel: '프로젝트 ',
  visitorLeftLabel: '방문자 세션: ',
  visitorLeft: (left, max) => `프로젝트 ${max}개 중 ${left}개 남음`,
  visitorEach: (experts, t) => ` · 프로젝트당 전문가 최대 ${experts}명 · ${t} 종료`,
  visitorEnds: (t) => ` · ${t} 종료`,
  checkStatusAgain: '상태 다시 확인',
  liveBlocked: '서버가 준비되고, 소유자로 로그인하거나 관리자 토큰을 넣거나 방문자 접근이 승인될 때까지 실제 실행은 막혀 있습니다.',
  exportJson: 'JSON 내보내기', exportReport: '보고서 내보내기', moreOptions: '추가 옵션',
  decisionDetails: '결정 세부 정보 (선택)',
  decisionHint: (n) => n ? `${n}개 항목` : '사용 안 함',
  decisionHelp: (items, chars) => `한 줄에 한 항목 — 칸마다 최대 ${items}줄, 줄마다 ${chars}자까지 씁니다. 고른 전문가 모두가 같은 내용을 받습니다. 비워 두면 쓰지 않습니다.`,
  decisionField: {
    options: '검토 중인 선택지', constraints: '제약 조건', successCriteria: '성공 기준',
    knownFacts: '알려진 사실', assumptions: '가정', unknowns: '모르는 점 — 열린 질문',
  },
  vDecisionItems: (field, n) => `${field}: 최대 ${n}줄까지 쓸 수 있습니다.`,
  vDecisionLong: (field, n) => `${field}: 줄마다 ${n}자 이하여야 합니다.`,
  docsTitle: '프로젝트 근거 자료 (선택)',
  docsHint: (n) => n ? `파일 ${n}개` : '없음',
  docsHelp: (files, each, total) => `글자로 된 TXT·MD·CSV·JSON 파일을 최대 ${files}개, 파일마다 ${each}자, 합계 ${total}자까지 추가합니다. 실행 전에 아래에서 내용을 확인하고 공유하지 않을 파일은 빼세요.`,
  docsCopy: '파일 내용은 고른 전문가 각자의 샌드박스에 복사되고 프로젝트·사용 기록과 함께 보관됩니다. 전문가는 이를 사용자가 준 자료로 다루며, 지시나 검증된 사실로 보지 않습니다. PDF·저장소·웹 링크는 가져오지 않습니다.',
  docsDemo: '브라우저 데모에서는 내용이 이 탭에만 남고, 시뮬레이션된 PROJECT.md 에 들어갑니다.',
  docsPick: '파일 추가',
  wfStage: '프로젝트 단계 (선택)', wfStageNone: '밝히지 않음',
  wfStageName: { unspecified: '밝히지 않음', discovery: '탐색', design: '설계', validation: '검증', launch: '출시', operation: '운영' },
  wfLang: '응답 언어 (선택)', wfLangNone: '밝히지 않음 (서버 기본값)',
  wfLangName: { ko: '한국어', en: '영어' },
  wfLangHelp: '전문가가 답을 쓰는 언어입니다. 위의 화면 언어와는 따로 정합니다.',
  budgetTitle: '고급: 호출 상한 (선택)',
  budgetHint: (set) => set ? '직접 정한 상한' : '서버 기본값',
  budgetHelp: (per, review, memo) => `상한일 뿐입니다. 넷 다 비우면 서버 기본값(역할마다 모델 호출 ${per}번, 교차 검토 최대 ${review}번, 메모 ${memo}번)을 씁니다. 서버가 다시 확인합니다.`,
  budgetField: { maxExperts: '최대 역할 수', maxModelCalls: '전체 모델 호출 상한', maxReviewCalls: '교차 검토 호출 상한', maxMemoCalls: '메모 호출 상한' },
  budgetFill: '서버 기본값 채우기', budgetClear: '상한 비우기',
  vBudget: (label, min, max) => `${label}: ${min}–${max} 사이의 정수를 넣어 주세요.`,
  vBudgetPartial: '호출 상한: 넷 다 채우거나 넷 다 비워 주세요.',
  prepareLabel: '계획 준비', preparingLabel: '계획을 준비하는 중…', runPlanLabel: '이 계획으로 실행',
  planTitle: '준비된 계획',
  planNote: '확인된 계획일 뿐 예약이 아닙니다. 실행하면 정확히 이 브리프로 프로젝트를 만들고, 서버가 다시 확인합니다.',
  planDiscard: '계획 버리기', planCancelled: '계획 준비를 멈췄습니다. 아무것도 시작하지 않았습니다.',
  planStale: '계획을 준비한 뒤 브리프가 바뀌어 그 계획을 버렸습니다. 새 계획을 준비해 주세요.',
  planRoles: (n) => `팀 역할 ${n}개`,
  planStage: (s) => `단계: ${s}`, planLang: (s) => `응답 언어: ${s}`,
  planEnvelope: '호출 범위 (상한이며 예측이 아님)',
  planSandboxes: (n) => `샌드박스: 최대 ${n}개`,
  planNosana: (n, e, r, mm) => `Nosana 모델 호출: 최대 ${n}번 (전문가 ${e} · 교차 검토 ${r} · 메모 ${mm})`,
  planJev: (n) => n ? `Jev 경로 호출: ${n}번, Nosana 예산과 별도` : 'Jev 경로 호출: 없음 (직접 고른 팀)',
  planCaps: (b) => `서버 확인 뒤 상한: 역할 ${b.maxExperts} · 모델 호출 ${b.maxModelCalls} · 검토 ${b.maxReviewCalls} · 메모 ${b.maxMemoCalls}`,
  planNoCost: '여기서는 비용을 추정하지 않습니다. 공급자는 실제 사용량으로 청구하며, 위 숫자는 상한일 뿐입니다.',
  planAssignments: '팀 배정', planWarnings: '서버 안내',
  planQuestion: '질문', planOptions: '선택지', planDeliverables: '산출물', planEvidence: '필요한 근거', planBoundaries: '경계',
  planSource: { 'jev-coverage': 'Jev 관점 배정', 'manual-scope': '직접 고른 역할' },
  planNetwork: '계획을 준비하려고 서버에 연결하지 못했습니다. 아무것도 시작하지 않았습니다.',
  planInvalid: '서버가 이 콘솔이 읽을 수 없는 계획을 보냈습니다. 아무것도 시작하지 않았습니다.',
  planMismatch: '계획이 고른 팀과 맞지 않습니다. 아무것도 시작하지 않았습니다. 새 계획을 준비해 주세요.',
  pmcTitle: 'PubMed Central 에서 가져오기 (선택)',
  pmcHelp: 'PMCID(PMC1234567) 또는 DOI 하나를 넣으세요. 서버가 공식 PMC 서비스에서 이용 허락을 확인한 발췌를 가져옵니다. 발췌를 고르고 추가를 누르기 전에는 아무것도 넣지 않습니다.',
  pmcLabel: 'PMCID 또는 DOI', pmcBtn: '찾기', pmcBusy: '찾는 중…',
  pmcBad: 'PMC1234567 같은 PMCID 나 10.1234/abcd 같은 DOI 를 넣어 주세요.',
  pmcError: { invalid_identifier: '서버가 이 식별자를 받지 않았습니다.', not_found: '이 식별자에 맞는 PMC 논문이 없습니다.',
    identity_mismatch: 'PMC 가 돌려준 논문이 이 식별자와 맞지 않습니다.', source_unavailable: '이 논문은 PMC 에 재사용 가능한 본문이 없습니다.',
    rate_limited: 'PMC 가 지금 요청을 제한하고 있습니다.', timeout: 'PMC 가 제때 답하지 않았습니다.', too_large: '논문이 너무 커서 가져올 수 없습니다.',
    redirect_blocked: 'PMC 가 허용되지 않은 곳으로 넘기려 했습니다.', invalid_xml: 'PMC 가 보낸 기록을 읽을 수 없습니다.',
    upstream_error: 'PMC 가 오류를 돌려주었습니다.' },
  pmcRetry: (s) => `${s}초 뒤에 다시 시도해 주세요.`,
  pmcNetwork: 'PMC 를 찾으려고 서버에 연결하지 못했습니다.',
  pmcInvalid: '서버가 이 콘솔이 읽을 수 없는 PMC 결과를 보냈습니다. 아무것도 추가하지 않았습니다.',
  pmcHttp: (s) => `PMC 찾기에 실패했습니다 (HTTP ${s}).`,
  pmcLicense: '이용 허락', pmcRetrieved: '가져온 시각', pmcSourceLink: '원본 기록',
  pmcSections: (n) => `찾은 절: ${n}개`, pmcSectionChars: (n) => `${n}자`,
  pmcOmissions: '빠진 부분과 경고', pmcNoOmissions: '서버가 빠진 부분이 없다고 알렸습니다.',
  pmcExcerpts: '발췌', pmcExcerpt: (chars) => `발췌 미리 보기 (${chars}자)`,
  pmcPick: (name) => `${name} 고르기`,
  pmcAdd: (n) => n ? `고른 발췌 ${n}개 추가` : '추가할 발췌를 고르세요',
  pmcAdded: (n) => `발췌 ${n}개를 프로젝트 근거에 추가했습니다.`,
  pmcDup: (name) => `${name}: 이미 프로젝트 근거에 있습니다.`,
  docBytes: (name, kib) => `${name}: 추가하면 근거 파일이 ${kib} KiB 를 넘어 추가하지 않았습니다.`,
  docsReading: '파일을 읽는 중…',
  docsUsage: (n, max, chars, total) => `파일 ${max}개 중 ${n}개 · ${total}자 중 ${chars}자`,
  docsReview: (chars) => `내용 확인 (${chars}자)`,
  docsRemove: '빼기',
  docsRemoveAria: (id, name) => `${id} ${name} 빼기`,
  docType: (name) => `${name}: TXT·MD·CSV·JSON 파일만 추가할 수 있습니다. PDF 등 바이너리 파일은 가져오지 않습니다.`,
  docBinary: (name) => `${name}: 일반 글자 파일이 아닌 것 같아 추가하지 않았습니다.`,
  docLong: (name, n) => `${name}: ${n}자를 넘어 추가하지 않았습니다. 줄이거나 나누어 주세요.`,
  docTotal: (name, n) => `${name}: 추가하면 합계 ${n}자를 넘어 추가하지 않았습니다.`,
  docCount: (name, n) => `${name}: 파일은 최대 ${n}개까지 추가할 수 있어 추가하지 않았습니다.`,
  docEmpty: (name) => `${name}: 빈 파일이라 추가하지 않았습니다.`,
  docRead: (name) => `${name}: 파일을 읽지 못했습니다.`,
  vDocsBusy: '파일을 다 읽을 때까지 기다려 주세요.',
  evidencePanel: '주장과 근거',
  docsList: (n) => `프로젝트 자료 (${n})`,
  ledgerSummary: (n, linked) => `주장 장부 — 주장 ${n}개, 연결 ${linked}개`,
  ledgerNote: '연결됨은 인용한 출처 ID가 이 프로젝트의 자료나 전문가의 지식 자료에서 발견됐다는 뜻입니다. 주장이 사실이라는 뜻이 아니며, 보정된 품질 점수도 아닙니다.',
  ledgerEmpty: '서버가 이 프로젝트에서 보고한 주장이 없습니다.',
  claimStatus: { linked: '출처 ID 발견', unlinked: '출처 ID 없음' },
  refDoc: (id, name) => `${id} · ${name} — 원문 보기`,
  refDocMissing: (id) => `${id} — 이 프로젝트의 자료에 없음`,
  refKnowledge: (id, available) => `지식 출처 ${id} — ${available ? '지식 자료 목록에 있음 (메타데이터만, 주장과 대조하지 않음)' : '지식 자료에서 찾지 못함'}`,
  demoNoLedger: '브라우저 데모: 주장 장부와 교차 검토를 만들지 않습니다. 자료는 이 탭의 시뮬레이션 프로젝트에만 남습니다.',
  reviewTitle: '교차 검토',
  reviewExplain: 'Nosana를 통한 선택적 2차 검토입니다. 검토자 최대 3명이 각각 다른 의견 최대 3개와 제공된 자료를 읽습니다. 전체가 아닌 부분 검토이며 모델을 최대 3번 더 호출합니다. 샌드박스를 추가하지 않고 원래 의견을 보존합니다. 판정은 모델의 판단이며 검증된 사실이 아닙니다.',
  reviewBtn: '교차 검토 실행', reviewRetry: '교차 검토 확인·요청', reviewRunning: '교차 검토 중…',
  reviewNeed: '교차 검토는 완료된 전문가가 2명 이상인, 끝난 실제 실행에서만 할 수 있습니다.',
  reviewServerRunning: '서버가 교차 검토를 진행 중이라고 알렸습니다.',
  reviewDone: (t) => `${t}에 교차 검토를 마쳤습니다. 원래 의견은 그대로입니다.`,
  reviewFailed: (e) => `교차 검토가 실패했습니다${e ? `: ${e}` : '.'} 원래 의견은 그대로입니다. 교차 검토는 프로젝트마다 한 번만 시도합니다.`,
  reviewRequestFailed: (e) => `교차 검토 응답을 확인하지 못했습니다: ${e} 다시 요청하기 전에 저장된 상태를 확인하세요.`,
  reviewNetwork: '서버 응답을 확인하지 못했습니다. 교차 검토가 계속 실행 중일 수 있으니 저장된 상태를 확인하세요.',
  reviewInvalid: '서버가 이 콘솔에서 읽을 수 없는 교차 검토를 보내 보여 주지 않습니다.',
  reviewPollStopped: '교차 검토 상태 확인을 멈췄습니다. 사용 기록에서 프로젝트를 다시 열어 결과를 보세요.',
  reviewSaved: '저장된 교차 검토 (읽기 전용)',
  reviewBy: (name) => `검토자: ${name}`,
  reviewFinding: (target, n) => `${target} · 근거 ${n}`,
  verdict: { supported: '뒷받침됨', challenged: '이의 있음', insufficient: '근거 부족' },
  reviewNoFindings: '이 보고서에는 판정 항목이 없습니다.',
  settingsTitle: '설정',
  settingsIntro: '실행 방식과 세션입니다. 프로젝트 브리프와 전문가 선택은 홈에 있습니다.',
  modeHeading: '실행 방식',
  modeLocked: '프로젝트가 실행되는 동안에는 실행 방식을 바꿀 수 없습니다.',
  tokenPlaceholder: '기존 관리자 세션 토큰',
  tokenLabelOperator: '임시 Cloudbite 운영자 토큰 (Cloudbite 실행 전용)',
  tokenLabelAdmin: '관리자 토큰',
  tokenHelp: '토큰은 이 탭의 메모리에만 있고 저장되지 않습니다. Daytona·Nosana API 키는 서버에 설정하며 여기에 입력하지 않습니다.',
  clearToken: '토큰 지우기',
  checkingServer: '서버 준비 상태를 확인하는 중…',
  catalogueFailed: (e) => `서버 카탈로그를 불러오지 못했습니다: ${e}`,
  checkAgain: '다시 확인',
  ownerRecheck: '로그인 상태 다시 확인',
  liveNotReady: '실제 실행이 준비되지 않았습니다',
  missingSettings: '서버 운영자가 서버에 다음 설정을 추가해야 합니다 (값은 여기에 입력하지 않습니다):',
  notReadyGeneric: '서버가 실제 실행이 준비되지 않았다고 알렸습니다.',
  serverReady: (n) => `서버 준비됨 · 전문가 최대 ${n}명`,
  visitorSession: (name, t, left, max, experts, tokenUsed) =>
    `${name || '나'}의 방문자 세션 · ${t} 종료 · 프로젝트 ${max}개 중 ${left}개 남음 · 프로젝트당 전문가 최대 ${experts}명${tokenUsed ? ' · 관리자 토큰을 넣은 동안에는 토큰을 대신 씁니다' : ''}`,
  ownerChecking: '소유자 로그인을 확인하는 중…',
  ownerSignedIn: '소유자로 로그인되어 있습니다. 실제 실행은 소유자 세션을 쓰며 토큰이나 방문자 한도가 필요 없습니다.',
  ownerTokenWins: '관리자 토큰을 넣은 동안에는 토큰을 대신 씁니다.',
  ownerSignedOut: '소유자인가요? 소유자 요청함에서 보안 키로 로그인하세요.',
  ownerNoCredentials: '소유자 로그인이 아직 설정되지 않았습니다. 소유자 요청함에서 보안 키를 등록하세요.',
  ownerCheckFailed: (why) => `소유자 로그인 상태를 확인하지 못했습니다: ${why}`,
  ownerRejected: '소유자 로그인이 받아들여지지 않았습니다 — 만료되었거나 로그아웃되었을 수 있습니다. 소유자 요청함(/cloudbite/requests)에서 다시 로그인하세요. (데모로 바꾸지 않았습니다.)',
  signOut: '로그아웃', signingOut: '로그아웃하는 중…',
  signOutFailed: (why) => `로그아웃하지 못했습니다: ${why}`,
  aboutHeading: '이 콘솔에 대해',
  aboutText: 'Cloudbite v0.0.1 — 하나의 공동 프로젝트, 여러 전문가 페르소나, 각자 분리된 Daytona 샌드박스, 서버에 설정된 추론.',
  legacyNote: '기존 교실 실습실은 별개 제품이며 이 콘솔에 포함되지 않습니다.',
  legacyLink: '기존 실습실 열기',
  accessPending: '마지막 실행이 실패했습니다. 서버가 샌드박스 정리를 확인하면 다시 실행할 수 있습니다 — 자동으로 확인하는 중입니다.',
  accessUnavailable: '마지막 실행이 실패했지만 서버가 아직 정리를 확인하지 못했습니다. 잠시 뒤 다시 확인을 누르세요.',
  accessLimit: '실행이 실패했고 이 방문자 세션은 실패 뒤 재시도를 모두 썼습니다. 호스트에게 새 세션을 요청하세요.',
  accessSpent: '방문자 세션에 남은 프로젝트가 없습니다. 호스트에게 새 세션을 요청하세요.',
  accessWaiting: '접근 요청이 아직 호스트의 승인을 기다리고 있습니다.',
  accessDenied: '호스트가 접근 요청을 거절했습니다.',
  accessRevoked: '호스트가 방문자 세션을 종료했습니다.',
  accessExpired: '방문자 세션이 만료되었습니다.',
  operatorMalformedLink: '임시 Cloudbite 운영자 링크의 형식이 잘못되었습니다. 주소창에서 지웠으니 소유자에게 새 링크를 요청하세요.',
  operatorMalformed: '임시 Cloudbite 운영자 토큰의 형식이 잘못되었습니다. 토큰을 지우고 새 링크를 쓰세요.',
  operatorRejected: '임시 Cloudbite 운영자 토큰이 거부되었거나 만료되었습니다. 소유자에게 새 링크를 요청하세요.',
  serverNotReady: '서버가 실제 실행을 할 준비가 되지 않았습니다.',
  needCredential: '소유자로 로그인하거나, 설정에 관리자 토큰을 넣거나, /cloudbite/request 에서 방문자 접근을 요청하세요.',
  visitorRejected: (path) => `방문자 세션이 받아들여지지 않았습니다 — 만료·취소되었거나 프로젝트를 모두 썼을 수 있습니다. ${path} 에서 다시 접근을 요청하세요. (데모로 바꾸지 않았습니다.)`,
  http401: '관리자 또는 프로젝트 권한이 없거나 만료되었습니다. 토큰을 확인하세요.',
  http404: '프로젝트를 찾을 수 없습니다.',
  http409: '같은 요청을 이미 처리하고 있습니다.',
  http413: '입력이 너무 깁니다. 목표나 맥락을 줄이세요.',
  http429: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  http503: '서버 실행 설정이 준비되지 않았습니다.',
  httpOther: (s) => `서버 오류 (HTTP ${s})`,
  withServer: (base, server) => `${base} — ${server}`,
  networkCreate: '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 실행하세요. (데모로 바꾸지 않았습니다.)',
  networkLost: '서버와의 연결이 끊겼습니다.',
  networkGeneric: '서버에 연결하지 못했습니다.',
  invalidResponse: '서버 응답 형식이 잘못되었습니다.',
  catalogueInvalid: '카탈로그 응답 형식이 잘못되었습니다',
  pollRetry: (msg, n) => `${msg} 다시 확인하는 중… (${n}/3)`,
  pollStopped: (msg) => `${msg} 상태 확인을 멈췄습니다.`,
  stopFailed: (msg) => `프로젝트를 중지하지 못했습니다: ${msg}`,
  stopNetwork: '중지 요청을 보내지 못했습니다. 다시 시도하세요.',
  fileUnexpected: '서버가 이 파일을 예상하지 못한 형식으로 보내 보여 주지 않습니다.',
  fileNetwork: '파일을 불러오지 못했습니다.',
  workspaceTitle: '전문가 작업공간',
  workspaceSub: '전문가를 골라 의견·보고서·파일을 읽으세요.',
  fullScreen: '전체 화면', exitFullScreen: '전체 화면 끝내기',
  clearView: '화면 비우기', restoreHistory: '기록 되돌리기',
  rosterAria: '이 프로젝트의 전문가',
  activityTitle: '실행 기록', readOnly: '읽기 전용',
  activityBar: '각 전문가가 보고한 내용, 오래된 순',
  failedWith: (e) => ` — 실패: ${e}`,
  invalidExcluded: ' — 결과 형식이 잘못되어 제외됨',
  failedPlain: ' — 실패',
  invalidChip: '형식 오류',
  streamState: (demo, phase, working, events) => `${demo ? '시뮬레이션 · ' : ''}${phase} · ${working}명 작업 중 · 이벤트 ${events}개`,
  phaseStopping: '중지하는 중',
  errorsCount: (n) => `오류 ${n}개`,
  viewCleared: '화면을 비웠습니다. 새 활동은 여기에 나타나며 프로젝트 기록은 그대로입니다.',
  noActivityYet: '아직 보고된 활동이 없습니다.',
  hiddenRows: (n) => `이전 줄 ${n}개를 이 화면에서 숨겼습니다. 기록 되돌리기로 다시 볼 수 있습니다.`,
  latestRows: (shown, total) => `${total}줄 중 최근 ${shown}줄을 보여 줍니다.`,
  tabFiles: (n) => `파일 ${n}`, tabActivity: '활동', tabWorkorder: '작업 지시서', tabPersona: '페르소나',
  tabsAria: (name) => `${name} 작업공간`,
  noActivity: '아직 활동이 없습니다.',
  workorderPreview: '작업공간이 아직 작업 지시서를 내보내지 않아 브리프로 만든 미리보기입니다.',
  roleMissing: '역할 정의를 찾을 수 없습니다.',
  roleNotInCatalogue: '카탈로그에서 이 역할을 찾지 못했습니다.',
  whereDemo: (id) => `데모 작업공간 ${id}`,
  whereLive: (id) => `샌드박스 ${id}`,
  wherePending: '작업공간 준비 전',
  errorLine: (e) => `오류: ${e}`,
  selfAssessed: (d, c) => `${d} · 자체 평가 ${c}%`,
  noFiles: '아직 파일이 없습니다. 전문가가 파일을 쓰면 나타납니다.',
  filesAria: '볼 수 있는 파일',
  fileContentsAria: (p) => `${p} 내용`,
  emptyFile: '(빈 파일)',
  loadingFile: '파일을 불러오는 중…',
  loadAgain: '다시 불러오기',
  noContents: '이 파일은 내용 없이 보고되었습니다.',
  asideAria: '진행과 결정',
  progress: '진행', progressDetails: '진행 세부 정보', progressAria: '완료한 전문가',
  progressNum: (done, n) => `${n}명 중 ${done}명`,
  progressTail: (status, working) => ` 완료 · ${status}${working ? ` · ${working}명 작업 중` : ''}`,
  stepState: { done: '완료', active: '진행 중', pending: '대기', blocked: '막힘' },
  stepBrief: '브리프 제출', stepWorkspaces: '작업공간 준비', stepWorking: '전문가 작업', stepOpinions: '의견 제출', stepSynth: '종합 준비',
  nActive: (n) => `${n}명 작업 중`, nValid: (n) => `유효 ${n}`, nFailed: (n) => `실패 ${n}`,
  whatNow: '지금 할 일',
  tipDemoRunning: '시뮬레이션 전문가들이 작업 중입니다. 전문가를 골라 파일을 여세요.',
  tipLiveRunning: '전문가들이 각자의 샌드박스에서 작업 중입니다. 전문가를 골라 파일을 읽으세요. 유효한 의견이 들어오면 종합이 갱신됩니다.',
  tipResults: '결과가 나왔습니다. 종합을 읽고 이견을 확인한 뒤 보고서를 내보내세요.',
  tipNoValid: '종합할 유효한 의견이 없습니다. 전문가 위에 보이는 오류를 확인한 뒤 프로젝트를 고쳐 다시 실행하세요.',
  tipExcluded: (n) => `전문가 ${n}명이 유효한 의견을 내지 못해 제외되었습니다.`,
  tipVisitorAgain: '방문자 세션으로 다시 실행할 수 있습니다. 프로젝트 편집을 열고 계획을 준비해 실행하기 전에는 아무것도 시작되지 않습니다.',
  tipVisitorNo: '방문자 세션으로 더 실행할 수 없습니다.',
  simulated: '시뮬레이션',
  synthesis: '종합', confidenceDetails: '확신도 세부 정보',
  suggestedDecision: '제안 결정',
  validOf: (n) => ` / ${n} 유효 의견`,
  countsLine: (a) => `실패 ${a.failed} · 대기/작업 중 ${a.pending} · 취소 ${a.cancelled}${a.invalid ? ` · 형식 오류 ${a.invalid}` : ''} — 완료된 유효 의견만 셉니다.`,
  nextActions: '제안 다음 행동',
  sharedBy: (n) => ` · ${n}명 공통`,
  dissent: '이견',
  noDissent: '아직 지지와 우려가 함께 나온 쟁점이 없습니다.',
  noValidYet: '아직 완료된 유효 의견이 없습니다.',
  meanConf: (n) => `평균 자체 평가 확신도 ${n}% — 보정된 정확도가 아닙니다.`,
  confExplain: '각 역할이 0–100 사이의 확신도를 스스로 보고합니다. 자체 평가이며 보정된 정확도나 독립적인 합의가 아닙니다. 실패·대기·취소·형식 오류 결과는 제외합니다.',
  confAria: (parts) => `확신도 분포 ${parts}`,
  announce: (status, valid, failed) => `${status}: 유효 의견 ${valid}개, 실패 ${failed}개`,
  guideTitle: '안내', guideIntro: 'Cloudbite 프로젝트 진행 순서: 브리프, 팀, 실행, 결과.',
  guide: [
    ['공동 브리프 쓰기', '홈에서 전문가들이 판단할 목표부터 씁니다. 프로젝트 세부 정보에는 프로젝트 이름과 선택 맥락이 있습니다. 모든 전문가가 같은 브리프를 받습니다.'],
    ['Jev가 전문가를 고릅니다', '질문과 맥락을 입력하면 Jev가 카탈로그에서 관련 역할을 고릅니다. 직접 고르기도 가능합니다. 선택된 전문가는 각자의 페르소나와 작업 지시서를 가지고 독립 작업공간에서 일합니다.'],
    ['데모 또는 실제 실행', '브라우저 데모는 이 탭 안에서 실행을 시뮬레이션합니다. 실제 실행은 서버에 전문가마다 Daytona 샌드박스 하나를 만들게 하고, 추론은 서버에 설정되어 있습니다. 실행 방식은 설정에서 고릅니다. 실행 버튼을 누르기 전에는 아무것도 실행되지 않습니다.'],
    ['전문가별 결과 읽기', '전문가를 골라 의견, 보고서와 다른 파일, 활동, 역할 정의를 읽습니다. 작업 지시서는 표시된 미리보기로 보일 수 있습니다. 브라우저 데모 파일은 시뮬레이션입니다.'],
    ['실행 기록 확인', '실행 기록은 각 전문가가 보고한 상태 변화, 도구 단계, 메모, 파일을 보여 줍니다. 읽기 전용이라 명령을 입력할 수 없습니다. 오류는 전문가 목록 위에도 보입니다.'],
    ['종합 검토', '오른쪽 패널은 완료된 유효 의견만 셉니다. 실패·대기·취소된 전문가는 따로 표시합니다. 끝나면 보고서나 JSON을 내보내세요.'],
  ],
  backHome: '홈으로 돌아가기',
  helpTitle: '도움말', helpIntro: '콘솔이 보여 주는 것과 주장하지 않는 것.',
  faq: [
    ['브라우저 데모는 진짜인가요?', '아닙니다. 브라우저 데모는 시작한 뒤에만 이 탭 안에서 도는 결정적 시뮬레이션입니다. Daytona 샌드박스를 만들지 않고 Nosana 추론도 호출하지 않습니다. 결과는 브리프 문구에 따라 바뀌지만 정해진 각본이며, 파일과 활동은 영어로 남습니다.'],
    ['확신도는 무슨 뜻인가요?', '각 전문가가 0–100 사이의 확신도를 스스로 보고합니다. 자체 평가이며 보정된 정확도나 독립적인 합의가 아닙니다. 실패·대기·취소·형식 오류 결과는 평균에서 제외합니다.'],
    ['실제 실행이 왜 꺼져 있나요?', '실제 실행에는 서버 설정과 다음 중 하나가 필요합니다: 보안 키로 로그인한 소유자(소유자 요청함 /cloudbite/requests), 기존 관리자 세션 토큰, 또는 프로젝트가 남은 승인·유효한 방문자 세션. 방문자는 /cloudbite/request 에서 접근을 요청할 수 있습니다. 서버가 준비되지 않았으면 설정에 빠진 설정 이름이 보입니다. 이 콘솔에는 API 키를 입력하지 않습니다.'],
    ['전문가는 몇 명까지 실행되나요?', '현재 카탈로그에서 프로젝트당 최대 100개 역할을 선택할 수 있습니다. 선택된 전문가는 운영자의 동시 실행 설정과 공급자 용량 범위에서 독립적으로 시작합니다. 선택 상한이 실제 샌드박스 100개의 처리량 검증을 의미하지는 않습니다.'],
    ['화면 비우기와 전체 화면은 무엇을 하나요?', '실행 기록 안의 화면 비우기는 보이는 기록 창만 비웁니다. 새 활동은 계속 들어오고 프로젝트 기록과 파일은 그대로입니다. 기록 되돌리기로 숨긴 줄을 다시 봅니다. 전체 화면은 작업공간과 기록을 넓혀 보이며, Escape 나 전체 화면 끝내기로 돌아옵니다.'],
    ['내 데이터는 어디에 남나요?', '관리자·운영자 토큰은 이 탭의 메모리에만 있습니다. 소유자 로그인과 승인된 방문자 세션은 서버가 이 페이지에서 읽을 수 없는 HttpOnly 쿠키로 보관합니다. 언어 선택은 주소(?lang=)에만 남습니다. 내보내기는 브라우저에서 다운로드로 만들어지며 데모인지 실제 실행인지 적혀 있습니다.'],
  ],
};
const DICT: Record<Lang, Messages> = { en: EN, ko: KO };

/** 알려진 역할(서버 카탈로그 12개·내장 데모 6개)의 한국어 설명. 이름과 페르소나 원문은 그대로 둔다 */
const ROLE_KO: Record<string, string> = {
  'probably-primetime-sta': '50개 지식 카드·120개 출처·8개 분야 체크리스트로 ASIC 타이밍을 검토합니다. PrimeTime 실행이나 signoff 인증은 제공하지 않습니다.',
  'agency-product-manager': '문제·대상 사용자·성과 지표를 정리하고, 범위를 좁힌 첫 출시와 Now/Next/Later 로드맵으로 프로젝트를 나눕니다.',
  'agency-business-strategist': '프로젝트가 이길 수 있는 지점을 그리고, 서로 다른 전략안 2–4개를 비교해 각각의 트레이드오프와 중단 기준을 밝힙니다.',
  'agency-specialized-pricing-analyst': '가치 지표와 패키징을 정하고, 제공 원가와 지불 의향 가정에 비추어 가격대를 검증합니다.',
  'agency-finance-fpa-analyst': '동인 기반 첫해 예산과 단위 경제성을 만들어 소진율·손익분기점과 결과를 가장 크게 움직이는 가정을 보여 줍니다.',
  'agency-design-ux-architect': '브리프를 주요 사용자 흐름·정보 구조·구현 가능한 UX 구조로 바꾸고 사용성·접근성 위험을 짚습니다.',
  'agency-engineering-software-architect': '시스템 분해·데이터 흐름·핵심 기술 결정을 제안하고, 각 트레이드오프를 아키텍처 결정 기록으로 남깁니다.',
  'agency-engineering-ai-engineer': 'AI 기능의 모델·검색·평가 방식을 설계하고 비용·지연·실패 처리를 분명히 합니다.',
  'agency-security-architect': '신뢰 경계를 따라 위협을 모델링하고 첫 출시에 중요한 통제부터 우선순위를 매깁니다.',
  'agency-engineering-privacy-engineer': '프로젝트가 다룰 개인정보를 목록화하고 최소화·동의·보존·삭제 통제를 설계합니다. 결과물은 자격 있는 개인정보·법률 검토가 필요합니다.',
  'agency-marketing-growth-hacker': '유입부터 유지까지의 퍼널을 모델링하고 후보 채널·루프를 고른 뒤, 반증 가능한 성장 실험 백로그에 순위를 매깁니다.',
  'agency-operations-manager': '핵심 프로세스·역량·공급업체·KPI와 표준화할 실패 지점까지, 프로젝트를 매일 실제로 운영하는 방식을 설계합니다.',
  'agency-product-feedback-synthesizer': '브리프가 고객에 대해 실제로 입증하는 것과 가정을 구분하고, 가장 중요한 빈틈을 메울 조사를 설계합니다.',
  'demo-product-strategist': '대안과 비교해 출시 범위·단계·차별점을 판단합니다.',
  'demo-business-model': '가격·단위 경제성과 추론 비용을 회수하는 방식을 검토합니다.',
  'demo-ai-trust': '근거 표시·책임 한계·고위험 분야 안전장치를 확인합니다.',
  'demo-data-validation': '자료 품질과 의견 근거를 검증할 수 있는지 살펴봅니다.',
  'demo-ux-research': '첫 사용 흐름·명확성·가치에 닿기까지의 시간을 봅니다.',
  'demo-security-compliance': '데이터 처리·접근 통제·규제 요구 사항을 검토합니다.',
};

/** `?lang=ko|en` 값. 없거나 다른 값이면 null */
function langParam(search: string): Lang | null {
  for (const part of (search.startsWith('?') ? search.slice(1) : search).split('&')) {
    if (part === 'lang' || part.startsWith('lang=')) { const v = part.slice('lang='.length); return v === 'ko' || v === 'en' ? v : null; }
  }
  return null;
}
/** 처음 언어: 올바른 ?lang= → 브라우저 언어 목록에서 처음 나오는 ko·en → en */
function pickLang(search: string, prefs: readonly unknown[]): Lang {
  const q = langParam(search);
  if (q) return q;
  for (const p of prefs) {
    if (typeof p !== 'string') continue;
    const t = p.trim().toLowerCase();
    if (t === 'ko' || t.startsWith('ko-')) return 'ko';
    if (t === 'en' || t.startsWith('en-')) return 'en';
  }
  return 'en';
}
/** 다른 질의는 그대로 두고 lang 만 바꾼 `?…` */
function withLang(search: string, l: Lang): string {
  const kept = (search.startsWith('?') ? search.slice(1) : search).split('&').filter(p => p && p !== 'lang' && !p.startsWith('lang='));
  return `?${[...kept, `lang=${l}`].join('&')}`;
}

/** GET /api/cloudbite/owner/session 응답. 글자 그대로의 true 만 로그인으로 본다. 형식이 틀리면 null (로그인 아님으로 다룬다) */
function normalizeOwnerSession(raw: unknown): { authenticated: boolean; hasCredentials: boolean } | null {
  if (!isObj(raw) || typeof raw.authenticated !== 'boolean') return null;
  return { authenticated: raw.authenticated === true, hasCredentials: raw.hasCredentials === true };
}

// ───────────────────────── 값 정리 (서버·모델이 보낸 것은 전부 의심한다) ─────────────────────────

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function str(v: unknown, n: number, fallback = ''): string { return typeof v === 'string' ? clip(v, n) : fallback; }
function strList(v: unknown, n: number, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max).map(x => clip(x, n)) : [];
}
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }
/** 카탈로그의 기계용 분야 이름(strategy.pricing, design.ui-ux)을 읽을 수 있는 말로. 이미 사람이 쓴 말이면 그대로 */
function domainLabel(d: string): string {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d)) return d;
  const last = d.slice(d.lastIndexOf('.') + 1).replace(/-/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}
/** 파일 응답 봉투 {path, label, bytes, content} 에서 내용만 꺼낸다. 형식이 다르거나 다른 파일이면 null */
function artifactContent(body: unknown, path: string): string | null {
  if (!isObj(body) || typeof body.content !== 'string') return null;
  if (body.path !== undefined && body.path !== path) return null;
  return clip(body.content, 200_000);
}

// 임시 Cloudbite 운영자 토큰 (docs/cloudbite/temporary-operator.txt): 서버(src/cloudbite-operator.ts)와 같은 모양만 받는다
const OPERATOR_TOKEN = /^cbo_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const isOperatorToken = (t: string) => t.trim().startsWith('cbo_');
/** `#operator=<token>` 조각을 읽는다. present = 운영자 자격처럼 보이는 조각이 있다 (형식이 틀려도 지워야 한다) */
function operatorFragment(hash: string): { present: boolean; token: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = raw.split('&');
  const hit = parts.find(p => p === 'operator' || p.startsWith('operator='));
  const value = hit === undefined ? null : hit.slice('operator='.length);
  return { present: hit !== undefined || raw.includes('cbo_'), token: value !== null && OPERATOR_TOKEN.test(value) ? value : '' };
}
/** 운영자 조각을 메모리로 옮기고, 어떤 요청보다 먼저 주소창·현재 기록 항목에서 지운다. location·history 가 없으면 조용히 넘어간다 */
function takeOperatorLink(): { present: boolean; token: string } {
  const g = globalThis as { location?: Location; history?: History };
  const loc = g.location;
  const found = operatorFragment(loc && typeof loc.hash === 'string' ? loc.hash : '');
  if (!found.present || !loc) return found;
  const clean = `${loc.pathname ?? ''}${loc.search ?? ''}`;
  try {
    if (g.history && typeof g.history.replaceState === 'function') { g.history.replaceState(g.history.state, '', clean); return found; }
  } catch { /* 아래 대안으로 */ }
  try { if (typeof loc.replace === 'function') loc.replace(`${clean}#`); } catch { /* 지울 방법이 없다 */ }
  return found;
}

function normalizeExpertDef(raw: unknown): ExpertDefinition | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 80), name = str(raw.name, 80);
  if (!id || !name) return null;
  const src = isObj(raw.source) ? raw.source : {};
  return {
    id, name, domain: str(raw.domain, 80, 'General'), summary: str(raw.summary, 400), prompt: str(raw.prompt, 20000),
    tools: strList(raw.tools, 80, 20), outputs: strList(raw.outputs, 120, 20),
    source: {
      repository: str(src.repository, 200), path: str(src.path, 200), revision: str(src.revision, 80),
      license: str(src.license, 120), basis: src.basis === 'curated-knowledge' ? 'curated-knowledge' : 'metadata-derived',
    },
  };
}

const ACCESS_STATUSES: CloudbiteAccessRequest['status'][] = ['pending', 'approved', 'denied', 'revoked', 'expired'];
const ACCESS_RECOVERY: NonNullable<CloudbiteAccessSession['recovery']>[] = ['pending', 'unavailable', 'limit'];
/** 실패한 방문자 실행의 정리 확인을 기다리며 bootstrap 을 다시 읽는 횟수·간격 (그 뒤에는 Check again 으로만) */
const ACCESS_RECHECKS = 24;
const ACCESS_RECHECK_MS = 5000;
/** 방문자 접근 상태 (bootstrap.access). 자격 증명은 HttpOnly 쿠키에만 있고 여기에는 상태만 온다. 깨졌으면 없는 것으로 본다 */
function normalizeAccess(raw: unknown): CloudbiteAccessSession | undefined {
  if (!isObj(raw)) return undefined;
  const r = raw.request;
  if (r === null || r === undefined) return { request: null, canCreate: false };
  if (!isObj(r)) return undefined;
  const id = str(r.id, 120), status = r.status as CloudbiteAccessRequest['status'];
  if (!id || !ACCESS_STATUSES.includes(status)) return undefined;
  const n = (v: unknown, max: number) => { const x = num(v); return x !== null && x >= 0 ? Math.min(Math.floor(x), max) : 0; };
  const request: CloudbiteAccessRequest = {
    id, status, name: str(r.name, 80), purpose: str(r.purpose, 1000), createdAt: n(r.createdAt, Number.MAX_SAFE_INTEGER), expiresAt: n(r.expiresAt, Number.MAX_SAFE_INTEGER),
    maxExperts: n(r.maxExperts, PROJECT_MAX), maxProjects: n(r.maxProjects, 100), usedProjects: n(r.usedProjects, 100),
  };
  const recovery = ACCESS_RECOVERY.find(x => x === raw.recovery);
  return { request, canCreate: raw.canCreate === true && status === 'approved', ...(recovery ? { recovery } : {}) };
}

/** 승인되고 만료 전인 방문자 요청만 돌려준다. URL 이 아니라 서버 bootstrap 이 알려 준 상태만 본다 */
function approvedVisitor(a: CloudbiteAccessSession | undefined, now: number): CloudbiteAccessRequest | null {
  const r = a?.request;
  return r && r.status === 'approved' && r.expiresAt > now ? r : null;
}

const POOL_MAX = CATALOGUE_MAX;
const POOL_KNOWLEDGE: PoolKnowledge[] = ['curated-knowledge', 'metadata-derived', 'none'];
/** bootstrap.pool 정리. 서버 값이라도 의심한다: 항목 카탈로그 한도(200)까지, id(pool-NNN)·번호(1–200)는 처음 것만, 이름 없는 항목은 버린다.
 *  실행 가능은 서버가 available 이라 하고 expertId 가 실제 카탈로그 역할이며 다른 항목이 먼저 가져가지 않았을 때뿐이다 — 아니면 계획 중.
 *  화면은 권한을 만들지 않는다: 평가는 늘 unvalidated, 지식 깊이는 실행 역할의 정의보다 높게 적지 않는다. 쓸 항목이 없으면 null */
function normalizePool(raw: unknown, experts: ExpertDefinition[]): Pool | null {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  const byId = new Map(experts.map(e => [e.id, e]));
  const ids = new Set<string>(), nums = new Set<number>(), mapped = new Set<string>();
  const entries: PoolEntry[] = [];
  for (const r of raw.entries.slice(0, 500)) {
    if (entries.length >= POOL_MAX) break;
    if (!isObj(r)) continue;
    const id = typeof r.id === 'string' && /^pool-\d{3}$/.test(r.id) ? r.id : '';
    const n = num(r.catalogNumber), name = str(r.name, 120).trim();
    if (!id || n === null || !Number.isInteger(n) || n < 1 || n > POOL_MAX || !name || ids.has(id) || nums.has(n)) continue;
    ids.add(id); nums.add(n);
    const def = typeof r.expertId === 'string' ? byId.get(r.expertId) : undefined;
    const available = r.availability === 'available' && !!def && !mapped.has(def.id);
    if (available) mapped.add(def!.id);
    let knowledge = POOL_KNOWLEDGE.find(k => k === r.knowledge) ?? 'none';
    if (available && knowledge === 'curated-knowledge' && def!.source.basis !== 'curated-knowledge') knowledge = 'metadata-derived';
    const category = typeof r.category === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.category) ? r.category : 'other';
    const label = isObj(r.categoryLabel) ? r.categoryLabel : {};
    const en = str(label.en, 60).trim() || category;
    const note = str(r.mappingNote, 200).trim();
    entries.push({
      id, catalogNumber: n, name, domain: str(r.domain, 120), category, categoryLabel: { en, ko: str(label.ko, 60).trim() || en },
      mission: str(r.mission, 400), ...(available ? { expertId: def!.id } : {}), availability: available ? 'available' : 'planned',
      knowledge, evaluation: 'unvalidated', priority: r.priority === true, keywords: strList(r.keywords, 40, 24), ...(note ? { mappingNote: note } : {}),
    });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.catalogNumber - b.catalogNumber);
  const pri = Array.isArray(raw.priorityNumbers) ? raw.priorityNumbers.filter((x): x is number => typeof x === 'number' && nums.has(x)) : [];
  return { version: str(raw.version, 80), entries, priorityNumbers: [...new Set(pri)] };
}

/** 검색·키워드 비교용: 소문자·NFKC, 글자·숫자·+·# 밖은 공백, 앞뒤에 공백 하나 */
function poolText(s: string): string { return ` ${s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim()} `; }
/** 키워드가 브리프에 나오는가. 영문은 낱말 단위(4자 이상은 앞부분 일치 — pricing·prices), 한글 등은 조사가 붙으므로 부분 일치 */
function keywordHit(text: string, kw: string): boolean {
  const k = poolText(kw).trim();
  if (k.length < 2) return false;
  if (!/^[\x20-\x7e]+$/.test(k)) return text.includes(k);
  return text.includes(` ${k} `) || (k.length >= 4 && text.includes(` ${k}`));
}
/** 규칙 기반 팀 제안: 브리프에 나온 서로 다른 키워드 수가 많은 실행 가능 역할부터 (같으면 우선 역할·번호 순), 최대 max 명.
 *  지금 카탈로그(runnable)에 있는 역할만, 같은 실행 역할은 한 번만. 맞는 키워드가 없으면 빈 목록이다 — 무작위·점수 없음 */
function suggestTeam(brief: string, entries: PoolEntry[], runnable: string[], max: number): PoolPick[] {
  const text = poolText(brief), ok = new Set(runnable), seen = new Set<string>();
  const scored: Array<PoolPick & { entry: PoolEntry }> = [];
  for (const e of entries) {
    if (e.availability !== 'available' || !e.expertId || !ok.has(e.expertId)) continue;
    const matched = [...new Set(e.keywords.filter(k => keywordHit(text, k)).map(k => k.trim()))];
    if (matched.length) scored.push({ entryId: e.id, expertId: e.expertId, matched: matched.slice(0, 6), entry: e });
  }
  scored.sort((a, b) => b.matched.length - a.matched.length || Number(b.entry.priority) - Number(a.entry.priority) || a.entry.catalogNumber - b.entry.catalogNumber);
  const out: PoolPick[] = [];
  for (const s of scored) {
    if (out.length >= Math.max(0, Math.min(PROJECT_MAX, max))) break;
    if (seen.has(s.expertId)) continue;
    seen.add(s.expertId); out.push({ entryId: s.entryId, expertId: s.expertId, matched: s.matched });
  }
  return out;
}

/** configuration.routing 정리. TypeSafe 가 아니거나 ready 가 참·거짓이 아니면 없는 것으로 본다 (예전 고르기 화면) */
function normalizeRouting(raw: unknown): Routing | undefined {
  if (!isObj(raw) || raw.provider !== 'typesafe' || typeof raw.ready !== 'boolean') return undefined;
  const max = num(raw.maxExperts);
  return { provider: 'typesafe', model: str(raw.model, 80).trim() || 'jev', ready: raw.ready, maxExperts: max !== null && max >= 1 ? Math.min(Math.floor(max), PROJECT_MAX) : 5 };
}

/** Jev 경로 응답 정리. 고른 역할은 지금 카탈로그의 실제 id 이고, 겹치지 않고, 1명 이상 max 명 이하여야 한다 — 아니면 null 이며
 *  화면은 그 팀으로 아무것도 만들지 않는다. matches 는 고른 역할의 적합도만 남긴다 (카탈로그 밖 id 는 버린다) */
function normalizeRoute(raw: unknown, allowed: string[], max: number): RouteResult | null {
  if (!isObj(raw) || raw.provider !== 'typesafe' || !Array.isArray(raw.expertIds) || !Array.isArray(raw.matches)) return null;
  const policyVersion = raw.policyVersion;
  if (policyVersion !== 'jev-routing/v1' && policyVersion !== 'jev-routing/v2') return null;
  const ok = new Set(allowed), ids: string[] = [];
  for (const id of raw.expertIds) {
    if (typeof id !== 'string' || !ok.has(id) || ids.includes(id)) return null;
    ids.push(id);
  }
  if (ids.length < 1 || ids.length > Math.min(PROJECT_MAX, max)) return null;
  const matches: RouteResult['matches'] = [];
  for (const x of raw.matches.slice(0, 200)) {
    if (!isObj(x) || typeof x.expertId !== 'string') return null;
    const r = num(x.relevance);
    if (r === null) return null;
    if (ids.includes(x.expertId) && !matches.some(y => y.expertId === x.expertId)) matches.push({ expertId: x.expertId, relevance: r });
  }
  const evaluatedCount = num(raw.evaluatedCount), threshold = num(raw.threshold), expiresAt = num(raw.expiresAt), queryHash = str(raw.queryHash, 200);
  if (evaluatedCount === null || threshold === null || expiresAt === null || !queryHash) return null;
  const base: RouteResult = { provider: 'typesafe', model: str(raw.model, 80), policyVersion, evaluatedCount, threshold, expertIds: ids, matches, queryHash, expiresAt };
  // v1(옛 기록 호환)에는 설명이 없다 — 붙어 와도 쓰지 않는다. v2 는 설명이 없거나 깨졌으면 팀 전체를 쓰지 않는다
  if (policyVersion === 'jev-routing/v1') return base;
  const harness = normalizeHarness(raw.harness, ok, ids, evaluatedCount);
  return harness ? { ...base, harness } : null;
}

const HARNESS_ID = /^[a-z][a-z0-9-]{0,47}$/;
const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** project-team/v1 팀 설명 정리 (jev-routing/v2 에서만). 고정 코드·실제 카탈로그 id·서로 맞는 담당 관계만 받고, 하나라도 어긋나면 null.
 *  관점 이름은 서버가 정한 고정 목록의 표시용 글이며 화면은 글자로만 그린다. 모르는 추가 필드는 버린다 */
function normalizeHarness(raw: unknown, allowed: Set<string>, ids: string[], evaluatedCount: number): CloudbiteRoutingHarness | null {
  if (!isObj(raw) || raw.version !== 'project-team/v1' || raw.peerReview !== 'not-performed') return null;
  if (!Array.isArray(raw.stages) || raw.stages.length !== 2 || raw.stages[0] !== 'assessment' || raw.stages[1] !== 'team-review') return null;
  const eligibleCount = raw.eligibleCount;
  // 고른 역할은 전부 자격 있는 후보에서 나오고, 자격 후보는 평가한 역할을 넘지 않는다 (엔진 후보 한도 = 카탈로그 한도 200).
  // 제외 목록은 고르지 않은 평가 역할 전부라 선택 한도(100)가 아니라 카탈로그 한도로 묶는다
  if (!isCount(eligibleCount) || eligibleCount < ids.length || eligibleCount > Math.min(CATALOGUE_MAX, evaluatedCount)) return null;
  if (!Array.isArray(raw.perspectives) || raw.perspectives.length > 32 || !Array.isArray(raw.selections) || !Array.isArray(raw.excluded)
    || raw.excluded.length > CATALOGUE_MAX || !Array.isArray(raw.warnings) || raw.warnings.length > HARNESS_WARNINGS.length) return null;
  const chosen = new Set(ids);
  const perspectives: CloudbiteRoutingHarness['perspectives'] = [];
  for (const p of raw.perspectives) {
    if (!isObj(p) || typeof p.id !== 'string' || !HARNESS_ID.test(p.id) || perspectives.some(x => x.id === p.id)) return null;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || name.length > 80 || !isProb(p.need) || !HARNESS_STATUSES.includes(p.status as HarnessStatus) || !Array.isArray(p.expertIds) || p.expertIds.length > PROJECT_MAX) return null;
    const experts: string[] = [];
    for (const id of p.expertIds) {
      if (typeof id !== 'string' || !chosen.has(id) || experts.includes(id)) return null;
      experts.push(id);
    }
    const status = p.status as HarnessStatus;
    // 담당이 있는데 빈 관점이라 하거나, 담당 없이 채웠다고 하면 서로 어긋난다
    if ((status === 'covered' && experts.length === 0) || (status !== 'covered' && experts.length > 0)) return null;
    perspectives.push({ id: p.id, name, need: p.need, status, expertIds: experts });
  }
  const selections: CloudbiteRoutingHarness['selections'] = [];
  for (const x of raw.selections) {
    if (!isObj(x) || typeof x.expertId !== 'string' || !chosen.has(x.expertId) || selections.some(y => y.expertId === x.expertId)) return null;
    if ((x.kind !== 'coverage' && x.kind !== 'additional-domain') || !Array.isArray(x.perspectiveIds) || x.perspectiveIds.length > 32) return null;
    const pids: string[] = [];
    for (const pid of x.perspectiveIds) {
      const p = typeof pid === 'string' ? perspectives.find(y => y.id === pid) : undefined;
      if (!p || pids.includes(p.id) || !p.expertIds.includes(x.expertId)) return null;
      pids.push(p.id);
    }
    if ((x.kind === 'coverage' && pids.length === 0) || (x.kind === 'additional-domain' && pids.length > 0)) return null;
    selections.push({ expertId: x.expertId, perspectiveIds: pids, kind: x.kind });
  }
  // 고른 역할마다 기여 설명이 정확히 하나 있고, 관점에 적힌 담당자는 그 역할의 설명에도 그 관점이 있다
  if (selections.length !== ids.length) return null;
  for (const p of perspectives) for (const id of p.expertIds) if (!selections.find(y => y.expertId === id)!.perspectiveIds.includes(p.id)) return null;
  const excluded: CloudbiteRoutingHarness['excluded'] = [];
  for (const x of raw.excluded) {
    if (!isObj(x) || typeof x.expertId !== 'string' || !allowed.has(x.expertId) || chosen.has(x.expertId) || excluded.some(y => y.expertId === x.expertId)) return null;
    if (!HARNESS_REASONS.includes(x.reason as HarnessReason)) return null;
    const reason = x.reason as HarnessReason;
    if (x.coveredBy !== undefined && (typeof x.coveredBy !== 'string' || !chosen.has(x.coveredBy))) return null;
    if (reason === 'overlap' && x.coveredBy === undefined) return null;
    excluded.push({ expertId: x.expertId, reason, ...(typeof x.coveredBy === 'string' ? { coveredBy: x.coveredBy } : {}) });
  }
  const warnings: HarnessWarning[] = [];
  for (const w of raw.warnings) {
    if (!HARNESS_WARNINGS.includes(w as HarnessWarning) || warnings.includes(w as HarnessWarning)) return null;
    warnings.push(w as HarnessWarning);
  }
  return { version: 'project-team/v1', stages: ['assessment', 'team-review'], eligibleCount, perspectives, selections, excluded, warnings, peerReview: 'not-performed' };
}

function normalizeBootstrap(raw: unknown): ConsoleBootstrap {
  if (!isObj(raw) || !Array.isArray(raw.experts) || !isObj(raw.configuration)) throw new Error('The catalogue response has an invalid format');
  const seen = new Set<string>();
  const experts: ExpertDefinition[] = [];
  for (const r of raw.experts.slice(0, 500)) {
    const e = normalizeExpertDef(r);
    if (e && !seen.has(e.id)) { seen.add(e.id); experts.push(e); }
  }
  const c = raw.configuration;
  const max = num(c.maxExperts);
  const access = normalizeAccess(raw.access);
  // 깨진 pool 은 bootstrap 전체를 실패시키지 않는다 — 없는 것으로 보고 예전 역할 고르기를 쓴다
  const pool = raw.pool === undefined ? null : normalizePool(raw.pool, experts);
  const routing = normalizeRouting(c.routing);
  return {
    experts,
    configuration: {
      liveReady: c.liveReady === true, missing: strList(c.missing, 80, 20),
      maxExperts: max !== null && max >= 1 ? Math.min(Math.floor(max), PROJECT_MAX) : 5,
      ...(c.historyRetentionDays === 30 ? { historyRetentionDays: 30 } : {}),
      ...(routing ? { routing } : {}),
    },
    ...(access ? { access } : {}),
    ...(pool ? { pool } : {}),
  };
}

function normalizeOpinion(raw: unknown): ExpertOpinion | null {
  if (!isObj(raw)) return null;
  const direction = raw.direction as OpinionDirection;
  const confidence = num(raw.confidence);
  const summary = str(raw.summary, 600).trim();
  if (!DIRECTIONS.includes(direction) || confidence === null || confidence < 0 || confidence > 100 || !summary) return null;
  return {
    direction, confidence: Math.round(confidence), summary,
    evidence: strList(raw.evidence, 300, 8), assumptions: strList(raw.assumptions, 300, 8), nextActions: strList(raw.nextActions, 200, 8),
  };
}

function normalizeExpertRun(raw: unknown, i: number): ConsoleExpert | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 120), expertId = str(raw.expertId, 80);
  if (!id || !expertId) return null;
  let status = raw.status as ExpertStatus;
  let error = str(raw.error, 400) || undefined;
  if (!EXPERT_STATUSES.includes(status)) { status = 'failed'; error = 'The server sent an unknown status'; }
  const activity: ExpertActivity[] = [];
  if (Array.isArray(raw.activity)) {
    for (const [j, a] of raw.activity.slice(-200).entries()) {
      if (!isObj(a)) continue;
      const kind = ACTIVITY_KINDS.includes(a.kind as ExpertActivity['kind']) ? a.kind as ExpertActivity['kind'] : 'status';
      const message = str(a.message, 500);
      if (message) activity.push({ id: str(a.id, 80, `${id}-${j}`), at: num(a.at) ?? 0, kind, message });
    }
  }
  const artifacts: ExpertArtifact[] = [];
  if (Array.isArray(raw.artifacts)) {
    for (const a of raw.artifacts.slice(0, 50)) {
      if (!isObj(a)) continue;
      const path = str(a.path, 200);
      if (!path) continue;
      const bytes = num(a.bytes);
      artifacts.push({
        path, label: str(a.label, 120, path),
        ...(typeof a.content === 'string' ? { content: clip(a.content, 200_000) } : {}),
        ...(bytes !== null && bytes >= 0 ? { bytes } : {}),
      });
    }
  }
  const opinion = raw.opinion === undefined || raw.opinion === null ? null : normalizeOpinion(raw.opinion);
  const run: ConsoleExpert = {
    id, expertId, name: str(raw.name, 80, `Expert ${i + 1}`), status, activity, artifacts, updatedAt: num(raw.updatedAt) ?? 0,
  };
  const sandboxId = str(raw.sandboxId, 120);
  if (sandboxId) run.sandboxId = sandboxId;
  if (error) run.error = error;
  if (opinion) run.opinion = opinion;
  else if (raw.opinion !== undefined && raw.opinion !== null) run.invalidOpinion = true;
  if (raw.authorResponse !== undefined && raw.authorResponse !== null) {
    const ar = normalizeAuthorResponse(raw.authorResponse, expertId);
    if (ar) run.authorResponse = ar; else run.invalidAuthorResponse = true;
  }
  return run;
}

function normalizeProject(raw: unknown): ConsoleProject | null {
  if (!isObj(raw) || !Array.isArray(raw.experts) || !isObj(raw.brief)) return null;
  const id = str(raw.id, 120);
  if (!id) return null;
  const b = raw.brief;
  const experts = raw.experts.slice(0, PROJECT_MAX).map(normalizeExpertRun).filter((e): e is ConsoleExpert => e !== null);
  const status = PROJECT_STATUSES.includes(raw.status as ProjectStatus) ? raw.status as ProjectStatus : statusFromExperts(experts);
  const decision = normalizeDecision(b.decision), documents = normalizeDocuments(b.documents), evidenceClaims = normalizeClaims(raw.evidenceClaims);
  const review = raw.crossReview === undefined || raw.crossReview === null ? undefined : normalizeCrossReview(raw.crossReview);
  // 선택 필드: 없으면 없음(undefined), 있는데 읽을 수 없으면 invalid* 로 밝힌다 (꾸며 채우지 않는다)
  const opt = <T>(v: unknown, f: (v: unknown) => T | null): T | null | undefined => v === undefined || v === null ? undefined : f(v);
  const memo = opt(raw.memo, normalizeMemo), signals = opt(raw.evidenceSignals, normalizeSignals), round = opt(raw.previousRound, normalizeRound);
  const memoBudget = isObj(raw.usage) ? phaseView(raw.usage.memo) : null;
  const budget = isObj(b.budget) && BUDGET_FIELDS.every(f => isInt((b.budget as Record<string, unknown>)[f], BUDGET_LIMITS[f][0], BUDGET_LIMITS[f][1]))
    ? Object.fromEntries(BUDGET_FIELDS.map(f => [f, (b.budget as Record<string, number>)[f]])) as unknown as ProjectBudget : null;
  const revision: ProjectRevision | null = isObj(b.revision) && typeof b.revision.parentId === 'string' && REVISION.parentId.test(b.revision.parentId) && typeof b.revision.changeSummary === 'string'
    ? { parentId: b.revision.parentId, changeSummary: clip(b.revision.changeSummary, REVISION.changeSummary),
      ...(typeof b.revision.reviewSnapshotHash === 'string' && SHA256.test(b.revision.reviewSnapshotHash) ? { reviewSnapshotHash: b.revision.reviewSnapshotHash } : {}) } : null;
  const prov = opt(raw.provenance, v => normalizeProvenance(v, id));
  // 작성자 응답 계획은 이전 라운드 안의 선택 필드다: 읽을 수 없으면 그 계획만 빼고 그렇다고 밝힌다 (비교·참고는 그대로)
  let authorPlan: AuthorResponsePlan | null | undefined;
  if (round && isObj(raw.previousRound) && raw.previousRound.authorResponse !== undefined && raw.previousRound.authorResponse !== null) {
    authorPlan = normalizeAuthorPlan(raw.previousRound.authorResponse, round.parentId);
    if (authorPlan) round.authorResponse = authorPlan;
  }
  return {
    id, status, experts, createdAt: num(raw.createdAt) ?? 0, updatedAt: num(raw.updatedAt) ?? 0,
    brief: {
      title: str(b.title, LIMIT.title), objective: str(b.objective, LIMIT.objective), context: str(b.context, LIMIT.context),
      expertIds: strList(b.expertIds, 80, PROJECT_MAX), mode: b.mode === 'live' ? 'live' : 'demo', requestId: str(b.requestId, 120),
      ...(decision ? { decision } : {}), ...(documents ? { documents } : {}),
      ...(STAGES.includes(b.stage as ProjectStage) ? { stage: b.stage as ProjectStage } : {}),
      ...(RESPONSE_LANGS.includes(b.responseLanguage as ResponseLanguage) ? { responseLanguage: b.responseLanguage as ResponseLanguage } : {}),
      ...(budget ? { budget } : {}), ...(revision ? { revision } : {}),
    },
    ...(evidenceClaims ? { evidenceClaims } : {}),
    ...(review ? { crossReview: review } : review === null ? { invalidCrossReview: true } : {}),
    ...(memo ? { memo } : memo === null ? { invalidMemo: true } : {}),
    ...(signals ? { evidenceSignals: signals } : signals === null ? { invalidSignals: true } : {}),
    ...(round ? { previousRound: round } : round === null ? { invalidRound: true } : {}),
    ...(authorPlan === null ? { invalidAuthorPlan: true } : {}),
    ...(memoBudget ? { memoBudget } : {}),
    ...(prov ? { provenance: prov } : prov === null ? { invalidProvenance: true } : {}),
  };
}

function statusFromExperts(experts: ConsoleExpert[]): ProjectStatus {
  if (experts.length === 0) return 'draft';
  if (experts.some(e => !TERMINAL_EXPERT.includes(e.status))) return 'running';
  const done = experts.filter(e => e.status === 'completed').length;
  if (done === experts.length) return 'completed';
  if (experts.every(e => e.status === 'cancelled')) return 'cancelled';
  if (done > 0) return 'partial';
  return experts.some(e => e.status === 'cancelled') ? 'cancelled' : 'failed';
}

// ───────────────── 결정 세부 정보 · 근거 자료 · 주장 장부 · 교차 검토 (전부 선택) ─────────────────

/** 천 단위 쉼표. 두 언어 모두 같은 모양을 쓴다 */
function group(n: number): string { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 여섯 칸의 글을 한 줄 한 항목으로 나눈다. 빈 줄은 버리고, 모든 칸이 비면 frame 이 없다 (선택 필드를 보내지 않는다) */
function parseDecision(texts: Partial<Record<DecisionField, string>>): { frame?: DecisionFrame; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  const frame = {} as DecisionFrame;
  let any = false;
  for (const f of DECISION_FIELDS) {
    const items = (texts[f] ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (items.length > DECISION.items) issues.push({ field: 'decision', text: m => m.vDecisionItems(m.decisionField[f], DECISION.items) });
    if (items.some(s => s.length > DECISION.chars)) issues.push({ field: 'decision', text: m => m.vDecisionLong(m.decisionField[f], DECISION.chars) });
    frame[f] = items;
    if (items.length) any = true;
  }
  return any ? { frame, issues } : { issues };
}

/** 브라우저 메모리에만 있는 근거 파일. key 는 화면 안에서만 쓰고, 보내는 id 는 남은 순서대로 doc-1.. 이다 */
/** origin: 가져온 출처 (PMC 발췌만). 사용자가 올린 파일에는 없고, 있으면 보낼 때 그대로 남긴다 */
interface DocDraft { key: number; name: string; content: string; origin?: string }
const docName = (name: string) => clip(name.trim() || 'file', 120);
/** 읽기 전에 거른다: 이름의 확장자, 브라우저가 알려 준 형식, 대략적인 크기 (UTF-8 한 글자는 최대 4바이트) */
function docProblem(f: { name: string; type: string; size: number }): Text | null {
  const name = docName(f.name);
  if (!DOC_EXT.test(f.name) || !(f.type.startsWith('text/') || DOC_TYPES.includes(f.type))) return m => m.docType(name);
  if (f.size === 0) return m => m.docEmpty(name);
  if (f.size > DOCS.chars * 4) return m => m.docLong(name, group(DOCS.chars));
  return null;
}
/** 읽은 글을 받아들일지 정한다. 제어 문자·깨진 UTF-8 이 있으면 바이너리로 보고, 한도는 이미 받은 파일과 합쳐서 잰다 */
/** 서버가 전문가 작업공간에 쓰는 evidence/documents.json 의 바이트 수를 넉넉히 어림한다 (안내문 자리 512바이트 포함) */
function docsBytes(docs: Array<{ name: string; content: string; origin?: string }>): number {
  const body = docsPayload(docs).map(d => ({ ...d, lines: d.content.split('\n').length }));
  let n = 512;
  for (const ch of JSON.stringify({ documents: body }, null, 2)) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
function docAccept(rawName: string, raw: string, docs: Array<{ name?: string; content: string; origin?: string }>): { doc: { name: string; content: string } } | { error: Text } {
  const name = docName(rawName);
  const content = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000E-\u001F\u007F�]/.test(content)) return { error: m => m.docBinary(name) };
  if (!content.trim()) return { error: m => m.docEmpty(name) };
  if (content.length > DOCS.chars) return { error: m => m.docLong(name, group(DOCS.chars)) };
  if (docs.length >= DOCS.files) return { error: m => m.docCount(name, DOCS.files) };
  if (docs.reduce((n, d) => n + d.content.length, 0) + content.length > DOCS.total) return { error: m => m.docTotal(name, group(DOCS.total)) };
  if (docsBytes([...docs.map(d => ({ ...d, name: d.name ?? '' })), { name, content }]) > DOCS.bytes) return { error: m => m.docBytes(name, DOCS.bytes / 1024) };
  return { doc: { name, content } };
}
/** 보낼 문서 목록. 빼고 남은 순서대로 doc-1..doc-6 을 다시 매긴다. 출처(origin)는 가져온 발췌에만 있고, 있으면 그대로 보낸다 */
function docsPayload(docs: Array<{ name: string; content: string; origin?: string }>): ProjectDocument[] {
  return docs.map((d, i) => ({ id: `doc-${i + 1}`, name: d.name, content: d.content, ...(d.origin ? { origin: d.origin } : {}) }));
}

/** 선택 워크플로 필드. 빈 칸은 보내지 않는다 (서버 기본값을 화면이 대신 채워 넣지 않는다). 예산은 넷 다 채우거나 넷 다 비운다 */
function parseWorkflow(stage: string, language: string, budget: Record<BudgetField, string>): {
  extras: { stage?: ProjectStage; responseLanguage?: ResponseLanguage; budget?: ProjectBudget }; issues: FormIssue[];
} {
  const extras: { stage?: ProjectStage; responseLanguage?: ResponseLanguage; budget?: ProjectBudget } = {};
  const issues: FormIssue[] = [];
  if (STAGES.includes(stage as ProjectStage)) extras.stage = stage as ProjectStage;
  if (RESPONSE_LANGS.includes(language as ResponseLanguage)) extras.responseLanguage = language as ResponseLanguage;
  const filled = BUDGET_FIELDS.filter(f => budget[f].trim() !== '');
  if (filled.length && filled.length < BUDGET_FIELDS.length) issues.push({ field: 'budget', text: m => m.vBudgetPartial });
  else if (filled.length) {
    const out = {} as ProjectBudget;
    for (const f of BUDGET_FIELDS) {
      const [min, max] = BUDGET_LIMITS[f], t = budget[f].trim();
      const n = /^\d{1,4}$/.test(t) ? Number(t) : NaN;
      if (!(n >= min && n <= max)) issues.push({ field: 'budget', text: m => m.vBudget(m.budgetField[f], min, max) });
      else out[f] = n;
    }
    if (!issues.length) extras.budget = out;
  }
  return { extras, issues };
}

const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const strArr = (v: unknown, max: number, n: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string') ? v.map(x => clip(x as string, n)) : null;
/** 서버의 ProjectPreview 를 그대로 받아들일 수 있는지 본다. 모양이 하나라도 다르면 null (꾸며 채우지 않는다) */
function normalizePreview(raw: unknown, expertIds: readonly string[]): ProjectPreview | null {
  if (!isObj(raw) || !isObj(raw.envelope) || !isObj(raw.budget)) return null;
  const ids = strArr(raw.expertIds, PROJECT_MAX, 120);
  if (!ids || JSON.stringify(ids) !== JSON.stringify(expertIds)) return null;
  const budget = {} as ProjectBudget;
  for (const f of BUDGET_FIELDS) { const v = raw.budget[f]; if (!isInt(v, BUDGET_LIMITS[f][0], BUDGET_LIMITS[f][1])) return null; budget[f] = v; }
  const e = raw.envelope;
  const keys = ['sandboxMaximum', 'nosanaMaximum', 'expertMaximum', 'reviewMaximum', 'memoMaximum', 'jevCalls'] as const;
  if (!keys.every(k => isInt(e[k]))) return null;
  const envelope = Object.fromEntries(keys.map(k => [k, e[k] as number])) as ProjectPreview['envelope'];
  if (!Array.isArray(raw.assignments) || raw.assignments.length > PROJECT_MAX) return null;
  const assignments: ExpertAssignment[] = [];
  for (const a of raw.assignments) {
    if (!isObj(a) || typeof a.expertId !== 'string' || !ids.includes(a.expertId) || !STAGES.includes(a.stage as ProjectStage)) return null;
    if (a.source !== 'jev-coverage' && a.source !== 'manual-scope' || typeof a.question !== 'string') return null;
    const optionIds = strArr(a.optionIds, 8, 20), deliverables = strArr(a.deliverables, 8, 400), requiredEvidence = strArr(a.requiredEvidence, 8, 400);
    const boundaries = strArr(a.boundaries, 8, 400), perspectiveIds = strArr(a.perspectiveIds, 14, 120);
    if (!optionIds || !optionIds.every(x => OPTION_ID.test(x)) || !deliverables || !requiredEvidence || !boundaries || !perspectiveIds) return null;
    assignments.push({ expertId: a.expertId, stage: a.stage as ProjectStage, question: clip(a.question, 800), optionIds, deliverables, requiredEvidence,
      boundaries, perspectiveIds, source: a.source });
  }
  const warnings = strArr(raw.warnings, 50, 400);
  if (!warnings) return null;
  return { expertIds: ids, assignments, budget, envelope, warnings };
}

/** 서버의 PmcImport 를 그대로 받아들일 수 있는지 본다. 발췌 원문·출처는 고치지 않고, 한도를 넘는 결과는 받지 않는다 */
function normalizePmc(raw: unknown): PmcImport | null {
  if (!isObj(raw) || !isObj(raw.article)) return null;
  const a = raw.article;
  if (typeof a.pmcid !== 'string' || !/^PMC\d{1,10}$/.test(a.pmcid) || typeof a.title !== 'string' || typeof a.license !== 'string'
    || typeof a.sourceUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(a.sourceUrl) || typeof a.retrievedAt !== 'string') return null;
  if (a.doi !== undefined && typeof a.doi !== 'string') return null;
  const article: PmcArticle = { pmcid: a.pmcid, title: clip(a.title, 400), license: clip(a.license, 200), sourceUrl: clip(a.sourceUrl, 500),
    retrievedAt: clip(a.retrievedAt, 40), ...(a.doi ? { doi: clip(a.doi, 220) } : {}) };
  if (!Array.isArray(raw.documents) || !raw.documents.length || raw.documents.length > DOCS.files) return null;
  const documents: ProjectDocument[] = [];
  for (const d of raw.documents) {
    if (!isObj(d) || typeof d.id !== 'string' || typeof d.name !== 'string' || typeof d.content !== 'string' || !d.content.trim()
      || d.content.length > DOCS.chars || (d.origin !== undefined && typeof d.origin !== 'string')) return null;
    documents.push({ id: clip(d.id, 20), name: docName(d.name), content: d.content, ...(d.origin ? { origin: clip(d.origin, 500) } : {}) });
  }
  if (!Array.isArray(raw.sections) || raw.sections.length > 200) return null;
  const sections: PmcSection[] = [];
  for (const x of raw.sections) {
    if (!isObj(x) || typeof x.id !== 'string' || typeof x.title !== 'string' || typeof x.locator !== 'string' || !isInt(x.characters)) return null;
    sections.push({ id: clip(x.id, 120), title: clip(x.title, 200), locator: clip(x.locator, 200), characters: x.characters });
  }
  const warnings = strArr(raw.warnings, 100, 400);
  if (!warnings) return null;
  return { article, documents, sections, warnings };
}

function normalizeDecision(raw: unknown): DecisionFrame | undefined {
  if (!isObj(raw)) return undefined;
  const frame = {} as DecisionFrame;
  let any = false;
  for (const f of DECISION_FIELDS) { frame[f] = strList(raw[f], DECISION.chars, DECISION.items); if (frame[f].length) any = true; }
  return any ? frame : undefined;
}
function normalizeDocuments(raw: unknown): ProjectDocument[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const docs: ProjectDocument[] = [];
  for (const d of raw.slice(0, DOCS.files)) {
    if (!isObj(d) || typeof d.content !== 'string') continue;
    const id = str(d.id, 40), origin = str(d.origin, 200);
    if (!id) continue;
    docs.push({ id, name: str(d.name, 120, id), content: clip(d.content, DOCS.chars), ...(origin ? { origin } : {}) });
  }
  return docs.length ? docs : undefined;
}
/** 서버의 주장 장부. 빈 배열은 "주장 없음"으로 남기고, 없는 필드와 구별한다 */
function normalizeClaims(raw: unknown): EvidenceClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const claims: EvidenceClaim[] = [];
  for (const [i, c] of raw.slice(0, PROJECT_MAX * 8).entries()) {
    if (!isObj(c)) continue;
    const text = str(c.text, 600).trim(), expertId = str(c.expertId, 80);
    if (!text || !expertId) continue;
    const references: EvidenceClaim['references'] = [];
    if (Array.isArray(c.references)) {
      for (const r of c.references.slice(0, 20)) {
        const id = isObj(r) ? str(r.id, 120) : '';
        if (isObj(r) && id && (r.kind === 'document' || r.kind === 'knowledge')) references.push({ kind: r.kind, id, available: r.available === true });
      }
    }
    claims.push({ id: str(c.id, 120, `claim-${i + 1}`), expertId, text, references, status: c.status === 'linked' ? 'linked' : 'unlinked' });
  }
  return claims;
}
const REVIEW_STATUSES: ProjectCrossReview['status'][] = ['running', 'completed', 'failed'];
/** 교차 검토. 실행 위치·상태·판정 중 하나라도 모르는 값이면 전체를 null 로 돌려 그리지 않는다 (짐작해 그리지 않는다) */
function normalizeCrossReview(raw: unknown): ConsoleReview | null {
  if (!isObj(raw) || raw.execution !== 'server-nosana' || !REVIEW_STATUSES.includes(raw.status as ProjectCrossReview['status'])) return null;
  if (raw.reports !== undefined && !Array.isArray(raw.reports)) return null;
  const reports: CrossReviewReport[] = [];
  for (const r of ((raw.reports as unknown[] | undefined) ?? []).slice(0, 8)) {
    if (!isObj(r) || !Array.isArray(r.findings)) return null;
    const reviewerExpertId = str(r.reviewerExpertId, 80);
    if (!reviewerExpertId) return null;
    const findings: CrossReviewFinding[] = [];
    for (const f of r.findings.slice(0, 40)) {
      if (!isObj(f) || !VERDICTS.includes(f.verdict as CrossReviewFinding['verdict'])) return null;
      const targetExpertId = str(f.targetExpertId, 80), evidenceIndex = num(f.evidenceIndex);
      if (!targetExpertId || evidenceIndex === null || evidenceIndex < 0 || !Number.isInteger(evidenceIndex)) return null;
      findings.push({ targetExpertId, evidenceIndex, verdict: f.verdict as CrossReviewFinding['verdict'], rationale: str(f.rationale, 600) });
    }
    reports.push({ reviewerExpertId, findings, summary: str(r.summary, 1000) });
  }
  const completedAt = num(raw.completedAt), error = str(raw.error, 400), disclosure = str(raw.disclosure, 1000);
  // 범위·글 확인은 선택 필드다: 모양이 틀리면 그 필드만 그리지 않는다 (판정은 그대로)
  const c = raw.coverage, ua = isObj(c) ? strArr(c.unassigned, PROJECT_MAX, 80) : null;
  const coverage: CrossReviewCoverage | null = isObj(c) && ua && (['completedOpinions', 'assignedOpinions', 'reviewers', 'maxReviewers', 'maxPeersPerReviewer'] as const).every(k => isInt(c[k]))
    ? { completedOpinions: c.completedOpinions as number, assignedOpinions: c.assignedOpinions as number, unassigned: ua, reviewers: c.reviewers as number,
      maxReviewers: c.maxReviewers as number, maxPeersPerReviewer: c.maxPeersPerReviewer as number } : null;
  const avail: CrossReviewTextAvailability[] = [];
  if (Array.isArray(raw.textAvailability)) for (const t of raw.textAvailability.slice(0, 320)) {
    if (!isObj(t) || typeof t.reviewerExpertId !== 'string' || typeof t.targetExpertId !== 'string' || !isInt(t.evidenceIndex)
      || !VERDICTS.includes(t.verdict as CrossReviewFinding['verdict']) || !TEXT_BASIS.includes(t.textBasis as CrossReviewTextAvailability['textBasis'])) continue;
    const a = strArr(t.availability, 40, 40);
    avail.push({ reviewerExpertId: clip(t.reviewerExpertId, 80), targetExpertId: clip(t.targetExpertId, 80), evidenceIndex: t.evidenceIndex,
      verdict: t.verdict as CrossReviewFinding['verdict'], availability: (a ?? []) as CrossReviewTextAvailability['availability'], textBasis: t.textBasis as CrossReviewTextAvailability['textBasis'] });
  }
  const art = raw.artifactCoverage === undefined || raw.artifactCoverage === null ? undefined : normalizeArtifactCoverage(raw.artifactCoverage);
  return {
    status: raw.status as ProjectCrossReview['status'], snapshotHash: str(raw.snapshotHash, 128), startedAt: num(raw.startedAt) ?? 0,
    ...(completedAt !== null ? { completedAt } : {}), reports, ...(error ? { error } : {}), execution: 'server-nosana',
    ...(coverage ? { coverage } : {}), ...(disclosure ? { disclosure } : {}), ...(avail.length ? { textAvailability: avail } : {}),
    ...(art ? { artifactCoverage: art } : art === null ? { invalidArtifactCoverage: true } : {}),
  };
}
type ArtifactCoverage = NonNullable<ProjectCrossReview['artifactCoverage']>;
const SHA256 = /^[0-9a-f]{64}$/;
/** 검토자가 읽은 저장 산출물 발췌의 범위 (파일·해시·줄 범위·잘림·빠진 이유). 하나라도 틀리면 null → 그리지 않고 밝힌다 */
function normalizeArtifactCoverage(raw: unknown): ArtifactCoverage | null {
  return every(raw, PROJECT_MAX, a => {
    if (!isObj(a) || typeof a.expertId !== 'string' || !a.expertId || typeof a.packetSha256 !== 'string' || !SHA256.test(a.packetSha256)) return null;
    const files = every(a.files, 50, f => isObj(f) && typeof f.path === 'string' && f.path && typeof f.sha256 === 'string' && SHA256.test(f.sha256)
      && isInt(f.startLine, 1) && isInt(f.endLine) && isInt(f.totalLines) && f.endLine >= f.startLine - 1 && f.endLine <= f.totalLines && isBool(f.excerptTruncated) && isBool(f.storedTruncated)
      ? { path: clip(f.path, 300), sha256: f.sha256, startLine: f.startLine, endLine: f.endLine, totalLines: f.totalLines, excerptTruncated: f.excerptTruncated, storedTruncated: f.storedTruncated } : null);
    const omitted = every(a.omitted, 200, o => isObj(o) && typeof o.path === 'string' && typeof o.reason === 'string' && o.reason ? { path: clip(o.path, 300), reason: clip(o.reason, 60) } : null);
    return files && omitted ? { expertId: clip(a.expertId, 80), packetSha256: a.packetSha256, files, omitted } : null;
  });
}

// ───────── 주장 출처 (src/cloudbite-provenance.ts). 서버가 다시 계산한 장부와 채택 상태를 엄격히 받는다. 지위는 구조일 뿐 검증이 아니다
const CLAIM_ID = /^cl-[0-9a-f]{16}$/, PROV_SNAPSHOT = /^ps-[0-9a-f]{16}$/;
const CLAIM_ORIGINS: LedgerClaim['origin'][] = ['user-statement', 'generated-opinion', 'parent-adoption'];
const CLAIM_KINDS: LedgerClaim['kind'][] = ['objective', 'context', 'option', 'constraint', 'success-criterion', 'known-fact', 'user-assumption', 'unknown',
  'opinion-summary', 'opinion-evidence', 'opinion-assumption', 'opinion-action', 'adopted-statement'];
const REF_AVAIL: LedgerClaim['refs'][number]['availability'][] = ['supplied-document', 'catalogue-listed', 'not-found'];
/** 100 역할 × (요약 + 3목록 × 12) + 브리프 + 넘어온 채택 64 를 넉넉히 덮는 상한. 넘으면 읽지 않는다 */
const PROV_MAX_CLAIMS = 6000;
const PROV_TEXT = 1000;
/** 서버(cloudbite-provenance clipChars·parseCarried)는 글을 코드 포인트로 센다: UTF-16 길이로 재면 이모지 1000자가 2000이 된다 */
const codePoints = (s: string) => { let n = 0; for (const _ of s) n++; return n; };
const adoptedIn = (v: unknown) => isObj(v) && typeof v.projectId === 'string' && typeof v.actor === 'string' && isInt(v.at) ? { projectId: clip(v.projectId, 128), actor: clip(v.actor, 200), at: v.at } : null;
function normalizeProvenance(raw: unknown, projectId: string): Provenance | null {
  if (!isObj(raw) || !isObj(raw.ledger) || !isObj(raw.state)) return null;
  const l = raw.ledger, s = raw.state, c = l.coverage;
  if (l.version !== 'cloudbite-provenance/v1' || l.projectId !== projectId || typeof l.snapshot !== 'string' || !PROV_SNAPSHOT.test(l.snapshot)) return null;
  if (!isObj(c) || c.factsVerified !== false || c.sourcesRetrieved !== false
    || !(['experts', 'expertsOmitted', 'itemsOmitted', 'textTruncated', 'refsOmitted', 'carriedAdoptions', 'carriedInvalid'] as const).every(k => isInt(c[k]))) return null;
  const ids = new Set<string>();
  const claims = every(l.claims, PROV_MAX_CLAIMS, x => {
    if (!isObj(x) || typeof x.id !== 'string' || !CLAIM_ID.test(x.id) || ids.has(x.id) || !CLAIM_ORIGINS.includes(x.origin as LedgerClaim['origin'])
      || !CLAIM_KINDS.includes(x.kind as LedgerClaim['kind']) || typeof x.field !== 'string' || !isInt(x.index) || typeof x.text !== 'string' || codePoints(x.text) > PROV_TEXT
      || !isBool(x.textTruncated) || !isBool(x.numericThresholdHint) || (x.expertId !== undefined && typeof x.expertId !== 'string')) return null;
    const refs = every(x.refs, 8, r => isObj(r) && (r.kind === 'document' || r.kind === 'knowledge') && typeof r.id === 'string'
      && REF_AVAIL.includes(r.availability as LedgerClaim['refs'][number]['availability']) ? { kind: r.kind as 'document' | 'knowledge', id: clip(r.id, 120), availability: r.availability as LedgerClaim['refs'][number]['availability'] } : null);
    const ad = x.adoptedIn === undefined ? undefined : adoptedIn(x.adoptedIn);
    if (!refs || ad === null || (x.origin === 'parent-adoption') !== !!ad) return null;
    ids.add(x.id);
    // 글은 자르지 않는다: 채택은 서버의 글과 정확히 같아야 한다
    const claim: LedgerClaim = { id: x.id, origin: x.origin as LedgerClaim['origin'], kind: x.kind as LedgerClaim['kind'], field: clip(x.field, 200), index: x.index,
      ...(typeof x.expertId === 'string' ? { expertId: clip(x.expertId, 80) } : {}), text: x.text, textTruncated: x.textTruncated, refs, numericThresholdHint: x.numericThresholdHint,
      ...(ad ? { adoptedIn: ad } : {}) };
    return claim;
  });
  if (!claims) return null;
  if (s.version !== 'cloudbite-provenance/v1' || s.projectId !== projectId) return null;
  const seen = new Set<string>();
  const adoptions = every(s.adoptions, 64, a => {
    if (!isObj(a) || typeof a.claimId !== 'string' || !CLAIM_ID.test(a.claimId) || seen.has(a.claimId) || typeof a.text !== 'string' || codePoints(a.text) > PROV_TEXT || typeof a.snapshot !== 'string'
      || !PROV_SNAPSHOT.test(a.snapshot) || a.projectId !== projectId || typeof a.actor !== 'string' || !isInt(a.at) || a.meaning !== 'user-adoption-not-verification') return null;
    seen.add(a.claimId);
    const out: ClaimAdoption = { claimId: a.claimId, text: a.text, snapshot: a.snapshot, projectId, actor: clip(a.actor, 200), at: a.at, meaning: 'user-adoption-not-verification' };
    return out;
  });
  if (!adoptions) return null;
  return {
    ledger: { version: 'cloudbite-provenance/v1', projectId, snapshot: l.snapshot, claims,
      coverage: { experts: c.experts as number, expertsOmitted: c.expertsOmitted as number, itemsOmitted: c.itemsOmitted as number, textTruncated: c.textTruncated as number,
        refsOmitted: c.refsOmitted as number, carriedAdoptions: c.carriedAdoptions as number, carriedInvalid: c.carriedInvalid as number, factsVerified: false, sourcesRetrieved: false } },
    state: { version: 'cloudbite-provenance/v1', projectId, adoptions },
  };
}
/** 서버 effectiveAdoptions·claimStanding 과 같은 규칙: 지금 장부에 같은 id·같은 글로 남은 채택만 효력이 있다 */
function provenanceView(pv: Provenance): { standing: Map<string, ClaimStanding>; active: ClaimAdoption[]; stale: ClaimAdoption[] } {
  const active: ClaimAdoption[] = [], stale: ClaimAdoption[] = [];
  const byId = new Map(pv.ledger.claims.map(c => [c.id, c]));
  for (const a of pv.state.adoptions) { const c = byId.get(a.claimId); (c && c.text === a.text && !c.textTruncated ? active : stale).push(a); }
  const standing = new Map<string, ClaimStanding>();
  for (const c of pv.ledger.claims) standing.set(c.id, c.origin === 'user-statement' ? 'user-stated' : c.origin === 'parent-adoption' ? 'user-adopted'
    : active.some(a => a.claimId === c.id && a.text === c.text) ? 'user-adopted' : 'generated-proposal');
  return { standing, active, stale };
}
type ProvGroup = keyof typeof P3_EN.provGroup;
/** 묶음: 숫자·기준이 있는 제안을 먼저 (요구 사항처럼 읽히기 쉬워서), 그다음 채택된 것, 그 밖의 제안, 사용자 진술 */
function provenanceGroups(pv: Provenance): Record<ProvGroup, LedgerClaim[]> {
  const { standing } = provenanceView(pv);
  const g: Record<ProvGroup, LedgerClaim[]> = { hinted: [], adopted: [], proposals: [], stated: [] };
  for (const c of pv.ledger.claims) {
    const s = standing.get(c.id);
    if (s === 'user-stated') g.stated.push(c);
    else if (s === 'user-adopted') g.adopted.push(c);
    else if (c.numericThresholdHint) g.hinted.push(c);
    else g.proposals.push(c);
  }
  return g;
}
function provenanceLines(pv: Provenance, m: Messages): string[] {
  const t = m.p3, g = provenanceGroups(pv), { stale } = provenanceView(pv), c = pv.ledger.coverage;
  return [
    t.provCounts(g.stated.length, g.hinted.length + g.proposals.length, g.hinted.length, g.adopted.length),
    ...(stale.length ? [t.provStale(stale.length)] : []),
    t.provCoverage(c.experts, c.expertsOmitted, c.itemsOmitted, c.textTruncated, c.refsOmitted),
    ...(c.carriedAdoptions || c.carriedInvalid ? [t.provCarried(c.carriedAdoptions, c.carriedInvalid)] : []),
  ];
}

// ───────── 작성자 응답 (src/cloudbite-author-response.ts): 계획은 이전 라운드 안에, 응답은 각 역할 실행 옆에 따로 있다
const DISPOSITIONS = ['revise', 'withdraw', 'maintain'] as const;
const AR_FINDING = /^arf_[0-9a-f]{32}$/;
function normalizeAuthorResponse(raw: unknown, expertId: string): AuthorResponseParsed | { invalid: string } | null {
  if (!isObj(raw)) return null;
  if ('invalid' in raw) return typeof raw.invalid === 'string' && raw.invalid ? { invalid: clip(raw.invalid, 400) } : null;
  const cv = raw.coverage, lg = raw.language;
  if (raw.expertId !== expertId || !isObj(cv) || !isObj(lg) || !RESPONSE_LANGS.includes(lg.language as ResponseLanguage)
    || !['consistent', 'mismatch', 'unknown'].includes(lg.status as string)) return null;
  const responses = every(raw.responses, 9, r => isObj(r) && typeof r.findingId === 'string' && AR_FINDING.test(r.findingId) && DISPOSITIONS.includes(r.disposition as typeof DISPOSITIONS[number])
    && typeof r.rationale === 'string' ? { findingId: r.findingId, disposition: r.disposition as typeof DISPOSITIONS[number], rationale: clip(r.rationale, 600) } : null);
  const missing = strArr(cv.missing, 9, 40);
  if (!responses || !missing || !isInt(cv.expected) || !isInt(cv.answered) || !['complete', 'partial', 'none'].includes(cv.status as string)
    || cv.answered !== responses.length || new Set(responses.map(r => r.findingId)).size !== responses.length) return null;
  return { expertId, responses, coverage: { expected: cv.expected, answered: cv.answered, missing, status: cv.status as AuthorResponseParsed['coverage']['status'] },
    language: { language: lg.language as ResponseLanguage, status: lg.status as AuthorResponseParsed['language']['status'] } };
}
const EXECUTION_KEYS = { kind: 'new-child-project', automaticCalls: 0, budget: 'child-normal', parentMutation: 'none', parentMemo: 'unchanged', childMemo: 'own-optional' } as const;
function normalizeAuthorPlan(raw: unknown, parentId: string): AuthorResponsePlan | null {
  if (!isObj(raw) || raw.version !== 'cloudbite-author-response/v1' || raw.kind !== 'author-response-follow-up' || raw.trust !== 'untrusted-data' || raw.parentId !== parentId
    || !PROJECT_STATUSES.includes(raw.parentStatus as ProjectStatus) || !RESPONSE_LANGS.includes(raw.responseLanguage as ResponseLanguage)
    || typeof raw.planSha256 !== 'string' || !SHA256.test(raw.planSha256) || typeof raw.disclosure !== 'string') return null;
  const ex = raw.execution, cr = raw.crossReview, cap = raw.capped;
  if (!isObj(ex) || Object.keys(EXECUTION_KEYS).some(k => ex[k] !== EXECUTION_KEYS[k as keyof typeof EXECUTION_KEYS])) return null;
  const reviewers = isObj(cr) ? strArr(cr.reviewers, 8, 80) : null;
  if (!isObj(cr) || typeof cr.snapshotHash !== 'string' || !SHA256.test(cr.snapshotHash) || !(cr.completedAt === null || isInt(cr.completedAt)) || !reviewers
    || !isInt(cr.findings) || !isInt(cr.supported) || !isInt(cr.eligible)) return null;
  const roles = strArr(raw.roles, PROJECT_MAX, 80), unselected = strArr(raw.unselectedAuthors, PROJECT_MAX, 80);
  const authors = every(raw.authors, PROJECT_MAX, a => {
    const o = isObj(a) ? a.original : null, fids = isObj(a) ? strArr(a.findingIds, 9, 40) : null;
    return isObj(a) && typeof a.expertId === 'string' && typeof a.name === 'string' && typeof a.opinionSha256 === 'string' && SHA256.test(a.opinionSha256) && fids
      && isObj(o) && DIRECTIONS.includes(o.direction as OpinionDirection) && isInt(o.confidence, 0, 100) && typeof o.summary === 'string' && isInt(o.evidenceCount)
      ? { expertId: clip(a.expertId, 80), name: clip(a.name, 120), opinionSha256: a.opinionSha256, findingIds: fids,
        original: { direction: o.direction as OpinionDirection, confidence: o.confidence, summary: clip(o.summary, 1500), evidenceCount: o.evidenceCount } } : null;
  });
  const findings = every(raw.findings, 9, f => isObj(f) && typeof f.findingId === 'string' && AR_FINDING.test(f.findingId) && typeof f.reviewerExpertId === 'string'
    && typeof f.targetExpertId === 'string' && isInt(f.evidenceIndex) && (f.verdict === 'challenged' || f.verdict === 'insufficient')
    && typeof f.reviewerRationale === 'string' && typeof f.evidenceText === 'string'
    ? { findingId: f.findingId, reviewerExpertId: clip(f.reviewerExpertId, 80), targetExpertId: clip(f.targetExpertId, 80), evidenceIndex: f.evidenceIndex,
      verdict: f.verdict as 'challenged' | 'insufficient', reviewerRationale: clip(f.reviewerRationale, 1000), evidenceText: clip(f.evidenceText, 1000) } : null);
  const omittedIds = isObj(cap) ? strArr(cap.omittedFindingIds, 18, 40) : null;
  const excluded = every(raw.excluded, 64, x => isObj(x) && isInt(x.reportIndex) && typeof x.reason === 'string'
    ? { reportIndex: x.reportIndex, reason: x.reason as AuthorResponsePlan['excluded'][number]['reason'], ...(isInt(x.findingIndex) ? { findingIndex: x.findingIndex } : {}),
      ...(typeof x.reviewerExpertId === 'string' ? { reviewerExpertId: clip(x.reviewerExpertId, 80) } : {}), ...(typeof x.targetExpertId === 'string' ? { targetExpertId: clip(x.targetExpertId, 80) } : {}) } : null);
  const omissions = every(raw.omissions, 200, o => isObj(o) && typeof o.path === 'string' && (o.omittedBytes === undefined || isInt(o.omittedBytes)) && (o.omittedItems === undefined || isInt(o.omittedItems))
    ? { path: clip(o.path, 120), ...(o.omittedBytes !== undefined ? { omittedBytes: o.omittedBytes as number } : {}), ...(o.omittedItems !== undefined ? { omittedItems: o.omittedItems as number } : {}) } : null);
  if (!roles || !unselected || !authors || !findings || !omittedIds || !excluded || !omissions || !isObj(cap) || !isInt(cap.limit) || !isInt(cap.eligibleSelected) || !isInt(cap.included)) return null;
  // 지적은 그 작성자 것이어야 한다: 계획의 묶음이 서로 맞지 않으면 읽지 않는다
  if (findings.some(f => !authors.some(a => a.expertId === f.targetExpertId && a.findingIds.includes(f.findingId)))) return null;
  return { version: 'cloudbite-author-response/v1', kind: 'author-response-follow-up', trust: 'untrusted-data', parentId, parentStatus: raw.parentStatus as ProjectStatus,
    crossReview: { snapshotHash: cr.snapshotHash, completedAt: cr.completedAt as number | null, reviewers, findings: cr.findings, supported: cr.supported, eligible: cr.eligible },
    responseLanguage: raw.responseLanguage as ResponseLanguage, execution: { ...EXECUTION_KEYS }, roles, authors, findings,
    capped: { limit: cap.limit, eligibleSelected: cap.eligibleSelected, included: cap.included, omittedFindingIds: omittedIds },
    unselectedAuthors: unselected, excluded, omissions, disclosure: clip(raw.disclosure, 2000), planSha256: raw.planSha256 };
}
/** 작성자 응답을 요청할 수 있는 작성자: 서버 후보와 같은 조건 (반박·부족, 검토자·대상 모두 완료 작성자이고 서로 다름, 근거 칸이 있음) */
function authorResponseAffected(p: ConsoleProject): string[] {
  const cr = p.crossReview;
  if (!cr || cr.status !== 'completed' || !SHA256.test(cr.snapshotHash)) return [];
  const done = new Map(p.experts.filter(e => e.status === 'completed' && e.opinion && !e.invalidOpinion).map(e => [e.expertId, e]));
  const hit = new Set<string>();
  for (const r of cr.reports) for (const f of r.findings) {
    const target = done.get(f.targetExpertId);
    if ((f.verdict === 'challenged' || f.verdict === 'insufficient') && done.has(r.reviewerExpertId) && target && r.reviewerExpertId !== f.targetExpertId
      && f.evidenceIndex < target.opinion!.evidence.length) hit.add(f.targetExpertId);
  }
  return p.experts.map(e => e.expertId).filter(id => hit.has(id));
}
/** 작성자 응답 요청 버튼을 낼 수 있는 프로젝트: 끝난 실제 실행 + 완료된 교차 검토 (부모 권한은 서버가 다시 확인한다) */
function authorResponseEligible(p: ConsoleProject): boolean {
  return followUpEligible(p) && p.status !== 'cancelled' && p.crossReview?.status === 'completed' && authorResponseAffected(p).length > 0;
}
/** 작성자 응답 줄 (화면·보고서 공용). 지적마다 응답·없음, 역할마다 거부·읽을 수 없음·아직 없음을 의견 상태와 따로 적는다 */
function authorResponseLines(plan: AuthorResponsePlan, experts: ConsoleExpert[], m: Messages, name: NameOf): Array<{ author: string; head: string; original: string; lines: string[] }> {
  const t = m.p3;
  return plan.authors.map(a => {
    const run = experts.find(e => e.expertId === a.expertId), ar = run?.authorResponse;
    const head: string[] = [];
    if (run?.invalidAuthorResponse) head.push(t.arUnreadable);
    else if (ar && 'invalid' in ar) head.push(t.arInvalid(ar.invalid));
    else if (ar) head.push(`${t.arStatus[ar.coverage.status]} · ${t.arAnswered(ar.coverage.answered, ar.coverage.expected)}`);
    else head.push(t.arPending);
    const lines = plan.findings.filter(f => a.findingIds.includes(f.findingId)).map(f => {
      const r = ar && !('invalid' in ar) ? ar.responses.find(x => x.findingId === f.findingId) : undefined;
      const answer = r ? `${t.arDisposition[r.disposition]} — ${r.rationale}` : ar && !('invalid' in ar) ? t.arMissing : '';
      return `${t.arFinding(name(f.reviewerExpertId), m.verdict[f.verdict], name(f.targetExpertId), f.evidenceIndex + 1)}${answer ? ` → ${answer}` : ''}`;
    });
    return { author: a.name, head: head.join(''), original: t.arOriginal(m.direction[a.original.direction], a.original.confidence), lines };
  });
}
/** 검토자가 읽은 산출물 글 (화면·보고서 공용). 읽기만 했다는 것 외에 아무것도 주장하지 않는다 */
function artifactFileLine(f: ArtifactCoverage[number]['files'][number], m: Messages): string {
  const t = m.p3, flags = [...(f.excerptTruncated ? [t.artExcerptCut] : []), ...(f.storedTruncated ? [t.artStoredCut] : [])];
  return `${t.artFile(f.path, f.startLine, f.endLine, f.totalLines)} · sha256 ${f.sha256.slice(0, 12)}…${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
}
const artifactOmitLine = (o: { path: string; reason: string }, m: Messages) => m.p3.artOmitted(o.path, m.p3.artReason[o.reason] ?? o.reason);
function artifactLines(cr: ConsoleReview, m: Messages, name: NameOf): string[] {
  const t = m.p3;
  if (cr.invalidArtifactCoverage) return [t.artInvalid];
  const a = cr.artifactCoverage;
  if (!a) return [];
  if (!a.length) return [t.artNone];
  return [t.artTitle(a.length, a.reduce((n, x) => n + x.files.length, 0)), t.artNote,
    ...a.flatMap(x => [`${name(x.expertId)} (packet ${x.packetSha256.slice(0, 12)}…)`, ...x.files.map(f => `  ${artifactFileLine(f, m)}`), ...x.omitted.map(o => `  ${artifactOmitLine(o, m)}`)])];
}
const TEXT_BASIS: CrossReviewTextAvailability['textBasis'][] = ['available', 'partial', 'unavailable', 'uncited'];

// ───────── 결정 메모 · 관찰 신호 · 이전 라운드 (서버가 저장한 모양 그대로만 받는다. 하나라도 틀리면 null → "읽을 수 없음")
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const every = <T>(v: unknown, max: number, f: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: T[] = [];
  for (const x of v) { const y = f(x); if (y === null) return null; out.push(y); }
  return out;
};
function phaseView(v: unknown): BudgetPhaseView | null {
  return isObj(v) && isInt(v.used) && isInt(v.max) && isInt(v.available) && isBool(v.exhausted) ? { used: v.used, max: v.max, available: v.available, exhausted: v.exhausted } : null;
}
function memoRef(r: unknown): MemoReference | null {
  if (!isObj(r)) return null;
  if (r.kind === 'opinion-evidence') return typeof r.expertId === 'string' && isInt(r.index) ? { kind: 'opinion-evidence', expertId: clip(r.expertId, 80), index: r.index } : null;
  if (r.kind === 'document') return typeof r.id === 'string' ? { kind: 'document', id: clip(r.id, 120) } : null;
  if (r.kind === 'packet') return typeof r.id === 'string' ? { kind: 'packet', id: clip(r.id, 120) } : null;
  if (r.kind === 'review-finding') return typeof r.reviewerExpertId === 'string' && isInt(r.index) ? { kind: 'review-finding', reviewerExpertId: clip(r.reviewerExpertId, 80), index: r.index } : null;
  if (r.kind === 'brief') return typeof r.field === 'string' ? { kind: 'brief', field: clip(r.field, 80) } : null;
  return null;
}
function memoClaim(c: unknown): MemoClaim | null {
  if (!isObj(c) || typeof c.text !== 'string') return null;
  const expertIds = strArr(c.expertIds, PROJECT_MAX, 80), refs = every(c.refs, 40, memoRef);
  return expertIds && refs ? { text: clip(c.text, 1500), expertIds, refs } : null;
}
function decisionMemo(raw: unknown): DecisionMemo | null {
  if (!isObj(raw) || typeof raw.summary !== 'string' || raw.basis !== 'derived-interpretation' || raw.confidence !== 'not-calibrated') return null;
  const r = raw.recommendation;
  if (!isObj(r) || (r.status !== 'recommend' && r.status !== 'no-recommendation') || typeof r.rationale !== 'string') return null;
  const optionIds = strArr(r.optionIds, 8, 20), expertIds = strArr(r.expertIds, PROJECT_MAX, 80), refs = every(r.refs, 40, memoRef);
  const options = every(r.options, 8, o => isObj(o) && typeof o.id === 'string' && OPTION_ID.test(o.id) && typeof o.text === 'string' ? { id: o.id, text: clip(o.text, 2000) } : null);
  if (!optionIds || !optionIds.every(x => OPTION_ID.test(x)) || !expertIds || !refs || !options) return null;
  const comparison = every(raw.comparison, 8, o => {
    if (!isObj(o) || typeof o.optionId !== 'string' || !OPTION_ID.test(o.optionId) || typeof o.optionText !== 'string') return null;
    const benefits = every(o.benefits, 20, memoClaim), risks = every(o.risks, 20, memoClaim), conditions = every(o.conditions, 20, memoClaim);
    return benefits && risks && conditions ? { optionId: o.optionId, optionText: clip(o.optionText, 2000), benefits, risks, conditions } : null;
  });
  const lists = (['dissent', 'criticalUnknowns', 'changeTriggers', 'nextActions'] as const).map(k => every(raw[k], 20, memoClaim));
  if (!comparison || lists.some(x => !x)) return null;
  const [dissent, criticalUnknowns, changeTriggers, nextActions] = lists as MemoClaim[][];
  return { summary: clip(raw.summary, 3000), recommendation: { status: r.status, optionIds, options, rationale: clip(r.rationale, 3000), expertIds, refs },
    comparison, dissent, criticalUnknowns, changeTriggers, nextActions, basis: 'derived-interpretation', confidence: 'not-calibrated' };
}
function section(v: unknown): { included: number; total: number; truncated: number; omitted: number } | null {
  return isObj(v) && isInt(v.included) && isInt(v.total) && isInt(v.truncated) && isInt(v.omitted) ? { included: v.included, total: v.total, truncated: v.truncated, omitted: v.omitted } : null;
}
function memoCoverage(raw: unknown): MemoCoverage | null {
  if (!isObj(raw) || !isInt(raw.teamSize) || !isInt(raw.completed) || !isInt(raw.promptBytes) || raw.fullReportsReviewed !== false || raw.sourcePagesReviewed !== false) return null;
  const sd = raw.statedDirections, sc = raw.statusCounts, br = raw.brief;
  if (!isObj(sd) || !DIRECTIONS.every(d => isInt(sd[d])) || !isObj(sc) || !Object.entries(sc).every(([k, n]) => EXPERT_STATUSES.includes(k as ExpertStatus) && isInt(n))) return null;
  if (!isObj(br) || !isBool(br.objectiveTruncated) || !isBool(br.contextTruncated) || !isInt(br.decisionItemsTruncated) || !isInt(br.decisionItemsOmitted) || !isBool(br.revisionTruncated)) return null;
  const reviews = section(raw.reviews), packets = section(raw.packets);
  if (!reviews || !packets || !isObj(raw.reviews) || !isInt(raw.reviews.reports) || !isObj(raw.packets) || !isInt(raw.packets.invalid) || !isInt(raw.packets.metadataOnly)) return null;
  const experts = every(raw.experts, PROJECT_MAX, e => isObj(e) && typeof e.expertId === 'string' && isBool(e.summaryTruncated) && Array.isArray(e.evidenceIncluded) && e.evidenceIncluded.every(x => isInt(x))
    && (['evidenceTotal', 'itemsTruncated', 'assumptionsIncluded', 'assumptionsTotal', 'nextActionsIncluded', 'nextActionsTotal'] as const).every(k => isInt(e[k]))
    ? { expertId: clip(e.expertId, 80), summaryTruncated: e.summaryTruncated, evidenceIncluded: e.evidenceIncluded as number[], evidenceTotal: e.evidenceTotal as number, itemsTruncated: e.itemsTruncated as number,
      assumptionsIncluded: e.assumptionsIncluded as number, assumptionsTotal: e.assumptionsTotal as number, nextActionsIncluded: e.nextActionsIncluded as number, nextActionsTotal: e.nextActionsTotal as number } : null);
  const documents = every(raw.documents, DOCS.files * 2, d => isObj(d) && typeof d.id === 'string' && isInt(d.includedBytes) && isInt(d.originalBytes) && isBool(d.truncated)
    ? { id: clip(d.id, 40), includedBytes: d.includedBytes, originalBytes: d.originalBytes, truncated: d.truncated } : null);
  if (!experts || !documents) return null;
  return { teamSize: raw.teamSize, completed: raw.completed, statusCounts: sc as MemoCoverage['statusCounts'], statedDirections: sd as Record<OpinionDirection, number>, experts, documents,
    brief: { objectiveTruncated: br.objectiveTruncated, contextTruncated: br.contextTruncated, decisionItemsTruncated: br.decisionItemsTruncated, decisionItemsOmitted: br.decisionItemsOmitted, revisionTruncated: br.revisionTruncated },
    reviews: { ...reviews, reports: raw.reviews.reports }, packets: { ...packets, invalid: raw.packets.invalid, metadataOnly: raw.packets.metadataOnly },
    fullReportsReviewed: false, sourcePagesReviewed: false, promptBytes: raw.promptBytes };
}
/** 서버의 ProjectMemo. 완료인데 메모가 없거나 읽을 수 없으면 전체를 null 로 돌려 "읽을 수 없음"으로 밝힌다 */
function normalizeMemo(raw: unknown): ConsoleMemo | null {
  if (!isObj(raw) || raw.version !== 'cloudbite-memo/v1' || !MEMO_STATUSES.includes(raw.status as MemoStatus) || !isInt(raw.attempts)
    || (raw.execution !== 'server-nosana' && raw.execution !== 'none')) return null;
  const memo = raw.memo === undefined ? undefined : decisionMemo(raw.memo);
  const coverage = raw.coverage === undefined ? undefined : memoCoverage(raw.coverage);
  if (memo === null || coverage === null || (raw.status === 'completed' && !memo)) return null;
  const at = (v: unknown) => num(v) ?? undefined;
  const startedAt = at(raw.startedAt), completedAt = at(raw.completedAt), reason = str(raw.reason, 600), error = str(raw.error, 600), snapshotHash = str(raw.snapshotHash, 128);
  return { version: 'cloudbite-memo/v1', status: raw.status as MemoStatus, attempts: raw.attempts, execution: raw.execution,
    ...(snapshotHash ? { snapshotHash } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}),
    ...(RESPONSE_LANGS.includes(raw.language as ResponseLanguage) ? { language: raw.language as ResponseLanguage } : {}),
    ...(coverage ? { coverage } : {}), ...(memo ? { memo } : {}), ...(reason ? { reason } : {}), ...(error ? { error } : {}) };
}
const SIGNAL_BINDINGS = ['bound', 'legacy-unbound', 'stale', 'foreign', 'invalid', 'absent', 'no-pack'];
const intsOf = (o: unknown, keys: readonly string[]): Record<string, number> | null =>
  isObj(o) && keys.every(k => isInt(o[k])) ? Object.fromEntries(keys.map(k => [k, o[k] as number])) : null;
/** 서버의 관찰 장부. null 인 칸(검색·교차 검토)은 "관찰 안 됨"이라 그대로 null 로 둔다 — 0 으로 바꾸지 않는다 */
function normalizeSignals(raw: unknown): EvidenceSignals | null {
  if (!isObj(raw) || raw.schema !== 'cloudbite.evidence-signals/v1' || typeof raw.interpretation !== 'string') return null;
  const experts = every(raw.experts, PROJECT_MAX, (e): ExpertEvidenceSignals | null => {
    if (!isObj(e) || typeof e.expertId !== 'string' || !isInt(e.selfAssessedConfidence, 0, 100) || !isInt(e.evidenceItems) || !isInt(e.unreferencedEvidenceItems)
      || !isInt(e.unknownReferences) || !isInt(e.assumptions)) return null;
    const references = intsOf(e.references, ['total', 'document', 'workspace', 'knowledge']), suppliedText = intsOf(e.suppliedText, ['available', 'missing']);
    const knowledge = intsOf(e.knowledge, ['curatedCardText', 'curatedCardTextOmitted', 'retrievalUnverified', 'notRetrieved']);
    const or = e.observedRetrieval, cr = e.crossReview;
    const observed = or === null ? null : isObj(or) && SIGNAL_BINDINGS.includes(or.binding as string) ? intsOf(or, ['retrievals', 'cards', 'sources']) : undefined;
    const cross = cr === null ? null : intsOf(cr, ['reviewers', 'findings', 'supported', 'challenged', 'insufficient', 'evidenceItemsReviewed']) ?? undefined;
    if (!references || !suppliedText || !knowledge || observed === undefined || cross === undefined) return null;
    return { expertId: clip(e.expertId, 80), selfAssessedConfidence: e.selfAssessedConfidence, evidenceItems: e.evidenceItems, unreferencedEvidenceItems: e.unreferencedEvidenceItems,
      references: references as ExpertEvidenceSignals['references'], suppliedText: suppliedText as ExpertEvidenceSignals['suppliedText'], knowledge: knowledge as ExpertEvidenceSignals['knowledge'],
      unknownReferences: e.unknownReferences, observedRetrieval: observed && isObj(or) ? { binding: or.binding as NonNullable<ExpertEvidenceSignals['observedRetrieval']>['binding'], ...observed } as ExpertEvidenceSignals['observedRetrieval'] : null,
      assumptions: e.assumptions, crossReview: cross as ExpertEvidenceSignals['crossReview'] };
  });
  const pc = raw.packetCoverage, rv = raw.review;
  const omitted = isObj(pc) ? strArr(pc.omittedExpertIds, PROJECT_MAX, 80) : null;
  if (!experts || !isObj(pc) || !isBool(pc.supplied) || !isInt(pc.included) || !isInt(pc.total) || !omitted) return null;
  if (!isObj(rv) || !isInt(rv.completedOpinions) || !isInt(rv.reviewedOpinions) || !isInt(rv.reviewers) || typeof rv.disclosure !== 'string'
    || !(rv.status === 'not-run' || REVIEW_STATUSES.includes(rv.status as ProjectCrossReview['status']))) return null;
  return { schema: 'cloudbite.evidence-signals/v1', interpretation: clip(raw.interpretation, 1000), experts,
    packetCoverage: { supplied: pc.supplied, included: pc.included, total: pc.total, omittedExpertIds: omitted },
    review: { completedOpinions: rv.completedOpinions, reviewedOpinions: rv.reviewedOpinions, reviewers: rv.reviewers, status: rv.status as EvidenceSignals['review']['status'], disclosure: clip(rv.disclosure, 1000) } };
}
const roundOption = (o: unknown): RoundOption | null => isObj(o) && typeof o.id === 'string' && OPTION_ID.test(o.id) && typeof o.text === 'string' ? { id: o.id, text: clip(o.text, 2000) } : null;
const roundIds = (v: unknown) => strArr(v, PROJECT_MAX, 120);
function listDiff(v: unknown): { added: string[]; removed: string[]; unchanged: number } | null {
  if (!isObj(v) || !isInt(v.unchanged)) return null;
  const added = strArr(v.added, 50, 400), removed = strArr(v.removed, 50, 400);
  return added && removed ? { added, removed, unchanged: v.unchanged } : null;
}
/** 서버가 만든 이전 라운드 (src/cloudbite-revision.ts ProjectPreviousRound). 이전 의견은 참고 자료일 뿐 새 실행에 섞지 않는다 */
function normalizeRound(raw: unknown): ProjectPreviousRound | null {
  if (!isObj(raw) || raw.version !== 'project-round/v1' || typeof raw.parentId !== 'string' || !REVISION.parentId.test(raw.parentId) || typeof raw.changeSummary !== 'string') return null;
  const newRoles = roundIds(raw.newRoles), c = raw.comparison, r = raw.reference;
  if (!newRoles || !isObj(c) || !isObj(r) || c.semanticImpact !== 'not-analyzed') return null;
  const st = c.stage, rl = c.responseLanguage, op = c.options, docs = c.documents, roles = c.roles;
  if (!isObj(st) || !STAGES.includes(st.previous as ProjectStage) || !STAGES.includes(st.current as ProjectStage) || !isBool(st.changed)) return null;
  if (!isObj(rl) || !RESPONSE_LANGS.includes(rl.previous as ResponseLanguage) || !RESPONSE_LANGS.includes(rl.current as ResponseLanguage) || !isBool(rl.changed)) return null;
  if (!isObj(op) || !isObj(docs) || !isObj(roles)) return null;
  const previous = every(op.previous, 8, roundOption), current = every(op.current, 8, roundOption);
  const matches = every(op.exactTextMatches, 64, x => isObj(x) && typeof x.previous === 'string' && typeof x.current === 'string' ? { previous: clip(x.previous, 20), current: clip(x.current, 20) } : null);
  const constraints = listDiff(c.constraints), successCriteria = listDiff(c.successCriteria), unknowns = listDiff(c.unknowns);
  const docLists = (['added', 'removed', 'changed', 'unchanged'] as const).map(k => strArr(docs[k], DOCS.files * 2, 40));
  const docCurrent = every(docs.current, DOCS.files, d => isObj(d) && typeof d.id === 'string' && typeof d.name === 'string' && isInt(d.bytes) && typeof d.sha256 === 'string'
    ? { id: clip(d.id, 40), name: clip(d.name, 120), bytes: d.bytes, sha256: clip(d.sha256, 64) } : null);
  const roleLists = (['added', 'removed', 'kept'] as const).map(k => roundIds(roles[k]));
  if (!previous || !current || !matches || !constraints || !successCriteria || !unknowns || docLists.some(x => !x) || !docCurrent || roleLists.some(x => !x)) return null;
  const omission = (o: unknown): RoundOmission | null => isObj(o) && typeof o.path === 'string' && (o.omittedBytes === undefined || isInt(o.omittedBytes)) && (o.omittedItems === undefined || isInt(o.omittedItems))
    ? { path: clip(o.path, 120), ...(o.omittedBytes !== undefined ? { omittedBytes: o.omittedBytes as number } : {}), ...(o.omittedItems !== undefined ? { omittedItems: o.omittedItems as number } : {}) } : null;
  const opinions = every(r.opinions, PROJECT_MAX, o => {
    if (!isObj(o) || typeof o.expertId !== 'string' || typeof o.name !== 'string' || !isBool(o.selectedAgain) || !DIRECTIONS.includes(o.direction as OpinionDirection)
      || !isInt(o.confidence, 0, 100) || typeof o.summary !== 'string') return null;
    const evidence = strArr(o.evidence, 8, 500);
    return evidence ? { expertId: clip(o.expertId, 80), name: clip(o.name, 120), selectedAgain: o.selectedAgain, direction: o.direction as OpinionDirection, confidence: o.confidence, summary: clip(o.summary, 1500), evidence } : null;
  });
  const excluded = every(r.excluded, PROJECT_MAX, x => isObj(x) && typeof x.expertId === 'string' && EXPERT_STATUSES.includes(x.status as ExpertStatus) ? { expertId: clip(x.expertId, 80), status: x.status as ExpertStatus } : null);
  const omissions = every(r.omissions, 400, omission);
  if (r.label !== 'previous-round-reference' || r.trust !== 'untrusted-data' || r.parentId !== raw.parentId || !PROJECT_STATUSES.includes(r.parentStatus as ProjectStatus)
    || !opinions || !excluded || !omissions || !isInt(r.bytes)) return null;
  const [dAdded, dRemoved, dChanged, dUnchanged] = docLists as string[][], [rAdded, rRemoved, rKept] = roleLists as string[][];
  return { version: 'project-round/v1', parentId: raw.parentId, changeSummary: clip(raw.changeSummary, 4000), newRoles,
    comparison: { stage: { previous: st.previous as ProjectStage, current: st.current as ProjectStage, changed: st.changed },
      responseLanguage: { previous: rl.previous as ResponseLanguage, current: rl.current as ResponseLanguage, changed: rl.changed },
      options: { previous, current, exactTextMatches: matches }, constraints, successCriteria, unknowns,
      documents: { added: dAdded, removed: dRemoved, changed: dChanged, unchanged: dUnchanged, current: docCurrent },
      roles: { added: rAdded, removed: rRemoved, kept: rKept }, semanticImpact: 'not-analyzed' },
    reference: { label: 'previous-round-reference', trust: 'untrusted-data', parentId: raw.parentId, parentStatus: r.parentStatus as ProjectStatus, opinions, excluded, omissions, bytes: r.bytes } };
}

/** 후속 라운드 초안과 이전 프로젝트의 차이. 글자가 정확히 같은 것만 같다고 보고, 의미는 따지지 않는다 (서버의 previousRound 가 최종 비교다) */
interface DraftRound {
  stage: [ProjectStage, ProjectStage]; language: [ResponseLanguage | '', ResponseLanguage | ''];
  previous: string[]; current: string[]; decision: Partial<DecisionFrame>;
  docs: Array<{ name: string; content: string }>; roles: string[] | null;
}
function draftRoundLines(parent: ConsoleProject, d: DraftRound, m: Messages, name: NameOf): string[] {
  const t = m.p2, list = (x: string[]) => x.length ? x.join(', ') : m.none;
  const stage = (x: ProjectStage) => x === 'unspecified' ? m.wfStageNone : m.wfStageName[x];
  const lang = (x: ResponseLanguage | '') => x ? m.wfLangName[x] : m.wfLangNone;
  const opt = (i: number) => `option-${i + 1}`;
  const matches = d.current.flatMap((c, j) => d.previous.flatMap((p, i) => p === c ? [`${opt(i)} = ${opt(j)}`] : []));
  const diff = (f: 'constraints' | 'successCriteria' | 'unknowns') => {
    const a = parent.brief.decision?.[f] ?? [], b = d.decision[f] ?? [];
    return t.roundList(m.decisionField[f], b.filter(x => !a.includes(x)).length, a.filter(x => !b.includes(x)).length, b.filter(x => a.includes(x)).length);
  };
  const before = parent.brief.documents ?? [];
  const docName = (x: { name: string }) => x.name;
  const added = d.docs.filter(x => !before.some(y => y.name === x.name)).map(docName), removed = before.filter(y => !d.docs.some(x => x.name === y.name)).map(docName);
  const changed = d.docs.filter(x => before.some(y => y.name === x.name && y.content !== x.content)).map(docName);
  const same = d.docs.filter(x => before.some(y => y.name === x.name && y.content === x.content)).map(docName);
  const lines = [
    t.roundStage(stage(d.stage[0]), stage(d.stage[1]), d.stage[0] !== d.stage[1]),
    t.roundLang(lang(d.language[0]), lang(d.language[1]), d.language[0] !== d.language[1]),
    `${t.roundPrev}: ${d.previous.length ? d.previous.map((x, i) => `${opt(i)}: ${x}`).join(' | ') : m.none}`,
    `${t.roundCur}: ${d.current.length ? d.current.map((x, i) => `${opt(i)}: ${x}`).join(' | ') : m.none}`,
    matches.length ? t.roundMatches(matches.join(', ')) : t.roundNoMatches, t.roundPositional,
    diff('constraints'), diff('successCriteria'), diff('unknowns'),
    t.roundDocs(list(added), list(removed), list(changed), list(same)),
  ];
  if (d.roles) {
    const was = parent.brief.expertIds;
    lines.push(t.roundRoles(list(d.roles.filter(x => !was.includes(x)).map(name)), list(was.filter(x => !d.roles!.includes(x)).map(name)), list(d.roles.filter(x => was.includes(x)).map(name))));
  }
  return lines;
}
/** 사용 기록 상세에서 후속 라운드를 시작할 수 있는 프로젝트: 끝난 실제 실행이고 삭제 표시가 없다 */
function followUpEligible(p: ConsoleProject): boolean {
  return p.brief.mode === 'live' && TERMINAL_PROJECT.includes(p.status) && REVISION.parentId.test(p.id) && p.brief.title !== '[deleted]' && p.brief.objective !== '[deleted]';
}

// ───────── 화면·보고서가 같이 쓰는 줄 (사전 글자만 쓴다. 숫자가 없는 칸은 UNKNOWN 이지 0 이 아니다)
type NameOf = (id: string) => string;
function signalRows(s: ExpertEvidenceSignals, m: Messages): Array<[string, string | null]> {
  const t = m.p2, o = s.observedRetrieval, c = s.crossReview;
  return [
    [t.sigSelf, `${s.selfAssessedConfidence}%`],
    [t.sigEvidence, t.sigEvidenceVal(s.evidenceItems, s.unreferencedEvidenceItems)],
    [t.sigRefs, t.sigRefsVal(s.references.total, s.references.document, s.references.workspace, s.references.knowledge)],
    [t.sigSupplied, t.sigSuppliedVal(s.suppliedText.available, s.suppliedText.missing)],
    [t.sigKnowledge, t.sigKnowledgeVal(s.knowledge.curatedCardText, s.knowledge.curatedCardTextOmitted, s.knowledge.retrievalUnverified, s.knowledge.notRetrieved)],
    [t.sigUnknownIds, String(s.unknownReferences)],
    [t.sigAssumptions, String(s.assumptions)],
    [t.sigRetrieval, o ? t.sigRetrievalVal(o.binding, o.retrievals, o.cards, o.sources) : null],
    [t.sigCross, c ? t.sigCrossVal(c.findings, c.reviewers, c.supported, c.challenged, c.insufficient, c.evidenceItemsReviewed) : null],
  ];
}
function signalSummary(sg: EvidenceSignals, m: Messages, name: NameOf): string[] {
  const t = m.p2, pc = sg.packetCoverage, rv = sg.review;
  return [
    pc.supplied ? t.sigPackets(pc.included, pc.total) : t.sigPacketsUnknown,
    ...(pc.supplied && pc.omittedExpertIds.length ? [t.sigOmitted(pc.omittedExpertIds.length, pc.omittedExpertIds.map(name).join(', '))] : []),
    t.sigReview(rv.reviewedOpinions, rv.completedOpinions, rv.reviewers, t.sigReviewStatus[rv.status]), rv.disclosure,
  ];
}
function memoCoverageLines(c: MemoCoverage, m: Messages): string[] {
  const t = m.p2, shortened = c.experts.filter(e => e.summaryTruncated || e.itemsTruncated > 0 || e.evidenceIncluded.length < e.evidenceTotal).length;
  return [
    t.memoCovTeam(c.completed, c.teamSize),
    t.memoCovDirections(DIRECTIONS.map(d => `${m.direction[d]} ${c.statedDirections[d]}`).join(' · ')),
    t.memoCovReviews(c.reviews.included, c.reviews.total, c.reviews.truncated, c.reviews.omitted, c.reviews.reports),
    t.memoCovPackets(c.packets.included, c.packets.total, c.packets.truncated, c.packets.omitted, c.packets.invalid, c.packets.metadataOnly),
    t.memoCovDocs(c.documents.length, c.documents.filter(d => d.truncated).length),
    t.memoCovExperts(shortened),
    t.memoCovBrief(c.brief.decisionItemsTruncated + (c.brief.objectiveTruncated ? 1 : 0) + (c.brief.contextTruncated ? 1 : 0), c.brief.decisionItemsOmitted),
    ...(c.brief.revisionTruncated ? [t.memoCovRevision] : []),
    t.memoCovLimits,
  ];
}
function memoRefText(p: ConsoleProject, r: MemoReference, m: Messages, name: NameOf): string {
  const t = m.p2;
  if (r.kind === 'opinion-evidence') return t.refOpinion(name(r.expertId), r.index + 1);
  if (r.kind === 'document') return t.refDocument(r.id, p.brief.documents?.find(d => d.id === r.id)?.name ?? '');
  if (r.kind === 'packet') return t.refPacket(r.id);
  if (r.kind === 'review-finding') return t.refReview(name(r.reviewerExpertId), r.index + 1);
  return t.refBrief(r.field);
}
function roundLines(r: ProjectPreviousRound, m: Messages, name: NameOf): string[] {
  const t = m.p2, c = r.comparison, list = (x: string[]) => x.length ? x.join(', ') : m.none;
  const stage = (s: ProjectStage) => s === 'unspecified' ? m.wfStageNone : m.wfStageName[s];
  const matches = c.options.exactTextMatches.map(x => `${x.previous} = ${x.current}`).join(', ');
  const omitted = r.reference.omissions;
  return [
    t.roundStage(stage(c.stage.previous), stage(c.stage.current), c.stage.changed),
    t.roundLang(m.wfLangName[c.responseLanguage.previous], m.wfLangName[c.responseLanguage.current], c.responseLanguage.changed),
    `${t.roundPrev}: ${c.options.previous.length ? c.options.previous.map(o => `${o.id}: ${o.text}`).join(' | ') : m.none}`,
    `${t.roundCur}: ${c.options.current.length ? c.options.current.map(o => `${o.id}: ${o.text}`).join(' | ') : m.none}`,
    matches ? t.roundMatches(matches) : t.roundNoMatches, t.roundPositional,
    t.roundList(m.decisionField.constraints, c.constraints.added.length, c.constraints.removed.length, c.constraints.unchanged),
    t.roundList(m.decisionField.successCriteria, c.successCriteria.added.length, c.successCriteria.removed.length, c.successCriteria.unchanged),
    t.roundList(m.decisionField.unknowns, c.unknowns.added.length, c.unknowns.removed.length, c.unknowns.unchanged),
    t.roundDocs(list(c.documents.added), list(c.documents.removed), list(c.documents.changed), list(c.documents.unchanged)),
    t.roundRoles(list(c.roles.added.map(name)), list(c.roles.removed.map(name)), list(c.roles.kept.map(name))),
    ...(r.reference.excluded.length ? [t.roundExcluded(r.reference.excluded.map(x => `${name(x.expertId)} (${m.status[x.status]})`).join(', '))] : []),
    ...(omitted.length ? [t.roundOmissions(omitted.length, omitted.slice(0, 12).map(o => o.path).join(', ') + (omitted.length > 12 ? ', …' : ''))] : []),
  ];
}
/** 교차 검토를 걸 수 있는 프로젝트: 취소되지 않고 끝났으며 의견을 낸 완료 전문가가 2명 이상 (서버와 같은 조건) */
function reviewEligible(p: ConsoleProject): boolean {
  return TERMINAL_PROJECT.includes(p.status) && p.status !== 'cancelled' && p.experts.filter(e => e.status === 'completed' && !!e.opinion).length >= 2;
}

/** 폼 오류. field 로 접힌 Project details 를 펼칠지 정하고, text 는 그릴 때의 언어로 바꾼다 */
interface FormIssue { field: 'title' | 'objective' | 'context' | 'decision' | 'docs' | 'experts' | 'budget' | 'revision' | 'run'; text: Text }
function validateForm(f: FormInput, limits: Limits): FormIssue[] {
  const errors: FormIssue[] = [];
  if (!f.title.trim()) errors.push({ field: 'title', text: m => m.vTitle });
  if (f.title.length > LIMIT.title) errors.push({ field: 'title', text: m => m.vTitleLong(LIMIT.title) });
  if (!f.objective.trim()) errors.push({ field: 'objective', text: m => m.vObjective });
  if (f.objective.length > LIMIT.objective) errors.push({ field: 'objective', text: m => m.vObjectiveLong(LIMIT.objective) });
  if (f.context.length > LIMIT.context) errors.push({ field: 'context', text: m => m.vContextLong(LIMIT.context) });
  if (f.expertIds.length < limits.min) errors.push({ field: 'experts', text: m => m.vMin(limits.min) });
  if (f.expertIds.length > limits.max) errors.push({ field: 'experts', text: m => m.vMax(limits.max) });
  return errors;
}

// ───────────────────────── 종합 (완료된 유효 의견만) ─────────────────────────

function aggregate(p: ConsoleProject, m: Messages = EN): Aggregate {
  const counts: Record<OpinionDirection, number> = { support: 0, conditional: 0, concern: 0, abstain: 0 };
  const buckets = [0, 0, 0, 0, 0];
  const actionMap = new Map<string, { text: string; count: number; names: string[]; conf: number }>();
  const supportVoices: Aggregate['supportVoices'] = [], concernVoices: Aggregate['concernVoices'] = [];
  let completed = 0, valid = 0, invalid = 0, failed = 0, pending = 0, cancelled = 0, confSum = 0;
  for (const e of p.experts) {
    if (e.status === 'failed') { failed++; continue; }
    if (e.status === 'cancelled') { cancelled++; continue; }
    if (e.status !== 'completed') { pending++; continue; }
    completed++;
    const o = e.opinion;
    if (!o) { invalid++; continue; }
    valid++;
    counts[o.direction]++;
    confSum += o.confidence;
    buckets[Math.min(4, Math.floor(o.confidence / 20))]++;
    const voice = { name: e.name, confidence: o.confidence, summary: o.summary };
    if (o.direction === 'support') supportVoices.push(voice);
    if (o.direction === 'concern') concernVoices.push(voice);
    for (const a of o.nextActions) {
      const key = a.replace(/\s+/g, ' ').trim().toLowerCase();
      const cur = actionMap.get(key);
      if (cur) { cur.count++; if (!cur.names.includes(e.name)) cur.names.push(e.name); cur.conf = Math.max(cur.conf, o.confidence); }
      else actionMap.set(key, { text: a, count: 1, names: [e.name], conf: o.confidence });
    }
  }
  const byConf = (a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence;
  supportVoices.sort(byConf); concernVoices.sort(byConf);
  let leading: OpinionDirection | null = null;
  for (const d of DIRECTIONS) if (counts[d] > 0 && (leading === null || counts[d] > counts[leading])) leading = d;
  const tie = leading !== null && DIRECTIONS.filter(d => counts[d] === counts[leading!]).length > 1;
  const disagreement = counts.support > 0 && counts.concern > 0;
  const actions = [...actionMap.values()].sort((a, b) => b.count - a.count || b.conf - a.conf).slice(0, 5)
    .map(({ text, count, names }) => ({ text, count, names }));
  let headline = m.hNone;
  if (valid > 0 && leading) {
    const base = tie ? m.hTie : leading === 'support' ? m.hSupport : leading === 'conditional' ? m.hConditional : leading === 'concern' ? m.hConcern : m.hAbstain;
    headline = valid < p.experts.length ? m.hPartial(base, valid, p.experts.length) : base;
  }
  return {
    selected: p.experts.length, completed, valid, invalid, failed, pending, cancelled, counts,
    meanConfidence: valid ? Math.round(confSum / valid) : null, buckets, leading: tie ? null : leading, disagreement,
    supportVoices: supportVoices.slice(0, 2), concernVoices: concernVoices.slice(0, 2), actions, headline,
  };
}

// ───────────────────────── 브라우저 데모 (시뮬레이션) ─────────────────────────

const DEMO_SOURCE = { repository: 'cloudbite built-in demo', path: 'client/cloudbite-console.ts', revision: 'demo', license: 'demo', basis: 'metadata-derived' as const };
const DEMO_EXPERTS: ExpertDefinition[] = [
  ['demo-product-strategist', 'Product Strategist', 'Product strategy', 'Judges launch scope, phasing and differentiation against alternatives.'],
  ['demo-business-model', 'Business Model Expert', 'Business & finance', 'Reviews pricing, unit economics and how inference costs are recovered.'],
  ['demo-ai-trust', 'AI Ethics & Trust Expert', 'AI trust', 'Checks evidence labelling, liability limits and safeguards for high-risk domains.'],
  ['demo-data-validation', 'Data Validation Expert', 'Data quality', 'Examines source quality and whether the evidence behind opinions can be verified.'],
  ['demo-ux-research', 'UX Researcher', 'User experience', 'Looks at the first-use flow, clarity and time to user value.'],
  ['demo-security-compliance', 'Security & Compliance Expert', 'Security & regulation', 'Reviews data handling, access control and regulatory requirements.'],
].map(([id, name, domain, summary]) => ({
  id, name, domain, summary,
  prompt: `You are "${name}", an AI role in the Cloudbite demo. You are not a real person and your output is not an endorsement. ${summary} Read the shared project documents and write your role's recommendation, evidence, assumptions, self-assessed confidence and next actions to out/result.json.`,
  tools: ['read_file', 'write_file', 'python'], outputs: ['out/notes.md', 'out/result.json', 'out/report.md'], source: DEMO_SOURCE,
}));

type Archetype = 'strategy' | 'business' | 'trust' | 'data' | 'ux' | 'security' | 'generic';
function archetypeOf(e: ExpertDefinition): Archetype {
  const t = `${e.id} ${e.name} ${e.domain}`.toLowerCase();
  if (/전략|strateg|product|제품/.test(t)) return 'strategy';
  if (/비즈니스|재무|사업|가격|finance|business|pricing/.test(t)) return 'business';
  if (/윤리|신뢰|ethic|trust|safety/.test(t)) return 'trust';
  if (/데이터|data|검증|analy/.test(t)) return 'data';
  if (/ux|사용자|디자인|design|research/.test(t)) return 'ux';
  if (/보안|규제|컴플라|법|security|legal|compliance|privacy/.test(t)) return 'security';
  return 'generic';
}

function has(text: string, words: string[]): boolean { return words.some(w => text.includes(w)); }
function quote(s: string, n = 48): string { const t = s.replace(/\s+/g, ' ').trim(); return t ? `“${clip(t, n)}”` : '“(empty)”'; }

interface DemoWork { steps: Array<[ExpertActivity['kind'], string]>; notes: string; opinion: ExpertOpinion }
function demoWork(e: ExpertDefinition, b: ProjectBrief, h: number): DemoWork {
  // 키워드는 영어·한국어 둘 다 본다 (브리프를 어느 언어로 써도 결정적으로 반응)
  const all = `${b.title}\n${b.objective}\n${b.context}`.toLowerCase();
  const jitter = (base: number, span: number) => base + (h % span);
  const ctx = b.context.trim() ? quote(b.context) : 'no context given';
  const obj = quote(b.objective);
  let direction: OpinionDirection, confidence: number, summary: string;
  let steps: DemoWork['steps'], evidence: string[], assumptions: string[], nextActions: string[];
  switch (archetypeOf(e)) {
    case 'strategy': {
      const fast = has(all, ['2 weeks', '4 weeks', 'two weeks', 'four weeks', '2-week', '4-week', 'fast', 'quick', '2주', '4주', '빠르', '단기']);
      const wide = has(all, ['100', 'every', 'entire', 'all roles', '전체', '모든']);
      direction = fast || wide ? 'conditional' : 'support';
      confidence = jitter(fast && wide ? 70 : 64, 14);
      summary = fast && wide ? 'The timeline is short and the scope is wide. Launch in phases, narrowing to the core roles first.'
        : wide ? 'The scope is wide. Validate with the core roles first, then expand.'
          : 'Objective and scope fit together; this is ready to execute.';
      steps = [
        ['tool', `python scope_matrix.py — split objective ${obj} into feature, scope and schedule axes`],
        ['thought', wide ? 'Many roles widen quality variance in week one. Review the top 20 roles first' : 'Narrow scope keeps first-launch risk low'],
        ['tool', 'write_file out/notes.md — comparison table of three phased launch options'],
      ];
      evidence = [`Objective ${obj}`, fast ? 'The brief mentions a short timeline' : 'No schedule constraint is stated', wide ? 'The brief uses wide-scope wording' : 'The scope is narrowly defined'];
      assumptions = ['Assumes a single first user group', 'Feature-by-feature comparison with competitors is out of scope'];
      nextActions = ['Limit the first launch to 20 core roles', 'Set two-week launch checkpoints'];
      break;
    }
    case 'business': {
      const paid = has(all, ['paid', 'subscription', 'freemium', 'pricing', 'billing', '유료', '구독', '과금']);
      const free = has(all, ['free', '무료']) && !paid;
      direction = free ? 'concern' : paid ? 'support' : 'conditional';
      confidence = jitter(free ? 72 : paid ? 66 : 58, 12);
      summary = free ? 'A free-only model has no way to recover inference costs that grow with every expert.'
        : paid ? 'There is a paid conversion path; with usage limits in place the unit economics work.'
          : 'No revenue model is defined yet, so start with pricing experiments.';
      steps = [
        ['tool', 'python unit_economics.py --experts 5 --rounds 3 — estimate inference cost per opinion'],
        ['thought', free ? 'Cost per free user grows linearly with no cap' : paid ? 'With partial paid plans, the top 10% of users offset costs' : 'Three pricing hypotheses need comparing'],
        ['tool', 'write_file out/notes.md — break-even table per pricing scenario'],
      ];
      evidence = [free ? 'The brief mentions only a free model' : paid ? 'The brief mentions a paid conversion path' : 'No revenue model mentioned', `Context ${ctx}`];
      assumptions = ['About three inference rounds per expert', 'Model unit prices are demo assumptions, not real quotes'];
      nextActions = ['Set usage limits and a price ceiling first', 'Limit the first launch to 20 core roles'];
      break;
    }
    case 'trust': {
      const risky = has(all, ['medical', 'legal', 'investment', 'financial', 'diagnos', '의료', '법률', '투자', '금융', '진단']);
      const sourced = has(all, ['source', 'evidence', 'citation', 'verif', '출처', '근거', '검증']);
      direction = risky ? 'concern' : sourced ? 'conditional' : 'concern';
      confidence = jitter(risky ? 78 : 61, 12);
      summary = risky ? 'The advice touches high-risk domains. Do not publish without liability limits and human expert review.'
        : sourced ? 'The intent to cite evidence is there. Document source-quality criteria and you can proceed.'
          : 'There is no standard for citing evidence per opinion, so trust is hard to explain.';
      steps = [
        ['tool', 'read_file PROJECT.md — scan for high-risk domain keywords'],
        ['thought', risky ? 'High-risk domain wording found: disclaimer and human review required' : 'No high-risk domain wording; evidence labelling is the key issue'],
        ['tool', 'write_file out/notes.md — draft evidence-labelling checklist'],
      ];
      evidence = [risky ? 'The brief contains high-risk domain wording' : 'No high-risk domain wording', sourced ? 'Evidence or sources are mentioned' : 'No evidence or source standard mentioned'];
      assumptions = ['Assumes users are told AI role opinions are not real expert endorsements'];
      nextActions = ['Document an evidence and source labelling standard per opinion', risky ? 'Publish high-risk topics only after human expert review' : 'Show the AI-role disclosure on the first screen'];
      break;
    }
    case 'data': {
      const sourced = has(all, ['data', 'evidence', 'source', 'metric', '데이터', '근거', '출처', '지표']);
      direction = sourced ? 'support' : 'conditional';
      confidence = jitter(sourced ? 69 : 55, 15);
      summary = sourced ? 'The plan clearly intends to use evidence. Add an automated verification pipeline.'
        : 'The evidence behind opinions is not defined. Start with verifiable metrics.';
      steps = [
        ['tool', 'python claim_check.py PROJECT.md — count verifiable claims'],
        ['thought', sourced ? 'Verifiable claims exist, so sampling checks are possible' : 'No quantitative metric, so there is no baseline for comparison'],
        ['tool', 'write_file out/notes.md — metric definitions and sampling procedure'],
      ];
      evidence = [`Objective ${obj}`, sourced ? 'The brief mentions data or evidence' : 'No quantitative metric mentioned'];
      assumptions = ['Assumes an initial sample of 30 items is enough to check opinion quality'];
      nextActions = ['Document an evidence and source labelling standard per opinion', 'Check a weekly sample of 30 opinions'];
      break;
    }
    case 'ux': {
      const simple = has(all, ['simple', 'easy', 'beginner', 'first-time', 'onboarding', '간단', '쉽', '초보', '처음']);
      direction = simple ? 'support' : 'conditional';
      confidence = jitter(simple ? 67 : 60, 14);
      summary = simple ? 'Aiming for an easy first experience should get users to value quickly.'
        : 'The more experts, the harder results are to read. Use a summary-then-evidence structure.';
      steps = [
        ['tool', 'python flow_walkthrough.py — count steps from first question to understanding results'],
        ['thought', simple ? 'Three steps to the first result, good' : 'Comparing opinions on the results screen risks getting long'],
        ['tool', 'write_file out/notes.md — first-use flow storyboard'],
      ];
      evidence = [`Objective ${obj}`, simple ? 'The brief asks for an easy experience' : 'No usage-flow requirement mentioned'];
      assumptions = ['Assumes first-time users read the summary before raw opinions'];
      nextActions = ['Show the synthesis first and let users expand the evidence', 'Run usability tests with 5 early users'];
      break;
    }
    case 'security': {
      const sensitive = has(all, ['enterprise', 'personal data', 'customer data', 'b2b', 'internal', 'pii', '기업', '개인정보', '고객 데이터', '사내']);
      direction = sensitive ? 'concern' : 'conditional';
      confidence = jitter(sensitive ? 74 : 57, 12);
      summary = sensitive ? 'Customer data is copied into every expert workspace. Do not proceed without isolation and retention policies.'
        : 'No sensitive data is mentioned, but a retention period per workspace still has to be set.';
      steps = [
        ['tool', 'python data_flow.py — trace how the brief is copied into each workspace'],
        ['thought', sensitive ? 'Sensitive data wording found: exposure grows with the number of workspaces' : 'No sensitive data wording'],
        ['tool', 'write_file out/notes.md — draft data retention and deletion policy'],
      ];
      evidence = [sensitive ? 'The brief mentions enterprise or personal data' : 'No sensitive data wording', 'Workspaces are separated per expert'];
      assumptions = ['Assumes workspaces are deleted after the run ends'];
      nextActions = ['Confirm workspace data retention and deletion steps', sensitive ? 'Anonymise customer data before use' : 'Define an access-log retention policy'];
      break;
    }
    default: {
      const pick = h % 3;
      direction = (['support', 'conditional', 'concern'] as const)[pick];
      confidence = jitter(52, 25);
      const field = domainLabel(e.domain).toLowerCase();
      summary = `${DIRECTION_LABEL[direction]} opinion from a ${field} perspective. Reviewed the premises of objective ${obj} against the role's criteria.`;
      steps = [
        ['tool', `read_file PROJECT.md — extract issues from a ${field} perspective`],
        ['thought', `List the largest uncertainty by ${field} criteria`],
        ['tool', 'write_file out/notes.md — role review notes'],
      ];
      evidence = [`Objective ${obj}`, `Context ${ctx}`];
      assumptions = ['Role definition is based on catalogue metadata'];
      nextActions = [`Validate the key ${field} assumptions`];
    }
  }
  confidence = Math.max(0, Math.min(100, confidence));
  const notes = [`# ${e.name} working notes (browser demo)`, '', `Project: ${b.title}`, `Objective: ${b.objective}`, '',
    '## Review steps', ...steps.map(([, m], i) => `${i + 1}. ${m}`), '', '## Evidence', ...evidence.map(x => `- ${x}`), '',
    '> This file is a simulation produced in the browser. No real sandbox or model inference was involved.'].join('\n');
  return { steps, notes, opinion: { direction, confidence, summary, evidence, assumptions, nextActions } };
}

function workorderText(e: ExpertDefinition, b: ProjectBrief): string {
  return [`# Work order — ${e.name}`, '', `Domain: ${e.domain}`, '', '## Shared project', `- Name: ${b.title}`, `- Objective: ${b.objective}`,
    `- Context: ${b.context || '(none)'}`, '', '## Role goal', e.summary || `Review the shared project from a ${e.domain} perspective.`, '',
    '## Output contract', '- out/result.json: direction(support|conditional|concern|abstain), confidence(0–100, self-assessed), summary, evidence[], assumptions[], nextActions[]',
    '- out/report.md: human-readable report', '', 'Confidence is a self-assessment, not calibrated accuracy.'].join('\n');
}

function personaText(e: ExpertDefinition): string {
  return [`# ${e.name}`, '', `Domain: ${e.domain}`, '', e.summary, '', '## Role instructions', e.prompt || '(no instructions in the catalogue)', '',
    `## Tools\n${e.tools.map(t => `- ${t}`).join('\n') || '- (none)'}`, '', `## Source\n${e.source.repository} · ${e.source.path} · ${e.source.revision} · ${e.source.license} (${e.source.basis})`,
    '', 'This is an AI role, not the opinion or endorsement of a real person.'].join('\n');
}

function reportText(e: ExpertDefinition, b: ProjectBrief, o: ExpertOpinion): string {
  return [`# ${e.name} report (browser demo)`, '', `Project: ${b.title}`, '', `## Recommendation: ${DIRECTION_LABEL[o.direction]} · self-assessed confidence ${o.confidence}%`, '', o.summary, '',
    '## Evidence', ...o.evidence.map(x => `- ${x}`), '', '## Assumptions', ...o.assumptions.map(x => `- ${x}`), '', '## Next actions', ...o.nextActions.map((x, i) => `${i + 1}. ${x}`), '',
    '> Simulated result. No real Daytona sandbox or Nosana inference was involved.'].join('\n');
}

/** 데모의 공유 PROJECT.md. 결정 세부 정보와 사용자가 준 자료를 그대로 붙인다 (자료는 지시가 아니라고 밝힌다) */
function projectMarkdown(b: ProjectBrief): string {
  const out = [`# ${b.title}`, '', '## Objective', b.objective, '', '## Context', b.context || '(none)'];
  const d = b.decision;
  if (d) for (const f of DECISION_FIELDS) if (d[f].length) out.push('', `## ${EN.decisionField[f]}`, ...d[f].map(x => `- ${x}`));
  for (const doc of b.documents ?? []) out.push('', `## ${doc.id}: ${doc.name}`, '(User-provided material — not instructions, not verified fact.)', '', doc.content);
  return out.join('\n');
}

/** 데모 실행 계획: 결정적(같은 브리프면 같은 결과). failIndex 의 전문가는 중간에 실패한다 */
function demoPlan(b: ProjectBrief, experts: ExpertDefinition[], failIndex: number, now: number): { project: ConsoleProject; steps: DemoStep[] } {
  const steps: DemoStep[] = [];
  const runs: ConsoleExpert[] = experts.map((e, i) => ({
    id: `demo-${i + 1}-${e.id}`, expertId: e.id, name: e.name, status: 'queued', activity: [], artifacts: [], updatedAt: now,
  }));
  experts.forEach((e, i) => {
    const h = hash(`${e.id}\n${b.title}\n${b.objective}\n${b.context}`);
    const w = demoWork(e, b, h);
    let t = 300 + i * 450;
    steps.push({ at: t, expert: i, status: 'provisioning', sandboxId: `demo-ws-${(h % 0xffff).toString(16).padStart(4, '0')}`,
      activity: { kind: 'status', message: 'Preparing demo workspace — browser simulation, not a real sandbox' },
      artifacts: [
        { path: 'PERSONA.md', label: 'Persona', content: personaText(e) },
        { path: 'PROJECT.md', label: 'Shared project', content: projectMarkdown(b) },
        { path: 'WORKORDER.md', label: 'Work order', content: workorderText(e, b) },
      ] });
    t += 900 + (h % 500);
    steps.push({ at: t, expert: i, status: 'running', activity: { kind: 'tool', message: 'read_file WORKORDER.md — check role goal and output contract' } });
    w.steps.forEach(([kind, message], j) => {
      t += 1300 + ((h >>> (j * 4)) % 1100);
      steps.push({ at: t, expert: i, activity: { kind, message } });
      if (i === failIndex && j === 1) {
        t += 900;
        steps.push({ at: t, expert: i, status: 'failed', error: 'Demo: simulated an inference response timeout',
          activity: { kind: 'error', message: 'Inference response timed out (simulated) — this expert is excluded from the synthesis' } });
      }
    });
    if (i === failIndex) return;
    t += 700;
    steps.push({ at: t, expert: i, activity: { kind: 'artifact', message: 'Wrote out/notes.md' },
      artifacts: [{ path: 'out/notes.md', label: 'Working notes', content: w.notes }] });
    t += 1000 + (h % 600);
    steps.push({ at: t, expert: i, status: 'completed', opinion: w.opinion,
      activity: { kind: 'artifact', message: `Submitted out/result.json — ${DIRECTION_LABEL[w.opinion.direction]} · confidence ${w.opinion.confidence}%` },
      artifacts: [
        { path: 'out/result.json', label: 'Result JSON', content: JSON.stringify(w.opinion, null, 2) },
        { path: 'out/report.md', label: 'Report', content: reportText(e, b, w.opinion) },
      ] });
  });
  steps.sort((a, b2) => a.at - b2.at);
  const project: ConsoleProject = { id: `demo-${hash(b.requestId).toString(36)}`, brief: b, status: 'running', experts: runs, createdAt: now, updatedAt: now };
  return { project, steps };
}

function applyStep(p: ConsoleProject, s: DemoStep, now: number): ConsoleProject {
  const experts = p.experts.map((e, i) => {
    if (i !== s.expert || TERMINAL_EXPERT.includes(e.status)) return e;
    const next: ConsoleExpert = { ...e, updatedAt: now, activity: e.activity.slice(), artifacts: e.artifacts.slice() };
    if (s.status) next.status = s.status;
    if (s.sandboxId) next.sandboxId = s.sandboxId;
    if (s.error) next.error = s.error;
    if (s.opinion) next.opinion = s.opinion;
    if (s.activity) next.activity.push({ id: `${e.id}-${next.activity.length}`, at: now, ...s.activity });
    for (const a of s.artifacts ?? []) {
      const k = next.artifacts.findIndex(x => x.path === a.path);
      if (k >= 0) next.artifacts[k] = a; else next.artifacts.push(a);
    }
    return next;
  });
  return { ...p, experts, status: statusFromExperts(experts), updatedAt: now };
}

function cancelProject(p: ConsoleProject, now: number): ConsoleProject {
  const experts = p.experts.map(e => TERMINAL_EXPERT.includes(e.status) ? e : {
    ...e, status: 'cancelled' as const, updatedAt: now,
    activity: [...e.activity, { id: `${e.id}-${e.activity.length}`, at: now, kind: 'status' as const, message: 'The user stopped the project' }],
  });
  return { ...p, experts, status: 'cancelled', updatedAt: now };
}

// ───────────────────────── 내보내기 ─────────────────────────

/** 머리말·제목은 화면 언어로, 브리프·의견·오류 원문은 받은 그대로 */
function markdownReport(p: ConsoleProject, demo: boolean, m: Messages = EN): string {
  const a = aggregate(p, m);
  const lines = [`# ${p.brief.title}`, '', demo ? m.mdDemo : m.mdLive, '',
    `## ${m.mdObjective}`, p.brief.objective, '', `## ${m.mdContext}`, p.brief.context || m.none, '',
    `## ${m.mdSynthesis}`, `- ${m.mdStatus(m.projectStatus[p.status])}`, `- ${m.mdCounts(a)}`,
    `- ${DIRECTIONS.map(d => `${m.direction[d]} ${a.counts[d]}`).join(' · ')}`,
    `- ${m.mdMean(a.meanConfidence === null ? '—' : a.meanConfidence + '%')}`, '', a.headline, '', `## ${m.mdNext}`,
    ...(a.actions.length ? a.actions.map((x, i) => `${i + 1}. ${x.text} (${x.names.join(', ')})`) : [m.none]), '', `## ${m.mdByExpert}`];
  for (const e of p.experts) {
    lines.push('', `### ${e.name} — ${m.status[e.status]}`);
    if (e.opinion) lines.push(m.mdOpinion(m.direction[e.opinion.direction], e.opinion.confidence), '', e.opinion.summary);
    else if (e.error) lines.push(m.mdError(e.error));
    else if (e.invalidOpinion) lines.push(m.mdInvalid);
  }
  if (!demo) lines.push(...phaseTwoMarkdown(p, m));
  return lines.join('\n') + '\n';
}

/** 이전 라운드·관찰 신호·교차 검토 범위·결정 메모. 서버가 저장한 것만 쓰고, 없거나 읽을 수 없으면 그렇다고 적는다 */
function phaseTwoMarkdown(p: ConsoleProject, m: Messages): string[] {
  const t = m.p2, name: NameOf = id => p.experts.find(e => e.expertId === id)?.name ?? p.previousRound?.reference.opinions.find(o => o.expertId === id)?.name ?? id;
  const out: string[] = [];
  const r = p.previousRound;
  if (r || p.invalidRound) {
    out.push('', `## ${t.roundTitle}`);
    if (!r) out.push(t.roundInvalid);
    else {
      out.push(t.roundOf(r.parentId), '', `> ${t.roundNote}`, '', `### ${t.roundChange}`, r.changeSummary, '', ...roundLines(r, m, name).map(x => `- ${x}`));
      if (r.reference.opinions.length) {
        out.push('', `### ${t.roundRefs(r.reference.opinions.length)}`);
        for (const o of r.reference.opinions) out.push(`- **${o.name}**${o.selectedAgain ? ` (${t.roundAgain})` : ''}: ${t.roundOpinion(m.direction[o.direction], o.confidence)} — ${o.summary}`);
      }
    }
  }
  const t3 = m.p3, plan = r?.authorResponse;
  if (plan || p.invalidAuthorPlan) {
    out.push('', `## ${t3.arTitle}`);
    if (!plan) out.push(t3.arPlanInvalid);
    else {
      out.push(`> ${t3.arNote}`, '', `- ${t3.arCapped(plan.capped.included, plan.capped.eligibleSelected)}`,
        ...(plan.unselectedAuthors.length ? [`- ${t3.arUnselected(plan.unselectedAuthors.map(name).join(', '))}`] : []), `- ${plan.disclosure}`);
      for (const a of authorResponseLines(plan, p.experts, m, name)) out.push('', `### ${a.author}`, `- ${a.original}`, `- ${a.head} (${t3.arSeparate})`, ...a.lines.map(x => `- ${x}`));
    }
  }
  if (p.provenance || p.invalidProvenance) {
    out.push('', `## ${t3.mdProvTitle}`);
    if (!p.provenance) out.push(t3.provInvalid);
    else {
      const g = provenanceGroups(p.provenance), claim = (c: LedgerClaim) => `- ${c.text}${c.expertId ? ` _(${name(c.expertId)})_` : ''}`;
      out.push(`> ${t3.provNote}`, '', ...provenanceLines(p.provenance, m).map(x => `- ${x}`), `- ${t3.provMemoNote}`);
      for (const k of ['adopted', 'hinted'] as const) if (g[k].length) out.push('', `### ${t3.provGroup[k]}`, ...g[k].map(claim));
    }
  }
  out.push('', `## ${t.sigTitle}`);
  const sg = p.evidenceSignals;
  if (p.invalidSignals) out.push(t.sigInvalid);
  else if (!sg) out.push(t.sigMissing);
  else {
    out.push(`> ${t.sigNote}`, '', sg.interpretation, '', ...signalSummary(sg, m, name).map(x => `- ${x}`));
    for (const e of sg.experts) out.push('', `### ${name(e.expertId)}`, ...signalRows(e, m).map(([k, v]) => `- ${k}: ${v ?? t.unknown}`));
  }
  const cr = p.crossReview;
  if (cr) {
    out.push('', `## ${m.reviewTitle}`, `- ${m.projectStatus[cr.status === 'running' ? 'running' : cr.status === 'failed' ? 'failed' : 'completed']}`);
    if (cr.coverage) {
      const c = cr.coverage;
      out.push(`- ${t.revCoverage(c.reviewers, c.maxReviewers, c.maxPeersPerReviewer, c.assignedOpinions, c.completedOpinions)}`);
      if (c.unassigned.length) out.push(`- ${t.revUnassigned(c.unassigned.map(name).join(', '))}`);
    }
    out.push(`- ${t.revCap}`, ...(cr.disclosure ? [`- ${cr.disclosure}`] : []));
    out.push(...artifactLines(cr, m, name).map(x => `- ${x}`));
    for (const rep of cr.reports) for (const f of rep.findings) {
      const basis = cr.textAvailability?.find(x => x.reviewerExpertId === rep.reviewerExpertId && x.targetExpertId === f.targetExpertId && x.evidenceIndex === f.evidenceIndex);
      out.push(`- ${m.reviewBy(name(rep.reviewerExpertId))} · ${m.verdict[f.verdict]} · ${m.reviewFinding(name(f.targetExpertId), f.evidenceIndex + 1)}${basis ? ` (${t.revBasis[basis.textBasis]})` : ''}${f.rationale ? ` — ${f.rationale}` : ''}`);
    }
  }
  out.push('', `## ${t.memoTitle}`);
  const pm = p.memo;
  if (p.invalidMemo) out.push(t.memoInvalid);
  else if (!pm || (pm.status === 'idle' && pm.attempts === 0)) out.push(t.memoNone);
  else if (pm.status === 'running') out.push(t.memoServerRunning);
  else if (pm.status === 'failed') out.push(t.memoFailed(pm.error ?? ''));
  else if (pm.status === 'needs-options') out.push(t.memoNeedsOptions(pm.reason ?? ''));
  else if (pm.memo) {
    const d = pm.memo, rec = d.recommendation;
    const refs = (c: { expertIds: string[]; refs: MemoReference[] }) => {
      const bits = [...(c.expertIds.length ? [t.memoBy(c.expertIds.map(name).join(', '))] : []), ...c.refs.map(x => memoRefText(p, x, m, name))];
      return bits.length ? ` _(${bits.join('; ')})_` : '';
    };
    const claims = (list: MemoClaim[]) => list.length ? list.map(c => `- ${c.text}${refs(c)}`) : [`- ${t.memoEmpty}`];
    out.push(`> ${t.memoExplain}`, '', `### ${t.memoSummary}`, d.summary, '', `### ${t.memoRecommendation}`, `> ${t.memoRecNote}`, '',
      ...(rec.status === 'recommend' && rec.options.length ? rec.options.map(o => `- **${o.id}**: ${o.text}`) : [`- ${t.memoNoRec}`]),
      ...(rec.rationale ? ['', rec.rationale + refs(rec)] : []), '', `### ${t.memoComparison}`);
    for (const o of d.comparison) out.push('', `#### ${o.optionId}: ${o.optionText}`, `${t.memoBenefits}:`, ...claims(o.benefits), `${t.memoRisks}:`, ...claims(o.risks), `${t.memoConditions}:`, ...claims(o.conditions));
    for (const [label, list] of [[t.memoDissent, d.dissent], [t.memoUnknowns, d.criticalUnknowns], [t.memoTriggers, d.changeTriggers], [t.memoActions, d.nextActions]] as Array<[string, MemoClaim[]]>)
      out.push('', `### ${label}`, ...claims(list));
    if (pm.coverage) out.push('', `### ${t.memoCoverage}`, ...memoCoverageLines(pm.coverage, m).map(x => `- ${x}`));
  }
  return out;
}

// ───────────────────────── DOM ─────────────────────────

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, unknown> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') (n as unknown as Record<string, unknown>)[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

function fill(n: Element, ...kids: Kid[]): void { n.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false)); }
/** CSS 마스크 아이콘 (cloudbite-console.css 의 .i-*) — 장식이므로 읽기 프로그램에서 숨긴다 */
function icon(name: string): HTMLElement { return h('span', { class: `cb-i i-${name}`, 'aria-hidden': 'true' }); }
function clock(at: number): string {
  if (!at) return '--:--:--';
  const d = new Date(at), p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 사람이 읽는 시:분 (방문자 세션 끝 등). 화면 언어의 Intl 형식·24시간제, Intl 이 없으면 clock 으로 */
function hhmmIn(l: Lang, at: number): string {
  try { return new Intl.DateTimeFormat(l === 'ko' ? 'ko-KR' : 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at); }
  catch { return clock(at).slice(0, 5); }
}
/** 브라우저가 알려 준 선호 언어 목록 (없으면 빈 목록) */
function navigatorLangs(nav: Navigator | undefined): readonly unknown[] {
  if (!nav) return [];
  return Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language];
}
/** 소유자 세션을 저절로(탭 포커스·Settings·Live run 전환) 다시 읽는 최소 간격. 사용자가 누른 확인은 바로 읽는다 */
const OWNER_REFRESH_MS = 30_000;
const OWNER_INBOX_PATH = '/cloudbite/requests';
const REQUEST_PATH = '/cloudbite/request';

const HISTORY_TEXT = {
  en: {
    title: 'Usage history', mine: 'My records', all: 'All users', report: 'Improvement report', refresh: 'Refresh', more: 'Load more',
    notice: 'Live-run questions and answers are stored for 30 days and can be reviewed by the owner to improve quality. You can delete finished records in History. Browser demos stay in this tab.',
    intro: 'Reopen questions, expert answers and feedback. Records stay available in this browser for 30 days; clearing browser cookies removes your access.',
    empty: 'No saved runs yet. Start a live run, then refresh here after a few seconds. Browser demos are not stored.',
    select: 'Choose a record to read the question and answers.', loading: 'Loading records…', auth: 'Run a project with approved visitor access, or sign in as the owner to see saved records.',
    error: (s: number) => s === 409 ? 'Stop the running project before deleting its record.' : `Could not load or update history (${s || 'network error'}). Try again.`,
    detail: 'Question and answers', model: 'Model', objective: 'Question', context: 'Context', sources: 'Evidence and sources', assumptions: 'Assumptions', actions: 'Next actions',
    expires: 'Available until', feedback: 'Was this expert answer useful?', helpful: 'Helpful', unhelpful: 'Not helpful', issue: 'What needs improvement?',
    noIssue: 'Choose a reason (optional)', comment: 'Comment (optional, up to 1,000 characters)', save: 'Save feedback', saved: 'Feedback saved.',
    remove: 'Delete record', confirm: 'Delete this question, answers, feedback and stored output files?', deleteYes: 'Delete permanently', cancel: 'Keep record',
    ownerNote: 'All-user records and the improvement report require the owner session. Sign in through Owner inbox.',
    reportIntro: 'Automatic signals from up to the latest 1,000 saved projects in 30 days. Only finished live runs contribute to quality metrics. No extra model calls or automatic prompt edits.',
    qualityNote: 'Source presence only checks reference formatting. It does not verify truth. Confidence is self-assessed, not accuracy.',
    sample: (n: number, live: number, demos: number, pending: number) => `${n} projects sampled · ${live} live · ${demos} server demos excluded · ${pending} live runs still in progress`,
    noSignals: 'No improvement signals in this sample yet. Collect real runs and user feedback before drawing conclusions.',
    small: 'Small sample: treat these as investigation leads, not a quality score or a ranking of expert ability.',
    counts: 'Execution and feedback', completed: 'Completed answers', failed: 'Failed experts', referenced: 'Answers with references', feedbackHelpful: 'Helpful reviews', feedbackUnhelpful: 'Unhelpful reviews',
    role: 'Expert', basis: 'Knowledge basis', revision: 'Prompt versions', knowledge: 'Curated knowledge', metadata: 'Persona metadata', unknown: 'Unknown',
    confidence: 'Self-assessed confidence distribution', errors: 'Failure categories', feedbackIssues: 'Feedback reasons', models: 'Models', projects: 'Projects', feedbackReadonly: 'Feedback is provided by the user who ran this project.',
    insights: {
      execution: (n: number, total: number) => `${n} / ${total} experts failed. Review the failure categories and affected roles before changing persona prompts.`,
      sources: (n: number, total: number) => `${n} / ${total} completed answers had no URL or source-ID reference. Review retrieval and citation instructions.`,
      confidence: (n: number, total: number) => `${n} / ${total} finished live projects gave identical confidence across at least three answers. Inspect shared examples and scoring rubrics; this alone does not prove a defect.`,
      feedback: (n: number, total: number) => `${n} / ${total} user reviews were unhelpful. Read the linked records and reasons before prioritizing changes.`,
      knowledge: (n: number, total: number) => `${n} / ${total} completed answers used metadata-only personas. Add curated domain material and retrieval where feedback shows a need.`,
    },
    issues: { incorrect: 'Incorrect', 'missing-sources': 'Missing sources', 'too-generic': 'Too generic', 'off-topic': 'Off topic', slow: 'Too slow', other: 'Other' } as Record<HistoryIssue, string>,
    errorKinds: { format: 'Result format', timeout: 'Timeout', 'rate-limit': 'Rate limit', budget: 'Budget / credit', sandbox: 'Sandbox', inference: 'Inference', other: 'Other' } as Record<string, string>,
  },
  ko: {
    title: '사용 기록', mine: '내 기록', all: '전체 사용자', report: '개선 리포트', refresh: '새로 고침', more: '더 보기',
    notice: '실제 실행의 질문·답변은 30일간 보관하며 운영자가 품질 개선을 위해 열람할 수 있습니다. 완료된 기록은 사용 기록에서 삭제할 수 있습니다. 브라우저 데모는 이 탭에만 남습니다.',
    intro: '질문·전문가 답변·피드백을 다시 살펴봅니다. 같은 브라우저에서 30일간 볼 수 있으며, 쿠키를 지우면 내 기록에 접근할 수 없습니다.',
    empty: '저장된 실행이 없습니다. 실제 실행을 시작한 뒤 몇 초 후 새로 고침하세요. 브라우저 데모는 저장하지 않습니다.',
    select: '기록을 선택하면 질문과 답변을 볼 수 있습니다.', loading: '기록을 불러오는 중…', auth: '승인된 방문자로 프로젝트를 실행하거나, 운영자 로그인 후 저장된 기록을 볼 수 있습니다.',
    error: (s: number) => s === 409 ? '실행 중인 프로젝트를 먼저 중지한 뒤 기록을 삭제하세요.' : `기록을 불러오거나 변경하지 못했습니다 (${s || '네트워크 오류'}). 다시 시도하세요.`,
    detail: '질문과 답변', model: '모델', objective: '질문', context: '맥락', sources: '근거와 출처', assumptions: '가정', actions: '다음 행동',
    expires: '보관 기한', feedback: '이 전문가의 답변이 도움이 됐나요?', helpful: '도움됨', unhelpful: '도움 안 됨', issue: '개선이 필요한 부분',
    noIssue: '이유 선택 (선택 사항)', comment: '의견 (선택 사항, 최대 1,000자)', save: '피드백 저장', saved: '피드백을 저장했습니다.',
    remove: '기록 삭제', confirm: '이 질문·답변·피드백과 저장된 결과 파일을 삭제할까요?', deleteYes: '영구 삭제', cancel: '기록 유지',
    ownerNote: '전체 사용자 기록과 개선 리포트는 운영자 로그인이 필요합니다. 소유자 요청함에서 로그인하세요.',
    reportIntro: '최근 30일 내 최신 프로젝트 최대 1,000개의 자동 집계입니다. 완료된 실제 실행만 품질 지표에 반영합니다. 추가 모델 호출이나 프롬프트 자동 변경은 하지 않습니다.',
    qualityNote: '출처 표기는 참조 형식의 유무만 확인하며 사실 여부를 검증하지 않습니다. 확신도는 자체 평가이며 정확도가 아닙니다.',
    sample: (n: number, live: number, demos: number, pending: number) => `분석 표본 ${n}개 · 실제 실행 ${live}개 · 서버 데모 ${demos}개 제외 · 실제 실행 진행 중 ${pending}개`,
    noSignals: '아직 이 표본에서 개선 신호가 발견되지 않았습니다. 실제 실행과 사용자 피드백을 더 모아 판단하세요.',
    small: '표본이 작습니다. 전문가의 능력 순위나 품질 점수가 아니라 우선 조사할 단서로 보세요.',
    counts: '실행과 피드백', completed: '완료 답변', failed: '실패 전문가', referenced: '출처 표기 답변', feedbackHelpful: '도움됨 평가', feedbackUnhelpful: '도움 안 됨 평가',
    role: '전문가', basis: '지식 기반', revision: '프롬프트 버전 수', knowledge: '문서 기반 지식', metadata: '페르소나 메타데이터', unknown: '알 수 없음',
    confidence: '자체 평가 확신도 분포', errors: '실패 유형', feedbackIssues: '개선 요청 이유', models: '모델', projects: '프로젝트', feedbackReadonly: '이 프로젝트를 실행한 사용자가 남기는 피드백입니다.',
    insights: {
      execution: (n: number, total: number) => `전문가 ${total}명 중 ${n}명이 실패했습니다. 페르소나를 바꾸기 전에 실패 유형과 해당 역할을 확인하세요.`,
      sources: (n: number, total: number) => `완료 답변 ${total}개 중 ${n}개에 URL·출처 ID 표기가 없습니다. 문서 검색과 근거 인용 지시를 점검하세요.`,
      confidence: (n: number, total: number) => `완료된 실제 실행 ${total}개 중 ${n}개에서 답변 3개 이상이 같은 확신도를 보고했습니다. 공통 예시와 평가 기준을 확인하세요. 이것만으로 결함이 입증되지는 않습니다.`,
      feedback: (n: number, total: number) => `사용자 평가 ${total}개 중 ${n}개가 도움 안 됨입니다. 해당 기록과 이유를 읽고 개선 우선순위를 정하세요.`,
      knowledge: (n: number, total: number) => `완료 답변 ${total}개 중 ${n}개가 메타데이터 중심 페르소나를 사용했습니다. 피드백에서 필요가 확인되는 분야부터 문서·검색을 보강하세요.`,
    },
    issues: { incorrect: '내용이 틀림', 'missing-sources': '출처 부족', 'too-generic': '너무 일반적임', 'off-topic': '질문과 무관함', slow: '너무 느림', other: '기타' } as Record<HistoryIssue, string>,
    errorKinds: { format: '결과 형식', timeout: '시간 초과', 'rate-limit': '호출 제한', budget: '예산·크레딧', sandbox: '샌드박스', inference: '추론', other: '기타' } as Record<string, string>,
  },
};

function boot(): void {
  // 운영자 링크는 화면·요청보다 먼저 지운다. 링크가 있으면 실제 실행 모드로 열고 자동 데모·자동 실행은 하지 않는다
  const link = takeOperatorLink();
  const root = document.getElementById('cloudbite');
  if (!root) return;
  const g = globalThis as { location?: Location; history?: History; navigator?: Navigator; addEventListener?: (t: string, f: () => void) => void };
  // 언어: 올바른 ?lang= → 브라우저 언어 → en. 저장소에 두지 않고, 바꿀 때 주소의 질의만 replaceState 로 고친다
  let lang: Lang = pickLang(g.location && typeof g.location.search === 'string' ? g.location.search : '', navigatorLangs(g.navigator));
  let M: Messages = DICT[lang];

  const S = {
    gen: 0,
    boot: { status: 'loading' as 'loading' | 'ready' | 'error', data: null as ConsoleBootstrap | null, error: null as Text | null },
    /** 소유자 로그인 (서버 HttpOnly 쿠키). 서버 /owner/session 응답만 믿는다 — 쿠키가 있는지는 JS 가 모른다 */
    owner: { status: 'loading' as 'loading' | 'ready' | 'error', authenticated: false, hasCredentials: false, error: null as Text | null, busy: false, message: null as Text | null },
    mode: (link.present ? 'live' : 'demo') as Mode,
    adminToken: link.token,
    selected: new Set<string>(),
    /** 역할 카탈로그 필터(검색어는 입력란에 있다)·보이는 줄 수와 규칙 기반 팀 제안. 제안은 Apply 전에는 선택을 바꾸지 않는다 */
    poolCat: '',
    poolShow: 'all' as PoolShow,
    poolLimit: POOL_PAGE,
    suggest: null as null | { brief: string; picks: PoolPick[]; empty: 'none' | 'brief' | null },
    failSim: false,
    /** routing 이 있을 때 팀을 고르는 방식. 기본은 Jev(auto). 직접 고르기(manual)는 사용자가 눌렀을 때만이며 언어를 바꿔도 남는다 */
    routeMode: 'auto' as 'auto' | 'manual',
    /** 마지막 Jev 선택과 그때의 브리프 열쇠. 화면 표시용일 뿐 — 다음 실행은 늘 새로 고르고, 이 팀을 선택(S.selected)에 넣지 않는다 */
    route: null as null | { key: string; result: RouteResult | null },
    /** Jev 팀 설명 접힘 상태. 다시 그려도 사용자가 연 상태를 지키고, 새로 고를 때 접는다 */
    teamOpen: false,
    run: null as null | {
      mode: Mode; phase: 'routing' | 'starting' | 'running' | 'cancelling' | 'done' | 'error'; project: ConsoleProject | null;
      accessToken: string; error: Text | null; startedAt: number; pollErrors: number;
      /** Jev 가 고른 팀으로 만든 실행 */
      routed: boolean;
      /** 승인된 방문자 쿠키로 만든 실제 실행: 끝나면 서버 접근 상태를 다시 읽는다 */
      viaVisitor: boolean;
      /** 소유자 로그인 쿠키로 만든 실제 실행 */
      viaOwner: boolean;
    },
    view: (g.location?.pathname?.replace(/\/$/, '') === '/cloudbite/history' ? 'history' : 'home') as View,
    /** 프로젝트 브리프 편집 영역. 실행 전에는 늘 열려 있고, 실행이 실제로 시작되면 접힌다 (오류가 나면 다시 열린다) */
    setupOpen: true,
    /** 사용자가 Settings 에서 실행 방식을 직접 골랐다 — 방문자·소유자 소개가 그 선택을 바꾸지 않는다 */
    modePicked: false,
    full: false,
    /** "Clear view" 때 화면에서만 숨긴 실행 기록 줄. 프로젝트 기록·파일은 그대로 둔다 */
    hiddenRows: new Set<string>(),
    focusExpert: '',
    tab: 'artifacts' as 'persona' | 'workorder' | 'activity' | 'artifacts',
    artifactPath: '',
    /** 사용자가 파일을 직접 고르기 전에는 새 파일이 생기면 가장 쓸모 있는 파일(out/report.md 우선)로 따라간다 */
    artifactPicked: false,
    artifactCache: new Map<string, { state: 'loading' } | { state: 'ok'; text: string } | { state: 'error'; text: Text }>(),
    /** 승인된 방문자를 처음 알아챘을 때 한 번만 실제 실행·프로젝트 설정으로 연다 */
    visitorIntro: false,
    /** 로그인한 소유자를 처음 알아챘을 때 한 번만 실제 실행으로 연다 (실행은 하지 않는다) */
    ownerIntro: false,
    formErrors: (link.present && !link.token ? [{ field: 'run', text: m => m.operatorMalformedLink }] : []) as FormIssue[],
    /** 근거 파일: 브라우저 메모리에만 둔다 (저장소·주소 없음). 다시 그려도 남고, 사용자가 빼기 전에는 실행 뒤에도 남는다 */
    docs: [] as DocDraft[],
    docErrors: [] as Text[],
    /** 읽는 중인 파일 수. 0 이 될 때까지 시작을 막는다 */
    docReading: 0,
    docOpen: new Set<number>(),
    /** 결과의 근거 패널 접기 상태 (열쇠에 프로젝트 id 를 붙인다) */
    evOpen: new Set<string>(),
    /** 이 화면에서 건 교차 검토 요청의 상태. 서버가 보낸 project.crossReview 와 따로 둔다 (실패를 완료로 꾸미지 않는다) */
    review: null as null | { projectId: string; phase: 'running' | 'failed'; error: Text | null; polls: number },
    /** 이 화면에서 건 결정 메모 요청. 한 프로젝트에 한 번만 보내며, 이 값이 있으면 그 프로젝트에 유료 버튼을 다시 내지 않는다.
     *  unknown = 응답을 확인하지 못함(다시 보내지 않고 읽기만 한다), reading = 저장 상태를 읽는 중, settled = 서버 상태를 받았다.
     *  blocked 만 예외다: 서버가 409 로 시작하지 않았고 GET 으로 시도 기록이 없음을 확인했다 (예약 없음) → 유료 버튼을 다시 낼 수 있다 */
    memo: null as null | { projectId: string; phase: 'running' | 'reading' | 'unknown' | 'failed' | 'blocked' | 'settled'; error: Text | null; polls: number },
    /** 사용 기록에서 시작한 후속 라운드 초안: 부모 id 와 서버가 읽어 준 부모 프로젝트(참고·비교용), 사용자가 쓰는 바뀐 점 요약 */
    /** authorResponse: 작성자 응답 라운드 (부모의 완료된 교차 검토 해시와 고를 수 있는 해당 작성자). 없으면 보통 후속 라운드 */
    followUp: null as null | { parentId: string; parent: ConsoleProject; changeSummary: string; authorResponse?: { reviewSnapshotHash: string; affected: string[] } },
    /** 실제 실행 전 준비한 계획. body 는 미리보기에 보낸 바로 그 JSON 문자열이며, 실행은 이 문자열을 그대로 보낸다 (기본값을 덧붙이지 않는다).
     *  sig 는 준비한 순간의 의미 있는 입력 전체. 하나라도 바뀌면 계획을 버린다 */
    plan: null as null | { sig: string; phase: 'preparing' | 'ready' | 'error'; routed: boolean; body: string; preview: ProjectPreview | null; error: Text | null },
    planStale: false,
    /** 같은 입력으로 다시 준비하면 같은 requestId 를 쓴다 (서버가 같은 요청으로 본다). 실행이 만들어지면 지운다 */
    planReq: null as null | { sig: string; requestId: string },
    /** PMC 가져오기: 서버 결과를 보여 주기만 하고, 사용자가 고른 발췌만 근거 파일에 더한다 */
    pmc: { busy: false, result: null as PmcImport | null, error: null as Text | null, note: null as Text | null, picked: new Set<string>() },
  };
  let timers: number[] = [];
  let pollTimer = 0;
  let reviewTimer = 0;
  let memoTimer = 0;
  let docKey = 0, docRev = 0, docSig = '';
  let planGen = 0, pmcSeq = 0, pmcRev = 0, pmcSig = '', planDrawn: unknown = undefined, planDrawnKey = '';
  /** 파일은 하나씩 차례로 읽는다: 늦게 끝난 읽기가 한도 계산을 앞지르지 않는다 */
  let docQueue: Promise<void> = Promise.resolve();
  let accessTimer = 0, accessTries = 0;
  let lastAnnounce = '';
  const H = {
    tab: (new URLSearchParams(g.location?.search ?? '').get('tab') === 'report' ? 'report' : 'mine') as 'mine' | 'all' | 'report',
    owner: false, busy: false, detailBusy: false, mutation: false, error: 0, unauthorized: false, message: '',
    list: null as HistoryList | null, detail: null as HistoryDetail | null, report: null as HistoryReport | null,
    deleteId: '', gen: 0, detailGen: 0, dirty: true, renderedLang: '',
    drafts: new Map<string, Omit<HistoryFeedback, 'at'>>(), opened: new Set<string>(),
    /** 프로젝트 id → 서버가 사용 기록 상세에서 밝힌 자기 기록 여부 (canFeedback). 끝나지 않은 상세의 false 는 모름이라 적지 않는다 */
    own: new Map<string, boolean>(),
  };
  const HT = () => HISTORY_TEXT[lang];
  function clearHistoryAuthority(): void {
    H.gen++; H.detailGen++; H.list = null; H.detail = null; H.report = null; H.drafts.clear(); H.opened.clear(); H.own.clear(); H.owner = false; H.busy = false; H.detailBusy = false; H.dirty = true; H.tab = 'mine';
  }

  const catalogue = (): ExpertDefinition[] => S.mode === 'live' ? S.boot.data?.experts ?? [] : (S.boot.data?.experts.length ? S.boot.data.experts : DEMO_EXPERTS);
  const catalogueIsBuiltin = () => S.mode === 'demo' && !S.boot.data?.experts.length;
  // 실제 실행 자격의 우선순위: 직접 넣은 관리자·운영자 토큰(헤더) → 소유자 로그인 쿠키 → 승인된 방문자 쿠키. JS 는 쿠키를 읽지 않는다
  const visitor = () => approvedVisitor(S.boot.data?.access, Date.now());
  const visitorLeft = () => { const v = visitor(); return v ? Math.max(0, v.maxProjects - v.usedProjects) : 0; };
  const visitorCanRun = () => !!visitor() && !!S.boot.data?.access?.canCreate && visitorLeft() > 0;
  const ownerAuthed = () => S.owner.status === 'ready' && S.owner.authenticated;
  const viaOwner = () => S.mode === 'live' && !S.adminToken.trim() && ownerAuthed();
  const viaVisitor = () => S.mode === 'live' && !S.adminToken.trim() && !ownerAuthed() && !!visitor();
  const liveCredential = () => !!S.adminToken.trim() || ownerAuthed() || visitorCanRun();
  const hhmm = (at: number) => hhmmIn(lang, at);
  /** 같은 출처 Cloudbite 화면 주소에 지금 언어를 붙인다 */
  const href = (path: string) => `${path}${withLang('', lang)}`;
  /** 쓸 수 없는 방문자 접근 상태의 설명. 쓸 수 있거나 요청이 없으면 null */
  const accessProblem = (): Text | null => {
    const r = S.boot.data?.access?.request;
    if (!r) return null;
    if (visitor()) {
      if (visitorCanRun()) return null;
      const rec = S.boot.data?.access?.recovery;
      return rec === 'pending' ? m => m.accessPending : rec === 'unavailable' ? m => m.accessUnavailable : rec === 'limit' ? m => m.accessLimit : m => m.accessSpent;
    }
    return r.status === 'pending' ? m => m.accessWaiting : r.status === 'denied' ? m => m.accessDenied : r.status === 'revoked' ? m => m.accessRevoked : m => m.accessExpired;
  };
  const routing = (): Routing | null => S.boot.data?.configuration.routing ?? null;
  /** 다음 실행에서 Jev 가 팀을 고르는가 (서버가 기능을 알렸고 사용자가 직접 고르기를 누르지 않았다) */
  const autoRoute = () => !!routing() && S.routeMode === 'auto';
  /** Jev 경로를 부를 자격: 직접 넣은 토큰 → 소유자 쿠키 → 승인된 방문자 쿠키. 공개 사용자는 유료 API 를 부르지 않는다 */
  const routeCredential = () => !!S.adminToken.trim() || ownerAuthed() || !!visitor();
  const limits = (): Limits => {
    const server = S.boot.data?.configuration.maxExperts ?? 5;
    const session = !S.adminToken.trim() && !ownerAuthed() && visitor() ? visitor()!.maxExperts : server;
    const jev = autoRoute() ? routing()!.maxExperts : server;
    return { min: 1, max: Math.max(1, Math.min(PROJECT_MAX, server, session, jev)) };
  };
  /** 탐색 줄의 카탈로그 규모: 계획 카탈로그가 있으면 그 항목 수, 없으면 실행 가능한 역할 수 (불러오기 전에는 0) */
  const catalogueCount = () => S.boot.data?.pool?.entries.length ?? S.boot.data?.experts.length ?? 0;
  /** Jev 선택이 어떤 브리프·인원 한도의 것인지 (바뀌면 화면에 오래됐다고 알린다) */
  const routeKey = (q: { title: string; objective: string; context: string; decision?: DecisionFrame; documents?: ProjectDocument[] }) =>
    [q.title, q.objective, q.context, limits().max, JSON.stringify(q.decision ?? null), JSON.stringify(q.documents ?? null)].join('\n');
  /** 선택 필드: 있을 때만 보낸다. 경로 묻기와 프로젝트 만들기가 같은 값을 보내 서버가 같은 확장 브리프로 해시한다 */
  const briefExtras = (b: { decision?: DecisionFrame; documents?: ProjectDocument[] }) => ({ ...(b.decision ? { decision: b.decision } : {}), ...(b.documents ? { documents: b.documents } : {}) });
  const active = () => !!S.run && (S.run.phase === 'routing' || S.run.phase === 'starting' || S.run.phase === 'running' || S.run.phase === 'cancelling'
    || (S.run.phase === 'error' && !!S.run.project && !TERMINAL_PROJECT.includes(S.run.project.status)));
  /** 실패한 실행의 정리를 아직 확인하지 못한 방문자: Check again 으로 서버 상태를 다시 읽을 수 있다 */
  const recheckable = () => { const r = S.boot.data?.access?.recovery; return !!visitor() && !visitorCanRun() && (r === 'pending' || r === 'unavailable'); };
  const checkAgain = () => h('button', { type: 'button', class: 'cb-ghost', onclick: () => refreshAccess(true) }, M.checkAgain);
  const findDef = (id: string) => catalogue().find(e => e.id === id) ?? DEMO_EXPERTS.find(e => e.id === id);

  // ── 고정 뼈대의 글자: 만들 때 지금 언어로 채우고, 언어를 바꾸면 applyLang 이 다시 채운다 (노드는 그대로라 포커스·입력·열림 상태가 남는다)
  const binds: Array<() => void> = [];
  function bind<N extends Element>(n: N, f: (n: N, m: Messages) => void): N { const run = () => f(n, M); binds.push(run); run(); return n; }
  function tx<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null, f: Text): HTMLElementTagNameMap[K] {
    return bind(h(tag, props), (n, m) => { n.textContent = f(m); });
  }
  const attr = <N extends Element>(n: N, name: string, f: Text): N => bind(n, (x, m) => x.setAttribute(name, f(m)));
  /** 같은 출처 Cloudbite 화면 링크: 글자와 ?lang= 가 화면 언어를 따른다 */
  const pageLink = (path: string, f: Text, props: Record<string, unknown> = {}) => bind(h('a', props), (n, m) => { n.textContent = f(m); n.setAttribute('href', href(path)); });

  // ── 고정 뼈대 (입력란·접기 상자는 한 번만 만들어 포커스·입력 중 글자·열림 상태를 잃지 않는다)
  const titleIn = h('input', { id: 'cb-title', type: 'text', maxlength: LIMIT.title, autocomplete: 'off', value: M.sampleTitle });
  const objectiveIn = h('textarea', { id: 'cb-objective', rows: 4, maxlength: LIMIT.objective });
  objectiveIn.value = M.sampleObjective;
  const contextIn = h('textarea', { id: 'cb-context', rows: 3, maxlength: LIMIT.context });
  contextIn.value = M.sampleContext;
  const staExampleBtn = tx('button', { type: 'button', class: 'cb-link', onclick: () => {
    if (active() || !findDef('probably-primetime-sta')) return;
    titleIn.value = M.staTitle; objectiveIn.value = M.staObjective; contextIn.value = M.staContext;
    S.selected.clear(); S.selected.add('probably-primetime-sta'); S.formErrors = [];
    for (const update of recount) update();
    keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
    objectiveIn.focus();
  } }, m => m.staExample);
  // 글자 수는 입력 중(포커스)이거나 한도에 가까울 때만 보인다 (CSS)
  const recount: Array<() => void> = [];
  const counter = (inp: HTMLInputElement | HTMLTextAreaElement, max: number) => {
    const c = h('span', { class: 'cb-count', 'aria-hidden': 'true' });
    const upd = () => { c.textContent = `${inp.value.length} / ${max}`; c.className = `cb-count${inp.value.length > max * 0.9 ? ' is-near' : ''}`; };
    inp.addEventListener('input', upd); upd(); recount.push(upd);
    return c;
  };
  for (const inp of [titleIn, objectiveIn]) inp.addEventListener('input', () => { if (!active()) renderControls(); });
  // 제안 뒤에 브리프를 고치면 제안이 오래됐다고 알린다 (선택은 그대로)
  for (const inp of [titleIn, objectiveIn, contextIn]) inp.addEventListener('input', () => { if (S.suggest) renderSuggest(); if (S.route?.result) renderJev(); });
  const tokenIn = attr(h('input', { id: 'cb-token', type: 'password', autocomplete: 'off', spellcheck: 'false' }), 'placeholder', m => m.tokenPlaceholder);
  tokenIn.value = S.adminToken;
  tokenIn.addEventListener('input', () => { S.adminToken = tokenIn.value; clearHistoryAuthority(); renderControls(); renderProgress(); });
  const failIn = h('input', { id: 'cb-fail', type: 'checkbox' });
  failIn.addEventListener('change', () => { S.failSim = failIn.checked; });
  const filterIn = attr(attr(h('input', { id: 'cb-filter', type: 'search', autocomplete: 'off' }), 'placeholder', m => m.searchPlaceholder), 'aria-label', m => m.searchAria);
  filterIn.addEventListener('input', () => renderCatalogue());

  const modeDemo = tx('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'true', onclick: () => setMode('demo') }, m => m.modeDemo);
  const modeLive = tx('button', { type: 'button', class: 'cb-seg', 'aria-pressed': 'false', onclick: () => setMode('live') }, m => m.modeLive);
  const startBtn = h('button', { type: 'button', class: 'cb-primary cb-start', 'data-fk': 'start', onclick: () => startRun() });
  const startLabel = h('span');
  startBtn.append(icon('play'), startLabel);
  const cancelBtn = h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'stop', onclick: () => cancelRun() });
  const cancelLabel = h('span');
  cancelBtn.append(icon('stop'), cancelLabel);
  const formMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const runMsg = h('div', { class: 'cb-formmsg', role: 'alert' });
  const coreBox = h('div', { class: 'cb-catalogue', role: 'group', 'aria-labelledby': 'cb-cat-label' });
  const moreBox = attr(h('div', { class: 'cb-catalogue', role: 'group' }), 'aria-label', m => m.allExpertsAria);
  const moreLabel = h('span');
  const moreDetails = h('details', { class: 'cb-disclosure cb-more' },
    h('summary', null, icon('chevron'), moreLabel), h('div', { class: 'cb-disclosure-body' }, filterIn, moreBox));
  // 역할 카탈로그 (bootstrap.pool 이 있을 때만): 접힌 채로 시작하고, 펼치면 검색·분야·실행 가능 여부로 좁혀 몇 줄씩 본다
  const poolSearch = attr(h('input', { id: 'cb-pool-q', type: 'search', autocomplete: 'off', 'data-fk': 'pool-q' }), 'placeholder', m => m.poolSearchPlaceholder);
  const poolCat = h('select', { id: 'cb-pool-cat', 'data-fk': 'pool-cat' });
  const poolShow = h('select', { id: 'cb-pool-show', 'data-fk': 'pool-show' });
  poolSearch.addEventListener('input', () => { S.poolLimit = POOL_PAGE; renderPool(); });
  poolCat.addEventListener('change', () => { S.poolCat = poolCat.value; S.poolLimit = POOL_PAGE; keepFocus(renderPool); });
  poolShow.addEventListener('change', () => { S.poolShow = (['all', 'available', 'planned'] as PoolShow[]).find(v => v === poolShow.value) ?? 'all'; S.poolLimit = POOL_PAGE; keepFocus(renderPool); });
  const poolList = attr(h('div', { class: 'cb-catalogue cb-pool-list', role: 'group' }), 'aria-label', m => m.poolListAria);
  const poolCount = h('p', { class: 'cb-help', 'aria-live': 'polite' });
  const poolMore = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'pool-more', onclick: () => { S.poolLimit += POOL_PAGE; keepFocus(renderPool); } });
  const poolLabel = h('span');
  const poolField = (id: string, f: Text, input: HTMLElement) => h('div', { class: 'cb-field' }, tx('label', { for: id, class: 'cb-label' }, f), input);
  const poolDetails = h('details', { class: 'cb-disclosure cb-more cb-pool' },
    h('summary', null, icon('chevron'), poolLabel),
    h('div', { class: 'cb-disclosure-body' }, tx('p', { class: 'cb-help' }, m => m.poolNote),
      h('div', { class: 'cb-pool-filters' }, poolField('cb-pool-q', m => m.poolSearchLabel, poolSearch),
        poolField('cb-pool-cat', m => m.poolCategoryLabel, poolCat), poolField('cb-pool-show', m => m.poolShowLabel, poolShow)),
      poolCount, poolList, poolMore));
  // 규칙 기반 팀 제안: 보여 주기만 하고, Apply 를 눌러야 선택(S.selected)만 바뀐다 — 실행·요청·방문자 한도와 무관
  const suggestBtn = tx('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'pool-suggest', onclick: () => suggest() }, m => m.suggestBtn);
  const suggestHelp = h('p', { class: 'cb-help' });
  const suggestBody = h('div', { class: 'cb-suggest-body' });
  const suggestBox = h('div', { class: 'cb-suggest', role: 'group', 'aria-labelledby': 'cb-suggest-h' },
    h('div', { class: 'cb-label-row' }, tx('span', { id: 'cb-suggest-h', class: 'cb-label' }, m => m.suggestTitle), suggestBtn), suggestHelp, suggestBody);
  const alsoSel = h('p', { class: 'cb-alsosel' });
  const catalogueNote = h('p', { class: 'cb-help' });
  const selCount = h('span', { class: 'cb-selcount' });
  const catLabelRow = h('div', { class: 'cb-label-row' }, tx('span', { id: 'cb-cat-label', class: 'cb-label' }, m => m.chooseExperts), selCount);
  // 직접 고르기 (routing 이 없으면 늘, 있으면 사용자가 직접 고르기를 눌렀을 때만 보인다)
  const manualBox = h('div', { class: 'cb-manual', role: 'group', 'aria-labelledby': 'cb-cat-label' }, catLabelRow, coreBox, alsoSel, suggestBox, moreDetails);
  // Jev 가 고르는 팀: 읽기 전용 표시와 진행·오류 상태, 직접 고르기로 바꾸는 버튼
  const jevHelp = h('p', { class: 'cb-help' });
  const jevBody = h('div', { class: 'cb-jev-body', 'aria-live': 'polite' });
  const jevToggle = h('button', { type: 'button', class: 'cb-link', 'data-fk': 'jev-toggle', onclick: () => toggleRouteMode() });
  const jevBox = h('div', { class: 'cb-suggest cb-jev', role: 'group', 'aria-labelledby': 'cb-jev-h' },
    h('div', { class: 'cb-label-row' }, tx('span', { id: 'cb-jev-h', class: 'cb-label' }, m => m.jevTitle)), jevHelp, jevBody, jevToggle);
  const liveStatus = h('div', { class: 'cb-live-status' });
  const clearTokenBtn = tx('button', { type: 'button', class: 'cb-ghost', onclick: () => { S.adminToken = ''; tokenIn.value = ''; clearHistoryAuthority(); renderControls(); tokenIn.focus(); } }, m => m.clearToken);
  const tokenLabel = h('label', { for: 'cb-token', class: 'cb-label' });
  const liveBox = h('div', { class: 'cb-live' }, liveStatus,
    tokenLabel, tokenIn, tx('p', { class: 'cb-help' }, m => m.tokenHelp), clearTokenBtn);
  const demoBox = h('div', { class: 'cb-demoopts' },
    h('label', { class: 'cb-check' }, failIn, ' ', tx('span', null, m => m.failSim)));

  const detailsHint = h('span', { class: 'cb-summary-hint' });
  const projDetails = h('details', { class: 'cb-disclosure' },
    h('summary', null, icon('chevron'), tx('span', null, m => m.projectDetails), detailsHint),
    h('div', { class: 'cb-disclosure-body cb-fields' },
      h('div', { class: 'cb-field' }, tx('label', { for: 'cb-title', class: 'cb-label' }, m => m.projectName), titleIn, counter(titleIn, LIMIT.title)),
      h('div', { class: 'cb-field' }, tx('label', { for: 'cb-context', class: 'cb-label' }, m => m.contextLabel), contextIn, counter(contextIn, LIMIT.context))));
  // 결정 세부 정보 (선택): 목표 아래 접힌 상자. 여섯 칸, 한 줄에 한 항목
  const decisionIns = {} as Record<DecisionField, HTMLTextAreaElement>;
  for (const f of DECISION_FIELDS) {
    const ta = h('textarea', { id: `cb-dec-${f}`, rows: 3, maxlength: DECISION.items * (DECISION.chars + 1), 'aria-describedby': 'cb-dec-help', 'data-fk': `dec:${f}` });
    ta.addEventListener('input', () => { renderDecisionHint(); if (S.route?.result) renderJev(); });
    decisionIns[f] = ta;
  }
  const decisionTexts = () => Object.fromEntries(DECISION_FIELDS.map(f => [f, decisionIns[f].value])) as Record<DecisionField, string>;
  const currentExtras = () => briefExtras({ decision: parseDecision(decisionTexts()).frame, documents: S.docs.length ? docsPayload(S.docs) : undefined });
  const decisionHint = h('span', { class: 'cb-summary-hint' });
  const decisionDetails = h('details', { class: 'cb-disclosure cb-decision' },
    h('summary', null, icon('chevron'), tx('span', null, m => m.decisionDetails), decisionHint),
    h('div', { class: 'cb-disclosure-body' },
      bind(h('p', { id: 'cb-dec-help', class: 'cb-help' }), (n, m) => { n.textContent = m.decisionHelp(DECISION.items, DECISION.chars); }),
      h('div', { class: 'cb-fields cb-decision-fields' }, ...DECISION_FIELDS.map(f =>
        h('div', { class: 'cb-field' }, tx('label', { for: `cb-dec-${f}`, class: 'cb-label' }, m => m.decisionField[f]), decisionIns[f])))));
  // 프로젝트 근거 자료 (선택): 글자 파일만 브라우저 메모리로 읽고, 보내기 전에 내용을 보이고 뺄 수 있게 한다
  const docsInput = h('input', { id: 'cb-docs-file', type: 'file', multiple: true, hidden: true, tabindex: '-1',
    accept: '.txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json' });
  docsInput.addEventListener('change', () => { const files = Array.from(docsInput.files ?? []); docsInput.value = ''; addFiles(files); });
  const docsPick = h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'docs-pick', 'aria-describedby': 'cb-docs-help',
    onclick: () => { if (!locked()) docsInput.click(); } }, tx('span', null, m => m.docsPick));
  const docsHint = h('span', { class: 'cb-summary-hint' });
  const docsCopyNote = h('p', { class: 'cb-help' });
  const docsUsage = h('p', { class: 'cb-help cb-docs-usage', 'aria-live': 'polite' });
  const docsErr = h('div', { class: 'cb-formmsg cb-docs-err', role: 'alert' });
  const docsList = h('ol', { class: 'cb-doc-list' });
  // PMC 원문 발췌 (선택): 식별자 하나 → 서버가 가져온 결과를 보이고, 고른 발췌만 근거 파일에 더한다
  const pmcIn = h('input', { id: 'cb-pmc-id', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 220, 'data-fk': 'pmc-id', 'aria-describedby': 'cb-pmc-help' });
  pmcIn.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Enter') { ev.preventDefault(); void pmcLookup(); } });
  const pmcBtn = h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'pmc-lookup', onclick: () => void pmcLookup() });
  const pmcMsg = h('div', { class: 'cb-formmsg cb-pmc-err', role: 'alert' });
  const pmcNote = h('p', { class: 'cb-help', 'aria-live': 'polite' });
  const pmcBody = h('div', { class: 'cb-pmc-body' });
  const pmcBox = h('div', { class: 'cb-pmc', role: 'group', 'aria-labelledby': 'cb-pmc-h' },
    tx('h3', { id: 'cb-pmc-h', class: 'cb-label' }, m => m.pmcTitle), tx('p', { id: 'cb-pmc-help', class: 'cb-help' }, m => m.pmcHelp),
    h('div', { class: 'cb-field' }, tx('label', { for: 'cb-pmc-id', class: 'cb-label' }, m => m.pmcLabel), h('div', { class: 'cb-docs-row' }, pmcIn, pmcBtn)),
    pmcMsg, pmcNote, pmcBody);
  const docsDetails = h('details', { class: 'cb-disclosure cb-docs' },
    h('summary', null, icon('chevron'), tx('span', null, m => m.docsTitle), docsHint),
    h('div', { class: 'cb-disclosure-body' },
      bind(h('p', { id: 'cb-docs-help', class: 'cb-help' }), (n, m) => { n.textContent = m.docsHelp(DOCS.files, group(DOCS.chars), group(DOCS.total)); }),
      docsCopyNote, h('div', { class: 'cb-docs-row' }, docsPick, docsUsage), docsInput, docsErr, docsList, pmcBox));
  // 워크플로 선택 필드: 단계, 응답 언어(화면 언어와 따로), 접힌 고급 호출 상한. 비워 두면 보내지 않는다
  const stageSel = h('select', { id: 'cb-stage', 'data-fk': 'wf-stage' }, ...['', ...STAGES.filter(x => x !== 'unspecified')].map(v =>
    bind(h('option', { value: v }), (n, m) => { n.textContent = v ? m.wfStageName[v as ProjectStage] : m.wfStageNone; })));
  const respSel = h('select', { id: 'cb-resp-lang', 'data-fk': 'wf-lang', 'aria-describedby': 'cb-resp-help' }, ...['', ...RESPONSE_LANGS].map(v =>
    bind(h('option', { value: v }), (n, m) => { n.textContent = v ? m.wfLangName[v as ResponseLanguage] : m.wfLangNone; })));
  const wfFields = h('div', { class: 'cb-fields cb-workflow-fields' },
    h('div', { class: 'cb-field' }, tx('label', { for: 'cb-stage', class: 'cb-label' }, m => m.wfStage), stageSel),
    h('div', { class: 'cb-field' }, tx('label', { for: 'cb-resp-lang', class: 'cb-label' }, m => m.wfLang), respSel, tx('p', { id: 'cb-resp-help', class: 'cb-help' }, m => m.wfLangHelp)));
  const budgetIns = {} as Record<BudgetField, HTMLInputElement>;
  for (const f of BUDGET_FIELDS) budgetIns[f] = h('input', { id: `cb-budget-${f}`, type: 'number', inputmode: 'numeric', min: BUDGET_LIMITS[f][0], max: BUDGET_LIMITS[f][1], step: 1,
    autocomplete: 'off', 'data-fk': `budget:${f}`, 'aria-describedby': 'cb-budget-help' });
  const budgetTexts = () => Object.fromEntries(BUDGET_FIELDS.map(f => [f, budgetIns[f].value])) as Record<BudgetField, string>;
  const budgetHint = h('span', { class: 'cb-summary-hint' });
  const budgetFill = tx('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'budget-fill', onclick: () => fillBudget(true) }, m => m.budgetFill);
  const budgetClear = tx('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'budget-clear', onclick: () => fillBudget(false) }, m => m.budgetClear);
  const budgetDetails = h('details', { class: 'cb-disclosure cb-budget' },
    h('summary', null, icon('chevron'), tx('span', null, m => m.budgetTitle), budgetHint),
    h('div', { class: 'cb-disclosure-body' },
      bind(h('p', { id: 'cb-budget-help', class: 'cb-help' }), (n, m) => { n.textContent = m.budgetHelp(BUDGET_DEFAULT.perExpert, BUDGET_DEFAULT.review, BUDGET_DEFAULT.memo); }),
      h('div', { class: 'cb-fields cb-budget-fields' }, ...BUDGET_FIELDS.map(f =>
        h('div', { class: 'cb-field' }, tx('label', { for: `cb-budget-${f}`, class: 'cb-label' }, m => m.budgetField[f]), budgetIns[f]))),
      h('div', { class: 'cb-docs-row' }, budgetFill, budgetClear)));
  // 준비된 계획 (실제 실행): 팀 배정·샌드박스/호출 범위·별도 Jev 호출. 실행은 시작 버튼 하나로 한다
  const planBox = h('div', { class: 'cb-plan', 'aria-live': 'polite' });
  // 의미 있는 입력이 바뀌면 준비한 계획을 버린다 (언어 전환·조회처럼 의미가 그대로인 다시 그리기는 계획을 지킨다)
  for (const n of [titleIn, objectiveIn, contextIn, stageSel, respSel, ...DECISION_FIELDS.map(f => decisionIns[f]), ...BUDGET_FIELDS.map(f => budgetIns[f])]) {
    n.addEventListener('input', () => semanticEdit()); n.addEventListener('change', () => semanticEdit());
  }
  // 후속 라운드 초안 (사용 기록에서 시작했을 때만 보인다): 바뀐 점 요약은 필수, 비교는 정확한 글자만
  const fuSummaryIn = h('textarea', { id: 'cb-fu-summary', rows: 3, maxlength: REVISION.changeSummary + 200, 'aria-describedby': 'cb-fu-help', 'data-fk': 'fu-summary' });
  fuSummaryIn.addEventListener('input', () => { if (S.followUp) S.followUp.changeSummary = fuSummaryIn.value; semanticEdit(); });
  const fuParentLine = h('p', { class: 'cb-help' });
  const fuDiffList = h('ul', { class: 'cb-fu-diff' });
  const fuRefs = h('div', { class: 'cb-fu-refs' });
  const fuAuthorLine = h('p', { class: 'cb-help cb-fu-author', hidden: true });
  const fuRolesNote = tx('p', { class: 'cb-help' }, m => m.p2.fuRoles);
  const fuCancelBtn = tx('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'fu-cancel', onclick: () => cancelFollowUp() }, m => m.p2.fuCancel);
  const fuBox = h('section', { class: 'cb-followup', 'aria-labelledby': 'cb-fu-h', hidden: true },
    tx('h3', { id: 'cb-fu-h', class: 'cb-label' }, m => m.p2.fuTitle), fuParentLine, tx('p', { class: 'cb-help' }, m => m.p2.fuNote),
    h('div', { class: 'cb-field' }, tx('label', { for: 'cb-fu-summary', class: 'cb-label' }, m => m.p2.fuSummary), fuSummaryIn,
      bind(h('p', { id: 'cb-fu-help', class: 'cb-help' }), (n, m) => { n.textContent = m.p2.fuSummaryHelp(REVISION.changeSummary); })),
    fuAuthorLine, fuRolesNote,
    tx('h4', { class: 'cb-label' }, m => m.p2.fuDiff), fuDiffList, fuRefs, fuCancelBtn);
  const modeLine = h('span');
  const startNote = h('div', { class: 'cb-startnote' });
  const historyNotice = tx('p', { class: 'cb-help cb-history-notice' }, () => HT().notice);
  const form = attr(h('form', { class: 'cb-form', novalidate: true }, fuBox,
    h('div', { class: 'cb-field cb-objective' }, tx('label', { for: 'cb-objective', class: 'cb-label' }, m => m.objectiveLabel), objectiveIn, counter(objectiveIn, LIMIT.objective)),
    staExampleBtn, projDetails, decisionDetails, docsDetails, wfFields, budgetDetails,
    h('div', { class: 'cb-team' }, jevBox, manualBox, poolDetails, catalogueNote),
    h('div', { class: 'cb-form-foot' }, formMsg, planBox, startNote,
      historyNotice,
      h('div', { class: 'cb-start-row' }, startBtn,
        h('p', { class: 'cb-mode-line' }, modeLine, ' ', tx('button', { type: 'button', class: 'cb-link', onclick: () => setView('settings') }, m => m.changeInSettings))))), 'aria-label', m => m.briefAria);
  form.addEventListener('submit', ev => { ev.preventDefault(); startRun(); });

  // ── 머리 (네이비 70px): 브랜드 · KO / EN · 모드 배지 · 세션 상태
  const modeBadge = h('span', { class: 'cb-badge' });
  const profileState = h('span', { class: 'cb-profile-state' });
  const profileName = h('span', { class: 'cb-profile-name' });
  const banner = h('p', { class: 'cb-banner' });
  const live = h('div', { class: 'cb-sr', 'aria-live': 'polite' });
  // 보이는 글자는 KO·EN, 읽기 프로그램에는 그 언어 이름(자기 언어로)을 함께 준다. 지금 언어는 aria-pressed
  const langBtns = LANG_ORDER.map(l => h('button', { type: 'button', class: 'cb-lang-btn', lang: l, 'data-fk': `lang:${l}`, onclick: () => setLang(l) },
    l.toUpperCase(), h('span', { class: 'cb-sr' }, ` ${LANG_NAME[l]}`)));
  const langGroup = attr(h('div', { class: 'cb-lang', role: 'group' }, ...langBtns), 'aria-label', m => m.langGroup);

  // ── 프로젝트 카드: 편집 중에는 "Project brief" 입력, 실행이 시작되면 제목·목표 요약과 상태
  const projTitle = h('h2', { id: 'cb-project-h', class: 'cb-project-title', tabindex: '-1' });
  const projObjective = h('p', { class: 'cb-project-obj' });
  const projStatus = h('span', { class: 'cb-pill' });
  const projMeta = h('div', { class: 'cb-project-meta' });
  const setupLabel = h('span');
  const setupBtn = h('button', { type: 'button', class: 'cb-secondary', 'aria-expanded': 'true', 'aria-controls': 'cb-setup', 'data-fk': 'setup',
    onclick: () => { S.setupOpen = !S.setupOpen; renderControls(); if (S.setupOpen && !active()) objectiveIn.focus(); } }, icon('edit'), setupLabel);
  const dlJson = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'export-json', onclick: () => download('json') }, icon('download'), tx('span', null, m => m.exportJson));
  const dlMd = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'export-md', onclick: () => download('md') }, icon('download'), tx('span', null, m => m.exportReport));
  const moreOpts = h('details', { class: 'cb-menu' }, h('summary', null, tx('span', null, m => m.moreOptions), icon('chevron')), h('div', { class: 'cb-menu-body' }, dlJson));
  const projActions = h('div', { class: 'cb-project-actions' }, dlMd, moreOpts);
  const projBody = h('div', { class: 'cb-project-body' }, projObjective, projMeta, projActions);
  const setup = h('div', { id: 'cb-setup', class: 'cb-setup' }, form);
  const projectCard = h('section', { class: 'cb-panel cb-project', 'aria-labelledby': 'cb-project-h' },
    h('div', { class: 'cb-project-top' }, projTitle, projStatus, h('span', { class: 'cb-spacer' }), cancelBtn, setupBtn),
    runMsg, projBody, setup);

  // ── 전문가 작업공간 (프로젝트가 생긴 뒤에만): 전문가 목록 · 의견·파일 · 접히는 실행 기록
  const wsSub = h('p', { class: 'cb-ws-sub' });
  const fullLabel = h('span'), fullIcon = h('span');
  const fullBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'full', 'aria-controls': 'cb-log', onclick: () => setFull(!S.full) }, fullIcon, fullLabel);
  const clearBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'clear', onclick: () => clearView() }, icon('clear'), tx('span', null, m => m.clearView));
  const restoreBtn = h('button', { type: 'button', class: 'cb-tool', 'data-fk': 'restore', onclick: () => restoreView() }, icon('history'), tx('span', null, m => m.restoreHistory));
  const wsErrors = h('div', { class: 'cb-ws-errors', role: 'alert' });
  const roster = attr(h('div', { class: 'cb-roster', role: 'group' }), 'aria-label', m => m.rosterAria);
  const streamState = h('span', { class: 'cb-stream-state' });
  const streamErr = h('span', { class: 'cb-stream-err' });
  const streamLog = attr(h('ol', { class: 'cb-stream-log', role: 'log', tabindex: '0' }), 'aria-label', m => m.activityTitle);
  const streamNote = h('p', { class: 'cb-stream-note' });
  const inspector = h('div', { class: 'cb-inspector' });
  const activityLog = h('details', { class: 'cb-disclosure cb-log', id: 'cb-log' },
    h('summary', null, icon('chevron'), tx('span', { class: 'cb-log-title' }, m => m.activityTitle), tx('span', { class: 'cb-stream-ro' }, m => m.readOnly), streamErr, streamState),
    h('div', { class: 'cb-stream' }, h('div', { class: 'cb-stream-bar' }, icon('pulse'), tx('span', null, m => m.activityBar), h('span', { class: 'cb-spacer' }), clearBtn, restoreBtn),
      streamLog, streamNote));
  const wsPanel = h('section', { class: 'cb-panel cb-workspace', 'aria-labelledby': 'cb-ws-h' },
    h('div', { class: 'cb-ws-head' },
      h('div', { class: 'cb-ws-title' }, tx('h2', { id: 'cb-ws-h' }, m => m.workspaceTitle), wsSub),
      h('div', { class: 'cb-ws-actions' }, fullBtn)),
    wsErrors, roster, inspector, activityLog);

  // ── 오른쪽 (실행 뒤에만): 결과가 있으면 종합이 맨 위, 진행 · 지금 할 일
  const progressBody = h('div');
  const stepsBody = h('ol', { class: 'cb-steps' });
  const progressPanel = h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-prog-h' }, h('div', { class: 'cb-panel-head' }, tx('h2', { id: 'cb-prog-h' }, m => m.progress)), progressBody,
    h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), tx('span', null, m => m.progressDetails)), stepsBody));
  const tipBody = h('div');
  const tipPanel = h('section', { class: 'cb-tip', 'aria-labelledby': 'cb-tip-h' }, h('div', { class: 'cb-tip-head' }, icon('tip'), tx('h2', { id: 'cb-tip-h' }, m => m.whatNow)), tipBody);
  const synthTag = tx('span', { class: 'cb-badge is-demo' }, m => m.simulated);
  const synth = h('div', { class: 'cb-synth-body' });
  const confBody = h('div');
  const synthPanel = h('section', { class: 'cb-panel cb-synth', 'aria-labelledby': 'cb-synth-h' },
    h('div', { class: 'cb-panel-head' }, icon('chart'), tx('h2', { id: 'cb-synth-h' }, m => m.synthesis), synthTag), synth,
    h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), tx('span', null, m => m.confidenceDetails)), confBody));
  const aside = attr(h('aside', { class: 'cb-aside' }, progressPanel, tipPanel, synthPanel), 'aria-label', m => m.asideAria);

  // ── Guide · Help · Settings (기존 안내·설정 내용을 실제로 보여 준다)
  const guideStep = (i: number) => h('li', null, h('span', { class: 'cb-guide-n' }, String(i + 1)), tx('h3', null, m => m.guide[i][0]), tx('p', null, m => m.guide[i][1]));
  const goHome = h('button', { type: 'button', class: 'cb-primary', onclick: () => setView('home') }, icon('home'), tx('span', null, m => m.backHome));
  const guideView = h('section', { class: 'cb-view cb-page', id: 'cb-view-guide', 'aria-labelledby': 'cb-guide-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-guide-h' }, m => m.guideTitle), tx('p', null, m => m.guideIntro)),
    h('ol', { class: 'cb-guide-steps' }, ...EN.guide.map((_, i) => guideStep(i))),
    h('div', null, goHome));

  const faq = (i: number) => h('section', null, tx('h3', null, m => m.faq[i][0]), tx('p', null, m => m.faq[i][1]));
  const helpView = h('section', { class: 'cb-view cb-page', id: 'cb-view-help', 'aria-labelledby': 'cb-help-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-help-h' }, m => m.helpTitle), tx('p', null, m => m.helpIntro)),
    h('div', { class: 'cb-faq' }, ...EN.faq.map((_, i) => faq(i))));

  const settingsView = h('section', { class: 'cb-view cb-page', id: 'cb-view-settings', 'aria-labelledby': 'cb-settings-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-settings-h' }, m => m.settingsTitle), tx('p', null, m => m.settingsIntro)),
    h('div', { class: 'cb-settings' },
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-mode-h' }, tx('h2', { id: 'cb-mode-h' }, m => m.modeHeading),
        attr(h('div', { class: 'cb-segs', role: 'group' }, modeDemo, modeLive), 'aria-label', m => m.modeHeading),
        tx('p', { class: 'cb-help' }, m => m.modeLocked), demoBox, liveBox),
      h('section', { class: 'cb-panel', 'aria-labelledby': 'cb-about-h' }, tx('h2', { id: 'cb-about-h' }, m => m.aboutHeading),
        tx('p', { class: 'cb-help' }, m => m.aboutText),
        tx('p', { class: 'cb-help' }, m => m.legacyNote),
        tx('a', { href: '/lab' }, m => m.legacyLink))));

  // ── 주장과 근거 (프로젝트가 생긴 뒤, 보일 것이 있을 때만): 자료 원문 · 주장 장부 · 교차 검토. 전부 접힌 채로 시작한다
  const evidenceBody = h('div', { class: 'cb-evidence-body' });
  const evidencePanel = h('section', { class: 'cb-panel cb-evidence', 'aria-labelledby': 'cb-ev-h' },
    h('div', { class: 'cb-panel-head' }, tx('h2', { id: 'cb-ev-h' }, m => m.evidencePanel)), evidenceBody);
  const homeView = h('div', { class: 'cb-view cb-home', id: 'cb-view-home' }, h('div', { class: 'cb-center' }, projectCard, wsPanel, evidencePanel), aside);
  const historyBody = h('div', { class: 'cb-history-body' });
  const historyView = h('section', { class: 'cb-view cb-history', id: 'cb-view-history', 'aria-labelledby': 'cb-history-h' },
    h('div', { class: 'cb-page-head' }, tx('h2', { id: 'cb-history-h' }, () => HT().title), tx('p', null, () => HT().intro)), historyBody);
  const views: Record<View, HTMLElement> = { home: homeView, guide: guideView, help: helpView, settings: settingsView, history: historyView };
  const NAV: View[] = ['home', 'guide', 'help', 'settings', 'history'];
  // 카탈로그 규모는 bootstrap 뒤에 정해지므로 언어 전환(bind)과 renderNav 둘 다 다시 채운다
  const navFoot = bind(h('span'), (n, m) => { n.textContent = m.navFoot(catalogueCount(), PROJECT_MAX); });
  const navBtns = NAV.map(v => h('button', { type: 'button', class: 'cb-nav-btn', 'data-fk': `nav:${v}`, onclick: () => setView(v) }, icon(v === 'history' ? 'chart' : v), tx('span', null, m => m.nav[v])));

  root.replaceChildren(
    h('header', { class: 'cb-top' },
      h('div', { class: 'cb-brand' }, h('span', { class: 'cb-logo' }, icon('cloud')),
        h('div', { class: 'cb-brand-text' }, h('span', { class: 'cb-word' }, 'Cloudbite', h('small', null, 'v0.0.1')),
          tx('span', { class: 'cb-sub' }, m => m.brandSub))),
      h('div', { class: 'cb-top-right' }, langGroup, modeBadge,
        attr(h('div', { class: 'cb-profile', role: 'status' }, h('span', { class: 'cb-avatar' }, icon('user')),
          h('span', { class: 'cb-profile-text' }, profileName, profileState)), 'aria-label', m => m.sessionAria))),
    live,
    h('div', { class: 'cb-shell' },
      attr(h('nav', { class: 'cb-nav' }, tx('span', { class: 'cb-nav-label' }, m => m.navLabel),
        h('ul', { class: 'cb-nav-list' }, ...navBtns.map(b => h('li', null, b))),
        h('div', { class: 'cb-nav-foot' }, navFoot, pageLink(REQUEST_PATH, m => m.requestAccess),
          pageLink('/cloudbite/access', m => m.accessQr, { target: '_blank', rel: 'noopener noreferrer' }), pageLink(OWNER_INBOX_PATH, m => m.ownerInbox))), 'aria-label', m => m.navAria),
      h('main', { class: 'cb-main' }, banner, homeView, guideView, helpView, settingsView, historyView)));

  document.addEventListener('keydown', ev => { if ((ev as KeyboardEvent).key === 'Escape' && S.full) { ev.preventDefault(); setFull(false); } });

  // ── 렌더 (동적 영역만 다시 그린다. 포커스는 data-fk 로 되돌린다. 접기 상자는 다시 만들지 않아 열림 상태가 남는다)
  function keepFocus(fn: () => void): void {
    const a = document.activeElement as HTMLElement | null;
    const key = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    fn();
    if (key) { const n = root!.querySelector(`[data-fk="${CSS.escape(key)}"]`) as HTMLElement | null; if (n) n.focus(); }
  }

  function renderAll(): void {
    keepFocus(() => {
      // 오른쪽 패널은 프로젝트가 생긴 뒤에만: 그 전에는 편집 영역 한 열
      homeView.className = `cb-view cb-home${S.run?.project ? ' has-rail' : ''}`;
      renderNav(); renderControls(); renderCatalogue(); renderWork(); renderEvidence(); renderProgress(); renderSynth(); renderHistory();
    });
  }

  function renderNav(): void {
    NAV.forEach((v, i) => { navBtns[i].setAttribute('aria-current', v === S.view ? 'page' : 'false'); views[v].hidden = v !== S.view; });
    banner.hidden = modeBadge.hidden = S.view === 'history';
    LANG_ORDER.forEach((l, i) => langBtns[i].setAttribute('aria-pressed', String(l === lang)));
    navFoot.textContent = M.navFoot(catalogueCount(), PROJECT_MAX);
  }

  /** Settings 의 소유자 로그인 줄. 서버가 돌려준 세션 상태만 보이고, 로그인 자체는 소유자 요청함(/cloudbite/requests)에서 한다 */
  function ownerKids(): Kid[] {
    const m = M, o = S.owner;
    const inbox = h('a', { href: href(OWNER_INBOX_PATH) }, m.ownerInbox);
    const kids: Kid[] = [];
    if (o.status === 'loading') kids.push(h('p', { class: 'cb-help' }, m.ownerChecking));
    else if (o.status === 'error') kids.push(h('p', { class: 'cb-warn' }, m.ownerCheckFailed(o.error ? o.error(m) : ''), ' ', inbox),
      h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'owner-recheck', onclick: () => { void loadOwner(); } }, m.ownerRecheck));
    else if (o.authenticated) kids.push(h('div', { class: 'cb-owner' },
      h('p', { class: 'cb-ok' }, m.ownerSignedIn, S.adminToken.trim() ? ` ${m.ownerTokenWins}` : ''),
      h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'owner-signout', disabled: o.busy, onclick: () => { void ownerSignOut(); } }, o.busy ? m.signingOut : m.signOut)));
    else kids.push(h('p', { class: 'cb-help' }, o.hasCredentials ? m.ownerSignedOut : m.ownerNoCredentials, ' ', inbox));
    if (o.message) kids.push(h('p', { class: 'cb-warn' }, o.message(m)));
    return kids;
  }

  function renderControls(): void {
    const m = M;
    const demo = S.mode === 'demo';
    modeDemo.setAttribute('aria-pressed', String(demo)); modeLive.setAttribute('aria-pressed', String(!demo));
    modeDemo.disabled = modeLive.disabled = locked();
    const runMode = S.run?.mode ?? S.mode;
    modeBadge.textContent = runMode === 'demo' ? m.modeDemo : m.modeLive;
    modeBadge.className = `cb-badge ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    const token = S.adminToken.trim();
    const operator = isOperatorToken(S.adminToken);
    const owner = ownerAuthed();
    const v = visitor();
    profileName.textContent = token ? m.profileOperator : owner ? m.profileOwner : v ? v.name || m.profileVisitor : m.profileOperator;
    profileState.textContent = operator ? m.stateOperatorToken : token ? m.stateAdminToken
      : owner ? m.stateOwner : v ? m.stateVisitor(hhmm(v.expiresAt)) : m.stateNone;
    tokenLabel.textContent = operator ? m.tokenLabelOperator : m.tokenLabelAdmin;
    banner.textContent = runMode === 'demo' ? m.bannerDemo : m.bannerLive;
    banner.className = `cb-banner ${runMode === 'demo' ? 'is-demo' : 'is-live'}`;
    modeLine.textContent = demo ? m.nextDemo : viaOwner() ? m.nextLiveOwner : viaVisitor() ? m.nextLiveVisitor : m.nextLive;
    demoBox.hidden = !demo; liveBox.hidden = demo;
    const cfg = S.boot.data?.configuration;
    historyNotice.hidden = demo || cfg?.historyRetentionDays !== 30;
    const liveKids: Kid[] = [];
    if (S.boot.status === 'loading') liveKids.push(h('p', { class: 'cb-help' }, m.checkingServer));
    else if (S.boot.status === 'error') liveKids.push(h('p', { class: 'cb-warn' }, m.catalogueFailed(S.boot.error ? S.boot.error(m) : '')),
      h('button', { type: 'button', class: 'cb-ghost', onclick: () => loadBootstrap() }, m.checkAgain));
    else if (cfg && !cfg.liveReady) liveKids.push(h('div', { class: 'cb-warn' }, h('strong', null, m.liveNotReady),
      h('p', null, cfg.missing.length ? m.missingSettings : m.notReadyGeneric),
      cfg.missing.length ? h('ul', null, ...cfg.missing.map(x => h('li', null, h('code', null, x)))) : null));
    else if (cfg) liveKids.push(h('p', { class: 'cb-ok' }, m.serverReady(cfg.maxExperts)));
    liveKids.push(...ownerKids());
    // 소유자로 로그인했으면 방문자 한도·접근 문제는 실행과 관계없으므로 보이지 않는다
    if (v && !owner) liveKids.push(h('p', { class: 'cb-help' }, m.visitorSession(v.name, hhmm(v.expiresAt), visitorLeft(), v.maxProjects, v.maxExperts, !!token)));
    const problem = owner ? null : accessProblem();
    if (problem) liveKids.push(h('p', { class: 'cb-warn' }, problem(m), ' ', h('a', { href: href(REQUEST_PATH) }, m.requestAccess)));
    if (!owner && recheckable()) liveKids.push(checkAgain());
    liveStatus.replaceChildren(...liveKids.filter((k): k is Node => !!k));
    clearTokenBtn.hidden = !S.adminToken;

    const busy = locked();
    // 의미 있는 입력이 준비한 계획과 달라졌으면 계획을 버린다 (실행 중에는 계획이 없다)
    if (S.plan && !preparing() && S.plan.sig !== semanticSig()) { S.plan = null; S.planStale = true; }
    staExampleBtn.hidden = !catalogue().some(e => e.id === 'probably-primetime-sta');
    staExampleBtn.disabled = busy;
    for (const n of [titleIn, objectiveIn, contextIn, failIn, tokenIn, filterIn, stageSel, respSel, budgetFill, budgetClear, fuSummaryIn, fuCancelBtn,
      ...DECISION_FIELDS.map(f => decisionIns[f]), ...BUDGET_FIELDS.map(f => budgetIns[f])]) n.disabled = busy;
    budgetHint.textContent = m.budgetHint(BUDGET_FIELDS.some(f => budgetIns[f].value.trim() !== ''));
    renderDecisionHint(); renderDocs(busy); renderPmc(busy); renderFollowUp(); renderPlan();
    const liveReady = S.boot.status === 'ready' && !!cfg?.liveReady && liveCredential();
    const auto = autoRoute(), rt = routing();
    const none = !auto && S.selected.size === 0;
    // 시작 버튼은 편집 영역 끝의 하나뿐이다. 전문가를 고르지 않았거나 Jev 를 쓸 수 없으면 이유를 보이고 잠근다
    startBtn.disabled = busy || S.docReading > 0 || (!demo && !liveReady) || none || (auto && (!rt!.ready || !routeCredential()));
    // 실제 실행은 두 걸음이다: 계획 준비 → 이 계획으로 실행. 데모는 예전처럼 바로 시작한다
    startLabel.textContent = preparing() ? m.preparingLabel : S.run?.phase === 'routing' ? m.routingLabel : S.run?.phase === 'starting' ? m.starting : busy ? m.running
      : !demo ? (S.plan?.phase === 'ready' ? m.runPlanLabel : m.prepareLabel) : S.run ? m.runAgainDemo : m.runExpertsDemo;
    if (auto && !busy) modeLine.textContent += m.nextJev(limits().max);
    renderJev();
    cancelBtn.hidden = !busy;
    cancelBtn.disabled = S.run?.phase === 'cancelling' || S.run?.phase === 'starting';
    cancelLabel.textContent = S.run?.phase === 'cancelling' ? m.stopping : m.stop;

    // 편집 영역: 실행 전·검증 오류·만들기 실패 때는 열려 있다. 접기·펴기 버튼은 실행이 있을 때만
    const p = S.run?.project;
    if (!S.run || S.formErrors.length || (S.run.phase === 'error' && !p) || (S.plan && !active())) S.setupOpen = true;
    setup.hidden = !S.setupOpen;
    setupBtn.hidden = !S.run;
    setupBtn.setAttribute('aria-expanded', String(S.setupOpen));
    setupLabel.textContent = S.setupOpen ? m.hideSetup : m.editProject;
    detailsHint.textContent = clip(titleIn.value.trim() || m.nameRequired, 60);

    const formKids = S.formErrors.map(e => h('p', null, e.text(m)));
    if (!demo && S.plan?.phase === 'error' && S.plan.error) formKids.push(h('p', null, S.plan.error(m)));
    if (S.run?.error && !p) formKids.push(h('p', null, S.run.error(m)));
    fill(formMsg, ...formKids);
    const runKids: Kid[] = [];
    if (S.run?.error && p) runKids.push(h('p', null, S.run.error(m)));
    if (S.run && p && S.run.phase === 'error' && S.run.pollErrors >= 4) runKids.push(h('button', { type: 'button', class: 'cb-ghost', onclick: () => {
      const r = S.run;
      if (!r?.project || r.phase !== 'error') return;
      r.phase = 'running'; r.error = null; r.pollErrors = 0; renderAll(); void poll(S.gen);
    } }, m.checkStatusAgain));
    fill(runMsg, ...runKids);

    // 시작 버튼 옆 안내: 이유가 있을 때만 (전문가 없음, 방문자 사용량, 실제 실행을 막는 이유)
    const notes: Kid[] = [];
    if (!busy) {
      if (none) notes.push(h('p', { class: 'cb-need' }, m.needExpert));
      if (!demo && v && !token && !owner) notes.push(h('p', { class: 'cb-help' }, m.visitorLeftLabel, h('strong', null, m.visitorLeft(visitorLeft(), v.maxProjects)),
        m.visitorEach(v.maxExperts, hhmm(v.expiresAt))));
      if (!demo && S.boot.status !== 'loading' && !liveReady) notes.push(h('p', { class: 'cb-warn' },
        problem ? problem(m) : m.liveBlocked, ' ',
        h('button', { type: 'button', class: 'cb-link', onclick: () => setView('settings') }, m.openSettings)), !owner && recheckable() ? checkAgain() : null);
    }
    fill(startNote, ...notes);

    selCount.textContent = m.selCount(S.selected.size, limits().max);
    // 접힌 카드는 실행한 프로젝트의 브리프를 보인다 (편집 중에는 같은 제목·목표를 되풀이하지 않는다)
    projTitle.textContent = S.setupOpen ? m.projectBrief : clip(p?.brief.title || titleIn.value.trim() || m.untitled, 120);
    projStatus.hidden = !S.run;
    const pst = p ? p.status : S.run?.phase === 'starting' || S.run?.phase === 'routing' ? 'running' : S.run?.phase === 'error' ? 'failed' : 'draft';
    projStatus.textContent = S.run?.phase === 'routing' ? m.routingPill : S.run?.phase === 'starting' ? m.startingPill : m.projectStatus[pst];
    projStatus.className = `cb-pill p-${pst}`;
    projBody.hidden = S.setupOpen || !S.run;
    projObjective.textContent = p?.brief.objective || objectiveIn.value.trim();
    projActions.hidden = !p;
    dlJson.disabled = dlMd.disabled = !p;
    const meta: Kid[] = [];
    if (p) {
      const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
      const valid = p.experts.filter(e => e.status === 'completed' && e.opinion).length;
      const [f1, f2] = m.finished(done, p.experts.length), [v1, v2] = m.validOpinions(valid);
      meta.push(h('span', null, h('strong', null, f1), f2), h('span', null, h('strong', null, v1), v2));
    }
    if (v && !token && !owner) meta.push(h('span', null, m.visitorLeftLabel, h('strong', null, m.visitorLeft(visitorLeft(), v.maxProjects)), m.visitorEnds(hhmm(v.expiresAt))));
    if (p && S.run?.mode === 'live') meta.push(h('span', null, m.projectLabel, h('code', null, clip(p.id, 24))));
    fill(projMeta, ...meta);
  }

  /** 짧은 설명: 알려진 역할은 화면 언어의 설명, 아니면 카탈로그 요약, 없으면 기계용 분야 이름을 사람이 읽는 말로 */
  function roleBlurb(e: ExpertDefinition): string { return (lang === 'ko' && ROLE_KO[e.id]) || e.summary.trim() || domainLabel(e.domain); }

  function renderCatalogue(): void {
    const m = M;
    const list = catalogue();
    const core = list.slice(0, CORE_ROLES), rest = list.slice(CORE_ROLES);
    const q = filterIn.value.trim().toLowerCase();
    const busy = active();
    const full = S.selected.size >= limits().max;
    // prefix: 기본 역할(x) · 전체 목록(xa). 같은 역할이 두 번 보여도 선택 상태는 S.selected 하나다
    const opt = (e: ExpertDefinition, prefix: string) => {
      const on = S.selected.has(e.id);
      const id = `cb-${prefix}-${e.id}`;
      const outsideResponse = !!S.followUp?.authorResponse && !S.followUp.authorResponse.affected.includes(e.id);
      const cb = h('input', { type: 'checkbox', id, 'data-fk': `${prefix}:${e.id}`, checked: on, disabled: busy || outsideResponse || (!on && full) });
      cb.addEventListener('change', () => toggleExpert(e.id, cb.checked));
      return h('label', { class: `cb-expert-opt${on ? ' is-on' : ''}`, for: id }, cb,
        h('span', { class: 'cb-opt-text' }, h('span', { class: 'cb-opt-name' }, e.name), h('span', { class: 'cb-opt-desc' }, roleBlurb(e))));
    };
    coreBox.replaceChildren(...core.map(e => opt(e, 'x')));
    if (!list.length) coreBox.append(h('p', { class: 'cb-empty' }, S.mode === 'live' ? m.catalogueEmptyLive : m.noRoles));
    moreDetails.hidden = rest.length === 0;
    moreLabel.textContent = m.allExperts(list.length);
    // 검색은 원문 요약과 화면 언어의 설명을 모두 본다
    const shown = q ? list.filter(e => `${e.name} ${e.domain} ${e.summary} ${roleBlurb(e)}`.toLowerCase().includes(q)) : rest;
    moreBox.replaceChildren(...shown.slice(0, CATALOGUE_MAX).map(e => opt(e, 'xa')));
    if (!shown.length) moreBox.append(h('p', { class: 'cb-empty' }, m.noMatch));
    // 접힌 전체 목록에서 고른 역할도 늘 보이게 요약한다
    const coreIds = new Set(core.map(e => e.id));
    const hiddenSel = [...S.selected].filter(id => !coreIds.has(id)).map(id => findDef(id)?.name ?? id);
    alsoSel.textContent = hiddenSel.length ? m.alsoSelected(hiddenSel.join(', ')) : '';
    alsoSel.hidden = !hiddenSel.length;
    catalogueNote.textContent = catalogueIsBuiltin() ? m.builtinRoles : full ? m.maxReached(limits().max) : m.recommended;
    catalogueNote.hidden = autoRoute();
    renderPool();
  }

  /** Jev 상자: routing 이 있을 때만. 자동이면 직접 고르기를 숨기고 고른 팀은 읽기 전용으로, 쓸 수 없으면 이유만 보인다 (규칙 대체 없음) */
  function renderJev(): void {
    const m = M, rt = routing(), auto = autoRoute(), busy = locked();
    jevBox.hidden = !rt;
    manualBox.hidden = auto;
    jevToggle.disabled = busy;
    if (!rt) return;
    jevToggle.textContent = auto ? m.jevManualBtn : m.jevAutoBtn;
    jevHelp.hidden = !auto;
    jevHelp.textContent = `${m.jevHelp(limits().max, rt.model)}${S.mode === 'demo' ? ` ${m.jevDemoNote}` : ''}`;
    if (!auto) { fill(jevBody, h('p', { class: 'cb-help' }, m.jevManualNote)); return; }
    const kids: Kid[] = [];
    if (!rt.ready) kids.push(h('p', { class: 'cb-warn' }, m.jevUnavailable));
    else if (!routeCredential()) kids.push(h('p', { class: 'cb-warn' }, m.jevNeedAccess, ' ', h('a', { href: href(REQUEST_PATH) }, m.requestAccess)));
    const r = S.route?.result;
    if (S.run?.phase === 'routing' || (preparing() && S.plan!.routed && !r)) kids.push(h('p', { class: 'cb-jev-status' }, m.jevRouting));
    else if (r) {
      // 적합도는 0–1 이면 백분율로, 다른 척도면 숫자 그대로 (전문가 확신도·정확도로 적지 않는다)
      const fit = (v: number) => v >= 0 && v <= 1 ? `${Math.round(v * 100)}%` : String(Math.round(v * 100) / 100);
      const t = r.harness;
      kids.push(h('p', { class: 'cb-label' }, m.jevChosen(r.expertIds.length)),
        h('ol', { class: 'cb-suggest-list', 'aria-label': m.jevListAria }, ...r.expertIds.map(id => {
          const match = r.matches.find(x => x.expertId === id);
          const sel = t?.selections.find(x => x.expertId === id);
          const role = sel ? sel.perspectiveIds.length ? m.teamCovers(sel.perspectiveIds.map(pid => perspectiveName(t!, pid)).join(', ')) : m.teamAdditional : '';
          const desc = [match ? m.jevSuitability(fit(match.relevance)) : '', role].filter(Boolean).join(' · ');
          return h('li', null, h('span', { class: 'cb-opt-name' }, findDef(id)?.name ?? id), desc ? h('span', { class: 'cb-opt-desc' }, desc) : null);
        })));
      if (t) kids.push(...teamExplanation(t, r, fit));
      if (!busy && S.route!.key !== routeKey({ title: titleIn.value.trim(), objective: objectiveIn.value.trim(), context: contextIn.value.trim(), ...currentExtras() })) kids.push(h('p', { class: 'cb-help' }, m.jevStale));
    }
    fill(jevBody, ...kids);
  }

  /** 관점 표시 이름: 아는 고정 id 는 지금 언어로, 아니면 서버가 보낸 이름을 글자 그대로 */
  function perspectiveName(t: CloudbiteRoutingHarness, id: string): string {
    return M.teamPerspectiveName[id] ?? t.perspectives.find(p => p.id === id)?.name ?? id;
  }

  /** v2 팀 설명: 짧은 관점 요약·빈 관점·한도 경고는 늘 보이고, 관점별 필요도·뺀 역할·읽기 전용 근거는 접힌 상자에 둔다 */
  function teamExplanation(t: CloudbiteRoutingHarness, r: RouteResult, fit: (v: number) => string): Kid[] {
    const m = M, name = (id: string) => findDef(id)?.name ?? id;
    const by = (status: HarnessStatus) => t.perspectives.filter(p => p.status === status);
    const uncovered = by('uncovered'), limited = by('limited');
    const kids: Kid[] = [h('p', { class: 'cb-help cb-team-coverage' }, m.teamCoverage(by('covered').length, limited.length, uncovered.length))];
    // normalizeHarness 가 고정 코드만 남겼다
    const warns = t.warnings.map(w => m.teamWarning[w as HarnessWarning]);
    if (uncovered.length) warns.push(m.teamGaps(uncovered.map(p => perspectiveName(t, p.id)).join(', ')));
    if (limited.length) warns.push(m.teamLimitedList(limited.map(p => perspectiveName(t, p.id)).join(', ')));
    if (warns.length) kids.push(h('div', { class: 'cb-warn cb-team-warn', role: 'note' }, ...warns.map(w => h('p', null, w))));
    const box = h('details', { class: 'cb-disclosure cb-quiet cb-team-why', open: S.teamOpen },
      h('summary', null, icon('chevron'), h('span', null, m.teamWhy)),
      h('div', { class: 'cb-disclosure-body' },
        h('p', { class: 'cb-help' }, m.teamRationale),
        h('p', { class: 'cb-help' }, m.teamNoPeer),
        h('p', { class: 'cb-help' }, m.teamEligible(t.eligibleCount, r.evaluatedCount)),
        t.perspectives.length ? h('p', { class: 'cb-label' }, m.teamPerspectivesTitle) : null,
        t.perspectives.length ? h('ul', { class: 'cb-team-list' }, ...t.perspectives.map(p => h('li', null,
          m.teamPerspective(perspectiveName(t, p.id), fit(p.need), m.teamStatus[p.status]), p.expertIds.length ? m.teamBy(p.expertIds.map(name).join(', ')) : ''))) : null,
        t.excluded.length ? h('p', { class: 'cb-label' }, m.teamExcludedTitle) : null,
        t.excluded.length ? h('ul', { class: 'cb-team-list' }, ...t.excluded.map(x => h('li', null,
          `${name(x.expertId)} — ${m.teamReason[x.reason]}${x.coveredBy ? ` ${name(x.coveredBy)}` : ''}`))) : null));
    box.addEventListener('toggle', () => { S.teamOpen = box.open; });
    return [...kids, box];
  }

  /** 자동(Jev) ↔ 직접 고르기. 실행 중에는 바꾸지 않는다. 직접 고른 선택은 그대로 두고 Jev 팀을 선택에 넣지 않는다 */
  function toggleRouteMode(): void {
    if (locked() || !routing()) return;
    S.routeMode = S.routeMode === 'auto' ? 'manual' : 'auto';
    S.formErrors = [];
    pruneSelection();
    keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
  }

  /** 역할 하나를 고르거나 뺀다. 한도를 넘는 선택은 받지 않는다 (상자도 잠겨 있다) */
  function toggleExpert(id: string, on: boolean): void {
    if (locked()) return;
    if (on && !S.selected.has(id) && S.selected.size >= limits().max) { keepFocus(renderCatalogue); return; }
    if (on) S.selected.add(id); else S.selected.delete(id);
    S.formErrors = []; keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
  }

  const pool = (): Pool | null => S.boot.data?.pool ?? null;
  /** 실행 가능 = 정리된 pool 이 available 이라 하고 그 역할이 지금 카탈로그에 있다 (데모 내장 역할로 바뀌면 실행 가능 아님) */
  const poolRunnable = (e: PoolEntry): e is PoolEntry & { expertId: string } => e.availability === 'available' && !!e.expertId && catalogue().some(x => x.id === e.expertId);
  const briefText = () => [titleIn.value, objectiveIn.value, contextIn.value].join('\n');

  function renderPool(): void {
    const m = M, pl = pool();
    poolDetails.hidden = suggestBox.hidden = !pl;
    if (!pl) return;
    const busy = active(), full = S.selected.size >= limits().max;
    poolLabel.textContent = m.poolSummary(pl.entries.length, pl.entries.filter(poolRunnable).length);
    // 분야·보기 목록은 언어마다 다시 만들되 고른 값은 상태(S)에서 되살린다
    const cats = new Map<string, PoolEntry['categoryLabel']>();
    for (const e of pl.entries) if (!cats.has(e.category)) cats.set(e.category, e.categoryLabel);
    if (S.poolCat && !cats.has(S.poolCat)) S.poolCat = '';
    poolCat.replaceChildren(h('option', { value: '' }, m.poolCategoryAll), ...[...cats].map(([c, l]) => h('option', { value: c }, l[lang])));
    poolCat.value = S.poolCat;
    poolShow.replaceChildren(...(['all', 'available', 'planned'] as PoolShow[]).map(v => h('option', { value: v }, m.poolShow[v])));
    poolShow.value = S.poolShow;
    const q = poolText(poolSearch.value).trim();
    const hay = (e: PoolEntry) => poolText([`${e.catalogNumber}`, `#${e.catalogNumber}`, e.name, e.domain, e.mission, e.categoryLabel.en, e.categoryLabel.ko,
      e.mappingNote ?? '', ...e.keywords, e.expertId ? findDef(e.expertId)?.name ?? '' : ''].join(' '));
    // Jev 가 고르는 동안 카탈로그는 둘러보기만 한다 (상자는 잠기고 직접 고른 선택도 표시하지 않는다)
    const auto = autoRoute();
    const isSel = (e: PoolEntry) => !auto && poolRunnable(e) && S.selected.has(e.expertId);
    const match = (e: PoolEntry) => (!S.poolCat || e.category === S.poolCat)
      && (S.poolShow === 'all' || (S.poolShow === 'available') === poolRunnable(e)) && (!q || hay(e).includes(q));
    // 고른 역할은 필터와 관계없이 맨 위에 남는다
    const chosen = pl.entries.filter(isSel), hits = pl.entries.filter(e => !isSel(e) && match(e));
    const shown = hits.slice(0, S.poolLimit);
    const row = (e: PoolEntry) => {
      const ok = poolRunnable(e), on = isSel(e), id = `cb-xp-${e.id}`;
      // 계획 중인 역할은 늘 잠긴 상자다 — 고를 수도, 제출될 수도 없다
      const outsideResponse = !!S.followUp?.authorResponse && (!e.expertId || !S.followUp.authorResponse.affected.includes(e.expertId));
      const cb = h('input', { type: 'checkbox', id, 'data-fk': `xp:${e.id}`, checked: on, disabled: !ok || busy || auto || outsideResponse || (!on && full) });
      if (ok) cb.addEventListener('change', () => toggleExpert(e.expertId!, cb.checked));
      const def = ok ? findDef(e.expertId!) : undefined;
      const meta = [e.categoryLabel[lang], def && def.name !== e.name ? m.poolRunsAs(def.name) : ''].filter(Boolean).join(' · ');
      return h('label', { class: `cb-expert-opt cb-pool-opt${on ? ' is-on' : ''}${ok ? '' : ' is-planned'}`, for: id }, cb,
        h('span', { class: 'cb-opt-text' },
          h('span', { class: 'cb-opt-name' }, h('span', { class: 'cb-pool-n' }, `#${e.catalogNumber}`), ' ', e.name),
          h('span', { class: 'cb-pool-meta' }, meta),
          e.mission ? h('span', { class: 'cb-opt-desc' }, e.mission) : null,
          h('span', { class: 'cb-pool-tags' },
            h('span', { class: `cb-tag ${ok ? 'is-avail' : 'is-planned'}` }, ok ? m.poolAvailable : m.poolPlanned),
            h('span', { class: 'cb-tag' }, m.poolKnowledge[e.knowledge]), h('span', { class: 'cb-tag is-unval' }, m.poolUnvalidated))));
    };
    fill(poolList, chosen.length ? h('p', { class: 'cb-pool-group' }, m.poolSelectedGroup) : null, ...chosen.map(row),
      chosen.length && shown.length ? h('hr', { class: 'cb-pool-sep' }) : null, ...shown.map(row),
      hits.length ? null : h('p', { class: 'cb-empty' }, m.poolNoMatch));
    poolCount.textContent = m.poolCount(shown.length, hits.length);
    const left = hits.length - shown.length;
    poolMore.hidden = left <= 0;
    poolMore.textContent = m.poolShowMore(Math.min(POOL_PAGE, Math.max(0, left)));
    renderSuggest();
  }

  /** 제안 상자. 제안은 데이터(항목 id·찾은 키워드)로 두어 언어를 바꿔도 그대로 다시 그린다 */
  function renderSuggest(): void {
    const m = M, pl = pool(), sg = S.suggest, busy = active();
    suggestBtn.disabled = busy || !pl;
    suggestHelp.textContent = m.suggestHelp(limits().max);
    if (!pl || !sg) { fill(suggestBody); return; }
    if (sg.empty) { fill(suggestBody, h('p', { class: 'cb-help' }, sg.empty === 'brief' ? m.suggestBriefEmpty : m.suggestEmpty)); return; }
    const valid = sg.picks.filter(p => pl.entries.some(e => e.id === p.entryId && poolRunnable(e) && e.expertId === p.expertId)).slice(0, limits().max);
    const stale = sg.brief !== briefText() || valid.length !== sg.picks.length;
    const same = valid.length === S.selected.size && valid.every(p => S.selected.has(p.expertId));
    const apply = h('button', { type: 'button', class: 'cb-primary', 'data-fk': 'pool-apply', disabled: busy || !valid.length || same, onclick: () => applySuggestion() },
      m.suggestApply(valid.length));
    const dismiss = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'pool-dismiss', onclick: () => { S.suggest = null; renderSuggest(); suggestBtn.focus(); } }, m.suggestDismiss);
    const item = (p: PoolPick) => {
      const e = pl.entries.find(x => x.id === p.entryId)!;
      return h('li', null, h('span', { class: 'cb-opt-name' }, h('span', { class: 'cb-pool-n' }, `#${e.catalogNumber}`), ' ', e.name),
        h('span', { class: 'cb-opt-desc' }, m.suggestMatched(p.matched.join(', '))));
    };
    fill(suggestBody, h('ol', { class: 'cb-suggest-list', 'aria-label': m.suggestListAria }, ...valid.map(item)),
      stale ? h('p', { class: 'cb-warn' }, m.suggestStale) : null, same ? h('p', { class: 'cb-help' }, m.suggestCurrent) : null,
      h('div', { class: 'cb-suggest-actions' }, apply, dismiss));
  }

  function suggest(): void {
    const pl = pool();
    if (!pl || active()) return;
    const brief = briefText();
    const picks = brief.trim() ? suggestTeam(brief, pl.entries, catalogue().map(e => e.id), limits().max) : [];
    S.suggest = { brief, picks, empty: !brief.trim() ? 'brief' : picks.length ? null : 'none' };
    keepFocus(renderSuggest);
  }

  /** 제안을 적용: 선택만 제안된 실행 역할로 바꾼다. 실행·요청·타이머 없음 */
  function applySuggestion(): void {
    const pl = pool(), sg = S.suggest;
    if (!pl || !sg || active()) return;
    const next = sg.picks.filter(p => pl.entries.some(e => e.id === p.entryId && poolRunnable(e) && e.expertId === p.expertId)).map(p => p.expertId).slice(0, limits().max);
    if (!next.length) return;
    S.selected.clear();
    for (const id of next) S.selected.add(id);
    S.formErrors = [];
    keepFocus(() => { renderCatalogue(); renderControls(); renderProgress(); });
    live.textContent = M.suggestApplied(next.length);
  }

  function statusDot(s: ExpertStatus): HTMLElement { return h('span', { class: `cb-dot s-${s}`, 'aria-hidden': 'true' }); }

  function streamRows(p: ConsoleProject): Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string }> {
    const rows: Array<{ key: string; at: number; name: string; kind: ExpertActivity['kind']; message: string; seq: number }> = [];
    let seq = 0;
    for (const e of p.experts) for (const a of e.activity) rows.push({ key: `${e.id}\n${a.id}`, at: a.at, name: e.name, kind: a.kind, message: a.message, seq: seq++ });
    return rows.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function renderWork(): void {
    const m = M;
    const p = S.run?.project;
    restoreBtn.disabled = S.hiddenRows.size === 0;
    // 프로젝트가 생기기 전에는 빈 작업공간·기록을 보이지 않는다
    wsPanel.hidden = !S.run || !p;
    if (!S.run || !p) {
      if (S.full) paintFull(false);
      roster.replaceChildren(); inspector.replaceChildren(); wsErrors.replaceChildren(); streamLog.replaceChildren();
      return;
    }
    if (!S.focusExpert || !p.experts.some(e => e.id === S.focusExpert)) S.focusExpert = p.experts[0]?.id ?? '';
    // 실패는 접힌 기록 안에 숨기지 않고 전문가 목록 위에 보인다 (서버·모델 오류 원문은 그대로)
    const failed = p.experts.filter(e => e.status === 'failed' || e.invalidOpinion);
    fill(wsErrors, ...failed.map(e => h('p', { class: 'cb-warn' }, h('strong', null, e.name), e.error ? m.failedWith(e.error) : e.invalidOpinion ? m.invalidExcluded : m.failedPlain)));
    roster.replaceChildren(...p.experts.map(e => h('button', { type: 'button', class: `cb-card s-${e.status}${e.id === S.focusExpert ? ' is-focus' : ''}`, 'data-fk': `card:${e.id}`,
      'aria-pressed': String(e.id === S.focusExpert), onclick: () => { if (S.focusExpert !== e.id) S.artifactPicked = false; S.focusExpert = e.id; keepFocus(renderWork); } },
      h('span', { class: 'cb-card-head' }, statusDot(e.status), h('span', { class: 'cb-card-name' }, e.name)),
      h('span', { class: 'cb-card-foot' }, h('span', { class: 'cb-card-status' }, m.status[e.status]),
        e.opinion ? h('span', { class: `cb-chip d-${e.opinion.direction}` }, `${m.direction[e.opinion.direction]} ${e.opinion.confidence}%`) : null,
        e.invalidOpinion ? h('span', { class: 'cb-chip d-invalid' }, m.invalidChip) : null))));
    wsSub.textContent = m.workspaceSub;

    // 실행 기록: 모든 전문가가 보고한 활동을 시간순으로. 숨긴 줄은 화면에서만 뺀다
    const rows = streamRows(p);
    const visible = rows.filter(r => !S.hiddenRows.has(r.key));
    const shown = visible.slice(-STREAM_ROWS);
    const working = p.experts.filter(e => !TERMINAL_EXPERT.includes(e.status) && e.status !== 'queued').length;
    const phase = S.run.phase === 'cancelling' ? m.phaseStopping : m.projectStatus[p.status].toLowerCase();
    streamState.textContent = m.streamState(S.run.mode === 'demo', phase, working, rows.length);
    const errs = rows.filter(r => r.kind === 'error').length;
    streamErr.textContent = errs ? m.errorsCount(errs) : '';
    streamErr.hidden = !errs;
    const atBottom = streamLog.scrollHeight - streamLog.scrollTop - streamLog.clientHeight < 48;
    if (!shown.length) {
      streamLog.replaceChildren(h('li', { class: 'cb-stream-empty' }, S.hiddenRows.size ? m.viewCleared : m.noActivityYet));
    } else {
      streamLog.replaceChildren(...shown.map(r => h('li', { class: `cb-row k-${r.kind}` },
        h('time', { class: 'cb-row-at' }, clock(r.at)), h('span', { class: 'cb-row-who' }, r.name),
        h('span', { class: 'cb-row-kind' }, m.kind[r.kind]), h('span', { class: 'cb-row-msg' }, r.message))));
    }
    if (atBottom) streamLog.scrollTop = streamLog.scrollHeight;
    const hiddenCount = rows.length - visible.length;
    streamNote.textContent = hiddenCount ? m.hiddenRows(hiddenCount) : visible.length > shown.length ? m.latestRows(shown.length, visible.length) : '';
    clearBtn.disabled = visible.length === 0;
    renderDetail(p);
  }

  function renderDetail(p: ConsoleProject): void {
    const m = M;
    const e = p.experts.find(x => x.id === S.focusExpert);
    if (!e) { inspector.replaceChildren(); return; }
    const def = findDef(e.expertId);
    const tabs: Array<[typeof S.tab, string]> = [['artifacts', m.tabFiles(e.artifacts.length)], ['activity', m.tabActivity], ['workorder', m.tabWorkorder], ['persona', m.tabPersona]];
    const tabBtns = tabs.map(([k, label]) => h('button', { type: 'button', role: 'tab', id: `cb-tab-${k}`, 'data-fk': `tab:${k}`, 'aria-selected': String(S.tab === k),
      'aria-controls': 'cb-tabpanel', tabindex: S.tab === k ? '0' : '-1', class: 'cb-tab', onclick: () => { S.tab = k; keepFocus(renderWork); } }, label));
    const tablist = h('div', { class: 'cb-tabs', role: 'tablist', 'aria-label': m.tabsAria(e.name) }, ...tabBtns);
    tablist.addEventListener('keydown', ev => {
      const k = (ev as KeyboardEvent).key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
      ev.preventDefault();
      const i = tabs.findIndex(([t]) => t === S.tab);
      const n = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      S.tab = tabs[n][0]; renderWork();
      (root!.querySelector(`#cb-tab-${S.tab}`) as HTMLElement | null)?.focus();
    });
    let body: Node;
    if (S.tab === 'activity') {
      body = e.activity.length ? h('ol', { class: 'cb-activity' }, ...e.activity.slice().reverse().map(a =>
        h('li', { class: `k-${a.kind}` }, h('span', { class: 'cb-act-kind' }, m.kind[a.kind]),
          h('span', { class: 'cb-act-msg' }, a.message), h('time', { class: 'cb-act-at' }, clock(a.at)))))
        : h('p', { class: 'cb-empty' }, m.noActivity);
    } else if (S.tab === 'artifacts') {
      body = artifactView(p, e);
    } else if (S.tab === 'workorder') {
      const wo = e.artifacts.find(a => a.path === 'WORKORDER.md' && typeof a.content === 'string');
      body = h('div', null, !wo ? h('p', { class: 'cb-help' }, m.workorderPreview) : null,
        h('pre', { class: 'cb-file' }, wo?.content ?? (def ? workorderText(def, p.brief) : m.roleMissing)));
    } else {
      body = def ? h('div', null, h('pre', { class: 'cb-file' }, personaText(def))) : h('p', { class: 'cb-empty' }, m.roleNotInCatalogue);
    }
    const op = e.opinion;
    const where = e.sandboxId ? (S.run?.mode === 'demo' ? m.whereDemo(e.sandboxId) : m.whereLive(e.sandboxId)) : m.wherePending;
    const blurb = def ? (lang === 'ko' && ROLE_KO[def.id]) || def.summary : '';
    fill(inspector,
      h('div', { class: 'cb-detail-head' }, statusDot(e.status), h('h3', null, e.name), h('span', { class: 'cb-help' }, `${m.status[e.status]} · ${where}`)),
      blurb ? h('p', { class: 'cb-help cb-detail-sum' }, blurb) : null,
      e.error ? h('p', { class: 'cb-warn' }, m.errorLine(e.error)) : null,
      op ? h('div', { class: `cb-opinion d-${op.direction}` }, h('span', { class: `cb-chip d-${op.direction}` }, m.selfAssessed(m.direction[op.direction], op.confidence)),
        h('p', null, op.summary)) : null,
      tablist, h('div', { id: 'cb-tabpanel', role: 'tabpanel', 'aria-labelledby': `cb-tab-${S.tab}`, class: 'cb-tabpanel' }, body));
  }

  function artifactView(p: ConsoleProject, e: ConsoleExpert): Node {
    const m = M;
    if (!e.artifacts.length) return h('p', { class: 'cb-empty' }, m.noFiles);
    if (!S.artifactPicked || !e.artifacts.some(a => a.path === S.artifactPath)) S.artifactPath = (e.artifacts.find(a => a.path === 'out/report.md') ?? e.artifacts.find(a => a.path.startsWith('out/')) ?? e.artifacts[0]).path;
    const a = e.artifacts.find(x => x.path === S.artifactPath)!;
    const list = h('ul', { class: 'cb-files', 'aria-label': m.filesAria }, ...e.artifacts.map(x => h('li', null, h('button', { type: 'button', class: `cb-filebtn${x.path === a.path ? ' is-on' : ''}`,
      'data-fk': `file:${x.path}`, 'aria-pressed': String(x.path === a.path), onclick: () => { S.artifactPath = x.path; S.artifactPicked = true; keepFocus(renderWork); } },
      icon('file'), h('span', { class: 'cb-file-text' }, h('span', { class: 'cb-file-path' }, x.path), h('span', { class: 'cb-help' }, x.label))))));
    let view: Node;
    if (typeof a.content === 'string') view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': m.fileContentsAria(a.path) }, a.content || m.emptyFile);
    else if (S.run?.mode === 'live' && S.run.accessToken) {
      const key = `${p.id}\n${e.expertId}\n${a.path}`;
      const c = S.artifactCache.get(key);
      if (!c) { fetchArtifact(p.id, e.expertId, a.path, key); view = h('p', { class: 'cb-help' }, m.loadingFile); }
      else if (c.state === 'loading') view = h('p', { class: 'cb-help' }, m.loadingFile);
      else if (c.state === 'error') view = h('div', null, h('p', { class: 'cb-warn' }, c.text(m)),
        h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'file-reload', onclick: () => { S.artifactCache.delete(key); keepFocus(renderWork); } }, m.loadAgain));
      else view = h('pre', { class: 'cb-file', tabindex: '0', 'aria-label': m.fileContentsAria(a.path) }, c.text || m.emptyFile);
    } else view = h('p', { class: 'cb-empty' }, m.noContents);
    return h('div', { class: 'cb-artifacts' }, list, view);
  }

  function renderProgress(): void {
    const m = M;
    const run = S.run, p = run?.project;
    aside.hidden = !run || !p;
    if (!run || !p) { progressBody.replaceChildren(); stepsBody.replaceChildren(); tipBody.replaceChildren(); return; }
    // 진행 단계는 관찰된 상태에서만 만든다 (클릭으로 완료되는 단계 없음)
    type StepState = 'done' | 'active' | 'pending' | 'blocked';
    const step = (label: string, state: StepState, n = '') => h('li', { class: `cb-step is-${state}` },
      h('span', { class: 'cb-step-mark', 'aria-hidden': 'true' }, state === 'done' ? icon('check') : null),
      h('span', null, label, h('span', { class: 'cb-sr' }, ` — ${m.stepState[state]}`)), h('span', { class: 'cb-step-n' }, n));
    const n = p.experts.length;
    const started = p.experts.filter(e => e.status !== 'queued').length;
    const working = p.experts.filter(e => e.status === 'running' || e.status === 'provisioning').length;
    const done = p.experts.filter(e => TERMINAL_EXPERT.includes(e.status)).length;
    const a = aggregate(p, m);
    const terminal = TERMINAL_PROJECT.includes(p.status);
    const stopped = p.status === 'cancelled' || p.status === 'failed';
    const bar = h('div', { class: 'cb-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': n, 'aria-valuenow': done, 'aria-label': m.progressAria },
      ...p.experts.map(e => h('span', { class: `cb-bar-seg s-${e.status}`, title: `${e.name}: ${m.status[e.status]}` })));
    fill(progressBody,
      h('p', { class: 'cb-progress-num' }, h('strong', null, m.progressNum(done, n)), m.progressTail(m.projectStatus[p.status].toLowerCase(), working)),
      bar);
    fill(stepsBody,
      run.routed ? step(m.stepRouted, 'done', String(n)) : null,
      step(m.stepBrief, 'done'),
      step(m.stepWorkspaces, started === n ? 'done' : stopped ? 'blocked' : 'active', `${started}/${n}`),
      step(m.stepWorking, done === n ? 'done' : stopped ? 'blocked' : working ? 'active' : 'pending', working ? m.nActive(working) : ''),
      step(m.stepOpinions, a.valid + a.failed + a.cancelled + a.invalid === n ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : stopped ? 'blocked' : 'pending', m.nValid(a.valid)),
      step(m.stepSynth, terminal ? (a.valid ? 'done' : 'blocked') : a.valid ? 'active' : 'pending', a.failed ? m.nFailed(a.failed) : ''));
    // 지금 할 일
    const tips: Kid[] = [];
    if (active()) {
      tips.push(h('p', null, run.mode === 'demo' ? m.tipDemoRunning : m.tipLiveRunning));
      if (run.error) tips.push(h('p', null, run.error(m)));
    } else {
      tips.push(h('p', null, a.valid ? m.tipResults : m.tipNoValid));
      if (a.failed || a.invalid) tips.push(h('p', null, m.tipExcluded(a.failed + a.invalid)));
      if (run.viaVisitor && !S.adminToken.trim() && S.boot.status === 'ready') {
        const problem = accessProblem();
        tips.push(h('p', null, visitorCanRun() ? m.tipVisitorAgain : problem ? problem(m) : m.tipVisitorNo));
        if (recheckable()) tips.push(checkAgain());
      }
    }
    fill(tipBody, ...tips);
  }

  function renderSynth(): void {
    const m = M;
    const p = S.run?.project;
    if (!p) { synthPanel.hidden = true; synth.replaceChildren(); confBody.replaceChildren(); return; }
    const a = aggregate(p, m);
    const terminal = TERMINAL_PROJECT.includes(p.status);
    // 빈 종합 카드는 보이지 않는다. 유효한 의견이 생기면 종합을 맨 위로 올린다 (노드를 옮길 뿐 다시 만들지 않는다)
    synthPanel.hidden = !a.valid && !terminal;
    const order = a.valid ? [synthPanel, progressPanel, tipPanel] : [progressPanel, tipPanel, synthPanel];
    if (order.some((n, i) => aside.children[i] !== n)) aside.append(...order);
    synthTag.hidden = S.run?.mode !== 'demo';
    const total = a.valid || 1;
    const segs = DIRECTIONS.filter(d => a.counts[d] > 0).map(d => {
      const s = h('span', { class: `cb-dist-seg d-${d}` }, `${Math.round(a.counts[d] / total * 100)}%`);
      s.style.flexGrow = String(a.counts[d]);
      return s;
    });
    fill(synth,
      h('div', { class: 'cb-recommend' }, h('h3', null, m.suggestedDecision), h('p', { class: 'cb-headline' }, a.headline)),
      h('div', { class: 'cb-tally' }, h('span', { class: 'cb-big' }, String(a.valid)), h('span', null, m.validOf(a.selected))),
      h('p', { class: 'cb-counts' }, m.countsLine(a)),
      a.valid ? h('div', { class: 'cb-dist', role: 'img', 'aria-label': DIRECTIONS.map(d => `${m.direction[d]} ${a.counts[d]}`).join(', ') }, ...segs) : null,
      a.valid ? h('ul', { class: 'cb-legend' }, ...DIRECTIONS.map(d => h('li', null, h('span', { class: `cb-sw d-${d}`, 'aria-hidden': 'true' }), `${m.direction[d]} `, h('strong', null, String(a.counts[d]))))) : null,
      a.actions.length ? h('div', { class: 'cb-next' }, h('h3', null, m.nextActions), h('ol', { class: 'cb-actions-list' }, ...a.actions.map(x => h('li', null, h('span', null, x.text),
        h('span', { class: 'cb-help' }, `${x.names.join(', ')}${x.count > 1 ? m.sharedBy(x.count) : ''}`))))) : null,
      a.disagreement ? h('div', { class: 'cb-dispute' }, h('h3', null, m.dissent),
        ...a.supportVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-support' }, h('span', { class: 'cb-chip d-support' }, `${m.direction.support} · ${v.name} ${v.confidence}%`), h('p', null, v.summary))),
        ...a.concernVoices.slice(0, 1).map(v => h('blockquote', { class: 'd-concern' }, h('span', { class: 'cb-chip d-concern' }, `${m.direction.concern} · ${v.name} ${v.confidence}%`), h('p', null, v.summary))))
        : a.valid > 1 ? h('p', { class: 'cb-help' }, m.noDissent) : null,
      h('p', { class: 'cb-help cb-conf-line' }, a.meanConfidence === null ? m.noValidYet : m.meanConf(a.meanConfidence)));
    const maxB = Math.max(1, ...a.buckets);
    fill(confBody,
      h('p', { class: 'cb-help' }, m.confExplain),
      h('div', { class: 'cb-hist', role: 'img', 'aria-label': m.confAria(a.buckets.map((n, i) => `${i * 20}–${i * 20 + 20}%: ${n}`).join(', ')) },
        ...a.buckets.map((n, i) => { const col = h('span', { class: 'cb-hist-col' }, h('span', { class: 'cb-hist-n' }, n ? String(n) : ''));
          const bar = h('span', { class: 'cb-hist-bar' }); bar.style.height = `${Math.round(n / maxB * 100)}%`; col.append(bar, h('span', { class: 'cb-hist-x' }, i === 4 ? '80–100' : `${i * 20}–${i * 20 + 19}`)); return col; })));
    const phrase = m.announce(m.projectStatus[p.status], a.valid, a.failed);
    if (terminal && phrase !== lastAnnounce) { lastAnnounce = phrase; live.textContent = phrase; }
  }

  // ── 서버 사용 기록: 기존 콘솔 안의 추가 화면. 원문은 텍스트 노드로만 그린다.
  function paintHistory(): void { H.dirty = true; keepFocus(renderHistory); }
  const historyDate = (at: number) => new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  async function historyRequest(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {};
    if (S.adminToken.trim()) headers['x-admin-token'] = S.adminToken.trim();
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const r = await fetch('/api/cloudbite/history' + path, { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, data: await r.json() };
    } catch { return { status: 0, data: null }; }
  }
  function historyDenied(status: number): void {
    H.error = status; H.unauthorized = status === 401 || status === 403;
    if (H.unauthorized) { H.list = null; H.detail = null; H.report = null; H.owner = false; H.drafts.clear(); H.own.clear(); }
  }
  async function loadHistory(more = false): Promise<void> {
    if (H.busy) return;
    const gen = ++H.gen, tab = H.tab;
    H.busy = true; H.error = 0; H.unauthorized = false; paintHistory();
    const q = '?scope=' + (tab === 'all' ? 'all' : 'mine') + (more && H.list?.next ? '&before=' + encodeURIComponent(H.list.next) : '');
    const result = await historyRequest(q);
    if (gen !== H.gen) return;
    const list = result.data as HistoryList | null;
    if (result.status !== 200 || !list || !Array.isArray(list.rows) || !list.rows.every(x => /^cb[0-9a-f]{32}$/.test(x.id))) {
      historyDenied(result.status); H.busy = false; paintHistory(); return;
    }
    H.owner = list.owner === true;
    H.list = more && H.list ? { ...list, rows: [...H.list.rows, ...list.rows] } : list;
    if (tab === 'report') {
      const r = await historyRequest('/report');
      if (gen !== H.gen) return;
      const report = r.data as HistoryReport | null;
      if (r.status === 200 && report && Array.isArray(report.insights) && Array.isArray(report.roles)) H.report = report;
      else historyDenied(r.status);
    }
    H.busy = false; paintHistory();
  }
  async function openHistory(id: string): Promise<void> {
    const gen = ++H.detailGen;
    H.detailBusy = true; H.detail = null; H.error = 0; H.message = ''; H.deleteId = ''; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id));
    if (gen !== H.detailGen) return;
    const detail = r.data as HistoryDetail | null;
    const shown = r.status === 200 && detail && Array.isArray(detail.feedback) ? normalizeProject(detail.project) : null;
    if (shown && detail) { H.detail = detail; noteOwn(shown, detail); }
    else historyDenied(r.status);
    H.detailBusy = false; paintHistory();
  }
  async function saveHistoryFeedback(id: string, draft: Omit<HistoryFeedback, 'at'>): Promise<void> {
    if (H.mutation) return;
    H.mutation = true; H.error = 0; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id) + '/feedback', 'POST', draft);
    H.mutation = false;
    if (r.status === 200) { if (H.detail?.project.id === id) { H.detail.feedback = [...H.detail.feedback.filter(f => f.expertId !== draft.expertId), { ...draft, at: Date.now() }]; H.message = 'saved'; } }
    else historyDenied(r.status);
    paintHistory();
  }
  async function deleteHistory(id: string): Promise<void> {
    if (H.mutation) return;
    H.mutation = true; H.error = 0; paintHistory();
    const r = await historyRequest('/' + encodeURIComponent(id), 'DELETE');
    H.mutation = false;
    if (r.status === 200) {
      H.detailGen++; H.detail = null; H.deleteId = ''; H.message = '';
      for (const key of H.drafts.keys()) if (key.startsWith(id + ':')) H.drafts.delete(key);
      for (const key of [...H.opened]) if (key.startsWith(id + ':')) H.opened.delete(key);
      if (S.followUp?.parentId === id) { dropFollowUp(); H.message = 'fu-cleared'; keepFocus(renderControls); }
      await loadHistory();
    } else { historyDenied(r.status); paintHistory(); }
  }
  function historyTable(heads: string[], rows: string[][]): HTMLElement {
    return h('div', { class: 'cb-history-table' }, h('table', null,
      h('thead', null, h('tr', null, ...heads.map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, ...rows.map(row => h('tr', null, ...row.map(x => h('td', null, x)))))));
  }
  // ── 결정 세부 정보 · 근거 자료 (편집 영역)
  function renderDecisionHint(): void {
    decisionHint.textContent = M.decisionHint(DECISION_FIELDS.reduce((n, f) => n + decisionIns[f].value.split('\n').filter(x => x.trim()).length, 0));
  }
  /** 근거 파일 목록. 바뀐 것이 있을 때만 다시 그려 펼친 원문·스크롤이 진행 조회마다 흔들리지 않는다 */
  function renderDocs(busy: boolean): void {
    const sig = `${lang}|${S.mode}|${busy}|${S.docReading}|${docRev}`;
    if (sig === docSig) return;
    docSig = sig;
    const m = M;
    const chars = S.docs.reduce((n, d) => n + d.content.length, 0);
    docsHint.textContent = m.docsHint(S.docs.length);
    docsCopyNote.textContent = S.mode === 'demo' ? `${m.docsCopy} ${m.docsDemo}` : m.docsCopy;
    docsUsage.textContent = S.docReading ? m.docsReading : m.docsUsage(S.docs.length, DOCS.files, group(chars), group(DOCS.total));
    docsPick.disabled = busy || S.docs.length >= DOCS.files;
    fill(docsErr, ...S.docErrors.map(e => h('p', null, e(m))));
    fill(docsList, ...S.docs.map((d, i) => {
      const id = `doc-${i + 1}`;
      const text = h('details', { class: 'cb-disclosure cb-quiet', open: S.docOpen.has(d.key) },
        h('summary', null, icon('chevron'), m.docsReview(group(d.content.length))), h('pre', { class: 'cb-doc-text' }, d.content));
      text.addEventListener('toggle', () => { if (text.open) S.docOpen.add(d.key); else S.docOpen.delete(d.key); });
      return h('li', { class: 'cb-doc' },
        h('div', { class: 'cb-doc-head' }, h('span', { class: 'cb-tag' }, id), h('strong', { class: 'cb-doc-name' }, d.name),
          h('button', { type: 'button', class: 'cb-ghost', 'data-fk': `doc-rm:${d.key}`, disabled: busy, 'aria-label': m.docsRemoveAria(id, d.name), onclick: () => removeDoc(d.key) }, m.docsRemove)),
        d.origin ? h('p', { class: 'cb-help cb-doc-origin' }, d.origin) : null, text);
    }));
  }
  /** 고른 파일을 거르고 차례로 읽는다. 읽는 동안 언어를 바꾸거나 다른 파일을 빼도 된다: 한도는 읽기가 끝난 순간의 목록으로 잰다 */
  function addFiles(files: File[]): void {
    if (locked() || !files.length) return;
    S.docErrors = []; docRev++;
    for (const file of files) {
      const problem = docProblem({ name: file.name, type: file.type || '', size: file.size });
      if (problem) { S.docErrors.push(problem); continue; }
      S.docReading++;
      docQueue = docQueue.then(async () => {
        let text: string | null = null;
        try { text = await file.text(); } catch { /* 아래에서 읽기 오류 */ }
        S.docReading--;
        if (text === null) S.docErrors.push(m => m.docRead(docName(file.name)));
        else {
          const r = docAccept(file.name, text, S.docs);
          if ('error' in r) S.docErrors.push(r.error); else S.docs.push({ key: ++docKey, ...r.doc });
        }
        docRev++;
        keepFocus(renderControls);
      });
    }
    keepFocus(renderControls);
  }
  /** 파일을 뺀다. 남은 파일은 보낼 때 doc-1.. 로 다시 매겨진다. 포커스는 다음 빼기 버튼, 없으면 파일 추가로 */
  function removeDoc(key: number): void {
    if (locked()) return;
    const i = S.docs.findIndex(d => d.key === key);
    if (i < 0) return;
    S.docs.splice(i, 1); S.docOpen.delete(key); S.docErrors = []; docRev++;
    renderControls();
    const next = S.docs[i] ?? S.docs[i - 1];
    const target = next ? root!.querySelector(`[data-fk="doc-rm:${next.key}"]`) as HTMLElement | null : null;
    (target ?? docsPick).focus();
  }

  // ── 계획 준비와 PMC 가져오기
  const preparing = () => S.plan?.phase === 'preparing';
  /** 실행 중이거나 계획을 준비하는 동안에는 입력을 잠근다 */
  const locked = () => active() || preparing();
  /** 계획에 들어가는 입력 전체. 화면 언어는 넣지 않는다 (응답 언어는 넣는다) */
  const semanticSig = () => JSON.stringify([S.mode, autoRoute(), autoRoute() ? [] : [...S.selected], limits().max, titleIn.value, objectiveIn.value, contextIn.value,
    decisionTexts(), docsPayload(S.docs), stageSel.value, respSel.value, budgetTexts(),
    S.followUp ? [S.followUp.parentId, fuSummaryIn.value, ...(S.followUp.authorResponse ? [S.followUp.authorResponse.reviewSnapshotHash] : [])] : null]);
  function semanticEdit(): void {
    budgetHint.textContent = M.budgetHint(BUDGET_FIELDS.some(f => budgetIns[f].value.trim() !== ''));
    if (S.followUp) renderFollowUp();
    if (S.plan && !preparing() && S.plan.sig !== semanticSig()) keepFocus(renderControls);
  }
  /** 실제 실행과 같은 자격: 넣은 토큰이 있으면 그 헤더만, 없으면 same-origin 쿠키 (소유자 → 방문자) */
  function cred(): { headers: Record<string, string>; operator: boolean; owner: boolean; v: CloudbiteAccessRequest | null } {
    const adminToken = S.adminToken.trim(), owner = !adminToken && ownerAuthed();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    return { headers, operator: isOperatorToken(S.adminToken), owner, v: adminToken || owner ? null : visitor() };
  }
  /** 거부 응답의 안내. 소유자 로그인이 거부되면 로그인 상태를 내리고 다시 묻고, 방문자면 서버 접근 상태를 다시 읽는다 */
  async function refusal(res: Response, c: ReturnType<typeof cred>, route = false, read?: { body: unknown }): Promise<Text> {
    const denied = res.status === 401 || res.status === 403;
    const msg: Text = c.operator && res.status === 401 ? m => m.operatorRejected : c.owner && denied ? m => m.ownerRejected
      : c.v && denied ? m => m.visitorRejected(REQUEST_PATH) : await errorText(res, route, read);
    if (c.owner && denied) { S.owner.authenticated = false; void loadOwner(); }
    if (c.v && denied) void loadBootstrap();
    return msg;
  }
  function fillBudget(on: boolean): void {
    if (locked()) return;
    const n = Math.max(1, Math.min(PROJECT_MAX, autoRoute() ? limits().max : S.selected.size || 1));
    const v: ProjectBudget = { maxExperts: n, maxModelCalls: Math.min(BUDGET_LIMITS.maxModelCalls[1], n * BUDGET_DEFAULT.perExpert + BUDGET_DEFAULT.review + BUDGET_DEFAULT.memo),
      maxReviewCalls: BUDGET_DEFAULT.review, maxMemoCalls: BUDGET_DEFAULT.memo };
    for (const f of BUDGET_FIELDS) budgetIns[f].value = on ? String(v[f]) : '';
    S.formErrors = S.formErrors.filter(e => e.field !== 'budget');
    semanticEdit(); keepFocus(renderControls);
  }
  function discardPlan(): void {
    planGen++; S.plan = null; S.planStale = false;
    renderControls(); startBtn.focus();
  }

  /** 계획 준비: Jev 가 고르면 먼저 /route, 그다음 만들기와 똑같은 본문으로 /preview. 직접 고르면 Jev 를 부르지 않는다.
   *  실패하면 잠금을 풀고 아무것도 만들지 않는다. 같은 입력으로 다시 준비하면 같은 requestId 를 쓴다 */
  async function preparePlan(f: FormInput, decision: DecisionFrame | undefined, wf: ReturnType<typeof parseWorkflow>['extras'] & { revision?: ProjectRevision }, auto: boolean): Promise<void> {
    const sig = semanticSig();
    const requestId = S.planReq?.sig === sig ? S.planReq.requestId : crypto.randomUUID();
    S.planReq = { sig, requestId };
    const gen = ++planGen;
    S.plan = { sig, phase: 'preparing', routed: auto, body: '', preview: null, error: null }; S.planStale = false;
    renderAll();
    const extras = { ...briefExtras({ decision, documents: S.docs.length ? docsPayload(S.docs) : undefined }), ...wf };
    const c = cred();
    const fail = (msg: Text) => { if (gen !== planGen) return; S.plan = { sig, phase: 'error', routed: auto, body: '', preview: null, error: msg }; renderAll(); };
    const post = async (path: string, body: string): Promise<Response | null> => {
      try { return await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: c.headers, body }); } catch { return null; }
    };
    let expertIds = f.expertIds;
    if (auto) {
      const key = routeKey({ ...f, ...extras }), max = limits().max, allowed = catalogue().map(e => e.id);
      S.route = { key, result: null }; S.teamOpen = false;
      const res = await post('/api/cloudbite/route', JSON.stringify({ title: f.title, objective: f.objective, context: f.context, requestId, ...extras }));
      if (gen !== planGen) return;
      if (!res) return fail(m => m.routeNetwork);
      if (!res.ok) { const msg = wf.revision && res.status === 404 ? ((m: Messages) => m.p2.fuParentMissing) : await refusal(res, c, true); return fail(msg); }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
      if (gen !== planGen) return;
      const route = normalizeRoute(body, allowed, max);
      if (!route) return fail(m => m.routeInvalid);
      S.route = { key, result: route };
      expertIds = route.expertIds;
    }
    // 만들기 본문 그대로 (자리 순서도 예전 만들기와 같다). 실행은 이 문자열을 바꾸지 않고 보낸다
    const payload = auto
      ? { title: f.title, objective: f.objective, context: f.context, requestId, mode: 'live', expertIds, ...extras, routing: 'jev' }
      : { ...f, mode: 'live', requestId, ...extras };
    const frozen = JSON.stringify(payload);
    const res = await post('/api/cloudbite/preview', frozen);
    if (gen !== planGen) return;
    if (!res) return fail(m => m.planNetwork);
    if (!res.ok) { const msg = wf.revision && res.status === 404 ? ((m: Messages) => m.p2.fuParentMissing) : await refusal(res, c); return fail(msg); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== planGen) return;
    if (isObj(body) && Array.isArray(body.expertIds) && JSON.stringify(body.expertIds) !== JSON.stringify(expertIds)) return fail(m => m.planMismatch);
    const preview = normalizePreview(body, expertIds);
    if (!preview) return fail(m => m.planInvalid);
    if (semanticSig() !== sig) { S.plan = null; S.planStale = true; renderAll(); return; }
    S.plan = { sig, phase: 'ready', routed: auto, body: frozen, preview, error: null };
    renderAll();
    live.textContent = M.planTitle;
  }

  /** 준비한 계획을 그대로 실행한다: 미리보기에 보낸 문자열을 같은 requestId 로 보낸다 (다시 눌러도 같은 요청) */
  function executePlan(): void {
    const plan = S.plan;
    if (!plan || plan.phase !== 'ready' || !plan.body || plan.sig !== semanticSig() || locked()) return;
    clearTimers();
    const gen = ++S.gen;
    S.review = null; S.memo = null;
    S.artifactCache.clear(); S.hiddenRows.clear(); S.focusExpert = ''; S.artifactPath = ''; S.artifactPicked = false; lastAnnounce = '';
    S.run = { mode: 'live', phase: 'starting', project: null, accessToken: '', error: null, startedAt: Date.now(), pollErrors: 0,
      routed: plan.routed, viaVisitor: viaVisitor(), viaOwner: viaOwner() };
    void startLive(gen, JSON.parse(plan.body) as ProjectBrief, plan.routed, plan.body);
    renderAll();
    settleFocus();
  }

  function renderPlan(): void {
    const p = S.plan, key = `${lang}|${S.mode}|${S.planStale}|${locked()}`;
    if (p === planDrawn && key === planDrawnKey) return;
    planDrawn = p; planDrawnKey = key;
    const m = M, kids: Kid[] = [];
    if (S.mode === 'live' && !p && S.planStale) kids.push(h('p', { class: 'cb-warn' }, m.planStale));
    if (S.mode === 'live' && p?.phase === 'ready' && p.preview) {
      const pv = p.preview, sent = JSON.parse(p.body) as Partial<ProjectBrief>, env = pv.envelope;
      const options = sent.decision?.options ?? [];
      const optText = (id: string) => { const i = Number(id.slice('option-'.length)) - 1; return options[i] ? `${id}: ${options[i]}` : id; };
      const list = (label: string, items: string[]) => items.length ? h('div', { class: 'cb-plan-list' }, h('strong', null, label), h('ul', null, ...items.map(x => h('li', null, x)))) : null;
      const byId = new Map(pv.assignments.map(a => [a.expertId, a]));
      kids.push(h('h3', { id: 'cb-plan-h', class: 'cb-plan-title', tabindex: '-1' }, m.planTitle), h('p', { class: 'cb-help' }, m.planNote),
        h('ul', { class: 'cb-plan-facts' },
          h('li', null, m.planRoles(pv.expertIds.length)),
          h('li', null, m.planStage(sent.stage ? m.wfStageName[sent.stage] : m.wfStageNone)),
          h('li', null, m.planLang(sent.responseLanguage ? m.wfLangName[sent.responseLanguage] : m.wfLangNone)),
          h('li', null, m.planCaps(pv.budget))),
        h('h4', { class: 'cb-plan-sub' }, m.planEnvelope),
        h('ul', { class: 'cb-plan-facts cb-plan-envelope' },
          h('li', null, m.planSandboxes(pv.envelope.sandboxMaximum)),
          h('li', null, m.planNosana(env.nosanaMaximum, env.expertMaximum, env.reviewMaximum, env.memoMaximum)),
          h('li', { class: 'cb-plan-jev' }, m.planJev(env.jevCalls))),
        h('p', { class: 'cb-help' }, m.planNoCost),
        h('h4', { class: 'cb-plan-sub' }, m.planAssignments),
        h('ol', { class: 'cb-plan-team' }, ...pv.expertIds.map(id => {
          const a = byId.get(id), name = findDef(id)?.name ?? id;
          if (!a) return h('li', { class: 'cb-plan-role' }, h('strong', null, name));
          return h('li', { class: 'cb-plan-role' }, h('details', { class: 'cb-disclosure cb-quiet' },
            h('summary', null, icon('chevron'), h('strong', null, name), ' ', h('span', { class: 'cb-tag' }, m.planSource[a.source]), ' ', h('span', { class: 'cb-tag' }, m.wfStageName[a.stage])),
            h('div', { class: 'cb-disclosure-body' },
              h('p', null, h('strong', null, `${m.planQuestion}: `), a.question),
              list(m.planOptions, a.optionIds.map(optText)), list(m.planDeliverables, a.deliverables),
              list(m.planEvidence, a.requiredEvidence), list(m.planBoundaries, a.boundaries))));
        })),
        pv.warnings.length ? h('div', { class: 'cb-plan-list' }, h('strong', null, m.planWarnings), h('ul', null, ...pv.warnings.map(w => h('li', null, w)))) : null,
        h('button', { type: 'button', class: 'cb-ghost', 'data-fk': 'plan-discard', disabled: active(), onclick: () => discardPlan() }, m.planDiscard));
    }
    planBox.hidden = !kids.length;
    fill(planBox, ...kids);
  }

  function renderPmc(busy: boolean): void {
    const key = `${lang}|${busy}|${S.pmc.busy}|${pmcRev}|${S.docs.length}`;
    if (key === pmcSig) return;
    pmcSig = key;
    const m = M, r = S.pmc.result;
    pmcBtn.textContent = S.pmc.busy ? m.pmcBusy : m.pmcBtn;
    pmcBtn.disabled = busy || S.pmc.busy; pmcIn.disabled = busy || S.pmc.busy;
    pmcBox.setAttribute('aria-busy', String(S.pmc.busy));
    fill(pmcMsg, S.pmc.error ? h('p', null, S.pmc.error(m)) : null);
    pmcNote.textContent = S.pmc.note ? S.pmc.note(m) : '';
    if (!r) { fill(pmcBody); return; }
    const a = r.article, picked = r.documents.filter(d => S.pmc.picked.has(d.id)).length;
    fill(pmcBody,
      h('div', { class: 'cb-pmc-article' }, h('strong', null, a.title),
        h('p', { class: 'cb-help' }, [a.pmcid, a.doi ? `doi:${a.doi}` : ''].filter(Boolean).join(' · ')),
        h('p', { class: 'cb-help' }, `${m.pmcLicense}: ${a.license} · ${m.pmcRetrieved}: ${a.retrievedAt} · `,
          h('a', { href: a.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, m.pmcSourceLink))),
      h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), m.pmcSections(r.sections.length)),
        h('ol', { class: 'cb-pmc-sections' }, ...r.sections.map(x => h('li', null, `${x.title} — ${x.locator} · ${m.pmcSectionChars(group(x.characters))}`)))),
      h('div', { class: 'cb-plan-list' }, h('strong', null, m.pmcOmissions),
        r.warnings.length ? h('ul', null, ...r.warnings.map(w => h('li', null, w))) : h('p', { class: 'cb-help' }, m.pmcNoOmissions)),
      h('strong', null, m.pmcExcerpts),
      h('ol', { class: 'cb-doc-list cb-pmc-docs' }, ...r.documents.map((d, i) => {
        const box = h('input', { type: 'checkbox', id: `cb-pmc-doc-${i}`, 'data-fk': `pmc-pick:${d.id}`, checked: S.pmc.picked.has(d.id), disabled: busy || S.pmc.busy });
        box.addEventListener('change', () => { if (box.checked) S.pmc.picked.add(d.id); else S.pmc.picked.delete(d.id); pmcRev++; keepFocus(renderControls); });
        return h('li', { class: 'cb-doc' },
          h('div', { class: 'cb-doc-head' }, box, h('label', { for: `cb-pmc-doc-${i}`, class: 'cb-doc-name' }, d.name), h('span', { class: 'cb-tag' }, m.pmcSectionChars(group(d.content.length)))),
          d.origin ? h('p', { class: 'cb-help cb-doc-origin' }, d.origin) : null,
          h('details', { class: 'cb-disclosure cb-quiet' }, h('summary', null, icon('chevron'), m.pmcExcerpt(group(d.content.length))), h('pre', { class: 'cb-doc-text' }, d.content)));
      })),
      h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'pmc-add', disabled: busy || S.pmc.busy || !picked, onclick: () => pmcAdd() }, m.pmcAdd(picked)));
  }

  /** PMC 식별자 하나를 서버에 묻는다. 모양이 틀리면 묻지 않고, 늦은 응답은 버리며, 실패를 성공으로 꾸미지 않는다 */
  async function pmcLookup(): Promise<void> {
    if (locked() || S.pmc.busy) return;
    const id = pmcIn.value.trim();
    S.pmc.note = null;
    if (!PMC_ID.test(id) || PMC_ID_BAD.test(id)) { S.pmc.error = m => m.pmcBad; pmcRev++; renderControls(); pmcIn.focus(); return; }
    const seq = ++pmcSeq;
    S.pmc = { busy: true, result: null, error: null, note: null, picked: new Set() }; pmcRev++;
    keepFocus(renderControls);
    const done = (error: Text | null, result: PmcImport | null = null) => {
      if (seq !== pmcSeq) return;
      S.pmc = { busy: false, result, error, note: null, picked: new Set() }; pmcRev++;
      keepFocus(renderControls);
      if (document.activeElement === null || document.activeElement === document.body) pmcBtn.focus();
    };
    const c = cred();
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/pmc/import', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: c.headers, body: JSON.stringify({ identifier: id }) });
    } catch { return done(m => m.pmcNetwork); }
    if (seq !== pmcSeq) return;
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 본문 없음 */ }
    if (seq !== pmcSeq) return;
    if (!res.ok) {
      const code = isObj(body) && PMC_ERRORS.includes(body.error as PmcImportErrorCode) ? body.error as PmcImportErrorCode : null;
      if (!code) return done(await refusal(res, c, false, { body }));
      const server = isObj(body) ? str(body.message, 300) : '';
      const retry = isObj(body) && isInt(body.retryAfterSeconds, 1, 86400) ? body.retryAfterSeconds : 0;
      return done(m => [m.pmcError[code], server, retry ? m.pmcRetry(retry) : ''].filter(Boolean).join(' '));
    }
    const result = normalizePmc(body);
    return result ? done(null, result) : done(m => m.pmcInvalid);
  }

  /** 고른 발췌만 근거 파일에 더한다. 출처(origin)를 지키고, 파일 수·길이·합계·바이트 한도는 지금 목록과 합쳐 잰다 */
  function pmcAdd(): void {
    const r = S.pmc.result;
    if (locked() || !r || S.pmc.busy || S.docReading) return;
    S.docErrors = [];
    let added = 0;
    for (const d of r.documents) {
      if (!S.pmc.picked.has(d.id)) continue;
      if (S.docs.some(x => x.name === d.name && x.content === d.content && x.origin === d.origin)) { S.docErrors.push(m => m.pmcDup(d.name)); continue; }
      const ok = docAccept(d.name, d.content, S.docs);
      if ('error' in ok) { S.docErrors.push(ok.error); continue; }
      const draft: DocDraft = { key: ++docKey, ...ok.doc, ...(d.origin ? { origin: d.origin } : {}) };
      if (docsBytes([...S.docs, draft]) > DOCS.bytes) { S.docErrors.push(m => m.docBytes(draft.name, DOCS.bytes / 1024)); continue; }
      S.docs.push(draft); S.pmc.picked.delete(d.id); added++;
    }
    docRev++; pmcRev++;
    S.pmc.note = added ? m => m.pmcAdded(added) : null;
    keepFocus(renderControls);
  }

  // ── 주장과 근거 (결과): 지금 실행과 사용 기록 상세가 같은 그리기를 쓴다. 사용 기록은 읽기 전용(실행 버튼 없음)
  function evDisclosure(opened: Set<string>, key: string, cls: string, summary: Kid[], ...content: Kid[]): HTMLDetailsElement {
    const box = h('details', { class: `cb-disclosure ${cls}`, open: opened.has(key) }, h('summary', null, icon('chevron'), ...summary), ...content);
    box.addEventListener('toggle', () => { if (box.open) opened.add(key); else opened.delete(key); });
    return box;
  }
  const expertName = (p: ConsoleProject, id: string) => p.experts.find(e => e.expertId === id)?.name ?? findDef(id)?.name ?? id;

  function evidenceKids(p: ConsoleProject, opened: Set<string>, prefix: string, interactive: boolean): Kid[] {
    const m = M, kids: Kid[] = [];
    const docs = p.brief.documents ?? [];
    const d = p.brief.decision;
    if (d) kids.push(evDisclosure(opened, `${prefix}decision`, 'cb-quiet', [h('span', null, m.decisionDetails)],
      h('dl', { class: 'cb-decision-view' }, ...DECISION_FIELDS.filter(f => d[f].length).flatMap(f =>
        [h('dt', null, m.decisionField[f]), h('dd', null, h('ul', null, ...d[f].map(x => h('li', null, x))))]))));
    if (docs.length) kids.push(evDisclosure(opened, `${prefix}docs`, 'cb-quiet', [h('span', null, m.docsList(docs.length))],
      h('ul', { class: 'cb-doc-list' }, ...docs.map(doc => h('li', { class: 'cb-doc' },
        evDisclosure(opened, `${prefix}doc:${doc.id}`, 'cb-quiet', [h('span', { class: 'cb-tag' }, doc.id), ' ', h('span', null, doc.name)],
          h('pre', { class: 'cb-doc-text' }, doc.content)))))));
    if (p.brief.mode === 'demo') { if (kids.length) kids.push(h('p', { class: 'cb-help' }, m.demoNoLedger)); return kids; }
    const claims = p.evidenceClaims;
    if (claims) {
      const linked = claims.filter(c => c.status === 'linked').length;
      kids.push(evDisclosure(opened, `${prefix}ledger`, 'cb-quiet cb-ledger', [h('span', null, m.ledgerSummary(claims.length, linked))],
        h('p', { class: 'cb-help' }, m.ledgerNote),
        claims.length ? h('ol', { class: 'cb-claims' }, ...claims.map(c => h('li', { class: 'cb-claim' },
          h('div', { class: 'cb-claim-head' }, h('strong', null, expertName(p, c.expertId)),
            h('span', { class: `cb-tag ${c.status === 'linked' ? 'is-avail' : 'is-unval'}` }, m.claimStatus[c.status])),
          h('p', { class: 'cb-claim-text' }, c.text),
          c.references.length ? h('ul', { class: 'cb-refs' }, ...c.references.map(r => {
            if (r.kind === 'knowledge') return h('li', null, m.refKnowledge(r.id, r.available));
            const doc = docs.find(x => x.id === r.id);
            return h('li', null, doc
              ? evDisclosure(opened, `${prefix}ref:${c.id}:${r.id}`, 'cb-quiet', [h('span', null, m.refDoc(doc.id, doc.name))], h('pre', { class: 'cb-doc-text' }, doc.content))
              : m.refDocMissing(r.id));
          })) : null)))
          : h('p', { class: 'cb-help' }, m.ledgerEmpty)));
    }
    const round = roundKids(p, prefix, opened);
    if (round.length) kids.unshift(h('section', { class: 'cb-round', 'aria-labelledby': `${prefix}round-h` }, h('h3', { id: `${prefix}round-h` }, m.p2.roundTitle), ...round));
    const signals = signalsKids(p, prefix, opened);
    if (signals.length) kids.push(h('section', { class: 'cb-signals', 'aria-labelledby': `${prefix}sig-h` }, h('h3', { id: `${prefix}sig-h` }, m.p2.sigTitle), ...signals));
    const prov = provenanceKids(p, opened, prefix);
    if (prov.length) kids.push(h('section', { class: 'cb-prov', 'aria-labelledby': `${prefix}prov-h` }, h('h3', { id: `${prefix}prov-h` }, m.p3.provTitle), ...prov));
    const review = reviewKids(p, interactive, opened, prefix);
    if (review.length) kids.push(h('section', { class: 'cb-review', 'aria-labelledby': `${prefix}review-h` },
      h('h3', { id: `${prefix}review-h` }, m.reviewTitle), ...review));
    const memo = memoKids(p, interactive, prefix, opened);
    if (memo.length) kids.push(h('section', { class: 'cb-memo', 'aria-labelledby': `${prefix}memo-h` }, h('h3', { id: `${prefix}memo-h` }, m.p2.memoTitle), ...memo));
    return kids;
  }

  // 메모와 교차 검토는 서로 겹치지 않는다 (서버도 409 로 거절하고 아무것도 예약하지 않는다): 한쪽이 이 화면이나 서버에서 진행 중이면 다른 쪽 버튼을 내지 않는다
  const reviewBusy = (p: ConsoleProject) => (S.review?.projectId === p.id && S.review.phase === 'running') || p.crossReview?.status === 'running';
  const memoBusy = (p: ConsoleProject) => (S.memo?.projectId === p.id && (S.memo.phase === 'running' || S.memo.phase === 'reading')) || p.memo?.status === 'running';
  /** 늦게 도착한 옛 프로젝트 상태는 버린다 (서버는 검토·메모가 바뀔 때마다 updatedAt 을 올린다). 남긴 쪽을 돌려준다 */
  function newer(next: ConsoleProject): ConsoleProject {
    const cur = S.run!.project;
    if (cur && cur.id === next.id && next.updatedAt < cur.updatedAt) return cur;
    S.run!.project = next;
    return next;
  }

  function reviewKids(p: ConsoleProject, interactive: boolean, opened: Set<string>, prefix: string): Kid[] {
    const m = M, cr = p.crossReview;
    const local = interactive && S.review?.projectId === p.id ? S.review : null;
    const run = interactive ? S.run : null;
    const canAsk = !!run && run.mode === 'live' && !!run.accessToken && run.project?.id === p.id && !active() && reviewEligible(p);
    if (!cr && !p.invalidCrossReview && !local && !(interactive && run?.mode === 'live' && TERMINAL_PROJECT.includes(p.status))) return [];
    const kids: Kid[] = [h('p', { class: 'cb-help' }, m.reviewExplain)];
    if (!interactive && (cr || p.invalidCrossReview)) kids.push(h('p', { class: 'cb-help' }, m.reviewSaved));
    if (p.invalidCrossReview) kids.push(h('p', { class: 'cb-warn' }, m.reviewInvalid));
    const running = local?.phase === 'running' || cr?.status === 'running';
    if (running) kids.push(h('p', { class: 'cb-help', role: 'status' }, local?.phase === 'running' ? m.reviewRunning : m.reviewServerRunning));
    else if (local?.phase === 'failed' && local.error) kids.push(h('p', { class: 'cb-warn', role: 'alert' }, local.error(m)));
    if (cr?.status === 'failed') kids.push(h('p', { class: 'cb-warn' }, m.reviewFailed(cr.error ?? '')));
    if (cr?.status === 'completed') kids.push(h('p', { class: 'cb-ok' }, m.reviewDone(hhmm(cr.completedAt ?? cr.startedAt))));
    if (cr?.coverage) {
      const c = cr.coverage;
      kids.push(h('p', { class: 'cb-help' }, m.p2.revCoverage(c.reviewers, c.maxReviewers, c.maxPeersPerReviewer, c.assignedOpinions, c.completedOpinions)),
        h('p', { class: 'cb-help' }, m.p2.revCap), c.unassigned.length ? h('p', { class: 'cb-help' }, m.p2.revUnassigned(c.unassigned.map(id => expertName(p, id)).join(', '))) : null);
    } else if (cr) kids.push(h('p', { class: 'cb-help' }, m.p2.revCap));
    if (cr?.disclosure) kids.push(h('p', { class: 'cb-help' }, cr.disclosure));
    // 버튼은 실제로 걸 수 있을 때만 (서버는 프로젝트마다 한 번만 시도한다): 이미 결과가 있거나 진행 중이면 없다
    if (interactive && !cr && !p.invalidCrossReview && !running) {
      if (canAsk && memoBusy(p)) kids.push(h('p', { class: 'cb-help', role: 'status' }, m.p2.reviewWaitMemo));
      else if (canAsk) kids.push(h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'review-run', onclick: () => { void runCrossReview(); } },
        local?.phase === 'failed' ? m.reviewRetry : m.reviewBtn));
      else if (run?.mode === 'live' && TERMINAL_PROJECT.includes(p.status) && !reviewEligible(p)) kids.push(h('p', { class: 'cb-help' }, m.reviewNeed));
    }
    for (const r of cr?.reports ?? []) {
      kids.push(h('article', { class: 'cb-review-report', 'aria-label': m.reviewBy(expertName(p, r.reviewerExpertId)) },
        h('h4', null, m.reviewBy(expertName(p, r.reviewerExpertId))),
        r.summary ? h('p', null, r.summary) : null,
        r.findings.length ? h('ol', { class: 'cb-findings' }, ...r.findings.map(f => {
          const target = p.experts.find(e => e.expertId === f.targetExpertId);
          const quoted = target?.opinion?.evidence[f.evidenceIndex];
          const basis = cr?.textAvailability?.find(x => x.reviewerExpertId === r.reviewerExpertId && x.targetExpertId === f.targetExpertId && x.evidenceIndex === f.evidenceIndex);
          return h('li', { class: 'cb-finding' },
            h('div', { class: 'cb-finding-head' }, h('span', { class: `cb-chip ${VERDICT_CHIP[f.verdict]}` }, m.verdict[f.verdict]),
              h('strong', null, m.reviewFinding(expertName(p, f.targetExpertId), f.evidenceIndex + 1)),
              basis ? h('span', { class: 'cb-tag' }, m.p2.revBasis[basis.textBasis]) : null),
            quoted ? h('blockquote', { class: 'cb-finding-evidence' }, quoted) : null,
            f.rationale ? h('p', null, f.rationale) : null);
        })) : h('p', { class: 'cb-help' }, m.reviewNoFindings)));
    }
    if (cr) kids.push(...artifactKids(p, cr, opened, prefix));
    // 작성자 응답 요청: 끝난 실제 실행의 완료된 검토에서만, 누를 때 후속 초안만 연다 (실행·비용 없음)
    if (cr?.status === 'completed' && followUpEligible(p) && p.status !== 'cancelled') {
      kids.push(authorResponseAffected(p).length
        ? h('div', { class: 'cb-ar-ask' }, h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'ar-ask', disabled: locked(), onclick: () => startAuthorResponse(p) }, m.p3.arAsk),
          h('p', { class: 'cb-help' }, m.p3.arAskHelp))
        : h('p', { class: 'cb-help' }, m.p3.arNone));
    }
    return kids;
  }
  /** 검토자가 읽은 저장 산출물 발췌 (접힌 상자). 읽었다는 것만 밝히고 실행·검증을 주장하지 않는다 */
  function artifactKids(p: ConsoleProject, cr: ConsoleReview, opened: Set<string>, prefix: string): Kid[] {
    const m = M, t = m.p3, a = cr.artifactCoverage;
    if (cr.invalidArtifactCoverage) return [h('p', { class: 'cb-warn' }, t.artInvalid)];
    if (!a) return [];
    if (!a.length) return [h('p', { class: 'cb-help' }, t.artNone)];
    return [evDisclosure(opened, `${prefix}art`, 'cb-quiet cb-art', [h('span', null, t.artTitle(a.length, a.reduce((n, x) => n + x.files.length, 0)))],
      h('p', { class: 'cb-help' }, t.artNote),
      ...a.map(x => h('div', { class: 'cb-art-role' }, h('h5', null, expertName(p, x.expertId)),
        h('ul', { class: 'cb-art-files' }, ...x.files.map(f => h('li', null, artifactFileLine(f, m))), ...x.omitted.map(o => h('li', { class: 'cb-help' }, artifactOmitLine(o, m)))))))];
  }

  // ── 주장 출처와 채택. 묶음은 펼칠 때만 그리고 PROV_PAGE 개씩 늘려 수천 개를 한꺼번에 그리지 않는다
  const PROV_PAGE = 50;
  const provShown = new Map<string, number>();
  // unknown: 보낸 채택의 결과도, 그 뒤 저장된 상태도 모른다 → 이 프로젝트의 채택 버튼 대신 GET 만 하는 다시 읽기만 낸다
  let adopt: null | { projectId: string; claimId: string; phase: 'confirm' | 'posting' | 'reading' | 'done' | 'failed' | 'unknown'; note: Text | null } = null;
  let adoptGen = 0;
  const adoptBusy = () => adopt?.phase === 'posting' || adopt?.phase === 'reading';
  function adoptPaint(): void { paintHistory(); keepFocus(renderEvidence); }
  /** 서버와 같은 조건 (끝난 실제 실행, 취소 아님, 진행 중인 검토·메모 없음). 최종 판단은 서버가 한다 */
  const adoptable = (p: ConsoleProject) => p.brief.mode === 'live' && REVISION.parentId.test(p.id) && TERMINAL_PROJECT.includes(p.status) && p.status !== 'cancelled'
    && !reviewBusy(p) && !memoBusy(p);
  /** 자기 기록 여부는 서버가 준 사용 기록 상세의 canFeedback (자기 actor && 끝남) 으로만 안다. 프로젝트 bearer·응답 본문의 다른 값은 근거가 아니다 */
  function noteOwn(p: ConsoleProject, d: HistoryDetail): void {
    if (d.canFeedback === true) H.own.set(p.id, true);
    else if (TERMINAL_PROJECT.includes(p.status)) H.own.set(p.id, false);
    else H.own.delete(p.id);
  }
  function provenanceKids(p: ConsoleProject, opened: Set<string>, prefix: string): Kid[] {
    const m = M, t = m.p3;
    if (p.invalidProvenance) return [h('p', { class: 'cb-warn' }, t.provInvalid)];
    const pv = p.provenance;
    if (!pv) return [];
    const own = H.own.get(p.id), mine = adopt?.projectId === p.id ? adopt : null;
    // 남의 기록(소유자의 전체 보기 포함)은 채택이 없다. 모르면 (지금 실행) 누를 때 먼저 사용 기록을 GET 으로 확인한다
    const view = provenanceView(pv), groups = provenanceGroups(pv), can = adoptable(p) && own !== false && mine?.phase !== 'unknown';
    const kids: Kid[] = [h('p', { class: 'cb-help' }, t.provNote), h('ul', { class: 'cb-prov-summary' }, ...provenanceLines(pv, m).map(x => h('li', null, x))),
      h('p', { class: 'cb-help' }, t.provMemoNote)];
    const open = groups.hinted.length + groups.proposals.length;
    if (open && own === false) kids.push(h('p', { class: 'cb-help' }, t.provAdoptNotOwn));
    else if (open && !adoptable(p)) kids.push(h('p', { class: 'cb-help' }, t.provAdoptWait));
    if (mine?.note) kids.push(h('p', { class: mine.phase === 'done' ? 'cb-ok' : 'cb-warn', role: 'status' }, mine.note(m)));
    if (mine?.phase === 'unknown') kids.push(h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'adopt-reread', onclick: () => { void rereadAdoption(p.id, mine.claimId); } }, t.provReread));
    const item = (c: LedgerClaim) => {
      const st = view.standing.get(c.id) ?? 'generated-proposal', hint = c.numericThresholdHint && st === 'generated-proposal';
      const here = mine?.claimId === c.id ? mine : null;
      const ref = (r: LedgerClaim['refs'][number]) => `${r.kind === 'document' ? 'doc' : 'source'}:${r.id} — ${t.provRef[r.availability]}`;
      let action: Kid = null;
      if (st === 'generated-proposal') {
        if (c.textTruncated) action = h('p', { class: 'cb-help' }, t.provTruncated);
        else if (here?.phase === 'posting' || here?.phase === 'reading') action = h('p', { class: 'cb-help', role: 'status' }, here.phase === 'posting' ? t.provAdopting : t.provReading);
        else if (here?.phase === 'confirm' && can && own === true) action = h('div', { class: 'cb-prov-confirm', role: 'group', 'aria-label': t.provAdoptConfirm },
          h('blockquote', { class: 'cb-claim-text' }, c.text), h('p', { class: 'cb-help' }, t.provAdoptAsk),
          h('button', { type: 'button', class: 'cb-secondary', 'data-fk': `adopt-yes:${c.id}`, onclick: () => { void adoptClaim(p, c, pv.ledger.snapshot); } }, t.provAdoptConfirm),
          h('button', { type: 'button', class: 'cb-ghost', 'data-fk': `adopt-no:${c.id}`, onclick: () => { adopt = null; adoptPaint(); } }, t.provAdoptCancel));
        else if (can) action = h('button', { type: 'button', class: 'cb-ghost', 'data-fk': `adopt:${c.id}`, disabled: adoptBusy(),
          onclick: () => { if (adoptBusy()) return; if (H.own.get(p.id) === true) { adopt = { projectId: p.id, claimId: c.id, phase: 'confirm', note: null }; adoptPaint(); } else void checkOwnAdopt(p, c); } }, t.provAdopt);
      }
      return h('li', { class: `cb-prov-claim is-${st}${hint ? ' is-hint' : ''}` },
        h('div', { class: 'cb-claim-head' }, h('span', { class: `cb-tag ${st === 'generated-proposal' ? 'is-unval' : 'is-avail'}` }, t.provStanding[st]),
          c.expertId ? h('strong', null, expertName(p, c.expertId)) : null, hint ? h('span', { class: 'cb-chip d-conditional' }, t.provHint) : null),
        h('p', { class: 'cb-claim-text' }, c.text),
        evDisclosure(opened, `${prefix}prov-o:${c.id}`, 'cb-quiet', [h('span', null, t.provOrigin)],
          h('ul', { class: 'cb-prov-origin' }, h('li', null, t.provOriginName[c.origin]), h('li', null, t.provField(c.field, c.index)),
            c.expertId ? h('li', null, t.provExpert(expertName(p, c.expertId))) : null,
            c.adoptedIn ? h('li', null, t.provAdoptedIn(c.adoptedIn.projectId, historyDate(c.adoptedIn.at))) : null,
            ...view.active.filter(a => a.claimId === c.id).map(a => h('li', null, t.provAdoptedIn(a.projectId, historyDate(a.at)))),
            c.textTruncated ? h('li', null, t.provTruncated) : null, ...c.refs.map(r => h('li', null, ref(r))))),
        action);
    };
    for (const k of ['hinted', 'adopted', 'proposals', 'stated'] as const) {
      const list = groups[k];
      if (!list.length) continue;
      const key = `${prefix}prov:${k}`, open = opened.has(key);
      const box = h('details', { class: `cb-disclosure cb-quiet cb-prov-group is-${k}`, open }, h('summary', null, icon('chevron'), h('span', null, `${t.provGroup[k]} (${list.length})`)));
      if (open) {
        const shown = provShown.get(key) ?? PROV_PAGE;
        box.append(h('ol', { class: 'cb-prov-claims' }, ...list.slice(0, shown).map(item)));
        if (list.length > shown) box.append(h('button', { type: 'button', class: 'cb-ghost', 'data-fk': `prov-more:${k}`, onclick: () => { provShown.set(key, shown + PROV_PAGE); adoptPaint(); } },
            t.provMore(Math.min(PROV_PAGE, list.length - shown))));
      }
      // 펼칠 때만 그린다: 상태가 바뀐 경우에만 다시 그린다 (만들 때 열린 상자의 toggle 은 무시)
      box.addEventListener('toggle', () => { if (box.open === opened.has(key)) return; if (box.open) opened.add(key); else opened.delete(key); adoptPaint(); });
      kids.push(box);
    }
    return kids;
  }
  /** 저장된 상세를 받아 지금 실행과 사용 기록 화면에 같이 반영한다. 읽을 수 없으면 아무것도 바꾸지 않는다 */
  function acceptHistoryDetail(id: string, data: unknown): ConsoleProject | null {
    const d = data as HistoryDetail | null;
    const next = isObj(d) && Array.isArray(d.feedback) ? normalizeProject(d.project) : null;
    if (!next || next.id !== id) return null;
    noteOwn(next, d!);
    if (H.detail?.project.id === id) { H.detail = d!; H.dirty = true; }
    const cur = S.run?.project;
    if (cur && cur.id === id) {
      const { provenance: _p, invalidProvenance: _i, ...rest } = cur;
      S.run!.project = { ...rest, ...(next.provenance ? { provenance: next.provenance } : {}), ...(next.invalidProvenance ? { invalidProvenance: true } : {}) };
    }
    return next;
  }
  /** 채택: 정확한 글·장부 스냅숏·claimId 만 보낸다 (누가·언제는 서버가 정한다). 실패하거나 응답을 모르면 다시 보내기 전에 저장된 상태를 읽는다 */
  async function adoptClaim(p: ConsoleProject, c: LedgerClaim, snapshot: string): Promise<void> {
    if (adoptBusy() || !adoptable(p) || c.textTruncated || H.own.get(p.id) !== true || adopt?.phase === 'unknown') return;
    const id = p.id, gen = ++adoptGen;
    adopt = { projectId: id, claimId: c.id, phase: 'posting', note: null }; adoptPaint();
    const r = await historyRequest('/' + encodeURIComponent(id) + '/adopt', 'POST', { claimId: c.id, text: c.text, snapshot });
    if (gen !== adoptGen) return;
    if (r.status === 200 && acceptHistoryDetail(id, r.data)) { adopt = { projectId: id, claimId: c.id, phase: 'done', note: m => m.p3.provAdopted }; adoptPaint(); return; }
    const server = isObj(r.data) && typeof r.data.error === 'string' ? clip(r.data.error, 300) : '';
    const unknown = r.status === 0 || r.status === 200;
    // 403 은 로그인 문제가 아니라 남의 프로젝트다: 로그아웃하지 않고 로그인하라고도 하지 않는다
    const why: Text = unknown ? m => m.p3.provAdoptUnknown : r.status === 404 ? m => m.p3.provAdoptFailed(m.p3.provAdoptForeign)
      : r.status === 401 ? m => m.p3.provAdoptSignedOut : r.status === 403 ? m => m.p3.provAdoptFailed(m.p3.provAdoptNotOwn) : m => m.p3.provAdoptFailed(server || String(r.status));
    adopt = { projectId: id, claimId: c.id, phase: 'reading', note: null }; adoptPaint();
    const g = await historyRequest('/' + encodeURIComponent(id));
    if (gen !== adoptGen) return;
    const next = g.status === 200 ? acceptHistoryDetail(id, g.data) : null;
    if (!next && unknown) { adopt = { projectId: id, claimId: c.id, phase: 'unknown', note: m => m.p3.provAdoptUnreconciled }; adoptPaint(); return; }
    const seen = !!next?.provenance && provenanceView(next.provenance).active.some(a => a.claimId === c.id && a.text === c.text);
    adopt = { projectId: id, claimId: c.id, phase: seen ? 'done' : 'failed', note: seen ? m => m.p3.provAdoptedSeen : why };
    adoptPaint();
  }
  /** 응답을 모를 때 사용자가 누르는 다시 읽기: GET 만 한다. 읽을 때까지 채택 버튼은 돌아오지 않고, 읽으면 새 장부로 다시 고를 수 있다 */
  async function rereadAdoption(id: string, claimId: string): Promise<void> {
    if (adoptBusy() || adopt?.projectId !== id || adopt.phase !== 'unknown') return;
    const gen = ++adoptGen, text = adoptText(id, claimId);
    adopt = { projectId: id, claimId, phase: 'reading', note: null }; adoptPaint();
    const g = await historyRequest('/' + encodeURIComponent(id));
    if (gen !== adoptGen) return;
    const next = g.status === 200 ? acceptHistoryDetail(id, g.data) : null;
    if (!next) { adopt = { projectId: id, claimId, phase: 'unknown', note: m => m.p3.provAdoptUnreconciled }; adoptPaint(); return; }
    const seen = !!next.provenance && provenanceView(next.provenance).active.some(a => a.claimId === claimId && (text === null || a.text === text));
    adopt = { projectId: id, claimId, phase: seen ? 'done' : 'failed', note: seen ? m => m.p3.provAdoptedSeen : m => m.p3.provAdoptReread };
    adoptPaint();
  }
  /** 화면에 있는 그 주장의 글 (지금 실행이나 사용 기록 상세) */
  function adoptText(id: string, claimId: string): string | null {
    for (const p of [S.run?.project, H.detail ? normalizeProject(H.detail.project) : null])
      if (p?.id === id) { const c = p.provenance?.ledger.claims.find(x => x.id === claimId); if (c) return c.text; }
    return null;
  }
  /** 자기 기록인지 모르는 채로 (지금 실행) 채택을 누르면 먼저 사용 기록 상세를 GET 한다. canFeedback 이 참일 때만 확인 단계로 간다 */
  async function checkOwnAdopt(p: ConsoleProject, c: LedgerClaim): Promise<void> {
    if (adoptBusy() || !adoptable(p) || c.textTruncated) return;
    const id = p.id, gen = ++adoptGen;
    adopt = { projectId: id, claimId: c.id, phase: 'reading', note: null }; adoptPaint();
    const g = await historyRequest('/' + encodeURIComponent(id));
    if (gen !== adoptGen) return;
    const next = g.status === 200 ? acceptHistoryDetail(id, g.data) : null;
    const fail = (note: Text) => { adopt = { projectId: id, claimId: c.id, phase: 'failed', note }; adoptPaint(); };
    if (!next) return fail(g.status === 401 ? m => m.p3.provAdoptSignedOut : g.status === 403 ? m => m.p3.provAdoptNotOwn : g.status === 404 ? m => m.p3.provAdoptForeign : m => m.p3.provAdoptCheckFailed);
    if (H.own.get(id) !== true) return fail(m => m.p3.provAdoptNotOwn);
    const view = next.provenance ? provenanceView(next.provenance) : null;
    if (view?.active.some(a => a.claimId === c.id && a.text === c.text)) { adopt = { projectId: id, claimId: c.id, phase: 'done', note: m => m.p3.provAdoptedSeen }; adoptPaint(); return; }
    const fresh = next.provenance?.ledger.claims.find(x => x.id === c.id);
    if (!fresh || fresh.text !== c.text || fresh.textTruncated || !adoptable(next)) return fail(m => m.p3.provAdoptReread);
    adopt = { projectId: id, claimId: c.id, phase: 'confirm', note: null }; adoptPaint();
  }

  function renderEvidence(): void {
    const p = S.run?.project;
    const kids = p ? evidenceKids(p, S.evOpen, `${p.id}:`, true) : [];
    evidencePanel.hidden = !kids.length;
    fill(evidenceBody, ...kids);
  }

  /** 사용자가 누를 때만 교차 검토를 건다 (자동·유료 재시도 없음). 프로젝트 bearer 와 같은 출처 요청, 빈 JSON 본문 {} */
  async function runCrossReview(): Promise<void> {
    const run = S.run, p = run?.project;
    if (!run || !p || run.mode !== 'live' || !run.accessToken || active() || !reviewEligible(p) || p.crossReview || S.review?.phase === 'running' || memoBusy(p)) return;
    const gen = S.gen, id = p.id;
    S.review = { projectId: id, phase: 'running', error: null, polls: 0 };
    renderEvidence();
    const failed = (msg: Text) => { if (gen !== S.gen || S.run?.project?.id !== id) return; S.review = { projectId: id, phase: 'failed', error: msg, polls: 0 }; keepFocus(renderEvidence); };
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}/review`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: `Bearer ${run.accessToken}`, 'content-type': 'application/json' }, body: '{}' });
    } catch {
      return failed(m => m.reviewNetwork);
    }
    if (gen !== S.gen || S.run?.project?.id !== id) return;
    // 409 는 이미 진행 중이거나 걸 수 없는 상태다: 서버의 지금 프로젝트를 읽어 그대로 보인다 (짐작해 완료로 꾸미지 않는다)
    if (res.status === 409) {
      const msg = await errorText(res);
      return reviewRead(gen, id, msg);
    }
    if (!res.ok) { const msg = await errorText(res); return failed(m => m.reviewRequestFailed(msg(m))); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen || S.run?.project?.id !== id) return;
    adoptReview(gen, id, body, () => failed(m => m.reviewInvalid));
  }
  /** 서버가 돌려준 ProjectRun 을 받아들인다. 교차 검토가 진행 중이면 조회를 이어 가고, 끝났으면 서버의 완료·실패를 그대로 둔다 */
  function adoptReview(gen: number, id: string, body: unknown, invalid: () => void): void {
    const next = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
    if (!next || next.id !== id || !S.run?.project) return invalid();
    const cur = newer(next);
    if (cur.crossReview?.status === 'running') {
      const polls = (S.review?.projectId === id ? S.review.polls : 0) + 1;
      if (polls > 30) { S.review = { projectId: id, phase: 'failed', error: m => m.reviewPollStopped, polls }; renderAll(); return; }
      S.review = { projectId: id, phase: 'running', error: null, polls };
      clearTimeout(reviewTimer);
      reviewTimer = setTimeout(() => { void reviewRead(gen, id, null); }, 3000) as unknown as number;
    } else if (cur.crossReview || cur.invalidCrossReview) S.review = null;
    else S.review = { projectId: id, phase: 'failed', error: m => m.reviewInvalid, polls: 0 };
    renderAll();
  }
  /** 프로젝트를 다시 읽어 교차 검토 상태를 본다. why 는 409 의 서버 설명: 검토가 없으면 그 이유를 실패로 보인다 */
  async function reviewRead(gen: number, id: string, why: Text | null): Promise<void> {
    const run = S.run;
    if (gen !== S.gen || run?.project?.id !== id) return;
    const failed = (msg: Text) => { if (gen !== S.gen || S.run?.project?.id !== id) return; S.review = { projectId: id, phase: 'failed', error: msg, polls: 0 }; renderAll(); };
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${run.accessToken}` } });
    } catch { return failed(why ? m => m.reviewRequestFailed(why(m)) : m => m.reviewNetwork); }
    if (gen !== S.gen || S.run?.project?.id !== id) return;
    if (!res.ok) { const msg = await errorText(res); return failed(m => m.reviewRequestFailed((why ?? msg)(m))); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen || S.run?.project?.id !== id) return;
    const next = normalizeProject(body);
    if (why && next && next.id === id && !next.crossReview && !next.invalidCrossReview) { newer(next); return failed(m => m.reviewRequestFailed(why(m))); }
    adoptReview(gen, id, body, () => failed(m => m.reviewInvalid));
  }

  // ── 결정 메모: 사용자가 누를 때만 한 번 (서버도 프로젝트마다 한 번만 시도한다). 응답을 확인하지 못하면 다시 보내지 않고 읽기만 한다
  /** 메모를 부를 수 없는 이유. null 이면 부를 수 있다 */
  function memoBlocked(p: ConsoleProject): Text | null {
    if (p.brief.mode !== 'live' || !TERMINAL_PROJECT.includes(p.status) || p.status === 'cancelled'
      || !p.experts.some(e => e.status === 'completed' && e.opinion && !e.invalidOpinion)) return m => m.p2.memoNeedOpinion;
    if (p.memoBudget ? p.memoBudget.available <= 0 : p.brief.budget?.maxMemoCalls === 0) return m => m.p2.memoNoBudget;
    return null;
  }
  const memoNames = (p: ConsoleProject, ids: string[]) => ids.map(id => expertName(p, id)).join(', ');
  function claimMeta(p: ConsoleProject, expertIds: string[], refs: MemoReference[]): Kid {
    const m = M, name = (id: string) => expertName(p, id);
    if (!expertIds.length && !refs.length) return null;
    return h('span', { class: 'cb-memo-meta' }, expertIds.length ? h('span', null, m.p2.memoBy(memoNames(p, expertIds))) : null,
      refs.length ? h('span', { class: 'cb-memo-refs' }, ...refs.map(r => h('span', { class: 'cb-tag' }, memoRefText(p, r, m, name)))) : null);
  }
  function claimItems(p: ConsoleProject, list: MemoClaim[]): Kid {
    if (!list.length) return h('p', { class: 'cb-help' }, M.p2.memoEmpty);
    return h('ul', { class: 'cb-memo-claims' }, ...list.map(c => h('li', null, h('span', null, c.text), claimMeta(p, c.expertIds, c.refs))));
  }
  function memoView(p: ConsoleProject, d: DecisionMemo, prefix: string, opened: Set<string>): Kid[] {
    const m = M, t = m.p2, r = d.recommendation;
    const lists: Array<[string, MemoClaim[]]> = [[t.memoDissent, d.dissent], [t.memoUnknowns, d.criticalUnknowns], [t.memoTriggers, d.changeTriggers], [t.memoActions, d.nextActions]];
    return [
      h('h4', null, t.memoSummary), h('p', null, d.summary),
      h('div', { class: 'cb-memo-rec' }, h('h4', null, t.memoRecommendation), h('p', { class: 'cb-help' }, t.memoRecNote),
        r.status === 'recommend' && r.options.length
          ? h('ul', { class: 'cb-memo-picks' }, ...r.options.map(o => h('li', null, h('span', { class: 'cb-tag' }, o.id), ' ', o.text)))
          : h('p', null, h('strong', null, t.memoNoRec)),
        r.rationale ? h('p', null, r.rationale) : null, claimMeta(p, r.expertIds, r.refs)),
      h('h4', null, t.memoComparison),
      d.comparison.length ? h('div', { class: 'cb-memo-scroll' }, h('table', { class: 'cb-memo-table' },
        h('thead', null, h('tr', null, ...[t.memoOption, t.memoBenefits, t.memoRisks, t.memoConditions].map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', null, ...d.comparison.map(o => h('tr', null,
          h('th', { scope: 'row' }, h('span', { class: 'cb-tag' }, o.optionId), ' ', o.optionText),
          h('td', { 'data-label': t.memoBenefits }, claimItems(p, o.benefits)), h('td', { 'data-label': t.memoRisks }, claimItems(p, o.risks)),
          h('td', { 'data-label': t.memoConditions }, claimItems(p, o.conditions))))))) : h('p', { class: 'cb-help' }, t.memoEmpty),
      ...lists.flatMap(([label, list]) => [h('h4', null, label), claimItems(p, list)]),
      p.memo?.coverage ? evDisclosure(opened, `${prefix}memo-cov`, 'cb-quiet', [h('span', null, t.memoCoverage)],
        h('ul', { class: 'cb-memo-cov' }, ...memoCoverageLines(p.memo.coverage, m).map(x => h('li', null, x)))) : null,
    ];
  }
  const memoUntried = (p: ConsoleProject) => !p.memo || (p.memo.status === 'idle' && p.memo.attempts === 0);
  function memoKids(p: ConsoleProject, interactive: boolean, prefix: string, opened: Set<string>): Kid[] {
    const m = M, t = m.p2, pm = p.memo;
    const local = interactive && S.memo?.projectId === p.id ? S.memo : null;
    const run = interactive ? S.run : null;
    const mine = !!run && run.mode === 'live' && !!run.accessToken && run.project?.id === p.id;
    if (!pm && !p.invalidMemo && !local && !(mine && TERMINAL_PROJECT.includes(p.status))) return [];
    const kids: Kid[] = [h('p', { class: 'cb-help' }, t.memoExplain)];
    if (!interactive) kids.push(h('p', { class: 'cb-help' }, t.memoSaved));
    if (p.invalidMemo) kids.push(h('p', { class: 'cb-warn' }, t.memoInvalid));
    const running = local?.phase === 'running' || pm?.status === 'running';
    if (running) kids.push(h('p', { class: 'cb-help', role: 'status' }, local?.phase === 'running' ? t.memoRunning : t.memoServerRunning));
    else if (local?.phase === 'reading') kids.push(h('p', { class: 'cb-help', role: 'status' }, t.memoReading));
    else if (local?.phase === 'unknown') kids.push(h('p', { class: 'cb-warn', role: 'alert' }, (local.error ?? (mm => mm.p2.memoNetwork))(m)),
      h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'memo-check', disabled: !mine, onclick: () => { void memoRead(S.gen, p.id, null); } }, t.memoCheck));
    else if ((local?.phase === 'failed' || local?.phase === 'blocked') && local.error) kids.push(h('p', { class: 'cb-warn', role: 'alert' }, local.error(m)));
    if (pm?.status === 'failed') kids.push(h('p', { class: 'cb-warn' }, t.memoFailed(pm.error ?? '')));
    if (pm?.status === 'needs-options') kids.push(h('p', { class: 'cb-warn' }, t.memoNeedsOptions(pm.reason ?? '')));
    if (pm?.status === 'completed' && pm.memo)
      kids.push(h('p', { class: 'cb-ok' }, t.memoDone(hhmm(pm.completedAt ?? pm.startedAt ?? 0), pm.language ? m.wfLangName[pm.language] : '')), ...memoView(p, pm.memo, prefix, opened));
    // 유료 버튼: 지금 실행에서, 서버가 아직 한 번도 시도하지 않았고, 이 화면도 보낸 적이 없을 때만 (사용 기록은 그리기만 한다)
    // blocked: 서버가 409 로 아무것도 시도·예약하지 않았음을 GET 으로 확인했다 → 첫 유료 시도를 그대로 남긴다
    if (interactive && mine && memoUntried(p) && !p.invalidMemo && (!local || local.phase === 'blocked') && !running) {
      const why = memoBlocked(p);
      if (why || active()) kids.push(h('p', { class: 'cb-help' }, why ? why(m) : t.memoIdle));
      else if (reviewBusy(p)) kids.push(h('p', { class: 'cb-help', role: 'status' }, t.memoWaitReview),
        // 이 화면이 조회하지 않는 (다른 곳에서 건) 검토는 GET 으로만 다시 읽는다
        S.review?.projectId === p.id && S.review.phase === 'running' ? null
          : h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'memo-check', onclick: () => { void memoRead(S.gen, p.id, null); } }, t.memoCheck));
      else kids.push(h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'memo-run', onclick: () => { void runMemo(); } }, t.memoBtn),
        h('p', { class: 'cb-help' }, t.memoOneAttempt));
    } else if (!interactive && memoUntried(p) && !p.invalidMemo) kids.push(h('p', { class: 'cb-help' }, t.memoNone));
    else if (interactive && !running && local?.phase !== 'reading') kids.push(h('p', { class: 'cb-help' }, t.memoOneAttempt));
    return kids;
  }
  async function runMemo(): Promise<void> {
    const run = S.run, p = run?.project;
    if (!run || !p || run.mode !== 'live' || !run.accessToken || active() || memoBlocked(p) || (S.memo?.projectId === p.id && S.memo.phase !== 'blocked') || !memoUntried(p) || reviewBusy(p)) return;
    const gen = S.gen, id = p.id;
    S.memo = { projectId: id, phase: 'running', error: null, polls: 0 };
    renderEvidence();
    const here = () => gen === S.gen && S.run?.project?.id === id;
    const failed = (msg: Text) => { if (!here()) return; S.memo = { projectId: id, phase: 'failed', error: msg, polls: 0 }; keepFocus(renderEvidence); };
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}/memo`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: `Bearer ${run.accessToken}`, 'content-type': 'application/json' }, body: '{}' });
    } catch {
      // 요청이 서버에 닿았는지 모른다: 다시 보내지 않고 저장된 상태를 읽는다
      if (!here()) return;
      S.memo = { projectId: id, phase: 'unknown', error: m => m.p2.memoNetwork, polls: 0 };
      return memoRead(gen, id, null);
    }
    if (!here()) return;
    // 409 는 서버가 시작하지 않았다는 뜻일 수 있다 (예: 교차 검토 진행 중, 예약 없음). 짐작하지 않고 GET 으로 확인한다
    if (res.status === 409) {
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 본문 없음 */ }
      const msg = await errorText(res, false, { body }), reason = isObj(body) ? str(body.error, 200) : '';
      return memoRead(gen, id, msg, m => m.p2.memoDeferred(reason));
    }
    if (!res.ok) { const msg = await errorText(res); return failed(m => m.p2.memoRequestFailed(msg(m))); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (!here()) return;
    adoptMemo(gen, id, body, () => failed(m => m.p2.memoInvalid));
  }
  /** 서버 ProjectRun 을 받아 메모 상태를 그대로 보인다. 진행 중이면 읽기 조회만 이어 간다 */
  function adoptMemo(gen: number, id: string, body: unknown, invalid: () => void): void {
    const next = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
    if (!next || next.id !== id || !S.run?.project) return invalid();
    const cur = newer(next);
    if (cur.memo?.status === 'running') {
      const polls = (S.memo?.projectId === id ? S.memo.polls : 0) + 1;
      if (polls > 40) { S.memo = { projectId: id, phase: 'failed', error: m => m.p2.memoPollStopped, polls }; renderAll(); return; }
      S.memo = { projectId: id, phase: 'running', error: null, polls };
      clearTimeout(memoTimer);
      memoTimer = setTimeout(() => { void memoRead(gen, id, null); }, 3000) as unknown as number;
    } else if (!memoUntried(cur) || cur.invalidMemo) S.memo = { projectId: id, phase: 'settled', error: null, polls: 0 };
    else S.memo = { projectId: id, phase: 'unknown', error: m => m.p2.memoNotFound, polls: 0 };
    renderAll();
  }
  /** GET 으로만 다시 읽는다 (유료 POST 를 다시 보내지 않는다). why 는 409 의 서버 설명, deferred 는 그 뒤 시도 기록이 없을 때 보일 문구.
   *  409 뒤이거나, 이 화면이 보낸 요청이 없거나(prev 없음) 이미 blocked 일 때만, 시도 기록이 없으면 유료 버튼을 남긴다 */
  async function memoRead(gen: number, id: string, why: Text | null, deferred?: Text): Promise<void> {
    const run = S.run;
    if (gen !== S.gen || run?.project?.id !== id || !run.accessToken) return;
    const here = () => gen === S.gen && S.run?.project?.id === id;
    const unknown = (msg: Text) => { if (!here()) return; S.memo = { projectId: id, phase: 'unknown', error: msg, polls: 0 }; keepFocus(renderAll); };
    const prev = S.memo?.projectId === id ? S.memo : null;
    const safe = !why && (!prev || prev.phase === 'blocked');
    const keep = (msg: Text) => { if (!here()) return; S.memo = { projectId: id, phase: 'blocked', error: msg, polls: 0 }; keepFocus(renderAll); };
    if (prev?.phase !== 'running') { S.memo = { projectId: id, phase: 'reading', error: prev?.error ?? null, polls: prev?.polls ?? 0 }; renderEvidence(); }
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${run.accessToken}` } });
    } catch { return safe ? keep(m => m.p2.memoReadFailed) : unknown(m => m.p2.memoNetwork); }
    if (!here()) return;
    if (!res.ok) { const msg = await errorText(res); return safe ? keep(m => m.withServer(m.p2.memoReadFailed, msg(m))) : unknown(m => m.p2.memoRequestFailed((why ?? msg)(m))); }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (!here()) return;
    const next = normalizeProject(body);
    if ((why || safe) && next && next.id === id) {
      const cur = newer(next);
      if (memoUntried(cur) && !cur.invalidMemo) {
        S.memo = why ? { projectId: id, phase: 'blocked', error: deferred ?? (m => m.p2.memoRequestFailed(why(m))), polls: 0 }
          : prev ? { ...prev, phase: 'blocked' } : null;
        renderAll(); return;
      }
    }
    adoptMemo(gen, id, body, () => unknown(m => m.p2.memoInvalid));
  }

  // ── 관찰 신호: 서버 장부를 그대로. null 칸은 UNKNOWN (0 이 아니다)
  function signalsKids(p: ConsoleProject, prefix: string, opened: Set<string>): Kid[] {
    const m = M, t = m.p2, sg = p.evidenceSignals;
    if (p.invalidSignals) return [h('p', { class: 'cb-warn' }, t.sigInvalid)];
    if (!sg) return TERMINAL_PROJECT.includes(p.status) && p.experts.some(e => e.opinion) ? [h('p', { class: 'cb-help' }, t.sigMissing)] : [];
    const name = (id: string) => expertName(p, id);
    return [
      h('p', { class: 'cb-help' }, t.sigNote), h('p', { class: 'cb-help' }, sg.interpretation),
      h('ul', { class: 'cb-sig-summary' }, ...signalSummary(sg, m, name).map(x => h('li', null, x))),
      ...sg.experts.map(e => evDisclosure(opened, `${prefix}sig:${e.expertId}`, 'cb-quiet', [h('span', null, name(e.expertId)), ' ', h('span', { class: 'cb-tag' }, `${t.sigSelf} ${e.selfAssessedConfidence}%`)],
        h('dl', { class: 'cb-sig-dl' }, ...signalRows(e, m).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null ? h('span', { class: 'cb-unknown' }, t.unknown) : v)])))),
    ];
  }

  // ── 이전 라운드: 서버가 만든 비교·참고. 이전 의견은 새 결과가 아니다
  function roundKids(p: ConsoleProject, prefix: string, opened: Set<string>): Kid[] {
    const m = M, t = m.p2, r = p.previousRound;
    if (p.invalidRound) return [h('p', { class: 'cb-warn' }, t.roundInvalid)];
    if (!r) return [];
    const ops = r.reference.opinions;
    const name = (id: string) => ops.find(o => o.expertId === id)?.name ?? expertName(p, id);
    return [...roundBaseKids(p, r, prefix, opened, name), ...authorPlanKids(p, r.authorResponse, prefix, opened, name)];
  }
  /** 작성자 응답: 지적마다 작성자의 수정·철회·유지와 근거, 없음·일부·거부를 역할의 의견 상태와 따로 보인다. 원래 의견은 바뀌지 않은 이전 기록이다 */
  function authorPlanKids(p: ConsoleProject, plan: AuthorResponsePlan | undefined, prefix: string, opened: Set<string>, name: NameOf): Kid[] {
    const m = M, t = m.p3;
    if (p.invalidAuthorPlan) return [h('p', { class: 'cb-warn' }, t.arPlanInvalid)];
    if (!plan) return [];
    const kids: Kid[] = [h('h4', null, t.arTitle), h('p', { class: 'cb-help' }, t.arNote),
      h('p', { class: 'cb-help' }, t.arCapped(plan.capped.included, plan.capped.eligibleSelected)),
      plan.unselectedAuthors.length ? h('p', { class: 'cb-help' }, t.arUnselected(plan.unselectedAuthors.map(name).join(', '))) : null,
      plan.disclosure ? h('p', { class: 'cb-help' }, plan.disclosure) : null];
    for (const a of plan.authors) {
      const run = p.experts.find(e => e.expertId === a.expertId), ar = run?.authorResponse;
      const parsed = ar && !('invalid' in ar) ? ar : null;
      const state = run?.invalidAuthorResponse ? h('p', { class: 'cb-warn' }, t.arUnreadable)
        : ar && 'invalid' in ar ? h('p', { class: 'cb-warn' }, t.arInvalid(ar.invalid))
        : parsed ? h('p', null, h('span', { class: `cb-tag ${parsed.coverage.status === 'complete' ? 'is-avail' : 'is-unval'}` }, t.arStatus[parsed.coverage.status]), ' ', t.arAnswered(parsed.coverage.answered, parsed.coverage.expected))
        : h('p', { class: 'cb-help' }, t.arPending);
      kids.push(h('article', { class: 'cb-ar-author', 'aria-label': `${t.arTitle}: ${a.name}` },
        h('h5', null, a.name),
        h('p', { class: 'cb-help' }, t.arOriginal(m.direction[a.original.direction], a.original.confidence)), h('p', { class: 'cb-ar-original' }, a.original.summary),
        state, h('p', { class: 'cb-help' }, t.arSeparate),
        h('ol', { class: 'cb-findings' }, ...plan.findings.filter(f => a.findingIds.includes(f.findingId)).map(f => {
          const r = parsed?.responses.find(x => x.findingId === f.findingId);
          return h('li', { class: 'cb-finding' },
            h('div', { class: 'cb-finding-head' }, h('span', { class: `cb-chip ${VERDICT_CHIP[f.verdict]}` }, m.verdict[f.verdict]),
              h('strong', null, m.reviewFinding(name(f.targetExpertId), f.evidenceIndex + 1)), h('span', { class: 'cb-tag' }, m.reviewBy(name(f.reviewerExpertId)))),
            evDisclosure(opened, `${prefix}ar:${f.findingId}`, 'cb-quiet', [h('span', null, `${t.arEvidence} · ${t.arReviewer}`)],
              h('blockquote', { class: 'cb-finding-evidence' }, f.evidenceText), f.reviewerRationale ? h('p', null, f.reviewerRationale) : null),
            r ? h('div', { class: 'cb-ar-answer' }, h('span', { class: `cb-chip is-${r.disposition}` }, t.arDisposition[r.disposition]), ' ', h('span', null, r.rationale))
              : parsed ? h('p', { class: 'cb-help' }, t.arMissing) : null);
        }))));
    }
    return kids;
  }
  function roundBaseKids(p: ConsoleProject, r: ProjectPreviousRound, prefix: string, opened: Set<string>, name: NameOf): Kid[] {
    const m = M, t = m.p2, ops = r.reference.opinions;
    return [
      h('p', null, h('span', { class: 'cb-tag' }, t.roundOf(r.parentId))),
      h('p', { class: 'cb-help' }, t.roundNote),
      h('h4', null, t.roundChange), h('p', { class: 'cb-round-change' }, r.changeSummary),
      h('ul', { class: 'cb-round-diff' }, ...roundLines(r, m, name).map(x => h('li', null, x))),
      ops.length ? evDisclosure(opened, `${prefix}round-refs`, 'cb-quiet', [h('span', null, t.roundRefs(ops.length))],
        h('ol', { class: 'cb-round-refs' }, ...ops.map(o => h('li', null,
          h('div', { class: 'cb-claim-head' }, h('strong', null, o.name), o.selectedAgain ? h('span', { class: 'cb-tag' }, t.roundAgain) : null),
          h('p', { class: 'cb-help' }, t.roundOpinion(m.direction[o.direction], o.confidence)), h('p', null, o.summary),
          o.evidence.length ? h('ul', null, ...o.evidence.map(x => h('li', null, x))) : null)))) : null,
    ];
  }

  function historyDisclosure(key: string, title: string, ...content: Kid[]): HTMLDetailsElement {
    const box = h('details', { class: 'cb-disclosure cb-history-disclosure', open: H.opened.has(key) }, h('summary', null, icon('chevron'), title), ...content);
    box.addEventListener('toggle', () => { if (box.open) H.opened.add(key); else H.opened.delete(key); });
    return box;
  }
  function renderHistory(): void {
    if (S.view !== 'history' || (!H.dirty && H.renderedLang === lang)) return;
    H.dirty = false; H.renderedLang = lang;
    const t = HT();
    if (H.list && !H.owner && !S.adminToken.trim() && !ownerAuthed()) { profileName.textContent = M.profileVisitor; profileState.textContent = lang === 'ko' ? '이 브라우저의 사용 기록' : 'History for this browser'; }
    const tabs = h('div', { class: 'cb-history-toolbar', role: 'group', 'aria-label': t.title });
    for (const tab of (H.owner ? ['mine', 'all', 'report'] : ['mine']) as Array<typeof H.tab>) {
      tabs.append(h('button', { type: 'button', class: 'cb-seg', 'aria-pressed': String(H.tab === tab), 'data-fk': 'hist-tab:' + tab, onclick: () => {
        H.gen++; H.detailGen++; H.busy = false; H.detailBusy = false; H.tab = tab; H.list = null; H.detail = null; H.error = 0; H.message = ''; void loadHistory();
      } }, t[tab]));
    }
    tabs.append(h('button', { type: 'button', class: 'cb-secondary', disabled: H.busy, 'data-fk': 'hist-refresh', onclick: () => { void loadHistory(); } }, t.refresh));
    const notices: Kid[] = [tabs];
    if (H.error || H.unauthorized) notices.push(h('p', { class: 'cb-warn', role: 'alert' }, H.unauthorized ? t.auth : t.error(H.error), ' ', pageLink(OWNER_INBOX_PATH, m => m.ownerInbox)));
    if (H.busy) notices.push(h('p', { role: 'status', class: 'cb-help' }, t.loading));
    if (H.message === 'fu-cleared') notices.push(h('p', { role: 'status', class: 'cb-help' }, M.p2.fuCleared));
    if (H.tab === 'report' && H.report && H.owner) {
      const r = H.report;
      fill(historyBody, ...notices, h('section', { class: 'cb-panel cb-history-report' }, h('h3', null, t.report), h('p', null, t.reportIntro),
        h('p', { class: 'cb-help' }, t.sample(r.analyzed, r.live, r.demoExcluded, r.pending)), h('p', { class: 'cb-help' }, t.qualityNote),
        r.experts > 0 && r.experts < 20 ? h('p', { class: 'cb-help' }, t.small) : null,
        r.insights.length ? h('ul', { class: 'cb-history-insights' }, ...r.insights.map(x => h('li', null, t.insights[x.kind](x.count, x.total)))) : h('p', null, t.noSignals),
        r.experts ? h('h3', null, t.counts) : null, r.experts ? historyTable([t.completed, t.failed, t.referenced, t.feedbackHelpful, t.feedbackUnhelpful], [[r.completed, r.failed, r.referenced, r.feedback.helpful, r.feedback.unhelpful].map(String)]) : null,
        r.experts ? historyTable([t.role, t.basis, t.completed, t.failed, t.referenced, t.feedbackUnhelpful, t.revision], r.roles.map(x => [findDef(x.id)?.name ?? x.id, x.basis === 'curated-knowledge' ? t.knowledge : x.basis === 'metadata-derived' ? t.metadata : t.unknown, ...[x.completed, x.failed, x.referenced, x.unhelpful, x.revisions.length].map(String)])) : null,
        r.experts ? historyDisclosure('diagnostics', lang === 'ko' ? '진단 세부 정보' : 'Diagnostic details',
        h('h3', null, t.confidence), historyTable(['0–19', '20–39', '40–59', '60–79', '80–100'], [r.confidenceBins.map(String)]),
        h('h3', null, t.errors), historyTable([t.errors, t.failed], Object.entries(r.errors).map(([k, n]) => [t.errorKinds[k] ?? k, String(n)])),
        h('h3', null, t.feedbackIssues), historyTable([t.issue, t.feedbackUnhelpful], Object.entries(r.feedback.issues).map(([k, n]) => [t.issues[k as HistoryIssue] ?? k, String(n)])),
        h('h3', null, t.models), historyTable([t.model, t.projects, t.failed], r.models.map(x => [x.model, String(x.projects), String(x.failed)]))) : null));
      return;
    }
    const list = h('section', { class: 'cb-panel cb-history-list', 'aria-label': t.title });
    if (!H.list?.rows.length && !H.busy && !H.unauthorized) list.append(h('p', null, t.empty));
    for (const p of H.list?.rows ?? []) list.append(h('button', { type: 'button', class: 'cb-history-record', 'aria-pressed': String(H.detail?.project.id === p.id), 'data-fk': 'hist-record:' + p.id, onclick: () => { void openHistory(p.id); } },
      h('strong', null, p.title), h('span', null, `${M.projectStatus[p.status]} · ${p.mode === 'live' ? M.modeLive : M.modeDemo}`), h('small', null, `${historyDate(p.createdAt)} · ${M.experts(p.expertCount)}${p.browser ? ' · ' + p.browser : ''}`)));
    if (H.list?.next) list.append(h('button', { type: 'button', class: 'cb-secondary', disabled: H.busy, onclick: () => { void loadHistory(true); } }, t.more));
    const detail = h('section', { class: 'cb-panel cb-history-detail', 'aria-label': t.detail });
    if (H.detailBusy) detail.append(h('p', { role: 'status' }, t.loading));
    else if (!H.detail) detail.append(h('p', { class: 'cb-help' }, t.select));
    else {
      const d = H.detail, p = d.project;
      detail.append(h('h3', null, p.brief.title), h('p', { class: 'cb-help' }, `${M.projectStatus[p.status]} · ${t.model}: ${d.model} · ${t.expires}: ${historyDate(d.expiresAt)}`),
        h('h4', null, t.objective), h('p', { class: 'cb-history-copy' }, p.brief.objective));
      if (p.brief.context) detail.append(historyDisclosure(p.id + ':context', t.context, h('p', { class: 'cb-history-copy' }, p.brief.context)));
      if (H.message === 'saved') detail.append(h('p', { role: 'status', class: 'cb-ok' }, t.saved));
      for (const e of p.experts) {
        const article = h('article', { class: 'cb-history-answer' }, h('h4', null, e.name), h('p', { class: 'cb-help' }, M.status[e.status]));
        if (e.opinion) {
          article.append(h('p', { class: 'cb-help' }, M.mdOpinion(M.direction[e.opinion.direction], e.opinion.confidence)), h('p', { class: 'cb-history-copy' }, e.opinion.summary));
          if (d.reports?.[e.expertId]) article.append(historyDisclosure(p.id + ':' + e.id + ':report', lang === 'ko' ? '전체 보고서' : 'Full report', h('pre', { class: 'cb-history-copy' }, d.reports[e.expertId])));
          for (const [part, heading, content] of [['evidence', t.sources, e.opinion.evidence], ['assumptions', t.assumptions, e.opinion.assumptions], ['actions', t.actions, e.opinion.nextActions]] as const)
            article.append(historyDisclosure(p.id + ':' + e.id + ':' + part, heading, h('ul', { class: 'cb-history-copy' }, ...content.map(x => h('li', null, x)))));
          const prior = d.feedback.find(f => f.expertId === e.expertId);
          if (d.canFeedback) {
            const key = p.id + ':' + e.expertId;
            if (!H.drafts.has(key)) H.drafts.set(key, prior ? { expertId: prior.expertId, rating: prior.rating, issue: prior.issue, comment: prior.comment } : { expertId: e.expertId, rating: 'helpful', comment: '' });
            const draft = H.drafts.get(key)!, base = 'hist-' + e.id;
            const rating = h('select', { id: base + '-rating', 'data-fk': key + '-rating' }, h('option', { value: 'helpful', selected: draft.rating === 'helpful' }, t.helpful), h('option', { value: 'unhelpful', selected: draft.rating === 'unhelpful' }, t.unhelpful));
            rating.addEventListener('change', () => { draft.rating = rating.value === 'unhelpful' ? 'unhelpful' : 'helpful'; if (draft.rating === 'helpful') delete draft.issue; paintHistory(); });
            const reason = h('select', { id: base + '-issue', disabled: draft.rating === 'helpful', 'data-fk': key + '-issue' }, h('option', { value: '', selected: !draft.issue }, t.noIssue), ...Object.entries(t.issues).map(([k, text]) => h('option', { value: k, selected: draft.issue === k }, text)));
            reason.addEventListener('change', () => { if (reason.value in t.issues) draft.issue = reason.value as HistoryIssue; else delete draft.issue; });
            const comment = h('textarea', { id: base + '-comment', maxlength: 1000, rows: 2, value: draft.comment, 'data-fk': key + '-comment' });
            comment.addEventListener('input', () => { draft.comment = comment.value; });
            const form = h('form', { class: 'cb-history-feedback' }, h('label', { for: base + '-rating' }, t.feedback), rating,
              h('label', { for: base + '-issue' }, t.issue), reason, h('label', { for: base + '-comment' }, t.comment), comment,
              h('button', { type: 'submit', class: 'cb-secondary', disabled: H.mutation, 'data-fk': key + '-save' }, t.save));
            form.addEventListener('submit', ev => { ev.preventDefault(); void saveHistoryFeedback(p.id, { ...draft }); }); article.append(historyDisclosure(key + ':feedback', t.feedback, form));
          } else if (prior) article.append(h('p', { class: 'cb-help' }, `${prior.rating === 'helpful' ? t.helpful : t.unhelpful}${prior.issue ? ' · ' + t.issues[prior.issue] : ''}`, prior.comment ? '\n' + prior.comment : ''));
        } else if (e.error) article.append(h('p', { class: 'cb-warn' }, e.error));
        detail.append(article);
      }
      const saved = normalizeProject(p);
      if (saved) detail.append(...evidenceKids(saved, H.opened, `${p.id}:ev:`, false).filter((k): k is Node | string => !!k));
      if (saved && followUpEligible(saved)) detail.append(h('div', { class: 'cb-history-followup' },
        h('button', { type: 'button', class: 'cb-secondary', 'data-fk': 'hist-followup', disabled: locked(), onclick: () => startFollowUp(saved) }, M.p2.fuStart),
        h('p', { class: 'cb-help' }, M.p2.fuStartHelp)));
      detail.append(h('p', { class: 'cb-help' }, t.qualityNote));
      if (H.deleteId === p.id) detail.append(h('div', { class: 'cb-history-delete', role: 'group', 'aria-label': t.confirm }, h('p', null, t.confirm),
        h('button', { type: 'button', class: 'cb-secondary', disabled: H.mutation, onclick: () => { void deleteHistory(p.id); } }, t.deleteYes),
        h('button', { type: 'button', class: 'cb-ghost', disabled: H.mutation, onclick: () => { H.deleteId = ''; paintHistory(); } }, t.cancel)));
      else detail.append(h('button', { type: 'button', class: 'cb-ghost', onclick: () => { H.deleteId = p.id; paintHistory(); } }, t.remove));
    }
    fill(historyBody, ...notices, h('div', { class: 'cb-history-grid' }, list, detail), h('p', { class: 'cb-help' }, t.ownerNote));
  }

  // ── 후속 라운드
  /** 지금 화면의 초안과 부모의 차이 (화면 표시용). 서버가 만든 previousRound 가 실행 뒤의 최종 비교다 */
  function draftRound(parent: ConsoleProject): DraftRound {
    const frame = parseDecision(decisionTexts()).frame;
    return {
      stage: [parent.brief.stage ?? 'unspecified', (STAGES.includes(stageSel.value as ProjectStage) ? stageSel.value : 'unspecified') as ProjectStage],
      language: [parent.brief.responseLanguage ?? '', (RESPONSE_LANGS.includes(respSel.value as ResponseLanguage) ? respSel.value : '') as ResponseLanguage | ''],
      previous: parent.brief.decision?.options ?? [], current: frame?.options ?? [], decision: frame ?? {},
      docs: S.docs.map(d => ({ name: d.name, content: d.content })), roles: autoRoute() ? null : [...S.selected],
    };
  }
  function renderFollowUp(): void {
    const fu = S.followUp, m = M;
    fuBox.hidden = !fu;
    if (!fu) return;
    const p = fu.parent, name = (id: string) => expertName(p, id);
    fuParentLine.textContent = m.p2.fuParent(p.brief.title, fu.parentId);
    const ar = fu.authorResponse;
    fuAuthorLine.hidden = !ar; fuRolesNote.hidden = !!ar;
    fuAuthorLine.textContent = ar ? m.p3.fuAuthor(ar.affected.map(name).join(', ')) : '';
    fill(fuDiffList, ...draftRoundLines(p, draftRound(p), m, name).map(x => h('li', null, x)));
    const ops = p.experts.filter(e => e.status === 'completed' && e.opinion && !e.invalidOpinion);
    fill(fuRefs, ops.length ? evDisclosure(S.evOpen, `fu:${fu.parentId}:refs`, 'cb-quiet', [h('span', null, m.p2.roundRefs(ops.length))],
      h('p', { class: 'cb-help' }, m.p2.roundNote),
      h('ul', { class: 'cb-round-refs' }, ...ops.map(e => h('li', null, h('strong', null, e.name), ' ',
        h('span', { class: 'cb-help' }, m.p2.roundOpinion(m.direction[e.opinion!.direction], e.opinion!.confidence)))))) : null);
  }
  /** 사용 기록의 끝난 실제 실행을 새 프로젝트 초안으로 옮긴다. 아무것도 실행하지 않고, 이전 의견은 참고로만 보인다 */
  function startFollowUp(parent: ConsoleProject): void {
    if (locked() || !followUpEligible(parent)) return;
    if (S.mode !== 'live') setMode('live');
    const b = parent.brief;
    titleIn.value = b.title; objectiveIn.value = b.objective; contextIn.value = b.context;
    for (const f of DECISION_FIELDS) decisionIns[f].value = (b.decision?.[f] ?? []).join('\n');
    S.docs = (b.documents ?? []).map(d => ({ key: ++docKey, name: d.name, content: d.content, ...(d.origin ? { origin: d.origin } : {}) }));
    S.docErrors = []; S.docOpen.clear(); docRev++;
    stageSel.value = b.stage && b.stage !== 'unspecified' ? b.stage : '';
    respSel.value = b.responseLanguage ?? '';
    for (const f of BUDGET_FIELDS) budgetIns[f].value = '';
    // 역할: 이전 팀을 직접 고르기로 미리 채운다 (사용자가 바꾸거나 Jev 로 새로 고르게 할 수 있다). 숨은 선택은 없다
    S.selected.clear();
    const allowed = new Set(catalogue().map(e => e.id));
    for (const id of b.expertIds) if (allowed.has(id) && S.selected.size < limits().max) S.selected.add(id);
    if (routing()) S.routeMode = 'manual';
    S.followUp = { parentId: parent.id, parent, changeSummary: '' };
    fuSummaryIn.value = '';
    planGen++; S.plan = null; S.planReq = null; S.planStale = false; S.formErrors = []; S.route = null;
    S.setupOpen = true;
    if (b.decision) decisionDetails.open = true;
    if (b.documents?.length) docsDetails.open = true;
    setView('home');
    renderAll();
    fuSummaryIn.focus();
  }
  /** 작성자 응답 요청: 보통 후속 초안을 열고, 반박·부족 지적을 받은 완료 작성자만 직접 고르기로 미리 채운다. 아무것도 실행하지 않는다 */
  function startAuthorResponse(parent: ConsoleProject): void {
    if (locked() || !authorResponseEligible(parent)) return;
    const affected = authorResponseAffected(parent);
    startFollowUp(parent);
    const fu = S.followUp;
    if (!fu || fu.parentId !== parent.id) return;
    fu.authorResponse = { reviewSnapshotHash: parent.crossReview!.snapshotHash, affected };
    S.selected.clear();
    const allowed = new Set(catalogue().map(e => e.id));
    for (const id of affected) if (allowed.has(id) && S.selected.size < limits().max) S.selected.add(id);
    if (routing()) S.routeMode = 'manual';
    renderAll();
    fuSummaryIn.focus();
  }
  function dropFollowUp(): void {
    S.followUp = null; fuSummaryIn.value = '';
    planGen++; S.plan = null; S.planReq = null; S.planStale = false;
    S.formErrors = S.formErrors.filter(e => e.field !== 'revision');
  }
  /** 초안만 놓는다. 옮겨 온 브리프 글은 사용자의 입력으로 남는다 */
  function cancelFollowUp(): void {
    if (locked()) return;
    dropFollowUp();
    renderAll();
    objectiveIn.focus();
  }

  // ── 동작
  /** 언어를 그 자리에서 바꾼다: 다시 실행·새로 고침 없이 글자만 다시 그리고, 입력·선택·실행·타이머·탭·접기 상태는 그대로 둔다 */
  function setLang(l: Lang): void {
    if (l === lang) return;
    const prev = M;
    lang = l; M = DICT[l];
    // 예시 브리프는 사용자가 고치지 않은 칸만 새 언어로 바꾼다. 사용자가 쓴 글은 건드리지 않는다
    const fresh = !!S.suggest && S.suggest.brief === briefText();
    // Jev 가 고르는 동안에는 바꾸지 않는다: 화면의 브리프가 지금 고르고 있는 질문과 같게 남는다
    if (S.run?.phase !== 'routing' && !preparing()) for (const [inp, k] of [[titleIn, 'sampleTitle'], [objectiveIn, 'sampleObjective'], [contextIn, 'sampleContext']] as const) if (inp.value === prev[k]) inp.value = M[k];
    // 예시가 번역되어 바뀐 것은 사용자가 고친 것이 아니다: 그 전에 최신이던 제안은 그대로 최신으로 둔다
    if (fresh && S.suggest) S.suggest = { ...S.suggest, brief: briefText() };
    for (const f of recount) f();
    applyLang();
    renderAll();
    live.textContent = M.langChanged;
    // 언어는 주소의 ?lang= 에만 남긴다 (저장소 없음, 새 기록 항목 없음). 주소를 못 바꿔도 화면 언어는 바뀐다
    const loc = g.location;
    if (loc && g.history && typeof g.history.replaceState === 'function') {
      try { g.history.replaceState(g.history.state, '', `${loc.pathname ?? ''}${withLang(loc.search ?? '', l)}${loc.hash ?? ''}`); } catch { /* 위 설명 */ }
    }
  }

  /** 문서 언어·제목과 고정 뼈대의 글자를 지금 언어로 */
  function applyLang(): void {
    for (const b of binds) b();
    const docEl = (document as { documentElement?: HTMLElement | null }).documentElement;
    if (docEl && typeof docEl.setAttribute === 'function') docEl.setAttribute('lang', lang);
    try { document.title = M.docTitle; } catch { /* 제목을 못 바꿔도 화면은 그대로 */ }
  }

  function setView(v: View): void {
    if (S.full && v !== 'home') setFull(false);
    const wasHistory = S.view === 'history';
    S.view = v; renderNav();
    navBtns[NAV.indexOf(v)].focus();
    if ((v === 'history' || wasHistory) && g.history && typeof g.history.replaceState === 'function') {
      try { g.history.replaceState(g.history.state, '', (v === 'history' ? '/cloudbite/history' : '/cloudbite') + withLang('', lang)); } catch { /* navigation still works in place */ }
    }
    if (v === 'history') { void loadHistory(); }
    if (v === 'settings') refreshOwner(false);
  }

  function setFull(on: boolean): void { paintFull(on); fullBtn.focus(); }
  /** 전체 화면은 실행 기록을 펼쳐 보이고, 끝나면 사용자가 두었던 열림 상태로 되돌린다 */
  let logWasOpen = false;
  function paintFull(on: boolean): void {
    if (on && !S.full) { logWasOpen = activityLog.open; activityLog.open = true; }
    else if (!on && S.full) activityLog.open = logWasOpen;
    S.full = on;
    wsPanel.className = `cb-panel cb-workspace${on ? ' is-full' : ''}`;
    root!.className = `cb-root${on ? ' is-fullscreen' : ''}`;
    fullIcon.className = `cb-i i-${on ? 'collapse' : 'expand'}`;
    fullIcon.setAttribute('aria-hidden', 'true');
    fullBtn.setAttribute('aria-pressed', String(on));
    paintFullLabel();
  }
  const paintFullLabel = () => { fullLabel.textContent = S.full ? M.exitFullScreen : M.fullScreen; };
  binds.push(paintFullLabel);

  function clearView(): void {
    const p = S.run?.project;
    if (!p) return;
    for (const r of streamRows(p)) S.hiddenRows.add(r.key);
    keepFocus(renderWork);
  }

  function restoreView(): void {
    S.hiddenRows.clear();
    keepFocus(renderWork);
    streamLog.scrollTop = 0;
  }

  /** 지금 카탈로그에 없는 역할을 선택에서 뺀다 */
  function pruneSelection(): void {
    const ids = new Set(catalogue().map(e => e.id));
    for (const id of [...S.selected]) if (!ids.has(id)) S.selected.delete(id);
  }

  function setMode(md: Mode): void {
    if (locked() || S.mode === md) return;
    S.mode = md; S.formErrors = []; S.modePicked = true;
    // 방문자의 실제 실행에는 데모 기본 선택을 넘기지 않는다 (숨은 유료 선택 없음)
    if (md === 'live' && viaVisitor()) S.selected.clear();
    pruneSelection();
    if (!S.selected.size && md === 'demo') defaultSelection();
    renderAll();
    if (md === 'live') refreshOwner(false);
  }

  function defaultSelection(): void {
    const list = catalogue();
    const want: Archetype[] = ['strategy', 'business', 'trust', 'ux'];
    for (const a of want) { const e = list.find(x => archetypeOf(x) === a && !S.selected.has(x.id)); if (e) S.selected.add(e.id); }
    for (const e of list) { if (S.selected.size >= 4) break; S.selected.add(e.id); }
  }

  function clearTimers(): void {
    for (const t of timers) clearTimeout(t); timers = []; clearTimeout(pollTimer); pollTimer = 0; clearTimeout(accessTimer); accessTimer = 0;
    clearTimeout(reviewTimer); reviewTimer = 0;
    clearTimeout(memoTimer); memoTimer = 0;
  }

  /** 방문자 실행이 끝나면 서버가 아는 접근 상태(canCreate)를 다시 읽는다. 실패한 실행의 정리 확인을 기다리는 동안만
   *  잠깐씩 다시 본다. 버튼만 다시 열 뿐 실행·데모는 자동으로 시작하지 않고, 실패 기록은 사용자가 다시 시작할 때까지 둔다 */
  function refreshAccess(fresh: boolean): void {
    clearTimeout(accessTimer); accessTimer = 0;
    if (fresh) accessTries = 0;
    void loadBootstrap().then(() => {
      if (active()) return;
      const r = S.boot.data?.access?.recovery;
      if ((r === 'pending' || r === 'unavailable' || S.boot.status === 'error') && ++accessTries < ACCESS_RECHECKS)
        accessTimer = setTimeout(() => refreshAccess(false), ACCESS_RECHECK_MS) as unknown as number;
    });
  }

  /** 실행은 사용자가 시작 버튼을 눌렀을 때만 시작한다 (첫 화면 자동 데모 없음) */
  function startRun(): void {
    if (locked()) return;
    const f: FormInput = { title: titleIn.value.trim(), objective: objectiveIn.value.trim(), context: contextIn.value.trim(), expertIds: [...S.selected] };
    // Jev 가 고를 때는 직접 고른 선택을 보지도 보내지도 않는다. Jev 를 쓸 수 없으면 직접 고르기로 몰래 바꾸지 않고 막는다
    const auto = autoRoute();
    S.formErrors = validateForm(f, limits()).filter(e => !auto || e.field !== 'experts');
    const dec = parseDecision(decisionTexts());
    S.formErrors.push(...dec.issues);
    if (S.docReading) S.formErrors.push({ field: 'docs', text: m => m.vDocsBusy });
    const wf = parseWorkflow(stageSel.value, respSel.value, budgetTexts());
    S.formErrors.push(...wf.issues);
    // 후속 라운드: 실제 실행만, 바뀐 점 요약 필수. 부모 권한은 서버가 지금 자격으로 다시 확인한다 (화면이 따로 주장하지 않는다)
    const fu = S.followUp, change = fuSummaryIn.value.trim();
    if (fu) {
      if (S.mode !== 'live') S.formErrors.push({ field: 'revision', text: m => m.p2.fuNeedLive });
      if (!change) S.formErrors.push({ field: 'revision', text: m => m.p2.fuNeedSummary });
      else if (change.length > REVISION.changeSummary) S.formErrors.push({ field: 'revision', text: m => m.p2.fuSummaryLong(REVISION.changeSummary) });
      // 작성자 응답: 해당 작성자만 직접 고른다 (해당하지 않는 역할·Jev 자동 선택 없음). 서버가 다시 확인한다
      const ar = fu.authorResponse;
      if (ar && (auto || f.expertIds.some(id => !ar.affected.includes(id)))) S.formErrors.push({ field: 'revision', text: m => m.p3.fuAuthorOnly });
      else if (ar && !f.expertIds.length) S.formErrors.push({ field: 'revision', text: m => m.p3.fuAuthorNone });
    }
    const extras = fu ? { ...wf.extras, revision: { parentId: fu.parentId, changeSummary: change, ...(fu.authorResponse ? { reviewSnapshotHash: fu.authorResponse.reviewSnapshotHash } : {}) } } : wf.extras;
    if (auto) {
      if (!routing()!.ready) S.formErrors.push({ field: 'run', text: m => m.jevUnavailable });
      else if (!routeCredential()) S.formErrors.push({ field: 'run', text: m => m.jevNeedAccess });
    }
    if (S.mode === 'live') {
      if (!S.boot.data?.configuration.liveReady) S.formErrors.push({ field: 'run', text: m => m.serverNotReady });
      if (S.adminToken.trim()) {
        if (isOperatorToken(S.adminToken) && !OPERATOR_TOKEN.test(S.adminToken.trim())) S.formErrors.push({ field: 'run', text: m => m.operatorMalformed });
      } else if (!ownerAuthed() && !visitorCanRun()) S.formErrors.push({ field: 'run', text: accessProblem() ?? (m => m.needCredential) });
    }
    if (S.formErrors.length) {
      // 접힌 Project details 안의 입력이 문제면 펼쳐서 고칠 곳을 보인다
      if (S.formErrors.some(e => e.field === 'title' || e.field === 'context')) projDetails.open = true;
      if (S.formErrors.some(e => e.field === 'decision')) decisionDetails.open = true;
      if (S.formErrors.some(e => e.field === 'docs')) docsDetails.open = true;
      if (S.formErrors.some(e => e.field === 'budget')) budgetDetails.open = true;
      renderControls(); return;
    }
    // 실제 실행: 준비한 계획이 지금 입력과 같으면 그 계획을 실행하고, 아니면 새 계획을 준비한다 (바로 실행하지 않는다)
    if (S.mode === 'live') {
      if (S.plan?.phase === 'ready' && S.plan.sig === semanticSig()) executePlan();
      else void preparePlan(f, dec.frame, extras, auto);
      return;
    }
    clearTimers();
    const gen = ++S.gen;
    const brief: ProjectBrief = { ...f, mode: S.mode, requestId: crypto.randomUUID(), ...briefExtras({ decision: dec.frame, documents: S.docs.length ? docsPayload(S.docs) : undefined }), ...wf.extras };
    S.review = null; S.memo = null;
    S.artifactCache.clear(); S.hiddenRows.clear(); S.focusExpert = ''; S.artifactPath = ''; S.artifactPicked = false; lastAnnounce = '';
    S.run = { mode: S.mode, phase: auto ? 'routing' : 'starting', project: null, accessToken: '', error: null, startedAt: Date.now(), pollErrors: 0,
      routed: auto, viaVisitor: viaVisitor(), viaOwner: viaOwner() };
    if (auto) void routeThenStart(gen, { ...brief, expertIds: [] });
    else if (S.mode === 'demo') { startDemo(gen, brief); S.setupOpen = false; } else void startLive(gen, brief);
    renderAll();
    settleFocus();
  }

  /** 누른 순간의 브리프·실행 방식·requestId 로 Jev 경로를 묻고, 맞는 팀이 오면 같은 브리프·같은 requestId 로 바로 시작한다.
   *  늦은 응답·취소·실패·깨진 팀이면 아무것도 만들지 않는다 (직접 고르기·규칙·데모로 바꾸지 않음). 자격 헤더는 프로젝트 만들기와 같다 */
  async function routeThenStart(gen: number, brief: ProjectBrief): Promise<void> {
    const adminToken = S.adminToken.trim();
    const operator = isOperatorToken(S.adminToken);
    const owner = !adminToken && ownerAuthed();
    const v = adminToken || owner ? null : visitor();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    const key = routeKey(brief), max = limits().max, allowed = catalogue().map(e => e.id);
    S.route = { key, result: null }; S.teamOpen = false;
    const fail = (msg: Text) => { S.run!.phase = 'error'; S.run!.error = msg; renderAll(); };
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/route', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({ title: brief.title, objective: brief.objective, context: brief.context, requestId: brief.requestId, ...briefExtras(brief) }) });
    } catch {
      if (gen !== S.gen) return;
      return fail(m => m.routeNetwork);
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const denied = res.status === 401 || res.status === 403;
      const msg: Text = operator && res.status === 401 ? m => m.operatorRejected
        : owner && denied ? m => m.ownerRejected
          : v && denied ? m => m.visitorRejected(REQUEST_PATH)
            : await errorText(res, true);
      if (gen !== S.gen) return;
      if (owner && denied) { S.owner.authenticated = false; void loadOwner(); }
      fail(msg);
      if (v && denied) void loadBootstrap();
      return;
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen) return;
    const route = normalizeRoute(body, allowed, max);
    if (!route) return fail(m => m.routeInvalid);
    S.route = { key, result: route };
    const team: ProjectBrief = { ...brief, expertIds: route.expertIds };
    S.run!.phase = 'starting';
    if (team.mode === 'demo') { startDemo(gen, team); S.setupOpen = false; renderAll(); settleFocus(); return; }
    renderAll();
    void startLive(gen, team, true);
  }

  /** 편집 영역이 접혀 시작 버튼이 사라졌으면 포커스를 프로젝트 제목으로 옮긴다 */
  function settleFocus(): void {
    if (!S.setupOpen && document.activeElement === startBtn) projTitle.focus();
  }

  function startDemo(gen: number, brief: ProjectBrief): void {
    const defs = brief.expertIds.map(id => findDef(id)).filter((e): e is ExpertDefinition => !!e);
    const failIndex = S.failSim ? defs.length - 1 : -1;
    const plan = demoPlan(brief, defs, failIndex, Date.now());
    S.run!.project = plan.project; S.run!.phase = 'running';
    for (const step of plan.steps) {
      timers.push(setTimeout(() => {
        if (gen !== S.gen || !S.run?.project || S.run.phase !== 'running') return;
        S.run.project = applyStep(S.run.project, step, Date.now());
        if (TERMINAL_PROJECT.includes(S.run.project.status)) { S.run.phase = 'done'; timers = []; }
        renderAll();
      }, step.at) as unknown as number);
    }
  }

  /** 상태별 안내 + 서버가 보낸 {error} 원문. 그릴 때의 언어로 바뀐다 */
  async function errorText(res: Response, route = false, read?: { body: unknown }): Promise<Text> {
    let server = '';
    try { const j = read ? read.body : await res.json(); if (isObj(j)) server = str(j.error, 200); } catch { /* 본문 없음 */ }
    const s = res.status;
    // Jev 경로: 422 맞는 역할 없음 · 503 설정·공급자 실패 · 409 같은 requestId/브리프 충돌 또는 진행 중
    const base: Text = route && s === 422 ? m => m.routeNone : route && s === 503 ? m => m.routeUnavailable : route && s === 409 ? m => m.routeConflict
      : s === 401 || s === 403 ? m => m.http401 : s === 404 ? m => m.http404 : s === 409 ? m => m.http409
      : s === 413 ? m => m.http413 : s === 429 ? m => m.http429 : s === 503 ? m => m.http503 : m => m.httpOther(s);
    return server ? m => m.withServer(base(m), server) : base;
  }

  /** routed: Jev 가 고른 팀. 서버가 같은 requestId 의 경로 기록으로 행위자·브리프·한도를 확인하고 역할을 정하므로 routing:'jev' 만 더한다 */
  /** frozen: 준비한 계획의 본문 문자열. 주면 바꾸지 않고 그대로 보낸다 */
  async function startLive(gen: number, brief: ProjectBrief, routed = false, frozen?: string): Promise<void> {
    const operator = isOperatorToken(S.adminToken);
    // 토큰을 넣었으면 그 헤더만 쓴다 (거부돼도 쿠키로 넘어가지 않는다). 없으면 헤더 없이 same-origin 쿠키(소유자 → 방문자)로 요청한다.
    // 빈 x-admin-token 도 서버는 명시한 토큰으로 보므로 아예 넣지 않는다. 권한 판단은 서버가 한다
    const adminToken = S.adminToken.trim();
    const owner = !adminToken && ownerAuthed();
    const v = adminToken || owner ? null : visitor();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    const payload = routed
      ? { title: brief.title, objective: brief.objective, context: brief.context, requestId: brief.requestId, mode: brief.mode, expertIds: brief.expertIds, ...briefExtras(brief), routing: 'jev' }
      : brief;
    let res: Response;
    try {
      res = await fetch('/api/cloudbite/projects', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers, body: frozen ?? JSON.stringify(payload) });
    } catch {
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = m => m.networkCreate; renderAll(); return;
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const denied = res.status === 401 || res.status === 403;
      const msg: Text = operator && res.status === 401 ? m => m.operatorRejected
        : owner && denied ? m => m.ownerRejected
          : v && denied ? m => m.visitorRejected(REQUEST_PATH)
            : await errorText(res);
      if (gen !== S.gen) return;
      S.run!.phase = 'error'; S.run!.error = msg;
      // 소유자 로그인이 거부되면 로그인 상태를 내리고 서버에 다시 묻는다 (자동 데모·재시도 없음)
      if (owner && denied) { S.owner.authenticated = false; void loadOwner(); }
      renderAll();
      if (v) void loadBootstrap(); // 서버가 아는 지금 방문자 상태로 다시 그린다 (자동 데모·재시도 없음)
      return;
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ }
    if (gen !== S.gen) return;
    const project = isObj(body) ? normalizeProject(body.project) : null;
    const token = isObj(body) ? str(body.accessToken, 2000) : '';
    if (!project || !token) { S.run!.phase = 'error'; S.run!.error = m => m.invalidResponse; renderAll(); return; }
    S.run!.project = project; S.run!.accessToken = token; S.setupOpen = false; // 실제로 시작됐으니 편집 영역을 접는다
    if (frozen) { S.plan = null; S.planReq = null; S.planStale = false; if (S.followUp) { S.followUp = null; fuSummaryIn.value = ''; } } // 계획을 썼다: 다음 실행은 새 계획·새 requestId
    if (v) v.usedProjects = Math.min(v.maxProjects, v.usedProjects + 1); // 서버가 센 사용량을 화면에도 반영한다
    S.run!.phase = TERMINAL_PROJECT.includes(project.status) ? 'done' : 'running';
    if (S.run!.phase === 'running') schedulePoll(gen, 1200);
    renderAll();
    settleFocus();
    if (S.run!.phase === 'done' && v) refreshAccess(true);
  }

  function schedulePoll(gen: number, ms: number): void {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void poll(gen); }, ms) as unknown as number;
  }

  async function poll(gen: number): Promise<void> {
    const run = S.run;
    if (gen !== S.gen || !run?.project || run.phase !== 'running') return;
    let res: Response;
    try {
      res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(run.project.id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${run.accessToken}` } });
    } catch {
      if (gen !== S.gen) return;
      return pollFailed(gen, m => m.networkLost);
    }
    if (gen !== S.gen) return;
    if (!res.ok) {
      const msg = await errorText(res);
      if (gen !== S.gen) return;
      if (res.status === 401 || res.status === 403 || res.status === 404) { run.phase = 'error'; run.error = msg; renderAll(); return; }
      return pollFailed(gen, msg);
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { /* 형식 오류 */ }
    if (gen !== S.gen) return;
    const p = normalizeProject(body);
    if (!p || p.id !== run.project.id) return pollFailed(gen, m => m.invalidResponse);
    run.pollErrors = 0; run.error = null;
    if (p.updatedAt >= run.project.updatedAt) run.project = p; // 늦게 도착한 옛 상태는 버린다
    if (TERMINAL_PROJECT.includes(run.project.status)) run.phase = 'done'; else schedulePoll(gen, 2000);
    renderAll();
    if (run.phase === 'done' && run.viaVisitor) refreshAccess(true);
  }

  function pollFailed(gen: number, msg: Text): void {
    const run = S.run!;
    const n = ++run.pollErrors;
    if (n >= 4) { run.phase = 'error'; run.error = m => m.pollStopped(msg(m)); renderAll(); return; } // Check status again 은 renderControls 가 그린다
    run.error = m => m.pollRetry(msg(m), n);
    renderControls(); renderProgress();
    schedulePoll(gen, 1500 * 2 ** n);
  }

  async function cancelRun(): Promise<void> {
    // 계획 준비 중이면 늦게 온 경로·미리보기를 버린다 (아무것도 만들지 않았다)
    if (S.plan?.phase === 'preparing') {
      planGen++; S.plan = { ...S.plan, phase: 'error', error: S.plan.routed && !S.route?.result ? m => m.routeCancelled : m => m.planCancelled };
      renderAll(); return;
    }
    const run = S.run;
    if (!run || !active() || run.phase === 'cancelling' || run.phase === 'starting') return;
    const gen = ++S.gen; // 진행 중이던 타이머·조회 응답은 이제 전부 무시된다
    clearTimers();
    // Jev 가 고르는 중이면 늦게 온 팀으로 아무것도 만들지 않는다 (서버 경로는 할당량·샌드박스를 쓰지 않는다)
    if (run.phase === 'routing') { run.phase = 'error'; run.error = m => m.routeCancelled; renderAll(); return; }
    if (run.mode === 'demo') {
      if (run.project) run.project = cancelProject(run.project, Date.now());
      run.phase = 'done'; renderAll(); return;
    }
    run.phase = 'cancelling'; run.error = null; renderAll();
    const id = run.project?.id;
    if (!id) { run.phase = 'done'; renderAll(); return; }
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { authorization: `Bearer ${run.accessToken}` } });
      if (gen !== S.gen) return;
      if (!res.ok) { const msg = await errorText(res); if (gen !== S.gen) return; run.phase = 'error'; run.error = m => m.stopFailed(msg(m)); renderAll(); return; }
      let body: unknown = null;
      try { body = await res.json(); } catch { /* 형식 오류 */ }
      if (gen !== S.gen) return;
      const p = normalizeProject(isObj(body) && isObj(body.project) ? body.project : body);
      if (p && p.id === id) run.project = p;
      else if (run.project) run.project = { ...run.project, status: 'cancelled' };
      run.phase = 'done';
    } catch {
      if (gen !== S.gen) return;
      run.phase = 'error'; run.error = m => m.stopNetwork;
    }
    renderAll();
  }

  async function fetchArtifact(projectId: string, expertId: string, path: string, key: string): Promise<void> {
    const gen = S.gen, token = S.run?.accessToken ?? '';
    S.artifactCache.set(key, { state: 'loading' });
    try {
      const res = await fetch(`/api/cloudbite/projects/${encodeURIComponent(projectId)}/artifact?expert=${encodeURIComponent(expertId)}&path=${encodeURIComponent(path)}`,
        { credentials: 'same-origin', cache: 'no-store', headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const msg = await errorText(res);
        if (gen !== S.gen) return;
        S.artifactCache.set(key, { state: 'error', text: msg });
      } else {
        // 서버는 {path, label, bytes, content} JSON 봉투를 돌려준다. 봉투를 글자로 보이지 않고 내용만 꺼낸다
        let body: unknown;
        try { body = await res.json(); } catch { body = undefined; }
        if (gen !== S.gen) return;
        const content = artifactContent(body, path);
        S.artifactCache.set(key, content === null ? { state: 'error', text: m => m.fileUnexpected } : { state: 'ok', text: content });
      }
    } catch {
      if (gen !== S.gen) return;
      S.artifactCache.set(key, { state: 'error', text: m => m.fileNetwork });
    }
    keepFocus(renderWork);
  }

  function download(kind: 'json' | 'md'): void {
    const p = S.run?.project;
    if (!p) return;
    const demo = S.run!.mode === 'demo';
    const text = kind === 'json'
      ? JSON.stringify({ kind: demo ? 'cloudbite-browser-demo' : 'cloudbite-live', note: demo ? M.exportDemoNote : M.exportLiveNote, project: p, aggregate: aggregate(p, M) }, null, 2)
      : markdownReport(p, demo, M);
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'json' ? 'application/json' : 'text/markdown' }));
    const safe = p.brief.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'cloudbite';
    const a = h('a', { href: url, download: `${safe}${demo ? '-demo' : ''}.${kind === 'json' ? 'json' : 'md'}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadBootstrap(): Promise<void> {
    S.boot = { status: 'loading', data: null, error: null }; renderControls();
    let reached = false;
    try {
      const res = await fetch('/api/cloudbite/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
      reached = true;
      S.boot = res.ok ? { status: 'ready', data: normalizeBootstrap(await res.json()), error: null } : { status: 'error', data: null, error: await errorText(res) };
    } catch {
      S.boot = { status: 'error', data: null, error: reached ? m => m.catalogueInvalid : m => m.networkGeneric };
    }
    const intro = visitorIntro();
    // 실행 중인 프로젝트는 그대로 둔다. 선택만 지금 카탈로그에 있는 역할로 맞추고, 아직 시작 전이면 기본 선택을 다시 잡는다
    if (!S.run) S.selected.clear();
    pruneSelection();
    if (!S.selected.size && !intro && (S.mode === 'demo' || link.present || ownerAuthed())) defaultSelection();
    renderAll();
  }

  /** 승인된 방문자를 처음 알아챘을 때 한 번: 실제 실행·프로젝트 설정을 연다. Settings 에서 직접 고른 실행 방식은 바꾸지 않는다.
   *  역할은 방문자가 직접 고르고(기본 선택 없음), 유료 실행·데모는 자동으로 시작하지 않는다. 사용자가 시작한 실행은 건드리지 않는다.
   *  로그인한 소유자는 방문자 한도를 쓰지 않으므로 이 소개를 건너뛴다 */
  function visitorIntro(): boolean {
    if (S.visitorIntro || link.present || S.adminToken.trim() || ownerAuthed() || !visitor() || active()) return false;
    S.visitorIntro = true;
    if (!S.modePicked) S.mode = 'live';
    S.setupOpen = true; S.formErrors = [];
    if (S.mode !== 'live') return false;
    S.selected.clear();
    return true;
  }

  /** 로그인한 소유자를 처음 알아챘을 때 한 번: 실행 전이고 실행 방식을 직접 고르지 않았으면 실제 실행 모드로 연다. 실행은 하지 않는다 */
  function ownerIntro(): void {
    if (S.ownerIntro || !ownerAuthed()) return;
    S.ownerIntro = true;
    if (link.present || S.adminToken.trim() || S.modePicked || S.run || active()) return;
    S.mode = 'live'; S.setupOpen = true;
    pruneSelection();
    if (!S.selected.size && S.boot.status === 'ready') defaultSelection();
  }

  // ── 소유자 세션 (GET /api/cloudbite/owner/session → {authenticated, hasCredentials})
  let ownerSeq = 0, ownerCheckedAt = 0, ownerPending = false;
  /** 서버에 소유자 세션을 묻는다. 응답이 실패하거나 형식이 틀리면 로그인으로 보지 않는다. 늦게 온 옛 응답은 버린다 */
  async function loadOwner(): Promise<void> {
    const seq = ++ownerSeq;
    ownerCheckedAt = Date.now(); ownerPending = true;
    let next: { status: 'ready' | 'error'; authenticated: boolean; hasCredentials: boolean; error: Text | null };
    try {
      const res = await fetch('/api/cloudbite/owner/session', { credentials: 'same-origin', cache: 'no-store' });
      let body: unknown = null;
      if (res.ok) { try { body = await res.json(); } catch { /* 아래에서 형식 오류 */ } }
      const s = res.ok ? normalizeOwnerSession(body) : null;
      next = s ? { status: 'ready', ...s, error: null }
        : { status: 'error', authenticated: false, hasCredentials: false, error: res.ok ? m => m.invalidResponse : m => m.httpOther(res.status) };
    } catch {
      next = { status: 'error', authenticated: false, hasCredentials: false, error: m => m.networkGeneric };
    }
    if (seq !== ownerSeq) return;
    ownerPending = false;
    if (H.owner && next.status === 'ready' && !next.authenticated && !S.adminToken.trim()) {
      H.gen++; H.detailGen++; H.list = null; H.detail = null; H.report = null; H.drafts.clear(); H.own.clear(); H.owner = false; H.busy = false; H.detailBusy = false; H.dirty = true;
    }
    Object.assign(S.owner, next);
    ownerIntro();
    renderAll();
  }
  /** 저절로 다시 읽기는 OWNER_REFRESH_MS 에 한 번, 진행 중이면 건너뛴다 (포커스가 오가도 요청이 쌓이지 않는다) */
  function refreshOwner(force: boolean): void {
    if (!force && (ownerPending || Date.now() - ownerCheckedAt < OWNER_REFRESH_MS)) return;
    void loadOwner();
  }
  /** 서버에 로그아웃(POST {})을 보내고, 화면은 그 뒤 다시 읽은 서버 세션 상태로만 바꾼다 */
  async function ownerSignOut(): Promise<void> {
    if (S.owner.busy) return;
    S.owner.busy = true; S.owner.message = null; renderControls();
    try {
      const res = await fetch('/api/cloudbite/owner/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) S.owner.message = m => m.signOutFailed(m.httpOther(res.status));
    } catch {
      S.owner.message = m => m.signOutFailed(m.networkGeneric);
    }
    S.owner.busy = false;
    await loadOwner();
  }

  // 첫 화면은 예시 브리프와 기본 역할을 채운 편집 영역이다. 데모·실제 실행 모두 사용자가 시작 버튼을 눌러야 시작한다
  paintFull(false);
  applyLang();
  defaultSelection();
  renderAll();
  if (S.view === 'history') void loadHistory();
  const first = loadBootstrap();
  void loadOwner();
  // 탭으로 돌아오면 소유자 세션을 다시 읽는다 (간격 제한)
  document.addEventListener('visibilitychange', () => { if ((document as { visibilityState?: string }).visibilityState !== 'hidden') refreshOwner(false); });
  if (typeof g.addEventListener === 'function') g.addEventListener('focus', () => refreshOwner(false));
  // 이전 실행의 정리 확인을 기다리는 방문자가 페이지를 다시 열었으면 같은 방식으로 잠깐씩 다시 본다
  void first.then(() => { if (!S.run && recheckable() && !accessTimer) accessTimer = setTimeout(() => refreshAccess(true), ACCESS_RECHECK_MS) as unknown as number; });
}

const CloudbiteCore = { normalizeProvenance, provenanceView, provenanceGroups, provenanceLines, normalizeAuthorPlan, normalizeAuthorResponse, normalizeArtifactCoverage, authorResponseAffected, authorResponseEligible, authorResponseLines, artifactLines, normalizeMemo, normalizeSignals, normalizeRound, phaseView, signalRows, signalSummary, memoCoverageLines, roundLines, draftRoundLines, followUpEligible, phaseTwoMarkdown, parseDecision, docProblem, docAccept, docsPayload, docsBytes, parseWorkflow, normalizePreview, normalizePmc, normalizeCrossReview, reviewEligible, projectMarkdown, normalizeBootstrap, normalizePool, normalizeRouting, normalizeRoute, suggestTeam, normalizeProject, normalizeOpinion, aggregate, validateForm, demoPlan, applyStep, cancelProject, statusFromExperts, markdownReport, archetypeOf, operatorFragment, artifactContent, domainLabel, DEMO_EXPERTS,
  pickLang, withLang, normalizeOwnerSession, DICT, ROLE_KO };
const hook = (globalThis as { __cloudbiteTestHook?: (core: typeof CloudbiteCore) => void }).__cloudbiteTestHook;
if (typeof hook === 'function') hook(CloudbiteCore);
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
