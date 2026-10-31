import { z } from 'zod';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { DEFAULT_GENERAL_SETTINGS, generalSettingsSchema, generalSettingsUpdateSchema, type GeneralSettings, type GeneralSettingsSnapshot } from '../../shared/generalSettings';

const schema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), settings: generalSettingsSchema }).strict();
export interface StartupRegistration { get: () => boolean; set: (enabled: boolean) => void; }
export class GeneralSettingsStore {
  private readonly storage;
  private cached = structuredClone(DEFAULT_GENERAL_SETTINGS);
  private cachedRevision = -1;
  private readonly listeners = new Set<(snapshot: GeneralSettingsSnapshot) => void>();
  private sandboxTransition?: (before: GeneralSettings, after: GeneralSettings) => Promise<() => void>;
  setSandboxTransition(transition: NonNullable<GeneralSettingsStore['sandboxTransition']>) { this.sandboxTransition = transition; }
  constructor(file: AtomicJsonStorePath, private readonly startup?: StartupRegistration) {
    this.storage = new AtomicJsonStore({ filePath: file, empty: () => ({ version: 1 as const, revision: 0, settings: structuredClone(DEFAULT_GENERAL_SETTINGS) }), decode: value => schema.parse(value) });
  }
  current() { return structuredClone(this.cached); }
  subscribe(listener: (snapshot: GeneralSettingsSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async get(): Promise<GeneralSettingsSnapshot> {
    const data = await this.storage.read();
    if (data.revision >= this.cachedRevision) { this.cached = data.settings; this.cachedRevision = data.revision; }
    this.cached = { ...this.cached, launchAtLogin: this.startup?.get() ?? false };
    return { revision: this.cachedRevision, settings: this.current(), startupSupported: Boolean(this.startup) };
  }
  async update(value: unknown) {
    const patch = generalSettingsUpdateSchema.parse(value);
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      const beforeStartup = this.startup?.get() ?? false;
      if (patch.launchAtLogin !== undefined && !this.startup) throw new Error('STARTUP_UNAVAILABLE');
      const settings = generalSettingsSchema.parse({ ...data.settings, ...patch, launchAtLogin: patch.launchAtLogin ?? beforeStartup, notifications: { ...data.settings.notifications, ...patch.notifications } });
      const sandboxChanged = settings.sandboxEnabled !== data.settings.sandboxEnabled || settings.sandboxAllowNetwork !== data.settings.sandboxAllowNetwork;
      const finishTransition = sandboxChanged ? await this.sandboxTransition?.(data.settings, settings) : undefined;
      try {
        if (patch.launchAtLogin !== undefined) {
          this.startup!.set(settings.launchAtLogin);
          if (this.startup!.get() !== settings.launchAtLogin) throw new Error('STARTUP_REGISTRATION_FAILED');
        }
        await this.storage.writeNow({ version: 1, revision: data.revision + 1, settings });
      } catch (error) {
        if (patch.launchAtLogin !== undefined) { try { this.startup!.set(beforeStartup); } catch { /* Preserve the failure; get() always reads the actual OS registration. */ } }
        finishTransition?.(); throw error;
      }
      this.cached = settings;
      this.cachedRevision = data.revision + 1;
      finishTransition?.();
      const snapshot = { revision: data.revision + 1, settings: this.current(), startupSupported: Boolean(this.startup) };
      for (const listener of this.listeners) { try { listener(snapshot); } catch { /* A view cannot roll back a committed setting. */ } }
      return snapshot;
    });
  }
}
