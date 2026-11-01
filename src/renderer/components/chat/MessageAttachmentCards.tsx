import { useEffect, useState } from 'react';
import { FileImage, FileText } from 'lucide-react';
import type { ConversationAttachmentInfo, MessageAttachment } from '../../../shared/agentProtocol';

interface Props {
  attachments?: MessageAttachment[];
  conversationId: string;
  onPreview: (attachment: MessageAttachment) => void;
  onContextMenu: (attachment: MessageAttachment, x: number, y: number) => void;
}

export function MessageAttachmentCards({ attachments, conversationId, onPreview, onContextMenu }: Props) {
  if (!attachments?.length) return null;
  return <div className={`message-attachments ${attachments.length > 1 ? 'message-attachments--multiple' : ''}`}>{attachments.map(attachment =>
    <AttachmentCard key={`${conversationId}:${attachment.id}`} attachment={attachment} conversationId={conversationId} onPreview={onPreview} onContextMenu={onContextMenu} />,
  )}</div>;
}

function AttachmentCard({ attachment, conversationId, onPreview, onContextMenu }: Omit<Props, 'attachments'> & { attachment: MessageAttachment }) {
  const [thumbnail, setThumbnail] = useState('');
  const [availability, setAvailability] = useState<ConversationAttachmentInfo['availability']>();
  const { id, mediaType } = attachment;
  useEffect(() => {
    let active = true;
    const api = window.asteriumAttachments;
    void api?.inspect(id, conversationId).then(async info => {
      if (!active) return;
      setAvailability(info.availability);
      if (info.availability === 'available' && mediaType.startsWith('image/')) {
        try {
          const value = await api.thumbnail(id, conversationId);
          if (active) setThumbnail(value);
        } catch {
          // Thumbnail errors do not establish that the snapshot is missing.
          // The main process still rechecks the store on preview/open/read.
          if (active) setThumbnail('');
        }
      }
    }).catch(() => { if (active) setAvailability('missing'); });
    return () => { active = false; };
  }, [id, mediaType, conversationId]);
  const image = mediaType.startsWith('image/');
  const missing = availability === 'missing';
  return <button type="button" className="message-attachment-card" disabled={missing} onClick={() => onPreview(attachment)} onContextMenu={event => { event.preventDefault(); onContextMenu(attachment, event.clientX, event.clientY); }}>
    {thumbnail ? <img src={thumbnail} alt="" /> : image ? <FileImage size={20} /> : <FileText size={20} />}
    <span><strong>{attachment.name}</strong><small>{missing ? '附件快照不可用' : `${formatBytes(attachment.sizeBytes)} · 点击预览`}</small></span>
  </button>;
}


function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
