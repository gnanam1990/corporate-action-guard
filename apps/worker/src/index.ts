import { loadEnv } from '@cag/config';
import { checkDatabase } from '@cag/db';

/**
 * Worker skeleton.
 *
 * Proves configuration loads and the database is reachable, then idles. Polling,
 * indexing, and reconciliation arrive in modules 05 and 07.
 */
const env = loadEnv();
const database = await checkDatabase(env.DATABASE_URL);

process.stdout.write(
  JSON.stringify({
    level: 'info',
    service: 'worker',
    event: 'startup',
    databaseReachable: database.ok,
    databaseDetail: database.detail,
  }) + '\n',
);

if (!database.ok) {
  process.exitCode = 1;
}
