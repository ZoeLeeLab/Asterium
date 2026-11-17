import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { ApiPartnerConnection } from '../../shared/agentProtocol';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderAdapterOptions, ApiProviderRegistry } from '../api/ApiProviderRegistry';

interface ApiConnectionProbeDependencies {
  apiConnections: Pick<ApiConnectionStore, 'snapshot'>;
  apiProviders: Pick<ApiProviderRegistry, 'require'>;
  configuredApiOptions(connection: ApiPartnerConnection): Promise<Pick<ApiProviderAdapterOptions, 'apiKey' | 'requestSettings' | 'modelSettings' | 'headers'>>;
}

export function registerApiConnectionProbeIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { apiConnections, apiProviders, configuredApiOptions }: ApiConnectionProbeDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const apiProbes = new Map<string, AbortController>();

  ipcMain.handle(AGENT_IPC.apiConnectionsProbe, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.modelId !== 'string' || (value.tools !== undefined && typeof value.tools !== 'boolean')) throw new Error('INVALID_API_PROBE');
    if (value.cancel === true) { apiProbes.get(value.modelId)?.abort(); return; }
    if (apiProbes.has(value.modelId)) throw new Error('API_PROBE_BUSY');
    const probeController = new AbortController(); apiProbes.set(value.modelId, probeController);
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await apiConnections.snapshot(); const model = data.models.find(m => m.id === value.modelId); const service = data.services.find(s => s.id === model?.serviceId);
      if (!model || !service) throw new Error('API_MODEL_NOT_FOUND');
      const provider = service.legacyDeepSeek ? 'deepseek' : ({ chat_completions: 'openai', responses: 'responses', anthropic_messages: 'anthropic', gemini: 'gemini' } as const)[service.protocol];
      const apiOptions = await configuredApiOptions({ provider, endpoint: service.endpoint, model: model.model, credentialRef: service.credentialRef, requestSettings: service.settings, modelSettings: model.settings });
      if (service.settings?.roundTimeoutMs) probeTimer = setTimeout(() => probeController.abort(), service.settings.roundTimeoutMs);
      let text = '', toolCall = false;
      try {
        const adapter = apiProviders.require(provider).createAdapter({ ...apiOptions, endpoint: service.endpoint, model: model.model });
        for await (const item of adapter.stream({ messages: [{ role: 'user', content: value.tools ? 'Call asterium_connection_probe once with value "ok". Do not call any other tool.' : 'This is a connection test. Reply briefly: OK.' }], tools: value.tools ? [{ name: 'asterium_connection_probe', description: 'Harmless synthetic connection probe; no operations are executed.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] : [], signal: probeController.signal })) {
          if (item.type === 'text.delta') text = (text + item.text).slice(0, 2000);
          if (item.type === 'tool.delta' && item.name === 'asterium_connection_probe') toolCall = true;
        }
        return { text, toolCall };
      } catch { throw new Error('API_PROBE_FAILED'); }
    } finally { if (probeTimer) clearTimeout(probeTimer); apiProbes.delete(value.modelId); }
  });

  return () => {
    for (const controller of apiProbes.values()) controller.abort();
    apiProbes.clear();
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
