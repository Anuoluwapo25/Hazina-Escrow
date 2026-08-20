import express, { Request, Response } from 'express';
import { readStore } from './common/storage';
import { requireSellerReadAuth } from './common/auth.middleware';

export const analyticsRouter = express.Router();

type SeriesPoint = { date: string; usdc?: number; count?: number };

const dayKey = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 10);

function lastNDays(days: number): string[] {
  const result: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

analyticsRouter.get(
  '/seller/:wallet',
  requireSellerReadAuth,
  async (req: Request, res: Response) => {
    const wallet = req.params.wallet;
    const store = await readStore();
    const sellerDatasets = store.datasets.filter(dataset => dataset.sellerWallet === wallet);
    const datasetById = new Map(sellerDatasets.map(dataset => [dataset.id, dataset]));
    const sellerTransactions = store.transactions.filter(transaction =>
      datasetById.has(transaction.datasetId),
    );

    const days = lastNDays(30);
    const revenueByDay = new Map(days.map(date => [date, 0]));
    const volumeByDay = new Map(days.map(date => [date, 0]));
    const buyerCounts = new Map<string, number>();

    for (const transaction of sellerTransactions) {
      const date = dayKey(transaction.timestamp);
      if (revenueByDay.has(date)) {
        const currentRevenue = revenueByDay.get(date) ?? 0;
        const currentVolume = volumeByDay.get(date) ?? 0;
        revenueByDay.set(date, Number((currentRevenue + transaction.amount * 0.95).toFixed(7)));
        volumeByDay.set(date, currentVolume + 1);
      }

      const buyerId = transaction.buyerWallet ?? transaction.txHash;
      if (buyerId) {
        buyerCounts.set(buyerId, (buyerCounts.get(buyerId) ?? 0) + 1);
      }
    }

    const datasetBreakdown = sellerDatasets
      .map(dataset => {
        const transactions = sellerTransactions.filter(tx => tx.datasetId === dataset.id);
        return {
          id: dataset.id,
          name: dataset.name,
          earned: Number(transactions.reduce((sum, tx) => sum + tx.amount * 0.95, 0).toFixed(7)),
          queries: transactions.length,
        };
      })
      .sort((a, b) => b.earned - a.earned || b.queries - a.queries);

    const topBuyers = [...buyerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([walletOrHash, count]) => ({ wallet: walletOrHash, count }));

    const revenueSeries: SeriesPoint[] = days.map(date => ({
      date,
      usdc: revenueByDay.get(date) ?? 0,
    }));
    const queryVolumeSeries: SeriesPoint[] = days.map(date => ({
      date,
      count: volumeByDay.get(date) ?? 0,
    }));

    res.json({ success: true, revenueSeries, queryVolumeSeries, datasetBreakdown, topBuyers });
  },
);
