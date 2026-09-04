import { AppShell } from '@/components/app-shell';
import { PreflightForm } from '@/components/preflight-form';
import { InlineAlert } from '@/components/primitives';
import { readDeployment } from '@/lib/deployment';

/**
 * Preflight Lab.
 *
 * A developer and operator tool for making the receipt binding visible, and the refusals
 * reproducible. Not a consumer trading UI: there is no balance, no price, and no
 * celebration on success.
 */

export const dynamic = 'force-dynamic';

const FAILURE_PROOFS = [
  {
    scenario: 'Change the recipient after the receipt is issued',
    expected: 'Rejected — the operation no longer reproduces the bound digest',
    where: 'Locally by the SDK, and on chain by the adapter',
  },
  {
    scenario: 'Change the amount after issuance',
    expected: 'Rejected — same reason',
    where: 'Locally and on chain',
  },
  {
    scenario: 'Wait for the receipt to expire',
    expected: 'ReceiptExpired — the upper bound is inclusive, so ties block',
    where: 'On chain',
  },
  {
    scenario: 'Replay a consumed receipt',
    expected: 'ReceiptAlreadyConsumed — a receipt authorizes exactly one action',
    where: 'On chain',
  },
  {
    scenario: 'Schedule a corporate action, then use an older receipt',
    expected: 'MultiplierNonceMismatch — the epoch advanced at schedule time, not activation',
    where: 'On chain',
  },
  {
    scenario: 'Preflight inside the guard window',
    expected: 'BLOCK with ACTIVATION_WINDOW, and no receipt issued',
    where: 'Off chain, at preflight',
  },
  {
    scenario: 'Take a source offline',
    expected: 'BLOCK with API_UNAVAILABLE or RPC_UNAVAILABLE — fails closed',
    where: 'Off chain, reproducible with FAULTS=',
  },
];

export default function PreflightPage() {
  const deployment = readDeployment();
  const apiBaseUrl = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:4000';

  return (
    <AppShell
      environmentLabel="LIVE X LAYER MAINNET READS · TESTNET ENFORCEMENT"
      currentPath="/preflight"
    >
      <header className="page-header">
        <h1 className="page-title">Preflight Lab</h1>
        <p className="page-subtitle">
          Authorize one exact operation, or see precisely why it is refused. A developer and
          operator tool — there is no balance, no price, and nothing here celebrates a success.
        </p>
      </header>

      <div style={{ marginBottom: 'var(--space-5)' }}>
        <InlineAlert tone="info" title="Mainnet is never written from this page.">
          Execution targets X Layer testnet (chain 1952) against a labelled{' '}
          <code>TESTNET FIXTURE</code>. There is no signing code path for chain 196 anywhere in this
          product.
        </InlineAlert>
      </div>

      <PreflightForm apiBaseUrl={apiBaseUrl} deployment={deployment} />

      <section
        className="detail-section"
        style={{ marginTop: 'var(--space-6)' }}
        aria-labelledby="proofs-heading"
      >
        <h2 id="proofs-heading" className="section-title">
          Failure proofs
        </h2>
        <p className="detail-note" style={{ marginTop: 0 }}>
          The refusals this product exists to demonstrate. Each is executable — the on-chain ones by{' '}
          <code>pnpm testnet:prove</code> once contracts are deployed, the off-chain ones right now.
        </p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Failure proof scenarios, scrollable"
        >
          <table className="data-table">
            <caption className="visually-hidden">
              Failure scenarios and their expected refusals.
            </caption>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Expected result</th>
                <th scope="col">Enforced where</th>
              </tr>
            </thead>
            <tbody>
              {FAILURE_PROOFS.map((proof) => (
                <tr key={proof.scenario}>
                  <th scope="row" data-label="Scenario">
                    {proof.scenario}
                  </th>
                  <td data-label="Expected result">{proof.expected}</td>
                  <td data-label="Enforced where" className="cell-detail">
                    {proof.where}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {deployment === undefined && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <InlineAlert tone="warning" title="The on-chain rows are NOT yet proven.">
              No contracts are deployed, so no transaction has ever exercised them. They are covered
              by 65 Solidity tests against a local EVM, which is not the same claim.
            </InlineAlert>
          </div>
        )}
      </section>
    </AppShell>
  );
}
