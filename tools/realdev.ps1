# dev 서버를 **진짜 Daytona + 진짜 Realtime SFU** 로 띄우고 점검 스크립트를 돌린다 (운영 시간값: ALLOW_SHORT_TTL 0).
#   pwsh tools/realdev.ps1 -Test tools/real-screen.mjs
# 진짜 샌드박스를 만들므로 비용이 든다 — 스크립트가 끝에서 수업을 끝내(샌드박스·서브키 삭제) 정리한다. 운영 수업의 샌드박스는 건드리지 않는다.
# 키는 User 환경변수에서 이 프로세스로만 (값은 출력하지 않는다): DAYTONA_API_KEY, OPENROUTER_MANAGEMENT_KEY, REALTIME_APP_TOKEN, TAVILY_API_KEY, GROQ_API_KEY
param([Parameter(Mandatory)][string]$Test, [int]$Last = 200, [string]$Root = (Split-Path $PSScriptRoot))
. (Join-Path $PSScriptRoot 'runner-common.ps1')
$m = Enter-RunnerLock
$code = 1
try {
    $Root = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath
    Set-Location -LiteralPath $Root -ErrorAction Stop
    $log = Join-Path $Root 'dev.log'
    $env:MASTER_KEY = (Get-Content .dev-master-key -Raw).Trim()
    $env:SETUP_TOKEN = (Get-Content .dev-setup-token -Raw).Trim()
    $env:CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'
    $rt = [Environment]::GetEnvironmentVariable('REALTIME_APP_TOKEN', 'User'); if ($rt) { $env:REALTIME_APP_TOKEN = $rt }
    $code = Invoke-DevTest -Test $Test -Last $Last -ReadyUrl 'http://localhost:8797/borrow' -ReadySec 90 -Launch {
        Remove-WranglerState $Root   # 뮤텍스 안·포트 확인 뒤에만 — 이미 떠 있는 남의 dev 상태를 지우지 않게
        Start-Process -ErrorAction Stop pwsh -ArgumentList '-NoProfile', '-Command', 'npx wrangler dev --env dev --port 8797 --var LAB_DAYTONA_API:https://app.daytona.io/api --var ALLOW_SHORT_TTL:0 --var REALTIME_API:https://rtc.live.cloudflare.com/v1 2>&1' -PassThru -WindowStyle Hidden -RedirectStandardOutput $log
    } -Prepare {
        foreach ($n in 'OPENROUTER_MANAGEMENT_KEY', 'DAYTONA_API_KEY', 'TAVILY_API_KEY', 'GROQ_API_KEY') { Set-Item "env:$n" ([Environment]::GetEnvironmentVariable($n, 'User')) }
    }
} finally { Exit-RunnerLock $m }
exit $code
