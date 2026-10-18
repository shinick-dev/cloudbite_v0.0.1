# 실습실 화면 성능 측정

실습실(code-server) 화면이 느리다는 말이 나올 때, 참가자 브라우저 안에서만 숫자를 모아 보는 도구다.
코드는 `src/labperf.ts` 의 `LAB_PERF_JS` (브라우저에서 도는 문자열 스크립트), 테스트는 `test/lab-client-performance.mjs`.

> 자리 호스트(`src/labhost.ts`)는 이 스크립트를 `/__lab/perf.js` 로 내준다(다른 `/__lab/*.js` 정적 자산처럼
> `seatGuard` 출처 검사 뒤). code-server 최상위 HTML 문서(iframe 은 아님)에는 `</body>` 앞에
> `bar`·`snips`·`screen`·`rtc` 다음 **맨 뒤** `<script src="/__lab/perf.js" defer>` 로 넣는다(nonce 가 있으면 같은 값).
> `<head>` 맨 앞의 `guard.js` 보다도 늦다. 페이지에 들어가 있어도 아래처럼 켜지 않으면 아무것도 하지 않는다.
> 입장 화면(`src/pages.ts` 의 `labEnterPage`, 자리 호스트 입장 POST 가 맞을 때 쿠키와 함께 주는 화면)은 `page()` 를 거치지 않아
> 외부 `/__lab/app.js` 를 싣지 않는다(기준 커밋은 1개). 인라인 스크립트 하나가 `labWatch` 를 set/remove 하고(저장소 예외는 삼킴)
> 곧바로 `location.replace('/')` 한다. PWA 머리·한국어 안내·대체 링크(`/`)는 그대로이고, 다른 실습실 화면(초대·확인·랜딩·끝)은
> 여전히 `app.js` 를 쓴다(`test/lab-entry-performance.mjs`). 이것으로 체감 입장 시간이 얼마나 줄었는지는 아직 재지 않았다.

## 켜고 끄기 (기본은 꺼짐)

스크립트가 페이지에 있어도 `sessionStorage.labPerf === '1'` 이 아니면 아무것도 하지 않는다
(리스너·관찰자·타이머·`window.__labPerf` 모두 없음). 저장소를 읽다 예외가 나도 꺼진 채로 둔다.

DevTools 콘솔에서 이 탭에만 켠다:

```js
sessionStorage.setItem('labPerf', '1'); location.reload();
```

새로 고친 뒤 60초 안에 평소처럼 편집기·터미널에 입력하고:

```js
copy(JSON.stringify(window.__labPerf.snapshot(), null, 2)); // 결과를 클립보드로 (사람이 직접)
window.__labPerf.stop();                                    // 일찍 멈추기
sessionStorage.removeItem('labPerf');                       // 끄기 (탭을 닫아도 꺼진다)
```

스크립트 자신은 저장소에 쓰지 않는다. 켜기·끄기의 쓰기는 사람이 콘솔에서 한다.

## 무엇을 재나

| 항목 | 내용 |
|---|---|
| `nav` | `performance.getEntriesByType('navigation')[0]` 의 숫자 필드만: `requestStart`, `responseStart`, `responseEnd`, `domInteractive`, `domContentLoadedEventEnd`, `loadEventEnd`, `duration`, `transferSize` (ms·바이트, 0.1 반올림). 주소(`name`)·`serverTiming`·종류 문자열은 담지 않는다. |
| `keyToFrame` | 신뢰된(`isTrusted`) `keydown` 의 `timeStamp` → 다음 `requestAnimationFrame` 콜백이 불린 시각. 분류는 `editor`(`.monaco-editor` 안) / `terminal`(`.xterm` 안) / `other` 셋뿐. 분류별 누적 `n`·`meanMs`·`maxMs`, 최근 고리 기준 `p50Ms`·`p95Ms`, 최근 표본(`category`, `ms`). |
| `longtask` | `PerformanceObserver('longtask')` 가 되면 수·합·최대·최근 길이. 출처(attribution)·이름은 담지 않는다. `buffered: true` 로 관찰하므로 스크립트가 설치되기 전(문서 로딩 중)에 이미 버퍼에 있던 항목도 섞여 들어올 수 있다. |
| `elapsedMs`, `active`, `windowMs` | 관찰 시간과 상태. |

**`keyToFrame` 은 터미널 에코 지연이 아니다.** 키 이벤트가 생긴 뒤 브라우저가 다음 프레임 작업을 시작하기까지의
메인 스레드 지연(입력 처리 + 막힘)을 근사할 뿐이다 — 로컬의 **다음 rAF 하나**까지만이다. 샌드박스까지의 왕복(RTT), 셸 에코,
글자가 실제로 화면에 그려진 시각(glyph paint)은 재지 않는다. 그것들은 아래 "합성 지연 모델" 과 P3 에서 따로 다룬다.
`keyToFrame` 의 이름·스냅샷 모양·`window.__labPerf` API 는 바꾸지 않았다(이 문서가 뜻만 분명히 한다).

서버 쪽 시간은 게이트웨이가 이미 `Server-Timing` 헤더로 내보내고, DevTools 네트워크 탭의 Timing 에서 본다.
이 스크립트는 리소스 주소를 모으지 않으려고 resource timing 을 읽지 않는다(`nav` 에서도 `serverTiming` 은 뺀다).

- 입장 호스트 `POST /__lab/wake`: `labJoin` 의 **성공 결과(ready·starting)에만** `이름;dur=정수ms` (정한 이름만·상한 10분).
  입장 호스트가 공개 JSON 을 만들기 전에 `labTiming` 을 떼므로 본문에는 시간 메타데이터가 없다. 실패 응답에는 헤더가 없다.
  - `total` 은 **이 입장 요청**이 자리 확인부터 응답까지 걸린 시간(같은 준비 일을 기다린 시간 포함)이다.
    `prep_*` 는 **공유 준비 일**의 관측이며, 서로 다른 입장 요청이 같은 값을 받을 수 있다. 둘을 더하지 않는다.
    기존 `sandbox`·`materials`·`health`·`start` 이름도 정리 함수는 받지만 현재 `labJoin` 은 그 이름을 채우지 않는다.
- 자리 호스트 최상위 HTML 문서(upstream 200): `upstream;dur=` — upstream 응답 헤더까지 걸린 시간만.
- 둘 다 자리 코드·샌드박스 id·주소·토큰·오류 문구를 담지 않는다.

입장 요청의 Timing 에서 다음 고정 이름을 본다(`src/lab-preparation-timing.ts`). 권한을 확인한 자기 자리의 성공 응답에만
붙고, JSON 본문·새 로그·별도 수집 요청·쿠키에는 추가하지 않는다.

| 이름 | 공유 준비 일에서 관측한 범위 |
|---|---|
| `prep_queue` | 일 생성부터 첫 실행까지. 아직 실행 전이면 응답 시각까지 실제 기다린 길이 |
| `prep_wait` | 준비 실행이 다음 확인을 기다리기로 한 시각부터 다음 실행까지의 합(현재 대기도 포함). 폴링·재시도 사이의 실제 간격 |
| `prep_elapsed` | 첫 실행부터 종료 또는 응답 시각까지 벽시계 시간. 큐는 제외하고 실행 사이 대기·서버 재시작 간격은 포함 |
| `prep_sandbox` | 샌드박스 상태 확인 호출을 기다린 길이의 합 |
| `prep_wake` | 샌드박스 깨우기 요청을 기다린 길이의 합 |
| `prep_materials` | 수업 자료 설치 호출을 기다린 길이의 합 |
| `prep_health` | code-server health 확인 호출을 기다린 길이의 합 |
| `prep_start` | code-server 시작 요청을 기다린 길이의 합 |

호출 값은 서비스가 권한 재확인·키 풀기부터 응답·오류·시간 제한까지 **기다린 관측**이다. 시간 제한으로 기다림을 그만둔 경우도
그 시각까지 세며, 원격 작업 완료나 샌드박스 왕복(RTT)을 증명하지 않는다. 위 단계 합이 `prep_elapsed` 와 같다는 보장도 없다.
모든 길이는 정수 ms이며 **600000ms에서 잘린다**(그 값이면 정확한 길이가 아니다). 단계별 표본은 128개까지 합산하고 배열·문구는
저장하지 않는다. 숫자 관측은 일 생성 후 24시간까지만 유효하며, 만료 뒤 응답에서 생략하고 예약된 알람에서 거둔다(`uncertain` 보호 기록은 유지).
같은 일의 폴링은 누적 관측을 이어 쓰고, 실패 후 새 일의 재시도·ready 재확인은 새 관측으로 시작한다. 예전 일에 없는 관측이나
서버 재시작으로 중간에 끊긴 호출은 추정하거나 0으로 채우지 않는다. 빠진 단계는 미측정이지 0ms가 아니다.
이 헤더는 브라우저 `keyToFrame` 의 의미를 바꾸지 않으며 터미널 에코 측정도 추가하지 않는다.
관측을 보존하려고 호출을 기다린 뒤 기존 소유자 검사와 DO 저장을 한 번 더 한다. 이 추가 저장의 지연·저장 비용은 별도로 측정하지 않았다.

## 묶음과 안전 장치

- 표본 사이 최소 100ms, 대기 중인 rAF 는 하나. 그 사이 키는 `skipped` 로 세기만 한다.
- 최근 표본 고리·longtask 고리 각각 128개까지. 누적은 숫자 몇 개.
- 켠 뒤 60초가 지나면(타이머 또는 다음 keydown 에서) 멈춘다. `pagehide` 에도 멈춘다.
  60초 타이머는 브라우저 스케줄링(백그라운드 탭 스로틀링 등)에 따라 늦게 불릴 수 있어 정확한 벽시계 마감이 아니다.
  멈추면 리스너 제거, 관찰자 `disconnect`, 대기 rAF `cancelAnimationFrame`, 타이머 해제.
- 리스너는 `{ capture: true, passive: true }`, `preventDefault`·`stopPropagation` 을 부르지 않는다.
  기존 `guard.js`(클립보드 규칙)·VS Code 단축키 동작은 그대로다.
- 기능이 없으면(rAF·PerformanceObserver·navigation timing) 그 항목만 비우고, 각 단계의 예외는 삼킨다.
- `snapshot()` 은 매번 새로 만든 복사본이고 숫자·불리언·null·고정 분류 문자열만 담는다.

## 개인정보 — 이 탭 밖으로 나가지 않는다

- `fetch`·`sendBeacon`·`XMLHttpRequest`·`WebSocket`·`EventSource` 없음. 서버 엔드포인트 없음.
- `localStorage`·`sessionStorage` 쓰기 없음, `console` 출력 없음.
- 읽지 않는 것: `event.key`/`code`/`keyCode`, 입력 값·텍스트, 클립보드, 페이지·리소스 주소, 요청 본문,
  자리 코드·초대 코드·토큰·식별자. 대상 요소는 `closest()` 로 분류만 하고 속성을 읽지 않는다.
- 결과를 공유하는 건 사람이 스냅샷 JSON 을 직접 복사해 넘길 때뿐이다. 넘기기 전에 숫자만 있는지 눈으로 확인한다.

## 자리 미리 준비 (P2)

코드는 `src/lab-preparation-service.ts`(`LabPreparationService`, State DO 안에서만 쓰고 Worker 에서 내보내지 않음)와
`src/state.ts` 의 `#prep`·`#prepActive`·`#prepPatchSetup`·`#seatPatch`·`#prepEnqueue`·`labJoin`.

- **언제** — `labCreate` 가 수업을 저장하고 감사 기록을 남긴 뒤 `#prepEnqueue` 로 샌드박스·세션이 있고 오류 없는 자리만 줄에
  넣는다. 네트워크 준비는 기다리지 않고, 실패해도 수업 만들기는 그대로다.
- **무엇을 쓰나** — 준비 일은 샌드박스 확인 → 필요하면 깨우기 → 수업 자료 넣기 → 편집기(healthz) 확인·켜기만 한다.
  `who`(이름)·`opened`·미리보기 주소(`pv`)·쿠키·입장 감사 기록은 쓰지 않는다. 자기 일 기록(`labprep:<code>`)·멈춤 표시
  (`labprepstop:<labId>`)와, State 가 트랜잭션 안에서 일 번호·자리·멈춤을 다시 확인한 뒤의 `setup` 필드만 바뀐다.
- **한도** — `enqueue` 한 번에 20자리(State 의 수업당 최대와 같음), 끝나지 않은 일 기록 40개, 동시에 도는 일 1개,
  무거운 자료 넣기 1개. 넘치면 줄에서 기다리고 입장은 `starting`(실습실을 준비하는 중)을 받는다. 자리가 찬 동안의 알람은
  30초 간격이고, 보통은 끝난 일이 다음 일을 바로 깨운다.
  - 동시 1개·자료 넣기 1개는 **지금 살아 있는 이 DO 인스턴스(incarnation) 안에서만** 지킨다. 서버가 다시 뜬 뒤까지 이어지는
    전역 한도가 아니다. 다시 뜬 뒤에는 앞 인스턴스의 자료 넣기가 아직 도는지 증명할 수 없으므로, 그 자리(같은 샌드박스)는 아래
    '알 수 없음' 으로 막힌 채로 남고 다른 자리 준비는 이어 간다. 앞 호출을 끊거나 전역으로 정리하지 않는다.
- **시간** — 일 하나의 끝 시각은 **처음 돌기 시작한 때부터 5분**이다. 줄에서 기다린 시간은 들어가지 않는다.
  확인·켜기 호출 하나는 60초(자료 넣기는 끝 시각까지), 확인 실패·기다림은 40번까지(입장 폴링도 센다), 다시 시도 간격
  2·4·8·15·30초, 깨우기 요청 사이 20초, 편집기 켜기는 최대 2번·45초 간격. 남은 시간이 0 이하(또는 숫자가 아님)면 바깥 호출을
  시작하지 않고 시간 초과로 본다 — 끝 시각 뒤에 새 바깥 호출을 하지 않는다. 시간이 지나 기다림을 멈춘 호출은 끊지 않고,
  시간으로 놓아 주지도 않는다 — 실제로 끝날 때까지 동시 개수(자료 넣기면 자료 넣기 1개 자리)를 계속 잡는다.
  끝난 일(`ready`·`failed`)·멈춤 표시는 24시간 뒤 알람이 지운다(`uncertain` 은 지우지 않음).
- **첫 입장(대체 경로)** — `labJoin` 은 자리 확인(`seatOf`) → 이름(비어 있을 때만, 트랜잭션) → Daytona 키 확인 → `#prep.ensure`
  순서다. 같은 자리 일이 돌고 있으면 그 결과를 같이 기다리고, 겹친 입장은 하나로 묶는다. 일이 없거나 끝났거나 다른 샌드박스면
  새 일 번호로 지금 확인한다. 미리 `ready` 였던 자리도 샌드박스 상태와 편집기 health 는 다시 본다(`ready` 를 권한으로 보지 않음).
  준비가 끝나지 않았으면 지금처럼 대기 화면이 폴링한다.
- **ready 뒤** — `ensure` 가 ready 면 State 가 `#seatPatch` 한 트랜잭션에서 자리·수업·끝 시각·끝내는 중·멈춤을 다시 읽는다.
  자료가 '진행 중' 이면 `starting`, '알 수 없음' 이면 `opened`·감사 없이 502, 둘 다 아닐 때만 `opened` 를 적는다.
  `lab-join` 감사는 `opened` 를 새로 적은 때만 남는다. `gone` 은 410, 최종 오류는 502.
- **끝내기·만료** — `endLab` 은 `cancelLab`(메모리에서 먼저 막고 → 멈춤 표시 저장 → 그 수업 일 기록 삭제)을 기다린 뒤에 바깥
  정리를 시작한다. 돌던 호출은 끊지 않지만, 바깥 호출 하나를 기다린 뒤마다 "멈춤 없음 + 내 일 번호 + 자리 유효" 를 다시 보므로
  끝난 결과를 쓰지 않고 수업·자리가 되살아나지 않는다.
- **바깥 호출 직전의 마지막 문** — 준비의 바깥 호출은 매번 `#prepRemote` 를 지난다: Daytona 키를 풀고(`daytona()`) 일 기록·멈춤 표시·
  자리 표·수업을 저장소에서 새로 읽어 ref 네 값·끝 시각·끝내는 중·내 일 번호(끝나지 않은 기록인지)를 확인한 뒤, 마지막 await 와
  호출 사이에 await 없이 메모리 멈춤과 서비스의 문(지금 도는 일 번호·멈춤·이 호출의 절대 끝 시각 = 호출 하나 한도와 일 끝 시각 중
  이른 쪽·시간 초과로 닫힌 문)을 다시 보고, 하나라도 걸리면 호출하지 않는다. 이 문은 새 호출을 막을 뿐, 이미 시작한 자료 넣기·
  ZIP 되돌리기는 끊지 않으며 메모리 멈춤과 문은 이 인스턴스 안에서만 유효하다. 키를 푸는 동안 붙잡혔다가 끝내기 뒤에 풀리는 경우는
  `test/lab-preparation-state.mjs` 가 가짜 Daytona·가짜 저장소로 로컬에서만 확인한다.
- **끝났는지 모르는 자료 넣기는 '알 수 없음' 으로 닫는다(fail closed)** — 주인 없는 `setup: running`(서버가 다시 떠서 이어 받은
  `install` 단계·예전 방식·주인을 잃은 일)과 시작한 자료 넣기의 끝 시각 초과는 되풀이하지 않는다. 자료 넣기는 일 기록과
  `running` 을 먼저 적은 뒤에만 시작하므로, `running` 을 적기 전에 멈춘 일은 시작도 안 한 것이라 새로 넣는다
  (`running` 을 적은 직후·호출 전에 끝 시각이 지나면 보통 시간 초과 오류). `setup` 을 `PREP_UNCERTAIN` 오류로, 일 기록을 끝난 단계 `uncertain` 으로 남긴다. 이 상태는 **재시도도
  ready 도 없다** — 30초가 지나도 입장·백그라운드 줄 어느 쪽도 같은 샌드박스로 새 일을 만들지 않고, 입장은 매번 "강사가 이 자리
  실습실을 새로 만들어야 합니다" 502 를 받는다(`opened` 를 적지 않음). 알람도 `uncertain` 기록은 24시간이 지나도 지우지 않는다.
  풀리는 길은 강사가 실습실(샌드박스)을 새로 만드는 것뿐이다.
- 일반 `failed`(확인 횟수·끝 시각 초과 등 자료 넣기와 무관한 실패)는 30초 뒤 입장이 새 일로 다시 확인할 수 있다.
- **보통의 자료 오류** — 끝 시각 안에 `putMaterials` promise 가 돌아오거나 reject 된(settled) 경우만 지금처럼 `setup: error` 와
  문구를 남기고 편집기 준비를 이어 간다. 입장은 ready 와 함께 그 경고를 받는다(기존 `labJoin` 경고 동작 그대로).
  promise 가 끝났다는 뜻일 뿐, 샌드박스 안의 바깥 작업이 전부 멈췄다는 증명은 아니다. 확인되지 않은 ZIP 되돌리기 오류도
  기존처럼 백업을 남기고 이 경고 경로로 가며, 시간 초과·재시작용 '알 수 없음' 표시가 아니다. 자료 넣기·되돌리기 정책은 이번에
  바꾸지 않았다. 이미 `ok`·`error` 이거나 입장한(`opened`) 자리는 자료를 다시 넣지 않는다.
- 기존 자리·관리자 권한 검사(`seatOf`·`checkAdmin` 등)는 그대로 작업보다 먼저 한다. 준비 때문에 await 순서는 달라졌다(트랜잭션
  patch·`ensure`·마지막 유효성 확인). 준비는 그 위에 자리·멈춤·끝 시각·일 주인 확인을 더한다. CPU·지역·guard 설정은 바꾸지 않았다.
- **재지 않은 것** — 배포 환경·실제 참가자의 입장 지연이 줄었다는 측정은 없다. 미리 준비가 첫 입장 시간을 얼마나 줄이는지는
  수업 규모·Daytona 상태·줄 위치에 따라 다르고, 동시 1개 한도 때문에 뒤쪽 자리는 첫 입장 때까지 준비가 끝나지 않을 수 있다.
- **들어가는 순서** — P2a 는 준비 모듈(`src/lab-preparation-service.ts`)과 그 테스트만, P2b 는 State 연결(`labCreate`·`labJoin`·
  끝내기·알람)을 켜는 작은 변경이다.

## 합성 지연 모델 (측정 아님)

코드는 `tools/lab-latency-benchmark.mjs`, 테스트는 `test/lab-latency-benchmark.mjs`. 의존성 없는 오프라인 계산기다.

```
node tools/lab-latency-benchmark.mjs --rtt=80 --jitter=20 --frame=16.7 --samples=2000 --seed=1
                                     [--interval=2500 --server=150 --ready-window=60000]
```

**이것은 합성(synthetic) 모델이다.** 숫자로 준 RTT·jitter·프레임 간격과 시드로 만든 가상 표본만 계산한다.
실제 브라우저·PTY·네트워크 측정이 아니고, 실제로 지연이 줄었다는 증거도 아니다. 출력 JSON 에 `"synthetic": true` 와
`label`(`SYNTHETIC MODEL — not live browser/PTY evidence, not a measured improvement`)이 늘 붙는다.
키 문자열·주소·비밀·저장소·원격 측정(telemetry)·공급자·네트워크·브라우저 호출이 없다(테스트가 소스를 검사한다).

- **입력** — 모두 유한한 숫자, 범위 밖·음수·NaN·Infinity·모르는 인자는 거부(CLI 종료 코드 2, stdout 비어 있음).
  표본 수 1~10000, RTT·jitter 0~10000ms, 프레임 1~1000ms, 간격 250~60000ms, ready 창 0~300000ms. 같은 설정·시드면
  바이트까지 같은 결과(키 단계와 폴링은 따로 된 수열이라 RTT 를 바꿔도 `keyToFrame` 표본은 그대로).
- **출력** — 설정 전체, 단계·방식별 정의 문구, `p50`·`p95`(nearest-rank, 0.1ms 반올림), 폴링 요청 수, timeout 수.
  `config` 는 정규화한 입력 값을 **반올림 없이 그대로** 담는다(예: 기본 `frameMs` 는 `1000/60` = `16.666666666666668`).
  반올림은 지표(`p50`·`p95`)에만 한다. 그래서 `config` 의 입력 키(`ceilingMs`·`responseGapMs`·`maxAttempts` 는 고정 상수라 빼고)를
  그대로 다시 넣으면 같은 결과가 나온다(테스트가 소수 프레임으로 확인한다).
- **키 입력 세 단계** — 각자 자기 경계로 계산하고 서로에게서 끌어내지 않는다.

  | 단계 | 정의 |
  |---|---|
  | `keyToFrame` | 로컬: 키 → 다음 애니메이션 프레임. P1 `keyToFrame` 이 근사하는 구간. 왕복과 **동시에** 흐르므로 합에 넣지 않는다 |
  | `networkToEcho` | 가상: 키 → 왕복(`rtt` + `[0, jitter)`) → 권위 있는(서버 쪽) 터미널 에코가 브라우저에 도착 |
  | `echoToRender` | 로컬: 에코 도착 → 그 다음 프레임 |
  | `keyToRender` | `networkToEcho + echoToRender` (겹치지 않고 이어진 두 구간) |

  메인 스레드 막힘·글자 그리기 비용·서버 쪽 셸 처리 시간은 모델에 없다.
- **입장 폴링 간격** — `old` 는 이전 대기 화면(`9d0b008` 의 `src/pages.ts`) 그대로다: 응답을 받은 뒤 2500ms 쉬고 다음 요청,
  횟수 상한 없음. 300초 마감은 **요청을 시작하기 전에만** 본다(시작 < 300000ms) — 그래서 마감 전에 시작한 요청의 ready 는
  300000ms 정각이나 그 뒤에 도착해도 받아들인다. `start` 는 아래 구현된 입장 동작과 **똑같은** 규칙이다: 다음 시작 =
  max(이전 시작 + 2500ms, 이전 응답 + 250ms), 요청 최대 120번, 300000ms 이상에는 시작하지 않고, ready 를 300000ms 정각이나
  그 뒤에 보면 입장하지 않는다(timeout 으로 센다). 손 계산 테스트: 마감 정각 ready 는 `start` 거부·`old` 받아들임, 마감 뒤 늦은
  ready 도 `old` 는 받아들임, 마감 5ms 전 ready 는 `start` 입장. 둘은 같은 ready 시각·같은 요청별 지연
  (`rtt + jitter + server`)을 쓴다. 표본 하나씩은 `start` 가 늘 이기지 않으므로(요청 격자가 다르다) 분포로만 본다.
  `start` 는 요청 수가 조금 늘어난다. 손 계산 회귀: 응답 3000ms → 다음 시작 3250ms, 응답 100ms → 2500ms(old 는 5500·2600).
  자료 경고 뒤 4초 대기·오류 뒤 다시 시도·여러 번 누르기는 모델에 없다(입장 동작의 가상 시계 테스트가 맡는다).

### 입장 폴링 간격 — 구현된 동작

대기 화면(`src/pages.ts` 의 `labJoinPage` `wake`)은 `b8061f3`(perf: bound and shorten lab entry retries)에서 요청 시작 기준
간격으로 바뀌었다. 합성 모델의 `start` 가 맞춘 동작:

- 다음 요청 시작 = max(이전 요청 시작 + 2500ms, 이전 응답 + 250ms) (단조 시계). 응답이 빠르면 시작 간격 2500ms
  (응답 뒤 기다림을 최대 2.25초 줄일 수 있다), 느리면 응답 뒤 250ms.
- 동시에 한 요청만: 버튼·Enter 는 한 번만 받고(singleflight) 도는 동안 버튼을 막는다. 오류·마감이면 다시 시도 화면으로 돌아온다.
- 사용자 동작 한 번에 요청 최대 120번. 300초(5분) 마감 정각이나 그 뒤에는 새 요청을 시작하지 않고, 응답이 마감 정각이나
  그 뒤에 도착하면(ready 여도) 입장 form 을 보내지 않으며, 자료 경고 뒤 4초 대기가 마감을 넘겨도 보내지 않는다.
- `/__lab/enter` 는 그대로 POST 만, `code`·`watch` 필드 그대로, 화면 글자는 `textContent`. 서버 쪽 폴링 한도(40)·준비·권한 검사는
  바꾸지 않는다.
- 이것은 클라이언트 쪽 기다림을 줄일 수 있다는 뜻일 뿐, 실제 입장 지연이 줄었다는 측정이 아니다(실제 참가자 이득은 재지 않았다).

### 터미널 에코 — 결정과 하지 않는 것

- **로컬 에코 실험은 opt-in, 기본 꺼짐.** Toolshed 기본값도 로컬 에코 OFF 다. 권위 있는 화면은 서버 에코이고, 로컬 예측은
  그 전까지의 표시일 뿐이다.
- **스냅샷 플래그 (opt-in 전용)** — `lab/snapshot.ps1 -LocalEchoExperiment` 를 따로 줄 때만
  `lab/files/code-server-settings.json` 을 바탕으로 기존 키를 모두 두고 `terminal.integrated.localEchoEnabled=on`,
  `localEchoLatencyThreshold=0`, `localEchoStyle=dim` 세 개만 넣은 설정으로 굽는다(작은 설정 도우미가 합친다).
  `excludePrograms` 는 넣지 않는다 — 비워 두어 기본 제외 목록(tmux 포함)이 그대로 적용된다. 플래그 없이 굽는 기본 스냅샷의
  설정은 바이트까지 같다.
  - 예시 (실행하지 않음 — 공급자 호출·과금): `lab/snapshot.ps1 -LocalEchoExperiment -Name gw-lab-v4-echo`
    → 크기별 변형(1c2g·2c4g·4c8g)을 만든다.
  - 키·API 를 건드리기 전에 거부: `-Name` 이 없을 때, 기본 이름 `gw-lab-v4`(대소문자 무시)일 때, 이름 형식이 틀릴 때,
    `-Force` 와 함께일 때.
  - **스냅샷을 실제로 구운 적도, 실습실에서 로컬 에코를 재 본 적도 없다.** 단위 테스트(설정 합치기·인자 검사 순서)뿐이다.
  - **지금 참가자는 바뀌지 않는다.** 실습실 설정·배포·기존 수업·기존 샌드박스는 그대로다. 실험 스냅샷은 나중에 사람이
    **새 수업**을 만들 때 고를 때만 쓰인다. 되돌리기도 다음 새 수업에서 보통 스냅샷(`gw-lab-v4`)을 고르는 것이고, 이미 만든
    수업·샌드박스를 바꾸지 않는다.
  - A/B 를 한다면 같은 조건(자리 크기·지역·시간대·망)에서 기본 스냅샷과 실험 스냅샷을 비교하고, 셸은 bash 로 잰다. tmux 안에서는
    로컬 에코가 꺼져 있으므로(기본 제외) tmux 안의 입력은 두 스냅샷이 같다 — bash 결과를 tmux 로 넓혀 말하지 않는다.
- **모든 전체 화면 TUI 에서 맞는다고 보장하지 않는다.** vim·less 같은 대체 화면·raw 모드 프로그램에서 예측이 틀릴 수 있다.
  **tmux 는 대상에서 뺀다.**
- **터미널 출력은 순서대로·잃지 않고** 전한다(필요하면 backpressure 로 늦춘다). 화면 공유 영상처럼 늦은 프레임을 버려도 되는
  흐름과 다르다 — 터미널 바이트는 버리지 않는다.

### 전송 계층 관찰

- 응답 압축은 이미 zstd 를 쓰고, `Alt-Svc` 로 h3 를 알린다. 실제로 어느 프로토콜(h2/h3)이 쓰이는지는 브라우저·망이 정하므로
  **약속하지 않는다**. 이 관찰은 작업 지시에서 받은 것이고 이 패치에서 네트워크로 다시 확인하지 않았다.
- 다음은 주장하지 않는다: 공개 정적 자산 캐시, 참가자(학생) 직접 경로, Argo(Cloudflare Tunnel) WebSocket 개선.

## 테스트와 한계

```
node test/lab-latency-benchmark.mjs      # 합성 지연 모델 (오프라인 계산, 측정 아님)
node test/lab-client-performance.mjs     # P1 브라우저 측정 스크립트 (node:vm 가짜 환경)
node test/lab-server-timing.mjs          # Server-Timing 정리·입장/자리 호스트 헤더·labJoin 순서(소스 구조)
node test/lab-entry-performance.mjs      # 입장 화면이 app.js 없이 곧바로 / 로
node test/lab-preparation-service.mjs    # P2 준비 서비스 (가짜 저장소·시계·Daytona)
node test/lab-preparation-state.mjs      # P2 State 연결 (가짜 ctx·메모리 저장소, fetch 가짜)
npm run test:security                    # 기존 보안 묶음 5개 (로컬 임시 포트·합성 fixture, 좁히기 인자 없음)
npm run check
```

전부 로컬에서만 돈다: 진짜 Daytona·SFU·공급자·자료 주소·배포를 부르지 않고 자격 증명을 넣지 않는다.
`lab-server-timing.mjs` 의 4절은 `src/state.ts`·`src/lab-preparation-service.ts` 소스를 읽어 순서(자리 확인 → 이름 → Daytona 키 →
`ensure` → 다시 확인하며 `opened` → 감사)와 "실패 응답에는 시간 없음·요청 시계는 `total`, 공유 일 관측은 `prep_*`·준비 서비스는 who/opened/pv/감사를
쓰지 않음" 을 본다. 소스 문자열 검사라 동작 증명이 아니며, 동작은 위 P2 테스트 두 개가 맡는다.

`lab-client-performance.mjs` 는 설치된 esbuild 로 `src/labperf.ts` 를 옮겨 문자열을 꺼내고, `node:vm` 안에서 가짜 `window`·
`sessionStorage`·`performance`·`requestAnimationFrame`·`PerformanceObserver`·타이머로 돌린다. 네트워크·브라우저·
자격 증명을 쓰지 않는다. 확인하는 것: 기본 꺼짐(값 없음·`'0'`·저장소 예외), 내용·주소를 읽거나 내보내지 않음
(키·값 getter 감시, 전송·쓰기·로그 함정), 표본 간격·대기 rAF 하나·고리 128·60초, 고정 분류, 기능 없음·예외,
`stop()`·`pagehide` 정리, 스냅샷 복사본·모양.

가짜 환경이라 확인하지 못하는 것: 진짜 브라우저의 `timeStamp` 기준점, rAF 가 불리는 실제 시점과 프레임 스로틀링
(백그라운드 탭), longtask 보고 지연·버퍼, code-server 의 실제 DOM 구조(`.monaco-editor`·`.xterm` 클래스가 바뀌면
`other` 로 떨어진다), Trusted Types·CSP 아래 동작, 다른 스크립트(guard.js·bar.js)와의 상호작용.

## 계획

- **P1 (들어감, `0ac51c1`)** — 측정 도구와 입장 화면 정리. opt-in 로컬 측정 스크립트(`/__lab/perf.js`, 최상위 문서에 맨 뒤
  `defer`, 기본 꺼짐)와 단위 테스트, `labJoin`·자리 호스트 문서의 성공 응답에만 붙는 정리된 `Server-Timing`(JSON 메타데이터 없음),
  `labEnterPage` 에서 `/__lab/app.js` 빼기. **실제 체감 지연이 줄었다는 측정은 아직 없다.**
- **P2 (P2a 준비 모듈 + P2b State 연결)** — 위 "자리 미리 준비". 첫 입장은 그래도 같은 준비 일을 같이 기다리는 대체 경로(대기
  화면 폴링)를 탄다. 기존 권한 검사는 작업보다 먼저이고, 준비가 자리·멈춤·끝 시각·일 주인을 다시 확인한다. 배포 환경 측정은 없다.
- **P3 (조건부 설계, 구현 안 함)** — 터미널 에코·왕복은 따로 설계한다: 가짜 code-server/toolbox(loopback)로 키 입력 → 출력 도착 →
  그려진 프레임을 재는 로컬 하네스. 진짜 Daytona·SFU·공급자 호출 없이. guard·화면 공유(영상)·CPU·지역을 바꾸는 일은 실제 첫 입장
  시간과 입력 지연 측정(P1 도구·하네스)으로 원인이 확인된 뒤에만 정한다. 어느 단계도 체감 지연이 다 없어진다고 약속하지 않는다.
  그 전 단계로 위 "합성 지연 모델" 이 단계 정의와 폴링 간격 비교를 숫자 가정으로만 보여 준다(측정 하네스를 대신하지 않는다).

## 안전한 검증 방법

- 자동 검증은 위 명령들뿐이고 바깥에 닿지 않는다.
- 사람이 확인할 때는 로컬 개발 서버나 자기 자리에서, 위 콘솔 명령으로 이 탭만 켠다. 배포 설정·비밀·진짜 자격 증명을
  테스트에 넣지 않는다. 다른 참가자의 자리에서 켜지 않는다.
- 이 문서와 스크립트는 릴리스 준비 완료를 뜻하지 않는다.
