export const STUDIO_WAKE_LIMITS = {
  debounceMs: 2_000,
  startsPerMinute: 6,
  connectTimeoutMs: 8_000,
  deliveryReceiptMs: 8_000,
  heartbeatMs: 15_000,
  replayEvents: 1_000,
  pageEvents: 128,
  maximumPendingRooms: 64,
  maximumFrameCharacters: 64 * 1024,
} as const;

export interface StudioWakeHint {
  latestEventId: number;
  roomId: string;
  membershipGeneration: number;
  cursor: number;
  wakeReason: 'user_message' | 'mention' | 'room_changed' | 'processed';
  wakeEligible: boolean;
}

export interface StudioWakeTrigger {
  type: 'asterium.group_wake';
  source: 'asterium';
  adapterId: string;
  triggerId: string;
  roomId: string;
  cursor: number;
  membershipGeneration: number;
  latestEventId: number;
  wakeReason: 'user_message' | 'mention';
}

export interface StudioWakeExecution {
  triggerId: string;
  outcome: 'completed' | 'passed' | 'failed';
}
