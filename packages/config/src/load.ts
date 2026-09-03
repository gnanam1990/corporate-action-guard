import { envSchema, PUBLIC_KEYS, SERVER_SECRET_KEYS, type Env } from './schema.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

/**
 * A secret must never be published to the browser. `NEXT_PUBLIC_` is the Next.js prefix
 * that inlines a value into the client bundle, so a secret carrying it is a leak by
 * construction — fail at startup rather than at deploy time.
 */
function assertNoPublicSecrets(source: Record<string, string | undefined>): void {
  const leaked: string[] = [];
  for (const key of Object.keys(source)) {
    if (!key.startsWith('NEXT_PUBLIC_')) continue;
    if ((PUBLIC_KEYS as readonly string[]).includes(key)) continue;
    leaked.push(key);
  }
  for (const secret of SERVER_SECRET_KEYS) {
    if (String(secret).startsWith('NEXT_PUBLIC_')) {
      leaked.push(String(secret));
    }
  }
  if (leaked.length > 0) {
    throw new ConfigError(
      'Server configuration would be published to the browser bundle.',
      leaked.map((k) => `${k} carries the NEXT_PUBLIC_ prefix but is not an allowed public key`),
    );
  }
}

/**
 * X Layer mainnet is read-only (ADR 0002). There is no code path that signs for chain 196,
 * and configuration must not be able to create one.
 */
function assertNoMainnetSigner(env: Env): void {
  if (env.XLAYER_MAINNET_RPC_URL === undefined) return;
  if (env.RECEIPT_SIGNER_PRIVATE_KEY === undefined) return;
  // Holding both is legitimate: the signer signs receipts consumed on testnet while the
  // reader observes mainnet. What must never exist is a mainnet *broadcast* target, which
  // is why foundry.toml lists no mainnet rpc endpoint and deploy scripts reject 196.
  // The assertion here is the narrow one we can make from configuration alone.
  if (env.XLAYER_MAINNET_CHAIN_ID !== 196) {
    throw new ConfigError('X Layer mainnet chain id must remain pinned to 196.');
  }
}

/**
 * Parse and validate the process environment exactly once, at startup.
 * Throws `ConfigError` listing every problem rather than failing on the first.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  assertNoPublicSecrets(source);

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment (${issues.length} problem(s)).`, issues);
  }

  assertNoMainnetSigner(parsed.data);
  return parsed.data;
}

let cached: Env | undefined;

/** Memoized accessor for long-lived processes. Tests should call `loadEnv` directly. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only reset so a suite can exercise multiple environments in one process. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
