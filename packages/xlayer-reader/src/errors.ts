export type XLayerErrorKind =
  | 'RPC_UNAVAILABLE'
  | 'WRONG_CHAIN'
  | 'NO_BYTECODE'
  | 'LOG_RANGE_TOO_WIDE'
  | 'REORG_DETECTED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PARTIAL_MULTICALL'
  | 'PROVIDER_DIVERGENCE';

export class XLayerError extends Error {
  override readonly name = 'XLayerError';
  constructor(
    readonly kind: XLayerErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * Raised when a feature depends on an ABI element that was never verified.
 *
 * Deliberately a hard, typed stop rather than a silent fallback: a decoded value from an
 * invented signature looks authoritative and means nothing.
 */
export class UnsupportedCapabilityError extends XLayerError {
  constructor(capability: string, reason: string) {
    super('UNSUPPORTED_CAPABILITY', `${capability} is not supported: ${reason}`, {
      capability,
      reason,
    });
  }
}
