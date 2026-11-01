import { readFile, stat } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { MAX_MESSAGE_ATTACHMENT_BYTES } from './ConversationAttachmentStore';

/** The caller must resolve the managed path through the attachment store first. */
export async function createAttachmentThumbnail(sourcePath: string): Promise<string> {
  const file = await stat(sourcePath);
  if (!file.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
  if (file.size > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  const bytes = await readFile(sourcePath);
  if (bytes.length > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  // Managed snapshots have no extension. Decode bytes, without the Shell cache.
  // Unsupported/corrupt image data has no thumbnail; it is not a missing file.
  try {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return '';
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0) return '';
    const scale = Math.min(1, 960 / width, 720 / height);
    const thumbnail = scale < 1 ? image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }) : image;
    return thumbnail.isEmpty() ? '' : thumbnail.toDataURL();
  } catch { return ''; }
}
