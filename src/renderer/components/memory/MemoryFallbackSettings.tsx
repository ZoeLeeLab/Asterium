import { useEffect, useId, useRef, useState } from 'react';
import { Power, RefreshCw } from 'lucide-react';
import type { MemoryFallbackProvider, MemoryFallbackSnapshot } from '../../../shared/memoryFallback';
import { Modal } from '../ui/Modal';

const deepSeekBase = 'https://api.deepseek.com/';
const displayEndpoint = (settings: Pick<MemoryFallbackSnapshot['settings'], 'provider' | 'endpoint'>) => settings.provider === 'deepseek'
  ? settings.endpoint.replace(/\/chat\/completions$/, '/')
  : settings.endpoint;

export function MemoryFallbackSettings({ partnerId, eligible }: { partnerId: string; eligible: boolean }) {
  const [snapshot, setSnapshot] = useState<MemoryFallbackSnapshot>();
  const [provider, setProvider] = useState<MemoryFallbackProvider>('deepseek');
  const modelListId = useId();
  const [endpoint, setEndpoint] = useState(deepSeekBase);
  const [model, setModel] = useState('deepseek-chat');
  const [models, setModels] = useState<string[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const modelsLoading = useRef(false);
  const modelsAttempted = useRef(false);
  const modelsGeneration = useRef(0);
  const mounted = useRef(false);
  const [interval, setInterval] = useState<15 | 20 | 30>(20);
  const [apiKey, setApiKey] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const load = () => window.asteriumMemoryFallback?.get().then((value) => {
      if (disposed) return;
      setSnapshot(value); setProvider(value.settings.provider); setEndpoint(displayEndpoint(value.settings)); setModel(value.settings.model); setInterval(value.settings.intervalMinutes);
    }).catch(() => { if (!disposed) setError('兜底设置暂时无法读取。'); });
    void load();
    // Display only; this never starts a model request or schedules Main work.
    const timer = window.setInterval(() => { void window.asteriumMemoryFallback?.get().then((value) => { if (!disposed) setSnapshot(value); }).catch(() => undefined); }, 30_000);
    return () => { disposed = true; mounted.current = false; window.clearInterval(timer); };
  }, []);
  if (!window.asteriumMemoryFallback) return null;
  const sameService = provider === snapshot?.settings.provider && Boolean(snapshot && displayEndpoint({ provider, endpoint: endpoint.trim() }).replace(/\/$/, '') === displayEndpoint(snapshot.settings).replace(/\/$/, ''));
  const invalidateModels = () => {
    modelsGeneration.current++; modelsAttempted.current = false; setModels([]); setModelsError('');
  };
  const loadModels = async (force = false) => {
    if (modelsLoading.current || (modelsAttempted.current && !force)) return;
    if (!apiKey && (!snapshot?.settings.credentialConfigured || !sameService)) {
      setModelsError('请先填写当前服务的独立 API Key，再读取模型列表。'); return;
    }
    modelsLoading.current = true; modelsAttempted.current = true;
    const generation = modelsGeneration.current;
    setModelsBusy(true); setModelsError('');
    try {
      const available = await window.asteriumMemoryFallback!.listModels({ provider, endpoint, ...(apiKey ? { apiKey } : {}) });
      if (mounted.current && generation === modelsGeneration.current) {
        setModels(available.map((item) => item.id));
        if (!available.length) setModelsError('此 API 未返回可用模型；已保留当前选择。');
      }
    } catch {
      if (mounted.current && generation === modelsGeneration.current) setModelsError('模型列表读取失败，请检查独立 API 配置后点击刷新。');
    } finally {
      modelsLoading.current = false;
      if (mounted.current) setModelsBusy(false);
    }
  };
  const run = async (operation: () => Promise<MemoryFallbackSnapshot>, syncConfig = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const value = await operation(); setSnapshot(value);
      if (syncConfig) { setProvider(value.settings.provider); setEndpoint(displayEndpoint(value.settings)); setModel(value.settings.model); setInterval(value.settings.intervalMinutes); }
      if (syncConfig) setApiKey('');
      setChoosing(false);
    }
    catch (cause) { setError(cause instanceof Error && cause.message.includes('MEMORY_FALLBACK_NEW_CREDENTIAL_REQUIRED') ? '服务已改变，请填写对应的新 API Key；原配置仍保留。' : '设置未保存，请检查 API 配置及伙伴记忆托管状态。'); }
    finally { setBusy(false); }
  };
  const enabled = snapshot?.settings.partners[partnerId]?.enabled ?? false;
  const job = snapshot?.jobs.find((item) => item.partnerId === partnerId);
  return <><details className="memory-briefing-card"><summary><strong>记忆管理 API 配置</strong><small>用于旧对话导入和记忆兜底</small></summary>
    <div className="memory-fallback-content">
    <form className="memory-editor" onSubmit={(event) => { event.preventDefault(); void run(() => window.asteriumMemoryFallback!.configure({ provider, endpoint, model, intervalMinutes: snapshot?.settings.intervalMinutes ?? 20, ...(apiKey ? { apiKey } : {}) }), true); }}>
      <label>API 协议<select aria-label="兜底 API 协议" value={provider} onChange={(event) => { setProvider(event.target.value as MemoryFallbackProvider); setEndpoint(event.target.value === 'deepseek' ? deepSeekBase : ''); setModel(''); setApiKey(''); invalidateModels(); }}><option value="deepseek">DeepSeek 官方（兼容原配置）</option><option value="openai">Chat Completions（OpenAI 兼容）</option><option value="responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini Generate Content</option></select></label>
      <label>独立 API 地址<input aria-label="兜底 API 地址" type="url" required value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setApiKey(''); invalidateModels(); }} /></label>
      <label>模型<div className="memory-fallback-model-control"><div className="api-model-picker"><input aria-label="兜底模型" aria-describedby={modelListId} role="combobox" aria-expanded={modelsOpen && models.length > 0} aria-controls={modelsOpen && models.length ? modelListId + '-options' : undefined} aria-autocomplete="list" placeholder="点击选择或手动填写模型 ID" required value={model}
        onFocus={() => { setModelsOpen(true); void loadModels(); }} onClick={() => setModelsOpen(true)} onChange={event => { setModel(event.target.value); setModelsOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'Escape') setModelsOpen(false);
          if (event.key === 'ArrowDown' && models.length) {
            event.preventDefault();
            if (modelsOpen) event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
            else setModelsOpen(true);
          }
        }} onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setModelsOpen(false); }} />
        {modelsOpen && models.length > 0 && <div className="api-model-options" id={modelListId + '-options'} role="listbox" aria-label="可用模型"
          onBlur={event => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setModelsOpen(false); }}>
          {models.map(id => <button type="button" key={id} role="option" aria-selected={id === model} onMouseDown={event => event.preventDefault()} onClick={() => { setModel(id); setModelsOpen(false); }}><strong>{id}</strong></button>)}
        </div>}
      </div><button className="secondary-button" type="button" aria-label="刷新兜底模型列表" title="读取当前账号可用模型" disabled={modelsBusy || busy} onClick={() => { setModelsOpen(true); void loadModels(true); }}><RefreshCw size={14} /></button></div><small id={modelListId} role={modelsError ? 'status' : undefined}>{modelsBusy ? '正在读取可用模型…' : modelsError || (models.length ? `已读取 ${models.length} 个可用模型` : '可手动填写模型 ID，或点击模型框读取可用模型。')} 用于自动兜底时，模型须支持工具调用。</small></label>
      <label>独立 API Key<input aria-label="兜底 API Key" type="password" autoComplete="off" value={apiKey} placeholder={snapshot?.settings.credentialConfigured ? sameService ? '已安全保存，留空不修改' : '服务已改变，请填写对应的新 Key' : '尚未配置'} onChange={(event) => { setApiKey(event.target.value); invalidateModels(); }} /></label>
      {provider === 'deepseek' && <p className="memory-editor-wide memory-muted">可填写 DeepSeek 官方基础地址，星丛会自动补全请求路径。</p>}
      <footer className="memory-editor-wide memory-fallback-actions">
        <div className="memory-fallback-save-actions"><button className="secondary-button" type="button" disabled={busy || !snapshot?.settings.credentialConfigured} onClick={() => void run(() => window.asteriumMemoryFallback!.configure({ provider: snapshot!.settings.provider, endpoint: snapshot!.settings.endpoint, model: snapshot!.settings.model, intervalMinutes: snapshot!.settings.intervalMinutes, clearCredential: true }), true)}>移除 API Key</button><button className="primary-button" disabled={busy}>保存记忆 API 配置</button></div>
      </footer>
    </form>
    {error && <p className="form-error">{error}</p>}
    </div>
  </details>
  <details className="memory-briefing-card"><summary><strong>星丛记忆兜底</strong></summary>
    <div className="memory-fallback-content">
    <form className="memory-editor" onSubmit={event => {
      event.preventDefault();
      if (!snapshot) return;
      const { provider, endpoint, model } = snapshot.settings;
      void run(() => window.asteriumMemoryFallback!.configure({ provider, endpoint, model, intervalMinutes: interval }));
    }}>
      <label>全局扫描间隔与闲置阈值<select aria-label="兜底扫描时间" value={interval} onChange={(event) => setInterval(Number(event.target.value) as 15 | 20 | 30)}>{[15, 20, 30].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label>
      <p className="memory-editor-wide memory-muted">所有伙伴共用此时间，通常在闲置 {interval}～{interval * 2} 分钟后整理。会将选中伙伴的待处理聊天发送给此独立 API；不会使用伙伴的 API Key。</p>
      <footer className="memory-editor-wide memory-fallback-actions">
        <div className="memory-fallback-partner-control"><button className={`secondary-button memory-fallback-toggle${enabled ? ' is-enabled' : ''}`} aria-pressed={enabled} disabled={busy || !partnerId || (!eligible && !enabled)} type="button" onClick={() => enabled ? void run(() => window.asteriumMemoryFallback!.setPartner({ partnerId, enabled: false })) : setChoosing(true)}><Power size={15} />{enabled ? '关闭此伙伴兜底' : '开启此伙伴兜底'}</button><small>{!enabled ? '未开启' : job?.state === 'running' ? '整理中' : job?.state === 'waiting_retry' ? '等待重试' : '等待闲置'}{job?.lastSuccessAt ? ` · 上次成功 ${new Date(job.lastSuccessAt).toLocaleString('zh-CN')}` : ''}</small></div>
        <button className="primary-button" disabled={busy || !snapshot}>保存扫描间隔</button>
      </footer>
    </form>
    {error && <p className="form-error">{error}</p>}
    </div>
    {choosing && <Modal title="开启此伙伴的记忆兜底" description="请选择开始范围；兜底不会读取其他伙伴的私人记忆。" onClose={() => setChoosing(false)}><div className="memory-editor"><button className="secondary-button" disabled={busy} onClick={() => void run(() => window.asteriumMemoryFallback!.setPartner({ partnerId, enabled: true, history: 'from_now' }))}>从现在开始</button><button className="primary-button" disabled={busy} onClick={() => void run(() => window.asteriumMemoryFallback!.setPartner({ partnerId, enabled: true, history: 'unprocessed' }))}>补做未处理历史</button></div></Modal>}
  </details></>;
}
