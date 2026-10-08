import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { Store, tokenHash } from '../src/store.js';
import type { Database } from '../src/db.js';
import { disabledAutomation, FIXED_REPLY, loadAutomation, SendError, WahaSender, type Automation } from '../src/automation.js';

async function fixture(automation: Automation = disabledAutomation) {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../sql/002_fixed_reply.sql', import.meta.url), 'utf8'));
  const database: Database = {
    query: async <T>(sql: string, values?: unknown[]) => pg.query<T>(sql, values),
    transaction: fn => pg.transaction(tx => fn({
      query: async <T>(sql: string, values?: unknown[]) => tx.query<T>(sql, values),
    })),
  };
  const companies = [randomUUID(), randomUUID()];
  const channels = [randomUUID(), randomUUID()];
  const tokens = ['a'.repeat(64), 'b'.repeat(64)];
  for (let i = 0; i < 2; i++) {
    await pg.query('INSERT INTO organizations(id,name) VALUES ($1,$2)', [companies[i], `Company ${i}`]);
    await pg.query('INSERT INTO channels(id,organization_id,instance,session,token_hash) VALUES ($1,$2,$3,$4,$5)',
      [channels[i], companies[i], 'principal', `session-${i}`, tokenHash(tokens[i]!)]);
  }
  const store = new Store(database, automation);
  const app = buildApp(store);
  const event = (session = 'session-0', fromMe = false) => ({
    event: 'message.any', session,
    payload: { id: 'message-1', from: '5511999999999@c.us', to: '5511888888888@c.us', fromMe, body: 'Olá', timestamp: 1700000000 },
  });
  const send = (payload: unknown, token = tokens[0]) => app.inject({
    method: 'POST', url: '/webhooks/waha/principal', headers: { 'x-webhook-token': token! }, payload,
  });
  return { pg, app, store, database, companies, channels, tokens, event, send,
    close: async () => { await app.close(); await pg.close(); } };
}

test('webhook authentication, isolation, duplicates and human mode', async () => {
  const f = await fixture();
  try {
    const unauthorized = await f.app.inject({ method: 'POST', url: '/webhooks/waha/principal', payload: f.event() });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal((await f.send(f.event('session-1'))).statusCode, 401);
    assert.equal((await f.send({ ...f.event(), organization_id: f.companies[1] })).json().status, 'stored');
    assert.equal((await f.send(f.event())).json().status, 'duplicate');
    assert.equal((await f.send(f.event('session-1'), f.tokens[1])).json().status, 'stored');
    const messages = await f.pg.query<{ organization_id: string }>('SELECT organization_id FROM messages');
    assert.equal(messages.rows.length, 2);
    assert.deepEqual(new Set(messages.rows.map(m => m.organization_id)), new Set(f.companies));
    const outgoing = f.event('session-0', true);
    outgoing.payload.id = 'outgoing-1';
    assert.equal((await f.send(outgoing)).json().status, 'stored');
    const modes = await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE chat_id = $1', [outgoing.payload.to]);
    assert.equal(modes.rows[0]!.mode, 'human');
    await f.pg.query('UPDATE organizations SET active = false WHERE id = $1', [f.companies[0]]);
    assert.equal((await f.send(f.event())).statusCode, 401);
  } finally { await f.close(); }
});

test('invalid messages, groups, readiness and cross-tenant database constraints', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send({ event: 'message.any' })).statusCode, 400);
    assert.equal((await f.send({ ...f.event(), payload: { fromMe: false } })).statusCode, 400);
    assert.equal((await f.send({ ...f.event(), payload: { ...f.event().payload, fromMe: true, to: undefined } })).statusCode, 400);
    assert.equal((await f.send({ ...f.event(), payload: { ...f.event().payload, from: '123@g.us' } })).json().status, 'ignored_chat');
    assert.equal((await f.send({ event: 'session.status', session: 'session-0' })).json().status, 'ignored_event');
    assert.equal((await f.app.inject('/health/ready')).statusCode, 200);
    assert.equal((await f.pg.query('SELECT * FROM messages')).rows.length, 0);
    await assert.rejects(f.pg.query(
      'INSERT INTO conversations(id,organization_id,channel_id,chat_id) VALUES ($1,$2,$3,$4)',
      [randomUUID(), f.companies[0], f.channels[1], '5511000000000@c.us'],
    ));
  } finally { await f.close(); }
});

test('storage failure returns retryable error without exposing database details', async () => {
  const f = await fixture();
  try {
    await f.pg.exec('DROP TABLE messages CASCADE');
    const result = await f.send(f.event());
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { error: 'service_unavailable' });
    assert.equal((await f.pg.query('SELECT * FROM conversations')).rows.length, 0);
  } finally { await f.close(); }
});

test('nullable recipient on incoming messages preserves history and deduplication', async () => {
  const f = await fixture();
  try {
    const event = { ...f.event(), payload: { ...f.event().payload, to: null } };
    assert.equal((await f.send(event)).json().status, 'stored');
    assert.equal((await f.send(event)).json().status, 'duplicate');
    const history = await f.pg.query<{ direction: string; chat_id: string }>(
      'SELECT m.direction, c.chat_id FROM messages m JOIN conversations c ON c.id = m.conversation_id',
    );
    assert.deepEqual(history.rows, [{ direction: 'incoming', chat_id: event.payload.from }]);
    assert.equal((await f.send({ ...event, payload: { ...event.payload, id: 'outgoing-null', fromMe: true } })).json().error, 'missing_recipient');
    assert.equal((await f.send({ ...event, payload: { ...event.payload, to: 123 } })).statusCode, 400);
    assert.equal((await f.send({ ...event, payload: { ...event.payload, to: {} } })).statusCode, 400);
    assert.equal((await f.pg.query('SELECT * FROM messages')).rows.length, 1);
  } finally { await f.close(); }
});

test('GOWS app-sent message without to pauses the destination conversation', async () => {
  const f = await fixture();
  try {
    const customer = '111111111111@lid';
    const ownAccount = '222222222222@lid';
    const incoming = { ...f.event(), payload: { ...f.event().payload, from: customer, to: null } };
    assert.equal((await f.send(incoming)).json().status, 'stored');
    const outgoing = {
      ...f.event(),
      payload: {
        ...f.event().payload, id: 'outgoing-gows', fromMe: true, from: ownAccount, to: null,
        source: 'app', _data: { Info: { Chat: customer, Sender: ownAccount, IsFromMe: true } },
      },
    };
    assert.equal((await f.send(outgoing)).json().status, 'stored');
    assert.equal((await f.send(outgoing)).json().status, 'duplicate');
    const conversations = await f.pg.query<{ chat_id: string; mode: string }>('SELECT chat_id, mode FROM conversations');
    assert.deepEqual(conversations.rows, [{ chat_id: customer, mode: 'human' }]);
    const messages = await f.pg.query<{ direction: string }>('SELECT direction FROM messages ORDER BY direction');
    assert.deepEqual(messages.rows, [{ direction: 'incoming' }, { direction: 'outgoing' }]);
    const invalid = { ...outgoing, payload: { ...outgoing.payload, id: 'bad-gows', _data: { Info: { Chat: 123, Sender: customer } } } };
    assert.equal((await f.send(invalid)).json().error, 'missing_recipient');
    const group = { ...outgoing, payload: { ...outgoing.payload, id: 'group-gows', _data: { Info: { Chat: '123@g.us' } } } };
    assert.equal((await f.send(group)).json().status, 'ignored_chat');
    assert.equal((await f.pg.query('SELECT * FROM messages')).rows.length, 2);
  } finally { await f.close(); }
});

const enabled: Automation = {
  enabled: true, instance: 'principal', session: 'session-0', chatId: '111111111111@lid',
  wahaUrl: 'http://waha:3000', apiKey: 'a'.repeat(64),
};
async function armed() {
  const f = await fixture(enabled);
  await f.send({ ...f.event(), payload: { ...f.event().payload, id: 'seed', from: enabled.chatId } });
  await f.store.control('resume');
  const incoming = (id: string, timestamp = Math.floor(Date.now() / 1000)) => ({
    ...f.event(), payload: { ...f.event().payload, id, from: enabled.chatId, timestamp },
  });
  return { ...f, incoming };
}

test('automation fails closed, is opt-in and never targets groups', () => {
  assert.equal(loadAutomation({}).enabled, false);
  assert.throws(() => loadAutomation({ AUTO_REPLY_ENABLED: 'yes' }));
  assert.throws(() => loadAutomation({ AUTO_REPLY_ENABLED: 'true' }));
  const env = {
    AUTO_REPLY_ENABLED: 'true', AUTO_REPLY_INSTANCE: 'principal', AUTO_REPLY_SESSION: 'teste',
    TEST_CHAT_ID: enabled.chatId, WAHA_BASE_URL: enabled.wahaUrl, WAHA_API_KEY: enabled.apiKey,
  };
  assert.equal(loadAutomation(env).chatId, enabled.chatId);
  assert.throws(() => loadAutomation({ ...env, TEST_CHAT_ID: '123@g.us' }));
  assert.throws(() => loadAutomation({ ...env, WAHA_BASE_URL: 'https://example.com/api' }));
});

test('new messages only, scope checks, deduplication and own echo before send completion', async () => {
  const f = await armed();
  try {
    assert.equal((await f.send(f.incoming('reply-1'))).json().status, 'stored');
    assert.equal((await f.send(f.incoming('reply-1'))).json().status, 'duplicate');
    await f.send(f.incoming('stale', Math.floor(Date.now() / 1000) - 300));
    await f.send({ ...f.incoming('wrong-contact'), payload: { ...f.incoming('wrong-contact').payload, from: '999@c.us' } });
    await f.send({ ...f.incoming('other-company'), session: 'session-1' }, f.tokens[1]);
    assert.equal((await f.pg.query('SELECT * FROM reply_jobs')).rows.length, 1);
    let sends = 0;
    let echo: ReturnType<typeof f.send> | undefined;
    const restarted = new Store(f.database, enabled);
    assert.equal(await new Store(f.database).processNext({ async send() { throw new Error('disabled'); } }), false);
    await restarted.processNext({ async send(request) {
      sends++;
      assert.deepEqual(request, { session: 'session-0', chatId: enabled.chatId, text: FIXED_REPLY });
      // Start the echo while the network operation is still in flight.
      echo = f.send({
        ...f.event(), payload: { ...f.event().payload, id: 'own-send-1', fromMe: true, to: null,
          _data: { Info: { Chat: enabled.chatId } } },
      });
      return { id: 'own-send-1' };
    } });
    assert.equal((await echo!).json().status, 'duplicate');
    assert.equal(await f.store.processNext({ async send() { throw new Error('must not retry'); } }), false);
    assert.equal(sends, 1);
    const conversation = await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE chat_id = $1', [enabled.chatId]);
    assert.equal(conversation.rows[0]!.mode, 'auto');
    assert.equal((await f.pg.query("SELECT * FROM messages WHERE direction = 'outgoing'")).rows.length, 1);
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'sent');
  } finally { await f.close(); }
});

test('phone and LID forms from GOWS target one conversation; human send cancels pending reply', async () => {
  const f = await armed();
  try {
    await f.send({ ...f.incoming('phone-form'), payload: { ...f.incoming('phone-form').payload,
      from: '5511999999999@c.us', _data: { Info: { Chat: enabled.chatId } } } });
    assert.equal((await f.pg.query('SELECT * FROM reply_jobs')).rows.length, 1);
    await f.send({ ...f.event(), payload: { ...f.event().payload, id: 'human-1', fromMe: true, to: null,
      source: 'app', _data: { Info: { Chat: enabled.chatId } } } });
    assert.equal(await f.store.processNext({ async send() { throw new Error('must not send'); } }), false);
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations')).rows[0]!.mode, 'human');
    await f.send(f.incoming('while-human'));
    assert.equal((await f.pg.query('SELECT * FROM reply_jobs')).rows.length, 1);
    await f.store.control('resume');
    await f.send(f.incoming('after-resume'));
    assert.equal((await f.pg.query("SELECT * FROM reply_jobs WHERE state = 'pending'")).rows.length, 1);
  } finally { await f.close(); }
});

test('claimed job rechecks human mode before sending and resume invalidates old jobs', async () => {
  const f = await armed();
  try {
    await f.send(f.incoming('pending-old-epoch'));
    await f.store.control('resume');
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'cancelled');
    await f.send(f.incoming('pending-disabled-channel'));
    await f.pg.query('UPDATE channels SET active = false WHERE id = $1', [f.channels[0]]);
    let called = false;
    assert.equal(await f.store.processNext({ async send() { called = true; return { id: 'bad' }; } }), true);
    assert.equal(called, false);
    assert.equal((await f.pg.query("SELECT * FROM reply_jobs WHERE state = 'cancelled'")).rows.length, 2);
  } finally { await f.close(); }
});

test('timeout is uncertain, pauses automation and is not retried even after restart', async () => {
  const f = await armed();
  try {
    await f.send(f.incoming('timeout-source'));
    await f.store.processNext({ async send() { throw new SendError('uncertain'); } });
    const states = await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs');
    assert.equal(states.rows[0]!.state, 'uncertain');
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations')).rows[0]!.mode, 'human');
    const restarted = new Store(f.database, enabled);
    await restarted.recoverInterrupted();
    assert.equal(await restarted.processNext({ async send() { throw new Error('must not retry'); } }), false);
    await f.send(f.incoming('after-timeout'));
    assert.equal((await f.pg.query('SELECT * FROM reply_jobs')).rows.length, 1);
  } finally { await f.close(); }
});

test('database failure after successful send never repeats the network call', async () => {
  const f = await armed();
  try {
    await f.send(f.incoming('rollback-source'));
    let sends = 0;
    // Force a provider-ID conflict after the network operation succeeds.
    await assert.rejects(f.store.processNext({ async send() { sends++; return { id: 'seed' }; } }));
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'sending');
    await f.pg.exec("UPDATE reply_jobs SET claimed_at = now() - interval '2 minutes'");
    await f.store.recoverInterrupted();
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'uncertain');
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations')).rows[0]!.mode, 'human');
    assert.equal(await f.store.processNext({ async send() { sends++; return { id: 'duplicate-send' }; } }), false);
    assert.equal(sends, 1);
  } finally { await f.close(); }
});

test('WAHA adapter checks scope, sends the API key, and never follows redirects', async () => {
  let calls = 0;
  const sender = new WahaSender(enabled, async (url, options) => {
    calls++;
    assert.equal(url, 'http://waha:3000/api/sendText');
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>)['X-Api-Key'], enabled.apiKey);
    assert.deepEqual(JSON.parse(options?.body as string), { session: enabled.session, chatId: enabled.chatId, text: FIXED_REPLY });
    return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
  });
  await assert.rejects(sender.send({ session: enabled.session, chatId: 'other@c.us', text: FIXED_REPLY }));
  assert.deepEqual(await sender.send({ session: enabled.session, chatId: enabled.chatId, text: FIXED_REPLY }), { id: 'provider-id' });
  assert.equal(calls, 1);
  const invalidResponse = new WahaSender(enabled, async () => new Response('{}', { status: 200 }));
  await assert.rejects(invalidResponse.send({ session: enabled.session, chatId: enabled.chatId, text: FIXED_REPLY }),
    (error: unknown) => error instanceof SendError && error.outcome === 'uncertain');
});

test('human pause between claim and send cancels the claimed job', async () => {
  const f = await armed();
  try {
    await f.send(f.incoming('claim-race'));
    const instrumented: Database = {
      transaction: fn => f.database.transaction(fn),
      async query<T>(sql: string, values?: unknown[]) {
        const result = await f.database.query<T>(sql, values);
        if (sql.includes('WITH candidate AS')) await f.store.control('pause');
        return result;
      },
    };
    let called = false;
    await new Store(instrumented, enabled).processNext({ async send() { called = true; return { id: 'should-not-send' }; } });
    assert.equal(called, false);
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs')).rows[0]!.state, 'cancelled');
  } finally { await f.close(); }
});

test('disabled flag prevents enqueue even if a conversation was previously armed', async () => {
  const f = await armed();
  try {
    const disabled = buildApp(new Store(f.database));
    try {
      const result = await disabled.inject({ method: 'POST', url: '/webhooks/waha/principal',
        headers: { 'x-webhook-token': f.tokens[0]! }, payload: f.incoming('disabled-source') });
      assert.equal(result.json().status, 'stored');
      assert.equal((await f.pg.query('SELECT * FROM reply_jobs')).rows.length, 0);
    } finally { await disabled.close(); }
  } finally { await f.close(); }
});

test('idempotent schema updates preserve existing history and human mode', async () => {
  const f = await fixture();
  try {
    await f.send(f.event());
    await f.send({ ...f.event(), payload: { ...f.event().payload, id: 'manual-schema', fromMe: true } });
    await f.pg.exec(await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8'));
    await f.pg.exec(await readFile(new URL('../sql/002_fixed_reply.sql', import.meta.url), 'utf8'));
    assert.equal((await f.pg.query('SELECT * FROM messages')).rows.length, 2);
    assert.equal((await f.pg.query<{ mode: string }>("SELECT mode FROM conversations WHERE chat_id = '5511888888888@c.us'")).rows[0]!.mode, 'human');
  } finally { await f.close(); }
});
