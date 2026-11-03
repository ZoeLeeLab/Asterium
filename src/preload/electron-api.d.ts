import type { DesktopBridge } from '../shared/desktopBridge';

declare global {
  interface Window {
    asteriumDelegation?: {
      list(conversationId: string): Promise<import('../main/runtime/PartnerDelegation').DelegationBatch[]>;
      interruptWait(conversationId: string): Promise<boolean>;
      control(conversationId: string, taskId: string, action: 'cancel' | 'retry'): Promise<void>;
    };
    asteriumStorage?: DesktopBridge['asteriumStorage'];
    asteriumEnvironment?: DesktopBridge['asteriumEnvironment'];
    asteriumUpdates?: DesktopBridge['asteriumUpdates'];
    asteriumDesktopNavigation?: DesktopBridge['asteriumDesktopNavigation'];
    asteriumGeneralSettings?: DesktopBridge['asteriumGeneralSettings'];
    asteriumAutomations?: DesktopBridge['asteriumAutomations'];
    asteriumStudioMcp?: DesktopBridge['asteriumStudioMcp'];
    asteriumStudioWake?: DesktopBridge['asteriumStudioWake'];
    asteriumExtensions?: DesktopBridge['asteriumExtensions'];
    asteriumPartnerDiary?: DesktopBridge['asteriumPartnerDiary'];
    asteriumMemoryFallback?: DesktopBridge['asteriumMemoryFallback'];
    asteriumAppearance?: DesktopBridge['asteriumAppearance'];
    asteriumAgents?: DesktopBridge['asteriumAgents'];
    asteriumArtifacts?: DesktopBridge['asteriumArtifacts'];
    asteriumAttachments?: DesktopBridge['asteriumAttachments'];
    asteriumProjects?: DesktopBridge['asteriumProjects'];
    asteriumStudio?: DesktopBridge['asteriumStudio'];
    asteriumStudioNotes?: DesktopBridge['asteriumStudioNotes'];
    asteriumProjectNotebooks?: DesktopBridge['asteriumProjectNotebooks'];
    asteriumContextHandoff?: import('../shared/contextHandoff').ContextHandoffApi;
    asteriumMemory?: DesktopBridge['asteriumMemory'];
    asteriumNativeBindings?: DesktopBridge['asteriumNativeBindings'];
    asteriumConversations?: DesktopBridge['asteriumConversations'];
  }
}

export * from '../shared/desktopBridge';
