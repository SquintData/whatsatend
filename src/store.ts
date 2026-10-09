import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { disabledAutomation, FIXED_REPLY, SendError, type Automation, type Sender } from './automation.js';
import type { AIContext, AIDecision, AIProvider } from './ai.js';

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
  constructor(private db: Database, private automation: Automation = disabledAutomation, private aiProvider?: AIProvider) {}

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
           SELECT 1 FROM reply_jobs j WHERE j.channel_id = c.id AND j.state IN ('sending','generating')
           AND j.claimed_at < now() - interval '60 seconds')
         ORDER BY c.id FOR UPDATE OF c SKIP LOCKED`,
      );
      for (const channel of channels.rows) {
        const jobs = await tx.query<{ conversation_id: string; epoch: number }>(
          `UPDATE reply_jobs SET state = 'uncertain', completed_at = now()
           WHERE channel_id = $1 AND state IN ('sending','generating') AND claimed_at < now() - interval '60 seconds'
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
    const claimed = await this.db.query<{ id: string; organization_id: string; channel_id: string; conversation_id: string; epoch: number; ai_enabled: boolean }>(
      `WITH candidate AS (
         SELECT j.id, o.ai_enabled FROM reply_jobs j JOIN channels c ON c.id = j.channel_id
         JOIN organizations o ON o.id = j.organization_id
         JOIN conversations cv ON cv.id = j.conversation_id
         WHERE j.state = 'pending' AND c.instance = $1 AND c.session = $2 AND cv.chat_id = $3
         ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ) UPDATE reply_jobs j SET state = CASE WHEN candidate.ai_enabled THEN 'generating' ELSE 'sending' END,
         claimed_at = now() FROM candidate WHERE j.id = candidate.id
         RETURNING j.id, j.organization_id, j.channel_id, j.conversation_id, j.epoch, candidate.ai_enabled`,
      [settings.instance, settings.session, settings.chatId],
    );
    const job = claimed.rows[0];
    if (!job) return false;

    let aiDecision: AIDecision | undefined;
    let aiModel: string | undefined;
    if (job.ai_enabled && this.aiProvider) {
      const config = await this.db.query<{
        company_name: string; ai_model: string; ai_business_data: Record<string, unknown>;
        ai_tone: string; ai_instructions: string; mode: string; automation_epoch: number;
        chat_id: string; active: boolean; organization_active: boolean; message: string; source_message_id: string;
      }>(
        `SELECT o.name AS company_name, o.ai_model, o.ai_business_data, o.ai_tone, o.ai_instructions,
           cv.mode, cv.automation_epoch, cv.chat_id, c.active, o.active AS organization_active,
           m.body AS message, j.source_message_id
         FROM reply_jobs j JOIN organizations o ON o.id = j.organization_id
         JOIN channels c ON c.id = j.channel_id AND c.organization_id = j.organization_id
         JOIN conversations cv ON cv.id = j.conversation_id AND cv.organization_id = j.organization_id
           AND cv.channel_id = j.channel_id
         JOIN messages m ON m.id = j.source_message_id AND m.organization_id = j.organization_id
           AND m.channel_id = j.channel_id AND m.conversation_id = j.conversation_id
         WHERE j.id = $1 AND j.organization_id = $2 AND j.state = 'generating'`,
        [job.id, job.organization_id],
      );
      const current = config.rows[0];
      if (current) {
        aiModel = current.ai_model;
        try {
          if (!current.active || !current.organization_active || current.mode !== 'auto'
            || current.automation_epoch !== job.epoch || current.chat_id !== settings.chatId) {
            throw new Error('AI job is no longer active');
          }
          const history = await this.db.query<{ direction: 'incoming' | 'outgoing'; body: string }>(
            `SELECT direction, body FROM messages WHERE organization_id = $1 AND conversation_id = $2
             AND received_at < (SELECT received_at FROM messages WHERE id = $3)
             ORDER BY received_at DESC LIMIT 8`,
            [job.organization_id, job.conversation_id, current.source_message_id],
          );
          const context: AIContext = {
            companyName: current.company_name, businessData: current.ai_business_data,
            tone: current.ai_tone, instructions: current.ai_instructions,
            history: history.rows.reverse().map(item => ({ ...item, body: item.body.slice(0, 1_200) })),
            message: current.message.slice(0, 4_000),
          };
          if (!this.aiProvider) throw new Error('AI provider unavailable');
          aiDecision = await this.aiProvider.generate(context, current.ai_model);
          if ((aiDecision.decision === 'reply' && (!aiDecision.reply.trim() || aiDecision.reply.length > 1_500 || aiDecision.handoffReason !== null))
            || (aiDecision.decision === 'handoff' && (aiDecision.reply !== '' || !aiDecision.handoffReason))) {
            throw new Error('AI provider returned an invalid decision');
          }
        } catch {
          await this.finishAIFailure(job);
          return true;
        }
      } else {
        await this.finishAIFailure(job);
        return true;
      }
      try {
        await this.db.query(
          `INSERT INTO ai_usage(reply_job_id, organization_id, model, input_tokens, output_tokens)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reply_job_id) DO NOTHING`,
          [job.id, job.organization_id, aiModel, aiDecision.inputTokens, aiDecision.outputTokens],
        );
      } catch {
        await this.finishAIFailure(job);
        return true;
      }
    } else if (job.ai_enabled) {
      // An opted-in company without a configured provider fails closed to a human.
      await this.finishAIFailure(job);
      return true;
    }

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
      const organization = await tx.query<{ active: boolean; ai_enabled: boolean }>(
        'SELECT active, ai_enabled FROM organizations WHERE id = $1 FOR UPDATE', [channel.organization_id]);
      if (current.state !== (aiDecision ? 'generating' : 'sending')) return;
      if (!channel.active || !organization.rows[0]?.active || conversation.mode !== 'auto'
        || conversation.automation_epoch !== current.epoch || current.epoch !== job.epoch || !current.fresh
        || channel.instance !== settings.instance || channel.session !== settings.session || conversation.chat_id !== settings.chatId
        || (aiDecision !== undefined && !organization.rows[0].ai_enabled)) {
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE id = $1", [job.id]);
        return;
      }
      if (aiDecision?.decision === 'handoff') {
        await tx.query(`UPDATE conversations SET mode = 'human', automation_epoch = automation_epoch + 1,
          control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint) WHERE id = $1`, [job.conversation_id]);
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE id = $1", [job.id]);
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE conversation_id = $1 AND state = 'pending'", [job.conversation_id]);
        return;
      }
      // No automatic retries after any network attempt: an error may hide a send.
      let result: { id: string };
      try {
        result = await sender.send({ session: channel.session, chatId: conversation.chat_id, text: aiDecision?.reply ?? current.body });
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
        [randomUUID(), channel.organization_id, job.channel_id, job.conversation_id, result.id, aiDecision?.reply ?? current.body],
      );
      await tx.query("UPDATE reply_jobs SET state = 'sent', provider_message_id = $1, completed_at = now() WHERE id = $2", [result.id, job.id]);
    });
    return true;
  }

  private async finishAIFailure(job: { id: string; channel_id: string; conversation_id: string; epoch: number }): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query('SELECT id FROM channels WHERE id = $1 FOR UPDATE', [job.channel_id]);
      await tx.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [job.conversation_id]);
      const current = await tx.query<{ state: string; epoch: number }>(
        'SELECT state, epoch FROM reply_jobs WHERE id = $1 FOR UPDATE', [job.id]);
      if (current.rows[0]?.state !== 'generating') return;
      await tx.query("UPDATE reply_jobs SET state = 'failed', completed_at = now() WHERE id = $1", [job.id]);
      const conversation = await tx.query<{ mode: string; automation_epoch: number }>(
        'SELECT mode, automation_epoch FROM conversations WHERE id = $1', [job.conversation_id]);
      if (conversation.rows[0]?.mode === 'auto' && conversation.rows[0].automation_epoch === job.epoch
        && current.rows[0].epoch === job.epoch) {
        await tx.query(`UPDATE conversations SET mode = 'human', automation_epoch = automation_epoch + 1,
          control_timestamp = GREATEST(control_timestamp, floor(extract(epoch FROM now()))::bigint) WHERE id = $1`, [job.conversation_id]);
        await tx.query("UPDATE reply_jobs SET state = 'cancelled', completed_at = now() WHERE conversation_id = $1 AND state = 'pending'", [job.conversation_id]);
      }
    });
  }

  async ready() { await this.db.query('SELECT 1'); }
}
