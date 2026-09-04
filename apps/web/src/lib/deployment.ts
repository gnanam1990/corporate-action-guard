import fs from 'node:fs';
import path from 'node:path';

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

const ARTIFACT = path.resolve(process.cwd(), '../../contracts/deployments/xlayer-testnet.json');

export function readDeployment(): Deployment | undefined {
  try {
    if (!fs.existsSync(ARTIFACT)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) as Deployment;
    // Refuse anything that is not chain 1952, however it got there.
    if (parsed.chainId !== 1952 || parsed.implementationVersion !== 2) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
