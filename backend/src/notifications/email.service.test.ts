import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendSellerNotificationEmail } from './email.service';

const notification = {
  to: 'seller@example.com',
  datasetName: 'Whale "Signals"',
  amount: 1,
  sellerAmount: 0.95,
  txHash: 'stellar-tx-hash',
  timestamp: '2026-06-19T12:00:00.000Z',
};

describe('sendSellerNotificationEmail', () => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFromEmail = process.env.RESEND_FROM_EMAIL;

  beforeEach(() => {
    sendMock.mockReset();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;

    if (originalFromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = originalFromEmail;
  });

  it('skips silently when RESEND_API_KEY is absent', async () => {
    delete process.env.RESEND_API_KEY;

    await expect(sendSellerNotificationEmail(notification)).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends the seller earnings notification through Resend', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'Hazina <notifications@hazina.example>';
    sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendSellerNotificationEmail(notification);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Hazina <notifications@hazina.example>',
        to: 'seller@example.com',
        subject: 'Your dataset "Whale "Signals"" was queried — 1 USDC earned',
        text: expect.stringContaining('You earned 0.95 USDC'),
      }),
    );
  });

  it('labels the earnings with the dataset payment token', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    sendMock.mockResolvedValue({ data: { id: 'email-2' }, error: null });

    await sendSellerNotificationEmail({ ...notification, paymentToken: 'EURC' });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Your dataset "Whale "Signals"" was queried — 1 EURC earned',
        text: expect.stringContaining('You earned 0.95 EURC'),
        html: expect.stringContaining('0.95 EURC'),
      }),
    );
  });

  it('throws when Resend returns an API error', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    sendMock.mockResolvedValue({ data: null, error: { message: 'delivery rejected' } });

    await expect(sendSellerNotificationEmail(notification)).rejects.toThrow(
      'Resend email failed: delivery rejected',
    );
  });
});
