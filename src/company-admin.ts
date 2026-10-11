import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createDatabase, type Connection, type Database } from './db.js';
import { parseCompanyAIConfig, type CompanyAIConfig } from './ai-config.js';
import { setChannelScope, type ChannelScope } from './channel-scope.js';
import { directChat } from './automation.js';
import { tokenHash } from './store.js';

const aiOnboardingSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/).default('gpt-4o-mini'),
  businessData: z.record(z.string(), z.unknown()).default({}),
  tone: z.string().max(300).default(''),
  instructions: z.string().max(2_000).default(''),
}).strict();

const onboardingSchema = z.object({
  name: z.string().trim().min(1).max(200),
  instance: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  session: z.string().trim().min(1).max(200),
  webhookToken: z.string().regex(/^[a-f0-9]{64}$/),
  ai: aiOnboardingSchema.optional(),
}).strict();

export type CompanyOnboarding = z.infer<typeof onboardingSchema> & { ai: z.infer<typeof aiOnboardingSchema> };

export function parseCompanyOnboarding(input: string): CompanyOnboarding {
  const parsed = onboardingSchema.parse(JSON.parse(input));
  const config: CompanyOnboarding = { ...parsed, ai: parsed.ai ?? aiOnboardingSchema.parse({}) };
  if (JSON.stringify(config.ai.businessData).length > 10_000) throw new Error('businessData exceeds 10000 characters');
  return config;
}

export async function createCompany(db: Database, config: CompanyOnboarding): Promise<void> {
  await db.transaction(tx => insertCompany(tx, config));
}

export async function insertCompany(tx: Connection, config: CompanyOnboarding): Promise<void> {
  const organizationId = randomUUID();
  await tx.query(
    `INSERT INTO organizations(id, name, ai_enabled, ai_model, ai_business_data, ai_tone, ai_instructions)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [organizationId, config.name, config.ai.enabled, config.ai.model, JSON.stringify(config.ai.businessData), config.ai.tone, config.ai.instructions],
  );
  await tx.query(
    `INSERT INTO channels(id, organization_id, instance, session, token_hash, automation_scope)
     VALUES ($1,$2,$3,$4,$5,'disabled')`,
    [randomUUID(), organizationId, config.instance, config.session, tokenHash(config.webhookToken)],
  );
}

export async function configureCompanyAI(
  db: Database, instance: string, session: string, config: CompanyAIConfig,
): Promise<void> {
  await db.transaction(async tx => {
    const channel = await tx.query<{ organization_id: string }>(
      `SELECT c.organization_id FROM channels c JOIN organizations o ON o.id = c.organization_id
       WHERE c.instance = $1 AND c.session = $2 FOR UPDATE OF c, o`, [instance, session]);
    const organizationId = channel.rows[0]?.organization_id;
    if (!organizationId) throw new Error('Channel not found');
    await tx.query(
      `UPDATE organizations SET ai_enabled = $2, ai_model = $3, ai_business_data = $4,
       ai_tone = $5, ai_instructions = $6 WHERE id = $1`,
      [organizationId, config.enabled, config.model, JSON.stringify(config.businessData), config.tone, config.instructions],
    );
  });
}

export async function listCompanies(db: Database): Promise<Array<{
  company: string; instance: string; session: string; organizationActive: boolean;
  channelActive: boolean; aiEnabled: boolean; scope: ChannelScope;
}>> {
  const result = await db.query<{
    company: string; instance: string; session: string; organization_active: boolean;
    channel_active: boolean; ai_enabled: boolean; automation_scope: ChannelScope;
  }>(`SELECT o.name AS company, c.instance, c.session, o.active AS organization_active,
       c.active AS channel_active, o.ai_enabled, c.automation_scope
     FROM organizations o JOIN channels c ON c.organization_id = o.id
     ORDER BY o.name, c.instance, c.session`);
  return result.rows.map(row => ({ company: row.company, instance: row.instance, session: row.session,
    organizationActive: row.organization_active, channelActive: row.channel_active,
    aiEnabled: row.ai_enabled, scope: row.automation_scope }));
}

function parseScope(args: string[]): { instance: string; session: string; scope: ChannelScope; chatId?: string } {
  const [instance, session, scopeArg, detail] = args;
  if (!instance || !session || !['disabled', 'test', 'all'].includes(scopeArg ?? '')) {
    throw new Error('Usage: npm run company:admin -- scope <instance> <session> disabled|test <chatId>|all --confirm-all');
  }
  if (scopeArg === 'all') {
    if (detail !== '--confirm-all' || args.length !== 4) throw new Error('all requires the explicit --confirm-all flag');
    return { instance, session, scope: 'all' };
  }
  if (scopeArg === 'test') {
    if (!detail || args.length !== 4 || !directChat(detail)) throw new Error('test requires one exact direct chat ID');
    return { instance, session, scope: 'test', chatId: detail };
  }
  if (args.length !== 3) throw new Error('disabled takes no extra argument');
  return { instance, session, scope: 'disabled' };
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }
  const { db, close } = createDatabase(process.env.DATABASE_URL);
  try {
    if (action === 'list' && args.length === 0) {
      const rows = await listCompanies(db);
      console.log(['COMPANY\tINSTANCE\tSESSION\tACTIVE\tAI\tSCOPE', ...rows.map(row =>
        `${row.company}\t${row.instance}\t${row.session}\t${row.organizationActive && row.channelActive}\t${row.aiEnabled}\t${row.scope}`)].join('\n'));
    } else if (action === 'create' && args.length === 1) {
      const config = parseCompanyOnboarding(await readFile(resolve(args[0]!), 'utf8'));
      await createCompany(db, config);
      console.log('Company and channel created; channel automation remains disabled');
    } else if (action === 'configure' && args.length === 3) {
      const config = parseCompanyAIConfig(await readFile(resolve(args[2]!), 'utf8'));
      await configureCompanyAI(db, args[0]!, args[1]!, config);
      console.log('Company AI configuration updated; configuration values omitted');
    } else if (action === 'scope') {
      const parsed = parseScope(args);
      await setChannelScope(db, parsed.instance, parsed.session, parsed.scope, parsed.chatId);
      console.log(`Channel automation scope set to ${parsed.scope}; configuration values omitted`);
    } else {
      throw new Error('Usage: npm run company:admin -- list | create <onboarding.json> | configure <instance> <session> <ai.json> | scope <instance> <session> disabled|test <chatId>|all --confirm-all');
    }
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('Usage:') ? error.message
      : error instanceof Error && /requires|takes no extra|exact direct chat/.test(error.message) ? error.message
      : 'Company administration failed; check input, channel mapping and database migration';
    console.error(message);
    process.exitCode = 1;
  } finally { await close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
