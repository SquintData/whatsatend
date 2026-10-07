import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './db.js';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Channel { id: string; organization_id: string; session: string }
export interface Message {
  id: string; from: string; to?: string; fromMe: boolean; body: string; timestamp?: number;
}

export class Store {
  constructor(private db: Database) {}

  async authenticate(instance: string, session: string, token: string): Promise<Channel | undefined> {
    const result = await this.db.query<Channel>(
      `SELECT c.id, c.organization_id, c.session FROM channels c
       JOIN organizations o ON o.id = c.organization_id
       WHERE c.instance = $1 AND c.session = $2 AND c.token_hash = $3
       AND c.active AND o.active`, [instance, session, tokenHash(token)],
    );
    return result.rows[0];
  }

  async receive(channel: Channel, message: Message): Promise<boolean> {
    const chatId = message.fromMe ? message.to! : message.from;
    return this.db.transaction(async (tx) => {
      // Locks one conversation so concurrent events cannot create conflicting state.
      const conversations = await tx.query<{ id: string }>(
        `INSERT INTO conversations(id, organization_id, channel_id, chat_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, chat_id) DO UPDATE SET chat_id = EXCLUDED.chat_id
         RETURNING id`, [randomUUID(), channel.organization_id, channel.id, chatId],
      );
      const conversationId = conversations.rows[0]!.id;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages(id, organization_id, channel_id, conversation_id,
         provider_message_id, direction, body, provider_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (channel_id, provider_message_id) DO NOTHING RETURNING id`,
        [randomUUID(), channel.organization_id, channel.id, conversationId,
          message.id, message.fromMe ? 'outgoing' : 'incoming', message.body, message.timestamp ?? null],
      );
      // No automatic sends exist yet: any outgoing event moves to human mode.
      // Before enabling sends, correlate own API sends with provider message IDs.
      if (inserted.rows.length && message.fromMe) {
        await tx.query(
          `UPDATE conversations SET mode = 'human' WHERE id = $1 AND organization_id = $2`,
          [conversationId, channel.organization_id],
        );
      }
      return inserted.rows.length > 0;
    });
  }

  async ready() { await this.db.query('SELECT 1'); }
}
