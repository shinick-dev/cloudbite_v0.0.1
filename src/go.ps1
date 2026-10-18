# k.shinick.dev/go — 빌린 PC 에서 금고의 로그인 정보로 사이트에 자동 로그인한다.
#   irm https://k.shinick.dev/go | iex
#
# 1. Edge 를 임시 프로필 + InPrivate 로 띄운다 (이 PC 사용자의 쿠키·저장된 비밀번호·Windows 계정 자동 로그인과 섞이지 않는다)
# 2. 그 창에 QR 이 뜬다 → 폰에서 금고를 열고 보낼 로그인을 고른다
# 3. 이 창만 풀 수 있게 암호화돼 온 로그인 정보로, 사이트를 열어 아이디·비밀번호를 넣고 로그인 버튼까지 누른다
# 4. Enter 를 누르면 Edge 를 닫고 임시 프로필을 통째로 지운다 (쿠키·기록 남지 않음)
& {
$ErrorActionPreference = 'Stop'
$gw = '__GW__'
$headless = [bool]$env:KVGO_HEADLESS         # 테스트용
$autoClose = [int]("0" + $env:KVGO_AUTOCLOSE) # 테스트용: Enter 대신 n초 뒤 정리

# 저장된 로그인 주소로 자동 입력해도 되는지: 'none'(주소 없음) · 'https' · 'dev-http' · 'bad'
# https 전체 주소(userinfo 없음)만 된다. http 는 이 스크립트를 준 게이트웨이가 로컬 개발용(http + loopback)일 때 loopback 주소만.
function LoginUrlMode([string]$u, [string]$gw) {
    if (-not $u) { return 'none' }
    $loop = 'localhost', '127.0.0.1', '[::1]'
    $x = $null; $g = $null
    if (-not [Uri]::TryCreate($u, [UriKind]::Absolute, [ref]$x) -or $x.UserInfo -or -not $x.Host) { return 'bad' }
    if ($x.Scheme -eq 'https') { return 'https' }
    if ($x.Scheme -eq 'http' -and $loop -contains $x.Host -and [Uri]::TryCreate($gw, [UriKind]::Absolute, [ref]$g) -and
        $g.Scheme -eq 'http' -and $loop -contains $g.Host) { return 'dev-http' }
    return 'bad'
}

$edge = @(
    (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $edge) { Write-Host 'Microsoft Edge 를 찾지 못했습니다.' -ForegroundColor Red; return }

# 지난번에 창을 그냥 닫아 못 지운 임시 프로필 (쓰는 Edge 가 없을 때만)
$busy = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ForEach-Object CommandLine) -join "`n"
Get-ChildItem $env:TEMP -Directory -Filter 'kvgo-*' -ErrorAction SilentlyContinue |
    Where-Object { -not $busy.Contains($_.Name) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$dir = Join-Path $env:TEMP ('kvgo-' + [guid]::NewGuid().ToString('N'))
$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop()
$args_ = @("--user-data-dir=""$dir""", "--remote-debugging-port=$port", '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--new-window', "$gw/recv?go=1")
# 새 프로필이라도 Edge 는 이 PC 의 Windows(MS) 계정으로 자동 로그인해서 MS 계정 사이트가 로그인된 채 뜬다 → InPrivate 로 막는다
$args_ = @('--inprivate') + $args_
if ($headless) { $args_ = @('--headless=new') + $args_ }
$sock = $null

function Cleanup {
    if ($sock) { try { $sock.Dispose() } catch {} }
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$dir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 40 -and (Test-Path $dir); $i++) {
        Start-Sleep -Milliseconds 500
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    }
    if (Test-Path $dir) { Write-Host "임시 프로필을 다 못 지웠습니다: $dir" -ForegroundColor Yellow }
    else { Write-Host '정리 완료: Edge 를 닫고 임시 프로필을 지웠습니다.' -ForegroundColor Green }
}

try {
    Start-Process $edge -ArgumentList $args_ | Out-Null

    # 브라우저 조종(CDP) 연결
    $ws = $null
    for ($i = 0; $i -lt 60 -and -not $ws; $i++) {
        try {
            # 5.1 의 Invoke-RestMethod 는 JSON 배열을 한 덩어리로 넘기므로 변수에 받아서 펼친다
            $targets = Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 2
            $ws = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -like "$gw/recv*" })[0].webSocketDebuggerUrl
        } catch {}
        if (-not $ws) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ws) { throw 'Edge 에 연결하지 못했습니다.' }
    $sock = [Net.WebSockets.ClientWebSocket]::new()
    $sock.ConnectAsync([Uri]$ws, [Threading.CancellationToken]::None).Wait()
    $script:cid = 0
    function Cdp([string]$method, $params = @{}) {
        $script:cid++
        $msg = @{ id = $script:cid; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
        $sock.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
        $buf = [byte[]]::new(65536)
        while ($true) {
            $ms = [IO.MemoryStream]::new()
            do {
                $r = $sock.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result
                $ms.Write($buf, 0, $r.Count)
            } while (-not $r.EndOfMessage)
            $o = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
            if ($o.id -eq $script:cid) {
                if ($o.error) { throw $o.error.message }
                return $o.result
            }
        }
    }
    function Js([string]$expr) {
        $r = Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
        if ($r.exceptionDetails) { throw ($r.exceptionDetails.exception.description) }
        return $r.result.value
    }
    # 로그인 정보를 다루는 스크립트는 페이지 JS 와 전역(URL·Object·prototype …)을 나누지 않는 격리 world 에서,
    # 그 순간의 최상위 frame 에 붙여 돌린다. 페이지가 전역을 바꿔 origin 비교를 속이거나 넘긴 값을 엿볼 수 없다.
    # frame·world 를 못 얻거나 그 사이 페이지가 바뀌면 예외 = 아무것도 넣지 않음.
    function JsIso([string]$expr) {
        $fid = (Cdp 'Page.getFrameTree').frameTree.frame.id
        if (-not $fid) { throw 'no main frame' }
        $ctx = (Cdp 'Page.createIsolatedWorld' @{ frameId = $fid; worldName = 'kvgo'; grantUniveralAccess = $false }).executionContextId
        if (-not $ctx) { throw 'no isolated world' }
        $r = Cdp 'Runtime.evaluate' @{ expression = $expr; contextId = $ctx; returnByValue = $true; awaitPromise = $true }
        if ($r.exceptionDetails) { throw ($r.exceptionDetails.exception.description) }
        return $r.result.value
    }

    # QR 이 뜰 때까지 기다렸다가 폰용 주소도 터미널에 보여준다
    $url = $null
    for ($i = 0; $i -lt 40 -and -not $url; $i++) { Start-Sleep -Milliseconds 500; $url = Js 'window.__kvUrl || ""' }
    Write-Host "`n  Edge 창의 QR 을 폰으로 찍고, 금고에서 보낼 로그인을 고르세요."
    Write-Host "  (QR 대신) 폰에서 열기: $url" -ForegroundColor DarkGray
    Write-Host "  코드: $(Js 'document.getElementById(''code'').textContent')" -ForegroundColor Yellow

    $data = $null
    $deadline = (Get-Date).AddMinutes(10)
    while (-not $data -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        $v = Js 'window.__kv ? JSON.stringify(window.__kv) : (window.__kvErr || "")'
        if ($v -and $v.StartsWith('{')) { $data = $v | ConvertFrom-Json }
        elseif ($v) { throw $v }
    }
    if (-not $data) { throw '10분 안에 받지 못했습니다.' }
    Write-Host "  받음: $($data.title)" -ForegroundColor Green

    $mode = LoginUrlMode ([string]$data.url) $gw
    if ($mode -eq 'none') {
        Write-Host '  주소가 없는 항목이라 자동 로그인은 건너뜁니다. Edge 창에서 복사해 쓰세요.' -ForegroundColor Yellow
        Js 'window.__kvShow && window.__kvShow()' | Out-Null
    } elseif ($mode -eq 'bad') {
        Write-Host '  저장된 로그인 주소가 https:// 전체 주소가 아니라서 자동 로그인은 하지 않습니다. 주소를 확인하고 Edge 창에서 복사해 쓰세요.' -ForegroundColor Yellow
        Js 'window.__kvShow && window.__kvShow()' | Out-Null
    } else {
        Cdp 'Page.navigate' @{ url = $data.url } | Out-Null
        # 한 화면 로그인은 바로, 아이디 → 다음 → 비밀번호 로 나뉜 화면은 단계마다 채운다.
        # 저장된 주소와 origin(scheme·host·port)이 정확히 같은 페이지에서만, 값을 넣고 제출하기 직전마다 확인한다.
        # 리다이렉트·다음 단계로 다른 origin 에 오거나 폼이 다른 origin 으로 보내게 돼 있으면 아무것도 넣지 않고 멈춘다.
        $fill = @'
(async (loginUrl, allowHttp, u, pw, skipU) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let A; try { A = new URL(loginUrl); } catch { return 'bad-url'; }
  if (!(A.protocol === 'https:' || (allowHttp && A.protocol === 'http:')) || A.username || A.password || !A.hostname) return 'bad-url';
  const O = A.origin;
  const here = () => location.origin === O;
  const moved = () => 'origin:' + location.origin;
  const base = () => Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI').get.call(document);
  const sameO = s => { try { const x = new URL(s, base()); return x.protocol === 'javascript:' || x.origin === O; } catch { return false; } };
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
  const set = (e, v) => { e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const WORD = /^\s*(log ?in|sign ?in|next|continue|submit|로그인|다음|계속|확인)\s*$/i;
  // 누를 버튼: 다른 origin 으로 가는 링크는 고르지 않는다
  const pick = e => {
    const scope = e.form || document;
    return [...scope.querySelectorAll('button[type=submit],input[type=submit]')].find(vis)
      || [...scope.querySelectorAll('button,[role=button],input[type=button],a')].find(x => vis(x) && WORD.test(x.textContent || x.value || '')
        && !(x.tagName === 'A' && x.hasAttribute('href') && !sameO(x.getAttribute('href'))));
  };
  // 폼이 제출될 곳도 같은 origin 이어야 한다: 입력칸의 폼, 누를 버튼이 실제로 제출하는 폼(form= 속성 포함)의 action 과
  // 버튼의 formaction 을 method(dialog·formmethod 등)와 상관없이 모두 본다.
  // Element.prototype 으로 읽어 name=action·name=getAttribute 같은 입력칸에 속지 않는다
  const attr = (x, n) => Element.prototype.hasAttribute.call(x, n) ? Element.prototype.getAttribute.call(x, n) : null;
  const target = (e, b) => {
    const forms = new Set([e.form, b && b.form].filter(Boolean));
    for (const f of forms) if (!sameO(attr(f, 'action') || location.href)) return false;
    const fa = b && b.form ? attr(b, 'formaction') : null;
    return fa === null || sameO(fa || location.href);
  };
  const submit = (e, b) => {
    if (b) b.click();
    else if (e.form) e.form.requestSubmit ? e.form.requestSubmit() : e.form.submit();
    else { e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }
  };
  const USERISH = /user|email|login|id|name|account|mail|아이디|이메일/i;
  const users = () => [...document.querySelectorAll('input')].filter(e => vis(e) && /^(email|text|tel|)$/.test(e.getAttribute('type') || '')
    && USERISH.test([e.name, e.id, e.autocomplete, e.placeholder, e.getAttribute('aria-label')].join(' ')));
  let uDone = skipU;
  for (let t = 0; t < 40; t++) {
    if (!here()) return moved();
    const pws = [...document.querySelectorAll('input[type=password]')].filter(vis);
    if (pws.length) {
      const p = pws[0];
      const before = users().filter(e => e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
      const ue = before[before.length - 1];
      if (!target(p, pick(p)) || (ue && ue.form !== p.form && !target(ue, null))) return 'target';
      if (u && ue && ue.value !== u) set(ue, u);
      set(p, pw);
      await sleep(300);
      if (!here()) return moved();
      const b = pick(p);
      if (!target(p, b)) { set(p, ''); return 'target'; }
      submit(p, b);
      return 'submitted';
    }
    const us = users();
    if (!uDone && u && us.length) {
      const e = us[0];
      if (!target(e, pick(e))) return 'target';
      set(e, u);
      await sleep(300);
      if (!here()) return moved();
      const b = pick(e);
      if (!target(e, b)) { set(e, ''); return 'target'; }
      submit(e, b); uDone = true;
    }
    await sleep(500);
  }
  return uDone ? 'username-only' : 'no-form';
})
'@
        $arg = { param($x) if ($null -eq $x) { 'null' } else { ConvertTo-Json ([string]$x) -Compress } }
        $result = $null; $skipU = $false
        for ($attempt = 0; $attempt -lt 4 -and -not $result; $attempt++) {
            # 새 페이지가 뜰 때까지
            for ($i = 0; $i -lt 40; $i++) {
                Start-Sleep -Milliseconds 500
                try { if ((Js "location.href.startsWith('$gw') ? '' : document.readyState") -eq 'complete') { break } } catch {}
            }
            try {
                $r = JsIso ("(" + $fill + ")(" + (& $arg $data.url) + "," + ($mode -eq 'dev-http').ToString().ToLower() + "," +
                    (& $arg $data.username) + "," + (& $arg $data.password) + "," + ($skipU.ToString().ToLower()) + ")")
                if ($r -eq 'submitted' -or $r -eq 'no-form' -or $r -eq 'target' -or $r -eq 'bad-url' -or "$r".StartsWith('origin:')) { $result = $r }
                elseif ($r -eq 'username-only') { $skipU = $true }
            } catch {
                # 아이디를 넣고 '다음'을 눌러 페이지가 바뀌면 여기로 온다 → 다음 페이지에서 이어서 (다음 페이지의 origin 을 다시 확인한다)
                $skipU = $true
            }
        }
        $then = $data.then; $who = $data.username; $loginHost = ([Uri]$data.url).Host; $title = [string]$data.title
        $want = ([Uri]$data.url).GetLeftPart([UriPartial]::Authority)
        $data = $null
        # 보안 문제로 멈추면 받은 값을 지우고, 이어서 하던 재시도·다음 사이트 자동 진행도 하지 않는다. Edge 창은 그대로 두어 직접 이어 할 수 있다
        $halt = $result -eq 'target' -or $result -eq 'bad-url' -or "$result".StartsWith('origin:')
        if ($halt) { $then = $null; $who = $null }
        switch -Wildcard ($result) {
            'submitted' { Write-Host '  로그인 정보를 넣고 로그인 버튼을 눌렀습니다. 2단계 인증이 있으면 Edge 창에서 마저 하세요.' -ForegroundColor Green }
            'no-form'   { Write-Host '  로그인 입력칸을 찾지 못했습니다. Edge 창에서 직접 로그인하세요.' -ForegroundColor Yellow }
            'origin:*'  { Write-Host "  로그인 화면이 저장된 주소($want)가 아닌 $($result.Substring(7)) 로 바뀌어 자동 입력을 멈췄습니다. 그 페이지에는 아이디·비밀번호를 넣지 않았습니다. 주소를 확인하고 Edge 창에서 직접 로그인하세요." -ForegroundColor Red }
            'target'    { Write-Host "  로그인 폼이 저장된 주소($want)가 아닌 곳으로 보내게 돼 있어 자동 입력을 멈췄습니다. Edge 창에서 주소를 확인하고 직접 로그인하세요." -ForegroundColor Red }
            'bad-url'   { Write-Host '  저장된 로그인 주소를 쓸 수 없어 자동 입력을 멈췄습니다. Edge 창에서 직접 로그인하세요.' -ForegroundColor Red }
            default     { Write-Host '  비밀번호 칸까지 가지 못했습니다. Edge 창에서 마저 하세요.' -ForegroundColor Yellow }
        }

        # 다음 사이트: 로그인(2단계 인증 포함)이 끝나면 그 사이트를 열고 "Google 로 계속" 같은 버튼까지 누른다
        if ($then -and $then -match '^https?://') {
            Write-Host "  로그인이 끝나면 $then 로 이동합니다 (최대 5분 대기)." -ForegroundColor DarkGray
            $done = $false; $stable = 0
            $deadline = (Get-Date).AddMinutes(5)
            while (-not $done -and (Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 1
                try {
                    $s = Js @'
(() => { const pw = [...document.querySelectorAll('input[type=password]')].some(e => e.getBoundingClientRect().width > 0);
  const busy = /signin|log-?in|challenge|verif|2fa|mfa|otp|auth|password|identifier|speedbump/i.test(location.pathname + location.search);
  return document.readyState === 'complete' && !pw && !busy ? 'ok' : 'wait'; })()
'@
                    if ($s -eq 'ok') { $stable++ } else { $stable = 0 }
                    if ($stable -ge 2) { $done = $true }
                } catch { $stable = 0 }
            }
            if (-not $done) { Write-Host '  로그인이 끝나지 않아 다음 사이트로 가지 않았습니다.' -ForegroundColor Yellow }
            else {
                $prov = switch -Regex ("$loginHost $title") {
                    'google' { 'google' } 'microsoft|live\.com' { 'microsoft' } 'apple' { 'apple' } 'github' { 'github' }
                    'kakao' { 'kakao|카카오' } 'naver' { 'naver|네이버' } 'facebook' { 'facebook' } default { '' }
                }
                $appHost = ([Uri]$then).Host
                Cdp 'Page.navigate' @{ url = $then } | Out-Null
                # SSO 버튼 → (Google) 계정 선택 → 동의 → 원래 사이트로 돌아오면 끝
                $sso = @'
((prov, who, appHost) => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.value || '')).replace(/\s+/g, ' ').trim();
  const btns = () => [...document.querySelectorAll('button,a,[role=button],[role=link],input[type=submit],input[type=button],li[data-identifier],div[data-identifier]')].filter(vis);
  if (document.readyState !== 'complete') return 'wait';
  if (who) { const a = document.querySelector('[data-identifier="' + CSS.escape(who) + '"],[data-email="' + CSS.escape(who) + '"]');
    if (a && vis(a)) { a.click(); return 'account'; } }
  const ok = btns().find(e => /^(continue|allow|계속|허용|확인)$/i.test(txt(e)));
  // 앱이 아닌 곳 = 로그인 제공자(IdP) 화면: 계정 선택·동의만 누른다
  if (location.hostname !== appHost) {
    if (ok) { ok.click(); return 'consent'; } return 'idp'; }
  if (!prov) return 'nosso';
  const re = new RegExp(prov, 'i');
  const b = btns().filter(e => re.test(txt(e)) && txt(e).length < 60).sort((x, y) => txt(x).length - txt(y).length)[0];
  if (b) { b.click(); return 'clicked'; }
  return 'none';
})
'@
                $clicked = $false; $last = ''; $none = 0
                $deadline = (Get-Date).AddSeconds(90)
                while ((Get-Date) -lt $deadline) {
                    Start-Sleep -Seconds 1
                    try {
                        $r = Js ("(" + $sso + ")(" + (ConvertTo-Json ([string]$prov) -Compress) + "," + (& $arg $who) + "," + (ConvertTo-Json $appHost -Compress) + ")")
                    } catch { if ($env:KVGO_DEBUG) { Write-Host "    [sso] err $($_.Exception.Message)" }; continue }
                    $last = $r
                    if ($env:KVGO_DEBUG) { Write-Host "    [sso] $r" }
                    if ($r -eq 'clicked') { $clicked = $true; Start-Sleep -Seconds 2 }
                    elseif ($r -eq 'account' -or $r -eq 'consent') { Start-Sleep -Seconds 2 }
                    elseif ($r -eq 'nosso') { break }
                    elseif ($r -eq 'none' -and $clicked) { break }   # 돌아왔고 더 누를 버튼이 없음 = 로그인됨
                    elseif ($r -eq 'none' -and ++$none -ge 15) { break }
                }
                if ($clicked -and $last -ne 'idp') { Write-Host "  $then 에서 로그인 버튼까지 눌렀습니다." -ForegroundColor Green }
                elseif ($last -eq 'nosso') { Write-Host "  $then 를 열었습니다." -ForegroundColor Green }
                else { Write-Host "  $then 를 열었지만 로그인 버튼을 다 누르지 못했습니다. Edge 창에서 마저 하세요." -ForegroundColor Yellow }
            }
        }
    }

    if ($autoClose) { Start-Sleep -Seconds $autoClose }
    else { Read-Host "`n  다 쓰면 Enter — Edge 를 닫고 임시 프로필을 지웁니다" | Out-Null }
} catch {
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
} finally {
    $data = $null
    Cleanup
}
}
