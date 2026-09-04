/** Signed off-chain intent for the explicitly labelled chain-1952 fixture. */
export interface FixtureEvidencePayload {
  readonly assetId: string;
  readonly chainId: 1952;
  readonly tokenAddress: string;
  readonly wrapperAddress: string;
  readonly multiplierValue: string;
  readonly multiplierDecimals: number;
  readonly multiplierNonce: string;
  readonly scheduledActivation: string | null;
  readonly observedAt: string;
}

/**
 * Canonical EIP-191 message signed by the fixture administrator.
 *
 * Fixed field order and explicit labels prevent concatenation ambiguity. Addresses are
 * normalized because checksum casing is not identity. The signature is intent evidence;
 * the independently read testnet snapshot must still match before preflight can ALLOW.
 */
export function fixtureEvidenceMessage(payload: FixtureEvidencePayload): string {
  return [
    'CORPORATE_ACTION_GUARD_FIXTURE_EVIDENCE_V1',
    `assetId:${payload.assetId}`,
    `chainId:${payload.chainId}`,
    `tokenAddress:${payload.tokenAddress.toLowerCase()}`,
    `wrapperAddress:${payload.wrapperAddress.toLowerCase()}`,
    `multiplierValue:${payload.multiplierValue}`,
    `multiplierDecimals:${payload.multiplierDecimals}`,
    `multiplierNonce:${payload.multiplierNonce}`,
    `scheduledActivation:${payload.scheduledActivation ?? 'none'}`,
    `observedAt:${payload.observedAt}`,
  ].join('\n');
}
