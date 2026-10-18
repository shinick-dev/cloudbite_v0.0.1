import { WORK, readCapped, type Dt, type Sandbox } from './lab';

export async function demoSandbox(c: Dt, id: string): Promise<Sandbox> {
  const r = await fetch(c.api + '/sandbox/' + encodeURIComponent(id), { headers: { authorization: 'Bearer ' + c.key }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { await r.body?.cancel(); throw Error('demo sandbox unavailable'); }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readCapped(r, 32768)));
  if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id || !('state' in value) || value.state !== 'started') throw Error('demo sandbox not ready');
  if ('toolboxProxyUrl' in value && typeof value.toolboxProxyUrl !== 'string') throw Error('invalid toolbox');
  const sb = value as Sandbox;
  if (sb.toolboxProxyUrl && !/^https:\/\//.test(sb.toolboxProxyUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(sb.toolboxProxyUrl)) throw Error('invalid toolbox origin');
  return sb;
}

/** A bounded actual command response; an interrupted read means outcome unknown, never a retry. */
export async function demoCommand(c: Dt, sb: Sandbox, command: string, gate: () => Promise<boolean>) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    if (!await gate()) throw Error('demo authority expired');
    const shell = 'cd ' + WORK + ' && ' + command;
    const quoted = "'" + shell.replace(/'/g, "'\\''") + "'";
    const base = sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox';
    const res = await fetch(base + '/' + encodeURIComponent(sb.id) + '/process/execute', {
      method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'bash -lc ' + quoted, timeout: 20 }), signal: ctrl.signal,
    });
    if (!res.ok) { await res.body?.cancel(); throw Error('demo execution response unavailable'); }
    const bytes = await readCapped(res, 128 * 1024);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== 'object' || !('result' in value) || typeof value.result !== 'string' || !('exitCode' in value) || !Number.isInteger(value.exitCode)) throw Error('invalid demo response');
    if (!await gate()) throw Error('demo authority expired');
    return value.result.slice(0, 11800) + '\n종료 코드: ' + value.exitCode;
  } finally { clearTimeout(timer); }
}

export interface DemoFile { filename: string; content: string; hash: string; exists: boolean }
/** Fixed work-directory text files only. Never follows a file symlink, never writes an arbitrary path. */
export async function demoFile(c: Dt, sb: Sandbox, filename: string, save: { content: string; expectedHash: string } | null, gate: () => Promise<boolean>): Promise<DemoFile> {
  if (!['결과.txt', '01_요청메모.txt', '02_진행메모.txt'].includes(filename)) throw Error('invalid demo filename');
  if (save && new TextEncoder().encode(save.content).length > 65536) throw Error('file too large');
  const input = btoa(Array.from(new TextEncoder().encode(JSON.stringify({ filename, save })), b => String.fromCharCode(b)).join(''));
  // All source below is fixed. User text is base64 data, never shell/source interpolation.
  const source = "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const input=JSON.parse(Buffer.from('" + input + "','base64').toString('utf8'));const dir=fs.realpathSync('/home/daytona/work');const p=path.join(dir,input.filename);const digest=x=>crypto.createHash('sha256').update(x).digest('hex');let content='',hash='missing',exists=false;try{const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>65536)throw Error('invalid file');const b=fs.readFileSync(fd);content=new TextDecoder('utf-8',{fatal:true}).decode(b);if(content.includes('\\0'))throw Error('binary file');hash=digest(b);exists=true}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')throw e}if(input.save){if(input.save.expectedHash!==hash)throw Error('file changed; read it again');if(input.save.content.includes('\\0'))throw Error('binary file');const b=Buffer.from(input.save.content,'utf8');if(b.length>65536)throw Error('file too large');const tmp=path.join(dir,'.gw-demo-'+crypto.randomUUID());try{fs.writeFileSync(tmp,b,{flag:'wx',mode:0o600});fs.renameSync(tmp,p)}finally{try{fs.unlinkSync(tmp)}catch{}}content=input.save.content;hash=digest(b);exists=true}process.stdout.write(JSON.stringify({filename:input.filename,content,hash,exists}));";
  const command = "node -e '" + source.replace(/'/g, "'\\''") + "'";
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (!await gate()) throw Error('demo authority expired');
    const res = await fetch((sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox') + '/' + encodeURIComponent(sb.id) + '/process/execute', {
      method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' }, body: JSON.stringify({ command, timeout: 10 }), signal: ctrl.signal,
    });
    if (!res.ok) { await res.body?.cancel(); throw Error('file response unavailable'); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readCapped(res, 512 * 1024))) as { exitCode?: number; result?: unknown };
    if (value.exitCode !== 0 || typeof value.result !== 'string') throw Error('file operation failed; read file again');
    const file = JSON.parse(value.result) as DemoFile;
    if (file.filename !== filename || typeof file.content !== 'string' || new TextEncoder().encode(file.content).length > 65536 || typeof file.hash !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(file.hash) || typeof file.exists !== 'boolean') throw Error('invalid file response');
    if (!await gate()) throw Error('demo authority expired');
    return file;
  } finally { clearTimeout(timer); }
}
