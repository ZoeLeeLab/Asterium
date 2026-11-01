// @vitest-environment node
import { mkdtemp, writeFile, rm, truncate, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_ATTACHMENT_BYTES } from '../../src/main/security/ConversationAttachmentStore';
import { createAttachmentThumbnail } from '../../src/main/security/attachmentThumbnail';

const native = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: native.decode } }));
const directories: string[] = [];
beforeEach(() => { native.decode.mockReset(); });
afterEach(async () => { for (const directory of directories.splice(0)) {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('asterium-thumbnail-')) throw Error('UNSAFE_TEST_CLEANUP');
  await rm(directory, { recursive: true, force: true });
} });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-thumbnail-')); directories.push(directory);
  const file = path.join(directory, 'content'), bytes = Buffer.from('synthetic image bytes; decoder mocked');
  await writeFile(file, bytes); return { directory, file, bytes };
}

it('decodes an extensionless snapshot by bytes and fits the result without distortion', async () => {
  const { file, bytes } = await fixture();
  const thumbnail = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,c3ludGhldGlj' };
  const resize = vi.fn(() => thumbnail);
  native.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 1920, height: 960 }), resize });
  expect(await createAttachmentThumbnail(file)).toBe(thumbnail.toDataURL());
  expect(native.decode).toHaveBeenCalledWith(bytes); expect(resize).toHaveBeenCalledWith({ width: 960, height: 480 });
});
it('keeps small images at their original size', async () => {
  const { file } = await fixture(), resize = vi.fn();
  native.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 32, height: 24 }), resize, toDataURL: () => 'small' });
  expect(await createAttachmentThumbnail(file)).toBe('small'); expect(resize).not.toHaveBeenCalled();
});
it('returns no thumbnail for unsupported or corrupt bytes without changing the snapshot', async () => {
  const { file, bytes } = await fixture(); native.decode.mockReturnValue({ isEmpty: () => true });
  expect(await createAttachmentThumbnail(file)).toBe('');
  native.decode.mockImplementation(() => { throw new Error('synthetic decoder error'); });
  expect(await createAttachmentThumbnail(file)).toBe('');
  const { readFile } = await import('node:fs/promises'); expect(await readFile(file)).toEqual(bytes);
});
it('retains real missing-file errors and rejects directories or oversized files before decoding', async () => {
  const { directory, file } = await fixture();
  await expect(createAttachmentThumbnail(path.join(directory, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(path.join(directory, 'folder')); await expect(createAttachmentThumbnail(path.join(directory, 'folder'))).rejects.toThrow('ATTACHMENT_NOT_FILE');
  await truncate(file, MAX_MESSAGE_ATTACHMENT_BYTES + 1); await expect(createAttachmentThumbnail(file)).rejects.toThrow('ATTACHMENT_TOO_LARGE');
  expect(native.decode).not.toHaveBeenCalled();
});
