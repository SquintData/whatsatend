import pg from 'pg';

export interface QueryResult<T> { rows: T[] }
export interface Connection {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}
export interface Database {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T>;
}

export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('Database idle connection failed'));
  const db: Database = {
    async query<T>(sql: string, values?: unknown[]) {
      const result = await pool.query(sql, values);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(fn: (connection: Connection) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<R>(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            return { rows: result.rows as R[] };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
  return { db, close: () => pool.end() };
}
