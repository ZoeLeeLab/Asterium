import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import {
  MEMORY_STATUSES, MEMORY_TYPES,
  type MemoryArchiveCommentRequest, type MemoryArchiveCreateRequest, type MemoryArchiveMutationRequest, type MemoryArchiveQuery,
  type MemoryArchiveSourceReadRequest, type MemoryArchiveUpdateRequest,
} from '../../shared/memoryArchive';
import type { PartnerMemoryManagementService } from '../memory/PartnerMemoryManagementService';

export function registerMemoryArchiveIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  partnerMemoryManagement: Pick<PartnerMemoryManagementService,
    'query' | 'briefing' | 'create' | 'update' | 'comment' | 'softDelete' | 'restore' | 'readSource'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.memoryArchiveQuery, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.query(assertMemoryArchiveQuery(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveBriefing, async (event, partnerId: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.briefing(assertMemoryPartnerId(partnerId));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveCreate, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.create(assertMemoryArchiveCreate(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveUpdate, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.update(assertMemoryArchiveUpdate(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveComment, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.comment(assertMemoryArchiveComment(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveSoftDelete, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.softDelete(assertMemoryArchiveMutation(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveRestore, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.restore(assertMemoryArchiveMutation(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveReadSource, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.readSource(assertMemoryArchiveSourceRead(value));
  });
}

export function assertMemoryPartnerId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_MEMORY_PARTNER_ID');
  return value;
}

function assertMemoryArchiveQuery(value: unknown): MemoryArchiveQuery {
  if (!isRecord(value)) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  const partnerId = assertMemoryPartnerId(value.partnerId);
  if (value.includeDeleted !== undefined && typeof value.includeDeleted !== 'boolean') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.archivedOnly !== undefined && typeof value.archivedOnly !== 'boolean') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.text !== undefined && typeof value.text !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every((item) => typeof item === 'string'))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.types !== undefined && (!Array.isArray(value.types) || !value.types.every((item) => MEMORY_TYPES.includes(item as never)))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.statuses !== undefined && (!Array.isArray(value.statuses) || !value.statuses.every((item) => MEMORY_STATUSES.includes(item as never)))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.from !== undefined && typeof value.from !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.to !== undefined && typeof value.to !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.limit !== undefined && !Number.isSafeInteger(value.limit)) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  return { ...value, partnerId } as MemoryArchiveQuery;
}

function assertMemoryArchiveCreate(value: unknown): MemoryArchiveCreateRequest {
  if (!isRecord(value) || !MEMORY_TYPES.includes(value.type as never) || typeof value.body !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_CREATE');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveCreateRequest;
}

function assertMemoryArchiveUpdate(value: unknown): MemoryArchiveUpdateRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim() || typeof value.expectedUpdatedAt !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  if (value.type !== undefined && !MEMORY_TYPES.includes(value.type as never)) throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  if (value.status !== undefined && !MEMORY_STATUSES.includes(value.status as never)) throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveUpdateRequest;
}

function assertMemoryArchiveComment(value: unknown): MemoryArchiveCommentRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim()
    || typeof value.expectedUpdatedAt !== 'string' || typeof value.content !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_COMMENT');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveCommentRequest;
}

export function assertMemoryArchiveMutation(value: unknown): MemoryArchiveMutationRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim() || typeof value.expectedUpdatedAt !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_MUTATION');
  return { partnerId: assertMemoryPartnerId(value.partnerId), memoryId: value.memoryId, expectedUpdatedAt: value.expectedUpdatedAt };
}

function assertMemoryArchiveSourceRead(value: unknown): MemoryArchiveSourceReadRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim()
    || (value.sourceIndex !== undefined && (!Number.isSafeInteger(value.sourceIndex) || Number(value.sourceIndex) < 0))) throw new Error('INVALID_MEMORY_ARCHIVE_SOURCE_READ');
  return {
    partnerId: assertMemoryPartnerId(value.partnerId),
    memoryId: value.memoryId,
    ...(value.sourceIndex !== undefined ? { sourceIndex: Number(value.sourceIndex) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
