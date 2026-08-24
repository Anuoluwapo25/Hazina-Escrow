/**
 * Gate tests for the determinism guarantee.
 *
 * Acceptance criterion: "npm run devnet:reset produces byte-identical account
 * addresses and contract id."
 *
 * Because every identity is a pure function of fixed strings, that criterion is
 * provable without Docker. The expected values below are FROZEN: they were taken
 * from a real provisioning run and verified against a live deploy. If a change
 * makes these fail, contributors' addresses have shifted and every existing
 * .env.devnet is stale — which is exactly what should block a merge.
 */

import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  ROLES,
  accountMap,
  contractSalt,
  deriveAccounts,
  keypairForRole,
  networkId,
  precomputeContractId,
} from '../lib/accounts.ts';
import { LOCAL_NETWORK_PASSPHRASE } from '../lib/config.ts';

/**
 * Frozen addresses. Confirmed against a live `npm run devnet` run on the pinned
 * quickstart image — these are the addresses every contributor gets.
 */
const EXPECTED_ADDRESSES: Record<string, string> = {
  issuer: 'GD4XUZEYIQFPDDRHZZYSGQQ4MV7DJI6OIJCCHOWN4A43O4CMAMPPHMBN',
  admin: 'GA7SSV6QD2ISGL5MYSIDQHXLCFKWEMSXSTYFANXWX655G5OFY4ICDTMN',
  treasury: 'GBRE5IW2TBH5Z7WBHVRUF6VBVWWSOL3AESTNWBFZKUYK3P6UAWF5WDQP',
  arbitrator: 'GBK4J5EAPIHRK5MZIY6NCARCBOE3BPGRZK2JQMMBTS6STSRVJXQYLW6X',
  buyer: 'GAY7W32IIVADJZ3UYIA7GVW2COFNIDJGWTXA27RTEDXHJXAY6NKKIZAD',
  seller: 'GB5XWX2O352SE4HXX5ARZJQQ2VMUUQGDWZDEDMXNVMI3X5UPRLFEXE4U',
  sellerNoTrustline: 'GBOZADVVDNX5VDCNB3JQVTXWFY7YIIF2BAN4PIPU7ZCY5BHK46B4KGOZ',
};

/**
 * Frozen contract id. Verified against a real deploy: the provisioner asserts
 * the deployed id equals this precomputed one and aborts otherwise.
 */
const EXPECTED_CONTRACT_ID = 'CCUL6I3SM3H2FMIEHSPJHNDNTCQCD3FIJGSXEM5RDX5SDF4HSM6ACZ2W';

describe('deterministic accounts', () => {
  it('derives the same keypair every time', () => {
    for (const spec of ROLES) {
      const a = keypairForRole(spec.role);
      const b = keypairForRole(spec.role);
      expect(a.publicKey()).toBe(b.publicKey());
      expect(a.secret()).toBe(b.secret());
    }
  });

  it('matches the frozen addresses every contributor gets', () => {
    const accounts = accountMap();
    for (const [role, expected] of Object.entries(EXPECTED_ADDRESSES)) {
      expect(accounts[role as keyof typeof accounts].publicKey).toBe(expected);
    }
  });

  it('produces a distinct account per role', () => {
    const keys = deriveAccounts().map(a => a.publicKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('produces valid ed25519 public keys and secrets', () => {
    for (const account of deriveAccounts()) {
      expect(StrKey.isValidEd25519PublicKey(account.publicKey)).toBe(true);
      expect(StrKey.isValidEd25519SecretSeed(account.secret)).toBe(true);
    }
  });

  it('covers every role in the roster with no gaps', () => {
    const accounts = deriveAccounts();
    expect(accounts).toHaveLength(ROLES.length);
    expect(accounts.map(a => a.role).sort()).toEqual(ROLES.map(r => r.role).sort());
  });

  it('gives every role a unique env var name', () => {
    const envKeys = ROLES.map(r => r.envKey);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  it('keeps exactly the intended accounts trustline-less', () => {
    // The no-trustline fixtures are load-bearing for the payout-failure test.
    const withoutTrustline = ROLES.filter(r => !r.trustline).map(r => r.role);
    expect(withoutTrustline.sort()).toEqual(['issuer', 'sellerNoTrustline']);
  });
});

describe('deterministic contract id', () => {
  it('is stable across calls', () => {
    const admin = accountMap().admin.publicKey;
    expect(precomputeContractId(admin, LOCAL_NETWORK_PASSPHRASE)).toBe(
      precomputeContractId(admin, LOCAL_NETWORK_PASSPHRASE),
    );
  });

  it('matches the frozen id verified against a live deploy', () => {
    expect(precomputeContractId(accountMap().admin.publicKey, LOCAL_NETWORK_PASSPHRASE)).toBe(
      EXPECTED_CONTRACT_ID,
    );
  });

  it('produces a valid contract strkey', () => {
    expect(StrKey.isValidContract(EXPECTED_CONTRACT_ID)).toBe(true);
  });

  it('changes when the network changes', () => {
    // Proof the network id is genuinely part of the preimage — a contract id
    // that ignored the network would collide across chains.
    const admin = accountMap().admin.publicKey;
    expect(precomputeContractId(admin, 'Test SDF Network ; September 2015')).not.toBe(
      EXPECTED_CONTRACT_ID,
    );
  });

  it('changes when the deployer changes', () => {
    const { buyer, admin } = accountMap();
    expect(precomputeContractId(buyer.publicKey, LOCAL_NETWORK_PASSPHRASE)).not.toBe(
      precomputeContractId(admin.publicKey, LOCAL_NETWORK_PASSPHRASE),
    );
  });

  it('changes when the salt changes', () => {
    const admin = accountMap().admin.publicKey;
    const otherSalt = Buffer.alloc(32, 7);
    expect(precomputeContractId(admin, LOCAL_NETWORK_PASSPHRASE, otherSalt)).not.toBe(
      EXPECTED_CONTRACT_ID,
    );
  });

  it('rejects a salt that is not 32 bytes', () => {
    const admin = accountMap().admin.publicKey;
    expect(() => precomputeContractId(admin, LOCAL_NETWORK_PASSPHRASE, Buffer.alloc(16))).toThrow(
      /32 bytes/,
    );
  });
});

describe('primitives', () => {
  it('derives a 32-byte network id and salt', () => {
    expect(networkId(LOCAL_NETWORK_PASSPHRASE)).toHaveLength(32);
    expect(contractSalt()).toHaveLength(32);
  });

  it('derives different network ids for different passphrases', () => {
    expect(networkId(LOCAL_NETWORK_PASSPHRASE).toString('hex')).not.toBe(
      networkId('Test SDF Network ; September 2015').toString('hex'),
    );
  });
});
