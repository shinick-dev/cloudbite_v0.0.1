// 강사 화면 받기 — 강사가 /lab 에서 화면을 공유하면 Cloudflare Realtime SFU 에서 받아 강사 화면 보기 창(screen.js 의 window.__labScreen)에 붙인다.
// 실습실 호스트가 screen.js 다음에 <script src="/__lab/rtc.js"> 를 끼운다. 신호(SDP)는 /__lab/screen/* 로만 — SFU 비밀·세션 id 는 서버에만 있다.
// 보이는 탭 10초·숨은 탭 30초마다 /__lab/screen 을 묻고, 켜지면 pull → answer → ontrack 의 MediaStream 을 attach. 꺼지면 attach(null).
// 연결이 15초 넘게 끊겼거나 30초 넘게 영상이 안 오면(강사 탭이 멈추지 못하고 닫힘 등) 다시 받는다. 강사 "들어가 보기" 탭은 받지 않는다.

export const LAB_RTC_JS = `(() => {
if (window.__labRtc) return; window.__labRtc = 1;
try { if (sessionStorage.getItem('labWatch') === '1') return; } catch {} // 강사 보기 탭: 강사 자신의 비용·혼선 방지
if (!window.RTCPeerConnection) return;
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
let pc = null, cur = -1, shown = false, busy = false, timer = 0, badSince = 0, bytes = -1, stillSince = 0, last = 0;
const post = async (p, b) => {
  const r = await fetch(p, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
};
// screen.js 가 아직 준비 전이면 잠깐 기다렸다 다시 (스크립트 순서상 거의 없음)
const attach = (s, info, tries) => {
  const L = window.__labScreen;
  if (L && typeof L.attach === 'function') { try { L.attach(s, info); } catch (e) {} return; }
  if ((tries || 0) < 40) setTimeout(() => { if (s === null ? !pc : pc && pc.__stream === s) attach(s, info, (tries || 0) + 1); }, 500);
};
function drop(hide) {
  if (pc) { const p = pc; pc = null; try { p.close(); } catch {} }
  cur = -1; badSince = 0; bytes = -1; stillSince = 0;
  if (hide && shown) { shown = false; attach(null); }
}
async function connect(v, title) {
  drop(false);
  const me = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
  pc = me; cur = v;
  me.ontrack = (e) => {
    if (pc !== me) return;
    const s = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (me.__stream === s) return;
    me.__stream = s; shown = true;
    attach(s, { title: title || '강사 화면' });
  };
  me.oniceconnectionstatechange = () => {
    const st = me.iceConnectionState;
    if (st === 'failed' || st === 'disconnected') badSince = badSince || Date.now(); else if (st === 'connected' || st === 'completed') badSince = 0;
  };
  const r = await post('/__lab/screen/pull');
  if (pc !== me) return;
  cur = r.v;
  await me.setRemoteDescription({ type: 'offer', sdp: r.sdp });
  await me.setLocalDescription(await me.createAnswer());
  await post('/__lab/screen/answer', { sid: r.sid, sdp: me.localDescription.sdp });
}
async function poll() {
  clearTimeout(timer);
  if (busy) return schedule();
  busy = true; last = Date.now();
  try {
    const r = await fetch('/__lab/screen', { cache: 'no-store' });
    const s = r.ok ? await r.json() : null;
    if (s && s.on) { if (!pc || s.v !== cur) await connect(s.v, s.title); }
    else if (s || r.status === 404 || r.status === 410) drop(true);
  } catch (e) { drop(true); }
  busy = false;
  schedule();
}
function schedule() { clearTimeout(timer); timer = setTimeout(poll, document.visibilityState === 'visible' ? 10000 : 30000); }
// 연결 건강: ICE 끊김 15초, 또는 받은 바이트가 30초 넘게 그대로면 다시 받는다 (화면이 가만히 있어도 인코더가 1초에 한 번은 보낸다)
setInterval(async () => {
  const me = pc;
  if (!me || busy) return;
  let again = badSince && Date.now() - badSince > 15000;
  if (!again) {
    try {
      let b = 0;
      (await me.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') b += x.bytesReceived || 0; });
      if (b !== bytes) { bytes = b; stillSince = Date.now(); } else if (stillSince && Date.now() - stillSince > 30000) again = true;
    } catch {}
  }
  if (again && pc === me) { drop(true); poll(); }
}, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 10000) poll(); });
setTimeout(poll, 1000);
})();
`;
