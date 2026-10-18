// 관리·강사 POST API 라우터가 함께 받는 것 (index.ts 의 호스트·메서드·Origin·익명 본문 상한·출처 해시 검사를 지난 뒤에만 부른다)

import type { Env, State } from './state';

export interface ApiContext {
  req: Request;
  path: string;
  env: Env;
  state: DurableObjectStub<State>;
  /** 출처 해시 (익명 API 일 때만, 아니면 '') */
  src: string;
  /** x-admin-token */
  admin: string;
  /** index.ts 의 본문 파서 (익명 API 는 미리 읽어 둔 본문을 쓴다) */
  body: <T>(req: Request) => Promise<T>;
  json: (data: unknown, status?: number) => Response;
  out: (r: unknown) => Response;
}
