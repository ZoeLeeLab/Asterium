import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { SessionStatus } from '../../../shared/sessionCommands';

const permissions = { read_only: '只读', manual: '手动审批', automatic: '自动审批', full: '完整权限' };
const states = { idle: '空闲', running: '运行中', waiting_authorization: '等待审批', waiting_user_input: '等待回答', maintenance: '正在维护会话' };
export function SessionCommandNotice({ result, onDismiss, label = '会话指令结果' }: { result: { state: 'running' | 'success' | 'info' | 'error'; message: string; session?: SessionStatus }; onDismiss: () => void; label?: string }) {
  const session = result.session;
  useEffect(() => {
    if (session || (result.state !== 'success' && result.state !== 'info')) return;
    const timer = window.setTimeout(onDismiss, 5_000);
    return () => window.clearTimeout(timer);
  }, [result, session, onDismiss]);
  return <section className={`session-command-notice compaction-notice--${result.state}`} role="status" aria-label={label}>
    <div className="session-command-notice-header"><strong>{result.message}</strong>{result.state !== 'running' && <button type="button" onClick={onDismiss} aria-label={`收起${label}`} title="收起"><X size={15} /></button>}</div>
    {session?.profileRecoveryRequired && session.state !== 'maintenance' && <p>上次资料重读需要恢复，普通续聊已暂停。请重试资料重读，或新建对话。</p>}
    {session && <dl>
      <div><dt>对话 ID</dt><dd>{session.conversationId}</dd></div>
      <div><dt>线程／会话 ID</dt><dd>{session.sessionId ?? '尚未建立'}</dd></div>
      <div><dt>伙伴来源</dt><dd>{{ api_partner: 'API 伙伴', local_cli: '本地伙伴', existing_thread: '接回伙伴' }[session.source]}</dd></div>
      <div><dt>模型</dt><dd>{session.model}{session.modelStatus === 'configured' ? '（配置值）' : session.modelStatus === 'recent' ? '（本会话最近报告）' : ''}</dd></div>
      <div><dt>运行状态</dt><dd>{states[session.state]}</dd></div>
      <div><dt>当前所选权限</dt><dd>{session.permissionMode ? permissions[session.permissionMode] : '尚未记录'}</dd></div>
      <div><dt>当前所选 Plan</dt><dd>{session.planMode === 'plan' ? '计划模式' : session.planMode === 'default' ? '普通模式' : '尚未记录'}{session.planStatus ? ' · ' + ({ planning: '规划中', waiting_user: '等待回答', ready: '计划已就绪', executing: '执行中', completed: '已完成' }[session.planStatus]) : ''}</dd></div>
      {session.appliedProfiles && <><div><dt>已应用用户资料版本</dt><dd>{session.appliedProfiles.user}</dd></div><div><dt>已应用伙伴人设版本</dt><dd>{session.appliedProfiles.persona}</dd></div></>}
    </dl>}
  </section>;
}
