// CloudBite computer image contract and tool catalogue (src/cloudbite-computer-tools.ts, images/cloudbite-computer/**).
// Structural checks only: no image build, sandbox, network or provider call. Installed status is never asserted here.
//   node test/cloudbite-computer-tools.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const out = await build({ stdin: { contents: "export * from './src/cloudbite-computer-tools.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { COMPUTER_IMAGE, COMPUTER_TOOLS, COMPUTER_DESKTOP_WEB_IDS, COMPUTER_START_COMMAND, COMPUTER_PROBE_COMMAND, parseComputerProbe, computerToolCatalog } = m;
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
const dir = 'images/cloudbite-computer/';
const files = Object.fromEntries(['Dockerfile', 'install.py', 'start-desktop.py', 'probe-tools.py', 'first-run.sh', 'install_selkies.py'].map(f => [f, readFileSync(dir + f, 'utf8')]));

// Catalogue: frozen, unique, known HTTPS hosts, every requested service present, natives pinned.
ok(Object.isFrozen(COMPUTER_TOOLS) && COMPUTER_TOOLS.every(Object.isFrozen), 'catalogue is frozen');
ok(new Set(COMPUTER_TOOLS.map(t => t.id)).size === COMPUTER_TOOLS.length, 'ids unique');
const hosts = new Set(['code.claude.com', 'developers.openai.com', 'cursor.com', 'antigravity.google', 'opencode.ai', 'grok.com', 'www.genspark.ai', 'lovable.dev', 'chatgpt.com', 'claude.ai', 'openrouter.ai', 'app.daytona.io', 'dashboard.nosana.com', 'k.shinick.dev', 'app.tavily.com', 'elevenlabs.io', 'tokenfactory.nebius.com']);
for (const t of COMPUTER_TOOLS) {
  const u = new URL(t.url);
  ok(u.protocol === 'https:' && hosts.has(u.hostname) && !u.search && !u.hash && !u.username, `${t.id} link is a known plain HTTPS URL`);
  ok(!/recv/i.test(t.url), `${t.id} never links the broker receive path`);
  ok(t.note.length > 0 && t.note.length <= 200, `${t.id} note bounded`);
  if (t.kind === 'native_cli') ok(/^[a-z][a-z-]*$/.test(t.command) && /^[0-9][0-9A-Za-z.+-]*$/.test(t.version), `${t.id} pinned command`);
  else ok(t.command === undefined && t.version === undefined, `${t.id} claims no binary`);
}
for (const id of ['claude-code', 'codex', 'cursor-agent', 'antigravity', 'opencode', 'grok', 'genspark', 'lovable', 'tavily', 'elevenlabs', 'nebius', 'openrouter-api', 'openai-api', 'k-broker', 'daytona', 'nosana'])
  ok(COMPUTER_TOOLS.some(t => t.id === id), `catalogue lists ${id}`);
const serialized = JSON.stringify(COMPUTER_TOOLS) + Object.values(files).join('\n');
for (const re of [/sk-[A-Za-z0-9_-]{16,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{12,}/, /api[_-]?key\s*[=:]\s*['"][^'"]{8,}/i])
  ok(!re.test(serialized), `no secret-shaped value ${re}`);

// Probe parsing: exact shape or null; catalogue never upgrades status without a probe.
ok(parseComputerProbe('noise\n{"ok":true,"tools":[{"id":"codex","installed":true,"version":"0.163.0"},{"id":"agy","installed":false,"version":null}]}') === null, 'unknown probe id rejected');
const probe = parseComputerProbe('log\n{"ok":true,"tools":[{"id":"codex","installed":true,"version":"0.163.0"},{"id":"antigravity","installed":false,"version":null},{"id":"chromium","installed":true,"version":"141.0.7390.65"}]}');
ok(probe && probe.tools.length === 3, 'valid probe parsed');
for (const bad of ['', 'not json', '{"ok":false}', '{"ok":true,"tools":[{"id":"codex","installed":true,"version":null}]}', '{"ok":true,"tools":[{"id":"codex","installed":false,"version":"1.0"}]}', '{"ok":true,"tools":[{"id":"codex","installed":true,"version":"1.0; rm -rf /"}]}'])
  ok(parseComputerProbe(bad) === null, `rejects ${bad || 'empty'}`);
const rows = computerToolCatalog(probe);
const row = id => rows.find(r => r.id === id);
ok(row('codex').status === 'installed' && row('codex').version === '0.163.0', 'probed install shown with version');
ok(row('antigravity').status === 'not_installed' && row('antigravity').version === null, 'probed absence shown');
ok(row('claude-code').status === 'unprobed', 'missing from probe stays unprobed');
ok(computerToolCatalog(null).filter(r => r.kind === 'native_cli').every(r => r.status === 'unprobed' && r.version === null), 'no probe, no installed claim');
ok(row('lovable').status === 'web' && row('tavily').status === 'api_broker', 'web and broker kinds distinguished');

// Image files agree with the TS contract.
ok(files['start-desktop.py'].includes(`PREFIX = "${COMPUTER_IMAGE.subfolder}"`) && files['start-desktop.py'].includes(`PORT = ${COMPUTER_IMAGE.port}`), 'start script subfolder/port match');
ok(COMPUTER_IMAGE.healthPath === COMPUTER_IMAGE.subfolder + '/api/health', 'health under subfolder');
ok(files['install_selkies.py'].includes(COMPUTER_IMAGE.selkies.wheelSha256) && files['install_selkies.py'].includes('"pixelflux==2.1.0", "pcmflux==2.1.0"'), 'selkies wheel pinned');
for (const k of ['"SELKIES_ENABLE_BASIC_AUTH": "false"', '"SELKIES_ENCODER": "h264enc"', '"SELKIES_USE_CPU": "true"', '"SELKIES_MODE": "websockets"'])
  ok(files['start-desktop.py'].includes(k), `selkies setting ${k}`);
ok(files['install.py'].includes('"start-desktop.py", "cloudbite-start-desktop"') && COMPUTER_START_COMMAND.endsWith('/cloudbite-start-desktop'), 'start command installed at contract path');
ok(files['install.py'].includes('"probe-tools.py", "cloudbite-probe-tools"') && COMPUTER_PROBE_COMMAND.endsWith('/cloudbite-probe-tools'), 'probe command installed at contract path');
ok(files.Dockerfile.includes('ARG BASE_IMAGE=' + COMPUTER_IMAGE.base) && /USER daytona\s*$/.test(files.Dockerfile), 'base image and final user');
ok(files['install.py'].includes(`"version": "${COMPUTER_IMAGE.node}"`) && Number(COMPUTER_IMAGE.node.split('.')[0]) >= 20, 'Node >= 20 pinned');
const webApps = [...files['install.py'].matchAll(/\("([a-z-]+)", "[^"]+", "(https:\/\/[^"]+)"\)/g)].map(x => [x[1], x[2]]);
assert.deepEqual(webApps.map(x => x[0]), [...COMPUTER_DESKTOP_WEB_IDS]); checks++;
for (const [id, url] of webApps) ok(COMPUTER_TOOLS.find(t => t.id === id)?.url === url, `${id} launcher URL matches catalogue`);
for (const t of COMPUTER_TOOLS.filter(t => t.kind === 'native_cli')) {
  ok(files['install.py'].includes(t.version), `${t.id} version pinned in installer`);
  ok(files['probe-tools.py'].includes(`("${t.id}", "${t.command}")`), `${t.id} probed by command`);
}
ok(/"sha256": "[0-9a-f]{64}"/.test(files['install.py']) && /[0-9a-f]{64}"\)/.test(files['install.py']), 'downloads carry digests');
const required = files['install.py'].match(/^REQUIRED_TOOLS = \(([^)]*)\)/m);
assert.deepEqual(required && [...required[1].matchAll(/"([a-z-]+)"/g)].map(x => x[1]).sort(), COMPUTER_TOOLS.filter(t => t.kind === 'native_cli').map(t => t.id).sort()); checks++;
ok(files['install.py'].includes('"computer_required_tools_missing"') && files['install.py'].includes('sys.exit(1)'), 'missing required CLI fails the build');
ok(/USER_AGENT = "[a-z0-9-]+\/\d+"/.test(files['install.py']) && files['install.py'].includes('"User-Agent": USER_AGENT'), 'downloads send a fixed non-default User-Agent');
ok(files['install.py'].includes('"../lib/node_modules/npm/bin/" + script') && files['install.py'].includes('die("computer_npm_verify_failed")'), 'npm links pinned and verified');
ok(!/safe_members|\.\." in m\.linkname/.test(files['install.py']), 'relative in-tree symlinks are not rejected wholesale');

// Launch bounds: no remote code piped to a shell, no unsafe Chromium flag, no root runtime, bounded steps.
const all = Object.values(files).join('\n');
ok(!/(curl|wget)[^\n|]*\|\s*(ba|z)?sh/.test(all), 'no curl|sh');
ok(!/--no-sandbox/.test(all.replace(/No --no-sandbox[^\n]*/g, '')), 'Chromium keeps its sandbox');
ok(files['start-desktop.py'].includes('if os.geteuid() == 0:') && files['first-run.sh'].includes('"$(id -u)" -ne 0'), 'runtime refuses root');
ok(!/os\.environ\[|getenv\(/.test(files['start-desktop.py'] + files['probe-tools.py']), 'no individual env secret reads');
ok(/HOME": home/.test(files['probe-tools.py']) && files['probe-tools.py'].includes('"--version"'), 'probe uses throwaway HOME and --version only');
for (const f of ['install.py', 'start-desktop.py', 'probe-tools.py']) ok(/timeout=/.test(files[f]), `${f} bounds subprocesses`);
ok(!/[\r]/.test(all), 'LF line endings for Linux image files');

const py = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0);
if (py) for (const f of ['install.py', 'start-desktop.py', 'probe-tools.py', 'install_selkies.py']) {
  const r = spawnSync(py, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())', dir + f]);
  ok(r.status === 0, `${f} parses`);
}
if (py) {
  const r = spawnSync(py, ['-I', '-B', 'test/cloudbite-computer-install.py'], { encoding: 'utf8' });
  ok(r.status === 0, `install.py unit checks pass\n${r.stderr}`);
}
console.log(`cloudbite-computer-tools: ${checks} checks passed`);
