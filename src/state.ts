import { makeDemoService } from './lab-demo-state';
import { applyClassroomMaterials } from './lab-classroom-materials';
import { demoSandbox } from './lab-demo-native';
// 모든 상태는 Durable Object 하나(idFromName('main'))에 있다.
// KV 와 달리 강한 일관성이라 "폐기 즉시 무효"가 보장된다.
//
// 저장 키:
//   cred:<id>        등록된 보안 키 (공개키만)
//   prov:<id>        공급자 정의 + 진짜 키 (MASTER_KEY 로 AES-GCM 암호화) + gen(세대). 새로 만들거나 키가 가는 곳·방식·종류가 바뀌면 gen 이 바뀐다
//   provgone:<id>:<gen>  지워진(또는 세대가 바뀐) 서브키 발급형 공급자의 관리 키 암호문 — 그 세대 서브키를 세션 끝에 지우는 데만. 세션이 다 끝나면 알람이 지운다
//   req:<id>         승인 요청 (10분). kind=borrow 는 빌린 PC, kind=admin 은 CLI 관리 로그인
//                    src = 만든 쪽 출처 해시 (Worker 가 cf-connecting-ip 로 만든다, IP 원문 아님). 거절되면 작은 흔적(1분)만 남긴다
//   wch:<purpose>|<challenge>  WebAuthn challenge (의식마다 따로, 1회용, 3분). 응답의 clientDataJSON 에 든 challenge 로 찾는다
//                    (예전 chal:<purpose> 한 칸짜리는 읽지 않고 지운다). src = options 를 받은 출처 해시
//   setup:<sha>      SETUP_TOKEN 하나의 사용 기록 (처음 맞게 쓴 시각, 등록 성공 수). 토큰 원문은 저장하지 않는다
//   (익명 임시 상태 상한은 아래 '익명 임시 상태' 상수 — 출처마다·전체)
//   sess:<id>        승인된 세션. OpenRouter 서브키는 여기에만 있다. gens = 승인 때 본 공급자별 gen (같은 id 로 다시 만든 공급자에는 안 통한다)
//                    manage = Daytona 관리 API 를 따로 허용한 공급자의 gen · limits = 총·분당·동시 호출 상한 · calls·leases = 분당·진행 중 호출
//   mig:grants       gen 도입 이전 공급자·세션에 gen 을 한 번 채워 넣었다는 표시
//   tok:<sha256>     가짜 토큰 해시 → 세션 id. 토큰 원문은 저장하지 않는다
//   admin:<sha256>   관리 세션 (8시간)
//   teacher:<sha256> 강사 보기 전용 세션 (8시간 고정, 기기 16개). 상태 읽기만 — 관리 API 는 admin: 만 받는다 (lab-teacher-service.ts)
//   tpsub:<sha256>   강사 알림 구독 (endpoint 해시). 주인 = 보기 세션 해시·그 고정 만료, endpoint+keys 는 MASTER_KEY 봉인만 (lab-teacher-push-service.ts)
//   tpush:outbox     새로 든 손 알림 일 (32개·자리마다 60초·3번·120초). 손 든 트랜잭션이 같이 쓴다
//   audit            최근 이벤트 100개
//   audit:deny       익명 거절 요약: (출처 해시, 10분 창)마다 횟수 한 줄, 24시간·48줄 상한. IP 원문 없음 (거절이 audit 를 밀어내지 않게)
//
// 금고 (종단 간 암호화 — 서버는 암호문만 본다. 풀고 잠그는 건 전부 브라우저):
//   vault:meta       복구용: 질문 목록, PBKDF2 salt, 복구 답으로 감싼 금고 키, 검증값 해시 (fails 는 예전 전역 기록 — 더 안 씀)
//   vault:rcode      복구 코드(소유자 능력) 해시 + 이 코드로 낸 오답 기록. 코드 원문은 저장하지 않고 발급 응답에 한 번만 나간다
//   vwrap:<credId>   그 보안 키의 PRF 로 감싼 금고 키
//   vitem:<id>       항목 암호문 + 정책(phone|send)
//
// 공부방 실습실 (Daytona):
//   labcreate:<id>   만들기 요청 hash·단계·고정 결과(48h, 최대 128). 실행/불확실 기록은 재시도하지 않는다
//   labcreatecleanup:<lab>:<n>   늦게 확인된 샌드박스 ID 정리. 공급자 세대/주소가 바뀌면 원래 조직에서 수동 정리
//   lab:<id>         수업 하나: 자리마다 가짜 토큰 세션 + Daytona 샌드박스. 끝나는 시각에 알람이 전부 지운다
//   labclassroom:<id>  수업 안내 문서 하나. 모임이 끝난 뒤 7일간 관리자 검토용으로 남긴다. 자리는 끝나는 즉시 거부
//   labclassroom-seat:<id>:<n>  자리 진행과 제출(최대 10개, 각 64KiB). 알람은 검토 기간 뒤에 자리 1..20 키만 지운다
//   seat:<code>      자리 코드(16자) → 수업 id·자리 번호. 자리 초대 링크(/j/<code>)와 자리 호스트 쿠키(__Host-lab_seat)에 들어가는 값
//                    자리마다 label(26자 base32, 코드와 무관한 난수) → 자리 호스트 s-<label>.<LAB_SEAT_DOMAIN>. 예전 수업은 처음 쓸 때 채운다
//   cls:<CODE>       예전 수업 코드. 더 이상 자리를 주지 않는다 (끝낼 때 지우기만)
//   exp:<code>       내 작업 받기 진행 중 (자리마다 하나): 묶는 폴더 id·상태·한 번 쓰는 표 해시·만료. expcd:<code> 마지막 시작 시각 (60초)
//   expq:<id>        묶은 폴더 지우기 대기 (한 번 지우면 없어짐, 실패하면 재시도 횟수)
//   laborg           Daytona 조직 id (한도 조회용, 샌드박스 응답에서 얻음)
//   labcfg           마지막으로 쓴 설정 (게이트웨이 workers.dev 주소, 스냅샷, 모델)
//                    + 나눠 준 공급자·자리당 호출 상한 (share)
//   snips:<labId>    강사가 보낸 코드 목록 (최신 30개), snipv:<labId> 그 버전 — 참가자 막대의 📥 받은 코드
//   scr:<labId>      강사 화면 공유 상태 (SFU 세션·트랙, v) · scrp:<sid> 참가자 받기 세션 → 자리·SFU 세션·remote mid·만료 (강사 화면 공유 절)
//   scrq:<id>        닫을 SFU 트랙 (한 번 닫으면 없어짐)

import { verifyOpenOwnerJwt } from './lab-open-owner';
import { DurableObject } from 'cloudflare:workers';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { canonUpstream, daytonaManagementPath, isDaytona, isOpenRouterUpstream, labShareable, normalizeDef, OPENROUTER_ORIGIN, sameDestination, type ProviderDef } from './providers';
import { dt, DtError, download, exec, EXPORT_LIMITS, exportZipMax, LAB_PORT, materials, packWork, putMaterials, quota, readCapped, spawn, WORK, type Dt, type Sandbox } from './lab';
import { labIsPreset, labResourcesOf, labSnapshotName } from './lab-resources';
import { isSnapPending, LabSnapshotService, SNAP_TIMEOUTS } from './lab-snapshot-service';
import { labCreateInput, labErrorText, labJoinInfo, labJoinName, labReady, labSandboxBody, labSeatSid, labSeatTag, labStarting, type LabRules } from './lab-setup';
import { LabTeacherService, TEACHER_PREFIX, teacherLabView } from './lab-teacher-service';
import { preparationView, seatDiagnostics, emptyDiagnostics, type PreparationView } from './lab-readiness';
import { LabTeacherPushService, PUSH_LEASE, PUSH_OUTBOX, pushDropSeat, pushEnqueue, type PushOutbox } from './lab-teacher-push-service';
import { importVapidKey, sendPush, parsePushSubscription, type VapidKey } from './lab-web-push';
import { LabPreparationService, PREP_TIMEOUT, PREP_UNCERTAIN, prepJobKey, prepOwns, prepUncertain,prepStopKey,type PrepGate, type PrepJob, type PrepRef, type PrepSetup, type PrepSnapshot, type PrepStop } from './lab-preparation-service';
import { EXPORT_COOLDOWN, EXPORT_STREAM_MAX, EXPORT_TICKET_TTL, LabExportService } from './lab-export-service';
import { LabScreenService, SCR_ANSWER_TTL } from './lab-screen-service';
import { LabLiveService } from './lab-live-service';
import { LabLifecycleService } from './lab-lifecycle-service';
import { labTimer, withLabTiming } from './lab-timing';
import { LabCreateService, type CreateSummary } from './lab-create-service';
import { LabTerminalService, terminalCurrentKey, terminalSessionKey, terminalOperationKey, type TerminalRef, type TerminalSession, type TerminalEffect } from './lab-terminal-service';
import { LabControlService, controlKey, controlView, controlEpochMatches, type LabControlEpoch, type LabControlRow } from './lab-control-service';
import { LabPreviewService, previewKey, type LabPreviewRecord, type PreviewContext } from './lab-preview-service';
import { LabTrialService, trialBindingKey, trialReserveKey, type TrialBinding, type TrialReservation, type TrialLab } from './lab-trial-service';
import { trialConfigText, trialTargetText, terminalCaptureCommand, clipTrialOutput } from './lab-trial';
import { LabInterruptService, interruptPreviewKey, type InterruptContext, type InterruptPreviewRecord, type InterruptRef } from './lab-interrupt-service';
import { teachingPaneProbeCommand, teachingPaneInterruptCommand, parseTeachingPane } from './lab-interrupt';
import { LabFileReceiptService, fileReceiptKey, verifiedFileReceiptId, type FileRef } from './lab-file-receipt-service';
import { LabCheckpointService, checkpointOperationKey, type CheckpointContext, type CheckpointOperation, type CheckpointRef } from './lab-checkpoint-service';
import { CLASSROOM_BYTES, CLASSROOM_FILE_NAME, CLASSROOM_WORK, LabClassroomService, classroomProbeCommand, type ClassroomLab, type ClassroomSeatRef } from './lab-classroom-service';
import { CHECKPOINT_LIMITS, checkpointArchive, checkpointContextText, type StoredCheckpoint } from './lab-checkpoint';
import { recoveryGenerationText, recoveryBindingText, recoveryResourceKey, sameRecoveryRef, replacementSeat, replacementSession, repairHealthCommand, type RecoveryAuthority, type RecoveryNativeIntent, type RecoveryNativeRef, type RecoveryNativeResource } from './lab-seat-recovery';
import { LabSeatRecoveryService, recoveryOperationKey, recoveryActiveKey } from './lab-seat-recovery-service';
import { LabAssistantService } from './lab-assistant-service';
import { LabOpenRequestService } from './lab-open-request-service';
import { LabOpenPushService } from './lab-open-push-service';
import { VaultService, type Sealed, type VaultMeta } from './vault-service';

export interface Env {
  LAB_OPEN_ACCESS_TEAM?: string;
  LAB_OPEN_AUDIENCE?: string;
  LAB_OPEN_OWNER_EMAIL?: string;
  STATE: DurableObjectNamespace<State>;
  RP_ID: string;
  ORIGIN: string;
  SETUP_TOKEN?: string;
  MASTER_KEY?: string;      // 32바이트 base64url. 저장된 공급자 키를 암호화한다
  ALLOW_SHORT_TTL?: string; // dev 전용: 만료 테스트용 초단기 TTL 허용
  LAB_DAYTONA_API?: string; // dev 전용: 가짜 Daytona 주소 (테스트)
  LAB_ORIGIN: string;       // 참가자가 여는 실습실 호스트 (https://lab.shinick.dev) — 게이트웨이가 code-server 를 대신 열어 준다
  LAB_GW?: string;          // 샌드박스가 부르는 게이트웨이 workers.dev 주소 (/lab 고급 칸의 기본값)
  REALTIME_APP_ID?: string;    // 강사 화면 공유: Cloudflare Realtime SFU 앱 id (비밀 아님)
  REALTIME_APP_TOKEN?: string; // 강사 화면 공유: SFU 앱 비밀 (Worker secret) — DO 밖으로 안 나간다
  REALTIME_API?: string;       // dev 전용: SFU 주소 바꾸기 (테스트의 가짜 SFU)
  LAB_SEAT_DOMAIN?: string;    // 자리 호스트의 상위 (shinick.dev → s-<label>.shinick.dev). 없으면 참가자 입장·수업 만들기를 막는다 (route 를 연 뒤에만 켠다)
  TEACHER_PUSH_VAPID_JWK?: string; // 강사 손 알림 VAPID 개인키 JWK (Worker secret). 없거나 틀리면 알림 꺼짐 — DO 밖으로 안 나간다 (공개키만 config 로)
  // Cloudbite (wrangler.cloudbite.jsonc 전용). 원래 gw-shinick 공급자 키를 쓰지 않는 독립 설정 — src/cloudbite-config.ts
  CLOUDBITE?: DurableObjectNamespace<import('./cloudbite-project').CloudbiteProject>;
  CLOUDBITE_DAYTONA_API_URL?: string;
  CLOUDBITE_DAYTONA_API_KEY?: string;   // Worker secret
  CLOUDBITE_DAYTONA_SNAPSHOT?: string;
  CLOUDBITE_NOSANA_BASE_URL?: string;   // OpenAI 호환 …/v1
  CLOUDBITE_NOSANA_API_KEY?: string;    // Worker secret
  CLOUDBITE_NOSANA_MODEL?: string;
  CLOUDBITE_GATEWAY_URL?: string;       // 샌드박스가 /p/_cloudbite/worker/ 로 부르는 이 Worker 의 workers.dev 주소
  CLOUDBITE_ALLOW_HTTP?: string;        // dev 전용: http://localhost 주소 허용
}

export interface ClientMeta { ip: string; country: string; city: string; ua: string }

export interface Cred { id: string; publicKey: string; counter: number; label: string; createdAt: number; lastUsed?: number; prf?: boolean }
interface Chal { challenge: string; purpose: string; expiresAt: number; src?: string }
interface SetupUse { firstAt: number; used: number }
interface DenyAgg { w: number; src: string; n: number; kinds: Record<string, number>; last: number } // 익명 거절 요약 한 줄
interface AdminTok { expiresAt: number; createdAt?: number; src?: 'web' | 'cli'; credentialId?: string }
interface StoredProvider extends ProviderDef { iv: string; ct: string; last4: string; updatedAt: number; gen?: string }
type Delivery =
  | { kind: 'borrow'; token: string; sessionId: string; providers: string[]; expiresAt: number; budget: number | null; manage?: string[]; limits?: Limits }
  | { kind: 'admin'; adminToken: string; expiresAt: number }
  | { kind: 'send'; epk: string; iv: string; ct: string };
export interface ApprovalRequest extends ClientMeta {
  id: string; kind: Kind; code: string; pollHash: string;
  pub?: string; // kind=send: 빌린 PC 페이지가 만든 ECDH 공개키. 폰은 이걸로만 암호화한다
  src?: string; // 만든 쪽 출처 해시 (출처마다 상한)
  status: 'pending' | 'approving' | 'approved' | 'delivered' | 'denied';
  createdAt: number; expiresAt: number; delivery?: Delivery;
}
export interface Session extends ClientMeta {
  id: string; tokenHash: string; providers: string[];
  createdAt: number; expiresAt: number; budget: number | null;
  orKey?: string; orKeyHash?: string; orProvider?: string;
  uses: number; lastUsed?: number; revoked?: boolean;
  lastAi?: number; // 조회용 호출(/key·/models)을 뺀 마지막 사용 — 실습실 강사 표의 'AI N분 전'
  lab?: string; counts?: Record<string, number>; // 실습실 자리: 수업 id, 공유 공급자별 호출 수 (수업의 share 로 켜짐·상한 확인)
  gens?: Record<string, string>; // 승인 때의 공급자 gen. 지금 prov:<id> 의 gen 과 같아야 쓴다
  manage?: Record<string, string>; // Daytona 관리 API 를 따로 허용한 공급자 → 그때의 gen (지우고 다시 만들면 안 통한다). 없으면 관리 API 거부
  limits?: Limits;                 // 호출 상한. 없는 예전 세션은 첫 호출 때 기본값(= 최대)을 받는다. 총 호출 수는 uses 로 센다
  calls?: number[];                // 최근 1분 동안 센 호출 시각 (분당 상한)
  leases?: Record<string, Lease>;  // 진행 중인 호출 (동시 상한). 밖으로 안 나간다 — 관리 화면에는 수만
}
interface Limits { total: number; perMinute: number; concurrent: number }
interface Lease { exp: number; p: string; counted: boolean; at: number; prevAi?: number } // exp: 프로세스가 죽어 늘리기·release 가 안 오면 이때 풀린다
interface Reserved { sess: Session; p: StoredProvider; lease: string; target: string } // reserveUse 가 잡은 호출 하나
type Kind = 'borrow' | 'admin' | 'send';
export interface Seat {
  n: number; code: string; sid?: string; sandboxId?: string; error?: string; opened?: number;
  label?: string;                            // 자리 호스트 이름 (코드와 무관한 130비트 난수). 호스트 이름만으로는 권한이 없다 — 쿠키 코드의 label 과 같아야
  who?: string;                              // 수업 링크로 들어와 이 자리를 받은 사람 이름
  pv?: { origin: string; token: string };    // Daytona 미리보기 주소·토큰 — 게이트웨이만 쓴다, 밖으로 안 나감
  setup?: { state: 'running' | 'ok' | 'error'; at: number; note: string }; // 수업 자료 넣기
  hand?: number;                             // 손 든 시각 (참가자 ✋, 강사가 내림)
  generation?: string;                       // 명시적 자리 교체마다 새 UUID. 기존 자리는 코드·샌드박스 신원으로 구분한다.
  openRequestId?: string;                    // 승인한 추가 자리의 중복 생성·결과 확인용. 공개 자리 정보에는 싣지 않는다.
}
export interface Lab {
  id: string; name: string; createdAt: number; expiresAt: number; budget: number;
  cpu: number; memory: number; disk: number; snapshot: string; model: string; gw: string;
  seats: Seat[]; endRetry?: number; cls?: string; materials?: string;
  teacherDemoFor?: string; // Private independent 모임지기 workspace, never a participant invitation.
  clip?: Clip; // 클립보드 방향별 허용 (없으면 둘 다 허용)
  share?: Record<string, LabShare>; // 이 수업에 나눠 준 공급자 (만들 때 고름). 끄거나 상한에 닿으면 게이트웨이가 바로 거부
}
interface LabShare { label: string; on: boolean; cap: number } // cap: 자리당 호출 수 상한
interface Clip { in: boolean; out: boolean } // in: 내 PC → 실습실 붙여넣기, out: 실습실 → 내 PC 복사
interface LabCfg { gw: string; snapshot: string; model: string; clip?: Clip; share?: Record<string, number> }
interface LabErr { at: number; status: number; msg: string; n: number }
export interface LabInput { requestId?: unknown; name?: unknown; seats?: unknown; hours?: unknown; budget?: unknown; cpu?: unknown; memory?: unknown; disk?: unknown; snapshot?: unknown; model?: unknown; gw?: unknown; materials?: unknown; clipIn?: unknown; clipOut?: unknown; share?: unknown; parentLabId?: unknown; openRequestId?: unknown; parentVersion?: unknown }
interface LabCreatePrepared { demoFor?: string; demoExpiresAt?: number; v: Exclude<ReturnType<typeof labCreateInput>, { error: string }>; shared: { share: Record<string, LabShare>; defs: StoredProvider[] }; c: Dt; or: StoredProvider; clip: Clip; daytonaStamp: string; parentId?: string; parentFingerprint?: string; openRequestId?: string }
export interface Choice { providers: string[]; ttlHours: number; budget: number; manage?: unknown; limits?: unknown }
export type Fail = { error: string; status: number };

const REQ_TTL = 10 * 60e3;
const CHAL_TTL = 3 * 60e3;
const ADMIN_TTL = 8 * 3600e3;
const TTL_CHOICES = [1, 3, 8];
const BUDGET_CHOICES = [1, 5, 10];
const REG_FRESH = 3 * 60e3;   // /admin 에서 새 키 등록: 로그인(탭) 후 이 시간 안에만
// ── 익명 임시 상태 상한. 출처 = Worker 가 cf-connecting-ip(IPv6 는 /64)로 만든 키 붙은 해시 — 요청 본문 값은 안 믿는다 ──
const REQ_PER_SOURCE = 8;     // 출처 하나가 동시에 잡을 수 있는 익명 요청 기록 (대기 중 + 거절 흔적)
const REQ_GLOBAL = 32;        // 전체 익명 요청 기록 (대기 중 + 거절 흔적). 승인된 기록은 키 탭이 있어야 생겨서 따로 센다
const DENY_TTL = 60e3;        // 거절 흔적: 빌린 PC 폴링(2초)이 '거절됨'을 볼 만큼만, 작게
const CHAL_PER_SOURCE = 16;   // 출처 하나가 동시에 잡을 수 있는 challenge (모든 purpose 합) — 한 출처가 purpose 의 CHAL_MAX 를 다 못 채운다
const CHAL_GLOBAL = 256;      // 전체 challenge (모든 purpose 합) — 저장소 상한
const SETUP_WINDOW = 30 * 60e3; // SETUP_TOKEN: 처음 맞게 쓴 뒤 이 시간 안에만
const SETUP_MAX_REGS = 2;     // SETUP_TOKEN 하나로 등록 성공 횟수 (Nano + NFC)
const DENY_WINDOW = 10 * 60e3; // 익명 거절 요약: 출처마다 이 창에 한 줄 (audit:deny)
const DENY_AGG_MAX = 48;      // 거절 요약 줄 수 상한 (마지막 한 줄은 넘친 출처를 합친 '*')
const DENY_SHOW = 5;          // 관리 화면 '최근 이벤트'에 섞는 거절 요약 줄 수
const SRC_RE = /^[\w-]{8,64}$/;
const LAB_HOURS = [1, 2, 3, 4, 6, 8];
const LAB_BUDGETS = [1, 2, 3, 5, 10];
const LAB_MAX_SEATS = 20;
const LAB_DEFAULT: LabCfg = { gw: '', snapshot: 'gw-lab-v5', model: 'deepseek/deepseek-v4.1-flash' };
const LAB_OLD_SNAPSHOTS = ['gw-lab-v1', 'gw-lab-v2', 'gw-lab-v3', 'gw-lab-v4']; // 저장된 설정에 남아 있으면 새 기본값으로
const LAB_ERR_RECENT = 10 * 60e3;          // 강사 표에 보일 '최근 오류' 범위
const USAGE_TTL = 30e3;                    // 자리별 OpenRouter 사용액 캐시
const CLIP_OPEN: Clip = { in: true, out: true };
const LAB_SHARE_CAP = 10000;                // 공유 공급자 자리당 호출 수 상한의 최대 (최소 1 — 막으려면 끄기)
const LAB_SHARE_MAX = 10;
// 세션(승인·실습실 자리)마다 호출 상한. 기본값 = 넘을 수 없는 최대. 승인하는 사람은 각 값을 1 이상으로 낮출 수만 있다
const LIMIT_MAX: Limits = { total: 10000, perMinute: 300, concurrent: 10 };
const LIMIT_KEYS = Object.keys(LIMIT_MAX) as (keyof Limits)[];
const RATE_WINDOW = 60e3;
// 진행 중 호출 자리(lease)의 수명. 프록시가 키를 쓰는 동안(fetch·응답 본문) 수명의 1/3 마다 renewUse 로 늘린다 —
// 끝·끊김·오류에 바로 풀고, 늘리기가 멈추면(Worker 가 죽음) 이만큼 뒤 자리가 아니게 된다
const LEASE_TTL = 15 * 60e3;
/** 승인 입력의 limits: 없으면 기본값. 있으면 { total?, perMinute?, concurrent? } 만, 각각 진짜 정수 1..최대 (문자열·불리언·배열·null 거부) */
function parseLimits(x: unknown): Limits | string {
  if (x === undefined) return { ...LIMIT_MAX };
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'limits 형식이 올바르지 않습니다.';
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => !LIMIT_KEYS.includes(k as keyof Limits))) return 'limits 에 모르는 항목이 있습니다.';
  const out = { ...LIMIT_MAX };
  for (const k of LIMIT_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > LIMIT_MAX[k]) return `${k} 는 1~${LIMIT_MAX[k]} 정수`;
    out[k] = v;
  }
  return out;
}
const liveLeases = (sess: Session) => Object.entries(sess.leases ?? {}).filter(([, l]) => l.exp > now());
// 공유 공급자 env 이름이 겹치면 안 되는 기본 env (labCreate 의 샌드박스 env)
const LAB_ENV_RESERVED = /^(OPENROUTER_API_KEY|OPENROUTER_BASE_URL|ANTHROPIC_\w+|LAB_\w+|TZ|CLAUDE_CODE_\w+|DISABLE_AUTOUPDATER|PATH|HOME)$/;
const clipText = (c: Clip) => `PC→실습실 ${c.in ? '허용' : '막음'} · 실습실→PC ${c.out ? '허용' : '막음'}`;              // 자료 넣기가 이보다 오래 '진행 중'이면 다시 시도
const CODE_ALPHABET ='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32자, 헷갈리는 0/O/1/I 제외

const now = () => Date.now();
const rand = (n: number) => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(n)));
const fail = (status: number, error: string): Fail => ({ status, error });
export const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;
const publicDef = ({ iv, ct, gen, ...d }: StoredProvider) => d;
// 세션 승인은 공급자 id 가 아니라 그 세대(gen)에 묶인다 — 지우고 같은 id 로 다시 만들면 예전 토큰은 안 통한다
const gensOf = (defs: StoredProvider[]) => Object.fromEntries(defs.map((d) => [d.id, d.gen ?? '']));
const grantOk = (sess: Session, p: StoredProvider) => !!p.gen && sess.gens?.[p.id] === p.gen;

// reserveUse 의 확인 단계 — 동기 검사와 원래 자리의 세션·공급자 고치기만. 저장소 읽기·쓰기는 reserveUse 에 남는다
function checkedProxySession(sess: Session, provider: string): Fail | undefined {
  if (sess.revoked || sess.expiresAt <= now()) return fail(401, 'invalid or expired token');
  if (!sess.providers.includes(provider)) return fail(403, `token not scoped for ${provider}`);
  return undefined;
}

/** 나갈 주소 또는 거절. p.upstream 은 정규화한 값으로 그 자리에서 고친다 (resolveToken 이 이 p 를 그대로 쓴다) */
function checkedProxyProvider(sess: Session, p: StoredProvider, provider: string, path: string, search: string, daytonaApi: boolean): Fail | string {
  // 저장된 기록도 다시 본다: upstream 이 올바른 절대 주소가 아니거나, 서브키 발급형인데 openrouter.ai 가 아니면 키를 내보내지 않는다
  const up = canonUpstream(p.upstream, daytonaApi);
  if (!up) return fail(503, 'provider key unavailable');
  p.upstream = up;
  if (p.kind === 'openrouter-mint' && (!isOpenRouterUpstream(p.upstream) || sess.orProvider !== provider || !sess.orKey)) return fail(503, 'provider key unavailable');
  // 나갈 주소도 예약 전에 정한다 — 틀린 경로는 세지 않고 400 (upstream 에 아무것도 안 넘겼으니 돌려줄 것도 없다)
  const target = proxyTarget(up, path, search);
  if (!target) return fail(400, 'bad path');
  // Daytona 조직·계정 관리 API(organizations·api-keys·users)는 승인 때 따로 허용한 세션만 — 그 공급자 세대(gen)에 묶인다.
  // 허용 표시가 없는 예전 세션은 거부. 키를 풀거나 예약하기 전에
  if (isDaytona(p) && daytonaManagementPath(up, target) && !(p.gen && sess.manage?.[p.id] === p.gen))
    return fail(403, 'Daytona organization/account management API not approved for this token');
  return target;
}

/** 실습실 자리의 공유 공급자: 수업에서 켜져 있고 자리당 상한 안일 때만. 통과하면 sess.counts 를 하나 올린다. 참가자가 읽는 메시지라 한국어 */
function checkedLabShare(lab: Lab | undefined, sess: Session, p: StoredProvider, provider: string): Fail | undefined {
  const sh = lab?.share?.[provider];
  if (!lab || lab.endRetry || lab.expiresAt <= now()) return fail(401, '수업이 끝났습니다.');
  if (!sh || !labShareable(p)) return fail(403, `이 수업에서는 ${p.label} 키를 쓸 수 없습니다.`);
  if (!sh.on) return fail(403, `강사가 ${sh.label} 키를 잠시 껐습니다. 강사에게 물어보세요.`);
  const used = sess.counts?.[provider] ?? 0;
  if (used >= sh.cap) return fail(429, `이 자리의 ${sh.label} 호출 상한(${sh.cap}회)을 다 썼습니다. 강사에게 알려주세요.`);
  sess.counts = { ...sess.counts, [provider]: used + 1 };
  return undefined;
}

/** 세션 호출 상한: 총(uses — 예전 호출도 든다)·최근 1분·동시. 상한 없는 예전 세션은 여기서 기본값을 받는다. 통과하면 살아 있는 lease 목록 */
function checkedSessionQuota(sess: Session, t: number): Fail | [string, Lease][] {
  const lim = sess.limits ?? { ...LIMIT_MAX };
  sess.limits = lim;
  sess.calls = (sess.calls ?? []).filter((x) => x > t - RATE_WINDOW);
  const live = liveLeases(sess);
  if ((sess.uses ?? 0) >= lim.total) return fail(429, `token call limit reached (${lim.total} total)`);
  if (sess.calls.length >= lim.perMinute) return fail(429, `token rate limit reached (${lim.perMinute}/min)`);
  if (live.length >= lim.concurrent) return fail(429, `token concurrency limit reached (${lim.concurrent} in flight)`);
  return live;
}

const CHAL_MAX = 64; // purpose 하나에 동시에 살아 있는 challenge 수 상한 (넘치면 새 의식만 막는다 — 남의 의식을 밀어내지 않는다)
const chalKey = (purpose: string, challenge: string) => `wch:${purpose}|${challenge}`;
/** 응답의 clientDataJSON 에 든 challenge. 믿지 않는 값이라 저장소에서 찾는 열쇠로만 쓰고, 검증은 저장된 값으로 한다 */
function clientChallenge(resp: unknown): string | null {
  try {
    const cdj = (resp as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
    if (typeof cdj !== 'string' || cdj.length > 4096) return null;
    const c = JSON.parse(new TextDecoder().decode(isoBase64URL.toBuffer(cdj)))?.challenge;
    return typeof c === 'string' && /^[\w-]{16,128}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

export async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return isoBase64URL.fromBuffer(new Uint8Array(d));
}
function shortCode() {
  // 256 은 32 의 배수라 치우침이 없다
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_ALPHABET[b % 32]).join('');
}
const srcOf = (src: unknown) => (typeof src === 'string' && SRC_RE.test(src) ? src : 'unknown');
/** 요청 기록 중 익명으로 잡을 수 있는 것 (승인·전달된 기록은 키 탭이 있어야 생긴다) */
const PROXY_PATH_MAX = 8192; // 프록시 경로 + 쿼리 길이 상한
/**
 * 경로 조각 하나를 upstream 이 몇 번 풀어도 '/'·'\' 가 생기거나 '.'·'..' 가 되면 거부한다 (%2F·%5c·%252F·%25%32%46 …).
 * URL 파서는 %2F 를 풀지 않으므로 아래 경로 확인을 통과하지만, upstream(또는 그 앞 프록시)이 풀면 base 경로 밖으로 나간다.
 * 바이트 단위로 %XX 를 푼다 (잘못된 UTF-8 도 그대로). 4번 풀어도 계속 바뀌면 거부. 쿼리는 경로 계층을 못 바꾸니 보지 않는다
 */
function pathSegmentsSafe(path: string) {
  for (const seg of path.split('/')) {
    let s = seg;
    for (let i = 0; ; i++) {
      if (s.includes('/') || s.includes('\\')) return false;
      const next = s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      if (next === s) break;
      if (i >= 4) return false;
      s = next;
    }
    if (s !== seg && (s === '.' || s === '..')) return false;
  }
  return true;
}
/** upstream 뒤에 붙인 주소. 같은 출처이고 upstream 경로 아래여야 한다 — 아니면 null (프록시는 예약 전에 400) */
function proxyTarget(up: string, path: string, search: string) {
  if (typeof path !== 'string' || typeof search !== 'string' || path.length + search.length > PROXY_PATH_MAX) return null;
  if (search && !search.startsWith('?')) return null;
  if (!pathSegmentsSafe(path)) return null;
  let t: URL, base: URL;
  try { t = new URL(`${up}/${path}${search}`); base = new URL(up); } catch { return null; }
  if (t.origin !== base.origin) return null;
  const root = base.pathname.replace(/\/+$/, '');
  if (root && t.pathname !== root && !t.pathname.startsWith(`${root}/`)) return null;
  return t.href;
}
const anonHeld = (r: ApprovalRequest) => r.status === 'pending' || r.status === 'approving' || r.status === 'denied';

// ── 참가자 상태 (Teams 비슷하게, 강사 /lab 표) ──
// 막대(/__lab/me)가 30초마다 보내는 신호: 마지막 키보드·마우스 입력 후 경과 초, 탭 보임·포커스, 탭 id, 강사 "들어가 보기" 탭 여부.
// DO 메모리에만 둔다 (스토리지 쓰기 없음). DO 가 다시 뜨면 다음 신호까지 '입장 전'으로 보인다.
//   활동 중: 신호 살아 있고 입력 5분 이내 · 자리 비움: 신호는 있는데 입력 5분 넘게 없음 (탭 가려짐과 무관)
//   오프라인: 3분 넘게 신호 없음 (크롬은 숨은 탭 타이머를 1분 간격까지 늦춘다) · 입장 전: 신호가 한 번도 없음
const PRESENCE = { away: 5 * 60, offline: 3 * 60 };     // 초
const PRESENCE_DEV = { away: 5 * 60, offline: 6 };      // dev(ALLOW_SHORT_TTL): 오프라인 판정을 테스트가 기다릴 수 있게
const PRESENCE_MAX_TABS = 8;                             // 자리 하나에 기억할 탭 수 (오래된 것부터 버림)
interface PresTab { at: number; idle: number; vis: boolean; focus: boolean; watch: boolean }
interface SeatPresence { state: 'active' | 'away' | 'offline' | 'none'; idleSec?: number; lastSeen?: number; tabs?: number; watch?: number }
interface Snip { id: string; at: number; title?: string; text: string } // 강사가 보낸 코드 (아래 '받은 코드' 절)

const LABEL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
/** 자리 호스트 이름: 26자 base32 = 130비트. 자리 코드와 따로 뽑는다 */
export function newSeatLabel() {
  const b = crypto.getRandomValues(new Uint8Array(26));
  return [...b].map((x) => LABEL_ALPHABET[x & 31]).join('');
}
export const SEAT_LABEL = /^[a-z2-7]{26}$/;

/** 승인 선택 검사 (탭 전, 저장소 없이). 문자열이면 400 사유 */
function approvalPlan(choice: Choice, ids: string[], defs: StoredProvider[], allowShort: boolean) {
  if (!ids.length || defs.length !== ids.length || defs.length !== choice.providers.length) return '공급자를 확인하세요.';
  const shortTtl = allowShort && choice.ttlHours > 0 && choice.ttlHours < 0.01;
  if (!TTL_CHOICES.includes(choice.ttlHours) && !shortTtl) return 'ttl';
  const minted = defs.filter((d) => d.kind === 'openrouter-mint');
  if (minted.length > 1) return '서브키 발급형 공급자는 하나만 고를 수 있습니다.';
  const budget = minted.length ? choice.budget : null;
  if (budget !== null && !BUDGET_CHOICES.includes(budget)) return 'budget';
  // 새 항목도 탭(의식 소비) 전에 엄격히 본다. 빠지면 관리 API 없음·기본 상한 (예전 클라이언트 그대로)
  if (choice.manage !== undefined && typeof choice.manage !== 'boolean') return 'manage 는 true/false';
  const dts = defs.filter(isDaytona);
  if (choice.manage === true && !dts.length) return 'Daytona 관리 API 허용은 Daytona 공급자를 고를 때만';
  const limits = parseLimits(choice.limits);
  if (typeof limits === 'string') return limits;
  const manage = choice.manage === true ? gensOf(dts) : undefined;
  return { mint: minted[0] as StoredProvider | undefined, budget, limits, manage };
}

/** 공급자 추가·수정 입력 검사 (저장소·외부 호출 없이). 문자열이면 400 사유 */
function upsertDraft(input: Record<string, unknown>, id: string, existing: StoredProvider | undefined, daytona: boolean) {
  const def = normalizeDef({ ...(existing ? publicDef(existing) : {}), ...input, id }, daytona);
  if (typeof def === 'string') return def;
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (!value && !existing) return '새 공급자는 키 값이 필요합니다.';
  // 저장된 키가 나가는 곳(upstream)·방식(auth)·종류(kind)는 키 값을 다시 넣을 때만 바꿀 수 있다. 이름·메모·고정 헤더 등은 그대로 고친다
  const same = !!existing && sameDestination(def, { ...existing, upstream: canonUpstream(existing.upstream, daytona) ?? existing.upstream });
  if (existing && !value && !same) return '주소(upstream)·인증 방식·종류를 바꾸려면 키 값을 다시 넣으세요.';
  return { def, value, same };
}

// LangSmith 서비스 키: workspace 를 X-Tenant-Id 로 골라야 데이터 API(trace 등)가 열린다 — 하나뿐이면 알아서 채운다
const wantsTenant = (value: string, def: ProviderDef) =>
  !!value && /^https:\/\/(eu\.)?api\.smith\.langchain\.com$/.test(def.upstream) && !def.headers?.['x-tenant-id'];

/** workspace 목록으로 고정 헤더를 채우거나 경고 문구를 돌려준다 */
function applyWorkspaces(def: ProviderDef, ws: { id: string }[]) {
  if (ws.length === 1) def.headers = { ...def.headers, 'x-tenant-id': ws[0].id };
  else if (ws.length > 1) return `LangSmith workspace 가 ${ws.length}개입니다 — /admin 에서 이 공급자의 고정 헤더에 X-Tenant-Id 를 넣으세요.`;
  return undefined;
}

/** 감사 기록에서 공급자마다 마지막 add·update·delete 시각. 시각이 이상하면 Infinity (증명 실패 쪽) */
function touchedProviders(log: { t: number; event: string; detail?: string }[]) {
  const touched = new Map<string, number>();
  for (const e of log) {
    if (e.event !== 'provider-add' && e.event !== 'provider-update' && e.event !== 'provider-delete') continue;
    const id = String(e.detail ?? '').split(' ')[0];
    touched.set(id, Math.max(touched.get(id) ?? 0, Number(e.t) || Infinity));
  }
  return touched;
}

/** gen 이전 세션: 공급자 기록이 세션보다 먼저 있었다고 증명되는 것만 지금 gen 으로 */
function legacyGens(sess: Session, provs: Map<string, StoredProvider>, touched: Map<string, number>) {
  const gens: Record<string, string> = {};
  for (const id of sess.providers ?? []) {
    const p = provs.get(`prov:${id}`);
    const before = Number.isFinite(p?.updatedAt) && Number.isFinite(sess.createdAt) && p!.updatedAt < sess.createdAt;
    if (p?.gen && before && (touched.get(id) ?? 0) <= sess.createdAt) gens[id] = p.gen;
  }
  return gens;
}

export class State extends DurableObject<Env> {
  private get s() { return this.ctx.storage; }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.migrateGrants());
  }

  /**
   * gen 도입 전 기록을 한 번만 옮긴다: 공급자마다 gen 을 주고, 세션에는 지금 그 공급자 기록이 세션보다 먼저 있었다고 증명될 때만 gen 을 적는다.
   * 증명 = 기록의 updatedAt 이 세션 createdAt 보다 앞선다 (예전 코드도 공급자를 쓸 때마다 updatedAt 을 now() 로 적었다 — 지우고
   * 다시 만들거나 키·주소를 바꾸면 반드시 세션 뒤가 된다). 감사 기록은 100개만 남아 오래된 add·delete 가 빠질 수 있으니 증명으로 쓰지 않고,
   * 남아 있는 세션 뒤 provider-add·update·delete 가 있으면 추가로 거부하는 데만 쓴다. 증명이 안 되면 옮기지 않는다 (다시 승인)
   */
  private async migrateGrants() {
    if (await this.s.get('mig:grants')) return;
    const provs = await this.s.list<StoredProvider>({ prefix: 'prov:' });
    const log = (await this.s.get<{ t: number; event: string; detail?: string }[]>('audit')) ?? [];
    const touched = touchedProviders(log);
    const put = new Map<string, unknown>();
    for (const [k, p] of provs) if (!p.gen) { p.gen = rand(9); put.set(k, p); }
    for (const [k, sess] of await this.s.list<Session>({ prefix: 'sess:' })) {
      if (sess.gens) continue;
      sess.gens = legacyGens(sess, provs, touched);
      put.set(k, sess);
    }
    const entries = [...put];
    for (let i = 0; i < entries.length; i += 100) await this.s.put(Object.fromEntries(entries.slice(i, i + 100)));
    await this.s.put('mig:grants', now());
  }

  // ── 요청 생성·폴링·종료 ──────────────────────────────────────

  /**
   * 익명 요청 만들기. 상한 확인과 기록 쓰기를 다른 요청 없이 한 덩어리로 한다 (동시에 만들어도 상한을 못 넘는다).
   * 출처마다 REQ_PER_SOURCE, 전체 REQ_GLOBAL — 거절 흔적도 센다 (만들고 거절하기를 되풀이해도 쌓이지 않는다)
   */
  async createRequest(meta: ClientMeta, kind: Kind, pub: string | undefined, src: string) {
    if (kind === 'send' && !(typeof pub === 'string' && /^[\w-]{87}$/.test(pub))) return fail(400, '공개키 형식이 올바르지 않습니다.');
    const s = srcOf(src);
    const id = rand(12);
    const secret = rand(24);
    const r: ApprovalRequest = {
      ...meta, id, kind, pub, src: s, code: shortCode(), pollHash: await sha(secret),
      status: 'pending', createdAt: now(), expiresAt: now() + REQ_TTL,
    };
    const bad = await this.ctx.blockConcurrencyWhile(async () => {
      let total = 0, mine = 0;
      const dead: string[] = [];
      for (const [k, x] of await this.s.list<ApprovalRequest>({ prefix: 'req:' })) {
        if (x.expiresAt <= now()) dead.push(k);
        else if (anonHeld(x)) { total++; if (x.src === s) mine++; }
      }
      await this.deleteKeys(dead);
      if (mine >= REQ_PER_SOURCE) return fail(429, '이 네트워크에서 대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      if (total >= REQ_GLOBAL) return fail(429, '대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      r.createdAt = now();
      r.expiresAt = now() + REQ_TTL;
      await this.s.put(`req:${id}`, r);
      return null;
    });
    if (bad) return bad;
    await this.schedule(r.expiresAt);
    return { id, secret, code: r.code, expiresAt: r.expiresAt };
  }

  async pollRequest(id: string, secret: string) {
    const r = await this.s.get<ApprovalRequest>(`req:${id}`);
    if (!r || r.expiresAt <= now()) return { status: 'expired' as const };
    if ((await sha(secret)) !== r.pollHash) return fail(403, 'forbidden');
    if (r.status === 'approved' && r.delivery) {
      // 토큰 원문은 딱 한 번만 내준다
      const d = r.delivery;
      delete r.delivery;
      r.status = 'delivered';
      await this.s.put(`req:${id}`, r);
      if (d.kind !== 'borrow') return { status: 'approved' as const, ...d };
      const defs = (await this.getProviders(d.providers)).map(publicDef);
      return { status: 'approved' as const, ...d, defs };
    }
    return { status: r.status === 'approving' ? ('pending' as const) : r.status };
  }

  async endByToken(token: string) {
    const sid = await this.s.get<string>(`tok:${await sha(token)}`);
    const sess = sid ? await this.s.get<Session>(`sess:${sid}`) : undefined;
    if (!sess) return fail(401, 'invalid token');
    await this.endSession(sess);
    await this.audit('end', sess.id, sess.ip);
    return { ok: true };
  }

  // ── 폰: 승인 ──────────────────────────────────────────────

  async requestInfo(id: string) {
    const r = await this.s.get<ApprovalRequest>(`req:${id}`);
    if (!r || r.expiresAt <= now()) return fail(404, '요청이 없거나 만료됐습니다.');
    const providers = (await this.listProviders()).map((p) => ({ id: p.id, label: p.label, kind: p.kind, daytona: isDaytona(p) }));
    return {
      kind: r.kind, code: r.code, pub: r.pub ?? null, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt,
      ip: r.ip, country: r.country, city: r.city, ua: r.ua,
      providers, ttlChoices: TTL_CHOICES, budgetChoices: BUDGET_CHOICES, limitMax: LIMIT_MAX,
    };
  }

  async approveOptions(id: string, src: string) {
    const r = await this.s.get<ApprovalRequest>(`req:${id}`);
    if (!r || r.expiresAt <= now() || r.status !== 'pending') return fail(409, '승인할 수 없는 요청입니다.');
    return this.authOptions(`approve:${id}`, src);
  }

  async approve(id: string, resp: AuthenticationResponseJSON, choice: Choice) {
    const r = await this.s.get<ApprovalRequest>(`req:${id}`);
    if (!r || r.expiresAt <= now() || r.status !== 'pending') return fail(409, '승인할 수 없는 요청입니다.');
    if (r.kind === 'admin') return this.approveAdmin(r, resp);
    if (r.kind === 'send') return fail(400, '보내기 요청은 금고에서 승인합니다.');

    const ids = [...new Set(choice.providers)];
    const defs = await this.getProviders(ids);
    const plan = approvalPlan(choice, ids, defs, this.env.ALLOW_SHORT_TTL === '1');
    if (typeof plan === 'string') return fail(400, plan);
    const { mint, budget, limits, manage } = plan;

    if (!(await this.verifyTap(`approve:${id}`, resp))) return fail(401, '보안 키 확인에 실패했습니다.');

    // 아래 fetch 동안 다른 요청이 끼어들 수 있으니 먼저 잠근다 (탭 확인 사이에 거절·만료됐으면 승인하지 않는다)
    if (!(await this.claimPending(r))) return fail(409, '승인할 수 없는 요청입니다.');

    const ns = await this.newSession(ids, mint, budget, choice.ttlHours * 3600e3, r, undefined, gensOf(defs), limits, manage);
    if (isFail(ns)) {
      r.status = 'pending';
      await this.s.put(`req:${id}`, r);
      return ns;
    }
    const { sid, token, expiresAt } = ns;
    const manageIds = Object.keys(manage ?? {});
    r.status = 'approved';
    r.delivery = { kind: 'borrow', token, sessionId: sid, providers: ids, expiresAt, budget, manage: manageIds, limits };
    r.expiresAt = now() + REQ_TTL; // 빌린 PC 가 받아갈 시간
    await this.s.put(`req:${id}`, r);
    await this.schedule(Math.min(expiresAt, r.expiresAt));
    await this.audit('approve', sid, r.ip, `${ids.join(',')} ${choice.ttlHours}h${budget !== null ? ` $${budget}` : ''} 상한 ${limits.total}/${limits.perMinute}분/${limits.concurrent}동시${manageIds.length ? ` Daytona관리 ${manageIds.join(',')}` : ''}`);
    return { ok: true, sessionId: sid, expiresAt, manage: manageIds, limits };
  }

  /** 가짜 토큰 세션을 만든다. 서브키 발급형 공급자가 있으면 $ 한도 서브키도 이 세션 전용으로 만든다. */
  private async newSession(ids: string[], mint: StoredProvider | undefined, budget: number | null, ttlMs: number, meta: ClientMeta, lab: string | undefined, gens: Record<string, string>, limits: Limits = { ...LIMIT_MAX }, manage?: Record<string, string>, gate?: () => Promise<void>) {
    const sid = rand(9);
    const token = `kvt_${rand(32)}`;
    const expiresAt = now() + ttlMs;
    let orKey: string | undefined;
    let orKeyHash: string | undefined;
    if (mint && budget !== null) {
      const m = await this.mintOpenRouterKey(mint, sid, budget, gate);
      if (!m) return fail(502, 'OpenRouter 서브키 발급에 실패했습니다.');
      ({ key: orKey, hash: orKeyHash } = m);
    }
    const sess: Session = {
      id: sid, tokenHash: await sha(token), providers: ids, createdAt: now(), expiresAt, budget,
      orKey, orKeyHash, orProvider: mint?.id, uses: 0, ip: meta.ip, country: meta.country, city: meta.city, ua: meta.ua,
      ...(lab ? { lab } : {}), gens, limits, ...(manage && Object.keys(manage).length ? { manage } : {}),
    };
    await this.s.put({ [`sess:${sid}`]: sess, [`tok:${sess.tokenHash}`]: sid });
    await this.schedule(expiresAt);
    return { sid, token, expiresAt };
  }

  /** CLI(kv.ps1) 관리 로그인: 키 탭으로 8시간짜리 관리 토큰을 CLI 에 넘긴다 */
  private async approveAdmin(r: ApprovalRequest, resp: AuthenticationResponseJSON) {
    if (!(await this.verifyTap(`approve:${r.id}`, resp))) return fail(401, '보안 키 확인에 실패했습니다.');
    if (!(await this.claimPending(r))) return fail(409, '승인할 수 없는 요청입니다.');
    const { token, expiresAt } = await this.newAdminToken('cli');
    r.status = 'approved';
    r.delivery = { kind: 'admin', adminToken: token, expiresAt };
    await this.s.put(`req:${r.id}`, r);
    await this.audit('cli-admin', null, r.ip);
    return { ok: true, expiresAt };
  }

  /** 저장된 요청이 아직 대기 중일 때만 approving 으로 바꾼다 (거절 흔적을 덮어쓰지 않는다) */
  private async claimPending(r: ApprovalRequest) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.s.get<ApprovalRequest>(`req:${r.id}`);
      if (!cur || cur.status !== 'pending' || cur.expiresAt <= now()) return false;
      r.status = 'approving';
      await this.s.put(`req:${r.id}`, r);
      return true;
    });
  }

  /** 금고에서 고른 항목을 빌린 PC 공개키로 암호화한 것을 전달. 서버는 중계만 한다 — VaultService.sendDeliver */
  sendDeliver(token: string, id: string, itemId: string, box: { epk?: unknown; iv?: unknown; ct?: unknown }) { return this.#vault.sendDeliver(token, id, itemId, box); }

  /** 거절: 기록을 작은 흔적으로 바꾼다 (상태·폴링 해시·출처만, DENY_TTL 뒤 지움). 흔적도 출처 상한에 든다 */
  async deny(id: string) {
    const r = await this.ctx.blockConcurrencyWhile(async () => {
      const r = await this.s.get<ApprovalRequest>(`req:${id}`);
      if (!r || r.status !== 'pending' || r.expiresAt <= now()) return null;
      const t: ApprovalRequest = {
        id: r.id, kind: r.kind, code: '', pollHash: r.pollHash, src: r.src, status: 'denied',
        createdAt: r.createdAt, expiresAt: Math.min(r.expiresAt, now() + DENY_TTL), ip: '', country: '', city: '', ua: '',
      };
      await this.s.put(`req:${id}`, t);
      return { ...r, expiresAt: t.expiresAt };
    });
    if (!r) return fail(409, '거절할 수 없는 요청입니다.');
    await this.schedule(r.expiresAt);
    await this.auditDeny(r.src ?? 'unknown', r.kind);
    return { ok: true };
  }

  /**
   * 익명 거절은 감사 기록(100개)에 한 줄씩 넣지 않는다 — 반복 거절이 소유자 보안 이벤트를 밀어내지 못하게.
   * audit:deny 에 (출처 해시, 10분 창)마다 한 줄로 센다. IP 원문은 안 남긴다 (출처 = Worker 가 만든 키 붙은 해시).
   * 24시간 지난 줄은 버리고, 줄 수는 DENY_AGG_MAX — 넘치면 '*'(여러 출처, 창 없이) 한 줄에 합친다 (횟수는 안 잃는다)
   */
  private async auditDeny(src: string, kind: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const t = now(), w = Math.floor(t / DENY_WINDOW) * DENY_WINDOW;
      const rows = ((await this.s.get<DenyAgg[]>('audit:deny')) ?? []).filter((d) => d.last > t - 24 * 3600e3);
      const key = srcOf(src);
      let row = rows.find((d) => d.w === w && d.src === key);
      if (!row && rows.filter((d) => d.src !== '*').length >= DENY_AGG_MAX - 1) row = rows.find((d) => d.src === '*');
      if (!row) { row = { w, src: rows.filter((d) => d.src !== '*').length >= DENY_AGG_MAX - 1 ? '*' : key, n: 0, kinds: {}, last: t }; rows.push(row); }
      row.n++;
      row.kinds[kind] = (row.kinds[kind] ?? 0) + 1;
      row.last = t;
      rows.sort((a, b) => b.last - a.last);
      await this.s.put('audit:deny', rows.slice(0, DENY_AGG_MAX));
    });
  }

  // ── 프록시 ────────────────────────────────────────────────

  async resolveToken(token: string, provider: string, path = '', search = '') {
    const th = await sha(token);
    // 확인 → 호출 수 예약·저장까지 다른 요청이 끼지 못하게 한 덩어리로 (끼면 같은 옛 counts 를 읽고 상한을 넘긴다).
    // 복호화·upstream 호출은 예약이 저장된 뒤에만 — 막힌 호출은 키를 풀지도 부르지도 않는다
    const g = await this.ctx.blockConcurrencyWhile(() => this.reserveUse(th, provider, path, search));
    if (isFail(g)) return g;
    const { sess, p } = g;
    const key = p.kind === 'openrouter-mint' ? sess.orKey : await this.decrypt(p);
    if (!key) {
      // upstream 에 넘기기 전에 실패 → 예약을 한 번 돌려준다. 예약은 실패가 정해질 때까지 잡혀 있으니 그 사이 다른 호출이 상한을 넘지 못한다.
      // 키를 돌려준 뒤(프록시가 upstream 을 부른 뒤)는 결과와 상관없이 센다 — 그때는 releaseUse 로 동시 자리만 푼다
      await this.refundUse(sess.id, g.lease);
      return fail(503, 'provider key unavailable');
    }
    // renew: 프록시가 renewUse 를 부를 간격 (lease 수명의 1/3)
    return { key, upstream: p.upstream, target: g.target, auth: p.auth, headers: p.headers, sid: sess.id, lease: g.lease, renew: Math.max(1, Math.floor(this.leaseTtl() / 3)) };
  }

  /** lease 수명. 테스트 fixture 만 짧게 바꾼다 (배포 코드는 늘 LEASE_TTL) */
  protected leaseTtl() { return LEASE_TTL; }

  /**
   * 키를 쓰는 중인 호출의 자리를 한 번 늘린다 (프록시가 fetch·응답 본문 동안 주기적으로). 세션이 없거나 끊겼거나 만료됐거나,
   * lease 가 이미 없거나 수명이 지났으면(그 사이 다른 호출이 자리를 가져갔을 수 있다) false — 프록시는 upstream 호출을 끊는다.
   * 지난 lease 는 되살리지 않고 지운다
   */
  async renewUse(sid: string, lease: string): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const sess = await this.s.get<Session>(`sess:${sid}`);
      const l = sess?.leases?.[lease];
      if (!sess || !l) return false;
      const t = now();
      if (sess.revoked || sess.expiresAt <= t || l.exp <= t) {
        delete sess.leases![lease];
        await this.s.put(`sess:${sid}`, sess);
        return false;
      }
      l.exp = t + this.leaseTtl();
      await this.s.put(`sess:${sid}`, sess);
      return true;
    });
  }

  /**
   * upstream 에 키가 가기 전 실패(복호화·요청 만들기): 그 예약을 통째로 되돌린다 (총·분당·수업 상한·동시 자리).
   * 예약(lease)이 있을 때만, 지우면서 한 번만 — 두 번 불러도(또는 release 뒤에 불러도) 두 번 돌려주지 않는다
   */
  async refundUse(sid: string, lease: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sess = await this.s.get<Session>(`sess:${sid}`);
      const l = sess?.leases?.[lease];
      if (!sess || !l) return;
      delete sess.leases![lease];
      if (l.counted && (sess.counts?.[l.p] ?? 0) > 0) sess.counts = { ...sess.counts, [l.p]: sess.counts![l.p] - 1 };
      sess.uses = Math.max(0, (sess.uses ?? 0) - 1);
      const i = sess.calls?.indexOf(l.at) ?? -1;
      if (i >= 0) sess.calls!.splice(i, 1);
      if (sess.lastAi === l.at) sess.lastAi = l.prevAi;
      await this.s.put(`sess:${sid}`, sess);
    });
  }

  /** upstream 에 키가 간 뒤(응답 끝·본문 끊김·연결 실패): 호출은 센 채로 두고 동시 자리만 푼다. 없는 lease 면 아무것도 안 한다 */
  async releaseUse(sid: string, lease: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sess = await this.s.get<Session>(`sess:${sid}`);
      if (!sess?.leases?.[lease]) return;
      delete sess.leases[lease];
      await this.s.put(`sess:${sid}`, sess);
    });
  }

  private async reserveUse(tokenHash: string, provider: string, path: string, search: string): Promise<Reserved | Fail> {
    const sid = await this.s.get<string>(`tok:${tokenHash}`);
    const sess = sid ? await this.s.get<Session>(`sess:${sid}`) : undefined;
    if (!sess || sess.tokenHash !== tokenHash) return fail(401, 'invalid or expired token');
    const sessDenied = checkedProxySession(sess, provider);
    if (sessDenied) return sessDenied;
    const p = await this.s.get<StoredProvider>(`prov:${provider}`);
    if (!p) return fail(404, `provider ${provider} was removed`);
    if (!grantOk(sess, p)) return fail(403, `provider ${provider} was replaced — approve again`);
    const target = checkedProxyProvider(sess, p, provider, path, search, !!this.env.LAB_DAYTONA_API);
    if (typeof target !== 'string') return target;
    let counted = false;
    const prevAi = sess.lastAi;
    if (sess.lab && provider !== sess.orProvider) {
      const labDenied = checkedLabShare(await this.s.get<Lab>(`lab:${sess.lab}`), sess, p, provider);
      if (labDenied) return labDenied;
      counted = true;
    }
    const t = now();
    const live = checkedSessionQuota(sess, t);
    if (!Array.isArray(live)) return live;
    const lease = rand(12);
    sess.leases = Object.fromEntries([...live, [lease, { exp: t + this.leaseTtl(), p: provider, counted, at: t, prevAi } satisfies Lease]]);
    sess.calls!.push(t);
    sess.uses = (sess.uses ?? 0) + 1;
    sess.lastUsed = t;
    // lab-status 가 상태 줄에서 자주 부르는 /key, 모델 목록은 'AI 사용'으로 치지 않는다
    if (!/^api\/v1\/(key|models)(\/|$)/.test(path)) sess.lastAi = t;
    await this.s.put(`sess:${sess.id}`, sess);
    return { sess, p, lease, target };
  }

  /** 프록시가 upstream 오류(4xx·5xx, 연결 실패)를 본 세션을 적어 둔다 → /lab 표에 자리별 '최근 오류', 여러 자리면 전체 경고 */
  async noteError(sid: string, status: number, msg: string) {
    if (!/^[\w-]{1,64}$/.test(sid)) return;
    const prev = await this.s.get<LabErr>(`lerr:${sid}`);
    const n = prev && now() - prev.at < LAB_ERR_RECENT ? prev.n + 1 : 1;
    await this.s.put(`lerr:${sid}`, { at: now(), status, msg: msg.replace(/\s+/g, ' ').slice(0, 200), n } satisfies LabErr);
  }

  // ── 등록 (SETUP_TOKEN, 또는 /admin 에서 방금 키로 로그인한 세션) ─────────

  // SETUP_TOKEN 이 맞는지는 Worker 쪽(index.ts)에서 본다 (시크릿이 바뀐 직후에도 그 버전의 env 를 보도록). 여기로는 맞을 때만 그 해시가 온다.
  // SETUP_TOKEN: 처음 맞게 쓴 순간 SETUP_WINDOW(30분) 창이 열리고, 그 안에 등록 성공 SETUP_MAX_REGS(2)번까지 (Nano + NFC).
  //   기록(setup:<해시>)은 저장소에 있어 다시 떠도 그대로 — 지나거나 다 쓴 토큰은 닫힌 채다.
  // 관리 토큰으로 등록하려면 웹에서 탭으로 받은 토큰이 3분 안이어야 한다 (CLI 토큰·오래된 토큰으로는 영구 접근을 못 만든다).
  private async freshWebAdmin(adminToken: string) {
    const a = await this.getAdmin(adminToken);
    return !!a && a.src === 'web' && now() - (a.createdAt ?? 0) < REG_FRESH;
  }

  /** setup 해시의 창 확인. start=true 면 처음 쓴 것으로 창을 연다. 열려 있고 남았으면 null */
  private async setupCheck(setupHash: string, start: boolean): Promise<Fail | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const k = `setup:${setupHash}`;
      let u = await this.s.get<SetupUse>(k);
      if (!u) {
        if (!start) return fail(403, 'setup token 창이 열리지 않았습니다. 등록을 처음부터 다시 하세요.');
        u = { firstAt: now(), used: 0 };
        await this.s.put(k, u);
        await this.audit('setup-open', null, null, `${SETUP_WINDOW / 60e3}분 · 키 ${SETUP_MAX_REGS}개`);
      }
      return this.setupLeft(u);
    });
  }

  private setupLeft(u: SetupUse) {
    if (now() - u.firstAt >= SETUP_WINDOW) return fail(403, `setup token 이 만료됐습니다 (처음 쓴 뒤 ${SETUP_WINDOW / 60e3}분). deploy.ps1 -SetupOnly 로 새로 받으세요.`);
    if (u.used >= SETUP_MAX_REGS) return fail(403, `이 setup token 으로 키 ${SETUP_MAX_REGS}개를 이미 등록했습니다. 더 등록하려면 /admin 에서 하거나 deploy.ps1 -SetupOnly 로 새로 받으세요.`);
    return null;
  }

  async registerOptions(setupHash: string, adminToken: string, src: string) {
    if (setupHash) {
      const bad = await this.setupCheck(setupHash, true);
      if (bad) return bad;
    } else if (!(await this.freshWebAdmin(adminToken)))
      return fail(403, adminToken ? '관리 로그인 후 3분이 지났습니다. 다시 로그인하세요.' : 'setup token이 틀렸습니다.');
    const creds = await this.creds();
    const opts = await generateRegistrationOptions({
      rpName: 'shinick gw', rpID: this.env.RP_ID,
      userName: 'owner', userID: new Uint8Array(new TextEncoder().encode('owner')),
      attestationType: 'none',
      // PRF 없는 예전 등록은 제외하지 않는다 — 같은 키를 PRF 로 다시 등록할 수 있게
      excludeCredentials: creds.filter((c) => c.prf).map((c) => ({ id: c.id })),
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required', authenticatorAttachment: 'cross-platform' },
      preferredAuthenticatorType: 'securityKey',
      extensions: { prf: {} },
      timeout: 180_000,
    });
    const bad = await this.putChallenge('reg', opts.challenge, src);
    return bad ?? opts;
  }

  async registerVerify(setupHash: string, resp: RegistrationResponseJSON, label: string, adminToken: string) {
    if (setupHash) {
      const bad = await this.setupCheck(setupHash, false);
      if (bad) return bad;
    } else if (!(await this.freshWebAdmin(adminToken))) return fail(403, '등록 권한이 없습니다.');
    let err = '';
    const v = await this.ceremony('reg', resp, async (challenge) => {
      try {
        const r = await verifyRegistrationResponse({
          response: resp, expectedChallenge: challenge,
          expectedOrigin: this.env.ORIGIN, expectedRPID: this.env.RP_ID, requireUserVerification: true,
        });
        return r.verified ? r : null;
      } catch (e) {
        err = (e as Error).message;
        return null;
      }
    });
    if (v === undefined) return fail(400, 'challenge가 없거나 만료됐습니다.');
    if (v === null) return fail(400, err ? `등록 검증 실패: ${err}` : '등록 검증 실패');
    const c = v.registrationInfo.credential;
    const cred: Cred = {
      id: c.id, publicKey: isoBase64URL.fromBuffer(c.publicKey), counter: c.counter,
      label: label.slice(0, 40) || 'key', createdAt: now(),
      prf: (resp.clientExtensionResults as { prf?: { enabled?: boolean } } | undefined)?.prf?.enabled === true,
    };
    // SETUP_TOKEN 으로 등록: 창·남은 횟수를 다시 보고, 횟수 올리기와 키 저장을 한 덩어리로 (동시에 성공해도 2개를 못 넘는다)
    const saved = await this.ctx.blockConcurrencyWhile(async () => {
      if (!setupHash) { await this.s.put(`cred:${c.id}`, cred); return null; }
      const k = `setup:${setupHash}`;
      const u = await this.s.get<SetupUse>(k);
      const bad = u ? this.setupLeft(u) : fail(403, 'setup token 창이 열리지 않았습니다.');
      if (bad) return bad;
      await this.s.put({ [k]: { ...u!, used: u!.used + 1 } satisfies SetupUse, [`cred:${c.id}`]: cred });
      return null;
    });
    if (saved) return saved;
    await this.audit('register', null, null, cred.label + (cred.prf ? ' (PRF)' : ''));
    return { ok: true, id: c.id, label: cred.label, prf: cred.prf };
  }

  // ── 관리 (보안 키 탭으로 8시간 세션) ──────────────────────────

  async adminOptions(src: string) { return this.authOptions('admin', src); }

  /** Restore the original web grant. Never mints a new token or extends its deadline. */
  async labAdminResume(token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return fail(401,'관리 세션이 만료됐습니다.');
    const grant = await this.getAdmin(token);
    if (!grant || grant.src !== 'web' || !Number.isFinite(grant.createdAt) || grant.expiresAt > grant.createdAt! + ADMIN_TTL) return fail(401,'관리 세션이 만료됐습니다.');
    return {token,expiresAt:grant.expiresAt};
  }
  async labAdminRemember(token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return fail(401,'보안 키로 먼저 로그인하세요.');
    const grant = await this.getAdmin(token);
    if (!grant || grant.src !== 'web' || !Number.isFinite(grant.createdAt) || now() - grant.createdAt! > 3 * 60_000) return fail(401,'보안 키로 먼저 로그인하세요.');
    return this.labAdminResume(token);
  }

  /** wantRc: 이 화면이 복구 코드를 보여 줄 수 있다 (/admin). 금고에 복구 코드가 아직 없으면 이 응답에 한 번만 실어 준다 */
  async adminLogin(resp: AuthenticationResponseJSON, wantRc = false) {
    const credential = await this.verifyTap('admin', resp);
    if (!credential) return fail(401, '보안 키 확인에 실패했습니다.');
    const t = await this.newAdminToken('web', credential.id);
    const rc = wantRc ? await this.issueRecoveryCode(false) : undefined;
    return rc ? { ...t, recoveryCode: rc } : t;
  }

  async adminList(token: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const sessions = [...(await this.s.list<Session>({ prefix: 'sess:' })).values()].map(
      ({ orKey, tokenHash, leases, calls, manage, limits, ...rest }) => ({
        ...rest, orKeyHash: rest.orKeyHash ?? null,
        // lease id·호출 시각은 안 내보낸다 — 상한·지금 쓰는 양만. manage = 관리 API 허용 공급자 id (상한 없는 예전 세션은 첫 호출 때 기본값)
        limits: limits ?? { ...LIMIT_MAX }, inflight: liveLeases({ leases } as Session).length,
        lastMinute: (calls ?? []).filter((t) => t > now() - RATE_WINDOW).length, manage: Object.keys(manage ?? {}),
      }),
    );
    const creds = (await this.creds()).map(({ publicKey, ...c }) => c);
    const providers = (await this.listProviders()).map(publicDef);
    // 익명 거절은 따로 묶어 둔 요약(출처·10분마다 한 줄)에서 최근 DENY_SHOW 줄만 섞는다 — 거절 홍수가 소유자 이벤트를 화면에서 밀어내지 않게
    const log = (await this.s.get<{ t: number }[]>('audit')) ?? [];
    const denies = ((await this.s.get<DenyAgg[]>('audit:deny')) ?? []).slice(0, DENY_SHOW).map((d) => ({
      t: d.last, event: 'deny', sid: null, ip: null,
      detail: `${d.n}회 (${Object.entries(d.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}) · 출처 ${d.src === '*' ? '여러 곳' : d.src.slice(0, 6)}`,
    }));
    return { sessions, creds, providers, audit: [...log, ...denies].sort((a, b) => b.t - a.t) };
  }

  /** 공급자 추가·수정. value 를 비우면 기존 키를 유지한다 (정의만 수정). */
  async adminUpsertProvider(token: string, input: Record<string, unknown>) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const id = String(input.id ?? input.preset ?? '');
    const existing = id ? await this.s.get<StoredProvider>(`prov:${id}`) : undefined;
    const draft = upsertDraft(input, id, existing, !!this.env.LAB_DAYTONA_API);
    if (typeof draft === 'string') return fail(400, draft);
    const { def, value, same } = draft;
    if (!this.env.MASTER_KEY) return fail(503, 'MASTER_KEY 가 설정되지 않았습니다.');
    let warn: string | undefined;
    if (wantsTenant(value, def)) {
      try {
        const r = await fetch(`${def.upstream}/api/v1/workspaces`, { headers: { 'x-api-key': value } });
        const ws = r.ok ? ((await r.json()) as { id: string }[]) : [];
        warn = applyWorkspaces(def, ws);
      } catch {}
    }
    const sealed = value
      ? { ...(await this.encrypt(def.id, value)), last4: value.slice(-4) }
      : { iv: existing!.iv, ct: existing!.ct, last4: existing!.last4 };
    // 새로 만들거나 키가 가는 곳·방식·종류가 바뀌면 새 세대 → 예전 세대로 받은 토큰은 이 공급자에 안 통한다 (같은 곳 키 교체는 유지)
    const gen = same && existing?.gen ? existing.gen : rand(9);
    const stored: StoredProvider = { ...def, ...sealed, updatedAt: now(), gen };
    // 위 fetch·암호화 동안 다른 요청이 끼어들 수 있다 (지우기·다시 만들기·다른 수정). 쓰기 직전에 처음 읽은 기록이 그대로인지
    // 다른 요청 없이 한 덩어리로 다시 보고 쓴다 — 아니면 거부 (지워진 공급자를 예전 세대로 되살리지 않는다)
    const ok = await this.ctx.blockConcurrencyWhile(async () => {
      const cur = await this.s.get<StoredProvider>(`prov:${def.id}`);
      if (existing ? !cur || cur.gen !== existing.gen || cur.updatedAt !== existing.updatedAt : cur) return false;
      if (existing && existing.gen !== gen) await this.retireProvider(existing);
      await this.s.put(`prov:${def.id}`, stored);
      await this.audit(existing ? 'provider-update' : 'provider-add', null, null, def.id + (value ? '' : ' (정의만)'));
      return true;
    });
    if (!ok) return fail(409, '그 사이 이 공급자가 바뀌었거나 지워졌습니다. 목록을 다시 보고 다시 시도하세요.');
    return { ok: true, provider: publicDef(stored), warn };
  }

  async adminDeleteProvider(token: string, id: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    return this.ctx.blockConcurrencyWhile(async () => {
      const p = await this.s.get<StoredProvider>(`prov:${id}`);
      if (!p) return fail(404, '없는 공급자입니다.');
      await this.retireProvider(p);
      await this.s.delete(`prov:${id}`);
      await this.audit('provider-delete', null, null, id);
      return { ok: true };
    });
  }

  async adminRevoke(token: string, target: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const list = [...(await this.s.list<Session>({ prefix: 'sess:' })).values()];
    const hit = target === 'all' ? list : list.filter((x) => x.id === target);
    let cleaned = 0;
    for (const sess of hit) if (await this.endSession(sess)) cleaned++;
    await this.audit('revoke', target, null, `${hit.length}개`);
    return { ok: true, revoked: hit.length, cleaned };
  }

  async adminDeleteCred(token: string, credId: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (!(await this.s.delete(`cred:${credId}`))) return fail(404, '없는 키입니다.');
    await this.s.delete(`vwrap:${credId}`);
    await this.audit('cred-delete', null, null, credId.slice(0, 8));
    return { ok: true };
  }

  // ── 금고 ─────────────────────────────────────────────────
  // 서버가 하는 일: 탭 검증, 암호문 보관, 복구 답 검증값 비교와 횟수 제한. 금고 키·평문은 절대 오지 않는다.
  // 금고 일은 전부 VaultService 가 한다. 공개 RPC 이름·인자·결과는 그대로 (서비스는 # 필드로만 닿는다). 탭 의식·관리 토큰·감사 기록은 State 것을 넘겨 준다
  readonly #vault = new VaultService({
    storage: this.ctx.storage,
    blockConcurrencyWhile: this.ctx.blockConcurrencyWhile.bind(this.ctx),
    reqTtl: REQ_TTL,
    checkAdmin: (token) => this.checkAdmin(token),
    freshWebAdmin: (token) => this.freshWebAdmin(token),
    creds: () => this.creds(),
    authOptions: (purpose, src, only) => this.authOptions(purpose, src, only),
    verifyTap: (purpose, resp) => this.verifyTap(purpose, resp),
    newAdminToken: (src) => this.newAdminToken(src),
    audit: (event, sid, ip, detail) => this.audit(event, sid, ip, detail),
  });

  vaultStatus() { return this.#vault.status(); }
  vaultOptions(credId: string | undefined, src: string) { return this.#vault.options(credId, src); }

  /** 탭 검증 → 관리 토큰 + 그 키의 감싼 금고 키 + 항목 암호문. 금고를 푸는 건 브라우저가 PRF 로 한다. */
  vaultOpen(resp: AuthenticationResponseJSON) { return this.#vault.open(resp); }

  vaultInit(token: string, credId: string, wrap: Sealed, rec: VaultMeta['rec']) { return this.#vault.init(token, credId, wrap, rec); }

  /** 복구 코드 발급 (adminLogin 이 부른다). force=false 면 금고가 있고 코드가 아직 없을 때만 */
  private issueRecoveryCode(force: boolean) { return this.#vault.issueRecoveryCode(force); }

  /** 복구 코드 새로 받기 (잃어버렸을 때). 키를 탭한 지 3분 안의 웹 세션만 — 예전 코드는 바로 무효 */
  vaultRotateRecoveryCode(token: string) { return this.#vault.rotateRecoveryCode(token); }

  vaultLink(token: string, credId: string, wrap: Sealed) { return this.#vault.link(token, credId, wrap); }
  vaultSetRecovery(token: string, rec: VaultMeta['rec']) { return this.#vault.setRecovery(token, rec); }
  vaultPutItem(token: string, item: { id?: unknown; iv?: unknown; ct?: unknown; policy?: unknown }) { return this.#vault.putItem(token, item); }
  vaultDeleteItem(token: string, id: string) { return this.#vault.deleteItem(token, id); }

  /** 복구 화면용. 질문과 KDF 파라미터, 지금 복구 코드의 남은 시도만 — 답·코드를 검증할 수 있는 건 주지 않는다. */
  vaultRecoverInfo() { return this.#vault.recoverInfo(); }

  /** 복구 = 복구 코드 + 복구 답. 코드 오답 예산·한 번만 성공·코드 바꾸기는 VaultService.recover */
  vaultRecover(code: unknown, verifier: unknown, ip: string) { return this.#vault.recover(code, verifier, ip); }

  // ── 공부방 실습실 ─────────────────────────────────────────
  // 강사가 /lab 에서 키 탭 → 자리 수만큼 [OpenRouter $ 한도 서브키 + 가짜 토큰 세션 + Daytona 샌드박스] 를 만든다.
  // 참가자는 /j/<code> 링크만 연다. 샌드박스에는 가짜 토큰과 workers.dev 게이트웨이 주소만 들어간다.

  async labConfig(token: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const cfg = { ...LAB_DEFAULT, ...((await this.s.get<LabCfg>('labcfg')) ?? {}) };
    if (LAB_OLD_SNAPSHOTS.includes(cfg.snapshot)) cfg.snapshot = LAB_DEFAULT.snapshot;
    if (this.env.LAB_GW) cfg.gw = this.env.LAB_GW; // workers.dev 주소는 wrangler 변수가 기준 (계정 하위 도메인을 바꾸면 거기만)
    const provs = await this.listProviders();
    return {
      cfg, hours: LAB_HOURS, budgets: LAB_BUDGETS, maxSeats: LAB_MAX_SEATS, labOrigin: this.env.LAB_ORIGIN,
      daytona: provs.some((p) => p.id === 'daytona'), openrouter: provs.some((p) => p.kind === 'openrouter-mint'),
      quota: await this.labQuota(),
      shareable: provs.filter(labShareable).map((p) => ({ id: p.id, label: p.label, envKey: p.envKey })), shareCap: LAB_SHARE_CAP,
    };
  }

  /** 수업 만들기 동기 확인 규칙 (lab-setup.ts) */
  #labRules(): LabRules {
    return {
      maxSeats: LAB_MAX_SEATS, hours: LAB_HOURS, budgets: LAB_BUDGETS, defaults: LAB_DEFAULT,
      allowShortTtl: this.env.ALLOW_SHORT_TTL === '1', devHttp: !!this.env.LAB_DAYTONA_API,
      today: () => new Date().toISOString().slice(0, 10),
    };
  }

  // requestId 없는 옛 호출은 그대로. ID 호출은 현재 DO 에서 합치고 재시작 뒤에는 재실행하지 않는다.
  async labCreate(token: string, input: LabInput) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, '수업 만들기 입력이 올바르지 않습니다.');
    if (input.requestId !== undefined) return this.#create.create(token, input as Record<string, unknown>);
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const p = await this.#labCreateValidate(input);
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (isFail(p)) return p;
    let r;
    try { r = await this.#labCreateExecute(token, p); } catch (e) { return isFail(e) ? e : fail(503, '수업 만들기 결과를 확인하지 못했습니다. 수업 목록을 확인하세요.'); }
    if (isFail(r) || isSnapPending(r)) return r;
    const lab = await this.s.get<Lab>(`lab:${r.labId}`);
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    return lab ? { ok: true, lab: this.labView(lab) } : fail(410, '수업이 끝났습니다.');
  }

  labCreateStatus(token: string, requestId: unknown) { return this.#create.status(token, requestId); }

  // Direct operator addition uses the same durable creation barrier as approved joins.
  // The random suffix becomes the seat marker; replays cannot allocate another seat.
  #seatAddMarker(requestId: string) { return requestId.slice(-32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'); }
  async #seatAddInfo(token: string, id: unknown) {
    if (!await this.checkAdmin(token)) return fail(401,'관리 세션이 만료됐습니다.');
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) return fail(400,'모임을 고르세요.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab || lab.endRetry || lab.expiresAt <= now() || await this.s.get(prepStopKey(id))) return fail(410,'모임이 끝났습니다.');
    if (lab.teacherDemoFor || await this.s.get(trialReserveKey(id)) || await this.s.get(trialBindingKey(id))) return fail(409,'시연실·체험 연결 모임에는 참여자 좌석을 추가할 수 없습니다.');
    const version = await sha(trialConfigText(lab)+'|'+lab.budget+'|'+lab.expiresAt);
    if (!await this.checkAdmin(token)) return fail(401,'관리 세션이 만료됐습니다.');
    return {lab,info:{id:lab.id,name:lab.name,seats:lab.seats.length,maxSeats:LAB_MAX_SEATS,cpu:lab.cpu,memory:lab.memory,disk:lab.disk,budget:lab.budget,model:lab.model,expiresAt:lab.expiresAt,version,canAdd:lab.seats.length<LAB_MAX_SEATS}};
  }
  async #seatAddResult(token: string, id: string, requestId: string, result: unknown) {
    if (isFail(result)) return result;
    const current = await this.#seatAddInfo(token,id); if (isFail(current)) return current;
    const seat = current.lab.seats.find(s=>s.openRequestId===this.#seatAddMarker(requestId));
    // A generic create ID or another room's operation cannot be presented as this addition.
    if (result && typeof result==='object' && 'creationState' in result && result.creationState==='completed' && !seat) return fail(409,'이 좌석 추가 요청의 결과가 아닙니다. 모임 목록을 확인하세요.');
    return {...result as Record<string,unknown>,seatAdd:{...current.info,...(seat?{seat:{n:seat.n,ready:!!seat.sandboxId&&!seat.error,error:seat.error?'좌석 준비를 완료하지 못했습니다. 모임 도구에서 복구 상태를 확인하세요.':null}}:{})}};
  }
  async labSeatAddStatus(token: string, input: unknown) {
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['id','requestId'].includes(k))) return fail(400,'좌석 추가 조회 형식이 올바르지 않습니다.');
    const b=input as Record<string,unknown>;
    const current=await this.#seatAddInfo(token,b.id);if(isFail(current))return current;
    if(b.requestId===undefined)return {seatAdd:current.info};
    if(typeof b.requestId!=='string'||!/^lc_\d{13}_[a-f0-9]{32}$/.test(b.requestId))return fail(400,'요청 ID가 올바르지 않습니다.');
    return this.#seatAddResult(token,current.lab.id,b.requestId,await this.#create.status(token,b.requestId));
  }
  async labSeatAdd(token: string, input: unknown) {
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['id','requestId','version'].includes(k))) return fail(400,'좌석 추가 입력 형식이 올바르지 않습니다.');
    const b=input as Record<string,unknown>;
    if(typeof b.requestId!=='string'||!/^lc_\d{13}_[a-f0-9]{32}$/.test(b.requestId)||typeof b.version!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.version))return fail(400,'요청 ID와 모임 조건을 다시 확인하세요.');
    const current=await this.#seatAddInfo(token,b.id);if(isFail(current))return current;
    // Stable payload: settings and deadline are validated against the confirmed fingerprint.
    // labCreate validates, atomically appends one seat, provisions only that seat and cleans up.
    const result=await this.#create.create(token,{requestId:b.requestId,parentLabId:current.lab.id,parentVersion:b.version,openRequestId:this.#seatAddMarker(b.requestId),name:'추가 좌석'});
    return this.#seatAddResult(token,current.lab.id,b.requestId,result);
  }

  // 개설 요청은 서버에 보관한다. 푸시는 알림일 뿐이며 WebAuthn 승인 없이 자원을 만들지 않는다.
  async #checkOpenManager(token:string) {
    if (typeof token !== 'string') return false;
    if (token.startsWith('owner:')) return !!await verifyOpenOwnerJwt(token.slice(6),this.env);
    return this.checkAdmin(token); // Existing internal/CLI callers; HTTP still requires Access.
  }
  readonly #openRequests = new LabOpenRequestService({ storage: this.ctx.storage, now, checkAdmin: t => this.#checkOpenManager(t), schedule: t => this.schedule(t) });
  readonly #openPush = new LabOpenPushService({
    storage: this.ctx.storage, now, credentialExists: async id => !!await this.s.get(`cred:${id}`),
    vapid: () => this.#pushVapid(), seal: (aad,text) => this.seal(aad,text), open: (aad,iv,ct) => this.unseal(aad,iv,ct),
    schedule: t => this.schedule(t), pending: () => this.#openRequests.pendingIds(),
    send: (sub,key,payload,options) => sendPush(sub,key,payload,{...options,ttlSeconds:3600}),
  });
  async labOpenSubmit(input: unknown, src: string) {
    const result = await this.#openRequests.submit(input,src);
    if (!isFail(result)) this.ctx.waitUntil(this.#openPush.alarm(now()).then(t => t < Infinity ? this.schedule(t) : undefined).catch(()=>this.schedule(now()+60e3)));
    return result;
  }
  async labOpenStatus(id: unknown, secret: unknown) {
    const result = await this.#openRequests.status(id,secret);
    if (isFail(result) || !('result' in result) || !result.result) return result;
    const target = result.result;
    const lab = await this.s.get<Lab>(`lab:${target.labId}`);
    const seat = lab?.seats.find(s=>s.n===target.n && s.code===target.seatCode);
    if (!lab || lab.endRetry || lab.expiresAt<=now() || !seat?.sandboxId || seat.error || await this.s.get(prepStopKey(lab.id))) return {id,state:'expired',expiresAt:target.expiresAt};
    return result;
  }
  async labOpenList(token: string) {
    const requests = await this.#openRequests.list(token); if (isFail(requests)) return requests;
    const labs = [...(await this.s.list<Lab>({prefix:'lab:'})).values()];
    const choices = [];
    for (const lab of labs) if (!lab.teacherDemoFor && !lab.endRetry && lab.expiresAt > now() && lab.seats.length < LAB_MAX_SEATS && !await this.s.get(prepStopKey(lab.id)) && !await this.s.get(trialReserveKey(lab.id)) && !await this.s.get(trialBindingKey(lab.id))) choices.push({id:lab.id,name:lab.name,expiresAt:lab.expiresAt,budget:lab.budget,seats:lab.seats.length,cpu:lab.cpu,memory:lab.memory,disk:lab.disk});
    if (!await this.#checkOpenManager(token)) return fail(401,'관리 세션이 만료됐습니다.');
    return {...requests,labs:choices,hours:LAB_HOURS,budgets:LAB_BUDGETS};
  }
  async #openPlan(id: unknown, choice: unknown) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return fail(400,'요청 ID가 올바르지 않습니다.');
    const request = await this.#openRequests.get(id);
    if (!request || request.expiresAt <= now() || request.state === 'denied' || request.state === 'expired') return fail(410,'요청이 끝났습니다.');
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return fail(400,'승인 조건을 확인하세요.');
    const raw = choice as Record<string,unknown>;
    let input: LabInput;
    if (request.mode === 'practice') {
      if (Object.keys(raw).some(k=>!['hours','budget','cpu','memory','disk'].includes(k)) || typeof raw.hours !== 'number' || typeof raw.budget !== 'number' || !LAB_HOURS.includes(raw.hours) || !LAB_BUDGETS.includes(raw.budget)) return fail(400,'사용 시간과 AI 한도를 고르세요.');
      const hasResources = ['cpu','memory','disk'].some(k=>Object.hasOwn(raw,k));
      // Older inbox tabs sent only hours/budget. Explicit specs must be complete numeric integers.
      const resources = hasResources && ['cpu','memory','disk'].some(k=>typeof raw[k]!=='number') ? null : labResourcesOf(hasResources?raw:{cpu:1,memory:2,disk:5});
      if (!resources) return fail(400,'CPU·메모리·디스크를 각각 1 이상의 정수로 입력하세요.');
      const config = {...LAB_DEFAULT,...await this.s.get<LabCfg>('labcfg')};
      input = {name:('개인 복습 · '+request.name).slice(0,40),seats:1,hours:raw.hours,budget:raw.budget,...resources,
        snapshot:LAB_DEFAULT.snapshot,model:config.model,gw:config.gw||this.env.LAB_GW||'',materials:'',clipIn:true,clipOut:true,share:{},openRequestId:id};
    } else {
      if (Object.keys(raw).some(k=>k!=='labId') || typeof raw.labId !== 'string' || !/^[\w-]{1,100}$/.test(raw.labId)) return fail(400,'자리를 추가할 모임을 고르세요.');
      const parent = await this.s.get<Lab>(`lab:${raw.labId}`);
      if (!parent || parent.endRetry || parent.expiresAt<=now() || parent.seats.length>=LAB_MAX_SEATS || await this.s.get(prepStopKey(parent.id)) || await this.s.get(trialReserveKey(parent.id)) || await this.s.get(trialBindingKey(parent.id))) return fail(409,'지금 자리를 추가할 수 없는 모임입니다.');
      input = {parentLabId:parent.id,openRequestId:id,name:parent.name,seats:1,hours:1,budget:parent.budget,cpu:parent.cpu,memory:parent.memory,disk:parent.disk,snapshot:parent.snapshot,model:parent.model,gw:parent.gw,
        materials:parent.materials??'',clipIn:parent.clip?.in!==false,clipOut:parent.clip?.out!==false,share:Object.fromEntries(Object.entries(parent.share??{}).filter(([,v])=>v.on).map(([k,v])=>[k,v.cap]))};
      // 승인 의식은 모임의 종료 시각·정책에도 묶인다. 그 사이 바뀌면 새로 확인해야 한다.
      const parentFingerprint=await sha(trialConfigText(parent)+'|'+parent.budget+'|'+parent.expiresAt);
      input.parentVersion=parentFingerprint;
      return {input,parentExpiresAt:parent.expiresAt,parentFingerprint};
    }
    return {input};
  }
  async labOpenOptions(token: string,id:unknown,choice:unknown,src:string) {
    if (!await this.#checkOpenManager(token)) return fail(401,'관리 세션이 만료됐습니다.');
    const plan = await this.#openPlan(id,choice); if (isFail(plan)) return plan;
    return this.authOptions('lab-open:'+id+':'+await sha(JSON.stringify(plan)),src);
  }
  async labOpenApprove(token:string,id:unknown,choice:unknown,assertion:unknown) {
    if (!await this.#checkOpenManager(token)) return fail(401,'관리 세션이 만료됐습니다.');
    const plan = await this.#openPlan(id,choice); if (isFail(plan)) return plan;
    const text = JSON.stringify(plan);
    if (!await this.verifyTap('lab-open:'+id+':'+await sha(text),assertion as AuthenticationResponseJSON)) return fail(401,'이 요청의 보안 키 승인에 실패했습니다.');
    const claimed = await this.#openRequests.claim(token,id,text); if (isFail(claimed)) return claimed;
    await this.audit('lab-open-approved',null,null,String(id));
    return this.labOpenResume(token,id);
  }
  async labOpenResume(token:string,id:unknown) {
    if (!await this.#checkOpenManager(token)) return fail(401,'관리 세션이 만료됐습니다.');
    if (typeof id!=='string') return fail(400,'요청 ID가 올바르지 않습니다.');
    const request = await this.#openRequests.get(id);
    if (!request || !['approving','ready'].includes(request.state) || !request.operationId || !request.choice) return fail(409,'보안 키로 승인한 요청만 이어갈 수 있습니다.');
    if (request.state==='ready') return {state:'ready',id};
    const plan = JSON.parse(request.choice) as {input:LabInput;parentExpiresAt?:number;parentFingerprint?:string};
    if (plan.input.parentLabId) {
      const parent = await this.s.get<Lab>(`lab:${plan.input.parentLabId}`);
      if (!parent || parent.endRetry || parent.expiresAt<=now() || await sha(trialConfigText(parent)+'|'+parent.budget+'|'+parent.expiresAt)!==plan.parentFingerprint) return fail(409,'승인 뒤 모임 조건이 바뀌었습니다. 자동으로 다시 만들지 않습니다.');
    }
    // Access can resume only a previously signed, immutable operation. The provisioning
    // token stays inside the DO; it is never returned to the page or used for arbitrary input.
    const creationToken = token.startsWith('owner:') ? (await this.newAdminToken('web')).token : token;
    const created = await this.labCreate(creationToken,{...plan.input,requestId:request.operationId});
    if (isFail(created)) return created;
    if (!('creationState' in created) || created.creationState!=='completed') return {id,state:'approving',creation:created};
    const lab = await this.s.get<Lab>(`lab:${created.lab.id}`);
    const seat = lab?.seats.find(s=>s.openRequestId===id);
    if (!lab || !seat?.sandboxId || seat.error || lab.endRetry || lab.expiresAt<=now() || await this.s.get(prepStopKey(lab.id))) return fail(409,'실습실 준비 결과를 확인해야 합니다. 모임 목록을 확인하세요.');
    // 초대 링크를 내주기 직전 정책과 실제 자원을 다시 읽는다. 내부 준비는 입장 페이지가 이어서 확인한다.
    const result = await this.#openRequests.finish(id,request.operationId,{labId:lab.id,n:seat.n,seatCode:seat.code,expiresAt:lab.expiresAt});
    return isFail(result)?result:{id,state:'ready'};
  }
  labOpenDeny(token:string,id:unknown) { return this.#openRequests.deny(token,id); }
  labOpenPushConfig() { return this.#openPush.config(); }
  async #openPushPurpose(subscription:unknown,label:unknown) {
    const sub=await parsePushSubscription(subscription);
    if(!sub || typeof label!=='string' || label.length<1 || label.length>40 || /[\u0000-\u001f\u007f]/.test(label)) return null;
    return 'lab-open-push:'+await sha(JSON.stringify({sub,label}));
  }
  async labOpenPushOptions(token:string,src:string,subscription:unknown,label:unknown) {
    if(!await this.#checkOpenManager(token))return fail(401,'관리 세션이 만료됐습니다.');
    const purpose=await this.#openPushPurpose(subscription,label);
    return purpose?this.authOptions(purpose,src):fail(400,'알림 기기 정보를 확인하세요.');
  }
  async labOpenPushSubscribe(token:string,subscription:unknown,label:unknown,assertion:unknown) {
    if (!await this.#checkOpenManager(token)) return fail(401,'관리 세션이 만료됐습니다.');
    const purpose=await this.#openPushPurpose(subscription,label);
    if(!purpose)return fail(400,'알림 기기 정보를 확인하세요.');
    const credential = await this.verifyTap(purpose,assertion as AuthenticationResponseJSON);
    if (!credential || !await this.#checkOpenManager(token)) return fail(401,'알림 등록용 보안 키 확인에 실패했습니다.');
    return this.#openPush.register(credential.id,subscription,label);
  }
  async labOpenPushStatus(token:string,endpoint:unknown) { return await this.#checkOpenManager(token)?this.#openPush.status(endpoint):fail(401,'관리 세션이 만료됐습니다.'); }
  async labOpenPushDevices(token:string) { return await this.#checkOpenManager(token)?this.#openPush.devices():fail(401,'관리 세션이 만료됐습니다.'); }
  async labOpenPushRemove(token:string,endpoint:unknown) { return await this.#checkOpenManager(token)?this.#openPush.remove(endpoint):fail(401,'관리 세션이 만료됐습니다.'); }
  async labOpenPushTest(token:string,endpoint:unknown) {
    if (!await this.#checkOpenManager(token)) return fail(401,'요청함 로그인이 만료됐습니다.');
    if (token.startsWith('owner:')) return this.#openPush.testRegistered(endpoint);
    const admin = await this.getAdmin(token);
    if (!admin?.credentialId) return fail(401,'이 화면에서 보안 키로 로그인한 뒤 시험 알림을 보내세요.');
    return this.#openPush.test(admin.credentialId,endpoint);
  }
  async labOpenPushAck(token:string,endpoint:unknown) { return await this.#checkOpenManager(token)?this.#openPush.acknowledgeTest(endpoint):fail(401,'관리 세션이 만료됐습니다.'); }
  readonly #create = new LabCreateService({
    storage: this.ctx.storage, now: () => now(), checkAdmin: (token) => this.checkAdmin(token),
    validate: (input) => this.#labCreateValidate(input),
    execute: (token, p, arm) => this.#labCreateExecute(token, p, arm),
    summary: (id) => this.#labCreateSummary(id),
  });
  async #labCreateSummary(id: string): Promise<CreateSummary | Fail> {
    const lab = await this.s.get<Lab>(`lab:${id}`);
    const stop = await this.s.get(prepStopKey(id));
    if (!lab || lab.endRetry || lab.expiresAt <= now() || stop || this.#prepStopped.has(id)) return fail(410, '수업이 끝났거나 지워졌습니다.');
    return { id: lab.id, name: lab.name, createdAt: lab.createdAt, expiresAt: lab.expiresAt, seatCount: lab.seats.length, failedSeats: lab.seats.filter((x) => !!x.error).length };
  }

  async #labCreateDaytonaStamp() {
    const p = await this.s.get<StoredProvider>('prov:daytona');
    return p ? sha(JSON.stringify({ gen: p.gen, iv: p.iv, ct: p.ct, upstream: p.upstream, api: this.env.LAB_DAYTONA_API ?? '' })) : 'unconfigured';
  }

  async #labCreateValidate(input: LabInput) {
    if ((await this.s.list({ prefix: 'labcreatecleanup:', limit: 257 })).size >= 256) return fail(429, '수업 자원 정리를 먼저 확인하세요.');
    let parentId: string | undefined, parentFingerprint: string | undefined;
    const openRequestId = typeof input.openRequestId === 'string' && /^[0-9a-f-]{36}$/.test(input.openRequestId) ? input.openRequestId : undefined;
    if (input.openRequestId !== undefined && !openRequestId) return fail(400, '개설 요청 ID가 올바르지 않습니다.');
    if (input.parentLabId !== undefined) {
      if (typeof input.parentLabId !== 'string' || !/^[\w-]{1,100}$/.test(input.parentLabId) || !openRequestId) return fail(400, '추가할 모임 정보가 올바르지 않습니다.');
      parentId = input.parentLabId;
      const parent = await this.s.get<Lab>(`lab:${parentId}`);
      if (!parent || parent.endRetry || parent.expiresAt <= now() || await this.s.get(prepStopKey(parentId))) return fail(410, '모임이 끝났습니다.');
      if (await this.s.get(trialReserveKey(parentId)) || await this.s.get(trialBindingKey(parentId))) return fail(409, '체험 연결 중인 모임에는 자리를 추가할 수 없습니다.');
      if (parent.seats.length >= LAB_MAX_SEATS) return fail(409, '이 모임의 자리 한도에 도달했습니다.');
      parentFingerprint = await sha(trialConfigText(parent) + '|' + parent.budget + '|' + parent.expiresAt);
      if(input.parentVersion!==undefined && input.parentVersion!==parentFingerprint)return fail(409,'승인 뒤 모임 조건이 바뀌었습니다.');
      input = { ...input, seats: 1, hours: 1, budget: parent.budget, cpu: parent.cpu, memory: parent.memory, disk: parent.disk,
        snapshot: parent.snapshot, model: parent.model, gw: parent.gw, materials: parent.materials ?? '', clipIn: parent.clip?.in !== false, clipOut: parent.clip?.out !== false,
        share: Object.fromEntries(Object.entries(parent.share ?? {}).filter(([,v]) => v.on).map(([k,v]) => [k,v.cap])) };
    }
    const v = labCreateInput(input, this.#labRules());
    if ('error' in v) return fail(400, v.error);
    const { model } = v;
    const shared = await this.labShareInput(input.share);
    if (isFail(shared)) return shared;
    if (!this.env.LAB_SEAT_DOMAIN) return fail(503, '자리 호스트(LAB_SEAT_DOMAIN)가 설정되지 않았습니다. *.shinick.dev route 를 연 뒤 켜세요 (wrangler.jsonc 주석).');
    const daytonaStamp = await this.#labCreateDaytonaStamp();
    const c = await this.daytona();
    if (isFail(c)) return c;
    if (daytonaStamp !== await this.#labCreateDaytonaStamp()) return fail(409, 'Daytona 공급자가 바뀌었습니다. 다시 확인하세요.');
    const or = (await this.listProviders()).find((p) => p.kind === 'openrouter-mint');
    if (!or) return fail(409, 'OpenRouter(관리 키) 공급자가 없습니다. kv.ps1 push 로 올리세요.');
    const known = await this.modelExists(model);
    if (known === false) return fail(400, `OpenRouter 에 ${model} 모델이 없습니다 (이름이 바뀌었거나 내려갔을 수 있음). openrouter.ai/models 에서 id 를 확인하세요.`);
    return { v, shared, c, or, clip: { in: input.clipIn !== false, out: input.clipOut !== false }, daytonaStamp, parentId, parentFingerprint, openRequestId };
  }

  #labCreateActive = 0;
  async #labCreateExecute(token: string, p: LabCreatePrepared, arm?: (id: string) => Promise<void>) {
    // 옛 ID 없는 호출도 포함: 정리 기록 255 + 동시에 최대 128×20자리로 새 기록 수가 묶인다.
    if (this.#labCreateActive >= 128) return fail(429, '다른 수업 만들기가 끝난 뒤 다시 시도하세요.');
    this.#labCreateActive++;
    try {
      if ((await this.s.list({ prefix: 'labcreatecleanup:', limit: 257 })).size >= 256) return fail(429, '수업 자원 정리를 먼저 확인하세요.');
      return await this.#labCreateRun(token, p, arm);
    }
    finally { this.#labCreateActive--; }
  }
  async #labCreateRun(token: string, p: LabCreatePrepared, arm?: (id: string) => Promise<void>) {
    const { v, shared, c, or, clip, daytonaStamp } = p;
    const { seats, budget, cpu, memory, disk, name, gw, snapshot, model, mat } = v;
    if (p.demoFor && !await this.#demoLiveLab(p.demoFor)) return fail(410, '모임이 끝났습니다.');
    let hours = v.hours;
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    // 직접 입력 사양: 저장·서브키·샌드박스 전에 그 사양의 스냅샷이 Daytona 에 active·같은 사양으로 있는지 (기본 세 가지는 예전 그대로 묻지 않음).
    // 없으면 자동 준비를 시작하고 202 준비 중을 돌려준다 — ID 호출은 labcreate/snapjob 기록만, 수업 자원은 만들지 않는다
    if (!labIsPreset({ cpu, memory, disk })) {
      const snap = await this.#snap.ensure(c, snapshot, { cpu, memory, disk });
      if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      if (isFail(snap) || isSnapPending(snap)) return snap;
    }
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (!p.demoFor && !p.parentId && !p.openRequestId) await this.s.put('labcfg', { gw, snapshot, model, clip, share: Object.fromEntries(Object.entries(shared.share).map(([k, v]) => [k, v.cap])) } satisfies LabCfg);

    const id = p.parentId ?? rand(6).replace(/[-_]/g, 'x').toLowerCase();
    let lab: Lab = {
      id, name, createdAt: now(), expiresAt: Math.min(now() + hours * 3600e3, p.demoExpiresAt ?? Infinity), budget, cpu, memory, disk, snapshot, model, gw,
      ...(p.demoFor ? { teacherDemoFor: p.demoFor } : {}),
      seats: Array.from({ length: seats }, (_, i) => ({ n: i + 1, code: rand(12), label: newSeatLabel(), ...(p.openRequestId ? { openRequestId: p.openRequestId } : {}) })),
      materials: mat || undefined, clip,
      share: shared.defs.length ? shared.share : undefined,
    };
    // 샌드박스를 만들기 전에 먼저 저장 → 중간에 실패해도 알람·끝내기가 정리할 수 있다
    if (arm) await arm(id);
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (p.parentId) {
      const added = await this.s.transaction(async tx => {
        const parent = await tx.get<Lab>(`lab:${id}`);
        if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
        if (!parent || parent.endRetry || parent.expiresAt <= now() || await tx.get(prepStopKey(id))) return fail(410, '모임이 끝났습니다.');
        if (await tx.get(trialReserveKey(id)) || await tx.get(trialBindingKey(id))) return fail(409, '체험 연결 중인 모임입니다.');
        if (parent.seats.length >= LAB_MAX_SEATS || parent.seats.some(s => s.openRequestId === p.openRequestId)) return fail(409, '이미 추가했거나 자리 한도에 도달했습니다. 결과를 확인하세요.');
        if (await sha(trialConfigText(parent) + '|' + parent.budget + '|' + parent.expiresAt) !== p.parentFingerprint) return fail(409, '모임 구성이 바뀌었습니다. 다시 확인하세요.');
        const seat: Seat = { n: Math.max(0, ...parent.seats.map(s => s.n)) + 1, code: rand(12), label: newSeatLabel(), openRequestId: p.openRequestId };
        const updated = { ...parent, seats: [...parent.seats, seat] };
        await tx.put({ [`lab:${id}`]: updated, [`seat:${seat.code}`]: { lab: id, n: seat.n } });
        return updated;
      });
      if (isFail(added)) return added;
      lab = added; hours = (lab.expiresAt - now()) / 3600e3;
    } else await this.s.put({ [`lab:${id}`]: lab, ...Object.fromEntries(lab.seats.map((x) => [`seat:${x.code}`, { lab: id, n: x.n }])) });
    await this.schedule(lab.expiresAt);

    const active = async () => {
      if (p.demoFor && !await this.#demoLiveLab(p.demoFor)) throw fail(410, '모임이 끝났습니다.');
      if (!(await this.checkAdmin(token))) throw fail(401, '관리 세션이 만료됐습니다.');
      const alive = await this.#labCreateSummary(id);
      if (isFail(alive)) throw alive;
      if(p.parentId){const current=await this.s.get<Lab>(`lab:${id}`);if(!current || await sha(trialConfigText(current)+'|'+current.budget+'|'+current.expiresAt)!==p.parentFingerprint)throw fail(409,'승인 뒤 모임 조건이 바뀌었습니다.');}
    };
    const storeCreationSeat = async (seat: Seat) => {
      await this.s.transaction(async (txn) => {
        const cur = await txn.get<Lab>(`lab:${id}`);
        const stop = await txn.get(prepStopKey(id));
        if (!cur || cur.endRetry || cur.expiresAt <= now() || stop || this.#prepStopped.has(id)) throw fail(410, '수업이 끝났습니다.');
        const x = cur.seats.find((x) => x.n === seat.n && x.code === seat.code);
        if (!x) throw fail(410, '수업이 끝났습니다.');
        x.sid = seat.sid; x.sandboxId = seat.sandboxId; x.error = seat.error;
        await txn.put(`lab:${id}`, cur);
      });
    };
    const operationSeats = p.parentId ? lab.seats.filter(s => s.openRequestId === p.openRequestId) : lab.seats;
    const settled = await Promise.allSettled(operationSeats.map(async (seat) => {
      let sid: string | undefined, sb: Sandbox | undefined;
      const cleanupKey = `labcreatecleanup:${id}:${seat.n}`;
      try {
        await active();
        const ns = await this.newSession([or.id, ...shared.defs.map((d) => d.id)], or, budget, Math.max(1,lab.expiresAt-now()), { ip: 'lab', country: '', city: name, ua: `공부방 ${seat.n}번` }, id, gensOf([or, ...shared.defs]), undefined, undefined, active);
        if (isFail(ns)) { await active(); seat.error = ns.error; await storeCreationSeat(seat); return; }
        sid = ns.sid; seat.sid = sid;
        await storeCreationSeat(seat);
        await active();
        if (daytonaStamp !== await this.#labCreateDaytonaStamp()) throw fail(409, 'Daytona 공급자가 바뀌었습니다. 수업 목록을 확인하세요.');
        await active();
        try {
          const got = await dt<Sandbox>(c, 'POST', '/sandbox', labSandboxBody(lab, seat.n, ns.token, or.id, hours, shared.defs));
          if (typeof got?.id !== 'string' || !/^[\w-]{1,128}$/.test(got.id)) throw new Error('알 수 없는 실습실 응답');
          sb = got;
        }
        catch {
          await active();
          seat.error = '실습실 만들기 결과를 확인하지 못했습니다. 수업 끝내기로 정리하세요.';
          const sess = await this.s.get<Session>(`sess:${sid}`);
          if (sess) await this.endSession(sess);
          seat.sid = undefined;
          await storeCreationSeat(seat);
          return;
        }
        // 응답으로 확인된 자원은 자리 쓰기가 거부돼도 정리할 수 있게 먼저 남긴다.
        await this.s.put(cleanupKey, { labId: id, sandboxId: sb.id, provider: daytonaStamp, due: now() + 5 * 60e3 });
        await this.schedule(now() + 5 * 60e3);
        seat.sandboxId = sb.id;
        await storeCreationSeat(seat);
        await active();
        await this.s.delete(cleanupKey);
        if (sb.organizationId) await this.s.put('laborg', sb.organizationId);
      } catch (e) {
        // 끝내기와 겹쳐 늦게 도착한 알려진 자원. 세션은 기존 폐기 재시도, 샌드박스는 고정 ID만 정리한다.
        if (sid) {
          try { const sess = await this.s.get<Session>(`sess:${sid}`); if (sess) await this.endSession(sess); }
          catch { /* 저장소 장애 때도 알려진 샌드박스 정리는 별도로 시도한다. 세션 기록은 기존 알람이 본다. */ }
        }
        if (sb) {
          try { await dt(c, 'DELETE', `/sandbox/${encodeURIComponent(sb.id)}`, undefined, AbortSignal.timeout(10e3)); await this.s.delete(cleanupKey); }
          catch { await this.s.put(cleanupKey, { labId: id, sandboxId: sb.id, provider: daytonaStamp, due: now() + 5 * 60e3 }); await this.schedule(now() + 5 * 60e3); }
        }
        throw e;
      }
    }));
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
    await active();
    const bad = operationSeats.filter((x) => x.error).length;
    await this.audit('lab-create', null, null, `${name} ${seats}명 ${hours}h $${budget} ${cpu}/${memory}/${disk} 클립보드 ${clipText(clip)}${shared.defs.length ? ` 공유 ${shared.defs.map((d) => `${d.id}(${shared.share[d.id].cap}회)`).join(',')}` : ''}${bad ? ` 실패 ${bad}` : ''}`);
    await this.#prepEnqueue(id);
    await active();
    return { labId: id };
  }

  async #labCreateCleanup(t: number) {
    const prefix = 'labcreatecleanup:', cursorKey = 'labcreatecleanup-cursor';
    const saved = await this.s.get<{ after: string; due?: number }>(cursorKey);
    const cursor = saved && typeof saved.after === 'string' && saved.after.startsWith(prefix) && saved.after.length <= 128 ? saved : undefined;
    let next = cursor && typeof cursor.due === 'number' && Number.isFinite(cursor.due) ? cursor.due : Infinity;
    let attempts = 0;
    // 하나는 다음 페이지가 있는지 보는 용도. 커서 행이 지워져도 startAfter는 그대로 이어간다.
    const listed = [...await this.s.list<{ labId: string; sandboxId: string; provider: string; due: number }>({ prefix, limit: 257, ...(cursor ? { startAfter: cursor.after } : {}) })];
    const entries = listed.slice(0, 256);
    for (const [key, item] of entries) {
      const lab = await this.s.get<Lab>(`lab:${item.labId}`);
      if (lab?.seats.some((s) => s.sandboxId === item.sandboxId)) { await this.s.delete(key); continue; }
      if (item.due > t) { next = Math.min(next, item.due); continue; }
      // 원래 세대와 다르면 자동 삭제하지 않는다. 운영자가 원래 Daytona 조직에서 정리해야 한다.
      if (attempts >= 4) { next = Math.min(next, t + 60e3); continue; }
      const matches = item.provider === await this.#labCreateDaytonaStamp();
      const c = matches ? await this.daytona() : fail(409, '공급자가 바뀌었습니다.');
      let gone = false;
      if (!isFail(c) && item.provider === await this.#labCreateDaytonaStamp()) {
        attempts++;
        try { await dt(c, 'DELETE', `/sandbox/${encodeURIComponent(item.sandboxId)}`, undefined, AbortSignal.timeout(10e3)); gone = true; }
        catch (e) { gone = e instanceof DtError && e.status === 404; }
      }
      if (gone) await this.s.delete(key);
      else { item.due = t + 5 * 60e3; await this.s.put(key, item); next = Math.min(next, item.due); }
    }
    if (listed.length > entries.length) {
      await this.s.put(cursorKey, { after: entries[entries.length - 1][0], ...(next < Infinity ? { due: next } : {}) });
      return t + 60e3; // 모두 다른 세대·미래 시각이어도 뒷페이지는 반드시 확인한다.
    }
    await this.s.delete(cursorKey);
    // 끝난/지워진 커서 뒤가 비어 있어도 앞쪽에 남은 행은 다음 순회에서 본다 (읽기는 한 행만).
    if (cursor) {
      const first = (await this.s.list<{ due: number }>({ prefix, limit: 1 })).values().next().value;
      if (first) next = Math.min(next, entries.length ? first.due : t + 60e3);
    }
    return next <= t ? t + 60e3 : next;
  }

  // 직접 입력 사양 스냅샷 자동 준비 (lab-snapshot-service.ts). 정해진 Daytona 주소(c.api)의 /snapshots 만 — 공급자 응답 본문·키·레시피는 돌려주지도 저장하지도 않는다
  protected snapshotTimeouts() { return SNAP_TIMEOUTS; }
  readonly #snap = new LabSnapshotService({
    storage: this.ctx.storage,
    now: () => now(),
    timeouts: () => this.snapshotTimeouts(),
  });

  /**
   * 강사 /lab: 직접 입력 사양의 스냅샷 준비 (POST /api/lab/snapshot). 부를 때마다 관리 토큰부터, 그다음 이름·사양 확인 — 둘 다 맞아야 Daytona 를 부른다.
   * 받는 것은 기본 이름(snapshot)·cpu·memory·disk 뿐. 202 준비 중 · { snapshotReady } · Fail. 수업·세션·자리·샌드박스는 만들지 않는다
   */
  async labSnapshotPrepare(token: string, input: { snapshot?: unknown; cpu?: unknown; memory?: unknown; disk?: unknown }) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const r = labResourcesOf(input);
    if (!r) return fail(400, '사양이 올바르지 않습니다.');
    if (labIsPreset(r)) return fail(400, '기본 사양은 따로 준비하지 않습니다.');
    const raw = input.snapshot;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return fail(400, '스냅샷·모델 이름이 올바르지 않습니다.');
    const base = (raw ?? '').trim() || LAB_DEFAULT.snapshot;
    if (!/^[\w./:-]{1,120}$/.test(base) || labSnapshotName(base, r).length > 120) return fail(400, '스냅샷·모델 이름이 올바르지 않습니다.');
    const c = await this.daytona();
    if (isFail(c)) return c;
    return this.#snap.ensure(c, base, r);
  }

  async labList(token: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const labs = [...(await this.s.list<Lab>({ prefix: 'lab:' })).values()].filter(l => !l.teacherDemoFor).sort((a, b) => b.createdAt - a.createdAt);
    const c = await this.daytona();
    const views = [];
    for (const lab of labs) {
      const v = this.labView(lab);
      if (!isFail(c)) {
        try {
          const list = await this.labSandboxes(c, lab.id);
          const st = new Map(list.map((x) => [x.id, x.state]));
          const org = list.find((x) => x.organizationId)?.organizationId;
          if (org && org !== (await this.s.get<string>('laborg'))) await this.s.put('laborg', org);
          for (const s of v.seats) s.state = s.sandboxId ? (st.get(s.sandboxId) ?? 'gone') : undefined;
        } catch (e) { v.stateError = e instanceof Error ? e.message : String(e); }
      }
      await Promise.all(lab.seats.map(async (seat, i) => {
        const vs = v.seats[i];
        vs.preparation = preparationView(lab, seat, await this.s.get(prepJobKey(seat.code)), now());
        if (!seat.sid) return;
        const e = await this.s.get<LabErr>(`lerr:${seat.sid}`);
        if (e && now() - e.at < LAB_ERR_RECENT) vs.err = e;
        const u = await this.seatUsage(seat.sid);
        if (u) { vs.usage = u.usage; vs.limit = u.limit; }
        if (lab.share) vs.counts = (await this.s.get<Session>(`sess:${seat.sid}`))?.counts ?? {};
      }));
      // 입장한 자리 절반 이상(2자리 이상)이 5분 안에 오류 → 모델·OpenRouter·게이트웨이 쪽 전체 문제일 가능성
      const recent = v.seats.filter((x) => x.err && now() - x.err.at < 5 * 60e3);
      const opened = v.seats.filter((x) => x.opened).length;
      if (recent.length >= 2 && recent.length * 2 >= opened) v.outage = `${recent.length}자리에서 최근 5분 안에 오류 — 예: ${recent[0].err!.status} ${recent[0].err!.msg}`;
      // 참가자 상태(메모리) + 그 자리 가짜 토큰으로 게이트웨이를 마지막으로 쓴 시각 (세션에서는 lastUsed 만 꺼낸다)
      const pres = await Promise.all(lab.seats.map(async (seat) => {
        const receipt = await this.#files.read(seat.code), transfer = isFail(receipt) ? null : receipt.transfer;
        return { presence: await this.seatPresence(seat.code), lastAi: seat.sid ? (await this.s.get<Session>(`sess:${seat.sid}`))?.lastAi : undefined,
          files: transfer ? { at: transfer.at, verifiedAt: transfer.verifiedAt } : null };
      }));
      const trial = await this.s.get<TrialReservation>(trialReserveKey(lab.id));
      const delivery = await this.#terminal.delivery(lab.id);
      views.push({ ...v, trialOf: trial?.parentId, seats: v.seats.map((s, i) => {
        const last = delivery.find(r => r.n === s.n);
        return { ...s, ...pres[i], delivery: last ? { status: last.status, at: last.at } : { status: 'unknown' as const, at: null } };
      }) });
    }
    return { labs: views, quota: await this.labQuota(), now: now() }; // now: 화면이 '몇 분 전'을 셀 때 서버 시계 기준으로
  }

  async labEnd(token: string, id: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    const ok = await this.endLab(lab, 'end');
    return ok ? { ok: true } : fail(502, '일부 샌드박스를 지우지 못했습니다. 5분 뒤 자동으로 다시 시도합니다.');
  }

  /**
   * 예전 수업 링크(QR·수업 코드). 공용 코드로는 자리를 주지 않는다 (#14 — 남의 이름·빈 자리 가로채기).
   * 자리는 강사가 자리마다 따로 주는 초대 링크(/j/<자리 코드>)로만 들어온다
   */
  async labClaim() {
    return fail(410, '이 수업은 자리마다 따로 받은 초대 링크로 들어옵니다. 강사에게 내 초대 링크를 받으세요.');
  }

  /** 강사: 자리 초대 링크 (n 이 있으면 그 자리 하나, 없으면 쓸 수 있는 자리 전부). 목록(labList)에는 자리 코드를 싣지 않는다 */
  async labInvite(token: string, id: string, n?: number) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    if (lab.expiresAt <= now() || lab.endRetry) return fail(410, '수업이 끝났습니다.');
    if (lab.teacherDemoFor || await this.s.get(trialReserveKey(id))) return fail(409, '모임지기 전용 실습실에는 참여자를 초대할 수 없습니다.');
    const seats = lab.seats.filter((x) => x.sandboxId && !x.error && (n === undefined || x.n === n));
    if (n !== undefined && !seats.length) return fail(404, '없는 자리이거나 준비에 실패한 자리입니다.');
    let changed = false;
    for (const x of seats) if (!x.label) { x.label = newSeatLabel(); changed = true; }
    if (changed) await this.s.put(`lab:${lab.id}`, lab);
    await this.audit('lab-invite', null, null, `${lab.name} ${n === undefined ? `전부 ${seats.length}자리` : `${n}번`}`);
    return { name: lab.name, seats: seats.map((x) => ({ n: x.n, who: x.who ?? '', code: x.code })) };
  }

  /** 초대 링크 화면(GET, 쿠키 없음)·자리 호스트 입장(POST)이 묻는다: 이 자리의 호스트 이름과 수업 정보. 예전 수업이면 이름을 여기서 채운다 */
  async labSeatInfo(code: string) {
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    if (lab.teacherDemoFor) return fail(403, '모임지기 화면에서 시연실을 여세요.');
    return { label: seat.label!, name: lab.name, seat: seat.n, who: seat.who ?? '', expiresAt: lab.expiresAt, model: lab.model };
  }

  /** 자리 깨우기: 샌드박스 켜기 → 수업 자료 넣기 → code-server 켜기 (#prep.ensure — 미리 준비 중이면 그 일을 같이 기다린다).
   *  ready 가 되면 초대 화면이 자리 호스트로 POST 한다. 이름·opened·입장 감사 기록은 여기(실제 입장)에서만 쓴다 */
  async labJoin(code: string, name = '') { return this.#demoJoin(code, name, false); }
  async #demoJoin(code: string, name: string, allowDemo: boolean) {
    const t = labTimer(); // total은 이 요청, prep_*는 같이 기다리는 준비 일의 관측 시간
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    if (lab.teacherDemoFor && (!allowDemo || !await this.#demoLiveLab(lab.teacherDemoFor))) return fail(403, '모임지기 화면에서 시연실을 여세요.');
    const ref: PrepRef = { labId: lab.id, n: seat.n, code: seat.code, sandboxId: seat.sandboxId };
    const who = labJoinName(name);
    if (who && !seat.who) { // 이름은 비어 있을 때 한 번만 (다른 자리를 고르는 데는 안 쓴다)
      const named = await this.#seatPatch(ref, (s, got) => got.get(trialReserveKey(lab.id)) ? 'deny' : (s.who ? 'keep' : (s.who = who, 'write')), [trialReserveKey(lab.id)]);
      if (!named) return fail(410, '수업이 끝났습니다.');
      if (named.wrote) await this.audit('lab-name', labSeatSid(named.seat), null, `${lab.name} ${seat.n}번 ${who}`);
      seat.who = named.seat.who;
    }
    const info = labJoinInfo(lab, seat);
    const c = await this.daytona();
    if (isFail(c)) return c;
    let r;
    try { r = await this.#prep.ensure(ref); } catch (e) { return fail(502, labErrorText(e)); }
    if (r.status === 'gone') return fail(410, '수업이 끝났습니다.');
    if (r.status === 'error') return fail(502, r.message);
    if (r.status === 'starting') return withLabTiming(labStarting(info, r.detail), t, r.prepTiming);
    // ready: 자리·수업·끝 시각·끝내는 중·멈춤을 다시 보고 opened 만 적는다 (자료 경고는 지금 저장된 setup 으로)
    // 자료 넣기가 아직 '진행 중' 이거나 끝났는지 모르면(서버 재시작·시간 초과) ready 로 보지 않는다 (opened 도 안 적음)
    // 트랜잭션 콜백은 다시 불릴 수 있다 — 콜백 밖 변수에 적지 않고, 진행 중·알 수 없음은 커밋된 결과(open.seat.setup)로 본다
    const open = await this.#seatPatch(ref, (s, got) => got.get(trialReserveKey(lab.id)) ? 'deny' : (s.setup?.state === 'running' || prepUncertain(s.setup) || s.opened ? 'keep' : (s.opened = now(), 'write')), [trialReserveKey(lab.id)]);
    if (!open) return fail(410, '수업이 끝났습니다.');
    if (open.seat.setup?.state === 'running') return withLabTiming(labStarting(info, '수업 자료를 넣는 중'), t, r.prepTiming);
    if (prepUncertain(open.seat.setup)) return fail(502, PREP_UNCERTAIN);
    if (open.wrote) await this.audit('lab-join', labSeatSid(open.seat), null, labSeatTag(open.lab, open.seat));
    return withLabTiming(labReady(labJoinInfo(open.lab, open.seat), open.seat.setup), t, r.prepTiming);
  }

  /** 실습실 호스트가 요청마다(캐시 30초) 묻는다: 이 쿠키의 code-server 는 어디이고 토큰은 무엇인지.
   *  시연실만: 부모 모임이 미리보기 조회 앞뒤로 살아 있을 때 demoParent 를 붙인다. 끝났거나 멈추거나 없으면 경로를 닫는다. */
  async labRoute(code: string): Promise<{ origin: string; token: string; expiresAt: number; seat: number; label: string; clip: { in: boolean; out: boolean }; demoParent?: string } | Fail> {
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    const demoParent = lab.teacherDemoFor;
    if (demoParent && !await this.#demoLiveLab(demoParent)) return fail(410, '모임이 끝났습니다.');
    if (!seat.pv) {
      const c = await this.daytona();
      if (isFail(c)) return c;
      let pv: { origin: string; token: string };
      try {
        const x = await dt<{ url: string; token: string }>(c, 'GET', `/sandbox/${seat.sandboxId}/ports/${LAB_PORT}/preview-url`);
        pv = { origin: new URL(x.url).origin, token: x.token };
      } catch (e) { return fail(502, e instanceof Error ? e.message : String(e)); }
      // 바깥 호출 뒤: 지금 수업·자리에 pv 만 적는다 (오래된 자리 통째로 덮지 않음, 끝난 수업이면 쓰지 않음)
      const saved = await this.#seatPatch({ labId: lab.id, n: seat.n, code: seat.code, sandboxId: seat.sandboxId! }, (s) => (s.pv = pv, 'write'));
      if (!saved) return fail(410, '수업이 끝났습니다.');
      seat.pv = pv;
    }
    if (demoParent && !await this.#demoLiveLab(demoParent)) return fail(410, '모임이 끝났습니다.');
    const route = { origin: seat.pv.origin, token: seat.pv.token, expiresAt: lab.expiresAt, seat: seat.n, label: seat.label!, clip: lab.clip ?? CLIP_OPEN };
    return demoParent ? { ...route, demoParent } : route;
  }

  /** 참가자 화면 위 막대(/__lab/bar.js)가 30초마다 부른다. sig 가 있으면(POST) 참가자 상태 신호도 적는다 — 자리는 쿠키로만 정해진다 */
  async labMe(code: string, sig?: unknown) {
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    if (sig !== undefined) await this.notePresence(seat.code, sig);
    const u = seat.sid ? await this.seatUsage(seat.sid) : null;
    const lesson = await this.#terminal.seatState(lab.id, seat.n);
    const files = await this.#files.read(code);
    return { name: lab.name, seat: seat.n, who: seat.who ?? '', expiresAt: lab.expiresAt, now: now(), model: lab.model, usage: u?.usage ?? null, limit: u?.limit ?? lab.budget, hand: !!seat.hand, clip: lab.clip ?? CLIP_OPEN, lesson, files: isFail(files) ? { transfer: null } : files };
  }

  /** 참가자 ✋ 손 들기·내리기 */
  async labHand(code: string, up: boolean) {
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const { lab, seat } = got;
    const ref: PrepRef = { labId: lab.id, n: seat.n, code: seat.code, sandboxId: seat.sandboxId };
    const push = up && (await this.#push.available()); // 설정 값 (재시도해도 같다)
    // 손 필드만 (한 트랜잭션에서 다시 읽음) — 미리 준비가 적은 setup 을 오래된 자리로 덮지 않는다.
    // 이미 든 손은 그대로 (시각을 바꾸지 않음). 새로 든 손만 같은 트랜잭션에서 알림 일을 넣고, 내린 손은 그 자리 일을 뺀다 (바깥 호출 없음)
    const r = await this.#seatPatch(ref, (s) => {
      if (up ? s.hand : !s.hand) return 'keep';
      s.hand = up ? now() : undefined;
      return 'write';
    }, [PUSH_OUTBOX], (s, g) => {
      const box = g.get(PUSH_OUTBOX) as PushOutbox | undefined;
      const nb = s.hand ? (push ? pushEnqueue(box, ref, s.hand, s.hand) : null) : pushDropSeat(box, ref.labId, ref.n);
      return nb ? { [PUSH_OUTBOX]: nb } : null;
    });
    if (!r) return fail(410, '수업이 끝났습니다.');
    if (r.also && r.seat.hand) {
      // 커밋된 새 손만: 처리가 죽어도 알람이 임차 뒤 다시 잡는다. 보내기는 응답을 기다리게 하지 않는다
      await this.schedule(now() + PUSH_LEASE);
      this.ctx.waitUntil(this.#push.kick());
    }
    return { hand: up };
  }

  /** 강사가 수업 중에 클립보드 방향별 허용을 바꾼다 (참가자 화면에는 30초 안에 반영) */
  async labSetClip(token: string, id: string, clip: Partial<Clip>) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    lab.clip = { in: clip.in !== false, out: clip.out !== false };
    await this.s.put(`lab:${id}`, lab);
    await this.audit('lab-clip', null, null, `${lab.name} ${clipText(lab.clip)}`);
    return { ok: true, clip: lab.clip };
  }

  /** 강사가 수업 중에 공유 공급자를 켜고 끄거나 자리당 상한을 바꾼다. 게이트웨이가 호출마다 수업을 보므로 바로 반영 */
  async labSetShare(token: string, id: string, provider: string, on: unknown, cap: unknown) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    const sh = lab.share?.[provider];
    if (!sh) return fail(400, '이 수업을 만들 때 고른 공급자만 켜고 끌 수 있습니다.');
    if (on !== undefined && typeof on !== 'boolean') return fail(400, 'on 은 true/false');
    if (cap !== undefined && !this.okCap(cap)) return fail(400, `상한은 1~${LAB_SHARE_CAP}회`);
    if (typeof on === 'boolean') sh.on = on;
    if (cap !== undefined) sh.cap = Number(cap);
    await this.s.put(`lab:${id}`, lab);
    await this.audit('lab-share', null, null, `${lab.name} ${provider} ${sh.on ? '켬' : '끔'} 자리당 ${sh.cap}회`);
    return { ok: true, share: { id: provider, ...sh } };
  }

  /** 샌드박스의 lab-status·lab-doctor 가 가짜 토큰으로 묻는다: 이 자리에서 쓸 수 있는 공유 키와 남은 호출 수 (upstream 은 안 부름, 세지 않음) */
  async labShareStatus(token: string) {
    const sid = await this.s.get<string>(`tok:${await sha(token)}`);
    const sess = sid ? await this.s.get<Session>(`sess:${sid}`) : undefined;
    if (!sess || sess.revoked || sess.expiresAt <= now()) return fail(401, 'invalid or expired token');
    const lab = sess.lab ? await this.s.get<Lab>(`lab:${sess.lab}`) : undefined;
    if (!lab || lab.endRetry || lab.expiresAt <= now()) return fail(401, '수업이 끝났습니다.');
    const defs = new Map((await this.getProviders(Object.keys(lab.share ?? {}))).map((d) => [d.id, d]));
    return {
      providers: Object.entries(lab.share ?? {}).map(([id, sh]) => ({
        id, label: sh.label, on: sh.on && !!defs.get(id) && labShareable(defs.get(id)!) && grantOk(sess, defs.get(id)!), cap: sh.cap, used: sess.counts?.[id] ?? 0,
        envKey: defs.get(id)?.envKey ?? null, envBase: defs.get(id)?.envBase ?? null,
      })),
    };
  }

  private okCap(x: unknown) { const n = Number(x); return typeof x === 'number' && Number.isInteger(n) && n >= 1 && n <= LAB_SHARE_CAP; }

  /** 수업 만들기 입력의 share = { 공급자 id: 자리당 호출 상한 }. 없는 공급자·공유 불가(Daytona·서브키 발급형·표시 안 함)·범위 밖은 거부 */
  private async labShareInput(input: unknown): Promise<{ share: Record<string, LabShare>; defs: StoredProvider[] } | Fail> {
    if (input === undefined || input === null) return { share: {}, defs: [] };
    if (typeof input !== 'object' || Array.isArray(input)) return fail(400, 'share 는 { 공급자: 상한 } 형식');
    const ids = Object.keys(input);
    if (ids.length > LAB_SHARE_MAX) return fail(400, `나눠 줄 공급자는 ${LAB_SHARE_MAX}개까지`);
    const share: Record<string, LabShare> = {};
    const defs: StoredProvider[] = [];
    const names = new Set<string>();
    for (const id of ids) {
      const d = /^[a-z0-9-]{1,24}$/.test(id) ? await this.s.get<StoredProvider>(`prov:${id}`) : undefined;
      if (!d) return fail(400, `없는 공급자입니다: ${id.slice(0, 24)}`);
      if (!labShareable(d)) return fail(400, `${d.label} 은(는) 실습실에 나눠 줄 수 없습니다 (/admin 에서 '실습실에 나눠 줄 수 있음' 표시 · Daytona·OpenRouter 는 안 됨)`);
      const cap = (input as Record<string, unknown>)[id];
      if (!this.okCap(cap)) return fail(400, `${d.label} 자리당 상한은 1~${LAB_SHARE_CAP}회`);
      for (const e of [d.envKey, d.envBase].filter((x): x is string => !!x)) {
        if (LAB_ENV_RESERVED.test(e) || names.has(e)) return fail(400, `${d.label} 의 환경변수 ${e} 가 실습실 기본값이나 다른 공급자와 겹칩니다`);
        names.add(e);
      }
      share[id] = { label: d.label, on: true, cap: Number(cap) };
      defs.push(d);
    }
    return { share, defs };
  }

  /** 강사가 손 내려 주기 */
  async labHandClear(token: string, id: string, n: number) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    // 손 필드만: 읽기·쓰기를 한 트랜잭션으로 (다른 자리 필드·미리 준비가 적은 setup 은 그대로)
    const ok = await this.s.transaction(async (txn) => {
      const lab = await txn.get<Lab>(`lab:${id}`);
      const seat = lab?.seats.find((x) => x.n === n);
      if (!lab || !seat) return false;
      seat.hand = undefined;
      await txn.put(`lab:${lab.id}`, lab);
      const box = pushDropSeat(await txn.get<PushOutbox>(PUSH_OUTBOX), lab.id, n); // 그 자리 알림 일도 (보내기 전 확인이 한 번 더 본다)
      if (box) await txn.put(PUSH_OUTBOX, box);
      return true;
    });
    if (!ok) return fail(404, '없는 자리입니다.');
    return { ok: true };
  }

  // ── 내 작업 받기 (#11) ──
  // POST /__lab/export → labExportStart: 자리마다 하나(exp:<code>)·시작 사이 60초(expcd:<code>). 기록을 먼저 남기고(묶는 폴더 id 포함)
  //   샌드박스에서 묶는다 (lab.ts packWork: 1GiB·50,000개·링크/특수 파일 안 따라감). 성공하면 한 번 쓰는 표(60초)를 준다.
  // GET /__lab/export/<표> → labExportDownload: 표를 지우고(streaming) Daytona 에서 받은 스트림을 그대로 넘긴다 (Worker·브라우저 모두 통째로 안 담음).
  //   끝·오류·취소면 end 한 번 → 묶은 폴더 지우기 (expq:<id>, 실패하면 알람이 재시도). 만료(표 안 씀·묶기·받기 시간 초과)·재시작은 알람이 같은 길로
  //   받는 중(streaming) 기록은 이 인스턴스의 aborts 에 있어야 산 것이다. 재시작·축출로 없으면 주인 없는 기록 → 다음 시작이 한 번 정리하고 비운다
  protected exportTtl() { return { ticket: EXPORT_TICKET_TTL, stream: EXPORT_STREAM_MAX, pack: (EXPORT_LIMITS.seconds + 60) * 1000, cooldown: EXPORT_COOLDOWN }; }
  protected exportLimits() { return EXPORT_LIMITS; }
  protected exportZipMax() { return exportZipMax(this.exportLimits()); }

  readonly #files = new LabFileReceiptService({ storage: this.ctx.storage, now: () => now(), ref: code => this.#fileRef(code) });
  async #fileRef(code: string): Promise<FileRef | Fail> {
    const map = /^[\w-]{16}$/.test(code) ? await this.s.get<{lab: string; n: number}>(`seat:${code}`) : undefined;
    if (!map) return fail(404, '자리 확인이 필요합니다.');
    const got = await this.s.get<unknown>([`seat:${code}`, `lab:${map.lab}`, prepStopKey(map.lab), trialReserveKey(map.lab)]);
    const lab = got.get(`lab:${map.lab}`) as Lab | undefined, current = got.get(`seat:${code}`) as typeof map;
    const seat = lab?.seats.find(s => s.n === map.n && s.code === code);
    if (!current || current.lab !== map.lab || current.n !== map.n || !lab || !seat?.sandboxId || lab.expiresAt <= now() || lab.endRetry || got.get(prepStopKey(map.lab)) || this.#prepStopped.has(map.lab) || got.get(trialReserveKey(map.lab))) return fail(410, '자리 정보가 바뀌었거나 모임이 끝났습니다.');
    return { labId: lab.id, n: seat.n, code, sandboxId: seat.sandboxId };
  }
  async #fileEffect<T>(code: string, sandboxId: string, effect: () => Promise<T>): Promise<T> {
    const ref = await this.#fileRef(code); if (isFail(ref) || ref.sandboxId !== sandboxId) throw Error('seat changed');
    const got = await this.s.get<unknown>([`seat:${code}`, `lab:${ref.labId}`, prepStopKey(ref.labId), trialReserveKey(ref.labId)]);
    if (!this.#prepSeat(got.get(`seat:${code}`), got.get(`lab:${ref.labId}`) as Lab | undefined, ref) || got.get(prepStopKey(ref.labId)) || this.#prepStopped.has(ref.labId) || got.get(trialReserveKey(ref.labId))) throw Error('seat changed or ended');
    return effect();
  }
  async labFileReceipt(code: string) { return this.#files.read(code); }
  async labFileAcknowledge(code: string, receiptId: unknown) { return this.#files.acknowledge(code, receiptId); }

  readonly #export = new LabExportService({
    storage: this.ctx.storage,
    waitUntil: (p) => this.ctx.waitUntil(p),
    seatOf: (code) => this.seatOf(code),
    daytona: () => this.daytona(),
    schedule: (t) => this.schedule(t),
    audit: (event, sid, ip, detail) => this.audit(event, sid, ip, detail),
    ttl: () => this.exportTtl(),
    limits: () => this.exportLimits(),
    zipMax: () => this.exportZipMax(),
    perform: (code, sandboxId, effect) => this.#fileEffect(code, sandboxId, effect),
    transferred: item => this.#files.transferred(item),
    checkpoint: (code, id) => this.#checkpointArchive(code, id),
  });

  async labExportStart(code: string, checkpointId?: unknown) { return this.#export.start(code, checkpointId); }

  /** 한 번 쓰는 표로 내려받기. 표는 쓰는 순간 지운다 */
  async labExportDownload(code: string, ticket: string): Promise<Response> { return this.#export.download(code, ticket); }

  readonly #checkpoint = new LabCheckpointService({
    storage: this.ctx.storage, now: () => now(), authorize: (token, id) => this.#interruptAuthorize(token, id),
    context: (token, id) => this.#checkpointContext(token, id),
    remote: async (token, ref, record, gate) => {
      const c = await this.daytona(); if (isFail(c) || !gate()) throw Error('provider unavailable or ended');
      const sb = await dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(ref.sandboxId)}`, undefined, AbortSignal.timeout(15000));
      if (sb.id !== ref.sandboxId || sb.state !== 'started') throw Error('sandbox unavailable');
      const packed = await packWork(c, sb, record.requestId, CHECKPOINT_LIMITS, effect => this.#checkpointEffect(token, ref, record, gate, effect));
      return { entries: packed.entries, bytes: packed.bytes, size: packed.size, omitted: packed.skipped };
    },
    audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async labCheckpointCreate(token: string, id: string, requestId: unknown, seats: unknown, revision: unknown) { return this.#checkpoint.create(token, id, requestId, seats, revision); }
  async labCheckpointStatus(token: string, id: string) { return this.#checkpoint.status(token, id); }
  async #checkpointContext(token: string, id: string): Promise<CheckpointContext | Fail> {
    const owner = await sha(token), lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 실습실입니다.');
    const text = checkpointContextText(lab), fingerprint = await sha(text);
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${id}`, prepStopKey(id), controlKey(id), trialReserveKey(id)]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, fresh = got.get(`lab:${id}`) as Lab | undefined, control = controlView(got.get(controlKey(id)));
    if (!admin || admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    if (!fresh || fresh.expiresAt <= now() || fresh.endRetry || got.get(prepStopKey(id)) || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    if (got.get(trialReserveKey(id)) || control.mode !== 'paused' || checkpointContextText(fresh) !== text) return fail(409, '명령 전달을 일시정지한 뒤 현재 대상을 다시 확인하세요.');
    return { owner, revision: control.revision, fingerprint, refs: fresh.seats.filter(s => !!s.sandboxId).map(s => ({labId: id, n: s.n, code: s.code, sandboxId: s.sandboxId!})) };
  }
  async #checkpointEffect<T>(token: string, ref: CheckpointRef, record: CheckpointOperation, gate: () => boolean, effect: () => Promise<T>): Promise<T> {
    const owner = await sha(token), lab = await this.s.get<Lab>(`lab:${ref.labId}`);
    if (!lab) throw Error('class unavailable');
    const text = checkpointContextText(lab);
    if (await sha(text) !== record.fingerprint || record.owner !== owner) throw Error('checkpoint context changed');
    const key = checkpointOperationKey(ref.labId, record.requestId), got = await this.s.get<unknown>([`admin:${owner}`, `lab:${ref.labId}`, `seat:${ref.code}`, prepStopKey(ref.labId), controlKey(ref.labId), trialReserveKey(ref.labId), key]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, fresh = got.get(`lab:${ref.labId}`) as Lab | undefined, control = controlView(got.get(controlKey(ref.labId))), stored = got.get(key) as StoredCheckpoint | undefined;
    if (!admin || admin.expiresAt <= now() || !fresh || !this.#prepSeat(got.get(`seat:${ref.code}`), fresh, ref) || got.get(prepStopKey(ref.labId)) || this.#prepStopped.has(ref.labId) || got.get(trialReserveKey(ref.labId)) || !gate()) throw Error('authorization expired or class ended');
    if (control.mode !== 'paused' || control.revision !== record.revision || checkpointContextText(fresh) !== text) throw Error('checkpoint context changed');
    if (!stored || stored.requestId !== record.requestId || stored.createdAt !== record.createdAt || stored.revision !== record.revision || !Array.isArray(stored.seats) || stored.seats.length !== record.refs.length || !stored.seats.every((s,i) => record.refs[i]?.labId === ref.labId && record.refs[i].n === s.n && record.refs[i].code === s.code && record.refs[i].sandboxId === s.sandboxId) || !Array.isArray(stored.results) || !stored.results.some(r => r.n === ref.n && r.status === 'pending')) throw Error('checkpoint intent changed');
    return effect(); // No await from the final storage/auth checks to the provider effect.
  }
  async #checkpointArchive(code: string, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return fail(400, '체크포인트를 다시 선택하세요.');
    const ref = await this.#fileRef(code); if (isFail(ref)) return ref;
    const row = await this.s.get(checkpointOperationKey(ref.labId, id)), fresh = await this.#fileRef(code);
    if (isFail(fresh)) return fresh;
    const archive = fresh.labId === ref.labId && fresh.n === ref.n && fresh.sandboxId === ref.sandboxId ? checkpointArchive(row, fresh, id, now()) : null;
    return archive ?? fail(409, '현재 자리의 사용 가능한 체크포인트가 아닙니다.');
  }
  readonly #recovery = new LabSeatRecoveryService({
    storage: this.ctx.storage, now: () => now(), authorize: (token, id) => this.#interruptAuthorize(token, id),
    context: async (token, id, n) => {const s = await this.#recoverySnapshot(token, id, n);return isFail(s) ? s : s.context},
    validateContext: (context, tx, file) => this.#recoveryValidate(context, tx, file),
    run: (token, record, gate) => this.#recoveryRun(token, record, gate, recoveryOperationKey(record.ref.labId, record.requestId), recoveryActiveKey(record.ref.labId, record.ref.n)),
    observe: (_token, record) => this.#recoveryObserve(record), audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async labRecoveryContext(token: string, id: string, n: unknown) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (typeof n !== 'number') return fail(400, '복구할 자리를 선택하세요.');
    const s = await this.#recoverySnapshot(token, id, n); if (isFail(s)) return s;
    const active = await this.s.get<string>(recoveryActiveKey(id, n));
    const operation = active ? await this.#recovery.status(token, id, active) : null;
    if (operation && isFail(operation)) return operation;
    const fresh = await this.#recoverySnapshot(token, id, n); if (isFail(fresh)) return fresh;
    if (fresh.context.ref.generation !== s.context.ref.generation || fresh.context.fingerprint !== s.context.fingerprint || fresh.control.revision !== s.control.revision) return fail(409, '자리 상태가 바뀌었습니다. 다시 확인하세요.');
    return {n, generation: s.context.ref.generation, revision: s.control.revision, verifiedFile: !!fresh.verifiedFileId,
      canRepair: !!fresh.seat.sandboxId, canReplace: !this.#recoveryBudget(fresh.session, fresh.lab, fresh.providerRows), operation};
  }
  async labRecoveryCreate(token: string, id: string, requestId: unknown, n: unknown, kind: unknown, generation: unknown, revision: unknown, ackDataLoss: unknown) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (typeof requestId === 'string' && /^[0-9a-f-]{36}$/.test(requestId) && typeof n === 'number' && (kind === 'repair' || kind === 'replace') && !await this.s.get(recoveryOperationKey(id, requestId))) {
      const s = await this.#recoverySnapshot(token, id, n);if (isFail(s)) return s;
      if (kind === 'replace') {const bad = this.#recoveryBudget(s.session, s.lab, s.providerRows);if (bad) return bad}
      else if (!s.seat.sandboxId) return fail(409, '기존 실습실이 없어 연결 복구를 할 수 없습니다.');
    }
    return this.#recovery.create(token, id, requestId, n, kind, generation, revision, ackDataLoss);
  }
  async labRecoveryStatus(token: string, id: string, requestId: unknown) { return this.#recovery.status(token, id, requestId); }
  async labRecoveryUnlock(token: string, id: string, requestId: unknown, generation: unknown, ackInspected: unknown) {
    return this.ctx.blockConcurrencyWhile(() => this.#recovery.unlock(token, id, requestId, generation, ackInspected));
  }
  async #recoveryValidate(expected: RecoveryAuthority, tx: Pick<DurableObjectStorage, 'get'>, requireFile: boolean): Promise<Fail | null> {
    const {labId: id, n, code, sid} = expected.ref, initial = await tx.get<Session>(`sess:${sid}`);
    const providers = ['prov:daytona', ...((initial?.providers ?? []).map(p => `prov:${p}`))].filter((p,i,a) => a.indexOf(p) === i).sort();
    const got = await tx.get<unknown>([`admin:${expected.owner}`, `lab:${id}`, `seat:${code}`, `sess:${sid}`, prepStopKey(id), prepJobKey(code), controlKey(id), trialReserveKey(id), fileReceiptKey(code), ...providers]);
    const fresh = this.#recoveryRead(expected.owner, id, n, code, sid, providers, got);if (isFail(fresh)) return fresh;
    const [fingerprint, generation] = await Promise.all([sha(fresh.text), sha(recoveryGenerationText(fresh.lab, fresh.seat))]);
    const admin = got.get(`admin:${expected.owner}`) as AdminTok;
    if (admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    if (this.#prepStopped.has(id) || fresh.lab.expiresAt <= now()) return fail(410, '모임이 끝났습니다.');
    if (fresh.control.revision !== expected.revision || fingerprint !== expected.fingerprint || generation !== expected.ref.generation || requireFile && (!expected.verifiedFileId || fresh.verifiedFileId !== expected.verifiedFileId)) return fail(409, '복구 대상 또는 파일 확인 상태가 바뀌었습니다. 다시 확인하세요.');
    return null;
  }
  #recoveryRead(owner: string, id: string, n: number, code: string, sid: string, providerKeys: string[], got: Map<string, unknown>) {
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, lab = got.get(`lab:${id}`) as Lab | undefined;
    const seat = lab?.seats.find(s => s.n === n && s.code === code), map = got.get(`seat:${code}`) as {lab: string; n: number} | undefined;
    const session = got.get(`sess:${sid}`) as Session | undefined, control = controlView(got.get(controlKey(id)));
    if (!admin || admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    if (!lab || lab.expiresAt <= now() || lab.endRetry || got.get(prepStopKey(id)) || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    if (!seat || !map || map.lab !== id || map.n !== n || (seat.sid ?? 'unavailable') !== sid || session && (session.id !== sid || session.lab !== id)) return fail(409, '자리 또는 예산 세션이 바뀌었습니다. 대상을 다시 확인하세요.');
    if (got.get(trialReserveKey(id)) || control.mode !== 'paused') return fail(409, '명령 전달을 일시정지한 뒤 현재 대상을 확인하세요.');
    const keys = ['prov:daytona', ...((session?.providers ?? []).map(p => `prov:${p}`))].filter((p,i,a) => a.indexOf(p) === i).sort();
    if (JSON.stringify(keys) !== JSON.stringify(providerKeys)) return fail(409, '공급자 권한이 바뀌었습니다. 대상을 다시 확인하세요.');
    const providerRows = keys.map(k => got.get(k) ?? null), text = recoveryBindingText(lab, seat, session, providerRows);
    const prep = got.get(prepJobKey(code)) as PrepJob | undefined;
    if (prep && !['ready', 'failed', 'uncertain'].includes(prep.phase)) return fail(409, '기존 자리 준비가 진행 중입니다. 준비 결과를 확인한 뒤 복구하세요.');
    return { lab, seat, session, control, providerRows, text, verifiedFileId: verifiedFileReceiptId(got.get(fileReceiptKey(code)), {labId: id, n, code, sandboxId: seat.sandboxId ?? 'unavailable'}, now()) };
  }
  async #recoverySnapshot(token: string, id: string, n: number) {
    if (typeof id !== 'string' || !id || id.length > 100 || !Number.isSafeInteger(n) || n < 1 || n > 50) return fail(400, '복구할 자리를 선택하세요.');
    const owner = await sha(token), initial = await this.s.get<Lab>(`lab:${id}`), seat = initial?.seats.find(s => s.n === n);
    if (!seat) return fail(404, '없는 자리입니다.');
    const sid = seat.sid ?? 'unavailable', session = await this.s.get<Session>(`sess:${sid}`);
    const providerKeys = ['prov:daytona', ...((session?.providers ?? []).map(p => `prov:${p}`))].filter((p,i,a) => a.indexOf(p) === i).sort();
    const keys = [`admin:${owner}`, `lab:${id}`, `seat:${seat.code}`, `sess:${sid}`, prepStopKey(id), prepJobKey(seat.code), controlKey(id), trialReserveKey(id), fileReceiptKey(seat.code), ...providerKeys];
    const snapshot = this.#recoveryRead(owner, id, n, seat.code, sid, providerKeys, await this.s.get<unknown>(keys)); if (isFail(snapshot)) return snapshot;
    const [fingerprint, generation] = await Promise.all([sha(snapshot.text), sha(recoveryGenerationText(snapshot.lab, snapshot.seat))]);
    const fresh = this.#recoveryRead(owner, id, n, seat.code, sid, providerKeys, await this.s.get<unknown>(keys)); if (isFail(fresh)) return fresh;
    if (fresh.text !== snapshot.text) return fail(409, '자리 또는 예산 설정이 바뀌었습니다. 대상을 다시 확인하세요.');
    const context: RecoveryAuthority = { owner, revision: fresh.control.revision, fingerprint,
      ref: {labId: id, n, code: fresh.seat.code, sandboxId: fresh.seat.sandboxId ?? 'unavailable', sid, generation}, verifiedFileId: fresh.verifiedFileId };
    return { ...fresh, context, providerKeys, keys };
  }
  async #recoveryPerform<T>(token: string, record: RecoveryNativeIntent, gate: () => boolean, jobKey: string, activeKey: string, effect: () => Promise<T>): Promise<T> {
    const s = await this.#recoverySnapshot(token, record.ref.labId, record.ref.n); if (isFail(s)) throw Error('recovery authority unavailable');
    if (s.context.owner !== record.owner || s.context.fingerprint !== record.fingerprint || !sameRecoveryRef(s.context.ref, record.ref)) throw Error('recovery target changed');
    const resourceKey = recoveryResourceKey(record.ref.labId, record.requestId), got = await this.s.get<unknown>([...s.keys, jobKey, activeKey, resourceKey]);
    const fresh = this.#recoveryRead(record.owner, record.ref.labId, record.ref.n, record.ref.code, record.ref.sid, s.providerKeys, got);
    if (isFail(fresh) || fresh.text !== s.text || !gate()) throw Error('recovery context changed');
    const job = got.get(jobKey) as RecoveryNativeIntent | undefined, resource = got.get(resourceKey) as RecoveryNativeResource | undefined;
    if (!job || job.owner !== record.owner || job.requestId !== record.requestId || job.kind !== record.kind || job.status !== 'pending' || job.revision !== record.revision || job.fingerprint !== record.fingerprint || !sameRecoveryRef(job.ref, record.ref) || got.get(activeKey) !== record.requestId) throw Error('recovery intent changed');
    if (!resource || resource.kind !== record.kind || resource.requestId !== record.requestId || resource.fingerprint !== record.fingerprint || resource.originalRevision !== record.revision || fresh.control.revision !== resource.nativeRevision || !sameRecoveryRef(resource.oldRef, record.ref) || resource.phase === 'adopted' || resource.phase === 'healthy') throw Error('recovery epoch changed');
    if (record.kind === 'replace' && !record.ackDataLoss && (!record.verifiedFileId || fresh.verifiedFileId !== record.verifiedFileId)) throw Error('file verification changed');
    if (this.#prepStopped.has(record.ref.labId)) throw Error('class ended');
    return effect();
  }
  async #recoveryStoreIntent(token: string, record: RecoveryNativeIntent, resource: RecoveryNativeResource, gate: () => boolean, jobKey: string, activeKey: string) {
    const s = await this.#recoverySnapshot(token, record.ref.labId, record.ref.n); if (isFail(s)) throw Error('recovery authority unavailable');
    if (s.context.owner !== record.owner || s.context.fingerprint !== record.fingerprint || !sameRecoveryRef(s.context.ref, record.ref)) throw Error('recovery target changed');
    const key = recoveryResourceKey(record.ref.labId, record.requestId);
    await this.s.transaction(async tx => {
      const got = await tx.get<unknown>([...s.keys, key, jobKey, activeKey]), fresh = this.#recoveryRead(record.owner, record.ref.labId, record.ref.n, record.ref.code, record.ref.sid, s.providerKeys, got);
      const job = got.get(jobKey) as RecoveryNativeIntent | undefined;
      if (got.get(key) || isFail(fresh) || fresh.text !== s.text || fresh.control.revision !== resource.nativeRevision || !gate() || this.#prepStopped.has(record.ref.labId) || !job || job.owner !== record.owner || job.revision !== record.revision || job.requestId !== record.requestId || job.status !== 'pending' || job.kind !== record.kind || job.fingerprint !== record.fingerprint || !sameRecoveryRef(job.ref, record.ref) || got.get(activeKey) !== record.requestId) throw Error('recovery intent changed');
      if (record.kind === 'replace' && !record.ackDataLoss && (!record.verifiedFileId || fresh.verifiedFileId !== record.verifiedFileId)) throw Error('file verification changed');
      await tx.put(key, resource);
    });
  }
  #recoveryBudget(session: Session | undefined, lab: Lab, rows: unknown[]) {
    if (!session || session.revoked || session.expiresAt <= now() || !session.tokenHash || !session.orKey || !session.orKeyHash || !session.orProvider || !Number.isFinite(session.budget) || session.budget !== lab.budget) return fail(409, '기존 예산 세션을 확인할 수 없어 교체를 차단했습니다. 새 예산을 발급하지 않습니다.');
    const providers = rows.filter((p): p is StoredProvider => !!p && typeof p === 'object' && 'id' in p);
    if (!providers.some(p => p.id === session.orProvider && p.kind === 'openrouter-mint' && isOpenRouterUpstream(p.upstream)) || !session.providers.includes(session.orProvider) || session.providers.some(id => !providers.some(p => p.id === id && grantOk(session, p)))) return fail(409, '기존 공급자 승인이 바뀌었습니다. 예산 세션을 먼저 확인하세요.');
    return null;
  }
  async #recoveryRun(token: string, record: RecoveryNativeIntent, gate: () => boolean, jobKey: string, activeKey: string) {
    const id = record.ref.labId, s = await this.#recoverySnapshot(token, id, record.ref.n);
    if (isFail(s) || !sameRecoveryRef(s.context.ref, record.ref) || s.context.fingerprint !== record.fingerprint || s.control.revision !== record.revision) throw Error('recovery context changed');
    if (record.kind === 'replace' && this.#recoveryBudget(s.session, s.lab, s.providerRows)) throw Error('original budget unavailable');
    if (record.kind === 'repair' && !s.seat.sandboxId) throw Error('existing sandbox unavailable');
    const stamp = await this.#labCreateDaytonaStamp(), c = await this.daytona();
    if (isFail(c) || stamp !== await this.#labCreateDaytonaStamp()) throw Error('provider unavailable or changed');
    let nativeRevision = record.revision;
    if (record.kind === 'replace') {
      const paused = await this.#control.pause(token, id, record.requestId);
      if (isFail(paused) || paused.mode !== 'paused' || paused.revision !== record.revision + 1) throw Error('recovery pause changed');
      nativeRevision = paused.revision;
    }
    const resource: RecoveryNativeResource = { requestId: record.requestId, labId: id, n: record.ref.n, kind: record.kind,
      originalRevision: record.revision, nativeRevision, fingerprint: record.fingerprint, oldRef: record.ref,
      phase: 'intent', createdAt: now() };
    let fake = '';
    if (record.kind === 'replace') {
      fake = `kvt_${rand(32)}`;
      resource.candidate = { code: rand(12), label: newSeatLabel(), generation: crypto.randomUUID(),
        tokenHash: await sha(fake), seal: await this.seal(`lab-recovery:${id}:${record.requestId}`, fake) };
    }
    await this.#recoveryStoreIntent(token, record, resource, gate, jobKey, activeKey);
    const perform = <T>(effect: () => Promise<T>) => this.#recoveryPerform(token, record, gate, jobKey, activeKey, effect);
    if (record.kind === 'repair') {
      let sb = await perform(() => dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(record.ref.sandboxId)}`, undefined, AbortSignal.timeout(15000)));
      if (sb.id !== record.ref.sandboxId) throw Error('sandbox identity mismatch');
      if (['stopped', 'archived', 'paused'].includes(sb.state)) {
        await perform(() => dt(c, 'POST', `/sandbox/${encodeURIComponent(sb.id)}/start`, undefined, AbortSignal.timeout(15000)));
        sb = await perform(() => dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(record.ref.sandboxId)}`, undefined, AbortSignal.timeout(15000)));
      }
      if (sb.id !== record.ref.sandboxId || sb.state !== 'started') throw Error('sandbox not running yet');
      const health = () => perform(() => dt<{exitCode: number; result: string}>({ ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' }, 'POST', `/${sb.id}/process/execute`, {command: repairHealthCommand(), timeout: 7}, AbortSignal.timeout(15000)));
      let probe = await health();
      if (probe.exitCode !== 0 || probe.result.trim() !== '200') {
        const toolbox = { ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' }, sessionId = `repair-${record.requestId}`;
        await perform(() => dt(toolbox, 'POST', `/${sb.id}/process/session`, {sessionId}, AbortSignal.timeout(15000)));
        await perform(() => dt(toolbox, 'POST', `/${sb.id}/process/session/${sessionId}/exec`, {command: 'lab-start', runAsync: true}, AbortSignal.timeout(15000)));
        probe = await health();
      }
      if (probe.exitCode !== 0 || probe.result.trim() !== '200') throw Error('editor health not confirmed');
      return this.#recoveryFinish(token, record, resource, gate, jobKey, activeKey);
    }
    const current = await this.#recoverySnapshot(token, id, record.ref.n);
    if (isFail(current) || this.#recoveryBudget(current.session, current.lab, current.providerRows)) throw Error('original budget unavailable');
    const defs = current.providerRows.filter((p): p is StoredProvider => !!p && typeof p === 'object' && 'id' in p)
      .filter(p => p.id !== current.session!.orProvider && !!current.lab.share?.[p.id] && labShareable(p));
    const body = labSandboxBody(current.lab, record.ref.n, fake, current.session!.orProvider!, (current.lab.expiresAt - now()) / 3600e3, defs);
    body.autoStopInterval = Math.max(1, Math.ceil((current.lab.expiresAt - now()) / 60000));
    const sb = await perform(() => dt<Sandbox>(c, 'POST', '/sandbox', {...body, labels: {...body.labels, 'gw-recovery': record.requestId}}, AbortSignal.timeout(45000)));
    if (!sb || typeof sb.id !== 'string' || !/^[\w-]{1,128}$/.test(sb.id)) throw Error('candidate identity unknown');
    resource.candidate!.sandboxId = sb.id; resource.phase = 'candidate';
    // Keep every known, unadopted candidate in the existing bounded cleanup queue.
    // The old sandbox is never queued here. Class end still owns all parent-labelled sandboxes.
    const cleanupKey = `labcreatecleanup:${id}:recover:${record.requestId}`;
    await this.s.put(cleanupKey, {labId: id, sandboxId: sb.id, provider: stamp, due: now() + 5 * 60e3});
    await this.s.put(recoveryResourceKey(id, record.requestId), resource);
    await this.schedule(now() + 5 * 60e3);
    const outcome = await this.#recoveryFinish(token, record, resource, gate, jobKey, activeKey);
    await this.s.delete(cleanupKey);
    return outcome;
  }
  async #recoveryFinish(token: string, record: RecoveryNativeIntent, resource: RecoveryNativeResource, gate: () => boolean, jobKey: string, activeKey: string) {
    const id = record.ref.labId, s = await this.#recoverySnapshot(token, id, record.ref.n);
    if (isFail(s) || s.context.owner !== record.owner || s.context.fingerprint !== record.fingerprint || !sameRecoveryRef(s.context.ref, record.ref)) throw Error('recovery target changed');
    const candidate = resource.candidate, nextSeat = record.kind === 'replace' ? replacementSeat(s.seat, candidate!) : undefined;
    const generation = nextSeat ? await sha(recoveryGenerationText(s.lab, nextSeat)) : record.ref.generation;
    const outcome = await this.ctx.blockConcurrencyWhile(() => this.s.transaction(async tx => {
      const terminalId = await tx.get<string>(terminalCurrentKey(id));
      const tk = terminalId ? terminalSessionKey(id, terminalId) : '';
      const key = recoveryResourceKey(id, record.requestId), got = await tx.get<unknown>([...s.keys, key, jobKey, activeKey,
        terminalCurrentKey(id), ...(tk ? [tk] : []), ...(candidate ? [`seat:${candidate.code}`, `tok:${candidate.tokenHash}`] : [])]);
      const fresh = this.#recoveryRead(record.owner, id, record.ref.n, record.ref.code, record.ref.sid, s.providerKeys, got);
      const job = got.get(jobKey) as RecoveryNativeIntent | undefined, native = got.get(key) as RecoveryNativeResource | undefined;
      if (isFail(fresh) || fresh.text !== s.text || fresh.control.revision !== resource.nativeRevision || !gate() || this.#prepStopped.has(id) ||
          !job || job.owner !== record.owner || job.requestId !== record.requestId || job.status !== 'pending' || job.revision !== record.revision || job.fingerprint !== record.fingerprint || !sameRecoveryRef(job.ref, record.ref) || job.kind !== record.kind ||
          got.get(activeKey) !== record.requestId || !native || JSON.stringify(native) !== JSON.stringify(resource) || got.get(terminalCurrentKey(id)) !== terminalId) return fail(409, 'recovery commit fence changed');
      if (record.kind === 'replace' && !record.ackDataLoss && (!record.verifiedFileId || fresh.verifiedFileId !== record.verifiedFileId)) return fail(409, 'file verification changed');
      const at = now();
      if (nextSeat && candidate) {
        if (this.#recoveryBudget(fresh.session, fresh.lab, fresh.providerRows) || got.has(`seat:${candidate.code}`) || got.has(`tok:${candidate.tokenHash}`)) return fail(409, 'replacement budget or identity unavailable');
        const nextSession = replacementSession(fresh.session!, candidate.tokenHash, fresh.lab.expiresAt);
        const control = got.get(controlKey(id)) as LabControlRow;
        const term = tk ? got.get(tk) as TerminalSession | undefined : undefined;
        await tx.put({[`lab:${id}`]: {...fresh.lab, seats: fresh.lab.seats.map(x => x.n === record.ref.n ? nextSeat : x)},
          [`sess:${record.ref.sid}`]: nextSession, [`tok:${candidate.tokenHash}`]: record.ref.sid, [`seat:${candidate.code}`]: {lab: id, n: record.ref.n},
          [controlKey(id)]: {...control, mode: 'paused', revision: control.revision + 1, updatedAt: at},
          [key]: {...native, phase: 'adopted', resultGeneration: generation, at},
          ...(term ? {[tk]: {...term, active: false}} : {})});
        await tx.delete([`tok:${fresh.session!.tokenHash}`, `seat:${record.ref.code}`, fileReceiptKey(record.ref.code)]);
      } else {
        await tx.put({[`lab:${id}`]: {...fresh.lab, seats: fresh.lab.seats.map(x => x.n === record.ref.n ? {...x, pv: undefined} : x)},
          [key]: {...native, phase: 'healthy', resultGeneration: generation, at}});
      }
      return {status: record.kind === 'replace' ? 'replaced' as const : 'ready' as const, at, generation};
    }));
    // Expected stale authority must not reject blockConcurrencyWhile's callback: that resets the DO.
    if (isFail(outcome)) throw Error(outcome.error);
    if (record.kind === 'replace') {this.presence.delete(record.ref.code);this.usageCache.delete(record.ref.sid)}
    return outcome;
  }
  async #recoveryObserve(record: RecoveryNativeIntent) {
    const id = record.ref.labId, got = await this.s.get<unknown>([recoveryResourceKey(id, record.requestId), `lab:${id}`]);
    const resource = got.get(recoveryResourceKey(id, record.requestId)) as RecoveryNativeResource | undefined, lab = got.get(`lab:${id}`) as Lab | undefined;
    if (!resource || !lab || resource.requestId !== record.requestId || resource.kind !== record.kind || resource.originalRevision !== record.revision || resource.fingerprint !== record.fingerprint || !sameRecoveryRef(resource.oldRef, record.ref) || !resource.at || !resource.resultGeneration) return null;
    const seat = lab.seats.find(x => x.n === record.ref.n);
    if (!seat || await sha(recoveryGenerationText(lab, seat)) !== resource.resultGeneration) return null;
    if (record.kind === 'replace' && resource.phase === 'adopted' && seat.code === resource.candidate?.code && seat.sandboxId === resource.candidate.sandboxId) return {status: 'replaced' as const, at: resource.at, generation: resource.resultGeneration};
    if (record.kind === 'repair' && resource.phase === 'healthy' && seat.code === record.ref.code && seat.sandboxId === record.ref.sandboxId) return {status: 'ready' as const, at: resource.at, generation: resource.resultGeneration};
    return null;
  }
  async labCheckpointFor(code: string) {
    const ref = await this.#fileRef(code); if (isFail(ref)) return ref;
    const listed = await this.s.list<StoredCheckpoint>({prefix: `labckpt:${encodeURIComponent(ref.labId)}:`, limit: 64}), fresh = await this.#fileRef(code);
    if (isFail(fresh)) return fresh;
    if (fresh.labId !== ref.labId || fresh.n !== ref.n || fresh.sandboxId !== ref.sandboxId) return fail(409, '자리 정보가 바뀌었습니다.');
    const checkpoints = [...listed.values()].flatMap(row => {if(!row || typeof row.requestId !== 'string')return [];const a = checkpointArchive(row, fresh, row.requestId, now());return a ? [{requestId: a.id, at: row.results.find(r => r.n === fresh.n)!.at, size: a.size, entries: a.entries, omitted: a.skipped}] : []});
    return { checkpoints: checkpoints.sort((a,b) => (b.at ?? 0) - (a.at ?? 0)) };
  }

  // ── 수업 터미널 (모임지기 → 선택한 자리의 전용 tmux 세션) ──
  readonly #control = new LabControlService({
    storage: this.ctx.storage, now: () => now(), checkAdmin: (token) => this.checkAdmin(token),
    lab: (id) => this.s.get<Lab>(`lab:${id}`),
    audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async labControlStatus(token: string, id: string) { return this.#control.status(token, id); }
  async labControlPause(token: string, id: string, requestId: unknown) { return this.#control.pause(token, id, requestId); }
  async labControlResume(token: string, id: string, requestId: unknown, revision: unknown) { return this.#control.resume(token, id, requestId, revision); }
  readonly #trial = new LabTrialService({
    storage: this.ctx.storage, now: () => now(), checkAdmin: token => this.checkAdmin(token),
    lab: id => this.#trialLab(id), audit: (event, detail) => this.audit(event, null, null, detail),
  });
  readonly #preview = new LabPreviewService({
    storage: this.ctx.storage, now: () => now(), context: (token, id) => this.#previewContext(token, id),
    trial: (token, id, runId) => this.#trial.proof(token, id, runId), audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async #trialLab(id: string): Promise<TrialLab | undefined> {
    const lab = await this.s.get<Lab>(`lab:${id}`); if (!lab || lab.id !== id) return undefined;
    const text = trialConfigText(lab), fingerprint = await sha(text);
    const got = await this.s.get<unknown>([`lab:${id}`, prepStopKey(id)]);
    const fresh = got.get(`lab:${id}`) as Lab | undefined;
    if (!fresh || fresh.id !== id || trialConfigText(fresh) !== text) return undefined;
    const history = await this.s.list({ prefix: `labterm:${id}:session:`, limit: 1 });
    const seat = fresh.seats.length === 1 ? fresh.seats[0] : undefined;
    const prepared = seat ? preparationView(fresh, seat, await this.s.get(prepJobKey(seat.code)), now()).state === 'ready' : false;
    return { id, name: fresh.name, expiresAt: fresh.expiresAt,
      endRetry: fresh.endRetry || (this.#prepStopped.has(id) || got.get(prepStopKey(id)) ? 1 : undefined), fingerprint,
      eligible: !fresh.teacherDemoFor && prepared && history.size === 0 && fresh.seats.every(s => !!s.sandboxId && !s.error && !s.who && !s.opened && s.setup?.state !== 'running' && s.setup?.state !== 'error'),
      seats: fresh.seats.map(s => ({ n: s.n, sandboxId: s.sandboxId })),
    };
  }
  async labTrialStatus(token: string, id: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const parent = await this.#trialLab(id); if (!parent) return fail(404, '없는 실습실입니다.');
    if (parent.endRetry || parent.expiresAt <= now()) return fail(410, '모임이 끝났습니다.');
    const current = await this.#trial.status(token, id);
    if (isFail(current) && current.status !== 409 && current.status !== 410) return current;
    const candidates: {id: string; name: string}[] = [];
    for (const lab of (await this.s.list<Lab>({ prefix: 'lab:' })).values()) {
      if (lab.id === id || lab.expiresAt <= now() || lab.endRetry) continue;
      const candidate = await this.#trialLab(lab.id);
      if (candidate?.eligible && candidate.fingerprint === parent.fingerprint && !await this.s.get(trialReserveKey(lab.id)) && !await this.s.get(trialBindingKey(lab.id))) candidates.push({id: lab.id, name: lab.name});
    }
    return await this.checkAdmin(token) ? { ...(isFail(current) ? { binding: null, warning: current.error } : current), candidates } : fail(401, '관리 세션이 만료됐습니다.');
  }
  async labTrialBind(token: string, id: string, trialId: unknown, requestId: unknown) {
    return this.#trial.bind(token, id, trialId as string, requestId);
  }
  async labTrialRun(token: string, id: string, requestId: unknown, command: unknown) {
    const claim = await this.#trial.begin(token, id, requestId, command); if (isFail(claim)) return claim;
    if (!claim.claimed) return claim;
    const b = claim.binding;
    try {
      const lab = await this.s.get<Lab>(`lab:${b.trialId}`);
      if (!lab || lab.seats.length !== 1) throw Error('trial unavailable');
      const status = await this.#terminal.status(token, b.trialId);
      if (!isFail(status) && 'needsTakeover' in status && status.needsTakeover) {
        const adopted = await this.#terminal.takeover(token, b.trialId, b.sessionId);
        if (isFail(adopted)) { await this.#trial.finish(id, claim.runId, 'error'); return adopted; }
      }
      const prepared = await this.#terminal.start(token, b.trialId, b.sessionId, [lab.seats[0].n]);
      if (isFail(prepared)) { await this.#trial.finish(id, claim.runId, 'error'); return prepared; }
      const sent = await this.#terminal.send(token, b.trialId, b.sessionId, claim.runId, command);
      // A final auth/storage error can follow an already accepted external input.
      const delivery = isFail(sent) ? 'unknown' : sent.results.every(r => r.status === 'sent') ? 'sent' : 'unknown';
      const saved = await this.#trial.finish(id, claim.runId, delivery);
      if (isFail(saved)) return saved;
      return { runId: claim.runId, delivery };
    } catch { await this.#trial.finish(id, claim.runId, 'unknown'); return { runId: claim.runId, delivery: 'unknown' }; }
  }
  async labTrialOutput(token: string, id: string) {
    const current = await this.#trial.status(token, id); if (isFail(current)) return current;
    const b = current.binding; if (!b || b.closed) return fail(409, '시험용 실습실을 먼저 지정하세요.');
    const lab = await this.s.get<Lab>(`lab:${b.trialId}`), seat = lab?.seats[0];
    if (!seat || seat.sandboxId !== b.sandboxId) return fail(409, '시험용 자리가 바뀌었습니다.');
    try {
      const r = await this.#terminalRemote(token, {labId: b.trialId, n: seat.n, code: seat.code, sandboxId: b.sandboxId}, b.sessionId, terminalCaptureCommand(), () => {}, undefined, { kind: 'capture' });
      return r.exitCode === 0 ? { output: clipTrialOutput(r.result), at: now() } : fail(502, '시험 터미널 출력을 읽지 못했습니다.');
    } catch { return fail(503, '시험 터미널 출력을 읽지 못했습니다.'); }
  }
  async labPreviewPrepare(token: string, id: string, requestId: unknown, command: unknown, options: unknown) {
    return this.#preview.prepare(token, id, requestId, command, options);
  }
  async #previewContext(token: string, id: string): Promise<PreviewContext | Fail> {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const owner = await sha(token);
    const sid = await this.s.get<string>(terminalCurrentKey(id));
    if (!sid) return fail(409, '수업 터미널을 먼저 시작하세요.');
    const lab = await this.s.get<Lab>(`lab:${id}`), session = await this.s.get<TerminalSession>(terminalSessionKey(id, sid));
    if (!lab || !session?.active) return fail(409, '수업 터미널을 먼저 시작하세요.');
    const configText = trialConfigText(lab), targetText = trialTargetText(lab, session);
    const [configFingerprint, targetFingerprint] = await Promise.all([sha(configText), sha(targetText)]);
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${id}`, prepStopKey(id), terminalCurrentKey(id), terminalSessionKey(id, sid), trialReserveKey(id)]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined;
    if (!admin || admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    const fresh = got.get(`lab:${id}`) as Lab | undefined, active = got.get(terminalSessionKey(id, sid)) as TerminalSession | undefined;
    if (!fresh || fresh.expiresAt <= now() || fresh.endRetry || got.get(prepStopKey(id)) || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    if (got.get(trialReserveKey(id))) return fail(409, '시험용 실습실에서는 시험 실행을 사용하세요.');
    if (!active?.active || active.owner !== owner || got.get(terminalCurrentKey(id)) !== sid) return fail(409, '수업 터미널을 다시 확인하고 이어받으세요.');
    if (trialConfigText(fresh) !== configText || trialTargetText(fresh, active) !== targetText || active.refs.some(r => !fresh.seats.some(s => s.n === r.n && s.code === r.code && s.sandboxId === r.sandboxId))) return fail(409, '명령 대상이나 실습 설정이 바뀌었습니다.');
    return { owner, sessionId: sid, targets: active.refs.map(r => r.n), targetFingerprint, configFingerprint };
  }
  #validTrialEffect(got: Map<string, unknown>, reserve: TrialReservation, lab: Lab, sessionId: string) {
    const parent = got.get(`lab:${reserve.parentId}`) as Lab | undefined, binding = got.get(trialBindingKey(reserve.parentId)) as TrialBinding | undefined;
    return !!parent && parent.expiresAt > now() && !parent.endRetry && !got.get(prepStopKey(parent.id)) && !this.#prepStopped.has(parent.id)
      && !!binding && !binding.closed && binding.bindingId === reserve.bindingId && binding.parentId === parent.id && binding.trialId === lab.id && binding.sessionId === sessionId
      && lab.seats.length === 1 && lab.seats[0].sandboxId === binding.sandboxId && trialConfigText(parent) === trialConfigText(lab);
  }
  async #trialAdmission(token: string, id: string, sessionId: string) {
    const reserve = await this.s.get<TrialReservation>(trialReserveKey(id)); if (!reserve) return null;
    const owner = await sha(token);
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${id}`, trialReserveKey(id), `lab:${reserve.parentId}`, prepStopKey(reserve.parentId), trialBindingKey(reserve.parentId)]);
    const lab = got.get(`lab:${id}`) as Lab | undefined, fresh = got.get(trialReserveKey(id)) as TrialReservation | undefined, admin = got.get(`admin:${owner}`) as AdminTok | undefined;
    return admin && admin.expiresAt > now() && lab && fresh?.bindingId === reserve.bindingId && this.#validTrialEffect(got, fresh, lab, sessionId) ? null : fail(409, '시험용 실습실의 연결을 다시 확인하세요.');
  }
  readonly #terminal = new LabTerminalService({
    storage: this.ctx.storage, now: () => now(), checkAdmin: (token) => this.checkAdmin(token),
    lab: (id) => this.s.get<Lab>(`lab:${id}`),
    acquire: (id) => this.#control.acquire(id),
    admit: (token, id, sessionId) => this.#trialAdmission(token, id, sessionId),
    remote: (token, ref, sessionId, command, gate, epoch, effect) => this.#terminalRemote(token, ref, sessionId, command, gate, epoch, effect),
    audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async labTerminalStart(token: string, id: string, requestId: unknown, seats: unknown, revision?: unknown) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    if (await this.s.get(trialReserveKey(id))) return fail(409, '시험용 실습실에서는 시험 실행을 사용하세요.');
    if (!(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) {
      const old = typeof requestId === 'string' && requestId.length === 36 ? await this.s.get(terminalSessionKey(id, requestId)) : null;
      if (!old) return fail(400, '명령 전달 상태 번호가 필요합니다. 화면을 새로고침한 뒤 다시 보내세요.');
    }
    return this.#terminal.start(token, id, requestId, seats, revision);
  }
  async labTerminalSend(token: string, id: string, sessionId: unknown, requestId: unknown, command: unknown, revision?: unknown, previewId?: unknown) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const old = typeof sessionId === 'string' && sessionId.length === 36 && typeof requestId === 'string' && requestId.length === 36 ? await this.s.get(terminalOperationKey(id, sessionId, requestId)) : null;
    if (old) return this.#terminal.send(token, id, sessionId, requestId, command, revision);
    if (!(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) {
      const old = typeof sessionId === 'string' && sessionId.length === 36 && typeof requestId === 'string' && requestId.length === 36 ? await this.s.get(terminalOperationKey(id, sessionId, requestId)) : null;
      if (!old) return fail(400, '명령 전달 상태 번호가 필요합니다. 화면을 새로고침한 뒤 다시 보내세요.');
    }
    const consumed = await this.#preview.consume(token, id, previewId, requestId, command);
    if (isFail(consumed)) return consumed.status >= 400 && consumed.status < 500 ? { ...consumed, code: 'preview_rejected' } : consumed;
    const approval = await this.s.get<LabPreviewRecord>(previewKey(id, consumed.previewId));
    if (!approval || approval.consumedBy !== requestId || approval.sessionId !== sessionId) return { ...fail(409, '미리보기와 전달 세션이 다릅니다.'), code: 'preview_rejected' };
    return this.#terminal.send(token, id, sessionId, requestId, command, revision, approval);
  }
  async labTerminalStop(token: string, id: string, sessionId: unknown) { return this.#terminal.stop(token, id, sessionId); }
  async labTerminalStatus(token: string, id: string) { return this.#terminal.status(token, id); }
  async labTerminalTakeover(token: string, id: string, sessionId: unknown) { return this.#terminal.takeover(token, id, sessionId); }

  readonly #interrupt = new LabInterruptService({
    storage: this.ctx.storage, now: () => now(),
    authorize: (token, id) => this.#interruptAuthorize(token, id),
    context: (token, id) => this.#interruptContext(token, id),
    probe: async (token, ref, sessionId) => {
      const context = await this.#interruptContext(token, ref.labId);
      if (isFail(context)) return context;
      if (context.sessionId !== sessionId) return fail(409, '수업 터미널이 바뀌었습니다.');
      const r = await this.#interruptRemote(token, ref, context, () => true);
      const proof = r.exitCode === 0 ? parseTeachingPane(r.result) : null;
      return proof ?? fail(409, '수업 터미널의 실행 프로그램을 확인하지 못했습니다. 각 자리에서 직접 확인하세요.');
    },
    remote: async (token, ref, record, requestId, gate) => {
      const r = await this.#interruptRemote(token, ref, record, gate, requestId);
      if (r.exitCode === 0 && r.result === 'SENT') return 'sent';
      if (r.exitCode === 0 && r.result === 'CHANGED') return 'changed';
      if (r.exitCode === 0 && r.result === 'DUPLICATE') return 'duplicate';
      throw Error('interruption result unavailable');
    },
    audit: (event, detail) => this.audit(event, null, null, detail),
  });
  async labInterruptPreview(token: string, id: string, previewId: unknown, seats: unknown, revision: unknown) {
    return this.#interrupt.prepare(token, id, previewId, seats, revision);
  }
  async labInterruptRequest(token: string, id: string, previewId: unknown, requestId: unknown) {
    return this.#interrupt.request(token, id, previewId, requestId);
  }
  async #interruptAuthorize(token: string, id: string): Promise<Fail | null> {
    const owner = await sha(token);
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${id}`, prepStopKey(id)]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, lab = got.get(`lab:${id}`) as Lab | undefined;
    if (!admin || admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    if (!lab || lab.expiresAt <= now() || lab.endRetry || got.get(prepStopKey(id)) || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    return null;
  }
  async #interruptContext(token: string, id: string): Promise<InterruptContext | Fail> {
    const owner = await sha(token), sid = await this.s.get<string>(terminalCurrentKey(id));
    if (!sid) return fail(409, '수업 터미널을 먼저 시작하세요.');
    const sk = terminalSessionKey(id, sid), snapshot = await this.s.get<unknown>([`lab:${id}`, sk]);
    const lab = snapshot.get(`lab:${id}`) as Lab | undefined, session = snapshot.get(sk) as TerminalSession | undefined;
    if (!lab || !session) return fail(409, '수업 터미널을 다시 확인하세요.');
    const configText = trialConfigText(lab), targetText = trialTargetText(lab, session);
    const fingerprint = await sha(JSON.stringify([configText, targetText]));
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${id}`, sk, terminalCurrentKey(id), prepStopKey(id), controlKey(id), trialReserveKey(id)]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, fresh = got.get(`lab:${id}`) as Lab | undefined, current = got.get(sk) as TerminalSession | undefined;
    if (!admin || admin.expiresAt <= now()) return fail(401, '관리 세션이 만료됐습니다.');
    if (!fresh || fresh.expiresAt <= now() || fresh.endRetry || got.get(prepStopKey(id)) || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    const control = controlView(got.get(controlKey(id)));
    if (control.mode !== 'paused') return fail(409, '먼저 명령 전달을 일시정지하고 상태를 확인하세요.');
    if (got.get(trialReserveKey(id))) return fail(409, '시험용 실습실에는 이 기능을 사용할 수 없습니다.');
    if (!current || current.sessionId !== sid || current.owner !== owner || got.get(terminalCurrentKey(id)) !== sid) return fail(409, '수업 터미널을 다시 확인하고 이어받으세요.');
    if (trialConfigText(fresh) !== configText || trialTargetText(fresh, current) !== targetText || !current.refs.length || current.refs.some(r => r.labId !== id || !fresh.seats.some(s => s.n === r.n && s.code === r.code && s.sandboxId === r.sandboxId))) return fail(409, '중단 요청의 대상이나 실습 설정이 바뀌었습니다.');
    return { owner, sessionId: sid, revision: control.revision, fingerprint, refs: current.refs };
  }
  async #interruptRemote(token: string, ref: InterruptRef, expected: Pick<InterruptContext, 'owner' | 'sessionId' | 'revision' | 'fingerprint'> | InterruptPreviewRecord, gate: () => boolean, requestId?: string) {
    const c = await this.daytona(); if (isFail(c)) throw Error('provider unavailable');
    if (!gate()) throw Error('lab ended');
    const sb = await dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(ref.sandboxId)}`, undefined, AbortSignal.timeout(15000));
    if (sb.id !== ref.sandboxId || sb.state !== 'started') throw Error('sandbox unavailable');
    const owner = await sha(token), sk = terminalSessionKey(ref.labId, expected.sessionId);
    const snapshot = await this.s.get<unknown>([`lab:${ref.labId}`, sk]);
    const lab = snapshot.get(`lab:${ref.labId}`) as Lab | undefined, session = snapshot.get(sk) as TerminalSession | undefined;
    if (!lab || !session) throw Error('session unavailable');
    const configText = trialConfigText(lab), targetText = trialTargetText(lab, session);
    if (await sha(JSON.stringify([configText, targetText])) !== expected.fingerprint || expected.owner !== owner) throw Error('intent changed');
    const record = 'previewId' in expected ? expected : undefined;
    const target = record?.targets.find(t => t.ref.n === ref.n && t.ref.labId === ref.labId && t.ref.code === ref.code && t.ref.sandboxId === ref.sandboxId);
    if (requestId && (!record || !target || record.consumedBy !== requestId)) throw Error('intent unavailable');
    const command = requestId && target ? teachingPaneInterruptCommand(expected.sessionId, requestId, target.proof) : teachingPaneProbeCommand();
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${ref.labId}`, `seat:${ref.code}`, prepStopKey(ref.labId), sk, terminalCurrentKey(ref.labId), controlKey(ref.labId), trialReserveKey(ref.labId),
      ...(record ? [interruptPreviewKey(ref.labId, record.previewId)] : [])]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined, fresh = got.get(`lab:${ref.labId}`) as Lab | undefined, current = got.get(sk) as TerminalSession | undefined;
    const liveSeat = this.#prepSeat(got.get(`seat:${ref.code}`), fresh, ref), control = controlView(got.get(controlKey(ref.labId)));
    if (!admin || admin.expiresAt <= now() || !fresh || !liveSeat || liveSeat.error || got.get(prepStopKey(ref.labId)) || this.#prepStopped.has(ref.labId) || got.get(trialReserveKey(ref.labId))) throw Error('authorization expired');
    if (!current || current.sessionId !== expected.sessionId || current.owner !== owner || got.get(terminalCurrentKey(ref.labId)) !== expected.sessionId || current.refs.some(r => r.labId !== ref.labId) || !current.refs.some(r => r.n === ref.n && r.code === ref.code && r.sandboxId === ref.sandboxId)) throw Error('session changed');
    if (control.mode !== 'paused' || control.revision !== expected.revision || trialConfigText(fresh) !== configText || trialTargetText(fresh, current) !== targetText) throw Error('intent changed');
    if (record) {
      const saved = got.get(interruptPreviewKey(ref.labId, record.previewId)) as InterruptPreviewRecord | undefined;
      if (!saved || saved.consumedBy !== requestId || saved.expiresAt <= now() || JSON.stringify(saved) !== JSON.stringify(record)) throw Error('intent expired');
    }
    // All authorization and immutable-target checks finish before this final gate.
    if (!gate()) throw Error('lab ended');
    return dt<{ exitCode: number; result: string }>({ ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' }, 'POST', `/${sb.id}/process/execute`, { command, timeout: 10 }, AbortSignal.timeout(15000));
  }

  async #terminalRemote(token: string, ref: TerminalRef, sessionId: string, command: string, gate: () => void, epoch: LabControlEpoch | undefined, effect: TerminalEffect) {
    const c = await this.daytona();
    if (isFail(c)) throw Error('Daytona unavailable');
    gate();
    const sb = await dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(ref.sandboxId)}`, undefined, AbortSignal.timeout(15000));
    if (sb.id !== ref.sandboxId || sb.state !== 'started') throw Error('sandbox not ready');
    const owner = await sha(token), sk = terminalSessionKey(ref.labId, sessionId);
    const reserve = await this.s.get<TrialReservation>(trialReserveKey(ref.labId));
    let configText: string | undefined, targetText: string | undefined;
    let trialText: string | undefined, trialHash: string | undefined;
    if (reserve) {
      const trial = await this.s.get<Lab>(`lab:${ref.labId}`); if (!trial) throw Error('trial unavailable');
      trialText = trialConfigText(trial); trialHash = await sha(trialText);
    }
    if (effect.approval) {
      const snapshot = await this.s.get<unknown>([`lab:${ref.labId}`, sk]);
      const lab = snapshot.get(`lab:${ref.labId}`) as Lab | undefined, session = snapshot.get(sk) as TerminalSession | undefined;
      if (!lab || !session) throw Error('preview unavailable');
      configText = trialConfigText(lab); targetText = trialTargetText(lab, session);
      const [configHash, targetHash] = await Promise.all([sha(configText), sha(targetText)]);
      const p = effect.approval;
      if (p.configFingerprint !== configHash || p.targetFingerprint !== targetHash || p.owner !== owner || p.sessionId !== sessionId || p.consumedBy !== effect.operationId || p.commandHash !== effect.commandHash) throw Error('preview changed');
    }
    const got = await this.s.get<unknown>([`admin:${owner}`, `lab:${ref.labId}`, `seat:${ref.code}`, prepStopKey(ref.labId), sk, terminalCurrentKey(ref.labId), controlKey(ref.labId), trialReserveKey(ref.labId),
      ...(reserve ? [`lab:${reserve.parentId}`, prepStopKey(reserve.parentId), trialBindingKey(reserve.parentId)] : [])]);
    const admin = got.get(`admin:${owner}`) as AdminTok | undefined;
    const session = got.get(sk) as TerminalSession | undefined;
    const liveSeat = this.#prepSeat(got.get(`seat:${ref.code}`), got.get(`lab:${ref.labId}`) as Lab | undefined, ref);
    if (!admin || admin.expiresAt <= now() || got.get(prepStopKey(ref.labId)) || !liveSeat) throw Error('authorization expired');
    if (effect.kind !== 'capture' && (liveSeat.error || liveSeat.setup?.state === 'running' || liveSeat.setup?.state === 'error')) throw Error('seat no longer ready');
    if (!session?.active || (effect.kind !== 'capture' && session.owner !== owner) || got.get(terminalCurrentKey(ref.labId)) !== sessionId || !session.refs.some((r) => r.n === ref.n && r.code === ref.code && r.sandboxId === ref.sandboxId)) throw Error('session stopped');
    const lab = got.get(`lab:${ref.labId}`) as Lab, freshReserve = got.get(trialReserveKey(ref.labId)) as TrialReservation | undefined;
    if (freshReserve) {
      const binding = got.get(trialBindingKey(freshReserve.parentId)) as TrialBinding | undefined;
      if (!reserve || freshReserve.bindingId !== reserve.bindingId || freshReserve.parentId !== reserve.parentId || !this.#validTrialEffect(got, freshReserve, lab, sessionId) || binding?.configFingerprint !== trialHash || trialConfigText(lab) !== trialText) throw Error('trial changed or ended');
    } else {
      if (reserve || effect.kind === 'capture') throw Error('trial unavailable');
      if (effect.kind === 'send') {
        const p = effect.approval;
        if (!p || p.expiresAt <= now() || trialConfigText(lab) !== configText || trialTargetText(lab, session) !== targetText) throw Error('preview changed or expired');
      }
    }
    if (effect.kind !== 'capture' && (!epoch || epoch.labId !== ref.labId || !controlEpochMatches(epoch, got.get(controlKey(ref.labId))))) throw Error('transmission paused or superseded');
    // 이 지점부터 외부 mutation 호출까지 await 없음. stop/end가 먼저 관측됐으면 전송하지 않는다.
    if (this.#prepStopped.has(ref.labId)) throw Error('lab ended');
    gate();
    return dt<{ exitCode: number; result: string }>({ ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' }, 'POST', `/${sb.id}/process/execute`, { command, timeout: 10 }, AbortSignal.timeout(15000));
  }

  // ── 받은 코드 (강사 → 참가자 코드 보내기) ──
  // 강사가 명령어·코드를 원문 그대로 반 전체에 보낸다 → 참가자 VS Code 막대의 📥 받은 코드 (src/labsnips.ts).
  //   snips:<labId>  [{ id, at, title?, text }] 최신이 앞, 30개까지 (넘으면 오래된 것 버림)
  //   snipv:<labId>  목록 버전 — 바뀔 때마다 오른다 (시각 ms 기준이라 새 수업이 예전 수업보다 늘 크다)
  // 참가자는 10초마다 GET /__lab/snips?v= 로 묻는다 → 버전은 메모리 캐시(없으면 저장소에서 읽음), 이 GET 은 저장소에 쓰지 않는다.
  private snipVer = new Map<string, number>();
  private static readonly SNIP = { max: 30, text: 20000, title: 60 };

  private async snipVersion(labId: string) {
    let v = this.snipVer.get(labId);
    if (v === undefined) { v = (await this.s.get<number>(`snipv:${labId}`)) ?? 0; this.snipVer.set(labId, v); }
    return v;
  }

  private async snipLab(token: string, id: string) {
    if (!(await this.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    if (lab.expiresAt <= now() || lab.endRetry) return fail(410, '수업이 끝났습니다.');
    return lab;
  }

  private async snipSave(labId: string, items: Snip[]) {
    const v = Math.max(now(), (await this.snipVersion(labId)) + 1);
    await this.s.put({ [`snips:${labId}`]: items, [`snipv:${labId}`]: v });
    this.snipVer.set(labId, v);
    return { ok: true, v, items };
  }

  /** 강사 화면: 이 수업에 보낸 코드 목록 */
  async labSnips(token: string, id: string) {
    const lab = await this.snipLab(token, id);
    if (isFail(lab)) return lab;
    return { v: await this.snipVersion(lab.id), items: (await this.s.get<Snip[]>(`snips:${lab.id}`)) ?? [] };
  }

  /** 강사가 코드 보내기. 본문은 손대지 않고 그대로 (감사 로그에는 제목·글자 수만) */
  async labSnipAdd(token: string, id: string, text: unknown, title: unknown) {
    const lab = await this.snipLab(token, id);
    if (isFail(lab)) return lab;
    const L = State.SNIP;
    if (typeof text !== 'string' || !text.trim() || text.length > L.text) return fail(400, `보낼 내용은 1~${L.text}자`);
    const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    if (t.length > L.title) return fail(400, `제목은 ${L.title}자까지`);
    const snip: Snip = { id: rand(6), at: now(), ...(t ? { title: t } : {}), text };
    const items = [snip, ...((await this.s.get<Snip[]>(`snips:${lab.id}`)) ?? [])].slice(0, L.max);
    const r = await this.snipSave(lab.id, items);
    await this.audit('lab-snip', null, null, `${lab.name} ${t ? `"${t}"` : '(제목 없음)'} ${text.length}자`);
    return r;
  }

  /** 보낸 코드 하나 지우기 (snip: 'all' 이면 전부) */
  async labSnipDelete(token: string, id: string, snipId: string) {
    const lab = await this.snipLab(token, id);
    if (isFail(lab)) return lab;
    const items = (await this.s.get<Snip[]>(`snips:${lab.id}`)) ?? [];
    const left = snipId === 'all' ? [] : items.filter((x) => x.id !== snipId);
    if (left.length === items.length && snipId !== 'all') return fail(404, '없는 항목입니다.');
    const r = await this.snipSave(lab.id, left);
    await this.audit('lab-snip-delete', null, null, `${lab.name} ${snipId === 'all' ? `전부 ${items.length}개` : '1개'}`);
    return r;
  }

  /** 참가자 막대(10초마다): 자리 쿠키의 수업 것만. 버전이 같으면 { same } → 204 */
  async labSnipsFor(code: string, since: string) {
    const got = await this.seatOf(code);
    if (isFail(got)) return got;
    const v = await this.snipVersion(got.lab.id);
    if (since === String(v)) return { same: true as const };
    return { v, items: (await this.s.get<Snip[]>(`snips:${got.lab.id}`)) ?? [] };
  }

  private usageCache = new Map<string, { at: number; v: { usage: number; limit: number | null } | null }>();
  /** 자리 서브키의 OpenRouter 사용액·한도 (관리 키로 조회, 30초 캐시) */
  private async seatUsage(sid: string) {
    const hit = this.usageCache.get(sid);
    if (hit && now() - hit.at < USAGE_TTL) return hit.v;
    const sess = await this.s.get<Session>(`sess:${sid}`);
    let v: { usage: number; limit: number | null } | null = null;
    const mgmt = sess?.orKeyHash ? await this.orMgmt(sess) : null;
    if (sess?.orKeyHash && mgmt) {
      try {
        const r = await fetch(`${OPENROUTER_ORIGIN}/api/v1/keys/${encodeURIComponent(sess.orKeyHash)}`, { headers: { Authorization: `Bearer ${mgmt}` } });
        if (r.ok) {
          const d = (await r.json<{ data?: { usage?: number; limit?: number | null } }>()).data;
          if (d && typeof d.usage === 'number' && Number.isFinite(d.usage) && d.usage >= 0 && (d.limit === null || (typeof d.limit === 'number' && Number.isFinite(d.limit) && d.limit >= 0))) v = { usage: d.usage, limit: d.limit };
        }
      } catch {}
    }
    this.usageCache.set(sid, { at: now(), v });
    return v;
  }

  // 자리 코드 → 탭별 마지막 신호. 저장소(pres:<code>)에도 적어 두어 배포·DO 재시작 뒤에도 이어진다 — 메모리는 읽기 캐시
  private presence = new Map<string, { seen: number; tabs: Map<string, PresTab> }>();
  private async presenceOf(code: string) {
    let p = this.presence.get(code);
    if (!p) {
      const d = await this.s.get<{ seen: number; tabs: [string, PresTab][] }>(`pres:${code}`);
      if (!d) return undefined;
      p = { seen: d.seen, tabs: new Map(d.tabs) };
      this.presence.set(code, p);
    }
    return p;
  }
  private get presenceRule() { return this.env.ALLOW_SHORT_TTL === '1' ? PRESENCE_DEV : PRESENCE; }

  /** 막대의 상태 신호. 형식이 틀리면 조용히 버린다 (막대의 다른 기능은 그대로) */
  private async notePresence(code: string, sig: unknown) {
    const x = (typeof sig === 'object' && sig !== null ? sig : {}) as Record<string, unknown>;
    const tab = typeof x.tab === 'string' && /^[\w-]{6,40}$/.test(x.tab) ? x.tab : '';
    const idle = Number(x.idle);
    if (!tab || !Number.isFinite(idle) || idle < 0) return;
    const p = (await this.presenceOf(code)) ?? { seen: 0, tabs: new Map<string, PresTab>() };
    const t: PresTab = { at: now(), idle: Math.min(Math.floor(idle), 7 * 86400), vis: x.vis === 'visible', focus: x.focus === true, watch: x.watch === true };
    p.tabs.delete(tab);
    p.tabs.set(tab, t); // Map 순서 = 마지막 신호 순서
    while (p.tabs.size > PRESENCE_MAX_TABS) p.tabs.delete(p.tabs.keys().next().value!);
    if (!t.watch) p.seen = t.at;
    this.presence.set(code, p);
    await this.s.put(`pres:${code}`, { seen: p.seen, tabs: [...p.tabs] });
  }

  /** 강사 표에 보일 자리 상태. 강사 "들어가 보기" 탭(watch)은 빼고, 남은 탭 중 가장 최근에 입력이 있었던 탭 기준 */
  private async seatPresence(code: string): Promise<SeatPresence> {
    const p = await this.presenceOf(code);
    if (!p) return { state: 'none' };
    const t = now(), rule = this.presenceRule;
    for (const [id, x] of p.tabs) if (t - x.at >= rule.offline * 1000) p.tabs.delete(id); // 끊긴 탭 정리
    const live = [...p.tabs.values()];
    const mine = live.filter((x) => !x.watch);
    const watch = live.length - mine.length || undefined;
    if (!mine.length) return p.seen ? { state: 'offline', lastSeen: p.seen, watch } : { state: 'none', watch };
    const idleSec = Math.min(...mine.map((x) => x.idle + Math.floor((t - x.at) / 1000)));
    return { state: idleSec >= rule.away ? 'away' : 'active', idleSec, lastSeen: p.seen, tabs: mine.length, watch };
  }

  private async seatOf(code: string): Promise<{ lab: Lab; seat: Seat & { sandboxId: string } } | Fail> {
    const ref = /^[\w-]{16}$/.test(code) ? await this.s.get<{ lab: string; n: number }>(`seat:${code}`) : undefined;
    const lab = ref ? await this.s.get<Lab>(`lab:${ref.lab}`) : undefined;
    const seat = lab?.seats.find((x) => x.n === ref?.n);
    if (!lab || !seat) return fail(404, '없는 링크이거나 수업이 끝났습니다.');
    if (lab.expiresAt <= now() || lab.endRetry) return fail(410, '수업이 끝났습니다.');
    if (await this.s.get(trialReserveKey(lab.id))) return fail(403, '모임지기 시험용 실습실입니다. 참여자 입장을 받지 않습니다.');
    if (!seat.sandboxId) return fail(503, `이 자리는 준비에 실패했습니다: ${seat.error ?? ''}`);
    if (!seat.label) {
      // 자리 호스트 전에 만든 수업: 처음 쓸 때 이름을 하나 정해 둔다. 한 트랜잭션에서 다시 읽어 label 만 (이미 있으면 그것)
      const fresh = newSeatLabel();
      seat.label = await this.s.transaction(async (txn) => {
        const cur = await txn.get<Lab>(`lab:${lab.id}`);
        const x = cur?.seats.find((y) => y.n === seat.n);
        if (!cur || !x) return fresh;
        if (!x.label) { x.label = fresh; await txn.put(`lab:${cur.id}`, cur); }
        return x.label;
      });
    }
    return { lab, seat: seat as Seat & { sandboxId: string } };
  }

  // ── 자리 미리 준비 (#prep) ──
  // labCreate 가 만든 자리를 백그라운드로 깨우고 자료를 넣고 편집기를 켠다 (lab-preparation-service.ts). 입장(labJoin)은 같은 일을 같이 기다린다.
  // 이 서비스는 who·opened·pv·쿠키·감사 기록을 쓰지 않는다. 자리 유효성(active)과 setup 저장(patchSetup)은 여기서 정한다.
  // 수업 끝내기·만료는 cancelLab(멈춤 표시)을 기다린 뒤에 바깥 정리를 시작한다 — 그 뒤로는 준비·이름·opened·pv 를 쓰지 않는다.
  readonly #prep = new LabPreparationService({
    storage: this.ctx.storage,
    now: () => now(),
    waitUntil: (p) => this.ctx.waitUntil(p),
    schedule: (t) => this.schedule(t),
    active: (ref) => this.#prepActive(ref),
    patchSetup: (ref, op, setup) => this.#prepPatchSetup(ref, op, setup),
    ops: {
      sandbox: (ref, gate) => this.#prepRemote(ref, null, gate, (c) => dt<Sandbox>(c, 'GET', `/sandbox/${ref.sandboxId}`)),
      wake: (ref, sb, gate) => this.#prepRemote(ref, sb, gate, async (c) => { await dt(c, 'POST', `/sandbox/${ref.sandboxId}/start`); }),
      install: (ref, sb, m, gate) => this.#prepRemote(ref, sb, gate, (c) => putMaterials(c, sb, m)),
      health: (ref, sb, gate) => this.#prepRemote(ref, sb, gate, async (c) => String((await exec(c, sb, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${LAB_PORT}/healthz`, 10)).result).includes('200')),
      editor: (ref, sb, gate) => this.#prepRemote(ref, sb, gate, (c) => spawn(c, sb, 'lab', 'lab-start')),
    },
  });
  /** 끝내기·만료가 시작된 수업 (cancelLab 을 기다리기 전에 메모리에서 먼저 막는다. 저장된 멈춤 표시는 #prepActive 가 본다) */
  readonly #prepStopped = new Set<string>();

  /** 준비 바깥 호출 하나: labJoin 과 같은 daytona() 로 키를 푼 뒤(await), 일 기록·멈춤·자리 표·수업을 한 번에 다시 읽어
   *  이 일 번호(gate.op)가 아직 주인인지(끝나지 않은 내 기록)·자리 유효(끝 시각·끝내는 중·ref 네 값)·샌드박스 id 를 보고,
   *  마지막 await 뒤 (사이에 await 없이) 메모리 멈춤과 서비스의 문(gate: 지금 도는 일·멈춤·끝 시각)을 지나야 부른다.
   *  문이 던지면 부르지 않는다. Daytona 가 없으면 정해진 문구로 실패 (다른 곳으로 보내지 않음) */
  async #prepRemote<T>(ref: PrepRef, sb: Sandbox | null, gate: PrepGate, f: (c: Dt) => Promise<T>): Promise<T> {
    const c = await this.daytona();
    if (isFail(c)) throw new Error(c.error);
    if (sb && sb.id !== ref.sandboxId) throw new Error('실습실 샌드박스가 바뀌었습니다.');
    if (this.#prepStopped.has(ref.labId)) throw new Error('수업이 끝났습니다.');
    const jk = prepJobKey(ref.code);
    const got = await this.s.get<unknown>([jk, prepStopKey(ref.labId), `seat:${ref.code}`, `lab:${ref.labId}`]);
    const stop = got.get(prepStopKey(ref.labId)) as PrepStop | undefined;
    if (!prepOwns(got.get(jk) as PrepJob | undefined, stop, ref, gate.op)) throw new Error('수업이 끝났습니다.');
    if (!this.#prepSeat(got.get(`seat:${ref.code}`), got.get(`lab:${ref.labId}`) as Lab | undefined, ref)) throw new Error('수업이 끝났습니다.');
    // 여기부터 f 까지 await 없음
    if (this.#prepStopped.has(ref.labId)) throw new Error('수업이 끝났습니다.');
    gate();
    return f(c);
  }

  /** 저장된 자리 표·수업에서 이 ref 와 맞는 자리 (수업 id·번호·코드·샌드박스 id·끝 시각·끝내는 중). 아니면 null */
  #prepSeat(map: unknown, lab: Lab | undefined, ref: PrepRef) {
    const m = map as { lab?: string; n?: number } | undefined;
    if (!m || m.lab !== ref.labId || m.n !== ref.n || !lab || lab.id !== ref.labId || lab.expiresAt <= now() || lab.endRetry) return null;
    const seat = lab.seats.find((x) => x.n === ref.n);
    return seat && seat.code === ref.code && seat.sandboxId === ref.sandboxId ? seat : null;
  }

  /** 자리 필드만 바꾸기: 한 트랜잭션 안에서 자리 표·수업·멈춤 표시(+extra)를 다시 읽어 확인하고 이 자리의 바꾼 필드만 쓴다 (바깥 호출 없음).
   *  f: 'write' 저장 · 'keep' 그대로 · 'deny' 거부. 자리가 유효하지 않거나 거부면 null
   *  also: 'write' 일 때만, 같은 트랜잭션에서 함께 쓸 키 (그 시도에서 읽은 got 로만 계산 — 재시도에 바깥 값을 들고 가지 않는다) */
  #seatPatch(ref: PrepRef, f: (seat: Seat, got: Map<string, unknown>) => 'write' | 'keep' | 'deny', extra: string[] = [],
    also?: (seat: Seat, got: Map<string, unknown>) => Record<string, unknown> | null) {
    return this.s.transaction(async (txn) => {
      if (this.#prepStopped.has(ref.labId)) return null;
      const got = await txn.get<unknown>([`seat:${ref.code}`, `lab:${ref.labId}`, prepStopKey(ref.labId), ...extra]);
      if (got.get(prepStopKey(ref.labId)) || this.#prepStopped.has(ref.labId)) return null;
      const lab = got.get(`lab:${ref.labId}`) as Lab | undefined;
      const seat = this.#prepSeat(got.get(`seat:${ref.code}`), lab, ref);
      if (!lab || !seat) return null;
      const w = f(seat, got);
      if (w === 'deny') return null;
      const more = w === 'write' && also ? also(seat, got) : null;
      if (w === 'write') await txn.put({ ...more, [`lab:${lab.id}`]: lab });
      return { lab, seat, wrote: w === 'write', also: !!more };
    });
  }

  /** 준비 서비스가 바깥 호출마다 다시 묻는다: 지금도 유효한 자리인가 (자격 증명은 넘기지 않는다) */
  async #prepActive(ref: PrepRef): Promise<PrepSnapshot | null> {
    if (this.#prepStopped.has(ref.labId)) return null;
    const got = await this.s.get<unknown>([`seat:${ref.code}`, `lab:${ref.labId}`, prepStopKey(ref.labId)]);
    if (got.get(prepStopKey(ref.labId)) || this.#prepStopped.has(ref.labId)) return null;
    const lab = got.get(`lab:${ref.labId}`) as Lab | undefined;
    const seat = this.#prepSeat(got.get(`seat:${ref.code}`), lab, ref);
    if (!lab || !seat) return null;
    return { materials: lab.materials ? materials(lab.materials, !!this.env.LAB_DAYTONA_API) : null, setup: seat.setup, opened: seat.opened };
  }

  /** 준비 서비스의 setup 저장: 같은 트랜잭션에서 일 번호·ref·샌드박스·멈춤을 확인. 끝난 setup(ok·error)은 덮지 않고, 'running' 은 비어 있고 입장 전일 때만 */
  async #prepPatchSetup(ref: PrepRef, op: string, setup: PrepSetup) {
    const jk = prepJobKey(ref.code);
    const r = await this.#seatPatch(ref, (seat, got) => {
      if (!prepOwns(got.get(jk) as PrepJob | undefined, got.get(prepStopKey(ref.labId)) as PrepStop | undefined, ref, op)) return 'deny';
      const cur = seat.setup;
      if (cur && cur.state !== 'running') return 'deny';
      if (setup.state === 'running' && (cur || seat.opened)) return 'deny';
      seat.setup = { state: setup.state, at: setup.at, note: setup.note };
      return 'write';
    }, [jk]);
    return !!r;
  }

  /** labCreate 뒤: 저장된 수업에서 샌드박스·세션이 있는 자리만 준비 줄에 넣는다 (네트워크 준비는 기다리지 않음, 실패해도 수업 만들기는 그대로) */
  async #prepEnqueue(labId: string) {
    try {
      const lab = await this.s.get<Lab>(`lab:${labId}`);
      if (!lab || lab.endRetry || lab.expiresAt <= now() || this.#prepStopped.has(lab.id)) return;
      const refs = lab.seats.filter((x) => x.sandboxId && x.sid && !x.error)
        .map((x): PrepRef => ({ labId: lab.id, n: x.n, code: x.code, sandboxId: x.sandboxId! }));
      if (refs.length) await this.#prep.enqueue(refs);
    } catch {}
  }

  /** OpenRouter 공개 모델 목록에 있는지. 목록을 못 받으면 null (막지 않음) */
  private async modelExists(model: string) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models');
      if (!r.ok) return null;
      const d = (await r.json<{ data?: Array<{ id?: string }> }>()).data;
      return Array.isArray(d) && d.length ? d.some((x) => x.id === model) : null;
    } catch { return null; }
  }

  private async labQuota() {
    const org = await this.s.get<string>('laborg');
    const c = await this.daytona();
    if (!org || isFail(c)) return null;
    try { return await quota(c, org); } catch { return null; }
  }

  // ── 강사 보기 전용 세션 (새로고침·앱 재시작 뒤에도 8시간 상태만 본다). 만들기만 방금 탭한 웹 관리 토큰으로 ──
  readonly #teacher = new LabTeacherService({
    storage: this.ctx.storage,
    blockConcurrencyWhile: this.ctx.blockConcurrencyWhile.bind(this.ctx),
    freshWebAdmin: (token) => this.freshWebAdmin(token),
    revokeAdmin: async (token) => { if (await this.getAdmin(token)) await this.s.delete(`admin:${await sha(token)}`); },
    seatPresence: (code) => this.seatPresence(code),
    schedule: (t) => this.schedule(t),
    fixedNotes: [PREP_UNCERTAIN, PREP_TIMEOUT],
    trialOnly: async id => !!(await this.s.get<Lab>('lab:' + id))?.teacherDemoFor || !!await this.s.get(trialReserveKey(id)),
    delivery: id => this.#terminal.delivery(id),
    diagnostics: async (lab, seat, at) => {
      if (!seat.sid || lab.expiresAt <= at || lab.endRetry) return emptyDiagnostics();
      const sess = await this.s.get<Session>(`sess:${seat.sid}`);
      if (!sess || sess.id !== seat.sid || sess.lab !== lab.id || sess.revoked || sess.expiresAt <= at) return emptyDiagnostics();
      return seatDiagnostics(this.usageCache.get(seat.sid), await this.s.get(`lerr:${seat.sid}`), at);
    },
    ended: (owners) => this.#push.dropOwners(owners),
  });

  /** 원문 토큰은 Worker 가 __Host-lab_teacher 쿠키로만 내보낸다. prior: 이 기기의 지금 쿠키 (있으면 새로 만들지 않고 그대로) */
  teacherSessionMint(adminToken: string, prior?: string) { return this.#teacher.mint(adminToken, prior); }
  teacherStatus(token: string) { return this.#teacher.status(token); }
  /** adminToken: 같은 화면이 들고 있던 관리 토큰 (있으면 그것과 그것으로 만든 보기 세션도 지운다) */
  teacherLogout(token: string | null, adminToken?: string) { return this.#teacher.logout(token, adminToken); }


  // Scoped classroom assistant: its credentials are never admin credentials.
  readonly #assistant = new LabAssistantService({
    storage: this.ctx.storage, now, checkAdmin: token => this.checkAdmin(token),
  });
  labAssistantIssue(admin: string, input: unknown) {
    return this.#assistant.issue(admin, input as Parameters<LabAssistantService['issue']>[1]);
  }
  labAssistantList(admin: string, id: string) { return this.#assistant.list(admin, id); }
  labAssistantRevoke(admin: string, id: string, grantId: unknown) {
    return this.#assistant.revoke(admin, id, grantId as string);
  }
  labAssistantAudit(admin: string, id: string) { return this.#assistant.audit(admin, id); }
  private async assistantBinding(token: string) {
    if (!/^la_[A-Za-z0-9_-]{43}$/.test(token)) return fail(401, '조교 연결 코드가 올바르지 않습니다.');
    // Service token digest encoding is SHA-256 hex; no plaintext credential is persisted.
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(x => x.toString(16).padStart(2,'0')).join('');
    const id = await this.s.get<string>('labassist-token:'+digest);
    const row = typeof id === 'string' ? await this.s.get<{labId: string}>('labassist:'+id) : undefined;
    if (!row || typeof row.labId !== 'string') return fail(401, '조교 연결이 만료되었거나 회수되었습니다.');
    return this.#assistant.authorize(token, row.labId, 'status:read');
  }
  labAssistantSession(token: string) { return this.assistantBinding(token); }
  async labAssistantStatus(token: string) {
    const auth = await this.assistantBinding(token); if(isFail(auth)) return auth;
    const lab = await this.s.get<Lab>('lab:'+auth.grant.labId);
    if(!lab) return fail(410, '모임이 끝났습니다.');
    const seats=lab.seats.filter(s=>auth.grant.seats.includes(s.n));
    const snapshot={...lab,seats};
    const pres=await Promise.all(seats.map(s=>this.seatPresence(s.code)));
    const view=teacherLabView(snapshot,pres,[PREP_UNCERTAIN,PREP_TIMEOUT]);
    const delivery=await this.#terminal.delivery(lab.id);
    const at=now();
    for(let i=0;i<seats.length;i++){
      const seat=seats[i], out=view.seats[i];
      out.preparation=preparationView(lab,seat,await this.s.get('labprep:'+seat.code),at);
      if(seat.sid){
        const sess=await this.s.get<Session>('sess:'+seat.sid);
        if(sess&&sess.lab===lab.id&&!sess.revoked&&sess.expiresAt>at)out.diagnostics=seatDiagnostics(this.usageCache.get(seat.sid),await this.s.get('lerr:'+seat.sid),at);
      }
      const d=delivery.find(x=>x.n===seat.n);
      if(d)out.delivery={status:d.status,at:d.at};
    }
    const control=controlView(await this.s.get(controlKey(lab.id)));
    const check=await this.#assistant.authorize(token,lab.id,'status:read');
    if(isFail(check))return check;
    // Replaced seat metadata may have changed during diagnostics reads: discard stale snapshots.
    const current=await this.s.get<Lab>('lab:'+lab.id);
    if(!current||current.endRetry||current.expiresAt<=now())return fail(410,'모임이 끝났습니다.');
    if(seats.some(s=>current.seats.find(x=>x.n===s.n)?.code!==s.code))return fail(409,'자리 연결이 바뀌었습니다. 상태를 다시 확인하세요.');
    const final=await this.#assistant.authorize(token,lab.id,'status:read');
    return isFail(final)?final:{now:now(),grant:final.grant,lab:view,control};
  }
  labAssistantQuestions(token:string,id:string){return this.#assistant.questions(token,id);}
  labAssistantReply(token:string,id:string,input:unknown){return this.#assistant.reply(token,id,input as Parameters<LabAssistantService['reply']>[2]);}
  labAssistantTemplate(token:string,id:string,input:unknown){return this.#assistant.sendTemplate(token,id,input as Parameters<LabAssistantService['sendTemplate']>[2]);}
  labAssistantPause(token:string,id:string,input:unknown){return this.#assistant.pause(token,id,input as Parameters<LabAssistantService['pause']>[2]);}
  private async helpIdentity(code:string){
    const got=await this.seatOf(code);if(isFail(got))return got;
    if(got.seat.code!==code)return fail(401,'자리 연결이 바뀌었습니다.');
    return {labId:got.lab.id,n:got.seat.n,seatCode:code};
  }
  async labHelpFor(code:string){
    const identity=await this.helpIdentity(code);return isFail(identity)?identity:this.#assistant.participant(identity);
  }
  async labHelpAsk(code:string,input:unknown){
    const identity=await this.helpIdentity(code);return isFail(identity)?identity:this.#assistant.ask(identity,input as Parameters<LabAssistantService['ask']>[1]);
  }
  async labHelpResolve(code:string,input:unknown){
    const identity=await this.helpIdentity(code);return isFail(identity)?identity:this.#assistant.resolve(identity,input as Parameters<LabAssistantService['resolve']>[1]);
  }
  private async assistantForget(id:string){
    await this.s.transaction(async tx=>{
      await tx.put('labassist-stop:'+id,now());
      const grants=await tx.list<{labId:string;tokenHash:string}>({prefix:'labassist:'});
      const drop=[...grants].filter(([,g])=>g.labId===id);
      const keys=drop.flatMap(([key,g])=>[key,'labassist-token:'+g.tokenHash]);
      keys.push('labhelp:'+id,'labassist-msg:'+id,'labassist-audit:'+id);
      await tx.delete(keys);
    });
  }

  // ── 강사 손 알림 (Web Push). 보기 세션 쿠키 토큰만 — 관리 토큰으로는 안 된다. 보내는 내용·대상은 서버가 정한다 ──
  #vapid: { src: string; key: Promise<VapidKey | null> } | null = null;
  #pushVapid() {
    const src = this.env.TEACHER_PUSH_VAPID_JWK;
    if (!src) return Promise.resolve(null);
    if (this.#vapid?.src !== src) this.#vapid = {src,key:importVapidKey(src).catch(()=>null)};
    return this.#vapid.key;
  }
  readonly #push = new LabTeacherPushService({
    storage: this.ctx.storage,
    authorize: (token) => this.#teacher.owner(token),
    vapid: () => {
      const src = this.env.TEACHER_PUSH_VAPID_JWK;
      if (!src) return Promise.resolve(null);
      if (this.#vapid?.src !== src) this.#vapid = { src, key: importVapidKey(src).catch(() => null) };
      return this.#vapid.key;
    },
    sealReady: () => { try { return isoBase64URL.toBuffer(this.env.MASTER_KEY ?? '').length === 32; } catch { return false; } },
    seal: (aad, text) => this.seal(aad, text),
    open: (aad, iv, ct) => this.unseal(aad, iv, ct),
    handKeys: (j) => [`seat:${j.code}`, `lab:${j.labId}`, prepStopKey(j.labId)],
    handOk: (j, got) => {
      if (this.#prepStopped.has(j.labId) || got.get(prepStopKey(j.labId))) return false;
      const seat = this.#prepSeat(got.get(`seat:${j.code}`), got.get(`lab:${j.labId}`) as Lab | undefined, j);
      return !!seat && seat.hand === j.hand;
    },
    schedule: (t) => this.schedule(t),
  });
  teacherPushConfig(token: string) { return this.#push.config(token); }
  teacherPushSubscribe(token: string, body: string) { return this.#push.subscribe(token, body); }
  teacherPushStatus(token: string, body: string) { return this.#push.status(token, body); }
  teacherPushUnsubscribe(token: string, body: string) { return this.#push.unsubscribe(token, body); }

  private labView(lab: Lab) {
    const { seats, gw: _gw, endRetry, share, cls: _cls, ...rest } = lab;
    return {
      ...rest, ending: !!endRetry, stateError: undefined as string | undefined, outage: undefined as string | undefined,
      share: Object.entries(share ?? {}).map(([id, sh]) => ({ id, ...sh })),
      seats: seats.map((x) => ({
        n: x.n, sandboxId: x.sandboxId, error: x.error, opened: x.opened, who: x.who, hand: x.hand,
        preparation: { state: x.error ? 'error' : 'unknown', at: null } as PreparationView,
        setup: x.setup && { state: x.setup.state, note: x.setup.note }, state: undefined as string | undefined,
        err: undefined as LabErr | undefined, usage: undefined as number | undefined, limit: undefined as number | null | undefined,
        counts: undefined as Record<string, number> | undefined, // 공유 공급자별 호출 수 (labList 가 채움)
      })),
    };
  }

  private async labSandboxes(c: Dt, labId: string) {
    const q = encodeURIComponent(JSON.stringify({ 'gw-lab': labId }));
    const list = await dt<{ items?: Sandbox[] } | Sandbox[]>(c, 'GET', `/sandbox?labels=${q}`);
    return Array.isArray(list) ? list : (list.items ?? []);
  }

  readonly #lifecycle = new LabLifecycleService({
    storage: this.ctx.storage,
    daytona: () => this.daytona(),
    labSandboxes: (c, labId) => this.labSandboxes(c, labId),
    endSession: (sess) => this.endSession(sess),
    endLab: (lab, why) => this.endLab(lab, why),
    exportClear: async (codes, why) => { await this.#export.clear(codes, why); await this.#files.clear(codes); },
    screenClear: (labId) => this.screenClear(labId),
    dropPresence: (code) => { this.presence.delete(code); },
    dropSnipVer: (labId) => { this.snipVer.delete(labId); },
    schedule: (t) => this.schedule(t),
    audit: (event, sid, ip, detail) => this.audit(event, sid, ip, detail),
  });

  readonly #classroom = new LabClassroomService({
    storage: this.ctx.storage, now: () => now(), checkAdmin: (token) => this.checkAdmin(token),
    teacherLabs: (token) => this.#classroomTeacherLabs(token), lab: (id) => this.#classroomLab(id),
    live: (id, tx) => this.#classroomLive(id, tx), seat: (code) => this.#classroomSeat(code, this.s),
    seatIn: (code, tx) => this.#classroomSeat(code, tx), readFile: (ref, gate) => this.#classroomReadFile(ref, gate),
    schedule: (t) => this.schedule(t),
  });
  labClassroomStatus(admin: string, id: string) { return this.#classroom.status(admin, id); }
  labClassroomHistory(admin: string) { return this.#classroom.history(admin); }
  labClassroomTeacherStatus(token: string, id: string) { return this.#classroom.teacherStatus(token, id); }
  labClassroomUpdate(admin: string, id: string, revision: unknown, patch: unknown) { return this.#classroom.update(admin, id, revision, patch); }
  labClassroomFeedback(admin: string, id: string, n: unknown, submissionId: unknown, feedback: unknown) { return this.#classroom.feedback(admin, id, n, submissionId, feedback); }
  labClassroomSeatStatus(code: string) { return this.#classroom.seatStatus(code); }
  labClassroomProgress(code: string, step: unknown, completed: unknown) { return this.#classroom.progress(code, step, completed); }
  labClassroomSubmit(code: string, requestId: unknown, filename: unknown) { return this.#classroom.submit(code, requestId, filename); }
  async #classroomTeacherLabs(token: string) {
    const view = await this.#teacher.status(token);
    if (isFail(view)) return view;
    return view.labs.map((lab) => ({ id: lab.id, ending: lab.ending }));
  }
  async #classroomLab(id: string): Promise<ClassroomLab | null> {
    if (!/^[\w-]{1,100}$/.test(id)) return null;
    const lab = await this.s.get<Lab>(`lab:${id}`);
    if (!lab || lab.id !== id || !Array.isArray(lab.seats)) return null;
    const stop = await this.s.get(prepStopKey(id));
    return { id: lab.id, live: lab.expiresAt > now() && !lab.endRetry && !stop && !this.#prepStopped.has(id), seats: this.#classroomSeats(lab) };
  }
  async #classroomLive(id: string, tx: Pick<DurableObjectStorage, 'get'>): Promise<ClassroomLab | Fail> {
    const lab = await tx.get<Lab>(`lab:${id}`);
    const stop = await tx.get(prepStopKey(id));
    if (!lab || lab.id !== id || !Array.isArray(lab.seats)) return fail(404, '없는 수업입니다.');
    if (lab.expiresAt <= now() || lab.endRetry || stop || this.#prepStopped.has(id)) return fail(410, '모임이 끝났습니다.');
    return { id: lab.id, live: true, seats: this.#classroomSeats(lab) };
  }
  #classroomSeats(lab: Lab): ClassroomSeatRef[] {
    return lab.seats.slice(0, 20).flatMap((seat) => Number.isInteger(seat.n) && seat.n >= 1 && seat.n <= 20 ? [{ labId: lab.id, n: seat.n, who: typeof seat.who === 'string' ? seat.who.slice(0, 80) : '', code: seat.code, sandboxId: seat.sandboxId ?? '' }] : []);
  }
  async #classroomSeat(code: string, tx: Pick<DurableObjectStorage, 'get'>): Promise<ClassroomSeatRef | Fail> {
    const map = /^[\w-]{16}$/.test(code) ? await tx.get<{ lab: string; n: number }>(`seat:${code}`) : undefined;
    if (!map || typeof map.lab !== 'string' || !Number.isInteger(map.n)) return fail(404, '없는 링크이거나 수업이 끝났습니다.');
    const lab = await tx.get<Lab>(`lab:${map.lab}`);
    const stop = await tx.get(prepStopKey(map.lab));
    const trial = await tx.get(trialReserveKey(map.lab));
    const seat = lab?.seats.find((item) => item.n === map.n && item.code === code);
    if (!lab || lab.id !== map.lab || !seat) return fail(404, '없는 링크이거나 수업이 끝났습니다.');
    if (lab.expiresAt <= now() || lab.endRetry || stop || this.#prepStopped.has(map.lab)) return fail(410, '모임이 끝났습니다.');
    if (trial) return fail(403, '모임지기 시험용 실습실입니다. 참여자 입장을 받지 않습니다.');
    if (!seat.sandboxId) return fail(503, '이 자리는 준비에 실패했습니다.');
    return { labId: lab.id, n: seat.n, who: typeof seat.who === 'string' ? seat.who.slice(0, 80) : '', code, sandboxId: seat.sandboxId };
  }
  async #classroomReadFile(ref: ClassroomSeatRef, gate: () => boolean): Promise<{ content: string } | Fail> {
    const fence = async (): Promise<Fail | null> => {
      if (!gate()) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
      const live = await this.#classroomSeat(ref.code, this.s);
      if (isFail(live)) return live;
      if (live.labId !== ref.labId || live.n !== ref.n || live.code !== ref.code || live.sandboxId !== ref.sandboxId) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
      return null;
    };
    const blocked = await fence();
    if (blocked) return blocked;
    const c = await this.daytona();
    if (isFail(c)) return fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.');
    let stop = await fence(); if (stop) return stop;
    if (WORK !== CLASSROOM_WORK || CLASSROOM_FILE_NAME !== '결과.txt') return fail(503, '결과.txt 를 안전하게 읽지 못했습니다.');
    let sb: Sandbox;
    try { sb = await dt<Sandbox>(c, 'GET', `/sandbox/${encodeURIComponent(ref.sandboxId)}`, undefined, AbortSignal.timeout(15000)); }
    catch { return fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.'); }
    if (!gate() || sb.id !== ref.sandboxId || sb.state !== 'started') return fail(409, '실습실이 바뀌었거나 꺼져 있습니다.');
    stop = await fence(); if (stop) return stop;
    let probe: { exitCode: number; result: string };
    try { probe = await exec(c, sb, classroomProbeCommand(), 15); }
    catch { return fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.'); }
    stop = await fence(); if (stop) return stop;
    const line = String(probe.result ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    if (probe.exitCode !== 0 || !line.startsWith('OK ')) {
      if (line === 'ERR missing') return fail(404, '결과.txt 파일이 없습니다.');
      if (line === 'ERR oversize') return fail(413, '결과.txt 가 64KiB 를 넘습니다.');
      if (line === 'ERR symlink' || line === 'ERR outside' || line === 'ERR type' || line === 'ERR realpath') return fail(400, '결과.txt 를 안전하게 읽지 못했습니다.');
      return fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.');
    }
    const mark = line.match(/^OK ([0-9a-f]{64}) (\d+)$/);
    if (!mark || Number(mark[2]) > CLASSROOM_BYTES) return fail(413, '결과.txt 가 64KiB 를 넘습니다.');
    let response: Response;
    try { response = await download(c, sb, `${WORK}/${CLASSROOM_FILE_NAME}`, AbortSignal.timeout(15000)); }
    catch (e) { return e instanceof DtError && e.status === 404 ? fail(404, '결과.txt 파일이 없습니다.') : fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.'); }
    let bytes: Uint8Array;
    try { bytes = await readCapped(response, CLASSROOM_BYTES); }
    catch (e) { return e instanceof Error && e.message.includes('넘습니다') ? fail(413, '결과.txt 가 64KiB 를 넘습니다.') : fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.'); }
    stop = await fence(); if (stop) return stop;
    if (bytes.byteLength !== Number(mark[2]) || await this.#classroomSha(bytes) !== mark[1]) return fail(400, '결과.txt 를 안전하게 읽지 못했습니다.');
    for (const b of bytes) if (b === 0) return fail(400, '결과.txt 에 이진 데이터가 있습니다.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { return fail(400, '결과.txt 가 올바른 UTF-8 텍스트가 아닙니다.'); }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return fail(400, '결과.txt 에 이진 데이터가 있습니다.');
    stop = await fence(); if (stop) return stop;
    return { content: text };
  }
  async #classroomSha(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 샌드박스 전부 삭제 + 세션(서브키) 전부 폐기. 하나라도 못 지우면 false → 알람이 5분 뒤 다시 */
  private async endLab(lab: Lab, why: 'end' | 'expire'): Promise<boolean> {
    this.#prepStopped.add(lab.id); // 메모리에서 먼저 (await 전)
    try { await this.#classroom.retain(lab.id, lab.seats.map((seat) => ({ n: seat.n, who: typeof seat.who === 'string' ? seat.who : '' }))); }
    catch { /* 검토 기록 실패가 샌드박스 정리를 막지 않는다 */ }
    this.#interrupt.end(lab.id);
    this.#checkpoint.end(lab.id);
    this.#recovery.end(lab.id);
    await this.assistantForget(lab.id);
    const trial = await this.#trial.close(lab.id);
    await this.#control.end(lab.id);
    await this.#prep.cancelLab(lab.id); // 준비 멈춤이 먼저 (못 지워 재시도로 가도 멈춤은 남는다)
    await this.#terminal.clear(lab.id);
    await this.#push.dropLab(lab.id).catch(() => {}); // 손 알림 일 (보내기 전 확인은 멈춤·끝 시각도 본다)
    let childOk = true;
    if (!isFail(trial) && trial.trialId) {
      const child = await this.s.get<Lab>(`lab:${trial.trialId}`);
      if (child) childOk = await this.endLab(child, why);
    }
    for (const child of (await this.s.list<Lab>({ prefix: 'lab:' })).values()) {
      if (child.teacherDemoFor === lab.id) childOk = await this.endLab(child, why) && childOk;
    }
    await this.#demo.clear(lab.id);
    return await this.#lifecycle.end(lab, why) && childOk && !isFail(trial);
  }

  private async daytona(): Promise<Dt | Fail> {
    const p = await this.s.get<StoredProvider>('prov:daytona');
    // 키를 풀기 전에 보낼 곳부터 확인 (저장된 예전 기록도)
    const api = p ? this.env.LAB_DAYTONA_API || canonUpstream(p.upstream) : null;
    const key = p && api ? await this.decrypt(p) : null;
    if (!p || !api || !key) return fail(409, 'Daytona 공급자 키가 없습니다. kv.ps1 push 로 올리세요.');
    return { api, key };
  }


  async #demoLiveLab(id: string): Promise<Lab | undefined> {
    const lab = await this.s.get<Lab>('lab:' + id);
    if (!lab || lab.endRetry || lab.expiresAt <= now() || this.#prepStopped.has(id) || await this.s.get(prepStopKey(id))) return;
    return lab;
  }
  readonly #demo = makeDemoService({
    storage: this.ctx.storage, now, checkAdmin: token => this.checkAdmin(token),
    lab: id => this.#demoLiveLab(id), daytona: () => this.daytona(),
    seatOrigin: label => new URL(this.env.LAB_ORIGIN).protocol + '//s-' + label + '.' + this.env.LAB_SEAT_DOMAIN,
    create: async (token, id, arm) => {
      const parent = await this.#demoLiveLab(id);
      if (!parent || parent.teacherDemoFor || await this.s.get(trialReserveKey(id))) return fail(410, '활성 모임을 선택하세요.');
      const hours = LAB_HOURS.find(h => h >= (parent.expiresAt - now()) / 3600e3) ?? 8;
      const prepared = await this.#labCreateValidate({
        name: ('시연 · ' + parent.name).slice(0,40), seats: 1, hours, budget: parent.budget,
        cpu: parent.cpu, memory: parent.memory, disk: parent.disk, snapshot: parent.snapshot, model: parent.model, gw: parent.gw,
        materials: parent.materials ?? '', clipIn: parent.clip?.in !== false, clipOut: parent.clip?.out !== false,
        share: Object.fromEntries(Object.entries(parent.share ?? {}).filter(([,v]) => v.on).map(([k,v]) => [k,v.cap])),
      });
      if (isFail(prepared)) return prepared;
      if (!await this.#demoLiveLab(id)) return fail(410, '모임이 끝났습니다.');
      const r = await this.#labCreateExecute(token, { ...prepared, demoFor: id, demoExpiresAt: parent.expiresAt }, arm);
      return isFail(r) ? r : isSnapPending(r) ? { preparing: true as const } : { id: r.labId };
    },
    warm: async ref => {
      const r = await this.#demoJoin(ref.code, '모임지기', true);
      return isFail(r) ? r : { ready: r.status === 'ready', message: 'detail' in r ? r.detail : undefined };
    },
  });
  labClassroomDemoStatus(token: string, id: string) { return this.#demo.status(token, id); }
  labClassroomDemoPrepare(token: string, id: string, requestId: unknown) { return this.#demo.prepare(token, id, requestId); }
  labClassroomDemoSend(token: string, id: string, requestId: unknown, command: unknown) { return this.#demo.send(token, id, requestId, command); }
  labClassroomDemoOpen(token: string, id: string) { return this.#demo.open(token, id); }
  labClassroomDemoClaim(grant: unknown, label: string) { return this.#demo.claim(grant, label); }
  labClassroomDemoFile(token: string, id: string, filename: unknown, requestId: unknown, content?: unknown, expectedHash?: unknown) { return this.#demo.file(token, id, filename, requestId, content, expectedHash); }
  async labClassroomMaterials(code: string, label: string) {
    const ref = await this.#fileRef(code); if (isFail(ref)) return ref;
    const lab = await this.s.get<Lab>('lab:' + ref.labId);
    if (!lab?.seats.some(s => s.code === code && s.label === label && s.sandboxId === ref.sandboxId)) return fail(403, '내 실습실에서 다시 열어 주세요.');
    const state = await this.labClassroomSeatStatus(code); if (isFail(state)) return state;
    const gate = async () => {
      const live = await this.#fileRef(code);
      return !isFail(live) && live.labId === ref.labId && live.n === ref.n && live.sandboxId === ref.sandboxId;
    };
    try {
      const c = await this.daytona(); if (isFail(c)) return c;
      if (!await gate()) return fail(410, '실습실이 바뀌었거나 모임이 끝났습니다.');
      const sb = await demoSandbox(c, ref.sandboxId);
      return await applyClassroomMaterials(c, sb, state.classroom.materials, gate);
    } catch { return fail(503, '자료 넣기 결과를 확인하지 못했습니다. 파일 목록을 확인하세요. 기존 파일은 덮어쓰지 않습니다.'); }
  }

  // ── 강사 화면 공유 ──
  // 강사 /lab 탭이 getDisplayMedia 로 잡은 화면을 SFU 에 올리고(local track), 참가자 VS Code 의 /__lab/rtc.js 가 remote track 으로 받는다. 소리는 없다.
  // SFU 앱 비밀(REALTIME_APP_TOKEN)은 여기서만 쓴다 — 브라우저와는 SDP 만 주고받고, SFU 세션 id 도 참가자에게 주지 않는다.
  //   scr:<labId>   공유 상태 {sessionId?, tracks, startedAt?, v}. v 는 시작·멈춤마다 +1 → 참가자가 끊고 다시 연결할 때를 안다
  //   scrp:<sid>    참가자 받기 세션: 우리 쪽 불투명 id → 자리 코드·수업·SFU 세션·remote mid·만료. 쿠키 자리와 같아야 answer 를 받는다
  //   scrq:<id>     닫을 SFU 트랙. 받기 기록(scrp)·공유 상태(scr)를 지운 쪽 하나만 여기 넣는다 → 기록된 할당은 한 번만 닫힌다
  // 받기 (#16): SFU 를 부르기 전에 자리를 잡고(자리마다 기다림 2·전체 4), 세션 id·mid 를 받는 즉시 적는다.
  //   answer 가 30초 안에 안 오면·실패·밀려남·멈춤·새 시작·끝내기·알람 → 그 받기의 remote 트랙을 닫는다.
  //   SFU 호출 중(busy)인 받기는 닫는 쪽이 closing 만 표시하고, 호출한 요청이 응답을 받은 뒤 닫는다 (호출 중 생긴 트랙도 놓치지 않게)
  protected answerTtl() { return SCR_ANSWER_TTL; }

  readonly #liveAuth = new LabTeacherService({
    storage: this.ctx.storage,
    blockConcurrencyWhile: this.ctx.blockConcurrencyWhile.bind(this.ctx),
    freshWebAdmin: token => this.freshWebAdmin(token),
    revokeAdmin: async token => { if (await this.getAdmin(token)) await this.s.delete(`admin:${await sha(token)}`); },
    seatPresence: code => this.seatPresence(code), schedule: t => this.schedule(t), fixedNotes: [],
    ended: owners => this.#live.dropOwners(owners),
  }, 'live-auth:');
  readonly #live = new LabLiveService({
    storage: this.ctx.storage, env: this.env, seatOf: code => this.seatOf(code),
    authorize: token => this.#liveAuth.owner(token), schedule: t => this.schedule(t),
    waitUntil: p => this.ctx.waitUntil(p), audit: (...args) => this.audit(...args),
  });
  labLiveMint(token: string, prior?: string) { return this.#liveAuth.mint(token, prior); }
  labLiveOwner(token: string) { return this.#liveAuth.owner(token); }
  labLiveLogout(token: string | null, admin?: string) { return this.#liveAuth.logout(token, admin); }
  labLiveStatus(token: string) { return this.#live.status(token); }
  labLiveQuality(token: string, viewerTab: unknown, revision: unknown, at: unknown, focus: unknown) { return this.#live.quality(token, viewerTab, revision, at, focus); }
  labLiveStart(code: string, tab: unknown, sdp: unknown, tracks: unknown) { return this.#live.start(code, tab, sdp, tracks); }
  labLiveStop(code: string, tab: unknown) { return this.#live.stop(code, tab); }
  labLiveSeat(code: string, tab?: unknown, ack?: unknown, viewport?: unknown, ackRequest?: unknown) { return this.#live.seatState(code, tab, ack, viewport, ackRequest); }
  labLivePull(token: string, id: string, n: number, sid?: unknown, sdp?: unknown) { return this.#live.pull(token, id, n, sid, sdp); }
  labLiveRequest(token: string, id: string, n: number, requestId: unknown) { return this.#live.requestControl(token, id, n, requestId); }
  labLiveRelease(token: string, id: string, n: number, requestId: unknown) { return this.#live.release(token, id, n, requestId); }
  labLiveConsent(code: string, tab: unknown, requestId: unknown, allow: unknown) { return this.#live.consent(code, tab, requestId, allow); }
  labLiveInput(token: string, id: string, n: number, requestId: unknown, eventId: unknown, event: unknown) { return this.#live.input(token, id, n, requestId, eventId, event); }
  labLiveClose(token: string, id: string, n: number) { return this.#live.close(token, id, n); }

  readonly #screen = new LabScreenService({
    storage: this.ctx.storage,
    env: this.env,
    waitUntil: (p) => this.ctx.waitUntil(p),
    checkAdmin: async (token) => await this.checkAdmin(token) || !!await this.#liveAuth.owner(token),
    seatOf: (code) => this.seatOf(code),
    schedule: (t) => this.schedule(t),
    audit: (event, sid, ip, detail) => this.audit(event, sid, ip, detail),
    answerTtl: () => this.answerTtl(),
  });

  /** 강사: 화면 공유 시작. offer + 올릴 트랙(mid·이름) → SFU answer. 다른 탭에서 하던 공유는 끊고 바꾼다 */
  async labScreenStart(token: string, id: string, sdp: unknown, tracks: unknown) { return this.#screen.start(token, id, sdp, tracks); }

  /** 강사: 화면 공유 멈춤 (이미 멈춰 있으면 그대로). 참가자는 다음 확인(10초)에 창을 닫는다 */
  async labScreenStop(token: string, id: string) { return this.#screen.stop(token, id); }

  /** 강사 /lab: 수업별 공유 상태 (다른 탭이나 닫힌 탭의 공유가 남아 있는지) */
  async labScreenList(token: string) { return this.#screen.list(token); }

  /** 참가자 막대가 10초(숨은 탭 30초)마다 묻는다. 저장소에 쓰지 않는다 */
  async labScreenState(code: string) { return this.#screen.state(code); }

  /** 참가자: 받기 세션을 만들고 강사 트랙을 remote 로 요청 → SFU 의 offer. 돌려주는 sid 는 우리 쪽 id (SFU 세션 id 아님) */
  async labScreenPull(code: string) { return this.#screen.pull(code); }

  /** 참가자: SFU offer 에 대한 answer. 그 자리(쿠키)가 만든 받기 세션만, offer 뒤 30초 안에 한 번 */
  async labScreenAnswer(code: string, sid: unknown, sdp: unknown) { return this.#screen.answer(code, sid, sdp); }

  /** 끝내기·만료: 공유 상태와 받기 세션 정리 (트랙 닫기는 scrq 로 한 번) */
  private async screenClear(labId: string) { await this.#live.clear(labId); return this.#screen.clear(labId); }

  /** 알람: 시간이 지난 받기·죽은 SFU 호출·끝난 수업의 받기를 닫고, 닫기 재시도. 다음 시각을 돌려준다 */
  private async screenAlarm(t: number) { return Math.min(await this.#screen.alarm(t), await this.#live.alarm(t)); }

  // ── 만료 정리 ─────────────────────────────────────────────

  async alarm() {
    const t = now();
    let next = Infinity;
    for (const prefix of ['req:', 'wch:', 'admin:', TEACHER_PREFIX, 'live-auth:']) {
      for (const [k, v] of await this.s.list<{ expiresAt: number }>({ prefix })) {
        if (v.expiresAt <= t) await this.s.delete(k);
        else next = Math.min(next, v.expiresAt);
      }
    }
    // 예전 한 칸짜리 challenge(chal:<purpose>)는 더 이상 받지 않는다 — 남은 건 만료와 무관하게 지운다
    const legacy = [...(await this.s.list({ prefix: 'chal:' })).keys()];
    if (legacy.length) await this.s.delete(legacy.slice(0, 128));
    next = Math.min(next, await this.#lifecycle.alarm(t));
    next = Math.min(next, await this.#classroom.alarm(t).catch(() => t + 60e3));
    next = Math.min(next, await this.#labCreateCleanup(t));
    // 내 작업 받기: 시간이 지난 받기(묶기·표·받기)를 끝내고, 못 지운 묶은 폴더를 다시 지운다 (재시작으로 끊긴 받기도 여기서)
    next = Math.min(next, await this.#export.alarm(t));
    next = Math.min(next, await this.screenAlarm(t));
    // 자리 미리 준비: 오래된 기록 정리 + 기다리는 일 돌리기 (실패해도 나머지 정리는 그대로, 1분 뒤 다시)
    next = Math.min(next, (await this.#prep.alarm(t).catch(() => t + 60e3)) ?? Infinity);
    for (const sess of (await this.s.list<Session>({ prefix: 'sess:' })).values()) {
      if (sess.expiresAt <= t) {
        const wasRevoked = sess.revoked;
        if (await this.endSession(sess)) { if (!wasRevoked) await this.audit('expire', sess.id, sess.ip); }
        else next = Math.min(next, sess.expiresAt); // endSession 이 재시도 시각을 넣었다
      } else next = Math.min(next, sess.expiresAt);
    }
    // 남겨 둔 관리 키 암호문: 그 세대 서브키를 가진 세션이 다 끝났으면 지운다
    const gone = await this.s.list({ prefix: 'provgone:' });
    if (gone.size) {
      const need = new Set<string>();
      for (const x of (await this.s.list<Session>({ prefix: 'sess:' })).values())
        if (x.orKeyHash && x.orProvider && x.gens?.[x.orProvider]) need.add(`provgone:${x.orProvider}:${x.gens[x.orProvider]}`);
      for (const k of gone.keys()) if (!need.has(k)) await this.s.delete(k);
    }
    // 강사 손 알림: 끝난 구독 정리 + 쌓인 일 보내기 (다른 정리 뒤에 — 실패해도 위 정리는 끝났고, 1분 뒤 다시)
    next = Math.min(next, await this.#push.alarm(t).catch(() => t + 60e3));
    next = Math.min(next, await this.#openRequests.alarm(t).catch(() => t + 60e3));
    next = Math.min(next, await this.#openPush.alarm(t).catch(() => t + 60e3));
    // 위에서 재시도를 schedule 로 잡았을 수 있다 — 더 이른 쪽을 남긴다
    const cur = await this.s.getAlarm();
    if (cur !== null && cur > t) next = Math.min(next, cur);
    if (next < Infinity) await this.s.setAlarm(next);
  }

  // ── 내부 ─────────────────────────────────────────────────

  private async schedule(t: number) {
    const cur = await this.s.getAlarm();
    if (cur === null || t < cur) await this.s.setAlarm(t);
  }

  private async newAdminToken(src: 'web' | 'cli', credentialId?: string) {
    const token = rand(24);
    const expiresAt = now() + ADMIN_TTL;
    await this.s.put(`admin:${await sha(token)}`, { expiresAt, createdAt: now(), src, ...(credentialId?{credentialId}:{}) } satisfies AdminTok);
    await this.schedule(expiresAt);
    return { token, expiresAt };
  }

  private async listProviders() { return [...(await this.s.list<StoredProvider>({ prefix: 'prov:' })).values()]; }

  private async getProviders(ids: string[]) {
    const got = await this.s.get<StoredProvider>(ids.map((i) => `prov:${i}`));
    return [...got.values()];
  }

  private async aesKey() {
    const raw = isoBase64URL.toBuffer(this.env.MASTER_KEY ?? '');
    if (raw.length !== 32) throw new Error('MASTER_KEY must be 32 bytes');
    return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  private async encrypt(id: string, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`prov:${id}`) },
      await this.aesKey(), new TextEncoder().encode(value),
    );
    return { iv: isoBase64URL.fromBuffer(iv), ct: isoBase64URL.fromBuffer(new Uint8Array(ct)) };
  }

  /** MASTER_KEY AES-GCM 봉인 (AAD 로 용도·대상을 묶는다). encrypt/decrypt 의 prov:<id> 와 다른 AAD 만 쓴다 */
  private async seal(aad: string, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await this.aesKey(), new TextEncoder().encode(value));
    return { iv: isoBase64URL.fromBuffer(iv), ct: isoBase64URL.fromBuffer(new Uint8Array(ct)) };
  }

  private async unseal(aad: string, iv: string, ct: string) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(isoBase64URL.toBuffer(iv)), additionalData: new TextEncoder().encode(aad) },
        await this.aesKey(), new Uint8Array(isoBase64URL.toBuffer(ct)),
      );
      return new TextDecoder().decode(pt);
    } catch { return null; }
  }

  private async decrypt(p: StoredProvider) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(isoBase64URL.toBuffer(p.iv)), additionalData: new TextEncoder().encode(`prov:${p.id}`) },
        await this.aesKey(), new Uint8Array(isoBase64URL.toBuffer(p.ct)),
      );
      return new TextDecoder().decode(pt);
    } catch {
      return null; // MASTER_KEY 가 바뀌었으면 여기로 온다 → 다시 push 하면 된다
    }
  }

  /** 세션 종료. 토큰은 즉시 무효. OpenRouter 서브키 삭제가 실패하면 5분 뒤 재시도하도록 남긴다. */
  private async endSession(sess: Session): Promise<boolean> {
    await this.s.delete(`tok:${sess.tokenHash}`);
    if (sess.orKeyHash) {
      const key = await this.orMgmt(sess);
      if (!key) {
        // 관리 키가 사라졌으면 지울 방법이 없다. 서브키는 한도 안에서만 쓰이고 OpenRouter 대시보드에서 지울 수 있다
        await this.audit('orphan-subkey', sess.id, null, sess.orKeyHash.slice(0, 12));
      } else if (!(await this.deleteOpenRouterKey(key, sess.orKeyHash))) {
        sess.revoked = true;
        sess.expiresAt = now() + 5 * 60e3;
        await this.s.put(`sess:${sess.id}`, sess);
        await this.schedule(sess.expiresAt);
        return false;
      }
    }
    await this.s.delete([`sess:${sess.id}`, `lerr:${sess.id}`]);
    return true;
  }

  /**
   * 세션 서브키를 만든 그 세대의 관리 키. 공급자가 지워졌거나 세대가 바뀌었으면 남겨 둔 provgone 암호문으로 푼다.
   * gen 이 적히지 않은 세션(옮기기에서 빠진 예전 세션)만 지금 기록을 쓴다. 서브키 발급형·openrouter.ai 가 아니면 풀지 않는다
   */
  private async orMgmt(sess: Session) {
    if (!sess.orProvider) return null;
    const gen = sess.gens?.[sess.orProvider];
    const cur = await this.s.get<StoredProvider>(`prov:${sess.orProvider}`);
    const p = cur && (gen === undefined || cur.gen === gen) ? cur
      : gen ? await this.s.get<StoredProvider>(`provgone:${sess.orProvider}:${gen}`) : undefined;
    if (!p || p.kind !== 'openrouter-mint' || !isOpenRouterUpstream(p.upstream)) return null;
    return this.decrypt(p);
  }

  /** 공급자 기록이 없어지거나 세대가 바뀔 때: 그 관리 키로 만든 서브키가 살아 있으면 세션 끝에 지울 수 있게 암호문(같은 AAD)을 남긴다 */
  private async retireProvider(p: StoredProvider) {
    if (p.kind !== 'openrouter-mint' || !p.gen) return;
    const live = [...(await this.s.list<Session>({ prefix: 'sess:' })).values()]
      .some((x) => x.orKeyHash && x.orProvider === p.id && x.gens?.[p.id] === p.gen);
    if (live) await this.s.put(`provgone:${p.id}:${p.gen}`, p);
  }

  private async mintOpenRouterKey(p: StoredProvider, sid: string, limit: number, gate?: () => Promise<void>) {
    // 관리 키는 정확히 openrouter.ai 로만 — 저장된 기록이 무엇이든 풀기 전에 확인
    if (p.kind !== 'openrouter-mint' || !isOpenRouterUpstream(p.upstream)) return null;
    const mgmt = await this.decrypt(p);
    if (!mgmt) return null;
    if (gate) await gate(); // 수업 만들기는 키 풀기를 기다린 뒤에도 인증·끝내기를 다시 확인한다.
    const r = await fetch(`${OPENROUTER_ORIGIN}/api/v1/keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `gw-borrow-${sid}`, limit }),
    });
    if (!r.ok) return null;
    const j = await r.json<{ key?: string; data?: { hash?: string } }>();
    return j.key && j.data?.hash ? { key: j.key, hash: j.data.hash } : null;
  }

  private async deleteOpenRouterKey(mgmt: string, hash: string) {
    try {
      const r = await fetch(`${OPENROUTER_ORIGIN}/api/v1/keys/${encodeURIComponent(hash)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${mgmt}` },
      });
      return r.ok || r.status === 404;
    } catch {
      return false;
    }
  }

  private async creds() { return [...(await this.s.list<Cred>({ prefix: 'cred:' })).values()]; }

  private async authOptions(purpose: string, src: string, only: (c: Cred) => boolean = () => true) {
    const creds = (await this.creds()).filter(only);
    if (!creds.length) return fail(409, purpose === 'vault' ? 'PRF 로 등록된 보안 키가 없습니다. /admin 에서 키를 PRF 로 다시 등록하세요.' : '등록된 보안 키가 없습니다. /register 부터 하세요.');
    const opts = await generateAuthenticationOptions({
      rpID: this.env.RP_ID,
      // transports 를 명시해야 한다. 비워 두면 Android 는 폰 안의 패스키만 찾고
      // "사용 가능한 패스키 없음"으로 끝낸다 — NFC 태깅 화면을 띄우지 않는다.
      allowCredentials: creds.map((c) => ({ id: c.id, transports: ['nfc', 'usb'] })),
      userVerification: 'required',
      timeout: 120_000,
    });
    const bad = await this.putChallenge(purpose, opts.challenge, src);
    return bad ?? { ...opts, hints: ['security-key'] };
  }

  /**
   * 의식마다 challenge 를 따로 저장한다 (같은 purpose 의 다른 의식을 덮어쓰지 않는다). 상한을 넘으면 새 의식만 막는다 — 살아 있는 의식은 안 밀어낸다.
   * 상한: purpose 마다 CHAL_MAX, 출처마다 CHAL_PER_SOURCE (모든 purpose 합), 전체 CHAL_GLOBAL. 세기와 쓰기는 한 덩어리로
   */
  private async putChallenge(purpose: string, challenge: string, src: string) {
    const s = srcOf(src);
    const bad = await this.ctx.blockConcurrencyWhile(async () => {
      await this.s.delete(`chal:${purpose}`); // 예전 한 칸짜리 기록은 쓰지 않는다
      let total = 0, same = 0, mine = 0;
      const dead: string[] = [];
      for (const [k, c] of await this.s.list<Chal>({ prefix: 'wch:' })) {
        if (c.expiresAt <= now()) { dead.push(k); continue; }
        total++;
        if (c.purpose === purpose) same++;
        if (c.src === s) mine++;
      }
      await this.deleteKeys(dead);
      if (mine >= CHAL_PER_SOURCE) return fail(429, '이 네트워크에서 진행 중인 확인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      if (same >= CHAL_MAX || total >= CHAL_GLOBAL) return fail(429, '진행 중인 확인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      await this.s.put(chalKey(purpose, challenge), { challenge, purpose, expiresAt: now() + CHAL_TTL, src: s } satisfies Chal);
      return null;
    });
    if (bad) return bad;
    await this.schedule(now() + CHAL_TTL);
    return null;
  }

  /** 저장소 delete 는 한 번에 128 키까지 */
  private async deleteKeys(keys: string[]) {
    for (let i = 0; i < keys.length; i += 128) await this.s.delete(keys.slice(i, i + 128));
  }

  /**
   * 응답의 clientDataJSON 에서 challenge 를 꺼내 이 purpose 의 기록을 찾고, 저장된 challenge 로 검증한다.
   * 검증을 통과한 응답만 기록을 지운다 (지우기에 성공한 한 번만 인정 → 재사용·동시 재전송 막음). 틀린 응답은 남의 의식을 없애지 못한다.
   * undefined = 이 purpose 로 발급한 살아 있는 challenge 가 없음, null = 검증 실패
   */
  private async ceremony<T>(purpose: string, resp: unknown, verify: (challenge: string) => Promise<T | null>): Promise<T | null | undefined> {
    const c = clientChallenge(resp);
    if (!c) return undefined;
    const k = chalKey(purpose, c);
    const ch = await this.s.get<Chal>(k);
    if (!ch || ch.purpose !== purpose || ch.challenge !== c) return undefined;
    if (ch.expiresAt <= now()) { await this.s.delete(k); return undefined; }
    const v = await verify(ch.challenge);
    if (v === null) return null;
    if (!(await this.s.delete(k))) return undefined;
    return v;
  }

  private async verifyTap(purpose: string, resp: AuthenticationResponseJSON) {
    const cred = typeof resp?.id === 'string' && resp.id ? await this.s.get<Cred>(`cred:${resp.id}`) : undefined;
    if (!cred) return null;
    const v = await this.ceremony(purpose, resp, async (challenge) => {
      try {
        const r = await verifyAuthenticationResponse({
          response: resp, expectedChallenge: challenge,
          expectedOrigin: this.env.ORIGIN, expectedRPID: this.env.RP_ID,
          credential: { id: cred.id, publicKey: new Uint8Array(isoBase64URL.toBuffer(cred.publicKey)), counter: cred.counter },
          requireUserVerification: true,
        });
        return r.verified ? r : null;
      } catch {
        return null;
      }
    });
    if (!v) return null;
    // 검증 사이에 같은 키의 다른 의식이 카운터를 올렸을 수 있다 — 지금 저장된 값에 더 큰 쪽만
    const cur = await this.s.get<Cred>(`cred:${cred.id}`);
    if (!cur) return null; // 그 사이 지워진 키
    cur.counter = Math.max(cur.counter, v.authenticationInfo.newCounter);
    cur.lastUsed = now();
    await this.s.put(`cred:${cred.id}`, cur);
    return cur;
  }

  private async getAdmin(token: string) {
    if (typeof token !== 'string' || !token) return null;
    const a = await this.s.get<AdminTok>(`admin:${await sha(token)}`);
    return a && a.expiresAt > now() ? a : null;
  }

  private async checkAdmin(token: string) { return !!(await this.getAdmin(token)); }

  private async audit(event: string, sid: string | null, ip: string | null, detail = '') {
    const log = (await this.s.get<unknown[]>('audit')) ?? [];
    log.unshift({ t: now(), event, sid, ip, detail });
    await this.s.put('audit', log.slice(0, 100));
  }
}
