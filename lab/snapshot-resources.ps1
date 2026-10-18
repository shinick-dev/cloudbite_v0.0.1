# lab/snapshot.ps1 의 이름·사양 검사 (순수 함수 — 키·네트워크·파일 쓰기 없음). snapshot.ps1 이 키를 읽기 전에 dot-source 한다.
#   사양 문자열 '<cpu>/<memory GiB>/<disk GiB>' 은 0 으로 시작하지 않는 10진 양의 정수 셋 (부호·소수·공백·줄바꿈·변환 없음).
#   상한 2147483647 은 [int] 파싱 한도일 뿐 Daytona 한도가 아니다 — 실제 한도는 조직 설정이고 Daytona 가 거부한다.
#   이름: 예전 사양 1/2/5 · 2/4/5 · 4/8/10 은 <Name>-<cpu>c<memory>g 그대로, 그 밖은 <Name>-<cpu>c<memory>g<disk>d.
#   접미사에 '-' 가 없으므로 (Name, 사양) → 스냅샷 이름은 하나로만 나온다. 만든 이름은 120자까지 (앱이 정한 상한, Daytona 한도 추정 아님).
$script:LabSnapshotNameMax = 120
$script:LabLegacySpecs = @('1/2/5', '2/4/5', '4/8/10')

function ConvertTo-LabSnapshotSpec([object]$Spec) {
    $m = if ($Spec -is [string]) { [regex]::Match($Spec, '\A([1-9][0-9]{0,9})/([1-9][0-9]{0,9})/([1-9][0-9]{0,9})\z', [Text.RegularExpressions.RegexOptions]::CultureInvariant) }
    if (-not $m -or -not $m.Success) {
        throw "사양 '$Spec' 이 잘못됐습니다: '<cpu>/<memory GiB>/<disk GiB>' 처럼 0 으로 시작하지 않는 양의 정수 셋 (예: 2/8/10)."
    }
    $n = @(1, 2, 3 | ForEach-Object { [long]::Parse($m.Groups[$_].Value, [Globalization.CultureInfo]::InvariantCulture) })
    if (@($n | Where-Object { $_ -gt [int]::MaxValue }).Count) { throw "사양 '$Spec' 의 값이 2147483647 을 넘습니다." }
    $key = '{0}/{1}/{2}' -f $n[0], $n[1], $n[2]
    $suffix = if ($script:LabLegacySpecs -ccontains $key) { '{0}c{1}g' -f $n[0], $n[1] } else { '{0}c{1}g{2}d' -f $n[0], $n[1], $n[2] }
    [pscustomobject]@{ Spec = $key; Cpu = [int]$n[0]; Memory = [int]$n[1]; Disk = [int]$n[2]; Suffix = $suffix }
}

# 전부 검사한 뒤에만 계획을 돌려준다 — 하나라도 잘못되면 throw (아무것도 안 함)
function Resolve-LabSnapshotPlan([object]$Name, [object[]]$Specs) {
    if ($Name -isnot [string] -or $Name -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z') {
        throw "-Name '$Name' 이 잘못됐습니다: 영문·숫자로 시작하고 영문·숫자·._- 만 (예: gw-lab-custom)."
    }
    if ($null -eq $Specs -or $Specs.Count -eq 0) { throw '-Specs 가 비었습니다 (예: -Specs 2/8/10).' }
    $plan = @(foreach ($s in $Specs) {
            $p = ConvertTo-LabSnapshotSpec $s
            $sn = "$Name-$($p.Suffix)"
            if ($sn.Length -gt $script:LabSnapshotNameMax) { throw "스냅샷 이름 '$sn' 이 $($script:LabSnapshotNameMax)자를 넘습니다 — -Name 을 줄이세요." }
            [pscustomobject]@{ Name = $sn; Spec = $p.Spec; Cpu = $p.Cpu; Memory = $p.Memory; Disk = $p.Disk }
        })
    $dupSpec = @($plan | Group-Object -CaseSensitive Spec | Where-Object Count -gt 1)
    if ($dupSpec.Count) { throw "-Specs 에 같은 사양이 두 번 있습니다: $($dupSpec[0].Name)" }
    $dupName = @($plan | Group-Object -CaseSensitive Name | Where-Object Count -gt 1)
    if ($dupName.Count) { throw "같은 스냅샷 이름이 두 번 나옵니다: $($dupName[0].Name)" }
    , $plan
}

function Test-LabWholeNumber([object]$Value, [long]$Expected) {
    ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and $Value -eq $Expected
}

# 목록($All)에서 계획 한 줄($Entry)과 같은 이름의 스냅샷을 찾는다. 없으면 $null.
# 지우거나 빌드하기 전에 부른다: 대소문자만 다른 이름·같은 이름 여럿·사양(cpu/메모리/디스크) 불일치는 -Force 여도 throw,
# active 가 아닌데 -Force 가 없으면 throw ("이미 있음" 으로 넘어가지 않게).
function Resolve-LabSnapshotExisting([object[]]$All, [object]$Entry, [bool]$Force) {
    $same = @($All | Where-Object { $_.name -is [string] -and $_.name -ieq $Entry.Name })
    if (@($same | Where-Object { $_.name -cne $Entry.Name }).Count) { throw "$($Entry.Name): 대소문자만 다른 스냅샷이 이미 있습니다 — 다른 -Name 을 쓰세요." }
    if ($same.Count -gt 1) { throw "$($Entry.Name): 같은 이름의 스냅샷이 여럿입니다 — Daytona 에서 확인하세요." }
    if ($same.Count -eq 0) { return $null }
    $e = $same[0]
    $props = @($e.PSObject.Properties.Name)
    $memKeys = @('mem', 'memory' | Where-Object { $props -ccontains $_ })
    $ok = (Test-LabWholeNumber $e.cpu $Entry.Cpu) -and (Test-LabWholeNumber $e.disk $Entry.Disk) -and $memKeys.Count -gt 0 -and
        @($memKeys | Where-Object { -not (Test-LabWholeNumber $e.$_ $Entry.Memory) }).Count -eq 0
    if (-not $ok) {
        $have = 'cpu={0} memory={1} disk={2}' -f $e.cpu, $(if ($props -ccontains 'mem') { $e.mem } else { $e.memory }), $e.disk
        throw "$($Entry.Name): 이미 있는 스냅샷 사양($have)이 요청($($Entry.Spec))과 다릅니다. -Force 로도 지우지 않습니다 — Daytona 에서 확인하거나 다른 -Name 을 쓰세요."
    }
    if ($e.state -cne 'active' -and -not $Force) { throw "$($Entry.Name): 이미 있지만 active 가 아닙니다 (state=$($e.state)). 다시 빌드하려면 -Force." }
    $e
}
