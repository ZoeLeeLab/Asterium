// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error Node build configuration is a standalone JavaScript module.
import { betaInstallerConfiguration } from '../../scripts/windows-installer-config.mjs';
import path from 'node:path';

describe('Beta Windows installer channel', () => {
  const create = (commit = 'a'.repeat(40), version = '0.1.0-beta.1') => betaInstallerConfiguration({ projectRoot: path.resolve('.'), outputDirectory: path.resolve('synthetic-output'), version, commit, electronVersion: '44.2.0' });
  it('keeps installation identity fixed across commits and Beta versions', () => {
    const first = create(), next = create('b'.repeat(40), '0.1.0-beta.2');
    expect(first.appId).toBe('Asterium.Beta'); expect(next.appId).toBe(first.appId); expect(next.nsis.guid).toBe(first.nsis.guid);
    expect(next.win.artifactName).not.toBe(first.win.artifactName);
  });
  it('requires current-user installation and retains application data', () => {
    expect(create().nsis).toMatchObject({ perMachine: false, allowElevation: false, packElevateHelper: false, deleteAppDataOnUninstall: false, runAfterFinish: false, createDesktopShortcut: false });
    expect(create().publish).toBeNull();
  });
  it('rejects an unbound commit and a version from the old candidate channel', () => {
    expect(() => create('future')).toThrow('EXISTING_BUILD_COMMIT_REQUIRED');
    expect(() => create('a'.repeat(40), '0.1.0')).toThrow('BETA_VERSION_REQUIRED');
  });
});
