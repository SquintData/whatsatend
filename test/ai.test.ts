import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Store, tokenHash } from '../src/store.js';
import type { Database } from '../src/db.js';
import { FIXED_REPLY, type Automation, type Sender } from '../src/automation.js';
import { OpenAIResponsesProvider, type AIContext, type AIProvider, type AIDecision } from '../src/ai.js';

const chatIds = ['5511999999991@c.us', '5511999999992@c.us'] as const;

async function fixture(aiEnabled: boolean[] = [true, true]) {
  const pg = new PGlite();
  for (const name of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql', '006_manual_send_claim.sql', '007_reaction_timestamp_precision.sql', '008_channel_onboarding_claim.sql', '009_global_waha_session_unique.sql', '010_ai_handoff_attention.sql']) {
    await pg.exec(await readFile(new URL(`../sql/${name}`, import.meta.url), 'utf8'));
  }
  const db: Database = {
    query: async <T>(sql: string, values?: unknown[]) => pg.query<T>(sql, values),
    transaction: fn => pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => tx.query<T>(sql, values) })),
  };
  const organizations = [randomUUID(), randomUUID()];
  const channels = [randomUUID(), randomUUID()];
  const conversations = [randomUUID(), randomUUID()];
  const tokens = ['a'.repeat(64), 'b'.repeat(64)];
  const automations: Automation[] = [];
  for (let i = 0; i < 2; i++) {
    await pg.query('INSERT INTO organizations(id,name,ai_enabled,ai_model,ai_business_data,ai_tone,ai_instructions) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [organizations[i], `Company ${i}`, aiEnabled[i], 'test-model', { services: [`private-service-${i}`], faqs: [{ q: `question-${i}`, a: `answer-${i}` }] }, `tone-${i}`, `instruction-${i}`]);
    await pg.query(`INSERT INTO channels(id,organization_id,instance,session,token_hash,automation_scope,automation_test_chat_id,automation_activated_at)
      VALUES ($1,$2,$3,$4,$5,'test',$6,to_timestamp(floor(extract(epoch FROM now())) - 1))`,
      [channels[i], organizations[i], `instance-${i}`, `session-${i}`, tokenHash(tokens[i]!), chatIds[i]]);
    await pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode,automation_started_at)
      VALUES ($1,$2,$3,$4,'auto',now())`, [conversations[i], organizations[i], channels[i], chatIds[i]]);
    await pg.query(`INSERT INTO messages(id,organization_id,channel_id,conversation_id,provider_message_id,direction,body,provider_timestamp)
      VALUES ($1,$2,$3,$4,$5,'incoming',$6,$7)`, [randomUUID(), organizations[i], channels[i], conversations[i], `history-${i}`, `private-history-${i}`, Math.floor(Date.now() / 1000) - 1]);
    automations.push({ enabled: true, instance: `instance-${i}`, session: `session-${i}`, chatId: chatIds[i]!, wahaUrl: 'http://waha.test', apiKey: 'not-a-real-key-'.padEnd(32, 'x') });
  }
  const storeFor = (index: number, provider: AIProvider) => new Store(db, automations[index]!, provider);
  const addIncoming = async (index: number, id: string, body: string, store: Store, timestamp = Math.floor(Date.now() / 1000)) => {
    const result = await db.query<{ id: string; organization_id: string; session: string; instance: string }>(
      'SELECT c.id, c.organization_id, c.session, c.instance FROM channels c WHERE id = $1', [channels[index]]);
    assert.ok(result.rows[0]);
    await store.receive(result.rows[0]!, { id, from: chatIds[index]!, fromMe: false, body, timestamp });
  };
  const senderCalls: Array<{ text: string; session: string; chatId: string }> = [];
  const sender: Sender = { async send(request) { senderCalls.push(request); return { id: `sent-${senderCalls.length}` }; } };
  return { pg, db, organizations, channels, automations, storeFor, addIncoming, sender, senderCalls,
    async close() { await pg.close(); } };
}

function reply(text: string): AIDecision {
  return { decision: 'reply', reply: text, handoffReason: null, inputTokens: 12, outputTokens: 5 };
}

test('AI worker keeps company context and recent conversation history isolated', async () => {
  const f = await fixture();
  const received: AIContext[] = [];
  const provider: AIProvider = { async generate(context, model) { assert.equal(model, 'test-model'); received.push(context); return reply(`reply-${context.companyName}`); } };
  try {
    for (let i = 0; i < 2; i++) {
      const store = f.storeFor(i, provider);
      await f.addIncoming(i, `incoming-${i}`, `private-message-${i}`, store);
      await store.processNext(f.sender);
    }
    assert.equal(received.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(received[i]!.companyName, `Company ${i}`);
      assert.deepEqual(received[i]!.businessData.services, [`private-service-${i}`]);
      assert.equal(JSON.stringify(received[i]).includes(`private-message-${1 - i}`), false);
      assert.equal(JSON.stringify(received[i]).includes(`private-history-${i}`), true);
      assert.equal(JSON.stringify(received[i]).includes(`private-history-${1 - i}`), false);
      assert.equal(f.senderCalls[i]!.text, `reply-Company ${i}`);
    }
    const usage = await f.pg.query<{ count: number }>('SELECT count(*)::int AS count FROM ai_usage');
    assert.equal(usage.rows[0]!.count, 2);
  } finally { await f.close(); }
});

test('manual pause during generation invalidates the epoch and prevents sending', async () => {
  const f = await fixture();
  let started!: () => void;
  let finish!: (decision: AIDecision) => void;
  const generationStarted = new Promise<void>(resolve => { started = resolve; });
  const provider: AIProvider = { generate: async () => { started(); return new Promise<AIDecision>(resolve => { finish = resolve; }); } };
  try {
    const store = f.storeFor(0, provider);
    await f.addIncoming(0, 'pause-incoming', 'question before pause', store);
    const processing = store.processNext(f.sender);
    await generationStarted;
    await store.control('pause');
    finish(reply('must not be sent'));
    await processing;
    assert.equal(f.senderCalls.length, 0);
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.mode, 'human');
    assert.equal((await f.pg.query('SELECT * FROM messages WHERE direction = \'outgoing\'')).rows.length, 0);
  } finally { await f.close(); }
});

test('admin conversation resume only replies to the next contact message and never revives cancelled jobs', async () => {
  const f = await fixture();
  const generated: string[] = [];
  const provider: AIProvider = { async generate(context) { generated.push(context.message); return reply('answer to next message'); } };
  try {
    const store = f.storeFor(0, provider);
    const conversationId = (await f.pg.query<{ id: string }>(
      'SELECT id FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.id;
    const source = (await f.pg.query<{ id: string }>(
      "SELECT id FROM messages WHERE conversation_id = $1 AND provider_message_id = 'history-0'", [conversationId])).rows[0]!;
    await f.pg.query(`UPDATE conversations SET mode = 'human', automation_epoch = 4,
      ai_handoff_reason = 'needs_person', ai_handoff_at = now() WHERE id = $1`, [conversationId]);
    await f.pg.query(`INSERT INTO reply_jobs(id, organization_id, channel_id, conversation_id, source_message_id, epoch, body, state)
      VALUES ($1,$2,$3,$4,$5,3,'old reply','cancelled')`,
      [randomUUID(), f.organizations[0], f.channels[0], conversationId, source.id]);

    assert.deepEqual(await store.resumeConversation('instance-0', 'session-0', conversationId), { status: 'resumed' });
    assert.equal(f.senderCalls.length, 0, 'resume itself must not call WAHA');
    assert.equal((await f.pg.query("SELECT count(*)::int AS count FROM reply_jobs WHERE conversation_id = $1 AND state = 'pending'", [conversationId])).rows[0]!.count, 0);
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs WHERE conversation_id = $1', [conversationId])).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query<{ ai_handoff_reason: string | null }>(
      'SELECT ai_handoff_reason FROM conversations WHERE id = $1', [conversationId])).rows[0]!.ai_handoff_reason, null);

    await f.addIncoming(0, 'after-admin-resume', 'only this message should get AI', store, Math.ceil(Date.now() / 1000) + 1);
    assert.equal(await store.processNext(f.sender), true);
    assert.deepEqual(generated, ['only this message should get AI']);
    assert.equal(f.senderCalls.length, 1);
    assert.equal(f.senderCalls[0]!.text, 'answer to next message');
    assert.deepEqual((await f.pg.query<{ state: string }>(
      'SELECT state FROM reply_jobs WHERE conversation_id = $1 ORDER BY created_at', [conversationId])).rows.map(row => row.state), ['cancelled', 'sent']);
  } finally { await f.close(); }
});

test('admin resume accepts a new message timestamped in its WAHA second but excludes messages received before resume', async () => {
  const f = await fixture();
  const generated: string[] = [];
  const provider: AIProvider = { async generate(context) { generated.push(context.message); return reply('reply to new event'); } };
  try {
    const store = f.storeFor(0, provider);
    const conversationId = (await f.pg.query<{ id: string }>(
      'SELECT id FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.id;
    await f.pg.query("UPDATE conversations SET mode = 'human' WHERE id = $1", [conversationId]);

    await f.addIncoming(0, 'before-resume', 'already received before resume', store);
    assert.equal((await f.pg.query('SELECT count(*)::int AS count FROM reply_jobs WHERE conversation_id = $1', [conversationId])).rows[0]!.count, 0);

    assert.deepEqual(await store.resumeConversation('instance-0', 'session-0', conversationId), { status: 'resumed' });
    const resumed = (await f.pg.query<{ automation_started_at: Date; click_second: number }>(
      `SELECT automation_started_at, floor(extract(epoch FROM automation_started_at))::int AS click_second
       FROM conversations WHERE id = $1`, [conversationId])).rows[0]!;
    assert.ok(new Date(resumed.automation_started_at).getMilliseconds() > 0,
      'resume boundary must retain subsecond precision instead of rounding up');
    const clickSecond = resumed.click_second;

    await f.addIncoming(0, 'same-second-after-resume', 'new message in resume second', store, clickSecond);
    assert.equal((await f.pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM reply_jobs j JOIN messages m ON m.id = j.source_message_id
       WHERE j.conversation_id = $1 AND m.provider_message_id = 'before-resume'`, [conversationId])).rows[0]!.count, 0,
      'a message received before resume must never acquire a job');
    assert.equal((await f.pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM reply_jobs WHERE conversation_id = $1 AND state = 'pending'", [conversationId])).rows[0]!.count, 1);
    assert.equal(await store.processNext(f.sender), true);
    assert.deepEqual(generated, ['new message in resume second']);
    assert.equal(f.senderCalls[0]!.text, 'reply to new event');
  } finally { await f.close(); }
});

test('admin resume samples the transition clock only after channel and conversation locks', async () => {
  const f = await fixture();
  const statements: string[] = [];
  const db: Database = {
    query: f.db.query,
    transaction: fn => f.pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      statements.push(sql);
      return tx.query<T>(sql, values);
    } })),
  };
  try {
    const conversationId = (await f.pg.query<{ id: string }>(
      'SELECT id FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.id;
    await f.pg.query("UPDATE conversations SET mode = 'human' WHERE id = $1", [conversationId]);
    const store = new Store(db, f.automations[0]!);
    assert.deepEqual(await store.resumeConversation('instance-0', 'session-0', conversationId), { status: 'resumed' });

    const channelLock = statements.findIndex(sql => sql.includes('FROM channels ch JOIN organizations o') && sql.includes('FOR UPDATE OF ch, o'));
    const conversationLock = statements.findIndex(sql => sql.includes('FROM conversations WHERE id = $1') && sql.includes('FOR UPDATE'));
    const clockSample = statements.findIndex(sql => sql.includes('clock_timestamp()'));
    const transition = statements.findIndex(sql => sql.includes("UPDATE conversations SET mode = 'auto'"));
    assert.ok(channelLock >= 0 && conversationLock > channelLock && clockSample > conversationLock && transition > clockSample,
      'transition time must be sampled after both lock queries and before persisting resume');
  } finally { await f.close(); }
});

test('company AI opt-out during generation cancels the generated reply without fixed fallback', async () => {
  const f = await fixture();
  let started!: () => void;
  let finish!: (decision: AIDecision) => void;
  const generationStarted = new Promise<void>(resolve => { started = resolve; });
  const provider: AIProvider = { generate: async () => { started(); return new Promise<AIDecision>(resolve => { finish = resolve; }); } };
  try {
    const store = f.storeFor(0, provider);
    await f.addIncoming(0, 'opt-out-incoming', 'question before opt-out', store);
    const processing = store.processNext(f.sender);
    await generationStarted;
    await f.pg.query('UPDATE organizations SET ai_enabled = false WHERE id = $1', [f.organizations[0]]);
    finish(reply('must not be sent'));
    await processing;
    assert.equal(f.senderCalls.length, 0);
    assert.equal((await f.pg.query<{ state: string }>("SELECT state FROM reply_jobs WHERE source_message_id IN (SELECT id FROM messages WHERE provider_message_id = 'opt-out-incoming')")).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query('SELECT * FROM messages WHERE direction = \'outgoing\'')).rows.length, 0);
  } finally { await f.close(); }
});

test('channel scope change during generation cancels the generated reply without fixed fallback', async () => {
  const f = await fixture();
  let started!: () => void;
  let finish!: (decision: AIDecision) => void;
  const generationStarted = new Promise<void>(resolve => { started = resolve; });
  const provider: AIProvider = { generate: async () => { started(); return new Promise<AIDecision>(resolve => { finish = resolve; }); } };
  try {
    const store = f.storeFor(0, provider);
    await f.addIncoming(0, 'scope-change-incoming', 'question before scope change', store);
    const processing = store.processNext(f.sender);
    await generationStarted;
    await f.pg.query("UPDATE channels SET automation_scope = 'disabled', automation_test_chat_id = NULL WHERE id = $1", [f.channels[0]]);
    finish(reply('must not be sent'));
    await processing;
    assert.equal(f.senderCalls.length, 0);
    assert.equal((await f.pg.query<{ state: string }>("SELECT state FROM reply_jobs WHERE source_message_id IN (SELECT id FROM messages WHERE provider_message_id = 'scope-change-incoming')")).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query('SELECT * FROM messages WHERE direction = \'outgoing\'')).rows.length, 0);
  } finally { await f.close(); }
});

test('provider failures and explicit handoff pause the conversation without inventing a reply', async t => {
  for (const [name, generate] of [
    ['provider failure', async () => { throw new Error('secret provider detail'); }],
    ['explicit handoff', async () => ({ decision: 'handoff', reply: '', handoffReason: 'needs_person', inputTokens: 7, outputTokens: 2 } as AIDecision)],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture();
      const provider: AIProvider = { async generate() { return generate(); } };
      try {
        const store = f.storeFor(0, provider);
        await f.addIncoming(0, `failed-${name}`, 'request requiring help', store);
        await store.processNext(f.sender);
        assert.equal(f.senderCalls.length, 0);
        assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE channel_id = $1', [f.channels[0]])).rows[0]!.mode, 'human');
        assert.equal((await f.pg.query('SELECT * FROM messages WHERE direction = \'outgoing\'')).rows.length, 0);
        assert.equal((await f.pg.query('SELECT * FROM ai_usage')).rows.length, name === 'explicit handoff' ? 1 : 0);
        const handoff = await f.pg.query<{ ai_handoff_reason: string | null; ai_handoff_at: Date | null }>(
          'SELECT ai_handoff_reason, ai_handoff_at FROM conversations WHERE channel_id = $1', [f.channels[0]]);
        assert.equal(handoff.rows[0]!.ai_handoff_reason, name === 'explicit handoff' ? 'needs_person' : null);
        assert.equal(handoff.rows[0]!.ai_handoff_at !== null, name === 'explicit handoff');
        if (name === 'explicit handoff') {
          const resumed = await store.react({ id: f.channels[0]!, organization_id: f.organizations[0]!, session: 'session-0' }, {
            id: 'handoff-resume', timestamp: Date.now() / 1000 + 1, fromMe: true, source: 'app',
            reaction: { text: '\u{1F916}', messageId: `failed-${name}` },
          });
          assert.equal(resumed, 'resumed');
          const cleared = await f.pg.query<{ ai_handoff_reason: string | null; ai_handoff_at: Date | null }>(
            'SELECT ai_handoff_reason, ai_handoff_at FROM conversations WHERE channel_id = $1', [f.channels[0]]);
          assert.deepEqual(cleared.rows[0], { ai_handoff_reason: null, ai_handoff_at: null });
        }
      } finally { await f.close(); }
    });
  }
});

test('company AI opt-out keeps the fixed reply path and does not call the provider', async () => {
  const f = await fixture([false, true]);
  let calls = 0;
  const provider: AIProvider = { async generate() { calls++; return reply('unexpected'); } };
  try {
    const store = f.storeFor(0, provider);
    await f.addIncoming(0, 'fixed-incoming', 'hello', store);
    await store.processNext(f.sender);
    assert.equal(calls, 0);
    assert.equal(f.senderCalls[0]!.text, FIXED_REPLY);
  } finally { await f.close(); }
});

test('OpenAI provider uses Responses structured output with storage disabled', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new OpenAIResponsesProvider('test-api-key', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ decision: 'reply', reply: 'Olá', handoffReason: null }) }] }],
      usage: { input_tokens: 18, output_tokens: 4 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await provider.generate({
    companyName: 'Example', businessData: { services: ['appointments'] }, tone: '', instructions: '',
    history: [{ direction: 'incoming', body: 'Hello' }, { direction: 'outgoing', body: 'How can I help?' }],
    message: 'I need an appointment',
  }, 'test-model');
  assert.equal(requestUrl, 'https://api.openai.com/v1/responses');
  assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer test-api-key');
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.store, false);
  assert.equal(body.model, 'test-model');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.max_output_tokens, 600);
  assert.ok(requestInit?.signal instanceof AbortSignal);
  assert.deepEqual(result, { decision: 'reply', reply: 'Olá', handoffReason: null, inputTokens: 18, outputTokens: 4 });
});
