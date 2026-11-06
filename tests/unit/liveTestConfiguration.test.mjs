// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { testRmSync } from '../helpers/autoTest.mjs';
import { requireLiveTestSource } from '../helpers/liveTestConfiguration.mjs';

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) testRmSync(directory, { recursive: true }); });

describe('explicit live test configuration', () => {
  it('rejects a missing opt-in even if a source is supplied', () => {
    expect(() => requireLiveTestSource({ ASTERIUM_API_SMOKE_SOURCE_USER_DATA: path.resolve('fixture-data') })).toThrow('ASTERIUM_API_LIVE_SMOKE');
  });
  it('does not infer a test source from the personal profile', () => {
    expect(() => requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', APPDATA: path.resolve('personal-profile') })).toThrow('ASTERIUM_API_SMOKE_SOURCE_USER_DATA');
    expect(() => requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', ASTERIUM_API_SMOKE_SOURCE_USER_DATA: 'relative' })).toThrow('absolute');
  });
  it('uses only the explicitly authorized source', () => {
    const selected = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'live-test-source-'))); temporary.push(selected);
    writeFileSync(path.join(selected, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'acceptance' }));
    expect(requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', ASTERIUM_API_SMOKE_SOURCE_USER_DATA: selected })).toBe(selected);
    writeFileSync(path.join(selected, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'daily' }));
    expect(() => requireLiveTestSource({ ASTERIUM_API_LIVE_SMOKE: '1', ASTERIUM_API_SMOKE_SOURCE_USER_DATA: selected })).toThrow('daily and dev');
  });
});
