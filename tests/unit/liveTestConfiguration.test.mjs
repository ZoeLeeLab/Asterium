// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { requireLiveTestSource } from '../helpers/liveTestConfiguration.mjs';

describe('explicit live test configuration', () => {
  it('rejects a missing opt-in even if a source is supplied', () => {
    expect(() => requireLiveTestSource({ ASTERIUM_API_SMOKE_SOURCE_USER_DATA: path.resolve('fixture-data') })).toThrow('ASTERIUM_API_LIVE_SMOKE');
  });
  it('does not infer a test source from the personal profile', () => {
    expect(() => requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', APPDATA: path.resolve('personal-profile') })).toThrow('ASTERIUM_API_SMOKE_SOURCE_USER_DATA');
    expect(() => requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', ASTERIUM_API_SMOKE_SOURCE_USER_DATA: 'relative' })).toThrow('absolute');
  });
  it('uses only the explicitly authorized source', () => {
    const selected = path.resolve('test-only-profile');
    expect(requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', ASTERIUM_API_SMOKE_SOURCE_USER_DATA: selected })).toBe(selected);
  });
});
