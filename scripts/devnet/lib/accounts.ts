/**
 * accounts.ts — deterministic identities.
 *
 * Acceptance criterion: "npm run devnet:reset produces byte-identical account
 * addresses and contract id."
 *
 * Both guarantees are pure functions of fixed strings, so they are provable by
 * gate tests without booting anything:
 *
 *   • Account keys come from sha256("hazina-devnet:v1:<role>") used as the raw
 *     ed25519 seed. Same role → same secret → same G… address, forever.
 *   • The contract id is the SHA-256 of the standard `ENVELOPE_TYPE_CONTRACT_ID`
 *     preimage over (network id, deployer address, salt). All three inputs are
 *     fixed, so the id is knowable before the network even boots — we do not
 *     read it back off the deploy transaction, we assert the deploy produced it.
 */

import { createHash } from 'node:crypto';
import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { CONTRACT_SALT_SEED } from './config.ts';

/** Namespace for every derived secret. Bumping this rotates all devnet keys. */
export const KEY_DERIVATION_PREFIX = 'hazina-devnet:v1:';

export type DevnetRole =
  | 'issuer'
  | 'admin'
  | 'treasury'
  | 'arbitrator'
  | 'buyer'
  | 'seller'
  | 'sellerNoTrustline';

export interface RoleSpec {
  role: DevnetRole;
  /** Env var name this account's public key is written to in .env.devnet. */
  envKey: string;
  /** Whether the account gets a devnet USDC trustline during provisioning. */
  trustline: boolean;
  description: string;
}

/**
 * The full roster. `sellerNoTrustline` deliberately has no trustline: it is the
 * fixture for the "payout to a trustline-less account" scenario, which is a real
 * production failure mode (the SAC transfer fails and the release reverts).
 */
export const ROLES: readonly RoleSpec[] = [
  {
    role: 'issuer',
    envKey: 'DEVNET_ISSUER_PUBLIC',
    trustline: false,
    description: 'Issues devnet USDC. Never holds a trustline to its own asset.',
  },
  {
    role: 'admin',
    envKey: 'DEVNET_ADMIN_PUBLIC',
    trustline: true,
    description: 'Contract admin + deployer. Signs release/refund.',
  },
  {
    role: 'treasury',
    envKey: 'DEVNET_TREASURY_PUBLIC',
    trustline: true,
    description: 'Receives the 5% platform fee on release.',
  },
  {
    role: 'arbitrator',
    envKey: 'DEVNET_ARBITRATOR_PUBLIC',
    trustline: true,
    description: 'Resolves disputes via resolve_dispute.',
  },
  {
    role: 'buyer',
    envKey: 'DEVNET_BUYER_PUBLIC',
    trustline: true,
    description: 'Locks funds into escrow. Funded with devnet USDC.',
  },
  {
    role: 'seller',
    envKey: 'DEVNET_SELLER_PUBLIC',
    trustline: true,
    description: 'Receives the 95% seller cut on release.',
  },
  {
    role: 'sellerNoTrustline',
    envKey: 'DEVNET_SELLER_NO_TRUSTLINE_PUBLIC',
    trustline: false,
    description: 'Seller with no USDC trustline — fixture for payout-failure tests.',
  },
] as const;

/**
 * Derives the keypair for a role. Deterministic by construction: sha256 of a
 * fixed string is a fixed 32 bytes, and ed25519 maps a seed to exactly one key.
 */
export function keypairForRole(role: DevnetRole): Keypair {
  const seed = createHash('sha256').update(`${KEY_DERIVATION_PREFIX}${role}`).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

export interface DevnetAccount extends RoleSpec {
  publicKey: string;
  secret: string;
}

/** The whole roster, resolved. Pure — safe to call from tests. */
export function deriveAccounts(): DevnetAccount[] {
  return ROLES.map(spec => {
    const kp = keypairForRole(spec.role);
    return { ...spec, publicKey: kp.publicKey(), secret: kp.secret() };
  });
}

/** Convenience lookup keyed by role. */
export function accountMap(): Record<DevnetRole, DevnetAccount> {
  const out = {} as Record<DevnetRole, DevnetAccount>;
  for (const account of deriveAccounts()) {
    out[account.role] = account;
  }
  return out;
}

/** The 32-byte network id: sha256 of the passphrase. */
export function networkId(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase).digest();
}

/** The fixed 32-byte deploy salt. */
export function contractSalt(): Buffer {
  return createHash('sha256').update(CONTRACT_SALT_SEED).digest();
}

/**
 * Computes the contract id a `create_contract` from `deployer` with `salt` will
 * produce on the network identified by `passphrase` — without deploying.
 *
 * This mirrors stellar-core's `getContractID`: sha256 of the XDR-encoded
 * HashIDPreimage(ENVELOPE_TYPE_CONTRACT_ID) built from the network id and the
 * (address, salt) preimage. Verified against a live deploy in the devnet's own
 * e2e run, and gate-tested against a frozen expected value.
 */
export function precomputeContractId(
  deployerPublicKey: string,
  passphrase: string,
  salt: Buffer = contractSalt(),
): string {
  if (salt.length !== 32) {
    throw new Error(`contract salt must be 32 bytes, got ${salt.length}`);
  }
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(deployerPublicKey).toScAddress(),
      salt,
    }),
  );
  const hashPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkId(passphrase),
      contractIdPreimage: preimage,
    }),
  );
  return StrKey.encodeContract(createHash('sha256').update(hashPreimage.toXdr()).digest());
}
