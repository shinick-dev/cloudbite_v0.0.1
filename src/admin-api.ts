// 관리 POST API (/api/admin/*). 경로가 맞지 않으면 null — 본문을 읽지 않고 DO 도 부르지 않는다

import type { ApiContext } from './api-context';

export async function adminApi(c: ApiContext): Promise<Response | null> {
  const { req, path, state, src, admin, body, out } = c;
  if (path === '/api/admin/options') return out(await state.adminOptions(src));
  if (path === '/api/admin/login') {
    const b = await body<{ assertion?: any; recoveryCode?: unknown }>(req);
    return out(await state.adminLogin(b.assertion, b.recoveryCode === true));
  }
  if (path === '/api/admin/list') return out(await state.adminList(admin));
  if (path === '/api/admin/revoke') return out(await state.adminRevoke(admin, String((await body<{ target?: string }>(req)).target ?? '')));
  if (path === '/api/admin/provider') return out(await state.adminUpsertProvider(admin, await body<Record<string, unknown>>(req)));
  if (path === '/api/admin/provider-delete') return out(await state.adminDeleteProvider(admin, String((await body<{ id?: string }>(req)).id ?? '')));
  if (path === '/api/admin/cred-delete') return out(await state.adminDeleteCred(admin, String((await body<{ id?: string }>(req)).id ?? '')));
  return null;
}
