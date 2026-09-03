import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addressEquals,
  ageAt,
  compareSources,
  EXACT_TOLERANCE,
  instant,
  isStale,
  millis,
  multiplier,
  multiplierEquals,
  multiplierToString,
  multiplierWithinTolerance,
  normalizeAddress,
  parseIsoInstant,
  parseMultiplier,
  toIso,
  unsafe,
  type ApiObservation,
  type ChainObservation,
} from '../src/index.js';

describe('ISO instants are timezone-independent', () => {
  it('parses UTC and equivalent offsets to the same instant', () => {
    const utc = parseIsoInstant('2026-09-17T12:00:00.000Z');
    const plus = parseIsoInstant('2026-09-17T17:30:00.000+05:30');
    const minus = parseIsoInstant('2026-09-17T07:00:00.000-05:00');
    expect(utc.ok && plus.ok && minus.ok).toBe(true);
    if (utc.ok && plus.ok && minus.ok) {
      expect(plus.value).toBe(utc.value);
      expect(minus.value).toBe(utc.value);
    }
  });

  it('rejects a timestamp with no zone designator rather than assuming UTC', () => {
    const r = parseIsoInstant('2026-09-17T12:00:00');
    expect(r.ok).toBe(false);
  });

  it('rejects out-of-range civil dates', () => {
    expect(parseIsoInstant('2026-02-30T00:00:00Z').ok).toBe(false);
    expect(parseIsoInstant('2026-13-01T00:00:00Z').ok).toBe(false);
    expect(parseIsoInstant('2026-01-01T24:00:00Z').ok).toBe(false);
  });

  it('handles leap days correctly', () => {
    expect(parseIsoInstant('2028-02-29T00:00:00Z').ok).toBe(true);
    expect(parseIsoInstant('2027-02-29T00:00:00Z').ok).toBe(false);
    // 2000 is a leap year; 1900 is not.
    expect(parseIsoInstant('2000-02-29T00:00:00Z').ok).toBe(true);
    expect(parseIsoInstant('1900-02-29T00:00:00Z').ok).toBe(false);
  });

  it('round-trips parse and format', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        const iso = toIso(instant(ms));
        const back = parseIsoInstant(iso);
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.value).toBe(ms);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with the platform Date implementation across the range', () => {
    // Cross-check the hand-written civil-date maths against a known-good implementation.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        expect(toIso(instant(ms))).toBe(new globalThis.Date(ms).toISOString());
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

describe('freshness', () => {
  const now = instant(1_000_000);

  it('a future-dated observation has age zero, not a negative age', () => {
    expect(ageAt(instant(now + 5_000), now)).toBe(0);
  });

  it('is stale exactly at the limit', () => {
    expect(isStale(instant(now - 60_000), now, millis(60_000))).toBe(true);
    expect(isStale(instant(now - 59_999), now, millis(60_000))).toBe(false);
  });
});

describe('multiplier arithmetic has no floating-point loss', () => {
  it('represents a value that IEEE-754 cannot', () => {
    const a = parseMultiplier('0.1');
    const b = parseMultiplier('0.2');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // 0.1 + 0.2 !== 0.3 in floating point. In scaled integers the digits are exact.
    expect(a.value.value + b.value.value).toBe(3n);
    expect(multiplierToString({ value: 3n, decimals: 1 })).toBe('0.3');
  });

  it('compares across differing scales', () => {
    const a = multiplier(150n, 2); // 1.50
    const b = multiplier(15n, 1); // 1.5
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(multiplierEquals(a.value, b.value)).toBe(true);
  });

  it('distinguishes values that differ only in the last digit', () => {
    const a = multiplier(1_000_000_000_000_000_001n, 18);
    const b = multiplier(1_000_000_000_000_000_000n, 18);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(multiplierEquals(a.value, b.value)).toBe(false);
      // The same two values collapse to equal as doubles.
      expect(Number(a.value.value) === Number(b.value.value)).toBe(true);
    }
  });

  it('exact tolerance means exact equality', () => {
    const a = multiplier(100n, 2);
    const b = multiplier(101n, 2);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(multiplierWithinTolerance(a.value, b.value, EXACT_TOLERANCE)).toBe(false);
      expect(multiplierWithinTolerance(a.value, a.value, EXACT_TOLERANCE)).toBe(true);
    }
  });

  it('round-trips decimal strings without a float in the path', () => {
    fc.assert(
      fc.property(
        // No leading zeros: '00.0' is not a canonical decimal and normalizes to '0.0'.
        fc.stringMatching(/^(?:0|[1-9]\d{0,11})\.\d{1,18}$/),
        (s) => {
          const parsed = parseMultiplier(s);
          if (!parsed.ok) return true;
          expect(multiplierToString(parsed.value)).toBe(s);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects a negative or malformed multiplier', () => {
    expect(parseMultiplier('-1.0').ok).toBe(false);
    expect(parseMultiplier('1.2.3').ok).toBe(false);
    expect(parseMultiplier('').ok).toBe(false);
    expect(parseMultiplier('1e5').ok).toBe(false);
  });
});

describe('address normalization', () => {
  it('is checksum-insensitive', () => {
    expect(
      addressEquals(
        '0x9D275685Dc284c8Eb1c79F6ABa7A63dc75Ec890A',
        '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
      ),
    ).toBe(true);
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(normalizeAddress('0x123').ok).toBe(false);
    expect(normalizeAddress('9d275685dc284c8eb1c79f6aba7a63dc75ec890a').ok).toBe(false);
    expect(normalizeAddress('').ok).toBe(false);
    expect(addressEquals('not-an-address', 'not-an-address')).toBe(false);
  });
});

describe('compareSources', () => {
  const api = (over: Partial<ApiObservation> = {}): ApiObservation => ({
    provenance: {
      sourceKind: 'XSTOCKS_API',
      sourceLocator: '/v1/assets',
      observedAt: instant(1_000),
    },
    symbol: unsafe.symbol('AAPLx'),
    tokenAddress: unsafe.address('0x' + 'a'.repeat(40)),
    wrapperAddress: unsafe.address('0x' + 'b'.repeat(40)),
    multiplier: { value: 100n, decimals: 2 },
    multiplierNonce: 7n,
    scheduledActivation: instant(50_000),
    ...over,
  });

  const chain = (over: Partial<ChainObservation> = {}): ChainObservation => ({
    provenance: {
      sourceKind: 'XLAYER_RPC',
      sourceLocator: 'provider-a',
      observedAt: instant(1_000),
    },
    chainId: unsafe.chainId(196),
    blockNumber: unsafe.blockNumber(100n),
    blockHash: unsafe.blockHash('0x' + '1'.repeat(64)),
    tokenAddress: unsafe.address('0x' + 'a'.repeat(40)),
    wrapperAddress: unsafe.address('0x' + 'b'.repeat(40)),
    tokenHasBytecode: true,
    wrapperHasBytecode: true,
    multiplier: { value: 1000n, decimals: 3 },
    multiplierNonce: 7n,
    scheduledActivation: instant(50_000),
    ...over,
  });

  const policy = { multiplierTolerance: EXACT_TOLERANCE, activationToleranceMs: 0 };

  it('reports MATCH when every shared field agrees', () => {
    expect(compareSources(api(), chain(), policy).agreement).toBe('MATCH');
  });

  it('reports MISMATCH on a disagreeing nonce', () => {
    const result = compareSources(api(), chain({ multiplierNonce: 8n }), policy);
    expect(result.agreement).toBe('MISMATCH');
    expect(result.fields.find((f) => f.field === 'multiplierNonce')?.agreement).toBe('MISMATCH');
  });

  it('reports INCOMPLETE — never MATCH — when a source cannot supply a field', () => {
    const { multiplierNonce: _drop, ...partial } = api();
    const result = compareSources(partial as ApiObservation, chain(), policy);
    expect(result.agreement).toBe('INCOMPLETE');
  });

  it('MISMATCH dominates INCOMPLETE', () => {
    const { multiplier: _m, ...partial } = api({ multiplierNonce: 9n });
    const result = compareSources(partial as ApiObservation, chain(), policy);
    expect(result.agreement).toBe('MISMATCH');
  });

  it('checksum casing does not create a wrapper mismatch', () => {
    const result = compareSources(
      api({ wrapperAddress: ('0x' + 'B'.repeat(40)) as ReturnType<typeof unsafe.address> }),
      chain(),
      policy,
    );
    expect(result.fields.find((f) => f.field === 'wrapperAddress')?.agreement).toBe('MATCH');
  });
});
