// 강사 공부방 POST API (/api/lab/*). 경로가 맞지 않으면 null — 본문을 읽지 않고 DO 도 부르지 않는다

import { renderSVG } from 'uqr';
import type { ApiContext } from './api-context';
import { type CreatePending } from './lab-create-service';
import { isSnapPending } from './lab-snapshot-service';
import { labTeacherApi } from './lab-teacher-api';
import { labLiveApi } from './lab-live-api';
import { labAssistantApi } from './lab-assistant-api';
import { isFail } from './state';
import { labTerminalApi } from './lab-terminal-api';
import { labControlApi } from './lab-control-api';
import { labTrialApi } from './lab-trial-api';
import { labInterruptApi } from './lab-interrupt-api';
import { labCheckpointApi } from './lab-checkpoint-api';
import { labClassroomApi } from './lab-classroom-api';
import { labSeatRecoveryApi } from './lab-seat-recovery-api';
import { labOpenApi } from './lab-open-api';
import { labAdminSessionApi } from './lab-admin-session';
import { labSeatAddApi } from './lab-seat-add-api';

export function labApi(c: ApiContext): Promise<Response> | null {
  return labAdminSessionApi(c) ?? labSeatAddApi(c) ?? labOpenApi(c) ?? labLiveApi(c) ?? labAssistantApi(c) ?? labTeacherApi(c) ?? labControlApi(c) ?? labTrialApi(c) ?? labInterruptApi(c) ?? labCheckpointApi(c) ?? labClassroomApi(c) ?? labSeatRecoveryApi(c) ?? labTerminalApi(c) ?? labLifecycle(c) ?? labPolicy(c) ?? labContent(c) ?? labScreen(c);
}

async function send(c: ApiContext, r: PromiseLike<unknown>) {
  return c.out(await r);
}

/** 본문의 id 만 쓰는 것: 본문을 읽고 그 id 로 DO 를 부른다 */
async function byId(c: ApiContext, rpc: (id: string) => PromiseLike<unknown>) {
  const id = String((await c.body<{ id?: string }>(c.req)).id ?? '');
  return c.out(await rpc(id));
}

function labLifecycle(c: ApiContext) {
  const { path, state, admin } = c;
  switch (path) {
    case '/api/lab/config': return send(c, state.labConfig(admin));
    case '/api/lab/create': return labCreate(c);
    case '/api/lab/create-status': return labCreateStatus(c);
    case '/api/lab/snapshot': return labSnapshot(c);
    case '/api/lab/list': return labList(c);
    case '/api/lab/invite': return labInvite(c);
    case '/api/lab/end': return byId(c, (id) => state.labEnd(admin, id));
  }
  return null;
}

/** 스냅샷 준비 중은 실패가 아니다 → 202 (본문은 고정 모양 그대로). 그 밖은 예전 out (Fail → 그 상태, 나머지 200) */
function prepOut(c: ApiContext, r: unknown) {
  return isSnapPending(r) ? c.json({ snapshotPreparing: true, snapshot: r.snapshot, state: r.state, retryAfterMs: r.retryAfterMs }, 202) : c.out(r);
}

function createOut(c: ApiContext, r: unknown) {
  if (r && typeof r === 'object' && 'creationState' in r && ['preparing', 'running', 'unknown'].includes((r as CreatePending).creationState)) return c.json(r, 202);
  return prepOut(c, r);
}
async function labCreate(c: ApiContext) {
  return createOut(c, await c.state.labCreate(c.admin, await c.body<Record<string, unknown>>(c.req)));
}
async function labCreateStatus(c: ApiContext) {
  if (!c.admin) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  if (Number(c.req.headers.get('content-length') ?? 0) > 256) return c.json({ error: '본문이 너무 큽니다.' }, 413);
  const reader = c.req.body?.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let requestId: string;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256) { void reader.cancel().catch(() => {}); return c.json({ error: '본문이 너무 큽니다.' }, 413); }
      parts.push(value);
    }
    const all = new Uint8Array(bytes);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.byteLength; }
    const b: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all));
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || !('requestId' in b) || typeof b.requestId !== 'string' || b.requestId.length !== 49 || !/^lc_\d{13}_[a-f0-9]{32}$/.test(b.requestId)) return c.json({ error: '만들기 요청 ID가 올바르지 않습니다.' }, 400);
    requestId = b.requestId;
  } catch { return c.json({ error: '만들기 요청 상태를 확인하지 못했습니다.' }, 400); }
  finally { reader?.releaseLock(); }
  try { return createOut(c, await c.state.labCreateStatus(c.admin, requestId)); }
  catch { return c.json({ error: '만들기 요청 상태를 확인하지 못했습니다.' }, 503); }
}

/** 직접 입력 사양 스냅샷 준비: 본문에서 기본 이름·사양 네 칸만 넘긴다 (레시피·이미지·주소·env 는 받지 않는다) */
async function labSnapshot(c: ApiContext) {
  const b = await c.body<{ snapshot?: unknown; cpu?: unknown; memory?: unknown; disk?: unknown }>(c.req);
  return prepOut(c, await c.state.labSnapshotPrepare(c.admin, { snapshot: b.snapshot, cpu: b.cpu, memory: b.memory, disk: b.disk }));
}

async function labList(c: ApiContext) {
  const r = await c.state.labList(c.admin);
  if (isFail(r)) return c.out(r);
  return c.json(r); // 자리 코드·초대 링크는 싣지 않는다 (/api/lab/invite 로 따로)
}

/** 자리 초대 링크(QR): n 이 있으면 그 자리 하나 + QR, 없으면 쓸 수 있는 자리 전부 (링크만) */
async function labInvite(c: ApiContext) {
  const { req, env, state, admin, body, json, out } = c;
  const b = await body<{ id?: string; n?: unknown }>(req);
  const one = b.n !== undefined && b.n !== null;
  if (one && !Number.isInteger(b.n)) return json({ error: '자리 번호가 올바르지 않습니다.' }, 400);
  const r = await state.labInvite(admin, String(b.id ?? ''), one ? Number(b.n) : undefined);
  if (isFail(r)) return out(r);
  const seats = r.seats.map((x) => ({ n: x.n, who: x.who, link: `${env.LAB_ORIGIN}/j/${x.code}` }));
  return json(one ? { ...seats[0], name: r.name, qr: renderSVG(seats[0].link) } : { name: r.name, seats });
}

function labPolicy(c: ApiContext) {
  switch (c.path) {
    case '/api/lab/clip': return labClip(c);
    case '/api/lab/share': return labShare(c);
    case '/api/lab/hand': return labHand(c);
  }
  return null;
}

async function labClip(c: ApiContext) {
  const b = await c.body<{ id?: string; in?: boolean; out?: boolean }>(c.req);
  return c.out(await c.state.labSetClip(c.admin, String(b.id ?? ''), { in: b.in !== false, out: b.out !== false }));
}

async function labShare(c: ApiContext) {
  const b = await c.body<{ id?: string; provider?: string; on?: unknown; cap?: unknown }>(c.req);
  return c.out(await c.state.labSetShare(c.admin, String(b.id ?? ''), String(b.provider ?? ''), b.on, b.cap));
}

async function labHand(c: ApiContext) {
  const b = await c.body<{ id?: string; n?: number }>(c.req);
  return c.out(await c.state.labHandClear(c.admin, String(b.id ?? ''), Number(b.n)));
}

// 코드 보내기 (참가자 막대의 📥 받은 코드)
function labContent(c: ApiContext) {
  const { path, state, admin } = c;
  switch (path) {
    case '/api/lab/snips': return byId(c, (id) => state.labSnips(admin, id));
    case '/api/lab/snip': return labSnipAdd(c);
    case '/api/lab/snip-delete': return labSnipDelete(c);
  }
  return null;
}

async function labSnipAdd(c: ApiContext) {
  const b = await c.body<{ id?: string; text?: unknown; title?: unknown }>(c.req);
  return c.out(await c.state.labSnipAdd(c.admin, String(b.id ?? ''), b.text, b.title));
}

async function labSnipDelete(c: ApiContext) {
  const b = await c.body<{ id?: string; snip?: string }>(c.req);
  return c.out(await c.state.labSnipDelete(c.admin, String(b.id ?? ''), String(b.snip ?? '')));
}

// 강사 화면 공유 (Realtime SFU) — 이 탭의 offer 를 SFU 에 올린다. 앱 비밀은 DO 안에서만
function labScreen(c: ApiContext) {
  const { path, state, admin } = c;
  switch (path) {
    case '/api/lab/screen/start': return labScreenStart(c);
    case '/api/lab/screen/stop': return byId(c, (id) => state.labScreenStop(admin, id));
    case '/api/lab/screen/status': return send(c, state.labScreenList(admin));
  }
  return null;
}

async function labScreenStart(c: ApiContext) {
  const b = await c.body<{ id?: string; sdp?: unknown; tracks?: unknown }>(c.req);
  return c.out(await c.state.labScreenStart(c.admin, String(b.id ?? ''), b.sdp, b.tracks));
}
