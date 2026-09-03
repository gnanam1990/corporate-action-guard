import { loadEnv } from '@cag/config';
import { migrate } from './migrate.js';

const env = loadEnv();
const result = await migrate(env.DATABASE_URL);
process.stdout.write(
  `migrations applied: ${result.applied.length ? result.applied.join(', ') : '(none)'}\n` +
    `already current:    ${result.skipped.length ? result.skipped.join(', ') : '(none)'}\n`,
);
