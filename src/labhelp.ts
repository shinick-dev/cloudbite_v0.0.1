// 참여자 막대(bar.js) 다음. 도움 요청·승인된 요청문. 신뢰하지 않는 글은 textContent 만.
// 패널이 열려 있고 탭이 보일 때만 5초마다 GET. 응답을 모르는 제출은 같은 requestId 로만 다시 확인한다.

export const LAB_HELP_JS = String.raw`
(() => {
if (window.__labHelp) return; window.__labHelp = 1;
const NO_ASSISTANT = '연결된 조교가 아직 없습니다. 모임지기에게 음성/손들기로 알려주세요.';
const ASK_UNKNOWN = '도움 요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
const RESOLVE_UNKNOWN = '해결 확인 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
const start = () => {
  const U = window.__labBarUI;
  if (!U || !U.box || typeof U.el !== 'function' || typeof U.note !== 'function' || !U.BTN || !document.body) return setTimeout(start, 300);
  const { el, BTN } = U;
  const btn = el('button', BTN, '도움 요청');
  btn.type = 'button';
  btn.title = '조교에게 도움 요청';
  U.box.insertBefore(btn, U.box.lastChild);
  const dialog = el('dialog', 'box-sizing:border-box;width:min(440px,calc(100vw - 16px));max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;margin:auto;padding:16px;border:1px solid #d5e0dc;border-radius:12px;background:#f4f7f6;color:#0f172a;font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere');
  const title = el('h2', 'margin:0 0 8px;font-size:18px;color:#0f172a', '도움 요청');
  title.id = 'lab-help-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const enabledNote = el('p', 'margin:0 0 8px;color:#0f766e;overflow-wrap:anywhere');
  enabledNote.setAttribute('role', 'status');
  const hint = el('p', 'margin:0 0 8px;color:#52606d;overflow-wrap:anywhere');
  hint.setAttribute('role', 'status');
  const field = el('label', 'display:block;margin:8px 0');
  const privacy = el('p', 'margin:0 0 8px;color:#52606d', '질문은 AI 조교에게 전달됩니다. 개인정보나 비밀번호는 적지 마세요.');
  field.append(el('span', 'display:block;margin-bottom:4px', '도움 내용'));
  const textarea = el('textarea');
  textarea.maxLength = 2000;
  textarea.placeholder = '비밀번호, 개인정보, 토큰은 적지 마세요.';
  textarea.style.cssText = 'box-sizing:border-box;width:100%;max-width:100%;min-height:88px;padding:8px;border:1px solid #d5e0dc;border-radius:8px;background:#fff;color:#0f172a;font:inherit;overflow-wrap:anywhere';
  field.append(textarea);
  const send = el('button', BTN + ';display:inline-block;box-sizing:border-box;max-width:100%;min-height:44px;margin:4px 8px 4px 0;padding:8px 12px;background:#0f766e;color:#fff;white-space:normal;overflow-wrap:anywhere', '도움 요청 보내기');
  send.type = 'button';
  const dropAsk = el('button', BTN + ';display:none;box-sizing:border-box;max-width:100%;min-height:44px;margin:4px 0;padding:8px 12px;background:#fff;color:#0f172a;border:1px solid #d5e0dc;white-space:normal', '이 요청 버리기');
  dropAsk.type = 'button';
  const askMsg = el('p', 'margin:8px 0;overflow-wrap:anywhere');
  askMsg.setAttribute('role', 'status');
  const qHead = el('h3', 'margin:16px 0 8px;font-size:15px', '내 질문');
  const qList = el('div');
  const mHead = el('h3', 'margin:16px 0 8px;font-size:15px', '승인된 요청문');
  const mNote = el('p', 'margin:0 0 8px;color:#52606d;overflow-wrap:anywhere', '승인된 요청문입니다. 여기서는 복사만 할 수 있고 실행하지 않습니다.');
  const mList = el('div');
  const closeBtn = el('button', BTN + ';box-sizing:border-box;max-width:100%;min-height:44px;margin-top:8px;padding:8px 12px;background:#fff;color:#0f172a;border:1px solid #d5e0dc', '닫기');
  closeBtn.type = 'button';
  dialog.append(title, enabledNote, hint, privacy, field, send, dropAsk, askMsg, qHead, qList, mHead, mNote, mList, closeBtn);
  document.body.append(dialog);

  let questions = [], messages = [], askPending = null, resolvePending = null, busy = false, flight = null, timer = 0, authEnded = false;

  const validQ = (q) => !!q && typeof q.id === 'string' && typeof q.question === 'string' && typeof q.n === 'number' && (q.status === 'open' || q.status === 'answered' || q.status === 'resolved') && typeof q.at === 'number' && (q.reply == null || typeof q.reply === 'string');
  const validM = (m) => !!m && typeof m.id === 'string' && typeof m.title === 'string' && typeof m.text === 'string' && typeof m.at === 'number';
  const statusText = (s) => s === 'open' ? '접수' : s === 'answered' ? '답변' : '본인확인';

  function stopPoll() { clearTimeout(timer); timer = 0; }
  function arm() {
    stopPoll();
    if (authEnded || !dialog.open || document.visibilityState !== 'visible') return;
    timer = setTimeout(() => { tick(); }, 5000);
  }
  async function request(path, body) {
    const controller = new AbortController();
    let live = true, timerId = 0;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        live = false;
        controller.abort();
        reject(Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true }));
      }, 10000);
    });
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
      let text = '', parsed = null;
      try { text = await response.text(); } catch (e) {
        if (!live) return null;
        throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true });
      }
      if (!live) return null;
      if (text) { try { parsed = JSON.parse(text); } catch (e) { parsed = null; } } else parsed = {};
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error('다시 인증해 주세요.'), { status: response.status, auth: true });
      const known = response.status >= 400 && response.status < 500 && parsed && typeof parsed === 'object';
      if (!response.ok || !parsed || typeof parsed !== 'object') throw Object.assign(new Error((parsed && parsed.error) || ('HTTP ' + response.status)), { status: response.status, known: !!known, unknown: !known });
      return parsed;
    })();
    try {
      const result = await Promise.race([work, timeout]);
      if (!live || result == null) throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'), { unknown: true });
      return result;
    } finally { live = false; clearTimeout(timerId); }
  }
  function paintAsk() {
    send.textContent = askPending ? '같은 도움 요청 다시 보내기' : '도움 요청 보내기';
    send.disabled = busy || authEnded;
    textarea.disabled = busy || authEnded || !!askPending;
    dropAsk.style.display = askPending && !busy ? 'inline-block' : 'none';
    dropAsk.disabled = busy;
  }
  function authLost(e) {
    if (!e || ![401, 403, 404, 410].includes(e.status)) return false;
    authEnded = true;
    stopPoll();
    questions = []; messages = []; askPending = null; resolvePending = null;
    textarea.value = ''; askMsg.textContent = '';
    enabledNote.textContent = '실습실 연결을 확인해 주세요.';
    hint.textContent = '이전 안내를 지웠습니다. 모임지기에게 초대 링크를 확인한 뒤 다시 열어 주세요.';
    render();
    return true;
  }
  function upsert(q) {
    const i = questions.findIndex((item) => item.id === q.id);
    if (i >= 0) questions[i] = q; else questions.unshift(q);
  }
  async function copyText(text, button, node) {
    const base = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '복사됨';
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = '선택됨 · 직접 복사';
    }
    setTimeout(() => { button.textContent = base && base.indexOf('복사') === 0 ? '요청문 복사' : '요청문 복사'; }, 1500);
  }
  function render() {
    if (resolvePending && questions.some((q) => q.id === resolvePending.questionId && q.status === 'resolved')) resolvePending = null;
    qList.replaceChildren();
    if (!questions.length) qList.append(el('p', 'margin:0;color:#52606d', '아직 도움 요청이 없습니다.'));
    for (const q of questions) {
      const card = el('article', 'margin:0 0 10px;padding:8px;border:1px solid #d5e0dc;border-radius:8px;background:#fff');
      card.append(el('p', 'margin:0 0 4px;font-weight:700;overflow-wrap:anywhere', q.n + '번 · ' + statusText(q.status)));
      card.append(el('p', 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere', q.question));
      if (q.reply) card.append(el('p', 'margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere', '조교 답변: ' + q.reply));
      if (q.status === 'answered') {
        const pending = resolvePending && resolvePending.questionId === q.id;
        const b = el('button', BTN + ';box-sizing:border-box;max-width:100%;min-height:44px;margin-top:8px;padding:8px 12px;background:#0f766e;color:#fff;white-space:normal', pending ? '같은 해결 확인 다시 보내기' : '해결 확인');
        b.type = 'button';
        b.disabled = busy;
        b.onclick = () => resolveQuestion(q.id);
        card.append(b);
        if (pending) {
          const drop = el('button', BTN + ';box-sizing:border-box;max-width:100%;min-height:44px;margin:8px 0 0 8px;padding:8px 12px;background:#fff;color:#0f172a;border:1px solid #d5e0dc;white-space:normal', '이 해결 확인 버리기');
          drop.type = 'button';
          drop.disabled = busy;
          drop.onclick = () => { if (busy || !resolvePending) return; resolvePending = null; askMsg.textContent = '해결 확인 요청을 화면에서 버렸습니다. 서버에 이미 반영됐을 수 있습니다.'; render(); };
          card.append(drop);
        }
      }
      qList.append(card);
    }
    mList.replaceChildren();
    if (!messages.length) mList.append(el('p', 'margin:0;color:#52606d', '도착한 승인 요청문이 없습니다.'));
    for (const m of messages) {
      const card = el('article', 'margin:0 0 10px;padding:8px;border:1px solid #d5e0dc;border-radius:8px;background:#fff');
      card.append(el('p', 'margin:0 0 4px;font-weight:700;overflow-wrap:anywhere', m.title));
      const pre = el('pre', 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,Consolas,monospace', m.text);
      const copy = el('button', BTN + ';box-sizing:border-box;max-width:100%;min-height:44px;margin-top:8px;padding:8px 12px;background:#fff;color:#0f172a;border:1px solid #d5e0dc', '요청문 복사');
      copy.type = 'button';
      copy.onclick = () => copyText(m.text, copy, pre);
      card.append(pre, copy);
      mList.append(card);
    }
    paintAsk();
  }
  async function tick() {
    if (authEnded || flight || !dialog.open || document.visibilityState !== 'visible') return;
    const run = (async () => {
      let data;
      try { data = await request('/__lab/help'); }
      catch (e) { if (!authLost(e)) hint.textContent = '도움 상태를 확인하지 못했습니다.'; return; }
      if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.questions) || !Array.isArray(data.messages) || data.questions.some((q) => !validQ(q)) || data.messages.some((m) => !validM(m))) {
        hint.textContent = '도움 응답을 확인하지 못했습니다.';
        return;
      }
      enabledNote.textContent = data.enabled ? '' : NO_ASSISTANT;
      questions = data.questions;
      messages = data.messages;
      hint.textContent = '';
      render();
    })();
    flight = run;
    try { await run; } finally { if (flight === run) flight = null; arm(); }
  }
  function openPanel() {
    authEnded = false;
    paintAsk();
    if (!dialog.open) dialog.showModal();
    tick();
    if (askPending) send.focus(); else textarea.focus();
  }
  function closePanel() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('close', () => { stopPoll(); });
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  document.addEventListener('visibilitychange', () => {
    if (!dialog.open) return;
    if (document.visibilityState === 'visible') tick(); else stopPoll();
  });
  btn.onclick = () => { if (dialog.open) closePanel(); else openPanel(); };
  closeBtn.onclick = () => closePanel();
  dropAsk.onclick = () => {
    if (busy || !askPending) return;
    askPending = null;
    textarea.disabled = false;
    askMsg.textContent = '이 화면의 요청을 버렸습니다. 서버에 이미 접수됐을 수 있습니다.';
    paintAsk();
  };
  send.onclick = () => submitAsk();
  async function submitAsk() {
    if (busy || authEnded) return;
    if (!askPending) {
      const question = textarea.value;
      if (!question.trim()) { askMsg.textContent = '도움 내용을 적어 주세요.'; return; }
      if (question.length > 2000) { askMsg.textContent = '도움 내용은 2000자 이내여야 합니다.'; return; }
      askPending = { requestId: crypto.randomUUID(), question };
    }
    const pending = askPending;
    busy = true; paintAsk(); render();
    askMsg.textContent = '도움 요청 결과를 확인하는 중…';
    try {
      const data = await request('/__lab/help', { requestId: pending.requestId, question: pending.question });
      if (!data || !validQ(data.question) || data.question.question !== pending.question) {
        askMsg.textContent = ASK_UNKNOWN;
        return;
      }
      askPending = null;
      textarea.value = '';
      askMsg.textContent = enabledNote.textContent ? '요청을 보냈습니다. 연결된 조교가 없으면 답변을 보장하지 않습니다.' : '요청을 접수했습니다.';
      upsert(data.question);
      render();
    } catch (e) {
      if (authLost(e)) return;
      if (e && e.known) { askPending = null; askMsg.textContent = e.message || '요청이 거절됐습니다.'; }
      else askMsg.textContent = ASK_UNKNOWN;
    } finally { busy = false; paintAsk(); render(); }
  }
  async function resolveQuestion(questionId) {
    if (busy || authEnded) return;
    if (!resolvePending || resolvePending.questionId !== questionId) {
      if (resolvePending) return;
      resolvePending = { requestId: crypto.randomUUID(), questionId };
    }
    const pending = resolvePending;
    busy = true; paintAsk(); render();
    askMsg.textContent = '해결 확인 결과를 확인하는 중…';
    try {
      const data = await request('/__lab/help/resolve', { requestId: pending.requestId, questionId: pending.questionId });
      if (!data || !validQ(data.question) || data.question.id !== pending.questionId || data.question.status !== 'resolved') {
        askMsg.textContent = RESOLVE_UNKNOWN;
        return;
      }
      resolvePending = null;
      askMsg.textContent = '본인 확인으로 해결됐습니다.';
      upsert(data.question);
      render();
    } catch (e) {
      if (authLost(e)) return;
      if (e && e.known) { resolvePending = null; askMsg.textContent = e.message || '해결 확인이 거절됐습니다.'; }
      else askMsg.textContent = RESOLVE_UNKNOWN;
    } finally { busy = false; paintAsk(); render(); }
  }
  render();
};
start();
})();
`;
