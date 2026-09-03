import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://guard:guard@localhost:55432/guard';

export const PRODUCER = 'test@0.1.0';

/**
 * Each integration test file gets its own schema, so files cannot see each other's rows
 * and `fileParallelism: false` is a belt-and-braces guard rather than the only isolation.
 */
export async function createTestPool(schema: string): Promise<Pool> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  await migrateInSchema(TEST_DATABASE_URL, schema);
  return pool;
}

async function migrateInSchema(url: string, schema: string): Promise<void> {
  const withSchema = new URL(url);
  withSchema.searchParams.set('options', `-c search_path=${schema}`);
  await migrate(withSchema.toString());
}

export async function dropTestSchema(pool: Pool, schema: string): Promise<void> {
  await pool.end();
  const admin = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
}

export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
