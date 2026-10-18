// CloudBite personal computer: local compose widget for the separate desktop origin (Selkies page).
// Root serves COMPUTER_COMPOSE_JS at COMPUTER_COMPOSE_JS_PATH and COMPUTER_COMPOSE_CSS at COMPUTER_COMPOSE_CSS_PATH and puts
// COMPUTER_COMPOSE_HEAD first in <head>, before any Selkies script, so the window capture guards run before Selkies listeners.
// The draft is volatile local DOM: nothing leaves the page until Send. Send is one POST to COMPUTER_COMPOSE_INPUT_PATH
// {requestId,text,enter} with the HttpOnly desktop cookie (same-origin); {ok:true,outcome:'sent'} clears the draft, an unknown
// outcome keeps the draft and the same requestId for the same payload (no automatic retry), a definite error keeps the draft.
// No storage, cookies, logging, external assets, HTML parsing or cross-window messaging.

export const COMPUTER_COMPOSE_JS_PATH = '/p/_cloudbite/computer/desktop/_cloudbite-compose.js';
export const COMPUTER_COMPOSE_CSS_PATH = '/p/_cloudbite/computer/desktop/_cloudbite-compose.css';
export const COMPUTER_COMPOSE_INPUT_PATH = '/p/_cloudbite/computer/desktop/_cloudbite-input';
export const COMPUTER_COMPOSE_MAX_CHARS = 4000;
export const COMPUTER_COMPOSE_HEAD = `<script src="${COMPUTER_COMPOSE_JS_PATH}"></script><link rel="stylesheet" href="${COMPUTER_COMPOSE_CSS_PATH}">`;

export const COMPUTER_COMPOSE_JS = String.raw`(function(){'use strict';
var w=window,d=document;if(w.__cloudbiteComposeInstalled)return;
try{Object.defineProperty(w,'__cloudbiteComposeInstalled',{value:true});}catch(_){}
var PATH='/p/_cloudbite/computer/desktop/_cloudbite-input',MAX=4000,P='cloudbite-compose';
var KO=/^ko\b/i.test(String(navigator.language||''));
var T=KO?{open:'로컬에서 입력',caption:'대상: 원격 화면에서 지금 선택된 입력란',label:'로컬 초안 (보내기 전에는 원격으로 가지 않습니다)',paste:'붙여넣기만',send:'보내기 + Enter',reset:'새 요청',close:'닫기',pending:'보내는 중…',sent:'원격 화면으로 보냈습니다.',unknown:'원격 화면을 확인하세요. 이미 도착했을 수 있습니다. 다시 보내면 같은 요청을 재사용합니다. 새로 보내려면 새 요청을 누르세요.',error:'보내지 못했습니다: ',tooLong:'4000자를 넘었습니다. 줄여 주세요.',empty:'먼저 내용을 입력하세요.'}
:{open:'Type locally',caption:'Target: the field currently focused on the remote screen',label:'Local draft (nothing reaches the remote screen until you send)',paste:'Paste only',send:'Send + Enter',reset:'New request',close:'Close',pending:'Sending…',sent:'Sent to the remote screen.',unknown:'Check the remote screen; it may already have arrived. Sending again reuses the same request. Use New request to start over.',error:'Not sent: ',tooLong:'The text is longer than 4000 characters.',empty:'Type something first.'};
var root=null,toggle,pane,ta,count,status,bPaste,bSend,bReset,composing=false,pending=false,last=null;
function inside(t){for(;t;t=t.parentNode)if(t===root)return true;return false;}
function uuid(){var c=w.crypto;if(c&&typeof c.randomUUID==='function')return c.randomUUID();var b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h='';for(var i=0;i<16;i++){h+=(b[i]+256).toString(16).slice(1);if(i===3||i===5||i===7||i===9)h+='-';}return h;}
function el(tag,attrs,text){var e=d.createElement(tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;}
function say(kind,text){status.setAttribute('data-kind',kind);status.textContent=text;}
function render(){var n=String(ta.value).length;count.textContent=n+' / '+MAX;ta.readOnly=pending;bPaste.disabled=pending||n===0;bSend.disabled=pending;bReset.hidden=!last||pending;root.setAttribute('aria-busy',pending?'true':'false');}
function open(){pane.hidden=false;toggle.hidden=true;toggle.setAttribute('aria-expanded','true');ta.focus();}
function close(){pane.hidden=true;toggle.hidden=false;toggle.setAttribute('aria-expanded','false');toggle.focus();}
function finish(kind,msg){pending=false;if(kind==='sent'){ta.value='';last=null;say('sent',T.sent);}else if(kind==='error'){last=null;say('error',T.error+(typeof msg==='string'?msg.slice(0,200):''));}else say('unknown',T.unknown);render();}
function send(enter){if(pending)return;var text=String(ta.value);if(text.length>MAX){say('error',T.tooLong);return;}if(!text&&!enter){say('error',T.empty);return;}
var id=last&&last.text===text&&last.enter===enter?last.id:uuid();last={id:id,text:text,enter:enter};pending=true;say('pending',T.pending);render();
var p;try{p=w.fetch(PATH,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:id,text:text,enter:enter})});}catch(e){p=Promise.reject(e);}
Promise.resolve(p).then(function(r){return Promise.resolve(r.json()).then(function(b){return{s:r.status,b:b};},function(){return{s:r.status,b:null};});}).then(function(x){var b=x.b;
if(x.s>=200&&x.s<300&&b&&b.ok===true&&b.outcome==='sent')finish('sent');
else if(x.s>=400&&x.s<500&&b&&b.error&&typeof b.error.code==='string'&&b.error.code!=='unknown_outcome'&&b.error.code!=='delivery_unknown')finish('error',b.error.message);
else finish('unknown');},function(){finish('unknown');});}
function reset(){if(pending)return;last=null;say('idle','');render();}
function act(t){for(;t&&t!==root;t=t.parentNode){var a=t.getAttribute&&t.getAttribute('data-cloudbite-compose-action');if(a){if(t.disabled)return;if(a==='open')open();else if(a==='close')close();else if(a==='paste')send(false);else if(a==='send')send(true);else if(a==='reset')reset();return;}}}
function key(e){if(e.target!==ta)return;if(e.key==='Escape'&&!composing&&!e.isComposing){close();return;}
if(e.key!=='Enter'||e.isComposing||e.keyCode===229||composing||e.shiftKey||e.ctrlKey||e.altKey||e.metaKey)return;e.preventDefault();if(!e.repeat)send(true);}
function guard(e){if(!root||!inside(e.target))return;e.stopImmediatePropagation();var t=e.type;
if(t==='compositionstart')composing=true;else if(t==='compositionend'){composing=false;render();}else if(t==='keydown')key(e);else if(t==='input')render();else if(t==='click')act(e.target);}
['keydown','keyup','keypress','beforeinput','input','textInput','compositionstart','compositionupdate','compositionend','paste','copy','cut','select','selectstart','focusin','focusout','mousedown','mouseup','mousemove','mouseover','mouseout','click','dblclick','auxclick','contextmenu','wheel','pointerdown','pointerup','pointermove','pointercancel','pointerover','pointerout','gotpointercapture','lostpointercapture','touchstart','touchmove','touchend','touchcancel'].forEach(function(t){w.addEventListener(t,guard,true);});
function build(){if(root)return;
root=el('div',{id:P+'-root','class':P,lang:KO?'ko':'en'});
toggle=el('button',{type:'button','class':P+'-toggle','aria-expanded':'false','aria-controls':P+'-pane','data-cloudbite-compose-action':'open'},T.open);
pane=el('section',{id:P+'-pane','class':P+'-pane',role:'region','aria-label':T.open});pane.hidden=true;
var head=el('div',{'class':P+'-head'});head.appendChild(el('span',{'class':P+'-title'},T.open));
head.appendChild(el('button',{type:'button','class':P+'-close','aria-label':T.close,'data-cloudbite-compose-action':'close'},'×'));
var cap=el('p',{id:P+'-caption','class':P+'-caption'},T.caption);
var lab=el('label',{'for':P+'-text','class':P+'-label'},T.label);
ta=el('textarea',{id:P+'-text','class':P+'-text',rows:'4',maxlength:String(MAX),'aria-describedby':P+'-caption '+P+'-count',autocomplete:'off',autocapitalize:'off',spellcheck:'false',enterkeyhint:'send'});
count=el('div',{id:P+'-count','class':P+'-count'});
var row=el('div',{'class':P+'-actions'});
bPaste=el('button',{type:'button','class':P+'-paste','data-cloudbite-compose-action':'paste'},T.paste);
bSend=el('button',{type:'button','class':P+'-send','data-cloudbite-compose-action':'send'},T.send);
bReset=el('button',{type:'button','class':P+'-reset','data-cloudbite-compose-action':'reset'},T.reset);
row.appendChild(bPaste);row.appendChild(bSend);row.appendChild(bReset);
status=el('div',{id:P+'-status','class':P+'-status',role:'status','aria-live':'polite','data-kind':'idle'});
[head,cap,lab,ta,count,row,status].forEach(function(n){pane.appendChild(n);});
root.appendChild(toggle);root.appendChild(pane);(d.body||d.documentElement).appendChild(root);render();}
if(d.readyState==='loading')d.addEventListener('DOMContentLoaded',build,{once:true});else build();
})();
`;

export const COMPUTER_COMPOSE_CSS = `#cloudbite-compose-root{position:fixed;right:12px;bottom:12px;z-index:2147483646;box-sizing:border-box;max-width:calc(100vw - 24px);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111827;-webkit-text-size-adjust:100%;text-align:left}
#cloudbite-compose-root *{box-sizing:border-box;font:inherit;letter-spacing:normal;text-transform:none}
#cloudbite-compose-root [hidden]{display:none!important}
#cloudbite-compose-root .cloudbite-compose-toggle{display:block;margin-left:auto;min-width:48px;min-height:48px;padding:0 18px;border:0;border-radius:24px;background:#1d4ed8;color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;touch-action:manipulation}
#cloudbite-compose-root .cloudbite-compose-pane{width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35)}
#cloudbite-compose-root .cloudbite-compose-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
#cloudbite-compose-root .cloudbite-compose-title{font-weight:700}
#cloudbite-compose-root .cloudbite-compose-close{min-width:48px;min-height:48px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:22px;cursor:pointer}
#cloudbite-compose-root .cloudbite-compose-caption{margin:4px 0 8px;color:#475569;font-size:13px}
#cloudbite-compose-root .cloudbite-compose-label{display:block;margin-bottom:4px;font-size:13px}
#cloudbite-compose-root .cloudbite-compose-text{display:block;width:100%;min-height:80px;max-height:45vh;padding:8px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#111827;font-size:16px;white-space:pre-wrap;resize:vertical}
#cloudbite-compose-root .cloudbite-compose-text[readonly]{background:#f1f5f9}
#cloudbite-compose-root .cloudbite-compose-count{margin-top:4px;color:#64748b;font-size:12px;text-align:right}
#cloudbite-compose-root .cloudbite-compose-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
#cloudbite-compose-root .cloudbite-compose-actions button{flex:1 1 auto;min-height:48px;padding:0 12px;border:1px solid #1d4ed8;border-radius:8px;background:#fff;color:#1d4ed8;font-weight:600;cursor:pointer;touch-action:manipulation}
#cloudbite-compose-root .cloudbite-compose-actions .cloudbite-compose-send{background:#1d4ed8;color:#fff}
#cloudbite-compose-root .cloudbite-compose-actions button:disabled{opacity:.5;cursor:not-allowed}
#cloudbite-compose-root .cloudbite-compose-status{min-height:1.4em;margin-top:8px;font-size:13px}
#cloudbite-compose-root .cloudbite-compose-status[data-kind="unknown"],#cloudbite-compose-root .cloudbite-compose-status[data-kind="error"]{color:#b45309;font-weight:600}
#cloudbite-compose-root .cloudbite-compose-status[data-kind="sent"]{color:#15803d}
#cloudbite-compose-root button:focus-visible,#cloudbite-compose-root textarea:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
@media (prefers-color-scheme:dark){#cloudbite-compose-root{color:#e5e7eb}#cloudbite-compose-root .cloudbite-compose-pane{background:#111827;border-color:#334155}#cloudbite-compose-root .cloudbite-compose-text{background:#0f172a;color:#e5e7eb;border-color:#475569}#cloudbite-compose-root .cloudbite-compose-text[readonly]{background:#1e293b}#cloudbite-compose-root .cloudbite-compose-caption,#cloudbite-compose-root .cloudbite-compose-count{color:#94a3b8}#cloudbite-compose-root .cloudbite-compose-actions button{background:#111827;color:#93c5fd;border-color:#3b82f6}#cloudbite-compose-root .cloudbite-compose-actions .cloudbite-compose-send{background:#2563eb;color:#fff}#cloudbite-compose-root .cloudbite-compose-status[data-kind="unknown"],#cloudbite-compose-root .cloudbite-compose-status[data-kind="error"]{color:#fbbf24}#cloudbite-compose-root .cloudbite-compose-status[data-kind="sent"]{color:#4ade80}}
`;
