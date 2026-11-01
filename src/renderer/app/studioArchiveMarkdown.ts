import type { StudioRoomSnapshot } from '../../shared/studioRuntime';

interface StudioArchiveMarkdownIdentity {
  userId: string;
  userName: string;
  partners: Array<{ id: string; name: string }>;
}

export function formatStudioArchiveMarkdown(snapshot: StudioRoomSnapshot, identity: StudioArchiveMarkdownIdentity) {
  const partnerNames = new Map(identity.partners.map((partner) => [partner.id, partner.name]));
  const sections = snapshot.messages.map((message) => {
    const author = message.authorType === 'system'
      ? '系统'
      : message.authorType === 'user' && message.authorId === identity.userId
        ? identity.userName
        : partnerNames.get(message.authorId) ?? (message.authorType === 'user' ? '用户' : '未知伙伴');
    const attachments = message.attachments?.map(item => `- ${item.name} (${item.mediaType}, ${item.sizeBytes} bytes), attachment_id: ${item.id}`).join('\n');
    return `### ${author} · ${new Date(message.createdAt).toLocaleString('zh-CN')}\n\n${message.content}${attachments ? `\n\n用户附件（仅元数据，文件未嵌入导出）：\n${attachments}` : ''}`;
  });
  const body = sections.length ? sections.join('\n\n---\n\n') : '_此群聊没有消息。_';
  return `# ${snapshot.metadata.name}\n\n> 此文件由星丛从只读群聊归档导出。\n\n${body}\n`;
}
