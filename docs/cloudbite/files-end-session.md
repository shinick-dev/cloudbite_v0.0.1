# 사용 종료(safe end)와 환경 백업 연결

상위 계약: `docs/cloudbite/cloud-files-implementation-plan.md` §6. 이 문서는 `ComputerService`에 들어간 종료 상태 기계와
루트가 연결할 helper 계약만 적는다. 보관 정책(6시간 최소 간격, 검증 3개 + 대기 1개, 소유 확인 후 삭제)은 백업 관리자
`src/cloudbite-computer-backups.ts`의 몫이며 여기서는 중복 구현하지 않는다.

## 두 가지 종료 방식

| 방식 | 화면 문구 | 하는 일 | 파일 상태 |
|---|---|---|---|
| `disk_backup` | 종료하고 환경 보관 / End and keep environment | `sync` → provider stop(디스크 유지) → 백업 관리자에 비공개 cold capture 요청 | drain 미연결이면 `not_configured`, 연결돼 있으면 `unverified` |
| `files_verified` | 파일 저장 확인 후 종료 / Check files are saved, then end | 관리 파일 drain이 모두 원격 저장을 증명한 뒤에만 stop → 백업 | `verified`(확인 시점 기준) 또는 `blocked` |

- 화면은 버튼 하나만 보여 준다. drain이 연결돼 있으면 `files_verified`, 아니고 백업 관리자만 있으면 `disk_backup`,
  둘 다 없으면 종료 버튼을 숨기고 기존 ‘중지’만 남긴다(중지도 디스크를 남긴다).
- 어떤 방식도 머신·디스크를 삭제하지 않는다. cold capture는 디스크 전체(로컬 파일 포함)를 담으며 제외 경로를 주장하지 않는다.
  RAM·열린 프로그램·앱의 미저장 버퍼는 어떤 방식으로도 저장되지 않는다.
- 파일 상태와 환경 백업 상태는 별개다. `environmentBackup: active`는 “모든 파일 저장됨”을 뜻하지 않는다.

## 상태 기계

`draining → stopping → backing_up → done`, 종료 상태로 `blocked`(머신 계속 실행) · `failed`(디스크 유지) · `cancelled`.

1. `POST end`는 `draining`을 저장하고 즉시 돌아온다. 이후 단계는 DO alarm이 10초 간격으로 진행한다(긴 HTTP 없음).
2. 각 외부 호출(drain, stop) 직전에 단계와 시도 횟수를 저장한다. DO가 재기동해도 같은 기록에서 이어진다.
3. `files_verified`: drain을 최대 12회(약 2분) 시도. `agentReady && managedScanComplete && !scanLimited`이고
   dirty/uploading/conflict/unconfirmedOps/open/pendingDeletions/errors가 모두 0일 때만 증명으로 본다.
   빈 journal의 bare agent ready는 증명이 아니다. 끝내 증명이 안 되면 `blocked` — 머신은 계속 실행되고 `resume` hook을 부른다.
4. stop은 최대 2회 전송, 상태는 GET으로 관찰(약 10분). 응답 없는 stop은 GET으로 조정하며 맹목 재전송하지 않는다.
5. 정지 확인 뒤 `backup.begin`(같은 requestId, `environmentRevision: null`)을 부르고 이후 alarm마다 `tick`.
   `active/coalesced/failed/blocked`면 `done`, `pending/unknown`은 최대 360회(약 1시간) 후 `unknown`으로 끝낸다.
   begin이 응답하지 않으면 다음 alarm에 같은 requestId로 다시 묻는다(관리자는 requestId에 대해 멱등).
6. 관리자 상태의 `work: true`(예: 새 백업 active 뒤 보관 정리)는 `done` 이후에도 alarm마다 `tick`을 부르게 한다.
   `work`가 거짓이 되거나 360회(약 1시간)에 닿으면 멈춘다. 이 service는 삭제·재시작을 하지 않으며 tick 안의 정리는 관리자 몫이다.
7. `coalesced`는 새 백업이 아니다: 이전 복구 지점을 재사용하고, 그 뒤 변경은 남아 있는 디스크에만 있다. 화면도 그렇게 말하고
   디스크 보존(단계 줄)과 백업 상태(백업 줄)를 따로 보여 준다. 새 사본이 필요하면 수동 스냅샷을 쓴다.

## 기한·강제 정지

- 세션 기한은 유료 실행을 늘리지 않는다. 사용자 종료가 drain 중이어도 기한이 되면 마지막 drain 한 번 뒤 정지하고,
  증명되지 않았으면 파일을 `pending`으로 남긴다(디스크 유지). 이것을 백업 성공이나 저장 완료로 표시하지 않는다.
- 자동 종료는 opt-in(`end/settings {autoEnd}`)이다. 기한 5분 전부터 drain을 시도하고 **기한에** 정지한다. 일찍 검증돼도
  남은 유료 시간을 줄이지 않는다. 기한 전 연장(extend)은 아직 정지하지 않은 자동 종료를 `cancelled`로 돌린다.
- opt-in하지 않은 소유자는 예전과 같다: 기한에 디스크를 남기는 정지만 하고 자동 백업은 없다.
- provider auto-stop 등 외부 정지가 관찰되면 opt-in 소유자에게만 `provider_stop` 종료 기록(파일 `unverified`)을 만들고
  환경 백업을 이어 간다. 자동 재시작은 하지 않는다.
- 종료 진행 중에는 start·수동 snapshot·resize가 `busy`다. 기존 ‘중지’는 drain 단계만 가로챌 수 있다(파일 `unverified`).

## 루트 연결 계약

- RPC: `computerEnd(ownerTag, {requestId, mode})`, `computerEndStatus(ownerTag)`(저장소 읽기만, provider 호출 없음),
  `computerEndSettings(ownerTag, {requestId, autoEnd})`. `ComputerState.end`도 같은 보기를 담는다.
- 제안 경로: `POST/GET /api/cloudbite/computer/end`, `POST /api/cloudbite/computer/end/settings`. 기존과 같은 소유자 쿠키·
  정확한 Origin·requestId 의미론. 화면은 `GET end`의 `modes`/`backupConfigured`로 버튼을 정한다(경로가 없으면 기존 중지만).
- `uploadsFrozen`(draining/stopping)이 참이면 파일 런타임은 새 관리 업로드를 받지 않는다.
- `setComputerEndHooks((env, storage) => ({ drain, resume, backup }))`를 모듈 로드 시 한 번 호출한다.
  hook은 DO의 직렬 큐 안에서 돌므로 큐를 쓰는 ComputerService/DO 메서드를 다시 부르면 안 된다(`computerMachine`은 큐 밖 읽기).
- `computerBackupProtectedNames(env, storage, ownerTag): Promise<readonly string[]>`(service 모듈 export): 설정된 prepared image 전부,
  선택된 template, 현재 머신의 template, 현재 수동 스냅샷과 수동 이력 이름. 저장소 읽기만 하며 큐·provider를 쓰지 않는다.
  다른 소유자에 묶인 기록이나 잘못된 태그면 throw한다(fail closed — 호출자는 아무것도 지우지 않는다).
- `drain`은 watcher+agent 결합 prepare-end 보고가 실제로 있을 때만 연결한다. 그 전에는 `files_verified`가
  `files_not_configured`로 거절되고 `disk_backup`은 R2 없이도 동작한다.
- drain 이후에도 외부 앱은 디스크에 쓸 수 있다: `verified`는 “확인 시점 기준”이며 앱 정지·RPO 0이 아니다.

## Daytona 어댑터 추가

- `ComputerSnapshotInfo`에 `sourceSandboxId`(nullable)·`general`·`organizationId`·`createdAt`. `size`·`diskAllocation`은
  단위가 문서화되지 않았고 물리 바이트가 아니므로 읽지 않는다(비용·용량 근거로 쓰지 않음).
- `removeSnapshot(c, id)`: `DELETE /snapshots/{id}`(id만). 200은 완료가 아니며 이후 GET 404로만 삭제를 확인한다. 되돌릴 수
  없고 warm pool도 지운다. 이 어댑터는 백업 관리자가 소유가 증명된 자동 백업에만 쓴다. 이 작업에서 실제 삭제는 하지 않았다.

## 검증 범위

`test/cloudbite-computer-end-session.mjs`는 가짜 Daytona·drain·백업 관리자와 작은 가짜 DOM으로만 확인한다(n=소수).
실제 persistence·백업·지연·실기기 증거가 아니다.
