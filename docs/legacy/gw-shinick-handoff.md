# 인수인계 — gw-shinick (k.shinick.dev · 공부방 lab.shinick.dev)

작성 2026-09-30. 기능 설명은 `README.md` 가 기준이고, 이 문서는 **이어서 개발·운영하는 사람이 알아야 할 것**(계정·비밀값 위치·절차·규칙·함정·남은 일)을 모은다.
코드와 README 가 이 문서와 다르면 코드가 맞다 — 고친 사람이 이 문서도 고친다.

---

## 0. 한눈에

| | |
|---|---|
| 무엇 | ① 남의 PC 에서 내 API 키를 진짜 키 없이 쓰는 **자격 증명 중개**(k.shinick.dev) ② 로그인 비밀 **금고**(/vault) ③ 수업마다 참가자별 Daytona 실습실(브라우저 VS Code + Claude Code·OpenCode)을 만들어 주는 **공부방**(/lab, lab.shinick.dev) |
| 운영자 | 사용자 한 명 (jcpukpyi@gmail.com). 사업화(강의실 유지) 검토 중 |
| 소스 | `C:\Users\user\source\gw-shinick` = GitHub **비공개** `shinick-studyroom/gw-shinick` (`main`) |
| 실행 | Cloudflare Worker `gw-shinick` + Durable Object `State` 하나 (`idFromName('main')`) |
| 배포 | 기본은 사용자가 `deploy.ps1`로 수행. 이번 수업 화면 구현·commit/push/release·운영 교체는 사용자가 명시 승인하여 AI가 수행했다. 별도 승인 없는 비밀값 변경은 하지 않는다. |
| 마지막 배포 | 2026-10-16 21:27 KST 확인 · `v2026.10.16.22` · 코드 `77459d3` · Worker `a3fc6f29-ef37-48ae-a200-ef7752683788` 100% — 중앙 시연실 송출 버튼 복구·전체 화면 제어. 사용자 구현·배포 승인으로 진행 |
| 테스트 | 로컬 e2e 82 · lab-e2e 237 · rtc-browser 25 · 진짜 샌드박스 점검 27 (2026-09-30 전부 통과) |

---

### 배포 반영 확인

최신 `v2026.10.16.22`: [중앙 송출 버튼 표시 보완](docs/classroom-unified-workspace.md). 참여자 미리보기 세션 종료 시 live 모듈이 송출 제어까지 비우던 결합을 분리했다. 현재 모임의 송출 행을 안정적으로 유지하고 중앙 시연실 제목줄/전체 화면/모아보기/지원에서 접근할 수 있다. 관리자 유효·미리보기 세션 없음이면 기존 관리 API를 사용한다. 두 권한 모두 없으면 버튼을 비활성화하고 보안 키를 안내한다. 시연실 생성·새로고침만으로 자동 송출하지 않는다.

검증: 표시/권한4·중앙20·외부16·진행39·통합25·수업 구성 UI·타입/생성물·dry-run 통과. Aside에서도 실패한 미리보기 세션+중앙 iframe 상태의 버튼을 확인했다. 합성 실습실/인증과 실제 Cloudflare SFU·실제 송수신 스크립트/WebRTC를 연결해1920×1080 수신·편집 픽셀 변경·전체 화면 버튼·중지 수신을 확인하고 해당 검사 세션만 정리했다. 실제 Daytona/운영 모임·참여자 PC 수업망은 검증하지 않았다. State/API/비밀값/바인딩/저장 스키마 변경 없음.

21:27 KST 공개 HTML SHA-256 `a72204b89d0b420cb3de2dd7ee716c64d8d6ac4e1d11b05ba9e787aedfdc0518`가 소스와 일치하고 no-store, 무인증 관리 송출/시연 bridge401을 확인했다. Worker100% 배포 및 release/push 완료. 설치 앱은 새로고침 후 시연실 제목줄의 시연 송출 시작을 누른다. 증거는 `.artifacts/classroom-broadcast-controls-20261016/real-sfu.json`, `production-verification.json`과 새 테스트/통합 검사 도구에 있다.

아래는 이전 `v2026.10.16.21` 검증 기록이다.

최신 `v2026.10.16.21`: 중앙 시연실에서만 조건부 요청 헤더를 제거하고 완전한 HTML/no-store 응답을 사용한다. 304가 frame-ancestors self/X-Frame-Options SAMEORIGIN을 돌려주면 iframe이 거부되고 HTML 주입을 건너뛰던 오류를 실제 workerd/SQLite/Edge에서 재현해 수정했다. 일반 참여자·자산·최상위 새 탭 정책은 바꾸지 않는다. 새 실제 Worker 브라우저 검증5경로, 기존 호스트/브라우저 보안69·시연 호스트11·타입/생성물·dry-run 통과. State/비밀값/바인딩/저장 스키마 변경 없음. 실제 사용자 실습실의 인증된 입장은 여전히 Aside 관리자 권한 부재로 실물 확인하지 못했다. 기존 모임을 새로 만들지 말고 Ctrl+Shift+R 후 다시 연결한다. 증거는 `.artifacts/classroom-demo-cache-fix-20261016`과 `test/lab-demo-embed-browser.mjs`다.

아래는 이전 `v2026.10.16.20` 검증 기록이다.


최신 `v2026.10.16.20`: [중앙 시연실 연결](docs/classroom-unified-workspace.md). 독립 시연실의 VS Code를 중앙 iframe에 넣는다. 준비 완료·새로고침 시 상태/open만 사용해 자동 연결하고 새 prepare/send를 자동 호출하지 않는다. 화면 전환은 동일한 DOM 부모 아래 iframe을 화면 밖에 보관해 편집 상태를 유지한다. 명시적 다시 연결은 기존 송출을 멈추고 새 grant로 프레임을 교체한다. 크게·전체 화면·모드 전환 버튼은 접근 가능하게 유지한다.

시연실 root iframe·demo-bridge.js만 fresh labRoute로 쿠키/label/demoParent/살아 있는 부모 모임을 확인한다. 참여자 자리에는 예외를 주지 않는다. 부모의 frame-src는 /lab에서만 자리 도메인을 허용하고, 자식 frame-ancestors는 정확한 운영자 출처만 허용한다. 기존 DOM 캡처 번들에서 ImageBitmap을 보내며 부모는 정확한 origin/window/nonce/sequence/dimensions를 확인한다. 첫 프레임 전 captureStream 금지, 10초 신선도/첫 프레임 제한, 20초 준비 안내·retry, late 응답 폐기와 BFCache 타이머 정리를 검증했다.

검증: 호스트11·State6·API7·서비스11·native6·새 UI통합18·메시지/수명 검증, 기존 보안289·진행39·통합25·외부 공유16·수업 구성 UI, 타입/생성물·Worker dry-run 통과. StackBite의 두 Grok CLI 작업자는 요청 모델 grok-4.7-build-fast/high 실제 exit0를 확인했다. 부모가 iframe 재부착·임의 load 준비 판정·재연결 동작을 검수 수정했고 수정본을 독립 검토/재검증했다. Aside의 합성 화면에서 직접 편집·모아보기 복귀 후 내용 유지·스크롤 없음을 확인했다.

19:48 KST 공개 HTML SHA-256 `767f65f5a084ff312775990150c65fd421c06ae020305893d02d6df410b8bff9`가 코드와 일치한다. 새 landing의 정확한 frame-ancestors, bridge 무인증401, 무인증 root iframe403, Origin 없는 관리 API403을 확인했다. State 내부 route 응답에 선택적 demoParent를 추가했으며 저장 형식·바인딩·비밀값·마이그레이션 변경은 없다. DO 갱신은 deferred30s를 지정했지만 코드 전파는 eventual consistency이므로 실제 사설 시연실 응답 확인을 대신하지 않는다. Aside 운영 세션은 monitor만 있고 admin은 없어 실제 Daytona VS Code 중앙 입장/수신 실물 검증은 미완료다. 새 자원 생성·키 우회는 하지 않았다. 설치 앱은 새로고침으로 반영한다. 증거는 `.artifacts/classroom-embedded-demo-20261016`에 있다.

아래는 이전 `v2026.10.16.19` 검증 기록이다.



최신 `v2026.10.16.19`: [내 시연과 참여자 지원](docs/classroom-unified-workspace.md). 중앙의 실제 파일 편집·명령 화면만 DOM 영상으로 만들어 기존 SFU에 송출한다. 모아보기/지원 중에도 같은 원본을 화면 밖에 유지하며 관리 화면·참여자 영상을 기본 송출에 포함하지 않는다. 출력1920×1080·트랙최대15fps·2.5Mbps 상한, 렌더는 겹치지 않게 간격을 조절한다. 별도 전체 VS Code/OpenCode는 내장한 것이 아니며 ‘다른 화면’에서 기존 외부 탭·창 캡처를 사용한다.

새 손들기는 선택 모임의 첫 스냅샷을 기준으로 감지해 아이디·좌석번호와 함께 자동 확대하고 추가 요청은 대기한다. 자동 제어 요청·키보드 포커스 이동은 없다. 종료 응답이 늦게 와도 새로 선택한 지원 화면을 닫지 않게 세대·화면 변경을 확인한다. 관리8시간·참여자 제어 동의·보안 키 승인·불확정 종료 차단 정책은 유지한다. 모임 전환·로그아웃·원본 소실은 캡처를 정리한다.

검증: 통합25·진행39·외부 공유16, 캡처·자동 지원/종료 경합·수업 구성 UI·영상 지원·화질, TypeScript/생성물·Worker dry-run 통과. 캡처 비동기 취소와 원본/직접 중지 등 독립5개 검사도 통과했다. StackBite에서 Grok CLI `grok-4.7-build-fast`/high 작업자2개의 실제 exit0를 확인한 뒤 통합·검수했다. Aside에서 실제 로컬 중앙 전환·자동 지원·송출 유지와 운영 새 컨트롤/factory를 확인했다. 정적 detector0건은 전체 접근성 검증이 아니다.

19:17 KST 운영 HTML SHA-256 `0975d886c5417de94a3b63e91b1913d4839adf31552ff4eab712e25728c44c2c`과 코드 일치, no-store/CSP 및 인증 없는 읽기 요청401·Origin 없는 요청403을 확인했다. UI만 바뀌어 State/API/비밀값/바인딩/마이그레이션은 변경하지 않는다. DO 교체는 `deferred 300s`, 설치 앱은 새로고침으로 적용한다. 실제 참여자 자원 생성·실제 제어·실제 수업망의 화질 재측정은 하지 않았다. 증거는 `.artifacts/classroom-unified-workspace-20261016`에 있다.

아래는 이전 `v2026.10.16.18` 검증 기록이다.

최신 `v2026.10.16.18`: [Full HD 송출과 내 화면 미리보기](docs/classroom-broadcast-preview.md). 캡처를 1920×1080 ideal/max로 요청하고 기존 15fps·2.5Mbps·해상도 우선 정책을 유지한다. 실제 크기는 캡처 설정과 outbound-rtp 통계로 표시한다. 원본/창 크기/네트워크에 따라 실제 크기는 달라질 수 있으며 수신자 전원의 해상도를 보장하지 않는다.

같은 캡처 스트림을 중앙에서 크게·작게·브라우저 전체 화면으로 재생한다. 새 캡처·SFU 시청·재송출을 추가하지 않는다. 참여자 지원·모아보기는 중앙을 우선 사용하며 송출은 유지한다. 공유 중지·로그아웃은 미리보기도 해제하고, 캡처 선택 중 로그아웃하면 늦은 캡처도 중단한다. 상단에는 설정만 남기고 새 모임을 설정 안으로 옮겼다. 생성 결과 복구와 prepare 링크는 유지한다.

검증: 신규 송출 UI16, 진행39·운영37·관리/모니터98·인증 복원9·로그아웃25·좌석 추가15·요청 미리보기16, TypeScript·Worker dry-run 통과. 3840×2000·1920×980·390×844의 실제 페이지와 합성 캡처/RTC, native fullscreen, 같은 스트림 재사용을 확인했다. Aside에서도 로컬 캡처1920×1080·미리보기 전환을 확인했다. 정적 탐지0건은 전체 접근성 검증이 아니다. 실제 사용자 화면 캡처와 실제 망 지연/화질 재측정은 하지 않았다.

17:58 KST 운영 HTML SHA-256 `887487a61ab8287e14cfda9b1313f928ffb658b46cef80d3ae89fe45eff4a2b0`과 소스 일치, 새 미리보기 컨트롤·상단 메뉴 제거와 기존 인증 경계401/403을 확인했다. UI 변경으로 State/API/바인딩/비밀값/마이그레이션은 바꾸지 않는다. 설치 웹앱도 새로고침으로 적용한다. 증거는 `.artifacts/classroom-broadcast-preview-20261016`에 보관한다.

아래는 이전 `v2026.10.16.17` 검증 기록이다.

`v2026.10.16.17`: [자동 미리보기에서 개설 요청 승인](docs/classroom-request-previews.md). 상단 개설 요청 메뉴를 없애고 참여자 자동 미리보기 위에 회색 대기 자리와 승인 버튼을 표시한다. 배경만 천천히 점멸하며 동작 줄이기 설정을 따른다. 요청이 없으면 영역을 숨긴다. 합류는 선택한 모임이 기본이며 개인 복습 사양·시간·AI 한도는 접어 둔 조건 변경에서 조절한다. 지난 기록·기기 알림은 설정의 작은 요청 기록·알림 링크로 연다.

본인 전용 Access 경로와 기존 요청별 보안 키 승인·복구 API를 재사용한다. 새 API·State·바인딩·비밀값·마이그레이션 변경은 없다. 응답 유실·새로고침 후에는 요청 ID만 보관해 재승인을 차단한다. 본인 인증 만료와 관리 화면 로그아웃 뒤의 늦은 응답은 요청자 이름·목적을 복원하지 않는다. 요청은 보이는 탭에서 15초마다 확인하며 기존 수업 공유·제어 세션과 별개다.

검증: 신규 UI16, 진행39·운영39·관리/모니터98·인증 복원9·로그아웃25·좌석 추가15, 요청 API21·승인 State51, TypeScript·Worker dry-run 통과. PC/모바일 합성 화면과 Aside에서 대기 자리·조건·진행 화면을 확인했다. 정적 탐지0건은 전체 접근성 검증을 뜻하지 않는다. 운영 17:43 KST 공개 HTML SHA-256 `e3e9aae43e065100a6b86bc59babca186160f894aeb1d47e18f0e8dce15e12c3`이 소스와 일치하고 기존 인증 경계401/403을 확인했다. Aside 운영 탭에도 상단 요청 메뉴 제거와 미리보기 안의 요청 영역이 반영됐다. 실제 참여자 요청 승인·새 자원 생성은 검증에 사용하지 않았다. 설치 앱도 새로고침으로 반영한다. 증거는 `.artifacts/classroom-request-previews-20261016`의 `checks.json`, `production-verification.json` 및 스크린샷이다.

아래는 이전 `v2026.10.16.16` 검증 기록이다.

`v2026.10.16.16`: [작은 도구 창과 진행 중 좌석 추가](docs/classroom-seat-add.md). 상단 새 모임·설정은 작은 버튼으로 열고 Escape/닫기로 수업에 돌아온다. 빈 모임 목록에서도 준비 창을 자동으로 띄우지 않는다. 설정은 최대 520px 폭이며 긴 설명·앱 설치 안내는 접었다 연다. 현재 모임의 수업 구성을 편집하는 내부 수업 준비 메뉴는 유지한다.

진행 중 좌석 추가는 현재 조건·종료 시각·추가 자원 비용을 확인한 뒤 한 자리를 만들고 새 자리 전용 초대를 연다. 기존 참여자와 종료 시각은 유지한다. 모임당 최대 20자리이며 실제 조직 자원 한도에 따라 실패할 수 있다. 기존 생성 기록·트랜잭션·권한 재확인·자원 정리를 재사용한다. 같은 탭의 새로고침 복구에는 비밀이 아닌 요청 참조만 저장하며 자동 재생성하지 않는다. 시연/체험 연결/종료 모임은 거절한다. 관리 8시간·개설 요청 보안 키 승인·Access·참여자 제어 동의는 바꾸지 않는다.

검증: 신규 State 12 시나리오·API35·UI15, 기존 진행39·운영40·관리/모니터98·인증 복원9·로그아웃25·생성 State43/서비스26·개설 State51/서비스16, TypeScript·Worker dry-run 통과. 정적 디자인 탐지0건은 전체 접근성 검증을 뜻하지 않는다. 1920×980/390×844와 Aside에서 작은 창·수업 복귀를 확인했고, 운영 페이지의 설정 열기/Escape도 읽기 전용으로 확인했다. 실제 자원 생성·참여자 제어는 검증에 사용하지 않았다.

17:28 KST에 공개 HTML SHA-256 `aab598fdfd361fa887f43d6fb02525dce3c25fff57e3aa8b8d53be9de2c0e99d`과 소스 일치, no-store, 새 좌석 추가·조회 RPC의 합성 무효 토큰401과 Origin 없는 요청403을 확인했다. 배포 직후503은 기존 DO 코드였으며 `deferred 300s` 교체 뒤 새 메서드 응답까지 확인했다. 바인딩·비밀값·마이그레이션 변경은 없다. 설치 앱도 새로고침으로 적용한다. 증거: `.artifacts/classroom-seat-add-20261016/validation-summary.json`, `production-verification.json`, PC/모바일 스크린샷.

아래는 이전 `v2026.10.16.15` 검증 기록이다.

`v2026.10.16.15`: [모임지기 수업 진행 화면](docs/classroom-command-center.md). 1920×1080·1920×980에서 기본 시연 파일 편집·명령 입력, 참여자5명, 도움 요청, 현재 안내를 페이지 스크롤 없이 보도록 바꿨다. 중앙은 내 시연·선택한 참여자 지원·전체 모아보기로 전환하고 오른쪽에 진행 표시와 미리보기를 합쳤다. 자료·코드와 모임 도구는 닫기/Escape로 복귀하는 대화상자를 사용한다. QR을 크게 열 때 도구 패널을 닫는다. 돌아가기·중앙 작게 보기는 제어 종료를 요청하며 동의·종료 미확정 차단 정책을 유지한다.

검증: 새 진행 화면39, 기존 운영40, 관리·모니터98, 인증 복원9, 로그아웃 경합25, 수업 화면·영상 지원·화질/사용량·TypeScript·Worker dry-run 통과. 12명 목록은 영역 안에서 스크롤하면서 안내를 유지하고 작은 창·모바일은 세로로 배치한다. Aside에서도 로컬 도움 요청·중앙 지원·복귀 시 scrollY=0과 안내 노출을 확인했다. 정적 detector 결과0건은 전체 접근성 검증을 뜻하지 않는다. 실제 Daytona·SFU 망 지연·화질 재측정은 범위 밖이다.

16:48 운영 HTML SHA-256 `6bdd88c08b8a48076407ff5a5cead7b9340f9c3865d9fbd7b16b0f7ffadaf031`과 소스 일치, 신규 화면 컨트롤 포함, 인증 없는 기존 API401·Origin 없는 요청403·no-store를 확인했다. State/API/비밀값/바인딩/마이그레이션 변경은 없다. DO 교체는 기존 연결을 위해 `deferred 300s`로 두었다. 설치 앱도 페이지 새로고침으로 적용한다. 상세 증거: `.artifacts/classroom-command-center-20261016/validation-summary.json`, `production-verification.json` 및 PC/모바일 스크린샷. 실제 참여자 실습실 생성·제어·종료나 보안 키 동작은 배포 검증에 사용하지 않았다.

아래는 이전 `v2026.10.16.14` 검증 기록이다.

`v2026.10.16.14`: [새로고침 후 관리 인증 유지](docs/lab-admin-refresh.md). 관리 토큰이 페이지 메모리에서 사라지던 문제를 HttpOnly·Secure·Strict 호스트 쿠키와 동일 출처 복원 POST로 해결했다. 최초 로그인부터 8시간이며 복원으로 연장하지 않는다. 배포 후 한 번은 보안 키로 로그인해야 쿠키가 생긴다. 기존 보기 쿠키는 관리 권한으로 승격하지 않고, 개설 승인 시 보안 키 확인은 유지한다. 로그아웃은 쿠키와 서버 토큰을 모두 폐기하며 지연된 복원·쿠키 응답으로 권한이 살아나지 않게 했다.

검증: 실제 Worker/State와 격리 브라우저의 인증 복원9, 모니터144, 로그아웃 경합25, 관리 화면98, 수업 화면·TypeScript·Worker dry-run 통과. `deferred 300s` 교체 후 15:57에 새 State RPC가 응답하는 것까지 확인했다. 운영 HTML SHA-256은 `b0f52fa4232171b5ce1ed74434e9387838441d4d6a8ebd553e9b93a67bcb19f7`. 운영 검사에서는 원래/외부 출처·무권한·합성 무효 토큰만 사용했고 실제 보안 키 로그인이나 참여자 실습실 변경을 실행하지 않았다. Aside에서 기존 읽기 전용 모임 화면도 확인했다. 증거는 `.artifacts/classroom-admin-refresh-20261016/production-verification.json`. 새 바인딩·비밀값·마이그레이션·설치본 교체는 필요 없으며 설치 앱도 새로고침해 적용한다.

아래는 이전 `v2026.10.16.13` 검증 기록이다.

`v2026.10.16.13`: [수업 화면 사용 가이드](docs/classroom-flow.md), [검증 범위와 결과](docs/classroom-validation-2026-10-16.md). 서버·모임지기·참여자 작업을 StackBite/Grok CLI로 병렬 구현한 뒤 통합했다. 관리8시간·자동 실습실 미리보기·제어 동의·보안 키 승인 정책은 유지한다. 새 기능은 별도 DO나 외부 LMS 서버를 설치하지 않고 기존 SQLite State에 추가했다.

운영 반영은 `deferred 300s`로 진행했다. 15:29에 새 State RPC가 실제 응답하는 것까지 확인했다. 공개 `/lab` HTML 해시는 `1fa5c2cb1aeb966c02e40f3e9f871db16a688961af3c3aaa57acd5205fcecba8`로 소스와 같다. 새 API의 인증 없는 요청401·Origin 없는 요청403, 임의의 잘못된 관리 토큰401, 존재하지 않는 합성 시연 입장권410을 확인했다. 실제 참여자 실습실 생성·실행·제어·종료는 검증에 사용하지 않았다. 상세 증거는 로컬 `.artifacts/classroom-implementation-20261016/production-verification.json`에 있다. 설치된 웹앱과 열려 있던 실습실은 다음 페이지 새로고침에서 새 화면을 받는다.

아래는 이전 `v2026.10.16.12` 검증 기록이다.

2026-10-16 UI 배포: [기능별 운영 가이드](docs/lab-operator-ux.md). StackBite/Grok CLI(`grok-4.7-build-fast`, high)로 세 구현 작업을 병렬 진행하고 독립 검수에서 찾은 만료 경로 두 건을 수정·재검수했다. 관리8시간·Access 본인 로그인·승인 WebAuthn·참여자 제어 동의는 유지한다. `도와주기`만으로 제어를 요청하지 않는다. 관리자 만료 후 관리 메타데이터는 폐기하고, 모니터 만료는 독립적으로 유효한 라이브 지원을 끊지 않는다. UI만 바뀐 릴리스이며 리소스·비밀값·API 정책·마이그레이션은 바꾸지 않았다. Worker는 `deferred 300s`로 반영했고 기존 사용자 탭을 강제로 새로고침하지 않았다.

검증: 통합 UX40, 요청함70, 관리/모니터98, 생성복구57, 개설36, 기존 모바일139·카드106, 셸·준비상태·영상지원·화질·Monaco/xterm 합성 검사 통과. 1366×768·390px·200% 상당 뷰포트와 Aside에서 배치 확인. 정적 탐지0건은 전체 접근성·실제 수업망 검증을 뜻하지 않는다. 로컬 증거: `C:\Users\user\source\.artifacts\operator-ux-audit-20261016` (`production-verification.json`, `result-review-initial.txt`, `result-review-final.txt`, `visual-after`). 운영 HTML 해시는 코드 `449106a`에서 생성한 결과와 일치하며 모니터 API는 읽기만 했다. 이 검증은 실습실 생성·승인·제어·종료를 실행하지 않았다.

Wrangler 4.143.0의 `versions deploy`는 Durable Object 코드 교체가 기본 `deferred 300s`입니다. 화면이 새 코드여도 상태 서버는 최대 5분 동안 이전 코드를 실행할 수 있으므로, 배포 성공 메시지만으로 완료 처리하지 않습니다. 요청함 목록에 자원 메타데이터가 포함되는지와 잘못된 CPU 값의 사양 오류 응답까지 확인합니다. 즉시 교체 옵션은 `--durable-objects-code-update-mode immediate`이며, 진행 중 요청·연결에 미치는 영향을 확인하고 사용합니다. [명령 참조](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-deploy).

## 1. 계정·서비스·도메인

| 서비스 | 내용 |
|---|---|
| Cloudflare | 계정 "Jcpukpyi@gmail.com's Account" (id `96aee9d5fb56f2efc3d90e147a67f558`). 존 `shinick.dev`. wrangler 는 이 PC 에 OAuth 로그인 돼 있음 |
| 호스트 | `k.shinick.dev` (중개·금고·관리·강사 /lab) · `lab.shinick.dev` (참가자 실습실 — 출처 분리) · `gw-shinick.ai-gongbu.workers.dev` (샌드박스가 부르는 프록시 `/p/` 전용) |
| Cloudflare Access | `console.shinick.dev` 및 별도 앱들. `k.shinick.dev`는 **요청함 `/lab/requests`와 `/api/lab/open/manager`만** 본인 전용 앱으로 보호. 호스트 전체를 감싸면 참여자 요청·API 클라이언트가 막히므로 금지 |
| Cloudflare Realtime (SFU) | 앱 id `c29dbceb14ae7159c05ee756c190ddc2` (비밀 아님, `wrangler.jsonc` vars). 앱 비밀 = Worker secret `REALTIME_APP_TOKEN`. 요금: egress GB 당 $0.05, 월 1,000GB 무료(TURN 과 합산) |
| Daytona | 샌드박스(컨테이너). 리전 us·eu 만 (아시아 없음, 지금 `us`). Tier 1 = 합계 10 vCPU·10 GiB·30 GiB, Tier 2 = 카드 + $25 충전 → 100 vCPU·200 GiB. 결제는 사용자 |
| OpenRouter | 관리 키(management key)로 **자리마다 $ 한도 서브키**를 만들고 끝나면 지운다. 기본 모델 `deepseek/deepseek-v4.1-flash` |
| GitHub | org `shinick-studyroom` (free), 저장소 `gw-shinick` private. org·저장소 **Actions 꺼짐** (사용 시간도 없음). 개인 계정 `Shinick-Han` |
| 보안 키 | YubiKey 5C **Nano**(PC 에 늘 꽂힘) · 5C **NFC**(휴대). 둘 다 WebAuthn 으로 등록됨 (RP_ID `shinick.dev`) |

---

## 2. 비밀값 — 어디에 있고 어떻게 다루나 (값은 절대 출력·기록하지 않는다)

| 이름 | 위치 | 용도 / 주의 |
|---|---|---|
| `MASTER_KEY` | Worker secret | DO 에 저장된 공급자 키 AES-GCM 암호화. **다시 만들지 않는다** (잃으면 `kv.ps1 push` 로 키 다시 올리기) |
| `SETUP_TOKEN` | Worker secret (필요할 때만) | 보안 키 등록(/register). 등록 끝나면 `deploy.ps1 -RemoveSetup` |
| `REALTIME_APP_TOKEN` | Worker secret + PC User 환경변수 | SFU 앱 비밀. DO 밖(브라우저)으로 안 나감 — 테스트로 확인함 |
| 공급자 키들 (openrouter 관리 키, daytona, tavily, groq, langsmith, openai …) | DO `prov:<id>` (MASTER_KEY 로 암호화) | `kv.ps1 push` 또는 /admin 으로 올림. 목록은 `kv.ps1 list` (끝 4자리) |
| 같은 키들의 원본 | PC **User 환경변수** (`DAYTONA_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`, `TAVILY_API_KEY`, `GROQ_API_KEY`, `LANGSMITH_API_KEY`, `REALTIME_APP_TOKEN` …) | 스크립트가 프로세스 안에서만 읽는다. `[Environment]::GetEnvironmentVariable(name,'User')` |
| 키 보관함 | `C:\Users\user\.secrets` (`Set-Keys.ps1`, `KeyStore.ps1`, `keys.enc.json`) | 사용자 개인 키 금고. **AI 작업자는 안의 값을 읽지 않는다**. `Set-Keys.ps1` 이 키를 넣은 뒤 `kv.ps1 push -Sources <환경변수이름>` 으로 서버와 맞춘다 |
| `.dev-master-key`, `.dev-setup-token` | 저장소 폴더 (git 제외) | 로컬 dev 서버 전용 |
| 금고 항목 | DO `vault:*`, `vwrap:*`, `vitem:*` | 종단 간 암호화 — 서버도 못 푼다 |

지켜 온 규칙:
- 샌드박스·참가자 응답에는 **가짜 토큰(`kvt_`)과 게이트웨이 주소만** 들어간다. OpenRouter 관리 키·Daytona 키·미리보기 토큰은 절대 안 나간다 (lab-e2e 가 검사).
- 로그 보기(`wrangler tail`)는 요청 헤더에 쿠키가 들어 있으니 URL·상태·시간만 걸러 저장한다.

---

## 3. 구조

```
빌린 PC /borrow ─QR─▶ 폰 /a/<id> ─보안 키 탭─▶ 승인 → kvt_ 가짜 토큰
API 호출 /p/<provider>/… ── kvt_ → 진짜 키 ──▶ upstream

강사 k.shinick.dev/lab (키 탭, 관리 토큰 8시간)
  └ 수업 만들기 → 자리마다: OpenRouter 서브키 + kvt_ 세션 + Daytona 샌드박스(스냅샷 gw-lab-v4-<사양>)
참가자 자리 초대 lab.shinick.dev/j/<자리 코드> (강사가 자리마다 QR·링크) → "입장" → 깨우기 → 자리 호스트 s-<label>.shinick.dev 로 POST → __Host-lab_seat
  └ s-<label>.shinick.dev/* → (labhost.ts) Daytona 미리보기 주소 + x-daytona-preview-token 로 code-server 대신 연결 (WebSocket 포함)
     └ workbench HTML 에 HTMLRewriter 로 guard.js(head 맨 앞, 동기) + bar/snips/screen/rtc.js(defer, code-server nonce) 삽입
샌드박스 안 claude/opencode → https://gw-shinick.ai-gongbu.workers.dev/p/openrouter/… (Daytona Tier 1·2 는 허용 목록 도메인만 나감 — k.shinick.dev 막힘)
강사 화면 공유: 강사 브라우저 ─WebRTC─▶ Cloudflare Realtime SFU ─▶ 학생 브라우저 (게이트웨이·Daytona 안 거침. 신호만 DO)
끝내기 / 끝나는 시각 알람 → 샌드박스 삭제 + 세션·서브키 폐기 (실패하면 5분마다 재시도)
```

- **DO 하나**가 모든 상태를 가진다 (강한 일관성 → 폐기 즉시 무효). 저장 키 목록은 `src/state.ts` 맨 위 주석이 기준.
- 샌드박스 수명: `autoStopInterval = 수업 시간(분)`, `autoDeleteInterval = 0` → **꺼지면 곧바로 삭제**된다. 탭을 닫아도 안 꺼지고, 수업 시간만큼 활동이 없을 때만 꺼진다(= 삭제). 수업 끝 시각에는 알람이 지운다.
- 샌드박스는 자리마다 **따로인 컨테이너**(파일·프로세스·네트워크 분리). CPU·메모리 상한은 cgroup(`/sys/fs/cgroup/memory.max`, `cpu.max`). `free`·`nproc` 는 호스트 전체를 보여 주므로 에이전트가 사양을 잘못 말한다(아래 9절).
- 출처 분리: 관리·금고(k.)·입장(lab., 화면만, 권한 없음)·자리마다 자리 호스트(s-<label>.)를 나눴다. 자리 호스트끼리도 출처가 달라 한 자리의 코드가 다른 자리 쿠키·화면에 닿지 않는다. 예전 `/c/<수업 코드>` 는 410 안내, 예전 `lab_seat` 쿠키는 권한이 아니고 보이면 지운다(진행 중 수업 참가자는 초대 링크를 다시 받아야 함).
- **자리 호스트 켜기 전 (배포 전 운영 준비)**: `LAB_SEAT_DOMAIN` 은 비어 있다(입장·수업 만들기 503). `*.shinick.dev` 와일드카드 DNS + route 를 이 Worker 에 연결하되 console.shinick.dev(Access) 등 기존 호스트가 와일드카드에 먹히지 않게 제외를 대시보드에서 확인한 뒤 `"LAB_SEAT_DOMAIN": "shinick.dev"`. route 우선순위는 로컬에서 증명하지 못했다.
- 위 그림의 강사→참가자 화면 공유는 그대로다. 참여자→모임지기 화면 벽과 동의한 탭만의 짧은 제어는 13절. 사용 순서는 `docs/lab-live-support.md`.

### 파일 지도

| 파일 | 줄 | 내용 |
|---|---|---|
| `src/index.ts` | 245 | 라우팅 (호스트별 분기, `/api/*`, `/p/` 프록시) |
| `src/state.ts` | 1567 | DO: 인증·세션·공급자·금고·수업(만들기/자리/깨우기/상태/공유/코드 보내기/화면 공유 신호/끝내기/알람) |
| `src/pages.ts` | 783 | 모든 HTML 페이지 (/borrow, /a, /admin, /register, /vault, /recv, /lab). 문자열 템플릿 안의 JS |
| `src/providers.ts` | 154 | 공급자 프리셋, 인증 헤더 방식, 고정 헤더(`normHeaders`), 실습실 공유 env |
| `src/lab.ts` | 129 | Daytona API 도우미 (spawn, exec, 자료 넣기, quota) |
| `src/labhost.ts` | 198 | lab.shinick.dev: 자리 쿠키, code-server 대신 연결, 스크립트 삽입, `/__lab/*` |
| `src/labbar.ts` | 224 | 참가자 막대(`LAB_BAR_JS`, `window.__labBarUI`) + 클립보드 경계(`LAB_GUARD_JS`) |
| `src/labsnips.ts` | 99 | 📥 받은 코드 |
| `src/labscreen.ts` | 192 | 강사 화면 보기 창 (`window.__labScreen.attach(stream|null)`, 작은 창/크게/PiP/숨김) |
| `src/labrtc.ts` | 82 | 학생 쪽 화면 받기 (SFU pull/answer → `__labScreen.attach`) |
| `src/go.ps1` | 250 | 빌린 PC 자동 로그인 스크립트 (`irm k.shinick.dev/go \| iex`) |
| `lab/files/*` | | 스냅샷에 들어가는 파일: `lab-start`(code-server), `lab-status`, `lab-doctor`, 안내 README, Claude/OpenCode/code-server 설정, tmux |
| `lab/snapshot.ps1` | 108 | 사양별 스냅샷 빌드 (`gw-lab-v4-1c2g/2c4g/4c8g`) |
| `test/*` | | e2e(82) · lab-e2e(237) · vault-browser(14) · go-e2e(24) · `lib.mjs`(소프트웨어 인증기) |
| `tools/*` | | 잠금 실행기·진짜 샌드박스 실행기·브라우저 점검 (6절) |
| `deploy.ps1` · `kv.ps1` · `run-dev.ps1` | | 배포 · 공급자 키 올리기 · 로컬 서버 |

---

## 4. 개발 환경과 코드 규칙

- Windows 11, PowerShell 7 (`pwsh`), Node 24, wrangler 4.x, TypeScript 7 (`npx tsc --noEmit`).
- 로컬 포트: dev 서버 **8797** (8787 은 다른 작업이 씀), 가짜 Daytona **8799** (+`/rtc` 가짜 SFU), 가짜 code-server **8800**. 세 포트를 테스트끼리 같이 쓰므로 `tools/test-locked.ps1` 의 전역 뮤텍스로 한 번에 하나만.
- **줄 끝·BOM 을 파일마다 유지한다** (`.gitattributes` = `* -text` 로 git 이 바꾸지 않게 해 둠. 전역 `core.autocrlf` 가 켜져 있다):

  | 파일 | 형식 |
  |---|---|
  | `src/state.ts`, `src/pages.ts`, `src/index.ts` | CRLF |
  | 나머지 `.ts`·`.mjs`·`.md`·`.json`·`lab/files/*` | LF (**셸 스크립트가 CRLF 면 샌드박스에서 안 돈다**) |
  | 프로젝트 `.ps1` (`kv.ps1`, `lab/snapshot.ps1`, `tools/*.ps1`, `deploy.ps1`) | UTF-8 BOM (+CRLF). `run-dev.ps1` 은 BOM+LF. **`src/go.ps1` 은 BOM 없음** (문자열로 번들돼 `iex` 로 실행) |
- `pages.ts` 는 TS 템플릿 문자열 안의 JS 다: JS 문자열의 `\n` 은 `\\n` 으로 써야 한다. 헷갈리면 `;` 구분처럼 줄바꿈이 필요 없는 형식을 쓴다.
- 참가자 VS Code 에 들어가는 스크립트(`labbar/labsnips/labscreen/labrtc`)는 **`innerHTML` 금지**(code-server Trusted Types) — DOM API 로만. 전역 키를 가로채지 않는다. `window.__labBarUI` 가 먼저 있어야 하므로 삽입 순서는 `['bar','snips','screen','rtc']` (bar 먼저).
- 페이지 CSP 는 `script-src 'self' 'unsafe-inline'`, 외부 스크립트 없음.
- 코드·주석·커밋 메시지는 기존처럼 한국어, 짧게. 사용자와의 대화도 한국어.

---

## 5. 배포와 운영 절차 (사용자가 실행)

```powershell
pwsh -File C:\Users\user\source\gw-shinick\deploy.ps1 -CodeOnly    # 코드만 (가장 흔함)
.\deploy.ps1 -SkipSetup     # 코드 + MASTER_KEY(없을 때만 생성)
.\deploy.ps1 -SetupOnly     # 보안 키 추가 등록용 SETUP_TOKEN 발급 → 등록 후 -RemoveSetup
.\kv.ps1 push [-Names tavily,openai] [-Sources LANGSMITH_API_KEY]   # 공급자 키 올리기 (Nano 터치 1회)
.\kv.ps1 list
.\lab\snapshot.ps1 [-Force] [-Verify]                               # 스냅샷 (도구 버전 올릴 때만, 이름 버전도 올림 + state.ts LAB_DEFAULT)
```

- **수업 중에는 배포하지 않는다.** 배포하면 DO 와 WebSocket 이 한 번 끊겨 참가자 VS Code 가 재연결하고, 진행 중인 화면 공유도 끊길 수 있다. 수업 사이에.
- 새 Worker secret 이 필요한 기능은 사용자가 `wrangler secret put` 한다 (예: `REALTIME_APP_TOKEN` 은 이미 있음). PowerShell 에서 비밀을 환경변수로 넣을 때:
  ```powershell
  $v = Read-Host 'App Secret' -MaskInput
  [Environment]::SetEnvironmentVariable('REALTIME_APP_TOKEN', $v, 'User'); Remove-Variable v
  ```
  (바깥에서 `pwsh -Command "..."` 로 감싸면 `$v` 가 먼저 풀려 ParserError 가 난다 — 직접 두 줄 실행)
- 공급자 추가: /admin "직접 입력" 또는 `providers.ts` 프리셋 추가 후 배포. LangSmith 서비스 키는 올릴 때 workspace 가 하나면 `X-Tenant-Id` 고정 헤더를 자동으로 붙인다(여러 개면 경고 → /admin 의 "헤더" 버튼으로 직접).
- 수업 운영: /lab → 인원·시간(1~8h)·자리당 $ 한도·사양(1c2g/2c4g/4c8g)·자료(GitHub/ZIP/드라이브)·클립보드 방향·나눠 줄 공급자 → 만들기 → "화면에 크게"로 QR. 끝나면 "지금 끝내기" (안 눌러도 끝 시각에 자동 삭제). 참여자 화면 벽과 동의 기반 탭 지원의 사용·한계는 `docs/lab-live-support.md`.
- 비용 감: Daytona 는 켜져 있는 시간만큼(수업 시간), OpenRouter 는 자리당 한도 안, Realtime 은 거의 무료 구간.

---

## 6. 테스트

| 명령 | 무엇 | 필요 |
|---|---|---|
| `pwsh tools/test-locked.ps1` | lab-e2e **237** (가짜 Daytona·가짜 code-server·가짜 SFU + 진짜 OpenRouter 서브키) | `OPENROUTER_MANAGEMENT_KEY` |
| `node test/core-security.mjs` | 보안 회귀 (로컬 workerd + fixture, 바깥 호출 막음): #2 목적지·#4 Daytona 관리 API·#6 세대·#7 자리 상한·#12 challenge·#13 세션 호출 상한(총·분당·동시) | 없음 |
| `pwsh tools/test-locked.ps1 -Test test/e2e.mjs` | 서버 전체 **82** (진짜 upstream 10곳) | 프리셋 키들 User env |
| `node test/vault-browser.mjs` / `node test/go-e2e.mjs` | 금고 화면 14 / 빌린 PC 자동 로그인 24 (각각 `run-dev.ps1 -Fresh` 서버에서) | Edge |
| `pwsh tools/test-locked.ps1 -Test tools/rtc-browser.mjs` | 화면 공유 **진짜 SFU** 25 (학생 2 + 강사 보기 탭, 멈춤/재시작/새로고침, 지연·해상도) | `REALTIME_APP_TOKEN` |
| `pwsh tools/realdev.ps1 -Test tools/real-screen.mjs` | **진짜 Daytona 2자리** + 진짜 SFU + 진짜 code-server 27: 보기 창·버튼 겹침·받은 코드 → 편집기/터미널·복사 막힌 수업·멈춤·CSP | `DAYTONA_API_KEY` 등. 샌드박스 비용 몇 분치, 끝에서 정리 |

- 브라우저 점검은 `playwright-core` + 설치된 **Edge**(headless). 스크린샷은 `%TEMP%\gw-shinick-real-*.png`.
- `tools/real-screen.mjs` 는 2026-09-30 에 scratchpad 에서 27/27 통과한 뒤 저장소로 옮겼다. 옮긴 뒤 한 번 돌렸을 때 Daytona 가 자리를 못 만들어(`/__lab/wake` 503) 끝까지 못 봤다 — 11절 참고. `rtc-browser.mjs` 는 옮긴 뒤 25/25.
- 테스트가 운영 수업의 샌드박스를 건드리지 않게: 진짜 점검은 자기 수업을 새로 만들고 끝에서 끝낸다. **운영 샌드박스에 exec 하지 않는다.**
- 세 가지를 병렬로 개발할 때 썼던 방식: 원본을 scratchpad 로 복사해 작업자마다 한 벌씩 → 끝나면 base 기준 3-way merge(`git merge-file`, CRLF 파일은 LF 로 맞춰 합치고 되돌림) → 전체 테스트 → 원본에 반영. 이제는 git 브랜치로 하면 된다.

---

## 7. 작업 규칙 (다음 AI 작업자 포함)

- 운영 배포·`wrangler secret put`·Worker 삭제는 **사용자만**. 필요하면 명령을 알려 준다.
- 키·토큰·App Secret·미리보기 토큰·wrangler OAuth 토큰 값을 출력·파일·로그에 남기지 않는다. `~/.secrets` 안의 값은 읽지 않는다. `auth.json` 같은 자격 증명 파일에서 값을 꺼내지 않는다.
- OpenRouter 관리 키·Daytona 키를 샌드박스나 참가자 응답에 넣지 않는다.
- GitHub: 푸시는 사용자 확인 후. Actions 는 쓰지 않는다(꺼져 있고 사용 시간도 없음). 커밋 전 gitleaks 훅이 비밀값을 검사한다(`.git/hooks/pre-commit` — 새로 clone 하면 다시 깔아야 함, 7절 아래).
- 수업 중인 샌드박스에 들어가거나 바꾸지 않는다. 지우는 것(샌드박스·서브키·스냅샷)은 사용자 확인 후.
- `~/source` 에 새 최상위 폴더를 만들 때는 사용자 승인. 임시 파일은 scratchpad, 지울 것은 `_trash` 로.
- 브라우저 작업은 Aside 가 기본, 자동 테스트는 Playwright(`playwright-core` + Edge).
- `ai-study` Worker 는 지우지 않는다 (예전 것, 사용자 소유).

gitleaks 훅 다시 깔기 (clone 한 PC):
```sh
printf '#!/bin/sh\nexec gitleaks git . --pre-commit --staged --redact --no-banner\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```
(`.gitleaksignore` 의 한 줄은 테스트의 RFC 6455 예시 nonce — 비밀 아님)

---

## 8. 최근 변경 (2026-09-29 ~ 30)

- 09-29: 중개 서버·금고·보안 키 등록, 공급자를 DO 암호화 저장으로 이전(`MASTER_KEY`), 공부방 1차.
- 09-30:
  - 참가자 상태를 DO 저장(`pres:<code>`)으로 — DO 가 쉬다 다시 뜨면 메모리가 날아가 "입장 전"으로 보이던 문제.
  - LangSmith 프리셋 + 공급자 **고정 헤더**(`headers`, `x-` 로 시작, 최대 4개) + 서비스 키 `X-Tenant-Id` 자동 찾기. (서비스 키로 `/api/v1/sessions` 가 403 이던 원인이 tenant 헤더였음)
  - `kv.ps1 -Sources` (Set-Keys 와 연동).
  - 공부방 **📤 코드 보내기 / 📥 받은 코드**, **강사 화면 보기 창**, **강사 화면 공유(Realtime SFU)**. OCR(화면 글자 긁기)은 만들었다가 사용자 요청으로 뺐다 (그때 고른 모델 `google/gemini-3.1-flash-lite` — 다시 할 때 참고).
  - GitHub 비공개 저장소, `.gitattributes`, gitleaks, `tools/`, 이 문서.

- 10-01 보안: Daytona 조직·계정 관리 API(`organizations`·`api-keys`·`users`·`audit/organizations`·`webhooks/organizations`, 최종 경로 전체로 판단)는 승인 때 따로 켠 토큰만 (기본 꺼짐, 공급자 세대에 묶임). 세션마다 총 10,000 · 분당 300 · 동시 10 호출 상한 (기본=최대, 낮추기만) — `test/core-security.mjs --only=4,13`.
  - 동시 자리 lease 는 15분, 프록시가 fetch·응답 본문 동안 5분마다 늘린다 (15분 넘는 스트림도 자리 유지, Worker 가 죽으면 15분 뒤 회수). 테스트는 fixture 로 수명을 2초로 줄여 본다.
  - 로컬 wrangler dev 는 받는 쪽이 끊어도 Worker 응답 스트림을 취소하지 않는다 (운영 Cloudflare 는 넘긴다). 테스트는 소켓 끊김 항목을 SKIP 으로 적고, 같은 cancel 길은 fixture `/__fxw/cancel` 이 진짜 프록시 응답 본문을 cancel 해서 확인한다.
  - `test/e2e.mjs`(진짜 공급자)의 Daytona 확인은 `sandbox` 200 + `api-keys/current` 403 으로 바꿨다 (이번에는 돌리지 않음).

---

## 9. 알려진 한계·주의

| 항목 | 내용 |
|---|---|
| 첫 입장이 느림 | VS Code 웹 파일(수십 MB)을 **브라우저마다 처음에 미국 Daytona 에서** 받는다 (흰 화면 + 탭 스피너). 두 번째부터 캐시로 몇 초. 샌드박스를 미리 켜 둬도 브라우저 쪽은 못 데운다 → 백로그 3 |
| 관리 버튼 느림 | 버튼 → `/api/lab/list` 전체 다시 불러오기. Daytona 목록(~0.5s)·조직 한도(~0.5s)·OpenRouter 사용액(~0.8s, 30초 캐시)을 **순서대로** 부름 → 2~3초 → 백로그 2 |
| 관리 로그인 8시간 | 관리 토큰은 페이지 메모리에만 둔다. 보안 키 확인 후 8시간, 새로고침하면 다시 확인한다. 모임 화면은 별도 8시간 쿠키로 유지한다 |
| 화면 공유 | STUN 만(TURN 없음) — UDP 막힌 망에서는 영상이 안 올 수 있음. 학생 쪽 10초 간격 확인이라 뜨기까지 최대 ~10초. 강사는 /lab 탭을 열어 둬야 함(Chrome/Edge). Document PiP 는 headless 에서 실제 창까지는 확인 못 함 |
| 참여자 화면이 약 10분 뒤 안 보임 | 원인 미확정. 관리 10분이 끝나면 수업 카드의 관리 버튼(카드 안의 🖥 화면 공유 시작 포함)은 읽기 전용 모니터로 걷힌다. 모임 화면 벽은 별도 고정 8시간 쿠키다. SFU 가 10분에 끊긴다고 보지 말 것. 13절 · `docs/lab-live-support.md` |
| 클립보드 경계 | 소프트 경계 (개발자 도구·확장·화면 캡처·손으로 치기는 못 막음) |
| 자리 이름 가로채기 | 같은 이름으로 들어오면 원래 자리로 보내는 규칙 때문에, 남의 이름을 알면 그 자리에 들어갈 수 있다. 사용자가 "굳이 안 고쳐도 됨"으로 결정 |
| 에이전트가 사양을 잘못 말함 | 컨테이너 안 `free`·`nproc` 는 호스트 전체 숫자. 실제 상한은 cgroup → 백로그 5 |
| 성능 격리 | 메모리·CPU 는 자리마다 상한(넘으면 그 자리만 OOM). 디스크 IO·네트워크는 같은 호스트와 나눠 씀 |
| Daytona 리전 | us/eu 뿐 → 한국에서 지연 |
| 운영 데이터 백업 없음 | DO 의 수업·공급자(암호화)·금고 항목은 따로 백업이 없다. 소스만 GitHub |

---

## 10. 문제 해결 기록

- **참가자 상태가 다 "입장 전"으로 돌아감** → DO 가 쉬다 다시 떠 메모리가 사라짐. `pres:<code>` 저장으로 해결.
- **LangSmith 403** → 서비스 키는 `X-Tenant-Id` 필요. 고정 헤더로 해결 (키 권한 문제가 아니었음).
- **다른 PC 에서 흰 화면 + 탭 스피너** → 첫 로드 파일 다운로드(9절). 새로고침 뒤엔 정상. 서버 쪽 오류 없음 확인.
- **`/__lab/wake` 503 "이 자리는 준비에 실패했습니다"** → 수업 만들 때 그 자리 샌드박스를 못 만듦 (스냅샷 없음·Daytona 한도·키 문제). 강사 표의 자리 오류 문구를 본다.
- **운영 로그 보기**: `npx wrangler tail gw-shinick --format json` — 요청 헤더(쿠키 포함)가 나오니 URL·상태·시간만 걸러서 본다. 사용자 에이전트에서 Edge 는 `Edg/` 가 `Chrome/` 뒤에 있으니 그대로 찾을 것.
- **`sessions/new` (SFU)** 는 본문 없이 POST 해야 201 (본문 `{}` 면 400, 토큰 틀리면 401).

---

## 11. 지금 확인이 필요한 것 (2026-09-30 19:50 KST)

- PC 의 `DAYTONA_API_KEY` 로 Daytona 를 보면 **샌드박스 목록이 비어 있고 `gw-lab-v4-*` 스냅샷도 404** 다. 18:4x 에는 같은 키로 수업 `jzljh15v` 의 3자리와 스냅샷이 보였다. 그 사이 수업을 끝냈거나, 스냅샷을 지웠거나, 키/조직이 바뀐 것 중 하나로 보인다 — 사용자 확인 필요.
  - 스냅샷이 정말 없으면 **새 수업을 만들 수 없다** → `.\lab\snapshot.ps1` 로 다시 빌드 (운영 서버의 Daytona 키가 가리키는 조직과 같은 조직인지도 확인).
- 첫 테스트 때 만든 $1 OpenRouter 서브키 하나가 남아 있으면 사용자가 지운다.
- 예전 스냅샷 v1~v3 정리는 사용자 결정.
- GitHub org 설정: Member privileges 에서 저장소 만들기·private fork·공개 전환·삭제를 소유자만으로 (사람을 들이기 전에).

---

## 12. 다음 작업 (사용자와 합의됨, 아직 구현 안 함)

1. **수업 관리 로그인 유지** — `/lab` 전용 로그인 쿠키(HttpOnly, SameSite=Strict, 경로 제한), **30분 안 쓰면 만료·쓰는 동안 연장·최대 12시간**, 권한은 수업 관리만(/admin 공급자·금고는 지금처럼 매번 키). **수업 만들기·지금 끝내기는 YubiKey 한 번 더 터치**. 로그아웃 버튼.
2. **관리 버튼 속도** — 버튼은 결과만 받아 그 부분만 갱신(전체 새로고침은 뒤에서), `labList` 의 Daytona 두 번·OpenRouter 를 동시에, Daytona 상태 10~15초 캐시.
3. **VS Code 파일 Cloudflare 캐시 + 자동 데우기** — `/stable-<hash>/static/…` 처럼 버전이 들어간 정적 파일을 Worker Cache API 에 저장(자리 공용), 강사가 /lab 을 열면 미리 채움. 캐시는 데이터센터마다 따로라 강사·학생이 같은 나라일 때 효과. 헤더·쿠키가 섞이지 않게 주의(응답에 자리 정보 없음 확인).
4. **영상 연결을 VS Code 가 다 뜬 뒤에** (`.monaco-workbench` 뒤 몇 초) — 첫 입장 대역 겹침 줄이기. 원하면 확인 간격 단축.
5. **자원 표시** — 샌드박스 안 에이전트 안내(`CLAUDE.md`/`AGENTS.md`)에 "자원은 cgroup 기준" 추가, `lab-status` 에 내 CPU·메모리 상한/사용량. 스냅샷 새 버전 또는 `lab-start`. 먼저 테스트 수업으로 격리(메모리 초과 시 그 자리만 OOM, 옆자리 지연) 실측.
6. (선택) **암호화 백업** — `age` + `age-plugin-yubikey`(Nano·NFC 둘 다 수신자) + 종이 복구 키로 소스(와 나중에 DO 내보내기) 백업 파일.
7. (선택) TURN, 운영 데이터(DO) 내보내기 백업.

작업은 브랜치(예: `lab-session`)에서 하고, 테스트 통과 → 사용자 확인 → `main` 에 합치고 푸시 → 수업 없는 시간에 사용자가 배포.

---

## 13. 참여자 화면 벽과 동의 기반 탭 지원 (현재 코드)

배포 이력은 0절, 사용 순서는 `docs/lab-live-support.md`다. 배포 스크립트와 기본 배포 권한 원칙은 바꾸지 않았다. 코드와 그 문서가 다르면 코드가 맞다.

`v2026.10.16.1` 배포는 코드 업로드 뒤 라우트 갱신 API에서 권한 오류가 났다. 기존 관리·입장·와일드카드 자리 주소에서 새 코드를 확인한 뒤 코드 버전 배포를 완료했다. `v2026.10.16.2`는 `wrangler versions upload --env=` 후 `wrangler versions deploy <위 버전>@100% --env=`로 오류 없이 적용했다. 기본 `deploy.ps1 -CodeOnly`의 라우트 갱신 오류는 별도 운영 과제다.

`v2026.10.16.3`도 versions upload/deploy로 100% 적용했다. Aside의 `/lab` 새로고침 뒤 자동 미리보기 코드와 진행 중 모임 없음(읽기 전용)을 확인했다. 운영 자리 호스트의 `dom-capture.js`, `dom-capture-prelude.js`, `live.js`가 각각 커밋된 문자열과 정확히 같고 no-store이며, 무인증 `/__lab/live/state`는 401임을 확인했다. 참여자 모임을 새로 만들거나 기존 실습실을 변경하지 않았다. PWA는 별도 설치 바이너리가 없으므로 모임지기·참여자 화면을 새로고침해 새 코드를 받는다.

작업자 기본 실행은 `AGENTS.md`를 따른다. Grok CLI `grok-4.7-build-fast` + reasoning high로 이번 관리 수명 변경을 구현했다. StackBite의 Grok 좌석 실행은 실패하여 분리된 작업 폴더에서 네이티브 CLI를 직접 실행했다. Cursor로 대체하지 않았다. 최종 타입 검사·관리/모니터 144·모임지기 UI 98·로그아웃 25·보안 949개 단언이 통과했고, 보안 환경 스킵 2건은 확인되지 않은 항목으로 남긴다.

방향이 둘이다.

자동 미리보기 초안은 네이티브 Grok CLI `grok-4.7-build-fast` / high의 분리 브랜치 후보 `da38fdf`에서 가져와 통합했다. 조율·검수 중 원본 비밀번호를 잠시 바꾸던 방식을 복사본 마스킹으로 교체했고, 투명 배경의 검은 영상과 이전 프레임 잔상을 방지했다. 마지막 캡처의 뷰포트·15초 신선도를 확인해 크기가 맞지 않거나 오래된 화면에서 제어하지 않는다. 타입·생성물 검사, DOM/GPU 캡처 31개, 합성 영상/실제 Cloudflare SFU 각각 14개, 모임지기 UI 98개, 실습실 보안 289개 및 live 서비스·HTTP 검사가 통과했다. 실제 모임 전체 부하와 두 PC 실사용은 별도 확인 대상이다. 캡처의 자동 갱신은 다시 `open()`하는 대신 같은 스트림에서 글자 변경·리사이즈로 확인했다.

- **모임지기 → 참여자** (8절에 있던 강사 화면 공유): `/lab` 의 **🖥 화면 공유 시작**. 저장은 `scr:<labId>`. 참여자 VS Code 의 보기 창이 받는다. 소리 없음.
- **참여자 → 모임지기**: 실습실 입장 시 현재 편집기·터미널 DOM을 캔버스 영상으로 자동 송출한다. 공유 버튼·브라우저 화면 선택 창이 없고, 입장 안내와 막대의 자동 공유 표시를 제공한다. 모임지기 `/lab` 의 **모임 화면**(`#liveTools`)에 자리 벽으로 모은다. 기본 약 3초 간격이며 느린 기기·배경 탭에서는 늦어질 수 있다. 개인 데스크톱·다른 탭·소리는 포함하지 않고 호스트에 DOM이나 스크립트를 보내지 않는다. 저장은 `live-source:` · `live-control:` · `live-media:` 라 위 공유와 키가 겹치지 않는다. SFU 세션을 만들고 지우는 구현은 `src/lab-screen-service.ts` 를 같이 쓴다.

관리·모임 화면·읽기 전용 모니터는 서로 다른 세션이다. 보안 키 로그인이 같은 탭에서 각각 연다.

| 이름 | 수명 | 하는 일 |
|---|---|---|
| 관리 토큰 | 페이지 메모리, 로그인부터 최대 8시간 | 수업 만들기·초대·끝내기 등. 만료하면 관리 버튼을 닫는다. 사용자가 2026-10-16에 기존 10분 정책을 8시간으로 변경 |
| 모임 화면 쿠키 `__Host-lab_live` | `live-auth:` 네임스페이스, 처음 연 시각부터 고정 8시간. 다시 확인해도 늘지 않음 | 참여자 화면 받기, 모임지기가 참여자에게 보내는 🖥 공유(벽이 열려 있을 때), 참여자가 허용한 탭 제어. 모니터·조교 권한으로는 이 일을 열 수 없음 |
| 모니터 쿠키 | 별도 8시간, 읽기 전용 | 손 들기·자리 상태. 화면 제어 권한이 아님 |

화면 세션은 키를 탭한 직후의 관리 토큰으로만 만든다. 8시간이 지난 쿠키로 다시 만들려고 하면 거절하고 그 쿠키를 지운다. 그다음 키 탭이 새 8시간을 연다.

참여자 공유는 모임 종료·만료(`screenClear` 가 `live` 와 기존 `scr` 를 같이 지움), 탭 `pagehide` 에서 끝난다. 모임지기 로그아웃은 벽과 그 주인의 받기·제어 기록을 닫는다. 자동 송출 실패는 간격을 늘려 재시도하고, 다른 탭이 같은 자리를 송출하면 현재 탭은 양보한다. 참여자가 다시 앞으로 연 탭이 연결을 재시도한다. 그 탭이 상태를 더 이상 보내지 않으면 서버는 2분 뒤 그 공유를 오래됨으로 본다. 10분 타임아웃으로 적어 둔 경로는 없다.

제어는 현재 공유 탭과 그 게시 세대(`source.v`)·샌드박스 id 에 묶인다. 이 탭이 생성한 캡처 객체·영상 트랙을 확인하며 참여자의 실제 허용 클릭이 있어야 입력을 적용한다. 허용 시각부터 최대 5분(`CONTROL_TTL`)이며 화면 세션·모임 끝보다 길지 않다. 거절·철회·만료·어느 쪽의 종료는 대기 입력을 비우고 새 입력을 거절한다. 영상 송출 기록은 그때 지우지 않는다. 공유를 다시 시작하면 이전 제어는 지운다. 브라우저나 운영체제의 권한 창을 원격으로 누르는 기능은 없다.

관련 파일: `src/lablive.ts`(벽·참여자 막대), `src/lab-live-api.ts`, `src/lab-live-service.ts`, `src/lab-screen-service.ts`, `src/pages.ts` 의 입장 안내와 `/lab` 로그인·로그아웃, `src/labhost.ts` 의 `/__lab/live/*` 및 캡처 스크립트 주입. 자동 영상은 `client/lab-dom-capture.ts`에서 생성하고 `tools/build-lab-dom-capture.mjs`로 `src/lab-dom-capture.generated.ts`를 만든다. 번들은 같은 출처에서 제공하며 앱 초기화 전 WebGL 보존 설정을 적용한다. CSP·Trusted Types 제한은 해제하지 않는다. 3절 파일 지도의 줄 수는 작성 당시 기준이라 여기서 고치지 않는다.

### 파일 올리기 발견성 (2026-10-16)

참여자 막대의 **파일 올리기 안내**에서 code-server의 `work` 폴더 → `Upload…` 메뉴, 파일 끌어다 놓기, 실제 목록·내용 확인과 OpenCode 요청 예시를 안내한다. 안내는 편집기를 막지 않는 영역이며 닫기·Escape·막대 접기를 지원한다. 별도 업로드 API나 업로드 성공 추정은 추가하지 않았다. Word·Excel·PDF의 업로드와 AI 읽기를 구분하고, 결과 내려받기와 로컬 열기를 안내한다. 자세한 참여자 안내는 `docs/lab-file-upload.md`에 있다.

타입·생성물 검사, 막대 복구 55개, 기존 파일 UI 9개를 통과했다. Aside의 실제 막대 코드 미리보기에서 1440px/390px 배치, 가로 넘침 없음, 편집 유지·닫기 초점·Escape·접기를 확인했다. 편집기 배경은 모형이며 실제 참여자 자리에서 파일 전송을 새로 재현한 검증은 아니다. Worker 배포 후 실습실 페이지를 새로고침하면 버튼이 반영된다. `lab/files/README.md`의 설명은 새 스냅샷 제작 시에만 들어간다.

### 모임 밖 복습·모임 자리 추가 요청 (2026-10-16)

참여자 `/lab/request`, 모임지기 `/lab/requests`와 `/api/lab/open/*`를 추가했다. 요청은 비밀값의 해시·출처 해시와 함께 보관하며 대기 24시간/기록 48시간이다. 클라이언트가 만든 고정 UUID·확인 비밀로 응답 유실을 복구한다. 목록은 승인 대기를 우선해 최대 128건 표시하며 처리 기록에 묻히지 않는다. 요청함 열기는 8시간 관리 토큰, 개설은 선택 조건에 묶인 별도 WebAuthn 서명으로 확인한다. 서명만 재전송하거나 미승인 요청의 결과 확인으로 생성할 수 없다.

개인 복습은 표준 스냅샷 1c2g와 선택 시간·AI 한도를 사용하고 기존 기본 설정을 바꾸지 않는다. 모임 추가는 기존 만들기 방벽에 parentLabId·parentVersion·openRequestId를 묶어 새 자리만 원자적으로 예약한다. 기존 자리·종료 시각·정책을 유지하고 생성 결과를 모르는 작업은 새 ID로 재실행하지 않는다. 원래 수업 터미널 선택 대상은 자동 변경하지 않는다. 초대 코드 반환 전 실제 모임·자리·종료 상태를 재확인한다.

개설 요청 알림은 `labopen:pushsub:`의 별도 기기 등록이다. endpoint·구독 키는 MASTER_KEY로 봉인하고, 등록된 보안 키가 여전히 존재하는지 보낸 직전에 확인한다. 관리 토큰이 만료돼도 이 알림 등록은 남으며 승인 권한은 없다. 기존 TEACHER_PUSH_VAPID_JWK를 재사용하되 기존 손들기 세션/구독은 바꾸지 않는다. 기기별 영속 작업·임차·백오프·미처리 재안내가 있으며 Web Push 서비스 보관 시간은 개설 알림 1시간, 기존 손들기 기본값 60초다. 서비스 워커는 고정 tag만 구분해 일반 문구를 표시하고 `/lab/requests` 또는 `/lab` 고정 경로로만 이동한다. OS 표시 여부는 자동 추정하지 않는다.

검증: 타입·생성물 검사, 요청 서비스 16개, 알림 서비스 16개, 실제 State/WebAuthn 서명 통합 25개, API 12개, 390/1280px UI 18개, PWA/서비스 워커 41개, Web Push 암호·전송 57개, 기존 만들기 방벽 24개 및 실습실 회귀 289개 통과. Aside에서는 가상 요청 배경을 명시한 실제 UI를 데스크톱/390px에서 확인했다. 실제 휴대폰 설치·NFC·잠금 화면 표시와 운영 과금 공급자 응답은 별도 실물 확인 대상이다. 설치·시험 절차는 `docs/lab-on-demand.md`에 있다.

### 2026-10-16 모아보기 배포 확인 보완

v2026.10.16.11은 12:26에 Worker100% 배포와 정적 JS 반영이 확인됐지만 State 응답에 quality 필드가 없고 새 RPC가 HTML500을 반환했다. 30초 유예 후 즉시 교체 지정으로 다시 배포해도 바로 일치하지 않았으며, 12:32에 새 상태 필드와 quality API200을 확인했다. 짧은 유예·immediate 옵션이나 배포 성공 메시지만으로 상태 서버 반영을 단정하지 않는다. [Cloudflare의 코드 전파 설명](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#code-updates)에 따라, 실제 새 응답을 확인한 뒤 완료 처리한다. 검증은 독립 viewerTab의 focus:null만 사용해 기존 선택과 실습실을 변경하지 않았다.
