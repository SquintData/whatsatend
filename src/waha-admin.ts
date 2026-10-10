import { z } from 'zod';

export interface WahaAdminSettings { baseUrl: string; apiKey: string }
export interface WahaSessionStatus { status: string; engine: string | null; account: string | null }

const sessionName = z.string().min(1).max(200);
const apiFailure = () => new Error('WAHA request failed; details omitted');

export class WahaAdminClient {
  private readonly baseUrl: string;
  constructor(settings: WahaAdminSettings, private readonly transport: typeof fetch = fetch) {
    const parsed = z.string().url().safeParse(settings.baseUrl);
    if (!parsed.success || !['http:', 'https:'].includes(new URL(settings.baseUrl).protocol)
      || new URL(settings.baseUrl).username || new URL(settings.baseUrl).password
      || new URL(settings.baseUrl).search || new URL(settings.baseUrl).hash
      || !['', '/'].includes(new URL(settings.baseUrl).pathname)
      || settings.apiKey.length < 32 || settings.apiKey.length > 256 || settings.apiKey !== settings.apiKey.trim()) {
      throw new Error('Invalid WAHA admin configuration');
    }
    this.baseUrl = settings.baseUrl.replace(/\/$/, '');
    this.apiKeyValue = settings.apiKey;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await this.transport(`${this.baseUrl}${path}`, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(8_000),
        headers: { 'X-Api-Key': this.apiKey(), ...init.headers },
      });
      if (!response.ok) throw apiFailure();
      return response;
    } catch { throw apiFailure(); }
  }

  // Keep the key in a private closure-like field and never include it in errors.
  private apiKeyValue = '';
  private apiKey(): string { return this.apiKeyValue; }

  async listSessions(): Promise<Array<{ name: string; status: string }>> {
    const body: unknown = await (await this.request('/api/sessions?all=true')).json();
    const parsed = z.array(z.object({ name: sessionName, status: z.string().min(1).max(100) })).safeParse(body);
    if (!parsed.success) throw apiFailure();
    return parsed.data;
  }

  async createStoppedSession(name: string, webhookUrl: string, webhookToken: string): Promise<void> {
    sessionName.parse(name);
    const response = await this.request('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start: false, config: { webhooks: [{
        url: webhookUrl, events: ['message.any', 'message.reaction', 'session.status'],
        customHeaders: { 'X-Webhook-Token': webhookToken },
      }] } }),
    });
    await response.body?.cancel();
  }

  async startSession(name: string): Promise<void> {
    sessionName.parse(name);
    const response = await this.request(`/api/sessions/${encodeURIComponent(name)}/start`, { method: 'POST' });
    await response.body?.cancel();
  }

  async sessionStatus(name: string): Promise<WahaSessionStatus> {
    sessionName.parse(name);
    const body: unknown = await (await this.request(`/api/sessions/${encodeURIComponent(name)}`)).json();
    const parsed = z.object({ status: z.string().min(1).max(100),
      engine: z.union([z.string().max(100), z.record(z.enum(['engine', 'grpc', 'gows']), z.unknown())]).nullish(),
      me: z.object({ id: z.string().max(255).optional() }).nullish() }).safeParse(body);
    if (!parsed.success) throw apiFailure();
    const engine = typeof parsed.data.engine === 'string' ? parsed.data.engine
      : typeof parsed.data.engine?.engine === 'string' && parsed.data.engine.engine.length <= 100
        ? parsed.data.engine.engine : null;
    return { status: parsed.data.status, engine, account: parsed.data.me?.id ?? null };
  }

  async qrPng(name: string): Promise<Uint8Array> {
    sessionName.parse(name);
    const response = await this.request(`/api/${encodeURIComponent(name)}/auth/qr`, { headers: { Accept: 'image/png' } });
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/png')) throw apiFailure();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 8 || bytes.length > 2_000_000
      || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw apiFailure();
    return bytes;
  }
}

export function optionalWahaAdmin(baseUrl?: string, apiKey?: string): WahaAdminClient | undefined {
  if (!baseUrl || !apiKey) return undefined;
  try { return new WahaAdminClient({ baseUrl, apiKey }); } catch { return undefined; }
}

export function parsePublicBaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname)) return undefined;
    return url.origin;
  } catch { return undefined; }
}
