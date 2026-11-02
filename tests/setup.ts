import { afterEach, beforeEach, vi } from 'vitest';

// A real request is always a test failure, regardless of developer environment.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in unit tests. Inject a mocked fetch.'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
