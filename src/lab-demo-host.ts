// A short-lived, single-use grant opens only a private demo seat. No administrator token crosses origins.
import type { Env, State } from './state';

const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>모임지기 시연실</title><style>body{background:#f7f7f5;color:#20242c;font:16px/1.6 system-ui,sans-serif;margin:0}main{max-width:540px;margin:10vh auto;padding:24px}button{background:#315cf2;color:white;padding:12px 18px;border:0;border-radius:10px;font:inherit}button:disabled{opacity:.5}:focus-visible{outline:3px solid #315cf2;outline-offset:3px}</style><main><h1>모임지기 시연실</h1><p id="note" role="status">전용 실습실 입장을 확인하고 있습니다.</p><button id="retry" hidden>같은 입장 요청 확인</button></main><script>
(()=>{let grant=location.hash.slice(1),busy=false;const embed=new URLSearchParams(location.search).get('embed')==='1';history.replaceState(null,'',location.pathname);const note=document.getElementById('note'),button=document.getElementById('retry');
async function enter(){if(busy)return;if(!/^[a-f0-9]{64}$/.test(grant)){note.textContent='입장 정보가 없습니다. 모임지기 화면에서 시연실 열기를 다시 눌러 주세요.';return}busy=true;button.hidden=true;let timer;try{const ctrl=new AbortController();timer=setTimeout(()=>ctrl.abort(),15000);const res=await fetch('/__lab/demo-enter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant}),signal:ctrl.signal});const value=await res.json();if(!res.ok)throw Error(value.error||'입장을 확인하지 못했습니다.');if(value.starting){note.textContent=value.message||'시연실 준비 중입니다. 잠시 뒤 같은 입장 요청을 확인해 주세요.';button.hidden=false;return}if(value.ok!==true)throw Error('입장 응답을 확인하지 못했습니다.');grant='';location.replace(embed?'/?__demo_embed=1':'/')}catch(e){note.textContent=e.name==='AbortError'?'입장 응답이 늦습니다. 같은 입장 요청을 확인하거나 모임지기 화면에서 다시 여세요.':String(e.message||e);button.hidden=false}finally{clearTimeout(timer);busy=false}}button.onclick=enter;enter()})()
</script></html>`;

export async function labDemoHost(req: Request, env: Env, state: DurableObjectStub<State>, url: URL, label: string): Promise<Response | null> {
  if (url.pathname !== '/__lab/demo-open' && url.pathname !== '/__lab/demo-enter') return null;
  const json = (data: unknown, status = 200, more: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, 'content-type': 'application/json', 'x-frame-options': 'DENY', ...more } });
  if (url.pathname === '/__lab/demo-open') {
    if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const embed = url.searchParams.get('embed') === '1';
    const headers: Record<string, string> = { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': embed ? CSP.replace("frame-ancestors 'none'", `frame-ancestors ${env.ORIGIN}`) : CSP };
    if (!embed) headers['x-frame-options'] = 'DENY';
    return new Response(PAGE, { headers });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (req.headers.get('origin') !== url.origin) return json({ error: 'bad origin' }, 403);
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return json({ error: 'bad site' }, 403);
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'content-type' }, 415);
  if (Number(req.headers.get('content-length') ?? 0) > 256) return json({ error: '본문이 너무 큽니다.' }, 413);
  let bytes = 0, body = '', decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const reader = req.body?.getReader();
  try {
    if (reader) for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 256) { await reader.cancel(); return json({ error: '본문이 너무 큽니다.' }, 413); }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('grant' in value)) return json({ error: '입장 정보가 올바르지 않습니다.' }, 400);
    const result = await state.labClassroomDemoClaim(value.grant, label);
    if ('status' in result) return json({ error: result.error }, result.status);
    if ('starting' in result) return json(result, 202);
    const seconds = Math.floor((result.expiresAt - Date.now()) / 1000);
    if (seconds <= 0) return json({ error: '시연실이 종료됐습니다.' }, 410);
    return json({ ok: true }, 200, { 'set-cookie': `__Host-lab_seat=${result.code}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict` });
  } catch { return json({ error: '시연실 입장을 확인하지 못했습니다. 모임지기 화면에서 다시 여세요.' }, 400); }
  finally { reader?.releaseLock(); }
}
