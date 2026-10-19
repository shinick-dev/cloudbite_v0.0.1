# CloudBite Cloud Files core contract (P0-B)

작성일: 2026-10-19 · 상태: 라이브러리 + fault test 완료, Worker/DO 배선 전 · 상위 설계: [cloud-files-implementation-plan.md](cloud-files-implementation-plan.md)

코드: `src/cloudbite-computer-files-contract.ts`(wire 타입·오류 코드·한도), `src/cloudbite-computer-files.ts`(`FilesService`, DO/R2 어댑터), `test/cloudbite-computer-files.mjs`.

이 단계는 **메타데이터 카탈로그와 버전 확정 규칙**만 고정한다. 테스트는 메모리 test double로 돈다. 실제 DO 저장소·R2 버킷에 대한 live 영속성, 실폰, 지연 시간은 측정하지 않았다.

## 구성

- `FilesService`는 production env 없이 생성된다. `CatalogStore`와 `BlobStore`를 주입받고, 빠진 저장소를 쓰는 연산은 `store_not_configured`를 반환한다. 성공처럼 동작하는 가짜 원격 어댑터는 `src`에 없다.
- `CatalogStore`: `get` / `getMany` / `list(prefix, startAfter, limit)` / `write(expect, put, del)`. `write`는 조건부 원자 배치 하나로, 모든 `expect` rev가 맞을 때만 적용된다. 키 단위로 세분화되어 있어 Durable Object storage에 그대로 매핑된다(`durableObjectCatalog`). D1 등 추가 인프라를 요구하지 않는다.
- `BlobStore`: `put(key, stream, {size, sha256})` / `head(key)` / `get(key, range?)`. 본문은 스트림으로만 다룬다. `r2BlobStore`는 선언된 SHA-256을 R2에 넘겨 공급자 쪽에서 검증하게 하고, `head`는 R2가 저장한 checksum을 돌려준다. 어떤 어댑터를 쓸지는 root가 정한다.
- SHA-256: Workers에서는 `crypto.DigestStream`, 그 외에는 `sha256` 팩토리를 주입한다. 둘 다 없으면 본문 연산은 `store_not_configured`.

## 키 배치(모두 owner 접두)

| 키 | 내용 |
|---|---|
| `fs/<owner>/ws` | writerEpoch, writerMachine, used/reserved bytes, pending/dirty/pinned 카운터 |
| `fs/<owner>/e/<fileId>` | FileEntry (이름 NFC, fold, kind, currentVersion, versionSeq, pinned) |
| `fs/<owner>/c/<parentId>/<fold>` | 자식 인덱스 → fileId (목록·충돌 검사) |
| `fs/<owner>/n/<dirId>` | 자식 수 카운터 |
| `fs/<owner>/v/<fileId>/<역순 seq>` | 불변 버전 (최신순 정렬) |
| `fs/<owner>/u/<uploadId>` | 업로드 ledger |
| `fs/<owner>/r/<requestId>` | 요청 멱등 기록 (op, args, result) |
| `fs/<owner>/l/<machineId>/<fileId>` | 로컬 사본 상태 (seq 단조) |

전체 파일을 담는 단일 JSON 레코드는 없다. 다른 owner의 ID는 키가 달라 `not_found`가 된다.

## 메서드 (JSON)

정확한 필드는 contract TS와 `core-contract.json`(증거 폴더)에 있다. 오류 봉투는 `{"error":{"code","message","retryable"}}`, HTTP 상태는 `FILES_ERROR_STATUS`.

| 메서드 | 요청 → 응답 | 핵심 규칙 |
|---|---|---|
| `list` | `{parentId, cursor?, limit≤200}` → `{entries, nextCursor}` | BlobStore를 호출하지 않는다. 순서 = fold 키. cursor는 parent에 묶인다 |
| `create` | `{requestId, parentId, name, kind}` → `{entry}` | file/dir만. 깊이 ≤32, 자식 ≤100,000 |
| `rename` | `{requestId, fileId, expectedRev, name?, parentId?}` → `{entry}` | fileId 유지. 자기 하위로 이동은 `invalid_move`. 아래 이동 규칙 |
| `setPinned` | `{requestId, fileId, pinned}` → `{entry}` | |
| `beginUpload` | `{requestId, fileId, baseVersion, writerEpoch, size, sha256}` → `{upload}` | quota 예약, pending ≤64, TTL 24h |
| `writeUploadBody` | `uploadId` + 바이트 스트림 → `{upload}` | 선언 크기 초과 즉시 중단, 크기·해시 불일치 거절. **commit이 아니다** |
| `commitUpload` | `{uploadId}` → `{result}` | uploadId 단위 멱등. 아래 확정 규칙 |
| `getUpload` / `listPendingUploads` | | 응답 유실·크래시 뒤 재조정 |
| `abortUpload` | `{uploadId}` → `{upload}` | pending만 1회 감소(반복 abort는 no-op). **예약(reservedBytes)은 유지**: staged 객체가 있거나 진행 중 body가 늦게 도착할 수 있으므로, 검증된 소유 orphan을 지우는 GC 전에는 quota에서 풀지 않는다 |
| `open` / `listVersions` | | 버전 descriptor만. 공급자 URL·object key 없음 |
| `resolveManifest` | `{fileId, versionId?}` → `{manifest:{rootId, fileId, name, path, versionId, versionSeq, size, sha256, dirs:[{fileId, name, path}]}}` | 메타데이터만(BlobStore 호출 없음). 아래 manifest 규칙 |
| `readVersion` | `{fileId, versionId, offset?, length?}` → stream | 범위 제한. 전송 경로는 root가 배선 |
| `recordLocalState` | `{machineId, writerEpoch, seq, fileId, versionId, dirty}` → `{local, applied}` | 아래 dirty 규칙 |
| `advanceWriter` | `{requestId, expectedEpoch, machineId}` → `{writerEpoch, writerMachine}` | epoch CAS. 이전 writer 정지 확인은 호출자 책임 |
| `storageStatus` | → `{status}` | 저장소 구성 여부·용량·pending/dirty/pinned |

## 확정 규칙

1. commit은 `head`로 객체 존재 → `durable === true` → 크기 일치 → SHA-256 일치 순으로 확인한다. SHA-256은 공급자가 받은 바이트로 검증한 checksum이 있으면 그것을, 없으면 본문을 청크 단위로 다시 읽어 계산한다. HEAD 크기나 ETag만으로는 확정하지 않는다. `durable:false`면 `not_durable`(재시도)이며 아무 버전도 생기지 않는다.
2. 카탈로그 반영은 원자 배치 하나다: 버전 생성 + entry.currentVersion 갱신 + 업로드 phase/result + 용량 카운터. 쓰기 결과가 불명확하면 `commit_unknown`이고, 같은 uploadId로 다시 부르면 이미 적용된 결과를 돌려주거나 한 번만 적용한다.
3. `baseVersion`이 현재 canonical과 다르면(늦은 응답·다른 writer·base 없음) canonical을 덮어쓰지 않는다. 같은 폴더에 `이름 (conflict N).확장자` 새 파일로 내용을 보존하고 `status:"conflict"`, `conflictFileId`를 반환한다. last-writer-wins는 없다.
4. writerEpoch가 현재와 다르면 begin·body·commit 모두 `stale_writer`. body는 공급자 전송 전에 먼저 거절하고(유료 전송 없음), 전송 중 writer가 바뀌면 전송 뒤 다시 확인해 `stale_writer`를 돌려주며 phase를 올리지 않는다. 최종 펜스는 commit 배치의 `ws` rev 기대값이다. 업로드 ledger와 객체는 지우지 않는다.
5. 만료(`expiresAt`)는 공급자 검증이 끝난 뒤 commit 트랜잭션 안에서 다시 확인한다. 검증이 길어져 TTL을 넘기면 `invalid_upload_state`이고 버전은 생기지 않는다.
6. requestId 재사용: 같은 인자면 저장된 결과, 다른 인자면 `request_conflict`. 버전·업로드 ID는 재시도해도 바뀌지 않는다.

## dirty / clean / pinned

- 상태는 writer 머신의 `recordLocalState` 보고로 정해진다: `dirty`, `local`(canonical 버전의 clean 사본), `remote`.
- `recordLocalState` 배치는 dirty 카운터 변화가 없어도 항상 `ws` rev를 기대값에 넣는다. 읽기와 쓰기 사이에 `advanceWriter`가 끼면 배치가 실패하고 재시도에서 `stale_writer`가 된다.
- `seq`가 저장된 값 이하이면 `applied:false`로 무시한다. 늦게 도착한 clean 보고가 새 dirty를 지우지 못한다.
- clean 보고는 `versionId`가 현재 canonical일 때만 받는다. 아니면 `not_verified`. commit만으로 dirty가 풀리지 않는다.
- pin은 사용자 의도로 entry에 저장되고 `pinnedFiles`로 집계된다. 캐시 회수 판단은 agent 쪽이다.

## 이동 규칙 (`rename`에 `parentId`)

- 새 부모와 기존 부모의 조상 체인(각 ≤32 entry)을 읽고 그 rev를 모두 배치 기대값에 넣는다. `create`도 부모 체인을 넣는다. 조상이 동시에 옮겨지면 배치가 실패하고 재시도가 실제 상태로 다시 검사하므로, 하위 디렉터리를 거친 동시 이동으로 cycle이 생기지 않고 깊이 32를 넘지 않는다.
- 파일 이동, 그리고 같은 깊이나 더 얕은 곳으로의 디렉터리 이동은 하위 트리를 읽지 않는다(하위 노드 깊이가 늘지 않는다).
- 디렉터리를 더 깊게 옮기면 하위 트리를 너비 우선으로 최대 `moveScanMax`(1,000) entry까지 읽어 높이를 증명한다. 새 깊이 + 높이 > 32면 `depth_exceeded`, 1,000 entry를 넘으면 `invalid_move`("directory too large to move deeper"). 읽은 모든 디렉터리의 자식 카운터 rev를 기대값에 넣어, 스캔 도중 하위 트리가 자라면 배치가 실패하고 다시 스캔한다.
- 큰 디렉터리를 더 깊게 옮기지 못하는 것은 확장 가능한 하위 트리 높이 모델 전까지의 보수적 제한이다. 같은/얕은 깊이로 옮기거나 내용을 나눠 옮길 수 있다.

## manifest 규칙 (`resolveManifest`)

- 대상 entry에서 root까지 이 owner의 entry만 따라 올라가며 경로를 만든다. 각 단계는 부모의 자식 인덱스(`c/<parent>/<fold>` → fileId)와도 맞아야 한다. 이름은 검증된 NFC라 구분자·제어문자·`.`·`..`가 없고, 형제 fold가 유일하므로 경로도 NFC+case-fold 기준으로 유일하다.
- 걸은 entry와 인덱스(최대 32+32 키)를 한 번의 `getMany`로 다시 읽어 rev·fileId가 그대로일 때만 돌려준다(DO 어댑터에서 128키 미만이라 한 번의 `storage.get`). 동시 rename/move가 끼면 5회까지 다시 걷고, 그래도 바뀌면 `catalog_busy`(재시도 가능).
- `versionId` 생략/null이면 현재 canonical, 버전 없는 파일은 `not_found`. 다른 파일·다른 owner의 버전이나 모르는 id는 `not_found`, 디렉터리·root는 `is_a_directory`. 전역 스캔 없음. `dirs`는 위에서부터, root 제외, 최대 31개.

## 이름 규칙

- 저장은 NFC. 충돌 키는 `NFC(lower(NFC(name)))`. NFC/NFD 차이·대소문자 차이는 같은 폴더에서 `name_conflict`. 대소문자만 바꾸는 rename은 허용.
- 거절: 빈 문자열, `.`, `..`, `/`, `\`, NUL·제어문자·DEL, 끝 점/공백, 짝 없는 surrogate, UTF-8 255바이트 초과.
- symlink 등 file/dir 외 kind는 `unsupported_kind`. 경로 문자열을 받지 않으므로 경로 탈출 입력면이 없다.

## 한도

`FILES_LIMITS`: 목록 페이지 200(기본 100), 더 깊은 이동의 하위 트리 스캔 1,000, 이름 255B, 깊이 32, 폴더당 자식 100,000, requestId 128, cursor 1024, pending 업로드 64, 업로드 TTL 24h, 파일 기본 2 GiB(생성자 옵션, 상한 50 GiB), quota 기본 maxFileBytes×10.

## 알려진 한계 (의도적으로 범위 밖)

- 1,000 entry를 넘는 디렉터리는 더 깊은 곳으로 옮길 수 없다(위 이동 규칙).
- 요청 기록(`r/`)·중단/만료 업로드·참조되지 않은 객체의 GC는 없다. 소유 객체 GC와 TTL 정리는 lifecycle 단계에서 다룬다.
  그때까지 중단·만료된 업로드의 바이트는 `reservedBytes`로 계속 잡혀 있다("정리 대기 중 점유 용량"). 반복 upload+abort로
  staged 객체가 2 GiB quota를 넘어 쌓일 수는 없지만, 이 용량은 GC 전까지 자동으로 돌아오지 않는다.
  이 quota는 카탈로그(메타데이터) 회계이며 R2 버킷 자체의 물리적 상한이 아니다 — 버킷 수준 hard cap·lifecycle 규칙은 별도다.
- 삭제/휴지통, 버전 보관 정책은 아직 없다.
- R2 `put` 완료를 내구성 확인으로 보는 것은 R2 문서상의 의미론이며 live 측정은 하지 않았다.
- `writeUploadBody`의 phase 갱신은 참고용이다. 크래시로 빠져도 commit이 공급자 객체를 직접 검증한다.

## 검증

```
node test/cloudbite-computer-files.mjs   # 26 tests, global fetch 차단. race 테스트는 test double의 barrier hook으로 끼어들기를 재현
npx tsc --noEmit
```
