import { z } from 'zod';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';
import { Store } from './store.js';

const config = z.object({
  DATABASE_URL: z.string().url().refine(v => /^postgres(?:ql)?:\/\//.test(v)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
}).safeParse(process.env);
if (!config.success) {
  console.error('Invalid configuration: check DATABASE_URL and PORT');
  process.exit(1);
}
const { db, close } = createDatabase(config.data.DATABASE_URL);
const app = buildApp(new Store(db), true);
app.addHook('onClose', close);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
try {
  await db.query('SELECT 1 FROM channels LIMIT 1');
  await app.listen({ host: '0.0.0.0', port: config.data.PORT });
} catch {
  console.error('Startup failed: check database availability and run migrations');
  await app.close();
  process.exitCode = 1;
}
