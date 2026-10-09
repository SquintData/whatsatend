import { readFile, readdir } from 'node:fs/promises';
import { createDatabase } from './db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, close } = createDatabase(process.env.DATABASE_URL);
try {
  const directory = new URL('../sql/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(73482001)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      const applied = await tx.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
      if (applied.rows.length) continue;
      await tx.query(await readFile(new URL(name, directory), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
  console.log('Database migrations ready');
} catch {
  console.error('Migration failed; check database access'); process.exitCode = 1;
} finally { await close(); }
