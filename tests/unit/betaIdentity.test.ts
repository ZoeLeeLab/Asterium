// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { betaUserDataDirectory } from '../../src/main/settings/betaIdentity';
import { APP_VERSION, BETA_APP_ID } from '../../src/shared/appRelease';
import packageInfo from '../../package.json';

describe('Beta installation identity', () => {
  it('uses a fixed independent data folder instead of the old application profile', () => {
    const base = path.resolve('synthetic-appdata');
    expect(betaUserDataDirectory(base)).toBe(path.join(base, 'Asterium-Beta'));
    expect(betaUserDataDirectory(base)).not.toBe(path.join(base, 'Asterium'));
    expect(BETA_APP_ID).toBe('Asterium.Beta');
  });
  it('preserves an explicit isolated test directory', () => {
    const explicit = path.resolve('synthetic-test-profile');
    expect(betaUserDataDirectory(path.resolve('synthetic-appdata'), explicit)).toBe(explicit);
  });
  it('shows the package version without maintaining a second version literal', () => {
    expect(APP_VERSION).toBe(packageInfo.version);
  });
});
