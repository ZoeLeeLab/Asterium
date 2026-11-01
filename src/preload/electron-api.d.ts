import type { DesktopBridge } from '../shared/desktopBridge';

declare global {
  interface Window {
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
    asteriumMemory?: DesktopBridge['asteriumMemory'];
    asteriumNativeBindings?: DesktopBridge['asteriumNativeBindings'];
    asteriumConversations?: DesktopBridge['asteriumConversations'];
  }
}

export * from '../shared/desktopBridge';
