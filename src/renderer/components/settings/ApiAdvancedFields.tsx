import { useState, type ReactNode } from 'react';
import type { ApiModel, ApiService } from '../../../shared/apiConnections';

export function ApiServiceAdvanced({ value, onChange, headers, onHeaders, showHeaders = true }: { value: ApiService; onChange: (value: ApiService) => void; headers: string; onHeaders: (text: string) => void; showHeaders?: boolean }) {
  const settings = value.settings ?? {};
  const set = (next: Partial<NonNullable<ApiService['settings']>>) => onChange({ ...value, settings: { ...settings, ...next } });
  return <details><summary>高级连接设置</summary><p>留空跟随默认。自定义请求头值单独加密保存；已保存的值不会回显。</p>
    <label>鉴权方式<select value={settings.auth ?? 'default'} onChange={e => set({ auth: e.target.value as typeof settings.auth })}><option value="default">协议默认</option><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="google-api-key">x-goog-api-key</option><option value="custom">自定义请求头</option><option value="none">无需鉴权</option></select></label>
    {settings.auth === 'custom' && <label>鉴权头名称<input value={settings.authHeader ?? ''} onChange={e => set({ authHeader: e.target.value })} /></label>}
    <label>请求路径覆盖<input value={settings.path ?? ''} placeholder="留空自动解析；例如 /v2/chat/completions" onChange={e => set({ path: e.target.value || undefined })} /></label>
    <label>模型列表路径覆盖<input value={settings.modelsPath ?? ''} onChange={e => set({ modelsPath: e.target.value || undefined })} /></label>
    <label>响应头等待上限（秒）<input type="number" min={1} max={600} value={settings.headerTimeoutMs === undefined ? '' : settings.headerTimeoutMs / 1000} placeholder="120" onChange={e => set({ headerTimeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined })} /></label>
    <label>整轮超时（秒）<input type="number" min={1} value={settings.roundTimeoutMs === undefined ? '' : settings.roundTimeoutMs / 1000} placeholder="默认关闭" onChange={e => set({ roundTimeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined })} /></label>
    <label>响应方式<select value={settings.stream === false ? 'off' : 'on'} onChange={e => set({ stream: e.target.value !== 'off' })}><option value="on">流式</option><option value="off">非流式</option></select></label>
    {showHeaders && <label>替换附加请求头（JSON）<textarea value={headers} placeholder={'{"X-Custom-Header":"value"}'} onChange={e => onHeaders(e.target.value)} /></label>}
    <small>当前附加头：{settings.headers?.map(h => h.name).join('、') || '无'}；留空保留，输入 {'{}'} 清除。不能覆盖协议鉴权或 HTTP 管理字段。</small>
  </details>;
}
export function ApiModelAdvanced({ value, onChange, onError, children }: { value: ApiModel; onChange: (value: ApiModel) => void; onError: (message: string) => void; children?: ReactNode }) {
  const settings = value.settings ?? { autoCompact: false };
  const [thinking, setThinking] = useState(JSON.stringify(settings.thinking ?? {}, null, 2));
  const [extra, setExtra] = useState(JSON.stringify(settings.extra ?? {}, null, 2));
  const [invalid, setInvalid] = useState({ thinking: false, extra: false });
  const set = (next: Partial<typeof settings>) => onChange({ ...value, settings: { ...settings, ...next } });
  const json = (field: 'thinking' | 'extra', text: string) => {
    (field === 'thinking' ? setThinking : setExtra)(text);
    try {
      const parsed: unknown = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OBJECT_REQUIRED');
      const next = { ...invalid, [field]: false }; setInvalid(next); set({ [field]: Object.keys(parsed).length ? parsed : undefined }); onError(Object.values(next).some(Boolean) ? '高级 JSON 格式错误，尚未保存。' : '');
    } catch { setInvalid({ ...invalid, [field]: true }); onError('高级 JSON 格式错误，尚未保存。'); }
  };
  return <details><summary>高级模型设置</summary>
    <label>思考模式<select value={value.thinkingMode ?? 'auto'} onChange={e => onChange({ ...value, thinkingMode: e.target.value as ApiModel['thinkingMode'] })}><option value="auto">自动（跟随模型默认）</option><option value="enabled">启用</option><option value="disabled">关闭</option></select></label>
    {value.thinkingMode === 'enabled' && <label>思考强度<select value={value.reasoningEffort ?? 'high'} onChange={e => onChange({ ...value, reasoningEffort: e.target.value as ApiModel['reasoningEffort'] })}><option value="low">低</option><option value="high">高</option><option value="max">最大</option></select></label>}
    <label><input type="checkbox" checked={value.tools} onChange={e => onChange({ ...value, tools: e.target.checked })} />启用工具调用</label>
    <label><input type="checkbox" checked={value.images} onChange={e => onChange({ ...value, images: e.target.checked })} />启用聊天图片输入</label>
    <p>这些开关不扩大工作区、审批或群成员权限。请按模型文档启用，或先运行专项测试。</p>
    <label>Chat Completions 输出上限字段<select value={settings.chatOutputLimitField ?? 'max_completion_tokens'} onChange={e => set({ chatOutputLimitField: e.target.value as 'max_tokens' | 'max_completion_tokens' })}><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens（部分兼容服务）</option></select></label>
    {(['temperature', 'topP', 'maxOutputTokens', 'contextWindow', 'inputBudget'] as const).map(field => <label key={field}>{{ temperature: '温度', topP: 'Top P', maxOutputTokens: '最大输出 token', contextWindow: '上下文窗口（未知留空）', inputBudget: '输入预算（token 上限）' }[field]}<input type="number" step={field === 'temperature' || field === 'topP' ? 'any' : 1} value={settings[field] ?? ''} onChange={e => set({ [field]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>)}
    <label>思考参数（协议原生 JSON）<textarea value={thinking} onChange={e => json('thinking', e.target.value)} /></label>
    <label>扩展参数（JSON）<textarea value={extra} onChange={e => json('extra', e.target.value)} /></label>
    <label><input type="checkbox" checked={settings.autoCompact} onChange={e => set({ autoCompact: e.target.checked })} />启用自动压缩</label>
    <small>默认关闭。预检采用保守字节估算，并非模型分词器；压缩保留最近六轮，失败或仍超预算时停止。</small>
    {children}
  </details>;
}
