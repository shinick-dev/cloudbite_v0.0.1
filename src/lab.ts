// 공부방 실습실: Daytona REST 를 fetch 로 직접 부른다 (SDK 없음).
// Daytona 키는 공급자 'daytona' 로 저장된 것을 DO 안에서만 풀어 쓴다 — 샌드박스·참가자에게는 가지 않는다.
//
//   POST   /sandbox                              만들기 (snapshot, env, labels, cpu/memory/disk, autoStop/Delete)
//   GET    /sandbox/<id>                         상태 (started, stopped, archived, creating, …)
//   POST   /sandbox/<id>/start                   멈춘·보관된 것 다시 켜기
//   DELETE /sandbox/<id>                         지우기
//   GET    /sandbox/<id>/ports/<p>/preview-url   {url, token} — 게이트웨이가 x-daytona-preview-token 을 붙여 대신 연다
//   GET    /organizations/<org>/usage             한도·사용량 (vCPU · GiB · 디스크)
//   <toolboxProxyUrl>/<id>/process/...           샌드박스 안 명령 (같은 API 키)
//   <toolboxProxyUrl>/<id>/files/upload?path=    파일 올리기 (multipart, 필드 file)

export interface Dt { api: string; key: string }
export interface Sandbox { id: string; state: string; toolboxProxyUrl?: string; errorReason?: string; organizationId?: string }
export interface Quota { cpu: [number, number]; memory: [number, number]; disk: [number, number] } // [사용 중, 한도]

export const LAB_PORT = 8080; // 스냅샷의 code-server
export const READY = new Set(['started']);
export const WAKING = new Set(['creating', 'starting', 'restoring', 'pulling_snapshot', 'resuming', 'pending_build', 'building_snapshot']);
export const SLEEPING = new Set(['stopped', 'archived', 'paused', 'stopping', 'archiving', 'pausing']);

export class DtError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** signal: 스냅샷 자동 준비만 넘긴다 (호출 기한). 다른 호출은 예전 그대로 기한 없음 */
export async function dt<T>(c: Dt, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(c.api + path, {
    method,
    headers: { authorization: `Bearer ${c.key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = String(j.message ?? j.error ?? msg); } catch {}
    throw new DtError(r.status, `Daytona ${r.status}: ${msg}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** 샌드박스 안에서 명령 실행 (끝날 때까지 기다림) */
export async function exec(c: Dt, sb: Sandbox, command: string, timeout = 20) {
  const base = sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox';
  return dt<{ exitCode: number; result: string }>({ ...c, api: base }, 'POST', `/${sb.id}/process/execute`, { command, timeout });
}

/** 백그라운드로 띄우기 — execute 는 끝나면 자식 프로세스를 정리하므로 세션에서 비동기로 돌린다 */
export async function spawn(c: Dt, sb: Sandbox, sessionId: string, command: string) {
  const base = { ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' };
  try { await dt(base, 'POST', `/${sb.id}/process/session`, { sessionId }); } catch (e) { if (!(e instanceof DtError) || e.status >= 500) throw e; }
  await dt(base, 'POST', `/${sb.id}/process/session/${sessionId}/exec`, { command, runAsync: true });
}

const toolbox = (c: Dt, sb: Sandbox) => ({ ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' });

/** 샌드박스에 파일 하나 올리기 */
export async function upload(c: Dt, sb: Sandbox, path: string, data: ArrayBuffer | Uint8Array) {
  const fd = new FormData();
  fd.append('file', new Blob([data]), path.split('/').pop());
  const r = await fetch(`${toolbox(c, sb).api}/${sb.id}/files/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST', headers: { authorization: `Bearer ${c.key}` }, body: fd,
  });
  if (!r.ok) throw new DtError(r.status, `Daytona upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/** 컨테이너 샌드박스 한도·사용량. 조직 id 는 샌드박스 응답에서 얻는다 */
export async function quota(c: Dt, org: string): Promise<Quota | null> {
  const u = await dt<{ regionUsage?: Array<Record<string, number | string>> }>(c, 'GET', `/organizations/${org}/usage`);
  const r = u.regionUsage?.find((x) => x.sandboxClass === 'container' && Number(x.totalCpuQuota) > 0);
  if (!r) return null;
  const n = (k: string) => Number(r[k]) || 0;
  return {
    cpu: [n('currentCpuUsage'), n('totalCpuQuota')],
    memory: [n('currentMemoryUsage'), n('totalMemoryQuota')],
    disk: [n('currentDiskUsage'), n('totalDiskQuota')],
  };
}

// ── 수업 자료 ──
// 샌드박스(Tier 1·2)는 허용 목록 도메인만 나갈 수 있다. GitHub 는 열려 있어 샌드박스 안에서 clone 하고,
// 그 밖(ZIP 링크, 구글 드라이브 공유 링크)은 게이트웨이가 받아서 올린다.
export const MATERIALS_MAX = 50 * 1024 * 1024;
export const WORK = '/home/daytona/work';
export type Materials = { kind: 'git'; url: string; dir: string } | { kind: 'file'; url: string };

export function materials(raw: string, allowHttp = false): Materials | null {
  if (allowHttp && /^http:\/\/[\w.:-]+\/[\w./-]*$/.test(raw)) return { kind: 'file', url: raw }; // dev 테스트용
  if (!/^https:\/\/[\w.-]+(:\d+)?\/[\w\-./~%+=&?#:@!$,;]*$/.test(raw) || raw.length > 400) return null;
  let g = raw.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (g && !g[2].startsWith('.')) return { kind: 'git', url: `https://github.com/${g[1]}/${g[2]}.git`, dir: g[2] };
  g = raw.match(/^https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([\w-]{10,})/);
  if (g) return { kind: 'file', url: `https://drive.usercontent.google.com/download?id=${g[1]}&export=download&confirm=t` };
  return { kind: 'file', url: raw };
}

/** 자료를 샌드박스 ~/work 에 넣는다. 돌려주는 값은 강사 화면에 보일 한 줄 */
export async function putMaterials(c: Dt, sb: Sandbox, m: Materials, lim: MaterialLimits = LIMITS): Promise<string> {
  if (m.kind === 'git') return putGit(c, sb, m);
  const r = await fetch(m.url, { redirect: 'follow' });
  const buf = await readCapped(r, lim.download);
  let name = materialName(r);
  const zip = buf.subarray(0, 4).join() === '80,75,3,4';
  if (zip && !name.toLowerCase().endsWith('.zip')) name += '.zip';
  if (!zip) {
    await upload(c, sb, `${WORK}/${name}`, buf);
    return name;
  }
  return putZip(c, sb, name, buf, lim);
}

const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

async function putGit(c: Dt, sb: Sandbox, m: Extract<Materials, { kind: 'git' }>): Promise<string> {
  // url·dir 은 materials() 의 정규식을 통과한 [\w.-] 문자만 — 따옴표 안에 그대로 넣어도 된다
  const r = await exec(c, sb, `bash -lc 'cd ${WORK} && rm -rf ${m.dir} && git clone -q --depth 1 ${m.url} ${m.dir} 2>&1 | tail -2'`, 120);
  const ok = await exec(c, sb, `bash -lc 'test -d ${WORK}/${m.dir}/.git && echo ok'`, 10);
  if (!String(ok.result).includes('ok')) throw new Error(`git clone 실패: ${String(r.result).trim().slice(0, 200)}`);
  return `${m.dir}/ (git)`;
}

/** 받은 파일 이름: Content-Disposition → 최종 주소 순. [\w.-] 만 남기고 앞 점을 떼며 80자까지 */
function materialName(r: Response): string {
  const cd = r.headers.get('content-disposition') ?? '';
  let name = (cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? cd.match(/filename="?([^";]+)/i)?.[1] ?? new URL(r.url).pathname.split('/').pop() ?? '');
  try { name = decodeURIComponent(name); } catch {}
  return name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'materials';
}

/** 풀기 실패 이유 한 줄 (연결 끊김 · 시간 초과 · 풀기가 남긴 ERR 줄) */
function extractFailure(u: { exitCode: number; result: string } | null, lost: unknown): string {
  if (!u) return `연결 끊김 (${errText(lost)})`.slice(0, 200);
  return u.exitCode === 124 || u.exitCode === 137 ? '시간 초과' : String(u.result).trim().replace(/^ERR /, '').slice(0, 200);
}

/** 되돌리기 전 기다릴 초: timeout -k 가 풀기 프로세스를 확실히 죽인 뒤(시작 + 초 + 10)까지 */
const killWait = (t0: number, seconds: number) => Math.max(0, Math.ceil((t0 + (seconds + 11) * 1000 - Date.now()) / 1000));

// ZIP 은 ~/work 밖의 한 번 쓰는 폴더에 올려 그 안에서 풀고(한도 검사), 다 풀린 뒤에만 ~/work 로 옮긴다 (기록을 남기며 한 거래로).
// 실패하면 기록대로 ~/work 를 되돌린 뒤 그 폴더를 지운다 — 참가자 파일은 덮였어도 원본으로 돌아온다.
// 되돌리기를 확인하지 못하면 덮인 원본이 그 폴더(out/b)에 있으므로 지우지 않고 남긴다.
async function putZip(c: Dt, sb: Sandbox, name: string, buf: Uint8Array, lim: MaterialLimits): Promise<string> {
  const tmp = `${MATERIALS_TMP}/${crypto.randomUUID()}`;
  const mk = await exec(c, sb, `bash -lc 'umask 077 && mkdir -p ${MATERIALS_TMP} && mkdir ${tmp}'`, 10);
  if (mk.exitCode !== 0) throw new Error(`압축 풀 자리 만들기 실패: ${String(mk.result).trim().slice(0, 200)}`);
  let keep = false;
  try {
    await upload(c, sb, `${tmp}/extract.cjs`, new TextEncoder().encode(EXTRACT_JS));
    await upload(c, sb, `${tmp}/m.zip`, buf);
    const t0 = Date.now();
    let u: { exitCode: number; result: string } | null = null, lost: unknown = null;
    try { u = await exec(c, sb, `bash -lc 'timeout -k 5 ${lim.seconds + 5} node ${tmp}/extract.cjs ${tmp}/m.zip ${tmp}/out ${WORK} ${lim.bytes} ${lim.files} ${lim.seconds} 2>&1'`, 60); }
    catch (e) { lost = e; }
    if (u && u.exitCode === 0) return `${name} (압축 풂)`;
    const why = extractFailure(u, lost);
    // 풀기 프로세스가 스스로 못 되돌렸을 수 있다 (SIGKILL·연결 끊김) → 남은 기록으로 되돌린다.
    // 연결이 끊긴 경우엔 프로세스가 아직 돌고 있을 수 있어 timeout -k 가 확실히 죽인 뒤에 한다
    const wait = lost ? killWait(t0, lim.seconds) : 0;
    keep = true;
    const committed = await rollbackZip(c, sb, tmp, why, wait);
    keep = false;
    if (committed) return `${name} (압축 풂)`; // 다 옮긴 뒤에 끊기거나 죽음
    throw new Error(`압축 풀기 실패: ${why}`);
  } finally {
    if (!keep) try { await exec(c, sb, `bash -lc 'rm -rf ${tmp}'`, 20); } catch {}
  }
}

/** 남은 기록으로 ~/work 를 되돌린다. "OK …" 면 false, "COMMITTED" 면 true. 확인 못 하면 원본 자리를 알리며 던진다 */
async function rollbackZip(c: Dt, sb: Sandbox, tmp: string, why: string, wait: number): Promise<boolean> {
  let rb: { exitCode: number; result: string };
  try { rb = await exec(c, sb, `bash -lc '${wait ? `sleep ${wait} && ` : ''}timeout -k 5 50 node ${tmp}/extract.cjs --rollback ${tmp}/out ${WORK} 2>&1'`, wait + 60); }
  catch (e) { throw new Error(`압축 풀기 실패: ${why} — 되돌리기 확인 못 함 (${errText(e)}), 원본은 ${tmp}/out/b 에 남겨 둠`); }
  const rr = String(rb.result).trim();
  if (rb.exitCode !== 0 || !/^(OK|COMMITTED)/.test(rr)) throw new Error(`압축 풀기 실패: ${why} — 되돌리기도 실패 (${rr.replace(/^ERR /, '').slice(0, 200)}), 원본은 ${tmp}/out/b 에 남겨 둠`);
  return rr.startsWith('COMMITTED');
}

// ── 자료 한도 ──
// 받기: 실제로 흘러온 바이트를 세며 50MiB 에서 끊는다 (Content-Length 는 크면 바로 거절하는 데만 쓰고 믿지 않는다).
// 풀기: 1GiB · 50,000 개 (폴더 포함), 60초 exec 안에서. 적힌 크기·개수와 실제로 풀려 나온 바이트를 둘 다 센다.
export const EXTRACT_MAX_BYTES = 1024 * 1024 * 1024;
export const EXTRACT_MAX_FILES = 50_000;
export const MATERIALS_TMP = '/home/daytona/.gw-materials';
export interface MaterialLimits { download: number; bytes: number; files: number; seconds: number }
export const LIMITS: MaterialLimits = { download: MATERIALS_MAX, bytes: EXTRACT_MAX_BYTES, files: EXTRACT_MAX_FILES, seconds: 45 };

/** 응답 몸통을 max 바이트까지만 받는다. 넘거나·끊기거나·웹 페이지면 읽기를 취소하고 던진다 */
export async function readCapped(r: Response, max = MATERIALS_MAX): Promise<Uint8Array> {
  const tooBig = new Error(`자료가 ${Math.round(max / 1024 / 1024)}MB 를 넘습니다.`);
  const declared = checkResponse(r, max, tooBig);
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooBig;
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e === tooBig) throw e;
    throw new Error(`자료 받기 실패: ${errText(e)}`);
  }
  checkComplete(r, declared, total);
  return joinChunks(chunks, total);
}

/** 몸통을 읽기 전 검사 (실패 응답·웹 페이지·적힌 크기 초과면 읽기를 취소하고 던진다). 적힌 Content-Length 를 돌려준다 */
function checkResponse(r: Response, max: number, tooBig: Error): number | null {
  const drop = () => { r.body?.cancel().catch(() => {}); };
  if (!r.ok) { drop(); throw new Error(`자료 받기 실패: HTTP ${r.status}`); }
  if ((r.headers.get('content-type') ?? '').includes('text/html')) { drop(); throw new Error('자료 주소가 파일이 아니라 웹 페이지입니다 (공유 설정·주소 확인).'); }
  const cl = (r.headers.get('content-length') ?? '').trim();
  const declared = /^\d{1,16}$/.test(cl) ? Number(cl) : null;
  if (declared !== null && declared > max) { drop(); throw tooBig; }
  return declared;
}

/** 받은 바이트 수가 적힌 Content-Length 와 같은지. 압축 전송(Content-Encoding)이면 압축된 크기라 비교하지 않는다 */
function checkComplete(r: Response, declared: number | null, total: number): void {
  const identity = !r.headers.get('content-encoding') || r.headers.get('content-encoding') === 'identity';
  if (identity && declared !== null && total !== declared) throw new Error(`자료를 끝까지 받지 못했습니다 (${total}/${declared} 바이트).`);
}

/** 조각을 한 버퍼로 합친다. 옮긴 조각은 바로 놓아 준다 (최대 메모리 ≈ 받은 크기 + 한 조각) */
function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].byteLength; chunks[i] = out.subarray(0, 0); }
  return out;
}

// 샌드박스에서 `node extract.cjs <zip> <stage> <work> <maxBytes> <maxFiles> <seconds>` 로 돈다 (스냅샷의 node, 표준 모듈만).
// 되돌리기만: `node extract.cjs --rollback <stage> <work>` → "OK …" (되돌림·할 것 없음) 또는 "COMMITTED" (다 옮긴 뒤 죽음).
// 스냅샷을 다시 만들지 않아도 되게 게이트웨이가 매번 올린다. 규칙:
//  - 목차(central directory)의 적힌 개수·크기로 먼저 거절하고, 풀면서 실제 바이트·CRC 를 다시 센다 (적힌 것보다 크면 즉시 중단)
//  - 개수는 만들어질 파일 시스템 항목 전부 — 파일 + 적힌 폴더 + 경로에만 나오는 중간 폴더 (같은 것은 한 번). 한도를 넘으면 아무것도 만들기 전에 거절
//    항목은 (부모 번호, 이름) 으로 한 번만 등록 → 일·메모리 모두 항목 수·경로 길이에 비례 (경로 접두사를 매번 다시 만들지 않는다)
//  - 이름: \ 는 / 로 보고, 절대 경로·드라이브(C:)·.. ·제어 문자는 ZIP 전체 거절. 암호·지원 안 하는 압축 방식도 거절
//  - 심볼릭 링크·장치 같은 특수 파일은 만들지 않고 ZIP 전체 거절 (몰래 빼먹지 않는다). 실행 비트만 살린다 (755/644)
//  - 새 폴더 <stage>/t 에 다 푼 뒤, ~/work 쪽 경로를 모두 먼저 점검 (폴더 자리에 파일·링크가 있으면 거절) → 옮기기는 하나의 거래:
//    할 일을 <stage>/journal 에 먼저 적고(D 폴더 만듦 · B 원본을 <stage>/b 로 치움 · N 새 파일 넣음) 한다. 같은 이름 파일은 덮는다 (unzip -o 와 같음)
//    도중에 오류·시간 초과·SIGTERM 이면 적은 것을 거꾸로 되돌린다 (새 파일 지움 → 원본 제자리 → 만든 폴더 지움). 한 줄 되돌릴 때마다 기록을 잘라
//    다시 돌려도 안전하다. SIGKILL 처럼 손쓸 수 없이 죽으면 게이트웨이가 --rollback 으로 같은 기록을 되돌린다. 다 옮기면 journal → committed
//  - 시간: 풀기는 <seconds> 에서 옮기기 몫(¼, 최대 8초)을 남기고 끝나야 하고, 옮기기도 매 항목 <seconds> 를 확인한다.
//    바깥 timeout 은 <seconds>+5 에 SIGTERM(되돌리고 끝냄), +10 에 SIGKILL
//  - 실패하면 "ERR <이유>" 한 줄 + 종료 코드 3. 성공은 "OK <개수> <바이트>"
export const EXTRACT_JS = String.raw`'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
let undo = null; // ~/work 로 옮기는 중일 때만: 되돌리기
function die(m) {
  if (undo) { const u = undo; undo = null; try { u(); } catch (x) { m += ' (되돌리기 실패: ' + ((x && x.message) || x) + ')'; } }
  try { fs.writeSync(1, 'ERR ' + m + '\n'); } catch (e) {}
  process.exit(3);
}
function lst(f) { try { return fs.lstatSync(f); } catch (x) { if (x.code === 'ENOENT') return null; throw x; } }
function move(a, b) {
  try { fs.renameSync(a, b); } catch (x) {
    if (x.code !== 'EXDEV') throw x;
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), b);
    else { fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL); fs.chmodSync(b, st.mode & 0o777); }
    fs.unlinkSync(a);
  }
}
// 기록을 끝에서부터 되돌린다. 한 줄 되돌릴 때마다 그 줄을 잘라 낸다 (중간에 죽어도 다시 돌리면 이어서). 되돌린 줄 수를 돌려준다
function rollback(stage, work) {
  const jp = path.join(stage, 'journal'), jfd = fs.openSync(jp, 'r+'), buf = fs.readFileSync(jfd), recs = [];
  let s = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, s)) { recs.push([s, buf.toString('utf8', s, i)]); s = i + 1; }
  if (s !== buf.length) fs.ftruncateSync(jfd, s); // 쓰다 만 줄 = 아직 하지 않은 일
  for (let k = recs.length - 1; k >= 0; k--) {
    const off = recs[k][0], line = recs[k][1], op = line[0], sp = op === 'B' ? line.indexOf(' ', 2) : 1;
    const rel = line.slice(sp + 1), parts = rel.split('/');
    if (line[1] !== ' ' || sp < 0 || !rel || parts.some((x) => x === '' || x === '.' || x === '..')) throw new Error('기록 손상: ' + line.slice(0, 80));
    const dst = path.join(work, ...parts);
    if (op === 'N') { const st = lst(dst); if (st && !st.isDirectory()) fs.unlinkSync(dst); } // 넣기 전엔 비어 있던 자리 (원본은 B 로 이미 치움)
    else if (op === 'B') { const b = path.join(stage, 'b', line.slice(2, sp)); if (lst(b) && !lst(dst)) move(b, dst); }
    else if (op === 'D') { try { fs.rmdirSync(dst); } catch (x) { if (x.code !== 'ENOENT' && x.code !== 'ENOTEMPTY' && x.code !== 'EEXIST') throw x; } }
    else throw new Error('기록 손상: ' + line.slice(0, 80));
    fs.ftruncateSync(jfd, off);
  }
  fs.closeSync(jfd);
  fs.unlinkSync(jp);
  return recs.length;
}
if (process.argv[2] === '--rollback') {
  const stage = process.argv[3], work = process.argv[4];
  if (!stage || !work) die('usage');
  try {
    if (lst(path.join(stage, 'journal'))) fs.writeSync(1, 'OK rolled back ' + rollback(stage, work) + '\n');
    else fs.writeSync(1, lst(path.join(stage, 'committed')) ? 'COMMITTED\n' : 'OK nothing\n');
  } catch (x) { die('되돌리기 실패: ' + ((x && x.message) || x)); }
  process.exit(0);
}
const [zipPath, stage, work, maxB, maxF, secs] = process.argv.slice(2);
const MAX_BYTES = Number(maxB), MAX_FILES = Number(maxF), CH = 1 << 20;
if (!zipPath || !stage || !work || !(MAX_BYTES >= 0) || !(MAX_FILES >= 0) || !(Number(secs) >= 0)) die('usage');
const DEADLINE = Date.now() + Number(secs) * 1000, RESERVE = Math.min(8000, Number(secs) * 250);
let limit = DEADLINE - RESERVE; // 풀기는 옮기기 몫을 남기고 끝나야 한다
function tick() { if (Date.now() > limit) die('시간 초과'); }
process.on('SIGTERM', () => die('시간 초과'));
const TB = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TB[n] = c; }
const crc32 = zlib.crc32 || function (b, v) { let c = ~v; for (let i = 0; i < b.length; i++) c = TB[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
const fd = fs.openSync(zipPath, 'r'), SIZE = fs.fstatSync(fd).size;
function rd(pos, len) {
  if (!(pos >= 0 && len >= 0 && pos + len <= SIZE)) die('손상된 ZIP (범위 밖)');
  const b = Buffer.alloc(len);
  for (let o = 0; o < len;) { const n = fs.readSync(fd, b, o, len - o, pos + o); if (!n) die('손상된 ZIP (짧음)'); o += n; }
  return b;
}
function u64(b, o) { const v = b.readBigUInt64LE(o); if (v > BigInt(Number.MAX_SAFE_INTEGER)) die('손상된 ZIP (크기)'); return Number(v); }
const strict = new TextDecoder('utf-8', { fatal: true });
function utf8(b, loose) { try { return strict.decode(b); } catch (e) { if (loose) return b.toString('latin1'); die('파일 이름이 UTF-8 이 아님'); } }

// 목차 끝(EOCD) → 목차
const tl = Math.min(SIZE, 65557), tail = rd(SIZE - tl, tl);
let e = -1;
for (let i = tl - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) <= tl) { e = i; break; }
if (e < 0) die('ZIP 이 아니거나 손상됨');
if (tail.readUInt16LE(e + 4) !== 0 || tail.readUInt16LE(e + 6) !== 0) die('여러 조각으로 나뉜 ZIP 은 지원하지 않음');
let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
  const loc = rd(SIZE - tl + e - 20, 20);
  if (loc.readUInt32LE(0) !== 0x07064b50) die('손상된 ZIP64');
  const z = rd(u64(loc, 8), 56);
  if (z.readUInt32LE(0) !== 0x06064b50) die('손상된 ZIP64');
  count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
}
if (count > MAX_FILES) die('파일이 너무 많음 (' + count + '개, 한도 ' + MAX_FILES + ')');
const cd = rd(cdOff, cdSize);

// 만들어질 항목 표: 번호 0 = ~/work 자신. 부모 번호는 늘 자식보다 작다 (부모가 먼저 등록됨)
const ids = new Map(), kinds = ['d'], parent = [0], rel = [''];
const list = [];
let p = 0, declared = 0, records = 0, entries = 0;
while (p < cd.length) {
  tick();
  if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) die('손상된 ZIP (목차)');
  if (++records > MAX_FILES) die('파일이 너무 많음 (한도 ' + MAX_FILES + ')');
  const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
  let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), lho = cd.readUInt32LE(p + 42);
  const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), attr = cd.readUInt32LE(p + 38);
  const end = p + 46 + nl + xl + cl;
  if (end > cd.length) die('손상된 ZIP (목차)');
  const raw = cd.subarray(p + 46, p + 46 + nl), ex = cd.subarray(p + 46 + nl, p + 46 + nl + xl);
  p = end;
  let uname = null;
  for (let q = 0; q + 4 <= ex.length;) {
    const id = ex.readUInt16LE(q), sz = ex.readUInt16LE(q + 2), d = ex.subarray(q + 4, q + 4 + sz);
    q += 4 + sz;
    if (id === 1) {
      let o = 0;
      const take = () => { if (o + 8 > d.length) die('손상된 ZIP64'); const v = u64(d, o); o += 8; return v; };
      if (usize === 0xffffffff) usize = take();
      if (csize === 0xffffffff) csize = take();
      if (lho === 0xffffffff) lho = take();
    } else if (id === 0x7075 && d.length > 5 && d[0] === 1) uname = d.subarray(5);
  }
  if (flags & 1) die('암호가 걸린 ZIP 은 풀 수 없음');
  const name = flags & 0x800 ? utf8(raw) : uname ? utf8(uname) : utf8(raw, true);
  const n = name.replace(/\\/g, '/');
  if (/[\x00-\x1f\x7f]/.test(n)) die('파일 이름에 제어 문자');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) die('절대 경로: ' + name);
  const parts = n.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) die('상위 폴더(..)로 나가는 경로: ' + name);
  if (n.length > 1024 || parts.length > 64 || parts.some((s) => Buffer.byteLength(s) > 255)) die('경로가 너무 김: ' + name.slice(0, 80));
  const unix = madeBy >> 8 === 3, ft = unix ? (attr >>> 16) & 0o170000 : 0;
  if (ft === 0o120000) die('심볼릭 링크는 풀지 않음: ' + name);
  if (ft && ft !== 0o040000 && ft !== 0o100000) die('특수 파일은 풀지 않음: ' + name);
  const dir = n.endsWith('/') || ft === 0o040000 || (!unix && (attr & 0x10) !== 0);
  if (!parts.length) { if (dir) continue; die('빈 파일 이름'); }
  if (dir && usize) die('손상된 ZIP (폴더에 내용): ' + name);
  if (!dir && method !== 0 && method !== 8) die('지원하지 않는 압축 방식 ' + method + ': ' + name);
  if (!dir && method === 0 && csize !== usize) die('손상된 ZIP (크기): ' + name);
  declared += usize;
  if (declared > MAX_BYTES) die('풀면 너무 큼 (적힌 크기 ' + declared + ' 바이트 이상, 한도 ' + MAX_BYTES + ')');
  let pid = 0;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1, k = pid + '/' + parts[i];
    let id = ids.get(k);
    if (id === undefined) {
      id = kinds.length;
      if (id > MAX_FILES) die('파일이 너무 많음 (폴더 포함 ' + id + '개 이상, 한도 ' + MAX_FILES + ')');
      ids.set(k, id); kinds.push(last && !dir ? 'f' : 'd'); parent.push(pid); rel.push(pid ? rel[pid] + '/' + parts[i] : parts[i]);
    } else if (!last) { if (kinds[id] === 'f') die('파일과 폴더 이름이 겹침: ' + rel[id]); }
    else if (!dir || kinds[id] === 'f') die('같은 이름이 두 번: ' + rel[id]);
    pid = id;
  }
  entries++;
  if (!dir) list.push({ name, id: pid, method, csize, usize, crc, lho, exec: unix && ((attr >>> 16) & 0o111) !== 0 });
}
if (records !== count) die('손상된 ZIP (목차의 파일 수가 적힌 것과 다름)');
ids.clear();

function inflate(start, len, put) {
  return new Promise((res, rej) => {
    const z = zlib.createInflateRaw({ chunkSize: 1 << 16 });
    z.on('data', put);
    z.on('error', (x) => rej(new Error('압축 자료 손상: ' + x.message)));
    z.on('end', res);
    let q = 0;
    const pump = () => {
      while (q < len) {
        const b = rd(start + q, Math.min(CH, len - q));
        q += b.length;
        if (!z.write(b)) { z.once('drain', pump); return; }
      }
      z.end();
    };
    pump();
  });
}

let total = 0; // 실제로 풀려 나온 바이트 (모든 파일 합)

// 한 파일을 <stage>/t 안에 푼다: 실제 바이트·CRC 를 세고 적힌 크기를 넘으면 즉시 중단
async function extractFile(T, it) {
  tick();
  const dst = path.join(T, rel[it.id]);
  const h = rd(it.lho, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) die('손상된 ZIP (파일 머리): ' + it.name);
  const start = it.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  if (start + it.csize > cdOff) die('손상된 ZIP (자료 범위): ' + it.name);
  const out = fs.openSync(dst, 'wx', 0o600);
  let got = 0, c = 0;
  const put = (b) => {
    got += b.length; total += b.length;
    if (got > it.usize) die('실제 크기가 적힌 것보다 큼: ' + it.name);
    if (total > MAX_BYTES) die('풀면 너무 큼 (한도 ' + MAX_BYTES + ' 바이트)');
    tick();
    c = crc32(b, c);
    for (let o = 0; o < b.length;) o += fs.writeSync(out, b, o, b.length - o);
  };
  if (it.method === 0) for (let q = 0; q < it.csize; q += CH) put(rd(start + q, Math.min(CH, it.csize - q)));
  else await inflate(start, it.csize, put);
  fs.closeSync(out);
  if (got !== it.usize) die('크기가 적힌 것과 다름: ' + it.name);
  if (c !== it.crc) die('CRC 불일치: ' + it.name);
  fs.chmodSync(dst, it.exec ? 0o755 : 0o644);
}

// ~/work 쪽 점검을 먼저 전부 — 겹치면 하나도 옮기지 않는다. 부모가 먼저 오므로 링크인 폴더 자리는 그 아래를 보기 전에 걸린다.
// 돌려주는 had[id] = ~/work 에 이미 있는 항목
function checkWork() {
  const w = lst(work);
  if (!w || !w.isDirectory()) die('작업 폴더가 없음');
  const had = new Uint8Array(kinds.length);
  had[0] = 1;
  for (let id = 1; id < kinds.length; id++) {
    tick();
    if (!had[parent[id]]) continue; // 부모가 없으면 그 아래도 없다
    const st = lst(path.join(work, rel[id]));
    if (!st) continue;
    if (kinds[id] === 'd' && !st.isDirectory()) die('기존 작업과 겹침 (폴더 자리에 파일·링크): ' + rel[id]);
    if (kinds[id] === 'f' && !st.isFile() && !st.isSymbolicLink()) die('기존 작업과 겹침 (파일 자리에 폴더): ' + rel[id]);
    had[id] = 1;
  }
  return had;
}

// 옮기기 (거래): 하기 전에 적고, 실패하면 적은 만큼 되돌린다
function commit(T, had) {
  const BK = path.join(stage, 'b'), JP = path.join(stage, 'journal');
  limit = DEADLINE;
  fs.mkdirSync(BK);
  const jfd = fs.openSync(JP, 'wx', 0o600);
  undo = () => { fs.closeSync(jfd); rollback(stage, work); };
  const log = (s) => { const b = Buffer.from(s + '\n'); for (let o = 0; o < b.length;) o += fs.writeSync(jfd, b, o, b.length - o); };
  for (let id = 1; id < kinds.length; id++) {
    tick();
    const dst = path.join(work, rel[id]);
    if (kinds[id] === 'd') {
      if (!had[id]) { log('D ' + rel[id]); fs.mkdirSync(dst, 0o755); }
      else if (!fs.lstatSync(dst).isDirectory()) throw new Error('기존 작업과 겹침: ' + rel[id]);
      continue;
    }
    if (had[id]) { log('B ' + id + ' ' + rel[id]); move(dst, path.join(BK, String(id))); }
    log('N ' + rel[id]);
    move(path.join(T, rel[id]), dst);
  }
  undo = null;
  fs.closeSync(jfd);
  fs.renameSync(JP, path.join(stage, 'committed'));
}

async function main() {
  const T = path.join(stage, 't');
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.mkdirSync(T);
  for (let id = 1; id < kinds.length; id++) if (kinds[id] === 'd') { tick(); fs.mkdirSync(path.join(T, rel[id])); }
  for (const it of list) await extractFile(T, it);
  commit(T, checkWork());
  fs.writeSync(1, 'OK ' + entries + ' ' + total + '\n');
}
main().catch((x) => die(String((x && x.message) || x)));
`;

/** 샌드박스 파일 내려받기 (스트림 그대로). signal 로 중간에 끊을 수 있다 */
export async function download(c: Dt, sb: Sandbox, path: string, signal?: AbortSignal) {
  const r = await fetch(`${toolbox(c, sb).api}/${sb.id}/files/download?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${c.key}` }, signal });
  if (!r.ok || !r.body) throw new DtError(r.status, `Daytona download ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// ── 내 작업 받기 (#11) ──
// 자리마다 한 번에 하나, 시작 사이 60초. 묶는 곳은 ~/.gw-export/<uuid> (매번 새로, 0700) — ~/work 밖.
// 묶기는 EXPORT_JS 가 샌드박스 안에서: 링크·특수 파일은 따라가지도 넣지도 않고(건너뜀), 실제로 읽은 바이트 1GiB · 항목(파일+폴더) 50,000 개에서 중단.
// 받은 뒤·실패·취소·만료·재시작 모두 그 폴더를 한 번 지운다 (state.ts 의 exp: 기록).
export const EXPORT_MAX_BYTES = 1024 * 1024 * 1024;
export const EXPORT_MAX_ENTRIES = 50_000;
export const EXPORT_SECONDS = 240;
export const EXPORT_ROOT = '/home/daytona/.gw-export';
export const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface ExportLimits { bytes: number; entries: number; seconds: number }
export const EXPORT_LIMITS: ExportLimits = { bytes: EXPORT_MAX_BYTES, entries: EXPORT_MAX_ENTRIES, seconds: EXPORT_SECONDS };
/** 내려받기 바이트 상한: 읽은 바이트 한도 + deflate 가 못 줄인 블록 덧(1/1024) + zip 머리·data descriptor·중앙 목록(항목마다 1KiB).
 *  묶기가 알린 zip 크기가 이보다 크면 표를 주지 않고, 받을 때는 이 값과 알린 크기 중 작은 것까지만 넘긴다 */
export const exportZipMax = (lim: ExportLimits) => lim.bytes + Math.ceil(lim.bytes / 1024) + lim.entries * 1024;
export const exportStage = (id: string) => {
  if (!EXPORT_ID.test(id)) throw new Error('bad export id');
  return `${EXPORT_ROOT}/${id}`;
};

/** ~/work 를 묶어 <stage>/work.zip 으로. 돌려주는 값: 항목 수·읽은 바이트·건너뜀·zip 크기 */
export async function packWork(c: Dt, sb: Sandbox, id: string, lim: ExportLimits = EXPORT_LIMITS, perform?: <T>(effect: () => Promise<T>) => Promise<T>) {
  const stage = exportStage(id);
  const run = perform ?? (<T>(effect: () => Promise<T>) => effect());
  const mk = await run(() => exec(c, sb, `bash -lc 'umask 077 && mkdir -p ${EXPORT_ROOT} && test -d ${EXPORT_ROOT} && test ! -L ${EXPORT_ROOT} && chmod 700 ${EXPORT_ROOT} && mkdir -m 700 ${stage}'`, 10));
  if (mk.exitCode !== 0) throw new Error(`묶을 자리 만들기 실패: ${String(mk.result).trim().slice(0, 200)}`);
  await run(() => upload(c, sb, `${stage}/export.cjs`, new TextEncoder().encode(EXPORT_JS)));
  const r = await run(() => exec(c, sb, `bash -lc 'timeout -k 5 ${lim.seconds + 5} node ${stage}/export.cjs ${WORK} ${stage}/work.zip ${lim.bytes} ${lim.entries} ${lim.seconds} 2>&1'`, lim.seconds + 20));
  const out = String(r.result).trim();
  const m = out.match(/^OK (\d+) (\d+) (\d+) (\d+)$/m);
  if (r.exitCode !== 0 || !m) {
    const why = r.exitCode === 124 || r.exitCode === 137 ? '시간 초과' : out.replace(/^ERR /, '').slice(0, 200) || `종료 코드 ${r.exitCode}`;
    throw new Error(`묶기 실패: ${why}`);
  }
  return { entries: Number(m[1]), bytes: Number(m[2]), skipped: Number(m[3]), size: Number(m[4]), path: `${stage}/work.zip` };
}

/** 묶은 자리 지우기. id 는 uuid 만 */
export async function removeStage(c: Dt, sb: Sandbox, id: string) {
  const r = await exec(c, sb, `bash -lc 'rm -rf -- ${exportStage(id)}'`, 30);
  if (r.exitCode !== 0) throw new Error(`정리 실패: ${String(r.result).trim().slice(0, 200)}`);
}

// 샌드박스에서 `node export.cjs <work> <out.zip> <maxBytes> <maxEntries> <seconds>` (표준 모듈만).
//  - 따라가지 않기: 리눅스에서는 열어 둔 폴더 fd 를 /proc/self/fd/<n> 로 기준 삼아 그 안의 이름만 O_NOFOLLOW 로 연다 (중간 폴더가
//    링크로 바뀌어도 밖으로 못 나감). 연 뒤 fstat 이 lstat 과 같은 일반 파일·폴더인지 다시 본다. 링크·FIFO·장치·소켓은 건너뛴다
//  - 이름은 readdir 결과만 쓰므로 .. 이 없다. 제어 문자·\ 가 든 이름은 건너뛴다. node_modules·.venv·__pycache__ 도 건너뛴다
//  - 한도: 만든 항목(파일+폴더) 수, 실제로 읽은 바이트 (stat 크기를 믿지 않는다). 넘으면 zip 을 지우고 "ERR …" + 종료 코드 3
//  - zip: UTF-8 이름, 파일은 deflate + data descriptor (한 번 읽기). 1GiB·50,000 개라 ZIP64 가 필요 없다
//  - 성공: "OK <항목> <읽은 바이트> <건너뜀> <zip 크기>"
export const EXPORT_JS = String.raw`'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [work, out, maxB, maxE, secs] = process.argv.slice(2);
const MAX_BYTES = Number(maxB), MAX_ENTRIES = Number(maxE), DEADLINE = Date.now() + Number(secs) * 1000, CH = 1 << 20;
let ofd = null, made = false;
function die(m) {
  try { fs.writeSync(1, 'ERR ' + m + '\n'); } catch (e) {}
  try { if (ofd !== null) fs.closeSync(ofd); } catch (e) {}
  try { if (made) fs.unlinkSync(out); } catch (e) {} // 만든 것만 지운다 (이미 있던 파일은 건드리지 않음)
  process.exit(3);
}
if (!work || !out || !(MAX_BYTES >= 0) || !(MAX_ENTRIES >= 0) || !(Number(secs) > 0)) die('usage');
process.on('SIGTERM', () => die('시간 초과'));
function tick() { if (Date.now() > DEADLINE) die('시간 초과'); }
const K = fs.constants, NOFOLLOW = K.O_NOFOLLOW, NB = K.O_NONBLOCK || 0;
const PROC = NOFOLLOW !== undefined && K.O_DIRECTORY !== undefined && fs.existsSync('/proc/self/fd');
const SKIP = new Set(['node_modules', '.venv', '__pycache__']);
const TB = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TB[n] = c; }
const crc32 = zlib.crc32 || function (b, v) { let c = ~v; for (let i = 0; i < b.length; i++) c = TB[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
let entries = 0, bytes = 0, skipped = 0, off = 0;
const central = [];
function put(b) { for (let o = 0; o < b.length;) o += fs.writeSync(ofd, b, o, b.length - o); off += b.length; }
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
function header(name, flags, method, crc, csize, usize, dir) {
  const n = Buffer.from(name, 'utf8'), lh = Buffer.alloc(30), at = off;
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(n.length, 26);
  put(lh); put(n);
  return { n, at, flags, method, dir };
}
function finishEntry(h, crc, csize, usize, mode) {
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(h.flags, 8); ch.writeUInt16LE(h.method, 10);
  ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(h.n.length, 28);
  ch.writeUInt32LE(((mode << 16) | (h.dir ? 0x10 : 0)) >>> 0, 38); ch.writeUInt32LE(h.at, 42);
  central.push(ch, h.n);
}
function count() { if (++entries > MAX_ENTRIES) die('항목이 너무 많음 (한도 ' + MAX_ENTRIES + '개)'); }
function addDir(rel) {
  count();
  const h = header('work/' + rel + '/', 0x800, 0, 0, 0, 0, true);
  finishEntry(h, 0, 0, 0, 0o040755);
}
function addFile(rel, fd, exec) {
  return new Promise((res, rej) => {
    const h = header('work/' + rel, 0x808, 8, 0, 0, 0, false);
    const z = zlib.createDeflateRaw({ level: 6, chunkSize: 1 << 16 });
    let crc = 0, usize = 0, csize = 0;
    z.on('data', (b) => { csize += b.length; put(b); });
    z.on('error', rej);
    z.on('end', () => {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      put(dd);
      finishEntry(h, crc >>> 0, csize, usize, exec ? 0o100755 : 0o100644);
      res();
    });
    const buf = Buffer.alloc(CH);
    const pump = () => {
      try {
        for (;;) {
          tick();
          const n = fs.readSync(fd, buf, 0, CH, null);
          if (!n) { z.end(); return; }
          usize += n; bytes += n;
          if (bytes > MAX_BYTES) die('너무 큼 (읽은 바이트가 한도 ' + MAX_BYTES + ' 를 넘음)');
          const b = Buffer.from(buf.subarray(0, n));
          crc = crc32(b, crc);
          if (!z.write(b)) { z.once('drain', pump); return; }
        }
      } catch (x) { rej(x); }
    };
    pump();
  });
}
const bad = (name) => /[\x00-\x1f\x7f\\]/.test(name);
function openNoFollow(p, dir) {
  if (PROC) return fs.openSync(p, K.O_RDONLY | NOFOLLOW | NB | (dir ? K.O_DIRECTORY : 0));
  return fs.openSync(p, 'r');
}
// base = 이 폴더를 가리키는 경로 (리눅스: /proc/self/fd/<n>), rel = zip 안 이름
async function walk(base, rel) {
  let names;
  try { names = fs.readdirSync(base).sort(); } catch (x) { die('폴더를 읽지 못함: ' + (rel || 'work')); }
  for (const name of names) {
    tick();
    const r = rel ? rel + '/' + name : name;
    if (bad(name) || SKIP.has(name)) { skipped++; continue; }
    const p = path.join(base, name);
    let st;
    try { st = fs.lstatSync(p); } catch (x) { skipped++; continue; } // 그 사이 사라짐
    if (!st.isDirectory() && !st.isFile()) { skipped++; continue; } // 링크·FIFO·장치·소켓
    let fd;
    try { fd = openNoFollow(p, st.isDirectory()); } catch (x) { skipped++; continue; } // 그 사이 링크로 바뀜 (ELOOP) 등
    try {
      const fst = fs.fstatSync(fd);
      if (!same(st, fst) || st.isDirectory() !== fst.isDirectory() || (!fst.isDirectory() && !fst.isFile())) { skipped++; continue; }
      if (fst.isDirectory()) {
        if (r.split('/').length > 64) die('폴더가 너무 깊음: ' + r.slice(0, 80));
        addDir(r);
        await walk(PROC ? '/proc/self/fd/' + fd : p, r);
      } else {
        count();
        await addFile(r, fd, (fst.mode & 0o111) !== 0);
      }
    } finally { fs.closeSync(fd); }
  }
}
async function main() {
  const root = fs.lstatSync(work);
  if (!root.isDirectory()) die('작업 폴더가 없음');
  ofd = fs.openSync(out, 'wx', 0o600);
  made = true;
  const rfd = openNoFollow(work, true);
  if (!same(root, fs.fstatSync(rfd))) die('작업 폴더가 바뀜');
  count();
  finishEntry(header('work/', 0x800, 0, 0, 0, 0, true), 0, 0, 0, 0o040755);
  await walk(PROC ? '/proc/self/fd/' + rfd : work, '');
  fs.closeSync(rfd);
  const cdAt = off, cd = Buffer.concat(central);
  put(cd);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(entries, 8); eo.writeUInt16LE(entries, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(cdAt, 16);
  put(eo);
  fs.closeSync(ofd); ofd = null;
  fs.writeSync(1, 'OK ' + entries + ' ' + bytes + ' ' + skipped + ' ' + off + '\n');
}
main().catch((x) => die(String((x && x.message) || x)));
`;
