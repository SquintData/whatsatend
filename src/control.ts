import { createDatabase } from './db.js';
import { loadAutomation } from './automation.js';
import { Store } from './store.js';

const action = process.argv[2];
if (!['resume', 'pause'].includes(action ?? '') || !process.env.DATABASE_URL) {
  console.error('Usage: node dist/control.js resume|pause, with configured database and test scope');
  process.exit(1);
}
const { db, close } = createDatabase(process.env.DATABASE_URL);
try {
  await new Store(db, loadAutomation(process.env)).control(action as 'resume' | 'pause');
  console.log(action === 'resume' ? 'Test automation resumed for NEW messages only' : 'Test automation paused');
} catch {
  console.error('Control failed; check enabled flag, test scope, existing conversation and migrations');
  process.exitCode = 1;
} finally { await close(); }
