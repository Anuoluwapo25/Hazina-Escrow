import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getQuote, parseToStroops, formatFromStroops, verifyQuoteSignature } from '../quote.service';

vi.mock('../../common/storage', () => ({
  getDataset: vi.fn().mockResolvedValue({
    id: 'ds-123',
    pricePerQuery: 1.5, // 1.5 USDC
    paymentToken: 'USDC',
  }),
}));

const mockStrictReceivePathsCall = vi.fn();
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class {
        strictReceivePaths = vi.fn(() => ({
          call: mockStrictReceivePathsCall,
        }));
      }
    }
  };
});

describe('quote.service', () => {
  beforeEach(() => {
    mockStrictReceivePathsCall.mockReset();
  });

  it('correctly parses and formats stroops without float drift', () => {
    expect(parseToStroops('1.5')).toBe(15000000n);
    expect(parseToStroops('1.0000001')).toBe(10000001n);
    expect(parseToStroops('0.1234567')).toBe(1234567n);
    
    expect(formatFromStroops(15000000n)).toBe('1.5');
    expect(formatFromStroops(10000001n)).toBe('1.0000001');
    expect(formatFromStroops(1234567n)).toBe('0.1234567');
  });

  it('rejects quotes when no path is found', async () => {
    mockStrictReceivePathsCall.mockResolvedValue({ records: [] });
    
    await expect(getQuote('ds-123', 'EURC')).rejects.toThrow('No path found');
  });

  it('rejects quotes with excessive slippage (deviation > 20%)', async () => {
    mockStrictReceivePathsCall.mockResolvedValue({
      records: [
        {
          source_amount: '30.0000000', // 1.5 USDC costing 30 XLM. Normal is ~15 XLM. Deviation is 100%.
          path: [],
        }
      ]
    });
    
    await expect(getQuote('ds-123', 'XLM')).rejects.toThrow('Implied price deviates too much');
  });

  it('generates a valid signed quote with 1% slippage buffer', async () => {
    // 1.5 USDC cost 15 XLM exactly in our fixture
    mockStrictReceivePathsCall.mockResolvedValue({
      records: [
        {
          source_amount: '15.0000000',
          path: [{ asset_type: 'native' }],
        }
      ]
    });
    
    const quote = await getQuote('ds-123', 'XLM');
    
    // 15 XLM + 1% slippage = 15.15 XLM
    expect(quote.source.maxAmount).toBe('15.15');
    expect(quote.destination.amount).toBe('1.5');
    
    // Verify signature
    expect(verifyQuoteSignature(quote)).toBe(true);
  });
});
