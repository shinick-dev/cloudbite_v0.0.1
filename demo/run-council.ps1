# Cloudbite - 실제 Daytona 샌드박스 전문가 실행 데모
#
#   .\demo\run-council.ps1
#   .\demo\run-council.ps1 -Keep
#
# 역할마다 독립 샌드박스를 만들고, 그 안에서 분석을 실행한 뒤 결과를 집계한다.
# 산출물: demo/evidence.json

param(
  [string]$Brief = "100명의 AI 전문가 자문 서비스를 이번 분기에 출시할지 결정한다.",
  [string]$Snapshot = "daytona-small",
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$runId = -join ((48..57) + (97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$experts = @(
  @{ role = "product";  name = "제품 전략가"; focus = "시장 적합성과 출시 시점" },
  @{ role = "security"; name = "보안 책임자"; focus = "자격증명과 샌드박스 격리 위험" },
  @{ role = "pricing";  name = "가격 분석가"; focus = "원가 구조와 지불 의향" }
)

Write-Host "`nCloudbite . Daytona 병렬 전문가 실행" -ForegroundColor Green
Write-Host "brief: $Brief"
Write-Host "snapshot: $Snapshot`n"

$results = @()

foreach ($expert in $experts) {
  $sandbox = "council-$($expert.role)-$runId"

  $sw = [Diagnostics.Stopwatch]::StartNew()
  daytona sandbox create --name $sandbox --snapshot $Snapshot --auto-stop 20 2>&1 | Out-Null
  $createdMs = [int]$sw.ElapsedMilliseconds

  $expertJson = ($expert | ConvertTo-Json -Compress) -replace "'", "\'"

  $python = @"
import json, hashlib, platform
expert = json.loads(r'''$expertJson''')
brief = r'''$Brief'''
payload = (expert["role"] + "|" + brief).encode()
seed = int(hashlib.sha256(payload).hexdigest()[:8], 16)
risk_terms = ["위험", "실패", "규제", "비용", "보안", "경쟁"]
hits = sum(brief.count(t) for t in risk_terms)
base = 0.55 + ((seed % 30) / 100.0)
confidence = round(min(0.95, max(0.35, base - hits * 0.03)), 3)
stance = "support" if confidence >= 0.7 else ("conditional" if confidence >= 0.55 else "concern")
print(json.dumps({
    "role": expert["role"], "name": expert["name"], "focus": expert["focus"],
    "stance": stance, "confidence": confidence,
    "host": platform.node(), "python": platform.python_version(),
    "brief_chars": len(brief), "risk_hits": hits,
    "first_action": expert["focus"] + " 관점에서 2주 파일럿 검증",
}, ensure_ascii=True))
"@

  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($python))
  $bash = "python3 - <<'PY'`nimport base64`nexec(base64.b64decode('$b64').decode('utf-8'))`nPY"

  $sw.Restart()
  $raw = daytona sandbox exec $sandbox -- bash -c $bash 2>&1
  $execMs = [int]$sw.ElapsedMilliseconds

  $line = $raw | Where-Object { $_.ToString().TrimStart().StartsWith("{") } | Select-Object -Last 1
  if (-not $line) { throw "JSON 출력 없음 (sandbox=$sandbox): $($raw -join ' | ')" }
  $r = $line | ConvertFrom-Json

  $result = [ordered]@{
    role = $r.role; name = $r.name; focus = $r.focus
    stance = $r.stance; confidence = $r.confidence
    host = $r.host; python = $r.python
    brief_chars = $r.brief_chars; risk_hits = $r.risk_hits
    first_action = $r.first_action
    sandbox = $sandbox; createdMs = $createdMs; execMs = $execMs; cleaned = $false
  }

  if (-not $Keep) {
    try { daytona sandbox delete $sandbox 2>&1 | Out-Null; $result.cleaned = $true } catch { }
  }

  $results += [pscustomobject]$result
  Write-Host ("  {0,-12} {1,-12} conf={2}  sandbox={3}ms exec={4}ms  {5}" -f `
      $r.name, $r.stance, $r.confidence, $createdMs, $execMs, $sandbox)
}

$mean = [math]::Round((($results | Measure-Object -Property confidence -Average).Average), 3)
$stances = $results | Group-Object stance | ForEach-Object { @{ $_.Name = $_.Count } }

Write-Host "`n  평균 확신도 $mean"
Write-Host ("  실제 원격 실행 {0}건 ({1})" -f $results.Count, (($results | ForEach-Object { $_.host }) -join ", "))

$evidence = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  mode = "live-daytona"
  snapshot = $Snapshot
  brief = $Brief
  meanConfidence = $mean
  stanceCount = $stances
  results = $results
}
$outPath = Join-Path $PSScriptRoot "evidence.json"
$evidence | ConvertTo-Json -Depth 6 | Set-Content -Path $outPath -Encoding utf8
Write-Host "`n  evidence -> demo/evidence.json`n"

