// App-window lifecycle channels are owned and disposed by StartupWindowService,
// independently of the agent IPC domain and its shutdown registry.
export const STARTUP_IPC = { control: 'asterium:startup:control', state: 'asterium:startup:state' } as const;

export interface StartupWindowSnapshot { phase: 'loading' | 'failed'; revision: number; }
export interface AsteriumMainStartupApi { report(state: 'painted' | 'failed'): Promise<void>; }
export interface AsteriumSplashApi {
  get(): Promise<StartupWindowSnapshot>;
  retry(): Promise<void>;
  quit(): Promise<void>;
  onState(listener: (state: StartupWindowSnapshot) => void): () => void;
}
