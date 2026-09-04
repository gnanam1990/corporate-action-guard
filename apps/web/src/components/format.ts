/**
 * Pure display helpers.
 *
 * No React, no `'use client'`, so these are callable from server components. Keeping them
 * out of the client bundle is not just tidiness: a helper marked `'use client'` cannot be
 * invoked during server rendering at all, which fails at request time rather than at build
 * time.
 */

/** Truncate an address or hash while keeping enough of both ends to be recognisable. */
export function truncateAddress(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export const EXPLORER: Readonly<Record<number, string>> = {
  196: 'https://www.oklink.com/x-layer',
  1952: 'https://www.oklink.com/x-layer-test',
};

export function explorerBase(chainId: number): string | undefined {
  return EXPLORER[chainId];
}
