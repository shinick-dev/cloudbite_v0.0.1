/** The desktop has its own origin, distinct from the owner app AND its WebAuthn RP. No provider secrets live here. */
const PREFIX='/p/_cloudbite/computer/desktop';
export default {
  async fetch(req: Request, env: {COMPUTER_CONTROL: Fetcher}): Promise<Response> {
    const u=new URL(req.url);
    if(u.pathname!==PREFIX && !u.pathname.startsWith(PREFIX+'/'))return new Response('Not found',{status:404});
    return env.COMPUTER_CONTROL.fetch(req);
  },
};
