import { randomUUID } from 'node:crypto';
import {
  appendEvidence,
  applyEventToProjections,
  assertLeaseHeld,
  getAsset,
  withTransaction,
  type Lease,
} from '@cag/db';
import {
  compareSources,
  EXACT_TOLERANCE,
  fixtureEvidenceMessage,
  instant,
  summarizeCanonicality,
  unsafe,
  type ApiObservation,
  type ChainObservation,
  type FixtureEvidencePayload,
} from '@cag/domain';
import type { Logger } from '@cag/observability';
import type { XLayerReader } from '@cag/xlayer-reader';
import type { Pool } from 'pg';
import { verifyMessage } from 'viem';

export interface FixtureObserverDeps {
  readonly pool: Pool;
  readonly reader: XLayerReader;
  readonly assetId: string;
  readonly tokenAddress: string;
  readonly wrapperAddress: string;
  readonly adminAddress: string;
  readonly logger: Logger;
  readonly producerVersion: string;
  readonly now: () => number;
  readonly lease?: Lease;
}

export interface FixtureObservationResult {
  readonly observed: boolean;
  readonly agreement?: 'MATCH' | 'MISMATCH' | 'INCOMPLETE';
  readonly canonicality?: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly blockNumber?: bigint;
}

interface FixtureIntentRow {
  readonly payload: Record<string, unknown>;
  readonly source_time: Date | null;
}

const addressMatch = (left: string | null | undefined, right: string): boolean =>
  left?.toLowerCase() === right.toLowerCase();

/**
 * Compare signed fixture-admin intent with an independently finalized chain-1952 read.
 *
 * No signed control-plane observation means no row and no ALLOW. A mismatch is persisted
 * as such; chain values are never copied into the control-plane side to manufacture a
 * match.
 */
export async function runFixtureObservationCycle(
  deps: FixtureObserverDeps,
): Promise<FixtureObservationResult> {
  const registry = await getAsset(deps.pool, deps.assetId);
  if (registry === undefined) return { observed: false };
  if (
    registry.chainId !== 1952 ||
    !addressMatch(registry.tokenAddress, deps.tokenAddress) ||
    !addressMatch(registry.wrapperAddress, deps.wrapperAddress)
  ) {
    deps.logger.warn('fixture control-plane identity does not match worker configuration', {
      assetId: deps.assetId,
    });
    return { observed: false };
  }

  // `current_assets` also carries the latest chain values. Reading the signed side from
  // that mixed projection would let a chain observation overwrite the intent it is meant
  // to be compared against. The journal is append-only, so keep the two sources distinct.
  const intentResult = await deps.pool.query<FixtureIntentRow>(
    `SELECT payload, source_time
       FROM evidence_events
      WHERE aggregate_type = 'asset'
        AND aggregate_id = $1
        AND event_type = 'API_SNAPSHOT_OBSERVED'
        AND source_kind = 'FIXTURE_CONTROL_PLANE'
      ORDER BY source_time DESC, ingested_at DESC, id DESC
      LIMIT 1`,
    [deps.assetId],
  );
  const intent = intentResult.rows[0];
  const payload = intent?.payload;
  if (
    intent === undefined ||
    intent.source_time === null ||
    typeof payload?.['tokenAddress'] !== 'string' ||
    typeof payload['wrapperAddress'] !== 'string' ||
    typeof payload['multiplierValue'] !== 'string' ||
    !/^[0-9]+$/.test(payload['multiplierValue']) ||
    typeof payload['multiplierDecimals'] !== 'number' ||
    !Number.isInteger(payload['multiplierDecimals']) ||
    typeof payload['multiplierNonce'] !== 'string' ||
    !/^[0-9]+$/.test(payload['multiplierNonce']) ||
    (payload['scheduledActivation'] !== null &&
      typeof payload['scheduledActivation'] !== 'string') ||
    (typeof payload['scheduledActivation'] === 'string' &&
      !Number.isFinite(new Date(payload['scheduledActivation']).getTime())) ||
    payload['wrapperIsCurrent'] !== true ||
    typeof payload['adminAddress'] !== 'string' ||
    typeof payload['adminSignature'] !== 'string' ||
    typeof payload['sourceObservedAt'] !== 'string' ||
    !Number.isFinite(new Date(payload['sourceObservedAt']).getTime()) ||
    new Date(payload['sourceObservedAt']).getTime() !== intent.source_time.getTime() ||
    !/^0x[0-9a-fA-F]{130}$/.test(payload['adminSignature']) ||
    Number(payload['chainId']) !== 1952 ||
    !addressMatch(payload['tokenAddress'], deps.tokenAddress) ||
    !addressMatch(payload['wrapperAddress'], deps.wrapperAddress) ||
    !addressMatch(payload['adminAddress'], deps.adminAddress)
  ) {
    deps.logger.warn('fixture signed intent is absent or structurally invalid', {
      assetId: deps.assetId,
    });
    return { observed: false };
  }

  const signedPayload: FixtureEvidencePayload = {
    assetId: deps.assetId,
    chainId: 1952,
    tokenAddress: payload['tokenAddress'],
    wrapperAddress: payload['wrapperAddress'],
    multiplierValue: payload['multiplierValue'],
    multiplierDecimals: payload['multiplierDecimals'],
    multiplierNonce: payload['multiplierNonce'],
    scheduledActivation: payload['scheduledActivation'],
    observedAt: payload['sourceObservedAt'],
  };
  const signatureValid = await verifyMessage({
    address: deps.adminAddress as `0x${string}`,
    message: fixtureEvidenceMessage(signedPayload),
    signature: payload['adminSignature'] as `0x${string}`,
  }).catch(() => false);
  if (!signatureValid) {
    deps.logger.warn('fixture journal intent signature is invalid', { assetId: deps.assetId });
    return { observed: false };
  }

  const head = await deps.reader.getHead();
  const depth = BigInt(deps.reader.getConfirmationDepth());
  if (head.blockNumber < depth) return { observed: false };
  const at = await deps.reader.getBlockStamp(head.blockNumber - depth);
  const snapshot = await deps.reader.observeAsset({
    tokenAddress: deps.tokenAddress,
    wrapperAddress: deps.wrapperAddress,
    at,
    nowMs: deps.now(),
  });

  const api: ApiObservation = {
    provenance: {
      sourceKind: 'FIXTURE_CONTROL_PLANE',
      sourceLocator: '/v1/testnet/fixture-evidence',
      observedAt: instant(intent.source_time.getTime()),
    },
    symbol: unsafe.symbol(deps.assetId),
    tokenAddress: unsafe.address(payload['tokenAddress']),
    wrapperAddress: unsafe.address(payload['wrapperAddress']),
    multiplier: {
      value: BigInt(payload['multiplierValue']),
      decimals: payload['multiplierDecimals'],
    },
    multiplierNonce: BigInt(payload['multiplierNonce']),
    ...(payload['scheduledActivation'] === null
      ? {}
      : { scheduledActivation: instant(new Date(payload['scheduledActivation']).getTime()) }),
  };
  const chain: ChainObservation = {
    provenance: {
      sourceKind: 'XLAYER_RPC',
      sourceLocator: snapshot.providerName,
      observedAt: instant(deps.now()),
    },
    chainId: unsafe.chainId(snapshot.chainId),
    blockNumber: unsafe.blockNumber(snapshot.blockNumber),
    blockHash: unsafe.blockHash(snapshot.blockHash),
    tokenAddress: unsafe.address(snapshot.tokenAddress),
    wrapperAddress: unsafe.address(snapshot.wrapperAddress),
    tokenHasBytecode: snapshot.tokenHasBytecode,
    wrapperHasBytecode: snapshot.wrapperHasBytecode,
    ...(snapshot.wrapperAsset === undefined
      ? {}
      : { wrapperAsset: unsafe.address(snapshot.wrapperAsset) }),
    ...(snapshot.currentMultiplier === undefined || snapshot.tokenDecimals === undefined
      ? {}
      : {
          multiplier: {
            value: snapshot.currentMultiplier,
            decimals: snapshot.tokenDecimals,
          },
        }),
    ...(snapshot.multiplierNonce === undefined
      ? {}
      : { multiplierNonce: snapshot.multiplierNonce }),
    ...(snapshot.scheduledActivationMs === undefined
      ? {}
      : { scheduledActivation: instant(snapshot.scheduledActivationMs) }),
  };

  const comparison = compareSources(api, chain, {
    multiplierTolerance: EXACT_TOLERANCE,
    activationToleranceMs: 0,
    requiredAgreementFields: [
      'multiplier',
      'multiplierNonce',
      'scheduledActivation',
      'wrapperAddress',
    ],
  });
  const sourceAgreement = snapshot.complete ? comparison.agreement : 'INCOMPLETE';
  const canonicality = summarizeCanonicality([
    {
      name: 'TOKEN_MATCHES_REGISTRY',
      outcome: addressMatch(snapshot.tokenAddress, deps.tokenAddress) ? 'PASS' : 'FAIL',
      detail: 'fixture token must match the configured deployment',
    },
    {
      name: 'WRAPPER_MATCHES_REGISTRY',
      outcome: addressMatch(snapshot.wrapperAddress, deps.wrapperAddress) ? 'PASS' : 'FAIL',
      detail: 'fixture wrapper must match the configured deployment',
    },
    {
      name: 'TOKEN_HAS_BYTECODE',
      outcome: snapshot.failedReads.includes('eth_getCode(token)')
        ? 'UNKNOWN'
        : snapshot.tokenHasBytecode
          ? 'PASS'
          : 'FAIL',
      detail: 'fixture token bytecode at the finalized block',
    },
    {
      name: 'WRAPPER_HAS_BYTECODE',
      outcome: snapshot.failedReads.includes('eth_getCode(wrapper)')
        ? 'UNKNOWN'
        : snapshot.wrapperHasBytecode
          ? 'PASS'
          : 'FAIL',
      detail: 'fixture wrapper bytecode at the finalized block',
    },
    {
      name: 'WRAPPER_ASSET_RELATION',
      outcome:
        snapshot.wrapperAsset === undefined
          ? 'UNKNOWN'
          : addressMatch(snapshot.wrapperAsset, deps.tokenAddress)
            ? 'PASS'
            : 'FAIL',
      detail: 'fixture wrapper must report the configured token',
    },
    {
      name: 'WRAPPER_VERSION_CURRENT',
      outcome: payload['wrapperIsCurrent'] === true ? 'PASS' : 'FAIL',
      detail: 'signed fixture evidence declares the current wrapper',
    },
  ]);

  const correlationId = randomUUID();
  await withTransaction(deps.pool, async (client) => {
    if (deps.lease !== undefined) await assertLeaseHeld(client, deps.lease, true);
    const event = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: deps.assetId,
      eventType: 'CHAIN_SNAPSHOT_OBSERVED',
      observedAt: new Date(deps.now()),
      sourceKind: 'XLAYER_RPC',
      sourceLocator: snapshot.providerName,
      chain: {
        chainId: snapshot.chainId,
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
      },
      payload: {
        canonicality: canonicality.outcome,
        ...(snapshot.multiplierNonce === undefined
          ? {}
          : { multiplierNonce: snapshot.multiplierNonce.toString() }),
        scheduledActivation:
          snapshot.scheduledActivationMs === undefined
            ? null
            : new Date(snapshot.scheduledActivationMs).toISOString(),
        complete: snapshot.complete,
        failedReads: snapshot.failedReads,
        confirmationDepth: snapshot.confirmationDepth,
        settled: snapshot.settled,
        sourceAgreement,
        comparisonFields: comparison.fields.map((field) => ({
          ...field,
          apiValue: field.apiValue ?? null,
          chainValue: field.chainValue ?? null,
        })),
        observationBucket: new Date(deps.now()).toISOString().slice(0, 16),
      },
      correlationId,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, event.event);
  });

  return {
    observed: true,
    agreement: sourceAgreement,
    canonicality: canonicality.outcome,
    blockNumber: snapshot.blockNumber,
  };
}
