import { loadEnv } from '@cag/config';
import { checkDatabase } from '@cag/db';
import Fastify from 'fastify';

/**
 * Health-only API skeleton.
 *
 * Readiness reports real process and dependency reachability. It never reports a
 * hard-coded product health value — the product surface arrives in module 11.
 */
const env = loadEnv();
const app = Fastify({ logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' } });

const startedAt = Date.now();

app.get('/v1/health/live', async () => ({
  status: 'live',
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
}));

app.get('/v1/health/ready', async (_request, reply) => {
  // Dependency detail only. No secrets, no connection strings, no RPC URLs.
  const database = await checkDatabase(env.DATABASE_URL);
  const components = [{ name: 'database', ok: database.ok, detail: database.detail }];
  const ready = components.every((c) => c.ok);
  return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready', components });
});

const port = Number(new URL(env.API_PUBLIC_BASE_URL).port || 4000);
await app.listen({ port, host: '0.0.0.0' });
