import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { apiConfigurationMutationSchema } from '../../shared/apiConnections';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiPartnerConnection } from '../../shared/agentProtocol';
import { apiEndpoint, apiModelsEndpoint } from '../../shared/apiEndpoints';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderAdapterOptions, ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { apiHeaders } from '../api/ApiRequestConfiguration';
import { listApiSiteModels } from '../api/listApiSiteModels';
import type { CredentialStore } from '../security/CredentialStore';

export function registerApiConnectionsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  apiConnections: Pick<ApiConnectionStore, 'snapshot' | 'mutate'>,
  credentials: Pick<CredentialStore, 'has'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.apiConnectionsGet, async (event) => {
    requireSender(event); return apiConnections.snapshot();
  });
  ipcMain.handle(AGENT_IPC.apiConnectionsMutate, async (event, value: unknown) => {
    requireSender(event);
    const request = apiConfigurationMutationSchema.parse(value);
    if (request.action === 'service' && request.value.settings?.auth !== 'none' && !await credentials.has(request.value.credentialRef)) throw new Error('API_CREDENTIAL_REQUIRED');
    if (request.action === 'service') for (const header of request.value.settings?.headers ?? []) if (!await credentials.has(header.credentialRef)) throw new Error('API_HEADER_CREDENTIAL_REQUIRED');
    return apiConnections.mutate(request);
  });
}

export function registerApiCredentialIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  credentials: Pick<CredentialStore, 'save' | 'has' | 'delete'>,
  apiConnections: Pick<ApiConnectionStore, 'assertCredentialUnreferenced'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.saveApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret || (value.credentialRef !== undefined && typeof value.credentialRef !== 'string')) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const credentialRef = await credentials.save(value.secret, value.credentialRef);
    return { credentialRef, configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.apiCredentialStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const configured = await credentials.has(value.credentialRef);
    return { credentialRef: value.credentialRef, configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    await apiConnections.assertCredentialUnreferenced(value.credentialRef);
    await credentials.delete(value.credentialRef);
  });
}

interface ApiModelListDependencies {
  apiProviders: Pick<ApiProviderRegistry, 'has' | 'require'>;
  apiConnections: Pick<ApiConnectionStore, 'snapshot'>;
  credentials: Pick<CredentialStore, 'get'>;
  configuredApiOptions(connection: ApiPartnerConnection, keyOverride?: string): Promise<Pick<ApiProviderAdapterOptions, 'apiKey' | 'requestSettings' | 'modelSettings' | 'headers'>>;
}

export function registerApiModelListIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { apiProviders, apiConnections, credentials, configuredApiOptions }: ApiModelListDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.listApiModels, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !apiProviders.has(value.provider) || typeof value.endpoint !== 'string'
      || (value.credentialRef !== undefined && typeof value.credentialRef !== 'string')
      || (value.secret !== undefined && typeof value.secret !== 'string')) throw new Error('INVALID_API_MODEL_LIST_REQUEST');
    if (typeof value.serviceId === 'string') {
      const service = (await apiConnections.snapshot()).services.find(s => s.id === value.serviceId);
      if (!service) throw new Error('API_SERVICE_NOT_FOUND');
      const options = await configuredApiOptions({ provider: value.provider, endpoint: service.endpoint, model: '', credentialRef: service.credentialRef, requestSettings: service.settings }, typeof value.secret === 'string' ? value.secret : undefined);
      const url = service.settings?.modelsPath ? apiEndpoint(service.endpoint, service.protocol, service.settings.modelsPath) : apiModelsEndpoint(service.endpoint, service.protocol);
      return listApiSiteModels(url, service.protocol, apiHeaders({ ...options, apiKey: typeof value.secret === 'string' && value.secret ? value.secret : options.apiKey, endpoint: service.endpoint, model: '' }, service.protocol), service.settings?.headerTimeoutMs);
    }
    const endpoint = apiProviders.require(value.provider).normalizeEndpoint(value.endpoint);
    const apiKey = typeof value.secret === 'string' && value.secret ? value.secret
      : typeof value.credentialRef === 'string' ? await credentials.get(value.credentialRef) : undefined;
    if (!apiKey) throw new Error('API_CREDENTIAL_REQUIRED');
    const protocol = value.provider === 'responses' ? 'responses' : value.provider === 'anthropic' ? 'anthropic_messages' : value.provider === 'gemini' ? 'gemini' : 'chat_completions';
    return listApiSiteModels(apiModelsEndpoint(endpoint, protocol), protocol, apiHeaders({ endpoint, model: '', apiKey }, protocol));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
