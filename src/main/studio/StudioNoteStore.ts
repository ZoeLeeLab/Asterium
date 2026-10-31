import { randomUUID } from 'node:crypto';
import type { SaveStudioNoteRequest, StudioNote } from '../../shared/studioNotes';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

interface StudioNoteFile {
  version: 1;
  notes: StudioNote[];
}

const EMPTY_FILE: StudioNoteFile = { version: 1, notes: [] };

export class StudioNoteStore {
  private readonly storage: AtomicJsonStore<StudioNoteFile>;

  constructor(filePath: string | (() => string)) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => structuredClone(EMPTY_FILE),
      decode: decodeStudioNoteFile,
      encode: (data) => `${JSON.stringify(data, null, 2)}\n`,
    });
  }

  async list(projectId?: string) {
    const notes = (await this.storage.read()).notes;
    return structuredClone(projectId ? notes.filter((note) => note.projectId === projectId) : notes);
  }

  async save(request: SaveStudioNoteRequest) {
    const projectId = clean(request.projectId, 128, 'STUDIO_NOTE_PROJECT_REQUIRED');
    const content = clean(request.content, 4_000, 'STUDIO_NOTE_CONTENT_REQUIRED');
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const now = new Date().toISOString();
      const existing = request.id ? data.notes.find((note) => note.id === request.id) : undefined;
      const note: StudioNote = existing
        ? { ...existing, projectId, content, updatedAt: now }
        : { id: randomUUID(), projectId, content, status: 'open', createdAt: now, updatedAt: now };
      if (existing) data.notes = data.notes.map((item) => item.id === note.id ? note : item);
      else data.notes.unshift(note);
      await this.writeUnlocked(data);
      return structuredClone(note);
    });
  }

  async setStatus(id: string, status: StudioNote['status']) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const note = data.notes.find((item) => item.id === id);
      if (!note) throw new Error('STUDIO_NOTE_NOT_FOUND');
      const now = new Date().toISOString();
      note.status = status;
      note.updatedAt = now;
      if (status === 'completed') note.completedAt = now;
      else delete note.completedAt;
      if (status === 'archived') note.archivedAt = now;
      else delete note.archivedAt;
      await this.writeUnlocked(data);
      return structuredClone(note);
    });
  }

  async remove(id: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const next = data.notes.filter((note) => note.id !== id);
      if (next.length === data.notes.length) return;
      data.notes = next;
      await this.writeUnlocked(data);
    });
  }

  async removeProject(projectId: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const next = data.notes.filter((note) => note.projectId !== projectId);
      if (next.length === data.notes.length) return;
      data.notes = next;
      await this.writeUnlocked(data);
    });
  }

  async restoreProject(projectId: string, notes: StudioNote[]) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      data.notes = [...data.notes.filter((note) => note.projectId !== projectId), ...structuredClone(notes)];
      await this.writeUnlocked(data);
    });
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: StudioNoteFile) { return this.storage.writeNow(data); }

  private mutate<T>(operation: () => Promise<T>) {
    return this.storage.runExclusive(operation);
  }
}

function decodeStudioNoteFile(value: unknown): StudioNoteFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.notes)) throw new Error('STUDIO_NOTE_STORE_INVALID');
  return { version: 1, notes: value.notes.filter(isStudioNote) };
}

function clean(value: string, limit: number, error: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) throw new Error(error);
  return normalized;
}

function isStudioNote(value: unknown): value is StudioNote {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.projectId === 'string'
    && typeof value.content === 'string'
    && ['open', 'completed', 'archived'].includes(String(value.status))
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
