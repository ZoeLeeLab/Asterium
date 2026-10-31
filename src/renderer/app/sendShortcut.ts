import type { GeneralSettings } from '../../shared/generalSettings';

export function isMessageSendKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean; keyCode?: number }, shortcut: GeneralSettings['sendShortcut']) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229
    && (shortcut === 'ctrl_enter' ? event.ctrlKey : !event.ctrlKey);
}
