import { z } from 'zod';

const notifications = z.object({ completed: z.boolean(), approval: z.boolean(), automationFailed: z.boolean() }).strict();
export const generalSettingsSchema = z.object({
  launchAtLogin: z.boolean(), closeAction: z.enum(['tray', 'quit']), sendShortcut: z.enum(['enter', 'ctrl_enter']),
  notifications, language: z.literal('zh-CN'),
  sandboxEnabled: z.boolean().default(false), sandboxAllowNetwork: z.boolean().default(false),
  checkUpdatesAtStartup: z.boolean().default(true), includePrereleaseUpdates: z.boolean().default(true),
}).strict();
export const generalSettingsUpdateSchema = generalSettingsSchema.omit({ notifications: true }).partial().extend({ notifications: notifications.partial().optional(), sandboxEnabled: z.boolean().optional(), sandboxAllowNetwork: z.boolean().optional() }).strict();
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
