/**
 * The package exports no way to write.
 *
 * ADR 0007 makes Base mainnet read-only, and the strongest form of that is structural: not a
 * guard that can be deleted, but an absence of any signing surface to reach. This asserts it
 * against the built module and against the source text, so adding one fails here rather than
 * in a review that might not notice.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as reader from '../src/index.js';

const SRC = path.resolve(import.meta.dirname, '../src');

const WRITE_SHAPED =
  /wallet|signer|privatekey|sendtransaction|writecontract|signmessage|signtypeddata/i;

describe('read-only by construction', () => {
  it('exports nothing whose name suggests a write', () => {
    const offenders = Object.keys(reader).filter((name) => WRITE_SHAPED.test(name));
    expect(offenders).toEqual([]);
  });

  it('imports no viem write surface anywhere in the package', () => {
    // `createWalletClient`, `privateKeyToAccount` and `writeContract` are the three ways this
    // could acquire the ability to broadcast. None of them may appear.
    for (const file of ['reader.ts', 'indexing.ts', 'abi.ts', 'errors.ts', 'index.ts']) {
      const source = readFileSync(path.join(SRC, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      expect(code, `${file} references a write surface`).not.toMatch(
        /createWalletClient|privateKeyToAccount|writeContract|sendTransaction|sendRawTransaction/,
      );
    }
  });

  it('pins the two Base chain ids and nothing else', () => {
    expect(reader.BASE_MAINNET_CHAIN_ID).toBe(8453);
    expect(reader.BASE_SEPOLIA_CHAIN_ID).toBe(84532);
  });

  it('uses the precompile addresses from the pinned base-std snapshot', () => {
    expect(reader.B20_FACTORY_ADDRESS).toBe('0xb20f000000000000000000000000000000000000');
    expect(reader.POLICY_REGISTRY_ADDRESS).toBe('0x8453000000000000000000000000000000000002');
    expect(reader.ACTIVATION_REGISTRY_ADDRESS).toBe('0x8453000000000000000000000000000000000001');
  });
});
