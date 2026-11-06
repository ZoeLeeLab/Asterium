import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import type { CodexModelListRequest, CodexModelOption, CodexModelSelection } from '../../../shared/codexModels';

interface CodexModelPickerProps extends CodexModelListRequest {
  selection?: CodexModelSelection;
  currentModel?: string;
  disabled: boolean;
  onChange: (selection: CodexModelSelection) => void;
}

export function CodexModelPicker({ partnerRootGrantId, codexRuntimeId, codexRuntimeEnvironment, selection, currentModel, disabled, onChange }: CodexModelPickerProps) {
  const [catalog, setCatalog] = useState<CodexModelOption[]>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);

  const loadModels = async () => {
    const list = window.asteriumAgents?.listCodexModels;
    if (!list || catalog || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      setCatalog(await list({ partnerRootGrantId, codexRuntimeId, codexRuntimeEnvironment }));
    } catch {
      setFailed(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const modelId = selection?.model ?? currentModel;
  const model = catalog?.find(option => option.model === modelId);
  const effort = selection?.effort ?? model?.defaultEffort;
  const displayedEffort = effort && model?.efforts.includes(effort) ? effort : undefined;

  return <>
    <label className="quick-detail quick-detail--model">
      <span>选择模型</span>
      <span className="quick-model-select quick-model-select--codex">
        <select aria-label="选择 Codex 模型" aria-busy={loading} value={model?.model ?? ''} disabled={disabled} onFocus={() => void loadModels()} onChange={event => {
          const next = catalog?.find(option => option.model === event.target.value);
          if (next) onChange({ model: next.model, ...(next.defaultEffort ? { effort: next.defaultEffort } : {}) });
        }}>
          {!model && <option value="" disabled>{modelId ?? '选择模型'}</option>}
          {catalog?.map(option => <option key={option.model} value={option.model}>{option.displayName}</option>)}
        </select>
        {loading ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      </span>
      <small role={failed ? 'status' : undefined}>{failed ? '暂时无法读取模型列表，重新选择时会重试。'
        : catalog?.length === 0 ? '当前 Codex 未报告可选模型。' : '选择会用于下一轮。'}</small>
    </label>
    {model && model.efforts.length > 0 && <label className="quick-detail quick-detail--model">
      <span>思考强度</span>
      <span className="quick-model-select quick-model-select--codex">
        <select aria-label="思考强度" value={displayedEffort ?? ''} disabled={disabled} onChange={event => onChange({ model: model.model, effort: event.target.value })}>
          {!displayedEffort && <option value="" disabled>模型默认</option>}
          {model.efforts.map(option => <option key={option} value={option}>{effortLabels[option] ?? option}</option>)}
        </select>
        <ChevronDown size={13} aria-hidden="true" />
      </span>
    </label>}
  </>;
}

const effortLabels: Record<string, string> = {
  none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
};
