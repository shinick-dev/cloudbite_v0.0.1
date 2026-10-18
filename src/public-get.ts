// k.shinick.dev 의 GET: 화면·스크립트·예전 링크 이동·승인 요청 정보·프리셋. 맞는 경로가 없으면 404.
// index.ts 가 호스트 검사와 /p/ 프록시를 지난 뒤 GET 일 때만 부른다

import { adminPage, approvePage, borrowPage, labPage, prfPage, recvPage, registerPage, vaultPage, WEBAUTHN_JS } from './pages';
import GO from './go.ps1';
import { teacherAppGet, teacherHtml } from './lab-teacher-app';
import { LAB_ASSISTANT_HTML } from './lab-assistant-page';
import { labOpenParticipantPage, labOpenManagerPage } from './lab-open-pages';
import { PRESETS } from './providers';
import type { Env, State } from './state';
import { cloudbitePage } from './cloudbite-api';

export interface PublicGet {
  path: string;
  url: URL;
  env: Pick<Env, 'ORIGIN' | 'LAB_ORIGIN' | 'RP_ID' | 'LAB_SEAT_DOMAIN'>;
  state: Pick<DurableObjectStub<State>, 'requestInfo'>;
  /** index.ts 의 SECURITY_HEADERS */
  sec: Record<string, string>;
  html: (body: string) => Response;
  json: (data: unknown, status?: number) => Response;
  out: (r: unknown) => Response;
}

export async function publicGet({ path, url, env, state, sec, html, json, out }: PublicGet): Promise<Response> {
  const m = (re: RegExp) => path.match(re);
  let g: RegExpMatchArray | null;
  const cloudbite = cloudbitePage(path, sec); // '/' 는 Cloudbite 콘솔. 예전 /borrow 는 그대로
  if (cloudbite) return cloudbite;
  if (path === '/borrow') return html(borrowPage());
  if (path === '/register') return html(registerPage());
  if (path === '/admin') return html(adminPage());
  if (path === '/prf') return html(prfPage(env.RP_ID));
  if (path === '/vault') return html(vaultPage());
  if (path === '/recv') return html(recvPage());
  if (path === '/lab') {
    const domain=env.LAB_SEAT_DOMAIN||'';
    const source=/^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?$/i.test(domain)?new URL(env.LAB_ORIGIN).protocol+'//*.'+domain:'';
    return teacherHtml(labPage(domain), sec, source);
  }
  if (path === '/lab/request') return html(labOpenParticipantPage(env.LAB_ORIGIN));
  if (path === '/lab/requests') return teacherHtml(labOpenManagerPage(), sec);
  if (path === '/lab/assistant') return html(LAB_ASSISTANT_HTML);
  const app = teacherAppGet(path, sec);
  if (app) return app;
  if ((g = m(/^\/j\/([\w-]{16})$/))) return Response.redirect(`${env.LAB_ORIGIN}/j/${g[1]}`, 302); // 예전 자리 링크
  if (path === '/go')
    return new Response(GO.replace("'__GW__'", `'${env.ORIGIN}'`), { headers: { ...sec, 'content-type': 'text/plain; charset=utf-8' } });
  if ((g = m(/^\/a\/([\w-]{16})$/))) return html(approvePage(g[1]));
  if (path === '/webauthn.js')
    return new Response(WEBAUTHN_JS, { headers: { ...sec, 'content-type': 'text/javascript; charset=utf-8' } });
  if ((g = m(/^\/api\/approve\/([\w-]{16})$/))) return out(await state.requestInfo(g[1]));
  if (path === '/api/presets') return json(PRESETS);
  return json({ error: 'not found' }, 404);
}
