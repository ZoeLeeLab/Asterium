import { API_DEFAULT_TOOLS_ENABLED, API_ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS, apiConfigurationSchema, apiModelSchema, apiServiceSchema, defaultApiModelImages, type ApiModel, type ApiService } from '../../../shared/apiConnections';
import type { ApiPartner } from '../../types/domain';

export interface ApiConnectionValue {
  service?: ApiService;
  modelConfig?: ApiModel;
  modelId?: string;
  selectedCredentialRef?: string;
  provider: ApiPartner['provider'];
  endpoint: string;
  apiKey: string;
  model: string;
  advancedError?: string;
}

export function newApiModel(service: ApiService, model: string): ApiModel {
  return { id: '', serviceId: service.id, name: model.slice(0, 120), model, tools: API_DEFAULT_TOOLS_ENABLED, images: defaultApiModelImages(service),
    ...(service.protocol === 'anthropic_messages' ? { settings: { maxOutputTokens: API_ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS, autoCompact: false } } : {}) };
}

/** Save on explicit partner submission. No model request, and no key enters profile/config JSON. */
export async function saveApiPartnerConnection(value: ApiConnectionValue, credentialRef: string) {
  const bridge = window.asteriumAgents;
  if (!value.service || !bridge?.apiConnectionsGet || !bridge.apiConnectionsMutate) return value.modelId;
  const service = apiServiceSchema.parse({ ...value.service, credentialRef });
  const draft = value.modelConfig ?? newApiModel(service, value.model);
  const candidate = apiModelSchema.parse({ ...draft, serviceId: service.id, model: value.model.trim(), name: draft.name || value.model.trim(), id: draft.id || crypto.randomUUID() });
  apiConfigurationSchema.parse({ version: 1, revision: 0, services: [service], models: [candidate], bindings: [] });
  let data = await bridge.apiConnectionsGet();
  const current = data.services.find(item => item.id === value.service!.id);
  const currentService = current ? JSON.stringify(apiServiceSchema.parse(current)) : undefined;
  // A concurrent edit must not be overwritten by an old partner form.
  if (current && currentService !== JSON.stringify(apiServiceSchema.parse(value.service))) throw new Error('API_CONFIGURATION_CHANGED');
  if (JSON.stringify(service) !== currentService) data = await bridge.apiConnectionsMutate({ action: 'service', expectedRevision: data.revision, value: service });
  const existing = data.models.find(item => item.id === candidate.id);
  if (JSON.stringify(existing) === JSON.stringify(candidate)) return candidate.id;
  // Model parameter changes belong to this partner; do not alter a profile used by others.
  const model = { ...candidate, id: crypto.randomUUID() };
  await bridge.apiConnectionsMutate({ action: 'model', expectedRevision: data.revision, value: model });
  return model.id;
}
