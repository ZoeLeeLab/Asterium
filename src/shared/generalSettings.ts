import { z } from 'zod';

const notifications = z.object({ completed: z.boolean(), approval: z.boolean(), automationFailed: z.boolean() }).strict();
export const generalSettingsSchema = z.object({
  launchAtLogin: z.boolean(), closeAction: z.enum(['tray', 'quit']), sendShortcut: z.enum(['enter', 'ctrl_enter']),
  notifications, language: z.literal('zh-CN'),
  sandboxEnabled: z.boolean().default(false), sandboxAllowNetwork: z.boolean().default(false),
  checkUpdatesAtStartup: z.boolean().default(true), includePrereleaseUpdates: z.boolean().default(true),
  defaultProjectRoot: z.string().min(1).optional(),
}).strict();
export const generalSettingsUpdateSchema = generalSettingsSchema.omit({ notifications: true }).partial().extend({ notifications: notifications.partial().optional(), sandboxEnabled: z.boolean().optional(), sandboxAllowNetwork: z.boolean().optional(), defaultProjectRoot: z.string().min(1).nullable().optional() }).strict();
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type GeneralSettingsUpdate = z.infer<typeof generalSettingsUpdateSchema>;
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  launchAtLogin: false, closeAction: 'tray', sendShortcut: 'enter',
  notifications: { completed: true, approval: true, automationFailed: true }, language: 'zh-CN',
  sandboxEnabled: false, sandboxAllowNetwork: false,
  checkUpdatesAtStartup: true, includePrereleaseUpdates: true,
};
export interface GeneralSettingsSnapshot {
  revision: number;
  settings: GeneralSettings;
  startupSupported: boolean;
}
export interface AsteriumGeneralSettingsApi {
  get: () => Promise<GeneralSettingsSnapshot>;
  update: (patch: GeneralSettingsUpdate) => Promise<GeneralSettingsSnapshot>;
  onChanged: (listener: (snapshot: GeneralSettingsSnapshot) => void) => () => void;
}

export interface StorageLocations {
  userDataDirectory: string;
  defaultProjectRoot: string;
  customized: boolean;
}
export interface AsteriumStorageApi {
  get(): Promise<StorageLocations>;
  chooseProjectRoot(): Promise<StorageLocations | null>;
  resetProjectRoot(): Promise<StorageLocations>;
  openProjectRoot(): Promise<void>;
}
