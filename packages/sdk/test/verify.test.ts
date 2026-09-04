import { readFileSync } from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  computeOperationDigest,
  EXIT_CODE,
  GuardClient,
  GuardError,
  verifyReceiptLocally,
  type PreflightOperation,
  type Receipt,
} from '../src/index.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ADAPTER = '0x1111111111111111111111111111111111111111';
const RECEIPT_ID = `0x${'11'.repeat(32)}`;
const NOW_SECONDS = 1_788_000_100n;

const operation = (over: Partial<PreflightOperation> = {}): PreflightOperation => ({
  chainId: 1952,
  assetId: 'AAPLx',
  target: '0x3333333333333333333333333333333333333333',
  asset: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  wrapper: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
  actionType: 'DEPOSIT',
  caller: '0x2222222222222222222222222222222222222222',
  recipient: '0x4444444444444444444444444444444444444444',
  amount: 1_000_000_000_000_000_000n,
  expectedMultiplierNonce: 5n,
  ...over,
});

const VALID_AFTER = 1_788_000_000n;
const VALID_UNTIL = 1_788_000_300n;

const RECEIPT_TYPE = {
  PreflightReceipt: [
    { name: 'schemaVersion', type: 'uint16' },
    { name: 'receiptId', type: 'bytes32' },
    { name: 'caller', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'wrapper', type: 'address' },
    { name: 'actionType', type: 'uint8' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expectedMultiplierNonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'operationDigest', type: 'bytes32' },
  ],
} as const;

const ACTION_VALUE = { DEPOSIT: 1, WITHDRAW: 2, TRANSFER: 3, REDEEM: 4 } as const;

/**
 * Issue a receipt the way the server would, signing locally with viem.
 *
 * The digest comes from the SDK's own encoder, which the golden-vector test above pins to
 * the shared artifact — so this fixture cannot drift from the real issuer without that test
 * failing first.
 */
async function issue(op: PreflightOperation): Promise<{ receipt: Receipt; digest: string }> {
  const account = privateKeyToAccount(KEY);
  const digest = computeOperationDigest(op, ADAPTER);

  const signature = await account.signTypedData({
    domain: {
      name: 'CorporateActionGuard',
      version: '1',
      chainId: op.chainId,
      verifyingContract: ADAPTER,
    },
    types: RECEIPT_TYPE,
    primaryType: 'PreflightReceipt',
    message: {
      schemaVersion: 1,
      receiptId: RECEIPT_ID,
      caller: op.caller,
      target: op.target,
      asset: op.asset,
      wrapper: op.wrapper,
      actionType: ACTION_VALUE[op.actionType],
      recipient: op.recipient,
      amount: op.amount,
      expectedMultiplierNonce: op.expectedMultiplierNonce,
      validAfter: VALID_AFTER,
      validUntil: VALID_UNTIL,
      operationDigest: digest,
    } as never,
  });

  return {
    receipt: {
      receiptId: RECEIPT_ID,
      signature,
      signer: account.address,
      validAfter: new Date(Number(VALID_AFTER) * 1_000).toISOString(),
      validUntil: new Date(Number(VALID_UNTIL) * 1_000).toISOString(),
      verifyingContract: ADAPTER,
      chainId: op.chainId,
    },
    digest,
  };
}

/**
 * The SDK is pinned to the SAME committed golden vectors that the TypeScript signer and the
 * Solidity adapter are pinned to.
 *
 * It deliberately does NOT import @cag/receipts: the SDK must stay a pure HTTP client with
 * no server dependency, which is what makes it safe to hand to an integrator. Reading the
 * shared artifact instead gives a stronger guarantee anyway — all three implementations are
 * checked against one file that none of them can adjust to match itself.
 *
 * If these ever diverge, an integrator's local check would pass and the on-chain call would
 * revert, which is the worst possible split.
 */
describe('the SDK digest is pinned to the shared golden vectors', () => {
  const vectorsFile = path.resolve(
    import.meta.dirname,
    '../../receipts/vectors/operation-digests.json',
  );
  const vectors = JSON.parse(readFileSync(vectorsFile, 'utf8')) as {
    count: number;
    vectors: {
      name: string;
      operation: Record<string, string | number>;
      expectedDigest: string;
    }[];
  };

  const ACTION_BY_VALUE: Record<number, PreflightOperation['actionType']> = {
    1: 'DEPOSIT',
    2: 'WITHDRAW',
    3: 'TRANSFER',
    4: 'REDEEM',
  };

  it('reproduces every committed vector exactly', () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);

    for (const vector of vectors.vectors) {
      const op = vector.operation;
      const actual = computeOperationDigest(
        {
          chainId: Number(op['chainId']),
          assetId: 'vector',
          target: String(op['target']),
          asset: String(op['asset']),
          wrapper: String(op['wrapper']),
          actionType: ACTION_BY_VALUE[Number(op['actionType'])]!,
          caller: String(op['caller']),
          recipient: String(op['recipient']),
          amount: BigInt(String(op['amount'])),
          expectedMultiplierNonce: BigInt(String(op['expectedMultiplierNonce'])),
        },
        String(op['verifyingContract']),
      );
      expect(actual, `vector mismatch: ${vector.name}`).toBe(vector.expectedDigest);
    }
  });

  it('covers the uint256 maximum and both chain ids', () => {
    const names = vectors.vectors.map((v) => v.name);
    expect(names.some((n) => n.includes('uint256 maximum'))).toBe(true);
    expect(names.some((n) => n.includes('mainnet chain id'))).toBe(true);
  });
});

describe('local verification catches a mutated payload before gas is spent', () => {
  it('accepts the operation the receipt was issued for', async () => {
    const op = operation();
    const { receipt, digest } = await issue(op);
    const result = await verifyReceiptLocally({
      receipt,
      operation: op,
      operationDigest: digest,
      expectedSigners: [SIGNER],
      nowSeconds: NOW_SECONDS,
    });
    expect(result).toEqual({ ok: true });
  });

  const mutations: Array<[string, Partial<PreflightOperation>]> = [
    ['recipient', { recipient: `0x${'99'.repeat(20)}` }],
    ['amount', { amount: 999n }],
    ['asset', { asset: `0x${'99'.repeat(20)}` }],
    ['wrapper', { wrapper: `0x${'99'.repeat(20)}` }],
    ['target', { target: `0x${'99'.repeat(20)}` }],
    ['caller', { caller: `0x${'99'.repeat(20)}` }],
    ['actionType', { actionType: 'WITHDRAW' }],
    ['expectedMultiplierNonce', { expectedMultiplierNonce: 6n }],
  ];

  for (const [field, mutation] of mutations) {
    it(`rejects a changed ${field} with DIGEST_MISMATCH`, async () => {
      const { receipt, digest } = await issue(operation());
      const result = await verifyReceiptLocally({
        receipt,
        operation: operation(mutation),
        operationDigest: digest,
        nowSeconds: NOW_SECONDS,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('DIGEST_MISMATCH');
    });
  }

  it('rejects a chain mismatch before doing any crypto', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt,
      operation: operation({ chainId: 196 }),
      operationDigest: digest,
      nowSeconds: NOW_SECONDS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CHAIN_MISMATCH');
  });

  it('rejects an expired receipt at exactly validUntil', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt,
      operation: operation(),
      operationDigest: digest,
      nowSeconds: 1_788_000_300n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EXPIRED');
  });

  it('accepts one second before expiry', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt,
      operation: operation(),
      operationDigest: digest,
      nowSeconds: 1_788_000_299n,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a receipt before its window opens', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt,
      operation: operation(),
      operationDigest: digest,
      nowSeconds: 1_787_999_999n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_YET_VALID');
  });

  it('rejects a tampered signature', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt: { ...receipt, signature: `0x${'00'.repeat(65)}` },
      operation: operation(),
      operationDigest: digest,
      nowSeconds: NOW_SECONDS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a signer the integrator does not trust', async () => {
    const { receipt, digest } = await issue(operation());
    const result = await verifyReceiptLocally({
      receipt,
      operation: operation(),
      operationDigest: digest,
      expectedSigners: [`0x${'77'.repeat(20)}`],
      nowSeconds: NOW_SECONDS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNER_NOT_EXPECTED');
  });
});

describe('client behaviour', () => {
  const stub = (handler: (url: string, init: RequestInit) => Response) => {
    let calls = 0;
    const impl = (async (url: string | URL, init: RequestInit) => {
      calls++;
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  };

  it('never retries a preflight automatically', async () => {
    // A preflight can mint a receipt. Retrying without the caller's own stable key risks
    // minting a second one, so retries are the caller's decision.
    const fetchImpl = stub(() => new Response('{}', { status: 503 }));
    const client = new GuardClient({
      baseUrl: 'http://x',
      apiKey: 'k',
      fetchImpl: fetchImpl.impl,
      sleep: async () => undefined,
    });
    await expect(client.preflight(operation())).rejects.toThrow(GuardError);
    expect(fetchImpl.calls()).toBe(1);
  });

  it('does retry an idempotent read', async () => {
    let n = 0;
    const fetchImpl = stub(() =>
      ++n < 3 ? new Response('{}', { status: 503 }) : new Response('{"items":[]}', { status: 200 }),
    );
    const client = new GuardClient({
      baseUrl: 'http://x',
      fetchImpl: fetchImpl.impl,
      sleep: async () => undefined,
    });
    await client.listAssets();
    expect(fetchImpl.calls()).toBe(3);
  });

  it('sends the amount as a base-unit string, never a number', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = stub((_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ decision: 'BLOCK', reasonCodes: ['X'] }), {
        status: 200,
      });
    });
    const client = new GuardClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fetchImpl.impl });
    await client.preflight(operation({ amount: 2n ** 200n }));
    expect(typeof sent['amount']).toBe('string');
    expect(sent['amount']).toBe((2n ** 200n).toString());
  });

  it('always sends an idempotency key', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = stub((_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ decision: 'BLOCK', reasonCodes: ['X'] }), {
        status: 200,
      });
    });
    const client = new GuardClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fetchImpl.impl });
    await client.preflight(operation());
    expect(headers['idempotency-key']).toBeDefined();
  });

  it('uses a caller-supplied idempotency key verbatim', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = stub((_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ decision: 'BLOCK', reasonCodes: ['X'] }), {
        status: 200,
      });
    });
    const client = new GuardClient({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fetchImpl.impl });
    await client.preflight(operation(), { idempotencyKey: 'my-stable-key-0001' });
    expect(headers['idempotency-key']).toBe('my-stable-key-0001');
  });

  it('maps status codes to distinct error kinds', async () => {
    for (const [status, kind] of [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [400, 'INVALID_REQUEST'],
    ] as const) {
      const fetchImpl = stub(() => new Response('{}', { status }));
      const client = new GuardClient({
        baseUrl: 'http://x',
        apiKey: 'k',
        fetchImpl: fetchImpl.impl,
      });
      await expect(client.preflight(operation())).rejects.toMatchObject({ kind });
    }
  });

  it('omits the API key header entirely when none is configured', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = stub((_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response('{"items":[]}', { status: 200 });
    });
    const client = new GuardClient({ baseUrl: 'http://x', fetchImpl: fetchImpl.impl });
    await client.listAssets();
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('exit codes distinguish evaluation from failure', () => {
  it('ALLOW and BLOCK are both successful evaluations, and distinct', () => {
    // A script treating BLOCK as a retryable failure would hammer the API; one treating it
    // as success would proceed with an operation the guard refused.
    expect(EXIT_CODE.ALLOW).toBe(0);
    expect(EXIT_CODE.BLOCK).toBe(10);
    expect(EXIT_CODE.BLOCK).not.toBe(EXIT_CODE.UNAVAILABLE);
    expect(new Set(Object.values(EXIT_CODE)).size).toBe(Object.keys(EXIT_CODE).length);
  });
});
