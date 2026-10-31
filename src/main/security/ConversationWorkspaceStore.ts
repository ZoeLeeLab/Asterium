/**
 * Compatibility entrypoint for callers that still use the pre-partner naming.
 * The persisted filename and JSON schema intentionally remain unchanged.
 */
export {
  PartnerWorkspaceStore,
  PartnerWorkspaceStore as ConversationWorkspaceStore,
} from './PartnerWorkspaceStore';
export type {
  ProjectWorkspaceAssignment,
  WorkspaceSnapshot,
} from './PartnerWorkspaceStore';
