# CloudBite 파일 watcher 계약

상태: 로컬 구현 + 시험. 시험은 임시 디렉터리·실제 files agent(transport 없음)·가짜 agent CLI뿐이며 실제 VM 설치·실행·원격 저장 증거가 아니다.
VM 설치·시작은 root/bridge 통합이 맡는다(이 작업은 live VM 조작을 하지 않았다).

관련: [files-agent-contract.md](files-agent-contract.md), [files-bridge.md](files-bridge.md), [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md) §6·§7.
구현: `images/cloudbite-computer/files-watch.py` · 시험: `python -B test/cloudbite-computer-files-watch.py`
번들: `node tools/build-cloudbite-files-watch.mjs [--check]` → `src/cloudbite-computer-files-watch-source.ts` (`FILES_WATCH_SOURCE`, `_SHA256`, `_BYTES`).

## 1. 목적과 경계

- 관리 workspace(기본 `/home/daytona/CloudFiles`)의 편집을 매번 명시적 `mark-dirty` 없이 agent dirty journal에 넣는다.
- root는 agent `journal.sqlite3`의 `root`와 **같아야** 한다(읽기 전용 확인, 다르면 `root_mismatch`). 실제 디렉터리·symlink 아님·
  `/`·HOME·HOME을 포함하는 경로 아님·두 state 디렉터리와 겹치지 않음·소유자 본인·group/other 쓰기 불가.
- 첫 실행이 `--state`(0700)에 `config.json`(0600)으로 root·agent·agent-state·capability 경로·allowlist·파일 상한을 고정한다.
  이후 다른 값이면 `config_mismatch`.
- watcher는 workspace 파일을 바꾸거나 옮기거나 지우지 않는다. cache를 evict하지 않고, 머신을 시작하지 않는다.
- agent 호출: `python -I -B files-agent.py --state S [--capability C] <cmd>`, argv 목록·shell 없음·최소 환경, 경로는 `--path=REL`.
  capability 파일은 경로만 넘기고 watcher가 읽지 않는다. 출력은 메타데이터 JSON뿐(본문·토큰 없음).
- 다루지 않음: 앱 RAM·저장 안 된 편집 버퍼, 디스크 snapshot, 파일시스템 freeze.

## 2. 탐색(폴링)

- inotify 없이 제한된 폴링: tick마다 최대 `--max-entries`(≤1000) 항목을 lstat. 디렉터리 큐와 재개 위치(이름 바이트 순서의 마지막 처리 이름)를
  SQLite(WAL, synchronous=FULL)에 저장하므로 crash·재시작 후 같은 generation을 이어서 걷는다.
- 깊이 ≤32, 디렉터리당 자식 ≤5000, 파일 ≤32 MiB(`--max-file-bytes`로 더 낮출 수만 있음). symlink는 따라가지 않는다.
- 변경 판정: (size, mtime_ns, inode, ctime_ns). atomic replace(임시 파일 + rename, mtime 보존 포함)는 inode/ctime으로 잡는다.
- debounce(기본 2초): 서명이 바뀐 뒤 그 시간 동안 그대로인 파일만 해시한다. 해시 전후 서명이 다르면(쓰는 중) 표시하지 않고 창을 다시 시작한다.
  해시가 agent가 마지막으로 받은 해시와 같으면(touch) agent를 부르지 않는다. mtime이 2초 이내인 파일은 racy로 두고 다음 관찰 때 다시 해시한다.
- agent의 staged snapshot·로컬 해시 검증이 최종 판정이다(watcher 해시는 호출 여부만 정한다).

## 3. 범위 분류 (출력 `scope`)

| 분류 | 예 | readiness |
|---|---|---|
| excluded | `node_modules`, `.venv`, `.git`/`.hg`/`.svn`, `__pycache__` 등 build cache, 편집기 임시파일(`*.swp`, `.goutputstream-*` …) | 관리 범위 밖, 표시만. 디렉터리는 `--allow NAME`으로 opt-in |
| protected | agent 금지 이름(`.ssh` …, 최상위 `.config`/`.local`/`.cache` …), `.env*`·키(`*.pem`, `id_*` …), 브라우저 프로필(`Login Data`·`key4.db` 등 표식 포함 디렉터리), symlink, 특수 파일 | 관리 범위 밖, 표시만. allowlist 불가 |
| unsupported | 상한 초과, 깊이 초과, 자식 초과, 잘못된/디코딩 불가/`ß` 같은 모호한 이름, NFC+casefold 충돌, agent의 영구 거절 | **차단**(`scanLimited`) |

제외·보호 파일은 원격 저장된 것으로 세지 않는다.

## 4. 삭제·이름 변경

agent에 tombstone이 없다. agent가 알던 파일이 완전한 pass에서 사라지면 watcher journal에 `pendingDeletions`로 남기고(경로당 1건, 중복 없음)
canonical은 지우지 않는다. 같은 경로가 다시 생기면 해제된다. rename = 옛 경로 삭제 대기 + 새 경로 dirty.
`deleteSupport: "unsupported"`이며 대기 삭제가 있으면 end readiness는 막힌다(`deletions_unsupported`). agent에 알리기 전에 사라진 파일은 대기 삭제가 아니다.

## 5. 동기화·실패

- `run`에서 표시가 있었거나 60초마다: `reconcile` → `sync --limit 20`. `parent_not_registered`면 상위 폴더를 `create-dir`(회당 ≤10).
- 일시정지(이후 `resume` 전까지 sync 안 함, 로컬 표시는 계속): `capability_expired` → `credential_expired`, capability 무효/권한/범위 →
  `credential_invalid`, `stale_writer*` → `writer_fenced`, `not_running`, `transport_not_configured`, `quota_exceeded`.
- 일시적 오류: backoff = interval × 2ⁿ(최대 900초), 연속 8회면 `retry_exhausted`로 일시정지. 무기한 유료 재시도 없음.
- agent의 SQLite busy·비정상 종료(`agent_failed`)·시간 초과는 일시적 오류로 보고 해당 파일은 pending으로 남는다.

## 6. CLI

공통: `--state DIR --agent PATH --agent-state DIR [--capability PATH] [--root DIR] [--allow NAME]... [--max-file-bytes N]`.
출력은 JSON 한 줄, 거절은 `{"ok":false,"code"}` + exit 2.

| 명령 | 동작 |
|---|---|
| `scan-once [--max-entries] [--debounce] [--max-marks] [--sync]` | tick 한 번 |
| `run [--interval ≥2] [--max-runtime ≤21600]` | 반복. `drain.request`가 생기면 다음 확인 시 종료(`stopped: drain_requested`), SIGTERM은 정상 종료 |
| `status` | 잠금 없이 상태 조회 |
| `prepare-end [--timeout ≤30]` | 아래 |
| `resume` | draining·일시정지·backoff 해제 + agent `resume`. `run`이 잠금 보유 중이면 `{deferred:true}`(다음 tick에 일시정지 해제) |

단일 writer: `watch.lock`(flock/msvcrt). 잠금이 있으면 `scan-once`/`run`은 `watcher_busy`, draining 중이면 `draining`.

## 7. prepare-end (lifecycle drain hook 입력)

1. `drain.request` 생성 → 실행 중 watcher가 멈추고 잠금을 놓을 때까지 ≤10초 대기(실패 시 `watcher_busy`, 준비 안 됨).
2. watcher `draining` 기록 후 **새 전체 pass**를 timeout의 60%·100000항목 안에서 수행하고 변경 파일을 debounce 없이(해시 전후 서명 확인) 표시.
   끝내지 못하면 `managedScanComplete:false`(`scan_timeout`/`scan_limit`) — 전체 scan을 흉내 내지 않는다.
3. 남은 시간 −0.5초로 agent `prepare-end --flush`(시간 초과 시 kill → `agent_agent_timeout`). 일시정지 상태면 `--flush` 없이
   journal 상태만 받는다(재시도·네트워크 호출 없음). 잠금 대기·scan·해시·agent 실행을 합친 전체 시간이 `--timeout` 안에 끝난다.
   prepare-end는 sync·`create-dir`를 하지 않는다.
4. agent 보고가 실패·누락·형식 오류이면 agent 유래 수(`dirty`·`uploading`·`conflict`·`unconfirmedOps`·`open`)는 0이 아니라 `null`이고
   `errors`가 1 늘며 `agentReady:false`(`agent_<code>`/`agent_report_malformed`). ready여도 목록이 비어 있지 않으면 ready로 보지 않는다.

```
{ok, verified, agentReady, managedScanComplete, scanLimited,
 dirty, uploading, conflict, unconfirmedOps, open, pendingDeletions, errors,
 blocking[], deleteSupport, scope{tracked, excluded, protected, unsupported}, deletionSamples, agentErrors, pause, draining, elapsedMs}
```
`agentReady` = agent ok·ready·remoteSaved. `dirty` = agent dirty + 아직 표시 못 한 변경. `scanLimited` = pass 미완료·잠금 실패·unsupported 존재.
`verified` = agentReady ∧ managedScanComplete ∧ ¬scanLimited ∧ 모든 수 0 (`computerDrainVerified`와 같은 규칙).
draining은 `resume`까지 유지된다(lifecycle `resume` hook에서 호출).
