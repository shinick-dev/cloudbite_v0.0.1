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
| `rename` | `{requestId, fileId, expectedRev, name?, parentId?}` → `{entry}` | fileId 유지. 자기 하위로 이동은 `invalid_move` |
| `setPinned` | `{requestId, fileId, pinned}` → `{entry}` | |
| `beginUpload` | `{requestId, fileId, baseVersion, writerEpoch, size, sha256}` → `{upload}` | quota 예약, pending ≤64, TTL 24h |
| `writeUploadBody` | `uploadId` + 바이트 스트림 → `{upload}` | 선언 크기 초과 즉시 중단, 크기·해시 불일치 거절. **commit이 아니다** |
| `commitUpload` | `{uploadId}` → `{result}` | uploadId 단위 멱등. 아래 확정 규칙 |
| `getUpload` / `listPendingUploads` | | 응답 유실·크래시 뒤 재조정 |
| `abortUpload` | `{uploadId}` → `{upload}` | 예약 해제. 객체는 별도 GC 대상으로 남김 |
| `open` / `listVersions` | | 버전 descriptor만. 공급자 URL·object key 없음 |
| `readVersion` | `{fileId, versionId, offset?, length?}` → stream | 범위 제한. 전송 경로는 root가 배선 |
| `recordLocalState` | `{machineId, writerEpoch, seq, fileId, versionId, dirty}` → `{local, applied}` | 아래 dirty 규칙 |
| `advanceWriter` | `{requestId, expectedEpoch, machineId}` → `{writerEpoch, writerMachine}` | epoch CAS. 이전 writer 정지 확인은 호출자 책임 |
| `storageStatus` | → `{status}` | 저장소 구성 여부·용량·pending/dirty/pinned |

## 확정 규칙

1. commit은 `head`로 객체 존재 → `durable === true` → 크기 일치 → SHA-256 일치 순으로 확인한다. SHA-256은 공급자가 받은 바이트로 검증한 checksum이 있으면 그것을, 없으면 본문을 청크 단위로 다시 읽어 계산한다. HEAD 크기나 ETag만으로는 확정하지 않는다. `durable:false`면 `not_durable`(재시도)이며 아무 버전도 생기지 않는다.
2. 카탈로그 반영은 원자 배치 하나다: 버전 생성 + entry.currentVersion 갱신 + 업로드 phase/result + 용량 카운터. 쓰기 결과가 불명확하면 `commit_unknown`이고, 같은 uploadId로 다시 부르면 이미 적용된 결과를 돌려주거나 한 번만 적용한다.
3. `baseVersion`이 현재 canonical과 다르면(늦은 응답·다른 writer·base 없음) canonical을 덮어쓰지 않는다. 같은 폴더에 `이름 (conflict N).확장자` 새 파일로 내용을 보존하고 `status:"conflict"`, `conflictFileId`를 반환한다. last-writer-wins는 없다.
4. writerEpoch가 현재와 다르면 begin·commit 모두 `stale_writer`. 업로드 ledger와 객체는 지우지 않는다.
5. requestId 재사용: 같은 인자면 저장된 결과, 다른 인자면 `request_conflict`. 버전·업로드 ID는 재시도해도 바뀌지 않는다.

## dirty / clean / pinned

- 상태는 writer 머신의 `recordLocalState` 보고로 정해진다: `dirty`, `local`(canonical 버전의 clean 사본), `remote`.
- `seq`가 저장된 값 이하이면 `applied:false`로 무시한다. 늦게 도착한 clean 보고가 새 dirty를 지우지 못한다.
- clean 보고는 `versionId`가 현재 canonical일 때만 받는다. 아니면 `not_verified`. commit만으로 dirty가 풀리지 않는다.
- pin은 사용자 의도로 entry에 저장되고 `pinnedFiles`로 집계된다. 캐시 회수 판단은 agent 쪽이다.

## 이름 규칙

- 저장은 NFC. 충돌 키는 `NFC(lower(NFC(name)))`. NFC/NFD 차이·대소문자 차이는 같은 폴더에서 `name_conflict`. 대소문자만 바꾸는 rename은 허용.
- 거절: 빈 문자열, `.`, `..`, `/`, `\`, NUL·제어문자·DEL, 끝 점/공백, 짝 없는 surrogate, UTF-8 255바이트 초과.
- symlink 등 file/dir 외 kind는 `unsupported_kind`. 경로 문자열을 받지 않으므로 경로 탈출 입력면이 없다.

## 한도

`FILES_LIMITS`: 목록 페이지 200(기본 100), 이름 255B, 깊이 32, 폴더당 자식 100,000, requestId 128, cursor 1024, pending 업로드 64, 업로드 TTL 24h, 파일 기본 2 GiB(생성자 옵션, 상한 50 GiB), quota 기본 maxFileBytes×10.

## 알려진 한계 (의도적으로 범위 밖)

- 디렉터리를 옮길 때 하위 트리 높이는 검사하지 않는다. 옮겨진 노드 자신과 이후 생성만 깊이 32를 강제한다.
- 요청 기록(`r/`)·중단/만료 업로드·참조되지 않은 객체의 GC는 없다. 소유 객체 GC와 TTL 정리는 lifecycle 단계에서 다룬다.
- 삭제/휴지통, 버전 보관 정책은 아직 없다.
- R2 `put` 완료를 내구성 확인으로 보는 것은 R2 문서상의 의미론이며 live 측정은 하지 않았다.
- `writeUploadBody`의 phase 갱신은 참고용이다. 크래시로 빠져도 commit이 공급자 객체를 직접 검증한다.

## 검증

```
node test/cloudbite-computer-files.mjs   # 17 tests, global fetch 차단
npx tsc --noEmit
```
