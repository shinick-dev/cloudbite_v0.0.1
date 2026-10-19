# 파일 저장소 기능 검증 (P0-A)

[구현 계획](cloud-files-implementation-plan.md)의 P0-A 선택 게이트를 위한 저장소 검증 도구와 첫 실측 결과다. 실측은 2026-10-19 Daytona 기본 계정(`DAYTONA_API_KEY`) 1회 실행이며, 결과는 이 계정·리전(`us`)·SDK 0.214.0 시점의 관측이다.

## 도구

```text
python tools/cloudbite-files-storage-probe.py --dry-run
python tools/cloudbite-files-storage-probe.py --live --ledger LEDGER.json
python tools/cloudbite-files-storage-probe.py --reconcile --ledger LEDGER.json
python tools/cloudbite-files-storage-probe.py --cleanup --ledger LEDGER.json [--force-volume-cleanup]
python -B test/cloudbite-files-storage-probe.py
```

- `--dry-run`은 네트워크와 키를 쓰지 않고 생성 예정 자원·예산·단계를 출력한다.
- `--live`는 고유 이름 `cbfs-probe-<runId>`의 Volume 1개와 CPU 샌드박스 1개(1 vCPU·1 GiB·3 GiB, `ttlMinutes=60`, auto-stop 20분, 정지 후 auto-delete 30분, GPU 없음)만 만든다. 합성 데이터는 약 65 MiB이고 상한은 2 GiB다.
- 모든 생성은 호출 **전에** ledger에 intent로 기록한다. 결과를 모르는 생성은 정확한 이름(Volume) 또는 run 라벨+이름(샌드박스)으로 조회해 맞추며 다시 보내지 않는다.
- 401/402/403·quota 응답은 결과로 기록하고 중단한다. 다른 계정 키로 바꾸지 않는다.
- 정리는 ledger의 id·이름·run 라벨·owner 라벨이 모두 일치하는 자원만 지운다. Volume은 데이터 확인 후에만 지우며, 확인이 없으면 남기고 보고한다.
- 테스트는 네트워크 fake와 로컬 임시 디렉터리의 매트릭스 실행만 사용한다. 이는 도구 자체의 검증이며 실측 영속성 근거가 아니다.

## 실측 결과 (run `1761ef5e2742`)

증거: `.artifacts/cloudpc-mobile/cloud-files-implementation/storage-ledger.json`(정리 전 사본 `storage-ledger-before-cleanup.json`), `storage-cleanup-verify.json`, `storage-result.json`.

Volume은 샌드박스 안에서 `fuse` / device `mountpoint-s3`(AWS Mountpoint for S3)로 마운트됐다. 같은 매트릭스를 샌드박스 로컬 디스크(overlay)에도 실행해 비교했다.

| 항목 | Volume (`mountpoint-s3`) | 로컬 디스크 |
|---|---|---|
| 새 파일 쓰기 + fsync | 지원. 24 B 471 ms, 32 MiB write 198 ms + fsync 407 ms | 지원. 32 MiB 23 ms |
| 한글·기호 경로, 빈 디렉터리 | 지원 | 지원 |
| 범위 읽기 | 지원 | 지원 |
| rename (파일·디렉터리·기존 파일 덮어쓰기) | **불가** `ENOSYS` | 지원 |
| 기존 파일 중간 덮어쓰기 | **불가** `EBADF` | 지원 |
| append·truncate·삭제·chmod·utime·symlink·hardlink | **불가** `EPERM` | 지원 |
| flock, 디렉터리 fsync | 오류 없음 | 지원 |
| 정지 → 시작 후 내용 | 3개 파일 sha256·크기 일치 | 일치 |
| 정지 중 접근 | Volume 상태 `ready`. 내용 API 없음 | — |

- 정지 후 재시작 검증의 원래 판정 `ok:false`는 도구 v1의 기대값 오류였다. rename이 불가능해 만들어지지 않은 `dir-b/child`를 기대했기 때문이다. 파일과 실제 생성된 디렉터리는 모두 일치했고, 이 판단은 ledger의 `proofReview`에 따로 기록했다. 도구는 이후 생성에 성공한 디렉터리만 기대하도록 고쳤다.
- 재시작은 같은 샌드박스의 FUSE 재마운트다. 다른 머신에서의 재연결은 측정하지 않았다.
- 샌드박스는 생성 13초 뒤 삭제됐고, Volume은 데이터 확인 판정 뒤 삭제했다. 두 자원 모두 목록·조회에서 사라진 것을 확인했다.

## 판정

- **관리형 Volume은 편집 가능한 작업 파일의 저장 경로로 쓸 수 없다.** rename·삭제·덮어쓰기가 막혀 있어 편집기의 임시 파일 후 rename 저장, 파일 삭제, 부분 수정이 실패한다. 계획의 canonical 버전 확정·충돌 사본 계약도 이 마운트에서 직접 구현할 수 없다.
- **Volume 내용은 머신 없이 읽을 수 없다.** Volume API는 create/get/list/delete만 제공하고, 백엔드 S3 자격증명도 노출하지 않는다. 머신이 꺼진 상태의 카탈로그는 별도 메타데이터 저장소가 필요하다.
- 공식 문서도 Volume을 비트랜잭션·last-write-wins로 설명한다. [Daytona Volumes](https://www.daytona.io/docs/en/volumes/)
- 후보로 남는 쓰임은 한 번 쓰고 읽기만 하는 산출물 보관 정도다. 이마저 삭제가 막혀 있어 보관 정책은 Volume 삭제 단위로만 가능하다.
- 따라서 쓰기 경로는 사용자 소유 S3 호환 객체 저장소에 불변 버전 객체와 자체 카탈로그를 두는 방식이 우선 후보다. 객체 저장소는 머신 없이 API로 접근할 수 있다. 이 후보의 실측은 이번 실행에 포함하지 않았다.

## 측정하지 않은 것

- 다른 머신에서의 재연결, 동시 writer: 샌드박스 1개 예산.
- 마운트·캐시가 환경 스냅샷에 포함되는지: 스냅샷과 두 번째 샌드박스가 필요해 만들지 않았다.
- 공급자 반영 완료 확인: API가 없다. fsync 반환과 재시작 후 재읽기만 관측했다.
- 목록 조회가 본문 GET을 유발하는지: 요청 수를 볼 수단이 없다. 도구는 이후 실행부터 목록·stat 시간만 기록한다.
- Mountpoint 옵션(`--allow-delete`, `--allow-overwrite` 등)은 Daytona가 관리하는 마운트라 사용자가 바꿀 수 없다. 사용자 FUSE 권한으로 직접 마운트하는 경로는 검증하지 않았다.
