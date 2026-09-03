import type { ReactNode } from 'react';

/**
 * Status primitives.
 *
 * The governing rule: **never colour alone**. Every status carries a colour, a distinct
 * glyph shape, and a text label. Roughly one man in twelve has a colour vision deficiency,
 * a screenshot pasted into an incident report can lose colour meaning entirely, and a
 * printed page has no colour at all. A status that is only a green dot is not a status.
 */

export type StatusTone = 'verified' | 'pending' | 'blocked' | 'chain' | 'unknown';

/**
 * Distinct SHAPES, not just distinct colours. Each is visually separable in greyscale:
 * a check, a clock hand, a cross, a horizontal bar, a question mark.
 */
const GLYPH: Record<StatusTone, ReactNode> = {
  verified: <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />,
  pending: <path d="M8 4.5 V8.5 L11 10.5 M8 1.5 A6.5 6.5 0 1 1 8 14.5 A6.5 6.5 0 1 1 8 1.5" />,
  blocked: <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" />,
  chain: <path d="M3 8 H13 M8 3 V13" />,
  unknown: <path d="M6 6 A2 2 0 1 1 8 9.5 V10.5 M8 13 V13.01" />,
};

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  /** The visible text. Required — a badge is never icon-only. */
  readonly label: string;
  /** Explicitly allows undefined: exactOptionalPropertyTypes is on across the workspace. */
  readonly title?: string | undefined;
}

export function StatusBadge({ tone, label, title }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`} title={title}>
      <svg
        className="status-badge__glyph"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        // Decorative: the adjacent text already carries the meaning.
        aria-hidden="true"
        focusable="false"
      >
        {GLYPH[tone]}
      </svg>
      <span className="status-badge__label">{label}</span>
    </span>
  );
}

/** Map a canonicality outcome to a tone. UNKNOWN gets its own — it is not a soft FAIL. */
export function outcomeTone(outcome: 'PASS' | 'FAIL' | 'UNKNOWN'): StatusTone {
  return outcome === 'PASS' ? 'verified' : outcome === 'FAIL' ? 'blocked' : 'unknown';
}

export interface EvidenceAgeProps {
  /** Milliseconds since the observation, or undefined when the source was unreachable. */
  readonly ageMs: number | undefined;
  /** Age at or beyond which evidence may no longer authorize an action. */
  readonly staleAfterMs: number;
  /** Absolute UTC instant, shown as the authoritative detail. */
  readonly observedAtIso: string | undefined;
}

/**
 * Evidence freshness.
 *
 * Shows relative age as the scannable primary and the absolute UTC instant as the
 * authoritative secondary. Relative age alone is ambiguous in an incident report written
 * hours later; absolute alone is unreadable at a glance in a dense table.
 */
export function EvidenceAge({ ageMs, staleAfterMs, observedAtIso }: EvidenceAgeProps) {
  if (ageMs === undefined || observedAtIso === undefined) {
    return (
      <StatusBadge
        tone="unknown"
        label="No observation"
        title="This source could not be reached."
      />
    );
  }

  const stale = ageMs >= staleAfterMs;
  return (
    <span className="evidence-age">
      <StatusBadge
        tone={stale ? 'blocked' : 'verified'}
        label={stale ? `STALE · ${formatAge(ageMs)}` : formatAge(ageMs)}
        {...(stale ? { title: 'Older than the freshness limit; cannot authorize an action.' } : {})}
      />
      <time className="evidence-age__absolute" dateTime={observedAtIso}>
        {observedAtIso}
      </time>
    </span>
  );
}

export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface ReasonCodeProps {
  readonly code: string;
  readonly explanation?: string | undefined;
}

/** A machine-readable reason code, shown verbatim so it can be searched and quoted. */
export function ReasonCode({ code, explanation }: ReasonCodeProps) {
  return (
    <span className="reason-code" title={explanation}>
      {code}
    </span>
  );
}
