// 강사가 보낸 코드(받은 코드) — 참가자 VS Code 화면의 막대 옆. 실습실 호스트가 bar.js 다음에 <script src="/__lab/snips.js"> 를 끼운다.
// 막대에 📥 받은 코드 버튼(새 코드 개수 뱃지) → 막대 위 패널: 항목마다 제목·시각·코드(원문 그대로)·[복사].
// 보이는 탭은 10초, 숨은 탭은 30초마다 GET /__lab/snips?v=<버전> (바뀐 게 없으면 204). 마지막으로 본 코드 시각은 localStorage.
// 복사는 navigator.clipboard.writeText 그대로 — 강사가 밖으로 복사를 막았으면 guard.js 가 실습실 안 버퍼에 넣는다.
// VS Code 단축키와 부딪치지 않게 전역 키는 가로채지 않는다 (Esc 는 패널에 포커스가 있을 때만). innerHTML 없이 DOM API 로만 (Trusted Types).

export const LAB_SNIPS_JS = `(() => {
if (window.__labSnips) return; window.__labSnips = 1;
const start = () => {
const U = window.__labBarUI;
if (!U || !document.body) return setTimeout(start, 300);
const { el, note, BTN } = U;
const ls = (k, v) => { try { if (v !== undefined) localStorage.setItem(k, String(v)); return localStorage.getItem(k); } catch { return null; } };
const ss = (k, v) => { try { if (v !== undefined) sessionStorage.setItem(k, String(v)); return sessionStorage.getItem(k); } catch { return null; } };
const btn = el('button', BTN, '📥 받은 코드'); btn.title = '강사가 보낸 명령어·코드 — 눌러서 보고 복사하세요';
const badge = el('span', 'display:none;margin-left:5px;padding:0 6px;border-radius:9px;background:#dc2626;color:#fff;font-weight:700;font-size:11px;line-height:16px');
btn.append(badge);
U.box.insertBefore(btn, U.box.lastChild); // 접기 버튼 앞. 막대를 접어도 이 버튼(뱃지)은 보인다
const panel = el('div', 'position:fixed;right:14px;bottom:70px;z-index:2147483001;display:none;flex-direction:column;min-width:280px;max-width:calc(100vw - 28px);max-height:60vh;border-radius:10px;background:#111827f7;color:#e5e7eb;font:13px/1.45 system-ui,sans-serif;box-shadow:0 4px 20px #0009;outline:none');
panel.tabIndex = -1;
let W = Number(ls('labSnipW')) || 520;
const size = () => { panel.style.width = Math.max(280, Math.min(W, innerWidth - 28)) + 'px'; };
size(); window.addEventListener('resize', size);
// 왼쪽 가장자리를 끌어 폭 조절
const grip = el('div', 'position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize');
grip.title = '끌어서 폭 조절';
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault(); grip.setPointerCapture(e.pointerId);
  const x0 = e.clientX, w0 = panel.getBoundingClientRect().width;
  const mv = (m) => { W = w0 + (x0 - m.clientX); size(); };
  const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); ls('labSnipW', Math.round(W)); };
  grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
});
const head = el('div', 'display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border-bottom:1px solid #374151');
const close = el('button', BTN + ';padding:2px 8px', '✕'); close.title = '닫기 (Esc)';
head.append(el('b', 'flex:1', '📥 강사가 보낸 코드'), close);
const list = el('div', 'overflow:auto;flex:1;min-height:0');
panel.append(grip, head, list);
document.body.append(panel);

let V = '', items = [], open = false, timer = 0, last = 0;
let seen = Number(ls('labSnipSeen')) || 0;          // 패널에서 본 가장 새 코드의 시각 (서버 시각)
let told = Math.max(seen, Number(ss('labSnipTold')) || 0); // 알림을 띄운 가장 새 코드 (이 탭)
const label = (s) => s.title || (String(s.text).split('\\n').find((x) => x.trim()) || '').trim().slice(0, 40) || '(제목 없음)';
const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const markSeen = () => { if (items[0] && items[0].at > seen) { seen = items[0].at; ls('labSnipSeen', seen); } };
function paint() {
  const n = items.filter((s) => s.at > seen).length;
  badge.textContent = String(n); badge.style.display = n ? '' : 'none';
  btn.style.background = n ? '#1d4ed8' : 'rgba(255,255,255,.12)';
}
function render() {
  list.replaceChildren();
  if (!items.length) { list.append(el('div', 'padding:14px;opacity:.75', '아직 받은 코드가 없습니다. 강사가 보내면 여기에 뜹니다.')); return; }
  for (const s of items) {
    const it = el('div', 'padding:8px 10px 10px 14px;border-top:1px solid #1f2937');
    const top = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:5px');
    const t = el('b', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', label(s)); t.title = label(s);
    const cp = el('button', BTN, '복사');
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(s.text); cp.textContent = '복사됨 ✓'; }
      catch { const r = document.createRange(); r.selectNodeContents(pre); const g = getSelection(); g.removeAllRanges(); g.addRange(r); cp.textContent = 'Ctrl+C 로 복사'; }
      setTimeout(() => { cp.textContent = '복사'; }, 1500);
    };
    top.append(t, el('span', 'opacity:.65;font-size:12px;white-space:nowrap', hm(s.at)), cp);
    const pre = el('pre', 'margin:0;padding:8px 10px;border-radius:6px;background:#030712;color:#e5e7eb;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto;max-height:40vh;user-select:text;tab-size:4', s.text);
    it.append(top, pre); list.append(it);
  }
}
const show = (on) => {
  open = on; panel.style.display = on ? 'flex' : 'none';
  if (on) { markSeen(); paint(); render(); panel.focus({ preventScroll: true }); }
};
btn.onclick = () => show(!open);
close.onclick = () => show(false);
panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); show(false); } });
document.addEventListener('pointerdown', (e) => { if (open && !panel.contains(e.target) && !btn.contains(e.target)) show(false); }, true);
async function poll() {
  last = Date.now();
  let slow = false;
  try {
    const r = await fetch('/__lab/snips?v=' + encodeURIComponent(V), { cache: 'no-store' });
    if (r.status === 200) {
      const d = await r.json(); V = String(d.v); items = Array.isArray(d.items) ? d.items : [];
      const nw = items[0];
      if (nw && nw.at > told && nw.at > seen) { told = nw.at; ss('labSnipTold', told); if (!open) note('강사가 코드를 보냈습니다: ' + label(nw) + ' (눌러서 닫기)', '#1d4ed8'); }
      if (open) { markSeen(); render(); }
      paint();
    } else if (r.status !== 204) slow = true; // 수업이 끝남 등 — 천천히
  } catch {}
  clearTimeout(timer);
  timer = setTimeout(poll, slow ? 60000 : document.visibilityState === 'visible' ? 10000 : 30000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 3000) poll(); });
poll();
};
start();
})();
`;
