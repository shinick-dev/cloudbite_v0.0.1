// Owner-authenticated capacity helpers. Call only after computerRoute authenticates the owner.
// Provider keys and raw sandbox records never leave this module. Selection itself allocates nothing.
import type { ComputerEnv, ComputerAccount } from './cloudbite-computer-contract';
import { computerAccounts, COMPUTER_REQUEST_ID, isAccount } from './cloudbite-computer-contract';
import { dt, type Dt } from './lab';
import { gpuCandidates } from './cloudbite-computer-gpu';

export interface CapacitySandbox { id:string;account:ComputerAccount;name:string;region:string;state:string;cpu:number|null;memoryGiB:number|null }
type RawSandbox = {id?:unknown;name?:unknown;target?:unknown;region?:unknown;state?:unknown;cpu?:unknown;memory?:unknown};
const ID=/^[a-zA-Z0-9_-]{8,128}$/;
const clean=(v:unknown,n=128)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';
const positive=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;
function sandbox(r:RawSandbox,account:ComputerAccount):CapacitySandbox|null {
  if(typeof r?.id!=='string'||!ID.test(r.id))return null;
  return{id:r.id,account,name:clean(r.name)||r.id,region:clean(r.target??r.region,48),state:clean(r.state,48),cpu:positive(r.cpu),memoryGiB:positive(r.memory)};
}
export async function capacitySandboxes(env:ComputerEnv){
  let partial=false;
  const groups=await Promise.all(computerAccounts(env).map(async a=>{
    const out:CapacitySandbox[]=[];let cursor:string|undefined;
    try{
      for(let page=0;page<2;page++){
        const q=new URLSearchParams({limit:'100'});if(cursor)q.set('cursor',cursor);
        const raw=await dt<{items?:RawSandbox[];nextCursor?:string|null}|RawSandbox[]>({api:a.api,key:a.key},'GET','/sandbox?'+q,undefined,AbortSignal.timeout(12_000));
        const rows=Array.isArray(raw)?raw:raw.items;if(!Array.isArray(rows))throw Error('schema');
        for(const r of rows){const s=sandbox(r,a.id);if(s)out.push(s);}
        cursor=Array.isArray(raw)?undefined:(typeof raw.nextCursor==='string'?raw.nextCursor:undefined);
        if(!cursor)break;
      }
      if(cursor)partial=true;
    }catch{partial=true;}
    return out;
  }));
  return{ok:true as const,sandboxes:groups.flat(),partial};
}
/** Exact get under the explicitly configured account key, never a caller-controlled upstream. */
export async function capacitySandbox(env:ComputerEnv,id:unknown,account:unknown):Promise<CapacitySandbox|null>{
  if(typeof id!=='string'||!ID.test(id)||!isAccount(account))return null;
  const a=computerAccounts(env).find(a=>a.id===account);if(!a)return null;
  const raw=await dt<RawSandbox>({api:a.api,key:a.key} as Dt,'GET','/sandbox/'+encodeURIComponent(id),undefined,AbortSignal.timeout(12_000));
  if(raw.id!==id)return null;
  return sandbox(raw,a.id);
}
export async function capacityGpuCandidates(env:ComputerEnv,params:URLSearchParams){
  const sb=await capacitySandbox(env,params.get('sandboxId'),params.get('account'));
  if(!sb)return null;
  const raw=params.get('minVramGb');const min=raw===null?24:Number(raw);
  if(!Number.isFinite(min)||min<0||min>192)return null;
  return{ok:true as const,sandbox:sb,...await gpuCandidates(sb.region,min)};
}
interface SelectionRpc {ownerSelectGpuJson(input:{ownerMachineId:string;requestId:string;candidateId:string;gpu:string;country:string|null;market:string|null}):Promise<string>}
export async function capacityGpuSelect(env:ComputerEnv,input:Record<string,unknown>,nested:SelectionRpc){
  if(typeof input.requestId!=='string'||!COMPUTER_REQUEST_ID.test(input.requestId)||typeof input.candidateId!=='string'||input.candidateId.length>512)return null;
  const sb=await capacitySandbox(env,input.sandboxId,input.account);if(!sb)return null;
  const found=await gpuCandidates(sb.region,0);
  const candidate=found.candidates.find(c=>c.id===input.candidateId&&c.selectable&&c.available>0);
  if(!candidate)return{status:409,body:{error:{code:'gpu_candidate_unavailable',message:'Refresh GPU candidates and select an available option.'}}};
  const result=JSON.parse(await nested.ownerSelectGpuJson({ownerMachineId:sb.id,requestId:input.requestId,candidateId:candidate.id,gpu:candidate.gpu,country:candidate.country,market:candidate.market}));
  // Explicit flags work even if the CLI capability was installed for a different sandbox.
  if(result.body?.ok){
    const shell=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
    result.body.commandExample='cloudbite-compute run --provider nosana --gpu '+shell(candidate.gpu)+(candidate.country?' --country '+candidate.country:'')+' --image nvidia/cuda:12.8.1-base-ubuntu22.04 -- nvidia-smi';
  }
  return result;
}
