import { ASTERIUM_USER_ID } from '../../shared/identity';
import type { PrototypeState } from '../types/domain';

export function createInitialState(): PrototypeState {
  return {
    version: 7,
    userProfile: { id: ASTERIUM_USER_ID, displayName: '用户', introduction: '', audience: 'all', updatedAt: new Date().toISOString() },
    partners: [], conversations: [], projects: [], groupChats: [],
    activePartnerId: '', activeConversationId: '', activeProjectId: '', activeGroupChatId: '',
  };
}
