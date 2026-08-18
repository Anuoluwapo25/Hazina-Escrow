# Passkey smart-wallet checkout

Lets a buyer create a Stellar smart wallet and authenticate with Face ID /
Touch ID / Windows Hello / a security key — no browser extension, no seed
phrase, no funded account. This is Part 1 of #587: WebAuthn onboarding for a
[Soroban smart-wallet](https://developers.stellar.org/docs/build/apps/smart-wallets)
account, sponsored so a brand-new buyer never needs testnet XLM.

Code: `frontend/src/lib/passkeyWallet.ts` (client wrapper),
`backend/src/wallet/passkeyWallet.router.ts` +
`backend/src/lib/launchtube.client.ts` (server relay).

## What ships in this PR

1. **Feature-detected passkey button.** `WalletConnectButton` shows a third
   "Passkey" option next to Freighter/Albedo only when
   `isPasskeySupported()` resolves true (the browser has
   `PublicKeyCredential` and a platform authenticator). When it resolves
   false, the button is not rendered at all and a short explanatory note
   takes its place instead — never a blank button or a thrown error.
2. **Wallet creation.** Clicking "Passkey" runs a WebAuthn `create()`
   ceremony via [`passkey-kit`](https://www.npmjs.com/package/passkey-kit)'s
   `PasskeyKit.createWallet()`, which deploys a new smart-wallet contract
   with that passkey as its first signer and returns an already-authorized,
   unsigned deploy transaction. The frontend relays it to
   `POST /api/wallet/passkey/deploy`, which forwards it to
   [Launchtube](https://github.com/stellar/launchtube) — Launchtube pays the
   deploy fee, so the buyer needs zero XLM.
3. **One-tap reconnect + recovery.** The resulting `{ keyId, contractId }`
   pair is persisted to `localStorage`. A returning buyer reconnects with
   `PasskeyKit.connectWallet({ keyId })` — one tap, no new registration. If
   local storage is empty (new device, cleared storage), `connectWallet()`
   runs the full WebAuthn discovery ceremony instead, recovering the wallet
   straight from the passkey itself.
4. **Buyer address format.** `escrow.router.ts`'s `STELLAR_ADDRESS` validator
   now accepts both classic `G…` accounts and `C…` Soroban contract
   addresses. No contract change was needed: `lib.rs`'s `Address` type
   already authorizes either uniformly via `require_auth()` — the only place
   that assumed "buyer is always a `G…` account" was this HTTP-boundary zod
   schema.
5. **Launchtube stays server-side.** `LAUNCHTUBE_URL`/`LAUNCHTUBE_JWT` are
   read only in `backend/src/lib/passkeyWallet.config.ts` and
   `launchtube.client.ts`; the browser only ever calls
   `/api/wallet/passkey/{deploy,submit}`. Verified by building the frontend
   and grepping the bundle:
   ```bash
   cd frontend && npm run build && grep -ril launchtube dist/   # → no matches
   ```
   Both endpoints sit behind a dedicated, tight rate-limit tier
   (`RATE_LIMIT_PASSKEY_MAX`, default 5 requests per window) — each relayed
   request can spend Hazina's Launchtube fee budget.

## What's deliberately deferred

Actually **paying for a dataset** through a connected passkey wallet needs
more than what's above, and CONTRIBUTING.md asks big issues to ship as
sequential PRs rather than one large one — this is that split point.

The blocker is architectural, not effort: `buildLockTx()` in
`backend/src/lib/escrow.client.ts` calls `rpc.getAccount(buyer)` to build the
transaction envelope, which requires `buyer` to be a classic account with a
sequence number. A smart-wallet contract has no sequence number, so it can
never be the envelope's source account — only the `buyer` _argument_ inside
the contract call. The buyer's own wallet paying the fee (as Freighter/Albedo
do today) isn't an option either, since the whole point of a passkey wallet
is that it holds no XLM.

The fix is Launchtube's other submission mode: instead of a fully-built
transaction envelope, you submit a `HostFunction` XDR plus an array of
signed `SorobanAuthorizationEntry` XDRs (`func`/`auth` fields, vs. the `xdr`
field this PR's relay already forwards) — Launchtube supplies its own
fee-paying source account and sequence number, so the buyer needs none.
Concretely, the next PR:

1. Builds the payment host function client-side with `passkey-kit`'s own
   `buildTokenTransferHostFunction(tokenContract, from, to, amount)`
   (`passkey-kit/dist/sac.d.ts`) — already installed, no new dependency.
2. Simulates it to obtain the required auth entries, signs the one
   belonging to the connected wallet with `kit.signAuthEntry(entry)`.
3. Posts `{ func, auth }` to `/api/wallet/passkey/submit` (the route already
   exists; today it only accepts a full `xdr`).

`/api/wallet/passkey/submit` and `WalletConnectButton`'s
`onPasskeyWallet` callback are already wired for this — the follow-up is
additive, not a rework. Until it lands, a buyer who connects a passkey
wallet sees a clear status note in `QueryModal` and still has the existing
transaction-hash field as a fallback; nothing is a dead end.

Also out of scope here (per the original issue): a spend-policy signer for
autonomous agent purchases, and mainnet deployment/funding.

## Config

Backend (`backend/.env.example`):

| Var                        | Purpose                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAUNCHTUBE_URL`           | Launchtube base URL (defaults to the testnet endpoint)                                                                                                                    |
| `LAUNCHTUBE_JWT`           | Launchtube auth token. Unset ⇒ `/wallet/passkey/*` return 503; every other checkout path is unaffected. Generate a testnet token at `https://testnet.launchtube.xyz/gen`. |
| `PASSKEY_WALLET_WASM_HASH` | Hex WASM hash of the deployed smart-wallet contract (a public code identifier, not a secret)                                                                              |
| `RATE_LIMIT_PASSKEY_MAX`   | Requests per window for the passkey endpoints (default 5)                                                                                                                 |

Frontend (`frontend/.env.example`):

| Var                             | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `VITE_PASSKEY_WALLET_WASM_HASH` | Same WASM hash as above. Unset ⇒ the passkey button never appears. |
| `VITE_SOROBAN_RPC_URL`          | Optional Soroban RPC override for the passkey client               |

## Testing

- `frontend/src/lib/passkeyWallet.test.ts` — mocks `passkey-kit` and
  `navigator`'s `PublicKeyCredential`; covers feature detection, storage
  round-tripping, create-vs-reconnect branching, and the deploy relay.
- `backend/src/wallet/__tests__/passkeyWallet.router.test.ts` — mocks
  Launchtube; covers validation, the 503-when-unconfigured guard, a
  successful relay, error passthrough, and that a JWT never appears in a
  response body.
- `backend/src/lib/passkeyWallet.config.test.ts` — env-var resolution.
