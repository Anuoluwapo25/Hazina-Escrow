/**
 * WebSocket message types for real-time transaction updates
 * This file mirrors the backend types for type safety on the frontend
 */

// Transaction status types
export type TransactionStatus =
  | 'pending'
  | 'verifying'
  | 'verified'
  | 'delivery_pending'
  | 'delivery_failed'
  | 'completed'
  | 'failed'
  | 'refunded';

// Server-sent events
export interface TransactionUpdateEvent {
  type: 'transaction:update';
  data: {
    transactionId: string;
    datasetId: string;
    status: TransactionStatus;
    amount: string;
    buyerQuery?: string;
    aiSummary?: string;
    deliveryStatus?: 'pending' | 'delivered' | 'failed';
    timestamp: string;
    error?: string;
  };
}

export interface PaymentReceivedEvent {
  type: 'payment:received';
  data: {
    transactionId: string;
    datasetId: string;
    amount: string;
    timestamp: string;
  };
}

export interface PaymentForwardedEvent {
  type: 'payment:forwarded';
  data: {
    transactionId: string;
    datasetId: string;
    sellerAmount: string;
    platformAmount: string;
    timestamp: string;
  };
}

export interface DatasetQueryEvent {
  type: 'dataset:queried';
  data: {
    transactionId: string;
    datasetId: string;
    queryCount: number;
    timestamp: string;
  };
}

// Union of all server events
export type ServerEvent =
  | TransactionUpdateEvent
  | PaymentReceivedEvent
  | PaymentForwardedEvent
  | DatasetQueryEvent;

// Client messages (for reference, not used in frontend hook)
export interface SubscribeMessage {
  type: 'subscribe';
  datasetIds?: string[];
  transactionIds?: string[];
  token?: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  datasetIds?: string[];
  transactionIds?: string[];
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;
