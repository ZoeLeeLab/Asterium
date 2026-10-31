import type { ApiService } from './apiConnections';

/** Explicit preset identities: never merge users' connections by URL or key. */
export const API_SITE_PRESETS = [
  { id: 'preset-deepseek', name: 'DeepSeek', protocol: 'chat_completions', endpoint: 'https://api.deepseek.com/chat/completions', legacyDeepSeek: true },
  { id: 'preset-kimi', name: 'Kimi', protocol: 'chat_completions', endpoint: 'https://api.moonshot.cn/v1' },
  { id: 'preset-openai', name: 'OpenAI', protocol: 'responses', endpoint: 'https://api.openai.com/v1' },
  { id: 'preset-anthropic', name: 'Anthropic', protocol: 'anthropic_messages', endpoint: 'https://api.anthropic.com/v1' },
  { id: 'preset-siliconflow', name: '硅基流动', protocol: 'chat_completions', endpoint: 'https://api.siliconflow.cn/v1' },
] satisfies Omit<ApiService, 'credentialRef'>[];

export function apiSitePreset(id: string): ApiService | undefined {
  const preset = API_SITE_PRESETS.find(item => item.id === id);
  return preset ? { ...preset, credentialRef: '' } : undefined;
}
