/**
 * B20 quantity and valuation arithmetic.
 *
 * Two rules govern every function here.
 *
 * First, the multiplier is applied exactly once. `rawToShares` applies it; the valuation
 * routes then take either the raw amount with a price that already contains it, or the
 * share equivalent with a price that does not. There is no third combination, and the one
 * that would double it does not typecheck.
 *
 * Second, nothing rounds silently. `floor` matches the on-chain helper
 * (`rawBalance * multiplier / WAD_PRECISION`, integer division — see
 * `provenance/base-b20/base-std/src/interfaces/IB20Asset.sol`), and the remainder that floor
 * discards is returned rather than dropped. A holder who is short by one unit is owed an
 * explanation, not a rounding convention.
 */

import {
  isActionableFreshness,
  MAX_RAW_AMOUNT,
  WAD_PRECISION,
  type MultiplierWad,
  type PriceDecimals,
  type RawAmount,
  type ShareEquivalentAmount,
  type TokenDecimals,
  type TotalReturnPricePoint,
  type UnderlyingPricePoint,
  unsafeB20,
} from './quantities.js';

/** Failure shape shared by every function in this module. Nothing here throws. */
export type ArithmeticResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: B20ArithmeticError; readonly detail: string };

/**
 * Arithmetic failures that a caller must handle. These are distinct from decision reason
 * codes: they say the calculation could not be performed, not that an action is blocked.
 */
export const B20_ARITHMETIC_ERRORS = [
  'DOUBLE_MULTIPLIER_APPLIED',
  'PRICE_BASIS_MISMATCH',
  'PRICE_PROVENANCE_MISSING',
  'DECIMAL_MISMATCH',
  'OVERFLOW',
  'NEGATIVE_INPUT',
] as const;
export type B20ArithmeticError = (typeof B20_ARITHMETIC_ERRORS)[number];

const ok = <T>(value: T): ArithmeticResult<T> => ({ ok: true, value });
const fail = <T>(reason: B20ArithmeticError, detail: string): ArithmeticResult<T> => ({
  ok: false,
  reason,
  detail,
});

/*
 * Quantity conversion.
 */

export interface SharesConversion {
  readonly shares: ShareEquivalentAmount;
  /**
   * `(rawAmount * multiplier) mod WAD_PRECISION` — the part floor discarded, expressed in
   * WAD units. Reported so a UI can show it and a reconciliation can bound it, never
   * absorbed into the result.
   */
  readonly remainderWad: bigint;
  readonly rawAmount: RawAmount;
  readonly multiplierWad: MultiplierWad;
}

/**
 * `floor(rawAmount * multiplier / 1e18)`, matching `toScaledBalance` exactly.
 *
 * Deliberately not "round half up". The on-chain helper floors, and a UI that rounds up
 * where the chain floors will eventually show a holder a share they cannot transfer.
 */
export function rawToShares(
  raw: RawAmount,
  multiplier: MultiplierWad,
): ArithmeticResult<SharesConversion> {
  if (raw < 0n) return fail('NEGATIVE_INPUT', 'raw amount is negative');
  const scaled = raw * multiplier;
  // Supply is uint128-capped and the multiplier is uint128-capped, so the product stays
  // inside uint256 on chain. Asserting it here keeps an out-of-band value from producing a
  // number that no chain state could ever have produced.
  if (scaled > 2n ** 256n - 1n) {
    return fail('OVERFLOW', 'rawAmount * multiplier exceeds uint256');
  }
  return ok({
    shares: unsafeB20.shares(scaled / WAD_PRECISION),
    remainderWad: scaled % WAD_PRECISION,
    rawAmount: raw,
    multiplierWad: multiplier,
  });
}

export interface RawConversion {
  readonly rawAmount: RawAmount;
  /** `(shares * 1e18) mod multiplier`, in multiplier units. */
  readonly remainder: bigint;
}

/**
 * `floor(shares * 1e18 / multiplier)`, matching `toRawBalance`.
 *
 * Not an inverse. The upstream interface says so plainly: integer division rounds toward
 * zero, so `toRawBalance(toScaledBalance(x))` can be slightly less than `x`. The loss is
 * bounded by one raw unit and is returned as `remainder` rather than being hidden.
 */
export function sharesToRaw(
  shares: ShareEquivalentAmount,
  multiplier: MultiplierWad,
): ArithmeticResult<RawConversion> {
  if (shares < 0n) return fail('NEGATIVE_INPUT', 'share-equivalent amount is negative');
  const scaled = shares * WAD_PRECISION;
  const raw = scaled / multiplier;
  if (raw > MAX_RAW_AMOUNT) {
    return fail('OVERFLOW', 'resulting raw amount exceeds the on-chain supply cap');
  }
  return ok({ rawAmount: unsafeB20.rawAmount(raw), remainder: scaled % multiplier });
}

/*
 * Valuation.
 */

export const VALUATION_ROUTES = ['A_RAW_TIMES_TOTAL_RETURN', 'B_SHARES_TIMES_UNDERLYING'] as const;
export type ValuationRoute = (typeof VALUATION_ROUTES)[number];

export interface Valuation {
  readonly route: ValuationRoute;
  /** Exact integer value, scaled by `10 ** valueDecimals`. Never a float, never a string of one. */
  readonly value: bigint;
  /** `tokenDecimals + priceDecimals`. Stated so a caller cannot guess it wrong. */
  readonly valueDecimals: number;
  readonly quantity: bigint;
  readonly priceValue: bigint;
  readonly priceDecimals: PriceDecimals;
  readonly feedAddress: string;
  readonly roundId: bigint;
  /** True only when the price's freshness is actionable for a money-moving decision. */
  readonly actionable: boolean;
}

/**
 * Route A — a raw amount valued with a price that already contains the multiplier.
 *
 * Correct because the multiplier lives in the price, so the raw amount must *not* have been
 * converted to shares first.
 */
export function valueRawWithTotalReturnPrice(
  raw: RawAmount,
  tokenDecimals: TokenDecimals,
  price: TotalReturnPricePoint,
): ArithmeticResult<Valuation> {
  const guard = requireUsablePrice<Valuation>(price, 'TOTAL_RETURN_TOKEN_PRICE');
  if (guard !== undefined) return guard;
  return ok(build('A_RAW_TIMES_TOTAL_RETURN', raw, tokenDecimals, price));
}

/**
 * Route B — a share-equivalent amount valued with a price that does not contain the
 * multiplier.
 *
 * On Base today no feed publishes an underlying price, so this route runs on a price derived
 * from route A's. `origin` records that, and callers must not treat the two as independent
 * corroboration.
 */
export function valueSharesWithUnderlyingPrice(
  shares: ShareEquivalentAmount,
  shareDecimals: TokenDecimals,
  price: UnderlyingPricePoint,
): ArithmeticResult<Valuation> {
  const guard = requireUsablePrice<Valuation>(price, 'UNDERLYING_EQUITY_PRICE');
  if (guard !== undefined) return guard;
  return ok(build('B_SHARES_TIMES_UNDERLYING', shares, shareDecimals, price));
}

function build(
  route: ValuationRoute,
  quantity: bigint,
  decimals: TokenDecimals,
  price: TotalReturnPricePoint | UnderlyingPricePoint,
): Valuation {
  return {
    route,
    value: quantity * price.value,
    valueDecimals: (decimals as number) + (price.decimals as number),
    quantity,
    priceValue: price.value,
    priceDecimals: price.decimals,
    feedAddress: price.feedAddress,
    roundId: price.roundId,
    actionable: isActionableFreshness(price.freshness),
  };
}

function requireUsablePrice<T>(
  price: TotalReturnPricePoint | UnderlyingPricePoint,
  expected: string,
): ArithmeticResult<T> | undefined {
  if (price.basis !== expected) {
    return fail('PRICE_BASIS_MISMATCH', `expected ${expected}, received ${String(price.basis)}`);
  }
  // A price with no feed, no round or no timestamp cannot be traced back to an observation,
  // and an untraceable price is indistinguishable from an invented one.
  if (price.feedAddress === '' || price.roundId <= 0n || price.updatedAtSeconds <= 0n) {
    return fail('PRICE_PROVENANCE_MISSING', 'price is missing feed, round, or update time');
  }
  if (price.value <= 0n) return fail('NEGATIVE_INPUT', 'price must be positive');
  return undefined;
}

/**
 * The forbidden product, as an explicit runtime refusal.
 *
 * The type system already stops `shareEquivalent × TOTAL_RETURN_TOKEN_PRICE` from being
 * written. This exists for the boundaries where the types are gone — a JSON request body, a
 * conformance fixture, a stored operation replayed from the journal — so the combination is
 * rejected *before* any multiplication happens rather than computed and then flagged.
 */
export function rejectDoubleMultiplier(
  quantityKind: 'RAW' | 'SHARE_EQUIVALENT',
  basis: string,
): ArithmeticResult<never> | undefined {
  if (quantityKind === 'SHARE_EQUIVALENT' && basis === 'TOTAL_RETURN_TOKEN_PRICE') {
    return fail(
      'DOUBLE_MULTIPLIER_APPLIED',
      'share-equivalent amount valued with a total-return token price applies the multiplier ' +
        'twice; use rawAmount with TOTAL_RETURN_TOKEN_PRICE, or shareEquivalent with ' +
        'UNDERLYING_EQUITY_PRICE',
    );
  }
  if (quantityKind === 'RAW' && basis === 'UNDERLYING_EQUITY_PRICE') {
    return fail(
      'PRICE_BASIS_MISMATCH',
      'raw amount valued with an underlying share price omits the multiplier entirely',
    );
  }
  return undefined;
}

/*
 * Route agreement.
 */

export interface RouteComparison {
  readonly agree: boolean;
  /** Absolute difference, rescaled to the finer of the two value scales. */
  readonly differenceAtCommonScale: bigint;
  /** The largest difference floor loss alone can explain, at the same scale. */
  readonly toleranceAtCommonScale: bigint;
  readonly commonScale: number;
}

/**
 * Compare the two routes for one position.
 *
 * They are not expected to be bit-identical, and the gap is not a fudge factor — it is the
 * sum of exactly two floors, each derived from the inputs:
 *
 *   floor(raw * m / 1e18)        loses under one share-equivalent unit, worth at most one
 *                                underlying price at the value scale;
 *   floor(P_total * 1e18 / m)    loses under one price unit per share, worth at most the
 *                                share count at the value scale.
 *
 * So the tolerance is `shares + underlyingPrice`, at route B's scale. Anything wider would
 * start to hide a real disagreement, and a tolerance wide enough to hide a double multiplier
 * is wide enough to hide anything: a 10:1 split misapplied is off by 900 %, nine orders of
 * magnitude outside this bound. A difference beyond it is a CONFLICT for the caller to act
 * on, never an average.
 */
export function compareValuationRoutes(routeA: Valuation, routeB: Valuation): RouteComparison {
  const commonScale = Math.max(routeA.valueDecimals, routeB.valueDecimals);
  const lift = (value: bigint, scale: number) => value * 10n ** BigInt(commonScale - scale);

  const a = lift(routeA.value, routeA.valueDecimals);
  const b = lift(routeB.value, routeB.valueDecimals);
  const difference = a > b ? a - b : b - a;

  // routeB.quantity is the share count; routeB.priceValue is the underlying price. Both are
  // already expressed at route B's own scale, so one lift covers the pair.
  const tolerance = lift(routeB.quantity + routeB.priceValue + 1n, routeB.valueDecimals);

  return {
    agree: difference <= tolerance,
    differenceAtCommonScale: difference,
    toleranceAtCommonScale: tolerance,
    commonScale,
  };
}

/*
 * Display.
 */

/**
 * Render an exact integer and its scale as a decimal string.
 *
 * Display only, and separated from every function above on purpose: formatting must never be
 * able to change arithmetic. There is no float anywhere in this path, and no scientific
 * notation, which is how a large `bigint` silently loses digits when it meets `Number`.
 */
export function formatScaledInteger(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(digits.length - decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Parse a decimal string to an exact integer at `decimals` scale, without a float. */
export function parseScaledInteger(input: string, decimals: number): ArithmeticResult<bigint> {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return fail('DECIMAL_MISMATCH', 'value must be a decimal string');
  }
  const negative = trimmed.startsWith('-');
  const [wholeRaw, fractionRaw = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (fractionRaw.length > decimals) {
    // Truncating here would silently discard a holder's units. The caller has to decide.
    return fail(
      'DECIMAL_MISMATCH',
      `value has ${fractionRaw.length} fractional digits but the scale is ${decimals}`,
    );
  }
  const padded = fractionRaw.padEnd(decimals, '0');
  const magnitude = BigInt(`${wholeRaw ?? '0'}${padded}`);
  return ok(negative ? -magnitude : magnitude);
}
