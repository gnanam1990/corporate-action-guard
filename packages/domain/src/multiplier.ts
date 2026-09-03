/**
 * Multiplier arithmetic.
 *
 * A corporate-action multiplier is a ratio, and ratios like 1/3 have no exact IEEE-754
 * representation. Carrying one as a `number` loses value silently, and a lost unit here is
 * a wrong balance. Multipliers are therefore fixed-point: an integer `value` scaled by
 * `10 ** decimals`, compared exactly.
 */

import type { ParseResult } from './brands.js';

export interface Multiplier {
  /** Scaled integer numerator. `value = realValue * 10 ** decimals`. */
  readonly value: bigint;
  /** Scale exponent. */
  readonly decimals: number;
}

/** Monotonically increasing epoch counter. A change invalidates every outstanding receipt. */
export type MultiplierNonce = bigint;

export const MAX_MULTIPLIER_DECIMALS = 36;

export function multiplier(value: bigint, decimals: number): ParseResult<Multiplier> {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MULTIPLIER_DECIMALS) {
    return { ok: false, error: `decimals must be an integer in 0..${MAX_MULTIPLIER_DECIMALS}` };
  }
  if (value < 0n) return { ok: false, error: 'multiplier value must not be negative' };
  return { ok: true, value: { value, decimals } };
}

/** Rescale to a common exponent so two multipliers can be compared without loss. */
function align(a: Multiplier, b: Multiplier): { a: bigint; b: bigint } {
  const decimals = Math.max(a.decimals, b.decimals);
  const scale = (m: Multiplier) => m.value * 10n ** BigInt(decimals - m.decimals);
  return { a: scale(a), b: scale(b) };
}

/** Exact equality across differing scales: 1.50 (2dp) equals 1.5 (1dp). */
export function multiplierEquals(a: Multiplier, b: Multiplier): boolean {
  const aligned = align(a, b);
  return aligned.a === aligned.b;
}

/** Absolute difference, expressed at the finer of the two scales. */
export function multiplierAbsDiff(a: Multiplier, b: Multiplier): Multiplier {
  const aligned = align(a, b);
  const diff = aligned.a > aligned.b ? aligned.a - aligned.b : aligned.b - aligned.a;
  return { value: diff, decimals: Math.max(a.decimals, b.decimals) };
}

/**
 * Within tolerance, where tolerance is expressed at its own scale.
 * A zero tolerance means exact equality — the default for enforcement.
 */
export function multiplierWithinTolerance(
  a: Multiplier,
  b: Multiplier,
  tolerance: Multiplier,
): boolean {
  const diff = multiplierAbsDiff(a, b);
  const aligned = align(diff, tolerance);
  return aligned.a <= aligned.b;
}

export const EXACT_TOLERANCE: Multiplier = { value: 0n, decimals: 0 };

/** Human-readable decimal string. Display only — never a consensus encoding. */
export function multiplierToString(m: Multiplier): string {
  const negative = m.value < 0n;
  const digits = (negative ? -m.value : m.value).toString().padStart(m.decimals + 1, '0');
  const whole = digits.slice(0, digits.length - m.decimals) || '0';
  const frac = m.decimals > 0 ? `.${digits.slice(digits.length - m.decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}

/** Parse a decimal string without ever converting through a float. */
export function parseMultiplier(input: string): ParseResult<Multiplier> {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: 'multiplier must be a non-negative decimal string' };
  }
  const [wholeRaw, fracRaw = ''] = trimmed.split('.');
  const whole = wholeRaw ?? '0';
  if (fracRaw.length > MAX_MULTIPLIER_DECIMALS) {
    return { ok: false, error: `at most ${MAX_MULTIPLIER_DECIMALS} fractional digits` };
  }
  return { ok: true, value: { value: BigInt(whole + fracRaw), decimals: fracRaw.length } };
}
