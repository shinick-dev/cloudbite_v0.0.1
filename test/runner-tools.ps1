# tools/runner-common.ps1 회귀 (가짜 dev·가짜 테스트, 키·클라우드 없음): pwsh test/runner-tools.ps1
# node 실패 코드가 끝 줄 자르기(Select-Object)를 지나 그대로 나오는지, 준비 실패가 throw 되는지,
# 이 실행기가 띄운 나무(손자 포함)만 끄고 명령줄에 wrangler·8797 이 든 남의 프로세스는 살아남는지, 뮤텍스, .wrangler\state 지우기 경계,
# 포트가 이미 쓰이면 $Launch 안의 지우기가 안 도는지, 띄우기 실패면 prepare·테스트 없이 throw 하고 뮤텍스가 풀리는지.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\tools\runner-common.ps1')
$tmp = Join-Path ([IO.Path]::GetTempPath()) "gw-runner-test-$PID"
$tmpMade = (New-Item -ItemType Directory $tmp).FullName
$script:ok = 0; $script:bad = 0
function Check([string]$name, [bool]$cond) { if ($cond) { $script:ok++; Write-Host "ok   $name" } else { $script:bad++; Write-Host "FAIL $name" } }
function Alive([int]$id) { [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }
function FreePort { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }
function Throws([scriptblock]$b) { try { & $b | Out-Null; '' } catch { "$_" } }
# 다른 프로세스에서 뮤텍스를 잡아 본다 (같은 스레드는 재진입이라 못 가린다): 0 비었음, 9 누가 쥠, 2 버려짐
function LockFromOther([string]$name) {
    pwsh -NoProfile -Command "`$m = [Threading.Mutex]::new(`$false, '$name'); try { if (`$m.WaitOne(0)) { `$m.ReleaseMutex(); exit 0 } else { exit 9 } } catch [Threading.AbandonedMutexException] { exit 2 }"
    $LASTEXITCODE
}

# 가짜 dev: 손자(잠자는 node)를 하나 띄워 PID 를 적고, mode 에 따라 listen / 응답 안 함 / 곧바로 죽음
Set-Content "$tmp\fake-dev.mjs" @'
import http from 'node:http'; import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'
const [mode, port, pidFile] = process.argv.slice(2)
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' })
writeFileSync(pidFile, String(c.pid))
if (mode === 'listen') http.createServer((q, s) => s.end('ok')).listen(+port, '127.0.0.1')
else if (mode === 'exit') setTimeout(() => process.exit(5), 300)
else setInterval(() => {}, 1e9)
'@
Set-Content "$tmp\fail.mjs" "for (let i = 0; i < 100; i++) console.log('line ' + i); console.error('boom'); process.exit(7)"
Set-Content "$tmp\pass.mjs" "console.log('fine')"
Set-Content "$tmp\mark.mjs" "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1] + '.ran', 'x')"
Set-Content "$tmp\stderr.mjs" "process.stderr.write('only stderr\n'); process.exitCode = 3"

# 남의 프로세스: 명령줄에 wrangler dev --port 8797 gw-shinick 이 들어 있다 (예전 전역 정리가 죽이던 모양)
$decoyPort = FreePort
$decoy = Start-Process node -ArgumentList '-e', "`"require('http').createServer((q,s)=>s.end('x')).listen($decoyPort,'127.0.0.1')`"", 'wrangler', 'dev', '--port', '8797', 'gw-shinick' -PassThru -WindowStyle Hidden
$mtx = $null
try {
    for ($i = 0; $i -lt 50 -and -not (Test-DevUp "http://127.0.0.1:$decoyPort/"); $i++) { Start-Sleep -Milliseconds 200 }
    Check 'decoy up' (Test-DevUp "http://127.0.0.1:$decoyPort/")

    # 1. 종료 코드
    $r = @(Invoke-NodeTail "$tmp\fail.mjs" 5); Check 'tail: exit 7 survives Select-Object -Last' ($r.Count -eq 1 -and $r[0] -eq 7)
    $r = @(Invoke-NodeTail "$tmp\stderr.mjs" 5); Check 'tail: stderr-only exit 3' ($r.Count -eq 1 -and $r[0] -eq 3)
    $r = @(Invoke-NodeTail "$tmp\pass.mjs" 5); Check 'tail: exit 0' ($r.Count -eq 1 -and $r[0] -eq 0)

    function Launch([string]$mode, [int]$port, [string]$pidFile) {
        $js = "$tmp\fake-dev.mjs"
        { Start-Process node -ArgumentList "`"$js`"", $mode, $port, "`"$pidFile`"" -PassThru -WindowStyle Hidden }.GetNewClosure()
    }
    function Child([string]$pidFile) { for ($i = 0; $i -lt 50 -and -not (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 100 }; [int](Get-Content $pidFile) }

    # 2. 성공 경로: 준비 → 실패 테스트 코드 7 반환 → 나무만 꺼짐
    $port = FreePort; $pf = "$tmp\c1.pid"; $script:devId = 0
    $starter = Launch 'listen' $port $pf
    $r = @(Invoke-DevTest -Launch { $p = & $starter; $script:devId = $p.Id; $p } -ReadyUrl "http://127.0.0.1:$port/" -ReadySec 20 -Prepare { $env:GW_RUNNER_FAKE = 'fabricated' } -Test "$tmp\fail.mjs" -Last 3)
    $child = Child $pf
    Check 'dev test: returns node exit 7' ($r.Count -eq 1 -and $r[0] -eq 7)
    Check 'dev test: prepare ran after ready' ($env:GW_RUNNER_FAKE -eq 'fabricated')
    Check 'dev test: dev process stopped' (-not (Alive $script:devId))
    Check 'dev test: grandchild stopped' ($child -gt 0 -and -not (Alive $child))
    Check 'dev test: port freed' (-not (Test-DevUp "http://127.0.0.1:$port/"))

    # 3. 준비 시간 초과: throw, 나무는 꺼짐, prepare·테스트는 안 돎
    $port = FreePort; $pf = "$tmp\c2.pid"; $env:GW_RUNNER_FAKE = $null
    $starter = Launch 'silent' $port $pf
    $e = Throws { Invoke-DevTest -Launch { $p = & $starter; $script:devId = $p.Id; $p } -ReadyUrl "http://127.0.0.1:$port/" -ReadySec 3 -Prepare { $env:GW_RUNNER_FAKE = 'x' } -Test "$tmp\pass.mjs" -Last 3 }
    $child = Child $pf
    Check 'timeout: throws not ready' ($e -match 'not ready after 3s')
    Check 'timeout: prepare skipped' (-not $env:GW_RUNNER_FAKE)
    Check 'timeout: dev + grandchild stopped' (-not (Alive $script:devId) -and $child -gt 0 -and -not (Alive $child))

    # 4. dev 가 먼저 죽음: throw, 남은 손자(고아)도 꺼짐
    $port = FreePort; $pf = "$tmp\c3.pid"
    $starter = Launch 'exit' $port $pf
    $e = Throws { Invoke-DevTest -Launch $starter -ReadyUrl "http://127.0.0.1:$port/" -ReadySec 20 -Test "$tmp\pass.mjs" -Last 3 }
    $child = Child $pf
    Check 'early exit: throws exited before ready (exit 5)' ($e -match 'exited before ready \(exit 5\)')
    Check 'early exit: orphaned grandchild stopped' ($child -gt 0 -and -not (Alive $child))

    # 5. 포트에 이미 남의 서버: 띄우지 않고 throw — realdev 처럼 $Launch 안에 둔 상태 지우기도 안 돎
    $busy = "$tmp\busy"; New-Item -ItemType Directory "$busy\.wrangler\state" | Out-Null
    Set-Content "$busy\wrangler.jsonc" '{}'; Set-Content "$busy\.wrangler\state\db" 'live'
    $e = Throws { Invoke-DevTest -Launch { Remove-WranglerState $busy; throw 'must not launch' } -ReadyUrl "http://127.0.0.1:$decoyPort/" -ReadySec 3 -Test "$tmp\pass.mjs" -Last 3 }
    Check 'busy port: refuses before launch' ($e -match 'already answers')
    Check 'busy port: state reset in Launch skipped' (Test-Path "$busy\.wrangler\state\db")

    # 5b. 띄우기 실패 (Start-Process -ErrorAction Stop / 프로세스 아님): throw, prepare·테스트 안 돎, 뮤텍스 풀림
    $name3 = "Local\gw-runner-test3-$PID"; $env:GW_RUNNER_FAKE = $null
    $mtx = Enter-RunnerLock $name3
    Check 'launch fail: probe sees lock held' ((LockFromOther $name3) -eq 9)
    try {
        $e = Throws { Invoke-DevTest -Launch { Start-Process -ErrorAction Stop "$tmp\no-such-dev.exe" -PassThru } -ReadyUrl "http://127.0.0.1:$(FreePort)/" -ReadySec 3 -Prepare { $env:GW_RUNNER_FAKE = 'x' } -Test "$tmp\mark.mjs" -Last 3 }
    } finally { Exit-RunnerLock $mtx; $mtx = $null }
    Check 'launch fail: throws' ($e -ne '' -and $e -notmatch 'not ready')
    Check 'launch fail: prepare + test skipped' (-not $env:GW_RUNNER_FAKE -and -not (Test-Path "$tmp\mark.mjs.ran"))
    Check 'launch fail: lock free for other process' ((LockFromOther $name3) -eq 0)
    $e = Throws { Invoke-DevTest -Launch { $null } -ReadyUrl "http://127.0.0.1:$(FreePort)/" -ReadySec 3 -Test "$tmp\mark.mjs" -Last 3 }
    Check 'launch fail: no process returned throws' ($e -match 'did not return a process' -and -not (Test-Path "$tmp\mark.mjs.ran"))
    $r = @(Invoke-NodeTail "$tmp\mark.mjs" 1); Check 'control: marker test does write when run' ($r[-1] -eq 0 -and (Test-Path "$tmp\mark.mjs.ran"))
    Check 'unrelated wrangler/8797 process survived every cleanup' (Alive $decoy.Id)

    # 6. 뮤텍스: 놓기, 주인이 죽은 뮤텍스도 잡기
    $name = "Local\gw-runner-test-$PID"
    $mtx = Enter-RunnerLock $name; Exit-RunnerLock $mtx; $mtx = $null
    Check 'lock: released cleanly (not abandoned)' ((LockFromOther $name) -eq 0)
    $name2 = "Local\gw-runner-test2-$PID"
    $keep = [Threading.Mutex]::new($false, $name2)   # 핸들을 쥐고 있어야 이름이 남아 abandoned 가 된다
    $hold = "[void][Threading.Mutex]::new(`$false, '$name2').WaitOne()"   # 놓지 않고 끝난 프로세스
    pwsh -NoProfile -Command $hold
    $ab = try { [void]$keep.WaitOne(0); $false } catch [Threading.AbandonedMutexException] { $true }
    $keep.ReleaseMutex(); Check 'lock: setup really abandons' $ab
    pwsh -NoProfile -Command $hold
    $mtx = Enter-RunnerLock $name2; Check 'lock: abandoned mutex acquired' ($null -ne $mtx); Exit-RunnerLock $mtx; $mtx = $null; $keep.Dispose()

    # 7. .wrangler\state 지우기 경계
    $root = "$tmp\repo"; $outside = "$tmp\outside"
    New-Item -ItemType Directory "$root\.wrangler\state\v3", $outside | Out-Null
    Set-Content "$root\.wrangler\state\v3\db" 'x'; Set-Content "$root\.wrangler\keep" 'k'; Set-Content "$outside\precious" 'p'
    Check 'state: refuses root without wrangler.jsonc' ((Throws { Remove-WranglerState $root }) -match 'not a repository root')
    Check 'state: nothing deleted without marker' (Test-Path "$root\.wrangler\state\v3\db")
    Set-Content "$root\wrangler.jsonc" '{}'
    Remove-WranglerState $root
    Check 'state: deleted under real root' (-not (Test-Path "$root\.wrangler\state") -and (Test-Path "$root\.wrangler\keep") -and (Test-Path "$root\wrangler.jsonc"))
    Check 'state: missing state is a no-op' ((Throws { Remove-WranglerState $root }) -eq '')
    New-Item -ItemType Junction -Path "$root\.wrangler\state" -Target $outside | Out-Null
    Check 'state: refuses junction state' ((Throws { Remove-WranglerState $root }) -match 'link')
    [IO.Directory]::Delete("$root\.wrangler\state")
    Remove-Item -LiteralPath "$root\.wrangler" -Recurse -Force
    New-Item -ItemType Directory "$outside\state" | Out-Null; Set-Content "$outside\state\db" 's'
    New-Item -ItemType Junction -Path "$root\.wrangler" -Target $outside | Out-Null
    Check 'state: refuses junction .wrangler' ((Throws { Remove-WranglerState $root }) -match 'link')
    Check 'state: outside files survive' ((Test-Path "$outside\precious") -and (Test-Path "$outside\state\db"))
    [IO.Directory]::Delete("$root\.wrangler")
} finally {
    if ($mtx) { Exit-RunnerLock $mtx }
    Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    # 링크가 남았으면 링크만 떼고, 지울 대상이 OS 임시 폴더 바로 아래 이 테스트가 만든 폴더일 때만 통째로 지운다
    foreach ($j in "$tmp\repo\.wrangler\state", "$tmp\repo\.wrangler") {
        $it = Get-Item -LiteralPath $j -Force -ErrorAction SilentlyContinue
        if ($it -and ($it.Attributes -band [IO.FileAttributes]::ReparsePoint)) { [IO.Directory]::Delete($j) }
    }
    $tempBase = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))
    $target = (Resolve-Path -LiteralPath $tmp -ErrorAction SilentlyContinue).ProviderPath
    if ($target -and $target -eq $tmpMade -and [IO.Path]::GetDirectoryName($target) -eq $tempBase -and (Split-Path -Leaf $target) -eq "gw-runner-test-$PID" -and
        -not ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    } else { Write-Warning "cleanup skipped, unexpected target: $target" }
}
Write-Host "$script:ok passed, $script:bad failed"
exit [int]($script:bad -gt 0)
