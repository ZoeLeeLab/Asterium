import { createTestState } from './fixtures/applicationState';
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeEach, onTestFailed } from 'vitest';
import { cleanup } from '@testing-library/react';
import { beginAutoTestWorker, beginAutoTestCase, endAutoTestCase, setAutoTestFailureProbe, markAutoTestFailure, finishAutoTestWorker, type AutoTestRun } from './helpers/autoTest.mjs';

beginAutoTestWorker({ root: process.env.ASTERIUM_AUTOTEST_RUN_ROOT!, token: process.env.ASTERIUM_AUTOTEST_RUN_TOKEN! } as AutoTestRun, process.env.VITEST_POOL_ID ?? 'vitest', true);
beforeEach(context => {
  beginAutoTestCase();
  setAutoTestFailureProbe(() => context.task.result?.state === 'fail');
  onTestFailed(() => markAutoTestFailure());
});
afterAll(async () => { await finishAutoTestWorker(); });

if (typeof window !== 'undefined') Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

if (typeof HTMLElement !== 'undefined') Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  writable: true,
  value: () => undefined,
});

afterEach(() => {
  cleanup();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  endAutoTestCase();
});

// Tests opt into synthetic state; the application itself always starts empty.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('asterium.prototype.v7', JSON.stringify(createTestState()));
});
