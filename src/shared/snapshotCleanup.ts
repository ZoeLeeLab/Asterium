export interface SnapshotCleanupPreview {
  planId: string;
  count: number;
  bytes: number;
  skippedCount: number;
}

export interface SnapshotCleanupResult {
  clearedCount: number;
  freedBytes: number;
  skippedCount: number;
}

export interface SnapshotCleanupApi {
  previewSnapshotCleanup(): Promise<SnapshotCleanupPreview>;
  clearSnapshots(planId: string): Promise<SnapshotCleanupResult>;
}
