// 참가자 VS Code(code-server) 화면 오른쪽 아래에 붙는 작은 막대. 실습실 호스트가 workbench HTML 에 <script src="/__lab/bar.js"> 를 끼운다.
// 남은 시간·사용액, 클립보드 규칙, ⬇ 내 작업 받기(~/work zip), ✋ 손 들기, ↗ 다른 실습실(실습실 앱). 끝나기 10분 전에 한 번 알린다.
// code-server 페이지는 Trusted Types 를 쓸 수 있어 innerHTML 없이 DOM API 로만 만든다.

import { LAB_FILES_JS } from '#lab-files';

export const LAB_BAR_JS = `(() => {
${LAB_FILES_JS}
if (window.__labBar) return; window.__labBar = 1;
const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
const BTN = 'all:unset;cursor:pointer;padding:3px 9px;border-radius:6px;background:rgba(255,255,255,.12);white-space:nowrap';
const box = el('div', 'position:fixed;right:14px;bottom:30px;z-index:2147483000;display:flex;flex-wrap:wrap;max-width:calc(100vw - 28px);gap:6px;align-items:center;padding:5px 7px;border-radius:9px;background:#1f2937ee;color:#e5e7eb;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px #0006;user-select:none');
const time = el('span', 'padding:0 4px;font-variant-numeric:tabular-nums');
const money = el('span', 'padding:0 4px;opacity:.85;font-variant-numeric:tabular-nums');
const dl = el('button', BTN, '⬇ 내 작업 받기'); dl.title = 'work 폴더를 zip 으로 내려받습니다 (node_modules 제외)';
const uploadHelp = el('button', BTN + ';min-height:28px', '파일 올리기 안내');
uploadHelp.title = '내 컴퓨터의 파일을 실습실로 가져오는 방법';
uploadHelp.setAttribute('aria-expanded', 'false'); uploadHelp.setAttribute('aria-controls', 'lab-upload-help');
let uploadPanel = null;
const closeUploadHelp = (focus = false) => {
  if (uploadPanel) uploadPanel.style.display = 'none';
  uploadHelp.setAttribute('aria-expanded', 'false');
  if (focus) uploadHelp.focus();
};
const placeUploadHelp = () => {
  if (!uploadPanel || uploadPanel.style.display === 'none') return;
  const bottom = Math.ceil(window.innerHeight - box.getBoundingClientRect().top + 8);
  uploadPanel.style.bottom = bottom + 'px';
  uploadPanel.style.maxHeight = Math.max(80, window.innerHeight - bottom - 14) + 'px';
};
const focusRing = (button) => {
  button.addEventListener('focus', () => { button.style.outline = '2px solid #fbbf24'; button.style.outlineOffset = '2px'; });
  button.addEventListener('blur', () => { button.style.outline = ''; });
};
focusRing(uploadHelp);
uploadHelp.onclick = () => {
  if (uploadPanel && uploadPanel.style.display !== 'none') { closeUploadHelp(); return; }
  if (!uploadPanel) {
    const panel = uploadPanel = el('section', 'box-sizing:border-box;position:fixed;right:14px;z-index:2147483000;width:min(430px,calc(100vw - 28px));overflow:auto;padding:18px;border:1px solid #64748b;border-radius:12px;background:#1f2937;color:#f3f4f6;font:14px/1.6 system-ui,sans-serif;user-select:text;overflow-wrap:anywhere');
    panel.id = 'lab-upload-help'; panel.setAttribute('aria-labelledby', 'lab-upload-title');
    const heading = el('h2', 'font-size:17px;margin:0 0 10px', '내 파일을 실습실로 가져오기'); heading.id = 'lab-upload-title';
    const steps = el('ol', 'padding-left:22px;margin:0 0 12px');
    steps.append(el('li', '', '왼쪽 파일 목록에서 work 폴더를 오른쪽 클릭하고 Upload…(업로드)를 고르세요. 목록이 안 보이면 왼쪽 탐색기 아이콘을 누르세요.'));
    steps.append(el('li', '', '내 컴퓨터에서 파일을 선택하세요. 파일 목록에 이름이 나타나고 직접 열리는지 확인하세요. 같은 이름이 있으면 덮어쓰기 전에 확인하세요.'));
    steps.append(el('li', '', 'OpenCode 입력창에서 아래처럼 파일 이름과 할 일을 알려주세요. 실제 올린 파일 이름으로 바꿔 쓰세요.'));
    const example = el('code', 'display:block;white-space:pre-wrap;padding:10px;background:#111827;font:13px/1.6 system-ui,sans-serif', '내메모.txt를 읽고 핵심 내용을 정리해줘. 원본은 유지하고 결과는 정리.txt로 저장해줘.');
    const drag = el('p', 'margin:12px 0', '또는 Windows 탐색기·Finder의 파일을 실습실 왼쪽 파일 목록으로 끌어다 놓으세요. OpenCode 대화창에 파일 경로만 붙여넣는 것과는 달라요.');
    const formats = el('p', 'margin:12px 0', '처음에는 TXT·CSV 같은 텍스트 파일로 해보세요. Word·Excel·PDF는 업로드 후에도 읽기 도구나 변환이 필요할 수 있어요.');
    const save = el('p', 'margin:12px 0', '작업 뒤에는 파일을 저장하고 “내 작업 받기”로 내려받아 내 컴퓨터에서 직접 열어보세요. 실습실은 임시 공간입니다.');
    const privacy = el('p', 'margin:12px 0;font-size:12px;color:#cbd5e1', '실습실 화면은 모임지기에게 공유됩니다. AI에게 읽도록 요청한 내용은 모델 제공자에게 전달되므로 개인정보·회사 기밀이 없는 연습용 파일을 사용하세요.');
    const close = el('button', BTN + ';min-height:36px;padding:4px 12px', '안내 닫기'); close.type = 'button'; focusRing(close); close.onclick = () => closeUploadHelp(true);
    panel.append(heading, steps, example, drag, formats, save, privacy, close); document.body.append(panel);
    window.addEventListener('resize', placeUploadHelp);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.style.display !== 'none') {
        const inHelp = panel.contains(document.activeElement) || document.activeElement === uploadHelp;
        closeUploadHelp(inHelp);
        if (inHelp) { e.preventDefault(); e.stopPropagation(); }
      }
    });
  }
  uploadPanel.style.display = 'block'; uploadHelp.setAttribute('aria-expanded', 'true'); placeUploadHelp();
};
const hand = el('button', BTN, '✋ 손 들기'); hand.title = '모임지기 화면에 표시됩니다';
// 실습실 앱(입장 호스트)으로: 다른 실습실 초대 링크를 열거나 앱을 설치하는 곳. 이 자리 주소는 수업이 끝나면 사라지므로 여기서 설치하지 않는다
const home = el('button', BTN, '↗ 다른 실습실'); home.title = '실습실 앱 화면으로 갑니다 — 다른 초대 링크로 들어가거나 앱을 설치할 수 있습니다 (이 자리는 그대로 남습니다)';
const fold = el('button', BTN + ';padding:3px 7px', '–'); fold.title = '접기/펴기';
const lesson = el('button', BTN + ';background:#1d4ed8;color:#fff', '수업 터미널'); lesson.style.display = 'none';
lesson.title = '모임지기와 함께 실행하는 수업 터미널에 연결합니다';
let lessonReady = false, lessonDialog = null;
const lessonState = (value) => { lessonReady = !!(value && value.active === true && value.selected === true && value.ready === true); lesson.style.display = lessonReady && !folded ? '' : 'none'; if (!lessonReady && lessonDialog) lessonDialog.close(); };
lesson.onclick = () => {
  if (!lessonReady) return;
  if (!lessonDialog) {
    const d = lessonDialog = el('dialog', 'box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;padding:24px;border:1px solid #475569;border-radius:12px;background:#1f2937;color:#f3f4f6;font:14px/1.6 system-ui,sans-serif;box-shadow:0 8px 32px #0006');
    const heading = el('h2', 'font-size:18px;margin:0 0 12px', '모임지기와 수업 터미널 함께 보기'); heading.id = 'lab-lesson-title'; d.setAttribute('aria-labelledby', heading.id);
    const intro = el('p', '', '모임지기가 보낸 입력은 내 실습실의 수업 터미널에서 실행됩니다. 아래 방법으로 결과를 볼 수 있어요. 개인 터미널과 별도이며, 이 보기에서는 입력할 수 없습니다.');
    const steps = el('ol', 'padding-left:20px');
    steps.append(el('li', '', 'VS Code 위 메뉴에서 터미널 → 새 터미널을 여세요. 단축키: Ctrl+Shift+백틱(' + String.fromCharCode(96) + ').'));
    steps.append(el('li', '', '터미널 옆 아래 화살표에서 “수업 따라보기 (모임지기와 함께 보기)” 프로필을 고르세요.'));
    steps.append(el('li', '', '프로필이 보이지 않으면 새 터미널에 아래 명령을 붙여넣고 Enter를 누르세요.'));
    const command = 'tmux -u attach -r -t gw-lesson';
    const code = el('code', 'display:block;padding:12px;border-radius:6px;background:#111827;overflow-wrap:anywhere;user-select:text', command);
    const feedback = el('p', 'min-height:1.6em'); feedback.setAttribute('role', 'status');
    const copyLesson = el('button', BTN + ';padding:10px 14px;background:#1d4ed8;color:#fff', '연결 명령 복사');
    copyLesson.onclick = async () => { try { await navigator.clipboard.writeText(command); feedback.textContent = '복사했습니다. 새 터미널에 붙여넣고 Enter를 누르세요.'; } catch { feedback.textContent = '복사하지 못했습니다. 위 명령을 직접 선택해서 복사하세요.'; } };
    const closeLesson = el('button', BTN + ';padding:10px 14px;margin-left:8px', '닫기'); closeLesson.onclick = () => d.close();
    const ending = el('p', '', '모임지기가 전송을 중지해도 실행 중인 명령과 결과는 남습니다. 연결이 안 되면 모임지기에게 자리 번호를 알려주세요.');
    d.append(heading, intro, steps, code, feedback, copyLesson, closeLesson, ending); document.body.append(d);
  }
  if (!lessonDialog.open) lessonDialog.showModal();
};
const msg = el('div', 'position:fixed;right:14px;bottom:70px;z-index:2147483000;max-width:340px;padding:10px 12px;border-radius:9px;background:#b45309;color:#fff;font:13px/1.5 system-ui,sans-serif;box-shadow:0 2px 10px #0006;display:none;cursor:pointer');
box.append(time, money, uploadHelp, dl, hand, home, lesson, fold);
const clip = el('span', 'padding:0 4px;opacity:.85;white-space:nowrap');
box.insertBefore(clip, dl);
let me = null, up = false, warned = false, warned5 = false, warned1 = false, folded = false, lastBlock = 0, serverOffset = 0;
let statusFlight = null, refreshPending = false, statusRevision = 0;
const CLIP_NOTE = { in: '모임지기가 내 PC 에서 붙여넣기를 막아 두었습니다. 실습실 안에서 복사한 것은 붙여넣을 수 있어요.', out: '모임지기가 실습실 밖으로 복사를 막아 두었습니다. 실습실 안에서는 그대로 붙여넣을 수 있어요.' };
if (window.__labClip) window.__labClip.listeners.push((dir) => { if (Date.now() - lastBlock > 4000) { lastBlock = Date.now(); note(CLIP_NOTE[dir] + ' (눌러서 닫기)', '#374151'); } });
const clipLabel = (p) => p.in && p.out ? '' : !p.in && !p.out ? '📋 실습실 안에서만' : !p.in ? '📋 붙여넣기 막힘' : '📋 밖으로 복사 막힘';
try { folded = localStorage.getItem('labBarFolded') === '1'; } catch {}
const layout = () => { for (const x of [money, clip, uploadHelp, dl, hand, home]) x.style.display = folded ? 'none' : ''; if (folded) closeUploadHelp(); else placeUploadHelp(); lesson.style.display = lessonReady && !folded ? '' : 'none'; if(window.__labFileUI)window.__labFileUI.fold(folded);fold.textContent = folded ? '+' : '–'; };
const note = (t, bg) => { msg.textContent = t; msg.style.background = bg || '#b45309'; msg.style.display = 'block'; };
msg.onclick = () => { msg.style.display = 'none'; };
window.__labBarUI = { box, note, el, BTN }; // 다른 막대 스크립트가 알림과 버튼을 추가할 때.
fold.onclick = () => { folded = !folded; try { localStorage.setItem('labBarFolded', folded ? '1' : '0'); } catch {} layout(); };
function tick() {
  if (!me) return;
  const s = Math.floor((me.expiresAt - Date.now() - serverOffset) / 1000);
  if (s <= 0) { time.textContent = '⏱ 수업 끝'; time.style.color = '#f87171'; return; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  time.textContent = '⏱ ' + (h ? h + '시간 ' : '') + m + '분 남음';
  time.style.color = s < 600 ? '#fbbf24' : '';
  if (s < 60 && !warned1) { warned1 = warned5 = warned = true; note('1분 안에 모임이 끝나며 실습실 파일과 내부 체크포인트가 삭제됩니다. 확인 표시 이후 수정한 파일도 저장하고 내 작업 받기로 챙기세요. (눌러서 닫기)'); }
  else if (s < 300 && !warned5 && !me.files?.transfer?.verifiedAt) { warned5 = warned = true; note('5분 안에 모임이 끝납니다. 파일을 저장하고 ZIP을 내려받아 직접 열어 확인해주세요. 실습실 안의 체크포인트만으로는 보존되지 않습니다. (눌러서 닫기)'); }
  else if (s < 600 && !warned) { warned = true; note('수업이 ' + Math.max(1, Math.ceil(s / 60)) + '분 뒤 끝나고, 실습실의 파일은 모두 지워집니다. 남길 것은 ⬇ 내 작업 받기로 챙기세요. (눌러서 닫기)'); }
}
const fmt = (v) => '$' + (v < 0.01 && v > 0 ? v.toFixed(3) : v.toFixed(2));
// 참가자 상태 신호: 마지막 입력 후 경과 초·탭 보임/포커스·탭 id(탭마다, sessionStorage)·모임지기 "들어가 보기" 탭 여부. 입력 내용은 없다
const ss = (k, v) => { try { if (v !== undefined) sessionStorage.setItem(k, v); return sessionStorage.getItem(k); } catch { return null; } };
const TAB = ss('labTab') || ss('labTab', Math.random().toString(36).slice(2, 12) + Date.now().toString(36)) || 'tab-' + Math.random().toString(36).slice(2, 12);
const WATCH = ss('labWatch') === '1';
const L = window.__labClip;
let lastIn = Date.now(), sent = 0;
if (!(L && L.touch)) for (const ty of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(ty, (e) => { if (e.isTrusted) lastIn = Date.now(); }, { capture: true, passive: true });
const presence = () => ({ tab: TAB, idle: Math.max(0, Math.floor((Date.now() - ((L && L.input) || lastIn)) / 1000)), vis: document.visibilityState, focus: document.hasFocus(), watch: WATCH });
const soon = () => { if (Date.now() - sent > 10000) load(); }; // 오래 쉬다 돌아옴·탭이 다시 보임 → 30초 기다리지 않고 (10초에 한 번까지)
if (L && L.onInput) L.onInput.push((was) => { if (Date.now() - was > 60000) soon(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
time.title = '모임지기에게는 활동 중/자리 비움 여부와 시각만 보입니다 (무엇을 입력했는지는 보내지 않습니다)';
// 응답과 JSON 읽기를 하나의 마감으로 묶는다. abort 를 무시하는 늦은 결과도 화면에 쓰지 않는다.
const REQUEST_MS = 10000, EXPORT_MS = 300000; // 서버 묶기 240초 + 준비·응답 여유 (서버 pack TTL 300초)
const timeoutError = () => Object.assign(new Error('응답이 늦어 결과를 확인하지 못했습니다.'), { timeout: true });
async function request(path, options, wait = REQUEST_MS) {
  const controller = new AbortController(), deadline = Date.now() + wait;
  let live = true, timer;
  const current = () => { if (!live || Date.now() >= deadline) throw timeoutError(); };
  try {
    return await Promise.race([
      (async () => {
        const r = await fetch(path, { ...options, signal: controller.signal }); current();
        const j = await r.json(); current();
        if (!r.ok) throw new Error(j && j.error || 'HTTP ' + r.status);
        return j;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { live = false; controller.abort(); reject(timeoutError()); }, wait); }),
    ]);
  } finally { live = false; clearTimeout(timer); }
}
const showHand = () => {
  hand.textContent = up ? '✋ 손 내리기' : '✋ 손 들기';
  hand.style.background = up ? '#b45309' : 'rgba(255,255,255,.12)';
};
const stale = () => {
  lessonState(null);
  me = null; time.textContent = '⏱ 상태 확인 지연'; time.style.color = '#fbbf24'; money.textContent = '';
  box.title = '상태를 확인하지 못했습니다. 잠시 뒤 다시 확인합니다.';
  clip.title = '마지막으로 확인한 클립보드 규칙 — 새 상태를 기다리는 중';
};
// 새 상태가 올 때까지 마지막 규칙을 표시·유지한다 (조회 실패가 허용으로 바뀌지는 않는다).
if (L && L.policy) clip.textContent = clipLabel(L.policy);
function load(refresh = false) {
  if (statusFlight) { if (refresh) refreshPending = true; return statusFlight; }
  const revision = statusRevision;
  statusFlight = (async () => {
    try {
      sent = Date.now();
      const next = await request('/__lab/me', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(presence()) });
      if (revision !== statusRevision || hand.disabled) return;
      if (!next || !Number.isFinite(next.expiresAt) || (next.clip && (typeof next.clip.in !== 'boolean' || typeof next.clip.out !== 'boolean'))) throw new Error('상태 응답을 읽지 못했습니다.');
      me = next; up = !!me.hand;
      if(Number.isFinite(me.now))serverOffset=me.now-Date.now();
      lessonState(me.lesson);
      if(window.__labFileUI)window.__labFileUI.take(me.files);
      if (me.clip) { if (window.__labClip) window.__labClip.set(me.clip); clip.textContent = clipLabel(me.clip); clip.title = '모임지기가 정한 클립보드 규칙 (내 PC ↔ 실습실)'; }
      money.textContent = me.usage == null ? '' : fmt(me.usage) + (me.limit ? ' / $' + me.limit : '');
      showHand();
      box.title = (me.name || '') + ' · ' + me.seat + '번' + (me.who ? ' · ' + me.who : '');
      tick();
    } catch { if (revision === statusRevision && !hand.disabled) stale(); }
    finally {
      statusFlight = null;
      if (refreshPending) { refreshPending = false; load(); }
    }
  })();
  return statusFlight;
}
hand.onclick = async () => {
  if (hand.disabled) return;
  const intended = !up; hand.disabled = true; statusRevision++;
  try {
    await request('/__lab/hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ up: intended }) });
    up = intended; showHand();
    if (up) note('모임지기 화면에 ✋ 가 떴습니다. 잠시 기다려 주세요. (눌러서 닫기)', '#374151');
  } catch (e) {
    note(e && e.timeout ? '손 변경의 응답이 늦어 결과를 확인하지 못했습니다. 서버에서 바뀌었을 수도 있어 상태를 다시 확인합니다. (눌러서 닫기)' : '손을 바꾸지 못했습니다: ' + (e && e.message || e), '#b91c1c');
  } finally { hand.disabled = false; statusRevision++; load(true); }
};
dl.onclick = async () => {
  if (dl.disabled) return;
  const o = dl.textContent; dl.textContent = '묶는 중…'; dl.disabled = true;
  try {
    // 서버가 샌드박스에서 묶은 뒤 한 번 쓰는 표를 준다 → 브라우저가 바로 파일로 받는다 (메모리에 통째로 담지 않음)
    const j = await request('/__lab/export', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' }, EXPORT_MS);
    const a = el('a'); a.href = '/__lab/export/' + encodeURIComponent(j.ticket); a.download = j.name || 'work.zip'; document.body.append(a); a.click(); a.remove();
    if(window.__labFileUI)window.__labFileUI.download(j.receiptId);
    note('받는 중: ' + a.download + ' (' + Math.max(1, Math.round((j.size || 0) / 1024)) + ' KB' + (j.skipped ? ', 링크·특수 파일 등 ' + j.skipped + '개 건너뜀' : '') + ') — 브라우저 다운로드 목록을 보세요', '#047857');
  } catch (e) {
    note(e && e.timeout ? '묶기 응답이 늦어 결과를 확인하지 못했습니다. 서버에서 작업이 끝났을 수도 있으니 잠시 뒤 다시 시도해 주세요. (눌러서 닫기)' : '받지 못했습니다: ' + (e && e.message || e), '#b91c1c');
  } finally { dl.textContent = o; dl.disabled = false; }
};
// 같은 창·같은 출처의 고정 주소 — 서버가 실습실 앱(입장 호스트 /)으로 보낸다. 초대 코드·쿼리는 넘기지 않는다
home.onclick = () => { location.href = '/__lab/home'; };
const bootClassroom = () => {
  if (window.__labClassroomBoot) return;
  window.__labClassroomBoot = 1;
  let found = false;
  try { found = !!(document.querySelector && document.querySelector('script[src="/__lab/classroom.js"]')); } catch (e) { found = false; }
  if (found) return;
  const s = document.createElement('script');
  s.src = '/__lab/classroom.js';
  s.async = false;
  document.body.append(s);
};
const mount = () => { if (!document.body) return setTimeout(mount, 200); document.body.append(box, msg); layout(); load(); setInterval(load, 30000); setInterval(tick, 10000); bootClassroom(); };
window.__labFileUI=createLabFileUI({box,note,el,BTN,request});
mount();
})();
`;

// ── 클립보드 경계 (모임지기가 방향별로 켜고 끔) ──
// 실습실 호스트가 VS Code 문서와 그 안 iframe 의 <head> 맨 앞에 <script src="/__lab/guard.js"> 를 끼운다 (앱 코드보다 먼저).
// guard.js = `window.__labClipPolicy = {in, out};` + 아래 코드. 막힌 방향은:
//   out(실습실 → 내 PC): 복사·잘라내기·clipboard.write 가 실습실 안 버퍼에만 들어가고, PC 클립보드에는 안내 문구(MARK)만 간다.
//   in (내 PC → 실습실): 붙여넣기·clipboard.read 는 실습실 안 버퍼만 준다. 밖에서 끌어다 놓는 글자도 막는다.
// 그래서 실습실 안 복사·붙여넣기는 늘 된다. 브라우저 안 JS 로 거는 규칙이라 개발자 도구·확장 프로그램·화면 캡처까지 막는 경계는 아니다.
export const LAB_GUARD_JS = `(() => {
const MARK = '(실습실 밖으로 복사가 막혀 있습니다)';
let S;
try { if (window.top !== window && window.top.__labClip) S = window.top.__labClip; } catch {}
if (!S) {
  const p = window.__labClipPolicy || {};
  S = { policy: { in: p.in !== false, out: p.out !== false }, buf: '', listeners: [],
    set(q) { this.policy = { in: q.in !== false, out: q.out !== false }; },
    blocked(dir) { for (const f of this.listeners) { try { f(dir); } catch {} } } };
}
// 참가자 상태(모임지기 표의 활동 중·자리 비움): 마지막 키보드·마우스 입력 시각만 적는다 — 무엇을 눌렀는지는 보지도 보내지도 않는다.
// iframe(웹뷰)의 입력도 top 의 같은 S 에 모인다. 막대가 S.input 을 읽고, S.onInput 으로 오래 쉬다 돌아온 입력을 바로 알린다
if (!S.touch) {
  S.input = Date.now(); S.onInput = [];
  S.touch = function (t) { const was = this.input; this.input = t; for (const f of this.onInput) { try { f(was); } catch {} } };
}
function install(w) {
  try { if (w.__labClip) return; w.__labClip = S; } catch { return; }
  let moved = 0;
  const act = (e) => {
    if (!e.isTrusted) return;
    const t = Date.now();
    if (e.type === 'pointermove') { if (t - moved < 2000) return; moved = t; } // 마우스 움직임은 2초에 한 번만
    S.touch(t);
  };
  for (const ty of ['keydown', 'pointerdown', 'wheel', 'pointermove']) w.addEventListener(ty, act, { capture: true, passive: true });
  const C = w.Clipboard && w.Clipboard.prototype;
  if (C) {
    const wt = C.writeText, wr = C.write, rt = C.readText, rd = C.read;
    const item = (t) => [new w.ClipboardItem({ 'text/plain': new w.Blob([t], { type: 'text/plain' }) })];
    C.writeText = function (t) {
      S.buf = String(t);
      if (S.policy.out) return wt.call(this, t);
      S.blocked('out'); return wt.call(this, MARK).catch(() => {});
    };
    C.write = async function (items) {
      let t = '';
      try { for (const it of items) if (it.types.includes('text/plain')) { t = await (await it.getType('text/plain')).text(); break; } } catch {}
      S.buf = t;
      if (S.policy.out) return wr.call(this, items);
      S.blocked('out'); return wt.call(this, MARK).catch(() => {});
    };
    C.readText = async function () {
      if (!S.policy.in) { S.blocked('in'); return S.buf; }
      const t = await rt.call(this);
      return t === MARK ? S.buf : t;
    };
    C.read = async function () {
      if (!S.policy.in) { S.blocked('in'); return S.buf ? item(S.buf) : []; }
      const items = await rd.call(this);
      try { for (const it of items) if (it.types.includes('text/plain') && (await (await it.getType('text/plain')).text()) === MARK) return item(S.buf); } catch {}
      return items;
    };
  }
  const synth = (type, target, dt) => {
    let ev; try { ev = new w.ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true, composed: true }); } catch { return null; }
    if (!ev.clipboardData) return null;
    (target || w.document).dispatchEvent(ev);
    return ev;
  };
  const onCopy = (e) => {
    if (!e.isTrusted || !e.clipboardData || (S.policy.in && S.policy.out)) return; // 둘 다 허용이면 손대지 않는다
    // 앱(Monaco 등)이 채우는 내용을 가짜 이벤트로 받아 버퍼에 두고, 허용될 때만 진짜 클립보드로 옮긴다
    e.stopImmediatePropagation(); e.preventDefault();
    const dt = new w.DataTransfer();
    const ev = synth(e.type, e.target, dt);
    let types = [...dt.types];
    if (!types.length && !(ev && ev.defaultPrevented)) {
      const s = String(w.getSelection() || '');
      if (s) { dt.setData('text/plain', s); types = ['text/plain']; }
      if (e.type === 'cut' && s) { try { w.document.execCommand('delete'); } catch {} }
    }
    if (!types.length) return;
    S.buf = dt.getData('text/plain');
    if (S.policy.out) { for (const t of types) e.clipboardData.setData(t, dt.getData(t)); }
    else { e.clipboardData.setData('text/plain', MARK); S.blocked('out'); }
  };
  const onPaste = (e) => {
    if (!e.isTrusted) return;
    const os = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (S.policy.in && os !== MARK) return; // 평소대로
    e.stopImmediatePropagation(); e.preventDefault();
    if (!S.policy.in) S.blocked('in');
    if (!S.buf) return;
    const dt = new w.DataTransfer(); dt.setData('text/plain', S.buf);
    synth('paste', e.target, dt);
  };
  let inside = false;
  w.addEventListener('copy', onCopy, true);
  w.addEventListener('cut', onCopy, true);
  w.addEventListener('paste', onPaste, true);
  w.addEventListener('dragstart', () => { inside = true; }, true);
  w.addEventListener('dragend', () => { inside = false; }, true);
  // 밖에서 끌어다 놓는 글자 (파일 끌어다 놓기 = 올리기는 따로 둔다)
  w.addEventListener('drop', (e) => {
    const ext = !inside && e.isTrusted && e.dataTransfer && ![...e.dataTransfer.types].includes('Files');
    inside = false;
    if (ext && !S.policy.in) { e.preventDefault(); e.stopImmediatePropagation(); S.blocked('in'); }
  }, true);
  // 밖으로 끌어내는 글자·링크·파일(DownloadURL) — 앱이 채운 뒤(버블 단계)에 지운다. VS Code 내부 형식은 남긴다
  w.addEventListener('dragstart', (e) => {
    if (S.policy.out || !e.dataTransfer) return;
    for (const t of ['text/plain', 'text/html', 'text/uri-list', 'DownloadURL']) { try { e.dataTransfer.clearData(t); } catch {} }
  }, false);
  // 같은 출처 iframe (웹뷰 등) 에도 건다
  const frames = w.document.getElementsByTagName('iframe');
  const hook = () => {
    for (const f of frames) {
      if (f.__labHooked) continue;
      f.__labHooked = 1;
      const go = () => { try { if (f.contentWindow) install(f.contentWindow); } catch {} };
      go(); f.addEventListener('load', go);
    }
  };
  try { new w.MutationObserver(hook).observe(w.document, { childList: true, subtree: true }); } catch {}
  hook();
}
install(window);
})();
`;
