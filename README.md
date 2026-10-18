# Cloudbite v0.0.1

하나의 프로젝트를 서로 다른 전문가 AI가 독립된 Daytona 샌드박스에서 수행하는 작업 공간입니다. 프로젝트 책임자는 전문가의 페르소나·작업 지시·활동·산출물을 보고 다음 결정을 내립니다.

## 제품 흐름

1. 프로젝트의 목표와 맥락을 입력합니다.
2. 제품·기술·UX·데이터·가격·보안 등 필요한 전문가 역할을 선택합니다.
3. 전문가마다 `PERSONA.md`, `PROJECT.md`, `WORKORDER.md`, 결과 스키마를 가진 독립 작업 공간을 만듭니다.
4. Daytona 안의 작업자가 파일·코드 도구를 사용하고, Nosana 모델 추론으로 작업을 이어갑니다.
5. 전문가별 보고서·근거·가정·다음 행동과 전체 의견 분포를 확인합니다.

초기 실행 범위는 최대 5명의 전문가입니다. 100인 자문이라는 제품 비전과 동시에 100개의 실제 샌드박스를 실행했다는 주장은 구분합니다. 확신도는 모델의 자기 평가이며, 실제 정확도나 사업 성공 확률이 아닙니다.

## 피치용 완성 경험 미리보기

[demo/cloudbite-pitch.html](demo/cloudbite-pitch.html)을 브라우저에서 열면 됩니다. 파일 하나로 오프라인에서 동작합니다.

- ‘Replay pitch’: 프로젝트 전달 → 전문가별 작업실 → 실행과 근거 → 종합 판단의 30초 흐름. 3배속과 단계 이동을 지원합니다.
- 전문가 선택: 의견·페르소나·작업 지시·산출물 원문·활동을 확인합니다.
- ‘Full launch / Paid pilot’: 준비된 두 대안의 조언·분포를 비교합니다.
- ‘Save brief’: 현재 대안의 예시 판단을 텍스트 파일로 내보냅니다.

이 HTML은 모든 결과와 활동을 합성한 피치 목업입니다. 실제 실행 콘솔과 별개이며, 실서비스 연결이나 통계적 정확도를 증명하지 않습니다.

3분 피치 원고: [영어](docs/pitch/3min.en.txt) · [한국어](docs/pitch/3min.ko.txt) · [리허설 메모](docs/pitch/rehearsal-notes.txt). 두 원고의 마지막에는 QR 신청·보안키 승인 안내가 포함되어 있습니다.

## 참가자 체험용 QR

[QR PNG](demo/cloudbite-sandbox-request.png) · [SVG](demo/cloudbite-sandbox-request.svg) · [영문 QR 안내 화면](demo/access-qr.html)

QR은 기존 공개 신청 주소 `https://k.shinick.dev/lab/request`를 엽니다. 참가자는 개인 체험실을 신청하고, 모임지기는 `https://k.shinick.dev/lab/requests`에서 해당 요청의 조건을 보안키로 승인합니다. 준비가 끝나면 요청자에게만 개별 입장 링크가 나옵니다. 새 Cloudbite Worker를 배포하지 않아도 QR은 사용할 수 있습니다.

Cloudbite 로컬 콘솔에서는 `/cloudbite/access`에 같은 안내 화면이 있습니다. 기존 신청 서비스의 화면과 인증은 유지합니다. [운영·검증 메모](docs/cloudbite/sandbox-access.txt)를 참고하세요.

정확한 승인 버튼·보안키 절차·생성 결과 재확인은 [피치 QR 진행 안내](docs/pitch/qr-handoff.txt)에 정리되어 있습니다. 승인 후 환경 생성이 끝나지 않으면 같은 요청에서 ‘같은 요청으로 생성 결과 확인’을 누릅니다.

## 로컬 실행

```powershell
npm ci
npm run dev
```

기본 개발 주소는 `http://localhost:8808/cloudbite`입니다. 공개 데모는 모의 실행으로 명확히 표시하며 실제 Daytona·Nosana 자원을 만들지 않습니다. 실제 실행에 필요한 서버 설정과 권한은 [실행 엔진 문서](docs/cloudbite/runtime.md)를 참고하세요. 구성 파일은 `wrangler.cloudbite.jsonc`입니다.

## 실제 Daytona 실행 데모

`demo/run-council.ps1`은 전문가 역할마다 **실제 Daytona 샌드박스를 생성하고**, 그 안에서 분석 코드를 실행한 뒤 결과를 집계합니다. 모의 실행이 아니라 원격 샌드박스 실행입니다.

```powershell
.\demo\run-council.ps1        # 실행 후 샌드박스 자동 정리
.\demo\run-council.ps1 -Keep  # 샌드박스 유지
```

- 산출물: `demo/evidence.json` (샌드박스 ID·호스트·생성/실행 소요 시간·확신도)
- 데모 진행 순서는 [demo/DEMO.md](demo/DEMO.md)를 참고합니다.
- 확신도는 결정론적 시뮬레이션 값이며, 실제 모델 추론 확률이 아닙니다. 실제 추론은 Nosana 연동 단계에서 붙입니다.

## 개발과 검증

```powershell
npm run check
```

Cloudbite의 목적과 범위는 [구현 계약](docs/cloudbite/implementation-contract.md), 모듈 경계와 API는 [연동 계약](docs/cloudbite/api-contract.md)에 정리합니다. 기능별 검증 명령과 실행 결과는 각 작업 문서 및 [HANDOFF.md](HANDOFF.md)에 기록합니다. 설정과 연결을 확인하지 않은 실제 외부 실행은 통과했다고 기록하지 않습니다.

## 재사용한 기반

- `shinick-studyroom/gw-shinick`의 인증, 자격증명 중계, Daytona 실습 환경, 파일·터미널 기반 구조를 가져왔습니다. 기존 이력은 이어받지 않은 독립 저장소입니다.
- `Shinick-Han/pro-bably`의 역할 레지스트리와 전문가 작업 지시서 구성을 참고합니다. 원본 페르소나 프롬프트를 실행했다고 주장하지 않고, 실제 재사용 근거와 출처를 [페르소나 문서](docs/cloudbite/persona-provenance.md)에 기록합니다.
- 이전 공부방 문서와 운영 이력은 [legacy 문서](docs/legacy/gw-shinick.md)에 보존합니다. 그 안의 배포 내역은 Cloudbite의 배포 내역이 아닙니다.

## 실행 대상

`npm run dev`와 `npm run deploy`는 독립 Cloudbite 설정을 사용합니다. 원본 `wrangler.jsonc`는 기존 동작 검증용 참고 설정이며 원본 운영 도메인을 포함합니다. 기존 공부방의 DNS·비밀값·실습실을 변경하지 않습니다. 이 저장소를 복제한 것만으로 기존 서비스의 운영 데이터나 인증 정보가 복제되지는 않습니다.
