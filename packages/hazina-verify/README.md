# @hazina/verify

An offline verifier for [Hazina](../../README.md) verifiable delivery receipts. Given a receipt id and the exact payload that was delivered at purchase time, it independently recomputes the commitment hashes, checks the Merkle proof against the anchored root, and reports whether the receipt is authentic.

This package reimplements the hashing and Merkle logic itself — it imports no code from the backend — so the check is genuinely independent. If the backend were ever to lie about a receipt's hashes, this tool would still catch the discrepancy, because the commitment scheme is deterministic and documented.

## How it works

Hazina commits to every delivery with two hashes:

1. **Leaf hash** = `SHA256(JCS(datasetPayload))` — the canonical (RFC 8785) form of the delivered payload.
2. **Receipt hash** = `SHA256(leaf ‖ datasetId ‖ buyer ‖ seller ‖ deliveredAt ‖ amount)` — a length-prefixed serialization binding the payload to the parties, amount, and delivery time.

When receipts are batched for anchoring, each leaf is committed in a Merkle tree whose root is anchored on-chain (as a Stellar `memo_hash`). The receipt stores its Merkle proof; the verifier replays the proof against the stored root and also checks the anchor status.

## Install & build

```bash
cd packages/hazina-verify
npm install
npm run build
```

## Usage

```
hazina-verify <receipt-id> --payload <payload.json> [--api-url <url>]
hazina-verify <receipt-id> --leaf-hash <hex> [--api-url <url>]
```

The verifier fetches the receipt from a running Hazina backend (`GET /api/v1/receipts/:id`) and checks it locally.

| Option | Purpose |
|---|---|
| `--payload <file>` | JSON file containing the exact delivered payload. Recomputes the leaf hash and receipt hash from its canonical form. |
| `--leaf-hash <hex>` | A pre-computed leaf hash (SHA256 of the JCS payload). Use when the payload itself is no longer available but the hash was recorded at delivery. |
| `--api-url <url>` | Hazina backend base URL. Defaults to `HAZINA_API_URL` or `http://localhost:3001`. |
| `--help` | Show usage. |

Exit codes: `0` verified, `1` verification failed, `2` usage or fetch error.

### Example

```bash
# Backend returns the receipt for rcpt_abc; payload.json is what the buyer
# actually received at purchase time.
hazina-verify rcpt_abc --payload ./payload.json --api-url https://hazina.example.com
```

## Development

```bash
npm run dev      # tsx watch (no build step)
npm test         # vitest: canonicalization, preimage serialization, merkle
                 # proofs, payload/leaf verification, and a real subprocess
                 # smoke test against a stub HTTP server
npm run build
npm run lint
```