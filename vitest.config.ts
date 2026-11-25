import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two projects:
//  - "unit": pure, fast, no AWS. Runs in CI and locally by default (`npm test`).
//  - "integration": hits the shared AWS dev table (DD-11), opt-in via
//    `npm run test:integration` with AWS creds + SERVERLESSQ_TABLE_PREFIX=dev-.
export default defineConfig({
  test: {
    projects: [
      {
        // The SPA imports itself through `@/…` (see packages/web/vite.config.ts).
        // Mirrored here so a unit test can import a component without Vite.
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./packages/web/src', import.meta.url)),
          },
        },
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
