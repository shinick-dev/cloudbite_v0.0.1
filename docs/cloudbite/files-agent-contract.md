# CloudBite 파일 에이전트 계약 (P1-A/B 로컬 코어)

상태: 로컬 코어 + 실제 HTTPS transport(`HttpBackend`) 구현. 시험은 가짜 backend와 loopback 가짜 HTTP 서버뿐이며 실제 앱/R2/VM 연결은 아직 없다.
`--capability` 없이 실행하면 `UnconfiguredHttpBackend`가 모든 호출을 `transport_not_configured`로 거절한다. 원격 저장 성공을 흉내 내지 않는다.
서버 route·VM 설치는 [files-bridge.md](files-bridge.md).

관련 계획: [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md) §5·§6·§7.
구현: `images/cloudbite-computer/files-agent.py` · 시험: `python -B test/cloudbite-computer-files-agent.py`.

## 1. 경계

- 에이전트는 설정된 **workspace root 한 곳**만 다룬다. root가 HOME 자체·파일시스템 루트·상태 디렉터리 내부이면 거절한다.
- 디렉터리 전체 탐색을 하지 않는다. 카탈로그에 등록된 경로와 사용자가 명시한 경로만 본다.
- 경로는 root 기준 상대 POSIX 경로(`a/b.txt`)다. 절대 경로·`..`·빈 구성요소·NUL·`\`·제어문자를 거절한다.
  기존 구성요소 중 symlink가 하나라도 있으면 거절한다(`path_symlink`). 자격증명/프로필 이름(`.ssh`, `.gnupg`, `.aws`,
  `.netrc`, `.git-credentials`, root 최상위의 `.config`·`.local`·`.mozilla`·`.pki`·`.cache`)은 거절한다(`path_forbidden`).
- 파일명 Unicode는 받은 그대로 보존한다. 충돌 판정 키는 `NFC + casefold`이며, 같은 키의 다른 이름은 `path_collision`.
  카탈로그(core)의 키는 `NFC + toLowerCase`라서 두 키가 다를 수 있는 이름(`ß`, 어말 `ς` 등 `casefold != lower`)은
  등록·원격 생성 모두 `path_ambiguous`로 거절한다(보수적: 로컬 dirty 기록은 유지하고 원격 생성만 막는다).
- 상태(`journal.sqlite3`, `staging/`)는 `--state` 디렉터리에 둔다. root와 같은 파일시스템이어야 한다(원자적 rename).
- 출력에는 파일 본문·자격증명·토큰을 넣지 않는다. 경로·크기·해시·버전 ID만 포함한다.

## 2. 로컬 상태

| state | 의미 | 회수 가능 |
|---|---|---|
| `remote-only` | 메타데이터만 있음 | 해당 없음 |
| `clean` | 기대 버전의 검증된 사본(`localHash == versionHash`) | origin=`agent` & 미pin & 미사용일 때만 |
| `dirty` | 로컬 변경 기록됨, 원격 미확정 | 아니오 |
| `uploading` | 확정 요청 진행 중(`activeOp`) | 아니오 |
| `conflict` | 서버가 기준 버전/writer epoch 충돌로 거절 — 내용 보존, 사용자 해결 필요 | 아니오 |

`origin`: `agent`(에이전트가 원격 버전에서 생성) / `user`(원래 workspace에 있던 파일). `user` 파일은 clean이어도 **자동 삭제하지 않는다**.

## 3. CLI (JSON 한 줄 출력)

```
files-agent.py --state DIR init --root PATH --workspace-id ID --machine-id ID [--writer-epoch N]
               [--reserve-bytes N] [--max-transfer-bytes N] [--auto-evict]
files-agent.py --state DIR [--capability FILE] <command>   # FILE 없으면 transport_not_configured
files-agent.py --state DIR status
files-agent.py --state DIR list-local [--cursor N] [--limit N<=500]
files-agent.py --state DIR register --manifest FILE        # [{fileId,path,versionId,size,sha256,mode?} | {kind:"dir",fileId,path}] 메타데이터만
files-agent.py --state DIR create-dir --path P             # 등록된 부모 아래 원격 폴더 1개 (requestId 저널 후 전송)
files-agent.py --state DIR report-local [--limit N]        # recordLocalState 보고
files-agent.py --state DIR open (--path P | --file-id F) [--version V]
files-agent.py --state DIR close --lease L
files-agent.py --state DIR pin|unpin --path P
files-agent.py --state DIR mark-dirty --path P
files-agent.py --state DIR sync [--limit N]
files-agent.py --state DIR reconcile
files-agent.py --state DIR evict [--need-bytes N]
files-agent.py --state DIR prepare-end [--flush]
files-agent.py --state DIR resume
```

성공: `{"ok": true, ...}`. 실패: `{"ok": false, "code": "<code>"}` + 종료코드 2. 오류 코드:
`not_configured, invalid_argument, path_invalid, path_forbidden, path_symlink, path_collision, path_ambiguous,
parent_not_registered, not_found, version_mismatch, local_modified, local_modified_unrecorded, insufficient_space,
transfer_too_large, size_mismatch, checksum_mismatch, receipt_mismatch, draining, busy, transport_not_configured,
capability_invalid, capability_insecure, capability_expired, scope_mismatch, backend_error, base_version_conflict,
stale_writer_epoch, stale_writer, name_conflict, request_conflict, quota_exceeded` 및 core `FilesErrorCode` 통과값.

`init`은 같은 state에 다른 root/workspace/machine을 거절하고, writer epoch를 낮추는 재초기화를 `stale_writer_epoch`로 거절한다.

`prepare-end`는 새 open fetch를 막는 draining 상태로 전환하고 다음을 보고한다:
`{ready, safeToDelete, remoteSaved, dirty[], uploading[], conflict[], unconfirmedOps[], open[]}`.
`ready/safeToDelete/remoteSaved`는 dirty·uploading·conflict·미확정 op·열린 lease가 하나도 없을 때만 `true`다.
`safeToDelete`는 “원격 확인 완료”라는 의미일 뿐 에이전트가 무엇을 삭제한다는 뜻이 아니다. 브라우저 닫기는 이 명령을 부르지 않는다.

## 4. 서버 transport 계약 (주입형 backend)

에이전트는 아래 메서드를 가진 backend만 호출한다. 재시도 시 **같은 requestId와 같은 staged 바이트**를 보낸다.
실제 구현은 `HttpBackend`(core v1 route, [files-bridge.md](files-bridge.md) §2)이고, 시험용 가짜 backend도 같은 메서드를 갖는다.

| 에이전트 메서드 | 요청 | 응답 | core 매핑 (HttpBackend) |
|---|---|---|---|
| `fetch_version` | `{fileId, versionId, maxBytes, sha256}` | 바이트 청크 iterator | `POST open {fileId,versionId}` → descriptor의 `fileId/versionId/size/sha256`이 등록값과 다르면 `version_mismatch`(아무 바이트도 요청·기록 안 함), 같으면 `GET content/{f}?versionId={v}` (stream; `x-cloudbite-version`·`x-cloudbite-sha256`·`content-length`가 있으면 일치 필수) |
| `begin_upload` | `{requestId, fileId\|null, path, parentId, name, baseVersion\|null, writerEpoch, size, sha256}` | `{requestId, uploadId, fileId, phase}` | `fileId=null`이면 `create`(requestId `<rid>:create`) 후 `uploads/begin` |
| `put_body` | `{uploadId, size, sha256}` + staged 파일 핸들 | 무시 | `PUT uploads/{id}/body` 한 번, content-length=size 스트리밍 (commit 아님) |
| `commit_upload` | op 전체 `{requestId, uploadId, fileId, baseVersion, writerEpoch, size, sha256}` | receipt | `uploads/{id}/commit` → `CommitResult` |
| `get_operation` | 위와 같음(`uploadId` null 가능) | `{requestId, phase, receipt?, code?}` | `GET uploads/{id}`; uploadId 없으면 `unknown_request` |
| `create_entry` | `CreateRequest` | `{fileId, ...}` | `create` |
| `record_local_state` | `LocalStateRequest` | `{local, applied}` | `local-state` |

`phase`: `pending | committed | conflict | rejected | unknown_request | resend`. `unknown_request`(begin 응답 유실로
uploadId 모름)와 `resend`(begun/body_written, 미만료)는 같은 requestId로 다시 보낸다. core `create`/`beginUpload`는
같은 requestId+같은 인자에 저장된 결과를 돌려주므로 중복 파일·업로드가 생기지 않는다. `aborted`·만료 업로드는 `rejected`
(파일은 dirty 유지, 다음 sync가 새 op).

receipt: `{requestId, fileId, versionId, baseVersion, size, sha256, writerEpoch, canonical: true}`.
`HttpBackend`는 `begin`/`GET uploads` 응답의 `UploadView`가 op의 `fileId/baseVersion/writerEpoch/size/sha256`과 일치하는지 확인하고,
`CommitResult{status:"committed", durable:true}`의 `fileId/size/sha256`이 op와 같고 `versionId != baseVersion`일 때만
op의 불변 필드로 receipt를 만든다. `status:"conflict"`(형제 파일에 보존됨)는 `BackendError("base_version_conflict")`,
그 밖의 불일치·`durable` 누락·형식 오류는 결과 미확정(`unknown` → reconcile)이다.

전송 규칙: capability의 `endpoint`는 정확히 `<gateway origin>/p/_cloudbite/computer/files/agent/v1`이어야 한다(https, 시험용 loopback http만 예외; userinfo·query·fragment·다른 경로 = `capability_invalid`). 고정 host, redirect 미추적(3xx = 미확정), 응답 JSON ≤ 1 MiB,
연결 끊김·시간 초과·envelope 없는 5xx = 미확정. 오류 envelope `{error:{code}}`의 알려진 code만 확정 거절로 본다.
capability 파일은 0600·본인 소유(POSIX)여야 하고(`capability_insecure`), 만료면 아무 요청도 보내지 않는다(`capability_expired`).
capability의 machineId/workspaceId/writerEpoch가 저널 설정과 다르면 에이전트가 시작하지 않는다(`scope_mismatch`).
토큰은 Authorization 헤더에만 들어가며 출력·repr·오류에 포함되지 않는다.

backend 오류는 `BackendError(code)`로 던진다(확정 거절). 에이전트 처리:

| 코드 | 처리 |
|---|---|
| `base_version_conflict`, `stale_writer_epoch`, `stale_writer`, `stale_revision`, `name_conflict` | op `conflict`, 파일 `conflict`(로컬 내용 보존) |
| `request_conflict` | op `rejected`, 파일 `dirty` 유지(다음 sync에서 새 op) |
| `commit_unknown`, `invalid_upload_state` | op `unknown` → `reconcile` |
| `transport_not_configured`, `capability_expired`, `quota_exceeded`, `too_large`, `hash_mismatch`, `not_durable`, `body_missing`, `blob_unavailable` 등 | op `prepared` 유지, 같은 requestId로 나중에 재시도 |

새 파일의 부모 폴더가 카탈로그에 등록되지 않았으면(`parent_not_registered`) 또는 이름이 모호하면(`path_ambiguous`) op를 만들지 않고 dirty로 둔다.

`report-local`: 카탈로그 fileId가 있는 로컬 사본마다 `{machineId, writerEpoch, seq, fileId, versionId, dirty}`를 보낸다.
dirty/uploading/conflict는 `dirty:true`, clean은 기준 버전이 카탈로그 현재 버전일 때만 `dirty:false`로 보낸다.
seq는 전송 전에 저널에 기록되고 증가만 한다. `applied:false`면 서버 seq를 넘는 값으로 다음에 다시 보낸다(값이 같으면 확인 완료).
`stale_writer`·`not_verified`는 미확인으로 남는다. remote-only(회수된 사본)는 보고하지 않는다(core가 "사본 없음" 표현을 갖지 않음).

`BackendError`가 아닌 예외(타임아웃·연결 끊김)는 결과를 모르는 것으로 보고 op를 `unknown`으로 남긴다.

에이전트가 clean으로 전환하는 조건(모두 충족):
1. receipt의 `requestId`가 파일의 현재 `activeOp`이고 op가 미확정 상태다. 아니면 `stale_ack`로 무시한다.
2. `canonical == true`, `fileId`(신규면 발급값), `size`, `sha256`, `baseVersion`, `writerEpoch`가 staged 스냅샷과 일치하고
   `versionId`가 기준 버전과 다르다. 불일치는 `receipt_mismatch`로 op를 `unknown`에 둔다.
3. 업로드 이후 로컬 파일 내용이 staged 해시와 같다. 다르면(업로드 중 변경) `dirty` 유지, 기준 버전만 receipt 버전으로 전진.

ETag·HEAD·로컬 쓰기 완료를 원격 저장 확인으로 취급하지 않는다.
## 5. 용량·전송 한도

- 다운로드·업로드 staging 전 `free - size >= reserveBytes`가 필요하다. 부족하면 `--auto-evict`가 켜진 경우에만
  회수 가능한 clean `agent` 캐시를 LRU로 회수하고, 그래도 부족하면 `insufficient_space`로 거절한다. 계획 §9에 따라
  원격 저장 확인이 실측되기 전까지 자동 회수 기본값은 꺼져 있다(명시적 `evict`는 가능). dirty·pinned·open·`user` 파일은 회수하지 않는다.
- 파일당 전송 상한 `maxTransferBytes`(기본 1 GiB). 기대 크기를 넘는 바이트가 오면 즉시 중단(`size_mismatch`).
- 업로드 스냅샷 복사는 최초 stat이 아니라 **복사하는 청크마다** 한도를 검사한다: 누적이 `maxTransferBytes`를 넘으면 `transfer_too_large`, 다음 청크를 쓰면 `free < reserveBytes`가 되면 `insufficient_space`. 커지는 중인 파일도 한도 안에서 멈추고, 부분 staging은 지우며 파일은 `dirty`로 남는다(op 미생성).
- 다운로드는 staging 임시 파일 → 크기·SHA-256 검증 → fsync → 원자적 rename 순서. 실패 시 기존 파일을 건드리지 않는다.
- 회수 직전 파일의 크기·mtime·해시를 다시 확인한다. 기록과 다르면 삭제하지 않고 `dirty`로 기록한다.

## 6. 재시작 복구

시작 시 `fetching` 임시 파일(에이전트 staging 소유)만 정리한다. `sending` op는 `unknown`이 되어 dirty를 유지한다.
업로드용 staged 스냅샷은 op가 committed/conflict/rejected로 끝날 때까지 보존한다.

## 7. 남은 위험

- symlink 검사는 lstat 후 사용 시점까지의 경쟁(TOCTOU)을 완전히 막지 못한다. 최종 파일은 POSIX에서 `O_NOFOLLOW`로 열지만
  중간 디렉터리 교체 공격은 같은 사용자 권한의 프로세스를 전제로 한 잔여 위험이다.
- 로컬 변경 감지는 `mark-dirty` 호출과 open/evict 시의 크기·mtime 비교(차이 시 해시)에 의존한다. **autosave watcher·
  주기 sync·사용 종료 lifecycle 연결은 아직 없다**(누가 언제 `sync`/`report-local`/`prepare-end`를 부르는지 미정).
- 삭제·rename·폴더 이동의 로컬→원격 반영, 충돌 해결 UI는 범위 밖이다. 카탈로그 전체를 당겨오는 pull도 없다(서버가 만든 manifest만 등록).
- open lease는 명시적 `close`까지 유지된다(재시작 후에도). 앱 프로세스 종료 자동 감지는 없다.
- 업로드는 파일당 PUT 한 번이다(32 MiB 초기 한도 가정). 큰 파일 multipart·재개는 없다.
- 미확정 begin 재전송은 만료된 업로드를 클라이언트 시계로 판정한다. 시계가 빠르면 새 op가 생기고 이전 예약은 TTL까지 남는다(데이터 손실은 없음).
- writer epoch가 바뀌면 이전 epoch로 준비된 op는 `stale_writer` → conflict가 된다(내용 보존, 사용자 해결 필요).

## 8. 증거 수준

증거는 합성 임시 디렉터리 + 가짜 backend + **loopback 가짜 HTTP 서버**(core 모양) 시험뿐이다. Windows 19 pass/3 skip,
WSL Ubuntu(POSIX) 19 pass/0 skip. 실제 앱 route, 실제 R2/DO 저장 확인, 실제 VM 디스크, 성능·지연은 측정하지 않았다.
