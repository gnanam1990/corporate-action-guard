import { describe, expect, it } from 'vitest';
import { canonicalize, payloadHash } from '../src/canonical-json.js';

describe('canonical JSON', () => {
  it('is stable across object key order at the top level', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('is stable across key order at every depth', () => {
    const x = { outer: { z: 1, a: { m: 2, b: 3 } }, list: [{ q: 1, p: 2 }] };
    const y = { list: [{ p: 2, q: 1 }], outer: { a: { b: 3, m: 2 }, z: 1 } };
    expect(payloadHash(x)).toBe(payloadHash(y));
  });

  it('preserves array order, because order is part of the value', () => {
    expect(payloadHash([1, 2, 3])).not.toBe(payloadHash([3, 2, 1]));
  });

  it('treats an omitted key and an undefined key as the same fact', () => {
    expect(payloadHash({ a: 1, b: undefined })).toBe(payloadHash({ a: 1 }));
  });

  it('distinguishes null from an omitted key', () => {
    expect(payloadHash({ a: 1, b: null })).not.toBe(payloadHash({ a: 1 }));
  });

  it('encodes bigint exactly, without passing through a double', () => {
    const big = 2n ** 90n;
    expect(canonicalize({ n: big })).toBe(`{"n":"${big.toString()}"}`);
    expect(payloadHash({ n: big })).not.toBe(payloadHash({ n: big + 1n }));
  });

  it('distinguishes a numeric string from a number', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: '1' }));
  });

  it('rejects values with no stable encoding', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });

  it('produces a 64-character lowercase hex digest', () => {
    expect(payloadHash({ any: 'value' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
