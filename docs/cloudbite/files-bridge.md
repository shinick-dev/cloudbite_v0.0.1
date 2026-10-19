# CloudBite 파일 VM bridge · 에이전트 HTTP route 계약

상태: bridge 모듈·에이전트 HTTPS transport 구현, 시험은 모두 mock(가짜 Daytona 호출 기록, loopback 가짜 core 서버)이다.
실제 VM 설치·실제 route·실제 R2/DO 저장·지연은 검증하지 않았다. route 배선과 capability 발급은 CFRuntime/root 소유다.

구현: `src/cloudbite-computer-files-bridge.ts` · `images/cloudbite-computer/files-agent.py`(`HttpBackend`)
번들: `src/cloudbite-computer-files-agent-source.ts`(생성물, `FILES_AGENT_SOURCE`·`FILES_AGENT_SOURCE_SHA256`·`FILES_AGENT_SOURCE_BYTES`) ←
`node tools/build-cloudbite-files-agent.mjs` (검사: `--check`, 다르면 종료코드 1). 에이전트를 고치면 반드시 다시 생성한다.
시험: `node test/cloudbite-computer-files-bridge.mjs` · `python -B test/cloudbite-computer-files-agent.py`
관련: [files-agent-contract.md](files-agent-contract.md), [files-core-contract.md](files-core-contract.md), [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md).

## 1. 경계

- bridge는 **현재 running 상태의 소유 컴퓨터**에만 작동한다. 시작·중지·재시작·스냅샷·삭제 호출이 없다(의존성에 그런 함수 자체가 없다).
- 소유 증명: `deps.machine()`(running만)의 id로 sandbox를 읽어 `id`, 정확한 `name`, **모든 label**이 일치하고 `state=='started'`일 때만 진행.
  빈 label 집합은 소유 증명이 아니다. 실패 시 capability 발급·exec·upload를 하나도 하지 않는다.
- `gateway`(=`CLOUDBITE_GATEWAY_URL`)가 `https://host[:port]`가 아니거나 계정이 없으면 `not_configured`로 **유료/제공자 호출 전에** 실패한다.
- VM에서 쓰는 경로는 고정 두 곳뿐이다:
  - `/home/daytona/.local/share/cloudbite-files/`(0700) — `agent/files-agent.py`, `capability.json`(0600), `state/`, `manifests/`,
    `owner` 표식(`cloudbite-files-bridge v1 machine=<id> workspace=<id>`), `root-owned` 표식
  - `/home/daytona/CloudFiles` — 새 전용 workspace root(0700). **없을 때만 만든다**.
- PREPARE는 **모든 검사를 첫 쓰기 전에** 한다: `.local`, `.local/share`, base, `agent/state/manifests`, `owner`, `root-owned`, root 중
  하나라도 symlink이거나 디렉터리여야 할 곳이 디렉터리가 아니면 41(`install_failed`). base가 이미 있는데 `owner` 표식이 없거나
  machine/workspace가 다르면 44 `base_exists_unowned`(409). root가 이미 있는데 표식으로 증명된 bridge 생성분이 아니면 42
  `workspace_exists_unowned`(409). 거절 시 아무것도 만들거나 바꾸지 않는다(WSL 시험이 트리 지문으로 확인). ACTIVATE는 업로드된
  `.next`가 symlink가 아닌 일반 파일인지 다시 확인한다(45). 기존 사용자 파일을 바꾸지 않고 HOME 전체를 훑지 않는다.
- 비밀: capability 토큰은 0600으로 미리 만든 `capability.json.next`의 **업로드 본문에만** 들어간다. 그다음 `chmod 600` + 같은 디렉터리 `mv -f`(원자적).
  argv·exec 명령·응답·로그에 토큰이 없다. exec 명령에는 검증된 식별자(`[A-Za-z0-9._:-]`, 선행 `-` 금지)와 고정 경로만 들어간다.

## 2. 에이전트 route (CFRuntime `filesAgentRoute` 구현, `HttpBackend` 호출)

endpoint = `CLOUDBITE_GATEWAY_URL + FILES_AGENT_PREFIX`, `FILES_AGENT_PREFIX = /p/_cloudbite/computer/files/agent/v1`
(runtime `FILES_AGENT_PATH`, 에이전트 `AGENT_PREFIX`와 같은 값; 번들 시험이 일치를 확인). `/api/...` 제어 경로가 아니다.

인증: `authorization: Bearer <token>`만. owner cookie·Origin 없음(runtime은 `Origin`이 있으면 403 `bad_origin`).
토큰 1개 = (owner, machineId, writerEpoch, expiresAt), 서버는 해시만 저장. 매 호출: 유효(401 `capability_invalid`), 미만료(401
`capability_expired`), 그 machine/epoch가 아직 writer이고 running(409 `stale_writer`/`not_running`). **3xx 금지**(에이전트는 따라가지 않고 미확정 처리).
JSON 응답 ≤ 1 MiB. 오류는 core envelope.

| Method | Path | 요청 | 응답 | 에이전트 사용 |
|---|---|---|---|---|
| GET | `status` | - | `{status, agent}` | - |
| POST | `create` | `CreateRequest` | `{entry}` | 새 파일(`<rid>:create`)·폴더 등록 |
| POST | `open` | `{fileId, versionId}` | `{descriptor: VersionView & {name}}` | fetch 전 신뢰 descriptor 확인 |
| GET | `content/{fileId}?versionId={v}` | - | 바이트, `content-length`, `x-cloudbite-sha256`, `x-cloudbite-version` | fetch (스트림) |
| POST | `uploads/begin` | `BeginUploadRequest` | `{upload}` | 같은 requestId → 같은 uploadId |
| PUT | `uploads/{uploadId}/body` | 원시 바이트, `content-length` = size | `{upload}` | 커밋 아님 |
| POST | `uploads/{uploadId}/commit` | `{uploadId}` | `{result}` | canonical receipt |
| GET | `uploads/{uploadId}` | - | `{upload}` | reconcile |
| POST | `local-state` | `LocalStateRequest` | `{local, applied}` | report-local |

`versions/{f}/{v}/content` 경로는 없다. fetch 순서: `open` descriptor의 `fileId/versionId/size/sha256`이 manifest로 등록된 값과
같아야 하고(다르면 `version_mismatch`, content 요청·로컬 쓰기 없음), content 응답 헤더가 있으면 크기·해시·버전이 일치해야 하며,
본문 SHA-256을 staging에서 검증한 뒤에만 rename한다. 에이전트 쪽 receipt·재시도 규칙은 [files-agent-contract.md §4](files-agent-contract.md).

## 3. bridge API (root가 배선)

```ts
filesBridgeInstall(deps, { requestId })                         // 설치/갱신 + init + 상태 확인(네트워크 미사용)
filesBridgeMaterialize(deps, { requestId, manifest, fileId, versionId }) // 명시적 열기 1건
filesBridgeStatus(deps)                                         // 에이전트 집계, 파일 본문 미열람
filesBridgePrepareEnd(deps, { flush? })                         // 미래 lifecycle용 종료 준비(배선 안 됨)
```
`deps`: `gateway`(=`env.CLOUDBITE_GATEWAY_URL`), `machine()`, `account()`, `labels()`, `getSandbox/exec/upload`(=`cbGetSandbox/cbExec/cbUpload`),
`agentSource`(= `FILES_AGENT_SOURCE`), `grant({machine, requestId})`(= runtime `filesAgentGrant(env, tag, machineRef, requestId)`), 선택 `now()`.
`grant` 반환은 runtime `FilesResult<FilesAgentGrant>` 그대로: `{ok:true, body:{token,machineId,writerEpoch,workspaceId,expiresAt,endpoint}}`
또는 `{error:{code,message,retryable}, status}`. `requestId`는 기존 컴퓨터 API와 같은 UUID 형식.

설치 순서: 소유 확인 → grant(현재 machine 객체 그대로 전달) → 검증: `body.endpoint === filesBridgeEndpoint(gateway)` **정확히 일치**
(다른 host·http·`/api/...`·꼬리 `/` 모두 거절), `machineId` 일치, 토큰 형식, 만료 ≥ 60초 → PREPARE exec(0600 placeholder) →
agent·capability 업로드 → ACTIVATE exec(chmod + mv) → `init --root /home/daytona/CloudFiles --workspace-id= --machine-id= --writer-epoch=`
→ `--capability ... status`로 scope 확인(`scope_mismatch`면 409). 업로드가 실패하면 ACTIVATE를 하지 않는다. grant 오류는 형식이 맞는 code와
4xx/5xx status를 그대로 전달하고, 그 밖의 모양은 `install_failed`(502)다. 어느 경우든 exec·upload 없음.
capability 파일: `{schema:"cloudbite.files.agent-capability.v1", endpoint, token, machineId, workspaceId, writerEpoch, expiresAt}`.
에이전트도 `endpoint` 경로가 정확히 접두사인지(https, 시험용 loopback http만 예외; userinfo·query·fragment 금지) 다시 확인한다.
응답: `{ok, installed, machineId, writerEpoch, expiresAt}` — 토큰 없음.

materialize: manifest는 서버가 카탈로그에서 만든 `[{kind:"dir",fileId,path}… , {kind:"file",fileId,path,versionId,size,sha256}]`
(파일 정확히 1개, 항목 ≤ 64, ≤ 64 KiB, 키 외 필드 금지, 경로 탈출 금지)를 검증한 뒤 0600 manifest를 올리고
`register` → `open --file-id= --version=` 순으로 실행하고 manifest를 지운다. capability를 새로 발급하지 않는다(만료면 에이전트가
`capability_expired`를 돌려주므로 install을 다시 부른다). 응답 `{ok, open:{leaseId,path,state,versionId,fetchedBytes}}`.

prepare-end: 설치된 에이전트에 `prepare-end [--flush]`만 실행한다(시작·중지·삭제 없음, running이 아니면 `not_running`). 응답
`{ok, end:{ready, remoteSaved, safeToDelete, dirty[], uploading[], conflict[], unconfirmedOps[], open[], errors[]}}`.
draining으로 들어가 새 fetch를 막고, `--flush`면 reconcile → sync → reconcile 후 보고한다. `ready`는 남은 것이 하나도 없을 때만 true.
되돌리기는 에이전트 `resume`(bridge 미노출). watcher·자동 호출·중지 연동은 **이번 범위 밖**이다.

오류: `not_configured` 503, `bad_request` 400, `not_running`/`ownership_mismatch`/`workspace_exists_unowned`/`agent_not_installed` 409,
`base_exists_unowned` 409, `install_failed` 502, 결과 미확정 `unknown_outcome` 503, 에이전트 거절은 409 + 에이전트 코드(형식 검증된 `[a-z_]` 코드만, 그 외 `agent_failed`).
## 4. 이름 키 정렬

core 충돌 키는 `NFC + toLowerCase`, 에이전트는 `NFC + casefold`. 둘이 다를 수 있는 이름은 에이전트가 `path_ambiguous`로 거절한다
(bridge 시험에서 bridge가 만든 manifest를 실제 Python 에이전트가 읽어 확인). 서버도 해당 이름을 에이전트 경로로 보내지 않는 편이 안전하다.

## 5. 남은 일·위험 (정직한 공백)

- autosave watcher, 주기 `sync`/`report-local`, capability 자동 갱신 — **미구현**. `filesBridgePrepareEnd`는 helper만 있고 lifecycle에 배선되지 않았다.
- route 배선은 runtime/root 소유다. 이 bridge 시험은 runtime 코드를 실행하지 않는다(경로·헤더 모양은 runtime 소스와 대조만 함). R2 미활성 상태에서는 `store_not_configured`가 정답이다.
- 원래 사용자 VM(1af294ee-…)과 어떤 live VM에도 설치하지 않았다. 실제 `cbExec`가 `bash -c '…'`를 그대로 실행하는지,
  Daytona 업로드의 파일 모드·소유자, `/home/daytona/CloudFiles`와 state가 같은 파일시스템인지는 live 확인 전이다.
  PREPARE/ACTIVATE 스크립트 자체는 WSL Ubuntu 임시 HOME에서 실행해 모드·멱등·거절 동작을 확인했다(mock 수준 증거).
- manifest 파일명은 requestId라 동시 materialize끼리 충돌하지 않지만, 같은 requestId 재사용은 덮어쓴다(같은 내용이어야 한다).
- materialize의 `open` lease는 닫는 경로가 아직 없다(close 배선 필요). lease가 남아 있으면 `prepare-end`가 ready가 되지 않는다.
- exec 출력은 64 KiB 꼬리만 보고 마지막 JSON 줄만 해석한다.
