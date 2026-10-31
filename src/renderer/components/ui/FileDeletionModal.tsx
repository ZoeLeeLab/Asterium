import { AlertTriangle, FileText, Trash2 } from 'lucide-react';
import type { FileDeletionInspection } from '../../../shared/projectWorkspace';
import { Modal } from './Modal';

interface FileDeletionModalProps {
  inspection: FileDeletionInspection;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function FileDeletionModal({ inspection, busy, error, onClose, onConfirm }: FileDeletionModalProps) {
  const blocked = !inspection.canDelete;
  const trash = inspection.action === 'trash_and_remove';
  const title = blocked ? '无法删除文件' : trash ? '移入回收站？' : '从星丛移除？';
  const description = blocked
    ? '该文件仍会被未完成任务、活动流程或后续节点依赖使用。为避免破坏运行链路，不能删除原文件。'
    : trash
      ? '确认后会将 Windows 中的原文件移入回收站，并从当前文件列表移除。'
      : '这会移除当前文件记录；已有历史来源信息仍会保留。';

  return <Modal size="md" title={title} description={description} onClose={() => !busy && onClose()}>
    <div className="modal-body file-deletion-detail">
      <div className="file-deletion-target"><FileText size={18} /><span><strong>{inspection.name}</strong>{inspection.absolutePath && <small title={inspection.absolutePath}>{inspection.absolutePath}</small>}</span></div>
      {blocked && <div className="file-deletion-references"><header><AlertTriangle size={15} /><strong>引用位置</strong></header><ul>{inspection.references.map((reference, index) => <li key={`${reference.kind}-${reference.projectId ?? ''}-${reference.taskId ?? ''}-${reference.fileId ?? ''}-${index}`}>{reference.label}</li>)}</ul></div>}
      {error && <p className="modal-error">{error}</p>}
    </div>
    <footer className="modal-footer">
      <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>{blocked ? '关闭' : '取消'}</button>
      {!blocked && <button className="danger-button" type="button" disabled={busy} onClick={onConfirm}><Trash2 size={14} />{busy ? '正在处理…' : trash ? '移入回收站' : '确认移除'}</button>}
    </footer>
  </Modal>;
}
