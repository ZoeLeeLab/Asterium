import { z } from 'zod';

export const CYBERBOSS_CHAT_IMAGE_LIMIT = 4;
export const CYBERBOSS_CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CYBERBOSS_CHAT_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const CYBERBOSS_CHAT_IMAGE_HINT = '支持 JPG、PNG、WebP、GIF，一次最多 4 张，单张不超过 10 MiB。';
export const CYBERBOSS_CHAT_FILE_LIMIT = 10;
export const CYBERBOSS_CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const CYBERBOSS_CHAT_TOTAL_MAX_BYTES = 50 * 1024 * 1024;

export interface CyberBossChatFileCapabilities {
  fileTypes: Record<string, string>;
  maxFileBytes: number;
  maxAttachments: number;
  maxImages: number;
  maxImageBytes: number;
  mixedWithImages: boolean;
  maxTotalBytes: number;
}

type ChatAttachment = { name: string; mediaType: string; sizeBytes: number };

export const cyberBossChatFileSchema = z.object({
  kind: z.literal('file'),
  attachmentId: z.string().min(1).max(1024),
  fileName: z.string().min(1).max(512),
  contentType: z.string().min(1).max(256),
  sizeBytes: z.number().int().positive().max(CYBERBOSS_CHAT_FILE_MAX_BYTES),
  url: z.string().min(1).max(2048),
});

export const cyberBossChatFileCapabilitiesSchema = z.object({
  ok: z.literal(true),
  files: z.object({
    version: z.literal(1),
    maxFileBytes: z.number().int().positive(),
    maxAttachmentsPerMessage: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    uncommittedTtlSeconds: z.number().int().positive(),
    mixedWithImages: z.boolean(),
    types: z.array(z.object({
      extension: z.string().regex(/^\.[a-z0-9]+$/),
      contentType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
    })).min(1).max(128),
  }),
  images: z.object({
    maxFileBytes: z.number().int().positive(),
    maxImagesPerMessage: z.number().int().positive(),
  }),
}).transform(({ files, images }): CyberBossChatFileCapabilities => ({
  fileTypes: Object.fromEntries(files.types.map(type => [type.extension.slice(1), type.contentType])),
  maxFileBytes: Math.min(files.maxFileBytes, CYBERBOSS_CHAT_FILE_MAX_BYTES),
  maxAttachments: Math.min(files.maxAttachmentsPerMessage, CYBERBOSS_CHAT_FILE_LIMIT),
  maxImages: Math.min(images.maxImagesPerMessage, CYBERBOSS_CHAT_IMAGE_LIMIT),
  maxImageBytes: Math.min(images.maxFileBytes, CYBERBOSS_CHAT_IMAGE_MAX_BYTES),
  maxTotalBytes: Math.min(files.maxTotalBytes, CYBERBOSS_CHAT_TOTAL_MAX_BYTES),
  mixedWithImages: files.mixedWithImages,
}));

export function isCyberBossChatImage(attachment: ChatAttachment) {
  return imageTypes.has(attachment.mediaType);
}

export function cyberBossChatAttachmentError(attachments: readonly ChatAttachment[], files?: CyberBossChatFileCapabilities) {
  if (!attachments.length) return undefined;
  const images = attachments.filter(isCyberBossChatImage);
  if (!files && (images.length !== attachments.length || images.length > CYBERBOSS_CHAT_IMAGE_LIMIT)) {
    return 'CYBERBOSS_CHAT_IMAGE_UNSUPPORTED';
  }
  if (files && (attachments.length > files.maxAttachments || images.length > files.maxImages)) {
    return 'CYBERBOSS_CHAT_TOO_MANY_ATTACHMENTS';
  }
  if (files && !files.mixedWithImages && images.length > 0 && images.length < attachments.length) {
    return 'CYBERBOSS_CHAT_MIXED_UNSUPPORTED';
  }
  for (const attachment of attachments) {
    if (isCyberBossChatImage(attachment)) {
      if (attachment.sizeBytes < 1 || attachment.sizeBytes > (files?.maxImageBytes ?? CYBERBOSS_CHAT_IMAGE_MAX_BYTES)) {
        return 'CYBERBOSS_CHAT_IMAGE_SIZE';
      }
      continue;
    }
    const extension = /\.([a-z0-9]+)$/i.exec(attachment.name)?.[1].toLowerCase();
    if (!files || !extension || !Object.hasOwn(files.fileTypes, extension) || files.fileTypes[extension] !== attachment.mediaType) return 'CYBERBOSS_CHAT_FILE_TYPE';
    if (attachment.sizeBytes < 1 || attachment.sizeBytes > files.maxFileBytes) return 'CYBERBOSS_CHAT_FILE_SIZE';
  }
  if (files && attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0) > files.maxTotalBytes) {
    return 'CYBERBOSS_CHAT_TOTAL_SIZE';
  }
}

export function cyberBossChatAttachmentHint(code: string, files?: CyberBossChatFileCapabilities) {
  switch (code) {
    case 'CYBERBOSS_CHAT_IMAGE_UNSUPPORTED': return CYBERBOSS_CHAT_IMAGE_HINT;
    case 'CYBERBOSS_CHAT_TOO_MANY_ATTACHMENTS': return `每条消息最多 ${files?.maxAttachments ?? CYBERBOSS_CHAT_FILE_LIMIT} 个附件，其中图片最多 ${files?.maxImages ?? CYBERBOSS_CHAT_IMAGE_LIMIT} 张。`;
    case 'CYBERBOSS_CHAT_IMAGE_SIZE': return `图片不能为空，单张最多 ${(files?.maxImageBytes ?? CYBERBOSS_CHAT_IMAGE_MAX_BYTES) / 1024 / 1024} MiB。`;
    case 'CYBERBOSS_CHAT_MIXED_UNSUPPORTED': return '此 CyberBoss 连接需要分开发送图片和普通文件。';
    case 'CYBERBOSS_CHAT_FILE_UNAVAILABLE': return '当前 CyberBoss 未提供可用的普通文件功能，请重新打开单聊检查连接。';
    case 'CYBERBOSS_CHAT_FILE_TYPE': return '此 CyberBoss 连接不支持所选文件类型。';
    case 'CYBERBOSS_CHAT_FILE_SIZE': return `文件不能为空，单件最多 ${(files?.maxFileBytes ?? CYBERBOSS_CHAT_FILE_MAX_BYTES) / 1024 / 1024} MiB。`;
    case 'CYBERBOSS_CHAT_TOTAL_SIZE': return `每条消息附件合计最多 ${(files?.maxTotalBytes ?? CYBERBOSS_CHAT_TOTAL_MAX_BYTES) / 1024 / 1024} MiB。`;
    default: return undefined;
  }
}
