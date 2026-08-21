import { z } from 'zod';

/**
 * WebSocket message types for real-time transaction updates
 */

// Server-sent event types
export const TransactionStatusSchema = z.enum([
  'pending',
  'verifying',
  'verified',
  'delivery_pending',
  'delivery_failed',
  'completed',
  'failed',
  'refunded',
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const TransactionUpdateEventSchema = z.object({
  type: z.literal('transaction:update'),
  data: z.object({
    transactionId: z.string().uuid(),
    datasetId: z.string(),
    status: TransactionStatusSchema,
    amount: z.string(), // Big number as string
    buyerQuery: z.string().optional(),
    aiSummary: z.string().optional(),
    deliveryStatus: z.enum(['pending', 'delivered', 'failed', 'manual_review_needed']).optional(),
    timestamp: z.string().datetime(),
    error: z.string().optional(),
  }),
});
export type TransactionUpdateEvent = z.infer<typeof TransactionUpdateEventSchema>;

export const PaymentReceivedEventSchema = z.object({
  type: z.literal('payment:received'),
  data: z.object({
    transactionId: z.string().uuid(),
    datasetId: z.string(),
    amount: z.string(),
    timestamp: z.string().datetime(),
  }),
});
export type PaymentReceivedEvent = z.infer<typeof PaymentReceivedEventSchema>;

export const PaymentForwardedEventSchema = z.object({
  type: z.literal('payment:forwarded'),
  data: z.object({
    transactionId: z.string().uuid(),
    datasetId: z.string(),
    sellerAmount: z.string(),
    platformAmount: z.string(),
    timestamp: z.string().datetime(),
  }),
});
export type PaymentForwardedEvent = z.infer<typeof PaymentForwardedEventSchema>;

export const DatasetQueryEventSchema = z.object({
  type: z.literal('dataset:queried'),
  data: z.object({
    transactionId: z.string().uuid(),
    datasetId: z.string(),
    queryCount: z.number().int().positive(),
    timestamp: z.string().datetime(),
  }),
});
export type DatasetQueryEvent = z.infer<typeof DatasetQueryEventSchema>;

// Client-sent message types
export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  datasetIds: z.array(z.string()).optional(),
  transactionIds: z.array(z.string()).optional(),
  token: z.string().optional(), // Optional auth token
});
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  datasetIds: z.array(z.string()).optional(),
  transactionIds: z.array(z.string()).optional(),
});
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
});
export type PingMessage = z.infer<typeof PingMessageSchema>;

// Union of all server events
export const ServerEventSchema = z.union([
  TransactionUpdateEventSchema,
  PaymentReceivedEventSchema,
  PaymentForwardedEventSchema,
  DatasetQueryEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// Union of all client messages
export const ClientMessageSchema = z.union([
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// Pong response
export const PongMessageSchema = z.object({
  type: z.literal('pong'),
});
export type PongMessage = z.infer<typeof PongMessageSchema>;

// Error response
export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  code: z.string().optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
