import type { ResolveUserInputCommand, SendMessageCommand, UserInputQuestion } from '../../shared/agentProtocol';

export type UserInputOwner = Pick<ResolveUserInputCommand, 'partnerId' | 'conversationId' | 'connectionSource' | 'clientMessageId' | 'runId' | 'sessionId' | 'route'>;

export function userInputOwner(command: SendMessageCommand, runId: string, sessionId: string): UserInputOwner {
  return { partnerId: command.partnerId, conversationId: command.conversationId, connectionSource: command.connectionSource, clientMessageId: command.clientMessageId, runId, sessionId, route: command.route };
}

function routeKey(route: UserInputOwner['route']) {
  if (!route || route.scope === 'single') return ['single'];
  if (route.scope === 'workspace') return [route.scope, route.projectId];
  if (route.scope === 'group') return [route.scope, route.roomId, route.roundId, route.bindingGeneration, route.inputThroughSeq];
  return [route.scope, route.projectId, route.roomId, route.generationId, route.bindingGeneration];
}

/** Validate before consuming a pending request, so invalid replies cannot lose the card. */
export function assertUserInputResolution(command: ResolveUserInputCommand, owner: UserInputOwner, questions: UserInputQuestion[]) {
  for (const key of ['partnerId', 'conversationId', 'connectionSource', 'clientMessageId', 'runId', 'sessionId'] as const) {
    if (command[key] !== owner[key]) throw new Error('USER_INPUT_ROUTE_MISMATCH');
  }
  if (JSON.stringify(routeKey(command.route)) !== JSON.stringify(routeKey(owner.route))) throw new Error('USER_INPUT_ROUTE_MISMATCH');
  const ids = new Set(questions.map((question) => question.id));
  if (Object.keys(command.answers).some((id) => !ids.has(id))) throw new Error('INVALID_USER_INPUT_ANSWERS');
  for (const question of questions) {
    const values = command.answers[question.id];
    if (!Object.hasOwn(command.answers, question.id) || !Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value.trim()) || (!question.multiple && values.length !== 1)) throw new Error('INVALID_USER_INPUT_ANSWERS');
  }
  for (const [id, text] of Object.entries(command.customAnswers ?? {})) {
    if (!ids.has(id) || !text.trim() || !command.answers[id]?.includes(text)) throw new Error('INVALID_USER_INPUT_ANSWERS');
  }
}
