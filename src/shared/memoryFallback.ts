import { z } from 'zod';

export const memoryFallbackProvider = z.enum(['deepseek', 'openai', 'responses', 'anthropic', 'gemini']);
export type MemoryFallbackProvider = z.infer<typeof memoryFallbackProvider>;
export const fallbackSettingsUpdate = z.object({
  provider: memoryFallbackProvider, endpoint: z.string().url().max(2048), model: z.string().trim().min(1).max(200),
  intervalMinutes: z.union([z.literal(15), z.literal(20), z.literal(30)]),
  apiKey: z.string().trim().min(1).max(4096).optional(), clearCredential: z.boolean().optional(),
}).strict();
export const fallbackPartnerUpdate = z.object({ partnerId: z.string().min(1).max(200), enabled: z.boolean(), history: z.enum(['from_now', 'unprocessed']).optional() }).strict();
export const fallbackModelsRequest = z.object({ provider: memoryFallbackProvider.default('deepseek'), endpoint: z.string().url().max(2048), apiKey: z.string().trim().min(1).max(4096).optional() }).strict();
export type MemoryFallbackSettingsUpdate = z.infer<typeof fallbackSettingsUpdate>;
export type MemoryFallbackPartnerUpdate = z.infer<typeof fallbackPartnerUpdate>;
export interface MemoryFallbackSettings {
  provider: MemoryFallbackProvider; endpoint: string; model: string; intervalMinutes: 15 | 20 | 30; credentialConfigured: boolean;
  partners: Record<string, { enabled: boolean; enabledAt: string; history: 'from_now' | 'unprocessed' }>;
}
export interface MemoryFallbackJobStatus { partnerId: string; state: 'waiting_idle' | 'running' | 'waiting_retry'; lastSuccessAt?: string; }
export interface MemoryFallbackSnapshot { settings: MemoryFallbackSettings; jobs: MemoryFallbackJobStatus[]; }
export interface AsteriumMemoryFallbackApi {
  listModels: (input: z.input<typeof fallbackModelsRequest>) => Promise<import('./agentProtocol').ApiModelSummary[]>;
  get: () => Promise<MemoryFallbackSnapshot>;
  configure: (input: MemoryFallbackSettingsUpdate) => Promise<MemoryFallbackSnapshot>;
  setPartner: (input: MemoryFallbackPartnerUpdate) => Promise<MemoryFallbackSnapshot>;
}
