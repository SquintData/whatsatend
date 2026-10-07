import { readFile } from 'node:fs/promises';
import { createDatabase } from './db.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const { db, close } = createDatabase(process.env.DATABASE_URL);
try {
  const sql = await readFile(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(73482001)');
    await tx.query(sql);
  });
  console.log('Initial schema ready');
} catch {
  console.error('Migration failed; check database access'); process.exitCode = 1;
} finally { await close(); }
