import type { Lab } from './state';
import { TERM_SESSION, type TerminalSession } from './lab-terminal-service';

/** Compare trial and participant configuration; omit names, counts, expiry and credentials. */
export function trialConfigText(lab: Lab): string {
  return JSON.stringify({ snapshot: lab.snapshot, model: lab.model, cpu: lab.cpu, memory: lab.memory, disk: lab.disk,
    gw: lab.gw, materials: lab.materials ?? '', clip: lab.clip ?? { in: true, out: true },
    share: Object.entries(lab.share ?? {}).sort(([a],[b]) => a.localeCompare(b)).map(([id,v]) => [id,!!v.on,v.cap]),
  });
}

/** Pin actual seat/sandbox/session identity rather than display names. */
export function trialTargetText(lab: Lab, session: TerminalSession): string {
  return JSON.stringify({ sessionId: session.sessionId, refs: session.refs.map(ref => {
    const seat = lab.seats.find(s => s.n === ref.n);
    return [ref.n, ref.code, ref.sandboxId, seat?.code ?? null, seat?.sandboxId ?? null, !!seat?.error, seat?.setup?.state ?? null];
  }).sort((a,b) => Number(a[0]) - Number(b[0])) });
}

export function terminalCaptureCommand(): string {
  const script = `const {execFileSync}=require('node:child_process');try{const out=execFileSync('tmux',['capture-pane','-p','-S','-100','-t',${JSON.stringify("=" + TERM_SESSION + ":0.0")}],{encoding:'utf8',maxBuffer:32768});process.stdout.write(out.slice(-8192));}catch{process.stdout.write('Trial output unavailable');process.exitCode=1;}`;
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(script)));
  return `node -e 'eval(Buffer.from("${encoded}","base64").toString("utf8"))'`;
}

/** Mask a few known credential formats; output is never persisted or audited. */
export function clipTrialOutput(value: unknown): string {
  return String(value ?? '').slice(-8192)
    .replace(/\bkvt_[A-Za-z0-9_-]+/g, '[token hidden]')
    .replace(/\bsk-or-[A-Za-z0-9_-]+/g, '[key hidden]')
    .replace(/((?:OPENROUTER_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)\s*[=:]\s*)[^\s]+/g, '$1[hidden]');
}
