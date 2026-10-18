// 강사 /lab 수업 목록(카드·자리 표) 그리기. src/pages.ts labPage 의 load() 가 /api/lab/list 응답으로 부른다.
// 브라우저 스크립트 (import·export 없음): tools/build-lab-renderer.mjs 가 esbuild transform 으로 JS 로 옮겨
// src/lab-renderer.generated.ts 에 문자열로 넣고, labPage 인라인 스크립트에 그대로 붙는다. 고친 뒤 npm run build:lab-renderer.
// 관리 토큰·api 는 모른다 — 서버를 부르는 일은 전부 pages.ts 가 넘겨주는 콜백(LabRendererDeps)으로만 한다.
// 사용자 값(수업 이름·모델·자료·오류·이름)은 textContent 로만 넣는다. QR(서버 SVG)은 pages.ts 의 showBig 만 다룬다.

interface LabPresence { state: string; idleSec?: number; lastSeen?: number; tabs?: number; watch?: number }
interface LabPreparation { state: 'queued' | 'preparing' | 'ready' | 'error' | 'unknown'; at: number | null }
interface LabDiagnostics { usage: number | null; limit: number | null; usageAt: number | null; aiError: { at: number; status: number; count: number; kind: string } | null }
interface LabDelivery { status: 'none' | 'pending' | 'sent' | 'unknown' | 'error' | 'skipped'; at: number | null }
interface LabSeat {
  files?: { at: number; verifiedAt: number | null } | null;
  preparation?: LabPreparation;
  delivery?: LabDelivery;
  n: number; error?: string; state?: string; who?: string; hand?: number; opened?: number; lastAi?: number;
  presence?: LabPresence; setup?: { state: string; note?: string }; usage?: number | null; limit?: number;
  counts?: Record<string, number>; err?: { at: number; status: number | string; n: number; msg: string };
}
interface LabShare { id: string; label: string; on: boolean; cap: number }
interface LabClip { in: boolean; out: boolean }
interface LabItem {
  id: string; name: string; cpu: number; memory: number; budget: number; model: string; expiresAt: number;
  materials?: string; ending?: boolean; trialOf?: string; stateError?: string; outage?: string; clip?: LabClip; share?: LabShare[]; seats: LabSeat[];
}
// 읽기 전용(모니터) 목록: POST /api/lab/teacher/status 의 가벼운 모양. 오류는 있다/없다만 온다
interface MonSeat { preparation?: LabPreparation; diagnostics?: LabDiagnostics; delivery?: LabDelivery; n: number; who?: string; hand?: number; opened?: number; presence?: LabPresence; setup?: { state: string; note?: string }; error?: boolean }
interface MonLab { id: string; name: string; expiresAt: number; ending?: boolean; seats: MonSeat[] }
interface LabInviteLink { n: number; who?: string; link: string }
interface LabRendererDeps {
  // 글자 (pages.ts 의 것을 그대로 — 만들기 결과 문구와 같은 말을 쓴다)
  now(): number; fmt(t: number): string; dur(s: number): string; ago(t: number): string; cleanErr(t: unknown): string;
  joined(lab: LabItem): string; usable(lab: LabItem): boolean; failed(lab: LabItem): LabSeat[];
  failNote(lab: LabItem): string; firstErr(lab: LabItem): string;
  btn(t: string, cls: string, f: () => unknown): HTMLButtonElement;
  copy(b: HTMLButtonElement, text: string): Promise<void>;
  say(t: string, cls?: string): void;
  // pages.ts 가 상태를 쥔 조각: 공유 키 상한 · 화면 공유(이 탭의 연결) · 코드 보내기(쓰던 글·포커스)
  shareRow(lab: LabItem, x: LabShare): HTMLElement;
  screenRow(lab: LabItem): HTMLElement; sharing(id: string): boolean;
  // 모임 화면이 같은 공유 버튼을 이미 그릴 때 카드의 중복을 뺀다. 공유 중 멈춤은 pages 가 따로 남긴다.
  omitScreen?(id: string): boolean;
  selectedId?(): string | null;
  controlDock?(id: string): boolean;
  helpSeat?(id: string, n: number): void;
  snipBox(lab: LabItem): HTMLElement;
  terminalBox?(lab: LabItem): HTMLElement;
  controlBox?(lab: LabItem): HTMLElement;
  trialBox?(lab: LabItem): HTMLElement;
  interruptBox?(lab: LabItem): HTMLElement;
  checkpointBox?(lab: LabItem): HTMLElement;
  recoveryBox?(lab: LabItem): HTMLElement;
  assistantBox?(lab: LabItem): HTMLElement;
  // 서버 호출 — 초대 링크는 누를 때만 받는다 (목록에는 없다)
  inviteAll(lab: LabItem): Promise<{ seats: LabInviteLink[] }>;
  inviteSeat(lab: LabItem, n: number): Promise<LabInviteLink>;
  showInvite(lab: LabItem, inv: LabInviteLink): void;
  setClip(id: string, clip: LabClip): Promise<{ clip: LabClip }>;
  lowerHand(id: string, n: number): Promise<unknown>;
  endLab(id: string): Promise<unknown>;
  reload(): Promise<void>;
}

function createLabRenderer(D: LabRendererDeps) {
  const errMsg = (e: unknown) => (e as Error).message;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
  };
  const small = (b: HTMLButtonElement, pad: string, left?: string) => { b.style.padding = pad; b.style.width = 'auto'; if (left) b.style.marginLeft = left; return b; };

  const timestamp = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0;
  const freshAt = (t: unknown) => timestamp(t) && t <= D.now() && D.now() - t <= 5 * 60e3;
  function prepState(s: { preparation?: LabPreparation }) {
    const p = s.preparation;
    if (!p || !['queued', 'preparing', 'ready', 'error'].includes(p.state)) return 'unknown';
    return p.state === 'ready' && (!timestamp(p.at) || p.at > D.now()) ? 'unknown' : p.state;
  }
  function prepText(s: { preparation?: LabPreparation }) {
    const k = prepState(s), p = s.preparation;
    const label = { queued: '준비 대기', preparing: '서버 준비 중', ready: '마지막 서버 준비 확인', error: '서버 준비 실패', unknown: '서버 준비 확인 안 됨' }[k];
    return label + (timestamp(p?.at) && p.at <= D.now() ? ' · ' + D.fmt(p.at) + ' (' + D.ago(p.at) + ')' + (k === 'ready' && !freshAt(p.at) ? ' · 오래된 확인' : '') : '');
  }
  function preparationLine(lab: { seats: Array<{ preparation?: LabPreparation }> }) {
    const n = (k: string) => lab.seats.filter(s => prepState(s) === k).length;
    const p = el('p', 'mut', '서버 준비 확인 ' + n('ready') + ' / ' + lab.seats.length + '자리 · 대기 ' + n('queued') + ' · 준비 중 ' + n('preparing') + ' · 실패 ' + n('error') + ' · 확인 안 됨 ' + n('unknown'));
    p.dataset.preparation = '1'; p.title = '마지막 서버 상태 확인 기준입니다. 참가자 브라우저의 편집기 로딩 여부는 확인하지 않습니다.';
    return p;
  }
  function remaining(expiresAt: number) {
    if (!timestamp(expiresAt)) return '남은 시간 확인 필요';
    const minutes = Math.max(0, Math.ceil((expiresAt - D.now()) / 60000));
    return minutes ? '남은 시간 ' + (minutes >= 60 ? Math.floor(minutes / 60) + '시간 ' : '') + (minutes % 60) + '분' : '종료 시각 지남';
  }
  function deliveryLine(s: { delivery?: LabDelivery }) {
    const labels: Record<string, string> = { none: '아직 전달 기록 없음', pending: '전달 처리 중', sent: '입력 보냄', unknown: '결과 확인 필요', error: '전달 실패', skipped: '전달 건너뜀' };
    const d = s.delivery, valid = d && Object.hasOwn(labels, d.status) && (((d.status === 'none' || d.status === 'unknown') && d.at === null) || (timestamp(d.at) && d.at <= D.now()));
    const text = valid ? labels[d.status] : '확인 안 됨';
    const line = el('div', 'mut', '마지막 명령 전달: ' + text + (valid && timestamp(d.at) ? ' · 상태 기록 ' + D.fmt(d.at) + ' (' + D.ago(d.at) + ')' + (!freshAt(d.at) ? ' · 오래된 기록' : '') : ''));
    line.dataset.delivery = '1'; line.title = '수업 터미널 입력 전달 기록입니다. 프로그램 완료나 결과 정확성을 뜻하지 않습니다. 연결 상태·도움 요청과 함께 확인하세요.';
    if (valid && timestamp(d.at) && ['unknown','error'].includes(d.status)) line.className = 'bad';
    return line;
  }
  function fileChecked(s: LabSeat) {
    return !!s.files && timestamp(s.files.at) && s.files.at <= D.now() && timestamp(s.files.verifiedAt) && s.files.verifiedAt >= s.files.at && s.files.verifiedAt <= D.now();
  }
  function fileLine(s: LabSeat) {
    const at = s.files?.at, valid = timestamp(at) && at <= D.now();
    const text = !valid ? 'ZIP 전송 기록 확인 안 됨' : fileChecked(s) ? '참여자 직접 확인 표시 · ' + D.fmt(s.files!.verifiedAt!) : 'ZIP 전송 기록 · ' + D.fmt(at) + ' · 직접 확인 전';
    const line = el('div', 'mut', text); line.dataset.fileReceipt = '1'; line.title = '전송과 참여자의 ZIP 직접 확인 기록입니다. 확인 시각 이후 수정한 파일과 PC 저장 상태를 자동 검사하지 않습니다.'; return line;
  }
  function diagnosticsCells(tr: HTMLTableRowElement, s: MonSeat) {
    const d = s.diagnostics, usage = tr.insertCell();
    const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    usage.textContent = d && valid(d.usage) && (d.limit === null || valid(d.limit)) && freshAt(d.usageAt)
      ? '사용액 $' + d.usage.toFixed(2) + (d.limit === null ? ' · 한도 없음' : ' / $' + d.limit.toFixed(2)) + ' · 기준 ' + D.fmt(d.usageAt as number) + ' (' + D.ago(d.usageAt as number) + ')'
      : '사용액 확인 안 됨' + (timestamp(d?.usageAt) && d.usageAt <= D.now() ? ' · 마지막 기준 ' + D.fmt(d.usageAt) + ' · 오래된 확인' : '');
    const ec = tr.insertCell(), e = d?.aiError;
    const kinds: Record<string, string> = { 'rate-limit': '요청 한도', access: '접근 권한', upstream: '제공자 장애', request: '요청 오류', other: '기타 오류' };
    ec.textContent = e && freshAt(e.at) && Number.isSafeInteger(e.count) && e.count > 0 && Object.hasOwn(kinds, e.kind)
      ? '최근 AI 오류: ' + kinds[e.kind] + ' · ' + D.fmt(e.at) + ' · ' + e.count + '회' : '최근 AI 오류 확인 안 됨';
    if (e && freshAt(e.at)) ec.className = 'bad';
  }

  // 참가자 상태 (Teams 비슷하게). '몇 분 전' 은 서버 시계 기준 (pages.ts 의 ago)
  const PR: Record<string, string> = { active: '🟢', away: '🟡', offline: '⚫', none: '○' };
  const ST: Record<string, string> = { started: '켜짐', stopped: '멈춤', archived: '보관', creating: '만드는 중', starting: '켜는 중', pulling_snapshot: '준비 중', error: '오류', build_failed: '오류', gone: '없음' };
  const presOf = (s: { presence?: LabPresence }): LabPresence => s.presence || { state: 'none' };
  function presText(s: { presence?: LabPresence; opened?: number; lastAi?: number }) {
    const p = presOf(s);
    const t = p.state === 'active' ? '활동 중' : p.state === 'away' ? '자리 비움 · ' + D.dur(p.idleSec || 0) + '째' : p.state === 'offline' ? '오프라인 · ' + D.ago(p.lastSeen as number) : timestamp(s.opened) ? '신호 없음' : '입장 전';
    return PR[p.state] + ' ' + t + (s.lastAi ? ' · AI ' + D.ago(s.lastAi) : '');
  }
  function presTitle(s: { presence?: LabPresence; opened?: number }) {
    const p: Partial<LabPresence> = s.presence || {};
    return [(p.tabs as number) > 1 ? '탭 ' + p.tabs + '개 중 가장 최근 입력 기준' : '', p.watch ? '강사 보기 탭 ' + p.watch + '개(판정에서 뺌)' : '', p.state === 'none' && timestamp(s.opened) ? '입장했지만 아직 신호가 없습니다 (서버가 다시 뜬 직후일 수 있음)' : ''].filter(Boolean).join(' · ');
  }

  // ── 카드 위쪽: 이름·요약·참가자 상태 수·실패/장애 알림 ──
  function labMeta(lab: LabItem) {
    return D.joined(lab) + ' · ' + lab.cpu + ' vCPU·' + lab.memory + ' GiB · $' + lab.budget + '/명 · ' + lab.model + ' · ~' + D.fmt(lab.expiresAt)
      + ' · ' + remaining(lab.expiresAt) + (lab.materials ? ' · 자료 있음' : '') + (lab.ending ? ' · 정리 재시도 중' : '') + (lab.stateError ? ' · 상태 조회 실패: ' + lab.stateError : '');
  }
  function presenceLine(lab: { seats: Array<{ error?: unknown; presence?: LabPresence }> }) {
    const live = lab.seats.filter((s) => !s.error), n = (k: string) => live.filter((s) => presOf(s).state === k).length;
    const ps = el('p', 'mut'); ps.title = '활동 중 · 자리 비움(5분 넘게 입력 없음) · 오프라인(3분 넘게 신호 없음) · 입장 전';
    ps.textContent = '🟢 ' + n('active') + ' · 🟡 ' + n('away') + ' · ⚫ ' + n('offline') + (n('none') ? ' · ○ ' + n('none') : '');
    return ps;
  }
  // 쓸 수 있는 자리가 하나도 없으면 준비된 것처럼 보이지 않게: 첫 오류를 위에, 초대·QR 은 숨김. 카드는 남겨 확인·끝내기용
  function failLines(c: HTMLElement, lab: LabItem, ok: boolean) {
    if (!ok) { c.dataset.labFail = 'all'; c.style.borderColor = 'var(--bad)'; }
    if (!ok || D.failed(lab).length) {
      const o = el('p', 'bad'); o.dataset.failNote = '1';
      o.textContent = ok ? '⚠ ' + D.failNote(lab) : '⚠ 자리를 하나도 준비하지 못했습니다 — 참가자가 들어갈 수 없어 초대 링크를 숨겼습니다. 첫 오류: ' + D.firstErr(lab) + ' · 확인 후 "지금 끝내기" 로 정리하세요.';
      c.append(o);
    }
    if (lab.outage) c.append(el('p', 'bad', '⚠ 전체 문제일 수 있음: ' + lab.outage));
  }

  // ── 수업 단위 조작: 클립보드 · 초대 링크 모두 복사 · 새로고침/끝내기 ──
  // 클립보드 두 방향은 늘 같이 보낸다 (바꾼 쪽만 새 값). 실패하면 체크를 되돌린다
  function clipRow(lab: LabItem) {
    const cp = lab.clip || { in: true, out: true }; const r = el('div', 'row');
    const ck = (txt: string, key: keyof LabClip) => {
      const l = el('label'); const i = el('input'); i.type = 'checkbox'; i.checked = cp[key];
      i.onchange = async () => {
        const n = { in: cp.in, out: cp.out }; n[key] = i.checked;
        try {
          const x = await D.setClip(lab.id, n); cp.in = x.clip.in; cp.out = x.clip.out;
          D.say('클립보드: ' + (cp.in ? '붙여넣기 허용' : '붙여넣기 막음') + ' · ' + (cp.out ? '밖으로 복사 허용' : '밖으로 복사 막음') + ' — 참가자 화면에 30초 안에 반영', 'ok');
        } catch (e) { i.checked = !i.checked; D.say(errMsg(e), 'bad'); }
      };
      l.append(i, ' ' + txt); return l;
    };
    r.append(ck('내 PC → 실습실 붙여넣기', 'in'), ck('실습실 → 내 PC 복사', 'out'));
    return r;
  }
  const openSections = new Map<string, boolean>();
  function section(label: string, note: string | undefined, ...nodes: Array<HTMLElement | undefined | null | false>) {
    const kids = nodes.filter((n): n is HTMLElement => !!n);
    if (!kids.length) return null;
    const s = label === '명령 전달' ? el('section') : el('details');
    s.setAttribute('aria-label', label);
    if (s instanceof HTMLDetailsElement) { s.dataset.labSection = label; s.append(el('summary', undefined, label)); }
    else s.append(el('h3', undefined, label));
    if (note) s.append(el('p', 'mut', note));
    for (const n of kids) s.append(n);
    return s;
  }
  function inviteRow(lab: LabItem) {
    const r1 = el('div', 'row'); r1.dataset.invites = '1';
    const b1 = D.btn('초대 링크 모두 복사', 'sec', async () => {
      try {
        const x = await D.inviteAll(lab);
        await D.copy(b1, x.seats.map((v) => v.n + '번' + (v.who ? ' ' + v.who : '') + ' ' + v.link).join('\n'));
        D.say('자리 ' + x.seats.length + '개의 초대 링크를 복사했습니다 — 자리마다 그 사람에게만 주세요.', 'ok');
      } catch (e) { D.say(errMsg(e), 'bad'); }
    });
    b1.style.flex = '1';
    const p = el('span', 'mut', '자리마다 따로: 아래 표의 "초대" 로 QR 을 크게 띄우거나 링크를 복사합니다.'); p.style.flex = '2'; p.style.alignSelf = 'center';
    r1.append(b1, p);
    return r1;
  }
  function endRow(lab: LabItem) {
    const row = el('div', 'row');
    const rf = D.btn('새로고침', 'sec', () => D.reload().catch((e) => D.say(errMsg(e), 'bad'))); rf.style.flex = '1';
    const end = D.btn('지금 끝내기', 'bad', async () => {
      const unverified = lab.seats.filter(s => (s.opened || s.who) && !fileChecked(s)).length;
      if (!confirm(lab.name + ' 을(를) 끝낼까요? 실습실과 작업 내용, 내부 체크포인트, 토큰이 모두 지워집니다.' + (unverified ? '\n최근 목록 기준 ' + unverified + '자리에 ZIP 직접 확인 표시가 없습니다. 참여자들이 파일을 챙겼는지 먼저 확인하세요.' : '') + '\n직접 확인 표시 이후 수정한 파일도 별도로 저장하고 내려받아야 합니다. 지금 끝내려면 확인을 누르세요.')) return;
      try { await D.endLab(lab.id); D.say('끝냈습니다.', 'ok'); } catch (e) { D.say(errMsg(e), 'bad'); }
      D.reload();
    });
    end.style.flex = '1';
    row.append(rf, end);
    return row;
  }

  // ── 자리 표: 한 줄에 번호·이름(손)·상태·참가자 상태·입장/자료·사용액·공유 호출 수·최근 오류·조작 ──
  function whoCell(tr: HTMLTableRowElement, lab: LabItem, s: LabSeat) {
    const wc = tr.insertCell(); wc.textContent = s.who || '';
    if (!s.hand) return;
    const b = D.btn('✋ ' + D.fmt(s.hand), 'bad', async () => { try { await D.lowerHand(lab.id, s.n); D.reload(); } catch (e) { D.say(errMsg(e), 'bad'); } });
    b.title = '눌러서 내리기'; small(b, '2px 6px', '6px'); wc.append(b);
  }
  function setupNote(s: { setup?: { state: string; note?: string } }) {
    if (!s.setup) return '';
    return ' · 자료 ' + (s.setup.state === 'ok' ? 'OK' : s.setup.state === 'running' ? '넣는 중' : '실패: ' + s.setup.note);
  }
  function infoCells(tr: HTMLTableRowElement, lab: LabItem, s: LabSeat) {
    tr.insertCell().textContent = s.error ? ('실패: ' + D.cleanErr(s.error)) : (ST[s.state as string] || s.state || '');
    const prep = tr.insertCell(); prep.textContent = prepText(s); if (prepState(s) === 'error') prep.className = 'bad';
    const pc = tr.insertCell(); if (!s.error) { pc.textContent = presText(s); pc.title = presTitle(s); pc.style.whiteSpace = 'nowrap'; }
    const note = tr.insertCell(); note.textContent = (timestamp(s.opened) ? '서버 입장 ' + D.fmt(s.opened) : '입장 전') + setupNote(s); if (s.setup && s.setup.state === 'error') note.className = 'bad';
    note.append(deliveryLine(s), fileLine(s));
    tr.insertCell().textContent = s.usage == null ? '' : '$' + s.usage.toFixed(2) + (s.limit ? ' / $' + s.limit : '');
    const share = lab.share || [];
    if (share.length) {
      const used = (x: LabShare) => (s.counts || {})[x.id] || 0;
      const sc = tr.insertCell(); sc.textContent = share.map((x) => x.label + ' ' + used(x) + '/' + x.cap).join(' · '); if (share.some((x) => used(x) >= x.cap)) sc.className = 'bad';
    }
    const ec = tr.insertCell(); if (s.err) { ec.className = 'bad'; ec.textContent = D.fmt(s.err.at) + ' ' + s.err.status + (s.err.n > 1 ? ' ×' + s.err.n : ''); ec.title = s.err.msg; }
  }
  // 실패한 자리에는 초대·보기를 주지 않는다. 초대 링크는 그 자리 번호(n)로만 받는다
  function seatActions(td: HTMLTableCellElement, lab: LabItem, s: LabSeat) {
    const q = small(D.btn('초대', 'sec', async () => { try { D.showInvite(lab, await D.inviteSeat(lab, s.n)); } catch (e) { D.say(errMsg(e), 'bad'); } }), '4px 8px'); q.dataset.invite = String(s.n);
    const b = small(D.btn('링크 복사', 'sec', async () => { try { await D.copy(b, (await D.inviteSeat(lab, s.n)).link); } catch (e) { D.say(errMsg(e), 'bad'); } }), '4px 8px', '4px');
    td.append(q, b, watchButton(lab, s));
    if (D.helpSeat) {
      const h = small(D.btn('도와주기', 'sec', () => D.helpSeat!(lab.id, s.n)), '4px 8px', '4px');
      h.dataset.help = String(s.n);
      td.append(h);
    }
  }
  // 강사 보기: 새 탭에 초대 화면(?watch=1)을 열고 거기서 "입장" — 쿠키는 그 자리 주소에만 생겨 다른 자리 탭은 그대로다.
  // 팝업 차단을 피하려고 누른 순간 빈 탭을 먼저 열고, 링크를 받은 뒤 opener 를 끊고 보낸다 (실패하면 닫는다)
  function watchButton(lab: LabItem, s: LabSeat) {
    return small(D.btn('작업 공간 열기', 'sec', async () => {
      if (!confirm(s.n + '번 참여자와 같은 파일·실습실을 새 탭에서 엽니다. 참여자가 현재 보는 화면을 함께 보려면 모임 화면의 도와주기를 사용하세요.')) return;
      const t = window.open('about:blank', '_blank');
      try { const x = await D.inviteSeat(lab, s.n); if (t) { t.opener = null; t.location.href = x.link + '?watch=1'; } } catch (e) { if (t) t.close(); D.say(errMsg(e), 'bad'); }
    }), '4px 8px', '4px');
  }
  function seatNumber(tr: HTMLTableRowElement, n: number) {
    tr.insertCell().textContent = n + '번';
  }
  function addHead(t: HTMLTableElement, labels: string[]) {
    const tr = t.createTHead().insertRow();
    for (const text of labels) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = text; tr.append(th); }
  }
  function renderSeat(t: HTMLTableSectionElement, lab: LabItem, s: LabSeat) {
    const tr = t.insertRow(); tr.dataset.seat = String(s.n); seatNumber(tr, s.n);
    whoCell(tr, lab, s);
    infoCells(tr, lab, s);
    const td = tr.insertCell(); if (!s.error && !lab.trialOf) seatActions(td, lab, s);
  }
  // 자리 표는 폰 폭을 넘을 수 있어 표만 가로로 밀리게 (페이지 가로 스크롤 없음)
  function seatTable(lab: LabItem) {
    const t = el('table');
    const labels = ['자리', '참여자', '실습실', '서버 준비', '지금 상태', '입장 · 자료', '사용액'];
    if ((lab.share || []).length) labels.push('나눠 준 키');
    labels.push('최근 오류', '동작');
    addHead(t, labels);
    const body = t.createTBody();
    for (const s of lab.seats) renderSeat(body, lab, s);
    const tw = el('div'); tw.className = 'seat-wrap'; tw.style.overflowX = 'auto'; tw.append(t);
    return tw;
  }

  // ── 수업 카드 하나 ──
  function renderLab(lab: LabItem) {
    const c = el('div', 'card'); c.dataset.lab = lab.id;
    if (D.selectedId?.() === lab.id) c.dataset.selected = '1';
    const hands = lab.seats.filter((s) => s.hand).length;
    const ok = D.usable(lab);
    if (!D.selectedId) c.append(el('b', undefined, lab.name), el('p', 'mut', labMeta(lab)), presenceLine(lab), preparationLine(lab));
    else { const info = section('모임 정보', undefined, el('p', 'mut', labMeta(lab)), presenceLine(lab), preparationLine(lab)); if (info) c.append(info); }
    if (lab.trialOf) c.append(el('p', 'mut', '모임지기 시험용 실습실 · 참여자 입장을 받지 않습니다. 연결한 모임을 끝내면 함께 정리합니다.'));
    failLines(c, lab, ok);
    // 명령 전달 일시정지는 메뉴 안에 넣지 않는다. 실행 중인 프로그램을 끄는 동작이 아니다.
    const pause = ok && !lab.ending && D.controlBox && !D.controlDock?.(lab.id) ? D.controlBox(lab) : undefined;
    const pauseSection = section('명령 전달', '이 모임의 새 명령 전달만 멈춥니다. 이미 실행 중인 프로그램을 끄는 버튼이 아닙니다.', pause);
    if (pauseSection) c.append(pauseSection);
    const code = ok && !lab.ending ? D.snipBox(lab) : undefined;
    const codeSection = section('코드 보내기', '대상: 이 모임 참여자의 받은 코드. 효과: 글만 전달합니다. 터미널에서 실행하지 않습니다.', code);
    if (codeSection) c.append(codeSection);
    const term = ok && !lab.ending && !lab.trialOf && D.terminalBox ? D.terminalBox(lab) : undefined;
    const termSection = section('터미널 실행', '대상: 고른 참여자 자리의 터미널. 효과: 명령을 실제로 실행합니다. 코드 보내기와 다릅니다.', term);
    if (termSection) c.append(termSection);
    const tools = section('모임 도구', '시험, 체크포인트, 자리 복구, 도우미, 실행 중단입니다. 명령 전달 일시정지와 실행 중단은 서로 다릅니다.',
      ok && !lab.ending && !lab.trialOf && D.trialBox ? D.trialBox(lab) : undefined,
      ok && !lab.ending && !lab.trialOf && D.checkpointBox ? D.checkpointBox(lab) : undefined,
      ok && !lab.ending && !lab.trialOf && D.recoveryBox ? D.recoveryBox(lab) : undefined,
      ok && !lab.ending && !lab.trialOf && D.assistantBox ? D.assistantBox(lab) : undefined,
      ok && !lab.ending && !lab.trialOf && D.interruptBox ? D.interruptBox(lab) : undefined);
    if (tools) c.append(tools);
    const shares = (lab.share || []).map((x) => D.shareRow(lab, x));
    const resource = section('모델 · 자원 · 클립보드', lab.model + ' · ' + lab.cpu + ' vCPU · ' + lab.memory + ' GiB · 1인 $' + lab.budget + (lab.materials ? ' · 자료 있음' : ''), clipRow(lab), ...shares);
    if (resource) c.append(resource);
    if (ok && !lab.trialOf) {
      const invites = section('초대', '자리마다 초대 링크가 다릅니다. 참여자 본인에게만 주세요.', inviteRow(lab));
      if (invites) c.append(invites);
    }
    // 모임 화면이 떠 있으면 시작 버튼은 그쪽으로 둔다. 공유 중 멈춤이 화면에서 사라지면 pages 의 shareHold 가 남긴다.
    if ((ok || D.sharing(lab.id)) && !D.omitScreen?.(lab.id)) {
      const share = section('화면 공유', '이 기기 화면을 참여자 실습실에 보냅니다. 모임 화면이 켜져 있으면 그쪽 버튼을 쓰고, 여기에는 두지 않습니다.', D.screenRow(lab));
      if (share) c.append(share);
    }
    if (hands) c.append(el('p', 'bad', '✋ 손 든 사람 ' + hands + '명'));
    const people = section('참여자', '표는 서버가 아는 자리 상태입니다. 들어가 보기는 별도 실습실 작업 공간이고, 모임 화면은 참여자가 지금 보는 미리보기입니다.', seatTable(lab));
    if (people) c.append(people);
    const finish = section('마무리', '참여자가 내려받은 ZIP을 직접 열어 확인했는지 먼저 살펴보세요. 모임을 끝내면 실습실과 그 안의 파일이 지워집니다.', endRow(lab));
    if (finish) c.append(finish);
    return { card: c, hands };
  }

  // 목록 전체를 다시 그린다. 손 든 사람 수를 돌려준다 (탭 제목은 pages.ts 가)
  function orderLabs<T extends { id: string }>(labs: T[]) {
    if (!D.selectedId) return labs;
    const id = D.selectedId();
    return labs.filter(l => l.id === id);
  }
  function rememberSections(box: HTMLElement) {
    for (const d of box.querySelectorAll<HTMLDetailsElement>('details[data-lab-section]')) {
      const id = d.closest<HTMLElement>('[data-lab]')?.dataset.lab;
      if (id) openSections.set(id + ':' + d.dataset.labSection, d.open);
    }
  }
  function restoreSections(box: HTMLElement) {
    for (const d of box.querySelectorAll<HTMLDetailsElement>('details[data-lab-section]')) {
      const id = d.closest<HTMLElement>('[data-lab]')?.dataset.lab;
      if (id) d.open = openSections.get(id + ':' + d.dataset.labSection) ?? false;
    }
  }
  function renderLabs(box: HTMLElement, labs: LabItem[]) {
    rememberSections(box); box.replaceChildren(); let hn = 0;
    for (const lab of orderLabs(labs)) { const r = renderLab(lab); hn += r.hands; box.append(r.card); }
    restoreSections(box);
    if (!labs.length) box.append(el('p', 'mut', '진행 중인 모임이 없습니다.'));
    return hn;
  }
  // ── 읽기 전용 카드 (관리 작업 시간이 끝났거나 모니터만 있을 때): 버튼·초대·오류 원문 없음 ──
  function monitorCard(lab: MonLab) {
    const c = el('div', 'card'); c.dataset.lab = lab.id; c.dataset.readonly = '1';
    if (D.selectedId?.() === lab.id) c.dataset.selected = '1';
    const live = lab.seats.filter((s) => !s.error), bad = lab.seats.length - live.length, hands = live.filter((s) => s.hand).length;
    c.append(el('b', undefined, lab.name),
      el('p', 'mut', live.filter((s) => timestamp(s.opened)).length + ' / ' + live.length + ' 명 입장 · ~' + D.fmt(lab.expiresAt) + ' · ' + remaining(lab.expiresAt) + (lab.ending ? ' · 정리 재시도 중' : '')),
      presenceLine(lab), preparationLine(lab),
      el('p', 'mut', '참여자 표는 서버가 아는 자리 상태입니다. 모임 화면의 현재 미리보기와는 다릅니다.'));
    if (bad) c.append(el('p', 'bad', '⚠ ' + bad + '/' + lab.seats.length + '자리 준비 실패 — 자세한 오류는 보안 키로 다시 확인하면 보입니다.'));
    if (hands) c.append(el('p', 'bad', '✋ 손 든 사람 ' + hands + '명'));
    const t = el('table');
    addHead(t, ['자리', '참여자', '서버 준비', '지금 상태', '입장 · 자료', '사용액', '최근 AI 오류']);
    const body = t.createTBody();
    for (const s of lab.seats) {
      const tr = body.insertRow(); tr.dataset.seat = String(s.n); seatNumber(tr, s.n);
      const wc = tr.insertCell(); wc.textContent = s.who || '';
      if (s.hand && !s.error) { const h = el('span', 'bad', ' ✋ ' + D.fmt(s.hand)); h.title = '손 듦 — 내리려면 보안 키로 다시 확인'; wc.append(h); }
      const prep = tr.insertCell(); prep.textContent = prepText(s); if (prepState(s) === 'error') prep.className = 'bad';
      const pc = tr.insertCell(); pc.style.whiteSpace = 'nowrap';
      if (s.error) { pc.textContent = '준비 실패'; pc.className = 'bad'; } else { pc.textContent = presText(s); pc.title = presTitle(s); }
      const note = tr.insertCell(); note.textContent = (timestamp(s.opened) ? '서버 입장 ' + D.fmt(s.opened) : '입장 전') + setupNote(s); if (s.setup && s.setup.state === 'error') note.className = 'bad';
      note.append(deliveryLine(s));
      diagnosticsCells(tr, s);
    }
    const tw = el('div'); tw.style.overflowX = 'auto'; tw.append(t);
    const people = section('참여자 상태 상세', '실시간 화면은 위 모아보기에서 확인할 수 있습니다.', tw); if (people) c.append(people);
    return { card: c, hands };
  }
  function renderMonitor(box: HTMLElement, labs: MonLab[]) {
    rememberSections(box); box.replaceChildren(); let hn = 0;
    for (const lab of orderLabs(labs)) { const r = monitorCard(lab); hn += r.hands; box.append(r.card); }
    restoreSections(box);
    if (!labs.length) box.append(el('p', 'mut', '진행 중인 모임이 없습니다.'));
    return hn;
  }
  return { renderLabs, renderMonitor };
}
