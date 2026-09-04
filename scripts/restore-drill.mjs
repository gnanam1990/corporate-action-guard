#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { postgresEnv, requireEnv, run } from './database-tools.mjs';

const adminUrl = requireEnv('DATABASE_ADMIN_URL');
const backupPath = path.resolve(requireEnv('BACKUP_PATH'));
const drillDatabase = `cag_restore_drill_${Date.now()}_${process.pid}`;
const adminEnv = postgresEnv(adminUrl);
const drillEnv = postgresEnv(adminUrl, drillDatabase);
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const checksum = (await readFile(`${backupPath}.sha256`, 'utf8')).trim().split(/\s+/)[0];
const actual = createHash('sha256')
  .update(await readFile(backupPath))
  .digest('hex');
if (checksum !== actual) throw new Error('backup checksum does not match; restore refused');

let created = false;
try {
  await run(
    'psql',
    [
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `CREATE DATABASE ${quoteIdentifier(drillDatabase)}`,
    ],
    adminEnv,
  );
  created = true;
  await run(
    'pg_restore',
    ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', drillDatabase, backupPath],
    drillEnv,
  );
  await run(
    'psql',
    [
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--command',
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0007_fixture_evidence') THEN RAISE EXCEPTION 'incomplete schema'; END IF; END $$; SELECT 'schema-ok'; SELECT count(*) || ' journal rows' FROM evidence_events;",
    ],
    drillEnv,
  );
  process.stdout.write(`restore drill verified in disposable database ${drillDatabase}\n`);
} finally {
  if (created) {
    await run(
      'psql',
      [
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `DROP DATABASE ${quoteIdentifier(drillDatabase)} WITH (FORCE)`,
      ],
      adminEnv,
    );
  }
}
