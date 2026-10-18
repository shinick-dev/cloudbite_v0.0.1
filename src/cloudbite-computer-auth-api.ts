import type {Env, State} from './state';
import {ownerCookieName, ownerCookieValid, ownerRoute} from './cloudbite-owner';
import {boundedText} from './cloudbite-inference';
import {computerCookieToken, computerSetCookie, computerClearCookie} from './cloudbite-computer-access';
const PREFIX='/api/cloudbite/computer/auth/';
const security={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{...security,'content-type':'application/json'}});
const failure=(code:string,status:number)=>json({error:{code,message:code}},status);
const LEGACY_CREDENTIAL=/^cbown_[A-Za-z0-9_-]{43}$/;
/** Presence only (no State call): a well-formed legacy owner cookie must always be logged out, even when its check is unavailable. */
function legacyCookiePresented(req:Request,env:Env):boolean{
  const name=ownerCookieName(env);
  for(const part of (req.headers.get('cookie')??'').split(';')){const i=part.indexOf('=');if(i>=0 && part.slice(0,i).trim()===name)return LEGACY_CREDENTIAL.test(part.slice(i+1).trim());}
  return false;
}
export async function personalComputerCookieValid(req:Request,env:Env):Promise<boolean>{
  const token=computerCookieToken(req);if(!token || !env.CLOUDBITE_COMPUTER_ACCESS)return false;
  try{return await env.CLOUDBITE_COMPUTER_ACCESS.get(env.CLOUDBITE_COMPUTER_ACCESS.idFromName('owner')).check(token);}catch{return false;}
}

/** New phone credentials authorize only /computer; existing owner/vault APIs never consult this cookie. */
export async function computerAuthRoute(req:Request,env:Env,url:URL,state:DurableObjectStub<State>):Promise<Response|null>{
  if(!url.pathname.startsWith(PREFIX))return null;
  if(url.origin!=='https://cloudbite.shinick.dev' || env.CLOUDBITE_PUBLIC_ORIGIN!==url.origin)return failure('not_found',404);
  if(!env.CLOUDBITE_COMPUTER_ACCESS)return failure('not_configured',503);
  const stub=env.CLOUDBITE_COMPUTER_ACCESS.get(env.CLOUDBITE_COMPUTER_ACCESS.idFromName('owner'));
  const token=computerCookieToken(req), op=url.pathname.slice(PREFIX.length);
  // RPC/parse failures fail closed as a fixed 503; no raw error reaches the response.
  const call=async(action:string,extra:Record<string,unknown>={}):Promise<Record<string,any>>=>{
    try{const r=JSON.parse(await stub.authJson(action,JSON.stringify({origin:req.headers.get('origin')??url.origin,token,...extra})));return r&&typeof r==='object'?r:{ok:false,status:503};}catch{return {ok:false,status:503};}
  };
  const legacyRoute=async(op:string,body:string)=>{
    try{return await ownerRoute(new Request(req.url,{method:'POST',headers:req.headers,body}),env,'/api/cloudbite/owner/'+op,state,json);}catch{return null;}
  };
  const respond=(r:Record<string,any>,pair=false)=>{
    if(!r.ok)return failure(pair?'pair_invalid':'computer_auth_failed',typeof r.status==='number'?r.status:400);
    const {sessionToken,cookieMaxAge,options,renew,...safe}=r;
    const res=json(options??safe);
    if(typeof sessionToken==='string' && typeof cookieMaxAge==='number')res.headers.append('set-cookie',computerSetCookie(sessionToken,cookieMaxAge));
    else if(renew && token && typeof cookieMaxAge==='number')res.headers.append('set-cookie',computerSetCookie(token,cookieMaxAge));
    return res;
  };
  if(op==='session' && req.method==='GET'){
    const phone=await call('session');if(!phone.ok)return respond(phone);
    let legacy=false,oldHasCredentials=false;
    if(!phone.authenticated || !phone.hasCredentials){
      legacy=await ownerCookieValid(req,env,state);
      try {oldHasCredentials=(await state.cloudbiteOwnerStatus(null)).hasCredentials;}catch{/* Existing owner availability cannot invalidate a phone session. */}
    }
    return respond({...phone,authenticated:phone.authenticated===true||legacy,hasCredentials:phone.hasCredentials===true||oldHasCredentials});
  }
  if(op==='credentials' && req.method==='GET')return respond(await call('credentials'));
  if(req.method!=='POST')return failure('method_not_allowed',405);
  if(req.headers.get('origin')!==url.origin)return failure('bad_origin',403);
  if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return failure('bad_request',415);
  let input:Record<string,unknown>;
  try{const text=await boundedText(req,32*1024);const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();input=value;}catch{return failure('bad_request',400);}
  const legacy=await ownerCookieValid(req,env,state);
  if(op==='options' || op==='login'){
    const s=await call('session');
    if(!s.ok)return respond(s);
    // Existing hardware keys remain a first-setup fallback; phone passkeys use their own exact RP.
    if(!s.hasCredentials)return await legacyRoute(op,JSON.stringify(input))??failure('computer_auth_unavailable',503);
    return respond(await call(op==='options'?'loginOptions':'login',{responseJson:JSON.stringify(input.response)}));
  }
  if(op==='logout'){
    // Legacy first, gated on cookie presence (not on its check), so a State outage can never report a false sign-out.
    // Each cookie is cleared only after its own server session ended; any failure is 503 and a retry is safe.
    let legacyClear:string|null=null;
    if(legacyCookiePresented(req,env)){
      const old=await legacyRoute('logout','{}');legacyClear=old?.ok?old.headers.get('set-cookie'):null;
      if(!legacyClear)return failure('logout_unavailable',503);
    }
    const phone=await call('logout');
    const res=phone.ok?respond(phone):failure('logout_unavailable',503);
    if(phone.ok)res.headers.append('set-cookie',computerClearCookie());
    if(legacyClear)res.headers.append('set-cookie',legacyClear);
    return res;
  }
  if(op==='pair')return respond(await call('pair',{pairToken:input.token}),true);
  if(op==='register/options')return respond(await call('registerOptions',{legacyOwner:legacy}));
  if(op==='register/verify')return respond(await call('registerVerify',{legacyOwner:legacy,responseJson:JSON.stringify(input.response)}));
  if(op==='credentials/revoke')return respond(await call('revokeCredential',{credentialId:input.credentialId}));
  return failure('not_found',404);
}
