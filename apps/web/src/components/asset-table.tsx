import Link from 'next/link';
import { formatMultiplier, lifecycleTone, type Asset } from '@/lib/api';
import { CopyButton } from './copy-button';
import { truncateAddress } from './format';
import { AddressLink } from './links';
import { EvidenceAge, outcomeTone, StatusBadge } from './status';

/**
 * The asset table.
 *
 * A real `<table>` with a real `<caption>` and `scope`d headers, because this is tabular
 * data and a screen-reader user needs row and column association. A grid of divs would
 * look identical and convey nothing.
 *
 * At phone width the same data becomes cards through CSS alone — no second markup tree, so
 * the two presentations cannot drift apart.
 */

export interface AssetTableProps {
  readonly assets: readonly Asset[];
  readonly apiStaleAfterMs: number;
  readonly chainStaleAfterMs: number;
  /** Column currently sorted, reflected in aria-sort. */
  readonly sortColumn?: string;
  readonly sortDirection?: 'ascending' | 'descending';
}

export function AssetTable({
  assets,
  apiStaleAfterMs,
  chainStaleAfterMs,
  sortColumn,
  sortDirection,
}: AssetTableProps) {
  const ariaSort = (column: string) =>
    sortColumn === column ? (sortDirection ?? 'ascending') : ('none' as const);

  return (
    // Labelled scroll region: a keyboard user must be able to reach and scroll it, and a
    // screen-reader user must be told it scrolls.
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Protected assets, scrollable"
    >
      <table className="data-table">
        <caption className="visually-hidden">
          Discovered assets with lifecycle state, canonicality, multiplier epoch, and evidence
          freshness for each source.
        </caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort('symbol')}>
              Asset
            </th>
            <th scope="col">Token / current wrapper</th>
            <th scope="col" aria-sort={ariaSort('canonicality')}>
              Canonicality
            </th>
            <th scope="col" aria-sort={ariaSort('lifecycleState')}>
              Lifecycle
            </th>
            <th scope="col">Multiplier / nonce</th>
            <th scope="col">API evidence</th>
            <th scope="col">Chain evidence</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.assetId}>
              <th scope="row" data-label="Asset">
                {/*
                  A link, not a row click handler: it is keyboard reachable, middle-clickable,
                  and its target is visible in the status bar before activation.
                */}
                <Link className="asset-link" href={{ pathname: `/assets/${asset.assetId}` }}>
                  {asset.symbol}
                </Link>
                <span className="asset-id mono">{asset.assetId}</span>
              </th>

              <td data-label="Token / current wrapper">
                <div className="address-cell">
                  <span className="address-cell__row">
                    <span className="address-cell__tag">token</span>
                    <AddressLink address={asset.tokenAddress} chainId={asset.chainId} />
                    <CopyButton
                      value={asset.tokenAddress}
                      label={`${asset.symbol} token address`}
                    />
                  </span>
                  <span className="address-cell__row">
                    <span className="address-cell__tag">wrapper</span>
                    {asset.wrapperAddress === null ? (
                      <StatusBadge tone="unknown" label="NOT DECLARED" />
                    ) : (
                      <>
                        <AddressLink address={asset.wrapperAddress} chainId={asset.chainId} />
                        <CopyButton
                          value={asset.wrapperAddress}
                          label={`${asset.symbol} wrapper address`}
                        />
                        {asset.wrapperIsCurrent === false && (
                          <StatusBadge tone="blocked" label="SUPERSEDED" />
                        )}
                      </>
                    )}
                  </span>
                </div>
              </td>

              <td data-label="Canonicality">
                <StatusBadge tone={outcomeTone(asset.canonicality)} label={asset.canonicality} />
              </td>

              <td data-label="Lifecycle">
                <StatusBadge
                  tone={lifecycleTone(asset.lifecycleState)}
                  label={asset.lifecycleState.replace(/_/g, ' ')}
                />
                {asset.scheduledActivation !== null && (
                  <div className="cell-detail mono">activates {asset.scheduledActivation}</div>
                )}
              </td>

              <td data-label="Multiplier / nonce">
                <span className="mono">{formatMultiplier(asset.multiplier)}</span>
                <div className="cell-detail mono">nonce {asset.multiplierNonce ?? '—'}</div>
              </td>

              <td data-label="API evidence">
                <EvidenceAge
                  ageMs={ageOf(asset.apiObservedAt)}
                  staleAfterMs={apiStaleAfterMs}
                  observedAtIso={asset.apiObservedAt ?? undefined}
                />
              </td>

              <td data-label="Chain evidence">
                <EvidenceAge
                  ageMs={ageOf(asset.chainObservedAt)}
                  staleAfterMs={chainStaleAfterMs}
                  observedAtIso={asset.chainObservedAt ?? undefined}
                />
                {asset.chainBlockNumber !== null && (
                  <div className="cell-detail mono" title={asset.chainBlockHash ?? undefined}>
                    block {asset.chainBlockNumber}
                    {asset.chainBlockHash !== null && ` · ${truncateAddress(asset.chainBlockHash)}`}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ageOf(iso: string | null): number | undefined {
  if (iso === null) return undefined;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, Date.now() - parsed);
}
