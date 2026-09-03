import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Application shell.
 *
 * Carries the two things an operator must be able to see without clicking anything: which
 * environment they are looking at, and whether the evidence behind it is trustworthy right
 * now.
 *
 * The shell renders NO product data of its own. Source health and environment are passed
 * in from a server component that fetched them; nothing here has a default that would
 * render a healthy-looking console when the API is unreachable.
 */

export interface SourceHealth {
  readonly name: string;
  readonly healthy: boolean | undefined;
  readonly detail: string;
}

export interface AppShellProps {
  readonly children: ReactNode;
  /**
   * Undefined means "not yet known", which renders as unknown rather than healthy.
   * A console that looks fine when it cannot reach its API is the worst possible failure.
   */
  readonly sources?: readonly SourceHealth[];
  readonly environmentLabel: string;
  readonly currentPath?: string;
}

const NAV = [
  { href: '/', label: 'Coverage' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/preflight', label: 'Preflight Lab' },
] as const;

export function AppShell({
  children,
  sources,
  environmentLabel,
  currentPath = '/',
}: AppShellProps) {
  const degraded = sources?.filter((s) => s.healthy !== true) ?? [];
  const unknownHealth = sources === undefined;

  return (
    <div className="shell">
      {/* First focusable element on the page. */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="shell__header">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            <svg
              viewBox="0 0 20 20"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            >
              <path d="M10 2 L17 5 V10 C17 14 14 17 10 18.5 C6 17 3 14 3 10 V5 Z" />
              <path d="M7 10 L9 12 L13 8" />
            </svg>
          </span>
          <span className="shell__brand-text">Corporate Action Guard</span>
        </div>

        {/*
          The environment banner is never decorative. It states the read path and the write
          path separately, because they are different chains with different powers.
        */}
        <div className="shell__environment" title="Read and write paths are different chains.">
          {environmentLabel}
        </div>
      </header>

      <div className="shell__body">
        <nav className="shell__nav" aria-label="Primary">
          <ul className="shell__nav-list">
            {NAV.map((item) => {
              const active = currentPath === item.href;
              return (
                <li key={item.href}>
                  <Link
                    className={`shell__nav-link${active ? ' shell__nav-link--active' : ''}`}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main id="main" className="shell__main" tabIndex={-1}>
          {/*
            The degraded banner sits in the flow rather than fixed, so it can never cover a
            focused control — a sticky banner that hides the element you just tabbed to is
            an accessibility failure, not a nuisance.
          */}
          {unknownHealth && (
            <div className="shell__banner shell__banner--unknown" role="status">
              <strong>Source health unknown.</strong> The console could not determine whether its
              evidence sources are healthy. Treat everything below as unverified.
            </div>
          )}
          {!unknownHealth && degraded.length > 0 && (
            <div className="shell__banner shell__banner--degraded" role="alert">
              <strong>Degraded evidence.</strong> {degraded.map((s) => s.name).join(', ')}{' '}
              unavailable or unhealthy. Displayed state may be stale, and protected actions fail
              closed.
            </div>
          )}

          {children}
        </main>
      </div>

      <footer className="shell__footer">
        <p>
          Enforceable only for integrations routing through <code>ActionGuardAdapter</code>. A
          direct ERC-20 transfer bypasses the guard. X Layer mainnet is read-only.
        </p>
      </footer>
    </div>
  );
}
