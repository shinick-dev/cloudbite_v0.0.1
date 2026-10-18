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
4. 시작 → 데스크톱(1024x768) 화면과 원격 키보드로 사용.

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
- **release worktree에서만 배포·재현한다.** release는 `e09a009`(Falsify 200 roles 포함 최신 운영 카탈로그) 기반으로 격리돼 있다. 공용 main(`6d14054`)은 관련 없는 누락 모듈 `cloudbite-decision`을 import하므로 배포하지 않는다.

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
