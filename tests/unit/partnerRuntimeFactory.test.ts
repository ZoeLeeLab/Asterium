import { describe, expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { AsteriumRuntimeToolController, PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import { localRuntimeAdapterKey, PartnerRuntimeFactory } from '../../src/main/runtime/PartnerRuntimeFactory';

function controller(label: string): AsteriumRuntimeToolController {
  return {
    status: async () => label,
    workspace: async () => label,
    task: async () => label,
    update: vi.fn(),
  };
}

describe('PartnerRuntimeFactory', () => {
  it('rebinds a cached local adapter to the current attempt tools', () => {
    const host = new AdapterHost();
    const replaceRuntimeTools = vi.fn();
    const replaceRuntimeWorkspaceRoots = vi.fn();
    const adapter = {
      connectionSource: 'local_cli',
      capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
      sendMessage: async function* () {},
      resumeSession: async function* () {},
      resolveAuthorization: async () => undefined,
      cancel: async () => undefined,
      replaceRuntimeTools,
      replaceRuntimeWorkspaceRoots,
    } satisfies PartnerAdapter;
    host.set('workspace-adapter', adapter);
    const factory = new PartnerRuntimeFactory({
      host,
      credentials: {} as never,
      bridgeCursors: {} as never,
      apiSessions: {} as never,
      attachments: {} as never,
      braveApiKey: async () => undefined,
      protectedRoots: [],
      apiProviders: {} as never,
    });
    const current = controller('attempt-new');

    expect(factory.getLocal({
      adapterType: 'codex_cli', adapterKey: 'workspace-adapter', executablePath: 'codex.exe', partnerRoot: 'K:\\project', additionalDirectories: ['D:\\current'], runtimeTools: current,
    })).toBe(adapter);
    expect(replaceRuntimeTools).toHaveBeenCalledOnce();
    expect(replaceRuntimeTools).toHaveBeenCalledWith(current);
    expect(replaceRuntimeWorkspaceRoots).toHaveBeenCalledWith(['D:\\current']);
  });

  it('keeps Codex adapter identity stable across project workspace changes', () => {
    const base = {
      adapterType: 'codex_cli' as const,
      runtimeId: 'codex-runtime',
      partnerId: 'partner-one',
      conversationId: 'conversation-one',
      partnerRoot: 'D:\\fixture-workspace',
    };

    expect(localRuntimeAdapterKey({ ...base, additionalDirectories: ['K:\\project-a'] }))
      .toBe(localRuntimeAdapterKey({ ...base, additionalDirectories: ['K:\\project-b'] }));
    expect(localRuntimeAdapterKey({ ...base, adapterType: 'claude_code', additionalDirectories: ['K:\\project-a'] }))
      .not.toBe(localRuntimeAdapterKey({ ...base, adapterType: 'claude_code', additionalDirectories: ['K:\\project-b'] }));
  });
});
