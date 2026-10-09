import Fastify from 'fastify';
import { z } from 'zod';
import { Store } from './store.js';
import { directChat } from './automation.js';

const envelopeSchema = z.object({
  event: z.string().min(1).max(100), session: z.string().min(1).max(200), payload: z.unknown().optional(),
});
const messageSchema = z.object({
  id: z.string().min(1).max(512), from: z.string().min(1).max(255),
  to: z.string().min(1).max(255).nullish().transform(value => value ?? undefined), fromMe: z.boolean(),
  body: z.string().max(16000).optional().default(''),
  timestamp: z.number().int().nonnegative().safe().optional(),
  _data: z.unknown().optional(),
});
const gowsChatSchema = z.object({ Info: z.object({ Chat: z.string().min(1).max(255) }) });
const reactionSchema = z.object({
  id: z.string().min(1).max(512), timestamp: z.number().int().nonnegative().safe(),
  fromMe: z.boolean(), source: z.string().max(32).optional(),
  reaction: z.object({ text: z.string().max(32).nullish().transform(value => value ?? ''), messageId: z.string().min(1).max(512) }),
});

export function buildApp(store: Store, logger = false) {
  const app = Fastify({
    logger: logger ? {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers["x-webhook-token"]', 'req.headers["x-api-key"]'],
    } : false,
    disableRequestLogging: true, bodyLimit: 256 * 1024,
  });
  app.setErrorHandler((error, request, reply) => {
    const code = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 503;
    if (status === 503) request.log.error({ requestId: request.id }, 'Request failed; payload omitted');
    else request.log.warn({ requestId: request.id, status }, 'HTTP request rejected; payload omitted');
    reply.code(status).send({ error: status === 503 ? 'service_unavailable' : 'invalid_request' });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => { await store.ready(); return { status: 'ready' }; });

  app.post<{ Params: { instance: string } }>('/webhooks/waha/:instance', async (request, reply) => {
    const token = request.headers['x-webhook-token'];
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const envelope = envelopeSchema.safeParse(request.body);
    if (!envelope.success) {
      request.log.warn({ reason: 'invalid_event', issues: envelope.error.issues.map(issue => ({ field: issue.path[0], code: issue.code })) }, 'WAHA webhook rejected');
      return reply.code(400).send({ error: 'invalid_event' });
    }
    const channel = await store.authenticate(request.params.instance, envelope.data.session, token);
    if (!channel) return reply.code(401).send({ error: 'unauthorized' });
    if (envelope.data.event === 'message.reaction') {
      const parsed = reactionSchema.safeParse(envelope.data.payload);
      if (!parsed.success) {
        request.log.warn({ reason: 'invalid_reaction', issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), code: issue.code })) }, 'WAHA reaction rejected; payload omitted');
        return reply.code(400).send({ error: 'invalid_reaction' });
      }
      const result = await store.react(channel, parsed.data);
      request.log.info({ result, fromMe: parsed.data.fromMe, source: parsed.data.source }, 'WAHA reaction processed');
      return reply.code(200).send({ status: result });
    }
    if (envelope.data.event !== 'message.any') return reply.code(202).send({ status: 'ignored_event' });
    const parsed = messageSchema.safeParse(envelope.data.payload);
    if (!parsed.success) {
      request.log.warn({ reason: 'invalid_message', issues: parsed.error.issues.map(issue => ({ field: issue.path[0], code: issue.code })) }, 'WAHA webhook rejected');
      return reply.code(400).send({ error: 'invalid_message' });
    }
    const { _data, ...message } = parsed.data;
    if (!message.fromMe || !message.to) {
      // GOWS app-sent messages can omit `to`; Info.Chat identifies the conversation.
      // Never substitute Info.Sender or `from`, which may identify our own account.
      const gowsChat = gowsChatSchema.safeParse(_data);
      if (gowsChat.success) {
        if (message.fromMe) message.to = gowsChat.data.Info.Chat;
        else message.from = gowsChat.data.Info.Chat;
      }
    }
    if (message.fromMe && !message.to) {
      request.log.warn({ reason: 'missing_recipient' }, 'WAHA webhook rejected');
      return reply.code(400).send({ error: 'missing_recipient' });
    }
    const chatId = message.fromMe ? message.to! : message.from;
    if (!directChat(chatId)) return reply.code(202).send({ status: 'ignored_chat' });
    const inserted = await store.receive(channel, message);
    return reply.code(200).send({ status: inserted ? 'stored' : 'duplicate' });
  });
  return app;
}
