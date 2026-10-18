# 로컬 검증 서버. 공급자 키는 서버에 넘기지 않는다 — e2e 가 CLI 로그인 흐름으로 올린다 (운영과 같은 경로).
# MASTER_KEY 는 .dev-master-key 에 한 번 만들어 두고 계속 쓴다 (지우면 로컬 DO 에 저장된 공급자 키를 못 푼다).
param([switch]$Fresh)   # -Fresh: 로컬 DO 상태(등록 키·공급자·금고)를 비우고 시작 — e2e 는 빈 상태를 가정한다
Set-Location $PSScriptRoot
if ($Fresh -and (Test-Path .wrangler\state)) { Remove-Item -Recurse -Force .wrangler\state }
$mk = "$PSScriptRoot\.dev-master-key"
if (-not (Test-Path $mk)) {
    $b = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    [IO.File]::WriteAllText($mk, [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}
$env:MASTER_KEY = (Get-Content $mk -Raw).Trim()
$env:SETUP_TOKEN = (Get-Content "$PSScriptRoot\.dev-setup-token" -Raw).Trim()
$env:CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'
npx wrangler dev --env dev --port 8797 2>&1
