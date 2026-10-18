<#
.SYNOPSIS
    k.shinick.dev 공급자 키 관리 CLI. 키 값은 User 환경변수에서 읽어 HTTPS 로만 보낸다 (화면·파일에 안 남음).

.DESCRIPTION
    push  : 프리셋 중 User 환경변수에 값이 있는 것들을 서버에 올린다 (없던 건 추가, 있던 건 키 교체).
            실행하면 브라우저에 승인 페이지가 열린다 → 터미널 코드와 같은지 보고 Nano 를 터치.
    list  : 서버에 저장된 공급자 목록 (끝 4자리만).

.EXAMPLE
    .\kv.ps1 push                         # 가능한 것 전부
    .\kv.ps1 push -Names tavily,openai    # 골라서
    .\kv.ps1 push -Sources TAVILY_API_KEY # 환경변수 이름으로 (~/.secrets/Set-Keys.ps1 이 키를 넣은 뒤 부른다)
    .\kv.ps1 list
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('push', 'list')][string]$Command = 'list',
    [string[]]$Names,
    [string[]]$Sources,   # 환경변수 이름으로 고르기. 공급자 틀(preset)이 없는 이름은 알려 주고 건너뛴다
    [string]$Gateway = 'https://k.shinick.dev'
)

$ErrorActionPreference = 'Stop'
$H = @{ Origin = $Gateway }

function Post($Path, $Body, $Extra = @{}) {
    Invoke-RestMethod -Method Post -Uri "$Gateway$Path" -Headers ($H + $Extra) -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress)))
}

function Get-AdminToken {
    $r = Post '/api/cli/login' @{}
    Write-Host "`n  승인 코드: " -NoNewline; Write-Host $r.code -ForegroundColor Yellow
    Write-Host "  브라우저 승인 페이지의 코드가 같은지 확인하고 보안 키를 터치하세요." -ForegroundColor DarkGray
    Start-Process $r.approveUrl
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $p = Post "/api/borrow/$($r.id)/poll" @{ secret = $r.secret }
        if ($p.status -eq 'approved') { Write-Host "  승인됨 (8시간)`n" -ForegroundColor Green; return $p.adminToken }
        if ($p.status -in 'denied', 'expired') { throw "요청이 $($p.status) 되었습니다." }
    }
    throw '10분 안에 승인되지 않았습니다.'
}

if ($Command -eq 'push') {
    $presets = Invoke-RestMethod -Uri "$Gateway/api/presets"
    if ($Sources) {
        $known = @($presets | ForEach-Object { $_.source })
        foreach ($s in $Sources | Where-Object { $_ -notin $known }) { Write-Host "  - $s  (금고에 공급자 틀이 없음 — 필요하면 /admin 에서 공급자로 추가)" -ForegroundColor DarkGray }
        $presets = @($presets | Where-Object { $_.source -in $Sources })
    }
    $todo = foreach ($p in $presets) {
        if ($Names -and $p.id -notin $Names) { continue }
        $v = [Environment]::GetEnvironmentVariable($p.source, 'User')
        if ([string]::IsNullOrWhiteSpace($v)) { Write-Host "  - $($p.id)  ($($p.source) 없음, 건너뜀)" -ForegroundColor DarkGray; continue }
        [pscustomobject]@{ Preset = $p; Source = $p.source }
    }
    if (-not $todo) { Write-Host '올릴 것이 없습니다.' -ForegroundColor Yellow; return }
    Write-Host "올릴 공급자: $(($todo | ForEach-Object { $_.Preset.id }) -join ', ')"
    $A = @{ 'x-admin-token' = (Get-AdminToken) }
    foreach ($t in $todo) {
        try {
            # 값은 변수에만 잠깐 있고, 출력하지 않는다
            $r = Post '/api/admin/provider' @{ preset = $t.Preset.id; value = [Environment]::GetEnvironmentVariable($t.Source, 'User') } $A
            Write-Host "  + $($r.provider.label) ($($r.provider.id))  …$($r.provider.last4)" -ForegroundColor Green
        } catch {
            $msg = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
            Write-Host "  x $($t.Preset.id): $msg" -ForegroundColor Red
        }
    }
    return
}

if ($Command -eq 'list') {
    $A = @{ 'x-admin-token' = (Get-AdminToken) }
    (Post '/api/admin/list' @{} $A).providers |
        Select-Object id, label, kind, auth, @{ n = 'key'; e = { '…' + $_.last4 } }, @{ n = 'updated'; e = { [DateTimeOffset]::FromUnixTimeMilliseconds($_.updatedAt).LocalDateTime } } |
        Format-Table -AutoSize
}
