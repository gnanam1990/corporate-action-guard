/**
 * B20 quantities and prices.
 *
 * A tokenized stock exposes three numbers that all read as "how much stock is this", and two
 * of the three are routinely confused:
 *
 *   rawAmount              balanceOf() / the transfer unit. A corporate action never moves it.
 *   shareEquivalent        floor(rawAmount * multiplier / 1e18). What a holder thinks they own.
 *   totalReturnTokenPrice  underlyingEquityPrice * multiplier. What Chainlink publishes.
 *
 * Treating raw as shares is wrong by exactly the multiplier, forever, from the first
 * corporate action. Multiplying shares by the Chainlink price applies the multiplier twice —
 * a 10:1 split turns a $200 position into $2,000 and the number looks plausible. Neither
 * error reverts, and both reconcile against themselves.
 *
 * So they are separate types, not separate variable names. A `RawAmount` cannot be passed
 * where a `ShareEquivalentAmount` is expected, and a price is never a bare integer: it
 * carries the *basis* it was measured in. That is what makes the forbidden product fail to
 * compile rather than fail in a customer's ledger. See ADR 0006.
 *
 * Every value here is an integer with an explicit scale. No `number`, no float, no implicit
 * rescale.
 */

import type { ParseResult } from '../brands.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const err = <T>(error: string): ParseResult<T> => ({ ok: false, error });

/*
 * Bounds, taken from the verified base-std interfaces rather than chosen.
 * See provenance/base-b20/base-std/src/lib/B20Constants.sol and IB20Asset.sol.
 */

/** `WAD_PRECISION` — the fixed-point scale of every B20 multiplier. Read live as 1e18. */
export const WAD_PRECISION = 1_000_000_000_000_000_000n;

/** `MAX_UI_MULTIPLIER` — `type(uint128).max`, the setters' overflow guard. */
export const MAX_UI_MULTIPLIER = 2n ** 128n - 1n;

/** `MAX_SUPPLY_CAP` — also `type(uint128).max`, so `balance * multiplier` stays in uint256. */
export const MAX_RAW_AMOUNT = 2n ** 128n - 1n;

/** `MIN_ASSET_DECIMALS` / `MAX_ASSET_DECIMALS` from `B20Constants`. */
export const MIN_TOKEN_DECIMALS = 6;
export const MAX_TOKEN_DECIMALS = 18;

/** A price feed with more than this many decimals is a misread, not a precise feed. */
export const MAX_PRICE_DECIMALS = 36;

/*
 * Quantities.
 */

/** Raw token units, at the token's own `decimals()`. What `balanceOf` returns and transfers move. */
export type RawAmount = Brand<bigint, 'RawAmount'>;

/** Share-equivalent units, at the token's own `decimals()`. Derived, never transferred. */
export type ShareEquivalentAmount = Brand<bigint, 'ShareEquivalentAmount'>;

/** A multiplier scaled by `WAD_PRECISION`. `1e18` means 1.0. */
export type MultiplierWad = Brand<bigint, 'MultiplierWad'>;

/** A token's `decimals()`, constrained to the range the B20 factory accepts. */
export type TokenDecimals = Brand<number, 'TokenDecimals'>;

/** A price feed's `decimals()`. */
export type PriceDecimals = Brand<number, 'PriceDecimals'>;

/** A Chainlink `roundId`. `uint80`, and phase-encoded, so it is not a small counter. */
export type FeedRoundId = Brand<bigint, 'FeedRoundId'>;

/** Schema version of a persisted evidence payload. */
export type EvidenceVersion = Brand<number, 'EvidenceVersion'>;

export function rawAmount(value: bigint): ParseResult<RawAmount> {
  if (value < 0n) return err('raw amount must not be negative');
  // Supply is capped at uint128 on chain, so a larger raw amount cannot have been read from
  // a B20 token. Accepting it would let `raw * multiplier` leave uint256 downstream.
  if (value > MAX_RAW_AMOUNT) return err('raw amount exceeds the on-chain supply cap (uint128)');
  return ok(value as RawAmount);
}

export function shareEquivalentAmount(value: bigint): ParseResult<ShareEquivalentAmount> {
  if (value < 0n) return err('share-equivalent amount must not be negative');
  return ok(value as ShareEquivalentAmount);
}

export function multiplierWad(value: bigint): ParseResult<MultiplierWad> {
  // Zero is rejected by the on-chain setters (`InvalidMultiplier`), and a zero multiplier
  // would silently zero every holder's share equivalent.
  if (value <= 0n) return err('multiplier must be greater than zero');
  if (value > MAX_UI_MULTIPLIER) return err('multiplier exceeds MAX_UI_MULTIPLIER (uint128 max)');
  return ok(value as MultiplierWad);
}

export function tokenDecimals(value: number): ParseResult<TokenDecimals> {
  if (!Number.isInteger(value) || value < MIN_TOKEN_DECIMALS || value > MAX_TOKEN_DECIMALS) {
    return err(`token decimals must be an integer in ${MIN_TOKEN_DECIMALS}..${MAX_TOKEN_DECIMALS}`);
  }
  return ok(value as TokenDecimals);
}

export function priceDecimals(value: number): ParseResult<PriceDecimals> {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PRICE_DECIMALS) {
    return err(`price decimals must be an integer in 0..${MAX_PRICE_DECIMALS}`);
  }
  return ok(value as PriceDecimals);
}

export function feedRoundId(value: bigint): ParseResult<FeedRoundId> {
  if (value <= 0n) return err('feed round id must be positive');
  if (value > 2n ** 80n - 1n) return err('feed round id exceeds uint80');
  return ok(value as FeedRoundId);
}

export function evidenceVersion(value: number): ParseResult<EvidenceVersion> {
  if (!Number.isInteger(value) || value < 1)
    return err('evidence version must be a positive integer');
  return ok(value as EvidenceVersion);
}

/*
 * Prices.
 *
 * The basis is part of the type, not a comment on the field. A caller cannot pass "a price";
 * it has to say which price, and the valuation engine's overloads only accept the two legal
 * pairings.
 */

/**
 * The price of one whole token, already multiplied by the active multiplier.
 *
 * This is what every Chainlink Coinbase equity feed on Base publishes — see
 * `provenance/base-b20/feed-manifest.json`, where every entry carries
 * `priceBasis: TOTAL_RETURN_TOKEN_PRICE`. Multiplying a share-equivalent quantity by it
 * applies the multiplier a second time.
 */
export type TotalReturnTokenPrice = Brand<bigint, 'TotalReturnTokenPrice'>;

/**
 * The price of one whole underlying share, with no multiplier applied.
 *
 * No Chainlink feed on Base publishes this today. Where it is computed as
 * `totalReturnTokenPrice / multiplier` it is a *derivation from one source*, not a second
 * observation, and it is labelled `DERIVED_FROM_TOTAL_RETURN` so it is never presented as
 * corroborating the route it came from.
 */
export type UnderlyingEquityPrice = Brand<bigint, 'UnderlyingEquityPrice'>;

export const PRICE_BASES = ['TOTAL_RETURN_TOKEN_PRICE', 'UNDERLYING_EQUITY_PRICE'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

export const PRICE_ORIGINS = [
  /** Read directly from a verified feed at a recorded round. */
  'FEED_OBSERVED',
  /** Computed from the total-return price and the active multiplier. Not independent. */
  'DERIVED_FROM_TOTAL_RETURN',
] as const;
export type PriceOrigin = (typeof PRICE_ORIGINS)[number];

/**
 * A price that is safe to hand to the valuation engine.
 *
 * Every field is mandatory on purpose. A price without its basis invites the double
 * multiplier; without decimals it cannot be scaled; without a feed and round it cannot be
 * traced; without a freshness verdict a stale number authorizes a liquidation.
 */
export interface PricePoint<B extends PriceBasis> {
  readonly basis: B;
  readonly value: B extends 'TOTAL_RETURN_TOKEN_PRICE'
    ? TotalReturnTokenPrice
    : UnderlyingEquityPrice;
  readonly decimals: PriceDecimals;
  readonly origin: PriceOrigin;
  /** Chainlink proxy address, lowercase. Identity of the source, not a label. */
  readonly feedAddress: string;
  readonly roundId: FeedRoundId;
  /** Feed `updatedAt`, seconds since epoch. */
  readonly updatedAtSeconds: bigint;
  /** The freshness verdict for the action class this price was fetched for. */
  readonly freshness: PriceFreshness;
}

export type TotalReturnPricePoint = PricePoint<'TOTAL_RETURN_TOKEN_PRICE'>;
export type UnderlyingPricePoint = PricePoint<'UNDERLYING_EQUITY_PRICE'>;

/**
 * Freshness outcomes.
 *
 * `EXPECTED_HOLD` exists because an equity feed legitimately stops publishing outside market
 * hours: at the recorded provenance block the Coinbase AAPL feed's `updatedAt` was ~62 hours
 * old against an 86400 s heartbeat, which is a weekend, not an outage. A hold and a genuine
 * stall produce the *same* `updatedAt`, so only an explicit session policy can tell them
 * apart — and neither may be silently called `FRESH`.
 */
export const PRICE_FRESHNESS = [
  'FRESH',
  'EXPECTED_HOLD',
  'STALE',
  'ISSUER_PAUSED',
  'SEQUENCER_UNAVAILABLE',
  'INVALID_ROUND',
] as const;
export type PriceFreshness = (typeof PRICE_FRESHNESS)[number];

/**
 * Which freshness verdicts may back a money-moving decision.
 *
 * `EXPECTED_HOLD` is deliberately excluded. A weekend price is correct for display and wrong
 * for a liquidation, and the difference between those two uses is exactly where a product
 * like this earns its keep.
 */
export function isActionableFreshness(freshness: PriceFreshness): boolean {
  return freshness === 'FRESH';
}

export function totalReturnTokenPrice(value: bigint): ParseResult<TotalReturnTokenPrice> {
  if (value <= 0n) return err('total-return token price must be positive');
  return ok(value as TotalReturnTokenPrice);
}

export function underlyingEquityPrice(value: bigint): ParseResult<UnderlyingEquityPrice> {
  if (value <= 0n) return err('underlying equity price must be positive');
  return ok(value as UnderlyingEquityPrice);
}

/**
 * Unsafe constructors for tests and for values already validated at a trusted boundary.
 * Mirrors the `unsafe` export in `brands.ts` so both live in one recognisable place.
 */
export const unsafeB20 = {
  rawAmount: (v: bigint) => v as RawAmount,
  shares: (v: bigint) => v as ShareEquivalentAmount,
  multiplierWad: (v: bigint) => v as MultiplierWad,
  tokenDecimals: (v: number) => v as TokenDecimals,
  priceDecimals: (v: number) => v as PriceDecimals,
  feedRoundId: (v: bigint) => v as FeedRoundId,
  evidenceVersion: (v: number) => v as EvidenceVersion,
  totalReturnPrice: (v: bigint) => v as TotalReturnTokenPrice,
  underlyingPrice: (v: bigint) => v as UnderlyingEquityPrice,
} as const;
