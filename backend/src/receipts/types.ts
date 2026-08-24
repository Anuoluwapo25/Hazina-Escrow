/**
 * Receipt types for verifiable delivery receipts.
 */

export type ReceiptAnchorMode = 'direct' | 'batched';

export type ReceiptAnchorStatus =
  'NOT_ANCHORED_YET' | 'ANCHORING' | 'ANCHORED' | 'ANCHOR_FAILED' | 'VERIFIED' | 'MISMATCH';

export interface Receipt {
  id: string;
  datasetId: string;
  buyer: string;
  seller: string;
  amount: number;
  paymentToken: string;
  txHash: string;
  leafHash: string;
  receiptHash: string;
  anchorMode: ReceiptAnchorMode;
  anchorStatus: ReceiptAnchorStatus;
  anchorTxHash?: string;
  merkleRoot?: string;
  merkleIndex?: number;
  merkleProof?: (string | null)[];
  deliveredAt: string;
  anchoredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptMerkleProof {
  leafIndex: number;
  leafHash: string;
  siblings: (string | null)[];
  root: string;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  receiptHashMatches: boolean;
  merkleProofValid?: boolean;
  anchorVerified?: boolean;
  anchorTxHash?: string;
  status: ReceiptAnchorStatus;
  error?: string;
}

export interface ReceiptDeliveryPayload {
  receiptId: string;
  hash: string;
}

export interface ReceiptApiResponse {
  receipt: Receipt;
  merkleProof?: ReceiptMerkleProof;
  verificationUrl?: string;
}

export interface ReceiptCreateInput {
  datasetId: string;
  buyer: string;
  seller: string;
  amount: number;
  paymentToken: string;
  txHash: string;
  deliveredAt: string;
  anchorMode: ReceiptAnchorMode;
  datasetPayload: Record<string, unknown>;
}
