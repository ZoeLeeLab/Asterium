import {
  type ApiPartnerConnection
} from '../../shared/agentProtocol';
import { apiModelSettingsSchema, apiRequestSettingsSchema } from '../../shared/apiConnections';
import { CredentialStore } from '../security/CredentialStore';
export function createApiRuntimeConfiguration(credentials: Pick<CredentialStore, 'get'>) {
  async function configuredApiOptions(connection: ApiPartnerConnection, keyOverride?: string) {
    const requestSettings = connection.requestSettings ? apiRequestSettingsSchema.parse(connection.requestSettings) : undefined;
    const modelSettings = connection.modelSettings ? apiModelSettingsSchema.parse(connection.modelSettings) : undefined;
    const apiKey = requestSettings?.auth === 'none' ? '' : keyOverride || await credentials.get(connection.credentialRef);
    if (apiKey === undefined) throw new Error('API_CREDENTIAL_REQUIRED');
    const headers: Record<string, string> = {};
    for (const header of requestSettings?.headers ?? []) {
      const secret = await credentials.get(header.credentialRef);
      if (secret === undefined) throw new Error('API_HEADER_CREDENTIAL_REQUIRED');
      headers[header.name] = secret;
    }
    return { apiKey, requestSettings, modelSettings, headers };
  }
  return configuredApiOptions;
}

export function isAttachmentCapabilities(value: unknown) {
  return isRecord(value)
    && typeof value.supportsImageInput === 'boolean'
    && Array.isArray(value.acceptedMimeTypes)
    && value.acceptedMimeTypes.every((item) => typeof item === 'string' && item === item.trim().toLocaleLowerCase() && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item))
    && Number.isSafeInteger(value.maxImageBytes) && Number(value.maxImageBytes) >= 0
    && ['local_path', 'native_multimodal', 'metadata_only'].includes(String(value.attachmentTransport));
}

export function resolveApiAttachmentCapabilities(connection: ApiPartnerConnection) {
  const defaults = {
    supportsImageInput: false,
    acceptedMimeTypes: [] as string[],
    maxImageBytes: 0,
    attachmentTransport: 'metadata_only' as const,
  };
  const requested = connection.attachmentCapabilities ?? defaults;
  if (!isAttachmentCapabilities(requested)) throw new Error('INVALID_ATTACHMENT_CAPABILITIES');
  if (requested.attachmentTransport === 'local_path' || (connection.provider === 'deepseek' && (requested.attachmentTransport !== defaults.attachmentTransport || requested.supportsImageInput))) throw new Error('API_ATTACHMENT_TRANSPORT_NOT_IMPLEMENTED');
  return { ...requested, acceptedMimeTypes: [...new Set(requested.acceptedMimeTypes)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
