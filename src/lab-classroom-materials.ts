import { readCapped, type Dt, type Sandbox } from './lab';

/** Explicit participant action: create missing teaching text files, never replace existing work. */
export async function applyClassroomMaterials(c: Dt, sb: Sandbox, materials: { name: string; content: string }[], gate: () => Promise<boolean>): Promise<{ files: { name: string; state: 'added' | 'exists' }[] }> {
  if (!Array.isArray(materials) || materials.length > 4 || materials.some(m => typeof m.name !== 'string' || !m.name || m.name.length > 40 || m.name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f]/.test(m.name) || typeof m.content !== 'string' || m.content.includes('\0') || new TextEncoder().encode(m.content).length > 8000)) throw Error('invalid materials');
  const data = btoa(Array.from(new TextEncoder().encode(JSON.stringify(materials)), n => String.fromCharCode(n)).join(''));
  const code = "const fs=require('node:fs'),path=require('node:path');const materials=JSON.parse(Buffer.from('" + data + "','base64').toString('utf8'));const expected='/home/daytona/work',root=fs.realpathSync(expected);if(root!==expected)throw Error('work directory changed');const files=[];for(const m of materials){if(!m.name||path.basename(m.name)!==m.name||m.name.startsWith('.'))throw Error('invalid name');const target=path.join(root,m.name);try{fs.writeFileSync(target,m.content,{encoding:'utf8',flag:'wx',mode:0o600});files.push({name:m.name,state:'added'})}catch(e){if(e.code!=='EEXIST')throw e;files.push({name:m.name,state:'exists'})}}process.stdout.write(JSON.stringify({files}));";
  const command = "node -e '" + code.replace(/'/g, "'\\''") + "'";
  if (!await gate()) throw Error('seat changed');
  const res = await fetch((sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox') + '/' + encodeURIComponent(sb.id) + '/process/execute', {
    method: 'POST', headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' }, body: JSON.stringify({ command, timeout: 10 }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { await res.body?.cancel(); throw Error('materials result unknown'); }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readCapped(res, 16384))) as { exitCode?: number; result?: unknown };
  if (value.exitCode !== 0 || typeof value.result !== 'string') throw Error('materials result unknown');
  const result = JSON.parse(value.result) as { files: { name: string; state: 'added' | 'exists' }[] };
  if (!Array.isArray(result.files) || result.files.length !== materials.length || result.files.some((f, i) => f.name !== materials[i].name || !['added', 'exists'].includes(f.state))) throw Error('invalid materials result');
  if (!await gate()) throw Error('seat changed');
  return result;
}
