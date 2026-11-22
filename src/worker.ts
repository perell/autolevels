/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Worker entry. Every page needs ?token=<ADMIN_TOKEN>.
 * A cron every 5 minutes makes sure the agent's alarm is running.
 */
import { AgentDO, type Env } from './agent/durable';

export { AgentDO };

function stub(env: Env) {
  return env.AGENT.get(env.AGENT.idFromName('main'));
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) {
      return new Response('Set the ADMIN_TOKEN secret (at least 16 characters): npx wrangler secret put ADMIN_TOKEN', { status: 500 });
    }
    if (url.pathname.startsWith('/internal/')) return new Response('Not found', { status: 404 });
    const token = url.searchParams.get('token') ?? '';
    if (!sameSecret(token, env.ADMIN_TOKEN)) return new Response('Unauthorized: add ?token=<your ADMIN_TOKEN> to the URL', { status: 401 });
    return stub(env).fetch(req);
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(stub(env).fetch('https://agent/internal/ensure'));
  },
} satisfies ExportedHandler<Env>;
