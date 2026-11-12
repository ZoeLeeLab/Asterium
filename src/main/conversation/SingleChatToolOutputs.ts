import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../../renderer/types/domain';
import type { SingleChatToolOutputRequest } from '../../shared/singleChatHistory';
import { INLINE_TOOL_OUTPUT_BYTES, type ToolOutputReference } from '../../shared/toolOutput';

export const TOOL_OUTPUT_ID = /^[a-f0-9]{64}$/;
const PAGE_BYTES = 64 * 1024;

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function ordinaryDirectory(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_DIRECTORY');
}

export async function storeToolOutput(chatDirectory: string, detail: string) {
  const bytes = Buffer.from(detail);
  if (bytes.length <= INLINE_TOOL_OUTPUT_BYTES) return undefined;
  await ordinaryDirectory(chatDirectory);
  const directory = path.join(chatDirectory, 'outputs');
  await mkdir(directory, { recursive: true });
  await ordinaryDirectory(directory);
  const id = createHash('sha256').update(bytes).digest('hex');
  const target = path.join(directory, id + '.txt');
  const exists = await lstat(target).catch(error => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
  if (exists && (!exists.isFile() || exists.size !== bytes.length)) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_FILE');
  if (!exists) {
    const staged = path.join(directory, id + '.stage-' + randomUUID());
    try {
      await writeFile(staged, bytes, { flag: 'wx', flush: true, mode: 0o600 });
      await rename(staged, target);
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }
  const reference: ToolOutputReference = { id, sizeBytes: bytes.length };
  return { detail: presentationDetail(detail, bytes), detailRef: reference };
}

// Preserve the structured fields that the timeline uses for labels without embedding tool results.
function presentationDetail(detail: string, bytes: Buffer) {
  try {
    const root: unknown = JSON.parse(detail);
    const summary: Record<string, unknown> = {};
    const pending: unknown[] = [root];
    const paths: Array<{ path: string }> = [];
    while (pending.length && paths.length < 4) {
      const item = pending.pop();
      if (typeof item !== 'object' || item === null) continue;
      for (const [key, value] of Object.entries(item)) {
        if (key === 'action' && typeof value === 'string' && value.length <= 128) summary.action ??= value;
        if (/^(?:file_?path|path|notebook_?path)$/i.test(key) && typeof value === 'string' && value.length <= 1024 && paths.length < 4) paths.push({ path: value });
        if (value && typeof value === 'object') pending.push(value);
        if ((key === 'arguments' || key === 'input') && typeof value === 'string') {
          try { pending.push(JSON.parse(value)); } catch { /* Plain text input has no structured fields. */ }
        }
      }
    }
    if (paths.length) summary.files = paths;
    return JSON.stringify(summary);
  } catch {
    return bytes.subarray(0, utf8PageEnd(bytes, 2048)).toString('utf8');
  }
}

export async function separateToolOutputs(chatDirectory: string, messages: Message[]) {
  const result: Message[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.timeline) || !message.timeline.some(item => item && (item.kind === 'tool' || item.kind === 'computer')
      && typeof item.detail === 'string' && item.detail.length > INLINE_TOOL_OUTPUT_BYTES / 4)) {
      result.push(message);
      continue;
    }
    const timeline = [];
    for (const item of message.timeline) {
      const stored = item && (item.kind === 'tool' || item.kind === 'computer') && typeof item.detail === 'string'
        ? await storeToolOutput(chatDirectory, item.detail) : undefined;
      timeline.push(stored ? { ...item, ...stored } : item);
    }
    result.push({ ...message, timeline });
  }
  return result;
}

export async function readToolOutput(chatDirectory: string, { outputId, offset = 0 }: SingleChatToolOutputRequest) {
  const directory = path.join(chatDirectory, 'outputs');
  if (!TOOL_OUTPUT_ID.test(outputId)) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_ID');
  await ordinaryDirectory(chatDirectory);
  await ordinaryDirectory(directory);
  const target = path.join(directory, outputId + '.txt');
  if (!(await lstat(target)).isFile()) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_FILE');
  const file = await open(target, 'r');
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_OFFSET');
    const buffer = Buffer.alloc(Math.min(PAGE_BYTES + 1, size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length || (buffer[0] & 0xc0) === 0x80) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_PAGE');
    const end = utf8PageEnd(buffer, Math.min(PAGE_BYTES, bytesRead));
    const next = offset + end;
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, end)), nextOffset: next < size ? next : undefined };
  } finally {
    await file.close();
  }
}

function utf8PageEnd(bytes: Buffer, end: number) {
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

export async function removeToolOutputs(chatDirectory: string) {
  const directory = path.join(chatDirectory, 'outputs');
  const exists = await lstat(directory).catch(error => {
    if (!isMissing(error)) throw error;
    return undefined;
  });
  if (!exists) return;
  await ordinaryDirectory(chatDirectory);
  if (!exists.isDirectory()) throw new Error('SINGLE_CHAT_TOOL_OUTPUT_INVALID_DIRECTORY');
  for (const name of await readdir(directory)) {
    if (/^[a-f0-9]{64}(?:\.txt|\.stage-[a-f0-9-]{36})$/.test(name)) await rm(path.join(directory, name), { force: true });
  }
}
