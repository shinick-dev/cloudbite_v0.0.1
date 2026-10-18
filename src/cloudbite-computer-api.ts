import type { Env, State } from './state';
import { sha, isFail } from './state';
import { ownerCookieValid } from './cloudbite-owner';
import { COMPUTER_COOKIE, COMPUTER_DESKTOP_PATH, COMPUTER_TICKET_PARAM } from './cloudbite-computer-contract';
import { proxyComputerDesktop } from './cloudbite-computer-daytona';
import { computerAccounts, computerLabels, COMPUTER_REQUEST_ID } from './cloudbite-computer-contract';
import { cbExec, cbGetSandbox, cbUpload } from './cloudbite-daytona';
import type { CbNestedInstall } from './cloudbite-computer-nested';
import { CLOUDBITE_COMPUTER_HTML, CLOUDBITE_COMPUTER_JS, CLOUDBITE_COMPUTER_CSS } from './cloudbite-computer-page';

const API = '/api/cloudbite/computer';
const PAGE = '/cloudbite/computer';
const headers = { 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{...headers,'content-type':'application/json'}});
const error = (code: string, status: number) => json({error:{code,message:code}},status);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  if (Number(req.headers.get('content-length') ?? 0) > 8192 || !req.body) return null;
  const reader = req.body.getReader(); let n=0; const parts: Uint8Array[]=[];
  for (;;) { const {done,value}=await reader.read(); if(done)break; n+=value.byteLength; if(n>8192){await reader.cancel();return null;} parts.push(value); }
  const bytes=new Uint8Array(n); let at=0; for(const p of parts){bytes.set(p,at);at+=p.byteLength;}
  try {const v=JSON.parse(new TextDecoder().decode(bytes));return v && typeof v==='object' && !Array.isArray(v)?v:null;} catch{return null;}
}

/** Owner control stays on the public origin. Untrusted desktop content lives only on the separate gateway. */
export async function computerRoute(req: Request, env: Env, url: URL, state: DurableObjectStub<State>): Promise<Response|null> {
  const p=url.pathname;
  const gateway=env.CLOUDBITE_COMPUTER_GATEWAY_ORIGIN;
  if(p.startsWith('/p/_cloudbite/computer/nested/')) {
    if(url.origin!==env.CLOUDBITE_GATEWAY_URL || !env.CLOUDBITE_COMPUTER_NESTED)return error('not_found',404);
    return env.CLOUDBITE_COMPUTER_NESTED.get(env.CLOUDBITE_COMPUTER_NESTED.idFromName('owner')).fetch(req);
  }
  if(p===COMPUTER_DESKTOP_PATH || p.startsWith(COMPUTER_DESKTOP_PATH+'/')) {
    if(!gateway || url.origin!==gateway || url.origin===env.ORIGIN || url.hostname===env.RP_ID || url.origin===env.CLOUDBITE_PUBLIC_ORIGIN || !env.CLOUDBITE_COMPUTER) return error('not_found',404);
    const computer=env.CLOUDBITE_COMPUTER.get(env.CLOUDBITE_COMPUTER.idFromName('owner'));
    const ticket=url.searchParams.get(COMPUTER_TICKET_PARAM);
    if(ticket!==null) {
      if(req.method!=='GET' || (p!==COMPUTER_DESKTOP_PATH && p!==COMPUTER_DESKTOP_PATH+'/'))return error('ticket_invalid',401);
      const grant=await computer.computerRedeemTicket(ticket);
      if(!('ok' in grant))return error('ticket_invalid',401);
      // A new top-level document establishes the gateway site before the Strict cookie is used.
      // An HTTP redirect from the cross-site control page would omit that cookie and burn the ticket.
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${COMPUTER_DESKTOP_PATH}/"><title>Opening your computer</title></head><body><p>Opening your cloud computer…</p><a href="${COMPUTER_DESKTOP_PATH}/" rel="noreferrer">Continue to your computer</a></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8',
        'content-security-policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'set-cookie':`${COMPUTER_COOKIE}=${grant.cookie}; Path=/; Max-Age=${grant.maxAge}; HttpOnly; Secure; SameSite=Strict`}});
    }
    // Only one matching cookie is accepted; credentials from the control origin cannot authenticate this gateway.
    const cookies=(req.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COMPUTER_COOKIE+'='));
    if(cookies.length!==1)return error('desktop_sign_in',401);
    const upstream=await computer.computerDesktopUpstream(cookies[0].slice(COMPUTER_COOKIE.length+1));
    if(!('ok' in upstream))return error('desktop_sign_in',401);
    const origin=req.headers.get('origin');
    if(origin && origin!==gateway)return error('bad_origin',403);
    try {
      const response=await proxyComputerDesktop(req,upstream);
      if(response.status===401 || response.status===403){await computer.computerDesktopPreviewRejected(cookies[0].slice(COMPUTER_COOKIE.length+1));return error('desktop_unavailable',502);}
      const h=new Headers(response.headers);
      h.delete('set-cookie');h.delete('clear-site-data');h.delete('access-control-allow-origin');h.delete('access-control-allow-credentials');
      h.set('permissions-policy','publickey-credentials-get=(), publickey-credentials-create=()');
      h.set('set-cookie',`${COMPUTER_COOKIE}=${cookies[0].slice(COMPUTER_COOKIE.length+1)}; Path=/; Max-Age=${upstream.maxAge}; HttpOnly; Secure; SameSite=Strict`);
      return new Response(response.status===101?null:response.body,{status:response.status,statusText:response.statusText,headers:h,...(response.webSocket?{webSocket:response.webSocket}:{})});
    } catch{return error('desktop_unavailable',502);}
  }
  if(p===PAGE || p===PAGE+'.js' || p===PAGE+'.css') {
    if(req.method!=='GET')return error('method_not_allowed',405);
    const kind=p===PAGE?'text/html; charset=utf-8':p.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8';
    const content=p===PAGE?CLOUDBITE_COMPUTER_HTML:p.endsWith('.js')?CLOUDBITE_COMPUTER_JS:CLOUDBITE_COMPUTER_CSS;
    return new Response(content,{headers:{...headers,'content-type':kind,'x-frame-options':'DENY',
      'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
  }
  if(p!==API && !p.startsWith(API+'/'))return null;
  const admin=req.headers.get('x-admin-token');
  // Existing project-only operator tokens never gain access to this private computer.
  const authorized=admin!==null ? (!admin.startsWith('cbo_') && !isFail(await state.adminList(admin))) : await ownerCookieValid(req,env,state);
  if(!authorized)return error('owner_required',401);
  if(!env.CLOUDBITE_COMPUTER)return error('not_configured',503);
  const op=p.slice(API.length+1);
  const computer=env.CLOUDBITE_COMPUTER.get(env.CLOUDBITE_COMPUTER.idFromName('owner'));
  const tag=(await sha('cloudbite-personal-computer-owner-v1')).slice(0,24);
  if(req.method==='GET' && op==='state')return json(await computer.computerState(tag));
  const nested=env.CLOUDBITE_COMPUTER_NESTED?.get(env.CLOUDBITE_COMPUTER_NESTED.idFromName('owner'));
  if(req.method==='GET' && op==='nested/jobs') {
    if(!nested)return error('not_configured',503);
    const result=JSON.parse(await nested.ownerJobsJson());return json(result.body,result.status);
  }
  if(req.method!=='POST')return error('method_not_allowed',405);
  if(req.headers.get('origin')!==env.ORIGIN && admin===null)return error('bad_origin',403);
  if(req.headers.get('origin') && req.headers.get('origin')!==env.ORIGIN)return error('bad_origin',403);
  const input=await body(req); if(!input)return error('bad_request',400);
  if(op==='nested/configure') {
    if(!nested)return error('not_configured',503);
    if(typeof input.requestId!=='string' || !COMPUTER_REQUEST_ID.test(input.requestId))return error('bad_request',400);
    const current=await computer.computerState(tag);
    if(!('ok' in current) || current.status!=='running' || !current.machine?.id)return error('not_running',409);
    const account=computerAccounts(env).find(a=>a.id===current.machine!.account);
    if(!account)return error('not_configured',503);
    const c={api:account.api,key:account.key};
    try {
      const sandbox=await cbGetSandbox(c,current.machine.id);
      if(!sandbox || (sandbox as {name?: string}).name!==current.machine.name || !Object.entries(computerLabels(tag,account.id)).every(([k,v])=>sandbox.labels?.[k]===v))return error('ownership_mismatch',409);
      const grant=JSON.parse(await nested.configureJson({ownerMachineId:current.machine.id,requestId:input.requestId}));
      if(!grant.body.ok)return json(grant.body,grant.status);
      const install=grant.body.install as CbNestedInstall;
      const expected=new Map([['~/.config/cloudbite/compute.json','/home/daytona/.config/cloudbite/compute.json.next'],['~/.local/bin/cloudbite-compute','/home/daytona/.local/bin/cloudbite-compute.next']]);
      if(!install || install.files.length!==2 || !install.files.every(f=>expected.has(f.path)))return error('install_failed',502);
      const prep=await cbExec(c,sandbox,'install -d -m 700 /home/daytona/.config/cloudbite /home/daytona/.local/bin && install -m 600 /dev/null /home/daytona/.config/cloudbite/compute.json.next && install -m 700 /dev/null /home/daytona/.local/bin/cloudbite-compute.next',20);
      if(prep.exitCode!==0)return error('install_failed',502);
      for(const file of install.files)await cbUpload(c,sandbox,expected.get(file.path)!,file.content);
      const done=await cbExec(c,sandbox,'chmod 600 /home/daytona/.config/cloudbite/compute.json.next && chmod 700 /home/daytona/.local/bin/cloudbite-compute.next && mv /home/daytona/.config/cloudbite/compute.json.next /home/daytona/.config/cloudbite/compute.json && mv /home/daytona/.local/bin/cloudbite-compute.next /home/daytona/.local/bin/cloudbite-compute',20);
      if(done.exitCode!==0)return error('install_failed',502);
      return json({ok:true,installed:true,capability:grant.body.capability});
    } catch{return error('install_failed',502);}
  }
  let result;
  switch(op) {
    case 'start': result=await computer.computerStart(tag,input);break;
    case 'stop': result=await computer.computerStop(tag,input);break;
    case 'extend': result=await computer.computerExtend(tag,input);break;
    case 'snapshot': result=await computer.computerSnapshot(tag,input);break;
    case 'launch': result=await computer.computerLaunch(tag);break;
    default:return error('not_found',404);
  }
  return json(result, 'status' in result && typeof result.status==='number' ? result.status : 200);
}
