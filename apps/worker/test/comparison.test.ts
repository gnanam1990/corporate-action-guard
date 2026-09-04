import {
  compareSources,
  DEFAULT_REQUIRED_AGREEMENT_FIELDS,
  EXACT_TOLERANCE,
  instant,
  unsafe,
  type ApiObservation,
  type ChainObservation,
} from '@cag/domain';
import { describe, expect, it } from 'vitest';

/**
 * Source comparison as the worker performs it.
 *
 * Until this was wired up the agreement verdict was permanently unknown, so every
 * protected action blocked with SOURCE_MISMATCH. That is fail-closed — the correct
 * direction to be wrong in — but a guard that refuses everything is an outage, not a
 * guard. These tests pin the behaviour that makes an ALLOW reachable at all.
 *
 * The values are the real ones observed on X Layer mainnet.
 */

const TOKEN = unsafe.address('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a');
const WRAPPER = unsafe.address('0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f');
const NOW = instant(1_788_000_000_000);

const policy = {
  multiplierTolerance: EXACT_TOLERANCE,
  activationToleranceMs: 0,
  requiredAgreementFields: DEFAULT_REQUIRED_AGREEMENT_FIELDS,
};

const api = (over: Partial<ApiObservation> = {}): ApiObservation => ({
  provenance: { sourceKind: 'XSTOCKS_API', sourceLocator: '/x', observedAt: NOW },
  symbol: unsafe.symbol('AAPLx'),
  tokenAddress: TOKEN,
  wrapperAddress: WRAPPER,
  // As the API sends it: an exact decimal literal lifted from the raw body.
  multiplier: { value: 10_032_690_125_398_187n, decimals: 16 },
  ...over,
});

const chain = (over: Partial<ChainObservation> = {}): ChainObservation => ({
  provenance: { sourceKind: 'XLAYER_RPC', sourceLocator: 'rpc.xlayer.tech', observedAt: NOW },
  chainId: unsafe.chainId(196),
  blockNumber: unsafe.blockNumber(69_713_901n),
  blockHash: unsafe.blockHash(`0x${'ab'.repeat(32)}`),
  tokenAddress: TOKEN,
  wrapperAddress: WRAPPER,
  tokenHasBytecode: true,
  wrapperHasBytecode: true,
  wrapperAsset: TOKEN,
  // As the chain returns it: a uint256 scaled by the token's 18 decimals.
  multiplier: { value: 1_003_269_012_539_818_700n, decimals: 18 },
  multiplierNonce: 5n,
  ...over,
});

describe('the real observed values agree', () => {
  it('matches the API decimal against the chain uint256 across scales', () => {
    // 1.0032690125398187 at 16dp IS 1003269012539818700 at 18dp. Comparing without exact
    // rescaling would produce a permanent false mismatch on every asset.
    const result = compareSources(api(), chain(), policy);
    expect(result.agreement).toBe('MATCH');
    expect(result.fields.find((f) => f.field === 'multiplier')?.agreement).toBe('MATCH');
  });

  it('agrees on a whole-number multiplier written two ways', () => {
    // Observed live: the API sends "1" and the chain sends 1000000000000000000 @18dp.
    const result = compareSources(
      api({ multiplier: { value: 1n, decimals: 0 } }),
      chain({ multiplier: { value: 10n ** 18n, decimals: 18 } }),
      policy,
    );
    expect(result.agreement).toBe('MATCH');
  });

  it('reports the nonce as chain-authoritative, not as a degradation', () => {
    // The API publishes no nonce (ADR 0004). Requiring agreement on it would block every
    // action forever.
    const result = compareSources(api(), chain(), policy);
    const nonce = result.fields.find((f) => f.field === 'multiplierNonce');
    expect(nonce?.requiredForAgreement).toBe(false);
    expect(nonce?.agreement).toBe('INCOMPLETE');
    expect(result.agreement).toBe('MATCH');
  });

  it('treats both sources reporting no pending action as agreement', () => {
    // The resting state of every asset. Scoring it INCOMPLETE would block the catalog.
    const result = compareSources(api(), chain(), policy);
    expect(result.fields.find((f) => f.field === 'scheduledActivation')?.agreement).toBe('MATCH');
  });
});

describe('disagreement is still caught', () => {
  it('a differing multiplier is MISMATCH', () => {
    const result = compareSources(
      api(),
      chain({ multiplier: { value: 2n * 10n ** 18n, decimals: 18 } }),
      policy,
    );
    expect(result.agreement).toBe('MISMATCH');
  });

  it('a multiplier differing in the last of eighteen decimals is MISMATCH', () => {
    // The exact case a float comparison would silently pass.
    const result = compareSources(
      api({ multiplier: { value: 1_000_000_000_000_000_001n, decimals: 18 } }),
      chain({ multiplier: { value: 1_000_000_000_000_000_002n, decimals: 18 } }),
      policy,
    );
    expect(result.agreement).toBe('MISMATCH');
  });

  it('a schedule known to only one source is INCOMPLETE', () => {
    const result = compareSources(
      api({ scheduledActivation: instant(NOW + 3_600_000) }),
      chain(),
      policy,
    );
    expect(result.agreement).toBe('INCOMPLETE');
  });

  it('a multiplier the API could not supply is INCOMPLETE, never assumed from the chain', () => {
    // Filling the gap from the chain value would be inventing agreement — precisely the
    // failure the product exists to prevent.
    const { multiplier: _drop, ...partial } = api();
    const result = compareSources(partial as ApiObservation, chain(), policy);
    expect(result.agreement).toBe('INCOMPLETE');
  });

  it('a differing wrapper is MISMATCH', () => {
    const result = compareSources(
      api(),
      chain({ wrapperAddress: unsafe.address(`0x${'99'.repeat(20)}`) }),
      policy,
    );
    expect(result.agreement).toBe('MISMATCH');
  });

  it('checksum casing alone never creates a mismatch', () => {
    const result = compareSources(
      api({ wrapperAddress: '0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f' as typeof WRAPPER }),
      chain(),
      policy,
    );
    expect(result.agreement).toBe('MATCH');
  });
});

/**
 * The fault harness must be reachable from the worker.
 *
 * It was written, tested, and documented in a runbook — and never wired in. The runbook
 * told an operator to run `FAULTS=XSTOCKS_TIMEOUT node apps/worker/dist/index.js`, and the
 * command did nothing at all. Found by running the documented command, not by a test.
 */
describe('fault injection is reachable from the worker', () => {
  it('parses FAULTS from the environment', async () => {
    const { FaultInjector } = await import('@cag/observability');
    const injector = FaultInjector.fromEnv('XSTOCKS_TIMEOUT');
    expect(injector?.activeKinds()).toEqual(['XSTOCKS_TIMEOUT']);
  });

  it('is off when FAULTS is unset, so a normal run is unaffected', async () => {
    const { FaultInjector } = await import('@cag/observability');
    expect(FaultInjector.fromEnv(undefined)).toBeUndefined();
  });

  it('the worker source constructs the injector and passes it to the client', async () => {
    // A unit test cannot start the worker, so assert the wiring exists in source. Without
    // this the harness silently detaches again the next time the file is refactored.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
    expect(src).toMatch(/FaultInjector\.fromEnv\(process\.env\['FAULTS'\]\)/);
    expect(src).toMatch(/faults === undefined \? \{\} : \{ faults \}/);
  });
});
