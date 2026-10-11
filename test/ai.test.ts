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
  for (const name of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql', '006_manual_send_claim.sql', '007_reaction_timestamp_precision.sql', '008_channel_onboarding_claim.sql']) {
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
  const addIncoming = async (index: number, id: string, body: string, store: Store) => {
    const result = await db.query<{ id: string; organization_id: string; session: string; instance: string }>(
      'SELECT c.id, c.organization_id, c.session, c.instance FROM channels c WHERE id = $1', [channels[index]]);
    assert.ok(result.rows[0]);
    await store.receive(result.rows[0]!, { id, from: chatIds[index]!, fromMe: false, body, timestamp: Math.floor(Date.now() / 1000) });
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
