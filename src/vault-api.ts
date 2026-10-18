// 금고 POST API (/api/vault/*). /api/vault/ 밖이면 null (본문을 읽지 않는다).
// /api/vault/ 아래면 모르는 이름이어도 본문을 먼저 읽고 null (예전 index.ts 와 같은 순서)

import type { ApiContext } from './api-context';

type Body = Record<string, any>;

export function vaultApi(c: ApiContext): Promise<Response | null> | null {
  if (!c.path.startsWith('/api/vault/')) return null;
  return vaultRoute(c);
}

async function vaultRoute(c: ApiContext) {
  const b = await c.body<Body>(c.req);
  const adm = c.req.headers.get('x-admin-token') ?? '';
  const name = c.path.slice(11);
  return vaultRead(c, name, b) ?? vaultWrite(c, name, b, adm);
}

async function send(c: ApiContext, r: PromiseLike<unknown>) {
  return c.out(await r);
}

/** 관리 토큰 없이 부르는 것 (상태·탭 열기·복구) */
function vaultRead(c: ApiContext, name: string, b: Body) {
  const { req, state, src } = c;
  switch (name) {
    case 'status': return send(c, state.vaultStatus());
    case 'options': return send(c, state.vaultOptions(typeof b.credId === 'string' ? b.credId : undefined, src));
    case 'open': return send(c, state.vaultOpen(b.assertion));
    case 'recover-info': return send(c, state.vaultRecoverInfo());
    case 'recover': return send(c, state.vaultRecover(b.code, b.verifier, req.headers.get('cf-connecting-ip') ?? ''));
  }
  return null;
}

/** 관리 토큰으로 바꾸는 것 (DO 가 토큰을 확인한다) */
function vaultWrite(c: ApiContext, name: string, b: Body, adm: string) {
  const { state } = c;
  switch (name) {
    case 'init': return send(c, state.vaultInit(adm, String(b.credId ?? ''), b.wrap, b.rec));
    case 'link': return send(c, state.vaultLink(adm, String(b.credId ?? ''), b.wrap));
    case 'recovery': return send(c, state.vaultSetRecovery(adm, b.rec));
    case 'item': return send(c, state.vaultPutItem(adm, b.item ?? {}));
    case 'item-delete': return send(c, state.vaultDeleteItem(adm, String(b.id ?? '')));
    case 'send': return send(c, state.sendDeliver(adm, String(b.id ?? ''), String(b.itemId ?? ''), b.box ?? {}));
    case 'recovery-code': return send(c, state.vaultRotateRecoveryCode(adm));
  }
  return null;
}
