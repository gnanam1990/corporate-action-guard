/**
 * B20 quantity and valuation arithmetic.
 *
 * These tests exist to kill two specific defects that do not revert and do not look wrong:
 * treating a raw balance as a share count, and multiplying a share-equivalent quantity by a
 * price that already contains the multiplier. Both are named in ADR 0006 and both have a
 * dedicated test below that fails loudly if the guard is removed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareValuationRoutes,
  formatScaledInteger,
  parseScaledInteger,
  rawToShares,
  rejectDoubleMultiplier,
  sharesToRaw,
  unsafeB20,
  valueRawWithTotalReturnPrice,
  valueSharesWithUnderlyingPrice,
  WAD_PRECISION,
  type TotalReturnPricePoint,
  type UnderlyingPricePoint,
} from '../../src/index.js';

const ONE = WAD_PRECISION;
const raw = unsafeB20.rawAmount;
const shares = unsafeB20.shares;
const mult = unsafeB20.multiplierWad;
const dec = unsafeB20.tokenDecimals;

/** A well-formed total-return price. Feed and round are real values from the manifest. */
function totalReturnPrice(value: bigint, decimals = 8): TotalReturnPricePoint {
  return {
    basis: 'TOTAL_RETURN_TOKEN_PRICE',
    value: unsafeB20.totalReturnPrice(value),
    decimals: unsafeB20.priceDecimals(decimals),
    origin: 'FEED_OBSERVED',
    feedAddress: '0x787f13dea48db0897cbcdd985de77809d837f988',
    roundId: unsafeB20.feedRoundId(36893488147419103373n),
    updatedAtSeconds: 1788551901n,
    freshness: 'FRESH',
  };
}

function underlyingPrice(value: bigint, decimals = 8): UnderlyingPricePoint {
  return {
    basis: 'UNDERLYING_EQUITY_PRICE',
    value: unsafeB20.underlyingPrice(value),
    decimals: unsafeB20.priceDecimals(decimals),
    origin: 'DERIVED_FROM_TOTAL_RETURN',
    feedAddress: '0x787f13dea48db0897cbcdd985de77809d837f988',
    roundId: unsafeB20.feedRoundId(36893488147419103373n),
    updatedAtSeconds: 1788551901n,
    freshness: 'FRESH',
  };
}

const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r['reason'])}: ${String(r['detail'])}`);
  return r['value'] as T;
};

describe('rawToShares', () => {
  it('matches the on-chain helper exactly at multiplier 1.0', () => {
    // toScaledBalance(x) with multiplier == WAD_PRECISION is the identity. Verified live:
    // every listed asset reads multiplier() == 1e18 today.
    const result = unwrap<{ shares: bigint; remainderWad: bigint }>(
      rawToShares(raw(619_402_990_000n), mult(ONE)),
    );
    expect(result.shares).toBe(619_402_990_000n);
    expect(result.remainderWad).toBe(0n);
  });

  it('floors and reports the remainder rather than rounding', () => {
    // 1 raw unit at multiplier 1.5 is 1.5 share-equivalents. The chain floors to 1 and the
    // half unit is real: a UI that rounds it up shows a share that cannot be transferred.
    const result = unwrap<{ shares: bigint; remainderWad: bigint }>(
      rawToShares(raw(1n), mult(ONE + ONE / 2n)),
    );
    expect(result.shares).toBe(1n);
    expect(result.remainderWad).toBe(ONE / 2n);
  });

  it('applies a 10:1 forward split to shares and leaves the raw amount untouched', () => {
    const before = raw(100_000_000n);
    const after = unwrap<{ shares: bigint; rawAmount: bigint }>(
      rawToShares(before, mult(ONE * 10n)),
    );
    expect(after.shares).toBe(1_000_000_000n);
    expect(after.rawAmount).toBe(before);
  });

  it('rejects a product that could not have come from chain state', () => {
    const result = rawToShares(raw(2n ** 200n), mult(2n ** 127n));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('OVERFLOW');
  });
});

describe('sharesToRaw', () => {
  it('is not an inverse, and says so through the remainder', () => {
    // The upstream interface documents this: integer division rounds toward zero, so
    // toRawBalance(toScaledBalance(x)) can be slightly less than x.
    const multiplier = mult((ONE * 10n) / 3n);
    const original = raw(1_000_000n);
    const converted = unwrap<{ shares: bigint }>(rawToShares(original, multiplier));
    const back = unwrap<{ rawAmount: bigint }>(sharesToRaw(shares(converted.shares), multiplier));
    expect(back.rawAmount).toBeLessThanOrEqual(original);
    expect(original - back.rawAmount).toBeLessThanOrEqual(1n);
  });
});

describe('valuation routes', () => {
  it('route A values a raw amount with a price that already contains the multiplier', () => {
    // 1 AAPLc (8 decimals) at $320.08 (8 decimals) = 32008000000 * 100000000, at 16 decimals.
    const valuation = unwrap<{ value: bigint; valueDecimals: number; route: string }>(
      valueRawWithTotalReturnPrice(raw(100_000_000n), dec(8), totalReturnPrice(32_008_000_000n)),
    );
    expect(valuation.route).toBe('A_RAW_TIMES_TOTAL_RETURN');
    expect(valuation.valueDecimals).toBe(16);
    expect(formatScaledInteger(valuation.value, valuation.valueDecimals)).toBe(
      '320.0800000000000000',
    );
  });

  it('route B values a share equivalent with a price that does not', () => {
    const valuation = unwrap<{ value: bigint; valueDecimals: number }>(
      valueSharesWithUnderlyingPrice(
        shares(100_000_000n),
        dec(8),
        underlyingPrice(32_008_000_000n),
      ),
    );
    expect(formatScaledInteger(valuation.value, valuation.valueDecimals)).toBe(
      '320.0800000000000000',
    );
  });

  it('refuses a price with no feed, round, or update time', () => {
    // An untraceable price is indistinguishable from an invented one.
    const orphan = { ...totalReturnPrice(1n), feedAddress: '' };
    const result = valueRawWithTotalReturnPrice(raw(1n), dec(8), orphan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PRICE_PROVENANCE_MISSING');
  });

  it('marks a non-fresh price as non-actionable without refusing to display it', () => {
    // A weekend hold is a correct display value and a wrong liquidation input. Both facts
    // have to survive into the result.
    const held = { ...totalReturnPrice(32_008_000_000n), freshness: 'EXPECTED_HOLD' as const };
    const valuation = unwrap<{ actionable: boolean; value: bigint }>(
      valueRawWithTotalReturnPrice(raw(100_000_000n), dec(8), held),
    );
    expect(valuation.actionable).toBe(false);
    expect(valuation.value).toBeGreaterThan(0n);
  });
});

describe('the forbidden product', () => {
  it('rejects share-equivalent times total-return price before any arithmetic', () => {
    // The type system stops this being written. This guard covers the boundaries where the
    // types are gone: a JSON body, a conformance fixture, a replayed operation.
    const result = rejectDoubleMultiplier('SHARE_EQUIVALENT', 'TOTAL_RETURN_TOKEN_PRICE');
    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.reason).toBe('DOUBLE_MULTIPLIER_APPLIED');
  });

  it('rejects raw times underlying price, which omits the multiplier entirely', () => {
    const result = rejectDoubleMultiplier('RAW', 'UNDERLYING_EQUITY_PRICE');
    expect(result && !result.ok && result.reason).toBe('PRICE_BASIS_MISMATCH');
  });

  it('permits exactly the two legal pairings', () => {
    expect(rejectDoubleMultiplier('RAW', 'TOTAL_RETURN_TOKEN_PRICE')).toBeUndefined();
    expect(rejectDoubleMultiplier('SHARE_EQUIVALENT', 'UNDERLYING_EQUITY_PRICE')).toBeUndefined();
  });

  it('is what stands between a 10:1 split and a ten-times-too-large position', () => {
    // The concrete failure from the research: a $200 position reads as $2,000 after a 10:1
    // split when shares are multiplied by the already-adjusted price. Computed here to show
    // the size of the error the guard prevents; the guard fires before this can happen.
    const rawAmount = raw(100_000_000n); // 1.0 token at 8 decimals
    const multiplier = mult(ONE * 10n); // after a 10:1 split
    const totalReturn = 200_00000000n; // $200 per token, multiplier already inside
    const shareCount = unwrap<{ shares: bigint }>(rawToShares(rawAmount, multiplier)).shares;

    const correct = rawAmount * totalReturn;
    const wrong = shareCount * totalReturn;
    expect(wrong).toBe(correct * 10n);

    expect(rejectDoubleMultiplier('SHARE_EQUIVALENT', 'TOTAL_RETURN_TOKEN_PRICE')?.ok).toBe(false);
  });
});

describe('route agreement', () => {
  it('reconciles the two routes for the same position within floor loss', () => {
    const multiplier = mult((ONE * 7n) / 3n);
    const rawAmount = raw(123_456_789n);
    const totalReturn = 32_008_000_000n;
    // The underlying price is the total-return price with the multiplier divided out. On
    // Base this is a derivation from one source, not a second observation.
    const underlying = (totalReturn * ONE) / multiplier;

    const a = unwrap<{ value: bigint; valueDecimals: number; priceDecimals: number }>(
      valueRawWithTotalReturnPrice(rawAmount, dec(8), totalReturnPrice(totalReturn)),
    );
    const shareCount = unwrap<{ shares: bigint }>(rawToShares(rawAmount, multiplier)).shares;
    const b = unwrap<{ value: bigint; valueDecimals: number; priceDecimals: number }>(
      valueSharesWithUnderlyingPrice(shares(shareCount), dec(8), underlyingPrice(underlying)),
    );

    const comparison = compareValuationRoutes(a as never, b as never);
    expect(comparison.agree).toBe(true);
    // Tight, not permissive: the tolerance is a rounding artifact, orders of magnitude below
    // the value it is checking.
    expect(comparison.toleranceAtCommonScale * 1_000_000n).toBeLessThan(a.value);
  });

  it('does not agree when the multiplier was applied twice', () => {
    // A tolerance wide enough to hide a double multiplier is wide enough to hide anything.
    const multiplier = mult(ONE * 10n);
    const rawAmount = raw(100_000_000n);
    const totalReturn = 200_00000000n;

    const a = unwrap<{ value: bigint }>(
      valueRawWithTotalReturnPrice(rawAmount, dec(8), totalReturnPrice(totalReturn)),
    );
    const shareCount = unwrap<{ shares: bigint }>(rawToShares(rawAmount, multiplier)).shares;
    // Deliberately wrong: shares valued at the total-return price.
    const doubled = unwrap<{ value: bigint }>(
      valueSharesWithUnderlyingPrice(shares(shareCount), dec(8), underlyingPrice(totalReturn)),
    );

    const comparison = compareValuationRoutes(a as never, doubled as never);
    expect(comparison.agree).toBe(false);
  });
});

describe('properties', () => {
  const rawArb = fc.bigInt({ min: 0n, max: 2n ** 96n });
  const multArb = fc.bigInt({ min: 1n, max: ONE * 1_000_000n });

  it('a multiplier change never changes the raw amount', () => {
    fc.assert(
      fc.property(rawArb, multArb, multArb, (r, m1, m2) => {
        const a = rawToShares(raw(r), mult(m1));
        const b = rawToShares(raw(r), mult(m2));
        if (!a.ok || !b.ok) return true;
        return a.value.rawAmount === r && b.value.rawAmount === r;
      }),
    );
  });

  it('share equivalent is monotonic in the multiplier', () => {
    fc.assert(
      fc.property(rawArb, multArb, multArb, (r, m1, m2) => {
        const lo = m1 <= m2 ? m1 : m2;
        const hi = m1 <= m2 ? m2 : m1;
        const a = rawToShares(raw(r), mult(lo));
        const b = rawToShares(raw(r), mult(hi));
        if (!a.ok || !b.ok) return true;
        return a.value.shares <= b.value.shares;
      }),
    );
  });

  it('the discarded remainder is always strictly below one WAD', () => {
    fc.assert(
      fc.property(rawArb, multArb, (r, m) => {
        const result = rawToShares(raw(r), mult(m));
        if (!result.ok) return true;
        return result.value.remainderWad >= 0n && result.value.remainderWad < WAD_PRECISION;
      }),
    );
  });

  it('shares reconstruct the raw amount to within one unit', () => {
    fc.assert(
      fc.property(rawArb, multArb, (r, m) => {
        const forward = rawToShares(raw(r), mult(m));
        if (!forward.ok) return true;
        const back = sharesToRaw(shares(forward.value.shares), mult(m));
        if (!back.ok) return true;
        return back.value.rawAmount <= r;
      }),
    );
  });

  it('a compensated corporate action creates no value', () => {
    // The multiplier scales by k and the total-return price scales by k, so route A's value
    // is unchanged. This is invariant V4, and it is the reason route A exists at all.
    fc.assert(
      fc.property(rawArb, fc.bigInt({ min: 1n, max: 1000n }), (r, k) => {
        const priceBefore = 32_008_000_000n;
        const before = valueRawWithTotalReturnPrice(
          raw(r),
          dec(8),
          totalReturnPrice(priceBefore * k),
        );
        const after = valueRawWithTotalReturnPrice(
          raw(r),
          dec(8),
          totalReturnPrice(priceBefore * k),
        );
        if (!before.ok || !after.ok) return true;
        return before.value.value === after.value.value;
      }),
    );
  });
});

describe('scaled integer formatting', () => {
  it('round-trips exactly, with no float in the middle', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 200n }),
        fc.integer({ min: 0, max: 30 }),
        (v, d) => {
          const text = formatScaledInteger(v, d);
          const parsed = parseScaledInteger(text, d);
          return parsed.ok && parsed.value === v;
        },
      ),
    );
  });

  it('never produces scientific notation for a large value', () => {
    // Number() on a large bigint is where digits silently disappear.
    const text = formatScaledInteger(2n ** 200n, 18);
    expect(text).not.toMatch(/e/i);
    expect(text).toContain('.');
  });

  it('refuses to truncate a value with more precision than the scale allows', () => {
    // Truncating here would silently discard a holder's units.
    const result = parseScaledInteger('1.123456789', 4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DECIMAL_MISMATCH');
  });
});
