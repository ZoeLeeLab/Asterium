import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
import { apiProviderForProtocol, apiServiceSchema, type ApiConfiguration, type ApiService } from '../../../shared/apiConnections';
import { API_SITE_PRESETS, apiSitePreset } from '../../../shared/apiPresets';
import { apiEndpoint } from '../../../shared/apiEndpoints';
import type { ApiModelSummary } from '../../../shared/agentProtocol';
import { Modal } from '../ui/Modal';
import { ApiModelAdvanced, ApiServiceAdvanced } from './ApiAdvancedFields';
import { newApiModel, type ApiConnectionValue } from './apiPartnerConnection';

const emptyConfiguration: ApiConfiguration = { version: 1, revision: 0, services: [], models: [], bindings: [] };
export function ApiPartnerConnectionFields({ value, onChange, onDirty }: { value: ApiConnectionValue; onChange: (value: Partial<ApiConnectionValue>) => void; onDirty?: () => void }) {
  const [data, setData] = useState(emptyConfiguration);
  const [models, setModels] = useState<ApiModelSummary[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeProbe, setActiveProbe] = useState<string>(), [probeNotice, setProbeNotice] = useState('');
  const [editor, setEditor] = useState<{ service?: ApiService }>();
  const sequence = useRef(0);
  const modelEdited = useRef(false);
  const activeRequest = useRef(false);
  const service = value.service ?? apiSitePreset('preset-deepseek')!;
  useEffect(() => {
    let alive = true;
    const initialSequence = sequence.current;
    void window.asteriumAgents?.apiConnectionsGet?.().then(config => {
      if (!alive) return;
      setData(config);
      const saved = config.services.find(item => item.id === value.service?.id);
      if (saved && !value.service?.credentialRef && !value.apiKey && !value.model && !modelEdited.current && sequence.current === initialSequence) onChange({ service: saved, selectedCredentialRef: saved.credentialRef });
    }).catch(() => { if (alive) setError('站点读取失败，请重新打开伙伴设置。'); });
    const requestSequence = sequence;
    return () => { alive = false; requestSequence.current++; };
  // Hydration applies only to the initial untouched form; later edits stay in the draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const resetModels = () => { sequence.current++; activeRequest.current = false; setBusy(false); setModels([]); setModelsOpen(false); setError(''); };
  const selectService = (selected: ApiService) => {
    onDirty?.();
    resetModels();
    onChange({ ...value, service: selected, modelId: undefined, modelConfig: undefined, selectedCredentialRef: selected.credentialRef,
      provider: selected.legacyDeepSeek ? 'deepseek' : apiProviderForProtocol(selected.protocol), endpoint: selected.endpoint, apiKey: '', model: '', advancedError: '' });
  };
  const chooseModel = (id: string) => {
    modelEdited.current = true;
    onDirty?.();
    const saved = data.models.find(item => item.serviceId === service.id && item.model === id);
    onChange({ ...value, model: id, modelId: saved?.id, modelConfig: saved ?? newApiModel(service, id), advancedError: '' });
    setModelsOpen(false);
  };
  const loadModels = async () => {
    if (activeRequest.current) return;
    const request = ++sequence.current;
    activeRequest.current = true; setBusy(true); setError('');
    try {
      const bridge = window.asteriumAgents;
      if (!bridge?.listApiModels) throw new Error('UNAVAILABLE');
      if (!value.apiKey && !service.credentialRef && service.settings?.auth !== 'none') throw new Error('KEY_REQUIRED');
      const saved = data.services.some(item => item.id === service.id);
      const result = await bridge.listApiModels(value.provider, service.endpoint, service.credentialRef || undefined, value.apiKey || undefined, saved ? service.id : undefined);
      if (sequence.current !== request) return;
      setModels(result); setModelsOpen(true);
      if (!result.length) setError('站点未返回模型，可以手动填写模型 ID。');
    } catch (cause) {
      if (sequence.current === request) setError(cause instanceof Error && cause.message === 'KEY_REQUIRED' ? '请先填写 API Key。' : '模型列表读取失败，请检查 Key 和站点配置；也可以手动填写模型 ID。');
    } finally { if (sequence.current === request) { activeRequest.current = false; setBusy(false); } }
  };
  const customSites = data.services.filter(item => !API_SITE_PRESETS.some(preset => preset.id === item.id));
  if (!API_SITE_PRESETS.some(item => item.id === service.id) && !customSites.some(item => item.id === service.id)) customSites.push(service);
  const model = value.modelConfig ?? newApiModel(service, value.model);
  const probe = async (tools: boolean) => {
    setActiveProbe(model.id); setProbeNotice('');
    try {
      const result = await window.asteriumAgents!.apiConnectionsProbe!(model.id, tools);
      setProbeNotice(tools ? result.toolCall ? '测试工具调用通过；未执行文件或命令。' : '未返回预期工具调用。' : `测试回复：${result.text || '无文字回复'}`);
    } catch { setProbeNotice('测试未完成，请检查配置或取消状态。'); } finally { setActiveProbe(undefined); }
  };
  return <fieldset className="form-section api-partner-connection"><legend>模型连接</legend>
    <div className="api-site-row"><label>API 站点<select aria-label="API 站点" value={service.id} onChange={event => {
      if (event.target.value === 'custom') { setEditor({}); return; }
      const selected = data.services.find(item => item.id === event.target.value) ?? apiSitePreset(event.target.value);
      if (selected) selectService(selected);
    }}>{API_SITE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      {customSites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="custom">＋ 自定义配置…</option>
    </select></label>{!API_SITE_PRESETS.some(item => item.id === service.id) && <button className="secondary-button" type="button" aria-label="编辑自定义站点" onClick={() => setEditor({ service })}><Pencil size={15} />编辑</button>}
    </div>
    <label>API Key<input type="password" autoComplete="off" value={value.apiKey} placeholder={service.credentialRef ? '已安全保存，留空保持不变' : '填写该站点的 API Key'} onChange={event => { resetModels(); onChange({ ...value, apiKey: event.target.value }); }} /></label>
    <div className="api-model-row"><label>模型<div className="api-model-picker"><input aria-label="模型" value={value.model} role="combobox" aria-expanded={modelsOpen && models.length > 0} aria-controls="api-site-model-options" aria-autocomplete="list" placeholder="拉取后选择，或填写模型 ID" onFocus={() => setModelsOpen(true)} onKeyDown={event => { if (event.key === 'Escape') setModelsOpen(false); }} onChange={event => chooseModel(event.target.value)} onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setModelsOpen(false); }} />
      {modelsOpen && models.length > 0 && <div className="api-model-options" id="api-site-model-options" role="listbox" aria-label="可用模型">{models.map(item => <button type="button" role="option" aria-selected={item.id === value.model} key={item.id} onMouseDown={event => event.preventDefault()} onClick={() => chooseModel(item.id)}><strong>{item.id}</strong>{item.ownedBy && <small>{item.ownedBy}</small>}</button>)}</div>}
    </div></label><button className="secondary-button" type="button" disabled={busy} onClick={() => void loadModels()}><RefreshCw size={15} className={busy ? 'is-spinning' : undefined} />{busy ? '正在拉取…' : '拉取模型'}</button></div>
    <small role="status">{error || (models.length ? `已读取 ${models.length} 个模型，点击模型框选择。` : '填写 Key 后拉取模型，保存伙伴时生效。')}</small>
    {value.model && <p className="appearance-hint">{model.tools ? '工具调用已启用；实际操作仍遵循会话权限与审批。' : '工具调用未启用：伙伴只能文字聊天，不能创建自动化或调用文件、记忆等工具。如需使用，请在“高级模型设置”勾选“启用工具调用”并保存伙伴，下一轮生效。'}</p>}
    {value.apiKey && data.bindings.some(binding => data.models.some(item => item.id === binding.modelId && item.serviceId === service.id)) && <small>此站点由多个伙伴共用，保存新 Key 将同时更新使用该站点的伙伴。</small>}
    <ApiModelAdvanced key={`${service.id}:${value.model}:${model.id}`} value={model} onChange={next => onChange({ modelConfig: next })} onError={advancedError => onChange({ advancedError })}>
      <div className="studio-mcp-actions"><button type="button" className="secondary-button" disabled={!model.id || Boolean(activeProbe) || Boolean(value.apiKey)} onClick={() => void probe(false)}>发送测试对话（会调用 API）</button><button type="button" className="secondary-button" disabled={!model.id || Boolean(activeProbe) || Boolean(value.apiKey)} onClick={() => void probe(true)}>测试工具调用（会调用 API）</button>{activeProbe && <button type="button" className="secondary-button" onClick={() => void window.asteriumAgents?.apiConnectionsCancelProbe?.(activeProbe)}>取消测试</button>}</div>
      <small>测试使用已保存的模型配置；修改后请先保存伙伴，再进入编辑测试。</small>{probeNotice && <p role="status">{probeNotice}</p>}
    </ApiModelAdvanced>
    {value.advancedError && <p role="alert">{value.advancedError}</p>}
    {editor && createPortal(<ApiSiteDialog initial={editor.service} data={data} onClose={() => setEditor(undefined)} onSaved={(next, selected) => { setData(next); setEditor(undefined); if (selected) selectService(selected); else selectService(next.services.find(item => item.id === 'preset-deepseek') ?? apiSitePreset('preset-deepseek')!); }} />, document.body)}
  </fieldset>;
}

function ApiSiteDialog({ initial, data, onClose, onSaved }: { initial?: ApiService; data: ApiConfiguration; onClose: () => void; onSaved: (data: ApiConfiguration, service?: ApiService) => void }) {
  const [service, setService] = useState<ApiService>(initial ?? { id: crypto.randomUUID(), name: '', endpoint: '', protocol: 'chat_completions', credentialRef: '' });
  const [key, setKey] = useState(''), [headers, setHeaders] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const inUse = data.bindings.filter(binding => data.models.some(model => model.id === binding.modelId && model.serviceId === service.id)).length;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch { setError('未保存：请检查名称、地址、Key、Headers 格式及站点引用；配置被其他窗口修改时，请关闭后重试。'); } finally { setBusy(false); }
  };
  const save = async () => {
    const bridge = window.asteriumAgents!;
    apiEndpoint(service.endpoint, service.protocol, service.settings?.path);
    const parsed: unknown = headers.trim() ? JSON.parse(headers) : undefined;
    if (parsed !== undefined && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string' || /[\r\n]/.test(value)))) throw new Error('INVALID_HEADERS');
    const headerValues = parsed as Record<string, string> | undefined;
    // Validate before writing any secret to the encrypted store.
    apiServiceSchema.parse({ ...service, credentialRef: service.credentialRef || 'pending', settings: { ...service.settings, headers: headerValues ? Object.keys(headerValues).map(name => ({ name, credentialRef: 'pending' })) : service.settings?.headers } });
    if (!key && !service.credentialRef && service.settings?.auth !== 'none') throw new Error('KEY_REQUIRED');
    const credentialRef = key ? (await bridge.saveApiCredential!(key)).credentialRef : service.settings?.auth === 'none' ? 'none' : service.credentialRef;
    const refs = headerValues ? await Promise.all(Object.entries(headerValues).map(async ([name, secret]) => ({ name, credentialRef: (await bridge.saveApiCredential!(secret)).credentialRef }))) : service.settings?.headers;
    const value = apiServiceSchema.parse({ ...service, credentialRef, settings: { ...service.settings, headers: refs } });
    const next = await bridge.apiConnectionsMutate!({ action: 'service', expectedRevision: data.revision, value });
    onSaved(next, value);
  };
  return <Modal title={initial ? '编辑自定义站点' : '新增自定义站点'} onClose={() => { if (!busy) onClose(); }} size="md">
    <form className="api-site-dialog" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void run(save); }} onChange={event => event.stopPropagation()}>
      <fieldset disabled={busy} className="api-site-fields">
        <label>名称<input required value={service.name} onChange={event => setService({ ...service, name: event.target.value })} /></label>
        <label>地址<input required value={service.endpoint} placeholder="https://api.example.com/v1" onChange={event => setService({ ...service, endpoint: event.target.value })} /></label>
        <label>API Key<input type="password" autoComplete="off" value={key} placeholder={service.credentialRef ? '已安全保存，留空保持不变' : '填写 API Key'} onChange={event => setKey(event.target.value)} /></label>
        <label>Headers（可选）<textarea value={headers} placeholder={'{"X-Custom-Header":"value"}'} onChange={event => setHeaders(event.target.value)} rows={2} /></label>
        <small>留空保留已有 Headers，输入 {'{}'} 清除；值加密保存，不会回显。{service.settings?.headers?.map(item => item.name).join('、')}</small>
        <label>API 协议<select value={service.protocol} onChange={event => setService({ ...service, protocol: event.target.value as ApiService['protocol'], legacyDeepSeek: false })}><option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option><option value="gemini">Gemini 原生接口</option></select></label>
        {inUse > 0 && <small>{inUse} 位伙伴使用此站点，连接修改在下一轮生效。删除前请先为这些伙伴更换站点。</small>}
        <ApiServiceAdvanced value={service} onChange={setService} headers={headers} onHeaders={setHeaders} showHeaders={false} />
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer className="modal-footer">{initial && <button className="danger-button" type="button" disabled={busy || inUse > 0} onClick={() => void run(async () => { const next = await window.asteriumAgents!.apiConnectionsMutate!({ action: 'delete_service', expectedRevision: data.revision, id: service.id }); onSaved(next); })}>删除</button>}<button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy}><Plus size={15} />{busy ? '保存中…' : '确认'}</button></footer>
    </form>
  </Modal>;
}
