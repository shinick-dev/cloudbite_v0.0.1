<#
.SYNOPSIS
    k.shinick.dev 배포. 키는 User 환경변수에서 wrangler stdin 으로만 넘긴다 (화면·파일에 안 남음).

.DESCRIPTION
    1. wrangler deploy  (k.shinick.dev 커스텀 도메인)
    2. MASTER_KEY 가 없으면 한 번만 만든다 (저장된 공급자 키 암호화용. 절대 다시 만들지 않는다)
       예전 방식의 공급자 secrets(OPENROUTER_MANAGEMENT_KEY 등)는 지운다 — 이제 kv.ps1 push 로 올린다
    3. SETUP_TOKEN 을 새로 만들어 등록하고 클립보드에 복사 → /register 에 붙여넣기
       서버는 이 토큰을 처음 맞게 쓴 순간(아래 확인 요청 포함)부터 30분 동안, 등록 성공 2번(Nano + NFC)까지만 받는다.
       지나거나 다 쓰면 다시 떠도 닫힌 채다 — 더 필요하면 -SetupOnly 로 새 토큰

.EXAMPLE
    .\deploy.ps1                 # 전체
    .\deploy.ps1 -SetupOnly      # SETUP_TOKEN 만 다시 발급 (키 추가 등록할 때)
    .\deploy.ps1 -RemoveSetup    # 등록 끝난 뒤 SETUP_TOKEN 삭제 (/register 닫힘)
    .\deploy.ps1 -CodeOnly       # 코드만 다시 배포 (키·토큰은 그대로)
    .\deploy.ps1 -SkipSetup      # 배포 + MASTER_KEY 까지만 (보안 키 등록이 이미 끝났을 때)
#>
[CmdletBinding()]
param([switch]$SetupOnly, [switch]$RemoveSetup, [switch]$CodeOnly, [switch]$SkipSetup)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Put-Secret([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { Write-Host "  - $Name  (값 없음, 건너뜀)" -ForegroundColor Yellow; return }
    $out = $Value | npx wrangler secret put $Name 2>&1
    if ($LASTEXITCODE) { $out | Out-Host; throw "$Name 등록 실패" }
    Write-Host "  + $Name" -ForegroundColor Green
}

if ($CodeOnly) {
    npx wrangler deploy
    if ($LASTEXITCODE) { throw 'deploy 실패' }
    return
}

if ($RemoveSetup) {
    'y' | npx wrangler secret delete SETUP_TOKEN
    Write-Host "SETUP_TOKEN 삭제됨. /register 는 이제 항상 거부합니다." -ForegroundColor Green
    return
}

if (-not $SetupOnly) {
    Write-Host "`n[1/3] 배포" -ForegroundColor Cyan
    npx wrangler deploy
    if ($LASTEXITCODE) { throw 'deploy 실패' }

    Write-Host "`n[2/3] MASTER_KEY" -ForegroundColor Cyan
    $list = npx wrangler secret list --format json 2>$null | Out-String
    if ($LASTEXITCODE) { throw 'secret list 실패' }
    $names = @(($list | ConvertFrom-Json) | ForEach-Object { $_.name })
    if ($names -contains 'MASTER_KEY') {
        Write-Host "  = MASTER_KEY (이미 있음, 그대로 둠)" -ForegroundColor Green
    } else {
        # 이 값은 어디에도 남기지 않는다. 잃어버리면 공급자 키를 kv.ps1 push 로 다시 올리면 된다.
        $mk = [byte[]]::new(32)
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($mk)
        Put-Secret 'MASTER_KEY' ([Convert]::ToBase64String($mk).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
    }
    foreach ($n in 'OPENROUTER_MANAGEMENT_KEY', 'GROQ_API_KEY', 'HF_TOKEN') {
        if ($names -contains $n) {
            'y' | npx wrangler secret delete $n 2>&1 | Out-Null
            Write-Host "  - $n (예전 방식 secret 삭제)" -ForegroundColor DarkGray
        }
    }
    if ($SkipSetup) {
        Write-Host "`n다음: .\kv.ps1 push  (Nano 터치 한 번으로 공급자 키 올리기)`n" -ForegroundColor Cyan
        return
    }
}

Write-Host "`n[3/3] SETUP_TOKEN" -ForegroundColor Cyan
$bytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$setup = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
Put-Secret 'SETUP_TOKEN' $setup

# 서버가 새 토큰을 받아들이는지 직접 확인한 뒤에 페이지를 연다 (시크릿 반영까지 몇 초 걸릴 수 있다).
# 처음 통과한 확인이 30분 창을 연다 — 등록을 바로 이어서 한다
$ok = $false
for ($i = 1; $i -le 15 -and -not $ok; $i++) {
    try {
        Invoke-RestMethod -Method Post -Uri 'https://k.shinick.dev/api/register/options' `
            -Headers @{ Origin = 'https://k.shinick.dev' } -ContentType 'application/json' `
            -Body (@{ setup = $setup } | ConvertTo-Json) | Out-Null
        $ok = $true
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $ok) { throw '서버가 새 SETUP_TOKEN 을 30초 안에 받아들이지 않았습니다.' }
Write-Host "  서버 확인 완료 (토큰 유효)" -ForegroundColor Green
Set-Clipboard -Value $setup
# 클립보드는 환경에 따라 비어 버린 적이 있어서, 토큰을 URL fragment 로 실어 등록 페이지를 바로 연다.
# fragment(#…)는 서버로 전송되지 않고, 페이지가 읽자마자 주소창에서 지운다.
Start-Process "https://k.shinick.dev/register#$setup"
Write-Host "  등록 페이지를 열었습니다. Setup token 이 자동 입력돼 있습니다 (비어 있으면 Ctrl+V — 클립보드에도 넣어둠)." -ForegroundColor Green
Write-Host "  이 토큰은 지금부터 30분 동안 키 2개(Nano + NFC)까지만 등록됩니다." -ForegroundColor Yellow
Write-Host "  두 키 등록이 끝나면: .\deploy.ps1 -RemoveSetup  → 그다음 .\kv.ps1 push`n" -ForegroundColor DarkGray
