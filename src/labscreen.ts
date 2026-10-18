// 강사 화면 보기 창 — 참가자 VS Code 화면 위에 뜨는 작은 창 / 크게 보기 / 따로 띄우기. 실습실 호스트가 bar.js 다음에 <script src="/__lab/screen.js"> 를 끼운다.
// 영상 전송(Cloudflare Realtime)은 따로 붙인다: 받은 MediaStream 을 window.__labScreen.attach(stream, {title}) 로 넘기고, 공유가 끝나면 attach(null).
//   작은 창: 제목줄로 끌어 옮기기, 네 모서리로 크기 조절(▣ 비율 유지), 화면 밖으로 못 나감. 기본은 오른쪽 아래(막대 위), 폭 360px.
//   크게 보기: VS Code 전체를 덮음(영상 contain). 버튼·더블클릭으로 작은 창과 오감, 창에 포커스가 있을 때 Esc → 작은 창.
//   따로 띄우기: Document Picture-in-Picture 창에 영상+버튼을 옮긴다(항상 위). 없으면 video PiP (그때 버튼은 원래 창에).
//   숨김: 막대의 📺 강사 화면 버튼으로 다시 연다 (공유 중일 때만 보임).
// 학생이 고른 모드·위치·크기는 localStorage(labScreen). 창 밖 클릭·키는 VS Code 로 그대로 간다. z-index 는 막대·알림보다 낮다.
// code-server 페이지는 Trusted Types 를 쓸 수 있어 innerHTML 없이 DOM API 로만 만든다.
export const LAB_SCREEN_JS = `(() => {
if (window.__labScreen) return;
const U = window.__labBarUI || {};
const el = U.el || ((t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; });
const note = (t, bg) => { if (U.note) U.note(t, bg); };
const Z = 2147482000, TB = 30, MINW = 200, MINH = 120, KEY = 'labScreen';
const SB = 'all:unset;cursor:pointer;padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.12);white-space:nowrap;font:12px/1.5 system-ui,sans-serif;color:#e5e7eb';
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
let pref = { mode: 'small', last: 'small', x: null, y: null, w: 360, h: null, keep: true };
try {
  const p = JSON.parse(localStorage.getItem(KEY) || '{}');
  if (['small', 'big', 'hidden'].includes(p.mode)) pref.mode = p.mode;
  if (['small', 'big'].includes(p.last)) pref.last = p.last;
  for (const k of ['x', 'y', 'w', 'h']) if (num(p[k]) != null) pref[k] = p[k];
  if (typeof p.keep === 'boolean') pref.keep = p.keep;
} catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch {} };
let stream = null, mode = 'off', pip = null, drag = null; // mode: off · small · big · pip · hidden

// ── 창 ──
const win = el('div', 'position:fixed;z-index:' + Z + ';display:none;flex-direction:column;background:#111827;color:#e5e7eb;border-radius:9px;box-shadow:0 4px 18px #0008;overflow:hidden;font:12px/1.4 system-ui,sans-serif;user-select:none;outline:none;box-sizing:border-box');
win.tabIndex = -1; win.dataset.lab = 'screen';
const head = el('div', 'display:flex;align-items:center;gap:4px;height:' + TB + 'px;padding:0 5px 0 9px;box-sizing:border-box;flex:none;background:#1f2937;cursor:move');
const title = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', '강사 화면');
const bKeep = el('button', SB, '▣'); bKeep.title = '크기를 바꿀 때 영상 비율 유지';
const bBig = el('button', SB, '⛶');
const bPip = el('button', SB, '⧉');
const bHide = el('button', SB, '–'); bHide.title = '숨기기 (막대의 📺 강사 화면 으로 다시 열기)';
head.append(title, bKeep, bBig, bPip, bHide);
const stage = el('div', 'position:relative;flex:1;min-height:0;background:#000;overflow:hidden');
const video = el('video', 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000');
video.muted = true; video.autoplay = true; video.playsInline = true;
for (const a of ['muted', 'autoplay', 'playsinline']) video.setAttribute(a, '');
stage.append(video);
const grips = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
  const g = el('div', 'position:absolute;width:14px;height:14px;z-index:5;' + (sx < 0 ? 'left:0;' : 'right:0;') + (sy < 0 ? 'top:0;' : 'bottom:0;') + 'cursor:' + (sx * sy > 0 ? 'nwse-resize' : 'nesw-resize'));
  g.dataset.sx = sx; g.dataset.sy = sy; return g;
});
win.append(head, stage, ...grips);
const sbtn = el('button', U.BTN || SB, '📺 강사 화면'); sbtn.style.display = 'none';

const ar = () => (video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9);
const floating = () => mode === 'small' || (mode === 'pip' && !pip); // video PiP 일 때는 원래 창을 작은 창으로 둔다
/** 저장된 크기·위치를 지금 화면 안으로 */
function fit() {
  const W = innerWidth, H = innerHeight;
  let w = clamp(pref.w || 360, Math.min(MINW, W), W);
  let h = pref.keep || !pref.h ? Math.round(w / ar()) + TB : pref.h;
  h = clamp(h, Math.min(MINH, H), H);
  if (pref.keep && Math.round(w / ar()) + TB > h) w = Math.max(Math.min(MINW, W), Math.round((h - TB) * ar()));
  const x = clamp(pref.x == null ? W - w - 14 : pref.x, 0, Math.max(0, W - w));
  const y = clamp(pref.y == null ? H - h - 72 : pref.y, 0, Math.max(0, H - h));
  return { x, y, w, h };
}
function layout() {
  sbtn.style.display = stream ? '' : 'none';
  sbtn.title = mode === 'hidden' ? '강사 화면 보기 창 열기' : '강사 화면 보기 창 숨기기';
  const S = win.style;
  S.display = stream && mode !== 'hidden' && mode !== 'off' ? 'flex' : 'none';
  const fl = floating();
  for (const g of grips) g.style.display = fl ? '' : 'none';
  head.style.cursor = fl ? 'move' : 'default';
  bKeep.style.display = fl ? '' : 'none';
  bKeep.style.background = pref.keep ? '#2563eb' : '';
  bBig.style.display = mode === 'pip' ? 'none' : '';
  bBig.textContent = mode === 'big' ? '🗗' : '⛶';
  bBig.title = mode === 'big' ? '작은 창으로 (Esc)' : '크게 보기 (더블클릭)';
  bPip.textContent = mode === 'pip' ? '↩' : '⧉';
  bPip.title = mode === 'pip' ? '따로 띄운 창 닫고 돌아오기' : '따로 띄우기 (다른 창 위에 항상 보임)';
  if (!fl) { S.left = '0'; S.top = '0'; S.width = '100%'; S.height = '100%'; S.borderRadius = '0'; S.boxShadow = 'none'; }
  else { const g = fit(); S.left = g.x + 'px'; S.top = g.y + 'px'; S.width = g.w + 'px'; S.height = g.h + 'px'; S.borderRadius = '9px'; S.boxShadow = '0 4px 18px #0008'; }
}
function setMode(m) {
  if (!stream || m === mode) return;
  if (mode === 'pip' && m !== 'pip') closePip();
  mode = m;
  if (m === 'small' || m === 'big' || m === 'hidden') { pref.mode = m; if (m !== 'hidden') pref.last = m; save(); }
  layout();
  if (m === 'big') { try { win.focus({ preventScroll: true }); } catch {} }
}

// ── 옮기기·크기 조절 ──
const stop = () => { if (drag) { drag = null; save(); } };
head.addEventListener('pointerdown', (e) => {
  if (!floating() || e.button !== 0 || e.target.closest('button')) return;
  const g = fit(); drag = { el: head, dx: e.clientX - g.x, dy: e.clientY - g.y };
  head.setPointerCapture(e.pointerId); e.preventDefault();
});
head.addEventListener('pointermove', (e) => {
  if (!drag || drag.el !== head) return;
  pref.x = e.clientX - drag.dx; pref.y = e.clientY - drag.dy;
  const g = fit(); pref.x = g.x; pref.y = g.y; layout();
});
head.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && mode !== 'pip') setMode(mode === 'big' ? 'small' : 'big'); });
for (const gr of grips) {
  gr.addEventListener('pointerdown', (e) => {
    if (!floating() || e.button !== 0) return;
    drag = { el: gr, g: fit(), sx: +gr.dataset.sx, sy: +gr.dataset.sy, x0: e.clientX, y0: e.clientY };
    gr.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
  });
  gr.addEventListener('pointermove', (e) => {
    if (!drag || drag.el !== gr) return;
    const { g, sx, sy } = drag, W = innerWidth, H = innerHeight;
    const maxW = sx > 0 ? W - g.x : g.x + g.w, maxH = sy > 0 ? H - g.y : g.y + g.h;
    let w = clamp(g.w + sx * (e.clientX - drag.x0), MINW, maxW);
    let h = pref.keep ? Math.round(w / ar()) + TB : g.h + sy * (e.clientY - drag.y0);
    h = clamp(h, MINH, maxH);
    if (pref.keep) w = clamp(Math.round((h - TB) * ar()), Math.min(MINW, maxW), maxW);
    pref.w = w; pref.h = h;
    pref.x = sx > 0 ? g.x : g.x + g.w - w; pref.y = sy > 0 ? g.y : g.y + g.h - h;
    layout();
  });
}
for (const x of [head, ...grips]) { x.addEventListener('pointerup', stop); x.addEventListener('pointercancel', stop); }
addEventListener('resize', () => { if (floating()) layout(); });
video.addEventListener('loadedmetadata', layout);
video.addEventListener('resize', () => { if (floating()) layout(); });

// ── 버튼 ──
bBig.onclick = () => setMode(mode === 'big' ? 'small' : 'big');
bHide.onclick = () => setMode('hidden');
bKeep.onclick = () => { pref.keep = !pref.keep; if (!pref.keep) pref.h = fit().h; save(); layout(); };
bPip.onclick = () => { if (mode === 'pip') { closePip(); mode = 'small'; layout(); } else openPip(); };
sbtn.onclick = () => setMode(mode === 'hidden' ? pref.last || 'small' : 'hidden');
stage.addEventListener('dblclick', () => { if (mode !== 'pip') setMode(mode === 'big' ? 'small' : 'big'); });
win.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mode === 'big') { e.stopPropagation(); setMode('small'); } });
stage.addEventListener('pointerdown', () => { if (mode === 'big') { try { win.focus({ preventScroll: true }); } catch {} } });

// ── 따로 띄우기 ──
async function openPip() {
  const D = window.documentPictureInPicture;
  if (D && D.requestWindow) {
    try {
      const g = fit();
      const w = await D.requestWindow({ width: Math.max(g.w, 480), height: Math.max(g.h, 300) });
      pip = w; mode = 'pip';
      w.document.title = title.textContent;
      w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
      w.document.body.append(win);
      w.addEventListener('pagehide', () => { if (pip !== w) return; home(); if (mode === 'pip') mode = stream ? 'small' : 'off'; layout(); });
      layout(); video.play().catch(() => {});
      return;
    } catch {}
  }
  if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
    try { await video.requestPictureInPicture(); mode = 'pip'; layout(); return; } catch {}
  }
  note('이 브라우저에서는 따로 띄우기를 쓸 수 없습니다. (눌러서 닫기)', '#374151');
}
const home = () => { pip = null; document.body.append(win); video.play().catch(() => {}); };
function closePip() {
  if (pip) { const w = pip; home(); try { w.close(); } catch {} }
  else if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
}
video.addEventListener('leavepictureinpicture', () => { if (mode === 'pip' && !pip) { mode = stream ? 'small' : 'off'; layout(); } });

// ── 바깥에서 부르는 곳 ──
function mount() {
  if (!document.body) return;
  if (!pip && win.parentNode !== document.body) document.body.append(win);
  if (U.box && sbtn.parentNode !== U.box) U.box.insertBefore(sbtn, U.box.lastChild); // 접기(–) 버튼 앞
}
function attach(s, info) {
  if (!s || typeof s.getVideoTracks !== 'function') {
    const had = !!stream;
    if (mode === 'pip') closePip();
    stream = null; video.srcObject = null; mode = 'off'; layout();
    if (had) note('강사가 화면 공유를 멈췄습니다. (눌러서 닫기)', '#374151');
    return;
  }
  const first = !stream;
  stream = s; video.srcObject = s; video.play().catch(() => {});
  title.textContent = (info && info.title) || '강사 화면';
  if (pip) pip.document.title = title.textContent;
  for (const t of s.getVideoTracks()) t.addEventListener('ended', () => { if (stream === s && s.getVideoTracks().every((x) => x.readyState === 'ended')) attach(null); });
  if (first) mode = pref.mode === 'big' || pref.mode === 'hidden' ? pref.mode : 'small';
  mount(); layout();
}
const api = { attach };
Object.defineProperty(api, 'mode', { enumerable: true, get: () => mode, set: (m) => { if (m === 'pip') openPip(); else if (['small', 'big', 'hidden'].includes(m)) setMode(m); } });
window.__labScreen = api;
})();
`;
