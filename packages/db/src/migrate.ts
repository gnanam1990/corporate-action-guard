import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** A migration that was applied and then edited is a silent schema divergence. */
export class MigrationChecksumError extends Error {
  override readonly name = 'MigrationChecksumError';
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Apply pending migrations in filename order, each inside its own transaction.
 * Re-running is a no-op; an edited already-applied migration is a hard error.
 */
export async function migrate(
  databaseUrl: string,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const known = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const sum = checksum(sql);
      const previous = known.get(version);

      if (previous !== undefined) {
        if (previous !== sum) {
          throw new MigrationChecksumError(
            `Migration ${version} was already applied but its file has changed. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped.push(version);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          version,
          sum,
        ]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}

/** Liveness/readiness probe: is the database reachable and answering? */
export async function checkDatabase(databaseUrl: string): Promise<{ ok: boolean; detail: string }> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ now: Date }>('SELECT now() AS now');
    return {
      ok: true,
      detail: `reachable; server time ${rows[0]?.now.toISOString() ?? 'unknown'}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'unknown error' };
  } finally {
    await client.end().catch(() => undefined);
  }
}
