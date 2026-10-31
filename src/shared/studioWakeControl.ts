import type { StudioWakeControlReply } from './studioWakeAdapter';

export interface StudioWakeBinding { partnerId: string; connectionBindingId: string; connectOnLaunch: boolean }
export interface StudioWakeEntry extends StudioWakeBinding {
  ready: boolean;
  state: 'waiting' | 'requesting' | 'unknown' | 'unavailable' | 'stopped' | 'connecting' | 'connected';
  remote?: StudioWakeControlReply;
  error?: string;
}
export interface StudioWakeStatus { entries: StudioWakeEntry[] }
export type StudioWakeAction = 'connect_once' | 'status' | 'retry' | 'ignore' | 'resume';
export interface AsteriumStudioWakeApi {
  status(): Promise<StudioWakeStatus>;
  configure(binding: StudioWakeBinding): Promise<StudioWakeStatus>;
  control(partnerId: string, action: StudioWakeAction, triggerId?: string): Promise<StudioWakeStatus>;
}
