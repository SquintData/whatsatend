import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createDatabase } from './db.js';

const configSchema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/),
  businessData: z.record(z.string(), z.unknown()).default({}),
  tone: z.string().max(300).default(''),
  instructions: z.string().max(2_000).default(''),
}).strict();

export type CompanyAIConfig = z.infer<typeof configSchema>;

export function parseCompanyAIConfig(input: string): CompanyAIConfig {
  const config = configSchema.parse(JSON.parse(input));
  if (JSON.stringify(config.businessData).length > 10_000) throw new Error('businessData exceeds 10000 characters');
  return config;
}

async function main() {
  const [instance, session, file] = process.argv.slice(2);
  if (!instance || !session || !file || !process.env.DATABASE_URL) {
    console.error('Usage: npm run ai:config -- <instance> <session> <config.json> (DATABASE_URL required)');
    process.exitCode = 1;
    return;
  }
  let config: CompanyAIConfig;
  try { config = parseCompanyAIConfig(await readFile(resolve(file), 'utf8')); }
  catch {
    console.error('Invalid AI configuration file; check its structure, data size and configured model');
    process.exitCode = 1;
    return;
  }
  const { db, close } = createDatabase(process.env.DATABASE_URL);
  try {
    const updated = await db.query<{ id: string }>(
      `UPDATE organizations o SET ai_enabled = $3, ai_model = $4, ai_business_data = $5,
         ai_tone = $6, ai_instructions = $7
       FROM channels c WHERE c.organization_id = o.id AND c.instance = $1 AND c.session = $2
       RETURNING o.id`,
      [instance, session, config.enabled, config.model, JSON.stringify(config.businessData), config.tone, config.instructions],
    );
    if (!updated.rows.length) throw new Error('Company channel not found');
    console.log('Company AI configuration updated; configuration values omitted');
  } catch {
    console.error('AI configuration failed; check the channel mapping, schema migration and JSON file');
    process.exitCode = 1;
  } finally { await close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
