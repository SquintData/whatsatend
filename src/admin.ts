import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Connection, Database } from './db.js';
import { parseCompanyAIConfig, type CompanyAIConfig } from './ai-config.js';
import { setChannelScope, type ChannelScope } from './channel-scope.js';
import { directChat } from './automation.js';
import { listCompanies, configureCompanyAI, insertCompany, parseCompanyOnboarding } from './company-admin.js';
import type { WahaAdminClient } from './waha-admin.js';
import type { Store } from './store.js';
import { adminPage as importedAdminPage } from './admin-page.js';
export { adminPage } from './admin-page.js';

const sessionCookie = 'wa_admin';
const sessionTtlMs = 8 * 60 * 60 * 1000;
const adminPage = importedAdminPage;


const mappingSchema = z.object({ instance: z.string().min(1).max(100), session: z.string().min(1).max(200) }).strict();
const conversationsQuerySchema = mappingSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();
const conversationQuerySchema = mappingSchema.extend({ id: z.string().uuid() }).strict();
const conversationMutationSchema = mappingSchema.extend({ id: z.string().uuid() }).strict();
const manualReplySchema = conversationMutationSchema.extend({ text: z.string().min(1).max(16_000) }).strict();
const loginSchema = z.object({ secret: z.string().min(1).max(256) }).strict();
const scopeSchema = mappingSchema.extend({
  scope: z.enum(['disabled', 'test', 'all']), testChatId: z.string().max(255).optional(), confirmAll: z.boolean().optional(),
}).strict();

export function registerAdminPanel(app: FastifyInstance, db: Database, secret: string,
  connections: { waha?: WahaAdminClient; publicBaseUrl?: string } = {}, store?: Store) {
  const secretBytes = Buffer.from(secret);
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; startedAt: number }>();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const secretMatches = (value: string) => {
    const bytes = Buffer.from(value);
    return bytes.length === secretBytes.length && timingSafeEqual(bytes, secretBytes);
  };
  const sessionKey = (request: { headers: { cookie?: string } }) => {
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`));
    const token = cookie?.slice(sessionCookie.length + 1);
    return token && /^[A-Za-z0-9_-]{40,60}$/.test(token) ? digest(token) : undefined;
  };
  const authenticated = (request: { headers: { cookie?: string } }) => {
    const key = sessionKey(request);
    const expiry = key ? sessions.get(key) : undefined;
    if (!key || !expiry || expiry <= Date.now()) { if (key) sessions.delete(key); return false; }
    return true;
  };
  const headers = (reply: { header(name: string, value: string): unknown }) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  };
  const reject = (reply: { code(status: number): { send(payload: unknown): unknown } }, status = 401) => reply.code(status).send({ error: status === 401 ? 'unauthorized' : 'invalid_request' });
  const secureSameOrigin = (request: { headers: { origin?: string; host?: string | string[] } }) =>
    typeof request.headers.host === 'string' && request.headers.origin === `https://${request.headers.host}`;
  const ensureMutation = (request: { headers: Record<string, string | string[] | undefined> }) =>
    request.headers['x-admin-action'] === '1' && typeof request.headers.host === 'string'
      && request.headers.origin === `https://${request.headers.host}`;
  const guard = (request: { headers: { cookie?: string } }, reply: { code(status: number): { send(payload: unknown): unknown } }) => {
    if (authenticated(request)) return true;
    reject(reply);
    return false;
  };

  app.get('/admin', async (_request, reply) => {
    headers(reply); return reply.type('text/html; charset=utf-8').send(adminPage);
  });
  app.post('/admin/api/login', async (request, reply) => {
    headers(reply);
    if (!secureSameOrigin(request)) return reject(reply);
    const ip = request.ip;
    let state = attempts.get(ip);
    if (!state || Date.now() - state.startedAt > 10 * 60_000) { state = { count: 0, startedAt: Date.now() }; attempts.set(ip, state); }
    if (state.count >= 8) return reject(reply, 429);
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || !secretMatches(parsed.data.secret)) { state.count++; return reject(reply); }
    attempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), Date.now() + sessionTtlMs);
    reply.header('Set-Cookie', `${sessionCookie}=${token}; Path=/admin; Max-Age=${sessionTtlMs / 1000}; HttpOnly; Secure; SameSite=Strict`);
    return reply.code(204).send();
  });
  app.post('/admin/api/logout', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const key = sessionKey(request); if (key) sessions.delete(key);
    reply.header('Set-Cookie', `${sessionCookie}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return reply.code(204).send();
  });
  app.get('/admin/api/channels', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    try { return await listCompanies(db); } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/ai-usage', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    try {
      const result = await db.query<{
        month_utc: string; organization_id: string | null; company: string | null;
        calls: number | null; input_tokens: string | null; output_tokens: string | null;
      }>(`WITH bounds AS (
          SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start,
            (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS month_end,
            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS month_utc
        ), totals AS (
          SELECT o.id AS organization_id, o.name AS company,
            count(u.reply_job_id)::int AS calls,
            coalesce(sum(u.input_tokens), 0)::text AS input_tokens,
            coalesce(sum(u.output_tokens), 0)::text AS output_tokens
          FROM organizations o CROSS JOIN bounds b
          LEFT JOIN ai_usage u ON u.organization_id = o.id
            AND u.created_at >= b.month_start AND u.created_at < b.month_end
          GROUP BY o.id, o.name
        )
        SELECT b.month_utc, t.organization_id, t.company, t.calls, t.input_tokens, t.output_tokens
        FROM bounds b LEFT JOIN totals t ON true
        ORDER BY t.company NULLS LAST, t.organization_id`);
      const first = result.rows[0];
      return {
        monthUtc: first?.month_utc ?? new Date().toISOString().slice(0, 7),
        companies: result.rows.filter(row => row.organization_id !== null).map(row => ({
          company: row.company!, calls: row.calls!, inputTokens: row.input_tokens!, outputTokens: row.output_tokens!,
        })),
      };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/attention', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    try {
      const result = await db.query<{
        organization: string; instance: string; session: string; conversation_id: string;
        status: 'failed' | 'uncertain' | 'ai_handoff'; attention_at: Date; reason: string | null;
      }>(`SELECT item.organization, item.instance, item.session, item.conversation_id,
          item.status, item.attention_at, item.reason
        FROM (
          SELECT o.name AS organization, ch.instance, ch.session, cv.id AS conversation_id,
            j.state AS status, coalesce(j.completed_at, j.created_at) AS attention_at, NULL::text AS reason,
            j.id AS tie_breaker
          FROM reply_jobs j
          JOIN organizations o ON o.id = j.organization_id
          JOIN channels ch ON ch.id = j.channel_id AND ch.organization_id = j.organization_id
          JOIN conversations cv ON cv.id = j.conversation_id AND cv.organization_id = j.organization_id
            AND cv.channel_id = j.channel_id
          WHERE j.state IN ('failed', 'uncertain')
          UNION ALL
          SELECT o.name AS organization, ch.instance, ch.session, cv.id AS conversation_id,
            'ai_handoff'::text AS status, cv.ai_handoff_at AS attention_at, cv.ai_handoff_reason AS reason,
            cv.id AS tie_breaker
          FROM conversations cv
          JOIN organizations o ON o.id = cv.organization_id
          JOIN channels ch ON ch.id = cv.channel_id AND ch.organization_id = cv.organization_id
          WHERE cv.ai_handoff_reason IS NOT NULL
        ) item
        ORDER BY item.attention_at DESC, item.tie_breaker DESC, item.status
        LIMIT 50`);
      return { items: result.rows.map(row => ({ organization: row.organization, instance: row.instance,
        session: row.session, conversationId: row.conversation_id, status: row.status, reason: row.reason,
        attentionAt: row.attention_at })) };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/conversations', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const parsed = conversationsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reject(reply, 400);
    const { instance, session, limit, offset } = parsed.data;
    try {
      const result = await db.query<{
        id: string; company: string; chat_id: string; mode: string; created_at: Date;
        latest_message_at: Date | null; last_direction: string | null; last_message: string | null;
      }>(`SELECT cv.id, o.name AS company, cv.chat_id, cv.mode, cv.created_at,
          latest.received_at AS latest_message_at, latest.direction AS last_direction, latest.body AS last_message
        FROM channels ch
        JOIN organizations o ON o.id = ch.organization_id
        JOIN conversations cv ON cv.organization_id = ch.organization_id AND cv.channel_id = ch.id
        LEFT JOIN LATERAL (
          SELECT m.received_at, m.direction, m.body FROM messages m
          WHERE m.organization_id = ch.organization_id AND m.channel_id = ch.id AND m.conversation_id = cv.id
          ORDER BY m.received_at DESC, m.id DESC LIMIT 1
        ) latest ON true
        WHERE ch.instance = $1 AND ch.session = $2
        ORDER BY latest.received_at DESC NULLS LAST, cv.created_at DESC, cv.id DESC
        LIMIT $3 OFFSET $4`, [instance, session, limit + 1, offset]);
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(row => ({
        id: row.id, company: row.company, chatId: row.chat_id, mode: row.mode,
        latestAt: row.latest_message_at ?? row.created_at,
        lastDirection: row.last_direction, lastMessage: row.last_message,
      }));
      return { items, nextOffset: hasMore ? offset + limit : null };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/conversation', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const parsed = conversationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reject(reply, 400);
    const { instance, session, id } = parsed.data;
    try {
      const channel = await db.query<{ id: string; organization_id: string }>(
        'SELECT id, organization_id FROM channels WHERE instance = $1 AND session = $2', [instance, session]);
      const scopedChannel = channel.rows[0];
      if (!scopedChannel) return reject(reply, 404);
      const conversation = await db.query<{ id: string; company: string; chat_id: string; mode: string }>(
        `SELECT cv.id, o.name AS company, cv.chat_id, cv.mode
        FROM conversations cv JOIN organizations o ON o.id = cv.organization_id
        WHERE cv.id = $1 AND cv.organization_id = $2 AND cv.channel_id = $3`,
        [id, scopedChannel.organization_id, scopedChannel.id]);
      const row = conversation.rows[0];
      if (!row) return reject(reply, 404);
      const messages = await db.query<{ direction: string; body: string; provider_timestamp: string | null; received_at: Date }>(
        `SELECT m.direction, m.body, m.provider_timestamp, m.received_at FROM messages m
        WHERE m.organization_id = $1 AND m.channel_id = $2 AND m.conversation_id = $3
        ORDER BY m.received_at DESC, m.id DESC LIMIT 100`,
        [scopedChannel.organization_id, scopedChannel.id, row.id]);
      return { id: row.id, company: row.company, chatId: row.chat_id, mode: row.mode,
        messages: messages.rows.reverse().map(message => ({ direction: message.direction, body: message.body,
          timestamp: message.provider_timestamp, receivedAt: message.received_at })) };
    } catch { return reject(reply, 503); }
  });
  app.post('/admin/api/conversation/pause', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = conversationMutationSchema.safeParse(request.body);
    if (!parsed.success || !store) return reject(reply, parsed.success ? 503 : 400);
    try {
      const target = await store.pauseConversation(parsed.data.instance, parsed.data.session, parsed.data.id);
      if (!target) return reject(reply, 404);
      return { mode: 'human' };
    } catch { return reject(reply, 503); }
  });
  app.post('/admin/api/conversation/resume', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = conversationMutationSchema.safeParse(request.body);
    if (!parsed.success || !store) return reject(reply, parsed.success ? 503 : 400);
    try {
      const result = await store.resumeConversation(parsed.data.instance, parsed.data.session, parsed.data.id);
      if (result.status === 'resumed') return { mode: 'auto' };
      if (result.status === 'not_found') return reject(reply, 404);
      if (result.status === 'manual_send_in_progress') return reply.code(409).send({ error: 'manual_send_in_progress' });
      return reply.code(409).send({ error: 'conversation_not_resumable' });
    } catch { return reject(reply, 503); }
  });
  app.post('/admin/api/conversation/reply', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = manualReplySchema.safeParse(request.body);
    if (!parsed.success) return reject(reply, 400);
    if (!store || !connections.waha) return reject(reply, 503);
    let reservation: Awaited<ReturnType<Store['reserveManualSend']>>;
    try { reservation = await store.reserveManualSend(parsed.data.instance, parsed.data.session, parsed.data.id); }
    catch { return reject(reply, 503); }
    if (reservation.status === 'not_found') return reject(reply, 404);
    if (reservation.status === 'in_flight') return reply.code(409).send({ error: 'manual_send_in_progress' });
    const target = reservation.target;
    if (!target.channelActive || !target.organizationActive) {
      try { await store.releaseManualSend(target); } catch { return reject(reply, 503); }
      return reject(reply, 409);
    }
    try {
      const sent = await connections.waha.send({ session: target.session, chatId: target.chatId, text: parsed.data.text });
      await store.recordManualOutgoing(target, parsed.data.text, sent.id);
      return { ok: true };
    } catch {
      // There is no queued retry. Release this claim and reassert human mode if a concurrent resume raced WAHA.
      try { await store.releaseManualSend(target); } catch { /* reservation remains fail-closed */ }
      return reply.code(503).send({ error: 'send_uncertain', paused: true });
    }
  });
  const channelForConnection = async (connection: Pick<Connection, 'query'>, instance: string, session: string) => {
    const result = await connection.query<{ id: string }>(
      'SELECT id FROM channels WHERE instance = $1 AND session = $2', [instance, session]);
    return result.rows.length > 0;
  };
  const channelForSession = async (connection: Pick<Connection, 'query'>, session: string) => {
    const result = await connection.query<{ id: string }>(
      'SELECT id FROM channels WHERE session = $1 LIMIT 1', [session]);
    return result.rows.length > 0;
  };
  app.post('/admin/api/channels', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = z.object({ company: z.string().trim().min(1).max(200),
      instance: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), session: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      businessInfo: z.string().max(10_000).default(''), tone: z.string().max(300).default(''),
      instructions: z.string().max(2_000).default('') })
      .strict().safeParse(request.body);
    if (!parsed.success) return reject(reply, 400);
    if (!connections.waha || !connections.publicBaseUrl) return reject(reply, 503);
    const { company, instance, session, businessInfo, tone, instructions } = parsed.data;
    const webhookToken = randomBytes(32).toString('hex');
    let onboarding: ReturnType<typeof parseCompanyOnboarding>;
    try {
      onboarding = parseCompanyOnboarding(JSON.stringify({ name: company, instance, session, webhookToken,
        ai: { enabled: false, businessData: businessInfo.trim() ? { description: businessInfo } : {}, tone, instructions } }));
    } catch { return reject(reply, 400); }
    const duplicate = () => reply.code(409).send({ error: 'channel_already_registered' });
    try {
      // Keep the unique WAHA session claim in the transaction until its channel mapping commits.
      const created = await db.transaction(async tx => {
        const claim = await tx.query<{ session: string }>(
          `INSERT INTO channel_onboarding_claims(instance, session) VALUES ($1, $2)
           ON CONFLICT (session) DO NOTHING RETURNING session`, [instance, session]);
        if (!claim.rows.length) return false;
        try {
          if (await channelForSession(tx, session)) return false;
          const existing = await connections.waha!.listSessions();
          if (existing.some(item => item.name === session)) return false;
          const webhookUrl = new URL(`/webhooks/waha/${instance}`, connections.publicBaseUrl).toString();
          await connections.waha!.createStoppedSession(session, webhookUrl, webhookToken);
          await insertCompany(tx, onboarding);
          return true;
        } finally {
          await tx.query('DELETE FROM channel_onboarding_claims WHERE session = $1', [session]);
        }
      });
      if (!created) return duplicate();
      await connections.waha.startSession(session);
      return reply.code(201).send({ ok: true });
    } catch (error) {
      if (error instanceof Error && /WAHA session is already/.test(error.message)) return duplicate();
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return duplicate();
      return reject(reply, 503);
    }
  });
  app.get('/admin/api/channel', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success) return reject(reply, 400);
    try {
      const result = await db.query<{
        company: string; ai_enabled: boolean; ai_model: string; ai_business_data: Record<string, unknown>;
        ai_tone: string; ai_instructions: string; automation_scope: ChannelScope; automation_test_chat_id: string | null;
      }>(`SELECT o.name AS company, o.ai_enabled, o.ai_model, o.ai_business_data, o.ai_tone, o.ai_instructions,
          c.automation_scope, c.automation_test_chat_id FROM channels c JOIN organizations o ON o.id = c.organization_id
          WHERE c.instance = $1 AND c.session = $2`, [mapping.data.instance, mapping.data.session]);
      const row = result.rows[0]; if (!row) return reject(reply, 400);
      return { company: row.company, ai: { enabled: row.ai_enabled, model: row.ai_model,
        businessData: row.ai_business_data, tone: row.ai_tone, instructions: row.ai_instructions },
        scope: row.automation_scope, testChatId: row.automation_test_chat_id };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/channel/status', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(db, mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      return await connections.waha.sessionStatus(mapping.data.session);
    } catch { return reject(reply, 503); }
  });
  app.post('/admin/api/channel/start', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const mapping = mappingSchema.safeParse(request.body);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(db, mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      await connections.waha.startSession(mapping.data.session);
      return { ok: true };
    } catch { return reject(reply, 503); }
  });
  app.get('/admin/api/channel/qr', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    const mapping = mappingSchema.safeParse(request.query);
    if (!mapping.success || !connections.waha) return reject(reply, mapping.success ? 503 : 400);
    try {
      if (!await channelForConnection(db, mapping.data.instance, mapping.data.session)) return reject(reply, 404);
      const status = await connections.waha.sessionStatus(mapping.data.session);
      if (status.status !== 'SCAN_QR_CODE') return reject(reply, 409);
      return reply.type('image/png').send(Buffer.from(await connections.waha.qrPng(mapping.data.session)));
    } catch { return reject(reply, 503); }
  });
  app.put('/admin/api/channel/ai', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const body = z.object({ instance: mappingSchema.shape.instance, session: mappingSchema.shape.session,
      enabled: z.boolean(), model: z.string(), businessData: z.record(z.string(), z.unknown()),
      tone: z.string(), instructions: z.string() }).strict().safeParse(request.body);
    if (!body.success) return reject(reply, 400);
    let config: CompanyAIConfig;
    try { config = parseCompanyAIConfig(JSON.stringify({ enabled: body.data.enabled, model: body.data.model,
      businessData: body.data.businessData, tone: body.data.tone, instructions: body.data.instructions })); }
    catch { return reject(reply, 400); }
    try { await configureCompanyAI(db, body.data.instance, body.data.session, config); return { ok: true }; }
    catch { return reject(reply, 400); }
  });
  app.put('/admin/api/channel/scope', async (request, reply) => {
    headers(reply); if (!guard(request, reply)) return;
    if (!ensureMutation(request)) return reject(reply, 400);
    const parsed = scopeSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.scope === 'all' && parsed.data.confirmAll !== true)
      || (parsed.data.scope !== 'all' && parsed.data.confirmAll)
      || (parsed.success && parsed.data.scope === 'test' && !directChat(parsed.data.testChatId ?? ''))
      || (parsed.success && parsed.data.scope !== 'test' && parsed.data.testChatId !== undefined)) return reject(reply, 400);
    try {
      if (parsed.data.scope !== 'disabled') {
        if (!connections.waha) return reject(reply, 503);
        const session = await connections.waha.sessionStatus(parsed.data.session);
        if (session.status !== 'WORKING' || !session.account) return reject(reply, 409);
      }
      await setChannelScope(db, parsed.data.instance, parsed.data.session, parsed.data.scope, parsed.data.testChatId);
      return { ok: true };
    } catch { return reject(reply, 400); }
  });
}
