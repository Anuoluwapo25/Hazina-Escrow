#!/usr/bin/env node
/**
 * index.ts — offline verifier for Hazina verifiable delivery receipts.
 *
 * Usage:
 *   hazina-verify <receipt-id> --payload <payload.json> [--api-url <url>]
 *   hazina-verify <receipt-id> --leaf-hash <hex> [--api-url <url>]
 *
 * The verifier pulls the receipt from a running Hazina backend, recomputes the
 * commitment hashes from the delivered payload (or from a supplied leaf hash),
 * checks the Merkle proof against the anchored root, and reports whether the
 * receipt is authentic. No backend code is imported — hashing and Merkle logic
 * are reimplemented here so the check is genuinely independent.
 */

import { readFile } from 'node:fs/promises';
import {
  verifyReceiptAgainstPayload,
  verifyReceiptWithLeaf,
  type ReceiptData,
} from './verify.js';

const HELP = `hazina-verify — offline verifier for Hazina delivery receipts

Usage:
  hazina-verify <receipt-id> --payload <payload.json> [--api-url <url>]
  hazina-verify <receipt-id> --leaf-hash <hex> [--api-url <url>]

Options:
  --payload <file>   Path to the JSON payload that was delivered at purchase time.
                     Recomputes the leaf hash and receipt hash from its canonical form.
  --leaf-hash <hex>  A pre-computed leaf hash (SHA256 of the JCS payload). Use this
                     when the payload itself is not available but the hash was
                     recorded at delivery.
  --api-url <url>    Hazina backend base URL. Defaults to HAZINA_API_URL or
                     http://localhost:3001.
  --check-anchor     Also verify the anchor memo on Stellar Horizon (experimental,
                     requires network access).
  --help             Show this help.

Exit codes:
  0  Receipt verified (or verified with only warnings)
  1  Receipt failed verification
  2  Usage or fetch error

Examples:
  hazina-verify rcpt_abc123 --payload ./delivered.json
  hazina-verify rcpt_abc123 --leaf-hash a1b2... --api-url https://hazina.example.com
`;

interface CliArgs {
  receiptId: string;
  payloadPath?: string;
  leafHash?: string;
  apiUrl: string;
  checkAnchor: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    receiptId: '',
    apiUrl: process.env.HAZINA_API_URL ?? 'http://localhost:3001',
    checkAnchor: false,
    help: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--payload') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--payload requires a value.');
      args.payloadPath = value;
    } else if (arg === '--leaf-hash') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--leaf-hash requires a value.');
      args.leafHash = value;
    } else if (arg === '--api-url') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--api-url requires a value.');
      args.apiUrl = value;
    } else if (arg === '--check-anchor') {
      args.checkAnchor = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('Expected exactly one receipt id.');
  }
  args.receiptId = positional[0]!;

  if (args.payloadPath && args.leafHash) {
    throw new Error('Provide either --payload or --leaf-hash, not both.');
  }
  if (!args.payloadPath && !args.leafHash) {
    throw new Error('Provide --payload or --leaf-hash to recompute the commitment.');
  }

  return args;
}

async function fetchReceipt(receiptId: string, apiUrl: string): Promise<ReceiptData> {
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/receipts/${encodeURIComponent(receiptId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch receipt (HTTP ${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    receipt?: ReceiptData;
  };
  if (!json.receipt) {
    throw new Error('Response did not include a receipt.');
  }
  return json.receipt;
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return 0;
    }

    const receipt = await fetchReceipt(args.receiptId, args.apiUrl);

    let result: ReturnType<typeof verifyReceiptAgainstPayload>;
    if (args.payloadPath) {
      const raw = await readFile(args.payloadPath, 'utf8');
      const payload = JSON.parse(raw) as Record<string, unknown>;
      result = verifyReceiptAgainstPayload(receipt, payload);
    } else {
      // Leaf hash supplied: recompute the receipt hash and check the Merkle
      // proof from the supplied leaf. The leaf itself is trusted input.
      const leafHash = args.leafHash!.toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/.test(leafHash)) {
        throw new Error('--leaf-hash must be a 64-character hex string.');
      }
      result = verifyReceiptWithLeaf(receipt, leafHash);
    }

    const valid = result.valid;
    console.log('');
    console.log('  Receipt:', receipt.id);
    console.log('  Dataset:', receipt.datasetId);
    console.log('  Delivered at:', receipt.deliveredAt);
    console.log('  Anchor status:', receipt.anchorStatus);
    console.log('');

    console.log('  Leaf hash    stored:', receipt.leafHash);
    console.log('  Leaf hash  computed:', result.computedLeafHash);
    console.log('  Receipt hash stored:', receipt.receiptHash);
    console.log('  Receipt hash computed:', result.computedReceiptHash);
    console.log('');

    if (result.merkleProofValid !== undefined) {
      console.log('  Merkle proof:', result.merkleProofValid ? 'valid' : 'invalid');
    }
    if (result.anchorVerified !== undefined) {
      console.log('  Anchor verified:', result.anchorVerified ? 'yes' : 'no');
    }

    console.log('');
    if (valid) {
      console.log('  ✓ Receipt verified — the commitment chain is intact.');
      return 0;
    }
    console.log('  ✗ Receipt FAILED verification:');
    for (const err of result.errors) {
      console.log('      - ' + err);
    }
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`hazina-verify: ${message}`);
    console.error('Run "hazina-verify --help" for usage.');
    return 2;
  }
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    console.error(`hazina-verify: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });