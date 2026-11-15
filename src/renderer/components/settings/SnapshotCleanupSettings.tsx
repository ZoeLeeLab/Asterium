import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import type { SnapshotCleanupApi, SnapshotCleanupPreview } from '../../../shared/snapshotCleanup';
import { Modal } from '../ui/Modal';

type FormatSize = (bytes: number) => string;

export function SnapshotCleanupSettings({ formatSize }: { formatSize: FormatSize }) {
  return <section className="snapshot-cleanup-settings" aria-label="历史快照">
    <CleanupCard
      title="AI 交付快照" button="清除 AI 过期快照"
      detail="清理单聊历史里已被替代的交付清单，保留聊天消息、交付链接和迁移备份。"
      api={window.asteriumConversations} formatSize={formatSize}
    />
    <CleanupCard
      title="用户附件快照" button="清除用户重复快照"
      detail="合并内容完全一致的内部副本。源文件、内容不同的版本和消息中的附件都会保留。"
      api={window.asteriumAttachments} formatSize={formatSize}
    />
  </section>;
}

function CleanupCard({ title, button, detail, api, formatSize }: {
  title: string;
  button: string;
  detail: string;
  api?: Partial<SnapshotCleanupApi>;
  formatSize: FormatSize;
}) {
  const [preview, setPreview] = useState<SnapshotCleanupPreview>();
  const [busy, setBusy] = useState<'scan' | 'clear'>();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  const supported = Boolean(api?.previewSnapshotCleanup && api.clearSnapshots);

  async function scan() {
    if (!api?.previewSnapshotCleanup || busy) return;
    setBusy('scan');
    setNote('');
    setError('');
    try {
      const result = await api.previewSnapshotCleanup();
      if (result.count) setPreview(result);
      else setNote(result.skippedCount ? '本次没有可处理的快照，部分记录暂时无法检查。' : '没有可清理的快照。');
    } catch { setError('快照暂时无法扫描，请稍后重试。'); }
    finally { setBusy(undefined); }
  }

  async function clear() {
    if (!preview || !api?.clearSnapshots || busy) return;
    setBusy('clear');
    setError('');
    try {
      const result = await api.clearSnapshots(preview.planId);
      setNote(`已处理 ${result.clearedCount} 项，释放 ${formatSize(result.freedBytes)}。${result.skippedCount ? '部分文件未处理，可以重新扫描。' : ''}`);
    } catch { setError('清理计划已失效或暂时无法执行，请重新扫描。'); }
    finally {
      setBusy(undefined);
      setPreview(undefined);
    }
  }

  return <article className="cache-settings-card">
    <div><span className="snapshot-cleanup-title">{title}</span><small>{detail}</small></div>
    <button className="secondary-button" type="button" disabled={!supported || Boolean(busy) || Boolean(preview)} onClick={() => void scan()}>
      <Trash2 size={14} />{busy === 'scan' ? '正在扫描…' : button}
    </button>
    {note && <p role="status">{note}</p>}
    {error && <p role="alert">{error}</p>}
    {preview && createPortal(<Modal
      title={button} description={detail} initialFocusRef={cancel}
      onClose={() => { if (!busy) setPreview(undefined); }}
    >
      <div className="modal-body snapshot-cleanup-review">
        <strong>{formatSize(preview.bytes)}</strong>
        <span>预计可释放空间 · {preview.count} 项</span>
        {preview.skippedCount > 0 && <small>有 {preview.skippedCount} 项暂时无法检查，将跳过。</small>}
      </div>
      <footer className="modal-footer">
        <button ref={cancel} className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setPreview(undefined)}>取消</button>
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void clear()}>{busy === 'clear' ? '正在清理…' : '确认清理'}</button>
      </footer>
    </Modal>, document.body)}
  </article>;
}
