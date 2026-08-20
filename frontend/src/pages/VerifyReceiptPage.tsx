import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Anchor,
  FileCheck2,
  ExternalLink,
} from 'lucide-react';
import clsx from 'clsx';
import { api, Receipt, ReceiptMerkleProof, ReceiptVerification } from '../lib/api';
import { truncateAddress } from '../lib/utils';

const ANCHOR_STATUS_LABEL: Record<string, string> = {
  NOT_ANCHORED_YET: 'Not anchored yet',
  ANCHORING: 'Anchoring…',
  ANCHORED: 'Anchored',
  ANCHOR_FAILED: 'Anchor failed',
  VERIFIED: 'Verified',
  MISMATCH: 'Mismatch',
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Public delivery-receipt verification page (#594). Anyone holding a receipt
 * id can confirm the commitment chain: receipt hash, merkle proof against the
 * anchored root, and anchor status. It exposes no payload bytes, only the
 * commitment metadata, so it leaks nothing about the underlying dataset.
 */
export default function VerifyReceiptPage() {
  const { receiptId } = useParams<{ receiptId: string }>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [merkleProof, setMerkleProof] = useState<ReceiptMerkleProof | null>(null);
  const [verification, setVerification] = useState<ReceiptVerification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!receiptId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getReceipt(receiptId);
      setReceipt(result.receipt);
      setMerkleProof(result.merkleProof ?? null);
      setVerification(result.verification);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receipt.');
    } finally {
      setLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const valid = verification?.valid ?? false;

  return (
    <div className="min-h-screen pt-28 pb-20 px-4">
      <Helmet>
        <title>{receipt ? `Receipt ${truncateAddress(receipt.id)}` : 'Receipt verification'}</title>
      </Helmet>
      <div className="max-w-2xl mx-auto">
        <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
          Verifiable delivery receipt
        </p>
        <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground mb-3">
          Delivery Receipt
        </h1>
        <p className="text-foreground-muted font-body mb-8">
          This page is public — anyone holding a receipt id can independently check the commitment
          chain: the receipt hash, the Merkle proof against the anchored root, and the on-chain
          anchor status.
        </p>

        {loading && !receipt && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-gold animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 font-body">
            {error}
          </div>
        )}

        {receipt && (
          <div className="space-y-4">
            <div
              className={clsx(
                'rounded-xl border p-4 flex items-center gap-3',
                valid ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5',
              )}
            >
              {valid ? (
                <ShieldCheck className="w-8 h-8 text-emerald-400 shrink-0" />
              ) : (
                <ShieldAlert className="w-8 h-8 text-red-400 shrink-0" />
              )}
              <div>
                <p
                  className={clsx(
                    'font-display text-lg font-bold',
                    valid ? 'text-emerald-400' : 'text-red-400',
                  )}
                >
                  {valid ? 'Receipt verified' : 'Verification failed'}
                </p>
                <p className="text-xs text-foreground-muted font-body">
                  {valid
                    ? 'All stored commitments are internally consistent.'
                    : 'The commitment chain is broken or unverifiable.'}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-border/40 bg-surface-2/40 p-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Dataset</p>
                  <p className="font-mono text-foreground">{receipt.datasetId}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Delivery time</p>
                  <p className="font-body text-foreground">{fmtTime(receipt.deliveredAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Buyer</p>
                  <p className="font-mono text-xs text-foreground">
                    {truncateAddress(receipt.buyer)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Seller</p>
                  <p className="font-mono text-xs text-foreground">
                    {truncateAddress(receipt.seller)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Amount</p>
                  <p className="font-body text-foreground">
                    {receipt.amount} {receipt.paymentToken}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">Payment</p>
                  <p className="font-mono text-xs text-foreground">
                    {truncateAddress(receipt.txHash)}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/40 bg-surface-2/40 p-4">
              <p className="text-xs text-foreground-muted font-body mb-2 flex items-center gap-1.5">
                <FileCheck2 className="w-3.5 h-3.5" /> Hashes
              </p>
              <div className="space-y-2 text-xs">
                <div>
                  <p className="text-foreground-muted font-body">Leaf hash (delivered payload)</p>
                  <p className="font-mono text-foreground break-all">{receipt.leafHash}</p>
                </div>
                <div>
                  <p className="text-foreground-muted font-body">Receipt hash</p>
                  <p className="font-mono text-foreground break-all">{receipt.receiptHash}</p>
                </div>
                {merkleProof && (
                  <div>
                    <p className="text-foreground-muted font-body">Merkle root</p>
                    <p className="font-mono text-foreground break-all">{merkleProof.root}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border/40 bg-surface-2/40 p-4">
              <p className="text-xs text-foreground-muted font-body mb-2 flex items-center gap-1.5">
                <Anchor className="w-3.5 h-3.5" /> Anchor status
              </p>
              <div className="flex items-center justify-between">
                <span
                  className={clsx(
                    'inline-flex items-center gap-1.5 text-xs font-body font-semibold px-2 py-1 rounded-full',
                    receipt.anchorStatus === 'ANCHORED' || receipt.anchorStatus === 'VERIFIED'
                      ? 'text-emerald-400 bg-emerald-400/10'
                      : 'text-gold bg-gold/10',
                  )}
                >
                  <Anchor className="w-3.5 h-3.5" />
                  {ANCHOR_STATUS_LABEL[receipt.anchorStatus] ?? receipt.anchorStatus}
                </span>
                {verification?.anchorVerified === false &&
                  receipt.anchorStatus === 'NOT_ANCHORED_YET' && (
                    <span className="text-xs text-foreground-muted font-body flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> Waiting for the anchoring worker
                    </span>
                  )}
              </div>
              {receipt.anchorTxHash && (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${receipt.anchorTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-gold hover:underline font-body flex items-center gap-1 mt-3"
                >
                  View anchor transaction <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {verification?.error && (
                <p className="text-xs text-red-400 font-body mt-3">{verification.error}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
