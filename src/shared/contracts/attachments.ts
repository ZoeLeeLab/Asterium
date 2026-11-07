export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface PendingMessageAttachment {
  selectionId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  localReference?: true;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  localReference?: true;
}

export interface AttachmentSendRecord {
  messageId: string;
  sentAt: string;
}

export type AttachmentTransport = 'local_path' | 'native_multimodal' | 'metadata_only';

export const COMMON_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
] as const;

export interface AttachmentCapabilities {
  supportsImageInput: boolean;
  acceptedMimeTypes: string[];
  maxImageBytes: number;
  attachmentTransport: AttachmentTransport;
}

export interface ConversationAttachmentInfo extends MessageAttachment {
  createdAt: string;
  sentAt: string;
  sourceId: string;
  sourceAvailability: 'available' | 'missing' | 'unknown';
  sends: AttachmentSendRecord[];
  availability: 'available' | 'missing';
}

export type ArtifactSourceClaim =
  | { kind: 'local_path'; path: string }
  | { kind: 'remote_ref'; provider: string; reference: string }
  | { kind: 'content'; transport: 'https_url' | 'data_url' | 'base64'; value: string }
  | { kind: 'content'; transport: 'bytes'; value: number[] };
