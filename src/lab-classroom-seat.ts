// 참여자 수업 창. code-server 를 바꾸지 않고 같은 자리 문서에 안내 패널을 붙인다.
// 글은 textContent 만. 자료·제출·녹화 주소는 서버 값이며 iframe 으로 열지 않는다.
// 상태 조회는 보일 때 5초보다 빠르지 않게, 숨기면 멈추고, pagehide 에서도 멈춘다.
// 다른 단계로 옮기면 저장 전에 완료를 끈다. 같은 단계를 다시 누르면 완료를 지우지 않는다.
// 상태 세대는 진행·제출 쓰기 시작과 끝에 올린다. 그보다 앞선 상태 응답은 진행과 제출을 되돌리지 않는다.

export const LAB_CLASSROOM_SEAT_JS = String.raw`(() => {
if (window.__labClassroomSeat) return;
window.__labClassroomSeat = 1;
const ACTIVE_MS = 5000;
const WAIT_MS = 10000;
const NARROW = '(max-width: 719px)';
const MODES = {
  demo: ['시연 보기', '시연은 모임지기 실습실에서 실행됩니다. 내 파일과 터미널은 바뀌지 않습니다.'],
  together: ['함께 실행', '함께 실행은 모임지기가 대상을 확인한 뒤에만 각자 실습실에서 따로 실행됩니다. 이 표시만으로 명령이 실행되지 않습니다.'],
  individual: ['개인 실습', '내 실습실에서 따로 작업합니다.']
};

const start = () => {
  if (!document.body || !document.documentElement) return setTimeout(start, 300);
  const el = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
  const style = el('style');
  style.textContent = 'html.lab-classroom-reserve .monaco-workbench{right:280px!important;width:auto!important}.lab-classroom-toggle,.lab-classroom-panel button,.lab-classroom-panel a{font:inherit}.lab-classroom-panel :focus-visible,.lab-classroom-toggle:focus-visible{outline:2px solid #315cf2;outline-offset:2px}';
  (document.head || document.documentElement).append(style);

  const toggle = el('button', '수업 안내');
  toggle.id = 'lab-classroom-open';
  toggle.type = 'button';
  toggle.className = 'lab-classroom-toggle';
  toggle.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147482500;box-sizing:border-box;min-height:36px;padding:6px 10px;border:1px solid #c9c9c2;border-radius:12px;background:#fff;color:#20242c;cursor:pointer;font:14px/1.4 system-ui,sans-serif';
  toggle.setAttribute('aria-controls', 'lab-classroom-panel');

  const panel = el('aside');
  panel.id = 'lab-classroom-panel';
  panel.className = 'lab-classroom-panel';
  panel.setAttribute('aria-labelledby', 'lab-classroom-instruction-title');
  panel.style.cssText = 'box-sizing:border-box;position:fixed;top:0;right:0;bottom:0;z-index:2147482500;width:min(280px,100vw);overflow:auto;padding:12px 12px 96px;background:#f7f7f5;color:#20242c;border-left:1px solid #d9d9d3;font:14px/1.5 system-ui,sans-serif';

  const btnCss = 'box-sizing:border-box;max-width:100%;min-height:36px;margin:4px 6px 4px 0;padding:6px 10px;border:1px solid #c9c9c2;border-radius:12px;background:#fff;color:#20242c;cursor:pointer';
  const primaryCss = btnCss + ';background:#315cf2;color:#fff;border-color:#315cf2';
  const closeBtn = el('button', '안내 접기');
  closeBtn.id = 'lab-classroom-close';
  closeBtn.type = 'button';
  closeBtn.style.cssText = btnCss;

  const statusLine = el('p', '수업 안내를 불러오는 중…');
  statusLine.setAttribute('role', 'status');
  statusLine.style.cssText = 'overflow-wrap:anywhere;margin:8px 0';

  const tabs = el('div');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '수업 안내 구역');
  const tabNames = [['guide', '안내'], ['files', '자료'], ['submit', '제출']];
  const tabButtons = {};
  for (const [id, label] of tabNames) {
    const b = el('button', label);
    b.type = 'button';
    b.style.cssText = btnCss;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'lab-classroom-tab-' + id);
    b.dataset.tab = id;
    tabButtons[id] = b;
    tabs.append(b);
  }

  const guide = el('section');
  guide.dataset.tab = 'guide';
  guide.id = 'lab-classroom-tab-guide';
  const instructionTitle = el('h2', '이 단계 안내');
  instructionTitle.id = 'lab-classroom-instruction-title';
  instructionTitle.style.cssText = 'font-size:18px;margin:8px 0';
  const classTitle = el('p');
  classTitle.style.cssText = 'margin:4px 0;overflow-wrap:anywhere';
  const modeLine = el('p');
  modeLine.style.cssText = 'margin:4px 0;overflow-wrap:anywhere';
  const teacherLine = el('p');
  teacherLine.style.cssText = 'margin:4px 0;overflow-wrap:anywhere';
  const ownLine = el('p');
  ownLine.style.cssText = 'margin:4px 0;overflow-wrap:anywhere';
  const stepTitle = el('h3');
  stepTitle.style.cssText = 'font-size:16px;margin:8px 0 4px;overflow-wrap:anywhere';
  const goalLabel = el('p', '이번 안내');
  goalLabel.style.cssText = 'margin:8px 0 2px;font-weight:700';
  const instruction = el('p');
  instruction.style.cssText = 'margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere';
  const promptLabel = el('p', '예시 문장');
  promptLabel.style.cssText = 'margin:8px 0 2px;font-weight:700';
  const prompt = el('pre');
  prompt.style.cssText = 'margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 system-ui,sans-serif';
  const copyBtn = el('button', '예시 문장 복사');
  copyBtn.type = 'button';
  copyBtn.style.cssText = btnCss;
  const prevBtn = el('button', '이전 단계');
  prevBtn.type = 'button';
  prevBtn.style.cssText = btnCss;
  const nextBtn = el('button', '다음 단계');
  nextBtn.type = 'button';
  nextBtn.style.cssText = btnCss;
  const doneLabel = el('label');
  doneLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:8px 0';
  const doneBox = el('input');
  doneBox.type = 'checkbox';
  doneBox.id = 'lab-classroom-done';
  doneBox.style.cssText = 'width:auto;margin-top:4px';
  doneLabel.append(doneBox, el('span', '이 단계를 마친 것으로 표시'));
  doneLabel.htmlFor = doneBox.id;
  const helpBtn = el('button', '이 단계로 도움 요청');
  helpBtn.type = 'button';
  helpBtn.style.cssText = btnCss;
  const helpNote = el('p');
  helpNote.setAttribute('role', 'status');
  helpNote.style.cssText = 'overflow-wrap:anywhere;margin:4px 0';
  const progressNote = el('p');
  progressNote.setAttribute('role', 'status');
  progressNote.style.cssText = 'overflow-wrap:anywhere;margin:4px 0';
  const progressRetry = el('button', '같은 진행 다시 시도');
  progressRetry.type = 'button';
  progressRetry.style.cssText = btnCss;
  const emptyNote = el('p', '아직 수업 안내가 없습니다. 편집기는 그대로 쓸 수 있습니다.');
  emptyNote.style.cssText = 'overflow-wrap:anywhere';
  guide.append(instructionTitle, classTitle, modeLine, teacherLine, ownLine, emptyNote, stepTitle, goalLabel, instruction, promptLabel, prompt, copyBtn, prevBtn, nextBtn, doneLabel, helpBtn, helpNote, progressNote, progressRetry);

  const files = el('section');
  files.dataset.tab = 'files';
  files.id = 'lab-classroom-tab-files';
  const filesHead = el('h2', '자료');
  filesHead.style.cssText = 'font-size:16px;margin:12px 0 4px';
  const materialList = el('div');
  const materialNote = el('p');
  materialNote.setAttribute('role', 'status');
  materialNote.style.cssText = 'overflow-wrap:anywhere';
  const recordLine = el('p');
  recordLine.style.cssText = 'overflow-wrap:anywhere;margin:8px 0';
  const chapterList = el('div');
  const uploadHead = el('h2', '파일 올리기');
  uploadHead.style.cssText = 'font-size:16px;margin:12px 0 4px';
  const uploadGuide = el('p', '파일을 이 패널이 대신 올리지 않습니다. 편집기 왼쪽 탐색기에서 work 폴더를 연 뒤, 내 컴퓨터 파일을 끌어다 놓거나 폴더를 오른쪽 클릭해 Upload…를 고르세요.');
  uploadGuide.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0';
  const explorerBtn = el('button', '탐색기 열기');
  explorerBtn.type = 'button';
  explorerBtn.style.cssText = btnCss;
  const uploadNote = el('p');
  uploadNote.setAttribute('role', 'status');
  uploadNote.style.cssText = 'overflow-wrap:anywhere';
  files.append(filesHead, materialList, materialNote, recordLine, chapterList, uploadHead, uploadGuide, explorerBtn, uploadNote);

  const submitSec = el('section');
  submitSec.dataset.tab = 'submit';
  submitSec.id = 'lab-classroom-tab-submit';
  const submitHead = el('h2', '제출');
  submitHead.style.cssText = 'font-size:16px;margin:12px 0 4px';
  const submitHint = el('p', '제출은 실습실에 저장한 결과.txt 를 모임지기에게 보내는 것입니다. 화면에서 글을 받아 대신 저장하지 않습니다.');
  submitHint.style.cssText = 'overflow-wrap:anywhere';
  const submitBtn = el('button', '결과 제출');
  submitBtn.type = 'button';
  submitBtn.style.cssText = primaryCss;
  const submitNote = el('p');
  submitNote.setAttribute('role', 'status');
  submitNote.style.cssText = 'overflow-wrap:anywhere';
  const versionList = el('div');
  const versionDetail = el('div');
  versionDetail.style.cssText = 'margin-top:8px;overflow-wrap:anywhere;white-space:pre-wrap';
  const zipHead = el('h2', '내 컴퓨터에 보관');
  zipHead.style.cssText = 'font-size:16px;margin:12px 0 4px';
  const zipHint = el('p', '내 작업 받기는 work 폴더 ZIP입니다. 내려받은 뒤 내 컴퓨터에서 직접 열어 확인하는 기록은 파일 보존 확인에 남습니다. 제출, ZIP 내려받기, 직접 확인은 서로 다릅니다.');
  zipHint.style.cssText = 'overflow-wrap:anywhere';
  const zipBtn = el('button', '내 작업 받기');
  zipBtn.type = 'button';
  zipBtn.style.cssText = btnCss;
  const ackBtn = el('button', '파일 보존 확인 열기');
  ackBtn.type = 'button';
  ackBtn.style.cssText = btnCss;
  const zipNote = el('p');
  zipNote.setAttribute('role', 'status');
  zipNote.style.cssText = 'overflow-wrap:anywhere';
  submitSec.append(submitHead, submitHint, submitBtn, submitNote, versionList, versionDetail, zipHead, zipHint, zipBtn, ackBtn, zipNote);

  panel.append(closeBtn, statusLine, tabs, guide, files, submitSec);
  document.body.append(toggle, panel);

  let stopped = false, timer = 0, statusFlight = null, lastStart = 0;
  let snap = null, dirty = false, ownStep = 0, ownDone = false, tab = 'guide';
  let progressFlight = false, progressQueued = false, submitFlight = false;
  let submitId = null, submitUnknown = false, progressUnknown = false;
  let statusError = '', statusErrorAt = 0, statusOkAt = 0;
  let progressError = '', progressErrorAt = 0, submitError = '', submitErrorAt = 0;
  let statusGen = 0, cursorRefresh = false;
  let open = !window.matchMedia(NARROW).matches;
  let narrowWas = window.matchMedia(NARROW).matches;
  let detailId = '';

  const narrow = () => window.matchMedia(NARROW).matches;
  const stamp = (t) => { try { return new Date(t).toLocaleString('ko-KR'); } catch (e) { return ''; } };
  const clamp = (n, len) => Number.isInteger(n) && len > 0 ? Math.max(0, Math.min(len - 1, n)) : 0;
  const stepsOf = () => snap && snap.classroom && Array.isArray(snap.classroom.steps) ? snap.classroom.steps : [];
  const stepAt = (i) => { const steps = stepsOf(); return steps[i] || null; };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const setDisabled = (node, value) => { node.disabled = value; node.style.opacity = value ? '0.55' : '1'; node.style.cursor = value ? 'not-allowed' : 'pointer'; node.setAttribute('aria-disabled', value ? 'true' : 'false'); };

  function httpsUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch (e) { return ''; }
  }
  function safeName(name) {
    const base = String(name == null ? '' : name).split(/[/\\]/).pop() || '';
    const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().replace(/^\.+/, '').slice(0, 80);
    return cleaned || '자료.txt';
  }
  function validStep(s) {
    return !!s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.instruction === 'string' && typeof s.prompt === 'string';
  }
  function validSub(s) {
    return !!s && typeof s.id === 'string' && typeof s.filename === 'string' && typeof s.content === 'string' && Number.isInteger(s.version) && typeof s.feedback === 'string';
  }
  function validSnap(d) {
    if (!d || typeof d !== 'object' || !d.classroom || !d.progress || !Array.isArray(d.submissions)) return false;
    const c = d.classroom, p = d.progress;
    if (typeof c.title !== 'string' || !Number.isInteger(c.currentStep) || !Array.isArray(c.steps) || c.steps.some((s) => !validStep(s))) return false;
    if (c.mode !== 'demo' && c.mode !== 'together' && c.mode !== 'individual') return false;
    if (!Number.isInteger(p.step) || typeof p.completed !== 'boolean') return false;
    if (d.submissions.some((s) => !validSub(s))) return false;
    return true;
  }

  function reserveWorkbench(on) {
    document.documentElement.classList.toggle('lab-classroom-reserve', on);
    const wb = document.querySelector && document.querySelector('.monaco-workbench');
    if (!wb || !wb.style) return;
    if (on) {
      if (wb.dataset.labClassroomHeld !== '1') {
        wb.dataset.labClassroomHeld = '1';
        wb.dataset.labClassroomRight = wb.style.right || '';
        wb.dataset.labClassroomWidth = wb.style.width || '';
      }
      wb.style.right = '280px';
      wb.style.width = 'auto';
      return;
    }
    if (wb.dataset.labClassroomHeld === '1') {
      wb.style.right = wb.dataset.labClassroomRight || '';
      wb.style.width = wb.dataset.labClassroomWidth || '';
      delete wb.dataset.labClassroomHeld;
      delete wb.dataset.labClassroomRight;
      delete wb.dataset.labClassroomWidth;
    }
  }
  function layout() {
    const isNarrow = narrow();
    panel.hidden = !open;
    toggle.hidden = open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    reserveWorkbench(open && !isNarrow);
    tabs.hidden = !isNarrow;
    for (const section of [guide, files, submitSec]) section.hidden = !!(isNarrow && section.dataset.tab !== tab);
    for (const [id, button] of Object.entries(tabButtons)) {
      const on = id === tab;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
  }
  function setOpen(next, focus) {
    open = !!next;
    layout();
    if (!focus) return;
    if (open) closeBtn.focus(); else toggle.focus();
  }

  function paint() {
    const steps = stepsOf();
    const ready = !!snap && !stopped;
    const empty = ready && steps.length === 0;
    const mine = stepAt(ownStep);
    const teacherIndex = snap && snap.classroom ? snap.classroom.currentStep : -1;
    const teacher = stepAt(teacherIndex);
    const mode = snap && snap.classroom && MODES[snap.classroom.mode];
    classTitle.textContent = snap && snap.classroom ? snap.classroom.title : '';
    modeLine.textContent = mode ? mode[0] + ' · ' + mode[1] : '';
    teacherLine.textContent = teacher ? '모임지기 안내 ' + (teacherIndex + 1) + '/' + steps.length + ' · ' + teacher.title : (ready && !empty ? '모임지기 안내가 단계 밖에 있습니다.' : '');
    ownLine.textContent = mine ? '내 단계 ' + (ownStep + 1) + '/' + steps.length + ' · ' + mine.title : '';
    stepTitle.textContent = mine ? mine.title : '';
    instruction.textContent = mine ? mine.instruction : '';
    prompt.textContent = mine ? mine.prompt : '';
    emptyNote.hidden = !empty;
    goalLabel.hidden = !mine;
    instruction.hidden = !mine;
    promptLabel.hidden = !mine;
    prompt.hidden = !mine;
    const locked = !ready || empty || progressFlight || submitFlight;
    setDisabled(prevBtn, locked || ownStep <= 0);
    setDisabled(nextBtn, locked || !mine || ownStep >= steps.length - 1);
    setDisabled(copyBtn, !mine);
    setDisabled(doneBox, locked);
    setDisabled(helpBtn, !mine || stopped);
    setDisabled(submitBtn, !ready || stopped || submitFlight || progressFlight);
    doneBox.checked = !!ownDone;
    progressRetry.hidden = !progressUnknown || progressFlight || submitFlight;
    submitBtn.textContent = submitUnknown ? '같은 제출 다시 확인' : (submitFlight ? '제출 확인 중…' : '결과 제출');
    if (statusError) statusLine.textContent = statusError + ' · ' + stamp(statusErrorAt) + (statusOkAt ? ' · 마지막 안내 ' + stamp(statusOkAt) : '');
    else if (!snap) statusLine.textContent = '수업 안내를 불러오는 중…';
    else statusLine.textContent = '마지막 확인 ' + stamp(statusOkAt);
    progressNote.textContent = progressError ? progressError + ' · ' + stamp(progressErrorAt) : (progressFlight ? '내 단계를 저장하는 중…' : '');
    submitNote.textContent = submitError ? submitError + ' · ' + stamp(submitErrorAt) + (submitUnknown && submitId ? ' · 같은 제출 번호로 다시 확인하세요.' : '') : (submitFlight ? '저장한 결과.txt 제출을 확인하는 중…' : '');
    paintMaterials();
    paintVersions();
    layout();
  }
  function paintMaterials() {
    clear(materialList);
    clear(chapterList);
    clear(recordLine);
    const c = snap && snap.classroom;
    const materials = c && Array.isArray(c.materials) ? c.materials : [];
    if (!materials.length) materialList.append(el('p', snap ? '받은 자료가 없습니다.' : ''));
    for (const material of materials) {
      if (!material || typeof material.name !== 'string') continue;
      const row = el('div');
      row.style.cssText = 'margin:6px 0';
      const name = el('span', material.name);
      name.style.cssText = 'display:block;overflow-wrap:anywhere';
      const download = el('button', '자료 내려받기');
      download.type = 'button';
      download.style.cssText = btnCss;
      download.onclick = () => downloadMaterial(material);
      row.append(name, download);
      materialList.append(row);
    }
    const href = c ? httpsUrl(c.recordingUrl) : '';
    if (href) {
      const link = el('a', '녹화 외부 링크로 열기');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      recordLine.append(el('span', '녹화는 이 창 안에 넣지 않습니다. '), link);
    } else if (c) recordLine.append(el('span', '녹화 주소가 없습니다.'));
    const chapters = c && Array.isArray(c.chapters) ? c.chapters : [];
    for (const chapter of chapters) {
      if (!chapter || typeof chapter.title !== 'string' || !Number.isInteger(chapter.step)) continue;
      const row = el('div');
      row.style.margin = '6px 0';
      const seconds = Number.isFinite(chapter.seconds) ? ' · ' + chapter.seconds + '초' : '';
      const label = el('span', chapter.title + seconds);
      label.style.cssText = 'display:block;overflow-wrap:anywhere';
      const jump = el('button', '내 단계로 이동');
      jump.type = 'button';
      jump.style.cssText = btnCss;
      jump.disabled = !stepAt(chapter.step) || progressFlight || submitFlight || stopped;
      jump.onclick = () => { moveOwn(chapter.step); };
      row.append(label, jump);
      chapterList.append(row);
    }
  }
  function moveOwn(next) {
    if (stopped || progressFlight || submitFlight) return;
    if (!stepAt(next) || next === ownStep) return;
    ownStep = next;
    ownDone = false;
    dirty = true;
    paint();
    saveProgress();
  }
  function paintVersions() {
    clear(versionList);
    const list = snap && Array.isArray(snap.submissions) ? snap.submissions : [];
    if (snap && !list.length) versionList.append(el('p', '아직 제출이 없습니다.'));
    for (const item of list) {
      const openVersion = el('button', '제출 ' + item.version + ' · ' + item.filename);
      openVersion.type = 'button';
      openVersion.style.cssText = btnCss + ';display:block;white-space:normal';
      openVersion.onclick = () => { detailId = item.id; paintVersions(); };
      versionList.append(openVersion);
    }
    clear(versionDetail);
    const picked = list.find((item) => item.id === detailId);
    if (!picked) return;
    versionDetail.append(el('p', '제출 차례 ' + picked.version));
    versionDetail.append(el('p', picked.filename));
    versionDetail.append(el('p', picked.content));
    versionDetail.append(el('p', picked.feedback ? '모임지기 의견' : '모임지기 의견은 아직 없습니다.'));
    if (picked.feedback) versionDetail.append(el('p', picked.feedback));
    versionDetail.append(el('p', '의견은 읽기만 합니다. 누르는 것으로 수락하지 않습니다.'));
  }
  function downloadMaterial(material) {
    if (!material || typeof material.content !== 'string') {
      materialNote.textContent = '자료 내용이 없어 내려받지 않습니다.';
      return;
    }
    const blob = new Blob([material.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = safeName(material.name);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    materialNote.textContent = '자료 파일을 내려받았습니다. ' + a.download;
  }
  function currentHelpText() {
    const mine = stepAt(ownStep);
    const title = snap && snap.classroom ? snap.classroom.title : '';
    return ['수업 단계 도움', title, mine ? mine.title : '', mine ? mine.instruction : ''].filter(Boolean).join('\n').slice(0, 2000);
  }
  function askHelp() {
    const box = window.__labBarUI && window.__labBarUI.box;
    const buttons = box && box.querySelectorAll ? [...box.querySelectorAll('button')] : [];
    const help = buttons.find((b) => (b.textContent || '').includes('도움 요청'));
    const text = currentHelpText();
    if (help) {
      const title = document.getElementById('lab-help-title');
      const dialog = title && title.closest ? title.closest('dialog') : null;
      if (!dialog || !dialog.open) help.click();
      const opened = document.getElementById('lab-help-title');
      const live = opened && opened.closest ? opened.closest('dialog') : dialog;
      const area = live && live.querySelector ? live.querySelector('textarea') : null;
      if (area && !area.value.trim() && !area.disabled) area.value = text;
      helpNote.textContent = '도움 요청 창에 이 단계 안내를 넣었습니다. 보내기는 그 창에서 직접 합니다. 해결로 표시하지 않습니다.';
      return;
    }
    const hand = buttons.find((b) => (b.textContent || '').includes('손 들기'));
    if (hand && !hand.disabled) {
      hand.click();
      helpNote.textContent = '손 들기를 표시했습니다. 단계 안내를 대신 해결하지 않습니다.';
      return;
    }
    helpNote.textContent = '도움 요청 버튼을 찾지 못했습니다. 아래 막대의 손 들기나 도움 요청을 사용해 주세요.';
  }
  function clickBar(pred) {
    const box = window.__labBarUI && window.__labBarUI.box;
    if (!box || !box.querySelectorAll) return false;
    for (const button of box.querySelectorAll('button')) {
      if (pred(button.textContent || '')) { button.click(); return true; }
    }
    return false;
  }
  function openExplorer() {
    const selectors = ['.activitybar [aria-label*="Explorer"]', '.activitybar [aria-label*="탐색기"]', '[aria-label^="Explorer"]', '.codicon-explorer-view-icon'];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      const target = node && node.closest ? (node.closest('a,button,.action-item') || node) : node;
      if (target && typeof target.click === 'function') {
        target.click();
        uploadNote.textContent = '탐색기를 열었습니다. 파일 목록에 끌어다 놓거나 오른쪽 클릭의 Upload…로 올리세요. 이 안내가 파일을 대신 올리지 않습니다.';
        return;
      }
    }
    uploadNote.textContent = '왼쪽 탐색기 아이콘을 눌러 주세요. 이 화면은 파일을 올리지 않습니다.';
  }

  function stopPoll() { clearTimeout(timer); timer = 0; }
  function arm() {
    stopPoll();
    if (stopped || document.visibilityState === 'hidden') return;
    timer = setTimeout(() => { timer = 0; loadStatus(); }, ACTIVE_MS);
  }
  function stopAuth() {
    stopped = true;
    stopPoll();
    statusError = '실습실 연결을 확인해 주세요.';
    statusErrorAt = Date.now();
    paint();
  }
  async function request(path, body, waitMs) {
    const controller = new AbortController();
    let live = true, timerId = 0;
    const timeout = waitMs > 0 ? new Promise((_, reject) => {
      timerId = setTimeout(() => {
        live = false;
        controller.abort();
        reject(Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true }));
      }, waitMs);
    }) : null;
    const work = (async () => {
      let response;
      try {
        const opt = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal };
        if (body !== undefined) { opt.headers = { 'content-type': 'application/json' }; opt.body = JSON.stringify(body); }
        response = await fetch(path, opt);
      } catch (e) {
        if (!live) return null;
        throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true });
      }
      if (!live) return null;
      let text = '';
      try { text = await response.text(); } catch (e) {
        if (!live) return null;
        throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true });
      }
      if (!live) return null;
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = null; } } else parsed = {};
      if ([401, 403, 404, 410].includes(response.status)) throw Object.assign(new Error((parsed && parsed.error) || '다시 연결해 주세요.'), { status: response.status, auth: true });
      const known = response.status >= 400 && response.status < 500 && parsed && typeof parsed === 'object';
      if (!response.ok || !parsed || typeof parsed !== 'object') throw Object.assign(new Error((parsed && parsed.error) || ('HTTP ' + response.status)), { status: response.status, known: !!known, unknown: !known });
      return parsed;
    })();
    try {
      const result = timeout ? await Promise.race([work, timeout]) : await work;
      if (!live || result == null) throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true });
      return result;
    } finally { live = false; clearTimeout(timerId); }
  }
  function applySnap(data) {
    snap = data;
    if (!dirty) {
      ownStep = clamp(data.progress.step, data.classroom.steps.length);
      ownDone = data.progress.completed === true;
    }
    paint();
  }
  async function loadStatus() {
    if (stopped || document.visibilityState === 'hidden') return;
    if (statusFlight) return statusFlight;
    const gen = statusGen;
    cursorRefresh = false;
    const run = (async () => {
      lastStart = Date.now();
      try {
        const data = await request('/__lab/classroom/status', undefined, WAIT_MS);
        if (stopped || gen !== statusGen) return;
        if (!validSnap(data)) throw Object.assign(new Error('수업 응답을 확인하지 못했습니다.'), { unknown: true });
        statusError = '';
        statusOkAt = Date.now();
        applySnap(data);
      } catch (e) {
        if (stopped) return;
        if (e && e.auth) { stopAuth(); return; }
        if (gen !== statusGen) return;
        statusError = (e && e.message) || '수업 안내를 확인하지 못했습니다.';
        statusErrorAt = Date.now();
        paint();
      }
    })();
    statusFlight = run;
    try { await run; } finally {
      if (statusFlight === run) statusFlight = null;
      if (!stopped && document.visibilityState !== 'hidden' && cursorRefresh) loadStatus();
      else arm();
    }
  }
  async function saveProgress() {
    if (stopped || submitFlight) return;
    if (progressFlight) { progressQueued = true; return; }
    const step = ownStep, completed = ownDone;
    statusGen += 1;
    progressFlight = true;
    paint();
    let settled = false;
    try {
      const data = await request('/__lab/classroom/progress', { step: step, completed: completed }, WAIT_MS);
      statusGen += 1;
      settled = true;
      if (stopped) return;
      if (!validSnap(data)) throw Object.assign(new Error('진행 응답을 확인하지 못했습니다.'), { unknown: true });
      if (ownStep === step && ownDone === completed) dirty = false;
      progressError = '';
      progressUnknown = false;
      statusOkAt = Date.now();
      statusError = '';
      applySnap(data);
    } catch (e) {
      if (!settled) { statusGen += 1; settled = true; }
      if (stopped) return;
      if (e && e.auth) { stopAuth(); return; }
      progressErrorAt = Date.now();
      if (e && e.known && e.status === 409) {
        progressUnknown = false;
        if (ownStep === step && ownDone === completed) dirty = false;
        progressError = '다른 진행과 겹쳐 이 변경은 저장하지 못했습니다. 서버에 저장된 단계로 맞춥니다.';
        cursorRefresh = true;
        loadStatus();
      } else {
        progressUnknown = true;
        dirty = true;
        progressError = e && e.unknown ? '진행 저장 결과를 확인하지 못했습니다. 같은 단계로 다시 시도하세요.' : ((e && e.message) || '진행을 저장하지 못했습니다.');
      }
    } finally {
      progressFlight = false;
      if (progressQueued && !stopped) { progressQueued = false; saveProgress(); }
      else paint();
    }
  }
  async function submitResult() {
    if (submitFlight || progressFlight || stopped || !snap) return;
    if (!submitId) submitId = crypto.randomUUID();
    const id = submitId;
    statusGen += 1;
    submitFlight = true;
    paint();
    let settled = false;
    try {
      const data = await request('/__lab/classroom/submit', { requestId: id, filename: '결과.txt' }, WAIT_MS);
      statusGen += 1;
      settled = true;
      if (stopped) return;
      if (!validSnap(data)) throw Object.assign(new Error('제출 응답을 확인하지 못했습니다.'), { unknown: true });
      submitId = null;
      submitUnknown = false;
      submitError = '';
      statusError = '';
      statusOkAt = Date.now();
      applySnap(data);
    } catch (e) {
      if (!settled) { statusGen += 1; settled = true; }
      if (stopped) return;
      if (e && e.auth) { stopAuth(); return; }
      submitErrorAt = Date.now();
      if (e && e.known) {
        submitId = null;
        submitUnknown = false;
        submitError = e.message || '제출이 거절됐습니다.';
      } else {
        submitUnknown = true;
        submitId = id;
        submitError = '제출 결과를 확인하지 못했습니다. 같은 제출로 다시 확인하세요.';
      }
    } finally { submitFlight = false; paint(); }
  }

  toggle.onclick = () => setOpen(true, true);
  closeBtn.onclick = () => setOpen(false, true);
  for (const [id, button] of Object.entries(tabButtons)) button.onclick = () => { tab = id; layout(); };
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const ids = tabNames.map((x) => x[0]);
    const i = ids.indexOf(tab);
    tab = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    layout();
    tabButtons[tab].focus();
    e.preventDefault();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    const active = document.activeElement;
    if (active !== toggle && !panel.contains(active)) return;
    setOpen(false, true);
    e.preventDefault();
    e.stopPropagation();
  });
  prevBtn.onclick = () => { if (prevBtn.disabled || ownStep <= 0) return; moveOwn(ownStep - 1); };
  nextBtn.onclick = () => { const steps = stepsOf(); if (nextBtn.disabled || ownStep >= steps.length - 1) return; moveOwn(ownStep + 1); };
  doneBox.addEventListener('change', () => { if (doneBox.disabled) return; ownDone = doneBox.checked; dirty = true; saveProgress(); });
  copyBtn.onclick = async () => {
    const mine = stepAt(ownStep);
    const text = mine ? mine.prompt : '';
    if (!text) { helpNote.textContent = '복사할 예시 문장이 없습니다.'; return; }
    try { await navigator.clipboard.writeText(text); helpNote.textContent = '예시 문장을 복사했습니다.'; }
    catch (e) { helpNote.textContent = '복사하지 못했습니다. 예시 문장을 직접 선택해 복사하세요.'; }
  };
  helpBtn.onclick = () => askHelp();
  progressRetry.onclick = () => saveProgress();
  submitBtn.onclick = () => submitResult();
  explorerBtn.onclick = () => openExplorer();
  zipBtn.onclick = () => { zipNote.textContent = clickBar((text) => text.includes('내 작업 받기')) ? '막대의 내 작업 받기를 실행했습니다. 브라우저 다운로드 목록을 확인하세요.' : '막대의 내 작업 받기를 찾지 못했습니다.'; };
  ackBtn.onclick = () => { zipNote.textContent = clickBar((text) => text.includes('파일 보존 확인')) ? '파일 보존 확인을 열었습니다. ZIP을 직접 연 뒤에만 확인을 저장하세요.' : '파일 보존 확인 버튼을 찾지 못했습니다.'; };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { stopPoll(); return; }
    if (cursorRefresh) { loadStatus(); return; }
    const since = Date.now() - lastStart;
    if (since >= ACTIVE_MS) loadStatus();
    else { stopPoll(); timer = setTimeout(() => { timer = 0; loadStatus(); }, ACTIVE_MS - since); }
  });
  window.addEventListener('pagehide', () => { stopped = true; stopPoll(); });
  window.addEventListener('resize', () => {
    const isNarrow = narrow();
    if (isNarrow && !narrowWas) open = false;
    narrowWas = isNarrow;
    layout();
  });
  if (window.MutationObserver) {
    const watch = new MutationObserver(() => { if (open && !narrow()) reserveWorkbench(true); });
    watch.observe(document.body, { childList: true });
    window.addEventListener('pagehide', () => watch.disconnect());
  }
  paint();
  loadStatus();
};
start();
})();
`;
