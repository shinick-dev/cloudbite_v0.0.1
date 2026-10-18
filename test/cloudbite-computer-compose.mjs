import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
const b=await build({entryPoints:['src/cloudbite-computer-compose.ts'],bundle:true,write:false,platform:'neutral',format:'esm'});
const M=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const {COMPUTER_COMPOSE_JS:JS,COMPUTER_COMPOSE_CSS:CSS,COMPUTER_COMPOSE_HEAD:HEAD,COMPUTER_COMPOSE_INPUT_PATH:INPUT}=M;
const INPUT_PATH='/p/_cloudbite/computer/desktop/_cloudbite-input';
assert.equal(INPUT,INPUT_PATH);
assert.match(HEAD,/^<script src="\/p\/_cloudbite\/computer\/desktop\/_cloudbite-compose\.js"><\/script><link rel="stylesheet" href="\/p\/_cloudbite\/computer\/desktop\/_cloudbite-compose\.css">$/);
assert.doesNotMatch(HEAD,/async|defer|type="module"/);
// Static boundaries: no storage, cookies, logging, HTML parsing, eval, external assets or cross-window authority.
for(const re of [/localStorage/,/sessionStorage/,/indexedDB/i,/cookie/i,/console\./,/\beval\b/,/new Function/,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/,/https?:/i,/\/\//,/postMessage/,/\bparent\./,/\b(w|window)\.(top|opener|parent)\b/,/setTimeout|setInterval/,/reconnect|\/(start|stop|extend|snapshot|launch)\b/i])assert.doesNotMatch(JS,re,String(re));
for(const re of [/url\(/i,/@import/i,/@font-face/i,/https?:/i])assert.doesNotMatch(CSS,re,String(re));
assert.match(CSS,/min-width:48px;min-height:48px/);assert.match(CSS,/width:min\(360px,calc\(100vw - 24px\)\)/);assert.match(CSS,/min-height:80px/);
const selectors=CSS.replace(/@media[^{]*\{/g,'').replace(/\{[^{}]*\}/g,'\n').replace(/\}/g,'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
assert.ok(selectors.length>10&&selectors.every(s=>/^#cloudbite-compose-root\b/.test(s)),'every rule is namespaced');

function makePage({lang='en-US',loading=true}={}){
 const winCap=[],winBub=[],touched=[],fetches=[];let ready=loading?'loading':'complete';const docListeners={};
 class El{constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attrs={};this._t='';this.hidden=false;this.disabled=false;this.readOnly=false;this.value='';}
  appendChild(c){c.parentNode=this;this.children.push(c);return c}
  setAttribute(k,v){this.attrs[k]=String(v);if(k==='id')this.id=String(v)}getAttribute(k){return k in this.attrs?this.attrs[k]:null}
  set textContent(v){this._t=String(v);this.children=[]}get textContent(){return this._t+this.children.map(c=>c.textContent).join('')}
  focus(){doc.activeElement=this}}
 const html=new El('html');
 const doc={documentElement:html,body:null,activeElement:null,get readyState(){return ready},createElement:t=>new El(t),
  addEventListener:(t,f)=>{(docListeners[t]??=[]).push(f)},get cookie(){touched.push('cookie');return ''},set cookie(_){touched.push('cookie')}};
 const win={document:doc,navigator:{language:lang},Object,String,JSON,Promise,Uint8Array,
  addEventListener:(t,f,c)=>{(c===true||c?.capture?winCap:winBub).push({t,f})},
  crypto:{randomUUID:()=>'00000000-0000-4000-8000-'+String(fetches.length+1+Math.random()).replace(/\D/g,'').padEnd(12,'0').slice(0,12)},
  fetch:(url,opts)=>new Promise((resolve,reject)=>fetches.push({url,opts,body:JSON.parse(opts.body),resolve,reject}))};
 for(const k of ['localStorage','sessionStorage','indexedDB','console','parent','top','opener'])Object.defineProperty(win,k,{get(){touched.push(k);return undefined}});
 win.window=win;vm.createContext(win);
 const dispatch=(target,type,props={})=>{const e={type,target,key:undefined,keyCode:0,isComposing:false,shiftKey:false,ctrlKey:false,altKey:false,metaKey:false,repeat:false,...props,
   defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true},stopImmediatePropagation(){this.stopped=this.imm=true}};
  if(type==='click'&&target.disabled)return e;
  for(const l of winCap)if(l.t===type){l.f(e);if(e.imm)break}
  if(!e.stopped)for(const l of winBub)if(l.t===type)l.f(e);return e};
 return {win,doc,html,El,winCap,touched,fetches,dispatch,loadBody(){doc.body=html.appendChild(new El('body'));ready='interactive';for(const f of docListeners.DOMContentLoaded??[])f()}};
}
const find=(n,p)=>{if(p(n))return n;for(const c of n.children){const r=find(c,p);if(r)return r}return null};
const byId=(pg,id)=>find(pg.html,n=>n.id===id);
const tick=()=>new Promise(r=>setImmediate(r));
const ok=(s=200,b={ok:true,outcome:'sent'})=>({status:s,json:async()=>b});

// Guards are installed synchronously before <body> exists; DOM is built on DOMContentLoaded.
const pg=makePage();
vm.runInContext(JS,pg.win);
assert.ok(pg.winCap.some(l=>l.t==='keydown')&&pg.winCap.some(l=>l.t==='pointerdown')&&pg.winCap.some(l=>l.t==='touchstart')&&pg.winCap.some(l=>l.t==='beforeinput'));
assert.equal(pg.doc.body,null);assert.equal(byId(pg,'cloudbite-compose-root'),null);
vm.runInContext(JS,pg.win);assert.equal(pg.winCap.filter(l=>l.t==='keydown').length,1,'second include is a no-op');
pg.loadBody();
const root=byId(pg,'cloudbite-compose-root');assert.ok(root&&root.parentNode===pg.doc.body);
const toggle=find(root,n=>n.attrs['data-cloudbite-compose-action']==='open'),pane=byId(pg,'cloudbite-compose-pane'),ta=byId(pg,'cloudbite-compose-text'),status=byId(pg,'cloudbite-compose-status');
const btn=a=>find(root,n=>n.attrs['data-cloudbite-compose-action']===a);
assert.equal(toggle.textContent,'Type locally');assert.equal(pane.hidden,true);assert.equal(status.attrs['aria-live'],'polite');
assert.match(byId(pg,'cloudbite-compose-caption').textContent,/currently focused on the remote screen/);
// Selkies registers its global handlers later; it must still see events outside the widget and none inside it.
const selkies=[];for(const t of ['keydown','keyup','keypress','input','beforeinput','compositionstart','compositionend','pointerdown','mousedown','touchstart','click','paste']){pg.win.addEventListener(t,e=>selkies.push(t+':'+(e.target===canvas?'canvas':'widget')),true);pg.win.addEventListener(t,e=>selkies.push('bubble-'+t),false)}
const canvas=pg.doc.body.appendChild(new pg.El('canvas'));
pg.dispatch(canvas,'keydown',{key:'a'});pg.dispatch(canvas,'pointerdown');pg.dispatch(canvas,'touchstart');
assert.deepEqual(selkies,['keydown:canvas','bubble-keydown','pointerdown:canvas','bubble-pointerdown','touchstart:canvas','bubble-touchstart']);selkies.length=0;
for(const t of ['pointerdown','touchstart','mousedown'])pg.dispatch(toggle,t);pg.dispatch(toggle,'click');
assert.equal(pane.hidden,false);assert.equal(toggle.hidden,true);assert.equal(pg.doc.activeElement,ta);assert.equal(toggle.attrs['aria-expanded'],'true');
// Typing, IME composition and non-plain Enter stay local: no fetch, no remote key events, native editing not prevented.
const draft='  안녕하세요 세계  👋🏽 ls -la  ';
for(const t of ['keydown','keypress','beforeinput'])assert.equal(pg.dispatch(ta,t,{key:'a'}).defaultPrevented,false);
ta.value=draft;pg.dispatch(ta,'input');assert.equal(byId(pg,'cloudbite-compose-count').textContent,draft.length+' / 4000');
pg.dispatch(ta,'compositionstart');
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter'}).defaultPrevented,false,'composition flag blocks Enter');
pg.dispatch(ta,'compositionend');
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter',isComposing:true}).defaultPrevented,false);
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter',keyCode:229}).defaultPrevented,false);
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter',shiftKey:true}).defaultPrevented,false,'Shift+Enter is a native newline');
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter',repeat:true}).defaultPrevented,true,'held Enter neither sends nor adds newlines');
pg.dispatch(ta,'paste');pg.dispatch(ta,'keyup',{key:'Enter'});
assert.equal(pg.fetches.length,0,'draft never leaves before an explicit send');assert.deepEqual(selkies,[],'Selkies saw no widget event');
// Plain Enter sends exactly once with the fixed body and same-origin credentials, and locks the widget while pending.
assert.equal(pg.dispatch(ta,'keydown',{key:'Enter'}).defaultPrevented,true);
assert.equal(pg.fetches.length,1);let f=pg.fetches[0];
assert.equal(f.url,INPUT_PATH);assert.equal(f.opts.method,'POST');assert.equal(f.opts.credentials,'same-origin');assert.equal(f.opts.headers['content-type'],'application/json');
assert.deepEqual(Object.keys(f.body),['requestId','text','enter']);assert.equal(f.body.text,draft);assert.equal(f.body.enter,true);assert.match(f.body.requestId,/^[0-9a-f-]{36}$/);
assert.equal(ta.readOnly,true);assert.equal(btn('send').disabled,true);assert.equal(btn('paste').disabled,true);assert.equal(root.attrs['aria-busy'],'true');
pg.dispatch(ta,'keydown',{key:'Enter'});pg.dispatch(btn('send'),'click');assert.equal(pg.fetches.length,1,'no second request while pending');
// Unknown outcome (network failure): draft kept, clear warning, no automatic retry, same id for the same payload.
f.reject(new TypeError('network'));await tick();
assert.equal(ta.value,draft);assert.equal(status.attrs['data-kind'],'unknown');assert.match(status.textContent,/Check the remote screen; it may already have arrived/);
assert.equal(btn('reset').hidden,false);assert.equal(ta.readOnly,false);await tick();assert.equal(pg.fetches.length,1);
pg.dispatch(btn('send'),'click');assert.equal(pg.fetches.length,2);assert.equal(pg.fetches[1].body.requestId,f.body.requestId,'same UUID after unknown');
pg.fetches[1].resolve(ok(409,{error:{code:'delivery_unknown',message:'x'}}));await tick();assert.equal(status.attrs['data-kind'],'unknown');assert.equal(ta.value,draft);
pg.dispatch(btn('send'),'click');pg.fetches[2].resolve({status:200,json:async()=>{throw SyntaxError('html')}});await tick();
assert.equal(pg.fetches[2].body.requestId,f.body.requestId);assert.equal(status.attrs['data-kind'],'unknown');
// Paste only is a different payload -> new id; explicit reset also allows a new id for the same payload.
pg.dispatch(btn('paste'),'click');assert.equal(pg.fetches[3].body.enter,false);assert.notEqual(pg.fetches[3].body.requestId,f.body.requestId);
pg.fetches[3].resolve(ok(504,{}));await tick();const unknownId=pg.fetches[3].body.requestId;
pg.dispatch(btn('reset'),'click');assert.equal(btn('reset').hidden,true);assert.equal(status.textContent,'');
pg.dispatch(btn('paste'),'click');assert.notEqual(pg.fetches[4].body.requestId,unknownId,'reset starts a new request');
// Definite error keeps the draft and shows the safe server message; next send is a fresh request.
pg.fetches[4].resolve(ok(409,{error:{code:'desktop_unavailable',message:'The desktop is not ready yet.'}}));await tick();
assert.equal(ta.value,draft);assert.equal(status.attrs['data-kind'],'error');assert.match(status.textContent,/^Not sent: The desktop is not ready yet\.$/);assert.equal(btn('reset').hidden,true);
pg.dispatch(btn('paste'),'click');assert.notEqual(pg.fetches[5].body.requestId,pg.fetches[4].body.requestId);
// Known sent clears the draft only then.
pg.fetches[5].resolve(ok());await tick();assert.equal(ta.value,'');assert.equal(status.attrs['data-kind'],'sent');assert.equal(btn('paste').disabled,true);
// Empty Send + Enter sends a bare Enter; Paste only stays disabled for empty text.
pg.dispatch(btn('paste'),'click');assert.equal(pg.fetches.length,6);
pg.dispatch(btn('send'),'click');assert.deepEqual([pg.fetches[6].body.text,pg.fetches[6].body.enter],['',true]);pg.fetches[6].resolve(ok());await tick();
// Over-limit text never leaves; 4000 exactly does.
ta.value='가'.repeat(4001);pg.dispatch(ta,'input');pg.dispatch(btn('send'),'click');assert.equal(pg.fetches.length,7);assert.match(status.textContent,/4000/);
ta.value='x'.repeat(4000);pg.dispatch(btn('send'),'click');assert.equal(pg.fetches.length,8);pg.fetches[7].resolve(ok());await tick();
// Close (button or Escape) collapses and keeps the draft.
ta.value='keep me';pg.dispatch(btn('close'),'click');assert.equal(pane.hidden,true);assert.equal(toggle.hidden,false);assert.equal(ta.value,'keep me');
pg.dispatch(toggle,'click');pg.dispatch(ta,'keydown',{key:'Escape'});assert.equal(pane.hidden,true);assert.equal(ta.value,'keep me');
assert.equal(pg.fetches.length,8);assert.deepEqual(selkies,[],'Selkies never saw widget events');assert.deepEqual(pg.touched,[],'no storage/cookie/logging/cross-window access');

// Korean UI from navigator.language; a page already parsed builds immediately.
const ko=makePage({lang:'ko-KR',loading:false});ko.doc.body=ko.html.appendChild(new ko.El('body'));vm.runInContext(JS,ko.win);
const kr=byId(ko,'cloudbite-compose-root');assert.equal(kr.attrs.lang,'ko');assert.equal(find(kr,n=>n.attrs['data-cloudbite-compose-action']==='open').textContent,'로컬에서 입력');
const kta=byId(ko,'cloudbite-compose-text');kta.value='한글 입력';ko.dispatch(find(kr,n=>n.attrs['data-cloudbite-compose-action']==='send'),'click');
assert.equal(ko.fetches[0].body.text,'한글 입력');ko.fetches[0].reject(Error('x'));await tick();
assert.match(byId(ko,'cloudbite-compose-status').textContent,/원격 화면을 확인하세요\. 이미 도착했을 수 있습니다\./);assert.equal(kta.value,'한글 입력');
console.log('cloudbite-computer-compose: ok');
