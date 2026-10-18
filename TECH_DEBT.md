# 기술 부채 기록 (함수 복잡도·마스터 파일)

이 문서는 측정값과 남은 작업 목록이다. 기술 부채가 모두 갚아졌다는 뜻이 아니다.
CCN 은 코드 읽기·변경 위험의 지표일 뿐 보안 증명이 아니다. CCN > 20 함수가 0개가 된 것도 이름 붙인 목록이 끝났다는 뜻일 뿐이다.

## 측정 방법

- 도구: ESLint 9.39.5 `complexity` (classic) + @typescript-eslint/parser 8.71.0. W4 기준선(`b7c54a0ec9a4096925d4a859514ddcff18eec665`), W12 시작, 현재에 같은 방법을 썼다.
- 범위: `src/`, `client/`, 그리고 그 안에 들어 있는 JS 템플릿. `.generated.` 산출물은 뺐다.
- 셈: `&&`·`||`·`??`, 삼항, optional chaining, 기본 매개변수를 포함한다. 중첩 함수는 따로 센다.
- 중복 제거: (파일, 종류, 템플릿 라벨, 함수 이름, 줄) 기준 (원래 스크립트는 `EXTRACT_JS` 를 두 번 처리했다).
- 제외: PowerShell·bash, 함수 본문이 아닌 코드. 파싱 오류는 없었다.

## 전체 수치

| | 함수 수 | CCN > 20 | 최대 CCN |
|---|---:|---:|---:|
| W4 기준선 | 860 | 21 | 108 |
| W12 시작 | 966 | 13 | 32 |
| 현재 (Wave18) | 1036 | 0 | 20 |

함수 수가 늘어난 것은 분해했기 때문이다. CCN > 10 함수는 아직 72개 있다.

## Wave13~18 에서 이름 붙인 13개 (W12 시작 → 현재)

Wave13~18 을 구현했다. Wave13~17 은 각각 커밋됐고, 게이트 ID 와 패치 해시는 각 커밋 메시지에 있다. Wave18 은 이름 붙인 함수가 아니라 금고 책임을 옮겼다.

| 파일 | 함수 | 전 | 후 |
|---|---|---:|---:|
| lab-screen-service | `start` | 30 | 13 |
| lab-screen-service | `pull` | 32 | 14 |
| state | `approve` | 29 | 13 |
| state | `adminUpsertProvider` | 29 | 15 |
| state | `migrateGrants` | 25 | 8 |
| lab | `putMaterials` | 32 | 6 |
| lab | `readCapped` | 21 | 8 |
| lab | `EXTRACT_JS.main` | 26 | 4 |
| labhost | `entry` | 24 | 3 |
| labhost | `seatGet` | 22 | 6 |
| labhost | `proxy` | 26 | 15 |
| state | `labJoin` | 23 | 15 |
| lab-export-service | `start` | 21 | 17 |

13개 모두 20 이하가 됐다 (13 → 0). 지금 가장 높은 것은 20 (`state.alarm`, `EXTRACT_JS.rollback`) 이다.
래퍼의 수치만 보고 복잡도가 없어졌다고 읽지 않는다. 로직은 서비스·보조 함수로 옮겨 갔고 거기서 따로 센다.

## Wave18: 금고 나머지 → VaultService

- 옮긴 것: 금고 상태(`vaultStatus`), 탭 옵션(`vaultOptions`, PRF 키만), 탭 열기(`vaultOpen`), 키 잇기(`vaultLink`), 항목 쓰기·지우기(`vaultPutItem`·`vaultDeleteItem`), 보내기(`sendDeliver`), 그리고 내부 도우미 `vaultItems`·`checkWrap`.
  금고 만들기·복구 코드·복구는 앞서 서비스로 옮겼으므로 금고 로직은 이제 전부 `src/vault-service.ts` 에 있다 (279줄, 함수 40개, 최대 CCN 12 = `putItem`).
- 그대로 둔 것: State 의 공개 RPC 이름·인자·결과. State 메서드는 `#vault` 로 넘기는 한 줄 래퍼다 (`issueRecoveryCode` 비공개 래퍼는 `adminLogin` 이 쓴다).
  서비스는 Worker 에서 내보내지 않고 새 DO 공개 메서드도 없다. 저장 키·한도·응답 모양·오류 문구·await 순서는 바꾸지 않았다.
- State 에 남은 것: 탭 의식(`authOptions`·`verifyTap`), 관리 토큰 발급·확인, 키 목록, 감사 기록. 서비스는 이것들을 콜백으로만 받는다 (receiver 는 State, 런타임 import 순환 없음 — `import type` 만).
- 테스트: `test/auth-security.mjs` 의 `#10 vault` 절이 로컬 loopback·mock 으로 키 잇기·항목·보내기를 직접 부른다.
  토큰 없는 쓰기 거부(아무것도 안 씀), PRF 아닌 키·형식 틀린 wrap 거부, 이은 키가 상태에 linked 로만 보이고 감싼 키는 안 보임,
  항목 형식·64KB 상한·기본 정책 phone·500개 상한(새 id 409, 있는 id 고치기 200)·없는 항목 지우기 404,
  보내기의 종류·만료·상태·phone 정책 가드, 암호 상자 전달과 폴 한 번만 꺼내기. 암호문은 합성 문자열이다.

## 마스터 파일 (현재 줄 수)

- `src/state.ts` 1853줄 (W4 2210, W12 2006). 금고는 빠졌지만 인증 의식·세션·관리·승인·공부방 조정을 여전히 State 하나가 진다.
- `src/pages.ts` 814줄 (HTML·JS 포함, 함수 239개), `src/lab.ts` 688줄 (내장 샌드박스 프로그램 포함), `src/labhost.ts` 447줄, `src/index.ts` 155줄.
- 내장 JS 템플릿(pages·lab·labbar·labscreen)은 함수 399개로 따로 남아 있다. 이것들의 분리는 아직 하지 않았다.

## 다음 작업 (권고)

1. **State 경계** — 인증 의식·세션·관리·승인 조정과 공부방 조정을 State 에서 더 떼어 낼지 판단한다. 인증 의식은 한곳에 두는 편이 안전하다.
2. **pages·내장 마스터 템플릿** — 화면 HTML·JS 가 큰 문자열 안에 있다. 분리하려면 브라우저 흉내 테스트를 먼저 깐다.
3. **CCN 11~20 함수 72개** — 목록이 아니라 바뀔 때마다 조금씩.

원칙: 마스터 파일을 한꺼번에 쪼개지 않는다. diff는 작게 하고, 매번 보안 게이트 전체를 돌리며, 기존 보안 수정은 그대로 둔다.

## 웨이브마다 지킬 절차

1. 같은 ESLint 방법으로 기준선과 바뀐 코드를 잰다.
2. 아래 검사를 모두 통과한 뒤 게이트 검토(Daybreak Blue 보안 회귀 검토)를 한다.
3. 게이트를 통과한 뒤에만 커밋한다. 게이트 통과 여부와 그때의 해시는 각 웨이브의 커밋 메시지에 적는다 — 이 문서는 게이트 통과를 주장하지 않는다.

```
npm run check
npm run test:security
node test/router-parity.mjs
node test/auth-router-parity.mjs
node test/provider-parity.mjs
```

한계: 검사는 로컬 loopback과 mock으로만 돈다. 배포된 서버나 실제 공급자로 확인한 것이 아니다. 전체 스위트에는 로컬 환경에서 건너뛰는 항목이 2개 있다.
