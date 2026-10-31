export type DesktopNavigationTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'group'; roomId: string }
  | { kind: 'project'; projectId: string; taskId?: string }
  | { kind: 'automations'; automationId?: string };
export interface AsteriumDesktopNavigationApi {
  take: () => Promise<DesktopNavigationTarget | undefined>;
  onReady: (listener: () => void) => () => void;
}
