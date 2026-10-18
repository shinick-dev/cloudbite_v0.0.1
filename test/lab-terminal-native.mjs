// 선택 실행: Windows의 로컬 WSL Ubuntu + Node + tmux로 실제 전송을 검증한다.
// 운영 Daytona는 사용하지 않는다. 별도 HOME/TMUX_TMPDIR와 /tmp 디렉터리만 쓴다.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const out=await build({entryPoints:['src/lab-terminal-service.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const M=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const root='/tmp/gw-terminal-native-'+randomUUID(),sid=randomUUID(),rid=randomUUID();
const command="printf '%s\\n' '한글; $HOME $(touch NEVER_A) `touch NEVER_B`' >> result.txt";
const commands=[M.terminalStartCommand(root+'/work'),M.terminalSendCommand(sid,rid,command),M.terminalSendCommand(sid,rid,command),M.terminalSendCommand(sid,randomUUID(),"export GW_LESSON_TEST='persists'"),M.terminalSendCommand(sid,randomUUID(),'printf \'%s\' "$GW_LESSON_TEST" > state.txt')];
const script=`const f=require('node:fs'),p=require('node:path'),c=require('node:child_process'),a=require('node:assert/strict');
const root=${JSON.stringify(root)},commands=${JSON.stringify(commands)};
f.mkdirSync(root+'/socket',{recursive:true,mode:448});f.mkdirSync(root+'/work',{recursive:true,mode:448});
const env={...process.env,HOME:root,TMUX_TMPDIR:root+'/socket',PATH:p.dirname(process.execPath)+':'+process.env.PATH};
const run=(command)=>c.execFileSync('bash',['-c',command],{env,encoding:'utf8',timeout:15000}).trim();
const wait=(name)=>{for(let i=0;i<100;i++){if(f.existsSync(root+'/work/'+name))return;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}throw Error('output timeout '+name);};
try{
 a.equal(run(commands[0]),'READY');a.equal(run(commands[1]),'SENT');a.equal(run(commands[2]),'DUPLICATE');
 a.equal(run(commands[3]),'SENT');a.equal(run(commands[4]),'SENT');wait('result.txt');wait('state.txt');
 a.equal(f.readFileSync(root+'/work/result.txt','utf8'),${JSON.stringify('한글; $HOME $(touch NEVER_A) `touch NEVER_B`\n')});
 a.equal(f.readFileSync(root+'/work/state.txt','utf8'),'persists');a.equal(f.existsSync(root+'/work/NEVER_A'),false);a.equal(f.existsSync(root+'/work/NEVER_B'),false);
 const screen=c.execFileSync('tmux',['capture-pane','-p','-t','=gw-lesson:0.0'],{env,encoding:'utf8'});a.ok(screen.includes('result.txt'));
 console.log('ok real tmux: dedicated session, Korean/quotes/dollar/backtick literal transport, one Enter, duplicate suppressed, shell state persists, pane output visible');
}finally{try{c.execFileSync('tmux',['kill-server'],{env,stdio:'ignore'});}catch{}if(root.startsWith('/tmp/gw-terminal-native-'))f.rmSync(root,{recursive:true,force:true});}
`;
let binary=process.env.LAB_TEST_LINUX_NODE;
if(!binary){const found=spawnSync('wsl.exe',['-d','Ubuntu','--','bash','-lc','ls ~/.nvm/versions/node/*/bin/node 2>/dev/null | head -1'],{encoding:'utf8'});binary=found.stdout.trim();}
assert.ok(binary,'Set LAB_TEST_LINUX_NODE to the local WSL Node binary');
const r=spawnSync('wsl.exe',['-d','Ubuntu','--',binary,'-'],{input:script,encoding:'utf8',timeout:30000});
process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.error)throw r.error;assert.equal(r.status,0);
