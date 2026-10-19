# CloudBite 파일 에이전트 계약 (P1-A/B 로컬 코어)

상태: 로컬 코어 구현·가짜 transport 시험만 완료. 실제 서버 transport는 아직 연결하지 않았다.
CLI의 HTTP 어댑터는 모든 호출을 `transport_not_configured`로 거절하며, 원격 저장 성공을 흉내 내지 않는다.

관련 계획: [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md) §5·§6·§7.
구현: `images/cloudbite-computer/files-agent.py` · 시험: `python -B test/cloudbite-computer-files-agent.py`.

## 1. 경계

- 에이전트는 설정된 **workspace root 한 곳**만 다룬다. root가 HOME 자체·파일시스템 루트·상태 디렉터리 내부이면 거절한다.
- 디렉터리 전체 탐색을 하지 않는다. 카탈로그에 등록된 경로와 사용자가 명시한 경로만 본다.
- 경로는 root 기준 상대 POSIX 경로(`a/b.txt`)다. 절대 경로·`..`·빈 구성요소·NUL·`\`·제어문자를 거절한다.
  기존 구성요소 중 symlink가 하나라도 있으면 거절한다(`path_symlink`). 자격증명/프로필 이름(`.ssh`, `.gnupg`, `.aws`,
  `.netrc`, `.git-credentials`, root 최상위의 `.config`·`.local`·`.mozilla`·`.pki`·`.cache`)은 거절한다(`path_forbidden`).
- 파일명 Unicode는 받은 그대로 보존한다. 충돌 판정 키는 `NFC + casefold`이며, 같은 키의 다른 이름은 `path_collision`.
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
files-agent.py --state DIR status
files-agent.py --state DIR list-local [--cursor N] [--limit N<=500]
files-agent.py --state DIR register --manifest FILE        # [{fileId,path,versionId,size,sha256,mode?}] 메타데이터만
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
`not_configured, invalid_argument, path_invalid, path_forbidden, path_symlink, path_collision, not_found,
version_mismatch, local_modified, local_modified_unrecorded, insufficient_space, transfer_too_large,
size_mismatch, checksum_mismatch, receipt_mismatch, draining, busy, transport_not_configured,
backend_error, base_version_conflict, stale_writer_epoch, request_conflict, quota_exceeded`.

`prepare-end`는 새 open fetch를 막는 draining 상태로 전환하고 다음을 보고한다:
`{ready, safeToDelete, remoteSaved, dirty[], uploading[], conflict[], unconfirmedOps[], open[]}`.
`ready/safeToDelete/remoteSaved`는 dirty·uploading·conflict·미확정 op·열린 lease가 하나도 없을 때만 `true`다.
`safeToDelete`는 “원격 확인 완료”라는 의미일 뿐 에이전트가 무엇을 삭제한다는 뜻이 아니다. 브라우저 닫기는 이 명령을 부르지 않는다.

## 4. 서버 transport 계약 (주입형 backend)

에이전트는 아래 메서드를 가진 backend만 호출한다. 재시도 시 **같은 requestId와 같은 staged 바이트**를 보낸다.
root가 실제 transport를 연결할 때 cf-core 초안(`cloudbite.files.core-contract.draft1`)으로 매핑하는 어댑터를 둔다.

| 에이전트 메서드 | 요청 | 응답 | cf-core 매핑 |
|---|---|---|---|
| `fetch_version` | `{fileId, versionId, maxBytes}` | 바이트 청크 iterator | `open` descriptor + root의 readVersion stream |
| `begin_upload` | `{requestId, fileId\|null, path\|null, baseVersion\|null, writerEpoch, size, sha256}` | `{requestId, uploadId}` | `fileId=null`이면 `create` 후 `beginUpload`(baseVersion null) |
| `put_body` | `{uploadId, offset}` + 청크(≤ 1 MiB) | 무시 | `writeUploadBody` (commit 아님) |
| `commit_upload` | `{requestId, uploadId}` | receipt | `commitUpload` → `CommitResult` |
| `get_operation` | `{requestId, uploadId\|null}` | `{requestId, phase, receipt?, code?}` | `getUpload`; uploadId가 없으면 `unknown_request` |

`phase`: `pending | committed | conflict | rejected | unknown_request`. `unknown_request`는 서버가 요청을 받은 적 없다는
확정 답이며, 이때만 같은 requestId로 다시 보낸다(서버는 requestId 멱등이어야 한다).

receipt: `{requestId, fileId, versionId, baseVersion, size, sha256, writerEpoch, canonical: true}`.
어댑터는 `CommitResult{status:"committed", durable:true}`와 `UploadView`의 `baseVersion/writerEpoch`로 receipt를 만들고,
`status:"conflict"`는 `BackendError("base_version_conflict")`로 넘긴다.

backend 오류는 `BackendError(code)`로 던진다(확정 거절). 에이전트 처리:

| 코드 | 처리 |
|---|---|
| `base_version_conflict`, `stale_writer_epoch`, `stale_writer`, `stale_revision` | op `conflict`, 파일 `conflict`(로컬 내용 보존) |
| `request_conflict` | op `rejected`, 파일 `dirty` 유지(다음 sync에서 새 op) |
| `commit_unknown`, `invalid_upload_state` | op `unknown` → `reconcile` |
| `transport_not_configured`, `quota_exceeded`, `too_large`, `hash_mismatch`, `not_durable`, `body_missing` 등 | op `prepared` 유지, 같은 requestId로 나중에 재시도 |

`BackendError`가 아닌 예외(타임아웃·연결 끊김)는 결과를 모르는 것으로 보고 op를 `unknown`으로 남긴다.

에이전트가 clean으로 전환하는 조건(모두 충족):
1. receipt의 `requestId`가 파일의 현재 `activeOp`이고 op가 미확정 상태다. 아니면 `stale_ack`로 무시한다.
2. `canonical == true`, `fileId`(신규면 발급값), `size`, `sha256`, `baseVersion`, `writerEpoch`가 staged 스냅샷과 일치하고
   `versionId`가 기준 버전과 다르다. 불일치는 `receipt_mismatch`로 op를 `unknown`에 둔다.
3. 업로드 이후 로컬 파일 내용이 staged 해시와 같다. 다르면(업로드 중 변경) `dirty` 유지, 기준 버전만 receipt 버전으로 전진.

ETag·HEAD·로컬 쓰기 완료를 원격 저장 확인으로 취급하지 않는다. cf-core의 `recordLocalState`(dirty/clean 보고)는
root 통합 시 `list-local` 결과로 보고하도록 연결한다. 이 코어는 그 호출을 하지 않는다.
## 5. 용량·전송 한도

- 다운로드·업로드 staging 전 `free - size >= reserveBytes`가 필요하다. 부족하면 `--auto-evict`가 켜진 경우에만
  회수 가능한 clean `agent` 캐시를 LRU로 회수하고, 그래도 부족하면 `insufficient_space`로 거절한다. 계획 §9에 따라
  원격 저장 확인이 실측되기 전까지 자동 회수 기본값은 꺼져 있다(명시적 `evict`는 가능). dirty·pinned·open·`user` 파일은 회수하지 않는다.
- 파일당 전송 상한 `maxTransferBytes`(기본 1 GiB). 기대 크기를 넘는 바이트가 오면 즉시 중단(`size_mismatch`).
- 다운로드는 staging 임시 파일 → 크기·SHA-256 검증 → fsync → 원자적 rename 순서. 실패 시 기존 파일을 건드리지 않는다.
- 회수 직전 파일의 크기·mtime·해시를 다시 확인한다. 기록과 다르면 삭제하지 않고 `dirty`로 기록한다.

## 6. 재시작 복구

시작 시 `fetching` 임시 파일(에이전트 staging 소유)만 정리한다. `sending` op는 `unknown`이 되어 dirty를 유지한다.
업로드용 staged 스냅샷은 op가 committed/conflict/rejected로 끝날 때까지 보존한다.

## 7. 남은 위험

- symlink 검사는 lstat 후 사용 시점까지의 경쟁(TOCTOU)을 완전히 막지 못한다. 최종 파일은 POSIX에서 `O_NOFOLLOW`로 열지만
  중간 디렉터리 교체 공격은 같은 사용자 권한의 프로세스를 전제로 한 잔여 위험이다.
- 로컬 변경 감지는 `mark-dirty` 호출과 open/evict 시의 크기·mtime 비교(차이 시 해시)에 의존한다. watcher는 아직 없다.
- 삭제·rename의 로컬→원격 반영, 충돌 해결 UI, `recordLocalState` 보고는 이 코어 범위 밖이다.
- open lease는 명시적 `close`까지 유지된다(재시작 후에도). 앱 프로세스 종료 자동 감지는 없다.

## 8. 증거 수준

현재 증거는 합성 임시 디렉터리 + 가짜 backend 단위 시험뿐이다. 실제 원격 저장 확인, 실제 VM 디스크, 성능·지연은 측정하지 않았다.
