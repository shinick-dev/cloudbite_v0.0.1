// Helpers called only after the root computer route verifies the owner's cookie/admin credential.
// Browser callers never name an upstream, token or trusted ownerMachineId.
import type {ComputerEnv,ComputerAccount,ComputerMachineRef} from './cloudbite-computer-contract';
import {capacitySandbox} from './cloudbite-computer-capacity-api';
import {cbGpuAvailability} from './cloudbite-computer-gpu';

export interface WebJobSandbox {id:string;account:ComputerAccount;name:string;region:string|null}
interface MachineRpc {computerMachine(tag:string):Promise<{ok:true;machine:ComputerMachineRef}|{error:unknown;status:number}>}
export interface WebJobsRpc {
 ownerGpuSelectionJson(id:string):Promise<string>;
 ownerRunJson(input:Record<string,unknown>):Promise<string>;
 ownerStopJson(input:Record<string,unknown>):Promise<string>;
 ownerJobsJson():Promise<string>;
}
type Result={status:number;body:Record<string,unknown>};
const bad=(code:string,status=400):Result=>({status,body:{error:{code,message:code}}});
const RUN_KEYS=new Set(['requestId','sandboxId','account','provider','image','timeout','command','files','acknowledgeCost','acknowledgePublic']);

export async function webJobSandbox(env:ComputerEnv,computer:MachineRpc,tag:string,id:unknown,account:unknown):Promise<WebJobSandbox|null>{
 if(id!==undefined&&id!==null||account!==undefined&&account!==null)return capacitySandbox(env,id,account);
 const current=await computer.computerMachine(tag);if(!('ok' in current))return null;
 const {id:machineId,name,region,account:machineAccount}=current.machine;
 return{id:machineId,name,region:region??null,account:machineAccount};
}
export async function webJobsContext(env:ComputerEnv,computer:MachineRpc,nested:WebJobsRpc,tag:string,params:URLSearchParams):Promise<Result>{
 const sb=await webJobSandbox(env,computer,tag,params.get('sandboxId'),params.get('account'));if(!sb)return bad('bad_sandbox_selection');
 const raw=JSON.parse(await nested.ownerGpuSelectionJson(sb.id));if(!raw.body?.ok)return raw;
 const selection=raw.body.selection??null;let gpuBaseUsdPerHour:number|null=null;
 if(selection){try{const v=await cbGpuAvailability(selection.gpu,selection.country);gpuBaseUsdPerHour=v.usdPerHourMax??v.usdPerHourMin;}catch{/* price unknown, never invented */}}
 return{status:200,body:{ok:true,sandbox:sb,selection,pricing:{cpuUsdPerHour:0.165924,gpuBaseUsdPerHour,gpuReservationMinutes:50,networkFeeIncluded:false,observedAt:new Date().toISOString()}}};
}
export async function webJobsRun(env:ComputerEnv,computer:MachineRpc,nested:WebJobsRpc,tag:string,input:Record<string,unknown>):Promise<Result>{
 if(Object.keys(input).some(k=>!RUN_KEYS.has(k)))return bad('bad_request');
 if(input.acknowledgeCost!==true)return bad('cost_confirmation_required');
 if(input.provider==='nosana'&&input.acknowledgePublic!==true)return bad('public_confirmation_required');
 const sb=await webJobSandbox(env,computer,tag,input.sandboxId,input.account);if(!sb)return bad('bad_sandbox_selection');
 const fields:Record<string,unknown>={ownerMachineId:sb.id};
 for(const k of ['requestId','provider','image','timeout','command','files'])if(input[k]!==undefined)fields[k]=input[k];
 return JSON.parse(await nested.ownerRunJson(fields));
}
export async function webJobsStop(nested:WebJobsRpc,input:Record<string,unknown>):Promise<Result>{
 if(Object.keys(input).some(k=>!['requestId','jobId'].includes(k)))return bad('bad_request');
 return JSON.parse(await nested.ownerStopJson(input));
}
export async function webJobOutput(nested:WebJobsRpc,id:string):Promise<{status:number;text:string|null}>{
 if(!/^nj[0-9a-f]{24}$/.test(id))return{status:404,text:null};
 const raw=JSON.parse(await nested.ownerJobsJson());
 const job=raw.body?.ok&&Array.isArray(raw.body.jobs)?raw.body.jobs.find((j:{id?:unknown})=>j?.id===id):null;
 if(!job)return{status:404,text:null};
 if(!job.result||typeof job.result.output!=='string')return{status:409,text:null};
 return{status:200,text:job.result.output.slice(-65536)};
}
