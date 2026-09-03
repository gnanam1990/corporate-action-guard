import { addressEquals } from '@cag/domain';
import type { CanonicalityRecord } from './canonicality.js';

/**
 * Registry refresh diffing.
 *
 * A refresh must never silently overwrite what we previously believed. A wrapper that
 * changed, or a deployment that vanished, is evidence that something happened — and
 * something that happened is what an operator needs to see. Each difference becomes an
 * explicit, typed change rather than an in-place update.
 */

export type RegistryChangeKind =
  'DEPLOYMENT_ADDED' | 'DEPLOYMENT_REMOVED' | 'WRAPPER_CHANGED' | 'FIELD_CHANGED' | 'NO_CHANGE';

export interface RegistryChange {
  readonly kind: RegistryChangeKind;
  readonly assetId: string;
  readonly field?: string;
  readonly previous?: string | undefined;
  readonly current?: string | undefined;
  /** True when this change must open review evidence rather than just update a projection. */
  readonly opensReview: boolean;
  readonly detail: string;
}

export interface RegistrySnapshotEntry {
  readonly assetId: string;
  readonly symbol: string;
  readonly tokenAddress: string;
  readonly currentWrapperAddress: string | undefined;
}

export function toRegistryEntry(record: CanonicalityRecord): RegistrySnapshotEntry {
  return {
    assetId: record.assetId,
    symbol: record.symbol,
    tokenAddress: record.apiTokenAddress,
    currentWrapperAddress: record.apiCurrentWrapperAddress,
  };
}

/**
 * Compare a previous registry snapshot with a fresh one.
 *
 * Returns one change per material difference. `NO_CHANGE` is returned explicitly for an
 * unchanged asset rather than an empty result, so a caller can tell "we checked and
 * nothing moved" from "we did not check".
 */
export function diffRegistry(
  previous: readonly RegistrySnapshotEntry[],
  current: readonly RegistrySnapshotEntry[],
): readonly RegistryChange[] {
  const byId = (entries: readonly RegistrySnapshotEntry[]) =>
    new Map(entries.map((e) => [e.assetId, e]));
  const before = byId(previous);
  const after = byId(current);
  const changes: RegistryChange[] = [];

  for (const [assetId, entry] of after) {
    const prior = before.get(assetId);
    if (prior === undefined) {
      changes.push({
        kind: 'DEPLOYMENT_ADDED',
        assetId,
        current: entry.tokenAddress,
        // A newly discovered asset is normal operation, not an incident.
        opensReview: false,
        detail: `${entry.symbol} appeared in the registry`,
      });
      continue;
    }

    const diffs: RegistryChange[] = [];

    if (!addressEquals(prior.tokenAddress, entry.tokenAddress)) {
      diffs.push({
        kind: 'FIELD_CHANGED',
        assetId,
        field: 'tokenAddress',
        previous: prior.tokenAddress,
        current: entry.tokenAddress,
        // The canonical token address changing under us is a serious claim to verify.
        opensReview: true,
        detail: `${entry.symbol} token address changed`,
      });
    }

    const wrapperChanged =
      prior.currentWrapperAddress !== undefined && entry.currentWrapperAddress !== undefined
        ? !addressEquals(prior.currentWrapperAddress, entry.currentWrapperAddress)
        : prior.currentWrapperAddress !== entry.currentWrapperAddress;

    if (wrapperChanged) {
      diffs.push({
        kind: 'WRAPPER_CHANGED',
        assetId,
        field: 'currentWrapperAddress',
        previous: prior.currentWrapperAddress,
        current: entry.currentWrapperAddress,
        // Outstanding receipts were bound to the old wrapper. This must be visible.
        opensReview: true,
        detail: `${entry.symbol} current wrapper changed`,
      });
    }

    if (prior.symbol !== entry.symbol) {
      diffs.push({
        kind: 'FIELD_CHANGED',
        assetId,
        field: 'symbol',
        previous: prior.symbol,
        current: entry.symbol,
        opensReview: false,
        detail: `symbol changed from ${prior.symbol} to ${entry.symbol}`,
      });
    }

    if (diffs.length === 0) {
      changes.push({
        kind: 'NO_CHANGE',
        assetId,
        opensReview: false,
        detail: `${entry.symbol} unchanged`,
      });
    } else {
      changes.push(...diffs);
    }
  }

  for (const [assetId, entry] of before) {
    if (after.has(assetId)) continue;
    changes.push({
      kind: 'DEPLOYMENT_REMOVED',
      assetId,
      previous: entry.tokenAddress,
      // A deployment disappearing is never silently applied: outstanding integrations may
      // still be pointing at it.
      opensReview: true,
      detail: `${entry.symbol} is no longer present in the registry`,
    });
  }

  return changes;
}
