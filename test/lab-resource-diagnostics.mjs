import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { collect, format } = require('../lab/files/lab-resources');
const root = '/sys/fs/cgroup';
function fixture({current='/class/seat', mountRoot='/', edits={}, denied=[], real={}}={}) {
  const files = { '/proc/self/cgroup': `0::${current}`, '/proc/self/mountinfo': `30 20 0:28 ${mountRoot} ${root} rw - cgroup2 cgroup rw` };
  for (const dir of [root, root+'/class', root+'/class/seat']) Object.assign(files, {
    [dir+'/cpu.max']: 'max 100000', [dir+'/cpuset.cpus.effective']: '0-3',
    [dir+'/memory.max']: 'max', [dir+'/memory.current']: '100',
    [dir+'/cpu.stat']: 'throttled_usec 123', [dir+'/memory.events']: 'oom 2\noom_kill 1',
  });
  Object.assign(files, edits); const reads=[];
  return { reads, io: {
    openSync(p) { reads.push(p); if (denied.includes(p) || files[p] == null) throw Error('unreadable'); return p; },
    readSync(p,b) { const data=Buffer.from(files[p]); data.copy(b); return Math.min(data.length,b.length); }, closeSync() {},
    realpathSync(p) { if (denied.includes(p)) throw Error('denied'); if (files[p] === null) { const e=Error('absent'); e.code='ENOENT'; throw e; } return real[p]??p; },
    statfsSync(p) { assert(['/','/home/daytona/work'].includes(p)); return {bavail:10,bsize:4096}; },
  }};
}
let f=fixture({edits:{[root+'/cpu.max']:'200000 100000',[root+'/class/seat/cpu.max']:'50000 100000',
  [root+'/class/cpuset.cpus.effective']:'0-1',[root+'/class/memory.max']:'1000',[root+'/class/memory.current']:'900',
  [root+'/class/seat/memory.max']:'800',[root+'/class/seat/memory.current']:'200'}});
let r=collect(f.io);
assert.equal(r.cpuQuotaCores,.5); assert.equal(r.cpuSetCores,2); assert.equal(r.cpuEffectiveCores,.5);
assert.equal(r.memoryLimitBytes,800); assert.equal(r.memoryCurrentBytes,200); assert.equal(r.memoryHeadroomBytes,100);
assert.equal(r.memoryOomTotal,2); assert.equal(r.memoryOomKillTotal,1); assert.equal(r.cpuThrottledUsecTotal,123); assert.equal(r.memoryPressure,true);
assert.equal(r.rootAvailableBytes,40960); assert.equal(r.workAvailableBytes,40960);
assert.match(format(r),/누적; 현재 부하 아님/); assert.match(format(r),/디스크 여유가 300 MiB 미만/);
const globalRoot=collect(fixture({edits:{[root+'/cpu.max']:null,[root+'/memory.max']:null,[root+'/class/seat/cpu.max']:'100000 100000',[root+'/class/seat/memory.max']:'1000'}}).io);
assert.equal(globalRoot.cpuQuotaState,'unknown'); assert.equal(globalRoot.cpuEffectiveCores,null); assert.equal(globalRoot.memoryLimitState,'unknown'); assert.equal(globalRoot.memoryLimitBytes,null); assert.equal(globalRoot.memoryHeadroomBytes,null);
const deniedRoot=collect(fixture({denied:[root+'/cpu.max',root+'/memory.max']}).io); assert.equal(deniedRoot.cpuQuotaState,'unknown'); assert.equal(deniedRoot.memoryLimitState,'unknown');
r=collect(fixture().io); assert.equal(r.cpuQuotaState,'unlimited'); assert.equal(r.memoryLimitState,'unlimited'); assert.equal(r.memoryHeadroomBytes,null);
r=collect(fixture({mountRoot:'/class',edits:{[root+'/seat/cpu.max']:'100000 200000',[root+'/seat/cpuset.cpus.effective']:'1',
 [root+'/seat/memory.max']:'500',[root+'/seat/memory.current']:'600'}}).io);
assert.equal(r.cpuEffectiveCores,.5); assert.equal(r.memoryHeadroomBytes,0);
for (const value of ['oops','0 100000','100000 0','100000 -1','100000 10 trailing','9007199254740992 1']) {
  r=collect(fixture({edits:{[root+'/class/seat/cpu.max']:value}}).io); assert.equal(r.cpuQuotaState,'unknown'); assert.equal(r.cpuEffectiveCores,null);
}
for (const value of ['oops','-1','9007199254740992']) {
  r=collect(fixture({edits:{[root+'/class/seat/memory.max']:value}}).io); assert.equal(r.memoryLimitState,'unknown'); assert.equal(r.memoryHeadroomBytes,null);
}
r=collect(fixture({edits:{[root+'/class/seat/cpuset.cpus.effective']:'0-2,2-3'}}).io); assert.equal(r.cpuEffectiveCores,null);
r=collect(fixture({denied:[root+'/class/cpu.max',root+'/class/memory.max']}).io); assert.equal(r.cpuQuotaState,'unknown'); assert.equal(r.memoryLimitState,'unknown');
r=collect(fixture({edits:{'/proc/self/cgroup':'4:memory:/class'}}).io); assert.equal(r.cgroup,'v1-unsupported');
for (const current of ['/class/../escape','relative','/class/./seat','/class/seat;evil','/'+Array(70).fill('a').join('/')]) {
 f=fixture({current}); r=collect(f.io); assert.equal(r.cgroup,'unknown'); assert(f.reads.every(p=>p.startsWith('/proc/')));
}
f=fixture({real:{[root+'/class/seat/cpu.max']:'/etc/passwd'}}); r=collect(f.io); assert.equal(r.cpuQuotaState,'unknown'); assert(!f.reads.includes('/etc/passwd'));
f=fixture({real:{[root]:'/elsewhere'}}); assert.equal(collect(f.io).cgroup,'unknown');
r=collect(fixture({edits:{'/proc/self/mountinfo':'x'.repeat(20000)}}).io); assert.equal(r.cgroup,'unknown');
for (const file of ['lab-status','lab-doctor','lab-resources','README.md','AGENTS.md','CLAUDE.md']) {
 const b=fs.readFileSync(new URL('../lab/files/'+file,import.meta.url)); assert(!b.includes(13),file+' LF'); assert(!b.subarray(0,3).equals(Buffer.from([239,187,191])),file+' no BOM');
}
const snapshotBytes=fs.readFileSync(new URL('../lab/snapshot.ps1',import.meta.url));
assert(snapshotBytes.subarray(0,3).equals(Buffer.from([239,187,191]))); const snapshot=snapshotBytes.toString('utf8');
assert(!snapshot.replaceAll('\r\n','').includes('\n'));
for (const file of ['lab-resources','AGENTS.md','CLAUDE.md']) assert(snapshot.includes(`$(B64 '${file}')`));
assert(snapshot.includes("[string]$Name = 'gw-lab-v4'"));
const status=fs.readFileSync(new URL('../lab/files/lab-status',import.meta.url),'utf8');
assert(status.includes('-lt 30')); assert(status.indexOf('exit 0')<status.lastIndexOf('lab-resources')); assert(status.includes('AI $money · 남은 시간 ${left:-?}'));
const doctor=fs.readFileSync(new URL('../lab/files/lab-doctor',import.meta.url),'utf8'); assert(!doctor.includes('free -m')); assert(doctor.includes('lab-resources'));
const bash='C:/Program Files/Git/bin/bash.exe';
if(fs.existsSync(bash)) {
 for(const file of ['lab-status','lab-doctor']) { const p=spawnSync(bash,['-n',new URL('../lab/files/'+file,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],{encoding:'utf8'}); assert.equal(p.status,0,p.stderr); }
 // Cached --line uses only budget/time, with commands stubbed offline and resource execution prohibited.
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lab-resource-test-'));
 const cached=path.join(temp,'cache.json').replaceAll('\\','/');
 const scriptFile=path.join(temp,'lab-status').replaceAll('\\','/');
 fs.writeFileSync(cached,'{}'); fs.writeFileSync(scriptFile,status.replace('cache=/tmp/lab-status.json',`cache='${cached}'`));
 const script=`set -e\nfunction curl(){ echo 'unexpected network' >&2; return 99; }\nfunction date(){ echo 100; }\nfunction stat(){ echo 90; }\nfunction jq(){ case "$*" in *usage*) echo 1;; *limit*) echo 5;; esac; }\nfunction lab-resources(){ echo 'unexpected resources' >&2; return 99; }\nexport -f curl date stat jq lab-resources\nLAB_ENDS=220 bash '${scriptFile}' --line\n`;
 const p=spawnSync(bash,['-c',script],{encoding:'utf8'}); fs.rmSync(temp,{recursive:true}); assert.equal(p.status,0,p.stderr); assert.equal(p.stdout.trim(),'AI $1.00 / $5 · 남은 시간 2분'); assert.equal(p.stderr,'');
}
console.log('lab resource diagnostics: synthetic cgroup, readonly safety, formats, packaging, cached status-line PASS');
