# Cloudbite 개인 컴퓨터 — 운영·재개 가이드

휴대폰에서 여는 개인 클라우드 리눅스 컴퓨터. 사용자 로컬 PC는 런타임 서버가 아니다.

- 공개 주소: `https://cloudbite.shinick.dev/cloudbite/computer?lang=ko`
- 구성: Cloudflare Workers + Durable Objects(메인 `cloudbite-v001`) + 영속 Daytona Linux 샌드박스(4 vCPU / 8 GiB / 10 GiB, region `us`)
- 데스크톱 게이트웨이: `https://cloudbite-desktop.ai-gongbu.workers.dev` — 신뢰하지 않는 전용 게이트웨이. WebAuthn·금고 권한 없음.
- 소스: `src/cloudbite-computer-*.ts`, `src/cloudbite-desktop-gateway.ts`, `client/cloudbite-computer.{ts,css}`, `tools/build-cloudbite-computer.mjs`

## 1. 휴대폰 빠른 사용

1. **최초 1회 페어링**: 1회용·30분 페어링 링크를 연다. 링크의 fragment는 fetch 전에 주소창에서 지워진다. 페어링 링크는 Cloudflare 배포 권한으로만 발급되며 공개 HTTP 발급 경로는 없다. 링크·토큰·쿠키는 문서·로그·채팅에 남기지 않는다.
2. 페어링 세션은 24시간. 그 안에 **휴대폰 플랫폼 패스키**를 등록한다.
   - RP는 `cloudbite.shinick.dev`, 범위는 개인 컴퓨터 전용. 기존 owner/금고의 하드웨어 보안키 정책은 바뀌지 않는다.
3. 이후 등록 패스키로 로그인 → 세션은 롤링 400일, 명시적 로그아웃 시 종료. 자기 자격증명을 폐기하면 그 자격증명의 세션이 모두 끝난다.
4. 시작 → 데스크톱(1920x1080) 화면과 원격 키보드로 사용.

## 2. 도구 인증

준비된 스냅샷 `cloudbite-computer-989b229ebe47`에 설치된 버전(존재 확인 기준):

| 도구 | 버전 |
|---|---|
| Claude Code | 2.1.302 |
| Codex | 0.163.0 |
| Cursor Agent | 2026.10.16-e3cb207 |
| Antigravity CLI (`agy`) | 1.4.2 |
| OpenCode | 1.19.3 |
| Chromium / Node | 155 / 22.20.0 |

- 각 도구는 사용자가 **프로필 안에서 공식 구독/API 로그인을 한 번** 한다. "이미 로그인됨" 상태로 제공되지 않는다.
- 웹 런처: Grok, Genspark, Lovable, Tavily, ElevenLabs, Nebius Token Factory, `k.shinick.dev/borrow/vault`. IDE 중심 흐름은 없다.
- 새 base image 앱만 포함. owner 파일시스템/프로필은 정지 후에도 유지된다.

## 3. 정지 · 연장 · 스냅샷

- **Stop**: 디스크는 유지(스토리지 과금 계속). RAM 상태는 보존되지 않는다.
- 과금 마감: Durable Object 기준 2시간 + 명시적 **Extend**. Extend 시 last-activity 갱신. 공급자 측 130분 idle backstop.
- **Snapshot**: 먼저 정지한 뒤 생성(RAM 미포함). 같은 이름은 409로 거부. 확인되지 않은 결과는 `unconfirmed`로 표시한다.
- private cold snapshot에는 OAuth 자격증명이 들어 있을 수 있다 → **절대 공개하지 않는다.**
- 실측 n=1: private snapshot 복원 9.282초(파일·0600 유지), 중지된 데스크톱 재개 ready까지 11.469초. 5초 목표 미달.

## 4. 중첩 CPU/GPU 작업 (`cloudbite-compute`)

화면의 *Install CPU/GPU CLI* 버튼이 설치한다:
- `~/.config/cloudbite/compute.json` (0600, 2시간 범위 capability)
- `~/.local/bin/cloudbite-compute` (0700)
- 원본 공급자 키는 Worker에만 있다. 샌드박스에는 들어가지 않는다.

```sh
cloudbite-compute doctor
cloudbite-compute jobs
cloudbite-compute run --provider daytona --timeout 60 -- python3 -c "print(123456789)"
cloudbite-compute run --provider nosana --timeout 60 --no-wait -- nvidia-smi
```

- 기본 동작은 결과 대기. `--wait` 플래그는 없고, 대기하지 않으려면 `--no-wait`.
- 제한(`src/cloudbite-computer-nested.ts`): 동시 활성 2개, timeout 10–600초(API 기본 300), CPU는 2 vCPU / 4 GiB / 8 GiB 임시 샌드박스.
- Nosana: 기본 RTX 4090 마켓. 결과는 인증된 공급자 job 상세 → 고정 IPFS reader로 수집한다. 공개 콜백 비밀은 쓰지 않는다. job 정의는 공개되므로 **명령에 API 키를 넣지 않는다.**
- 키 분리: 배포 API용 `CLOUDBITE_COMPUTER_NOSANA_API_KEY`(신규, 전용) ↔ 추론용 `CLOUDBITE_NOSANA_API_KEY`(기존, 변경 없음).
- 요청 헤더 `User-Agent: CloudBiteCompute/1.0` 필수(urllib 기본 UA는 403/1010).
- 계정 키 primary/secondary/tertiary는 명시 선택, 자동 fallback 없음. 준비 스냅샷은 primary에만 있다.

## 5. 배포 · 테스트

- 메인: `wrangler.cloudbite.jsonc` → `cloudbite-v001` 하나뿐. 게이트웨이: `wrangler.cloudbite-desktop.jsonc` (service binding, 경로 prefix 전용).
- DO 마이그레이션: v4 = Computer + Nested, v5 = ComputerAccess, v6 = ComputerInput.
- 게이트웨이는 `CANONICAL_ONLY=1` 필요. 기존 workers.dev/api의 GET/POST는 410 → 같은 사이트 형제 쿠키 권한 차단(회귀 테스트 10건).
- 원본 `gw-shinick` / `k` / lab은 수정·배포하지 않는다.
- **통합 브랜치 `integration/unified-release`가 배포 기준이다.** 개인 컴퓨터 release(`0e05c51`)와 main의 decision workflow(`29f925f`: decision frame, TXT/MD/CSV/JSON 근거 업로드, 800건 claim ledger, Nosana cross-review, 전체 Jev routing 입력, 252KiB runner budget)는 공통 조상 `e09a009`에서 갈라졌고, 이 브랜치에서 둘을 병합했다. 예전 문서가 말한 "main이 누락 모듈 `cloudbite-decision`을 import한다"는 문제는 더 이상 사실이 아니다(모듈은 main에 커밋돼 있다). main에 있던 v4 시점 개인 컴퓨터 스냅샷은 release의 최신 개인 컴퓨터 소스로 대체됐고, v4/v5/v6 마이그레이션과 네 개의 컴퓨터 DO 바인딩을 모두 유지한다. 분리된 release worktree만 따로 배포하면 decision workflow가 빠지므로 그렇게 하지 않는다.

```sh
npm run check
node test/cloudbite-computer-access.mjs
node test/cloudbite-computer-api.mjs
node test/cloudbite-computer-service.mjs
node test/cloudbite-computer-nested.mjs
node test/cloudbite-computer-nosana-results.mjs
node test/cloudbite-computer-daytona.mjs
node test/cloudbite-computer-tools.mjs
node test/cloudbite-computer-ui.mjs
```

`AUTH_HASH`·원본 비밀값·페어링 URL은 문서·로그에 쓰지 않는다. 비밀값은 값을 출력하지 않고 설치한다.

## 6. 재개 근거와 남은 한계

검증된 것:
- 운영 환경 소프트웨어 CTAP2 QA: 일회용 자격증명 등록 → 로그아웃 → 로그인 → 폐기. (사람 생체인증 증명은 아님)
- 공개 GUI 영상 1024x768 + 원격 키보드 + bash 파일 증명 성공: `.artifacts/cloudpc-mobile/public-desktop-frame.png`. 390px 모바일 뷰는 Aside가 viewport를 지원하지 않아 격리 headless로 대체 확인.
- Daytona CPU 중첩 작업: stdout `123456789`, 35.813초, 정리 완료.
- HTTP owner tag 버그(State.sha base64 vs hex) 수정: `computerOwnerTag()`가 실제 hex(`543bd0888b7460ae3b30d32a`)를 쓰고 테스트가 정확히 일치.

미완료 / 주의:
- owner tag 수정 뒤 운영 모바일 QA 통과: running/ready, 4 CPU, 공개 nested 설치, 로그아웃/재로그인/폐기 확인.
- **GPU 실행 미증명**: 첫 Nosana 요청은 접수됐으나 job이 배정되지 않았고(`GET jobs` = `[]`) timeout. 소유 배포 정지·삭제 완료, 공급자 목록에 해당 자원 없음. VRAM 임대를 주장하지 않는다.
- Windows Tier 2는 금지·미구현, macOS 미구현, RAM/VRAM 풀링 없음.
- 휴대폰은 소스가 서빙하는 페이지를 쓰며 로컬 8898 프로토타입이 필요 없다. 옛 Python 오프라인/local-first 흐름은 이번 단계에서 모든 공개 흐름으로 이식되지 않았다.

자원 보존·정리:
- 사용자 데이터 샌드박스 `1af294ee-b648-461c-a78a-039695413922` (`cloudbite-computer-primary-543bd0888b7460ae3b30d32a`) — **유지**.
- QA 샌드박스 d7a0 및 복원 clone 44fd 삭제 확인. 누락 CLI 구 이미지도 삭제.
- 임시 QA 컨트롤러 Worker `cloudbite-computer-qa-d5a322c6`(만료 20분)은 최종 페어링 발급 후 **삭제 완료**(공급자 GET 404/10007 확인).
- 사용자 머신 stopped 확인(데이터 보존). WorkBite T0067에 최종 검증 사실 기록.

## 7. 휴대폰 로컬 입력

데스크톱의 ‘로컬에서 입력’을 열어 휴대폰 키보드로 작성한 뒤 보내기 + Enter를 누른다. 원격에서 선택된 입력란이 대상이다. 초안은 휘발성 DOM에만 존재하며 전송 전에는 공급자 호출이 없다. 입력 요청 원문은 DO ledger에 저장하지 않는다. 불명확한 전송은 같은 requestId를 유지하며 자동 재입력하지 않는다. 24시간 4096건 제한.

실제 운영 390x844 모바일 QA에서 전송 전 TTY 초안 미노출, 한글·공백 명령 실행과 파일 내용 일치, 가로 넘침 없음 확인. 공급자 keyboard/type이 이모지를 누락함을 발견했다. 보조평면 Unicode는 서버에서 422로 거부하여 손상된 명령을 전송하지 않는다. 실제 휴대폰 OS 키보드/생체인증은 사용자 실사용 확인이 남는다.

## 8. 2026-10-19 화면·CLI 로그인 복구

### 후속: 실제 기본 터미널과 한글 입력 (2026-10-19)

앞선 bash -lc 검증은 실제 데스크톱의 기본 터미널을 대표하지 않았다. 사용자 재현 뒤 /proc의 환경 메타데이터만 확인해, 기존 xfce4-terminal 서버가 오래된 NVM-first PATH를 유지하고 /bin/sh를 실행하며 GTK 입력기 설정도 없음을 확인했다. 사용자 명령 기록·자격증명은 읽지 않았다.

- 기본 Terminal 실행은 새 프로세스로 시작하며 개인 bashrc 뒤에 공통 프로필을 적용한다. 패널/메뉴의 기본 Terminal도 이 경로를 쓴다. 기존 창과 실행 중인 프로그램을 강제 종료하지 않는다.
- 예전 터미널이 기억하는 NVM의 Claude/Codex/OpenCode 심볼릭 링크도 준비된 실행 파일로 연결한다. 원래 링크는 .cloudbite-base로 보존한다. 일반 파일은 덮어쓰지 않는다.
- IBus·ibus-hangul·GTK 모듈·Noto CJK 글꼴·한국어 UTF-8 로캘을 준비한다. 새 터미널은 IBus 환경을 받고, 한/영은 Shift+Space로 전환한다.
- 사용자 VM의 실제 GUI bash에서 Claude 2.1.302와 GTK_IM_MODULE=ibus를 확인했다. 영문 물리 키 입력 gksrmf dlqfur가 “한글 입력”으로 조합되어 파일에 정확히 저장됐다. gui-korean-terminal.png와 user-vm-native-input-proof.json이 근거다.
- 새 기본 이미지 cloudbite-computer-3d400ff85b2e도 새 VM에서 cold start와 stop/start 뒤 같은 GUI 검사를 통과했다. Shift+Space를 연속 사용해 gksrmf → 한글 → gksrmf 전환을 실제 검증했다. QA VM은 삭제했고 사용자의 기존 VM은 켜두었다.
- 실제 운영의 de6a7ea/8f059c5 계열을 기반으로 통합했다. 별도 운영의 raw REST env 수정과 결정·근거·교차검토 기능을 보존하며 npm run deploy 보호 경로로 배포한다.

갱신 기본 앱 이미지: cloudbite-computer-d2e6a902c06d (active). 현재 사용자 VM은 기존 파일·브라우저 프로필을 보존한 채 같은 시작 스크립트로 보정했다.

- 사용자 VM을 재생성하지 않고 1920×1080으로 보정했다. 구형 base의 Xvfb 시작 크기가 최대 1024×768이므로 환경변수/RandR만으로는 커지지 않았다. configure-display.py가 dpkg-divert로 원본 Xvfb를 보존하고 시작 인자의 화면 0 크기를 보정한다. --remove로 복구 가능. 새 생성 요청에도 공식 raw REST env.VNC_RESOLUTION을 전달한다.
- Selkies 수동 크기 1920×1080, 클라이언트 자동 크기 변경 잠금. 운영 영상 검증: 1440×900 브라우저에서 영상 1920×1080/CSS 1440×810, 390×844에서 영상 1920×1080/CSS 390×219.375. 양쪽 모두 16:9 유지.
- 실제 bash -lc는 base nvm의 Claude 2.1.19를 선택했다. 고정 도구 경로를 PATH 앞에 두고 중복을 제거하며 bashrc의 nvm 초기화 뒤에 적용한다. CLI/로그인 아이콘은 고정 경로를 직접 호출한다. 실제 선택 버전 Claude 2.1.302, Codex 0.163.0 확인.
- 브라우저가 기본 keyring을 만들라는 창에서 멈춰 localhost 콜백도 발송하지 않는 것을 화면으로 확인했다. 한 개인 세션 버스로 브라우저/CLI를 모으고, 기본 collection이 없을 때만 빈 비밀번호의 CloudBite Login을 준비한다. 개인 VM 파일시스템이 기존 정책과 같은 저장 경계다. 기존 다른 자격증명·보호 비밀번호는 읽거나 바꾸지 않는다. 재개 시 이 앱이 만든 collection만 빈 비밀번호로 잠금 해제한다.
- 사용자 VM의 DISPLAY가 없는 프로세스 → 브라우저 → VM의 127.0.0.1 콜백 실제 수신 확인. 세 CLI의 공식 로그인 시작은 승인 대기까지 확인했으며 사용자 계정 OAuth 성공을 대신 주장하지 않는다.
- Linux에서 로그인 테스트 21/21, 설치 테스트 16/16, keyring 경계/재사용 테스트 통과. 별도 QA VM에서 cold start와 stop/start 모두 1920×1080, keyring started 확인 후 QA 삭제.
- 데스크톱 교체 중 종료 완료 전에 기존 HTTP health를 정상으로 오인한 갱신 스크립트 경합 때문에 한 차례 502가 발생했다. 종료 대기 후 새 시작으로 검증 절차를 고쳤으며, 복구 뒤 운영 영상 해상도를 다시 검증했다.

사용: Sign in: Claude Code, Sign in: Codex, Sign in: Cursor Agent. Codex 브라우저 콜백이 불가능하면 Sign in: Codex (device code)를 사용한다. 기기 코드 로그인은 ChatGPT 보안 설정에서 허용해야 한다. 각 터미널은 오류·종료 코드를 남긴다. 물리 보안키가 꽂혀 있다는 사실은 로그인 상태가 아니며, 이미 발급된 브라우저 세션은 명시적 로그아웃까지 유지한다. 인증된 기기들은 같은 소유자의 동일한 VM을 사용한다.
