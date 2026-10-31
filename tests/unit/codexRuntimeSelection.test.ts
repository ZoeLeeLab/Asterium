import { describe, expect, it } from 'vitest';
import type { CodexRuntimeInfo } from '../../src/shared/agentProtocol';
import { resolveCodexRuntime } from '../../src/shared/codexRuntimeSelection';

function runtime(
  runtimeId: string,
  environment: CodexRuntimeInfo['environment'],
  loggedIn = true,
): CodexRuntimeInfo {
  return {
    runtimeId,
    executablePath: `C:\\Codex\\${runtimeId}\\codex.exe`,
    executableLabel: 'codex.exe',
    environment,
    environmentLabel: environment,
    codexHome: 'C:\\Users\\fixture-user\\.codex',
    installed: true,
    loggedIn,
    version: '0.160.0',
    authMethod: loggedIn ? 'using ChatGPT' : undefined,
  };
}

describe('Codex runtime selection recovery', () => {
  it('keeps an exact runtime selection ahead of another recommended environment', () => {
    const global = runtime('runtime-global', 'global_cli');
    const desktop = runtime('runtime-desktop', 'desktop_app');

    expect(resolveCodexRuntime([global, desktop], desktop.runtimeId, 'desktop_app')).toBe(desktop);
  });

  it('recovers a stale desktop runtime id within the desktop environment after an app update', () => {
    const global = runtime('runtime-global', 'global_cli');
    const signedOutDesktop = runtime('runtime-desktop-signed-out', 'desktop_app', false);
    const currentDesktop = runtime('runtime-desktop-current', 'desktop_app');

    expect(resolveCodexRuntime(
      [global, signedOutDesktop, currentDesktop],
      'runtime-desktop-from-previous-version',
      'desktop_app',
    )).toBe(currentDesktop);
  });

  it('does not silently switch environments when no remembered environment is available', () => {
    const global = runtime('runtime-global', 'global_cli');

    expect(resolveCodexRuntime([global], 'runtime-missing')).toBeUndefined();
    expect(resolveCodexRuntime([global], 'runtime-desktop-old', 'desktop_app')).toBeUndefined();
  });
});
