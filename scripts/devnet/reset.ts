/**
 * reset.ts — `npm run devnet:reset`.
 *
 * Tears the network down (container AND volumes, so no ledger state survives)
 * and provisions from zero. The acceptance criterion is that this produces
 * byte-identical account addresses and contract id, which holds because every
 * identity is derived from a fixed string rather than from ledger state — see
 * lib/accounts.ts.
 *
 * The generated artifacts are compared before and after and any drift is
 * reported as a failure, so a regression in determinism surfaces here rather
 * than silently in someone's .env a week later.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS_OUTPUT_FILE, env as readEnv } from './lib/config.ts';
import { composeDown } from './lib/compose.ts';
import { provision } from './provision.ts';
import { renderSummary } from './lib/summary.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function log(message: string): void {
  process.stdout.write(`      ${message}\n`);
}

/** Reads the previous accounts file, if one exists, for the drift check. */
async function readPrevious(): Promise<{ contractId: string; addresses: string[] } | null> {
  try {
    const raw = await readFile(join(REPO_ROOT, ACCOUNTS_OUTPUT_FILE), 'utf8');
    const parsed = JSON.parse(raw) as {
      contract: { escrowContractId: string };
      accounts: Array<{ publicKey: string }>;
    };
    return {
      contractId: parsed.contract.escrowContractId,
      addresses: parsed.accounts.map(a => a.publicKey),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const overrides = readEnv();
  const before = await readPrevious();

  process.stdout.write('\n[reset] Tearing down the devnet\n');
  await composeDown(REPO_ROOT, overrides.port, log);

  process.stdout.write('\n[reset] Reprovisioning from zero\n');
  const result = await provision();
  process.stdout.write(renderSummary(result, process.stdout.isTTY === true));

  if (before) {
    const addressesAfter = result.accounts.map(a => a.publicKey);
    const contractSame = before.contractId === result.contractId;
    const addressesSame =
      before.addresses.length === addressesAfter.length &&
      before.addresses.every((addr, i) => addr === addressesAfter[i]);

    if (contractSame && addressesSame) {
      process.stdout.write(
        'Determinism check: PASS — contract id and all account addresses are identical ' +
          'to the previous run.\n',
      );
    } else {
      process.stderr.write('\n✖ Determinism check FAILED\n');
      if (!contractSame) {
        process.stderr.write(`  contract id: was ${before.contractId}, now ${result.contractId}\n`);
      }
      if (!addressesSame) {
        process.stderr.write('  account addresses changed between runs\n');
      }
      process.stderr.write(
        '\n`devnet:reset` must reproduce identical addresses. Check whether ' +
          'KEY_DERIVATION_PREFIX, CONTRACT_SALT_SEED or the network passphrase changed.\n\n',
      );
      process.exitCode = 1;
      return;
    }
  } else {
    process.stdout.write(
      `Determinism check: skipped — no previous ${ACCOUNTS_OUTPUT_FILE} to compare against.\n`,
    );
  }

  process.stdout.write(`Reset completed in ${((Date.now() - started) / 1000).toFixed(1)}s\n\n`);
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `\n✖ devnet reset failed\n\n${err instanceof Error ? err.message : String(err)}\n\n`,
    );
    process.exitCode = 1;
  });
}
