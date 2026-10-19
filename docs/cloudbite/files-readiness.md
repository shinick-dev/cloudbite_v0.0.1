# Cloud Files 준비 상태 · 재개 기록

작성일: 2026-10-19 · 기준 커밋: `8b2d5f6000ac7cb45898e10e494e9752d154812c` · 상위 설계: [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md)

엔지니어 재개용 상태 기록이다. 사용자 안내서가 아니다. 이 문서는 **배포 완료를 주장하지 않는다**. 배포 상태 칸은 최종 검토와 릴리스 가드 뒤에 루트가 채운다.

## 1. 한 줄 요약

메타데이터 카탈로그·UI·버전 코어와 `disk_backup` 종료는 코드와 mock 시험까지 준비됐다. 실제 외부 파일 저장·캐시 회수 acceptance, `files_verified` 종료는 아직 열리지 않았다. VM watcher 설치·재개 경로는 코드와 mock/local 시험까지 통합됐다. R2는 사용자 결정에 따라 활성화하지 않았다. bucket이나 구독도 만들지 않았다.

## 2. 상태 매트릭스

시험 수는 기준 커밋에서 루트가 accept한 모듈별 통과 수다. 모두 mock 또는 local loopback 시험이며 live 증거가 아니다. 최신 v6/v7를 포함한 전체 `npm run check`와 `npm run test:cloudbite`가 `ca8a653`에서 통과했다.

| 영역 | 구현 | 시험 (mock/local) | 게이트 / 미완 |
|---|---|---|---|
| 카탈로그·버전 코어 ([core](files-core-contract.md)) | 완료 | 27 | 실제 R2 본문 저장은 미검증 (binding 없음) |
| 런타임 ([runtime](files-runtime.md)) | 완료 | 13 | 위와 같음 |
| 내 파일 UI ([ui](files-ui.md)) | 완료 | 21 | R2가 없으면 *Prepare on cloud computer* 비활성 |
| VM bridge ([bridge](files-bridge.md)) | 완료 | 15 | R2가 없으면 `503 store_not_configured` |
| 파일 에이전트 ([agent](files-agent-contract.md)) | 완료 | 25 (+5 Windows POSIX skip; WSL 25/0) | HTTP cache eviction OFF |
| watcher ([watch](files-watch.md)) | 설치·재개 경로 통합 | 18 (+2 skip) | R2 조건부, 실제 VM 설치는 미실행 (§5) |
| 사용 종료 ([end](files-end-session.md)) | 완료 | 28 | `files_verified` 의도적 비활성 |
| 자동 백업 ([backups](files-backups.md)) | 완료 | 27 | live 검증은 n=1 probe뿐 (§4) |
| ComputerService | 완료 | 26 | stopped→start resume 빚 반영 (`649f512`, §5) |
| 스냅샷 ([snapshots](computer-snapshots.md)) | 완료 | 17 | — |
| 통합 경로 ([integration](files-integration.md)) | 배선 완료 | 13 (mock/local 체인) | DO·R2 in-memory, 가짜 VM, TLS 미검증 |

- 로컬 workerd 3 MiB smoke는 위 시험과 별개다. 원격(remote) 증거가 아니다.
- 네이티브 구현 후보는 accept됐다. **마지막 변경의 독립 검토는 끝났고, 아래 장시간 동기화 제약(F1)을 확인했다. 배포 가드는 아직 실행 전이다.**

## 3. 동작 정책 (현재 코드 기준)

- **업로드·quota**: 초기 업로드는 파일당 32 MiB, quota는 2 GiB이며 `used + reserved` 기준으로 센다. 중단된 업로드의 바이트도 안전한 GC 전까지 계속 잡혀 있다. 절감 수치는 표시하지 않는다.
- **Pin**: 요청된 메타데이터다. 실제로 VM에 사본이 상주한다는 증거가 아니다.
- **HTTP cache eviction**: 수동과 자동 모두 OFF다 (`eviction_policy = None`). 우회 경로는 없다.
- **관리 범위**: `~/CloudFiles` 전용이다. 자격증명·프로필·캐시는 제외한다. 상한을 넘는 삭제와 지원하지 않는 삭제는 검증 drain을 막는다.
- **종료 방식**
  - `disk_backup`은 동작한다. 각 항목 소유 계정의 비공개 cold capture를 쓰고, 디스크를 유지하며, 파일시스템 전체를 담는다. RAM과 앱의 미저장 버퍼는 저장하지 않는다.
  - `files_verified`는 watcher·drain·재진입·admission 전체가 증명될 때까지 의도적으로 막혀 있다 (`409 files_not_configured`).
  - 자동 종료는 opt-in이다. 기존 Stop은 계속 쓸 수 있다.
- **백업 보관**
  - 최소 간격 6시간, 검증본 3개와 교체 대기 1개를 두고 하루 최대 4회 만든다.
  - `coalesced`는 새 백업이 아니라 이전 복구 지점을 재사용한다는 뜻이다. 외부 저장이 없으면 그 뒤의 변경은 유지된 디스크에만 있다.
  - owner·최신본·template은 엄격히 보호한다. 출처를 모르는 create는 맹목적으로 재시도하지 않고, 출처를 모르는 자원은 지우지 않는다.
- 작업자는 사용자의 원래 VM을 변경하지 않았다. 실제 사용자 머신에 새로 설치한 것도 없다.

## 4. 실측 (live probe, n=1)

상세: [end-backup-probe.md](end-backup-probe.md). 실행한 스크립트는 `98eb8ec`, manager 소스는 `33ddfea`이다.

| 항목 | 값 |
|---|---|
| 데이터 | 29,425,850 bytes, 9 files / 8 dirs / 1 symlink |
| 복원 결과 | **새 합성 public-base VM**에서 hash·mode·Unicode 이름 일치 (불일치 0) |
| cold capture | 284.1 s |
| bare restore create | 3.51 s, verify 1.46 s |
| 전체 | 309.9 s |
| 정리 | 합성 VM 2대(순차)와 비공개 snapshot 1개 모두 삭제. 루트가 세 자원을 id로 각각 GET해 404를 확인 (`end-backup-live/root-cleanup-proof.json`) |

- 표본이 n=1이라 percentile을 주장하지 않는다. 1 CPU 정지 머신의 cold filesystem capture/restore만 검증했다.
- desktop 준비 상태, RAM, OAuth·프로필, 실폰, R2는 이 probe로 증명되지 않는다.
- 이후 추가된 budget guard (`b0a3032`)는 **offline 시험만** 거쳤다. 이 guard는 phase 30분, 누적 active 15분과 예비 시간을 강제한다. guard를 넣은 뒤 live 실행은 없었다.

## 5. 통합 완료: watcher 연결 (실제 설치는 별도)

- 기준 커밋에는 resume 빚을 기록하는 Service 변경 `649f512`가 들어 있다. 소유한 정지 머신이 실제로 start되면 기존 resume hook에 빚을 남기고, alarm 경로에서만 한 번(실행당 최대 6회 시도) 갚는다. GET은 아무 효과도 일으키지 않는다.
- `98605fd`에서 agent와 watcher 설치, bounded async 실행, 같은 writer의 명시적 설정 머신에 대한 재개를 통합했다. R2 bucket·files DO·정상 gateway가 없으면 resume hook 자체를 제공하지 않는다. 같은 머신을 stop/start할 때에만 기존 설치를 확인하고 capability를 갱신한다. GET은 실행하지 않는다.
- `8b2d5f6`에서 CLI 명령 전체에 프로세스 간 잠금을 걸어 watcher와 사용자 파일 접근이 서로의 임시 파일을 복구 처리하지 않도록 했다. 이미 닫힌 lease의 재시도도 성공하는 no-op이다.
- 설치 응답은 background command 제출만 뜻하며 실행 관측을 주장하지 않는다. 사용자의 개인 VM에는 설치하거나 실행하지 않았다. `files_verified` drain은 별도 재진입 검증 전까지 비활성이다.

### 장시간 동기화 제약 — R2 실사용 전 해결 필요 (F1)

- watcher 실행과 capability는 최대 6시간이다. 현재는 명시적 configure 또는 같은 머신의 stop/start 재개 때만 실행하며, 계속 연장한 running 세션의 자동 갱신은 구현되지 않았다. 6시간 이후 원격 사본은 갱신되지 않는다. 로컬 원본은 유지되며 cache eviction은 계속 OFF다.
- 실행 중 configure를 다시 해도 기존 watcher가 lock을 보유하면 새 작업이 종료하므로 기존 실행 시간 상한이 연장되지 않는다. 자동 갱신이 된다고 안내하지 않는다.
- R2 연결을 여는 acceptance에는 이 갱신과 상태 표시를 포함한다. hook의 느린 provider 응답이 Computer DO queue를 막는 시간, toolbox 초기 준비 실패 후 재시도, 동시 configure/grant 경쟁도 함께 검증한다.
- 독립 검토: `delta-review-report.md` (로컬 artifact, CFDeltaReview). 마지막 startup/watcher/CLI lock 변경 외 범위의 재검토나 실제 R2 검증을 뜻하지 않는다.

## 6. 남은 acceptance 확인

| 확인 | 상태 |
|---|---|
| 실제 외부 파일 저장 / cache eviction acceptance | 대기. R2 미활성 |
| 실제 R2 (binding, persistence, 비용) | 미실행. 사용자가 활성화하지 않기로 함 |
| `files_verified`: watcher 설치, workerd에서 DO alarm drain 시 deadlock 없음 증명 | 미실행 |
| 기존 머신 점진 이전·되돌리기 (migration) | 미실행 |
| 실폰 파일 열기·종료·재접속 | 미실행 |
| 복원 후 프로필·OAuth·앱 로그인 (restore-profile) | 미실행 |
| 여러 백업에 걸친 보관 정책, 실제 provider 상대의 budget 초과 run | 미실행 |
| 최종 리뷰와 릴리스 가드 | 독립 delta 검토 완료. 전체 check/test 통과. 배포 가드 대기 |
| 배포 | **주장하지 않음**. 가드 후 루트가 기입 |

WorkBite 상태: T0087과 T0067은 started로 남아 있다. T0085(복원 acceptance)는 열려 있다.

## 7. 재개 순서

1. 배포 가드를 실행하고 실제 결과와 배포 버전을 기록한다.
2. R2 실사용을 열기 전에 장시간 watcher/capability 자동 갱신과 hook의 queue 지연을 보완하고 검증한다.
3. R2를 활성화하기로 결정하면 테스트 bucket으로 P0-A 선택 게이트([files-storage-probe.md](files-storage-probe.md))를 먼저 통과시킨다. 그 뒤에 외부 저장 acceptance를 진행하고 eviction 게이트를 검토한다.
4. `files_verified`는 watcher 설치·drain·재진입·admission이 실제로 증명된 뒤에만 연다.
5. T0085: 새 임시 환경에서 프로필·OAuth를 복원하는 시나리오를 진행한다. 원래 VM은 건드리지 않는다.
6. 실폰 시나리오와 반복 표본(n≥30 목표)은 사전에 정한 비용 한도 안에서만 실행한다.
