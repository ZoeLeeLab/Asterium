import type { MemoryRecord } from './memoryArchive';

export const MEMORY_BACKUP_EXTENSION = 'asterium-memory.gz';

export interface MemoryBackupData {
  format: 'asterium.partner-memory';
  version: 1;
  partnerId: string;
  records: MemoryRecord[];
  fallbackMemoryIds: string[];
}

export interface MemoryBackupPreview {
  id: string;
  fileName: string;
  total: number;
  archived: number;
}

export interface MemoryBackupReceipt {
  added: number;
  skipped: number;
}

export interface MemoryBackupApi {
  export: (partnerId: string) => Promise<number | null>;
  choose: (partnerId: string) => Promise<MemoryBackupPreview | null>;
  import: (partnerId: string, id: string) => Promise<MemoryBackupReceipt>;
  cancel: (partnerId: string, id: string) => Promise<void>;
}
