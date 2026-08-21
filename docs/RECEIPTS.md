# Verifiable delivery receipts

Hazina commits to every data delivery in a way that can be independently
verified later — by a buyer, by an arbitrator, or by anyone holding the
receipt id. The commitment chain is: delivered payload → leaf hash → receipt
hash → (batched) Merkle root → on-chain Stellar memo. Any single link can be
recomputed offline and checked against the stored/on-chain value.

Feature tracking: #594. Code lives in `backend/src/receipts/`, the public
verification page in `frontend/src/pages/VerifyReceiptPage.tsx`, and the
offline verifier in `packages/hazina-verify/`.

## The commitment chain

### 1. Leaf hash — commits the delivered payload

```
leaf = SHA256(JCS(datasetPayload))
```

`JCS` is the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) JSON
Canonicalization Scheme: object keys sorted by UTF-16 code unit order, no
insignificant whitespace, `-0` preserved, numbers in shortest
round-trippable decimal form, `undefined`/functions/symbols dropped,
non-finite numbers rejected, dates as ISO 8601 UTC. The canonical form is
UTF-8-hashed with SHA-256 to 32 bytes.

The same payload serializes to the same leaf hash on any machine — the
frontend, the backend, the offline CLI, or a third-party auditor. Two
implementations live in the repo: `backend/src/receipts/canonical.ts` and the
independent copy in `packages/hazina-verify/src/canonical.ts` (the CLI
reimplements it deliberately, so the check is not trust-on-our-own-code).

### 2. Receipt hash — binds payload to the deal

```
receiptHash = SHA256(
    leaf (32 bytes) ‖
    len(datasetId) ‖ datasetId ‖
    len(buyer)    ‖ buyer    ‖
    len(seller)   ‖ seller   ‖
    len(deliveredAt) ‖ deliveredAt ‖
    amount (8-byte big-endian IEEE 754 float64)
)
```

String fields are length-prefixed with a 4-byte big-endian count; `amount` is
encoded as a big-endian float64 and comes last. This binds the delivered
payload to the parties, the dataset, the delivery time, and the amount paid —
changing any one of them changes the hash. See
`serializeReceiptPreimage` in `backend/src/receipts/receipt.service.ts`.

### 3. Merkle root — batches receipts (optional)

`batched` anchor mode Merkle-commits a set of receipts' **leaf hashes** into a
single root. The tree is built with odd leaves promoted unchanged (no
duplication), and each receipt stores its inclusion proof as
`siblings: (string | null)[]` — `null` marks a level where the node was
promoted. See `backend/src/receipts/merkle.ts`.

### 4. On-chain anchor — timestamp by Stellar

`direct` mode anchors the **receipt hash**; `batched` mode anchors the
**Merkle root**. The anchor is a minimal 1-stroop (`0.0000001 XLM`) XLM
self-payment from the agent wallet with the 32-byte hash carried as
`memo_hash`. The memo, not the amount, is what binds the hash to a ledger
entry with an immutable timestamp. Anyone can read the anchor transaction
(`anchorTxHash`) and check its `memo_hash` equals the stored hash.

## Receipt lifecycle

1. **Created** at delivery time (`deliverVerifiedPayment` in
   `backend/src/payments/payments.service.ts`). `storeReceipt` computes leaf
   and receipt hashes from the exact delivered payload and persists
   `anchorStatus = NOT_ANCHORED_YET`. Best-effort: a receipt failure never
   blocks the delivery.
2. **Anchored** by the sweep worker (`startAnchorWorker`, runs every
   `RECEIPT_ANCHOR_INTERVAL_MS`, default 60 s). Direct receipts are anchored
   one per transaction; batched receipts are Merkle-rooted in groups of up to
   `RECEIPT_ANCHOR_BATCH_SIZE` (default 64). Failures move to `ANCHOR_FAILED`
   and are retried on the next sweep.
3. **Verifiable** via `GET /api/v1/receipts/:id`, the
   `/receipts/:receiptId` page, the offline CLI, or an on-chain check of the
   anchor memo.

## Verification surfaces

| Surface | What it checks |
|---|---|
| `GET /api/v1/receipts/:id` (public) | Returns the receipt, its Merkle proof (when anchored), and a server-computed verification result. Exposes only commitment metadata — never payload bytes. |
| `/receipts/:receiptId` page | Renders the same data for a human: hashes, Merkle root, anchor status, and a link to the anchor transaction on Stellar Expert. |
| `packages/hazina-verify` CLI | Recomputes leaf + receipt hashes from the delivered payload independently, checks the Merkle proof against the stored root, and reports anchor status. Exit 0 = verified, 1 = failed, 2 = usage/fetch error. |
| Arbitrator | Disputes default to the receipt hash as the `raise_dispute()` evidence hash (see below). |

### Receipt anchoring in disputes

`POST /api/v1/payments/escrow/dispute/build` assembles an unsigned
`raise_dispute()` XDR. When the buyer supplies no explicit `evidenceHash`, the
backend resolves the escrow's transaction to its receipt and uses the receipt
hash as the on-chain evidence. The dispute is therefore committed to the same
verifiable hash a receipt page or the CLI can prove — either party can
independently reconstruct what was actually delivered. See
`backend/src/payments/escrow.router.ts`.

## Config

| Env var | Default | Meaning |
|---|---|---|
| `RECEIPT_ANCHOR_MODE` | `direct` | `direct` (one tx per receipt hash) or `batched` (Merkle-root many). Read per-receipt at creation time. |
| `RECEIPT_ANCHOR_ENABLED` | `true` | `false` disables the sweep worker (tests/CI). |
| `RECEIPT_ANCHOR_INTERVAL_MS` | `60000` | Sweep cadence. |
| `RECEIPT_ANCHOR_BATCH_SIZE` | `64` | Max receipts per batched anchor. |
| `AGENT_WALLET_SECRET` | unset | Agent wallet that signs anchor self-payments. Required for anchoring. |
| `HAZINA_API_URL` | `http://localhost:3001` | Backend base URL for the offline CLI. |

## Threat model and limits

- **What this proves**: that the exact delivered payload was committed, bound
  to a deal, and (once anchored) timestamped on-chain. It is cryptographic
  evidence of *what was delivered* and *when the commitment was made*.
- **What it does not prove**: that the delivery was correct, that the data
  was truthful, or that the buyer received anything. Those are claims about
  the payload's content and about the delivery channel, not about the
  commitment.
- **Trust boundary**: the leaf/receipt hashes are computed by the backend at
  delivery time and could in principle be forged at that moment. The offline
  CLI closes the loop on the *later* case — a receipt, stored hash, or anchor
  that was tampered with after delivery fails verification. An operator who
  controls the backend at delivery time could commit to a different payload
  than was actually sent; that requires trusting the delivery path, which is
  out of scope for the hash scheme.
- **Payload bytes are never exposed**: the verification API, page, and CLI
  operate on the hash — no dataset content leaves the backend.

## Developer notes

```bash
# Backend receipt tests
cd backend && npm test -- src/receipts

# Offline CLI tests (independent reimplementation + subprocess smoke test)
cd packages/hazina-verify && npm test

# Verify a receipt end-to-end with the CLI
cd packages/hazina-verify && npm run build
node dist/index.js rcpt_abc123 --payload /tmp/delivered.json \
  --api-url http://localhost:3001
```