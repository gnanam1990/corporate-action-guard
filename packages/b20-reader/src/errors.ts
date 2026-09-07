/**
 * Reader failure kinds.
 *
 * These are deliberately distinguished rather than collapsed into "the read failed", because
 * downstream they mean opposite things. `NOT_DIALED` says the chain cannot answer the
 * question and the honest result is `UNSUPPORTED_CAPABILITY`. `RPC_UNAVAILABLE` says *we*
 * could not reach the chain and the honest result is that nothing is known. Treating the
 * second as the first would turn an outage into a confident negative answer.
 */
export type B20ReaderErrorKind =
  /** The RPC did not answer: timeout, transport failure, rate limit. Says nothing about chain state. */
  | 'RPC_UNAVAILABLE'
  /** `eth_chainId` did not match the configured chain. Aborts the session before any read. */
  | 'WRONG_CHAIN'
  /** The selector reverted with exactly its own four bytes: this hardfork has not dialed it. */
  | 'NOT_DIALED'
  /** The call reverted for some other reason. That is a real answer about state. */
  | 'CONTRACT_REVERT'
  /** The provider rejected the block range. The indexer shrinks and retries. */
  | 'LOG_RANGE_TOO_WIDE'
  /** The provider no longer has the requested historical block. */
  | 'PRUNED_HISTORY'
  /** A parent-hash mismatch inside the configured lookback. */
  | 'REORG_DETECTED'
  /** A reorg deeper than the lookback. History cannot be reconstructed automatically. */
  | 'REORG_BEYOND_LOOKBACK'
  /** The response did not match the shape the ABI declares. */
  | 'MALFORMED_RESPONSE'
  /** A batch returned some results and failed others. A partial batch is not a result. */
  | 'PARTIAL_BATCH';

export class B20ReaderError extends Error {
  override readonly name = 'B20ReaderError';
  constructor(
    readonly kind: B20ReaderErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * Raised before any read when the endpoint is not the chain we were configured for.
 *
 * Evidence labelled with a chain it did not come from is worse than no evidence: it passes
 * every downstream chain check while being about something else entirely.
 */
export class WrongChainError extends B20ReaderError {
  constructor(expected: number, observed: number) {
    super(
      'WRONG_CHAIN',
      `RPC reports chain ${String(observed)}, expected ${String(expected)}; aborting before any read`,
      { expected, observed },
    );
  }
}

/**
 * Raised when a capability the caller needs is not dialed on this chain.
 *
 * A hard, typed stop rather than a fallback. A value decoded from a selector the chain does
 * not implement looks authoritative and means nothing.
 */
export class NotDialedError extends B20ReaderError {
  constructor(selector: string, name: string) {
    super('NOT_DIALED', `${name} (${selector}) is not dialed on this chain`, { selector, name });
  }
}
