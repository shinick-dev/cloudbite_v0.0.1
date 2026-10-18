// Actual files in the independent demo sandbox. No browser storage and no simulated editor content.
export const LAB_DEMO_EDITOR_JS = String.raw`
function createLabDemoEditor(D){
 const states=new Map(),names=['결과.txt','01_요청메모.txt','02_진행메모.txt'];
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n};
 const admin=()=>{try{return !!D.admin()}catch{return false}};
 function make(id){
  const s={id,name:'결과.txt',content:'',hash:null,dirty:false,busy:false,pending:null,materials:[],ended:false};
  const root=el('section');root.className='demo-file-editor';root.setAttribute('aria-label','모임지기 시연실 파일 편집기');
  const style=el('style');style.textContent='.demo-file-editor{min-width:0;border:1px solid var(--line,#d8dcdF);border-radius:12px;overflow:hidden;margin:12px 0}.demo-file-editor .de-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;background:var(--card,#fff)}.demo-file-editor button,.demo-file-editor select{width:auto;min-height:38px;margin:0;font:inherit;font-size:13px}.demo-file-editor textarea{display:block;box-sizing:border-box;width:100%;height:260px;resize:vertical;border:0;border-radius:0;margin:0;padding:14px;background:#18212f;color:#dbe6f5;caret-color:#fff;font:14px/1.7 ui-monospace,Consolas,monospace;tab-size:2}.demo-file-editor textarea::selection{background:#315cf2}.demo-file-editor textarea:focus-visible{outline:2px solid #315cf2;outline-offset:-2px}.demo-file-editor .de-note{padding:8px 12px;margin:0;font-size:13px}.demo-file-editor [hidden]{display:none!important}@media(max-width:600px){.demo-file-editor textarea{height:230px}.demo-file-editor .de-tools{gap:4px}}';
  const tools=el('div');tools.className='de-tools';
  const choose=el('select');choose.setAttribute('aria-label','시연 파일');for(const name of names){const o=el('option',name);o.value=name;choose.append(o)}
  const read=el('button','파일 읽기'),save=el('button','시연실에 저장'),mats=el('button','수업 메모 넣기');read.className=mats.className='sec';
  const text=el('textarea');text.setAttribute('aria-label','모임지기 시연실 파일 내용');text.spellcheck=false;text.placeholder='시연실을 만든 뒤 파일 읽기를 누르세요. 실제 저장 파일을 읽고 편집합니다.';text.disabled=true;
  const line=el('p','시연실 파일을 아직 읽지 않았습니다. 참여자 파일에는 영향을 주지 않습니다.');line.className='de-note';line.setAttribute('role','status');
  const pending=el('p');pending.className='de-note';pending.hidden=true;
  tools.append(choose,read,save,mats);root.append(style,tools,text,line,pending);
  s.root=root;s.text=text;s.line=line;s.choose=choose;
  function say(t,bad){line.textContent=t;line.className='de-note '+(bad?'bad':'mut')}
  function paint(){const a=admin()&&!s.ended;read.disabled=choose.disabled=mats.disabled=s.busy||!a;save.disabled=s.busy||!a||s.hash===null||!s.dirty||!!s.pending;text.disabled=s.busy||!a||s.hash===null;pending.hidden=!s.pending;pending.textContent=s.pending?'저장 결과가 미확정입니다. 입력을 복사해 둔 뒤 파일 읽기로 서버 내용을 대조하세요. 자동으로 다시 저장하지 않습니다.':'';}
  function take(file){if(s.ended)return;if(!file||file.filename!==s.name||typeof file.content!=='string'||typeof file.hash!=='string')throw Error('파일 응답을 확인하지 못했습니다.');s.content=file.content;s.hash=file.hash;s.dirty=false;s.pending=null;text.value=file.content;say(file.exists?'실제 시연실의 저장 파일을 읽었습니다.':'아직 없는 파일입니다. 내용을 입력하고 저장하면 시연실에 만듭니다.')}
  async function load(){if(s.busy||!admin())return;if(s.dirty&&!confirm('아직 저장하지 않은 입력을 서버 파일로 바꿉니다. 필요한 입력을 복사해 두셨나요?'))return;s.busy=true;paint();say('실제 시연실 파일을 읽고 있습니다…');try{take((await D.call('/api/lab/classroom/demo/file',{id:s.id,filename:s.name})).file)}catch(e){say('파일을 읽지 못했습니다. 시연실이 준비됐는지 확인하세요. '+String(e.message||e),true)}finally{s.busy=false;paint()}}
  choose.onchange=()=>{if(s.busy)return;if(s.dirty&&!confirm('저장하지 않은 입력이 있습니다. 다른 파일로 이동할까요?')){choose.value=s.name;return}s.name=choose.value;s.hash=null;s.content='';s.dirty=false;s.pending=null;text.value='';paint();load()};
  text.oninput=()=>{s.content=text.value;s.dirty=true;paint()};read.onclick=load;
  save.onclick=async()=>{if(s.busy||!admin()||!s.dirty||s.pending||s.hash===null)return;const op={id:s.id,filename:s.name,requestId:crypto.randomUUID(),content:text.value,expectedHash:s.hash};s.pending=op;s.busy=true;paint();say('시연실에 실제 파일을 저장하고 있습니다…');try{take((await D.call('/api/lab/classroom/demo/file',op)).file);say('시연실에 저장했습니다. 참여자 파일은 바뀌지 않았습니다.')}catch(e){say('저장 결과를 확인하지 못했습니다. 현재 입력을 유지합니다. '+String(e.message||e),true)}finally{s.busy=false;paint()}};
  mats.onclick=async()=>{if(s.busy||!admin())return;if(!confirm('저장된 수업 자료의 메모 두 개를 시연실에 넣습니다. 이미 있는 파일은 덮어쓰지 않습니다. 참여자 파일은 바뀌지 않습니다.'))return;s.busy=true;paint();let added=0,kept=0;try{const materials=s.materials.filter(m=>m&&names.slice(1).includes(m.name)&&typeof m.content==='string');if(!materials.length)throw Error('수업 준비에서 메모 연습 템플릿을 먼저 저장하세요.');for(const m of materials){const current=(await D.call('/api/lab/classroom/demo/file',{id:s.id,filename:m.name})).file;if(current.exists){kept++;continue}await D.call('/api/lab/classroom/demo/file',{id:s.id,filename:m.name,requestId:crypto.randomUUID(),content:m.content,expectedHash:'missing'});added++}say('메모 '+added+'개를 넣었습니다. 기존 파일 '+kept+'개는 유지했습니다.')}catch(e){say('자료 넣기가 완료됐는지 확인이 필요합니다. 파일 읽기로 확인하세요. '+String(e.message||e),true)}finally{s.busy=false;paint()}};
  s.paint=paint;paint();return s;
 }
 return{box(id,materials){let s=states.get(id);if(!s){s=make(id);states.set(id,s)}s.materials=Array.isArray(materials)?materials:[];s.paint();return s.root},clear(){for(const s of states.values()){s.ended=true;s.content='';s.text.value='';s.hash=null;s.pending=null;s.materials=[];s.root.replaceChildren();s.root.remove()}states.clear()}};
}
`;
