import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDatabase } from './db.js';
import { tokenHash } from './store.js';

const config = z.object({
  DATABASE_URL: z.string().url(), COMPANY_NAME: z.string().trim().min(1).max(200),
  WAHA_INSTANCE: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  WAHA_SESSION: z.string().min(1).max(200), WEBHOOK_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
}).safeParse(process.env);
if (!config.success) {
  console.error('Provisioning requires DATABASE_URL, COMPANY_NAME, WAHA_INSTANCE, WAHA_SESSION and a 64-character random hex WEBHOOK_TOKEN');
  process.exit(1);
}
const settings = config.data;
const { db, close } = createDatabase(settings.DATABASE_URL);
try {
  await db.transaction(async tx => {
    const existing = await tx.query<{ organization_id: string; token_hash: string }>(
      'SELECT organization_id, token_hash FROM channels WHERE instance = $1 AND session = $2',
      [settings.WAHA_INSTANCE, settings.WAHA_SESSION],
    );
    if (existing.rows.length) {
      if (existing.rows[0]!.token_hash !== tokenHash(settings.WEBHOOK_TOKEN)) {
        throw new Error('Existing channel: token changes require an explicit rotation');
      }
      return;
    }
    const organizationId = randomUUID();
    await tx.query('INSERT INTO organizations(id, name) VALUES ($1,$2)', [organizationId, settings.COMPANY_NAME]);
    await tx.query(
      'INSERT INTO channels(id, organization_id, instance, session, token_hash) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), organizationId, settings.WAHA_INSTANCE, settings.WAHA_SESSION, tokenHash(settings.WEBHOOK_TOKEN)],
    );
  });
  console.log('Company/channel ready; automatic responses remain disabled');
} catch {
  console.error('Provisioning failed: check existing session mapping, token and database'); process.exitCode = 1;
} finally { await close(); }
