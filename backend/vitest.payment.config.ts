import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

const socketTestsEnabled = process.env.ALLOW_SOCKET_TESTS === '1';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: socketTestsEnabled
        ? [
            'src/common/storage.test.ts',
            'src/payments/stellar.service.test.ts',
            'src/payments/payments.integration.test.ts',
            'src/payments/__tests__/payments.router.test.ts',
          ]
        : [
            'src/common/storage.test.ts',
            'src/payments/stellar.service.test.ts',
            'src/payments/__tests__/payments.router.test.ts',
          ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary', 'html'],
        include: socketTestsEnabled
          ? ['src/payments/payments.router.ts', 'src/payments/stellar.service.ts']
          : ['src/payments/stellar.service.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts', 'src/webhooks/**'],
        thresholds: {
          lines: 70,
          functions: 55,
          branches: 80,
          statements: 70,
        },
      },
    },
  }),
);
