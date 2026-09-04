'use client';

import { useCallback, useId, useState } from 'react';

/**
 * The only genuinely interactive primitive, and therefore the only one that needs to reach
 * the browser.
 */
export interface CopyButtonProps {
  readonly value: string;
  readonly label: string;
}

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
          // Revert, so the control does not permanently read "Copied".
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
      {/* Announced politely rather than by moving focus. */}
      <span id={statusId} role="status" aria-live="polite" className="visually-hidden">
        {copied ? `${label} copied` : ''}
      </span>
    </>
  );
}
