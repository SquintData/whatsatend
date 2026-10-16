import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/db.js';
import { Store, tokenHash } from '../src/store.js';
import { directChat, FIXED_REPLY, type Automation, type Sender } from '../src/automation.js';
import type { AIContext, AIProvider } from '../src/ai.js';
import { setChannelScope } from '../src/channel-scope.js';

const chats = ['5511999999901@c.us', '5511999999902@c.us', '5511999999903@c.us'] as const;
const automation: Automation = {
  enabled: true, instance: '', session: '', chatId: '', wahaUrl: 'http://waha.test', apiKey: 'a'.repeat(32),
};

async function fixture(scopes: Array<{ scope: 'disabled' | 'test' | 'all'; testChatId?: string }> = [
  { scope: 'all' }, { scope: 'all' }, { scope: 'disabled' },
]) {
  const pg = new PGlite();
  for (const file of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql', '006_manual_send_claim.sql', '007_reaction_timestamp_precision.sql', '008_channel_onboarding_claim.sql', '009_global_waha_session_unique.sql', '010_ai_handoff_attention.sql']) {
    await pg.exec(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
  }
  const db: Database = {
    query: async <T>(sql: string, values?: unknown[]) => pg.query<T>(sql, values),
    transaction: fn => pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => tx.query<T>(sql, values) })),
  };
  const companies = scopes.map((_, i) => randomUUID());
  const channels = scopes.map((_, i) => randomUUID());
  const tokens = scopes.map((_, i) => String.fromCharCode(97 + i).repeat(64));
  for (let i = 0; i < scopes.length; i++) {
    await pg.query('INSERT INTO organizations(id,name,ai_enabled,ai_business_data) VALUES ($1,$2,true,$3)',
      [companies[i], `Company ${i}`, { business: `business-${i}` }]);
    await pg.query(`INSERT INTO channels(id,organization_id,instance,session,token_hash,automation_scope,automation_test_chat_id,automation_activated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6 = 'disabled' THEN NULL ELSE to_timestamp(floor(extract(epoch FROM now())) - 1) END)`,
      [channels[i], companies[i], `instance-${i}`, `session-${i}`, tokenHash(tokens[i]!), scopes[i]!.scope, scopes[i]!.testChatId ?? null]);
  }
  const conversations = new Map<number, string>();
  const getChannel = async (index: number) => {
    const result = await db.query<{ id: string; organization_id: string; session: string; instance: string }>(
      'SELECT id, organization_id, session, instance FROM channels WHERE id = $1', [channels[index]]);
    return result.rows[0]!;
  };
  const receive = async (index: number, id: string, from = chats[index]!, body = `message-${index}`, timestamp = Math.floor(Date.now() / 1000)) => {
    const store = new Store(db, automation);
    return store.receive(await getChannel(index), { id, from, fromMe: false, body, timestamp });
  };
  const sent: Array<{ session: string; chatId: string; text: string }> = [];
  const sender: Sender = { async send(request) { sent.push(request); return { id: `outgoing-${sent.length}` }; } };
  return { pg, db, companies, channels, tokens, conversations, getChannel, receive, sender, sent,
    store: (provider?: AIProvider) => new Store(db, automation, provider),
    async close() { await pg.close(); } };
}

test('worker sends separate AI replies to two companies through each channel session', async () => {
  const f = await fixture([{ scope: 'all' }, { scope: 'all' }]);
  const contexts: AIContext[] = [];
  const provider: AIProvider = { async generate(context) { contexts.push(context); return {
    decision: 'reply', reply: `reply-${context.companyName}`, handoffReason: null, inputTokens: 10, outputTokens: 3,
  }; } };
  try {
    const store = f.store(provider);
    await f.receive(0, 'msg-a');
    await f.receive(1, 'msg-b');
    assert.equal(await store.processNext(f.sender), true);
    assert.equal(await store.processNext(f.sender), true);
    assert.equal(contexts.length, 2);
    assert.deepEqual(new Set(contexts.map(context => context.businessData.business)), new Set(['business-0', 'business-1']));
    assert.deepEqual(new Set(f.sent.map(request => request.session)), new Set(['session-0', 'session-1']));
    assert.deepEqual(new Set(f.sent.map(request => request.text)), new Set(['reply-Company 0', 'reply-Company 1']));
  } finally { await f.close(); }
});

test('channel scope disabled, test and all control first-contact opt-in and reject groups', async () => {
  const f = await fixture([
    { scope: 'test', testChatId: chats[0] }, { scope: 'all' }, { scope: 'disabled' },
  ]);
  try {
    await f.receive(0, 'test-match', chats[0]!);
    await f.receive(0, 'test-other', chats[1]!);
    await f.receive(1, 'all-direct', chats[1]!);
    assert.equal(await f.receive(1, 'all-group', '120363000000000000@g.us'), false);
    await f.receive(2, 'disabled-direct', chats[2]!);
    const rows = await f.pg.query<{ instance: string; chat_id: string; mode: string }>(
      `SELECT c.instance, cv.chat_id, cv.mode FROM conversations cv JOIN channels c ON c.id = cv.channel_id ORDER BY c.instance, cv.chat_id`);
    const find = (instance: string, chat: string) => rows.rows.find(row => row.instance === instance && row.chat_id === chat);
    assert.equal(find('instance-0', chats[0]!)?.mode, 'auto');
    assert.equal(find('instance-0', chats[1]!)?.mode, 'monitoring');
    assert.equal(find('instance-1', chats[1]!)?.mode, 'auto');
    assert.equal(find('instance-2', chats[2]!)?.mode, 'monitoring');
    assert.equal((await f.pg.query('SELECT * FROM conversations WHERE chat_id LIKE \'%g.us\'')).rows.length, 0);
    assert.equal((await f.pg.query('SELECT count(*)::int AS count FROM reply_jobs')).rows[0]!.count, 2);
    assert.equal(directChat('120363000000000000@g.us'), false);
    assert.ok(FIXED_REPLY.length > 0);
  } finally { await f.close(); }
});

test('new channels remain opted out by the migration default', async () => {
  const f = await fixture([]);
  const company = randomUUID();
  const channel = randomUUID();
  try {
    await f.pg.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [company, 'Default disabled']);
    await f.pg.query('INSERT INTO channels(id,organization_id,instance,session,token_hash) VALUES ($1,$2,$3,$4,$5)',
      [channel, company, 'new-instance', 'new-session', tokenHash('d'.repeat(64))]);
    const result = await f.pg.query<{ automation_scope: string }>('SELECT automation_scope FROM channels WHERE id = $1', [channel]);
    assert.equal(result.rows[0]!.automation_scope, 'disabled');
  } finally { await f.close(); }
});

test('activation second boundary rejects earlier events but accepts later direct messages', async () => {
  const f = await fixture([{ scope: 'all' }]);
  try {
    const now = Math.floor(Date.now() / 1000);
    const activatedSecond = now - 10;
    await f.pg.query('UPDATE channels SET automation_activated_at = to_timestamp($2::double precision + 0.25) WHERE id = $1', [f.channels[0], activatedSecond]);
    await f.receive(0, 'same-second-before-activation', chats[0], 'must not respond', activatedSecond);
    await f.receive(0, 'delayed-after-activation', chats[1], 'arrived late', activatedSecond + 1);
    await f.receive(0, 'event-before-activation', chats[2], 'must not respond', activatedSecond - 1);
    const jobs = await f.pg.query<{ provider_message_id: string }>(
      `SELECT m.provider_message_id FROM reply_jobs j JOIN messages m ON m.id = j.source_message_id ORDER BY j.created_at`);
    assert.deepEqual(jobs.rows.map(row => row.provider_message_id), ['delayed-after-activation']);

    const existingConversation = await f.pg.query<{ id: string }>(
      'SELECT id FROM conversations WHERE channel_id = $1 AND chat_id = $2', [f.channels[0], chats[0]]);
    const conversationId = existingConversation.rows[0]!.id;
    await f.pg.query(`INSERT INTO messages(id,organization_id,channel_id,conversation_id,provider_message_id,direction,body,provider_timestamp)
      VALUES ($1,$2,$3,$4,$5,'incoming','old target',$6)`,
      [randomUUID(), f.companies[0], f.channels[0], conversationId, 'same-second-reaction-target', activatedSecond]);
    assert.equal(await f.store().react(await f.getChannel(0), {
      id: 'same-second-reaction', timestamp: activatedSecond, fromMe: true, source: 'app',
      reaction: { text: '\u{1f916}', messageId: 'same-second-reaction-target' },
    }), 'ignored_state_or_timestamp');
  } finally { await f.close(); }
});

test('administrative disable cancels queued work and clears auto mode for the channel', async () => {
  const f = await fixture([{ scope: 'all' }]);
  try {
    await f.receive(0, 'disable-me');
    await setChannelScope(f.db, 'instance-0', 'session-0', 'disabled');
    const status = await f.pg.query<{ automation_scope: string; automation_activated_at: Date | null }>(
      'SELECT automation_scope, automation_activated_at FROM channels WHERE id = $1', [f.channels[0]]);
    assert.equal(status.rows[0]!.automation_scope, 'disabled');
    assert.equal(status.rows[0]!.automation_activated_at, null);
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.mode, 'monitoring');
  } finally { await f.close(); }
});

test('worker claim and final send reject a source timestamp in the activation second', async () => {
  const f = await fixture([{ scope: 'test', testChatId: chats[0] }, { scope: 'test', testChatId: chats[1] }]);
  try {
    const sourceSecond = Math.floor(Date.now() / 1000);
    await f.pg.query('UPDATE organizations SET ai_enabled = false');
    await f.pg.query('UPDATE channels SET automation_activated_at = to_timestamp($2) WHERE id = ANY($1)',
      [[f.channels[0], f.channels[1]], sourceSecond - 1]);
    await f.receive(0, 'claim-boundary', chats[0], 'claim boundary', sourceSecond);
    await f.pg.query('UPDATE channels SET automation_activated_at = to_timestamp($2::double precision + 0.25) WHERE id = $1',
      [f.channels[0], sourceSecond]);
    assert.equal(await f.store().processNext(f.sender), false);

    await f.receive(1, 'final-boundary', chats[1], 'final boundary', sourceSecond);
    let updateActivationAfterClaim = true;
    const delayedDb: Database = {
      transaction: fn => f.db.transaction(fn),
      async query<T>(sql: string, values?: unknown[]) {
        const result = await f.db.query<T>(sql, values);
        if (updateActivationAfterClaim && sql.includes('WITH candidate')) {
          updateActivationAfterClaim = false;
          await f.pg.query('UPDATE channels SET automation_activated_at = to_timestamp($2::double precision + 0.25) WHERE id = $1',
            [f.channels[1], sourceSecond]);
        }
        return result;
      },
    };
    assert.equal(await new Store(delayedDb, automation).processNext(f.sender), true);
    assert.equal(f.sent.length, 0);
    const state = await f.pg.query<{ state: string }>(
      `SELECT state FROM reply_jobs WHERE source_message_id IN (SELECT id FROM messages WHERE provider_message_id = 'final-boundary')`);
    assert.equal(state.rows[0]!.state, 'cancelled');
  } finally { await f.close(); }
});

test('robot reaction resumes only a conversation in the authenticated channel scope', async () => {
  const f = await fixture([{ scope: 'test', testChatId: chats[0] }, { scope: 'test', testChatId: chats[1] }]);
  try {
    await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode)
      VALUES ($1,$2,$3,$4,'human')`, [randomUUID(), f.companies[0], f.channels[0], chats[0]]);
    await f.receive(0, 'reaction-target');
    const store = f.store();
    const reaction = { id: 'react-cross-channel', timestamp: Math.floor(Date.now() / 1000) + 1, fromMe: true, source: 'app',
      reaction: { text: '\u{1f916}', messageId: 'reaction-target' } };
    assert.equal(await store.react(await f.getChannel(1), reaction), 'ignored_target');
    assert.equal(await store.react(await f.getChannel(0), { ...reaction, id: 'react-own-channel' }), 'resumed');
  } finally { await f.close(); }
});
