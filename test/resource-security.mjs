// 수업 자료 받기·풀기 한도 (#9 받기 50MiB 스트림 · #15 풀기 1GiB/50,000개·경로·링크)
// wrangler·Daytona 없이 돈다: src/lab.ts 를 esbuild 로 옮겨 실제 readCapped·putMaterials·EXTRACT_JS 를 부른다.
// fetch 는 가짜 (자료 서버 + Daytona toolbox), exec 는 명령 모양을 확인하고 이 PC 의 node 로 EXTRACT_JS 를 실제로 돌린다.
//   node test/resource-security.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import { transform } from 'esbuild';

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rsec-'));
const src = fs.readFileSync(path.join(here, '..', 'src', 'lab.ts'), 'utf8');
fs.writeFileSync(path.join(TMP, 'lab.mjs'), (await transform(src, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
const lab = await import(pathToFileURL(path.join(TMP, 'lab.mjs')).href);
const { readCapped, putMaterials, materials, EXTRACT_JS, MATERIALS_MAX, LIMITS, MATERIALS_TMP, WORK } = lab;
const XJS = path.join(TMP, 'extract.cjs');
fs.writeFileSync(XJS, EXTRACT_JS);

// ── ZIP 만들기 (거짓 크기·링크·특수 파일도 만들 수 있게 직접 쓴다) ──
function zip(entries, { eocdCount } = {}) {
  const local = [], central = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? (e.dir ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32(data);
    const usize = e.usize ?? data.length;
    const flags = e.flags ?? 0x800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46);
    const mode = e.mode ?? (e.dir ? 0o040755 : 0o100644);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.madeBy ?? 0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const n = eocdCount ?? entries.length;
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(n, 8); eo.writeUInt16LE(n, 10);
  eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, eo]);
}

const MiB = 1024 * 1024;
const small = { download: 4 * MiB, bytes: 1 * MiB, files: 50, seconds: 20 };
let caseN = 0;
function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n), r = rel ? `${rel}/${n}` : n, st = fs.lstatSync(f);
      if (st.isSymbolicLink()) out[r + '@'] = fs.readlinkSync(f);
      else if (st.isDirectory()) { out[r + '/'] = ''; walk(f, r); }
      else out[r] = fs.readFileSync(f).toString('base64');
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return JSON.stringify(out);
}
// 고장 넣기 (node -r): ~/work 로 옮기는 rename 을 가로챈다. GW_FAULT =
//   fail          zz-late.txt 를 넣는 rename 이 EACCES (앞의 것들은 이미 옮겨진 뒤)
//   fail-restore  위 + 되돌리기의 원본 복귀 rename 도 EIO (프로세스 안 되돌리기 실패 → --rollback 으로 다시)
//   kill          zz-late.txt 를 넣기 직전에 SIGKILL (손쓸 수 없는 종료)
//   time          첫 파일을 옮긴 뒤 시계를 먼 미래로 (옮기는 중 시간 초과)
//   kill-commit   다 옮기고 committed 표시 뒤, OK 를 쓰기 직전에 SIGKILL
// 옮긴 파일은 GW_LOG 에 한 줄씩 적는다 (실패 전에 실제로 옮겨진 것이 있었는지 확인)
const FAULT = path.join(TMP, 'fault.cjs');
fs.writeFileSync(FAULT, `const fs = require('fs'), path = require('path');
const mode = process.env.GW_FAULT, work = path.resolve(process.env.GW_WORK), stage = path.resolve(process.env.GW_STAGE), log = process.env.GW_LOG;
const under = (p, d) => path.resolve(String(p)).startsWith(d + path.sep);
const boom = (code) => { const e = new Error(code + ': injected'); e.code = code; return e; };
const ren = fs.renameSync;
fs.renameSync = function (a, b) {
  const intoWork = under(b, work), fromT = under(a, path.join(stage, 't')), fromB = under(a, path.join(stage, 'b'));
  if (intoWork && fromT && path.basename(String(b)) === 'zz-late.txt') {
    if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
    if (mode === 'fail' || mode === 'fail-restore') throw boom('EACCES');
  }
  if (mode === 'fail-restore' && intoWork && fromB) throw boom('EIO');
  const r = ren.apply(this, arguments);
  if (intoWork && fromT) { fs.appendFileSync(log, String(b) + '\\n'); if (mode === 'time') Date.now = () => 8.64e15; }
  return r;
};
if (mode === 'kill-commit') { const w = fs.writeSync; fs.writeSync = function (f, s) { if (f === 1 && typeof s === 'string' && s.startsWith('OK ')) process.kill(process.pid, 'SIGKILL'); return w.apply(this, arguments); }; }
`);
const faultArgs = (fault, work, stage, log) => fault
  ? { pre: ['-r', FAULT], env: { ...process.env, GW_FAULT: fault, GW_WORK: work, GW_STAGE: stage, GW_LOG: log } }
  : { pre: [], env: process.env };
const moved = (log) => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;

/** EXTRACT_JS 를 직접 돌린다. root/{m.zip, stage, work, outside} */
function runX(buf, lim = small, prep, fault) {
  const root = path.join(TMP, `x${++caseN}`);
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(work, 'keep.txt'), 'participant');
  prep?.(work, root);
  const before = tree(work);
  fs.writeFileSync(path.join(root, 'm.zip'), buf);
  const stage = path.join(root, 'stage'), log = path.join(TMP, `log${caseN}.txt`), f = faultArgs(fault, work, stage, log);
  const r = spawnSync(process.execPath, [...f.pre, XJS, path.join(root, 'm.zip'), stage, work, String(lim.bytes), String(lim.files), String(lim.seconds)], { encoding: 'utf8', timeout: 60000, env: f.env });
  return { code: r.status, signal: r.signal, out: (r.stdout + r.stderr).trim(), root, work, before, after: tree(work), stage, moved: moved(log), escaped: tree(path.join(root, 'outside')) !== '{}' || fs.readdirSync(root).some((n) => !['m.zip', 'stage', 'work', 'outside'].includes(n)) };
}
/** --rollback 만 돌린다 (게이트웨이가 하는 회복) */
function rollbackX(stage, work) {
  const r = spawnSync(process.execPath, [XJS, '--rollback', stage, work], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}
function stageBytes(stage) {
  let n = 0;
  const walk = (d) => { for (const x of fs.readdirSync(d)) { const f = path.join(d, x), st = fs.lstatSync(f); st.isDirectory() ? walk(f) : (n += st.size); } };
  if (fs.existsSync(stage)) walk(stage);
  return n;
}

console.log('\n# 풀기 (EXTRACT_JS 실제 실행)');
{
  const sh = '#!/bin/bash\necho "안녕"\n';
  const r = runX(zip([
    { name: '과제/', dir: true },
    { name: '과제/한글 폴더/설명.md', data: '# 설명\n줄 끝 LF\n' },
    { name: 'scripts/run.sh', data: sh, mode: 0o100755 },
    { name: 'empty/', dir: true },
    { name: 'stored.bin', data: Buffer.from([0, 1, 2, 255]), method: 0 },
    { name: 'win\\sub\\a.txt', data: 'backslash', flags: 0 },
    { name: 'over.txt', data: 'from archive' },
  ]), small, (w) => fs.writeFileSync(path.join(w, 'over.txt'), 'old'));
  const w = r.work;
  check('정상 ZIP: 종료 0, OK 한 줄', r.code === 0 && /^OK 7 \d+$/.test(r.out), r.out);
  check('한글 이름·중첩 폴더 그대로', fs.readFileSync(path.join(w, '과제', '한글 폴더', '설명.md'), 'utf8') === '# 설명\n줄 끝 LF\n');
  check('셸 스크립트 바이트 그대로 (LF, CR 없음)', fs.readFileSync(path.join(w, 'scripts', 'run.sh'), 'utf8') === sh);
  if (process.platform !== 'win32') check('실행 비트 유지 (755)', (fs.statSync(path.join(w, 'scripts', 'run.sh')).mode & 0o777) === 0o755);
  else console.log('  skip 실행 비트 확인 (Windows 에서는 모드 비트 없음)');
  check('빈 폴더·저장(stored) 방식·\\ 구분자', fs.statSync(path.join(w, 'empty')).isDirectory() && fs.readFileSync(path.join(w, 'stored.bin')).equals(Buffer.from([0, 1, 2, 255])) && fs.readFileSync(path.join(w, 'win', 'sub', 'a.txt'), 'utf8') === 'backslash');
  check('같은 이름은 덮음 (unzip -o 호환) · 참가자 파일 유지', fs.readFileSync(path.join(w, 'over.txt'), 'utf8') === 'from archive' && fs.readFileSync(path.join(w, 'keep.txt'), 'utf8') === 'participant');
  check('밖으로 새지 않음', !r.escaped);
}
{
  const r = runX(zip([{ name: 'a.txt', data: 'x' }, { name: 'bomb.bin', data: Buffer.alloc(5 * MiB) }]));
  check('ZIP 폭탄 (적힌 크기 5MiB > 한도 1MiB): 쓰기 전에 거절', r.code === 3 && r.out.includes('풀면 너무 큼') && !fs.existsSync(r.stage) && r.after === r.before, r.out);
}
{
  const r = runX(zip([{ name: 'bomb.bin', data: Buffer.alloc(5 * MiB), usize: 100 }]));
  const n = stageBytes(r.stage);
  check('ZIP 폭탄 (크기를 100 으로 속임, 실제 5MiB): 실제 바이트로 중단', r.code === 3 && r.out.includes('실제 크기가 적힌 것보다 큼') && r.after === r.before, r.out);
  check(`  → 중간 폴더에 쓴 양 ≤ 적힌 크기 + 64KiB (${n})`, n <= 100 + 64 * 1024);
}
{
  const lie = [];
  for (let i = 0; i < 20; i++) lie.push({ name: `f${i}.bin`, data: Buffer.alloc(256 * 1024), usize: 1000 });
  const r = runX(zip(lie));
  check('여러 파일이 모두 크기를 속임: 첫 파일에서 중단, ~/work 그대로', r.code === 3 && r.after === r.before && stageBytes(r.stage) <= 1000 + 64 * 1024, r.out);
}
{
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `d/f${i}.txt`, data: String(i) }));
  const r = runX(zip(many));
  check('파일 60개 > 한도 50: 거절', r.code === 3 && r.out.includes('파일이 너무 많음') && !fs.existsSync(r.stage), r.out);
  const r2 = runX(zip(many, { eocdCount: 1 }));
  check('EOCD 가 1개라고 속여도 목차를 세어 거절', r2.code === 3 && r2.out.includes('파일이 너무 많음') && !fs.existsSync(r2.stage), r2.out);
  const r3 = runX(zip(many.slice(0, 10), { eocdCount: 3 }));
  check('EOCD 개수와 목차 개수가 다르면 거절', r3.code === 3 && r3.out.includes('손상된 ZIP') && r3.after === r3.before, r3.out);
  const r4 = runX(zip(many.slice(0, 49)));
  check('정확히 50개 (d/ 폴더 1 + 파일 49) 는 통과 (경계)', r4.code === 0 && r4.out.startsWith('OK 49 '), r4.out);
  const r5 = runX(zip(many.slice(0, 50)));
  check('51개 (d/ 폴더 1 + 파일 50): 중간 폴더까지 세어 거절', r5.code === 3 && r5.out.includes('폴더 포함') && !fs.existsSync(r5.stage) && r5.after === r5.before, r5.out);
}

console.log('\n# 중간 폴더도 개수에 (F1)');
{
  // 파일 10개, 각자 다른 63단 폴더 → 폴더 630 + 파일 10 = 640 항목 (목차에는 10개뿐)
  const deep = Array.from({ length: 10 }, (_, i) => ({ name: `u${i}/${'a/'.repeat(62)}f.txt`, data: String(i) }));
  const r = runX(zip(deep));
  check('파일 10개 · 63단 고유 경로 (640 항목) > 한도 50: 아무것도 만들기 전에 거절', r.code === 3 && r.out.includes('폴더 포함') && !fs.existsSync(r.stage) && r.after === r.before, r.out);
  const r2 = runX(zip(deep), { ...small, files: 639 });
  check('  → 한도 639: 거절 (640 째 항목에서)', r2.code === 3 && r2.out.includes('폴더 포함 640개') && !fs.existsSync(r2.stage), r2.out);
  const r3 = runX(zip(deep), { ...small, files: 640 });
  check('  → 한도 640: 통과 (정확히 센다), 깊은 파일 그대로', r3.code === 0 && r3.out.startsWith('OK 10 ') && fs.readFileSync(path.join(r3.work, 'u9', ...Array(62).fill('a'), 'f.txt'), 'utf8') === '9', r3.out);
  // 다른 모양: 계단 — 기록마다 폴더 하나 + 파일 하나 (s/f.txt, s/s/f.txt, …) → 30 기록, 60 항목
  const stairs = Array.from({ length: 30 }, (_, i) => ({ name: `${'s/'.repeat(i + 1)}f.txt`, data: 'x' }));
  const r4 = runX(zip(stairs));
  check('계단 모양 30 기록 (60 항목) > 한도 50: 거절', r4.code === 3 && r4.out.includes('폴더 포함') && !fs.existsSync(r4.stage) && r4.after === r4.before, r4.out);
  const r5 = runX(zip(stairs), { ...small, files: 60 });
  check('  → 한도 60: 통과', r5.code === 0 && r5.out.startsWith('OK 30 '), r5.out);
  // 적힌 폴더와 경로에서 나온 폴더는 한 번만
  const ex = zip([{ name: 'x/', dir: true }, { name: 'x/y/z.txt', data: 'z' }, { name: 'x/w.txt', data: 'w' }]); // 기록 3, 항목 4 (x 는 적힌 폴더이자 중간 폴더)
  const r6 = runX(ex, { ...small, files: 4 }), r7 = runX(ex, { ...small, files: 3 });
  check('적힌 폴더 + 중간 폴더 중복은 한 번 (4 항목: 한도 4 통과, 3 거절)', r6.code === 0 && r7.code === 3 && r7.out.includes('폴더 포함 4개'), JSON.stringify([r6.out, r7.out]));
  // 기본 한도 (50,000) 에서도 빨리 끊긴다 — 기록 1,000개 × 64단 고유 경로
  const big = zip(Array.from({ length: 1000 }, (_, i) => ({ name: `v${i}/${'b/'.repeat(62)}f`, data: '', method: 0 })));
  const t = Date.now();
  const r8 = runX(big, LIMITS);
  const ms = Date.now() - t;
  check(`기본 한도 50,000: 64,000 항목 ZIP 을 목차에서 거절 (${ms}ms)`, r8.code === 3 && r8.out.includes('폴더 포함 50001개') && !fs.existsSync(r8.stage) && ms < 10000, r8.out);
}
for (const bad of ['../evil.txt', '/abs.txt', 'C:/evil.txt', 'c:evil.txt', 'a\\..\\..\\evil.txt', 'ok/../../evil.txt', '..\\evil.txt', 'x/\u0001.txt']) {
  const r = runX(zip([{ name: 'fine.txt', data: 'ok' }, { name: bad, data: 'pwn' }]));
  check(`경로 거절: ${JSON.stringify(bad)}`, r.code === 3 && r.after === r.before && !r.escaped && !fs.existsSync(path.join(r.root, '..', 'evil.txt')), r.out);
}
{
  const r = runX(zip([{ name: 'fine.txt', data: 'ok' }, { name: 'link', data: '/etc/passwd', mode: 0o120777, method: 0 }]));
  check('심볼릭 링크 항목: ZIP 전체 거절 (몰래 빼지 않음)', r.code === 3 && r.out.includes('심볼릭 링크') && r.after === r.before, r.out);
  const r2 = runX(zip([{ name: 'fifo', data: '', mode: 0o010644, method: 0 }]));
  check('특수 파일(FIFO) 항목: 거절', r2.code === 3 && r2.out.includes('특수 파일') && r2.after === r2.before, r2.out);
}
{
  const r = runX(zip([{ name: 'fresh.txt', data: 'new' }, { name: 'conf', data: 'file' }]), small, (w) => { fs.mkdirSync(path.join(w, 'conf')); fs.writeFileSync(path.join(w, 'conf', 'mine.txt'), 'mine'); });
  check('~/work 에 같은 이름 폴더가 있으면: 하나도 옮기지 않고 거절 (fresh.txt 없음, conf/mine.txt 유지)', r.code === 3 && r.out.includes('기존 작업과 겹침') && r.after === r.before, r.out);
  const r2 = runX(zip([{ name: 'fresh.txt', data: 'new' }, { name: 'sub/a.txt', data: 'x' }]), small, (w) => fs.writeFileSync(path.join(w, 'sub'), 'a file'));
  check('폴더 자리에 참가자 파일: 거절, 그대로', r2.code === 3 && r2.after === r2.before, r2.out);
  let linked = false;
  const r3 = runX(zip([{ name: 'fresh.txt', data: 'new' }, { name: 'ln/pwn.txt', data: 'x' }]), small, (w, root) => {
    try { fs.symlinkSync(path.join(root, 'outside'), path.join(w, 'ln'), 'junction'); linked = true; } catch {}
  });
  if (linked) check('~/work 안의 링크(폴더 자리)를 따라가지 않음: 거절, outside 비어 있음', r3.code === 3 && r3.out.includes('기존 작업과 겹침') && fs.readdirSync(path.join(r3.root, 'outside')).length === 0, r3.out);
  else console.log('  skip ~/work 링크 따라가기 (이 PC 에서 링크를 못 만듦)');
}
{
  const r = runX(zip([{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }]));
  check('같은 이름 두 번: 거절', r.code === 3 && r.out.includes('같은 이름'), r.out);
  const r2 = runX(zip([{ name: 'a', data: 'x' }, { name: 'a/b.txt', data: 'y' }]));
  check('파일과 폴더 이름 겹침: 거절', r2.code === 3 && r2.out.includes('겹침'), r2.out);
  const r3 = runX(zip([{ name: 'a.txt', data: 'hello', crc: 1234 }]));
  check('CRC 불일치: 거절, ~/work 그대로', r3.code === 3 && r3.out.includes('CRC') && r3.after === r3.before, r3.out);
  const r4 = runX(zip([{ name: 'a.txt', data: 'hello', flags: 0x801 }]));
  check('암호 ZIP: 거절', r4.code === 3 && r4.out.includes('암호'), r4.out);
  const r5 = runX(Buffer.from('this is not a zip at all'));
  check('ZIP 아님: 거절', r5.code === 3 && r5.after === r5.before, r5.out);
  // 샌드박스 node 가 22.2 보다 낮으면 zlib.crc32 가 없다 → 스크립트 안 CRC 로 같은 결과
  const pre = path.join(TMP, 'nocrc.cjs');
  fs.writeFileSync(pre, "Object.defineProperty(require('zlib'), 'crc32', { value: undefined });\n");
  const zc = path.join(TMP, 'crc.zip');
  fs.writeFileSync(zc, zip([{ name: 'a.txt', data: 'hello crc' }, { name: 'b.bin', data: Buffer.alloc(200 * 1024, 7) }]));
  const run = (z) => { const d = fs.mkdtempSync(path.join(TMP, 'c')); fs.mkdirSync(path.join(d, 'w')); fs.writeFileSync(zc, z); return spawnSync(process.execPath, ['-r', pre, XJS, zc, path.join(d, 's'), path.join(d, 'w'), '1000000', '10', '20'], { encoding: 'utf8' }).stdout.trim(); };
  const okOut = run(fs.readFileSync(zc)), badOut = run(zip([{ name: 'a.txt', data: 'hello', crc: 99 }]));
  check('zlib.crc32 없는 node: 스크립트 CRC 로 통과·불일치 거절', okOut.startsWith('OK 2 ') && badOut.includes('CRC'), JSON.stringify([okOut, badOut]));
  const r6 = runX(zip([{ name: 'big.bin', data: Buffer.alloc(300 * MiB) }]), { ...small, bytes: 400 * MiB, seconds: 0.05 });
  check('시간 한도: 큰 파일을 푸는 중에 시간 초과로 중단, ~/work 그대로', r6.code === 3 && r6.out.includes('시간 초과') && r6.after === r6.before, r6.out);
}

console.log('\n# ~/work 로 옮기기는 한 거래 (F2)');
// 참가자: proj/mine.txt · proj/over.txt · top.txt 가 이미 있음. ZIP 은 proj 에 더하고(merge), 둘을 덮고, 새 폴더를 만들고, 마지막에 zz-late.txt
const txn = zip([
  { name: 'proj/new.txt', data: 'attacker new' },
  { name: 'proj/over.txt', data: 'attacker over' },
  { name: 'newdir/deep/x.txt', data: 'x' },
  { name: 'top.txt', data: 'attacker top' },
  { name: 'zz-late.txt', data: 'late' },
]);
const txnPrep = (w) => { fs.mkdirSync(path.join(w, 'proj')); fs.writeFileSync(path.join(w, 'proj', 'mine.txt'), 'mine'); fs.writeFileSync(path.join(w, 'proj', 'over.txt'), 'orig over'); fs.writeFileSync(path.join(w, 'top.txt'), 'orig top'); };
const has = (r, f) => fs.existsSync(path.join(r.stage, f));
{
  const r = runX(txn, small, txnPrep);
  const t = JSON.parse(r.after), b64 = (s) => Buffer.from(s).toString('base64');
  check('성공 (대조): 기존 폴더에 합침 · 같은 이름은 덮음 · 참가자 파일 유지', r.code === 0 && r.out.startsWith('OK 5 ')
    && t['proj/mine.txt'] === b64('mine') && t['proj/new.txt'] === b64('attacker new') && t['proj/over.txt'] === b64('attacker over')
    && t['top.txt'] === b64('attacker top') && t['newdir/deep/x.txt'] === b64('x') && t['zz-late.txt'] === b64('late') && t['keep.txt'] === b64('participant')
    && Object.keys(t).length === 10, r.out + ' ' + r.after);
  check('  → committed 표시, 기록(journal) 없음, 덮인 원본은 stage/b 에만, 밖으로 새지 않음', has(r, 'committed') && !has(r, 'journal') && fs.readdirSync(path.join(r.stage, 'b')).length === 2 && !r.escaped);
  check('  → --rollback 은 COMMITTED (되돌리지 않음)', rollbackX(r.stage, r.work).out === 'COMMITTED' && tree(r.work) === r.after);
}
{
  const r = runX(txn, small, txnPrep, 'fail');
  check(`늦은 실패 (앞의 ${r.moved}개 옮긴 뒤 rename EACCES): ERR, ~/work 원래대로 (덮인 원본 복귀 · 새 파일·폴더 지움 · 기존 폴더 유지)`, r.code === 3 && r.out.includes('EACCES') && r.moved >= 4 && r.after === r.before && !r.escaped, r.out);
  check('  → 기록 비움 (되돌리기 끝), 다시 --rollback 해도 할 것 없음', !has(r, 'journal') && !has(r, 'committed') && rollbackX(r.stage, r.work).out === 'OK nothing' && tree(r.work) === r.before);
}
{
  const r = runX(txn, small, txnPrep, 'fail-restore');
  check('늦은 실패 + 프로세스 안 되돌리기도 실패: 그렇다고 알림, 기록은 남김', r.code === 3 && r.out.includes('되돌리기 실패') && has(r, 'journal') && r.after !== r.before, r.out);
  const rb = rollbackX(r.stage, r.work);
  check('  → --rollback 이 남은 기록을 이어서 되돌림: ~/work 원래대로', rb.code === 0 && rb.out.startsWith('OK rolled back') && tree(r.work) === r.before && !has(r, 'journal'), rb.out);
  check('  → 한 번 더 돌려도 그대로 (멱등)', rollbackX(r.stage, r.work).out === 'OK nothing' && tree(r.work) === r.before);
}
{
  const r = runX(txn, small, txnPrep, 'kill');
  const partial = fs.existsSync(path.join(r.work, 'proj', 'new.txt'));
  check(`SIGKILL (앞의 ${r.moved}개 옮긴 뒤): 프로세스가 못 되돌림 — 반쯤 옮긴 상태 + 기록 남음`, r.code !== 0 && r.code !== 3 && partial && has(r, 'journal') && r.moved >= 4, JSON.stringify([r.code, r.signal, r.out]));
  const rb = rollbackX(r.stage, r.work);
  check('  → --rollback: ~/work 원래대로 (덮인 원본 복귀), 원본 보관함 비움', rb.code === 0 && tree(r.work) === r.before && fs.readdirSync(path.join(r.stage, 'b')).length === 0 && !has(r, 'journal'), rb.out);
}
{
  const r = runX(txn, small, txnPrep, 'time');
  check(`옮기는 중 시간 초과 (${r.moved}개 옮긴 뒤 시계 넘어감): ERR 시간 초과, ~/work 원래대로`, r.code === 3 && r.out.includes('시간 초과') && r.moved >= 1 && r.after === r.before && !has(r, 'journal'), r.out);
}
{
  const r = runX(txn, small, txnPrep, 'kill-commit');
  check('다 옮기고 committed 뒤 OK 직전 SIGKILL: --rollback 은 COMMITTED, 결과 유지', r.code !== 0 && has(r, 'committed') && rollbackX(r.stage, r.work).out === 'COMMITTED' && JSON.parse(tree(r.work))['zz-late.txt'] === Buffer.from('late').toString('base64'), r.out);
}
{
  // 기록 자체: 쓰다 만 마지막 줄은 하지 않은 일로 보고 버림 · 경로가 이상한 기록은 따르지 않음
  const d = fs.mkdtempSync(path.join(TMP, 'j')), w = path.join(d, 'work'), st = path.join(d, 'stage');
  fs.mkdirSync(w); fs.mkdirSync(path.join(st, 'b'), { recursive: true });
  fs.writeFileSync(path.join(w, 'made.txt'), 'attacker'); fs.mkdirSync(path.join(w, 'nd'));
  fs.writeFileSync(path.join(st, 'journal'), 'D nd\nN made.txt\nN half');
  const rb = rollbackX(st, w);
  check('쓰다 만 기록 줄: 무시하고 나머지 되돌림', rb.code === 0 && rb.out === 'OK rolled back 2' && fs.readdirSync(w).length === 0, rb.out);
  fs.writeFileSync(path.join(d, 'victim.txt'), 'keep');
  fs.writeFileSync(path.join(st, 'journal'), 'N ../victim.txt\n');
  const rb2 = rollbackX(st, w);
  check('기록에 .. 경로: 따르지 않고 실패 (밖의 파일 유지)', rb2.code === 3 && rb2.out.includes('기록 손상') && fs.existsSync(path.join(d, 'victim.txt')), rb2.out);
}

console.log('\n# 받기 (readCapped 실제 호출)');
function stream(chunks, { fail } = {}) {
  const st = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(ctl) {
      if (fail !== undefined && i === fail) { ctl.error(new Error('connection reset')); return; }
      if (i >= chunks.length) { ctl.close(); return; }
      st.pulled += chunks[i].length;
      ctl.enqueue(chunks[i++]);
    },
    cancel() { st.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, st };
}
const K = (n) => new Uint8Array(n * 1024);
async function rc(chunks, headers = {}, max = 100 * 1024, opt = {}) {
  const { body, st } = stream(chunks, opt);
  const r = new Response(body, { status: opt.status ?? 200, headers });
  try { const b = await readCapped(r, max); return { ok: true, len: b.byteLength, st, b }; }
  catch (e) { return { ok: false, msg: e.message, st }; }
}
{
  let r = await rc([K(10), K(10)], { 'content-length': String(20 * 1024) });
  check('정상 (Content-Length 맞음)', r.ok && r.len === 20 * 1024);
  r = await rc([K(10), K(10)]);
  check('정상 (Content-Length 없음)', r.ok && r.len === 20 * 1024);
  r = await rc([K(200)], { 'content-length': String(200 * 1024) });
  check('Content-Length 가 한도 초과: 몸통을 읽지 않고 취소', !r.ok && r.msg.includes('넘습니다') && r.st.pulled === 0 && r.st.cancelled, JSON.stringify(r));
  r = await rc(Array.from({ length: 50 }, () => K(8)));
  check('헤더 없이 한도 초과 스트림: 실제 바이트로 중단·취소', !r.ok && r.msg.includes('넘습니다') && r.st.cancelled && r.st.pulled <= 100 * 1024 + 8 * 1024, JSON.stringify(r.st));
  r = await rc(Array.from({ length: 50 }, () => K(8)), { 'content-length': '10' });
  check('작게 속인 Content-Length + 큰 스트림: 한도에서 중단·취소', !r.ok && r.msg.includes('넘습니다') && r.st.cancelled && r.st.pulled <= 108 * 1024, JSON.stringify(r));
  r = await rc([K(1)], { 'content-length': '10' });
  check('Content-Length 보다 많이 옴 (한도 안): 거절', !r.ok && r.msg.includes('끝까지'), JSON.stringify(r));
  r = await rc([K(5)], { 'content-length': String(10 * 1024) });
  check('끊긴 스트림 (알린 것보다 적음): 거절', !r.ok && r.msg.includes('끝까지'), JSON.stringify(r));
  r = await rc([K(5), K(5)], {}, 100 * 1024, { fail: 1 });
  check('중간에 오류난 스트림: 거절·취소', !r.ok && r.msg.includes('자료 받기 실패'), JSON.stringify(r));
  r = await rc([K(5)], { 'content-type': 'text/html; charset=utf-8' });
  check('웹 페이지(text/html): 읽지 않고 취소', !r.ok && r.msg.includes('웹 페이지') && r.st.pulled === 0 && r.st.cancelled, JSON.stringify(r));
  r = await rc([K(5)], {}, 100 * 1024, { status: 404 });
  check('HTTP 404: 거절·취소', !r.ok && r.msg.includes('HTTP 404') && r.st.cancelled, JSON.stringify(r));
  r = await rc([K(5)], { 'content-length': '999', 'content-encoding': 'gzip' });
  check('압축 전송이면 Content-Length 불일치를 따지지 않음', r.ok && r.len === 5 * 1024, JSON.stringify(r));
}
{
  const M = new Uint8Array(MiB);
  let r = await rc(Array.from({ length: 50 }, () => M), {}, MATERIALS_MAX);
  check('경계: 헤더 없이 정확히 50MiB 통과', r.ok && r.len === MATERIALS_MAX && MATERIALS_MAX === 50 * MiB);
  r = await rc([...Array.from({ length: 50 }, () => M), new Uint8Array(1)], {}, MATERIALS_MAX);
  check('경계: 50MiB + 1 바이트 거절·취소', !r.ok && r.msg.includes('50MB') && r.st.cancelled);
  r = await rc([], { 'content-length': String(MATERIALS_MAX + 1) }, MATERIALS_MAX);
  check('경계: Content-Length 50MiB+1 즉시 거절', !r.ok && r.st.pulled === 0);
  r = await rc(Array.from({ length: 50 }, () => M), { 'content-length': String(MATERIALS_MAX) }, MATERIALS_MAX);
  check('경계: Content-Length 정확히 50MiB (기본 한도) 통과', r.ok && r.len === MATERIALS_MAX);
}

console.log('\n# putMaterials (가짜 fetch · exec 는 이 PC 에서 실제 실행)');
const TB = 'https://tb.test/toolbox';
const c = { api: 'https://dt.test/api', key: 'k-test' };
const sb = { id: 'sb1', state: 'started', toolboxProxyUrl: TB };
function sandbox() {
  const home = path.join(TMP, `home${++caseN}`);
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fs.writeFileSync(path.join(home, 'work', 'keep.txt'), 'participant');
  const outside = path.join(TMP, `outside${caseN}`);
  fs.mkdirSync(outside);
  return { home, outside, uploads: [], execs: [], unknown: [], rollbacks: [], failUpload: null, material: null, fault: null, lose: false, failRollback: false };
}
const loc = (S, p) => {
  if (!p.startsWith('/home/daytona/')) throw new Error(`sandbox path outside home: ${p}`);
  return path.join(S.home, ...p.slice('/home/daytona/'.length).split('/'));
};
function install(S) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://mat.test/')) { const r = S.material(); Object.defineProperty(r, 'url', { value: u }); return r; }
    if (u.startsWith(`${TB}/sb1/files/upload?path=`)) {
      const p = decodeURIComponent(u.split('path=')[1]);
      if (S.failUpload && p.endsWith(S.failUpload)) return new Response('boom', { status: 500 });
      const f = init.body.get('file');
      const b = Buffer.from(await f.arrayBuffer());
      S.uploads.push({ path: p, size: b.length });
      fs.writeFileSync(loc(S, p), b);
      return new Response('{}');
    }
    if (u === `${TB}/sb1/process/execute`) {
      const { command, timeout } = JSON.parse(init.body);
      S.execs.push({ command, timeout });
      let m;
      if ((m = command.match(/^bash -lc 'umask 077 && mkdir -p (\S+) && mkdir (\S+)'$/))) {
        fs.mkdirSync(loc(S, m[1]), { recursive: true });
        fs.mkdirSync(loc(S, m[2]));
        return Response.json({ exitCode: 0, result: '' });
      }
      if ((m = command.match(/^bash -lc '(?:sleep (\d+) && )?timeout -k 5 50 node (\S+) --rollback (\S+) (\S+) 2>&1'$/))) {
        S.rollbacks.push({ sleep: m[1] ? Number(m[1]) : 0, timeout });
        if (S.loseRollback) throw new TypeError('rollback connection lost');
        if (S.failRollback) return Response.json({ exitCode: 3, result: 'ERR 되돌리기 실패: injected\n' });
        const r = spawnSync(process.execPath, [loc(S, m[2]), '--rollback', loc(S, m[3]), loc(S, m[4])], { encoding: 'utf8', timeout: 60000 });
        return Response.json({ exitCode: r.status ?? 137, result: r.stdout + r.stderr });
      }
      if ((m = command.match(/^bash -lc 'timeout -k 5 (\d+) node (\S+) (\S+) (\S+) (\S+) (\d+) (\d+) (\d+) 2>&1'$/))) {
        const f = faultArgs(S.fault, path.join(S.home, 'work'), loc(S, m[4]), path.join(S.home, 'moved.log'));
        const r = spawnSync(process.execPath, [...f.pre, loc(S, m[2]), loc(S, m[3]), loc(S, m[4]), loc(S, m[5]), m[6], m[7], m[8]], { encoding: 'utf8', timeout: 60000, env: f.env });
        if (S.lose) throw new TypeError('network connection lost');
        return Response.json({ exitCode: r.status ?? 137, result: r.stdout + r.stderr });
      }
      if ((m = command.match(/^bash -lc 'rm -rf (\S+)'$/))) {
        if (!m[1].startsWith(MATERIALS_TMP + '/')) throw new Error(`rm outside tmp: ${m[1]}`);
        fs.rmSync(loc(S, m[1]), { recursive: true, force: true });
        return Response.json({ exitCode: 0, result: '' });
      }
      if (command.startsWith("bash -lc 'test -d ")) return Response.json({ exitCode: 0, result: 'ok' });
      if (command.startsWith("bash -lc 'cd /home/daytona/work && rm -rf ")) return Response.json({ exitCode: 0, result: '' });
      S.unknown.push(command);
      return Response.json({ exitCode: 127, result: 'unknown command' });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}
const zipResp = (buf, headers = {}) => () => new Response(stream([new Uint8Array(buf)]).body, { headers: { 'content-type': 'application/zip', ...headers } });
const tmpLeft = (S) => fs.existsSync(path.join(S.home, '.gw-materials')) ? fs.readdirSync(path.join(S.home, '.gw-materials')) : [];
async function put(S, url, lim) { try { return { ok: true, v: await putMaterials(c, sb, materials(url), lim) }; } catch (e) { return { ok: false, msg: e.message }; } }
{
  const S = sandbox(); install(S);
  const good = zip([{ name: '수업/첫째 주/예제.py', data: 'print("안녕")\n' }, { name: 'run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o100755 }]);
  S.material = zipResp(good, { 'content-length': String(good.length), 'content-disposition': 'attachment; filename="lesson.zip"' });
  const r = await put(S, 'https://mat.test/lesson.zip', small);
  const w = path.join(S.home, 'work');
  check('정상 ZIP: 성공 메시지', r.ok && r.v === 'lesson.zip (압축 풂)', JSON.stringify(r));
  check('~/work 에 풀림 (한글 중첩) · 참가자 파일 유지', fs.readFileSync(path.join(w, '수업', '첫째 주', '예제.py'), 'utf8') === 'print("안녕")\n' && fs.readFileSync(path.join(w, 'keep.txt'), 'utf8') === 'participant');
  check('ZIP·풀기 스크립트는 ~/work 밖 한 번 쓰는 폴더로 올라감', S.uploads.length === 2 && S.uploads.every((u) => u.path.startsWith(MATERIALS_TMP + '/')) && !fs.existsSync(path.join(w, 'lesson.zip')), JSON.stringify(S.uploads));
  check('끝나면 임시 폴더 지움 · unzip 안 씀 · 모르는 명령 없음', tmpLeft(S).length === 0 && !S.execs.some((e) => e.command.includes('unzip')) && S.unknown.length === 0, JSON.stringify([tmpLeft(S), S.unknown]));
  check('풀기 exec 는 60초 deadline 안 (timeout 25s + 한도 인자)', S.execs.some((e) => e.timeout === 60 && e.command.includes(`timeout -k 5 25 node`) && e.command.includes(` ${small.bytes} ${small.files} ${small.seconds} `)), JSON.stringify(S.execs));
}
{
  const S = sandbox(); install(S);
  const good = zip([{ name: 'a.txt', data: 'a' }]);
  S.material = zipResp(good);
  const r = await put(S, 'https://mat.test/dl?id=1');
  check('Content-Length 없는 ZIP (이름 없음 → .zip 붙임) · 기본 한도 1GiB/50,000', r.ok && r.v === 'dl.zip (압축 풂)' && S.execs.some((e) => e.command.includes(` ${1024 ** 3} 50000 45 `)) && LIMITS.bytes === 1024 ** 3 && LIMITS.files === 50000, JSON.stringify([r, S.execs.map((e) => e.command)]));
}
{
  const S = sandbox(); install(S);
  fs.writeFileSync(path.join(S.home, 'work', 'm.zip'), 'participant zip');
  const before = tree(path.join(S.home, 'work'));
  S.material = zipResp(zip([{ name: 'ok.txt', data: 'ok' }, { name: '../../outside/evil.txt', data: 'pwn' }]));
  const r = await put(S, 'https://mat.test/m.zip', small);
  check('경로 탈출 ZIP: 실패 메시지', !r.ok && r.msg.startsWith('압축 풀기 실패') && r.msg.includes('상위 폴더'), JSON.stringify(r));
  check('  → ~/work 그대로 (참가자의 m.zip 포함), 밖에 쓴 것 없음, 임시 폴더 지움', tree(path.join(S.home, 'work')) === before && fs.readdirSync(S.outside).length === 0 && !fs.existsSync(path.join(S.home, 'evil.txt')) && tmpLeft(S).length === 0);
}
{
  const S = sandbox(); install(S);
  const before = tree(path.join(S.home, 'work'));
  S.material = zipResp(zip([{ name: 'bomb.bin', data: Buffer.alloc(3 * MiB), usize: 10 }]));
  const r = await put(S, 'https://mat.test/b.zip', small);
  check('크기 속인 폭탄: 실패, ~/work 그대로, 임시 폴더 지움', !r.ok && r.msg.includes('실제 크기') && tree(path.join(S.home, 'work')) === before && tmpLeft(S).length === 0, JSON.stringify(r));
}
{
  const S = sandbox(); install(S);
  let st;
  S.material = () => { const s = stream(Array.from({ length: 100 }, () => K(64))); st = s.st; return new Response(s.body); };
  const r = await put(S, 'https://mat.test/huge.bin', small);
  check('받기 한도 초과 (헤더 없음): 실패, 올리지 않음, 스트림 취소', !r.ok && r.msg.includes('넘습니다') && S.uploads.length === 0 && S.execs.length === 0 && st.cancelled && st.pulled <= small.download + 64 * 1024, JSON.stringify([r, st]));
  S.material = () => { const s = stream([K(1)]); st = s.st; return new Response(s.body, { headers: { 'content-type': 'text/html' } }); };
  const r2 = await put(S, 'https://mat.test/page', small);
  check('웹 페이지: 실패, 올리지 않음, 읽지 않음', !r2.ok && r2.msg.includes('웹 페이지') && S.uploads.length === 0 && st.pulled === 0);
  S.material = () => new Response(stream([K(3)]).body, { headers: { 'content-length': String(10 * 1024) } });
  const r3 = await put(S, 'https://mat.test/cut.zip', small);
  check('끊긴 다운로드: 실패, 올리지 않음', !r3.ok && r3.msg.includes('끝까지') && S.uploads.length === 0);
}
{
  const S = sandbox(); install(S);
  S.material = () => new Response(stream([new Uint8Array(Buffer.from('%PDF-1.7 hello'))]).body, { headers: { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''%EA%B0%95%EC%9D%98.pdf" } });
  const r = await put(S, 'https://mat.test/x', small);
  check('ZIP 아닌 파일: ~/work 에 그대로 (이전 동작)', r.ok && S.uploads.length === 1 && S.uploads[0].path.startsWith(`${WORK}/`) && S.execs.length === 0, JSON.stringify([r, S.uploads]));
}
{
  const S = sandbox(); install(S);
  S.failUpload = 'm.zip';
  S.material = zipResp(zip([{ name: 'a.txt', data: 'a' }]));
  const r = await put(S, 'https://mat.test/m.zip', small);
  check('올리기 실패: 오류 전달, 임시 폴더 지움 exec, ~/work 그대로', !r.ok && r.msg.includes('upload 500') && tmpLeft(S).length === 0 && S.execs.at(-1).command.startsWith("bash -lc 'rm -rf "), JSON.stringify(r));
}
// 게이트웨이 회복: 풀기가 실패·죽음·연결 끊김이면 --rollback 을 돌리고, 확인된 뒤에만 임시 폴더를 지운다
async function txnPut(setup) {
  const S = sandbox(); install(S);
  txnPrep(path.join(S.home, 'work'));
  setup(S);
  const before = tree(path.join(S.home, 'work'));
  S.material = zipResp(txn);
  const r = await put(S, 'https://mat.test/t.zip', small);
  return { S, r, before, after: tree(path.join(S.home, 'work')), moved: moved(path.join(S.home, 'moved.log')) };
}
{
  const { S, r, before, after, moved: n } = await txnPut((S) => { S.fault = 'fail'; });
  check(`putMaterials 늦은 실패 (${n}개 옮긴 뒤): 실패 메시지, ~/work 원래대로, --rollback 확인, 임시 폴더 지움`, !r.ok && r.msg === '압축 풀기 실패: EACCES: injected' && after === before && S.rollbacks.length === 1 && S.rollbacks[0].sleep === 0 && tmpLeft(S).length === 0 && n >= 4, JSON.stringify(r));
}
{
  const { S, r, before, after } = await txnPut((S) => { S.fault = 'kill'; });
  check('putMaterials SIGKILL 중간: --rollback 으로 원래대로, 실패 보고, 임시 폴더 지움', !r.ok && r.msg.startsWith('압축 풀기 실패') && after === before && S.rollbacks.length === 1 && tmpLeft(S).length === 0, JSON.stringify(r));
}
{
  const { S, r, before, after } = await txnPut((S) => { S.fault = 'fail-restore'; });
  check('putMaterials 프로세스 안 되돌리기 실패: --rollback 이 마저 되돌림, 원래 원인 보고', !r.ok && r.msg.startsWith('압축 풀기 실패: EACCES') && after === before && tmpLeft(S).length === 0, JSON.stringify(r));
}
{
  const { S, r, after } = await txnPut((S) => { S.fault = 'kill-commit'; });
  check('putMaterials 다 옮긴 뒤 죽음: COMMITTED → 성공으로 보고, 결과 유지, 임시 폴더 지움', r.ok && r.v === 't.zip (압축 풂)' && JSON.parse(after)['zz-late.txt'] && tmpLeft(S).length === 0, JSON.stringify(r));
}
{
  const { S, r, before, after } = await txnPut((S) => { S.fault = 'kill'; S.lose = true; });
  const rb = S.rollbacks[0];
  check(`putMaterials 연결 끊김: 풀기 프로세스가 죽을 시각까지 기다린 뒤 --rollback (sleep ${rb?.sleep}s ≤ ${small.seconds + 11}, exec ${rb?.timeout}s), 원래대로`, !r.ok && r.msg.includes('연결 끊김') && rb && rb.sleep > 0 && rb.sleep <= small.seconds + 11 && rb.timeout === rb.sleep + 60 && after === before && tmpLeft(S).length === 0, JSON.stringify([r, S.rollbacks]));
}
{
  const { S, r, after, before } = await txnPut((S) => { S.fault = 'kill'; S.failRollback = true; });
  check('putMaterials 되돌리기 실패: 그렇다고 보고, 덮인 원본이 있는 임시 폴더를 지우지 않음', !r.ok && r.msg.includes('되돌리기도 실패') && r.msg.includes('/out/b') && tmpLeft(S).length === 1 && after !== before && fs.readdirSync(path.join(S.home, '.gw-materials', tmpLeft(S)[0], 'out', 'b')).length > 0, JSON.stringify(r));
  const rb = rollbackX(path.join(S.home, '.gw-materials', tmpLeft(S)[0], 'out'), path.join(S.home, 'work'));
  check('  → 남겨 둔 폴더로 나중에 --rollback 하면 원래대로', rb.code === 0 && tree(path.join(S.home, 'work')) === before, rb.out);
}
{
  const { S, r, after, before } = await txnPut((S) => { S.fault = 'kill'; S.loseRollback = true; });
  check('putMaterials 되돌리기 중 연결 끊김: 확인 못 함 보고, 임시 폴더 지우지 않음 (rm 안 보냄)', !r.ok && r.msg.includes('되돌리기 확인 못 함 (rollback connection lost)') && r.msg.includes('/out/b') && tmpLeft(S).length === 1 && !S.execs.some((e) => e.command.startsWith("bash -lc 'rm -rf ")) && after !== before, JSON.stringify(r));
  const rb = rollbackX(path.join(S.home, '.gw-materials', tmpLeft(S)[0], 'out'), path.join(S.home, 'work'));
  check('  → 남겨 둔 폴더로 나중에 --rollback 하면 원래대로', rb.code === 0 && tree(path.join(S.home, 'work')) === before, rb.out);
}
{
  const { S, r } = await txnPut(() => {});
  check('putMaterials 성공 (대조): --rollback 안 돌림, 임시 폴더 지움', r.ok && S.rollbacks.length === 0 && tmpLeft(S).length === 0, JSON.stringify(r));
}
{
  const S = sandbox(); install(S);
  const r = await put(S, 'https://github.com/owner/repo', small);
  check('GitHub 자료: 샌드박스 clone 흐름 그대로', r.ok && r.v === 'repo/ (git)' && S.execs[0].command === "bash -lc 'cd /home/daytona/work && rm -rf repo && git clone -q --depth 1 https://github.com/owner/repo.git repo 2>&1 | tail -2'" && S.uploads.length === 0, JSON.stringify(S.execs));
  const d = materials('https://drive.google.com/file/d/ABCDEFGHIJKL/view?usp=sharing');
  check('구글 드라이브 링크 → 직접 받기 주소 (그대로)', d?.kind === 'file' && d.url === 'https://drive.usercontent.google.com/download?id=ABCDEFGHIJKL&export=download&confirm=t');
  check('일반 https 주소 → file (그대로)', materials('https://example.com/a.zip')?.kind === 'file');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
