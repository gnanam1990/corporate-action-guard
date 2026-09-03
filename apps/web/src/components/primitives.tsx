'use client';

import { useCallback, useId, useState, type ReactNode } from 'react';

/**
 * Shared primitives.
 *
 * Every interactive element here is keyboard-operable, has an accessible name, and meets
 * the 44px touch target minimum. Those are requirements of the product, not polish: an
 * operator responding to an incident may well be on a phone.
 */

export interface AddressLinkProps {
  readonly address: string;
  readonly chainId: number;
  readonly label?: string;
}

const EXPLORER: Readonly<Record<number, string>> = {
  196: 'https://www.oklink.com/x-layer',
  1952: 'https://www.oklink.com/x-layer-test',
};

/** Truncate for display while keeping enough of both ends to be recognisable. */
export function truncateAddress(address: string): string {
  return address.length <= 14 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function AddressLink({ address, chainId, label }: AddressLinkProps) {
  const base = EXPLORER[chainId];
  const text = label ?? truncateAddress(address);

  if (base === undefined) {
    // No explorer for this chain: show the value rather than a dead link.
    return <span className="mono">{text}</span>;
  }

  return (
    <a
      className="address-link mono"
      href={`${base}/address/${address}`}
      target="_blank"
      rel="noreferrer noopener"
      // The visible text is truncated, so the accessible name carries the full value.
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
  const base = EXPLORER[chainId];
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

export interface CopyButtonProps {
  readonly value: string;
  readonly label: string;
}

/**
 * Copy to clipboard.
 *
 * Announces the result in a polite live region rather than moving focus, and reverts after
 * a moment so the control does not permanently read "Copied".
 */
export function CopyButton({ value, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const statusId = useId();

  const copy = useCallback(
    (event: React.MouseEvent) => {
      // A copy control inside a clickable row must not also navigate.
      event.stopPropagation();
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2_000);
        })
        .catch(() => setCopied(false));
    },
    [value],
  );

  return (
    <>
      <button type="button" className="icon-button" onClick={copy} aria-label={`Copy ${label}`}>
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
        </svg>
      </button>
      <span id={statusId} role="status" aria-live="polite" className="visually-hidden">
        {copied ? `${label} copied` : ''}
      </span>
    </>
  );
}

export interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'neutral' | 'verified' | 'pending' | 'blocked';
  readonly detail?: string;
}

export function MetricCard({ label, value, tone = 'neutral', detail }: MetricCardProps) {
  return (
    <div className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__value">{value}</div>
      {detail !== undefined && <div className="metric-card__detail">{detail}</div>}
    </div>
  );
}

export interface StateProps {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}

/** Empty is not an error. It says so plainly rather than looking broken. */
export function EmptyState({ title, description, action }: StateProps) {
  return (
    <div className="state-panel state-panel--empty">
      <h3 className="state-panel__title">{title}</h3>
      <p className="state-panel__description">{description}</p>
      {action}
    </div>
  );
}

/**
 * An error state names the cause and the recovery step.
 *
 * `role="alert"` because a failure to load evidence is exactly the thing a screen-reader
 * user must not silently miss.
 */
export function ErrorState({ title, description, action }: StateProps) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <h3 className="state-panel__title">{title}</h3>
      <p className="state-panel__description">{description}</p>
      {action}
    </div>
  );
}

export interface SkeletonProps {
  readonly rows?: number;
  readonly label: string;
}

/**
 * Loading placeholder.
 *
 * Reserves layout space so content does not jump when it arrives, and announces itself
 * once rather than on every row.
 */
export function Skeleton({ rows = 3, label }: SkeletonProps) {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton__row" />
      ))}
    </div>
  );
}

export interface InlineAlertProps {
  readonly tone: 'info' | 'warning' | 'danger';
  readonly title: string;
  readonly children?: ReactNode;
}

export function InlineAlert({ tone, title, children }: InlineAlertProps) {
  return (
    <div
      className={`inline-alert inline-alert--${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <strong className="inline-alert__title">{title}</strong>
      {children !== undefined && <div className="inline-alert__body">{children}</div>}
    </div>
  );
}
