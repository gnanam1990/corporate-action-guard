#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { postgresEnv, requireEnv, run } from './database-tools.mjs';

const databaseUrl = requireEnv('DATABASE_URL');
const backupPath = path.resolve(requireEnv('BACKUP_PATH'));
const checksumPath = `${backupPath}.sha256`;

for (const target of [backupPath, checksumPath]) {
  try {
    await access(target);
    throw new Error(`refusing to overwrite existing backup artifact: ${target}`);
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
  }
}

await mkdir(path.dirname(backupPath), { recursive: true });
try {
  const env = postgresEnv(databaseUrl);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', backupPath], env);
  await chmod(backupPath, 0o600);
  // A zero exit from pg_dump is not enough: prove pg_restore can parse the archive.
  await run('pg_restore', ['--list', backupPath], env);
  const digest = createHash('sha256')
    .update(await readFile(backupPath))
    .digest('hex');
  await writeFile(checksumPath, `${digest}  ${path.basename(backupPath)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`backup verified: ${backupPath}\nchecksum: ${checksumPath}\n`);
} catch (error) {
  await Promise.allSettled([unlink(backupPath), unlink(checksumPath)]);
  throw error;
}
