import {spawnSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scripts=['test/lab-assistant-service.mjs','test/lab-assistant-boundaries.mjs','test/lab-assistant-repair.mjs','test/lab-assistant-api.mjs','test/lab-assistant-ui.mjs','test/lab-assistant-workerd.mjs'];
let passed=0;
for(const script of scripts){
 const result=spawnSync(process.execPath,[script],{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
 const output=((result.stdout??'')+(result.stderr??'')).trim();
 if(result.status!==0||result.error){console.error('FAIL',script,result.error?.message??'');console.error(output.slice(-5000));process.exit(1)}
 console.log('PASS',script,'—',output.split(/\r?\n/).filter(s=>/PASS/.test(s)).at(-1)??'completed');passed++;
}
console.log('PASS scoped classroom assistants:',passed,'scripts; synthetic fixtures only');
