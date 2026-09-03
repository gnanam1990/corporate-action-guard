import {
  addressEquals,
  summarizeCanonicality,
  type CanonicalityCheck,
  type CanonicalityResult,
  type CheckOutcome,
} from '@cag/domain';
import type { XStocksAsset, XStocksDeployment } from '@cag/xstocks-client';
import type { ChainSnapshot } from '@cag/xlayer-reader';

/**
 * Canonical asset and wrapper verification.
 *
 * Joins what the live registry declares with what the chain actually contains, and reports
 * PASS / FAIL / UNKNOWN **per check** — never a single unexplained boolean. An operator
 * looking at a block needs to know which of six things went wrong.
 *
 * Two rules run through everything here:
 *  - Canonical addresses come from the live API at runtime, never from a constant list in
 *    source. A hard-coded registry is a registry that silently goes stale.
 *  - UNKNOWN is never optimistically resolved. `summarizeCanonicality` returns PASS only
 *    when every check passes, and a property test asserts no UNKNOWN can produce PASS.
 */

export interface CanonicalityInput {
  /** What the live API declared for this asset. */
  readonly asset: XStocksAsset;
  /** The X Layer deployment inside that asset. */
  readonly deployment: XStocksDeployment;
  /** What the chain contained, at a recorded block. */
  readonly snapshot: ChainSnapshot;
}

export interface CanonicalityRecord extends CanonicalityResult {
  readonly assetId: string;
  readonly symbol: string;
  readonly apiTokenAddress: string;
  /** The current wrapper the API declares. Undefined means the API did not say. */
  readonly apiCurrentWrapperAddress: string | undefined;
  /** The wrapper version accepted for protected actions. */
  readonly apiWrapperVersion: number | undefined;
  readonly observedWrapperAsset: string | undefined;
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly apiSourceLocator: string;
  readonly chainProviderName: string;
  readonly observedAtMs: number;
}

/**
 * Only `wrapperAddressV2` is accepted for protected actions.
 *
 * `wrapperAddress` (v1) is preserved when present so historical incidents can be replayed
 * against the wrapper that was current at the time — but a v1 wrapper still holding
 * bytecode is emphatically not a reason to accept it now.
 */
export const CURRENT_WRAPPER_VERSION = 2;

export function currentWrapperAddress(deployment: XStocksDeployment): string | undefined {
  return deployment.wrapperAddressV2;
}

export function legacyWrapperAddress(deployment: XStocksDeployment): string | undefined {
  return deployment.wrapperAddress;
}

const check = (
  name: CanonicalityCheck['name'],
  outcome: CheckOutcome,
  detail: string,
): CanonicalityCheck => ({ name, outcome, detail });

/**
 * Build the six-row canonicality matrix.
 *
 * Every row is derived from evidence that is present in the inputs. Nothing is inferred
 * from the absence of a contradiction.
 */
export function verifyCanonicality(input: CanonicalityInput): CanonicalityRecord {
  const { asset, deployment, snapshot } = input;
  const apiToken = deployment.address;
  const apiWrapper = currentWrapperAddress(deployment);

  const checks: CanonicalityCheck[] = [];

  // 1. Does the token the chain was read at match what the registry declares?
  checks.push(
    addressEquals(apiToken, snapshot.tokenAddress)
      ? check(
          'TOKEN_MATCHES_REGISTRY',
          'PASS',
          `registry token ${apiToken} matches the observed address`,
        )
      : check(
          'TOKEN_MATCHES_REGISTRY',
          'FAIL',
          `registry declares ${apiToken} but the chain was read at ${snapshot.tokenAddress}`,
        ),
  );

  // 2. Same for the wrapper. An API that does not declare a current wrapper is UNKNOWN —
  //    it is not permission to accept whatever address the caller supplied.
  if (apiWrapper === undefined) {
    checks.push(
      check(
        'WRAPPER_MATCHES_REGISTRY',
        'UNKNOWN',
        'the registry declares no current (v2) wrapper for this deployment',
      ),
    );
  } else {
    checks.push(
      addressEquals(apiWrapper, snapshot.wrapperAddress)
        ? check(
            'WRAPPER_MATCHES_REGISTRY',
            'PASS',
            `registry wrapper ${apiWrapper} matches the observed address`,
          )
        : check(
            'WRAPPER_MATCHES_REGISTRY',
            'FAIL',
            `registry declares ${apiWrapper} but the chain was read at ${snapshot.wrapperAddress}`,
          ),
    );
  }

  // 3 and 4. Bytecode. An address with no code is not a contract, whatever the registry says.
  const codeFailed = (target: 'token' | 'wrapper') =>
    snapshot.failedReads.includes(`eth_getCode(${target})`);

  checks.push(
    codeFailed('token')
      ? check(
          'TOKEN_HAS_BYTECODE',
          'UNKNOWN',
          'eth_getCode failed; bytecode presence is undetermined',
        )
      : snapshot.tokenHasBytecode
        ? check('TOKEN_HAS_BYTECODE', 'PASS', `code present at block ${snapshot.blockNumber}`)
        : check(
            'TOKEN_HAS_BYTECODE',
            'FAIL',
            `eth_getCode returned 0x at block ${snapshot.blockNumber}`,
          ),
  );

  checks.push(
    codeFailed('wrapper')
      ? check(
          'WRAPPER_HAS_BYTECODE',
          'UNKNOWN',
          'eth_getCode failed; bytecode presence is undetermined',
        )
      : snapshot.wrapperHasBytecode
        ? check('WRAPPER_HAS_BYTECODE', 'PASS', `code present at block ${snapshot.blockNumber}`)
        : check(
            'WRAPPER_HAS_BYTECODE',
            'FAIL',
            `eth_getCode returned 0x at block ${snapshot.blockNumber}`,
          ),
  );

  // 5. The relation that actually matters: does the wrapper agree about its own underlying?
  if (snapshot.wrapperAsset === undefined) {
    checks.push(
      check(
        'WRAPPER_ASSET_RELATION',
        'UNKNOWN',
        'wrapper.asset() could not be read; the relation is undetermined',
      ),
    );
  } else if (addressEquals(snapshot.wrapperAsset, apiToken)) {
    checks.push(
      check(
        'WRAPPER_ASSET_RELATION',
        'PASS',
        `wrapper.asset() returns the expected token ${apiToken}`,
      ),
    );
  } else {
    checks.push(
      check(
        'WRAPPER_ASSET_RELATION',
        'FAIL',
        `wrapper.asset() returns ${snapshot.wrapperAsset}, not the expected token ${apiToken}`,
      ),
    );
  }

  // 6. Is this the current wrapper version? A legacy wrapper with live bytecode is still
  //    a legacy wrapper.
  checks.push(
    apiWrapper === undefined
      ? check('WRAPPER_VERSION_CURRENT', 'UNKNOWN', 'no current wrapper version is declared')
      : addressEquals(apiWrapper, snapshot.wrapperAddress)
        ? check(
            'WRAPPER_VERSION_CURRENT',
            'PASS',
            `v${CURRENT_WRAPPER_VERSION} is the current wrapper`,
          )
        : check(
            'WRAPPER_VERSION_CURRENT',
            'FAIL',
            `the observed wrapper is not the current v${CURRENT_WRAPPER_VERSION} wrapper`,
          ),
  );

  return {
    ...summarizeCanonicality(checks),
    assetId: asset.id,
    symbol: asset.symbol,
    apiTokenAddress: apiToken.toLowerCase(),
    apiCurrentWrapperAddress: apiWrapper?.toLowerCase(),
    apiWrapperVersion: apiWrapper === undefined ? undefined : CURRENT_WRAPPER_VERSION,
    observedWrapperAsset: snapshot.wrapperAsset,
    chainId: snapshot.chainId,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    apiSourceLocator: '',
    chainProviderName: snapshot.providerName,
    observedAtMs: snapshot.observedAtMs,
  };
}
