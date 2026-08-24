import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeSellerSignIn, requestChallenge, submitSignedChallenge } from './sep10';
import { getSellerSession, setSellerSession } from './sellerAuth';

vi.mock('./env', () => ({
  getEnv: () => ({ apiUrl: 'http://localhost:3000', apiKey: '', enableDemoMode: false }),
  initEnv: vi.fn(),
}));

vi.mock('./stellarWallets', () => ({
  signWithFreighter: vi.fn(),
}));

import { signWithFreighter } from './stellarWallets';

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeJwt(exp: number): string {
  const b64url = (json: string) =>
    btoa(json).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ exp, sellerWallet: WALLET }),
  )}.signature`;
}

function createFetchResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

describe('sep10 client', () => {
  beforeEach(() => {
    setSellerSession(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    setSellerSession(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests a challenge for an account and home domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        transaction: 'AAAAAA==',
        network_passphrase: 'Test SDF Network',
        expires_at: 1777500000,
        home_domain: 'example.com',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const challenge = await requestChallenge(WALLET, 'example.com');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toContain('/api/v1/auth?');
    expect(String(url)).toContain(`account=${encodeURIComponent(WALLET)}`);
    expect(String(url)).toContain('home_domain=example.com');
    expect(challenge.home_domain).toBe('example.com');
  });

  it('submits a signed challenge and returns the seller JWT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createFetchResponse({
        token: 'jwt-token',
        seller_wallet: WALLET,
        account: WALLET,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitSignedChallenge('SIGNED_XDR', 'example.com');

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string; headers?: Record<string, string> },
    ];
    expect(String(url)).toContain('/api/v1/auth');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      transaction: 'SIGNED_XDR',
      home_domain: 'example.com',
    });
    expect(result.token).toBe('jwt-token');
    expect(result.sellerWallet).toBe(WALLET);
  });

  it('runs the full flow and stores the session in memory', async () => {
    const challengeBody = {
      transaction: 'CHALLENGE_XDR',
      network_passphrase: 'Test SDF Network',
      expires_at: 1777500000,
      home_domain: 'example.com',
    };
    const tokenBody = {
      token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
      seller_wallet: WALLET,
      account: WALLET,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createFetchResponse(challengeBody))
      .mockResolvedValueOnce(createFetchResponse(tokenBody));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(signWithFreighter).mockResolvedValue('SIGNED_XDR');

    const result = await completeSellerSignIn(WALLET);

    expect(signWithFreighter).toHaveBeenCalledWith('CHALLENGE_XDR');
    const session = getSellerSession();
    expect(session?.token).toBe(makeJwt(Math.floor(Date.now() / 1000) + 3600));
    expect(session?.sellerWallet).toBe(WALLET);
    expect(result.sellerWallet).toBe(WALLET);
  });

  it('throws without storing a session when the wallet refuses to sign', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createFetchResponse({
        transaction: 'CHALLENGE_XDR',
        network_passphrase: 'Test SDF Network',
        expires_at: 1777500000,
        home_domain: 'example.com',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(signWithFreighter).mockRejectedValue(new Error('user rejected'));

    await expect(completeSellerSignIn(WALLET)).rejects.toThrow('user rejected');
    expect(getSellerSession()).toBeNull();
  });

  it('throws when the server returns an invalid token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createFetchResponse({
          transaction: 'CHALLENGE_XDR',
          network_passphrase: 'Test SDF Network',
          expires_at: 1777500000,
          home_domain: 'example.com',
        }),
      )
      .mockResolvedValueOnce(
        createFetchResponse({ token: 'not-a-jwt', seller_wallet: WALLET, account: WALLET }),
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(signWithFreighter).mockResolvedValue('SIGNED_XDR');

    await expect(completeSellerSignIn(WALLET)).rejects.toThrow('invalid token');
    expect(getSellerSession()).toBeNull();
  });

  it('propagates backend error bodies with the server message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid signature' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitSignedChallenge('BAD_XDR', 'example.com')).rejects.toThrow(
      'invalid signature',
    );
  });
});
