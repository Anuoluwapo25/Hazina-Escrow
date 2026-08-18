import { describe, expect, it, beforeEach, vi } from 'vitest';
import { initEnv } from './env';

const createWalletMock = vi.fn();
const connectWalletMock = vi.fn();

vi.mock('passkey-kit', () => ({
  PasskeyKit: vi.fn().mockImplementation(() => ({
    createWallet: createWalletMock,
    connectWallet: connectWalletMock,
  })),
}));

import {
  isPasskeySupported,
  getStoredPasskeyWallet,
  clearStoredPasskeyWallet,
  createPasskeyWallet,
  connectPasskeyWallet,
  createOrConnectPasskeyWallet,
} from './passkeyWallet';

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('passkeyWallet', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PASSKEY_WALLET_WASM_HASH', 'a'.repeat(64));
    initEnv();
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  describe('isPasskeySupported', () => {
    it('returns false when the browser has no PublicKeyCredential', async () => {
      vi.stubGlobal('PublicKeyCredential', undefined);
      expect(await isPasskeySupported()).toBe(false);
    });

    it('returns false when the platform authenticator check throws', async () => {
      vi.stubGlobal('PublicKeyCredential', {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockRejectedValue(new Error('nope')),
      });
      expect(await isPasskeySupported()).toBe(false);
    });

    it('returns true when a platform authenticator is available', async () => {
      vi.stubGlobal('PublicKeyCredential', {
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
      });
      expect(await isPasskeySupported()).toBe(true);
    });
  });

  describe('storage helpers', () => {
    it('returns null when nothing is stored', () => {
      expect(getStoredPasskeyWallet()).toBeNull();
    });

    it('returns null for malformed stored data', () => {
      window.localStorage.setItem('hazina:passkeyWallet', '{"garbage":true}');
      expect(getStoredPasskeyWallet()).toBeNull();
    });

    it('round-trips a stored wallet and clears it', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
      createWalletMock.mockResolvedValue({
        keyIdBase64: 'key-1',
        contractId: CONTRACT_ID,
        signedTx: 'AAAA...',
      });

      await createPasskeyWallet('buyer-1');
      expect(getStoredPasskeyWallet()).toEqual({ keyId: 'key-1', contractId: CONTRACT_ID });

      clearStoredPasskeyWallet();
      expect(getStoredPasskeyWallet()).toBeNull();
    });
  });

  describe('createPasskeyWallet', () => {
    it('relays the signed deploy carrier to the backend and persists the mapping', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
      vi.stubGlobal('fetch', fetchMock);
      createWalletMock.mockResolvedValue({
        keyIdBase64: 'key-abc',
        contractId: CONTRACT_ID,
        signedTx: 'AAAAdeploy...',
      });

      const result = await createPasskeyWallet('buyer-42');

      expect(result).toEqual({ keyId: 'key-abc', contractId: CONTRACT_ID });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('/wallet/passkey/deploy');
      expect(JSON.parse(init.body)).toEqual({ xdr: 'AAAAdeploy...' });
      expect(getStoredPasskeyWallet()).toEqual({ keyId: 'key-abc', contractId: CONTRACT_ID });
    });

    it('throws when the backend relay rejects the deploy', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'rate limited' }) }),
      );
      createWalletMock.mockResolvedValue({
        keyIdBase64: 'key-x',
        contractId: CONTRACT_ID,
        signedTx: 'AAAA...',
      });

      await expect(createPasskeyWallet('buyer-1')).rejects.toThrow('rate limited');
      expect(getStoredPasskeyWallet()).toBeNull();
    });
  });

  describe('connectPasskeyWallet', () => {
    it('reconnects using the stored keyId when a wallet is already stored', async () => {
      window.localStorage.setItem(
        'hazina:passkeyWallet',
        JSON.stringify({ keyId: 'stored-key', contractId: CONTRACT_ID }),
      );
      connectWalletMock.mockResolvedValue({ keyIdBase64: 'stored-key', contractId: CONTRACT_ID });

      const result = await connectPasskeyWallet();

      expect(connectWalletMock).toHaveBeenCalledWith({ keyId: 'stored-key' });
      expect(result).toEqual({ keyId: 'stored-key', contractId: CONTRACT_ID });
    });

    it('runs a full discovery ceremony for recovery when nothing is stored', async () => {
      connectWalletMock.mockResolvedValue({
        keyIdBase64: 'recovered-key',
        contractId: CONTRACT_ID,
      });

      const result = await connectPasskeyWallet();

      expect(connectWalletMock).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({ keyId: 'recovered-key', contractId: CONTRACT_ID });
      expect(getStoredPasskeyWallet()).toEqual({ keyId: 'recovered-key', contractId: CONTRACT_ID });
    });
  });

  describe('createOrConnectPasskeyWallet', () => {
    it('creates a new wallet when none is stored', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
      createWalletMock.mockResolvedValue({
        keyIdBase64: 'new-key',
        contractId: CONTRACT_ID,
        signedTx: 'AAAA...',
      });

      await createOrConnectPasskeyWallet('buyer-99');

      expect(createWalletMock).toHaveBeenCalled();
      expect(connectWalletMock).not.toHaveBeenCalled();
    });

    it('reconnects the existing wallet when one is already stored', async () => {
      window.localStorage.setItem(
        'hazina:passkeyWallet',
        JSON.stringify({ keyId: 'existing-key', contractId: CONTRACT_ID }),
      );
      connectWalletMock.mockResolvedValue({ keyIdBase64: 'existing-key', contractId: CONTRACT_ID });

      await createOrConnectPasskeyWallet('buyer-99');

      expect(connectWalletMock).toHaveBeenCalled();
      expect(createWalletMock).not.toHaveBeenCalled();
    });
  });
});
