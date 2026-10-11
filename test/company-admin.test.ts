import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/db.js';
import { parseCompanyAIConfig } from '../src/ai-config.js';
import { createCompany, configureCompanyAI, listCompanies, parseCompanyOnboarding } from '../src/company-admin.js';
import { setChannelScope } from '../src/channel-scope.js';
import { tokenHash } from '../src/store.js';

async function fixture() {
  const pg = new PGlite();
  for (const file of ['001_initial.sql', '002_fixed_reply.sql', '003_reaction_resume.sql', '004_company_ai.sql', '005_channel_automation_scope.sql', '006_manual_send_claim.sql', '007_reaction_timestamp_precision.sql', '008_channel_onboarding_claim.sql']) {
    await pg.exec(await readFile(new URL(`../sql/${file}`, import.meta.url), 'utf8'));
  }
  const db: Database = {
    query: async <T>(sql: string, values?: unknown[]) => pg.query<T>(sql, values),
    transaction: fn => pg.transaction(tx => fn({ query: async <T>(sql: string, values?: unknown[]) => tx.query<T>(sql, values) })),
  };
  return { pg, db };
}

test('operator onboarding creates isolated company/channel defaults, configures AI, and safely disables automation', async () => {
  const f = await fixture();
  const token = 'c'.repeat(64);
  try {
    const onboarding = parseCompanyOnboarding(JSON.stringify({
      name: 'Clínica A', instance: 'clinic', session: 'whatsapp-a', webhookToken: token,
      ai: { businessData: { address: 'Rua 1', faqs: [{ question: 'Horário?', answer: '9h às 18h' }] } },
    }));
    await createCompany(f.db, onboarding);
    let channel = await f.pg.query<{ organization_id: string; automation_scope: string; token_hash: string }>(
      'SELECT organization_id, automation_scope, token_hash FROM channels WHERE instance = $1 AND session = $2', ['clinic', 'whatsapp-a']);
    assert.equal(channel.rows[0]!.automation_scope, 'disabled');
    assert.equal(channel.rows[0]!.token_hash, tokenHash(token));
    let company = await f.pg.query<{ name: string; ai_enabled: boolean; ai_business_data: { address: string } }>(
      'SELECT name, ai_enabled, ai_business_data FROM organizations WHERE id = $1', [channel.rows[0]!.organization_id]);
    assert.equal(company.rows[0]!.name, 'Clínica A');
    assert.equal(company.rows[0]!.ai_enabled, false);
    assert.equal(company.rows[0]!.ai_business_data.address, 'Rua 1');
    assert.deepEqual(await listCompanies(f.db), [{ company: 'Clínica A', instance: 'clinic', session: 'whatsapp-a',
      organizationActive: true, channelActive: true, aiEnabled: false, scope: 'disabled' }]);

    await configureCompanyAI(f.db, 'clinic', 'whatsapp-a', parseCompanyAIConfig(JSON.stringify({
      enabled: true, model: 'gpt-4o-mini', businessData: { address: 'Rua 2', services: ['Consulta'] },
      tone: 'cordial', instructions: 'Não invente disponibilidade.',
    })));
    company = await f.pg.query<{ ai_enabled: boolean; ai_business_data: { address: string }; ai_tone: string }>(
      'SELECT ai_enabled, ai_business_data, ai_tone FROM organizations WHERE id = $1', [channel.rows[0]!.organization_id]);
    assert.equal(company.rows[0]!.ai_enabled, true);
    assert.equal(company.rows[0]!.ai_business_data.address, 'Rua 2');
    assert.equal(company.rows[0]!.ai_tone, 'cordial');

    await setChannelScope(f.db, 'clinic', 'whatsapp-a', 'test', '5511999999999@c.us');
    await f.pg.query(`INSERT INTO conversations(id, organization_id, channel_id, chat_id, mode)
      VALUES ($1, $2, $3, '5511999999999@c.us', 'auto')`, [randomUUID(), channel.rows[0]!.organization_id,
      (await f.pg.query<{ id: string }>('SELECT id FROM channels WHERE instance = $1', ['clinic'])).rows[0]!.id]);
    const conversation = (await f.pg.query<{ id: string; organization_id: string; channel_id: string }>(
      'SELECT id, organization_id, channel_id FROM conversations')).rows[0]!;
    const messageId = randomUUID();
    await f.pg.query(`INSERT INTO messages(id, organization_id, channel_id, conversation_id, provider_message_id, direction, body)
      VALUES ($1,$2,$3,$4,'pending-source','incoming','hello')`,
      [messageId, conversation.organization_id, conversation.channel_id, conversation.id]);
    await f.pg.query(`INSERT INTO reply_jobs(id, organization_id, channel_id, conversation_id, source_message_id, epoch, body)
      VALUES ($1,$2,$3,$4,$5,1,'reply')`,
      [randomUUID(), conversation.organization_id, conversation.channel_id, conversation.id, messageId]);
    await setChannelScope(f.db, 'clinic', 'whatsapp-a', 'disabled');
    assert.equal((await f.pg.query('SELECT mode FROM conversations')).rows[0]!.mode, 'monitoring');
    assert.equal((await f.pg.query('SELECT state FROM reply_jobs')).rows[0]!.state, 'cancelled');
    assert.equal((await f.pg.query<{ automation_scope: string }>('SELECT automation_scope FROM channels')).rows[0]!.automation_scope, 'disabled');
  } finally { await f.pg.close(); }
});

test('onboarding rejects invalid tokens and oversized business data', () => {
  assert.throws(() => parseCompanyOnboarding(JSON.stringify({
    name: 'Bad', instance: 'i', session: 's', webhookToken: 'secret',
  })));
  assert.throws(() => parseCompanyOnboarding(JSON.stringify({
    name: 'Big', instance: 'i', session: 's', webhookToken: 'd'.repeat(64),
    ai: { businessData: { content: 'x'.repeat(10_001) } },
  })));
});
