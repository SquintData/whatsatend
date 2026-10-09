import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDatabase, type Database } from './db.js';
import { directChat } from './automation.js';

export type ChannelScope = 'disabled' | 'test' | 'all';

export async function setChannelScope(
  db: Database, instance: string, session: string, scope: ChannelScope, testChatId?: string,
): Promise<void> {
  if (scope === 'test' && (!testChatId || !directChat(testChatId))) throw new Error('test scope requires an exact direct chat ID');
  if (scope !== 'test' && testChatId) throw new Error('chat ID is only valid for test scope');
  await db.transaction(async tx => {
    const channel = await tx.query<{ id: string }>(
      'SELECT id FROM channels WHERE instance = $1 AND session = $2 FOR UPDATE', [instance, session]);
    if (!channel.rows[0]) throw new Error('Channel not found');
    const id = channel.rows[0].id;
    await tx.query(`UPDATE channels SET automation_scope = $2, automation_test_chat_id = $3,
      automation_activated_at = CASE WHEN $2 = 'disabled' THEN NULL ELSE now() END WHERE id = $1`,
      [id, scope, scope === 'test' ? testChatId : null]);
    await tx.query(`UPDATE reply_jobs SET state = 'cancelled', completed_at = now()
      WHERE channel_id = $1 AND state IN ('pending','generating')`, [id]);
    if (scope === 'disabled') {
      await tx.query(`UPDATE conversations SET mode = 'monitoring', automation_epoch = automation_epoch + 1,
        automation_started_at = NULL,
        control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint)
        WHERE channel_id = $1 AND mode = 'auto'`, [id]);
    }
  });
}

function parseArgs(args: string[]): { instance: string; session: string; scope: ChannelScope; chatId?: string } {
  const [instance, session, scopeArg, extra] = args;
  if (!instance || !session || !['disabled', 'test', 'all'].includes(scopeArg ?? '')) {
    throw new Error('Usage: npm run channel:scope -- <instance> <session> disabled|test <chatId>|all --confirm-all');
  }
  if (scopeArg === 'all') {
    if (extra !== '--confirm-all' || args.length !== 4) throw new Error('all scope requires the explicit --confirm-all flag');
    return { instance, session, scope: 'all' };
  }
  if (scopeArg === 'test') {
    if (!extra || args.length !== 4 || !directChat(extra)) throw new Error('test scope requires one exact direct chat ID');
    return { instance, session, scope: 'test', chatId: extra };
  }
  if (args.length !== 3) throw new Error('disabled scope takes no chat ID');
  return { instance, session, scope: 'disabled' };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid channel scope arguments');
    process.exitCode = 1;
    return;
  }
  const { db, close } = createDatabase(process.env.DATABASE_URL);
  try {
    await setChannelScope(db, args.instance, args.session, args.scope, args.chatId);
    console.log(`Channel automation scope set to ${args.scope}; configuration values omitted`);
  } catch {
    console.error('Channel scope update failed; check instance/session and database migration');
    process.exitCode = 1;
  } finally { await close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
