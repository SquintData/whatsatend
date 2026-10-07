import Fastify from 'fastify';
import { z } from 'zod';
import { Store } from './store.js';

const envelopeSchema = z.object({
  event: z.string().min(1).max(100), session: z.string().min(1).max(200), payload: z.unknown().optional(),
});
const messageSchema = z.object({
  id: z.string().min(1).max(512), from: z.string().min(1).max(255),
  to: z.string().min(1).max(255).optional(), fromMe: z.boolean(),
  body: z.string().max(16000).optional().default(''),
  timestamp: z.number().int().nonnegative().safe().optional(),
});
const directChat = (id: string) => /^\d+(?:@c\.us|@s\.whatsapp\.net|@lid)$/.test(id);

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
    if (!envelope.success) return reply.code(400).send({ error: 'invalid_event' });
    const channel = await store.authenticate(request.params.instance, envelope.data.session, token);
    if (!channel) return reply.code(401).send({ error: 'unauthorized' });
    if (envelope.data.event !== 'message.any') return reply.code(202).send({ status: 'ignored_event' });
    const parsed = messageSchema.safeParse(envelope.data.payload);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_message' });
    const message = parsed.data;
    if (message.fromMe && !message.to) return reply.code(400).send({ error: 'missing_recipient' });
    const chatId = message.fromMe ? message.to! : message.from;
    if (!directChat(chatId)) return reply.code(202).send({ status: 'ignored_chat' });
    const inserted = await store.receive(channel, message);
    return reply.code(200).send({ status: inserted ? 'stored' : 'duplicate' });
  });
  return app;
}
