import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexQuotaRequest, CodexQuotaResult, CodexQuotaWindow } from '../../../shared/codexQuota';

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const percent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

type QuotaSnapshot = Extract<CodexQuotaResult, { status: 'available' }>;
const statusText = {
  login_required: '请先在本机 Codex 登录 ChatGPT',
  chatgpt_required: '当前 Codex 登录方式不提供 ChatGPT 套餐额度',
  runtime_unavailable: '找不到此伙伴配置的本机 Codex，请在伙伴设置中检查',
  unavailable: '暂时无法获取额度，请稍后刷新',
};

export function CodexQuotaDetail({ partnerId, importedConversationId, visible }: CodexQuotaRequest & { visible: boolean }) {
  const readQuota = window.asteriumAgents?.readCodexQuota;
  const pending = useRef(false);
  const loadedOnce = useRef(false);
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [issue, setIssue] = useState<keyof typeof statusText>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!readQuota || pending.current) return;
    pending.current = true;
    setBusy(true);
    setIssue(undefined);
    try {
      const result = await readQuota({ partnerId, importedConversationId });
      if (result.status === 'available') setSnapshot(result);
      else {
        if (result.status !== 'unavailable') setSnapshot(undefined);
        setIssue(result.status);
      }
    } catch {
      setIssue('unavailable');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [importedConversationId, partnerId, readQuota]);

  useEffect(() => {
    if (!visible || !readQuota || loadedOnce.current) return;
    loadedOnce.current = true;
    void refresh();
  }, [readQuota, refresh, visible]);

  return <div className="quick-detail codex-quota">
    <span className="quick-directory-section__heading">
      <span>Codex 额度</span>
      <button type="button" aria-label="刷新 Codex 额度" title="刷新额度" disabled={busy || !readQuota} onClick={() => void refresh()}>
        <RefreshCw className={busy ? 'spin' : undefined} size={12} aria-hidden="true" />
      </button>
    </span>
    <div className="codex-quota__status" role="status">
      {snapshot?.windows.map((window, index) => <QuotaWindow key={index} window={window} index={index} />)}
      {busy ? <small>正在查询…</small>
        : issue ? <small>{snapshot ? '刷新失败，显示上次结果' : statusText[issue]}</small>
        : !readQuota ? <small>仅桌面应用可查询</small> : null}
    </div>
  </div>;
}

function QuotaWindow({ window, index }: { window: CodexQuotaWindow; index: number }) {
  const minutes = window.durationMinutes;
  const duration = minutes === undefined ? (index === 0 ? '主要额度' : '次要额度')
    : minutes === 10_080 ? '每周额度'
    : minutes % 1440 === 0 ? `${minutes / 1440} 天`
    : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : undefined;
  return <div className="codex-quota__window">
    <span>{duration}</span>
    <strong>剩余 {percent.format(100 - window.usedPercent)}%</strong>
    <small>{reset ? <>重置于 <time dateTime={reset.toISOString()}>{dateTime.format(reset)}</time></> : '重置时间未知'}</small>
  </div>;
}
