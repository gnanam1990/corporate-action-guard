import { spawn } from 'node:child_process';
import path from 'node:path';

const postgresCommands = new Set(['pg_dump', 'pg_restore', 'psql']);
const postgresEnvironment = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'];

export function postgresEnv(databaseUrl, databaseOverride) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('database URL must use postgres:// or postgresql://');
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseOverride ?? decodeURIComponent(url.pathname.slice(1)),
    ...(url.searchParams.get('sslmode') === null
      ? {}
      : { PGSSLMODE: url.searchParams.get('sslmode') }),
  };
}

export async function run(command, args, env) {
  const toolsImage = process.env.POSTGRES_TOOLS_IMAGE;
  if (toolsImage && postgresCommands.has(command)) {
    const mount = process.env.POSTGRES_TOOLS_MOUNT;
    if (mount && !path.isAbsolute(mount)) {
      throw new Error('POSTGRES_TOOLS_MOUNT must be an absolute path');
    }
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) {
      throw new Error('containerized PostgreSQL tools require a Unix user identity');
    }

    const dockerArgs = [
      'run',
      '--rm',
      '--user',
      `${uid}:${gid}`,
      '--network',
      process.env.POSTGRES_TOOLS_NETWORK || 'host',
    ];
    for (const name of postgresEnvironment) {
      if (env[name] !== undefined) dockerArgs.push('--env', name);
    }
    if (mount) dockerArgs.push('--volume', `${mount}:${mount}:rw`);
    dockerArgs.push(toolsImage, command, ...args);
    return runDirect('docker', dockerArgs, env);
  }
  return runDirect(command, args, env);
}

async function runDirect(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}
