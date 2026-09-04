import { explorerBase, truncateAddress } from './format';

/**
 * Explorer links.
 *
 * Server components: they have no interactivity, so shipping them to the browser would be
 * pure cost. The truncated text is what the eye reads; the accessible name carries the full
 * value, because a screen-reader user must not receive an ellipsis where an address should
 * be.
 */

export interface AddressLinkProps {
  readonly address: string;
  readonly chainId: number;
  readonly label?: string | undefined;
}

export function AddressLink({ address, chainId, label }: AddressLinkProps) {
  const base = explorerBase(chainId);
  const text = label ?? truncateAddress(address);

  // No explorer for this chain: show the value rather than a link that goes nowhere.
  if (base === undefined) return <span className="mono">{text}</span>;

  return (
    <a
      className="address-link mono"
      href={`${base}/address/${address}`}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${label ?? 'Address'} ${address}, opens in a new tab`}
    >
      {text}
    </a>
  );
}

export interface TxLinkProps {
  readonly txHash: string;
  readonly chainId: number;
}

export function TxLink({ txHash, chainId }: TxLinkProps) {
  const base = explorerBase(chainId);
  if (base === undefined) return <span className="mono">{truncateAddress(txHash)}</span>;
  return (
    <a
      className="address-link mono"
      href={`${base}/tx/${txHash}`}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Transaction ${txHash}, opens in a new tab`}
    >
      {truncateAddress(txHash)}
    </a>
  );
}
