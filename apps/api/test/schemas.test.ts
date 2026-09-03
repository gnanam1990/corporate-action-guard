import { describe, expect, it } from 'vitest';
import {
  addressSchema,
  amountSchema,
  assetFilterSchema,
  idempotencyKeySchema,
  preflightRequestSchema,
  reviewResolutionSchema,
} from '../src/schemas.js';

describe('input validation rejects rather than coerces', () => {
  it('rejects a malformed address', () => {
    for (const bad of ['0x123', 'not-an-address', '', '0x' + 'g'.repeat(40)]) {
      expect(addressSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts either address casing', () => {
    expect(addressSchema.safeParse('0x9D275685Dc284c8Eb1c79F6ABa7A63dc75Ec890A').success).toBe(
      true,
    );
    expect(addressSchema.safeParse('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a').success).toBe(
      true,
    );
  });

  it('accepts a uint256-scale amount as a string', () => {
    // A JSON number cannot hold a uint256; the contract uses decimal strings for a reason.
    const max = (2n ** 256n - 1n).toString();
    expect(amountSchema.safeParse(max).success).toBe(true);
  });

  it('rejects zero, negative, decimal, and scientific amounts', () => {
    for (const bad of ['0', '-1', '1.5', '1e18', '', 'abc']) {
      expect(amountSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('rejects a SQL-injection-shaped string in every free-text field', () => {
    const injection = "'; DROP TABLE evidence_events; --";
    expect(addressSchema.safeParse(injection).success).toBe(false);
    expect(amountSchema.safeParse(injection).success).toBe(false);
    expect(idempotencyKeySchema.safeParse(injection).success).toBe(false);
  });

  it('caps page size so a client cannot request the whole catalog', () => {
    expect(assetFilterSchema.safeParse({ limit: 1_000 }).success).toBe(false);
    expect(assetFilterSchema.parse({}).limit).toBe(25);
  });

  it('bounds the search term', () => {
    expect(assetFilterSchema.safeParse({ search: 'x'.repeat(1_000) }).success).toBe(false);
  });

  it('rejects an unknown lifecycle state', () => {
    expect(assetFilterSchema.safeParse({ lifecycleState: 'DEFINITELY_FINE' }).success).toBe(false);
  });

  it('validates a complete preflight request', () => {
    const parsed = preflightRequestSchema.safeParse({
      chainId: 1952,
      assetId: 'AAPLx',
      target: `0x${'11'.repeat(20)}`,
      asset: `0x${'22'.repeat(20)}`,
      wrapper: `0x${'33'.repeat(20)}`,
      actionType: 'DEPOSIT',
      caller: `0x${'44'.repeat(20)}`,
      recipient: `0x${'55'.repeat(20)}`,
      amount: '1000',
      expectedMultiplierNonce: '5',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown action type rather than defaulting', () => {
    expect(
      preflightRequestSchema.safeParse({
        chainId: 1952,
        assetId: 'A',
        target: `0x${'11'.repeat(20)}`,
        asset: `0x${'22'.repeat(20)}`,
        wrapper: `0x${'33'.repeat(20)}`,
        actionType: 'DRAIN',
        caller: `0x${'44'.repeat(20)}`,
        recipient: `0x${'55'.repeat(20)}`,
        amount: '1000',
        expectedMultiplierNonce: '5',
      }).success,
    ).toBe(false);
  });
});

describe('manual review requires a real reason', () => {
  it('rejects a one-click "mark safe"', () => {
    // There is deliberately no shortcut: a specific written reason is mandatory.
    expect(
      reviewResolutionSchema.safeParse({ reason: 'ok', evidenceIds: ['e'], actor: 'a' }).success,
    ).toBe(false);
  });

  it('rejects a resolution with no evidence reference', () => {
    expect(
      reviewResolutionSchema.safeParse({
        reason: 'x'.repeat(40),
        evidenceIds: [],
        actor: 'operator-1',
      }).success,
    ).toBe(false);
  });

  it('accepts a specific reason with evidence and an actor', () => {
    expect(
      reviewResolutionSchema.safeParse({
        reason: 'API and chain reconciled after the provider outage; verified at block 69686711.',
        evidenceIds: ['evt-1'],
        actor: 'operator-1',
      }).success,
    ).toBe(true);
  });
});
