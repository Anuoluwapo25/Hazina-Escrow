# Chaos Testing Suite

A fault-injection testing suite for Hazina Escrow's payment pipeline to ensure robustness against network failures, timeouts, and database drops.

## Overview

The Chaos Testing Suite provides tools to systematically inject faults into critical paths of the application, particularly `processPayment` and `processEscrowPayment`.

The suite is comprised of three main components:
1. **Fault Injector (`backend/test/chaos/inject.ts`)**: A utility class to intercept and fail operations.
2. **Invariants Checker (`backend/test/chaos/invariants.ts`)**: A set of rules that must hold true after any chaos scenario (e.g. no double spends, total earned matches successful payouts).
3. **Scenarios (`backend/test/chaos/scenarios.ts`)**: Predefined tests simulating real-world instability.

## Scenarios

- **Horizon Timeout + Retry**: Simulates Stellar Horizon timing out on transaction submission/verification. Validates that the system safely aborts and handles retries without double counting.
- **Concurrent same-txHash requests**: Simulates an attacker sending multiple simultaneous requests with the same transaction hash. Validates idempotency (no double spends).
- **DB Drop Mid-Delivery**: Simulates the database connection dropping while marking a transaction as 'delivered' or updating the dataset earnings.

## Usage

You can run the chaos scenarios using:
```bash
npx vitest backend/test/chaos/scenarios.ts
```
*(Requires test configuration to hook `faultInjector.check()` calls into the application layer or mocking the storage/stellar layers.)*

## Implementing Checks

To make your code chaos-aware, import the singleton `faultInjector` and call `check(operationName)` at critical paths:

```typescript
import { faultInjector } from '../test/chaos/inject';

// Example inside processPayment
await faultInjector.check('db_read_tx');
let existing = await getTransactionByHash(txHash);
```

For tests, simply configure probabilities:
```typescript
faultInjector.inject('db_read_tx', { type: 'mock_delay', probability: 0.5, delayMs: 100 });
```
