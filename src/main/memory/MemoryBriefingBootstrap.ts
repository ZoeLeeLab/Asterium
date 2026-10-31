import type { AsteriumRuntimeContextInput, MemoryManagementMode, SendMessageCommand } from '../../shared/agentProtocol';
import { formatAsteriumMemoryBriefing } from '../runtime/AsteriumRuntimeTools';

export function shouldBootstrapMemoryBriefing(command: SendMessageCommand, memoryMode?: MemoryManagementMode) {
  if (memoryMode !== 'asterium' || command.sessionId || !command.runtimeContext) return false;
  if (command.connectionSource !== 'api_partner' && command.connectionSource !== 'local_cli') return false;
  return !command.route || command.route.scope === 'single' || command.route.scope === 'group';
}

export function apiSessionBootstrapSystemPrompt(input: {
  partnerName: string;
  group: boolean;
  managedUserProfile: boolean;
  userProfileContext?: string;
  runtimeContext?: AsteriumRuntimeContextInput;
}) {
  return [
    input.group ? '' : `你在星丛中的名字：${input.partnerName}`,
    input.group ? '' : input.managedUserProfile && input.userProfileContext ? `关于当前用户：\n${input.userProfileContext}` : '',
    input.group ? '' : '星丛头像不会默认进入上下文；只有用户明确询问且当前模型支持图片输入时才可请求。',
    formatAsteriumMemoryBriefing(input.runtimeContext),
  ].filter(Boolean).join('\n\n');
}
