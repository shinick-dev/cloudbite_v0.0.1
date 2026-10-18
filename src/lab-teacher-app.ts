// 강사 /lab 설치 앱 (k.shinick.dev). 참가자 런처(lab.shinick.dev, src/labhost.ts)와 출처·id·이름이 다른 별도 앱이다.
//   GET /__teacher/manifest.webmanifest   id·start_url·scope = /lab
//   GET /__teacher/icon-<192|512>.png     실습실 아이콘을 그대로 (src/labicons.ts — 참가자 쪽은 건드리지 않는다)
//   GET /lab/teacher-sw.js                scope /lab 전용 서비스 워커 (Service-Worker-Allowed: /lab)
// 서비스 워커는 아무것도 저장하지 않는다: HTML·/api·쿠키·초대·참가자 이름·공급자 응답은 전부 네트워크로만 간다.
// /lab 화면 이동이 네트워크에서 실패할 때만 사용자 데이터가 없는 고정 안내 문서를 그 자리에서 만들어 돌려준다 (캐시 아님).
// push 는 고정 종류(tag)만 구분해 일반 알림을 띄운다. 서버 문구·주소는 사용하지 않는다.
// /admin·/vault·/borrow 와 참가자 호스트는 scope 밖이라 이 워커가 제어하지 않는다.

import { ICON_192, ICON_512 } from './labicons';

import { TEACHER_MANIFEST, TEACHER_SCOPE, TEACHER_SW } from './pages';

// index.ts 의 CSP 와 같은 값 + /lab 응답에서만 manifest-src·worker-src 'self'. index.ts 를 바꾸면 여기도 같이 맞춘다
const BASE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const TEACHER_CSP = BASE_CSP + "; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:";

const MANIFEST = JSON.stringify({
  id: TEACHER_SCOPE, name: '공부방 실습실 모임지기', short_name: '실습실 모임지기', lang: 'ko',
  start_url: TEACHER_SCOPE, scope: TEACHER_SCOPE, display: 'standalone', background_color: '#f7f7f5', theme_color: '#0f172a',
  icons: [192, 512].flatMap((n) => ['any', 'maskable'].map((purpose) => ({ src: `/__teacher/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose }))),
});

const OFFLINE = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>공부방 실습실</title>'
  + '<style>body{margin:0;background:#f7f7f5;color:#1c1c1a;font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:24px 16px}a{color:#2f5bea}'
  + '@media (prefers-color-scheme:dark){body{background:#141413;color:#ecebe6}a{color:#7c9bff}}</style></head>'
  + '<body><main><h1 style="font-size:20px">공부방 실습실</h1><p>연결이 없어 화면을 열지 못했습니다. 이 앱은 수업 정보를 기기에 저장하지 않으니, 연결이 돌아오면 다시 여세요.</p><p><a href="/lab">다시 열기</a></p></main></body></html>';

// 손들기 Web Push 알림: 고정 문구만 (서버가 보낸 내용과 상관없이)
export const PUSH_TITLE = '공부방 실습실', PUSH_BODY = '참여자가 손을 들었습니다. 모임지기 화면에서 확인하세요.', PUSH_ICON = '/__teacher/icon-192.png', PUSH_TAG = 'gw-teacher-hand';

export const TEACHER_SW_JS = `// 강사 앱 서비스 워커 — 저장 없음 (Cache Storage·IndexedDB 안 씀). scope ${TEACHER_SCOPE}
const OFFLINE=${JSON.stringify(OFFLINE)};
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const r=e.request;
 if(r.method!=='GET'||r.mode!=='navigate')return; // /api·스크립트·이미지 등은 손대지 않는다 → 브라우저가 네트워크로
 const u=new URL(r.url);if(u.origin!==location.origin||![${JSON.stringify(TEACHER_SCOPE)},'/lab/requests'].includes(u.pathname))return;
 e.respondWith(fetch(r).catch(()=>new Response(OFFLINE,{status:503,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})));
});
// tag만 고정 allowlist와 대조한다. 이름·본문·주소 등은 읽어 쓰지 않는다.
const N_TITLE=${JSON.stringify(PUSH_TITLE)},N_OPT={body:${JSON.stringify(PUSH_BODY)},icon:${JSON.stringify(PUSH_ICON)},tag:${JSON.stringify(PUSH_TAG)},renotify:true};
const REQUEST_BODY='실습실 개설 요청이 있습니다. 요청함에서 확인하세요.';
self.addEventListener('push',e=>{let request=false;try{request=e.data?.json()?.tag==='lab-open-request'}catch{}
 const opt=request?{body:REQUEST_BODY,icon:N_OPT.icon,tag:'gw-lab-open-request',renotify:true,data:{kind:'open-request'}}:Object.assign({},N_OPT);
 e.waitUntil(self.registration.showNotification(N_TITLE,opt))});
// 누르면: 알림을 닫고 같은 출처의 ${TEACHER_SCOPE} 창(경로가 정확히 같을 때만)을 앞으로, 없으면 고정 주소 ${TEACHER_SCOPE} 를 새로 연다. 알림에 실린 주소는 쓰지 않는다
self.addEventListener('notificationclick',e=>{e.notification.close();
 e.waitUntil((async()=>{const target=e.notification.data?.kind==='open-request'?'/lab/requests':${JSON.stringify(TEACHER_SCOPE)};const home=new URL(target,location.origin).href;
  const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const c of all){let u;try{u=new URL(c.url)}catch{continue}
   if(u.origin===location.origin&&u.pathname===target&&c.focus){try{return await c.focus()}catch{}}}
  return self.clients.openWindow(home)})())});
`;

const png = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const ICONS: Record<string, Uint8Array> = { '/__teacher/icon-192.png': png(ICON_192), '/__teacher/icon-512.png': png(ICON_512) };

/** 강사 앱 정적 GET. 해당 없으면 null. sec = index.ts SECURITY_HEADERS (no-store·nosniff 등) */
export function teacherAppGet(path: string, sec: Record<string, string>): Response | null {
  if (path === TEACHER_MANIFEST) return new Response(MANIFEST, { headers: { ...sec, 'content-type': 'application/manifest+json' } });
  if (path === TEACHER_SW)
    return new Response(TEACHER_SW_JS, { headers: { ...sec, 'content-type': 'text/javascript; charset=utf-8', 'service-worker-allowed': TEACHER_SCOPE } });
  const icon = ICONS[path];
  if (icon) return new Response(icon, { headers: { ...sec, 'content-type': 'image/png', 'cache-control': 'max-age=3600' } });
  return null;
}

/** /lab 화면 응답: 공통 보안 헤더 + manifest·worker 를 허용한 CSP (이 경로에만) */
export const teacherHtml = (body: string, sec: Record<string, string>, frameSource = '') =>
  new Response(body, { headers: { ...sec, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': TEACHER_CSP + (frameSource ? '; frame-src '+frameSource : '') } });
