import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { createCompany, parseCompanyOnboarding } from '../src/company-admin.js';
import { Store } from '../src/store.js';
import { adminPage } from '../src/admin.js';

function frontendApi(fetcher: (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) => unknown) {
  const start = adminPage.indexOf('async function api');
  const end = adminPage.indexOf('\nfunction notice', start);
  assert.ok(start >= 0 && end > start, 'frontend API helper must be present');
  return runInNewContext(`(()=>{${adminPage.slice(start, end)}; return api;})()`, { fetch: fetcher }) as
    (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;
}

async function fixture(withAdmin = true) {
  const pg = new PGlite();
  let queryCount = 0;
  for (const file of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql']) {
    await pg.exec(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
  }
  const db: Database = {
    query: async <T>(sql: string, values?: unknown[]) => { queryCount++; return pg.query<T>(sql, values); },
    transaction: fn => pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      queryCount++; return tx.query<T>(sql, values);
    } })),
  };
  const app = buildApp(new Store(db), false, withAdmin ? { db, secret: 'admin-secret-'.padEnd(40, 'x') } : undefined);
  return { pg, db, app, queryCount: () => queryCount, resetQueryCount: () => { queryCount = 0; },
    close: async () => { await app.close(); await pg.close(); } };
}

test('admin panel requires secret login, hides channel tokens, and updates only the selected company/channel', async () => {
  const f = await fixture();
  const webhookToken = 'a'.repeat(64);
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa A', instance: 'principal', session: 'a',
      webhookToken, ai: { businessData: { address: 'Rua A' } } })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa B', instance: 'principal', session: 'b',
      webhookToken: 'b'.repeat(64), ai: { businessData: { address: 'Rua B' } } })));
    assert.equal((await f.app.inject('/admin')).statusCode, 200);
    f.resetQueryCount();
    assert.equal((await f.app.inject('/admin/api/channels')).statusCode, 401);
    assert.equal(f.queryCount(), 0, 'unauthenticated list must not read database');
    const originHeaders = { host: 'admin.test', origin: 'https://admin.test' };
    const wrong = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders, payload: { secret: 'wrong' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.body.includes(webhookToken), false);
    const insecureLogin = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: { host: 'admin.test', origin: 'http://admin.test' }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    assert.equal(insecureLogin.statusCode, 401, 'admin secret must not be accepted over HTTP');
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    assert.equal(login.statusCode, 204);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    const headers = { cookie, 'x-admin-action': '1', ...originHeaders };
    const list = await f.app.inject({ method: 'GET', url: '/admin/api/channels', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.includes(webhookToken), false);
    assert.equal(list.body.includes('token_hash'), false);

    const details = await f.app.inject({ method: 'GET', url: '/admin/api/channel?instance=principal&session=a', headers });
    assert.equal(details.statusCode, 200);
    assert.equal(details.json().ai.businessData.address, 'Rua A');
    assert.equal(details.json().scope, 'disabled');
    const save = await f.app.inject({ method: 'PUT', url: '/admin/api/channel/ai', headers, payload: {
      instance: 'principal', session: 'a', enabled: true, model: 'gpt-4o-mini',
      businessData: { address: 'Rua A atualizada', faqs: [{ question: 'Horário?', answer: '9h-18h' }] },
      tone: 'cordial', instructions: 'Não inventar disponibilidade.',
    } });
    assert.equal(save.statusCode, 200);
    await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'principal', session: 'a', scope: 'all',
    } }).then(response => assert.equal(response.statusCode, 400));
    await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'principal', session: 'a', scope: 'test', testChatId: '123@g.us',
    } }).then(response => assert.equal(response.statusCode, 400));
    assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'principal', session: 'a', scope: 'test', testChatId: '5511999999999@c.us',
    } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'principal', session: 'a', scope: 'all', confirmAll: true,
    } })).statusCode, 200);

    const organizations = await f.pg.query<{ id: string; name: string; ai_enabled: boolean; ai_business_data: { address: string } }>(
      'SELECT id, name, ai_enabled, ai_business_data FROM organizations ORDER BY name');
    assert.equal(organizations.rows[0]!.ai_enabled, true);
    assert.equal(organizations.rows[0]!.ai_business_data.address, 'Rua A atualizada');
    assert.equal(organizations.rows[1]!.ai_enabled, false);
    assert.equal(organizations.rows[1]!.ai_business_data.address, 'Rua B');
    const channelA = (await f.pg.query<{ id: string; organization_id: string }>(
      "SELECT id, organization_id FROM channels WHERE session = 'a'")).rows[0]!;
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode, automation_epoch, automation_started_at)
      VALUES ($1,$2,$3,'5511000000001@c.us','auto',1,now()), ($4,$2,$3,'5511000000002@c.us','human',1,now())`,
      [randomUUID(), channelA.organization_id, channelA.id, randomUUID()]);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'principal', session: 'a', scope: 'disabled',
    } })).statusCode, 200);
    const modes = await f.pg.query<{ chat_id: string; mode: string }>(
      'SELECT chat_id, mode FROM conversations WHERE channel_id = $1 ORDER BY chat_id', [channelA.id]);
    assert.deepEqual(modes.rows.map(row => row.mode), ['monitoring', 'human']);

    let frontendRequest: { method?: string; headers: Record<string, string>; body?: string } | undefined;
    const logoutFrontend = frontendApi(async (_url, options) => {
      frontendRequest = options;
      return { ok: true, status: 204, json: async () => null };
    });
    await logoutFrontend('/admin/api/logout', { method: 'POST' });
    assert.equal(frontendRequest?.body, undefined);
    assert.equal(frontendRequest?.headers['x-admin-action'], '1');
    const logout = await f.app.inject({ method: 'POST', url: '/admin/api/logout', headers: {
      ...frontendRequest!.headers, cookie, host: 'admin.test', origin: 'https://admin.test',
    } });
    assert.equal(logout.statusCode, 204);
    assert.equal((await f.app.inject({ method: 'GET', url: '/admin/api/channels', headers })).statusCode, 401);
  } finally { await f.close(); }
});

test('admin panel is not mounted without an environment secret and mutations require same-site action header', async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.app.inject('/admin')).statusCode, 404);
  } finally { await f.close(); }

  const g = await fixture();
  try {
    await createCompany(g.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa', instance: 'i', session: 's',
      webhookToken: 'd'.repeat(64), ai: { businessData: { address: 'original' } } })));
    g.resetQueryCount();
    assert.equal((await g.app.inject({ method: 'GET', url: '/admin/api/channels' })).statusCode, 401);
    assert.equal(g.queryCount(), 0, 'unauthenticated list must not query the database');
    const deniedUpdate = await g.app.inject({ method: 'PUT', url: '/admin/api/channel/ai', headers: {
      'x-admin-action': '1', host: 'admin.test', origin: 'https://admin.test',
    }, payload: {
      instance: 'i', session: 's', enabled: true, model: 'gpt-4o-mini', businessData: { address: 'tampered' }, tone: '', instructions: '',
    } });
    assert.equal(deniedUpdate.statusCode, 401);
    assert.equal(g.queryCount(), 0, 'unauthenticated update must not query the database');
    const stored = await g.pg.query<{ ai_enabled: boolean; ai_business_data: { address: string } }>(
      'SELECT ai_enabled, ai_business_data FROM organizations');
    assert.equal(stored.rows[0]!.ai_enabled, false);
    assert.equal(stored.rows[0]!.ai_business_data.address, 'original');

    const login = await g.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const response = await g.app.inject({ method: 'PUT', url: '/admin/api/channel/ai', headers: { cookie }, payload: {
      instance: 'principal', session: 'none', enabled: false, model: 'gpt-4o-mini', businessData: {}, tone: '', instructions: '',
    } });
    assert.equal(response.statusCode, 400);
  } finally { await g.close(); }
});
