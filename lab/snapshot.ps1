# 공부방 실습실 스냅샷을 Daytona 에 만든다 (한 번, 도구 버전을 올릴 때만 다시).
# Daytona 는 스냅샷으로 샌드박스를 만들 때 사양(cpu/memory/disk)을 따로 못 준다 → 사양마다 스냅샷을 만든다:
#   gw-lab-v5-1c2g (1 vCPU · 2 GiB · 5 GiB)   gw-lab-v5-2c4g (2 · 4 · 5)   gw-lab-v5-4c8g (4 · 8 · 10)
#   그 밖의 사양은 디스크까지 이름에: -Specs 2/8/10 → <Name>-2c8g10d (검사·이름 규칙은 lab/snapshot-resources.ps1)
# 내용을 바꾸면 이름(버전)을 올린다 — 진행 중인 수업의 샌드박스가 쓰는 스냅샷을 덮지 않게. src/state.ts 의 LAB_DEFAULT 도 같이.
#   .\lab\snapshot.ps1                 # 없는 것만 빌드
#   .\lab\snapshot.ps1 -Force          # 전부 지우고 다시 빌드 (도구 버전 올릴 때)
#   .\lab\snapshot.ps1 -Verify         # 끝나고 -Specs 의 첫 사양으로 샌드박스 하나 띄워 점검하고 지움
#   .\lab\snapshot.ps1 -Name gw-lab-custom -Specs 2/8/10 -Plan   # 만들 이름·사양만 출력 (키 안 읽음, API 안 부름)
#   이름·사양이 잘못됐거나, 같은 이름의 스냅샷이 사양이 다르면 (-Force 여도) 아무것도 지우거나 만들지 않고 멈춘다.
#   .\lab\snapshot.ps1 -LocalEchoExperiment -Name gw-lab-v5-echo   # 실험: 터미널 local echo 만 켠 별도 스냅샷 (기본 이름·-Force 거부)
#     code-server 설정에 localEchoEnabled=on · LatencyThreshold=0 · Style=dim 세 키만 더한다 (lab/local-echo-settings.mjs, node 필요).
#     만든 뒤 수업에 쓸지는 따로 고른다 — 이 스크립트는 lab 설정·배포·기존 샌드박스를 건드리지 않는다.
# DAYTONA_API_KEY 는 User 환경변수에서 읽는다 (화면에 안 나옴). 게이트웨이를 거치지 않는다.
param(
    [string]$Name = 'gw-lab-v5',
    [string[]]$Specs = @('1/2/5', '2/4/5', '4/8/10'),
    [switch]$Force,
    [switch]$Verify,
    [switch]$LocalEchoExperiment,
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
$files = Join-Path $PSScriptRoot 'files'
function B64($f) { [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $files $f))) }
. (Join-Path $PSScriptRoot 'snapshot-resources.ps1')

# 이름·사양 검사는 맨 먼저 — 키 읽기·API 호출·node 실행 전에 전부 확인한다
$targets = Resolve-LabSnapshotPlan $Name $Specs

# 실험 플래그 검사와 설정 합치기는 키 읽기·API 호출보다 먼저 — 잘못 부르면 아무것도 안 하고 멈춘다
if ($LocalEchoExperiment) {
    if (-not $PSBoundParameters.ContainsKey('Name') -or $Name -notmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z' -or $Name -in @('gw-lab-v4', 'gw-lab-v5')) {
        throw '-LocalEchoExperiment 는 기본과 다른 -Name 을 직접 줘야 합니다 (영문·숫자·._- , 예: -Name gw-lab-v5-echo). 기본 스냅샷을 덮지 않게.'
    }
    if ($Force) { throw '-LocalEchoExperiment 와 -Force 는 같이 쓸 수 없습니다 (스냅샷을 지우고 다시 빌드하지 않는다).' }
    $codeServerSettings = & node (Join-Path $PSScriptRoot 'local-echo-settings.mjs') (Join-Path $files 'code-server-settings.json')
    if ($LASTEXITCODE -ne 0 -or $codeServerSettings -isnot [string] -or $codeServerSettings -notmatch '\A[A-Za-z0-9+/]+={0,2}\z') { throw "local echo 설정 만들기 실패 (exit $LASTEXITCODE)" }
} else {
    $codeServerSettings = B64 'code-server-settings.json'
}

if ($Plan) {
    foreach ($p in $targets) { Write-Host ("계획: {0}  cpu={1} memory={2} disk={3}" -f $p.Name, $p.Cpu, $p.Memory, $p.Disk) }
    Write-Host '(-Plan: 키를 읽거나 API 를 부르지 않았습니다)'
    return
}

$api = 'https://app.daytona.io/api'
$key = [Environment]::GetEnvironmentVariable('DAYTONA_API_KEY', 'User')
if (-not $key) { throw 'User 환경변수 DAYTONA_API_KEY 가 없습니다.' }
$h = @{ Authorization = "Bearer $key" }
function Dt($method, $path, $body) {
    $p = @{ Method = $method; Uri = "$api$path"; Headers = $h }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Depth 10) }
    Invoke-RestMethod @p
}

# 도구 버전 (올릴 때 여기만 바꾸고 -Force)
$CODE_SERVER = '4.139.1'
$CLAUDE_CODE = '2.1.284'
$OPENCODE = '1.18.33'

# COPY 할 빌드 컨텍스트가 없으므로 파일은 base64 로 Dockerfile 에 싣는다
$dockerfile = @"
FROM daytonaio/sandbox:0.9.0
USER root
ENV LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git jq zip unzip tmux \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/cs.deb https://github.com/coder/code-server/releases/download/v$CODE_SERVER/code-server_${CODE_SERVER}_amd64.deb \
 && dpkg -i /tmp/cs.deb && rm /tmp/cs.deb
RUN npm install -g @anthropic-ai/claude-code@$CLAUDE_CODE opencode-ai@$OPENCODE && npm cache clean --force
RUN echo $(B64 'lab-start') | base64 -d > /usr/local/bin/lab-start && chmod 755 /usr/local/bin/lab-start  && echo $(B64 'lab-status') | base64 -d > /usr/local/bin/lab-status && chmod 755 /usr/local/bin/lab-status \
 && echo $(B64 'lab-doctor') | base64 -d > /usr/local/bin/lab-doctor && chmod 755 /usr/local/bin/lab-doctor \
 && echo $(B64 'lab-resources') | base64 -d > /usr/local/bin/lab-resources && chmod 755 /usr/local/bin/lab-resources
USER daytona
RUN mkdir -p /home/daytona/.config/opencode /home/daytona/.local/share/code-server/User /home/daytona/work /home/daytona/.claude \
 && echo $(B64 'opencode.json') | base64 -d > /home/daytona/.config/opencode/opencode.json \
 && echo $(B64 'claude.json') | base64 -d > /home/daytona/.claude.json  && echo $(B64 'claude-settings.json') | base64 -d > /home/daytona/.claude/settings.json \
 && echo $codeServerSettings | base64 -d > /home/daytona/.local/share/code-server/User/settings.json \
 && echo $(B64 'tmux.conf') | base64 -d > /home/daytona/.tmux.conf \
 && echo $(B64 'README.md') | base64 -d > /home/daytona/work/README.md \
 && echo $(B64 'AGENTS.md') | base64 -d > /home/daytona/work/AGENTS.md \
 && echo $(B64 'CLAUDE.md') | base64 -d > /home/daytona/work/CLAUDE.md
"@

$all = @((Dt GET "/snapshots?limit=200").items)
# 지우거나 빌드하기 전에 전부 대조 — 하나라도 사양이 다르거나 상태가 이상하면 아무것도 안 하고 멈춘다
$found = @{}
foreach ($p in $targets) { $found[$p.Name] = Resolve-LabSnapshotExisting $all $p ([bool]$Force) }
foreach ($p in $targets) {
    $cpu, $mem, $disk, $sn = $p.Cpu, $p.Memory, $p.Disk, $p.Name
    $existing = $found[$sn]
    if ($existing -and $Force) {
        Write-Host "기존 $sn 삭제"
        Dt DELETE "/snapshots/$($existing.id)" | Out-Null
        for ($i = 0; $i -lt 60 -and (@((Dt GET "/snapshots?limit=200").items) | Where-Object { $_.name -ceq $sn }); $i++) { Start-Sleep 2 }
        $existing = $null
    }
    if ($existing) { Write-Host "$sn 이미 있음 (state=$($existing.state)). 다시 빌드하려면 -Force"; continue }
    Write-Host "빌드: $sn (code-server $CODE_SERVER, claude-code $CLAUDE_CODE, opencode $OPENCODE)"
    $snap = Dt POST '/snapshots' @{ name = $sn; buildInfo = @{ dockerfileContent = $dockerfile }; cpu = $cpu; memory = $mem; disk = $disk }
    $t0 = Get-Date
    while ($snap.state -notin 'active', 'error', 'build_failed') {
        Start-Sleep 5
        $snap = Dt GET "/snapshots/$($snap.id)"
        Write-Host "  $($snap.state)  $([int]((Get-Date) - $t0).TotalSeconds)s"
    }
    if ($snap.state -ne 'active') {
        try { Write-Host (Dt GET "/snapshots/$($snap.id)/build-logs") } catch {}
        throw "빌드 실패: $sn $($snap.state) $($snap.errorReason)"
    }
    Write-Host "완료: $sn" -ForegroundColor Green
}

if ($Verify) {
    $sn = $targets[0].Name
    Write-Host "`n점검: $sn 로 샌드박스 하나"
    $sb = Dt POST '/sandbox' @{ snapshot = $sn; labels = @{ 'gw-lab' = 'verify' }; env = @{ LAB_MODEL = 'deepseek/deepseek-v4.1-flash' }; autoStopInterval = 15; autoDeleteInterval = 0 }
    try {
        for ($i = 0; $i -lt 90 -and $sb.state -ne 'started'; $i++) { Start-Sleep 2; $sb = Dt GET "/sandbox/$($sb.id)"; if ($sb.state -in 'error', 'build_failed') { throw "샌드박스 $($sb.state): $($sb.errorReason)" } }
        Write-Host "  켜짐: cpu=$($sb.cpu) memory=$($sb.memory) disk=$($sb.disk)"
        $tb = @{ api = "$($sb.toolboxProxyUrl)/$($sb.id)" }
        function X($cmd) { Invoke-RestMethod "$($tb.api)/process/execute" -Method Post -Headers $h -ContentType 'application/json' -Body (@{ command = $cmd; timeout = 60 } | ConvertTo-Json) }
        foreach ($c in 'code-server --version', 'claude --version', 'opencode --version', 'bash -lc "df -h / | tail -1"', 'cat /home/daytona/.claude/settings.json', 'lab-status --line', 'bash -lc "command -v lab-doctor tmux; tmux -V; locale | head -1"') {
            $r = X $c; Write-Host "  [$($r.exitCode)] $c`n    $(($r.result -split "`n" | Select-Object -First 4) -join "`n    ")"
        }
        try { Invoke-RestMethod "$($tb.api)/process/session" -Method Post -Headers $h -ContentType 'application/json' -Body '{"sessionId":"lab"}' | Out-Null } catch {}
        Invoke-RestMethod "$($tb.api)/process/session/lab/exec" -Method Post -Headers $h -ContentType 'application/json' -Body '{"command":"lab-start","runAsync":true}' | Out-Null
        $code = ''
        for ($i = 0; $i -lt 30 -and $code -ne '200'; $i++) { Start-Sleep 2; $code = (X "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz").result.Trim() }
        Write-Host "  code-server healthz: $code" -ForegroundColor ($code -eq '200' ? 'Green' : 'Red')

        # 게이트웨이(lab.shinick.dev)가 하는 것처럼 미리보기 토큰 헤더로 연다 (토큰은 화면에 안 찍는다)
        $pv = Dt GET "/sandbox/$($sb.id)/ports/8080/preview-url"
        $st = & curl.exe -s -o NUL -w '%{http_code}' -H "x-daytona-preview-token: $($pv.token)" -H 'X-Daytona-Skip-Preview-Warning: true' "$($pv.url)/healthz"
        Write-Host "  미리보기 토큰으로 열기: $st" -ForegroundColor ($st -eq '200' ? 'Green' : 'Red')
    } finally {
        Dt DELETE "/sandbox/$($sb.id)" | Out-Null
        Write-Host '  점검 샌드박스 삭제'
    }
}
