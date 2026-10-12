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
import { disabledAutomation, type Automation } from '../src/automation.js';

const enabledAutomation: Automation = {
  enabled: true, instance: '', session: '', chatId: '', wahaUrl: 'http://waha.local', apiKey: 'test-key-'.padEnd(40, 'x'),
};

function frontendApi(fetcher: (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) => unknown) {
  const start = adminPage.indexOf('async function api');
  const end = adminPage.indexOf('\nfunction notice', start);
  assert.ok(start >= 0 && end > start, 'frontend API helper must be present');
  return runInNewContext(`(()=>{${adminPage.slice(start, end)}; return api;})()`, { fetch: fetcher }) as
    (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;
}

async function fixture(withAdmin = true, automation: Automation = disabledAutomation) {
  const pg = new PGlite();
  let queryCount = 0;
  let beforeManualSend: (() => Promise<void>) | undefined;
  let beforeSessionCreate: (() => Promise<void>) | undefined;
  let manualSendStatus = 200;
  const wahaSessions = new Set<string>();
  const wahaCalls: Array<{ url: string; init: RequestInit }> = [];
  for (const file of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql', '006_manual_send_claim.sql', '007_reaction_timestamp_precision.sql', '008_channel_onboarding_claim.sql', '009_global_waha_session_unique.sql', '010_ai_handoff_attention.sql']) {
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
    if (url.endsWith('/api/sendText')) {
      await beforeManualSend?.();
      return manualSendStatus === 200 ? Response.json({ id: 'manual-out-1' }) : new Response(null, { status: manualSendStatus });
    }
    if (url.endsWith('/api/sessions?all=true')) return Response.json([...wahaSessions].map(name => ({ name, status: 'STOPPED' })));
    if (url.endsWith('/api/sessions')) {
      await beforeSessionCreate?.();
      const sessionName = JSON.parse(String(init.body)).name as string;
      wahaSessions.add(sessionName);
      return Response.json({ name: sessionName, status: 'STOPPED' });
    }
    if (url.endsWith('/start')) return new Response(null, { status: 200 });
    if (url.endsWith('/auth/qr')) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } });
    if (url.includes('/api/sessions/')) return Response.json({ status: url.includes('qr-channel') ? 'SCAN_QR_CODE' : 'WORKING', engine: 'GOWS', me: { id: '5511999999999@c.us' } });
    return new Response(null, { status: 500 });
  });
  const app = buildApp(new Store(db, automation), false, withAdmin ? { db, secret: 'admin-secret-'.padEnd(40, 'x'), waha,
    publicBaseUrl: 'https://app.local' } : undefined);
  return { pg, db, app, wahaCalls, queryCount: () => queryCount, resetQueryCount: () => { queryCount = 0; },
    setBeforeManualSend: (handler: () => Promise<void>) => { beforeManualSend = handler; },
    setBeforeSessionCreate: (handler: () => Promise<void>) => { beforeSessionCreate = handler; },
    setManualSendStatus: (status: number) => { manualSendStatus = status; },
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

test('concurrent manual replies reserve a conversation atomically and only one reaches WAHA', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa', instance: 'principal', session: 'a', webhookToken: 'a'.repeat(64) })));
    const channel = (await f.pg.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM channels')).rows[0]!;
    const conversationId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode,automation_epoch)
      VALUES ($1,$2,$3,'5511999999999@c.us','auto',2)`, [conversationId, channel.organization_id, channel.id]);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };
    let entered!: () => void;
    let release!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let sendCalls = 0;
    f.setBeforeManualSend(async () => { if (++sendCalls === 1) { entered(); await barrier; } });
    const payload = { instance: 'principal', session: 'a', id: conversationId, text: 'One answer' };
    const first = f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers, payload });
    await sending;
    const second = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers, payload });
    assert.equal(second.statusCode, 409, 'the concurrent request must be rejected before reaching WAHA');
    release();
    assert.equal((await first).statusCode, 200);
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sendText')).length, 1);
    const outgoing = await f.pg.query<{ count: number; mode: string; manual_send_in_flight: boolean }>(
      `SELECT count(*)::int AS count,cv.mode,coalesce(cv.manual_send_started_at > now() - interval '1 minute',false) AS manual_send_in_flight
       FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
       WHERE cv.id=$1 AND m.direction='outgoing' GROUP BY cv.mode,cv.manual_send_started_at`, [conversationId]);
    assert.deepEqual(outgoing.rows[0], { count: 1, mode: 'human', manual_send_in_flight: false });
  } finally { await f.close(); }
});

test('manual reply authenticates, isolates channel, pauses before WAHA and records only confirmed outgoing messages', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa A', instance: 'principal', session: 'a', webhookToken: 'a'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa B', instance: 'principal', session: 'b', webhookToken: 'b'.repeat(64) })));
    const channels = await f.pg.query<{ id: string; organization_id: string; session: string }>(
      'SELECT id, organization_id, session FROM channels ORDER BY session');
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    const jobId = randomUUID();
    const messageId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode,automation_epoch)
      VALUES ($1,$2,$3,'5511999999999@c.us','auto',7),($4,$5,$6,'5511999999999@c.us','human',3)`,
      [conversationA, channels.rows[0]!.organization_id, channels.rows[0]!.id,
        conversationB, channels.rows[1]!.organization_id, channels.rows[1]!.id]);
    await f.pg.query(`INSERT INTO messages(id,organization_id,channel_id,conversation_id,provider_message_id,direction,body)
      VALUES ($1,$2,$3,$4,'incoming-a','incoming','Need help')`,
      [messageId, channels.rows[0]!.organization_id, channels.rows[0]!.id, conversationA]);
    await f.pg.query(`INSERT INTO reply_jobs(id,organization_id,channel_id,conversation_id,source_message_id,epoch,body)
      VALUES ($1,$2,$3,$4,$5,7,'automatic reply')`,
      [jobId, channels.rows[0]!.organization_id, channels.rows[0]!.id, conversationA, messageId]);

    f.resetQueryCount();
    const unauthorized = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply',
      headers: { host: 'admin.test', origin: 'https://admin.test', 'x-admin-action': '1' },
      payload: { instance: 'principal', session: 'a', id: conversationA, text: 'Manual reply' } });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(f.queryCount(), 0);
    assert.equal(f.wahaCalls.length, 0);

    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };

    const crossChannel = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers,
      payload: { instance: 'principal', session: 'b', id: conversationA, text: 'Should not send' } });
    assert.equal(crossChannel.statusCode, 404);
    assert.equal(f.wahaCalls.length, 0, 'cross-channel ID must not reach WAHA');

    const paused = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/pause', headers,
      payload: { instance: 'principal', session: 'a', id: conversationA } });
    assert.equal(paused.statusCode, 200);

    f.setBeforeManualSend(async () => {
      const state = await f.pg.query<{ mode: string; automation_epoch: number; state: string }>(
        `SELECT cv.mode, cv.automation_epoch, j.state FROM conversations cv JOIN reply_jobs j ON j.conversation_id=cv.id WHERE cv.id=$1`, [conversationA]);
      assert.deepEqual(state.rows[0], { mode: 'human', automation_epoch: 9, state: 'cancelled' },
        'the committed pause and cancellation must happen before WAHA');
    });
    const sent = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers,
      payload: { instance: 'principal', session: 'a', id: conversationA, text: 'Manual reply' } });
    assert.equal(sent.statusCode, 200);
    const sendCalls = f.wahaCalls.filter(call => call.url.endsWith('/api/sendText'));
    assert.equal(sendCalls.length, 1);
    assert.deepEqual(JSON.parse(String(sendCalls[0]!.init.body)), {
      session: 'a', chatId: '5511999999999@c.us', text: 'Manual reply',
    });
    assert.equal((sendCalls[0]!.init.headers as Record<string, string>)['X-Api-Key'], 'test-key-'.padEnd(40, 'x'));
    assert.equal(sent.body.includes('test-key-'), false, 'WAHA key must stay out of API responses');
    const echo = await f.app.inject({ method: 'POST', url: '/webhooks/waha/principal', headers: { 'x-webhook-token': 'a'.repeat(64) },
      payload: { event: 'message.any', session: 'a', payload: { id: 'manual-out-1', from: 'our-account@c.us',
        to: '5511999999999@c.us', fromMe: true, body: 'Manual reply' } } });
    assert.equal(echo.statusCode, 200);
    assert.equal(echo.json().status, 'duplicate', 'the later WAHA echo must deduplicate the already recorded send');
    const stored = await f.pg.query<{ mode: string; manual_send_in_flight: boolean; direction: string; body: string; provider_message_id: string }>(
      `SELECT cv.mode,coalesce(cv.manual_send_started_at > now() - interval '1 minute',false) AS manual_send_in_flight,
       m.direction,m.body,m.provider_message_id FROM conversations cv JOIN messages m ON m.conversation_id=cv.id
       WHERE cv.id=$1 AND m.provider_message_id='manual-out-1'`, [conversationA]);
    assert.deepEqual(stored.rows[0], { mode: 'human', manual_send_in_flight: false,
      direction: 'outgoing', body: 'Manual reply', provider_message_id: 'manual-out-1' });
    const other = await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE id=$1', [conversationB]);
    assert.equal(other.rows[0]!.mode, 'human');
  } finally { await f.close(); }
});

test('manual send uncertainty leaves the conversation paused and does not create a retryable outgoing message', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa', instance: 'principal', session: 'a', webhookToken: 'a'.repeat(64) })));
    const channel = (await f.pg.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM channels')).rows[0]!;
    const conversationId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id,organization_id,channel_id,chat_id,mode,automation_epoch)
      VALUES ($1,$2,$3,'5511999999999@c.us','auto',4)`, [conversationId, channel.organization_id, channel.id]);
    f.setManualSendStatus(504);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };
    const response = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers,
      payload: { instance: 'principal', session: 'a', id: conversationId, text: 'Possibly sent' } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'send_uncertain', paused: true });
    const stored = await f.pg.query<{ mode: string; automation_epoch: number; manual_send_in_flight: boolean; outgoing: number }>(
      `SELECT cv.mode,cv.automation_epoch,coalesce(cv.manual_send_started_at > now() - interval '1 minute',false) AS manual_send_in_flight,
       (SELECT count(*)::int FROM messages m WHERE m.conversation_id=cv.id AND m.direction='outgoing') AS outgoing
       FROM conversations cv WHERE cv.id=$1`, [conversationId]);
    assert.deepEqual(stored.rows[0], { mode: 'human', automation_epoch: 6, manual_send_in_flight: false, outgoing: 0 });
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sendText')).length, 1,
      'an uncertain WAHA result is not automatically retried');
  } finally { await f.close(); }
});

test('admin resume authenticates, scopes to the selected channel, clears handoff and leaves cancelled jobs untouched', async () => {
  const f = await fixture(true, enabledAutomation);
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Retomar A', instance: 'principal', session: 'resume-a', webhookToken: 'a'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Retomar B', instance: 'principal', session: 'resume-b', webhookToken: 'b'.repeat(64) })));
    const channels = (await f.pg.query<{ id: string; organization_id: string; session: string }>(
      'SELECT id, organization_id, session FROM channels ORDER BY session')).rows;
    await f.pg.query('UPDATE organizations SET ai_enabled = true');
    await f.pg.query(`UPDATE channels SET automation_scope = 'all', automation_activated_at = now() - interval '10 seconds'`);
    const conversationA = randomUUID(), conversationB = randomUUID(), messageId = randomUUID(), jobId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode, automation_epoch,
      ai_handoff_reason, ai_handoff_at)
      VALUES ($1,$2,$3,'5511999999991@c.us','human',4,'needs_person',now()),
             ($4,$5,$6,'5511999999991@c.us','human',8,'sensitive_request',now())`,
      [conversationA, channels[0]!.organization_id, channels[0]!.id,
        conversationB, channels[1]!.organization_id, channels[1]!.id]);
    await f.pg.query(`INSERT INTO messages(id, organization_id, channel_id, conversation_id, provider_message_id, direction, body)
      VALUES ($1,$2,$3,$4,'old-resume-message','incoming','No output expected')`,
      [messageId, channels[0]!.organization_id, channels[0]!.id, conversationA]);
    await f.pg.query(`INSERT INTO reply_jobs(id, organization_id, channel_id, conversation_id, source_message_id, epoch, body, state)
      VALUES ($1,$2,$3,$4,$5,4,'cancelled old reply','cancelled')`,
      [jobId, channels[0]!.organization_id, channels[0]!.id, conversationA, messageId]);

    f.resetQueryCount();
    const unauthorized = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume',
      headers: { host: 'admin.test', origin: 'https://admin.test', 'x-admin-action': '1' },
      payload: { instance: 'principal', session: 'resume-a', id: conversationA } });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(f.queryCount(), 0, 'unauthenticated resume must not query conversation data');
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };

    const crossChannel = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume', headers,
      payload: { instance: 'principal', session: 'resume-b', id: conversationA } });
    assert.equal(crossChannel.statusCode, 404);
    const resumed = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume', headers,
      payload: { instance: 'principal', session: 'resume-a', id: conversationA } });
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(resumed.json(), { mode: 'auto' });
    assert.equal(f.wahaCalls.length, 0, 'resume arms automation without sending a response');

    const rows = await f.pg.query<{ id: string; mode: string; automation_epoch: number; ai_handoff_reason: string | null }>(
      `SELECT id, mode, automation_epoch, ai_handoff_reason FROM conversations ORDER BY id`);
    const resumedConversation = rows.rows.find(row => row.id === conversationA)!;
    const untouchedConversation = rows.rows.find(row => row.id === conversationB)!;
    assert.deepEqual(resumedConversation, { id: conversationA, mode: 'auto', automation_epoch: 5, ai_handoff_reason: null });
    assert.deepEqual(untouchedConversation, { id: conversationB, mode: 'human', automation_epoch: 8, ai_handoff_reason: 'sensitive_request' });
    assert.equal((await f.pg.query<{ state: string }>('SELECT state FROM reply_jobs WHERE id = $1', [jobId])).rows[0]!.state,
      'cancelled', 'a cancelled job remains cancelled after resumption');
    assert.equal((await f.pg.query('SELECT * FROM reply_jobs WHERE conversation_id = $1 AND state = \'pending\'', [conversationA])).rows.length, 0);
  } finally { await f.close(); }
});

test('admin resume rejects inactive or ineligible channels, non-AI companies and non-human states', async () => {
  const f = await fixture(true, enabledAutomation);
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Retomar', instance: 'principal', session: 'resume', webhookToken: 'a'.repeat(64) })));
    const channel = (await f.pg.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM channels')).rows[0]!;
    const conversationId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode)
      VALUES ($1,$2,$3,'5511999999999@c.us','human')`, [conversationId, channel.organization_id, channel.id]);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };
    const payload = { instance: 'principal', session: 'resume', id: conversationId };
    const resume = async () => f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume', headers, payload });

    await f.pg.query('UPDATE channels SET active = false WHERE id = $1', [channel.id]);
    assert.equal((await resume()).statusCode, 409, 'inactive channel cannot resume');
    await f.pg.query("UPDATE channels SET active = true, automation_scope = 'all', automation_activated_at = now() WHERE id = $1", [channel.id]);
    await f.pg.query('UPDATE organizations SET active = false WHERE id = $1', [channel.organization_id]);
    assert.equal((await resume()).statusCode, 409, 'inactive organization cannot resume');
    await f.pg.query('UPDATE organizations SET active = true WHERE id = $1', [channel.organization_id]);
    assert.equal((await resume()).statusCode, 409, 'company AI opt-in is required for Retomar IA');
    await f.pg.query('UPDATE organizations SET ai_enabled = true WHERE id = $1', [channel.organization_id]);
    await f.pg.query("UPDATE channels SET automation_scope = 'disabled', automation_activated_at = NULL WHERE id = $1", [channel.id]);
    assert.equal((await resume()).statusCode, 409, 'disabled channel scope cannot resume');
    await f.pg.query("UPDATE channels SET automation_scope = 'test', automation_test_chat_id = '5511000000000@c.us', automation_activated_at = now() WHERE id = $1", [channel.id]);
    assert.equal((await resume()).statusCode, 409, 'test scope for another contact cannot resume');
    await f.pg.query("UPDATE channels SET automation_test_chat_id = '5511999999999@c.us' WHERE id = $1", [channel.id]);
    assert.equal((await resume()).statusCode, 200, 'matching test scope may resume the selected contact');
    await f.pg.query("UPDATE conversations SET mode = 'human' WHERE id = $1", [conversationId]);
    await f.pg.query("UPDATE channels SET automation_scope = 'all', automation_test_chat_id = NULL, automation_activated_at = now() WHERE id = $1", [channel.id]);
    await f.pg.query("UPDATE conversations SET mode = 'auto' WHERE id = $1", [conversationId]);
    assert.equal((await resume()).statusCode, 409, 'already automatic conversation cannot resume twice');
    await f.pg.query("UPDATE conversations SET mode = 'monitoring' WHERE id = $1", [conversationId]);
    assert.equal((await resume()).statusCode, 409, 'monitoring conversation cannot be resumed as paused human work');
    assert.equal((await f.pg.query('SELECT automation_epoch FROM conversations WHERE id = $1', [conversationId])).rows[0]!.automation_epoch, 1);
    assert.equal(f.wahaCalls.length, 0);
  } finally { await f.close(); }
});

test('admin resume respects the global automation kill switch', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Kill switch', instance: 'principal', session: 'resume-off', webhookToken: 'a'.repeat(64) })));
    const channel = (await f.pg.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM channels')).rows[0]!;
    await f.pg.query('UPDATE organizations SET ai_enabled = true WHERE id = $1', [channel.organization_id]);
    await f.pg.query("UPDATE channels SET automation_scope = 'all', automation_activated_at = now() WHERE id = $1", [channel.id]);
    const conversationId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode)
      VALUES ($1,$2,$3,'5511999999999@c.us','human')`, [conversationId, channel.organization_id, channel.id]);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };
    const response = await f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume', headers,
      payload: { instance: 'principal', session: 'resume-off', id: conversationId } });
    assert.equal(response.statusCode, 409);
    assert.equal((await f.pg.query<{ mode: string }>('SELECT mode FROM conversations WHERE id = $1', [conversationId])).rows[0]!.mode, 'human');
  } finally { await f.close(); }
});

test('admin resume cannot race an in-flight manual send and can be retried after it completes', async () => {
  const f = await fixture(true, enabledAutomation);
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Retomar corrida', instance: 'principal', session: 'resume-race', webhookToken: 'a'.repeat(64) })));
    const channel = (await f.pg.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM channels')).rows[0]!;
    await f.pg.query('UPDATE organizations SET ai_enabled = true WHERE id = $1', [channel.organization_id]);
    await f.pg.query("UPDATE channels SET automation_scope = 'all', automation_activated_at = now() WHERE id = $1", [channel.id]);
    const conversationId = randomUUID();
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode, ai_handoff_reason, ai_handoff_at)
      VALUES ($1,$2,$3,'5511999999999@c.us','human','needs_person',now())`, [conversationId, channel.organization_id, channel.id]);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test',
      origin: 'https://admin.test', 'x-admin-action': '1' };
    let entered!: () => void;
    let release!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.setBeforeManualSend(async () => { entered(); await barrier; });
    const manual = f.app.inject({ method: 'POST', url: '/admin/api/conversation/reply', headers,
      payload: { instance: 'principal', session: 'resume-race', id: conversationId, text: 'Atendimento manual' } });
    await sending;
    const resume = () => f.app.inject({ method: 'POST', url: '/admin/api/conversation/resume', headers,
      payload: { instance: 'principal', session: 'resume-race', id: conversationId } });
    const blocked = await resume();
    assert.equal(blocked.statusCode, 409);
    assert.deepEqual(blocked.json(), { error: 'manual_send_in_progress' });
    release();
    assert.equal((await manual).statusCode, 200);
    const retried = await resume();
    assert.equal(retried.statusCode, 200, 'operator can explicitly retry after manual send ends');
    const final = await f.pg.query<{ mode: string; ai_handoff_reason: string | null; manual_send_started_at: Date | null }>(
      'SELECT mode, ai_handoff_reason, manual_send_started_at FROM conversations WHERE id = $1', [conversationId]);
    assert.deepEqual(final.rows[0], { mode: 'auto', ai_handoff_reason: null, manual_send_started_at: null });
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sendText')).length, 1);
  } finally { await f.close(); }
});

test('admin panel script remains valid and includes channel connection operations', () => {
  const start = adminPage.indexOf('<script>') + '<script>'.length;
  const end = adminPage.indexOf('</script>', start);
  assert.ok(start >= '<script>'.length && end > start);
  assert.doesNotThrow(() => new Function(adminPage.slice(start, end)));
  assert.match(adminPage, /Cadastrar empresa e canal/);
  assert.match(adminPage, /name="businessInfo"[^>]*maxlength="10000"/);
  assert.match(adminPage, /name="tone"[^>]*maxlength="300"/);
  assert.match(adminPage, /name="instructions"[^>]*maxlength="2000"/);
  assert.match(adminPage, /Informações da empresa para a IA/);
  assert.match(adminPage, /Sessão já cadastrada neste canal ou existente no WAHA/);
  assert.match(adminPage, /Conexão/);
  assert.match(adminPage, /Exibir QR de pareamento/);
  assert.match(adminPage, /Conversas e histórico/);
  assert.match(adminPage, /Abrir histórico/);
  assert.match(adminPage, /admin\/api\/conversations/);
  assert.match(adminPage, /admin\/api\/conversation\/pause/);
  assert.match(adminPage, /admin\/api\/conversation\/reply/);
  assert.match(adminPage, /admin\/api\/conversation\/resume/);
  assert.match(adminPage, /Retomar IA/);
  assert.match(adminPage, /id="conversation-resume"/);
  assert.match(adminPage, /s\u00f3 gera resposta ap\u00f3s a pr\u00f3xima mensagem do contato/);
  assert.match(adminPage, /Enviar resposta manual/);
  assert.match(adminPage, /Consumo de IA/);
  assert.match(adminPage, /\/admin\/api\/ai-usage/);
  assert.match(adminPage, /Tokens de entrada/);
  assert.match(adminPage, /Fila de aten/);
  assert.match(adminPage, /admin\/api\/attention/);
  assert.match(adminPage, /Sem itens que precisem de aten/);
  assert.match(adminPage, /Tokens de sa[ií]da/);
});

test('AI usage is admin-only, isolated by company, includes zero-use companies and filters the current UTC month', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa A', instance: 'principal', session: 'usage-a', webhookToken: 'a'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Empresa B', instance: 'principal', session: 'usage-b', webhookToken: 'b'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Sem uso', instance: 'principal', session: 'usage-zero', webhookToken: 'c'.repeat(64) })));
    const channels = await f.pg.query<{ id: string; organization_id: string; session: string }>(
      'SELECT id, organization_id, session FROM channels ORDER BY session');
    const bySession = new Map(channels.rows.map(channel => [channel.session, channel]));
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const previousMonth = new Date(monthStart.getTime() - 1_000);
    const recordUsage = async (session: string, createdAt: Date, inputTokens: number, outputTokens: number) => {
      const channel = bySession.get(session)!;
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const jobId = randomUUID();
      await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id)
        VALUES ($1,$2,$3,$4)`, [conversationId, channel.organization_id, channel.id, `${conversationId}@c.us`]);
      await f.pg.query(`INSERT INTO messages(id, organization_id, channel_id, conversation_id, provider_message_id, direction, body)
        VALUES ($1,$2,$3,$4,$5,'incoming','PRIVATE PROMPT MUST NOT APPEAR')`,
      [messageId, channel.organization_id, channel.id, conversationId, `message-${messageId}`]);
      await f.pg.query(`INSERT INTO reply_jobs(id, organization_id, channel_id, conversation_id, source_message_id, epoch, body, state)
        VALUES ($1,$2,$3,$4,$5,1,'PRIVATE REPLY MUST NOT APPEAR','sent')`,
      [jobId, channel.organization_id, channel.id, conversationId, messageId]);
      await f.pg.query(`INSERT INTO ai_usage(reply_job_id, organization_id, model, input_tokens, output_tokens, created_at)
        VALUES ($1,$2,'fake-model',$3,$4,$5)`,
      [jobId, channel.organization_id, inputTokens, outputTokens, createdAt.toISOString()]);
    };
    await recordUsage('usage-a', monthStart, 11, 3);
    await recordUsage('usage-a', now, 7, 5);
    await recordUsage('usage-a', previousMonth, 900, 900);
    await recordUsage('usage-b', now, 4, 9);

    f.resetQueryCount();
    const unauthorized = await f.app.inject('/admin/api/ai-usage');
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(f.queryCount(), 0, 'unauthenticated usage request must not query data');
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test', origin: 'https://admin.test' };
    const report = await f.app.inject({ method: 'GET', url: '/admin/api/ai-usage', headers });
    assert.equal(report.statusCode, 200);
    assert.deepEqual(report.json(), {
      monthUtc: monthStart.toISOString().slice(0, 7),
      companies: [
        { company: 'Empresa A', calls: 2, inputTokens: '18', outputTokens: '8' },
        { company: 'Empresa B', calls: 1, inputTokens: '4', outputTokens: '9' },
        { company: 'Sem uso', calls: 0, inputTokens: '0', outputTokens: '0' },
      ],
    });
    assert.equal(report.body.includes('PRIVATE PROMPT'), false);
    assert.equal(report.body.includes('PRIVATE REPLY'), false);
    assert.equal(report.body.includes('usage-a'), false);
  } finally { await f.close(); }
});

test('attention queue is admin-only, tenant-labeled, recent, bounded and excludes job/message contents', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Aten\u00e7\u00e3o A', instance: 'principal', session: 'attention-a', webhookToken: 'a'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Aten\u00e7\u00e3o B', instance: 'principal', session: 'attention-b', webhookToken: 'b'.repeat(64) })));
    const channels = (await f.pg.query<{ id: string; organization_id: string; instance: string; session: string }>(
      'SELECT id, organization_id, instance, session FROM channels ORDER BY session')).rows;
    const bySession = new Map(channels.map(channel => [channel.session, channel]));

    f.resetQueryCount();
    const unauthorized = await f.app.inject('/admin/api/attention');
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(f.queryCount(), 0, 'unauthenticated attention request must not query data');
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test', origin: 'https://admin.test' };
    const empty = await f.app.inject({ method: 'GET', url: '/admin/api/attention', headers });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { items: [] });

    const records = Array.from({ length: 54 }, (_, index) => {
      const channel = bySession.get(index % 2 === 0 ? 'attention-a' : 'attention-b')!;
      const occurredAt = new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString();
      return { index, channel, conversationId: randomUUID(), messageId: randomUUID(), jobId: randomUUID(),
        chatId: `attention-${index}@c.us`, occurredAt,
        state: index === 53 ? 'sent' : index % 2 === 0 ? 'failed' : 'uncertain' };
    });
    const insertBatch = async (table: string, columns: string[], rows: unknown[][]) => {
      const values: unknown[] = [];
      const tuples = rows.map(row => `(${row.map(value => { values.push(value); return `$${values.length}`; }).join(',')})`);
      await f.pg.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
    };
    await insertBatch('conversations', ['id', 'organization_id', 'channel_id', 'chat_id', 'created_at'], records.map(record => [
      record.conversationId, record.channel.organization_id, record.channel.id, record.chatId, record.occurredAt,
    ]));
    await insertBatch('messages', ['id', 'organization_id', 'channel_id', 'conversation_id', 'provider_message_id', 'direction', 'body', 'received_at'], records.map(record => [
      record.messageId, record.channel.organization_id, record.channel.id, record.conversationId,
      `source-${record.index}`, 'incoming', 'PRIVATE PROMPT <img src=x onerror=alert(1)>', record.occurredAt,
    ]));
    await insertBatch('reply_jobs', ['id', 'organization_id', 'channel_id', 'conversation_id', 'source_message_id', 'epoch', 'body', 'state', 'created_at', 'completed_at'], records.map(record => [
      record.jobId, record.channel.organization_id, record.channel.id, record.conversationId, record.messageId,
      1, 'PRIVATE GENERATED REPLY', record.state, record.occurredAt, record.occurredAt,
    ]));

    const response = await f.app.inject({ method: 'GET', url: '/admin/api/attention?limit=500', headers });
    assert.equal(response.statusCode, 200);
    const report = response.json();
    assert.equal(report.items.length, 50, 'endpoint enforces a fixed maximum independent of query parameters');
    assert.equal(report.items[0].conversationId, records[52]!.conversationId, 'newest failed/uncertain job is first');
    assert.equal(report.items[49].conversationId, records[3]!.conversationId, 'older jobs fall off the 50-item window');
    assert.ok(report.items.some((item: { status: string }) => item.status === 'failed'));
    assert.ok(report.items.some((item: { status: string }) => item.status === 'uncertain'));
    for (const item of report.items as Array<{ organization: string; instance: string; session: string; conversationId: string; status: string; attentionAt: string }>) {
      const source = records.find(record => record.conversationId === item.conversationId)!;
      assert.equal(item.organization, source.channel.session === 'attention-a' ? 'Aten\u00e7\u00e3o A' : 'Aten\u00e7\u00e3o B');
      assert.equal(item.instance, source.channel.instance);
      assert.equal(item.session, source.channel.session);
      assert.equal(item.status, source.state);
      assert.equal(item.attentionAt, source.occurredAt);
    }
    assert.equal(response.body.includes('PRIVATE PROMPT'), false);
    assert.equal(response.body.includes('PRIVATE GENERATED REPLY'), false);
    assert.equal(response.body.includes('token_hash'), false);
    assert.equal(report.items.some((item: { conversationId: string }) => item.conversationId === records[53]!.conversationId), false,
      'sent jobs are not part of the attention queue');
  } finally { await f.close(); }
});

test('attention queue includes only explicit AI handoffs, isolated by company, and removes them after resume', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Handoff A', instance: 'principal', session: 'handoff-a', webhookToken: 'a'.repeat(64) })));
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Handoff B', instance: 'principal', session: 'handoff-b', webhookToken: 'b'.repeat(64) })));
    const channels = (await f.pg.query<{ id: string; organization_id: string; instance: string; session: string }>(
      'SELECT id, organization_id, instance, session FROM channels ORDER BY session')).rows;
    const conversations = [randomUUID(), randomUUID(), randomUUID()];
    const handoffAt = new Date('2026-09-02T10:00:00.000Z');
    for (let index = 0; index < 3; index++) {
      const channel = channels[index === 0 ? 0 : 1]!;
      await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode, ai_handoff_reason, ai_handoff_at)
        VALUES ($1,$2,$3,$4,'human',$5,$6)`, [
        conversations[index], channel.organization_id, channel.id, `handoff-${index}@c.us`,
        index < 2 ? index === 0 ? 'needs_person' : 'sensitive_request' : null,
        index < 2 ? new Date(handoffAt.getTime() + index * 1000) : null,
      ]);
    }
    await new Store(f.db).pauseConversation('principal', 'handoff-b', conversations[2]!);
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: {
      host: 'admin.test', origin: 'https://admin.test',
    }, payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, host: 'admin.test', origin: 'https://admin.test' };
    const response = await f.app.inject({ method: 'GET', url: '/admin/api/attention', headers });
    assert.equal(response.statusCode, 200);
    const items = response.json().items;
    assert.deepEqual(items.map((item: { conversationId: string }) => item.conversationId), [conversations[1], conversations[0]]);
    assert.equal(items[0].status, 'ai_handoff');
    assert.equal(items[0].organization, 'Handoff B');
    assert.equal(items[0].session, 'handoff-b');
    assert.equal(items[0].attentionAt, new Date(handoffAt.getTime() + 1000).toISOString());
    assert.equal(items[0].reason, 'sensitive_request');
    assert.equal(items[1].status, 'ai_handoff');
    assert.equal(items[1].organization, 'Handoff A');
    assert.equal(items[1].session, 'handoff-a');
    assert.equal(items.some((item: { conversationId: string }) => item.conversationId === conversations[2]), false,
      'human mode without the AI handoff marker is not a queue item');
    assert.equal(response.body.includes('handoffReason'), false);

    await f.pg.query(`UPDATE conversations SET mode = 'auto', ai_handoff_reason = NULL, ai_handoff_at = NULL WHERE id = $1`, [conversations[0]]);
    const resumed = await f.app.inject({ method: 'GET', url: '/admin/api/attention', headers });
    assert.deepEqual(resumed.json().items.map((item: { conversationId: string }) => item.conversationId), [conversations[1]]);
  } finally { await f.close(); }
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
    const businessInfo = 'Clinica de fisioterapia; atendimento de segunda a sexta.';
    const tone = 't'.repeat(300);
    const instructions = 'i'.repeat(2_000);
    const created = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
      payload: { company: 'Empresa QR', instance: 'instance-qr', session: 'qr-channel', businessInfo, tone, instructions } });
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
    const ai = await f.pg.query<{ ai_enabled: boolean; ai_model: string; ai_business_data: Record<string, string>;
      ai_tone: string; ai_instructions: string }>(
      `SELECT o.ai_enabled, o.ai_model, o.ai_business_data, o.ai_tone, o.ai_instructions
       FROM organizations o JOIN channels c ON c.organization_id = o.id WHERE c.session = $1`, ['qr-channel']);
    assert.deepEqual(ai.rows[0], { ai_enabled: false, ai_model: 'gpt-4o-mini',
      ai_business_data: { description: businessInfo }, ai_tone: tone, ai_instructions: instructions });

    const duplicate = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
      payload: { company: 'Nao reassociar', instance: 'instance-qr', session: 'qr-channel', businessInfo: 'other' } });
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(duplicate.json(), { error: 'channel_already_registered' });
    assert.equal(f.wahaCalls.length, 3, 'duplicate mapping must be rejected before touching WAHA');
    assert.equal((await f.pg.query('SELECT id FROM organizations')).rows.length, 1);

    const invalidPayloads = [
      { businessInfo: 'x'.repeat(9_990) }, { businessInfo: 'x'.repeat(10_001) },
      { tone: 't'.repeat(301) }, { instructions: 'i'.repeat(2_001) },
    ];
    for (const [index, invalid] of invalidPayloads.entries()) {
      const rejected = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
        payload: { company: 'Limite invalido', instance: 'instance-qr', session: `invalid-${index}`,
          ...invalid } });
      assert.equal(rejected.statusCode, 400);
    }
    assert.equal(f.wahaCalls.length, 3, 'invalid onboarding data must be rejected before touching WAHA');

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

test('concurrent channel onboarding reserves the session before only one WAHA create', async () => {
  const f = await fixture();
  let releaseCreate!: () => void;
  try {
    const originHeaders = { host: 'admin.test', origin: 'https://admin.test' };
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders,
      payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { ...originHeaders, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-admin-action': '1' };
    let createEntered!: () => void;
    const entered = new Promise<void>(resolve => { createEntered = resolve; });
    const createBarrier = new Promise<void>(resolve => { releaseCreate = resolve; });
    f.setBeforeSessionCreate(async () => { createEntered(); await createBarrier; });
    const payload = { company: 'Empresa Concorrente', instance: 'principal', session: 'same-session' };
    const first = f.app.inject({ method: 'POST', url: '/admin/api/channels', headers, payload });
    await entered;

    const second = f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
      payload: { ...payload, company: 'Outra empresa', instance: 'other-instance' } });
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sessions')).length, 1,
      'the second request must remain behind the database reservation while WAHA create is blocked');

    releaseCreate();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409]);
    assert.equal(responses.find(response => response.statusCode === 409)?.json().error, 'channel_already_registered');
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sessions')).length, 1);
    assert.equal((await f.pg.query('SELECT id FROM organizations')).rows.length, 1);
    assert.equal((await f.pg.query('SELECT instance FROM channel_onboarding_claims')).rows.length, 0);
  } finally { releaseCreate?.(); await f.close(); }
});

test('onboarding rejects a WAHA session already assigned through another instance or the CLI', async () => {
  const f = await fixture();
  try {
    await createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'CLI Company', instance: 'cli-instance',
      session: 'shared-session', webhookToken: 'c'.repeat(64) })));
    const originHeaders = { host: 'admin.test', origin: 'https://admin.test' };
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders,
      payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { ...originHeaders, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-admin-action': '1' };
    const response = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers,
      payload: { company: 'Panel Company', instance: 'ui-instance', session: 'shared-session' } });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: 'channel_already_registered' });
    assert.equal(f.wahaCalls.filter(call => call.url.endsWith('/api/sessions')).length, 0,
      'a persisted mapping from any instance must block WAHA mutation');
    assert.deepEqual((await f.pg.query('SELECT name FROM organizations')).rows, [{ name: 'CLI Company' }]);
    assert.deepEqual((await f.pg.query('SELECT instance, session FROM channels')).rows,
      [{ instance: 'cli-instance', session: 'shared-session' }]);
    await assert.rejects(createCompany(f.db, parseCompanyOnboarding(JSON.stringify({ name: 'Second CLI Company',
      instance: 'another-cli-instance', session: 'shared-session', webhookToken: 'd'.repeat(64) }))),
    /WAHA session is already assigned/);
    await assert.rejects(f.pg.query(`INSERT INTO channels(id, organization_id, instance, session, token_hash)
      SELECT $1, organization_id, 'direct-db-instance', session, $2 FROM channels WHERE session = $3`,
      [randomUUID(), tokenHash('e'.repeat(64)), 'shared-session']));
  } finally { await f.close(); }
});

test('failed WAHA session creation releases its onboarding reservation for retry', async () => {
  const f = await fixture();
  try {
    const originHeaders = { host: 'admin.test', origin: 'https://admin.test' };
    const login = await f.app.inject({ method: 'POST', url: '/admin/api/login', headers: originHeaders,
      payload: { secret: 'admin-secret-'.padEnd(40, 'x') } });
    const headers = { ...originHeaders, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-admin-action': '1' };
    const payload = { company: 'Empresa Retry', instance: 'principal', session: 'retry-session' };
    f.setBeforeSessionCreate(async () => { throw new Error('simulated WAHA create failure'); });
    const failed = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers, payload });
    assert.equal(failed.statusCode, 503);
    assert.equal((await f.pg.query('SELECT session FROM channel_onboarding_claims')).rows.length, 0);
    assert.equal((await f.pg.query('SELECT id FROM organizations')).rows.length, 0);

    f.setBeforeSessionCreate(async () => {});
    const retried = await f.app.inject({ method: 'POST', url: '/admin/api/channels', headers, payload });
    assert.equal(retried.statusCode, 201);
    assert.equal((await f.pg.query('SELECT session FROM channels WHERE session = $1', [payload.session])).rows.length, 1);
    assert.equal((await f.pg.query('SELECT session FROM channel_onboarding_claims')).rows.length, 0);
  } finally { await f.close(); }
});
