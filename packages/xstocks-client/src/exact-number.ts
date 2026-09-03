/**
 * Exact extraction of a numeric literal from a raw JSON body.
 *
 * The multiplier endpoint returns the multiplier as a JSON **number**:
 *
 *   {"currentMultiplier":1.0032690125398187, ...}
 *
 * That is 17 significant digits — at the edge of what a double represents. Once
 * `JSON.parse` has run, the exact decimal the server sent is already gone, and
 * re-serializing gives whatever the nearest double prints as. For a value that decides
 * whether a balance is right, "close enough" is not a property we can claim.
 *
 * So the multiplier is read from the raw response text, as the literal digits the server
 * actually wrote, and carried as a fixed-point value. The parsed object is still used for
 * structure and for every other field.
 */

export interface ExactDecimal {
  /** Scaled integer: value / 10 ** decimals. */
  readonly value: bigint;
  readonly decimals: number;
  /** The literal characters the server sent, for evidence display. */
  readonly literal: string;
}

/**
 * Read a top-level numeric field's literal text out of a JSON body.
 *
 * Deliberately narrow: it matches `"key": <number-literal>` at any depth but does not
 * attempt to parse JSON. It returns `undefined` rather than guessing when the field is
 * absent, is not a number, or appears more than once with different values.
 */
export function extractNumericLiteral(body: string, key: string): string | undefined {
  const pattern = new RegExp(
    `"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
    'g',
  );
  const found = new Set<string>();
  for (const match of body.matchAll(pattern)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  if (found.size !== 1) return undefined;
  return [...found][0];
}

/** Convert a decimal literal to fixed point without ever passing through a double. */
export function toExactDecimal(literal: string): ExactDecimal | undefined {
  // Exponent form would need expansion; the API does not use it, and guessing is worse
  // than declining.
  if (/[eE]/.test(literal)) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(literal)) return undefined;

  const negative = literal.startsWith('-');
  const unsigned = negative ? literal.slice(1) : literal;
  const [whole = '0', frac = ''] = unsigned.split('.');
  const value = BigInt(whole + frac) * (negative ? -1n : 1n);
  return { value, decimals: frac.length, literal };
}

/** Extract a field as an exact fixed-point decimal, or `undefined` if it cannot be trusted. */
export function extractExactDecimal(body: string, key: string): ExactDecimal | undefined {
  const literal = extractNumericLiteral(body, key);
  return literal === undefined ? undefined : toExactDecimal(literal);
}
