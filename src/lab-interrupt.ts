import { TERM_SESSION } from './lab-terminal-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
export interface TeachingPaneProof { fingerprint: string; paneId: string; program: string }
const nodeCommand = (source: string) => `node -e 'eval(Buffer.from("${btoa(String.fromCharCode(...new TextEncoder().encode(source)))}","base64").toString("utf8"))'`;

// Read only one exact teaching pane. The server process start time prevents a
// restarted tmux server from reusing an old numeric pane identity.
const inspectSource = () => String.raw`
const fs=require('node:fs'),path=require('node:path'),{execFileSync:exec}=require('node:child_process'),{createHash}=require('node:crypto');
function inspect(){
 const raw=exec('/usr/bin/tmux',['display-message','-p','-t',${JSON.stringify('=' + TERM_SESSION + ':0.0')},'#{pid}\t#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8',maxBuffer:4096}).trimEnd().split('\t');
 if(raw.length!==5||!/^\d+$/.test(raw[0])||!/^\$\d+$/.test(raw[1])||!/^%\d+$/.test(raw[2])||!/^\d+$/.test(raw[3])||!raw[4]||raw[4].length>128)throw Error('unavailable');
 const stat=fs.readFileSync('/proc/'+raw[0]+'/stat','utf8');
 const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];if(!/^\d+$/.test(start))throw Error('unavailable');
 const foreground=exec('/usr/bin/ps',['-o','tpgid=','-p',raw[3]],{encoding:'utf8',maxBuffer:256}).trim();
 if(!/^[1-9]\d*$/.test(foreground))throw Error('unavailable');
 const fgStat=fs.readFileSync('/proc/'+foreground+'/stat','utf8');
 const fgStart=fgStat.slice(fgStat.lastIndexOf(')')+2).split(' ')[19];if(!/^\d+$/.test(fgStart))throw Error('unavailable');
 const fingerprint=createHash('sha256').update(JSON.stringify([raw[0],start,...raw.slice(1),foreground,fgStart])).digest('hex');
 return{fingerprint,paneId:raw[2],program:raw[4].replace(/[^\p{L}\p{N}_.-]/gu,'?').slice(0,80)};
}
`;

export function teachingPaneProbeCommand(): string {
  return nodeCommand(inspectSource() + `try{process.stdout.write(JSON.stringify(inspect()))}catch{process.stdout.write('UNAVAILABLE');process.exitCode=1}`);
}

export function parseTeachingPane(value: unknown): TeachingPaneProof | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const p = JSON.parse(value) as TeachingPaneProof;
    return p && typeof p.fingerprint === 'string' && HEX.test(p.fingerprint) && typeof p.paneId === 'string' && /^%\d+$/.test(p.paneId)
      && typeof p.program === 'string' && p.program.length > 0 && p.program.length <= 80 && !/[\x00-\x1f\x7f]/.test(p.program)
      ? { fingerprint: p.fingerprint, paneId: p.paneId, program: p.program } : null;
  } catch { return null; }
}

/** A constant Ctrl+C, never arbitrary input, and never sandbox stop or deletion. */
export function teachingPaneInterruptCommand(sessionId: string, requestId: string, proof: TeachingPaneProof): string {
  if (!UUID.test(sessionId) || !UUID.test(requestId) || !HEX.test(proof.fingerprint) || !/^%\d+$/.test(proof.paneId)) throw Error('invalid interruption target');
  return nodeCommand(inspectSource() + `try{
 const expected=${JSON.stringify({ fingerprint: proof.fingerprint, paneId: proof.paneId })};
 const root=path.join(require('node:os').homedir(),'.gw-lesson');fs.mkdirSync(root,{recursive:true,mode:448});
 const info=fs.lstatSync(root);if(info.isSymbolicLink()||!info.isDirectory())throw Error('unavailable');
 const marker=path.join(root,${JSON.stringify('interrupt-' + sessionId + '-' + requestId)});
 if(fs.existsSync(marker)){process.stdout.write('DUPLICATE');process.exit(0)}
 const before=inspect();if(before.fingerprint!==expected.fingerprint||before.paneId!==expected.paneId){process.stdout.write('CHANGED');process.exit(0)}
 try{fs.mkdirSync(marker,{mode:448})}catch(e){if(e.code==='EEXIST'){process.stdout.write('DUPLICATE');process.exit(0)}throw e}
 const current=inspect();if(current.fingerprint!==expected.fingerprint||current.paneId!==expected.paneId){process.stdout.write('CHANGED');process.exit(0)}
 exec('/usr/bin/tmux',['send-keys','-t',current.paneId,'C-c'],{stdio:'ignore'});process.stdout.write('SENT');
}catch{process.stdout.write('UNAVAILABLE');process.exitCode=1}`);
}
