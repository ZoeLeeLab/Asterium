import { createHash } from 'node:crypto';
import { API_DEFAULT_TOOLS_ENABLED, API_ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS, apiConfigurationSchema, apiConfigurationMutationSchema, type ApiConfiguration, type ApiConfigurationMutation } from '../../shared/apiConnections';
import type { ApiPartnerConnection } from '../../shared/agentProtocol';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

export class ApiConnectionStore {
  private readonly storage: AtomicJsonStore<ApiConfiguration>;
  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, revision: 0, services: [], models: [], bindings: [] }), decode: value => apiConfigurationSchema.parse(value) });
  }
  snapshot() { return this.storage.read(); }
  async mutate(input: ApiConfigurationMutation) {
    const request = apiConfigurationMutationSchema.parse(input);
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      if (data.revision !== request.expectedRevision) throw new Error('API_CONFIGURATION_CHANGED');
      if (request.action === 'service') {
        if (request.value.protocol === 'anthropic_messages') {
          for (const model of data.models.filter(item => item.serviceId === request.value.id && !item.settings?.maxOutputTokens)) {
            model.settings = { autoCompact: false, ...model.settings, maxOutputTokens: API_ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS };
          }
        }
        upsert(data.services, request.value);
      }
      else if (request.action === 'model') {
        if (!data.services.some(s => s.id === request.value.serviceId)) throw new Error('API_SERVICE_NOT_FOUND');
        upsert(data.models, request.value);
      } else if (request.action === 'bind') {
        if (request.modelId && !data.models.some(m => m.id === request.modelId)) throw new Error('API_MODEL_NOT_FOUND');
        data.bindings = data.bindings.filter(b => b.partnerId !== request.partnerId);
        if (request.modelId) data.bindings.push({ partnerId: request.partnerId, modelId: request.modelId });
      } else if (request.action === 'delete_service') {
        const modelIds = new Set(data.models.filter(m => m.serviceId === request.id).map(m => m.id));
        if (data.bindings.some(binding => modelIds.has(binding.modelId))) throw new Error('API_SERVICE_IN_USE');
        data.models = data.models.filter(model => !modelIds.has(model.id));
        data.services = data.services.filter(s => s.id !== request.id);
      } else {
        if (data.bindings.some(b => b.modelId === request.id)) throw new Error('API_MODEL_IN_USE');
        data.models = data.models.filter(m => m.id !== request.id);
      }
      data.revision++;
      await this.storage.writeNow(apiConfigurationSchema.parse(data));
      return data;
    });
  }
  /** One legacy service per partner, never infer shared ownership from endpoint or key. */
  async migrateLegacy(partnerId: string, connection: ApiPartnerConnection, allowBindingChange = false) {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      const binding = data.bindings.find(b => b.partnerId === partnerId);
      if (connection.modelId) {
        if (binding && binding.modelId !== connection.modelId && !allowBindingChange) return;
        if (!data.models.some(m => m.id === connection.modelId)) throw new Error('API_MODEL_NOT_FOUND');
        if (binding?.modelId === connection.modelId && !binding.legacy) return;
        data.bindings = data.bindings.filter(b => b.partnerId !== partnerId);
        data.bindings.push({ partnerId, modelId: connection.modelId }); data.revision++;
        await this.storage.writeNow(apiConfigurationSchema.parse(data)); return;
      }
      const fingerprint = JSON.stringify([connection.provider, connection.endpoint, connection.model, connection.credentialRef, connection.thinkingMode, connection.reasoningEffort, connection.attachmentCapabilities]);
      if (binding && (!binding.legacy || binding.legacyFingerprint === fingerprint)) return;
      const suffix = createHash('sha256').update(partnerId).digest('hex');
      const serviceId = `legacy-service-${suffix}`, modelId = `legacy-model-${suffix}`;
      const previousService = data.services.find(item => item.id === serviceId), previousModel = data.models.find(item => item.id === modelId);
      const sameModel = previousModel?.model === connection.model && previousService?.legacyDeepSeek === (connection.provider === 'deepseek');
      upsert(data.services, { ...previousService, id: serviceId, name: previousService?.name ?? `${connection.provider} · ${partnerId}`, protocol: connection.provider === 'responses' ? 'responses' : connection.provider === 'anthropic' ? 'anthropic_messages' : connection.provider === 'gemini' ? 'gemini' : 'chat_completions', endpoint: connection.endpoint, credentialRef: connection.credentialRef, legacyDeepSeek: connection.provider === 'deepseek' });
      upsert(data.models, { ...previousModel, id: modelId, serviceId, name: previousModel?.name ?? connection.model, model: connection.model, tools: sameModel ? previousModel!.tools : connection.toolsEnabled ?? API_DEFAULT_TOOLS_ENABLED, images: previousModel ? sameModel && previousModel.images : connection.attachmentCapabilities?.supportsImageInput ?? false, thinkingMode: connection.thinkingMode, reasoningEffort: connection.reasoningEffort });
      data.bindings = data.bindings.filter(b => b.partnerId !== partnerId);
      data.bindings.push({ partnerId, modelId, legacy: true, legacyFingerprint: fingerprint });
      data.revision++;
      // Validate and atomically write before callers adopt the migrated configuration.
      await this.storage.writeNow(apiConfigurationSchema.parse(data));
    });
  }
  async resolve(partnerId: string, fallback: ApiPartnerConnection): Promise<ApiPartnerConnection> {
    const data = await this.snapshot();
    const binding = data.bindings.find(b => b.partnerId === partnerId);
    if (!binding) return structuredClone(fallback);
    const model = data.models.find(m => m.id === binding.modelId);
    const service = data.services.find(s => s.id === model?.serviceId);
    if (!model || !service) throw new Error('API_CONFIGURATION_INVALID_BINDING');
    const provider = service.legacyDeepSeek ? 'deepseek' : ({ chat_completions: 'openai', responses: 'responses', anthropic_messages: 'anthropic', gemini: 'gemini' } as const)[service.protocol];
    return { ...structuredClone(fallback), provider, endpoint: service.endpoint, credentialRef: service.credentialRef, model: model.model,
      serviceId: service.id, modelId: model.id, bindingKey: apiBindingKey({ ...service, name: undefined }, { ...model, name: undefined }), toolsEnabled: model.tools,
      requestSettings: service.settings, modelSettings: model.settings,
      thinkingMode: model.thinkingMode, reasoningEffort: model.reasoningEffort,
      attachmentCapabilities: { supportsImageInput: model.images, acceptedMimeTypes: model.images ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] : [], maxImageBytes: 20 * 1024 * 1024, attachmentTransport: model.images ? 'native_multimodal' : 'metadata_only' },
    };
  }
  async assertCredentialUnreferenced(ref: string) {
    if ((await this.snapshot()).services.some(s => s.credentialRef === ref || s.settings?.headers?.some(h => h.credentialRef === ref))) throw new Error('API_CREDENTIAL_IN_USE');
  }
}
function upsert<T extends { id: string }>(values: T[], value: T) {
  const index = values.findIndex(item => item.id === value.id);
  if (index < 0) values.push(value); else values[index] = value;
}
export function apiBindingKey(...configuration: unknown[]) { return createHash('sha256').update(JSON.stringify(configuration)).digest('hex'); }
