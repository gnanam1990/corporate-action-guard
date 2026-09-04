'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Deployment } from '@/lib/deployment';
import { InlineAlert } from './primitives';
import { ReasonCode, StatusBadge } from './status';

/**
 * The Preflight Lab.
 *
 * An operator and integrator tool, not a consumer trading interface. It exists to make the
 * binding between a receipt and one exact operation visible, and to make the refusals
 * reproducible.
 *
 * Client validation is for usability only. The server decides; nothing here treats a
 * locally-valid form as authorization.
 */

export interface PreflightFormProps {
  readonly apiBaseUrl: string;
  /** Undefined when nothing is deployed. Execution is then unavailable, and says so. */
  readonly deployment: Deployment | undefined;
}

type Decision =
  | {
      decision: 'ALLOW';
      requestId: string;
      evaluatedAt: string;
      reasonCodes: string[];
      operationDigest: string;
      evidence: Record<string, unknown>;
      receipt: {
        receiptId: string;
        signature: string;
        signer: string;
        validAfter: string;
        validUntil: string;
        verifyingContract: string;
        chainId: number;
      };
    }
  | {
      decision: 'BLOCK';
      requestId: string;
      evaluatedAt: string;
      reasonCodes: string[];
      reasonExplanations: { code: string; explanation: string }[];
      operationDigest: string;
      evidence: Record<string, unknown>;
    };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function PreflightForm({ apiBaseUrl, deployment }: PreflightFormProps) {
  const [assetId, setAssetId] = useState('');
  const [caller, setCaller] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1000000000000000000');
  const [nonce, setNonce] = useState('0');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Decision | undefined>();
  const [error, setError] = useState<string | undefined>();

  /** Usability only. The server is the authority, and a pass here means nothing. */
  const localIssues = useMemo(() => {
    const issues: string[] = [];
    if (assetId.trim() === '') issues.push('Asset id is required.');
    if (!ADDRESS_RE.test(caller)) issues.push('Caller must be a 20-byte 0x address.');
    if (!ADDRESS_RE.test(recipient)) issues.push('Recipient must be a 20-byte 0x address.');
    if (!/^\d+$/.test(amount) || amount === '0')
      issues.push('Amount must be a positive base-unit integer.');
    if (!/^\d+$/.test(nonce)) issues.push('Nonce must be a non-negative integer.');
    return issues;
  }, [assetId, caller, recipient, amount, nonce]);

  /** Human-readable preview of the base-unit amount, at 18 decimals. */
  const amountPreview = useMemo(() => {
    if (!/^\d+$/.test(amount)) return '—';
    const padded = amount.padStart(19, '0');
    const whole = padded.slice(0, padded.length - 18).replace(/^0+(?=\d)/, '');
    return `${whole}.${padded.slice(-18)}`;
  }, [amount]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(undefined);
      setResult(undefined);

      try {
        const response = await fetch(`${apiBaseUrl}/v1/preflight`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            // A fresh key per submission: this is a new intent, not a resubmission.
            'idempotency-key': `lab-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            chainId: deployment?.chainId ?? 1952,
            assetId,
            target: deployment?.protectedVault ?? '0x0000000000000000000000000000000000000000',
            asset: deployment?.fixtureAsset ?? '0x0000000000000000000000000000000000000000',
            wrapper: deployment?.fixtureWrapper ?? '0x0000000000000000000000000000000000000000',
            actionType: 'DEPOSIT',
            caller,
            recipient,
            amount,
            expectedMultiplierNonce: nonce,
          }),
        });

        const body = (await response.json()) as Decision & { detail?: string; title?: string };
        if (!response.ok) {
          setError(body.detail ?? body.title ?? `The API returned ${response.status}.`);
          return;
        }
        setResult(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The guard API could not be reached.');
      } finally {
        setBusy(false);
      }
    },
    [apiBaseUrl, apiKey, assetId, caller, recipient, amount, nonce, deployment],
  );

  return (
    <>
      <form className="lab-form" onSubmit={submit} noValidate>
        <fieldset className="lab-fieldset">
          <legend className="lab-legend">1 · Operation</legend>

          <label className="filters__field">
            <span className="filters__label">Asset id</span>
            <input
              className="filters__input"
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
              placeholder="AAPLx"
            />
          </label>

          <label className="filters__field">
            <span className="filters__label">Caller</span>
            <input
              className="filters__input mono"
              value={caller}
              onChange={(e) => setCaller(e.target.value)}
              placeholder="0x…"
            />
          </label>

          <label className="filters__field">
            <span className="filters__label">Recipient</span>
            <input
              className="filters__input mono"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0x…"
            />
          </label>

          <label className="filters__field">
            <span className="filters__label">Amount (base units)</span>
            <input
              className="filters__input mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {/* Base units are what gets signed; the preview is for the human only. */}
            <span className="lab-hint mono">= {amountPreview} at 18 decimals</span>
          </label>

          <label className="filters__field">
            <span className="filters__label">Expected multiplier nonce</span>
            <input
              className="filters__input mono"
              value={nonce}
              onChange={(e) => setNonce(e.target.value)}
            />
          </label>

          <label className="filters__field">
            <span className="filters__label">API key</span>
            <input
              className="filters__input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="cag_…"
              autoComplete="off"
            />
            <span className="lab-hint">Sent to the API only. Never stored or logged.</span>
          </label>
        </fieldset>

        {localIssues.length > 0 && (
          <div className="lab-issues" role="status">
            <strong>Before submitting:</strong>
            <ul>
              {localIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p className="lab-hint">
              These are convenience checks. The server decides, and a form that passes here can
              still be refused.
            </p>
          </div>
        )}

        <button className="filters__submit" type="submit" disabled={busy || localIssues.length > 0}>
          {busy ? 'Evaluating…' : 'Run preflight'}
        </button>
      </form>

      {/* Announced politely: the operator asked for this, so it should not steal focus. */}
      <div aria-live="polite">
        {error !== undefined && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <InlineAlert tone="danger" title="The request failed.">
              {error}
            </InlineAlert>
          </div>
        )}
        {result !== undefined && <DecisionPanel result={result} deployment={deployment} />}
      </div>
    </>
  );
}

function DecisionPanel({
  result,
  deployment,
}: {
  result: Decision;
  deployment: Deployment | undefined;
}) {
  return (
    <section
      className="detail-section"
      style={{ marginTop: 'var(--space-5)' }}
      aria-labelledby="decision-heading"
    >
      <h2 id="decision-heading" className="section-title">
        2 · Decision
        <span style={{ marginLeft: 'var(--space-3)' }}>
          <StatusBadge
            tone={result.decision === 'ALLOW' ? 'verified' : 'blocked'}
            label={result.decision}
          />
        </span>
      </h2>

      {result.decision === 'BLOCK' ? (
        <>
          <InlineAlert tone="danger" title="Refused. No receipt was issued.">
            A receipt is never returned for a BLOCK, for degraded evidence, or for an UNKNOWN check.
          </InlineAlert>
          <ul className="blocker-list" style={{ marginTop: 'var(--space-3)' }}>
            {result.reasonExplanations.map((item) => (
              <li key={item.code}>
                <ReasonCode code={item.code} /> {item.explanation}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <dl className="detail-grid">
            <div className="detail-row">
              <dt>Receipt id</dt>
              <dd className="mono">{result.receipt.receiptId}</dd>
            </div>
            <div className="detail-row">
              <dt>Signer</dt>
              <dd className="mono">{result.receipt.signer}</dd>
            </div>
            <div className="detail-row">
              <dt>Valid until</dt>
              <dd className="mono">{result.receipt.validUntil}</dd>
            </div>
            <div className="detail-row">
              <dt>Operation digest</dt>
              <dd className="mono">{result.operationDigest}</dd>
            </div>
          </dl>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <InlineAlert
              tone="warning"
              title="ALLOW authorizes a submission. It does not guarantee success."
            >
              The adapter re-verifies the nonce, <code>wrapper.asset()</code>, the guard window, and
              consumption at execution time. Any of those can change before you submit — a corporate
              action scheduled in the intervening seconds advances the nonce and this receipt stops
              working. That is the guard doing its job.
            </InlineAlert>
          </div>
        </>
      )}

      <h3 className="section-title" style={{ marginTop: 'var(--space-5)' }}>
        3 · Execute on X Layer testnet
      </h3>
      {deployment === undefined ? (
        <InlineAlert tone="info" title="Execution is unavailable: nothing is deployed.">
          No verified deployment artifact exists, so there is no adapter to call. This panel
          deliberately offers no form rather than one that cannot work. Deploy with{' '}
          <code>pnpm testnet:deploy</code>, which writes the artifact only after post-broadcast
          bytecode verification.
        </InlineAlert>
      ) : (
        <InlineAlert tone="info" title="Submit from the caller address named in the receipt.">
          Any other sender is rejected with <code>CallerMismatch</code>. The adapter is{' '}
          <span className="mono">{deployment.actionGuardAdapter}</span> on chain{' '}
          {deployment.chainId}.
        </InlineAlert>
      )}
    </section>
  );
}
