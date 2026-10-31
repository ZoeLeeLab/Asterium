// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertIdentityEvidence, assertOwnedPath, parseOptions, repository, runPoc, selectPocPolicy } from '../../tools/sandbox-s1/runner.mjs';

describe('S1 standalone policy boundary', () => {
  it('does no work by default, even if networking was requested', async () => {
    const launch = vi.fn();
    for (const allowNetwork of [false, true]) {
      const result = await runPoc({ allowNetwork }, { spawnHelper: launch });
      expect(result).toMatchObject({ type: 'not_started', policy: { backend: 'native', reason: 'disabled', network: 'native_unchanged' } });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('Full always selects Native without running either a helper or a native operation', async () => {
    const launch = vi.fn();
    for (const enabled of [false, true]) for (const allowNetwork of [false, true]) for (const testLauncher of [false, true]) {
      expect(await runPoc({ enabled, allowNetwork, testLauncher, permissionMode: 'full' }, { spawnHelper: launch }))
        .toMatchObject({ type: 'not_started', policy: { backend: 'native', reason: 'full', network: 'native_unchanged' } });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('only explicit non-Full execution selects the PoC, and network remains local to that selection', () => {
    for (const permissionMode of ['manual', 'automatic']) {
      expect(selectPocPolicy({ enabled: true, permissionMode })).toMatchObject({ backend: 'sandbox', launchPoc: true, network: 'blocked' });
      expect(selectPocPolicy({ enabled: true, permissionMode, allowNetwork: true })).toMatchObject({ backend: 'sandbox', launchPoc: true, network: 'allowed' });
    }
  });

  it('does not turn read-only or Plan into permission to execute', async () => {
    const launch = vi.fn();
    for (const policy of [{ permissionMode: 'read_only' }, { planMode: 'plan' }]) for (const testLauncher of [false, true]) {
      expect(await runPoc({ enabled: true, testLauncher, ...policy }, { spawnHelper: launch }))
        .toMatchObject({ type: 'not_started', policy: { launchPoc: false, reason: 'existing_mode_blocks_execution' } });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects malformed policy values instead of treating strings as permission', () => {
    for (const policy of [{ enabled: 'true' }, { allowNetwork: 1 }, { permissionMode: 'FULL' }, { planMode: 'ignore' }]) {
      expect(() => selectPocPolicy(policy)).toThrow('S1_INVALID_POLICY');
    }
  });

  it('keeps all flags off and selects only the current AppContainer backend', () => {
    expect(parseOptions([])).toEqual({ enabled: false, allowNetwork: false, testLauncher: false, permissionMode: 'manual', profile: 'appcontainer', planMode: 'default' });
    expect(parseOptions(['--enabled', '--allow-network', '--mode', 'full', '--profile', 'appcontainer']))
      .toMatchObject({ enabled: true, allowNetwork: true, permissionMode: 'full', profile: 'appcontainer' });
    for (const args of [['--enabled=false'], ['--mode'], ['--profile', 'native'], ['--profile', 'lpac'], ['--mode', 'manual', '--mode', 'full']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it('rejects LPAC and arbitrary runtime environment selectors without launching or retrying', async () => {
    const launch = vi.fn();
    await expect(runPoc({ enabled: true, profile: 'lpac' }, { spawnHelper: launch })).rejects.toThrow('S1_PROFILE_NOT_SUPPORTED');
    await expect(runPoc({ enabled: true, runtimeKind: 'inherit_environment' }, { spawnHelper: launch })).rejects.toThrow('S1_INVALID_RUNTIME_KIND');
    expect(launch).not.toHaveBeenCalled();
  });

  it('the test launcher flag cannot enable the PoC by itself', async () => {
    const launch = vi.fn();
    expect(parseOptions(['--test-launcher'])).toMatchObject({ enabled: false, testLauncher: true });
    expect(await runPoc({ testLauncher: true }, { spawnHelper: launch })).toMatchObject({ type: 'not_started', policy: { reason: 'disabled' } });
    expect(launch).not.toHaveBeenCalled();
    await expect(runPoc({ enabled: true, testLauncher: 'true' }, { spawnHelper: launch })).rejects.toThrow('S1_INVALID_TEST_LAUNCHER');
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses cancelled or incomplete requests before starting any helper', async () => {
    const launch = vi.fn();
    const controller = new AbortController(); controller.abort(new Error('cancel-before-launch'));
    await expect(runPoc({ enabled: true, signal: controller.signal }, { spawnHelper: launch })).rejects.toThrow();
    await expect(runPoc({ enabled: true }, { spawnHelper: launch })).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it('requires both access controls and the actual configured profile, not just verified=true', () => {
    for (const profile of ['lpac', 'appcontainer']) {
      const evidence = { method: 'access_check_controls', packageMatches: true, userMatches: true, userOnlyDenied: true, packageAllowed: true,
        allApplicationPackagesAllowed: profile === 'appcontainer', observedProfile: profile, verified: true };
      expect(() => assertIdentityEvidence(evidence, profile)).not.toThrow();
      expect(() => assertIdentityEvidence(evidence, profile === 'lpac' ? 'appcontainer' : 'lpac')).toThrow('S1_SANDBOX_IDENTITY_UNVERIFIED');
      for (const changed of [{ userOnlyDenied: false }, { packageAllowed: false }, { packageMatches: false }, { userMatches: false }, { verified: false },
        { method: 'requested_attributes_only' }, { allApplicationPackagesAllowed: profile === 'lpac' }]) {
        expect(() => assertIdentityEvidence({ ...evidence, ...changed }, profile)).toThrow('S1_SANDBOX_IDENTITY_UNVERIFIED');
      }
      expect(() => assertIdentityEvidence({ verified: true, observedProfile: profile }, profile)).toThrow('S1_SANDBOX_IDENTITY_UNVERIFIED');
    }
  });

  it('rejects invalid identity diagnostics before any launch', async () => {
    const launch = vi.fn();
    for (const options of [{ identityOnly: 'true' }, { probeLegacyQuery: 1 }, { expectedIdentityProfile: 'native' }]) {
      await expect(runPoc({ enabled: true, ...options }, { spawnHelper: launch })).rejects.toThrow();
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('the identity acceptance command stays off for default, Full, read-only and Plan', () => {
    const script = path.join(repository, 'tools', 'sandbox-s1', 'identity-acceptance.mjs');
    for (const args of [[], ['--enabled', '--mode', 'full'], ['--enabled', '--mode', 'read_only'], ['--enabled', '--plan-mode', 'plan']]) {
      const output = execFileSync(process.execPath, [script, '--test-launcher', ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      expect(JSON.parse(output)).toMatchObject({ status: 'not_started', policy: { launchPoc: false } });
    }
  });

  it('rejects workspace-wide or system paths for developer evidence', async () => {
    await expect(assertOwnedPath(repository)).rejects.toThrow('S1_PATH_OUTSIDE_EVIDENCE');
    await expect(assertOwnedPath(path.join(repository, 'src'))).rejects.toThrow('S1_PATH_OUTSIDE_EVIDENCE');
    await expect(assertOwnedPath(path.join(repository, '.qa', 'sandbox-s1-elsewhere'))).rejects.toThrow('S1_PATH_OUTSIDE_EVIDENCE');
  });

  it('does not import the experiment into the production bootstrap, gateway or runtime', async () => {
    for (const file of ['src/main/agentIpc.ts', 'src/main/execution/ExecutionGateway.ts', 'src/main/runtime/PartnerRuntimeFactory.ts', 'src/shared/generalSettings.ts']) {
      const source = await readFile(path.join(repository, file), 'utf8');
      expect(source).not.toMatch(/sandbox-s1|SandboxHelper|TestLauncher|TestTokenIdentity|AppContainerIdentity|runPoc/);
    }
  });
});
