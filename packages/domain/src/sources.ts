/**
 * Source comparison.
 *
 * The rule that makes this product mean anything: a field the two sources both report and
 * disagree on is a MISMATCH, and a field one source cannot report is INCOMPLETE — never a
 * match. An absent value is not agreement.
 */

import { addressEquals } from './brands.js';
import type {
  SourceAgreement,
  SourceComparison,
  SourceComparisonField,
  TolerancePolicy,
  ApiObservation,
  ChainObservation,
} from './evidence.js';
import { multiplierToString, multiplierWithinTolerance } from './multiplier.js';

/** MISMATCH dominates INCOMPLETE, which dominates MATCH. Disagreement is never averaged away. */
function combine(agreements: readonly SourceAgreement[]): SourceAgreement {
  if (agreements.includes('MISMATCH')) return 'MISMATCH';
  if (agreements.includes('INCOMPLETE')) return 'INCOMPLETE';
  return 'MATCH';
}

function compareOptional<T>(
  api: T | undefined,
  chain: T | undefined,
  equals: (a: T, b: T) => boolean,
): SourceAgreement {
  if (api === undefined || chain === undefined) return 'INCOMPLETE';
  return equals(api, chain) ? 'MATCH' : 'MISMATCH';
}

/**
 * Compare an API observation with a chain observation field by field.
 *
 * Chain evidence is authoritative for on-chain facts (ADR 0002); this function does not
 * pick a winner, it reports whether the sources agree. The caller decides, and
 * disagreement always blocks.
 */
export function compareSources(
  api: ApiObservation,
  chain: ChainObservation,
  policy: TolerancePolicy,
): SourceComparison {
  const fields: SourceComparisonField[] = [
    {
      field: 'multiplier',
      agreement: compareOptional(api.multiplier, chain.multiplier, (a, b) =>
        multiplierWithinTolerance(a, b, policy.multiplierTolerance),
      ),
      apiValue: api.multiplier ? multiplierToString(api.multiplier) : undefined,
      chainValue: chain.multiplier ? multiplierToString(chain.multiplier) : undefined,
    },
    {
      field: 'multiplierNonce',
      agreement: compareOptional(api.multiplierNonce, chain.multiplierNonce, (a, b) => a === b),
      apiValue: api.multiplierNonce?.toString(),
      chainValue: chain.multiplierNonce?.toString(),
    },
    {
      field: 'scheduledActivation',
      agreement: compareOptional(
        api.scheduledActivation,
        chain.scheduledActivation,
        (a, b) => Math.abs(a - b) <= policy.activationToleranceMs,
      ),
      apiValue: api.scheduledActivation?.toString(),
      chainValue: chain.scheduledActivation?.toString(),
    },
    {
      field: 'wrapperAddress',
      // Checksum casing must never manufacture a mismatch.
      agreement: compareOptional(api.wrapperAddress, chain.wrapperAddress, addressEquals),
      apiValue: api.wrapperAddress,
      chainValue: chain.wrapperAddress,
    },
  ];

  return { agreement: combine(fields.map((f) => f.agreement)), fields };
}
