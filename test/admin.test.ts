import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { createCompany, parseCompanyOnboarding } from '../src/company-admin.js';
import { Store, tokenHash } from '../src/store.js';
import { adminPage } from '../src/admin.js';
import { WahaAdminClient } from '../src/waha-admin.js';

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
  const wahaCalls: Array<{ url: string; init: RequestInit }> = [];
  for (const file of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql']) {
    await pg.exec(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
  }
  const db: Database = {
    query: async <T>(sql: string, values?: unknown[]) => { queryCount++; return pg.query<T>(sql, values); },
    transaction: fn => pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => {
      queryCount++; return tx.query<T>(sql, values);
    } })),
  };
  const waha = new WahaAdminClient({ baseUrl: 'http://waha.local', apiKey: 'test-key-'.padEnd(40, 'x') }, async (input, init = {}) => {
    const url = String(input);
    wahaCalls.push({ url, init });
    if (url.endsWith('/api/sessions?all=true')) return Response.json([]);
    if (url.endsWith('/api/sessions')) return Response.json({ name: 'created', status: 'STOPPED' });
    if (url.endsWith('/start')) return new Response(null, { status: 200 });
    if (url.endsWith('/auth/qr')) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } });
    if (url.includes('/api/sessions/')) return Response.json({ status: url.includes('qr-channel') ? 'SCAN_QR_CODE' : 'WORKING', engine: 'GOWS', me: { id: '5511999999999@c.us' } });
    return new Response(null, { status: 500 });
  });
  const app = buildApp(new Store(db), false, withAdmin ? { db, secret: 'admin-secret-'.padEnd(40, 'x'), waha,
    publicBaseUrl: 'https://app.local' } : undefined);
  return { pg, db, app, wahaCalls, queryCount: () => queryCount, resetQueryCount: () => { queryCount = 0; },
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

test('admin panel script remains valid and includes channel connection operations', () => {
  const start = adminPage.indexOf('<script>') + '<script>'.length;
  const end = adminPage.indexOf('</script>', start);
  assert.ok(start >= '<script>'.length && end > start);
  assert.doesNotThrow(() => new Function(adminPage.slice(start, end)));
  assert.match(adminPage, /Cadastrar empresa e canal/);
  assert.match(adminPage, /Conexão/);
  assert.match(adminPage, /Exibir QR de pareamento/);
  assert.match(adminPage, /Conversas e histórico/);
  assert.match(adminPage, /Abrir histórico/);
  assert.match(adminPage, /admin\/api\/conversations/);
});

test('conversation history requires admin auth and isolates same chat across companies and channels', async () => {
  const f = await fixture();
  const webhookToken = 'c'.repeat(64);
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Hist A', instance: 'principal', session: 'a', webhookToken })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Hist B', instance: 'principal', session: 'b', webhookToken: 'e'.repeat(64) })));
    const channels = (await f.pg.query<{ id: string; organization_id: string; session: string }>(
      'SELECT id, organization_id, session FROM channels ORDER BY session')).rows;
    const conversationIds = [randomUUID(), randomUUID()];
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i]!;
      await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode)
        VALUES ($1,$2,$3,'same-contact@c.us',$4)`,
        [conversationIds[i], channel.organization_id, channel.id, i === 0 ? 'human' : 'monitoring']);
      await f.pg.query(`INSERT INTO messages(id,organization_id,channel_id,conversation_id,provider_message_id,direction,body,provider_timestamp)
        VALUES ($1,$2,$3,$4,$5,'incoming',$6,1700000000)`,
        [randomUUID(), channel.organization_id, channel.id, conversationIds[i], `history-${i}`, `private-message-${i}`]);
    }
    await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode,created_at)
      VALUES ($1,$2,$3,'another-contact@c.us','monitoring','2000-01-01T00:00:00Z')`,
      [randomUUID(), channels[0]!.organization_id, channels[0]!.id]);

    f.resetQueryCount();
    assert.equal((await f.app.inject('/admin/api/conversations?instance=principal&session=a')).statusCode, 401);
    assert.equal((await f.app.inject(`/admin/api/conversation?instance=principal&session=a&id=${conversationIds[0]}`)).statusCode, 401);
    assert.equal(f.queryCount(), 0, 'unauthenticated history reads must not query database');

    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]! };
    const pageA = await f.app.inject({ url: '/admin/api/conversations?instance=principal&session=a&limit=1&offset=0', headers });
    assert.equal(pageA.statusCode, 200);
    assert.equal(pageA.json().items.length, 1);
    assert.notEqual(pageA.json().items[0].id, conversationIds[1], 'selected channel page must exclude another company');
    assert.ok(['human', 'monitoring'].includes(pageA.json().items[0].mode));
    assert.equal(pageA.json().items[0].chatId, 'same-contact@c.us');
    assert.equal(pageA.json().nextOffset, 1, 'limit + 1 query indicates a next page');
    assert.equal(JSON.stringify(pageA.json()).includes(webhookToken), false);

    const pageANext = await f.app.inject({ url: '/admin/api/conversations?instance=principal&session=a&limit=1&offset=1', headers });
    assert.equal(pageANext.statusCode, 200);
    assert.notEqual(pageANext.json().items[0].id, conversationIds[1]);
    assert.notEqual(pageANext.json().items[0].id, pageA.json().items[0].id);
    assert.equal(pageANext.json().nextOffset, null);

    const historyA = await f.app.inject({ url: `/admin/api/conversation?instance=principal&session=a&id=${conversationIds[0]}`, headers });
    assert.equal(historyA.statusCode, 200);
    assert.deepEqual(historyA.json().messages.map((message: { body: string }) => message.body), ['private-message-0']);
    const crossChannel = await f.app.inject({ url: `/admin/api/conversation?instance=principal&session=a&id=${conversationIds[1]}`, headers });
    assert.equal(crossChannel.statusCode, 404);

    const pageB = await f.app.inject({ url: '/admin/api/conversations?instance=principal&session=b&limit=1&offset=0', headers });
    assert.equal(pageB.statusCode, 200);
    assert.equal(pageB.json().items[0].id, conversationIds[1]);
    assert.equal(pageB.json().items[0].mode, 'monitoring');
    const historyB = await f.app.inject({ url: `/admin/api/conversation?instance=principal&session=b&id=${conversationIds[1]}`, headers });
    assert.deepEqual(historyB.json().messages.map((message: { body: string }) => message.body), ['private-message-1']);
    assert.equal((await f.app.inject({ url: '/admin/api/conversations?instance=principal&session=a&limit=500', headers })).statusCode, 400);
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

test('admin provisions an isolated disabled channel with a backend-only webhook token and exposes live WAHA status/QR', async () => {
  const f = await fixture();
  try {
    const originHeaders = { host: 'admin.test', origin: 'https://admin.test' };
    f.resetQueryCount();
    assert.equal((await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers: {
      ...originHeaders, 'x-admin-action': '1',
    }, payload: { company: 'Empresa QR', instance: 'instance-qr', session: 'qr-channel' } })).statusCode, 401);
    assert.equal(f.wahaCalls.length, 0, 'unauthorized provisioning must not access WAHA');
    assert.equal(f.queryCount(), 0, 'unauthorized provisioning must not read or write the database');

    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders,
      payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const headers = { ...originHeaders, cookie, 'x-admin-action': '1' };
    const created = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
      payload: { company: 'Empresa QR', instance: 'instance-qr', session: 'qr-channel' } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.includes('X-Webhook-Token'), false);
    const webhookConfig = JSON.parse(String(f.wahaCalls[1]!.init.body)).config.webhooks[0];
    const generatedToken = webhookConfig.customHeaders['X-Webhook-Token'] as string;
    assert.match(generatedToken, /^[a-f0-9]{64}$/);
    assert.equal(webhookConfig.url, 'https://app.local/webhooks/waha/instance-qr');
    assert.deepEqual(f.wahaCalls.slice(0, 3).map(call => new URL(call.url).pathname + new URL(call.url).search), [
      '/api/sessions?all=true', '/api/sessions', '/api/sessions/qr-channel/start',
    ]);
    const stored = await f.pg.query<{ token_hash: string; automation_scope: string }>(
      'SELECT token_hash, automation_scope FROM channels WHERE session = $1', ['qr-channel']);
    assert.equal(stored.rows[0]!.token_hash, tokenHash(generatedToken));
    assert.equal(stored.rows[0]!.token_hash.includes(generatedToken), false);
    assert.equal(stored.rows[0]!.automation_scope, 'disabled');

    const status = await f.app.inject({ method: 'GET', url: '/admin/api/channel/status?instance=instance-qr&session=qr-channel', headers });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { status: 'SCAN_QR_CODE', engine: 'GOWS', account: '5511999999999@c.us' });
    const qr = await f.app.inject({ method: 'GET', url: '/admin/api/channel/qr?instance=instance-qr&session=qr-channel', headers });
    assert.equal(qr.statusCode, 200);
    assert.match(String(qr.headers['content-type']), /image\/png/);
    assert.deepEqual([...qr.rawPayload], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/admin/api/channel/scope', headers, payload: {
      instance: 'instance-qr', session: 'qr-channel', scope: 'test', testChatId: '5511999999999@c.us',
    } })).statusCode, 409, 'a channel cannot be enabled until WAHA reports WORKING and a linked account');
    const deniedQr = await f.app.inject('/admin/api/channel/qr?instance=instance-qr&session=qr-channel');
    assert.equal(deniedQr.statusCode, 401);
  } finally { await f.close(); }
});
