# 로컬 dev 서버(-Fresh)를 띄워 테스트 하나를 돌리고 끈다. 포트 8797·8799·8800 을 같이 쓰므로 전역 뮤텍스로 한 번에 하나만.
#   pwsh tools/test-locked.ps1                               # test/lab-e2e.mjs
#   pwsh tools/test-locked.ps1 -Test test/e2e.mjs
#   pwsh tools/test-locked.ps1 -Test tools/rtc-browser.mjs   # 가짜 Daytona + 진짜 Realtime SFU
# 키는 User 환경변수에서 이 프로세스로만 (값은 출력하지 않는다): OPENROUTER_MANAGEMENT_KEY, REALTIME_APP_TOKEN(있으면 dev 서버로)
param([string]$Root = (Split-Path $PSScriptRoot), [string]$Test = 'test/lab-e2e.mjs', [int]$Last = 60)
. (Join-Path $PSScriptRoot 'runner-common.ps1')
Write-Host "[lock] waiting..."
$m = Enter-RunnerLock
Write-Host "[lock] acquired ($Root)"
$code = 1
try {
    $Root = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath
    Set-Location -LiteralPath $Root -ErrorAction Stop
    $log = Join-Path $Root 'dev.log'
    $rt = [Environment]::GetEnvironmentVariable('REALTIME_APP_TOKEN', 'User')
    if ($rt) { $env:REALTIME_APP_TOKEN = $rt }
    $code = Invoke-DevTest -Test $Test -Last $Last -ReadyUrl 'http://localhost:8797/borrow' -ReadySec 90 -Launch {
        Start-Process -ErrorAction Stop pwsh -ArgumentList '-NoProfile', '-File', 'run-dev.ps1', '-Fresh' -PassThru -WindowStyle Hidden -RedirectStandardOutput $log
    } -Prepare {
        $env:SETUP_TOKEN = (Get-Content .dev-setup-token -Raw).Trim()
        $env:OPENROUTER_MANAGEMENT_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_MANAGEMENT_KEY', 'User')
    }
} finally { Exit-RunnerLock $m; Write-Host "[lock] released" }
exit $code
