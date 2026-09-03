/**
 * Branded identifiers.
 *
 * These exist so a token address cannot be passed where a wrapper address is expected,
 * and so a value can only acquire a brand by passing its validator. Every constructor
 * returns a discriminated result rather than throwing, because these run at ingress where
 * the input is untrusted.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ChainId = Brand<number, 'ChainId'>;
export type Address = Brand<string, 'Address'>;
export type TxHash = Brand<string, 'TxHash'>;
export type BlockHash = Brand<string, 'BlockHash'>;
export type BlockNumber = Brand<bigint, 'BlockNumber'>;
export type AssetId = Brand<string, 'AssetId'>;
export type TickerSymbol = Brand<string, 'TickerSymbol'>;
export type WrapperVersion = Brand<number, 'WrapperVersion'>;

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const err = <T>(error: string): ParseResult<T> => ({ ok: false, error });

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Normalize an address to lowercase.
 *
 * EIP-55 checksums encode capitalization, not identity: `0xAbC…` and `0xabc…` are the same
 * account. Comparing raw strings would manufacture a mismatch out of a casing difference,
 * and a false SOURCE_MISMATCH blocks real money. Lowercase is therefore the single
 * canonical form used for all storage and comparison.
 */
export function normalizeAddress(input: string): ParseResult<Address> {
  const trimmed = input.trim();
  if (!ADDRESS_RE.test(trimmed)) {
    return err(`not a 20-byte 0x address: ${JSON.stringify(input.slice(0, 64))}`);
  }
  return ok(trimmed.toLowerCase() as Address);
}

/** Checksum-insensitive equality. Both sides are normalized first. */
export function addressEquals(a: string, b: string): boolean {
  const pa = normalizeAddress(a);
  const pb = normalizeAddress(b);
  if (!pa.ok || !pb.ok) return false;
  return pa.value === pb.value;
}

/** The zero address is never a valid token, wrapper, recipient, or target. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export function isZeroAddress(a: Address): boolean {
  return a === ZERO_ADDRESS;
}

export function parseChainId(input: number): ParseResult<ChainId> {
  if (!Number.isInteger(input) || input <= 0 || input > Number.MAX_SAFE_INTEGER) {
    return err(`chain id must be a positive integer, received ${String(input)}`);
  }
  return ok(input as ChainId);
}

export function parseTxHash(input: string): ParseResult<TxHash> {
  const trimmed = input.trim();
  if (!HASH32_RE.test(trimmed)) return err('not a 32-byte 0x transaction hash');
  return ok(trimmed.toLowerCase() as TxHash);
}

export function parseBlockHash(input: string): ParseResult<BlockHash> {
  const trimmed = input.trim();
  if (!HASH32_RE.test(trimmed)) return err('not a 32-byte 0x block hash');
  return ok(trimmed.toLowerCase() as BlockHash);
}

export function parseBlockNumber(input: bigint): ParseResult<BlockNumber> {
  if (input < 0n) return err('block number must not be negative');
  return ok(input as BlockNumber);
}

export function parseAssetId(input: string): ParseResult<AssetId> {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return err('asset id must be 1 to 128 characters');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return err('asset id may contain only letters, digits, and . _ : -');
  }
  return ok(trimmed as AssetId);
}

export function parseTickerSymbol(input: string): ParseResult<TickerSymbol> {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return err('symbol must be 1 to 32 characters');
  return ok(trimmed as TickerSymbol);
}

export function parseWrapperVersion(input: number): ParseResult<WrapperVersion> {
  if (!Number.isInteger(input) || input < 0)
    return err('wrapper version must be a non-negative integer');
  return ok(input as WrapperVersion);
}

/** Unsafe constructors for tests and for values already validated at a trusted boundary. */
export const unsafe = {
  address: (v: string) => v.toLowerCase() as Address,
  chainId: (v: number) => v as ChainId,
  txHash: (v: string) => v.toLowerCase() as TxHash,
  blockHash: (v: string) => v.toLowerCase() as BlockHash,
  blockNumber: (v: bigint) => v as BlockNumber,
  assetId: (v: string) => v as AssetId,
  symbol: (v: string) => v as TickerSymbol,
  wrapperVersion: (v: number) => v as WrapperVersion,
} as const;
