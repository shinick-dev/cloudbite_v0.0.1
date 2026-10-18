// Offline emergency rehearsals. All provider/participant state is synthetic.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=new Set(process.argv.slice(2));
for(const arg of args)if(arg!=='--full'){console.error('Usage: node tools/test-classroom-emergency.mjs [--full]');process.exit(2)}
const scripts=['test/lab-seat-recovery-service.mjs','test/lab-seat-recovery-state.mjs','test/lab-seat-recovery-api.mjs','test/lab-seat-recovery-ui.mjs','test/lab-seat-recovery-workerd.mjs','test/lab-emergency-drill.mjs','test/lab-terminal-service.mjs'];
if(args.has('--full'))scripts.push('test/lab-control-state.mjs','test/lab-terminal-state.mjs','test/lab-trial-state.mjs','test/lab-interrupt-state.mjs','test/lab-checkpoint-state.mjs','test/lab-file-preservation.mjs','test/lab-renderer-parity.mjs','test/lab-teacher-monitor.mjs');
let passed=0;
for(const script of scripts){
 const result=spawnSync(process.execPath,[script],{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
 const output=((result.stdout??'')+(result.stderr??'')).trim();
 if(result.status!==0||result.error){console.error('FAIL',script, result.error?.message??'');console.error(output.slice(-6000));process.exit(1)}
 const summary=output.split(/\r?\n/).filter(s=>/PASS|passed|passed,/.test(s)).slice(-1)[0]??'completed';
 console.log('PASS',script,'—',summary);passed++;
}
console.log('PASS classroom emergency rehearsal:',passed,'scripts; synthetic state only');
