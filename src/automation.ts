import { z } from 'zod';

export const FIXED_REPLY = 'Olá! Recebemos sua mensagem. Este é um teste do atendimento automático.';
export const directChat = (id: string) => /^\d+(?:@c\.us|@s\.whatsapp\.net|@lid)$/.test(id);
export interface Automation {
  enabled: boolean;
  instance: string;
  session: string;
  chatId: string;
  wahaUrl: string;
  apiKey: string;
}
export const disabledAutomation: Automation = {
  enabled: false, instance: '', session: '', chatId: '', wahaUrl: '', apiKey: '',
};
export function loadAutomation(env: NodeJS.ProcessEnv): Automation {
  if (env.AUTO_REPLY_ENABLED !== undefined && !['true', 'false'].includes(env.AUTO_REPLY_ENABLED)) {
    throw new Error('AUTO_REPLY_ENABLED must be true or false');
  }
  const enabled = env.AUTO_REPLY_ENABLED === 'true';
  if (!enabled) return {
    ...disabledAutomation,
    instance: env.AUTO_REPLY_INSTANCE ?? '', session: env.AUTO_REPLY_SESSION ?? '', chatId: env.TEST_CHAT_ID ?? '',
  };
  const parsed = z.object({
    AUTO_REPLY_INSTANCE: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    AUTO_REPLY_SESSION: z.string().min(1).max(200),
    TEST_CHAT_ID: z.string().refine(directChat),
    WAHA_BASE_URL: z.string().url().refine(value => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && !url.search && !url.hash && ['/', ''].includes(url.pathname);
    }),
    WAHA_API_KEY: z.string().min(32).max(256).refine(value => value === value.trim()),
  }).safeParse(env);
  if (!parsed.success) throw new Error('Invalid automation configuration; check scope, test chat, WAHA URL and key');
  return {
    enabled, instance: parsed.data.AUTO_REPLY_INSTANCE, session: parsed.data.AUTO_REPLY_SESSION,
    chatId: parsed.data.TEST_CHAT_ID, wahaUrl: parsed.data.WAHA_BASE_URL.replace(/\/$/, ''), apiKey: parsed.data.WAHA_API_KEY,
  };
}

export interface SendRequest { session: string; chatId: string; text: string }
export interface Sender { send(request: SendRequest): Promise<{ id: string }> }
export class SendError extends Error {
  constructor(public readonly outcome: 'failed' | 'uncertain') { super('WAHA send failed; details omitted'); }
}
export class WahaSender implements Sender {
  constructor(private settings: Automation, private transport: typeof fetch = fetch) {}
  async send(request: SendRequest): Promise<{ id: string }> {
    if (!this.settings.enabled || request.session !== this.settings.session || request.chatId !== this.settings.chatId) {
      throw new SendError('failed');
    }
    try {
      const response = await this.transport(`${this.settings.wahaUrl}/api/sendText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.settings.apiKey },
        body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        // Even an HTTP error can follow a partial send; never retry automatically.
        throw new SendError(response.status === 401 || response.status === 403 ? 'failed' : 'uncertain');
      }
      const result = z.object({ id: z.string().min(1).max(512) }).safeParse(await response.json());
      if (!result.success) throw new SendError('uncertain');
      return result.data;
    } catch (error) {
      if (error instanceof SendError) throw error;
      throw new SendError('uncertain');
    }
  }
}
