import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { disabledAutomation, FIXED_REPLY, SendError, type Automation, type Sender } from './automation.js';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Channel { id: string; organization_id: string; session: string; instance?: string }
export interface Message {
  id: string; from: string; to?: string; fromMe: boolean; body: string; timestamp?: number;
}
export interface Reaction {
  id: string; timestamp: number; fromMe: boolean; source?: string;
  reaction: { text: string; messageId: string };
}

export class Store {
  constructor(private db: Database, private automation: Automation = disabledAutomation) {}

  async authenticate(instance: string, session: string, token: string): Promise<Channel | undefined> {
    const result = await this.db.query<Channel>(
      `SELECT c.id, c.organization_id, c.session, c.instance FROM channels c
       JOIN organizations o ON o.id = c.organization_id
       WHERE c.instance = $1 AND c.session = $2 AND c.token_hash = $3
       AND c.active AND o.active`, [instance, session, tokenHash(token)],
    );
    return result.rows[0];
  }

  async receive(channel: Channel, message: Message): Promise<boolean> {
    const chatId = message.fromMe ? message.to! : message.from;
    return this.db.transaction(async (tx) => {
      // Consistent channel -> conversation -> job lock order. Holding this channel
      // lock during a bounded send also serializes an echo arriving before its ID.
      await tx.query('SELECT id FROM channels WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [channel.id, channel.organization_id]);
      if (message.fromMe) {
        const own = await tx.query(
          `SELECT id FROM reply_jobs WHERE channel_id = $1 AND provider_message_id = $2 AND state = 'sent'`,
          [channel.id, message.id],
        );
        if (own.rows.length) return false;
      }
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
      if (inserted.rows.length && message.fromMe) {
        await tx.query(
          `UPDATE conversations SET mode = 'human', automation_epoch = automation_epoch + 1,
           control_timestamp = GREATEST(control_timestamp, $3, floor(extract(epoch FROM now()))::bigint)
           WHERE id = $1 AND organization_id = $2`,
          [conversationId, channel.organization_id, message.timestamp ?? 0],
        );
        await tx.query(`UPDATE reply_jobs SET state = 'cancelled', completed_at = now()
          WHERE conversation_id = $1 AND state = 'pending'`, [conversationId]);
      } else if (inserted.rows.length && !message.fromMe && message.body.trim()
        && this.automation.enabled && channel.instance === this.automation.instance
        && channel.session === this.automation.session && chatId === this.automation.chatId
        && message.timestamp !== undefined) {
        // Only fresh messages after an explicit resume can enqueue a reply.
        await tx.query(
          `INSERT INTO reply_jobs(id, organization_id, channel_id, conversation_id, source_message_id, epoch, body)
           SELECT $1, cv.organization_id, cv.channel_id, cv.id, $2, cv.automation_epoch, $3
           FROM conversations cv WHERE cv.id = $4 AND cv.mode = 'auto'
             AND $5 >= floor(extract(epoch FROM cv.automation_started_at))
             AND $5 >= extract(epoch FROM now()) - 120 AND $5 <= extract(epoch FROM now()) + 30
             AND NOT EXISTS (SELECT 1 FROM reply_jobs j WHERE j.conversation_id = cv.id
               AND j.epoch = cv.automation_epoch AND (j.state IN ('pending','sending','uncertain')
                 OR (j.state = 'sent' AND j.completed_at > now() - interval '5 seconds')))
           ON CONFLICT (source_message_id) DO NOTHING`,
          [randomUUID(), inserted.rows[0]!.id, FIXED_REPLY, conversationId, message.timestamp],
        );
      }
      return inserted.rows.length > 0;
    });
  }

  async react(channel: Channel, reaction: Reaction): Promise<string> {
    const settings = this.automation;
    if (!reaction.fromMe || reaction.source !== 'app' || reaction.reaction.text !== '🤖') return 'ignored_reaction';
    if (!settings.enabled || channel.instance !== settings.instance || channel.session !== settings.session) return 'disabled_scope';
    return this.db.transaction(async tx => {
      const active = await tx.query(
        `SELECT c.id FROM channels c JOIN organizations o ON o.id = c.organization_id
         WHERE c.id = $1 AND c.organization_id = $2 AND c.active AND o.active FOR UPDATE OF c`,
        [channel.id, channel.organization_id]);
      if (!active.rows.length) return 'disabled_scope';
      // Resolve the reacted-to message inside this authenticated tenant/channel.
      // Reaction direction identifies the actor; target direction identifies the customer message.
      const target = await tx.query<{ id: string }>(
        `SELECT cv.id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
         WHERE m.channel_id = $1 AND m.organization_id = $2 AND m.provider_message_id = $3
         AND m.direction = 'incoming' AND cv.chat_id = $4 FOR UPDATE OF cv`,
        [channel.id, channel.organization_id, reaction.reaction.messageId, settings.chatId]);
      if (!target.rows[0]) return 'ignored_target';
      const id = target.rows[0].id;
      const inserted = await tx.query(
        `INSERT INTO reaction_commands(organization_id, channel_id, conversation_id, provider_event_id, provider_timestamp)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (channel_id, provider_event_id) DO NOTHING RETURNING provider_event_id`,
        [channel.organization_id, channel.id, id, reaction.id, reaction.timestamp]);
      if (!inserted.rows.length) return 'duplicate';
      const resumed = await tx.query(
        `UPDATE conversations SET mode = 'auto', automation_epoch = automation_epoch + 1,
         automation_started_at = GREATEST(now(), to_timestamp($2 + 1)), control_timestamp = $2
         WHERE id = $1 AND mode IN ('human','monitoring') AND $2 > control_timestamp
         AND $2 >= extract(epoch FROM now()) - 120 AND $2 <= extract(epoch FROM now()) + 30
         RETURNING id`, [id, reaction.timestamp]);
      if (!resumed.rows.length) return 'ignored_state_or_timestamp';
      await tx.query(`UPDATE reply_jobs SET state = 'cancelled', completed_at = now()
        WHERE conversation_id = $1 AND state = 'pending'`, [id]);
      // No reply is enqueued here: only a new incoming message can trigger it.
      return 'resumed';
    });
  }

  async control(action: 'resume' | 'pause'): Promise<void> {
    const settings = this.automation;
    if (!settings.instance || !settings.session || !settings.chatId || (action === 'resume' && !settings.enabled)) {
      throw new Error('Configure the test scope; resume also requires AUTO_REPLY_ENABLED=true');
    }
    await this.db.transaction(async tx => {
      const channel = await tx.query<{ id: string }>(
        `SELECT c.id FROM channels c JOIN organizations o ON o.id = c.organization_id
         WHERE c.instance = $1 AND c.session = $2 AND c.active AND o.active FOR UPDATE OF c`,
        [settings.instance, settings.session],
      );
      if (!channel.rows[0]) throw new Error('Active channel not found');
      const conversations = await tx.query<{ id: string }>(
        `UPDATE conversations SET mode = $1, automation_epoch = automation_epoch + 1,
         automation_started_at = CASE WHEN $1 = 'auto' THEN now() ELSE automation_started_at END,
         control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint)
         WHERE channel_id = $2 AND chat_id = $3 RETURNING id`,
        [action === 'resume' ? 'auto' : 'human', channel.rows[0].id, settings.chatId],
      );
      if (!conversations.rows[0]) throw new Error('Test conversation not found; receive a message first');
      await tx.query(`UPDATE reply_jobs SET state = 'cancelled', completed_at = now()
        WHERE conversation_id = $1 AND state = 'pending'`, [conversations.rows[0].id]);
    });
  }

  async recoverInterrupted(): Promise<void> {
    await this.db.transaction(async tx => {
      const channels = await tx.query<{ id: string }>(
        `SELECT c.id FROM channels c WHERE EXISTS (
           SELECT 1 FROM reply_jobs j WHERE j.channel_id = c.id AND j.state = 'sending'
           AND j.claimed_at < now() - interval '60 seconds')
         ORDER BY c.id FOR UPDATE OF c SKIP LOCKED`,
      );
      for (const channel of channels.rows) {
        const jobs = await tx.query<{ conversation_id: string; epoch: number }>(
          `UPDATE reply_jobs SET state = 'uncertain', completed_at = now()
           WHERE channel_id = $1 AND state = 'sending' AND claimed_at < now() - interval '60 seconds'
           RETURNING conversation_id, epoch`, [channel.id],
        );
        for (const job of jobs.rows) {
          await tx.query(`UPDATE conversations SET mode = 'human', automation_epoch = automation_epoch + 1,
            control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint)
            WHERE id = $1 AND automation_epoch = $2`, [job.conversation_id, job.epoch]);
          await tx.query(`UPDATE reply_jobs SET state = 'cancelled', completed_at = now()
            WHERE conversation_id = $1 AND epoch = $2 AND state = 'pending'`, [job.conversation_id, job.epoch]);
        }
      }
    });
  }

  async processNext(sender: Sender): Promise<boolean> {
    const settings = this.automation;
    if (!settings.enabled) return false;
    const claimed = await this.db.query<{ id: string; channel_id: string; conversation_id: string }>(
      `WITH candidate AS (
         SELECT j.id FROM reply_jobs j JOIN channels c ON c.id = j.channel_id
         JOIN conversations cv ON cv.id = j.conversation_id
         WHERE j.state = 'pending' AND c.instance = $1 AND c.session = $2 AND cv.chat_id = $3
         ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ) UPDATE reply_jobs j SET state = 'sending', claimed_at = now()
         FROM candidate WHERE j.id = candidate.id RETURNING j.id, j.channel_id, j.conversation_id`,
      [settings.instance, settings.session, settings.chatId],
    );
    const job = claimed.rows[0];
    if (!job) return false;
    await this.db.transaction(async tx => {
      const channels = await tx.query<{ active: boolean; organization_id: string; instance: string; session: string }>(
        'SELECT active, organization_id, instance, session FROM channels WHERE id = $1 FOR UPDATE', [job.channel_id],
      );
      const conversations = await tx.query<{ mode: string; automation_epoch: number; chat_id: string }>(
        'SELECT mode, automation_epoch, chat_id FROM conversations WHERE id = $1 FOR UPDATE', [job.conversation_id],
      );
      const jobs = await tx.query<{ state: string; epoch: number; body: string; fresh: boolean }>(
        `SELECT j.state, j.epoch, j.body,
          (m.provider_timestamp >= extract(epoch FROM now()) - 120) AS fresh
         FROM reply_jobs j JOIN messages m ON m.id = j.source_message_id WHERE j.id = $1 FOR UPDATE OF j`, [job.id],
      );
      const channel = channels.rows[0]!;
      const conversation = conversations.rows[0]!;
      const current = jobs.rows[0]!;
      const organization = await tx.query<{ active: boolean }>('SELECT active FROM organizations WHERE id = $1', [channel.organization_id]);
      if (current.state !== 'sending') return;
      if (!channel.active || !organization.rows[0]?.active || conversation.mode !== 'auto'
        || conversation.automation_epoch !== current.epoch || !current.fresh
        || channel.instance !== settings.instance || channel.session !== settings.session || conversation.chat_id !== settings.chatId) {
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE id = $1", [job.id]);
        return;
      }
      // No automatic retries after any network attempt: an error may hide a send.
      let result: { id: string };
      try {
        result = await sender.send({ session: channel.session, chatId: conversation.chat_id, text: current.body });
      } catch (error) {
        const outcome = error instanceof SendError ? error.outcome : 'uncertain';
        await tx.query('UPDATE reply_jobs SET state = $1, completed_at = now() WHERE id = $2', [outcome, job.id]);
        await tx.query("UPDATE conversations SET mode = 'human', automation_epoch = automation_epoch + 1, control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint) WHERE id = $1", [job.conversation_id]);
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE conversation_id = $1 AND state = 'pending'", [job.conversation_id]);
        return;
      }
      await tx.query(
        `INSERT INTO messages(id, organization_id, channel_id, conversation_id, provider_message_id, direction, body)
         VALUES ($1,$2,$3,$4,$5,'outgoing',$6)`,
        [randomUUID(), channel.organization_id, job.channel_id, job.conversation_id, result.id, current.body],
      );
      await tx.query("UPDATE reply_jobs SET state = 'sent', provider_message_id = $1, completed_at = now() WHERE id = $2", [result.id, job.id]);
    });
    return true;
  }

  async ready() { await this.db.query('SELECT 1'); }
}
