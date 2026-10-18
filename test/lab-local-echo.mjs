// 터미널 local echo 실험 스냅샷(lab/snapshot.ps1 -LocalEchoExperiment) 회귀 테스트. 스냅샷 스크립트는 실행하지 않는다 (Daytona·과금 없음):
//   - 합치기: 기본 설정의 모든 키(보안·tmux 프로필 포함) 그대로 + 세 키만 정확히. localEchoExcludePrograms 는 안 넣는다 (tmux 제외 기본값 유지)
//   - 기본 설정은 베이스(9d0b008)에 모임지기 표기·수업 따라보기 프로필만 더하고, 플래그 없을 때 파일 바이트 그대로
//   - 잘못된 JSON·객체 아닌 값은 실패 (모듈 throw, CLI 는 exit≠0·stdout 비움)
//   - snapshot.ps1 은 pwsh 파서(AST)로만 본다: 플래그 검사가 키 읽기·API 호출보다 먼저, 이름·-Force 검사(끝 LF/CRLF 거부), 파일 쓰기 없음.
//     검사 블록만 AST 에서 떼어 node 를 가짜 함수로 바꿔 돌려 본다 (키·네트워크 없음)
//   node test/lab-local-echo.mjs

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { LOCAL_ECHO_SETTINGS, mergeLocalEcho } from '../lab/local-echo-settings.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'lab', 'local-echo-settings.mjs');
const SETTINGS = join(ROOT, 'lab', 'files', 'code-server-settings.json');
const SNAPSHOT = join(ROOT, 'lab', 'snapshot.ps1');
const BASE_REV = '9d0b008e09f7c781bd4fbacdba84c442aee13c43';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const skip = (name, why) => { skipN++; console.log(`  skip ${name} (${why})`); };

const baseText = readFileSync(SETTINGS, 'utf8');
const base = JSON.parse(baseText);
const ECHO_KEYS = Object.keys(LOCAL_ECHO_SETTINGS);

console.log('합치기');
{
  const merged = JSON.parse(mergeLocalEcho(baseText));
  const added = Object.keys(merged).filter((k) => !(k in base));
  check('추가된 키는 정확히 세 개', isDeepStrictEqual(added.sort(), [...ECHO_KEYS].sort()), JSON.stringify(added));
  check('세 키 값', merged['terminal.integrated.localEchoEnabled'] === 'on' && merged['terminal.integrated.localEchoLatencyThreshold'] === 0 && merged['terminal.integrated.localEchoStyle'] === 'dim');
  check('LOCAL_ECHO_SETTINGS 는 세 키뿐', ECHO_KEYS.length === 3);
  check('기본 키 전부 그대로 (깊은 비교)', Object.keys(base).every((k) => isDeepStrictEqual(merged[k], base[k])));
  check('excludePrograms 를 덮지 않음 (tmux 제외 기본값 유지)', !('terminal.integrated.localEchoExcludePrograms' in merged));
  const guarded = {
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'chat.disableAIFeatures': true,
    'terminal.integrated.enableMultiLinePasteWarning': 'never', 'terminal.integrated.copyOnSelection': true,
    'terminal.integrated.rightClickBehavior': 'copyPaste', 'terminal.integrated.defaultProfile.linux': 'bash',
  };
  check('보안·클립보드 관련 설정 보존', Object.entries(guarded).every(([k, v]) => merged[k] === v));
  const tmux = merged['terminal.integrated.profiles.linux']?.['공유 터미널 (모임지기와 같이 보기)'];
  check('공유 터미널(tmux) 프로필 보존', tmux?.path === 'tmux' && isDeepStrictEqual(tmux.args, ['-u', 'new-session', '-A', '-s', 'share']));
  const lesson = merged['terminal.integrated.profiles.linux']?.['수업 따라보기 (모임지기와 함께 보기)'];
  check('수업 따라보기(tmux 읽기 전용) 프로필 보존', lesson?.path === 'tmux' && isDeepStrictEqual(lesson.args, ['-u', 'attach', '-r', '-t', 'gw-lesson']));
  check('기존 키를 바꿔 쓴다 (덮어쓰기는 세 키만)', isDeepStrictEqual(JSON.parse(mergeLocalEcho('{"a":1,"terminal.integrated.localEchoEnabled":"off"}')), { a: 1, ...LOCAL_ECHO_SETTINGS }));
  check('BOM 붙은 입력도 읽는다', JSON.parse(mergeLocalEcho(String.fromCharCode(0xfeff) + baseText))['telemetry.telemetryLevel'] === 'off');
}

console.log('기본 (플래그 없음)');
{
  check('기본 설정 파일에 local echo 키 없음', !Object.keys(base).some((k) => k.startsWith('terminal.integrated.localEcho')));
  let atBase = null;
  try { atBase = execFileSync('git', ['-C', ROOT, 'show', `${BASE_REV}:lab/files/code-server-settings.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  if (atBase === null) skip('기본 설정 파일이 베이스와 의미가 같음', 'git 베이스 커밋을 못 읽음');
  else {
    const expected = JSON.parse(atBase);
    const profiles = expected['terminal.integrated.profiles.linux'];
    profiles['공유 터미널 (모임지기와 같이 보기)'] = profiles['공유 터미널 (강사와 같이 보기)'];
    delete profiles['공유 터미널 (강사와 같이 보기)'];
    profiles['수업 따라보기 (모임지기와 함께 보기)'] = { path: 'tmux', args: ['-u', 'attach', '-r', '-t', 'gw-lesson'], icon: 'live-share' };
    check('모임지기 표기·수업 따라보기 프로필 외 기본 설정 유지', isDeepStrictEqual(expected, base));
  }
}

console.log('잘못된 입력은 실패');
for (const [label, text] of [['깨진 JSON', '{"a":'], ['빈 문자열', ''], ['배열', '[]'], ['null', 'null'], ['문자열', '"x"'], ['숫자', '1'], ['주석(JSONC)', '// c\n{}'], ['끝 쉼표', '{"a":1,}']]) {
  let threw = false;
  try { mergeLocalEcho(text); } catch { threw = true; }
  check(`모듈: ${label} → throw`, threw);
}
{
  let threw = false;
  try { mergeLocalEcho(undefined); } catch { threw = true; }
  check('모듈: 문자열 아님 → throw', threw);
}

console.log('CLI');
const dir = mkdtempSync(join(tmpdir(), 'lab-local-echo-'));
try {
  const run = (...args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });
  const ok = run(SETTINGS);
  const lines = ok.stdout.split('\n').filter(Boolean);
  check('정상: exit 0, base64 한 줄', ok.status === 0 && lines.length === 1 && /^[A-Za-z0-9+/]+={0,2}$/.test(lines[0]), ok.stderr);
  check('정상: 출력 = 합친 JSON 의 UTF-8 바이트', Buffer.from(lines[0] ?? '', 'base64').toString('utf8') === mergeLocalEcho(baseText));
  const spaced = join(dir, 'with space 공백.json');
  writeFileSync(spaced, baseText);
  const sp = run(spaced);
  check('공백·한글 경로', sp.status === 0 && Buffer.from(sp.stdout.trim(), 'base64').toString('utf8') === mergeLocalEcho(baseText), sp.stderr);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"terminal.integrated.fontSize": 14,');
  const b = run(bad);
  check('깨진 JSON: exit 1, stdout 비움, stderr 에 이유', b.status === 1 && b.stdout === '' && /local-echo-settings:/.test(b.stderr), JSON.stringify(b));
  const arr = join(dir, 'arr.json');
  writeFileSync(arr, '[1]');
  const a = run(arr);
  check('배열: exit 1, stdout 비움', a.status === 1 && a.stdout === '');
  const missing = run(join(dir, 'nope.json'));
  check('없는 파일: exit 1, stdout 비움', missing.status === 1 && missing.stdout === '');
  const none = run();
  check('인자 없음: exit 2', none.status === 2 && none.stdout === '');
  const two = run(SETTINGS, SETTINGS);
  check('인자 둘: exit 2', two.status === 2 && two.stdout === '');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log('snapshot.ps1 (정적·AST, 실행 안 함)');
{
  const src = readFileSync(SNAPSHOT, 'utf8');
  check('UTF-8 BOM 유지', src.charCodeAt(0) === 0xfeff);
  check('Dockerfile 은 고른 설정 변수만 싣는다', /echo \$codeServerSettings \| base64 -d > \/home\/daytona\/\.local\/share\/code-server\/User\/settings\.json/.test(src) && !/\$\(B64 'code-server-settings\.json'\)/.test(src));
  check('기본 분기는 파일 바이트 그대로 (B64)', /\} else \{\s*\$codeServerSettings = B64 'code-server-settings\.json'\s*\}/.test(src));
  check('이름·base64 검사는 문자열 전체 앵커(\\A…\\z), ^…$ 아님', src.includes(String.raw`$Name -notmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*\z'`) && src.includes(String.raw`$codeServerSettings -notmatch '\A[A-Za-z0-9+/]+={0,2}\z'`) && !/-notmatch '\^/.test(src));
  check('파일 쓰기 없음', !/Set-Content|Out-File|Add-Content|WriteAll|New-Item|>\s*\$|Copy-Item|Move-Item/.test(src.replace(/\$dockerfile = @"[\s\S]*?"@/, '')));

  const probe = String.raw`
param([string]$Path)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
$top = @($ast.EndBlock.Statements)
$idx = { param($pred) for ($i = 0; $i -lt $top.Count; $i++) { if (& $pred $top[$i]) { return $i } }; -1 }
$flagIf = & $idx { param($s) $s -is [System.Management.Automation.Language.IfStatementAst] -and $s.Clauses[0].Item1.Extent.Text -eq '$LocalEchoExperiment' }
$key = & $idx { param($s) $s.Extent.Text -match 'DAYTONA_API_KEY' }
$api = & $idx { param($s) $s.Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -in 'Dt', 'Invoke-RestMethod', 'curl.exe' }, $true) -ne $null -and $s -isnot [System.Management.Automation.Language.FunctionDefinitionAst] }
$docker = & $idx { param($s) $s.Extent.Text -match '^\$dockerfile\s*=' }
$params = @($ast.ParamBlock.Parameters | ForEach-Object { [pscustomobject]@{ name = $_.Name.VariablePath.UserPath; type = $_.StaticType.Name } })
$tmpl = @'
param([string]$Name = 'gw-lab-v4', [switch]$Force, [switch]$LocalEchoExperiment)
$ErrorActionPreference = 'Stop'
$script:nodeCalls = 0
function B64($f) { 'RAW-' + $f }
function node { $script:nodeCalls++; if (__FAIL__) { $global:LASTEXITCODE = 1; return }; $global:LASTEXITCODE = 0; __OUT__ }
$codeServerSettings = $null
__BLOCK__
[pscustomobject]@{ value = $codeServerSettings; nodeCalls = $script:nodeCalls }
'@
$results = @()
if ($flagIf -ge 0) {
  $block = $top[$flagIf].Extent.Text.Replace('$PSScriptRoot', "'" + (Split-Path $Path).Replace("'", "''") + "'")
  $files = Join-Path (Split-Path $Path) 'files'
  $cases = @(
    @{ label = 'noName'; args = @{ LocalEchoExperiment = $true } },
    @{ label = 'defaultName'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4' } },
    @{ label = 'defaultNameCase'; args = @{ LocalEchoExperiment = $true; Name = 'GW-LAB-V4' } },
    @{ label = 'newDefaultName'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v5' } },
    @{ label = 'newDefaultNameCase'; args = @{ LocalEchoExperiment = $true; Name = 'GW-LAB-V5' } },
    @{ label = 'emptyName'; args = @{ LocalEchoExperiment = $true; Name = '' } },
    @{ label = 'badName'; args = @{ LocalEchoExperiment = $true; Name = 'x y' } },
    @{ label = 'nameLF'; args = @{ LocalEchoExperiment = $true; Name = ('gw-lab-v4-echo' + [char]10) } },
    @{ label = 'nameCRLF'; args = @{ LocalEchoExperiment = $true; Name = ('gw-lab-v4-echo' + [char]13 + [char]10) } },
    @{ label = 'force'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo'; Force = $true } },
    @{ label = 'ok'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' } },
    @{ label = 'nodeFail'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' }; fail = $true },
    @{ label = 'nodeOutLF'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' }; out = "('QUJD' + [char]10)" },
    @{ label = 'nodeOutCRLF'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' }; out = "('QUJD' + [char]13 + [char]10)" },
    @{ label = 'nodeOutMultiline'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' }; out = "('QUJD' + [char]10 + 'QUJD')" },
    @{ label = 'nodeOutTwoLines'; args = @{ LocalEchoExperiment = $true; Name = 'gw-lab-v4-echo' }; out = "'QUJD'; 'QUJD'" },
    @{ label = 'default'; args = @{} }
  )
  foreach ($c in $cases) {
    $fail = [bool]$c.fail
    $out = $(if ($c.out) { $c.out } else { "'QUJD'" })
    $sb = [scriptblock]::Create($tmpl.Replace('__FAIL__', $(if ($fail) { '$true' } else { '$false' })).Replace('__OUT__', $out).Replace('__BLOCK__', $block))
    $a = $c.args
    try { $r = & $sb @a; $results += [pscustomobject]@{ label = $c.label; threw = $false; value = $r.value; nodeCalls = $r.nodeCalls } }
    catch { $results += [pscustomobject]@{ label = $c.label; threw = $true; message = $_.Exception.Message } }
  }
}
[pscustomobject]@{ errors = @($errors).Count; flagIf = $flagIf; key = $key; api = $api; docker = $docker; params = $params; results = $results } | ConvertTo-Json -Depth 6 -Compress
`;
  const pwsh = spawnSync('pwsh', ['-v'], { encoding: 'utf8' });
  if (pwsh.status !== 0) skip('pwsh AST 검사', 'pwsh 없음');
  else {
    const pdir = mkdtempSync(join(tmpdir(), 'lab-local-echo-ps-'));
    try {
      const pf = join(pdir, 'probe.ps1');
      writeFileSync(pf, String.fromCharCode(0xfeff) + probe);
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', pf, SNAPSHOT], { encoding: 'utf8' });
      let o = null;
      try { o = JSON.parse(r.stdout); } catch {}
      check('pwsh 프로브 동작', r.status === 0 && o, r.stderr || r.stdout);
      if (o) {
        check('파서 오류 0', o.errors === 0, o.errors);
        const p = Object.fromEntries(o.params.map((x) => [x.name, x.type]));
        check('-LocalEchoExperiment 는 switch, 기존 매개변수 유지', p.LocalEchoExperiment === 'SwitchParameter' && p.Force === 'SwitchParameter' && p.Verify === 'SwitchParameter' && p.Name === 'String' && p.Specs === 'String[]', JSON.stringify(o.params));
        check('플래그 검사 블록이 맨 위 문장에 있음', o.flagIf >= 0, o.flagIf);
        check('검사 < 키 읽기', o.flagIf >= 0 && o.key > o.flagIf, JSON.stringify(o));
        check('검사 < 첫 API 호출', o.flagIf >= 0 && o.api > o.flagIf, JSON.stringify(o));
        check('검사 < Dockerfile 조립', o.flagIf >= 0 && o.docker > o.flagIf, JSON.stringify(o));
        const res = Object.fromEntries((o.results ?? []).map((x) => [x.label, x]));
        for (const l of ['noName', 'defaultName', 'defaultNameCase', 'newDefaultName', 'newDefaultNameCase', 'emptyName', 'badName', 'nameLF', 'nameCRLF', 'force']) {
          check(`거부: ${l}`, res[l]?.threw === true && /-Name|-Force/.test(res[l]?.message ?? ''), JSON.stringify(res[l]));
        }
        for (const l of ['nodeOutLF', 'nodeOutCRLF', 'nodeOutMultiline', 'nodeOutTwoLines']) {
          check(`거부: node 결과 ${l} (끝 줄바꿈·여러 줄)`, res[l]?.threw === true && /local echo/.test(res[l]?.message ?? ''), JSON.stringify(res[l]));
        }
        check('통과: 이름 지정 → node 결과 사용', res.ok?.threw === false && res.ok.value === 'QUJD' && res.ok.nodeCalls === 1, JSON.stringify(res.ok));
        check('node 실패 → 멈춤', res.nodeFail?.threw === true, JSON.stringify(res.nodeFail));
        check('플래그 없음 → 파일 바이트 그대로, node 안 부름', res.default?.threw === false && res.default.value === 'RAW-code-server-settings.json' && res.default.nodeCalls === 0, JSON.stringify(res.default));
      }
    } finally { rmSync(pdir, { recursive: true, force: true }); }
  }
}

console.log(`\n${pass} passed, ${failN} failed, ${skipN} skipped`);
process.exit(failN ? 1 : 0);
