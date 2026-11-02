export type RuntimeProfile = 'daily' | 'dev' | 'acceptance' | 'autotest';

/** Read-only desktop information; never supplied by a partner or the renderer. */
export interface RuntimeEnvironment {
  profile: RuntimeProfile;
  label: string;
  userDataDirectory: string;
  projectsDirectory: string;
  temporaryDirectory: string;
  appUserModelId: string;
  allowStartup: boolean;
  allowUpdates: boolean;
  restoreBackgroundServices: boolean;
  mcpPort: number;
}

export interface AsteriumEnvironmentApi {
  get(): Promise<RuntimeEnvironment>;
}
