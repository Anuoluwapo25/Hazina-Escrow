import { afterEach, describe, expect, it } from 'vitest';
import { validateEscrowConfig } from './stellar.config';

const ORIGINAL = process.env.ESCROW_CONTRACT_ID;

describe('validateEscrowConfig', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.ESCROW_CONTRACT_ID;
    } else {
      process.env.ESCROW_CONTRACT_ID = ORIGINAL;
    }
  });

  it('does not throw when ESCROW_CONTRACT_ID is unset (legacy custodial demo mode)', () => {
    delete process.env.ESCROW_CONTRACT_ID;
    expect(() => validateEscrowConfig()).not.toThrow();
  });

  it('does not throw when ESCROW_CONTRACT_ID is a well-formed contract address', () => {
    process.env.ESCROW_CONTRACT_ID = 'CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU';
    expect(() => validateEscrowConfig()).not.toThrow();
  });

  it('throws when ESCROW_CONTRACT_ID is set but malformed', () => {
    process.env.ESCROW_CONTRACT_ID = 'not-a-contract-address';
    expect(() => validateEscrowConfig()).toThrow(/ESCROW_CONTRACT_ID/);
  });

  it('throws when ESCROW_CONTRACT_ID is a Stellar account (G…) address instead of a contract (C…) address', () => {
    process.env.ESCROW_CONTRACT_ID = 'GBVNKDPGVZGFKGRHDUBSZ5V7PXY6PJRFYF5RYVBKAHV3BUXHQWCFXBZ';
    expect(() => validateEscrowConfig()).toThrow(/ESCROW_CONTRACT_ID/);
  });
});
