import { Resend } from 'resend';

export interface SellerNotificationEmail {
  to: string;
  datasetName: string;
  amount: number;
  sellerAmount: number;
  txHash: string;
  timestamp: string;
  paymentToken?: string; // defaults to USDC
}

function formatAmount(amount: number): string {
  return amount.toFixed(4).replace(/\.?0+$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendSellerNotificationEmail(
  notification: SellerNotificationEmail,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const resend = new Resend(apiKey);
  const sellerAmount = formatAmount(notification.sellerAmount);
  const queryAmount = formatAmount(notification.amount);
  const token = notification.paymentToken || 'USDC';
  const timestamp = new Date(notification.timestamp).toISOString();
  const subject = `Your dataset "${notification.datasetName}" was queried — ${queryAmount} ${token} earned`;
  const body = `A buyer queried your dataset at ${timestamp}. You earned ${sellerAmount} ${token} (tx: ${notification.txHash}).`;

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Hazina <onboarding@resend.dev>',
    to: notification.to,
    subject,
    text: body,
    html:
      `<p>A buyer queried your dataset at ${escapeHtml(timestamp)}.</p>` +
      `<p>You earned <strong>${escapeHtml(sellerAmount)} ${escapeHtml(token)}</strong> ` +
      `(query price: ${escapeHtml(queryAmount)} ${escapeHtml(token)}).</p>` +
      `<p>Transaction: <code>${escapeHtml(notification.txHash)}</code></p>`,
  });

  if (error) {
    throw new Error(`Resend email failed: ${error.message}`);
  }
}
