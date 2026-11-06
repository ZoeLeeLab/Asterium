import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { autoTestReporter, vitestAutoTestRun } from './tests/autoTestReporter';

const { run, env } = vitestAutoTestRun();

export default defineConfig({
  plugins: [react()],
  cacheDir: path.join(run.root, 'vite-cache'),
  test: {
    env,
    bail: 1,
    maxConcurrency: 1,
    sequence: { hooks: 'stack' },
    reporters: ['default', autoTestReporter(run, !process.argv.includes('run'))],
    exclude: [...configDefaults.exclude, 'out/**', '.qa/**', '.vite/**'],
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: true,
    coverage: { reportsDirectory: path.join(run.root, 'coverage') },
  },
});
