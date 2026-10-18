// Real archive code and filesystem, isolated /tmp workspace over a fixture transport.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
const b=await build({entryPoints:['src/lab.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'}),url='data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64');
const script=String.raw`import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{inflateRawSync}from'node:zlib';
const M=await import(URL_REPLACE),root=fs.mkdtempSync(path.join(os.tmpdir(),'gw-checkpoint-real-')),work=path.join(root,'work'),exports=path.join(root,'exports');
fs.mkdirSync(work);fs.mkdirSync(path.join(work,'node_modules'));fs.writeFileSync(path.join(work,'node_modules','skip'),'not included');fs.writeFileSync(path.join(root,'secret'),'outside-work');fs.symlinkSync(path.join(root,'secret'),path.join(work,'link-secret'));
const original='보고서\n첫 메모와 둘째 메모로 만든 다섯 줄\n';fs.writeFileSync(path.join(work,'report.txt'),original);
const translate=s=>s.replaceAll('/home/daytona/.gw-export',exports).replaceAll('/home/daytona/work',work),env={...process.env,HOME:root,PATH:path.dirname(process.execPath)+':/usr/bin:/bin'};
globalThis.fetch=async(input,init={})=>{const u=new URL(input);assert.equal(u.host,'fixture.invalid');
 if(u.pathname==='/native/process/execute'){
  const command=translate(JSON.parse(init.body).command);let exitCode=0,result='';try{result=execFileSync('/bin/bash',['-c',command],{env,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']})}catch(e){exitCode=e.status??1;result=String(e.stdout??'')+String(e.stderr??'')}
  return Response.json({exitCode,result});
 }
 if(u.pathname==='/native/files/upload'){const file=init.body.get('file'),target=translate(u.searchParams.get('path'));assert.ok(target.startsWith(exports+'/'));fs.writeFileSync(target,new Uint8Array(await file.arrayBuffer()),{flag:'wx'});return new Response('')}
 throw Error('unexpected fixture path '+u.pathname);
};
const rid=n=>'b0000000-0000-4000-8000-'+String(n).padStart(12,'0'),sandbox={id:'native',state:'started',toolboxProxyUrl:'https://fixture.invalid'},provider={api:'https://fixture.invalid',key:'fixture'},limits={bytes:67108864,entries:4000,seconds:30};
function entries(file){const data=fs.readFileSync(file),end=data.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert.ok(end>=0);let at=data.readUInt32LE(end+16),out={};const count=data.readUInt16LE(end+10);for(let i=0;i<count;i++){
 assert.equal(data.readUInt32LE(at),0x02014b50);const method=data.readUInt16LE(at+10),size=data.readUInt32LE(at+20),nl=data.readUInt16LE(at+28),xl=data.readUInt16LE(at+30),cl=data.readUInt16LE(at+32),local=data.readUInt32LE(at+42),name=data.subarray(at+46,at+46+nl).toString('utf8'),start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28),compressed=data.subarray(start,start+size);out[name]=(method===8?inflateRawSync(compressed):compressed).toString('utf8');at+=46+nl+xl+cl;
 }return out}
try{
 let effects=0;const perform=async effect=>{effects++;return effect()};const first=await M.packWork(provider,sandbox,rid(1),limits,perform);assert.equal(effects,3);assert.ok(first.skipped>0);
 const archive=path.join(exports,rid(1),'work.zip'),hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),files=entries(archive);assert.equal(files['work/report.txt'],original);assert.ok(!Object.keys(files).some(n=>n.includes('link-secret')||n.includes('node_modules')));
 await assert.rejects(()=>M.packWork(provider,sandbox,rid(1),limits,perform));assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),hash);assert.equal(fs.readFileSync(path.join(work,'report.txt'),'utf8'),original);
 await M.packWork(provider,sandbox,rid(2),limits,perform);assert.ok(fs.existsSync(path.join(exports,rid(2),'work.zip')));assert.ok(fs.existsSync(archive));assert.equal(fs.readFileSync(path.join(root,'secret'),'utf8'),'outside-work');
 let calls=0;await assert.rejects(()=>M.packWork(provider,sandbox,rid(3),limits,async effect=>{if(++calls===2)throw Error('class ended');return effect()}));assert.ok(!fs.existsSync(path.join(exports,rid(3),'work.zip')));assert.equal(fs.readFileSync(path.join(work,'report.txt'),'utf8'),original);
 console.log('PASS real isolated checkpoint ZIP: exact saved text; symlink/dependency excluded; original files and existing archives unchanged; unique archives retained; between-effect end gate honored');
}finally{assert.ok(root.startsWith(path.join(os.tmpdir(),'gw-checkpoint-real-')));fs.rmSync(root,{recursive:true,force:true})}
`;
assert.ok(process.env.LAB_TEST_LINUX_NODE,'Set LAB_TEST_LINUX_NODE to your WSL Ubuntu Node executable');
const r=spawnSync('wsl.exe',['-d','Ubuntu','--exec',process.env.LAB_TEST_LINUX_NODE,'--input-type=module','-'],{input:script.replace('URL_REPLACE',JSON.stringify(url)),encoding:'utf8',timeout:90000});
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');if(r.error)throw r.error;assert.equal(r.status,0);
