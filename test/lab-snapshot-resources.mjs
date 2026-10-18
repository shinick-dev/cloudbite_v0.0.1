// lab/snapshot.ps1 사용자 사양(-Specs) 검사·이름 규칙 회귀 테스트. Daytona 키·네트워크·빌드 없음:
//   - 순수 도우미(lab/snapshot-resources.ps1)를 pwsh 에서 dot-source 해 파서·이름·중복·기존 스냅샷 대조를 본다
//   - 진짜 snapshot.ps1 은 -Plan 으로만 실행한다 (키 읽기 전에 끝남)
//   - -Plan 이 아닌 경로는 임시 폴더에 복사본을 만들어 키 읽기를 가짜 함수로 바꾸고 Invoke-RestMethod·node·Start-Sleep 을
//     가짜 함수로 가린 뒤 돌린다 (함수가 cmdlet 보다 먼저 잡힌다). 호출은 기록만 하고 밖으로 안 나간다
//   - 진단 패키징 변경만 허용하며 기존 Dockerfile 설정·실습실 보안 설정은 베이스(33d3751)와 같다
//   node test/lab-snapshot-resources.mjs

import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAB = join(ROOT, 'lab');
const SNAPSHOT = join(LAB, 'snapshot.ps1');
const HELPER = join(LAB, 'snapshot-resources.ps1');
const BASE_REV = '33d3751aff0a1004da78412b00989fffd8dceffd';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 600)}`); }
};
const skip = (name, why) => { skipN++; console.log(`  skip ${name} (${why})`); };

const BOM = String.fromCharCode(0xfeff);
const work = mkdtempSync(join(tmpdir(), 'lab-snapshot-resources-'));
const pwshOk = spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0;
const writePs = (name, text) => { const f = join(work, name); writeFileSync(f, BOM + text); return f; };
const pwsh = (file, ...args) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file, ...args], { encoding: 'utf8', env: { ...process.env, ...(pwsh.env ?? {}) } });

// 인자를 JSON 으로 받아 스플랫한다 (-File 은 배열·특수 문자를 그대로 못 넘긴다)
const RUNNER = writePs('runner.ps1', String.raw`
param([string]$Target, [string]$ArgsJson)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$a = $ArgsJson | ConvertFrom-Json -AsHashtable
if ($a.ContainsKey('Specs') -and $null -ne $a.Specs) { $a.Specs = [string[]]@($a.Specs) }
try { & $Target @a; Write-Host 'EXIT:OK' } catch { Write-Host ('EXIT:THROW ' + $_.Exception.Message) }
`);
const runScript = (target, args, env = {}) => {
  pwsh.env = env;
  const r = pwsh(RUNNER, '-Target', target, '-ArgsJson', JSON.stringify(args));
  pwsh.env = null;
  const out = r.stdout ?? '';
  const m = /EXIT:(OK|THROW)(.*)/.exec(out);
  return { out, err: r.stderr, ok: m?.[1] === 'OK', threw: m?.[1] === 'THROW', message: (m?.[2] ?? '').trim(),
    plan: [...out.matchAll(/계획: (\S+)  cpu=(\d+) memory=(\d+) disk=(\d+)/g)].map((x) => ({ name: x[1], cpu: +x[2], memory: +x[3], disk: +x[4] })) };
};

try {
  console.log('정적');
  {
    const src = readFileSync(SNAPSHOT, 'utf8');
    const helper = readFileSync(HELPER, 'utf8');
    check('snapshot.ps1 UTF-8 BOM·CRLF 유지', src.charCodeAt(0) === 0xfeff && !/[^\r]\n/.test(src));
    check('도우미 UTF-8 BOM', helper.charCodeAt(0) === 0xfeff);
    check('도우미에 키·네트워크·파일 쓰기 없음', !/DAYTONA_API_KEY|GetEnvironmentVariable|Invoke-RestMethod|Invoke-WebRequest|curl|\bDt\b|Set-Content|Out-File|Add-Content|WriteAll|New-Item|Remove-Item|Start-Process|\bnode\b/.test(helper));
    let baseSrc = null;
    try { baseSrc = execFileSync('git', ['-C', ROOT, 'show', `${BASE_REV}:lab/snapshot.ps1`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
    if (baseSrc === null) skip('기본 Dockerfile 이 베이스와 바이트가 같음', 'git 베이스 커밋을 못 읽음');
    else {
      const df = (s) => /\$dockerfile = @"[\s\S]*?\n"@/.exec(s)?.[0];
      const withoutDiagnostics = (s) => s
        .replace(/ && echo \$\(B64 'lab-doctor'\) \| base64 -d > \/usr\/local\/bin\/lab-doctor && chmod 755 \/usr\/local\/bin\/lab-doctor \\\r?\n && echo \$\(B64 'lab-resources'\) \| base64 -d > \/usr\/local\/bin\/lab-resources && chmod 755 \/usr\/local\/bin\/lab-resources/, " && echo $(B64 'lab-doctor') | base64 -d > /usr/local/bin/lab-doctor && chmod 755 /usr/local/bin/lab-doctor")
        .replace(/ && echo \$\(B64 'README.md'\) \| base64 -d > \/home\/daytona\/work\/README.md \\\r?\n && echo \$\(B64 'AGENTS.md'\) \| base64 -d > \/home\/daytona\/work\/AGENTS.md \\\r?\n && echo \$\(B64 'CLAUDE.md'\) \| base64 -d > \/home\/daytona\/work\/CLAUDE.md/, " && echo $(B64 'README.md') | base64 -d > /home/daytona/work/README.md");
      check('진단 패키징 외 Dockerfile 바이트 동일', df(baseSrc) && df(baseSrc) === withoutDiagnostics(df(src)));
      const filesDiff = spawnSync('git', ['-C', ROOT, 'diff', '--name-only', BASE_REV, '--', 'lab/files', 'lab/local-echo-settings.mjs'], { encoding: 'utf8' });
      const allowed = new Set(['lab/files/lab-status', 'lab/files/lab-doctor', 'lab/files/README.md', 'lab/files/lab-resources', 'lab/files/AGENTS.md', 'lab/files/CLAUDE.md', 'lab/files/code-server-settings.json']);
      check('진단 변경 외 기존 lab 설정·local echo 바이트 동일', filesDiff.status === 0 && filesDiff.stdout.trim().split(/\r?\n/).filter(Boolean).every(p => allowed.has(p)), filesDiff.stdout);
      const oldSettings = JSON.parse(execFileSync('git', ['-C', ROOT, 'show', `${BASE_REV}:lab/files/code-server-settings.json`], { encoding: 'utf8' }));
      oldSettings['terminal.integrated.profiles.linux']['공유 터미널 (모임지기와 같이 보기)'] = oldSettings['terminal.integrated.profiles.linux']['공유 터미널 (강사와 같이 보기)'];
      delete oldSettings['terminal.integrated.profiles.linux']['공유 터미널 (강사와 같이 보기)'];
      const newSettings = JSON.parse(readFileSync(join(LAB, 'files', 'code-server-settings.json'), 'utf8'));
      const lessonProfile = newSettings['terminal.integrated.profiles.linux']['수업 따라보기 (모임지기와 함께 보기)'];
      delete newSettings['terminal.integrated.profiles.linux']['수업 따라보기 (모임지기와 함께 보기)'];
      check('수업 따라보기 프로필 추가·모임지기 표기 외 기존 설정 유지', JSON.stringify(newSettings) === JSON.stringify(oldSettings)
        && JSON.stringify(lessonProfile) === JSON.stringify({ path: 'tmux', args: ['-u', 'attach', '-r', '-t', 'gw-lesson'], icon: 'live-share' }));
    }
    check('local echo 보호 그대로 (새·구 기본 이름 거부·-Force 거부)', src.includes(String.raw`$Name -notmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z' -or $Name -in @('gw-lab-v4', 'gw-lab-v5')`) && src.includes(`if ($Force) { throw '-LocalEchoExperiment 와 -Force 는 같이 쓸 수 없습니다`));
    const at = (re) => src.search(re);
    const v = at(/\$targets = Resolve-LabSnapshotPlan \$Name \$Specs/);
    check('검사 < local echo node 실행 < 키 읽기 < 첫 API', v > 0 && v < at(/& node /) && v < at(/DAYTONA_API_KEY', 'User'\)/) && v < at(/\(Dt GET/), v);
    check('-Plan 은 키 읽기 전에 return', at(/if \(\$Plan\) \{[\s\S]*?return\s*\}/) > v && at(/if \(\$Plan\) \{/) < at(/DAYTONA_API_KEY', 'User'\)/));
    check('대조(Resolve-LabSnapshotExisting)가 첫 DELETE·POST 보다 먼저, 전부 돈 뒤', at(/foreach \(\$p in \$targets\) \{ \$found\[/) > 0 && at(/foreach \(\$p in \$targets\) \{ \$found\[/) < at(/Dt DELETE "\/snapshots/) && at(/foreach \(\$p in \$targets\) \{ \$found\[/) < at(/Dt POST '\/snapshots'/));
    check('-Verify 는 검사한 첫 이름을 쓴다', /\$sn = \$targets\[0\]\.Name/.test(src) && !/\$Specs\[0\]/.test(src));
  }

  if (!pwshOk) { skip('pwsh 검사 전부', 'pwsh 없음'); throw null; }

  console.log('도우미 (pwsh, 순수 함수)');
  {
    const probe = writePs('probe.ps1', String.raw`
param([string]$Helper, [string]$CasesJson)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
. $Helper
$out = foreach ($c in ($CasesJson | ConvertFrom-Json -AsHashtable)) {
  try {
    if ($c.kind -eq 'plan') {
      $specs = if ($null -eq $c.specs) { $null } else { [object[]]@($c.specs | ForEach-Object { if ($_ -is [hashtable] -and $_.int) { [int]$_.int } else { $_ } }) }
      $r = Resolve-LabSnapshotPlan $c.name $specs
      [ordered]@{ id = $c.id; ok = $true; value = @($r | ForEach-Object { [ordered]@{ name = $_.Name; spec = $_.Spec; cpu = $_.Cpu; memory = $_.Memory; disk = $_.Disk } }) }
    } else {
      $all = @($c.all | ForEach-Object { [pscustomobject]$_ })
      $entry = (Resolve-LabSnapshotPlan $c.name @($c.spec))[0]
      $r = Resolve-LabSnapshotExisting $all $entry ([bool]$c.force)
      [ordered]@{ id = $c.id; ok = $true; value = $(if ($r) { $r.id } else { $null }) }
    }
  } catch { [ordered]@{ id = $c.id; ok = $false; message = $_.Exception.Message } }
}
@($out) | ConvertTo-Json -Depth 6 -Compress
`);
    const cases = [];
    const plan = (id, name, specs) => cases.push({ kind: 'plan', id, name, specs });
    const ex = (id, all, { name = 'n', spec = '2/8/10', force = false } = {}) => cases.push({ kind: 'existing', id, name, spec, force, all });

    // 받는 것
    plan('legacy', 'gw-lab-v4', ['1/2/5', '2/4/5', '4/8/10']);
    plan('custom', 'gw-lab-custom', ['2/8/10']);
    plan('custom2', 'base', ['2/4/10', '1/2/10', '4/8/5', '1/1/1']);
    plan('max', 'm', ['2147483647/2147483647/2147483647']);
    const n120 = 'a'.repeat(120 - '-2c8g10d'.length);
    plan('len120', n120, ['2/8/10']);
    // 거부: 사양
    const badSpecs = { empty: '', lead: ' 1/2/5', trail: '1/2/5 ', lf: '1/2/5\n', crlf: '1/2/5\r\n', zeroPad: '01/2/5', plus: '+1/2/5', neg: '-1/2/5',
      float: '1.0/2/5', exp: '1e3/2/5', hex: '0x1/2/5', zero: '0/2/5', zeroDisk: '1/2/0', two: '1/2', four: '1/2/5/6', doubleSlash: '1//5', comma: '1,2,5',
      tab: '1/\t2/5', over: '2147483648/1/1', huge: '99999999999/1/1', arabic: '١/2/5', fullwidth: '１/2/5', fwSlash: '1／2／5', nbsp: '1/2/5 ' };
    for (const [k, s] of Object.entries(badSpecs)) plan(`badSpec:${k}`, 'n', [s]);
    plan('badSpec:null', 'n', [null]);
    plan('badSpec:int', 'n', [{ int: 5 }]);
    plan('badSpec:oneBad', 'n', ['1/2/5', '2/8/x']);
    plan('emptyArray', 'n', []);
    plan('nullArray', 'n', null);
    plan('dupSpec', 'n', ['2/8/10', '2/8/10']);
    plan('dupLegacy', 'n', ['1/2/5', '1/2/5']);
    // 거부: 이름
    const badNames = { empty: '', dash: '-x', dot: '.x', space: 'a b', slash: 'a/b', lf: 'gw-lab\n', crlf: 'gw-lab\r\n', umlaut: 'ä', kelvin: 'gw-K', fullwidth: 'gwａ', colon: 'a:b', tooLong: n120 + 'a' };
    for (const [k, n] of Object.entries(badNames)) plan(`badName:${k}`, n, ['2/8/10']);

    // 기존 스냅샷 대조
    const snap = (o) => ({ id: 'old', name: 'n-2c8g10d', state: 'active', cpu: 2, mem: 8, disk: 10, ...o });
    ex('ex:none', [{ id: 'x', name: 'other', state: 'active', cpu: 2, mem: 8, disk: 10 }]);
    ex('ex:match', [snap()]);
    ex('ex:matchMemory', [(({ mem, ...r }) => ({ ...r, memory: 8 }))(snap())]);
    ex('ex:matchBoth', [snap({ memory: 8 })]);
    ex('ex:matchDouble', [snap({ cpu: 2.0 })]);
    ex('ex:diskMismatch', [snap({ disk: 5 })]);
    ex('ex:diskMismatchForce', [snap({ disk: 5 })], { force: true });
    ex('ex:memMismatchForce', [snap({ mem: 4 })], { force: true });
    ex('ex:bothMemDisagree', [snap({ memory: 4 })], { force: true });
    ex('ex:cpuString', [snap({ cpu: '2' })], { force: true });
    ex('ex:cpuFraction', [snap({ cpu: 2.5 })], { force: true });
    ex('ex:noMem', [(({ mem, ...r }) => r)(snap())], { force: true });
    ex('ex:noDisk', [(({ disk, ...r }) => r)(snap())], { force: true });
    ex('ex:legacyNameWrongDisk', [{ id: 'old', name: 'gw-lab-v4-1c2g', state: 'active', cpu: 1, mem: 2, disk: 10 }], { name: 'gw-lab-v4', spec: '1/2/5', force: true });
    ex('ex:pending', [snap({ state: 'pending' })]);
    ex('ex:error', [snap({ state: 'error' })]);
    ex('ex:errorForce', [snap({ state: 'error' })], { force: true });
    ex('ex:caseOnly', [snap({ name: 'N-2c8g10d' })], { force: true });
    ex('ex:twoSame', [snap(), snap({ id: 'old2' })], { force: true });

    const r = pwsh(probe, '-Helper', HELPER, '-CasesJson', JSON.stringify(cases));
    let out = null;
    try { out = JSON.parse(r.stdout); } catch {}
    check('pwsh 도우미 프로브 동작', Array.isArray(out) && out.length === cases.length, r.stderr || r.stdout);
    const res = Object.fromEntries((out ?? []).map((x) => [x.id, x]));
    const names = (id) => (res[id]?.value ?? []).map((x) => x.name);

    check('예전 세 사양은 이름 그대로 (<Name>-<cpu>c<mem>g)', JSON.stringify(names('legacy')) === JSON.stringify(['gw-lab-v4-1c2g', 'gw-lab-v4-2c4g', 'gw-lab-v4-4c8g']), JSON.stringify(res.legacy));
    check('사용자 사양 2/8/10 → gw-lab-custom-2c8g10d, 숫자 그대로', res.custom?.ok && JSON.stringify(res.custom.value) === JSON.stringify([{ name: 'gw-lab-custom-2c8g10d', spec: '2/8/10', cpu: 2, memory: 8, disk: 10 }]), JSON.stringify(res.custom));
    check('예전과 cpu/mem 이 같아도 디스크가 다르면 디스크까지 (충돌 없음)', JSON.stringify(names('custom2')) === JSON.stringify(['base-2c4g10d', 'base-1c2g10d', 'base-4c8g5d', 'base-1c1g1d']), JSON.stringify(res.custom2));
    check('Int32 최대 2147483647 통과', res.max?.ok && res.max.value[0].cpu === 2147483647 && res.max.value[0].disk === 2147483647, JSON.stringify(res.max));
    check('만든 이름 120자 통과', res.len120?.ok && res.len120.value[0].name.length === 120, JSON.stringify(res.len120));
    for (const k of [...Object.keys(badSpecs), 'null', 'int', 'oneBad']) check(`거부: 사양 ${k}`, res[`badSpec:${k}`]?.ok === false && /사양|-Specs/.test(res[`badSpec:${k}`].message), JSON.stringify(res[`badSpec:${k}`]));
    check('거부: 빈 -Specs', res.emptyArray?.ok === false && /-Specs/.test(res.emptyArray.message), JSON.stringify(res.emptyArray));
    check('거부: -Specs $null', res.nullArray?.ok === false, JSON.stringify(res.nullArray));
    check('거부: 같은 사양 두 번', res.dupSpec?.ok === false && /두 번/.test(res.dupSpec.message) && res.dupLegacy?.ok === false, JSON.stringify([res.dupSpec, res.dupLegacy]));
    for (const k of Object.keys(badNames)) check(`거부: 이름 ${k}`, res[`badName:${k}`]?.ok === false && /-Name|120/.test(res[`badName:${k}`].message), JSON.stringify(res[`badName:${k}`]));

    check('기존 없음 → $null', res['ex:none']?.ok && res['ex:none'].value === null, JSON.stringify(res['ex:none']));
    for (const k of ['ex:match', 'ex:matchMemory', 'ex:matchBoth', 'ex:matchDouble']) check(`기존 일치 → 그 스냅샷 (${k})`, res[k]?.ok && res[k].value === 'old', JSON.stringify(res[k]));
    for (const k of ['ex:diskMismatch', 'ex:diskMismatchForce', 'ex:memMismatchForce', 'ex:bothMemDisagree', 'ex:cpuString', 'ex:cpuFraction', 'ex:noMem', 'ex:noDisk', 'ex:legacyNameWrongDisk']) {
      check(`사양 불일치 거부, -Force 여도 (${k})`, res[k]?.ok === false && /다릅니다/.test(res[k].message), JSON.stringify(res[k]));
    }
    check('active 아님 → 거부 (pending·error)', res['ex:pending']?.ok === false && /active/.test(res['ex:pending'].message) && res['ex:error']?.ok === false, JSON.stringify([res['ex:pending'], res['ex:error']]));
    check('active 아님 + -Force → 다시 빌드 대상', res['ex:errorForce']?.ok && res['ex:errorForce'].value === 'old', JSON.stringify(res['ex:errorForce']));
    check('대소문자만 다른 이름 거부', res['ex:caseOnly']?.ok === false && /대소문자/.test(res['ex:caseOnly'].message), JSON.stringify(res['ex:caseOnly']));
    check('같은 이름 여럿 거부', res['ex:twoSame']?.ok === false, JSON.stringify(res['ex:twoSame']));
  }

  console.log('snapshot.ps1 -Plan (진짜 스크립트, 키 읽기 전에 끝남)');
  {
    const d = runScript(SNAPSHOT, { Plan: true });
    check('기본: 세 이름·사양', d.ok && JSON.stringify(d.plan) === JSON.stringify([
      { name: 'gw-lab-v5-1c2g', cpu: 1, memory: 2, disk: 5 }, { name: 'gw-lab-v5-2c4g', cpu: 2, memory: 4, disk: 5 }, { name: 'gw-lab-v5-4c8g', cpu: 4, memory: 8, disk: 10 }]), d.out + d.err);
    const c = runScript(SNAPSHOT, { Plan: true, Name: 'gw-lab-custom', Specs: ['2/8/10', '2/4/5'] });
    check('사용자 사양', c.ok && JSON.stringify(c.plan) === JSON.stringify([{ name: 'gw-lab-custom-2c8g10d', cpu: 2, memory: 8, disk: 10 }, { name: 'gw-lab-custom-2c4g', cpu: 2, memory: 4, disk: 5 }]), c.out + c.err);
    for (const [label, args] of [['잘못된 사양', { Specs: ['2/8/1.5'] }], ['빈 사양', { Specs: [] }], ['중복', { Specs: ['2/8/10', '2/8/10'] }], ['잘못된 이름', { Name: 'a b' }], ['null 사양', { Specs: [null] }], ['빈 문자열 사양', { Specs: ['2/8/10', ''] }], ['이름 끝 LF', { Name: 'gw-lab\n' }]]) {
      const r = runScript(SNAPSHOT, { Plan: true, ...args });
      check(`거부: ${label} (계획 출력 없음)`, r.threw && r.plan.length === 0, r.out + r.err);
    }
    const le = runScript(SNAPSHOT, { Plan: true, LocalEchoExperiment: true });
    check('local echo: 기본 이름은 -Plan 이어도 거부', le.threw && /-Name/.test(le.message), le.out);
    const lef = runScript(SNAPSHOT, { Plan: true, LocalEchoExperiment: true, Name: 'gw-lab-v4-echo', Force: true });
    check('local echo: -Force 는 -Plan 이어도 거부', lef.threw && /-Force/.test(lef.message) && lef.plan.length === 0, lef.out);
  }

  console.log('snapshot.ps1 복사본 + 가짜 Daytona (키·네트워크 없음)');
  {
    const sbx = join(work, 'lab');
    cpSync(LAB, sbx, { recursive: true });
    const copy = join(sbx, 'snapshot.ps1');
    let s = readFileSync(copy, 'utf8');
    const KEY = "[Environment]::GetEnvironmentVariable('DAYTONA_API_KEY', 'User')";
    const ANCHOR = "$ErrorActionPreference = 'Stop'\r\n";
    const STUBS = String.raw`
function Test-Log([string]$line) { Add-Content -LiteralPath $env:GW_SNAP_LOG -Value $line -Encoding utf8 }
function Get-StubKey { Test-Log 'KEY'; 'stub-key' }
function node { Test-Log 'NODE'; $global:LASTEXITCODE = 0; 'QUJD' }
function Start-Sleep { }
function curl.exe { Test-Log 'CURL'; '000' }
function Invoke-RestMethod {
  param($Uri, $Method = 'GET', $Headers, $ContentType, $Body)
  Test-Log ("API $Method $Uri " + $(if ($Body) { ($Body | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 5) } else { '' }))
  $fx = $env:GW_SNAP_FIXTURE
  $items = @(Get-Content -LiteralPath $fx -Raw | ConvertFrom-Json)
  if ($Uri -notlike 'https://app.daytona.io/api/*') { throw "stub: unexpected $Uri" }
  $path = $Uri.Substring('https://app.daytona.io/api'.Length)
  if ($Method -eq 'GET' -and $path -eq '/snapshots?limit=200') { return [pscustomobject]@{ items = $items } }
  if ($Method -eq 'DELETE' -and $path -like '/snapshots/*') { $id = $path.Substring(11); ConvertTo-Json -InputObject @($items | Where-Object { $_.id -ne $id }) -Depth 5 | Set-Content -LiteralPath $fx -Encoding utf8; return $null }
  if ($Method -eq 'POST' -and $path -eq '/snapshots') { return [pscustomobject]@{ id = 'new'; state = 'active' } }
  if ($Method -eq 'GET' -and $path -like '/snapshots/*') { return [pscustomobject]@{ id = 'new'; state = 'active' } }
  if ($Method -eq 'POST' -and $path -eq '/sandbox') { throw 'stub: verify stops here' }
  if ($Method -eq 'DELETE' -and $path -like '/sandbox/*') { return $null }
  throw "stub: unexpected $Method $path"
}
`.replace(/\n/g, '\r\n');
    const okRewrite = s.split(KEY).length === 2 && s.split(ANCHOR).length === 2;
    s = s.replace(KEY, 'Get-StubKey').replace(ANCHOR, ANCHOR + STUBS);
    writeFileSync(copy, s);
    check('복사본: 키 읽기를 가짜로 바꿈 (원본 한 곳)', okRewrite && !s.includes('GetEnvironmentVariable'));
    if (okRewrite) {
      let n = 0;
      const run = (args, fixture) => {
        const log = join(work, `log${++n}.txt`), fx = join(work, `fx${n}.json`);
        writeFileSync(log, ''); writeFileSync(fx, JSON.stringify(fixture));
        const r = runScript(copy, args, { GW_SNAP_LOG: log, GW_SNAP_FIXTURE: fx });
        const lines = readFileSync(log, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
        return { ...r, lines, api: lines.filter((l) => l.startsWith('API ')), mutations: lines.filter((l) => /^API (POST|DELETE)/.test(l)), key: lines.includes('KEY'), node: lines.includes('NODE') };
      };
      for (const [label, args] of [['잘못된 사양', { Specs: ['2/8/10.0'] }], ['빈 -Specs', { Specs: [] }], ['중복 사양', { Name: 'gw-lab-custom', Specs: ['2/8/10', '2/8/10'] }],
        ['잘못된 이름', { Name: 'x\r\n' }], ['넘는 값', { Specs: ['2147483648/1/1'] }], ['local echo + 잘못된 사양', { LocalEchoExperiment: true, Name: 'gw-lab-v4-echo', Specs: ['1/2/x'] }]]) {
        const r = run(args, []);
        check(`이른 거부: ${label} → 키·node·API 없음`, r.threw && !r.key && !r.node && r.api.length === 0, JSON.stringify(r.lines) + r.out);
      }
      const snap = (o) => ({ id: 'old', name: 'gw-lab-custom-2c8g10d', state: 'active', cpu: 2, mem: 8, disk: 10, ...o });

      const fresh = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'] }, []);
      const post = fresh.api.find((l) => l.startsWith('API POST https://app.daytona.io/api/snapshots '));
      const body = post ? JSON.parse(post.slice(post.indexOf('{'))) : null;
      check('새 사용자 사양 → POST 이름·cpu·memory·disk', fresh.ok && body?.name === 'gw-lab-custom-2c8g10d' && body.cpu === 2 && body.memory === 8 && body.disk === 10 && fresh.mutations.length === 1, JSON.stringify(fresh.lines) + fresh.out);

      const legacy = run({}, []);
      const legacyNames = legacy.api.filter((l) => l.startsWith('API POST')).map((l) => JSON.parse(l.slice(l.indexOf('{'))).name);
      check('기본 실행 → 새 기본 세 이름 POST', legacy.ok && JSON.stringify(legacyNames) === JSON.stringify(['gw-lab-v5-1c2g', 'gw-lab-v5-2c4g', 'gw-lab-v5-4c8g']), JSON.stringify(legacy.lines));

      const mm = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'], Force: true }, [snap({ disk: 5 })]);
      check('사양 다른 기존 + -Force → 멈춤, DELETE·POST 없음', mm.threw && /다릅니다/.test(mm.message) && mm.mutations.length === 0, JSON.stringify(mm.lines) + mm.out);

      const mm2 = run({ Name: 'gw-lab-custom', Specs: ['2/8/10', '4/16/20'], Force: true }, [snap(), { id: 'old2', name: 'gw-lab-custom-4c16g20d', state: 'active', cpu: 4, mem: 8, disk: 20 }]);
      check('둘째만 불일치여도 첫째를 지우지 않음 (전부 대조 후 변경)', mm2.threw && mm2.mutations.length === 0, JSON.stringify(mm2.lines));

      const legacyWrong = run({ Name: 'gw-lab-v4', Specs: ['1/2/5'], Force: true }, [{ id: 'old', name: 'gw-lab-v4-1c2g', state: 'active', cpu: 1, mem: 2, disk: 10 }]);
      check('예전 이름인데 디스크 다른 기존 → -Force 여도 멈춤', legacyWrong.threw && legacyWrong.mutations.length === 0, JSON.stringify(legacyWrong.lines));

      const same = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'] }, [snap()]);
      check('같은 사양 active 기존 → 아무것도 안 바꿈', same.ok && same.mutations.length === 0 && /이미 있음/.test(same.out), JSON.stringify(same.lines) + same.out);

      const pending = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'] }, [snap({ state: 'pending' })]);
      check('active 아닌 기존 → 성공이라 하지 않고 멈춤', pending.threw && /active/.test(pending.message) && pending.mutations.length === 0, JSON.stringify(pending.lines) + pending.out);

      const rebuild = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'], Force: true }, [snap({ state: 'error' })]);
      check('같은 사양 기존 + -Force → DELETE 후 POST', rebuild.ok && rebuild.mutations.length === 2 && /DELETE .*\/snapshots\/old/.test(rebuild.mutations[0]) && /POST .*\/snapshots /.test(rebuild.mutations[1]), JSON.stringify(rebuild.lines));

      const caseOnly = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'], Force: true }, [snap({ name: 'GW-LAB-CUSTOM-2c8g10d' })]);
      check('대소문자만 다른 기존 → 지우지 않고 멈춤', caseOnly.threw && caseOnly.mutations.length === 0, JSON.stringify(caseOnly.lines));

      const verify = run({ Name: 'gw-lab-custom', Specs: ['2/8/10'], Verify: true }, [snap()]);
      const sbPost = verify.api.find((l) => l.startsWith('API POST https://app.daytona.io/api/sandbox '));
      check('-Verify 는 같은 검사된 이름(gw-lab-custom-2c8g10d)으로 샌드박스', sbPost && JSON.parse(sbPost.slice(sbPost.indexOf('{'))).snapshot === 'gw-lab-custom-2c8g10d', JSON.stringify(verify.lines));

      const le = run({ LocalEchoExperiment: true, Name: 'gw-lab-v4-echo', Specs: ['2/8/10'] }, []);
      const lePost = le.api.find((l) => l.startsWith('API POST https://app.daytona.io/api/snapshots '));
      check('local echo + 사용자 사양 → gw-lab-v4-echo-2c8g10d, node 한 번', le.ok && le.node && lePost && JSON.parse(lePost.slice(lePost.indexOf('{'))).name === 'gw-lab-v4-echo-2c8g10d', JSON.stringify(le.lines) + le.out);
      const leForce = run({ LocalEchoExperiment: true, Name: 'gw-lab-v4-echo', Force: true }, []);
      check('local echo + -Force 는 그대로 거부 (키·API 없음)', leForce.threw && !leForce.key && leForce.api.length === 0, JSON.stringify(leForce.lines));
      const leDefault = run({ LocalEchoExperiment: true }, []);
      check('local echo 기본 이름 그대로 거부 (키·API 없음)', leDefault.threw && !leDefault.key && leDefault.api.length === 0, JSON.stringify(leDefault.lines));
    }
  }
} catch (e) {
  if (e !== null) { failN++; console.log(`  FAIL 예외 ${e?.stack ?? e}`); }
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failN} failed, ${skipN} skipped`);
process.exit(failN ? 1 : 0);
