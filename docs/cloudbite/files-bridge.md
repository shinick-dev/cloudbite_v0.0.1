# CloudBite 파일 VM bridge · 에이전트 HTTP route 계약

상태: bridge 모듈·에이전트 HTTPS transport 구현, 시험은 모두 mock(가짜 Daytona 호출 기록, loopback 가짜 core 서버)이다.
실제 VM 설치·실제 route·실제 R2/DO 저장·지연은 검증하지 않았다. route 배선과 capability 발급은 CFRuntime/root 소유다.

구현: `src/cloudbite-computer-files-bridge.ts` · `images/cloudbite-computer/files-agent.py`(`HttpBackend`)
시험: `node test/cloudbite-computer-files-bridge.mjs` · `python -B test/cloudbite-computer-files-agent.py`
관련: [files-agent-contract.md](files-agent-contract.md), [files-core-contract.md](files-core-contract.md), [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md).

## 1. 경계

- bridge는 **현재 running 상태의 소유 컴퓨터**에만 작동한다. 시작·중지·재시작·스냅샷·삭제 호출이 없다(의존성에 그런 함수 자체가 없다).
- 소유 증명: `deps.machine()`(running만)의 id로 sandbox를 읽어 `id`, 정확한 `name`, **모든 label**이 일치하고 `state=='started'`일 때만 진행.
  빈 label 집합은 소유 증명이 아니다. 실패 시 capability 발급·exec·upload를 하나도 하지 않는다.
- origin이 `https://host[:port]`가 아니거나 계정이 없으면 `not_configured`로 **유료/제공자 호출 전에** 실패한다.
- VM에서 쓰는 경로는 고정 두 곳뿐이다:
  - `/home/daytona/.local/share/cloudbite-files/` — `agent/files-agent.py`, `capability.json`(0600), `state/`, `manifests/`, `root-owned` 표식
  - `/home/daytona/CloudFiles` — 새 전용 workspace root(0700). **없을 때만 만든다**. 이미 있는데 bridge가 만든 표식이 없으면
    `workspace_exists_unowned`(409), symlink면 `install_failed`. 기존 사용자 파일을 바꾸지 않고 HOME 전체를 훑지 않는다.
- 비밀: capability 토큰은 0600으로 미리 만든 `capability.json.next`의 **업로드 본문에만** 들어간다. 그다음 `chmod 600` + 같은 디렉터리 `mv -f`(원자적).
  argv·exec 명령·응답·로그에 토큰이 없다. exec 명령에는 검증된 식별자(`[A-Za-z0-9._:-]`, 선행 `-` 금지)와 고정 경로만 들어간다.

## 2. 에이전트 route (CFRuntime 구현, `HttpBackend` 호출)

접두사 `FILES_AGENT_PREFIX = /api/cloudbite/computer/files/agent/v1`.

인증: `authorization: Bearer <token>`만. owner cookie·Origin 없음 — 서버는 이 route에서 `Origin`/`Cookie`가 있으면 거절하는 것을 권장한다.
토큰 1개 = (ownerId, machineId, writerEpoch, expiresAt). 서버는 토큰 해시만 저장한다. 매 호출 검사:
유효(401 `capability_invalid`), 미만료(401 `capability_expired`), 그 machine/epoch가 아직 writer(409 `stale_writer`),
본문의 `writerEpoch`/`machineId`가 capability와 같음(409 `stale_writer`). **3xx 금지.** JSON 응답 ≤ 1 MiB. 오류는 core envelope.

| Method | Path | 요청 | 응답 | core |
|---|---|---|---|---|
| GET | `status` | - | `{status}` | storageStatus |
| POST | `create` | `CreateRequest` | `{entry}` | create |
| POST | `uploads/begin` | `BeginUploadRequest` | `{upload}` | beginUpload |
| PUT | `uploads/{uploadId}/body` | 원시 바이트, `content-length` = upload.size | `{upload}` | writeUploadBody (스트림, 버퍼링 금지) |
| POST | `uploads/{uploadId}/commit` | `{uploadId}` | `{result}` | commitUpload |
| GET | `uploads/{uploadId}` | - | `{upload}` | getUpload |
| GET | `versions/{fileId}/{versionId}/content` | - | 200 바이트, `content-length`=size, `x-cloudbite-sha256` | readVersion (스트림, provider URL 금지) |
| POST | `local-state` | `LocalStateRequest` | `{local, applied}` | recordLocalState |

에이전트 쪽 receipt·재시도 규칙은 [files-agent-contract.md §4](files-agent-contract.md).

## 3. bridge API (CFRuntime/API가 배선)

```ts
filesBridgeInstall(deps, { requestId })                         // 설치/갱신 + init + 상태 확인(네트워크 미사용)
filesBridgeMaterialize(deps, { requestId, manifest, fileId, versionId }) // 명시적 열기 1건
filesBridgeStatus(deps)                                         // 에이전트 집계, 파일 본문 미열람
```
`deps`: `origin`, `machine()`, `account()`, `labels()`, `getSandbox/exec/upload`(=`cbGetSandbox/cbExec/cbUpload`),
`agentSource`(files-agent.py 텍스트, root가 번들), `capability({ownerMachineId, requestId})`(CFRuntime 발급), 선택 `now()`.
`requestId`는 기존 컴퓨터 API와 같은 UUID 형식.

설치 순서: 소유 확인 → capability 발급(machineId 일치, 형식, 만료 ≥ 60초 남음 검증) → PREPARE exec(0600 placeholder) →
agent·capability 업로드 → ACTIVATE exec(chmod + mv) → `init --root /home/daytona/CloudFiles --workspace-id= --machine-id= --writer-epoch=`
→ `--capability ... status`로 scope 확인(`scope_mismatch`면 409). 업로드가 실패하면 ACTIVATE를 하지 않는다.
응답: `{ok, installed, machineId, writerEpoch, expiresAt}` — 토큰 없음.

materialize: manifest는 서버가 카탈로그에서 만든 `[{kind:"dir",fileId,path}… , {kind:"file",fileId,path,versionId,size,sha256}]`
(파일 정확히 1개, 항목 ≤ 64, ≤ 64 KiB, 키 외 필드 금지, 경로 탈출 금지)를 검증한 뒤 0600 manifest를 올리고
`register` → `open --file-id= --version=` 순으로 실행하고 manifest를 지운다. capability를 새로 발급하지 않는다(만료면 에이전트가
`capability_expired`를 돌려주므로 install을 다시 부른다). 응답 `{ok, open:{leaseId,path,state,versionId,fetchedBytes}}`.

오류: `not_configured` 503, `bad_request` 400, `not_running`/`ownership_mismatch`/`workspace_exists_unowned`/`agent_not_installed` 409,
`install_failed` 502, 결과 미확정 `unknown_outcome` 503, 에이전트 거절은 409 + 에이전트 코드(형식 검증된 `[a-z_]` 코드만, 그 외 `agent_failed`).

## 4. 이름 키 정렬

core 충돌 키는 `NFC + toLowerCase`, 에이전트는 `NFC + casefold`. 둘이 다를 수 있는 이름은 에이전트가 `path_ambiguous`로 거절한다
(bridge 시험에서 bridge가 만든 manifest를 실제 Python 에이전트가 읽어 확인). 서버도 해당 이름을 에이전트 경로로 보내지 않는 편이 안전하다.

## 5. 남은 일·위험 (정직한 공백)

- autosave watcher, 주기 `sync`/`report-local`, 사용 종료 시 `prepare-end` 호출, capability 자동 갱신 — **미구현**. 누가 언제 부를지 root 결정 필요.
- route 미배선: 위 표는 계약일 뿐 CFRuntime 구현 전에는 호출이 404다. R2 미활성 상태에서는 `store_not_configured`가 정답이다.
- 원래 사용자 VM(1af294ee-…)과 어떤 live VM에도 설치하지 않았다. 실제 `cbExec`가 `bash -c '…'`를 그대로 실행하는지,
  Daytona 업로드의 파일 모드·소유자, `/home/daytona/CloudFiles`와 state가 같은 파일시스템인지는 live 확인 전이다.
  PREPARE/ACTIVATE 스크립트 자체는 WSL Ubuntu 임시 HOME에서 실행해 모드·멱등·거절 동작을 확인했다(mock 수준 증거).
- manifest 파일명은 requestId라 동시 materialize끼리 충돌하지 않지만, 같은 requestId 재사용은 덮어쓴다(같은 내용이어야 한다).
- materialize의 `open` lease는 닫는 경로가 아직 없다(close 배선 필요). lease가 남아 있으면 `prepare-end`가 ready가 되지 않는다.
- exec 출력은 64 KiB 꼬리만 보고 마지막 JSON 줄만 해석한다.
