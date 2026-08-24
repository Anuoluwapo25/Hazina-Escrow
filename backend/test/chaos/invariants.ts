import { getDataset, getTransactionsByDataset } from '../../src/common/storage';

/**
 * Validates the invariants of the database state.
 * These checks should pass regardless of how many faults were injected,
 * provided the system correctly rolls back or achieves eventual consistency.
 */
export async function validateInvariants(datasetId: string) {
  const dataset = await getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found');

  const transactions = await getTransactionsByDataset(datasetId);

  // Invariant 1: Total earned should exactly match the sum of all successful seller payouts
  // (Note: in demo mode or for failed deliveries, sellerReceived might be 0)
  let sumEarned = 0;
  for (const tx of transactions) {
    if (tx.sellerReceived) {
      sumEarned += tx.sellerReceived;
    }
  }

  // Handle floating point imprecision
  if (Math.abs(dataset.totalEarned - sumEarned) > 1e-7) {
    throw new Error(`Invariant Violation: Dataset totalEarned (${dataset.totalEarned}) != Sum of tx sellerReceived (${sumEarned})`);
  }

  // Invariant 2: No double spends. txHash should be strictly unique.
  const txHashes = new Set<string>();
  for (const tx of transactions) {
    if (txHashes.has(tx.txHash)) {
      throw new Error(`Invariant Violation: Double spend detected for txHash ${tx.txHash}`);
    }
    txHashes.add(tx.txHash);
  }

  // Invariant 3: queriesServed should match the number of delivered transactions + demo transactions
  // This depends on the exact logic of the app, but typically successful non-demo deliveries increment it.
  const successfulDeliveries = transactions.filter(t => t.sellerReceived && t.sellerReceived > 0).length;
  // If queriesServed tracks ONLY successful deliveries, it should match. (Adjust logic if demo queries also increment it).
  if (dataset.queriesServed < successfulDeliveries) {
    throw new Error(`Invariant Violation: queriesServed (${dataset.queriesServed}) is less than successful deliveries (${successfulDeliveries})`);
  }

  return true;
}
