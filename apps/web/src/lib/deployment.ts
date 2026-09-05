import deploymentArtifact from '../../../../contracts/deployments/xlayer-testnet.json';

/**
 * Deployed testnet addresses, read from the verified deployment artifact.
 *
 * The artifact is written by the deploy script ONLY after post-broadcast bytecode
 * verification. Addresses are never hand-entered here: a typo in a contract address is a
 * silent, total failure, and a UI that offers a wrong address is worse than one that
 * offers none.
 *
 * When no artifact exists, execution is unavailable and the page says so plainly rather
 * than presenting a form that cannot work.
 */
export interface Deployment {
  readonly chainId: number;
  readonly implementationVersion: number;
  readonly deployedAtBlock: number;
  readonly actionGuardAdapter: string;
  readonly protectedVault: string;
  readonly fixtureAsset: string;
  readonly fixtureWrapper: string;
  readonly receiptSigner: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseDeployment(raw: unknown): Deployment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const parsed = raw as Record<string, unknown>;
  // Refuse a partial, stale, or wrong-chain artifact rather than feeding unsafe defaults
  // into a transaction form.
  if (
    parsed['chainId'] !== 1952 ||
    parsed['implementationVersion'] !== 2 ||
    typeof parsed['deployedAtBlock'] !== 'number' ||
    !Number.isSafeInteger(parsed['deployedAtBlock']) ||
    parsed['deployedAtBlock'] < 0 ||
    typeof parsed['actionGuardAdapter'] !== 'string' ||
    !ADDRESS.test(parsed['actionGuardAdapter']) ||
    typeof parsed['protectedVault'] !== 'string' ||
    !ADDRESS.test(parsed['protectedVault']) ||
    typeof parsed['fixtureAsset'] !== 'string' ||
    !ADDRESS.test(parsed['fixtureAsset']) ||
    typeof parsed['fixtureWrapper'] !== 'string' ||
    !ADDRESS.test(parsed['fixtureWrapper']) ||
    typeof parsed['receiptSigner'] !== 'string' ||
    !ADDRESS.test(parsed['receiptSigner'])
  ) {
    return undefined;
  }
  return parsed as unknown as Deployment;
}

export function readDeployment(): Deployment | undefined {
  return parseDeployment(deploymentArtifact);
}
