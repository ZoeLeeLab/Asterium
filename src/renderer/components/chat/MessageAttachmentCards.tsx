import { useEffect, useState } from 'react';
import { FileImage, FileText } from 'lucide-react';
import type { ConversationAttachmentInfo, MessageAttachment } from '../../../shared/agentProtocol';

export function MessageAttachmentCards({ attachments, conversationId, onPreview, onContextMenu }: { attachments?: MessageAttachment[]; conversationId: string; onPreview: (attachment: MessageAttachment) => void; onContextMenu: (attachment: MessageAttachment, x: number, y: number) => void }) {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [availability, setAvailability] = useState<Record<string, ConversationAttachmentInfo['availability']>>({});
  useEffect(() => {
    let active = true;
    for (const attachment of attachments ?? []) {
      if (availability[attachment.id]) continue;
      void window.asteriumAttachments?.inspect(attachment.id, conversationId).then((info) => {
        if (!active) return;
        setAvailability((current) => ({ ...current, [attachment.id]: info.availability }));
        if (info.availability === 'available' && attachment.mediaType.startsWith('image/')) void window.asteriumAttachments?.thumbnail(attachment.id, conversationId)
          .then((value) => { if (active) setThumbnails((current) => ({ ...current, [attachment.id]: value })); })
          .catch(() => { if (active) setAvailability((current) => ({ ...current, [attachment.id]: 'missing' })); });
      }).catch(() => { if (active) setAvailability((current) => ({ ...current, [attachment.id]: 'missing' })); });
    }
    return () => { active = false; };
  }, [attachments, availability, conversationId]);
  if (!attachments?.length) return null;
  return <div className={`message-attachments ${attachments.length > 1 ? 'message-attachments--multiple' : ''}`}>{attachments.map((attachment) => {
    const image = attachment.mediaType.startsWith('image/');
    const status = availability[attachment.id];
    const missing = status === 'missing';
    const content = <>{thumbnails[attachment.id] ? <img src={thumbnails[attachment.id]} alt="" /> : image ? <FileImage size={20} /> : <FileText size={20} />}<span><strong>{attachment.name}</strong><small>{status === 'missing' ? '附件快照不可用' : `${formatBytes(attachment.sizeBytes)} · 点击预览`}</small></span></>;
    return <button type="button" className="message-attachment-card" key={attachment.id} disabled={missing} onClick={() => onPreview(attachment)} onContextMenu={(event) => { event.preventDefault(); onContextMenu(attachment, event.clientX, event.clientY); }}>{content}</button>;
  })}</div>;
}


function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
