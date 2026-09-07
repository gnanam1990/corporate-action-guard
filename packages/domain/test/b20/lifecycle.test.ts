/**
 * B20 lifecycle reduction.
 *
 * The three documented traps get a test each: the event that arrives before it takes
 * effect, the activation that emits nothing, and the one update that emits two events.
 * Plus the one the live chain forced on us — a scheduled surface that is not dialed at all,
 * where "no pending update" would be a false negative rather than an answer.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  reduceB20Lifecycle,
  unsafe,
  unsafeB20,
  WAD_PRECISION,
  type B20CapabilitySet,
  type B20LifecycleFact,
} from '../../src/index.js';

const ONE = WAD_PRECISION;
const mult = unsafeB20.multiplierWad;

const BLOCK_TIME = 2n;
const GENESIS_TS = 1_788_000_000n;

let nextEventId = 0;

/** A fact at a block, with a total order the reducer can rely on. */
function fact(
  kind: B20LifecycleFact['kind'],
  blockOffset: number,
  fields: Partial<B20LifecycleFact> = {},
): B20LifecycleFact {
  nextEventId += 1;
  return {
    kind,
    provenance: {
      blockNumber: unsafe.blockNumber(BigInt(1000 + blockOffset)),
      blockHash: unsafe.blockHash(`0x${String(blockOffset).padStart(64, '0')}`),
      blockTimestampSeconds: GENESIS_TS + BigInt(blockOffset) * BLOCK_TIME,
      transactionIndex: 0,
      logIndex: 0,
      eventId: `event-${nextEventId}`,
    },
    ...fields,
  };
}

const tsAt = (blockOffset: number) => GENESIS_TS + BigInt(blockOffset) * BLOCK_TIME;

/** Base mainnet today: Beryl live, the scheduled surface not dialed. */
const MAINNET_CAPABILITIES: B20CapabilitySet = {
  currentMultiplier: 'LIVE',
  scheduledUpdate: 'NOT_DIALED',
  announcements: 'LIVE',
  pause: 'LIVE',
  observedAtBlock: unsafe.blockNumber(50_993_686n),
};

/** A chain where Cobalt has activated. Used for every scheduling scenario. */
const COBALT_CAPABILITIES: B20CapabilitySet = {
  ...MAINNET_CAPABILITIES,
  scheduledUpdate: 'LIVE',
};

describe('the scheduled-surface capability gate', () => {
  it('does not report "no pending update" when the chain cannot be asked', () => {
    // This is the live Base mainnet position, measured at block 50993686. newUIMultiplier()
    // and effectiveAt() revert with their own selectors, so the product genuinely does not
    // know whether an action is scheduled. Answering "none" would be the single most
    // dangerous false negative this product could produce.
    const result = reduceB20Lifecycle({
      facts: [fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) })],
      evaluateAtSeconds: tsAt(10),
      capabilities: MAINNET_CAPABILITIES,
    });
    expect(result.state).toBe('LEGACY_ACTIVE');
    expect(result.reasons).toContain('B20_UNSUPPORTED_CAPABILITY');
    expect(result.pendingMultiplierWad).toBeUndefined();
  });

  it('drops the caveat once the surface is live', () => {
    const result = reduceB20Lifecycle({
      facts: [fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) })],
      evaluateAtSeconds: tsAt(10),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.reasons).not.toContain('B20_UNSUPPORTED_CAPABILITY');
  });

  it('never turns an unreachable RPC into a lifecycle conclusion', () => {
    const result = reduceB20Lifecycle({
      facts: [fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) })],
      evaluateAtSeconds: tsAt(10),
      capabilities: { ...MAINNET_CAPABILITIES, currentMultiplier: 'UNAVAILABLE' },
    });
    expect(result.state).toBe('UNSUPPORTED_CAPABILITY');
    expect(result.reasons).toContain('B20_RPC_UNAVAILABLE');
    expect(result.activeMultiplierWad).toBeUndefined();
  });
});

describe('a scheduled update activates on time, not on arrival', () => {
  const schedule = () => [
    fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
    fact('UI_MULTIPLIER_UPDATED', 1, {
      oldMultiplierWad: mult(ONE),
      newMultiplierWad: mult(ONE * 10n),
      effectiveAtSeconds: tsAt(100),
    }),
  ];

  it('is pending the second before effectiveAt', () => {
    const result = reduceB20Lifecycle({
      facts: schedule(),
      evaluateAtSeconds: tsAt(100) - 1n,
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.state).toBe('SCHEDULED_PENDING');
    expect(result.activeMultiplierWad).toBe(ONE);
    expect(result.pendingMultiplierWad).toBe(ONE * 10n);
    expect(result.reasons).toContain('B20_SCHEDULE_NOT_YET_EFFECTIVE');
  });

  it('activates exactly at effectiveAt, with no event marking the moment', () => {
    // Lazy activation: nothing is emitted at effectiveAt. A reducer that waits for an event
    // waits forever, and every downstream balance stays wrong.
    const result = reduceB20Lifecycle({
      facts: schedule(),
      evaluateAtSeconds: tsAt(100),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.state).toBe('SCHEDULED_ACTIVE_LAZY');
    expect(result.activeMultiplierWad).toBe(ONE * 10n);
    expect(result.pendingMultiplierWad).toBeUndefined();
  });

  it('is not active at the block the event arrived in', () => {
    const result = reduceB20Lifecycle({
      facts: schedule(),
      evaluateAtSeconds: tsAt(1),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.activeMultiplierWad).toBe(ONE);
  });
});

describe('cancellation and override supersede', () => {
  it('a cancel one block before activation stops it activating, ever', () => {
    const result = reduceB20Lifecycle({
      facts: [
        fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
        fact('UI_MULTIPLIER_UPDATED', 1, {
          oldMultiplierWad: mult(ONE),
          newMultiplierWad: mult(ONE * 10n),
          effectiveAtSeconds: tsAt(100),
        }),
        fact('UI_MULTIPLIER_UPDATE_CANCELLED', 99, {
          cancelledMultiplierWad: mult(ONE * 10n),
          cancelledEffectiveAtSeconds: tsAt(100),
        }),
      ],
      // Long after the schedule would have fired.
      evaluateAtSeconds: tsAt(500),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.state).toBe('CANCELLED');
    expect(result.activeMultiplierWad).toBe(ONE);
    expect(result.reasons).toContain('B20_SCHEDULE_CANCELLED');
  });

  it('an instant override clears a live pending schedule', () => {
    // IB20Asset: updateMultiplier applies immediately and cancels any live pending update.
    const result = reduceB20Lifecycle({
      facts: [
        fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
        fact('UI_MULTIPLIER_UPDATED', 1, {
          oldMultiplierWad: mult(ONE),
          newMultiplierWad: mult(ONE * 10n),
          effectiveAtSeconds: tsAt(100),
        }),
        fact('UI_MULTIPLIER_UPDATED', 50, {
          oldMultiplierWad: mult(ONE),
          newMultiplierWad: mult(ONE * 2n),
          effectiveAtSeconds: tsAt(50),
        }),
      ],
      evaluateAtSeconds: tsAt(200),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.state).toBe('INSTANT_OVERRIDE');
    expect(result.activeMultiplierWad).toBe(ONE * 2n);
    expect(result.pendingMultiplierWad).toBeUndefined();
    expect(result.reasons).toContain('B20_SCHEDULE_SUPERSEDED');
  });
});

describe('duplicate emission is folded once, by identity, never by value', () => {
  it('folds the legacy and canonical events of one instant update', () => {
    const legacy = fact('LEGACY_MULTIPLIER_UPDATED', 5, { newMultiplierWad: mult(ONE * 3n) });
    const canonical: B20LifecycleFact = {
      kind: 'UI_MULTIPLIER_UPDATED',
      provenance: { ...legacy.provenance, logIndex: 1, eventId: 'event-canonical' },
      oldMultiplierWad: mult(ONE),
      newMultiplierWad: mult(ONE * 3n),
      effectiveAtSeconds: tsAt(5),
    };
    const result = reduceB20Lifecycle({
      facts: [fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }), legacy, canonical],
      evaluateAtSeconds: tsAt(10),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.reasons).toContain('B20_DUPLICATE_EVENT_GENERATION');
    // One business fact, so one new epoch on top of the seed snapshot.
    expect(result.epochs.filter((e) => e.multiplierWad === ONE * 3n)).toHaveLength(1);
    expect(result.activeMultiplierWad).toBe(ONE * 3n);
  });

  it('does not fold a legacy and canonical event that carry different values', () => {
    // `announce` dispatches several internal calls in one transaction, so one transaction can
    // legitimately contain more than one multiplier change. Folding a legacy event into
    // whatever canonical event shares its transaction — rather than into the one carrying the
    // same value — would silently drop a real corporate action.
    const legacy = fact('LEGACY_MULTIPLIER_UPDATED', 5, { newMultiplierWad: mult(ONE * 3n) });
    const differentCanonical: B20LifecycleFact = {
      kind: 'UI_MULTIPLIER_UPDATED',
      provenance: { ...legacy.provenance, logIndex: 1, eventId: 'event-other-value' },
      oldMultiplierWad: mult(ONE * 3n),
      newMultiplierWad: mult(ONE * 8n),
      effectiveAtSeconds: tsAt(5),
    };
    const result = reduceB20Lifecycle({
      facts: [
        fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
        legacy,
        differentCanonical,
      ],
      evaluateAtSeconds: tsAt(10),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.reasons).not.toContain('B20_DUPLICATE_EVENT_GENERATION');
    expect(result.epochs.map((e) => e.multiplierWad)).toEqual([ONE, ONE * 3n, ONE * 8n]);
    expect(result.activeMultiplierWad).toBe(ONE * 8n);
  });

  it('keeps two genuine updates that happen to set the same value', () => {
    // Merging by value would erase a real second corporate action. Identity is
    // (blockHash, txIndex); these differ in both.
    const result = reduceB20Lifecycle({
      facts: [
        fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
        fact('UI_MULTIPLIER_UPDATED', 5, {
          oldMultiplierWad: mult(ONE),
          newMultiplierWad: mult(ONE * 2n),
          effectiveAtSeconds: tsAt(5),
        }),
        fact('UI_MULTIPLIER_UPDATED', 9, {
          oldMultiplierWad: mult(ONE * 2n),
          newMultiplierWad: mult(ONE * 2n),
          effectiveAtSeconds: tsAt(9),
        }),
      ],
      evaluateAtSeconds: tsAt(20),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.epochs.filter((e) => e.multiplierWad === ONE * 2n)).toHaveLength(2);
    expect(result.reasons).not.toContain('B20_DUPLICATE_EVENT_GENERATION');
  });
});

describe('continuity and history', () => {
  it('reports a broken epoch chain instead of guessing past the hole', () => {
    const result = reduceB20Lifecycle({
      facts: [
        fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
        fact('UI_MULTIPLIER_UPDATED', 5, {
          // Claims to supersede 5.0, but we believe the current value is 1.0.
          oldMultiplierWad: mult(ONE * 5n),
          newMultiplierWad: mult(ONE * 7n),
          effectiveAtSeconds: tsAt(5),
        }),
      ],
      evaluateAtSeconds: tsAt(10),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.reasons).toContain('B20_MULTIPLIER_CONTINUITY_BROKEN');
  });

  it('a historical query never sees a later fact', () => {
    // Asking about block n must give the same answer forever, whether asked at n or n + 10^6.
    const facts = [
      fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
      fact('UI_MULTIPLIER_UPDATED', 50, {
        oldMultiplierWad: mult(ONE),
        newMultiplierWad: mult(ONE * 4n),
        effectiveAtSeconds: tsAt(50),
      }),
    ];
    const before = reduceB20Lifecycle({
      facts,
      evaluateAtSeconds: tsAt(20),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(before.activeMultiplierWad).toBe(ONE);
    const after = reduceB20Lifecycle({
      facts,
      evaluateAtSeconds: tsAt(60),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(after.activeMultiplierWad).toBe(ONE * 4n);
  });

  it('links every conclusion back to the events that produced it', () => {
    const facts = [
      fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
      fact('UI_MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: mult(ONE),
        newMultiplierWad: mult(ONE * 2n),
        effectiveAtSeconds: tsAt(5),
      }),
    ];
    const result = reduceB20Lifecycle({
      facts,
      evaluateAtSeconds: tsAt(10),
      capabilities: COBALT_CAPABILITIES,
    });
    expect(result.evidenceEventIds).toEqual(facts.map((f) => f.provenance.eventId));
    expect(result.epochs.at(-1)?.sourceEventIds.length).toBeGreaterThan(0);
  });
});

describe('input order does not change the answer', () => {
  it('is independent of how the caller paginated its facts', () => {
    const facts = [
      fact('STATE_SNAPSHOT', 0, { newMultiplierWad: mult(ONE) }),
      fact('UI_MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: mult(ONE),
        newMultiplierWad: mult(ONE * 2n),
        effectiveAtSeconds: tsAt(5),
      }),
      fact('UI_MULTIPLIER_UPDATED', 9, {
        oldMultiplierWad: mult(ONE * 2n),
        newMultiplierWad: mult(ONE * 6n),
        effectiveAtSeconds: tsAt(400),
      }),
    ];
    fc.assert(
      fc.property(fc.shuffledSubarray(facts, { minLength: facts.length }), (shuffled) => {
        const result = reduceB20Lifecycle({
          facts: shuffled,
          evaluateAtSeconds: tsAt(20),
          capabilities: COBALT_CAPABILITIES,
        });
        return (
          result.activeMultiplierWad === ONE * 2n &&
          result.pendingMultiplierWad === ONE * 6n &&
          result.state === 'SCHEDULED_PENDING'
        );
      }),
    );
  });
});
