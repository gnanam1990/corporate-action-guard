#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { GuardClient } from './client.js';
import { EXIT_CODE, GuardError, type PreflightOperation } from './types.js';
import { verifyReceiptLocally } from './verify.js';

/**
 * The `guard` CLI.
 *
 * Read-only by default. Every command that could move value requires an explicit flag and
 * an interactive confirmation, and mainnet execution is not expressible at all.
 *
 * **The API key is never accepted as an argument.** A key on the command line lands in
 * shell history and in `ps` output for every user on the machine. It comes from
 * `GUARD_API_KEY` or from stdin.
 */

const USAGE = `guard — Corporate Action Guard CLI

Usage:
  guard assets list [--state STATE] [--search TERM] [--json]
  guard assets show <assetId> [--json]
  guard preflight check --asset ADDR --wrapper ADDR --target ADDR \\
      --caller ADDR --recipient ADDR --amount BASE_UNITS --nonce N \\
      --asset-id ID [--chain 1952] [--action DEPOSIT] [--idempotency-key KEY] [--json]
  guard receipt verify --file receipt.json [--expect-signer ADDR] [--json]
  guard doctor [--json]

Environment:
  GUARD_API_URL     Base URL of the guard API (default http://localhost:4000)
  GUARD_API_KEY     API key. Never pass a key as an argument: it would be recorded in
                    shell history and visible in ps output.

Exit codes:
  0   ALLOW        the operation is authorized (NOT a guarantee the transaction succeeds)
  10  BLOCK        the operation is refused, with reason codes
  20  UNAVAILABLE  the guard could not be reached or answered
  30  INVALID      bad input
  40  INTERNAL     unexpected failure
`;

interface Args {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const err = (text: string): void => void process.stderr.write(`${text}\n`);

/** Redact anything key-shaped before it can reach debug output. */
function redactForDisplay(value: string): string {
  return value.replace(/cag_[A-Za-z0-9]{8}_[A-Za-z0-9]+/g, 'cag_********_[redacted]');
}

function requireFlag(flags: Args['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') {
    err(`missing required --${name}`);
    process.exit(EXIT_CODE.INVALID_INPUT);
  }
  return value;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return EXIT_CODE.ALLOW;
  }

  const { positional, flags } = parseArgs(argv);
  const json = flags['json'] === true;
  const api = new GuardClient({
    baseUrl: process.env['GUARD_API_URL'] ?? 'http://localhost:4000',
    ...(process.env['GUARD_API_KEY'] === undefined ? {} : { apiKey: process.env['GUARD_API_KEY'] }),
  });

  const [group, command] = positional;

  try {
    if (group === 'assets' && command === 'list') {
      const query: Record<string, string> = {};
      if (typeof flags['state'] === 'string') query['lifecycleState'] = flags['state'];
      if (typeof flags['search'] === 'string') query['search'] = flags['search'];
      const result = (await api.listAssets(query)) as {
        items: Record<string, unknown>[];
        servedAt: string;
      };

      if (json) {
        out(JSON.stringify(result, null, 2));
      } else if (result.items.length === 0) {
        out('No assets matched.');
      } else {
        for (const asset of result.items) {
          out(
            `${String(asset['symbol']).padEnd(10)} ${String(asset['lifecycleState']).padEnd(14)} ` +
              `canonicality=${String(asset['canonicality']).padEnd(8)} nonce=${String(asset['multiplierNonce'] ?? '-')}`,
          );
        }
        out(`\n${result.items.length} asset(s), served at ${result.servedAt}`);
      }
      return EXIT_CODE.ALLOW;
    }

    if (group === 'assets' && command === 'show') {
      const assetId = positional[2];
      if (assetId === undefined) {
        err('usage: guard assets show <assetId>');
        return EXIT_CODE.INVALID_INPUT;
      }
      const asset = await api.getAsset(assetId);
      out(JSON.stringify(asset, null, 2));
      return EXIT_CODE.ALLOW;
    }

    if (group === 'preflight' && command === 'check') {
      const operation: PreflightOperation = {
        chainId: Number(flags['chain'] ?? 1952),
        assetId: requireFlag(flags, 'asset-id'),
        target: requireFlag(flags, 'target'),
        asset: requireFlag(flags, 'asset'),
        wrapper: requireFlag(flags, 'wrapper'),
        actionType: (typeof flags['action'] === 'string'
          ? flags['action']
          : 'DEPOSIT') as PreflightOperation['actionType'],
        caller: requireFlag(flags, 'caller'),
        recipient: requireFlag(flags, 'recipient'),
        amount: BigInt(requireFlag(flags, 'amount')),
        expectedMultiplierNonce: BigInt(requireFlag(flags, 'nonce')),
      };

      const decision = await api.preflight(operation, {
        ...(typeof flags['idempotency-key'] === 'string'
          ? { idempotencyKey: flags['idempotency-key'] }
          : {}),
      });

      if (json) {
        out(JSON.stringify(decision, null, 2));
      } else if (decision.decision === 'ALLOW') {
        out('ALLOW');
        out(`  receipt      ${decision.receipt.receiptId}`);
        out(`  valid until  ${decision.receipt.validUntil}`);
        out(`  digest       ${decision.operationDigest}`);
        out('');
        // Said plainly, because the distinction is exactly where an integrator goes wrong.
        out('ALLOW authorizes a submission. It is not a guarantee the transaction succeeds:');
        out('the adapter re-verifies the nonce, wrapper relation, guard window, and');
        out('consumption at execution time, and any of those can change before you submit.');
      } else {
        out('BLOCK');
        for (const item of decision.reasonExplanations) {
          out(`  ${item.code}`);
          out(`    ${item.explanation}`);
        }
      }
      return decision.decision === 'ALLOW' ? EXIT_CODE.ALLOW : EXIT_CODE.BLOCK;
    }

    if (group === 'receipt' && command === 'verify') {
      const file = requireFlag(flags, 'file');
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        receipt: Parameters<typeof verifyReceiptLocally>[0]['receipt'];
        operation: Record<string, unknown>;
        operationDigest: string;
      };

      const operation: PreflightOperation = {
        ...(parsed.operation as unknown as PreflightOperation),
        amount: BigInt(String(parsed.operation['amount'])),
        expectedMultiplierNonce: BigInt(String(parsed.operation['expectedMultiplierNonce'])),
      };

      const result = await verifyReceiptLocally({
        receipt: parsed.receipt,
        operation,
        operationDigest: parsed.operationDigest,
        ...(typeof flags['expect-signer'] === 'string'
          ? { expectedSigners: [flags['expect-signer']] }
          : {}),
        nowSeconds: BigInt(Math.floor(Date.now() / 1_000)),
      });

      if (json) {
        out(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        out('VALID — this receipt authorizes exactly this operation, right now.');
        out('The adapter still re-verifies chain facts at execution time.');
      } else {
        out(`INVALID — ${result.code}`);
        out(`  ${result.reason}`);
      }
      return result.ok ? EXIT_CODE.ALLOW : EXIT_CODE.BLOCK;
    }

    if (group === 'doctor') {
      const checks: { name: string; ok: boolean; detail: string }[] = [];

      checks.push({
        name: 'GUARD_API_URL',
        ok: true,
        detail: process.env['GUARD_API_URL'] ?? 'http://localhost:4000 (default)',
      });
      checks.push({
        name: 'GUARD_API_KEY',
        ok: process.env['GUARD_API_KEY'] !== undefined,
        // Presence only. The value is never printed, even redacted.
        detail: process.env['GUARD_API_KEY'] === undefined ? 'not set' : 'set',
      });

      const readiness = await api.readiness();
      if (!readiness.reachable) {
        checks.push({ name: 'api reachable', ok: false, detail: readiness.detail });
      } else {
        // Reachable and not-ready are different diagnoses, and conflating them sends an
        // operator to look at the network when the problem is a missing signing key.
        checks.push({ name: 'api reachable', ok: true, detail: 'responding' });
        checks.push({
          name: 'api ready',
          ok: readiness.ready,
          detail: readiness.ready
            ? 'all dependencies healthy'
            : 'a dependency is unhealthy (see below)',
        });
        for (const component of readiness.components) {
          checks.push({
            name: `dependency: ${component.name}`,
            ok: component.ok,
            detail: component.detail,
          });
        }
      }

      if (json) {
        out(JSON.stringify({ checks }, null, 2));
      } else {
        for (const check of checks) {
          out(
            `${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(28)} ${redactForDisplay(check.detail)}`,
          );
        }
      }
      return checks.every((c) => c.ok) ? EXIT_CODE.ALLOW : EXIT_CODE.UNAVAILABLE;
    }

    err(`unknown command: ${positional.join(' ')}\n`);
    err(USAGE);
    return EXIT_CODE.INVALID_INPUT;
  } catch (e) {
    if (e instanceof GuardError) {
      err(`${e.kind}: ${e.message}`);
      return e.kind === 'INVALID_REQUEST' ? EXIT_CODE.INVALID_INPUT : EXIT_CODE.UNAVAILABLE;
    }
    if (e instanceof SyntaxError) {
      err(`invalid input: ${e.message}`);
      return EXIT_CODE.INVALID_INPUT;
    }
    err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_CODE.INTERNAL;
  }
}

process.exit(await main());
