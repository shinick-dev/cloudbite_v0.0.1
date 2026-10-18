# test-locked.ps1 · realdev.ps1 공용 (dot-source). 뮤텍스, dev 서버 띄우기·준비 기다리기, 이 실행기가 띄운 프로세스 나무만 끄기,
# .wrangler\state 지우기, node 종료 코드 넘기기. 검증: pwsh test/runner-tools.ps1 (가짜 dev·가짜 테스트, 키 없음)

function Enter-RunnerLock([string]$Name = 'Global\gw-shinick-test') {
    $m = [System.Threading.Mutex]::new($false, $Name)
    # 앞 주인이 놓지 않고 죽었으면 AbandonedMutexException 과 함께 이미 잡힌 상태다
    try { [void]$m.WaitOne() } catch [System.Threading.AbandonedMutexException] { Write-Host '[lock] previous holder died without releasing' }
    $m
}

function Exit-RunnerLock($m) { try { $m.ReleaseMutex() } finally { $m.Dispose() } }

function Test-DevUp([string]$Url) { try { Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }

function Wait-DevReady($Proc, [string]$Url, [int]$TimeoutSec) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    while ($true) {
        if ($Proc.HasExited) { throw "[dev] exited before ready (exit $($Proc.ExitCode)) — see dev.log" }
        if (Test-DevUp $Url) { return }
        if ([DateTime]::UtcNow -ge $deadline) { throw "[dev] not ready after ${TimeoutSec}s: $Url — see dev.log" }
        Start-Sleep 1
    }
}

# 루트 PID 에서 ParentProcessId 로 내려간다. 자식은 부모가 생긴 뒤에 생긴 것만 (PID 재사용으로 남의 프로세스를 잡지 않게).
# 루트는 $dev 핸들이 PID 를 붙잡고 있어 재사용되지 않으므로, 루트가 먼저 죽었어도 루트의 직계 자식은 찾는다.
# 한계(Job Object 없음): 루트 아래 중간 프로세스가 먼저 죽으면 그 아래 자손은 스냅샷으로 이어지지 않아 남을 수 있다.
function Get-OwnedTree([int]$RootId, [datetime]$RootStart) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    $tree = [System.Collections.Generic.List[object]]::new()
    $tree.Add([pscustomobject]@{ Id = $RootId; Start = $RootStart })
    for ($i = 0; $i -lt $tree.Count; $i++) {
        $n = $tree[$i]
        foreach ($p in $all) {
            if ($p.ParentProcessId -eq $n.Id -and $p.ProcessId -ne $RootId -and $p.CreationDate -ge $n.Start -and -not ($tree.Id -contains $p.ProcessId)) {
                $tree.Add([pscustomobject]@{ Id = [int]$p.ProcessId; Start = $p.CreationDate })
            }
        }
    }
    $tree.Id
}

function Stop-OwnedTree($Proc, [datetime]$Since) {
    for ($round = 0; $round -lt 3; $round++) {
        $ids = @(Get-OwnedTree $Proc.Id $Since | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if (-not $ids) { return }
        [array]::Reverse($ids)   # 아래(workerd)부터
        foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        Wait-Process -Id $ids -Timeout 10 -ErrorAction SilentlyContinue
    }
    Write-Warning "[dev] owned processes still alive after cleanup"
}

# node 출력은 끝 $Last 줄만 보이고, 종료 코드는 그대로 돌려준다
function Invoke-NodeTail([string]$Test, [int]$Last) {
    $global:LASTEXITCODE = $null
    node $Test 2>&1 | Select-Object -Last $Last | Out-Host
    if ($null -eq $global:LASTEXITCODE) { 1 } else { $global:LASTEXITCODE }
}

# $Launch 가 Start-Process -PassThru 로 dev 를 띄운다 (지우기 같은 되돌릴 수 없는 준비도 $Launch 안에서 — 포트 확인 뒤에 돈다).
# 띄우기 실패·준비 안 됨은 throw (prepare·테스트 안 돎), 끝나면 그 나무만 끈다. 반환: node 종료 코드
function Invoke-DevTest([scriptblock]$Launch, [string]$ReadyUrl, [int]$ReadySec, [scriptblock]$Prepare, [string]$Test, [int]$Last) {
    if (Test-DevUp $ReadyUrl) { throw "[dev] $ReadyUrl already answers — another dev server is running" }
    $since = Get-Date
    $dev = & $Launch
    if ($dev -isnot [Diagnostics.Process]) { throw "[dev] launch did not return a process" }
    try {
        Wait-DevReady $dev $ReadyUrl $ReadySec
        if ($Prepare) { & $Prepare | Out-Null }
        Invoke-NodeTail $Test $Last
    } finally { Stop-OwnedTree $dev $since }
}

# <Root>\.wrangler\state 만 지운다. Root 는 wrangler.jsonc 가 있는 폴더, 경로 중간에 링크(junction·symlink)가 있으면 거부.
function Remove-WranglerState([string]$Root) {
    $rootFull = [IO.Path]::TrimEndingDirectorySeparator((Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath)
    if (-not (Test-Path -LiteralPath (Join-Path $rootFull 'wrangler.jsonc') -PathType Leaf)) { throw "[state] not a repository root: $rootFull" }
    $target = [IO.Path]::GetFullPath((Join-Path $rootFull '.wrangler\state'))
    if (-not $target.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "[state] target outside root: $target" }
    foreach ($p in (Join-Path $rootFull '.wrangler'), $target) {
        if (-not (Test-Path -LiteralPath $p)) { return }
        $it = Get-Item -LiteralPath $p -Force
        if (-not $it.PSIsContainer -or ($it.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "[state] refusing to delete through link or file: $p" }
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}
