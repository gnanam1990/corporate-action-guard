/**
 * Capability probing and the ABI transcription.
 *
 * The selector-revert probe is the single most consequential mechanism in this package: it
 * decides whether the product says "no corporate action is scheduled" or "this chain cannot
 * be asked". These tests pin both the mechanism and the transcription it depends on.
 */
import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  B20_EVENT_ABI,
  BERYL_SELECTORS,
  COBALT_SELECTORS,
  classifyProbe,
  extractRevertData,
  summarizeCapabilities,
  type CapabilityProbe,
  type ObservationContext,
} from '../src/index.js';

const selector = (signature: string) => keccak256(toHex(signature)).slice(0, 10);

const CONTEXT: ObservationContext = {
  chainId: 8453,
  blockNumber: 50_993_686n,
  blockHash: `0x${'ab'.repeat(32)}`,
  blockTimestampSeconds: 1_788_776_091n,
  rpcEndpointId: 'mainnet.base.org',
  observedAt: '2026-09-07T10:00:00.000Z',
};

describe('selector transcription', () => {
  it('matches keccak of the signature, so a slip fails the build', () => {
    // Hard-coded rather than derived from the ABI on purpose: a probe that depended on the
    // snapshot could not detect that the snapshot had gone stale.
    expect(COBALT_SELECTORS.uiMultiplier).toBe(selector('uiMultiplier()'));
    expect(COBALT_SELECTORS.newUIMultiplier).toBe(selector('newUIMultiplier()'));
    expect(COBALT_SELECTORS.effectiveAt).toBe(selector('effectiveAt()'));
    expect(COBALT_SELECTORS.toUIAmount).toBe(selector('toUIAmount(uint256)'));
    expect(COBALT_SELECTORS.balanceOfUI).toBe(selector('balanceOfUI(address)'));
    expect(COBALT_SELECTORS.totalSupplyUI).toBe(selector('totalSupplyUI()'));
    expect(COBALT_SELECTORS.supportsInterface).toBe(selector('supportsInterface(bytes4)'));
    expect(BERYL_SELECTORS.multiplier).toBe(selector('multiplier()'));
    expect(BERYL_SELECTORS.toScaledBalance).toBe(selector('toScaledBalance(uint256)'));
    expect(BERYL_SELECTORS.scaledBalanceOf).toBe(selector('scaledBalanceOf(address)'));
    expect(BERYL_SELECTORS.isPaused).toBe(selector('isPaused(uint8)'));
  });

  it('declares each event with the indexed-ness the interface uses', () => {
    // Indexed-ness decides which values arrive in topics and which in data. Getting it wrong
    // silently shifts every decoded field rather than failing.
    const byName = new Map(B20_EVENT_ABI.map((e) => [e.name, e]));
    expect(byName.get('Transfer')?.inputs.map((i) => i.indexed)).toEqual([true, true, false]);
    expect(byName.get('UIMultiplierUpdated')?.inputs.map((i) => i.indexed)).toEqual([
      false,
      false,
      false,
    ]);
    expect(byName.get('Announcement')?.inputs.map((i) => i.indexed)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(byName.get('PolicyUpdated')?.inputs.map((i) => i.indexed)).toEqual([true, false, false]);
  });

  it('carries both the legacy and the canonical multiplier event', () => {
    // An instant update emits both. Indexing only the canonical one would miss every legacy
    // emission; indexing only the legacy one would miss every scheduled update.
    const names = B20_EVENT_ABI.map((e) => e.name);
    expect(names).toContain('MultiplierUpdated');
    expect(names).toContain('UIMultiplierUpdated');
    expect(names).toContain('UIMultiplierUpdateCancelled');
  });
});

describe('probe classification', () => {
  it('reads a selector-shaped revert as not dialed', () => {
    // Verified on Base mainnet: uiMultiplier() reverts with exactly 0xa60bf13d.
    const error = { message: 'execution reverted, data: "0xa60bf13d"' };
    expect(classifyProbe(COBALT_SELECTORS.uiMultiplier, error)).toBe('NOT_DIALED');
  });

  it('reads a different revert payload as a real answer about state', () => {
    const error = { message: 'execution reverted, data: "0xdeadbeef"' };
    expect(classifyProbe(COBALT_SELECTORS.uiMultiplier, error)).toBe('REVERTED');
  });

  it('never turns a transport failure into a capability answer', () => {
    // The conflation this package exists to avoid: an outage reported as "the chain does not
    // support this" is an outage recorded as a permanent fact.
    expect(classifyProbe(COBALT_SELECTORS.uiMultiplier, new Error('socket hang up'))).toBe(
      'UNAVAILABLE',
    );
  });

  it('finds revert data through a nested cause chain', () => {
    const error = { message: 'wrapped', cause: { cause: { data: '0xA60BF13D' } } };
    expect(extractRevertData(error)).toBe('0xa60bf13d');
  });

  it('does not loop forever on a self-referential error', () => {
    const error: Record<string, unknown> = { message: 'x' };
    error['cause'] = error;
    expect(extractRevertData(error)).toBeUndefined();
  });
});

describe('capability summary', () => {
  const probe = (
    name: string,
    surface: CapabilityProbe['surface'],
    outcome: CapabilityProbe['outcome'],
  ): CapabilityProbe => ({ name, selector: '0x00000000', surface, outcome });

  it('reports the live Base mainnet position', () => {
    const summary = summarizeCapabilities(
      [
        probe('multiplier', 'BERYL', 'LIVE'),
        probe('toScaledBalance', 'BERYL', 'LIVE'),
        probe('isPaused', 'BERYL', 'LIVE'),
        probe('uiMultiplier', 'COBALT_ERC8056', 'NOT_DIALED'),
        probe('newUIMultiplier', 'COBALT_ERC8056', 'NOT_DIALED'),
        probe('effectiveAt', 'COBALT_ERC8056', 'NOT_DIALED'),
      ],
      CONTEXT,
    );
    expect(summary.berylLive).toBe(true);
    expect(summary.scheduledUpdatesLive).toBe(false);
  });

  it('refuses to call a half-available scheduling surface live', () => {
    // A pending multiplier with no effectiveAt cannot be evaluated, and an effectiveAt with
    // no multiplier cannot either. Partial is unusable, not partially usable.
    const summary = summarizeCapabilities(
      [
        probe('newUIMultiplier', 'COBALT_ERC8056', 'LIVE'),
        probe('effectiveAt', 'COBALT_ERC8056', 'NOT_DIALED'),
      ],
      CONTEXT,
    );
    expect(summary.scheduledUpdatesLive).toBe(false);
  });

  it('does not treat an unreachable probe as a live capability', () => {
    const summary = summarizeCapabilities(
      [
        probe('newUIMultiplier', 'COBALT_ERC8056', 'UNAVAILABLE'),
        probe('effectiveAt', 'COBALT_ERC8056', 'UNAVAILABLE'),
      ],
      CONTEXT,
    );
    expect(summary.scheduledUpdatesLive).toBe(false);
  });

  it('reports the scheduling surface live only when both halves answer', () => {
    const summary = summarizeCapabilities(
      [
        probe('newUIMultiplier', 'COBALT_ERC8056', 'LIVE'),
        probe('effectiveAt', 'COBALT_ERC8056', 'LIVE'),
      ],
      CONTEXT,
    );
    expect(summary.scheduledUpdatesLive).toBe(true);
  });
});
