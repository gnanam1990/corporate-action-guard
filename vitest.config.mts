import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/{api,worker}/test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          // Integration tests touch a real PostgreSQL instance; keep them serial.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
