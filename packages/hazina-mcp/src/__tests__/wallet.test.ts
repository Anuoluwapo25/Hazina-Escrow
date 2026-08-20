import { describe, expect, it } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { publicKeyFromSecret } from '../wallet.js';

describe('publicKeyFromSecret', () => {
  it('derives the matching public key from a secret', () => {
    const keypair = StellarSdk.Keypair.random();
    expect(publicKeyFromSecret(keypair.secret())).toBe(keypair.publicKey());
  });

  it('throws on a malformed secret rather than silently returning garbage', () => {
    expect(() => publicKeyFromSecret('not-a-real-secret')).toThrow();
  });
});
