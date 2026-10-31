import { createTestState } from './fixtures/applicationState';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
});

// Tests opt into synthetic state; the application itself always starts empty.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('asterium.prototype.v7', JSON.stringify(createTestState()));
});
