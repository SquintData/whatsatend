import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/app.js';
import { Store, tokenHash } from '../src/store.js';
import type { Database } from '../src/db.js';

async function fixture() {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8'));
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
  const app = buildApp(new Store(database));
  const event = (session = 'session-0', fromMe = false) => ({
    event: 'message.any', session,
    payload: { id: 'message-1', from: '5511999999999@c.us', to: '5511888888888@c.us', fromMe, body: 'Olá', timestamp: 1700000000 },
  });
  const send = (payload: unknown, token = tokens[0]) => app.inject({
    method: 'POST', url: '/webhooks/waha/principal', headers: { 'x-webhook-token': token! }, payload,
  });
  return { pg, app, companies, channels, tokens, event, send,
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
    await f.pg.exec('DROP TABLE messages');
    const result = await f.send(f.event());
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { error: 'service_unavailable' });
    assert.equal((await f.pg.query('SELECT * FROM conversations')).rows.length, 0);
  } finally { await f.close(); }
});
