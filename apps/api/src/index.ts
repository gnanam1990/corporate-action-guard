import { loadEnv } from '@cag/config';
import { getStoredApiKey, migrate, provisionApiKeyHash } from '@cag/db';
import { createLogger } from '@cag/observability';
import { ReceiptSigner } from '@cag/receipts';
import { Pool } from 'pg';
import { hashApiKey, type ApiKeyRecord } from './auth.js';
import { buildServer } from './server.js';
import type { EvidenceBundle } from './preflight-service.js';
import { summarizeCanonicality } from '@cag/domain';

/**
 * API entry point.
 *
 * Composition only: every decision lives in a package. This file wires configuration to
 * dependencies and starts listening.
 */

const env = loadEnv();
const logger = createLogger({
  service: 'api',
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
});

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

/**
 * API keys.
 *
 * Development-only convenience keys. Production authentication comes exclusively from
 * the persistent `api_keys` table, where only hashes are stored and revocation is durable.
 */
function loadApiKeys(): Map<string, ApiKeyRecord> {
  const keys = new Map<string, ApiKeyRecord>();
  const raw = process.env['DEV_API_KEYS'];
  if (raw === undefined || raw === '') return keys;
  if (env.NODE_ENV === 'production') {
    throw new Error('DEV_API_KEYS is forbidden in production; provision hashed keys in PostgreSQL');
  }

  // Format: keyId|principal|scope[,scope]|rawKey, entries separated by ';'.
  //
  // Fields are separated by '|' rather than ':' because scope names CONTAIN a colon
  // ('integrator:preflight'). Splitting on ':' silently truncated the scope list so every
  // key failed authorization — found by running the CLI against the real API, not by a
  // unit test, because the bug lived in configuration parsing rather than in logic.
  for (const entry of raw.split(';')) {
    const [keyId, principal, scopes, rawKey] = entry.split('|');
    if (
      keyId === undefined ||
      principal === undefined ||
      scopes === undefined ||
      rawKey === undefined
    )
      continue;
    keys.set(keyId, {
      keyId,
      principal,
      hash: hashApiKey(rawKey),
      scopes: scopes.split(',') as ApiKeyRecord['scopes'],
      revoked: false,
    });
  }
  return keys;
}

/**
 * Evidence assembly.
 *
 * Reads the projections the worker maintains. Where the worker has not yet produced an
 * observation, the bundle reports absence rather than inventing a value — which is what
 * makes the predicate block instead of guess.
 */
async function loadEvidence(assetId: string): Promise<EvidenceBundle> {
  const { rows } = await pool.query(
    `SELECT chain_id, token_address, wrapper_address, wrapper_is_current, canonicality,
            multiplier_nonce, scheduled_activation, api_observed_at, chain_observed_at,
            chain_block_number, chain_block_hash, last_event_id,
            source_agreement, comparison_fields
     FROM current_assets WHERE asset_id = $1`,
    [assetId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;

  if (row === undefined) {
    return {
      assetKnown: false,
      canonicality: summarizeCanonicality([]),
      sourceComparison: { agreement: 'INCOMPLETE', fields: [] },
      manualReviewOpen: false,
      evidenceIds: [],
    };
  }

  const openIncidents = await pool.query(
    `SELECT count(*)::int AS n FROM current_incidents
     WHERE asset_id = $1 AND status IN ('OPEN','IN_REVIEW')`,
    [assetId],
  );

  return {
    assetKnown: true,
    chainId: Number(row['chain_id']),
    ...(typeof row['token_address'] === 'string'
      ? { registryTokenAddress: row['token_address'] }
      : {}),
    ...(typeof row['wrapper_address'] === 'string'
      ? { registryWrapperAddress: row['wrapper_address'] }
      : {}),
    ...(typeof row['wrapper_is_current'] === 'boolean'
      ? { registryWrapperIsCurrent: row['wrapper_is_current'] }
      : {}),
    ...(typeof row['wrapper_address'] === 'string' && row['canonicality'] === 'PASS'
      ? { observedWrapperAsset: row['token_address'] as string }
      : {}),
    canonicality: summarizeCanonicality(
      row['canonicality'] === 'PASS'
        ? [
            { name: 'TOKEN_MATCHES_REGISTRY', outcome: 'PASS', detail: 'projection reports PASS' },
            {
              name: 'WRAPPER_MATCHES_REGISTRY',
              outcome: 'PASS',
              detail: 'projection reports PASS',
            },
            { name: 'TOKEN_HAS_BYTECODE', outcome: 'PASS', detail: 'projection reports PASS' },
            { name: 'WRAPPER_HAS_BYTECODE', outcome: 'PASS', detail: 'projection reports PASS' },
            { name: 'WRAPPER_ASSET_RELATION', outcome: 'PASS', detail: 'projection reports PASS' },
            { name: 'WRAPPER_VERSION_CURRENT', outcome: 'PASS', detail: 'projection reports PASS' },
          ]
        : [],
    ),
    // The recorded comparison, or INCOMPLETE when the worker has not compared this asset
    // yet. A NULL column means "never compared" — reported as INCOMPLETE, which blocks.
    // Absence is never rendered as agreement.
    sourceComparison: {
      agreement:
        row['source_agreement'] === 'MATCH' || row['source_agreement'] === 'MISMATCH'
          ? row['source_agreement']
          : 'INCOMPLETE',
      fields: Array.isArray(row['comparison_fields'])
        ? (
            row['comparison_fields'] as {
              field: string;
              agreement: string;
              apiValue: string | null;
              chainValue: string | null;
              requiredForAgreement: boolean;
            }[]
          ).map((f) => ({
            field: f.field as
              'multiplier' | 'multiplierNonce' | 'scheduledActivation' | 'wrapperAddress',
            agreement: f.agreement as 'MATCH' | 'MISMATCH' | 'INCOMPLETE',
            apiValue: f.apiValue ?? undefined,
            chainValue: f.chainValue ?? undefined,
            requiredForAgreement: f.requiredForAgreement,
          }))
        : [],
    },
    ...(row['multiplier_nonce'] === null || row['multiplier_nonce'] === undefined
      ? {}
      : { onChainMultiplierNonce: BigInt(String(row['multiplier_nonce'])) }),
    ...(row['scheduled_activation'] instanceof Date
      ? { scheduledActivationMs: row['scheduled_activation'].getTime() }
      : {}),
    ...(row['api_observed_at'] instanceof Date
      ? { apiObservedAtMs: row['api_observed_at'].getTime() }
      : {}),
    ...(row['chain_observed_at'] instanceof Date
      ? { chainObservedAtMs: row['chain_observed_at'].getTime() }
      : {}),
    manualReviewOpen: ((openIncidents.rows[0] as { n: number } | undefined)?.n ?? 0) > 0,
    evidenceIds: typeof row['last_event_id'] === 'string' ? [row['last_event_id']] : [],
    ...(row['chain_block_number'] === null || row['chain_block_number'] === undefined
      ? {}
      : { blockNumber: BigInt(String(row['chain_block_number'])) }),
    ...(typeof row['chain_block_hash'] === 'string' ? { blockHash: row['chain_block_hash'] } : {}),
  };
}

async function main(): Promise<void> {
  // Migrations are an explicit release step in production; running them here keeps local
  // development to one command.
  if (env.NODE_ENV !== 'production') {
    const result = await migrate(env.DATABASE_URL);
    logger.info('migrations checked', {
      applied: result.applied.length,
      current: result.skipped.length,
    });
  }

  if (env.OPERATOR_API_KEY_HASH !== undefined) {
    await provisionApiKeyHash(pool, {
      keyId: 'operator',
      principal: 'operator',
      hash: env.OPERATOR_API_KEY_HASH.toLowerCase(),
      scopes: ['operator:review', 'admin:reconcile'],
    });
  }
  if (env.INTEGRATOR_API_KEY_HASH !== undefined) {
    await provisionApiKeyHash(pool, {
      keyId: 'integ001',
      principal: 'integrator',
      hash: env.INTEGRATOR_API_KEY_HASH.toLowerCase(),
      scopes: ['integrator:preflight'],
    });
  }

  const keys = loadApiKeys();
  const app = await buildServer({
    db: pool,
    databaseUrl: env.DATABASE_URL,
    signer: new ReceiptSigner(
      () => env.RECEIPT_SIGNER_PRIVATE_KEY,
      env.XLAYER_TESTNET_CHAIN_ID,
      env.GUARD_ADAPTER_TESTNET_ADDRESS ?? '0x0000000000000000000000000000000000000000',
    ),
    policy: {
      supportedChainIds: [env.XLAYER_TESTNET_CHAIN_ID],
      supportedTargets:
        env.PROTECTED_VAULT_TESTNET_ADDRESS === undefined
          ? []
          : [env.PROTECTED_VAULT_TESTNET_ADDRESS],
      supportedActionTypes: ['DEPOSIT', 'WITHDRAW'],
      guardBeforeMs: 15 * 60_000,
      guardAfterMs: 15 * 60_000,
      apiMaxAgeMs: 5 * 60_000,
      chainMaxAgeMs: 2 * 60_000,
      receiptLifetimeMs: 5 * 60_000,
      verifyingContract:
        env.GUARD_ADAPTER_TESTNET_ADDRESS ?? '0x0000000000000000000000000000000000000000',
    },
    lookupApiKey: async (keyId) => {
      const stored = await getStoredApiKey(pool, keyId);
      if (stored !== undefined) return stored as ApiKeyRecord;
      return keys.get(keyId);
    },
    loadEvidence,
    corsOrigins: [env.NEXT_PUBLIC_API_BASE_URL.replace(/:\d+$/, ':3000'), 'http://localhost:3000'],
    logger,
  });

  const port = Number(new URL(env.API_PUBLIC_BASE_URL).port || 4000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info('api listening', { port, apiKeysConfigured: keys.size });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
