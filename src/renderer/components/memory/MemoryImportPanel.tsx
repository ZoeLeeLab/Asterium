import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MEMORY_IMPORT_MAX_CHARS, type MemoryImportCandidate, type MemoryImportReceipt, type MemoryImportPreview, type MemoryImportUndo } from '../../../shared/memoryImport';
import type { MemoryFallbackSettings } from '../../../shared/memoryFallback';
import { memoryTypeLabels } from './memoryLabels';

function importError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('MEMORY_IMPORT_CONNECTION_CHANGED')) return '模型连接已更改，请刷新配置后重新确认。';
  if (message.includes('MEMORY_IMPORT_CREDENTIAL_REQUIRED')) return '请先在上方设置并保存提炼 API 的凭据。';
  if (message.includes('MEMORY_IMPORT_PREVIEW_EXPIRED')) return '预览已失效，请重新提炼。';
  if (message.includes('MEMORY_IMPORT_PARTNER_UNAVAILABLE')) return '该伙伴当前无法使用星丛记忆导入。';
  if (message.includes('MEMORY_IMPORT_BUSY')) return '上一项提炼正在结束，请稍后重试。';
  const diagnostics = [...message.matchAll(/MEMORY_IMPORT_OUTPUT_DIAGNOSTIC:([a-z_]+):([\w-]+)/g)];
  if (diagnostics.length) return diagnostics.map(([, category, finish], index) => {
    const labels: Record<string, string> = {
      truncated: '回复截断', invalid_json: 'JSON 无法解析', empty_output: '没有正文',
      field_type: '记忆类型字段未通过校验', field_body: '正文字段未通过校验',
      field_paragraph: '段落编号字段未通过校验', source_not_in_batch: '来源编号不在本批',
      unexpected_fields: '含额外字段', invalid_item: '条目结构无效', expected_array: '顶层应为列表',
      item_limit: '条目超过上限', local_output_limit: '回复超过本地上限', unexpected_tool: '返回了工具调用',
    };
    return `${diagnostics.length > 1 ? `第 ${index + 1} 次：` : ''}${labels[category] ?? category}（结束原因 ${finish === 'missing' ? '未收到' : finish}）`;
  }).join('。');
  if (message.includes('MEMORY_IMPORT_TOO_MANY_CANDIDATES')) return '提炼出的候选太多，请分次导入。';
  if (message.includes('MEMORY_IMPORT_CONTENT_FILTERED')) return '模型服务拦截了本次提炼。请检查所选文本或更换模型。';
  if (/MEMORY_IMPORT_TIMEOUT|API_HEADER_TIMEOUT/.test(message)) return '提炼请求超时。可缩小文本范围后重试。';
  const status = /(?:API|DEEPSEEK)_HTTP_(\d{3})/.exec(message)?.[1];
  if (status === '401' || status === '403') return '模型服务拒绝了请求。请检查 API Key 和模型权限。';
  if (status === '429') return '模型服务请求过于频繁或已达额度限制，请稍后重试。';
  if (status) return `模型服务请求失败（HTTP ${status}）。请检查连接配置后重试。`;
  if (/STREAM_INTERRUPTED|EMPTY_STREAM|MALFORMED_SSE/.test(message)) return '模型回复中断或流格式无效，请稍后重试。';
  return '操作未完成。请检查提炼模型和网络，或稍后重试。';
}

export function MemoryImportPanel({ partnerId }: { partnerId: string }) {
  const api = window.asteriumMemory?.importText;
  const fallback = window.asteriumMemoryFallback;
  const [config, setConfig] = useState<MemoryFallbackSettings>();
  const [text, setText] = useState('');
  const [label, setLabel] = useState('粘贴的对话');
  const [candidates, setCandidates] = useState<Array<MemoryImportCandidate & { selected: boolean }>>();
  const [previewScrollbarVisible, setPreviewScrollbarVisible] = useState(false);
  const [previewSummary, setPreviewSummary] = useState<Omit<MemoryImportPreview, 'candidates'>>();
  const [receipt, setReceipt] = useState<MemoryImportReceipt>();
  const [undo, setUndo] = useState<MemoryImportUndo>();
  const [busy, setBusy] = useState<'file' | 'preview' | 'confirm' | 'undo'>();
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const batch = useRef<string | undefined>(undefined);

  useEffect(() => () => {
    if (batch.current) void api?.cancel({ partnerId, batchId: batch.current }).catch(() => undefined);
    batch.current = undefined;
  }, [api, partnerId]);

  if (!api || !fallback) return null;

  const refresh = async () => {
    setError('');
    try {
      setConfig((await fallback.get()).settings);
    } catch {
      setConfig(undefined);
      setError('读取提炼模型配置失败。');
    }
  };

  const clearPreview = () => {
    const batchId = batch.current;
    batch.current = undefined;
    setCandidates(undefined);
    setPreviewScrollbarVisible(false);
    setError('');
    if (batchId) void api.cancel({ partnerId, batchId }).catch(() => undefined);
    if (busy === 'preview') setBusy(undefined);
  };

  const preview = async () => {
    if (!config?.credentialConfigured || busy) return;
    const batchId = crypto.randomUUID();
    batch.current = batchId;
    setBusy('preview');
    setError('');
    try {
      const result = await api.preview({ partnerId, batchId, text, label, endpoint: config.endpoint, provider: config.provider, model: config.model });
      if (batch.current === batchId) {
        setCandidates(result.candidates.map(item => ({ ...item, selected: true })));
        setPreviewSummary({ duplicateCount: result.duplicateCount, rejectedCount: result.rejectedCount, failedBatchCount: result.failedBatchCount, diagnostic: result.diagnostic });
      }
    } catch (failure) {
      if (batch.current === batchId) setError(importError(failure));
    } finally {
      if (batch.current === batchId) setBusy(undefined);
    }
  };

  const confirm = async () => {
    const batchId = batch.current;
    const selected = candidates?.filter(item => item.selected).map(({ id, type, body }) => ({ id, type, body }));
    if (!batchId || !selected?.length || busy) return;
    setBusy('confirm');
    setError('');
    try {
      setReceipt(await api.confirm({ partnerId, batchId, selected }));
      setCandidates(undefined);
      setText('');
    } catch (failure) {
      setError(importError(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const undoBatch = async () => {
    if (!batch.current || busy) return;
    setBusy('undo');
    setError('');
    try {
      setUndo(await api.undo({ partnerId, batchId: batch.current }));
    } catch (failure) {
      setError(importError(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const readFile = async (file: File) => {
    setBusy('file');
    setError('');
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('请选择 .txt 或 .md 文件。');
      if (file.size > MEMORY_IMPORT_MAX_CHARS * 4 + 3) throw new Error('文件过长，请拆分后导入。');
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('无法读取文件，请确认文件使用 UTF-8 编码。');
      }
      if (content.length > MEMORY_IMPORT_MAX_CHARS) throw new Error('文件过长，请拆分后导入。');
      setText(content);
      setLabel(file.name.slice(0, 255));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '文件读取失败。');
    } finally {
      setBusy(undefined);
    }
  };

  const selected = candidates?.filter(item => item.selected) ?? [];
  const incomplete = Boolean(previewSummary && (previewSummary.rejectedCount || previewSummary.failedBatchCount));
  return <details className="memory-briefing-card" onToggle={event => { if (event.currentTarget.open) void refresh(); }}>
    <summary><strong>导入旧对话</strong><small>提炼后由你确认</small></summary>
    <div className="memory-fallback-content"><div className="memory-editor memory-import-editor">
      {receipt ? <>
        <p className="memory-editor-wide" role="status">已导入 {receipt.added} 条，跳过 {receipt.skipped} 条。{undo && `已移入归档库 ${undo.removed} 条，保留 ${undo.retained} 条已修改或被引用的记忆。`}</p>
        <footer className="memory-editor-wide">
          {receipt.added > 0 && !undo && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void undoBatch()}>撤销本批</button>}
          <button type="button" className="primary-button" disabled={!!busy} onClick={() => { clearPreview(); setReceipt(undefined); setUndo(undefined); setLabel('粘贴的对话'); }}>开始新导入</button>
        </footer>
      </> : candidates ? <>
        <p className="memory-editor-wide" role="status">{candidates.length ? `提炼了 ${candidates.length} 条候选。请核对原文，再选择要写入的条目。` : incomplete ? '未能生成可导入的候选。' : previewSummary?.duplicateCount ? `提炼出的 ${previewSummary.duplicateCount} 条候选与已有条目重复。` : '模型没有提炼出值得长期保留的记忆。单次问答、临时看图和只有附件名的内容通常不会生成记忆。可返回补充背景或选择另一段对话。'}</p>
        {incomplete && previewSummary && <p className="memory-editor-wide" role="alert">
          跳过 {previewSummary.rejectedCount} 条未通过校验的候选，{previewSummary.failedBatchCount} 个片段提炼失败。
          {previewSummary.diagnostic && ` 首个问题：${importError(new Error(previewSummary.diagnostic))}。`}
        </p>}
        {candidates.length > 0 && <div
          className={`memory-editor-wide memory-import-preview${previewScrollbarVisible ? ' memory-scrollbar-visible' : ''}`}
          role="region"
          aria-label="记忆候选列表"
          tabIndex={0}
          onPointerMove={event => setPreviewScrollbarVisible(event.currentTarget.getBoundingClientRect().right - event.clientX <= 20)}
          onPointerLeave={() => setPreviewScrollbarVisible(false)}
        >
        {candidates.map((item, index) => <fieldset className="memory-editor-wide" key={item.id} disabled={!!busy}>
          <legend>候选 {index + 1}</legend>
          <label className="memory-import-selection"><input type="checkbox" checked={item.selected} onChange={event => setCandidates(items => items?.map(candidate => candidate.id === item.id ? { ...candidate, selected: event.target.checked } : candidate))} />导入这条</label>
          <label>类型<select value={item.type} onChange={event => { const type = event.target.value as MemoryImportCandidate['type']; setCandidates(items => items?.map(candidate => candidate.id === item.id ? { ...candidate, type } : candidate)); }}>
            {Object.entries(memoryTypeLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select></label>
          <label>记忆正文<textarea rows={3} maxLength={2000} value={item.body} onChange={event => setCandidates(items => items?.map(candidate => candidate.id === item.id ? { ...candidate, body: event.target.value } : candidate))} /></label>
          <blockquote>{label} · 第 {item.paragraph} 段<br />{item.excerpt}</blockquote>
          {item.possibleConflicts.length > 0 && <p>请核对已有相近记忆：{item.possibleConflicts.join('；')}</p>}
        </fieldset>)}
        </div>}
        <footer className="memory-editor-wide">
          <button type="button" className="secondary-button" disabled={!!busy} onClick={clearPreview}>返回编辑原文</button>
          <button type="button" className="primary-button" disabled={!!busy || !selected.length || selected.some(item => !item.body.trim())} onClick={() => void confirm()}>确认导入（{selected.length}）</button>
        </footer>
      </> : <>
        <div className="memory-editor-wide memory-import-file">
          <input ref={fileInput} type="file" aria-label="选择 UTF-8 文本文件" accept=".txt,.md" hidden disabled={!!busy} onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void readFile(file);
          }} />
          <button className="secondary-button" type="button" disabled={!!busy} onClick={() => fileInput.current?.click()}><Upload size={15} />选择文本文件</button>
          <small>{label === '粘贴的对话' ? '支持 UTF-8 .txt、.md' : label}</small>
        </div>
        <label className="memory-editor-wide">要发送的对话文本<textarea rows={7} value={text} disabled={!!busy} onChange={event => setText(event.target.value)} /></label>
        <p className="memory-editor-wide">将发送文本框中的内容（{text.length} / {MEMORY_IMPORT_MAX_CHARS} 字符）。请先删掉不想发给模型的段落。星丛会跳过已识别的内部自动化触发记录。{config?.credentialConfigured ? `模型 ${config.model} · ${config.provider === 'deepseek' ? config.endpoint.replace(/\/chat\/completions$/, '/') : config.endpoint}` : '请先在上方「记忆管理 API 配置」中保存连接，再刷新配置。'}</p>
        <footer className="memory-editor-wide">
          <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void refresh()}>刷新模型配置</button>
          {busy === 'preview'
            ? <button type="button" className="secondary-button" onClick={clearPreview}>取消提炼</button>
            : <button type="button" className="primary-button" disabled={!!busy || !config?.credentialConfigured || !text.trim() || text.length > MEMORY_IMPORT_MAX_CHARS} onClick={() => void preview()}>发送并生成预览</button>}
        </footer>
      </>}
      {error && <p className="form-error memory-editor-wide" role="alert">{error}</p>}
    </div></div>
  </details>;
}
