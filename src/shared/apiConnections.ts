import { z } from 'zod';
export const API_DEFAULT_TOOLS_ENABLED = true;

// Messages requires max_tokens even for the minimal Key + model setup.
export const API_ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export const apiProtocolSchema = z.enum(['chat_completions', 'responses', 'anthropic_messages', 'gemini']);
export type ApiProtocol = z.infer<typeof apiProtocolSchema>;
export function apiProviderForProtocol(protocol: ApiProtocol) { return ({ chat_completions: 'openai', responses: 'responses', anthropic_messages: 'anthropic', gemini: 'gemini' } as const)[protocol]; }
const id = z.string().min(1).max(160);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(value => !/^(authorization|x-api-key|x-goog-api-key|content-type|content-length|host|cookie|connection|origin|proxy-authorization)$/i.test(value), 'HEADER_CONFLICT');
export const apiRequestSettingsSchema = z.object({
  auth: z.enum(['default', 'bearer', 'x-api-key', 'google-api-key', 'none', 'custom']).optional(),
  authHeader: headerName.optional(), headers: z.array(z.object({ name: headerName, credentialRef: id }).strict()).max(30).optional(),
  path: z.string().max(2048).optional(), modelsPath: z.string().max(2048).optional(),
  headerTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  roundTimeoutMs: z.number().int().min(1000).max(3600000).optional(), stream: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.auth === 'custom' && !value.authHeader) ctx.addIssue({ code: 'custom', message: 'AUTH_HEADER_REQUIRED' });
  const names = value.headers?.map(h => h.name.toLowerCase()) ?? [];
  if (new Set(names).size !== names.length || (value.authHeader && names.includes(value.authHeader.toLowerCase()))) ctx.addIssue({ code: 'custom', message: 'HEADER_CONFLICT' });
});
const jsonObject = z.record(z.string(), z.unknown());
const reserved = new Set(['model', 'messages', 'input', 'contents', 'tools', 'tool_choice', 'toolConfig', 'system', 'systemInstruction', 'stream', 'stream_options', 'store', 'previous_response_id', 'conversation', 'include', 'headers', 'authorization', 'api_key', 'key']);
export const apiModelSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), maxOutputTokens: z.number().int().positive().optional(),
  thinking: jsonObject.optional(), extra: jsonObject.optional(),
  chatOutputLimitField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
  contextWindow: z.number().int().positive().optional(), inputBudget: z.number().int().positive().optional(), autoCompact: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.keys(value.extra ?? {})) if (reserved.has(key) || ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'thinking', 'generationConfig', 'reasoning'].includes(key)) ctx.addIssue({ code: 'custom', message: `PARAMETER_CONFLICT:${key}` });
  if (value.autoCompact && !value.inputBudget) ctx.addIssue({ code: 'custom', message: 'INPUT_BUDGET_REQUIRED' });
  if (value.contextWindow && value.inputBudget && value.inputBudget + (value.maxOutputTokens ?? 0) > value.contextWindow) ctx.addIssue({ code: 'custom', message: 'CONTEXT_BUDGET_CONFLICT' });
});
export type ApiRequestSettings = z.infer<typeof apiRequestSettingsSchema>;
export type ApiModelSettings = z.infer<typeof apiModelSettingsSchema>;
export const apiServiceSchema = z.object({
  id, name: z.string().trim().min(1).max(120), protocol: apiProtocolSchema,
  endpoint: z.string().trim().url().max(4096).refine(value => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(key => /^(key|api_key|token|access_token)$/i.test(key));
  }, 'API_ENDPOINT_CREDENTIALS_OR_SCHEME_INVALID'), credentialRef: id,
  legacyDeepSeek: z.boolean().optional(),
  settings: apiRequestSettingsSchema.optional(),
}).strict();
export const apiModelSchema = z.object({
  id, serviceId: id, model: z.string().trim().min(1).max(240), name: z.string().trim().min(1).max(120),
  tools: z.boolean().default(API_DEFAULT_TOOLS_ENABLED), images: z.boolean().default(false),
  thinkingMode: z.enum(['auto', 'enabled', 'disabled']).optional(),
  reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
  settings: apiModelSettingsSchema.optional(),
}).strict();
export const apiBindingSchema = z.object({ partnerId: id, modelId: id, legacy: z.boolean().optional(), legacyFingerprint: z.string().optional() }).strict();
export const apiConfigurationSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), services: z.array(apiServiceSchema), models: z.array(apiModelSchema), bindings: z.array(apiBindingSchema) }).strict().superRefine((data, ctx) => {
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(data.services.map(s => s.id)) || !unique(data.models.map(m => m.id)) || !unique(data.bindings.map(b => b.partnerId))
    || data.models.some(m => !data.services.some(s => s.id === m.serviceId)) || data.bindings.some(b => !data.models.some(m => m.id === b.modelId))) ctx.addIssue({ code: 'custom', message: 'API_CONFIGURATION_INVALID_REFERENCES' });
  if (data.models.some(model => data.services.find(service => service.id === model.serviceId)?.protocol === 'anthropic_messages' && !model.settings?.maxOutputTokens)) ctx.addIssue({ code: 'custom', message: 'ANTHROPIC_MAX_OUTPUT_REQUIRED' });
  if (data.models.some(model => data.services.find(service => service.id === model.serviceId)?.legacyDeepSeek && model.images)) ctx.addIssue({ code: 'custom', message: 'API_IMAGE_CAPABILITY_NOT_IMPLEMENTED' });
});
export type ApiService = z.infer<typeof apiServiceSchema>;
export type ApiModel = z.infer<typeof apiModelSchema>;
export type ApiConfiguration = z.infer<typeof apiConfigurationSchema>;
export const apiConfigurationMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('service'), expectedRevision: z.number().int(), value: apiServiceSchema }).strict(),
  z.object({ action: z.literal('model'), expectedRevision: z.number().int(), value: apiModelSchema }).strict(),
  z.object({ action: z.literal('bind'), expectedRevision: z.number().int(), partnerId: id, modelId: id.nullable() }).strict(),
  z.object({ action: z.enum(['delete_service', 'delete_model']), expectedRevision: z.number().int(), id }).strict(),
]);
export type ApiConfigurationMutation = z.infer<typeof apiConfigurationMutationSchema>;
