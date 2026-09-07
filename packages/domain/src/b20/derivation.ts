/**
 * "Show the math."
 *
 * The most valuable thing this product can hand a customer is not a number — it is the
 * derivation of that number, in the order it was computed, with the evidence each step used.
 * A wallet that disagrees with us needs to see exactly where the two of us diverged, and
 * "our engine says 10 shares" does not tell anyone that.
 *
 * This module builds that derivation as data. It imports no UI, produces no HTML, and does
 * no formatting decisions beyond exact decimal rendering — so the console, the CLI, the JSON
 * export and the evidence package all render the same structure and cannot drift apart.
 *
 * It is also where the forbidden route is shown *as an example*. Teaching an integrator why
 * `shareEquivalent × totalReturnPrice` is wrong is more useful than refusing it silently, so
 * the rejected step is included, computed, and marked rejected — never selectable.
 */

import {
  compareValuationRoutes,
  formatScaledInteger,
  rawToShares,
  valueRawWithTotalReturnPrice,
  valueSharesWithUnderlyingPrice,
  type Valuation,
} from './arithmetic.js';
import {
  WAD_PRECISION,
  type MultiplierWad,
  type RawAmount,
  type TokenDecimals,
  type TotalReturnPricePoint,
  type UnderlyingPricePoint,
} from './quantities.js';

/** One line of the derivation. Machine-readable first, human-readable second. */
export interface DerivationStep {
  readonly label: string;
  /** The exact integer expression, in the form a reviewer can recompute by hand. */
  readonly expression: string;
  /** The exact integer result, unformatted. */
  readonly resultRaw: string;
  /** The same result rendered at its scale. Display only; never fed back into arithmetic. */
  readonly resultDisplay: string;
  readonly scale: number;
  /** Evidence this step consumed: a block, a feed round, a manifest entry. */
  readonly evidence: readonly string[];
  /**
   * A step that is shown to be wrong. Included so an integrator can see the error they are
   * about to make, and marked so nothing can select it as a result.
   */
  readonly rejected?: { readonly reason: string; readonly explanation: string };
}

export interface QuantityDerivation {
  readonly assetKey: string;
  readonly steps: readonly DerivationStep[];
  readonly rawAmount: string;
  readonly shareEquivalent: string;
  readonly remainderWad: string;
  readonly multiplierWad: string;
  readonly tokenDecimals: number;
}

export interface DerivationEvidence {
  readonly assetKey: string;
  /** `chainId:blockNumber@blockHash` — enough to re-read the same state. */
  readonly blockRef: string;
  readonly manifestRef: string;
}

/**
 * The quantity half: raw units to share-equivalents.
 *
 * The remainder is a step of its own rather than a footnote. A holder short by one unit is
 * owed an explanation, and burying the discarded dust inside the conversion is how a support
 * ticket becomes unanswerable.
 */
export function deriveQuantity(
  raw: RawAmount,
  multiplier: MultiplierWad,
  decimals: TokenDecimals,
  evidence: DerivationEvidence,
): QuantityDerivation | { readonly error: string } {
  const conversion = rawToShares(raw, multiplier);
  if (!conversion.ok) return { error: `${conversion.reason}: ${conversion.detail}` };
  const { shares, remainderWad } = conversion.value;

  const steps: DerivationStep[] = [
    {
      label: 'Raw token amount',
      expression: 'balanceOf(account)',
      resultRaw: raw.toString(),
      resultDisplay: formatScaledInteger(raw, decimals),
      scale: decimals,
      evidence: [evidence.blockRef],
    },
    {
      label: 'Active multiplier',
      expression: 'multiplier()',
      resultRaw: multiplier.toString(),
      resultDisplay: formatScaledInteger(multiplier, 18),
      scale: 18,
      evidence: [evidence.blockRef],
    },
    {
      label: 'Share equivalent',
      expression: `floor(${raw.toString()} * ${multiplier.toString()} / ${WAD_PRECISION.toString()})`,
      resultRaw: shares.toString(),
      resultDisplay: formatScaledInteger(shares, decimals),
      scale: decimals,
      evidence: [evidence.blockRef, evidence.manifestRef],
    },
    {
      label: 'Remainder discarded by floor',
      expression: `(${raw.toString()} * ${multiplier.toString()}) mod ${WAD_PRECISION.toString()}`,
      resultRaw: remainderWad.toString(),
      resultDisplay: formatScaledInteger(remainderWad, 18),
      scale: 18,
      evidence: [evidence.blockRef],
    },
  ];

  return {
    assetKey: evidence.assetKey,
    steps,
    rawAmount: raw.toString(),
    shareEquivalent: shares.toString(),
    remainderWad: remainderWad.toString(),
    multiplierWad: multiplier.toString(),
    tokenDecimals: decimals,
  };
}

export interface ValuationDerivation {
  readonly assetKey: string;
  readonly steps: readonly DerivationStep[];
  readonly routeA?: Valuation;
  readonly routeB?: Valuation;
  readonly routesAgree?: boolean;
  readonly toleranceRaw?: string;
  readonly differenceRaw?: string;
  /** True only when every price feeding a route was actionable for the requested class. */
  readonly actionable: boolean;
}

/**
 * The valuation half, both routes side by side, plus the rejected one.
 *
 * Route B's underlying price is derived from route A's total-return price on Base today, so
 * this is a consistency check, not corroboration — and the derivation says so in the step's
 * own text rather than in a caveat somewhere else.
 */
export function deriveValuation(
  raw: RawAmount,
  multiplier: MultiplierWad,
  decimals: TokenDecimals,
  totalReturn: TotalReturnPricePoint,
  underlying: UnderlyingPricePoint | undefined,
  evidence: DerivationEvidence,
): ValuationDerivation {
  const steps: DerivationStep[] = [];
  const feedRef = `feed:${totalReturn.feedAddress}@round:${totalReturn.roundId.toString()}`;

  const a = valueRawWithTotalReturnPrice(raw, decimals, totalReturn);
  if (a.ok) {
    steps.push({
      label: 'Route A — raw amount × total-return token price',
      expression: `${raw.toString()} * ${totalReturn.value.toString()}`,
      resultRaw: a.value.value.toString(),
      resultDisplay: formatScaledInteger(a.value.value, a.value.valueDecimals),
      scale: a.value.valueDecimals,
      evidence: [evidence.blockRef, feedRef],
    });
  }

  const conversion = rawToShares(raw, multiplier);
  const shares = conversion.ok ? conversion.value.shares : undefined;

  let b: ReturnType<typeof valueSharesWithUnderlyingPrice> | undefined;
  if (shares !== undefined && underlying !== undefined) {
    b = valueSharesWithUnderlyingPrice(shares, decimals, underlying);
    if (b.ok) {
      steps.push({
        label:
          underlying.origin === 'DERIVED_FROM_TOTAL_RETURN'
            ? 'Route B — share equivalent × underlying price (derived from route A, not an independent source)'
            : 'Route B — share equivalent × underlying equity price',
        expression: `${shares.toString()} * ${underlying.value.toString()}`,
        resultRaw: b.value.value.toString(),
        resultDisplay: formatScaledInteger(b.value.value, b.value.valueDecimals),
        scale: b.value.valueDecimals,
        evidence: [evidence.blockRef, `feed:${underlying.feedAddress}`],
      });
    }
  }

  // The teaching step. Computed deliberately so the size of the error is visible, and marked
  // rejected so no consumer can treat it as a result.
  if (shares !== undefined) {
    const wrong = shares * totalReturn.value;
    steps.push({
      label: 'Rejected — share equivalent × total-return token price',
      expression: `${shares.toString()} * ${totalReturn.value.toString()}`,
      resultRaw: wrong.toString(),
      resultDisplay: formatScaledInteger(
        wrong,
        (decimals as number) + (totalReturn.decimals as number),
      ),
      scale: (decimals as number) + (totalReturn.decimals as number),
      evidence: [],
      rejected: {
        reason: 'DOUBLE_MULTIPLIER_APPLIED',
        explanation:
          'The total-return price already contains the multiplier, so this applies it twice. ' +
          'After a 10:1 split it reports ten times the real value, and it does not revert. ' +
          'Shown here to make the error visible; it is never a selectable result.',
      },
    });
  }

  const comparison = a.ok && b?.ok === true ? compareValuationRoutes(a.value, b.value) : undefined;
  if (comparison !== undefined) {
    steps.push({
      label: 'Route agreement',
      expression: `|A - B| = ${comparison.differenceAtCommonScale.toString()} <= ${comparison.toleranceAtCommonScale.toString()}`,
      resultRaw: comparison.agree ? 'AGREE' : 'CONFLICT',
      resultDisplay: comparison.agree
        ? 'the routes reconcile within the floor-loss bound'
        : 'the routes disagree beyond what floor loss can explain',
      scale: comparison.commonScale,
      evidence: [evidence.blockRef, feedRef],
    });
  }

  return {
    assetKey: evidence.assetKey,
    steps,
    ...(a.ok ? { routeA: a.value } : {}),
    ...(b?.ok === true ? { routeB: b.value } : {}),
    ...(comparison !== undefined
      ? {
          routesAgree: comparison.agree,
          toleranceRaw: comparison.toleranceAtCommonScale.toString(),
          differenceRaw: comparison.differenceAtCommonScale.toString(),
        }
      : {}),
    // A single non-actionable price makes the whole valuation non-actionable. Reporting the
    // optimistic half would let a caller act on the actionable route and ignore the other.
    actionable:
      (a.ok ? a.value.actionable : false) && (b === undefined || (b.ok && b.value.actionable)),
  };
}

/**
 * The derivation as canonical JSON.
 *
 * `bigint` is stringified rather than serialized as a number, because `JSON.stringify` throws
 * on a bigint and `Number()` would silently drop digits. Keys are emitted in insertion order,
 * which is the order the math was done — an export a reviewer can read top to bottom.
 */
export function derivationToJson(value: QuantityDerivation | ValuationDerivation): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
