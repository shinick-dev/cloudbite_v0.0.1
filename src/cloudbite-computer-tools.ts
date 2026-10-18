// CloudBite personal computer: image contract and tool catalogue (images/cloudbite-computer/**).
// Leaf module with no imports. The catalogue is metadata only: it never claims a tool is installed or signed in.
// "installed" comes only from the fixed in-sandbox probe (`--version`, throwaway HOME, no auth check);
// sign-in happens in each tool's own official flow inside the desktop, and no credential is in the image.

export const COMPUTER_IMAGE = Object.freeze({
  base: 'daytonaio/sandbox:0.9.0',
  resources: Object.freeze({ cpu: 4, memoryGiB: 8, diskGiB: 10 }),
  user: 'daytona',
  port: 8082,
  subfolder: '/p/_cloudbite/computer/desktop',
  healthPath: '/p/_cloudbite/computer/desktop/api/health',
  selkies: Object.freeze({ version: '2.0.0', wheelSha256: 'f2777e74d191e2b5063190d40bfc6df00d7a77930620e0048a79267f211cbead', encoder: 'cpu_software_h264', transport: 'websocket' }),
  node: '22.20.0',
  paths: Object.freeze({
    start: '/opt/cloudbite/computer/bin/cloudbite-start-desktop',
    probe: '/opt/cloudbite/computer/bin/cloudbite-probe-tools',
    manifest: '/opt/cloudbite/computer/manifest.json',
    browserProfile: '/home/daytona/.config/cloudbite-browser',
  }),
});

/** Fixed commands the control plane runs as `daytona` after computer_use.start(); last stdout line is JSON. */
export const COMPUTER_START_COMMAND = COMPUTER_IMAGE.paths.start;
export const COMPUTER_PROBE_COMMAND = COMPUTER_IMAGE.paths.probe;

/** Fixed failure codes of the start script (`{"ok":false,"code":...}`). */
export const COMPUTER_START_CODES = Object.freeze([
  'computer_start_as_root', 'computer_no_display', 'computer_dbus_dir_untrusted', 'computer_dbus_start_failed',
  'computer_first_run_failed', 'computer_selkies_install_timeout', 'computer_selkies_install_failed',
  'computer_selkies_exited', 'computer_selkies_health_timeout',
] as const);

export type ComputerToolKind = 'native_cli' | 'web' | 'api_broker';
export type ComputerToolAuth = 'native_oauth_or_key' | 'web_login' | 'broker_key';

export interface ComputerTool {
  readonly id: string;
  readonly label: string;
  readonly kind: ComputerToolKind;
  readonly auth: ComputerToolAuth;
  readonly url: string;
  /** native_cli: executable on PATH inside the desktop. */
  readonly command?: string;
  /** native_cli: exact version pinned at image build. */
  readonly version?: string;
  readonly note: string;
}

const BROKER = 'https://k.shinick.dev/borrow';

export const COMPUTER_TOOLS: readonly ComputerTool[] = Object.freeze(([
  { id: 'claude-code', label: 'Claude Code', kind: 'native_cli', auth: 'native_oauth_or_key', command: 'claude', version: '2.1.302', url: 'https://code.claude.com/docs', note: 'npm @anthropic-ai/claude-code; run `claude` in the desktop terminal and sign in with your Claude account or API key.' },
  { id: 'codex', label: 'Codex', kind: 'native_cli', auth: 'native_oauth_or_key', command: 'codex', version: '0.163.0', url: 'https://developers.openai.com/codex/cli', note: 'npm @openai/codex; `codex login` signs in with ChatGPT in the desktop browser, or use an API key.' },
  { id: 'cursor-agent', label: 'Cursor Agent', kind: 'native_cli', auth: 'native_oauth_or_key', command: 'cursor-agent', version: '2026.10.16-e3cb207', url: 'https://cursor.com/docs/cli/overview', note: 'Official Cursor Agent package; `cursor-agent login` opens the desktop browser.' },
  { id: 'antigravity', label: 'Antigravity CLI', kind: 'native_cli', auth: 'native_oauth_or_key', command: 'agy', version: '1.4.2', url: 'https://antigravity.google/docs/cli', note: 'Official agy Linux build; sign in with Google on first run in the desktop.' },
  { id: 'opencode', label: 'OpenCode', kind: 'native_cli', auth: 'native_oauth_or_key', command: 'opencode', version: '1.19.3', url: 'https://opencode.ai/docs', note: 'npm opencode-ai; `opencode auth login` for providers such as OpenRouter.' },
  { id: 'grok', label: 'Grok', kind: 'web', auth: 'web_login', url: 'https://grok.com/', note: 'Web app in the desktop browser.' },
  { id: 'genspark', label: 'Genspark', kind: 'web', auth: 'web_login', url: 'https://www.genspark.ai/', note: 'Web app in the desktop browser; no API integration is claimed.' },
  { id: 'lovable', label: 'Lovable', kind: 'web', auth: 'web_login', url: 'https://lovable.dev/', note: 'Web app in the desktop browser.' },
  { id: 'chatgpt', label: 'ChatGPT', kind: 'web', auth: 'web_login', url: 'https://chatgpt.com/', note: 'Web app in the desktop browser.' },
  { id: 'claude-web', label: 'Claude', kind: 'web', auth: 'web_login', url: 'https://claude.ai/', note: 'Web app in the desktop browser.' },
  { id: 'antigravity-web', label: 'Google Antigravity', kind: 'web', auth: 'web_login', url: 'https://antigravity.google/', note: 'Product site; the desktop app is not installed, the agy CLI is.' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'web', auth: 'web_login', url: 'https://openrouter.ai/', note: 'Web console; OpenCode can use an OpenRouter key.' },
  { id: 'daytona', label: 'Daytona', kind: 'web', auth: 'web_login', url: 'https://app.daytona.io/', note: 'Web console; nested compute is a separate root-owned module.' },
  { id: 'nosana', label: 'Nosana', kind: 'web', auth: 'web_login', url: 'https://dashboard.nosana.com/', note: 'Web dashboard; nested compute is a separate root-owned module.' },
  { id: 'k-broker', label: 'k broker', kind: 'web', auth: 'web_login', url: BROKER, note: 'Opens the existing broker on this phone or in the desktop browser.' },
  { id: 'tavily', label: 'Tavily', kind: 'api_broker', auth: 'broker_key', url: 'https://app.tavily.com/', note: 'API key from the existing k broker; never stored in the image.' },
  { id: 'elevenlabs', label: 'ElevenLabs', kind: 'api_broker', auth: 'broker_key', url: 'https://elevenlabs.io/', note: 'API key from the existing k broker; never stored in the image.' },
  { id: 'nebius', label: 'Nebius Token Factory', kind: 'api_broker', auth: 'broker_key', url: 'https://tokenfactory.nebius.com/', note: 'API key from the existing k broker; never stored in the image.' },
  { id: 'openrouter-api', label: 'OpenRouter API', kind: 'api_broker', auth: 'broker_key', url: BROKER, note: 'API key from the existing k broker; never stored in the image.' },
  { id: 'openai-api', label: 'OpenAI API', kind: 'api_broker', auth: 'broker_key', url: BROKER, note: 'API key from the existing k broker; never stored in the image.' },
] as ComputerTool[]).map(t => Object.freeze(t)));

/** Web launchers the image places on the desktop (same set as WEB_APPS in images/cloudbite-computer/install.py). */
export const COMPUTER_DESKTOP_WEB_IDS = Object.freeze(['grok', 'genspark', 'lovable', 'chatgpt', 'claude-web', 'antigravity-web', 'openrouter', 'tavily', 'elevenlabs', 'nebius', 'daytona', 'nosana', 'k-broker']);

/** Ids the probe reports beyond the catalogue's native tools. */
const PROBE_EXTRA = new Set(['chromium', 'node']);
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

export interface ComputerProbeTool { readonly id: string; readonly installed: boolean; readonly version: string | null }
export interface ComputerProbe { readonly tools: readonly ComputerProbeTool[] }

/** Parse the probe's last stdout line; anything unexpected yields null (never a guessed status). */
export function parseComputerProbe(stdout: string): ComputerProbe | null {
  const line = String(stdout ?? '').trim().split('\n').pop()?.trim() ?? '';
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) return null;
  const raw = (value as { tools?: unknown }).tools;
  if (!Array.isArray(raw) || raw.length > 32) return null;
  const known = new Set(COMPUTER_TOOLS.filter(t => t.kind === 'native_cli').map(t => t.id));
  const tools: ComputerProbeTool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return null;
    const { id, installed, version } = t as Record<string, unknown>;
    if (typeof id !== 'string' || !(known.has(id) || PROBE_EXTRA.has(id)) || typeof installed !== 'boolean') return null;
    if (version !== null && (typeof version !== 'string' || !VERSION_RE.test(version))) return null;
    if (installed !== (version !== null)) return null;
    tools.push(Object.freeze({ id, installed, version: version as string | null }));
  }
  return Object.freeze({ tools: Object.freeze(tools) });
}

export type ComputerToolStatus = 'installed' | 'not_installed' | 'unprobed' | 'web' | 'api_broker';
export interface ComputerToolRow {
  readonly id: string; readonly label: string; readonly kind: ComputerToolKind; readonly auth: ComputerToolAuth;
  readonly url: string; readonly command: string | null; readonly pinned: string | null;
  readonly status: ComputerToolStatus; readonly version: string | null; readonly note: string;
}

/** Catalogue rows for GET /api/cloudbite/computer/state; native status only from a parsed probe. */
export function computerToolCatalog(probe: ComputerProbe | null): ComputerToolRow[] {
  const seen = new Map((probe?.tools ?? []).map(t => [t.id, t] as const));
  return COMPUTER_TOOLS.map(t => {
    const p = seen.get(t.id);
    const status: ComputerToolStatus = t.kind === 'web' ? 'web' : t.kind === 'api_broker' ? 'api_broker'
      : !probe || !p ? 'unprobed' : p.installed ? 'installed' : 'not_installed';
    return Object.freeze({ id: t.id, label: t.label, kind: t.kind, auth: t.auth, url: t.url, command: t.command ?? null,
      pinned: t.version ?? null, status, version: status === 'installed' ? p!.version : null, note: t.note });
  });
}
