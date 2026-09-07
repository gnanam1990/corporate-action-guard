/**
 * "Show the math."
 *
 * The derivation is the product's most valuable customer-facing artifact: a wallet that
 * disagrees with us needs to see exactly where we diverged. These tests pin the two things
 * that make it useful — every step is exactly recomputable by hand, and the forbidden route
 * is shown, computed, and marked rejected rather than hidden.
 */
import { describe, expect, it } from 'vitest';
import {
  derivationToJson,
  deriveQuantity,
  deriveValuation,
  unsafeB20,
  WAD_PRECISION,
  type DerivationEvidence,
  type TotalReturnPricePoint,
  type UnderlyingPricePoint,
} from '../../src/index.js';

const ONE = WAD_PRECISION;
const DECIMALS = unsafeB20.tokenDecimals(8);

const EVIDENCE: DerivationEvidence = {
  assetKey: '8453:0xb200000000000000000000c2e324d24d7eecd1fb',
  blockRef: '8453:50993686@0xabf162b6',
  manifestRef: 'provenance/base-b20/asset-manifest.json#AAPLc',
};

const totalReturn = (value: bigint): TotalReturnPricePoint => ({
  basis: 'TOTAL_RETURN_TOKEN_PRICE',
  value: unsafeB20.totalReturnPrice(value),
  decimals: unsafeB20.priceDecimals(8),
  origin: 'FEED_OBSERVED',
  feedAddress: '0x787f13dea48db0897cbcdd985de77809d837f988',
  roundId: unsafeB20.feedRoundId(36893488147419103373n),
  updatedAtSeconds: 1788551901n,
  freshness: 'FRESH',
});

const underlying = (value: bigint): UnderlyingPricePoint => ({
  ...totalReturn(value),
  basis: 'UNDERLYING_EQUITY_PRICE',
  value: unsafeB20.underlyingPrice(value),
  origin: 'DERIVED_FROM_TOTAL_RETURN',
});

describe('quantity derivation', () => {
  const result = deriveQuantity(
    unsafeB20.rawAmount(123_456_789n),
    unsafeB20.multiplierWad((ONE * 7n) / 3n),
    DECIMALS,
    EVIDENCE,
  );

  it('produces a step a reviewer can recompute by hand', () => {
    if ('error' in result) throw new Error(result.error);
    const step = result.steps.find((s) => s.label === 'Share equivalent');
    expect(step?.expression).toBe(
      `floor(123456789 * ${((ONE * 7n) / 3n).toString()} / ${ONE.toString()})`,
    );
    // The stated result must equal what the stated expression computes.
    expect(BigInt(step?.resultRaw ?? '0')).toBe((123_456_789n * ((ONE * 7n) / 3n)) / ONE);
  });

  it('gives the discarded remainder its own step rather than a footnote', () => {
    if ('error' in result) throw new Error(result.error);
    const step = result.steps.find((s) => s.label.startsWith('Remainder'));
    expect(step).toBeDefined();
    expect(BigInt(step?.resultRaw ?? '-1')).toBeGreaterThanOrEqual(0n);
    expect(BigInt(step?.resultRaw ?? '0')).toBeLessThan(ONE);
  });

  it('cites the block and manifest each step used', () => {
    if ('error' in result) throw new Error(result.error);
    expect(result.steps.every((s) => s.evidence.length > 0)).toBe(true);
    expect(result.steps.some((s) => s.evidence.includes(EVIDENCE.manifestRef))).toBe(true);
  });
});

describe('valuation derivation', () => {
  const raw = unsafeB20.rawAmount(100_000_000n);
  const multiplier = unsafeB20.multiplierWad(ONE * 10n);
  const price = 200_00000000n;

  const result = deriveValuation(
    raw,
    multiplier,
    DECIMALS,
    totalReturn(price),
    underlying((price * ONE) / multiplier),
    EVIDENCE,
  );

  it('shows both valid routes side by side', () => {
    expect(result.routeA).toBeDefined();
    expect(result.routeB).toBeDefined();
    expect(result.routesAgree).toBe(true);
  });

  it('labels route B as derived, not as a second opinion', () => {
    // On Base the underlying price comes from dividing the total-return price. Presenting
    // that as corroboration would make one source look like two.
    const step = result.steps.find((s) => s.label.startsWith('Route B'));
    expect(step?.label).toContain('not an independent source');
  });

  it('includes the forbidden route, computed and marked rejected', () => {
    // Teaching an integrator why it is wrong beats refusing it silently. Ten times the real
    // value, and it does not revert.
    const step = result.steps.find((s) => s.rejected !== undefined);
    expect(step?.rejected?.reason).toBe('DOUBLE_MULTIPLIER_APPLIED');
    expect(BigInt(step?.resultRaw ?? '0')).toBe(BigInt(result.routeA?.value ?? 0n) * 10n);
  });

  it('marks the whole valuation non-actionable if any price was not', () => {
    // Reporting the optimistic half would let a caller act on one route and ignore the other.
    const held = { ...totalReturn(price), freshness: 'EXPECTED_HOLD' as const };
    const degraded = deriveValuation(raw, multiplier, DECIMALS, held, undefined, EVIDENCE);
    expect(degraded.actionable).toBe(false);
  });

  it('reports agreement as a step, with the bound it was judged against', () => {
    const step = result.steps.find((s) => s.label === 'Route agreement');
    expect(step?.resultRaw).toBe('AGREE');
    expect(step?.expression).toContain('<=');
  });
});

describe('serialization', () => {
  it('stringifies bigints instead of throwing or losing digits', () => {
    // JSON.stringify throws on a bigint, and Number() silently drops digits above 2^53.
    const result = deriveQuantity(
      unsafeB20.rawAmount(2n ** 100n),
      unsafeB20.multiplierWad(ONE),
      DECIMALS,
      EVIDENCE,
    );
    if ('error' in result) throw new Error(result.error);
    const json = derivationToJson(result);
    expect(json).toContain((2n ** 100n).toString());
    expect(json).not.toMatch(/e\+/);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
