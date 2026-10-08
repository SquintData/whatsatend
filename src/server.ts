import { z } from 'zod';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';
import { Store } from './store.js';
import { loadAutomation, WahaSender, type Automation } from './automation.js';
import { startWorker } from './worker.js';

const config = z.object({
  DATABASE_URL: z.string().url().refine(v => /^postgres(?:ql)?:\/\//.test(v)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
}).safeParse(process.env);
if (!config.success) {
  console.error('Invalid configuration: check DATABASE_URL and PORT');
  process.exit(1);
}
const { db, close } = createDatabase(config.data.DATABASE_URL);
let automation: Automation;
try { automation = loadAutomation(process.env); }
catch {
  console.error('Invalid automation configuration: check enabled flag, scope, test chat, WAHA URL and key');
  await close();
  process.exit(1);
}
const store = new Store(db, automation);
const app = buildApp(store, true);
let worker: ReturnType<typeof startWorker> | undefined;
app.addHook('onClose', async () => { await worker?.stop(); await close(); });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
try {
  await db.query('SELECT 1 FROM reply_jobs LIMIT 1');
  await db.query('SELECT control_timestamp FROM conversations LIMIT 1');
  await db.query('SELECT 1 FROM reaction_commands LIMIT 1');
  await app.listen({ host: '0.0.0.0', port: config.data.PORT });
  if (automation.enabled) worker = startWorker(store, new WahaSender(automation), message => app.log.error(message));
  app.log.info({ enabled: automation.enabled }, 'Fixed test reply configuration loaded');
} catch {
  console.error('Startup failed: check database availability and run migrations');
  await app.close();
  process.exitCode = 1;
}
