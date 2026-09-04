import type { ReactNode } from 'react';

/**
 * Presentational primitives.
 *
 * Server components by default: none of these has interactivity, so shipping them to the
 * browser would be pure cost. Interactive controls live in their own `'use client'`
 * modules (see copy-button.tsx), and pure helpers in format.ts, so a server component can
 * call them.
 */

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
