// 네트워크 없이 수업 서비스 번들과 직렬 메모리 저장소만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-classroom-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-token';
const TEACHER = 'teacher-token';
const CODE1 = 'a'.repeat(16);
const CODE2 = 'b'.repeat(16);
const fail = (status, error) => ({ status, error });

function memory() {
  const data = new Map();
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  const storage = {
    async get(k) { return copy(data.get(k)); },
    async put(k, v) { data.set(k, copy(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) data.delete(x); },
    async list({ prefix = '', limit = Infinity, startAfter = '' } = {}) {
      return new Map([...data].filter(([key]) => String(key).startsWith(prefix) && key > startAfter).sort(([a],[b])=>a.localeCompare(b,'en')).slice(0, limit).map(([k, v]) => [k, copy(v)]));
    },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
  };
  return { data, storage };
}

function world() {
  const { data, storage } = memory();
  let T = 1_800_000_000_000;
  let ended = false;
  let present = true;
  let reads = 0;
  let seatsSeen = 0;
  const seats = [
    { labId: 'lab', n: 1, who: '가람', code: CODE1, sandboxId: 'sb-1' },
    { labId: 'lab', n: 2, who: '나래', code: CODE2, sandboxId: 'sb-2' },
  ];
  const scheduled = [];
  let file = { content: '확정: 신청자 10명\n' };
  const seatOf = (code) => {
    seatsSeen++;
    const seat = seats.find((item) => item.code === code);
    if (!present || !seat) return fail(404, '없는 링크이거나 수업이 끝났습니다.');
    if (ended) return fail(410, '모임이 끝났습니다.');
    return { ...seat };
  };
  const labOf = () => present ? { id: 'lab', live: !ended, seats: seats.map((seat) => ({ ...seat })) } : null;
  const deps = {
    storage, now: () => T, checkAdmin: async (token) => token === TOKEN,
    teacherLabs: async (token) => {
      if (token !== TEACHER) return fail(401, '강사 보기 세션이 만료됐습니다.');
      if (!present) return [];
      return [{ id: 'lab', ending: ended }];
    },
    lab: async (id) => id === 'lab' ? labOf() : null,
    live: async (id) => {
      if (id !== 'lab' || !present) return fail(404, '없는 수업입니다.');
      if (ended) return fail(410, '모임이 끝났습니다.');
      return labOf();
    },
    seat: seatOf, seatIn: async (code) => seatOf(code),
    readFile: async () => { reads++; return file; },
    schedule: async (t) => { scheduled.push(t); },
  };
  return {
    data, storage, seats, scheduled, deps, make: () => new M.LabClassroomService(deps),
    reads: () => reads, seatsSeen: () => seatsSeen,
    set time(v) { T = v; }, get time() { return T; },
    set ended(v) { ended = v; }, set present(v) { present = v; }, set file(v) { file = v; },
  };
}

const dumped = (w) => JSON.stringify([...w.data.values()]);
const pub = (x) => JSON.stringify(x);
let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('ok', name); }

await test('fresh status is the memo lesson and writes nothing', async () => {
  const w = world(), s = w.make();
  const view = await s.status(TOKEN, 'lab');
  assert.equal(view.classroom.title, '메모 두 개로 5줄 보고서 만들기');
  assert.equal(view.classroom.mode, 'together');
  assert.equal(view.classroom.currentStep, 0);
  assert.equal(view.classroom.revision, 0);
  assert.deepEqual(view.classroom.steps.map((step) => step.id), ['memo', 'draft', 'compare', 'submit', 'keep']);
  assert.deepEqual(view.classroom.materials.map((item) => item.name), ['01_요청메모.txt', '02_진행메모.txt']);
  assert.ok(view.classroom.materials[1].content.includes('정원 12명: 검토 중'));
  assert.deepEqual(view.classroom.chapters.map((chapter) => chapter.seconds), [0, 480, 960, 1560, 2100]);
  assert.deepEqual(view.participants.map((seat) => seat.n), [1, 2]);
  assert.equal(w.data.has(M.classroomDocKey('lab')), false);
  assert.equal((await s.status('nope', 'lab')).status, 401);
  assert.equal(w.data.size, 0);
  assert.equal((await s.status(TOKEN, 'missing')).status, 404);
});

await test('probe command is a fixed WORK/결과.txt reader', async () => {
  const command = M.classroomProbeCommand();
  const script = Buffer.from(command.match(/Buffer\.from\('([^']+)'/)[1], 'base64').toString('utf8');
  assert.equal(command.startsWith('node -e '), true);
  assert.match(script, /realpathSync/);
  assert.match(script, /O_NOFOLLOW/);
  assert.ok(script.includes("/home/daytona/work"));
  assert.ok(script.includes('결과.txt'));
  assert.equal(script.includes('process.argv'), false);
  assert.equal(M.classroomProbeCommand(), command);
});

await test('same revision commits once and a stale revision does not write', async () => {
  const w = world(), s = w.make();
  const [a, b] = await Promise.all([
    s.update(TOKEN, 'lab', 0, { title: '가 수업' }),
    s.update(TOKEN, 'lab', 0, { title: '나 수업' }),
  ]);
  const ok = [a, b].find((item) => !item.status);
  const lost = [a, b].find((item) => item.status);
  assert.equal(ok.classroom.revision, 1);
  assert.equal(lost.status, 409);
  assert.equal(w.data.get(M.classroomDocKey('lab')).revision, 1);
  assert.equal([a, b].filter((item) => !item.status).length, 1);
  const stale = await s.update(TOKEN, 'lab', 0, { title: '다시' });
  assert.equal(stale.status, 409);
  assert.equal(w.data.get(M.classroomDocKey('lab')).title, ok.classroom.title);
  assert.equal((await s.update('nope', 'lab', 1, { title: '몰래' })).status, 401);
  assert.equal(w.data.get(M.classroomDocKey('lab')).title, ok.classroom.title);
});

await test('teacher can read and cannot update or send feedback', async () => {
  const w = world(), s = w.make();
  const view = await s.teacherStatus(TEACHER, 'lab');
  assert.equal(view.classroom.title, '메모 두 개로 5줄 보고서 만들기');
  assert.equal(pub(view).includes(CODE1), false);
  assert.equal(pub(view).includes('sb-1'), false);
  assert.equal(pub(view).includes('grant'), false);
  assert.equal(w.data.size, 0);
  assert.equal((await s.update(TEACHER, 'lab', 0, { title: '강사 수정' })).status, 401);
  assert.equal((await s.feedback(TEACHER, 'lab', 1, uuid(1), '메모')).status, 401);
  assert.equal(w.data.size, 0);
  assert.equal((await s.teacherStatus('other', 'lab')).status, 401);
});

await test('ended lab denies seats and edits while admin can still read', async () => {
  const w = world(), s = w.make();
  assert.equal((await s.update(TOKEN, 'lab', 0, { currentStep: 2 })).classroom.currentStep, 2);
  w.ended = true;
  assert.equal((await s.update(TOKEN, 'lab', 1, { currentStep: 3 })).status, 410);
  assert.equal(w.data.get(M.classroomDocKey('lab')).currentStep, 2);
  assert.equal((await s.seatStatus(CODE1)).status, 410);
  assert.equal((await s.submit(CODE1, uuid(1), '결과.txt')).status, 410);
  assert.equal(w.reads(), 0);
  const admin = await s.status(TOKEN, 'lab');
  assert.equal(admin.classroom.currentStep, 2);
  assert.equal((await s.teacherStatus(TEACHER, 'lab')).status, 410);
});

await test('retain keeps the review copy after the lab record is gone', async () => {
  const w = world(), s = w.make();
  w.file = { content: '보관할 결과' };
  const submitted = await s.submit(CODE1, uuid(1), '결과.txt');
  assert.equal(submitted.submissions[0].content, '보관할 결과');
  await s.retain('lab', [{ n: 1, who: '가람' }, { n: 2, who: '나래' }]);
  w.present = false;
  w.ended = true;
  const kept = await s.status(TOKEN, 'lab');
  assert.equal(kept.participants[0].submissions[0].content, '보관할 결과');
  assert.equal((await s.seatStatus(CODE1)).status, 404);
  const until = w.data.get(M.classroomDocKey('lab')).retainUntil;
  assert.ok(w.scheduled.includes(until));
  w.time = until + 1;
  assert.equal((await s.status(TOKEN, 'lab')).status, 404);
  assert.equal(w.data.has(M.classroomDocKey('lab')), true);
  await s.alarm(until + 1);
  assert.equal(w.data.has(M.classroomDocKey('lab')), false);
  assert.equal(w.data.has(M.classroomSeatKey('lab', 1)), false);
  assert.equal((await s.status(TOKEN, 'lab')).status, 404);
});

await test('seat progress does not follow the teacher step', async () => {
  const w = world(), s = w.make();
  const moved = await s.progress(CODE1, 4, true);
  assert.equal(moved.progress.step, 4);
  assert.equal(moved.classroom.currentStep, 0);
  const taught = await s.update(TOKEN, 'lab', 0, { currentStep: 2 });
  assert.equal(taught.classroom.currentStep, 2);
  assert.equal(taught.participants.find((seat) => seat.n === 1).progress.step, 4);
  const again = await s.seatStatus(CODE1);
  assert.equal(again.progress.step, 4);
  assert.equal(again.classroom.currentStep, 2);
  const shorter = ['one', 'two', 'three'].map((id) => ({ id, title: id, instruction: '안내', prompt: '요청' }));
  assert.equal((await s.update(TOKEN, 'lab', 1, { steps: shorter, chapters: [{ title: '시작', seconds: 0, step: 0 }] })).status, 409);
  assert.equal(w.data.get(M.classroomDocKey('lab')).steps.length, 5);
});

await test('submit replays one read and retries a 503 without a second version', async () => {
  const w = world(), s = w.make();
  w.file = { content: '첫째 제출' };
  const first = await s.submit(CODE1, uuid(4), '결과.txt');
  assert.equal(first.submissions.length, 1);
  assert.equal(first.submissions[0].version, 1);
  assert.equal(w.reads(), 1);
  const replay = await s.submit(CODE1, uuid(4), '결과.txt');
  assert.deepEqual(replay, first);
  assert.equal(w.reads(), 1);
  w.file = { status: 503, error: '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.' };
  assert.equal((await s.submit(CODE1, uuid(5), '결과.txt')).status, 503);
  assert.equal((await s.seatStatus(CODE1)).submissions.length, 1);
  w.file = { content: '둘째 제출' };
  const second = await s.submit(CODE1, uuid(5), '결과.txt');
  assert.equal(second.submissions.length, 2);
  assert.deepEqual(second.submissions.map((item) => item.version), [1, 2]);
  assert.equal(second.submissions[1].content, '둘째 제출');
  assert.equal(w.reads(), 3);
  assert.equal(pub(second).includes(uuid(5)), false);
});

await test('oversize and a bad filename store nothing', async () => {
  const w = world(), s = w.make();
  w.file = fail(413, '결과.txt 가 64KiB 를 넘습니다.');
  assert.equal((await s.submit(CODE1, uuid(6), '결과.txt')).status, 413);
  assert.equal(dumped(w).includes('64KiB 를 넘는 본문'), false);
  assert.equal((await s.seatStatus(CODE1)).submissions.length, 0);
  const seen = w.seatsSeen();
  const reads = w.reads();
  assert.equal((await s.submit(CODE1, uuid(7), '../결과.txt')).status, 400);
  assert.equal((await s.submit(CODE1, uuid(7), '다른.txt')).status, 400);
  assert.equal(w.reads(), reads);
  assert.equal(w.seatsSeen(), seen);
});

await test('a replaced sandbox does not keep the read bytes', async () => {
  const w = world(), s = w.make();
  w.file = { content: 'SECRET-STALE' };
  const original = depsRead(w);
  w.deps.readFile = async () => { w.reads(); original(); w.seats[0].sandboxId = 'sb-next'; return { content: 'SECRET-STALE' }; };
  const lost = await s.submit(CODE1, uuid(8), '결과.txt');
  assert.equal(lost.status, 409);
  assert.equal(dumped(w).includes('SECRET-STALE'), false);
  const reads = countReads(w);
  assert.equal((await s.submit(CODE1, uuid(8), '결과.txt')).status, 409);
  assert.equal(countReads(w), reads);
});

await test('peers do not see each other and feedback stays with the owner', async () => {
  const w = world(), s = w.make();
  w.file = { content: 'SEAT1-ONLY-TEXT' };
  const mine = await s.submit(CODE1, uuid(9), '결과.txt');
  const peer = await s.seatStatus(CODE2);
  assert.equal(peer.submissions.length, 0);
  assert.equal(pub(peer).includes('SEAT1-ONLY-TEXT'), false);
  assert.equal(pub(peer).includes('participants'), false);
  const noted = await s.feedback(TOKEN, 'lab', 1, mine.submissions[0].id, 'FEEDBACK-ONLY-FOR-1');
  assert.equal(noted.participants.find((seat) => seat.n === 1).submissions[0].feedback, 'FEEDBACK-ONLY-FOR-1');
  const owner = await s.seatStatus(CODE1);
  assert.equal(owner.submissions[0].feedback, 'FEEDBACK-ONLY-FOR-1');
  const hidden = await s.seatStatus(CODE2);
  assert.equal(pub(hidden).includes('FEEDBACK-ONLY-FOR-1'), false);
  assert.equal(pub(hidden).includes('SEAT1-ONLY-TEXT'), false);
  assert.equal((await s.feedback(TOKEN, 'lab', 2, mine.submissions[0].id, '남의 자리')).status, 404);
});

await test('the eleventh submission and an http recording are rejected', async () => {
  const w = world(), s = w.make();
  w.file = { content: '버전' };
  for (let n = 1; n <= 10; n++) {
    const view = await s.submit(CODE1, uuid(20 + n), '결과.txt');
    assert.equal(view.submissions.length, n);
  }
  assert.equal((await s.submit(CODE1, uuid(40), '결과.txt')).status, 409);
  assert.equal((await s.seatStatus(CODE1)).submissions.length, 10);
  assert.equal((await s.update(TOKEN, 'lab', 0, { recordingUrl: 'http://example.com/rec' })).status, 400);
  assert.equal((await s.update(TOKEN, 'lab', 0, { recordingUrl: 'https://user:pw@example.com/rec' })).status, 400);
  const saved = await s.update(TOKEN, 'lab', 0, { recordingUrl: 'https://example.com/rec' });
  assert.equal(saved.classroom.recordingUrl, 'https://example.com/rec');
  assert.equal(pub(saved).includes(CODE1), false);
  assert.equal(pub(saved).includes('sb-1'), false);
});

await test('replaced pending submissions do not exhaust the new sandbox', async () => {
  const w=world(),s=w.make();
  w.deps.readFile=async()=>{w.seats[0].sandboxId+='-next';return {content:'버릴 내용'}};
  for(let i=1;i<=5;i++) assert.equal((await s.submit(CODE1,uuid(100+i),'결과.txt')).status,409);
  w.deps.readFile=async()=>({content:'새 실습실 결과'});
  const saved=await s.submit(CODE1,uuid(110),'결과.txt');
  assert.equal(saved.submissions.length,1);
  assert.equal(saved.submissions[0].content,'새 실습실 결과');
  assert.equal((await s.submit(CODE1,uuid(105),'결과.txt')).status,409);
});

await test('end retry never extends retention and a failed retain survives live lab removal', async () => {
  const w=world(),s=w.make();
  await s.submit(CODE1,uuid(120),'결과.txt');
  await s.retain('lab',[{n:1,who:'가람'}]);
  const original=w.data.get(M.classroomDocKey('lab')).retainUntil;
  w.time+=3600000;
  await s.retain('lab',[{n:1,who:'가람'}]);
  assert.equal(w.data.get(M.classroomDocKey('lab')).retainUntil,original);
  const x=world(),service=x.make();
  await service.submit(CODE1,uuid(121),'결과.txt');
  const originalPut=x.storage.put;
  x.storage.put=async(k,v)=>{if(k===M.classroomDocKey('lab'))throw Error('temporary storage failure');return originalPut(k,v)};
  await assert.rejects(service.retain('lab',[{n:1,who:'가람'}]));
  assert.ok(x.data.has('labclassroom-retain:lab'));
  x.present=false;x.ended=true;x.storage.put=originalPut;
  await service.alarm(x.time+60000);
  assert.equal(x.data.has('labclassroom-retain:lab'),false);
  assert.equal((await service.status(TOKEN,'lab')).participants[0].submissions.length,1);
  x.time+=M.CLASSROOM_RETENTION_MS+1;
  await service.alarm(x.time);
  assert.equal(x.data.has(M.classroomSeatKey('lab',1)),false);
});

await test('retention GC advances past 128 active courses', async () => {
  const w=world(),s=w.make();
  await s.update(TOKEN,'lab',0,{title:'기준'});
  const doc=w.data.get(M.classroomDocKey('lab'));
  w.data.delete(M.classroomDocKey('lab'));
  for(let i=0;i<130;i++)w.data.set(M.classroomDocKey('a'+String(i).padStart(3,'0')),structuredClone(doc));
  w.data.set(M.classroomDocKey('z-ended'),{...structuredClone(doc),endedAt:w.time-1000,retainUntil:w.time-1});
  w.data.set(M.classroomSeatKey('z-ended',1),{private:'expired'});
  await s.alarm(w.time);
  assert.ok(w.data.has(M.classroomDocKey('z-ended')));
  await s.alarm(w.time+60000);
  assert.equal(w.data.has(M.classroomDocKey('z-ended')),false);
  assert.equal(w.data.has(M.classroomSeatKey('z-ended',1)),false);
});

await test('history lists only retained ended courses, excludes expired and requires admin twice', async () => {
  const w = world(), s = w.make();
  await s.update(TOKEN, 'lab', 0, {title:'지난 모임'});
  assert.deepEqual((await s.history(TOKEN)).courses, []);
  await s.retain('lab', [{n:1,who:'가람'}]);
  const until=w.data.get(M.classroomDocKey('lab')).retainUntil;
  assert.deepEqual((await s.history(TOKEN)).courses, [{id:'lab',title:'지난 모임',endedAt:w.time,retainUntil:until}]);
  assert.equal((await s.history(TEACHER)).status,401);
  let authCalls=0;w.deps.checkAdmin=async()=>++authCalls===1;
  assert.equal((await s.history(TOKEN)).status,401);
  w.deps.checkAdmin=async t=>t===TOKEN;
  w.time=until;
  assert.deepEqual((await s.history(TOKEN)).courses,[]);
});

function depsRead(w) { return () => { w._reads = (w._reads ?? 0) + 1; }; }
function countReads(w) { return w._reads ?? 0; }

console.log('PASS classroom service conflicts, retention, isolation', pass);
