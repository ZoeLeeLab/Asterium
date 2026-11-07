import type { ContextHandoff } from '../../shared/contextHandoff';
import { useAppearance } from './useAppearance';
import type { AppearanceSettings, AppearanceUpdate } from './appearance';
/* eslint-disable react-refresh/only-export-components -- reducer and hook are intentionally colocated with this small prototype provider. */
import type { SessionCommandName, SessionStatus } from '../../shared/sessionCommands';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../components/ui/Modal';
import { useLocation } from 'react-router-dom';

import type { ApiPartner, Conversation, ConversationArtifact, ExistingThreadPartner, GroupChat, LocalCliPartner, Message, MessageQuote, Partner, Project, ProjectFile, PrototypeAction, PrototypeState, TaskItem, ThemeMode, TurnOperationCategory, TurnTimelineItem, UserProfile } from '../types/domain';
import { formatMessageWithQuote } from './messageQuote';
import { friendlyRuntimeErrorMessage } from './runtimeErrorPresentation';
import { loadPrototypeState, savePrototypeState } from './persistence';
import { AGENT_PROTOCOL_VERSION, type JsonValue, type LocalThreadLifecycleRequest, type MessageAttachment, type MessageDeliveryEvent, type PartnerEvent, type PartnerProfileSeed, type PartnerWorkspaceState, type PermissionMode, type PlanMode, type RunId, type RuntimeModelObservation, type WorkspaceGrant } from '../../shared/agentProtocol';
import { toolPresentation } from '../components/chat/toolPresentation';
import { type StudioMention, type StudioRoomSettings, type StudioRoomSnapshot } from '../../shared/studioRuntime';
import { ASTERIUM_USER_ID, isAsteriumUser } from '../../shared/identity';
import type { ProjectTaskCreateRequest, ProjectTaskUpdateRequest } from '../../shared/projectDomain';
import {
  conversationForCurrentWorkspace,
  conversationWorkspaceMismatch,
  createSingleChatMessage,
  nativeLifecycleRequest,
  regenerateSingleChatTurn,
  sendSingleChatMessage,
  type WorkspaceSwitchDecision,
} from './singleChatRuntime';

export { conversationWorkspaceMismatch } from './singleChatRuntime';
export type { WorkspaceSwitchDecision } from './singleChatRuntime';

interface NativeLifecycleSyncGroup {
  request: LocalThreadLifecycleRequest;
  conversations: Array<{ conversationId: string; threadId: string; nativeThreadState?: Conversation['nativeThreadState'] }>;
}

export function buildNativeLifecycleSyncGroups(partners: Partner[], conversations: Conversation[]): NativeLifecycleSyncGroup[] {
  return partners.flatMap((partner) => {
    if (partner.sourceMode !== 'local_cli' || partner.adapterType !== 'codex_cli' || partner.connectionKind !== 'local_codex' || partner.isRemoved) return [];
    const byGrant = new Map<string, NativeLifecycleSyncGroup['conversations']>();
    for (const conversation of conversations) {
      if (conversation.partnerId !== partner.id || !conversation.sessionId) continue;
      const grantId = conversation.partnerRootGrantId ?? partner.partnerRootGrantId ?? '';
      const group = byGrant.get(grantId) ?? [];
      group.push({ conversationId: conversation.id, threadId: conversation.sessionId, nativeThreadState: conversation.nativeThreadState });
      byGrant.set(grantId, group);
    }
    return [...byGrant.entries()].map(([grantId, items]) => ({
      request: nativeLifecycleRequest(partner, [...new Set(items.map((item) => item.threadId))], grantId || undefined),
      conversations: items,
    }));
  });
}

function applyPartnerWorkspace(partner: Partner, workspace: PartnerWorkspaceState): Partner {
  if (partner.sourceMode === 'local_cli') {
    const activeWorkspaceGrantId = partner.activeWorkspaceGrantId && workspace.workspaces.some((grant) => grant.grantId === partner.activeWorkspaceGrantId)
      ? partner.activeWorkspaceGrantId : workspace.workspaces[0]?.grantId;
    return {
      ...partner,
      workspaceVersion: workspace.version,
      partnerRoot: workspace.cwd?.displayPath,
      partnerRootGrantId: workspace.cwd?.grantId,
      workingDirectories: workspace.workspaces.map((grant) => grant.displayPath),
      workspaceGrantIds: workspace.workspaces.map((grant) => grant.grantId),
      activeWorkspaceGrantId,
      workingDirectory: workspace.workspaces[0]?.displayPath,
      workspaceGrantId: workspace.workspaces[0]?.grantId,
      primaryWorkspaceGrantId: undefined,
    };
  }
  if (partner.sourceMode === 'api_partner') {
    const grants = [...(workspace.cwd ? [workspace.cwd] : []), ...workspace.workspaces];
    return {
      ...partner,
      workspaceVersion: workspace.version,
      primaryWorkspaceGrantId: workspace.cwd?.grantId,
      workingDirectories: grants.map((grant) => grant.displayPath),
      workspaceGrantIds: grants.map((grant) => grant.grantId),
    };
  }
  return partner;
}

export function partnerProfileSeed(partner: Partner): PartnerProfileSeed {
  const management = partner.profileManagement ?? {
    userProfile: partner.sourceMode === 'api_partner',
    personality: partner.sourceMode === 'api_partner',
    memoryMode: partner.sourceMode === 'api_partner' ? 'asterium' as const
      : partner.sourceMode === 'local_cli' ? 'self_managed' as const : 'none' as const,
  };
  const connectionSettings: Record<string, JsonValue> = partner.sourceMode === 'api_partner' ? {
    provider: partner.provider,
    ...(partner.modelId ? { modelId: partner.modelId } : {}),
    endpoint: partner.endpoint ?? '',
    configuredModel: partner.model,
    apiSessionHistoryEnabled: partner.apiSessionHistoryEnabled,
    thinkingMode: partner.thinkingMode,
    reasoningEffort: partner.reasoningEffort,
  } : partner.sourceMode === 'local_cli' ? {
    adapterType: partner.adapterType,
    location: partner.location,
    sessionMode: partner.sessionMode,
    runtimeId: partner.codexRuntimeId ?? '',
    runtimeEnvironment: partner.codexRuntime?.environment ?? '',
    runtimeLabel: partner.codexRuntime?.environmentLabel ?? partner.connectionLabel,
    partnerRoot: partner.partnerRoot ?? '',
  } : {
    serviceType: partner.serviceType,
    serviceUrl: partner.serviceUrl,
    threadId: partner.threadId,
    workspaceRoot: partner.workspaceRoot ?? '',
  };
  const recentModel = partner.recentModel ? {
    model: partner.recentModel.model,
    status: partner.recentModel.status,
    observedAt: partner.recentModel.observedAt,
    source: partner.recentModel.source,
    ...(partner.recentModel.conversationId ? { conversationId: partner.recentModel.conversationId } : {}),
    ...(partner.recentModel.threadId ? { threadId: partner.recentModel.threadId } : {}),
  } : undefined;
  if (partner.sourceMode === 'existing_thread') connectionSettings.__diaryRuntime = {
    available: !partner.isRemoved && !partner.isPrototype && partner.configured,
    credentialRef: partner.credentialRef ?? '',
  };
  if (partner.sourceMode === 'api_partner') connectionSettings.__studioRuntime = {
    persist: !partner.isPrototype,
    available: !partner.isRemoved && !partner.isPrototype && partner.configured,
    ...(recentModel ? { recentModel } : {}),
    runtime: {
      kind: 'api',
      connection: {
        provider: partner.provider,
        ...(partner.modelId ? { modelId: partner.modelId } : {}),
        endpoint: partner.endpoint ?? '',
        model: partner.model,
        credentialRef: partner.credentialRef ?? '',
        thinkingMode: partner.thinkingMode,
        reasoningEffort: partner.reasoningEffort,
        ...(partner.primaryWorkspaceGrantId ? { primaryWorkspaceGrantId: partner.primaryWorkspaceGrantId } : {}),
        workspaceGrantIds: partner.workspaceGrantIds ?? [],
        ...(partner.attachmentCapabilities ? { attachmentCapabilities: partner.attachmentCapabilities } : {}),
      },
    },
  } as unknown as JsonValue;
  if (partner.sourceMode === 'local_cli') connectionSettings.__studioRuntime = {
    persist: !partner.isPrototype,
    available: !partner.isRemoved && !partner.isPrototype && (partner.connectionKind === 'local_claude' || partner.connectionKind === 'local_codex'),
    ...(recentModel ? { recentModel } : {}),
    runtime: {
      kind: 'local',
      adapterType: partner.adapterType,
      ...(partner.partnerRootGrantId ? { partnerRootGrantId: partner.partnerRootGrantId } : {}),
      workspaceGrantIds: partner.workspaceGrantIds ?? [],
      ...(partner.codexRuntimeId ? { codexRuntimeId: partner.codexRuntimeId } : {}),
      ...(partner.codexRuntime?.environment ? { codexRuntimeEnvironment: partner.codexRuntime.environment } : {}),
    },
  } as unknown as JsonValue;
  return {
    partnerId: partner.id,
    expectedRevision: partner.profileRevision,
    sourceMode: partner.sourceMode,
    publicIdentity: { ...partner.publicIdentity },
    management,
    ...(partner.sourceMode === 'api_partner'
      ? { personality: partner.personality, systemPrompt: partner.systemPrompt }
      : { personality: partner.managedPersonality, systemPrompt: partner.managedSystemPrompt }),
    connectionSettings,
  };
}

function observedModel(event: Extract<PartnerEvent, { type: 'extension.event' }>): RuntimeModelObservation | undefined {
  if (event.namespace !== 'asterium.runtime' || event.name !== 'model_observed' || typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return undefined;
  const model = typeof event.payload.model === 'string' ? event.payload.model.trim() : '';
  if (!model) return undefined;
  return {
    model,
    status: 'current',
    observedAt: event.occurredAt,
    source: event.payload.source === 'native_thread' ? 'native_thread' : 'runtime',
    conversationId: event.conversationId,
    threadId: event.sessionId,
  };
}

function boundModel(event: Extract<PartnerEvent, { type: 'session.bound' }>): RuntimeModelObservation | undefined {
  if (!event.model?.trim()) return undefined;
  return { model: event.model.trim(), status: 'current', observedAt: event.occurredAt, source: event.modelSource ?? 'runtime', conversationId: event.conversationId, threadId: event.sessionId };
}

function samePartnerWorkspace(left: Partner, right: Partner) {
  if (left.sourceMode !== right.sourceMode || left.workspaceVersion !== right.workspaceVersion) return false;
  if (left.sourceMode === 'existing_thread' || right.sourceMode === 'existing_thread') return true;
  return JSON.stringify({
    cwd: left.sourceMode === 'local_cli' ? [left.partnerRootGrantId, left.partnerRoot] : left.primaryWorkspaceGrantId,
    ids: left.workspaceGrantIds ?? [],
    paths: left.workingDirectories ?? [],
  }) === JSON.stringify({
    cwd: right.sourceMode === 'local_cli' ? [right.partnerRootGrantId, right.partnerRoot] : right.primaryWorkspaceGrantId,
    ids: right.workspaceGrantIds ?? [],
    paths: right.workingDirectories ?? [],
  });
}

function updateConversation(state: PrototypeState, conversationId: string, update: (conversation: Conversation) => Conversation): PrototypeState {
  return {
    ...state,
    conversations: state.conversations.map((conversation) => conversation.id === conversationId ? update(conversation) : conversation),
  };
}

function assistantMessage(conversation: Conversation, event: PartnerEvent): Message {
  return {
    id: `assistant-${event.runId}`,
    authorId: event.partnerId,
    content: '',
    createdAt: new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    occurredAt: event.occurredAt,
    runId: event.runId,
    runState: 'running',
    isStreaming: true,
    startedAt: event.occurredAt,
    toolEvents: [],
    timeline: [],
  };
}

function appendTimeline(message: Message, item: TurnTimelineItem) {
  const timeline = (message.timeline ?? []).map((previous) => {
    if (!('state' in previous) || previous.state !== 'running') return previous;
    if (previous.kind === 'tool' && item.kind === 'tool' && previous.toolCallId === item.toolCallId) {
      return { ...previous, state: item.state === 'failure' ? 'failure' as const : 'success' as const };
    }
    if ((previous.kind === 'reasoning' || previous.kind === 'status') && item.kind !== 'authorization') {
      return { ...previous, state: 'success' as const };
    }
    if (previous.kind === 'authorization' && item.kind === 'authorization' && previous.authorizationId === item.authorizationId) {
      return { ...previous, state: item.state };
    }
    return previous;
  });
  if (item.kind === 'authorization') {
    const authorizationIndex = timeline.findIndex((previous) => previous.kind === 'authorization' && previous.authorizationId === item.authorizationId);
    if (authorizationIndex >= 0) {
      const previous = timeline[authorizationIndex];
      if (previous.kind === 'authorization') timeline[authorizationIndex] = {
        ...previous,
        state: item.state,
        toolCallId: item.toolCallId ?? previous.toolCallId,
        action: item.action ?? previous.action,
        risk: item.risk ?? previous.risk,
        decision: item.decision ?? previous.decision,
        detail: item.detail ?? previous.detail,
        purpose: item.purpose ?? previous.purpose,
      };
      return timeline;
    }
  }
  if (item.kind === 'user_input') {
    const requestIndex = timeline.findIndex((previous) => previous.kind === 'user_input' && previous.requestId === item.requestId);
    if (requestIndex >= 0) {
      const previous = timeline[requestIndex];
      if (previous.kind === 'user_input') timeline[requestIndex] = {
        ...previous,
        state: item.state,
        questions: item.questions.length > 0 ? item.questions : previous.questions,
        answers: item.answers ?? previous.answers,
        customAnswers: item.customAnswers ?? previous.customAnswers,
      };
      return timeline;
    }
  }
  if (item.kind === 'plan') {
    const planIndex = timeline.findIndex((previous) => previous.kind === 'plan');
    if (planIndex >= 0) {
      timeline[planIndex] = item;
      return timeline;
    }
  }
  const previous = timeline.at(-1);
  if (item.kind === 'text' && previous?.kind === 'text') timeline[timeline.length - 1] = { ...previous, text: previous.text + item.text };
  else timeline.push(item);
  return timeline;
}

function finalizeTimeline(message: Message, state: 'success' | 'failure') {
  return (message.timeline ?? []).map((item) => 'state' in item && item.state === 'running' ? { ...item, state } : item);
}

function eventDetail(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.slice(0, 32_768) : undefined;
}

function operationCategory(toolName?: string): TurnOperationCategory {
  return toolPresentation(toolName).category;
}

function planStatusLabel(status: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed') {
  return ({ planning: '正在盘算怎么做', waiting_user: '计划等待你的回答', ready: '计划写好了', executing: '照着计划开工了', completed: '计划收工了' } as const)[status];
}

function applyAgentEventToConversation(conversation: Conversation, event: PartnerEvent): Conversation {
  if (event.type === 'run.failed' && conversation.failedRegenerationClientMessageId === event.clientMessageId) {
    return { ...conversation, failedRegenerationClientMessageId: undefined };
  }
  const previousSequence = conversation.eventSequences?.[event.runId]
    ?? (conversation.lastRunId === event.runId ? conversation.lastSequence : undefined)
    ?? 0;
  if (event.sequence <= previousSequence) return conversation;
  const eventSequences = { ...(conversation.eventSequences ?? {}), [event.runId]: event.sequence };
  const runIds = Object.keys(eventSequences);
  for (const staleRunId of runIds.slice(0, Math.max(0, runIds.length - 32))) delete eventSequences[staleRunId];
  let next: Conversation = { ...conversation, eventSequences, lastRunId: event.runId, lastSequence: event.sequence, updatedAt: event.occurredAt };
  if (event.type === 'session.bound') return { ...next, sessionId: event.sessionId, runtimeModel: boundModel(event) ?? next.runtimeModel, nativeThreadState: 'active', nativeThreadStateCheckedAt: event.occurredAt, nativeThreadNotice: undefined, ...(event.toolProtocolVersion ? { nativeToolProtocolVersion: event.toolProtocolVersion } : {}), activeRun: { runId: event.runId, clientMessageId: event.clientMessageId }, runNotice: undefined };
  if (event.type === 'message.accepted') return { ...next, activeRun: { runId: event.runId, clientMessageId: event.clientMessageId } };
  if (event.type === 'guidance.applied') {
    const guidance = next.messages.find((message) => message.clientMessageId === event.guidanceClientMessageId && message.isGuidance);
    if (!guidance || guidance.guidanceState === 'applied') return next;
    const messages = next.messages.map((message) => {
      if (message.id === guidance.id) return { ...message, status: 'delivered' as const, guidanceState: 'applied' as const };
      if (message.runId !== event.runId || isAsteriumUser(message.authorId)) return message;
      return { ...message, id: `${message.id}:before-guidance:${guidance.id}`, runId: `${event.runId}:before-guidance:${guidance.id}`, runState: 'completed' as const, isStreaming: false, completedAt: event.occurredAt, timeline: finalizeTimeline(message, 'success') };
    });
    return { ...next, messages, awaitingFirstResponse: { clientMessageId: guidance.clientMessageId!, startedAt: event.occurredAt }, workStatus: undefined };
  }
  if (event.type === 'work.status') next = { ...next, workStatus: event.state === 'idle' ? undefined : event.summary };
  if (event.type === 'authorization.requested') next = { ...next, pendingAuthorization: { authorizationId: event.authorizationId, toolCallId: event.toolCallId, action: event.action, risk: event.risk, summary: event.summary, targets: event.targets, resolution: event.resolution, purpose: event.purpose, extensionTrust: event.extensionTrust } };
  if (event.type === 'authorization.resolved') next = { ...next, pendingAuthorization: undefined };
  if (event.type === 'user_input.requested') next = { ...next, pendingUserInput: { requestId: event.requestId, questions: event.questions }, planStatus: next.planMode === 'plan' ? 'waiting_user' : next.planStatus };
  if (event.type === 'user_input.resolved') next = { ...next, pendingUserInput: undefined, planStatus: next.planMode === 'plan' ? 'planning' : next.planStatus };
  if (event.type === 'plan.updated') next = { ...next, planStatus: event.status, ...(event.planMode ? { planMode: event.planMode } : {}) };
  if (['reasoning.started', 'reasoning.delta', 'text.delta', 'tool.started', 'tool.progress', 'tool.completed', 'file.produced', 'authorization.requested', 'user_input.requested', 'plan.updated', 'run.failed', 'run.cancelled'].includes(event.type)) {
    next = { ...next, awaitingFirstResponse: undefined };
  }
  if (event.type === 'work.status' && eventDetail(event.detail)) next = { ...next, awaitingFirstResponse: undefined };

  const messages = [...next.messages];
  let index = messages.findIndex((message) => message.runId === event.runId && !isAsteriumUser(message.authorId));
  if (index < 0 && !['session.bound', 'message.accepted'].includes(event.type) && (event.type !== 'work.status' || Boolean(eventDetail(event.detail)))) {
    messages.push(assistantMessage(next, event));
    index = messages.length - 1;
  }
  if (index >= 0) {
    const message = { ...messages[index], toolEvents: [...(messages[index].toolEvents ?? [])], timeline: [...(messages[index].timeline ?? [])] };
    if (event.type === 'text.delta') {
      message.content += event.text;
      message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'text', text: event.text });
    }
    if (event.type === 'work.status') {
      const detail = eventDetail(event.detail);
      const shouldKeep = (event.state === 'thinking' && Boolean(detail))
        || (event.state !== 'thinking' && event.state !== 'idle');
      if (shouldKeep) message.timeline = appendTimeline(message, {
        id: event.eventId, sequence: event.sequence, kind: event.state === 'thinking' ? 'reasoning' : 'status', summary: event.summary,
        state: 'running', detail,
      });
    }
    if (event.type === 'reasoning.started') {
      message.timeline = appendTimeline(message, {
        id: event.eventId,
        sequence: event.sequence,
        kind: 'reasoning',
        reasoningId: event.reasoningId,
        summary: event.summary,
        state: 'running',
        detail: '',
      });
    }
    if (event.type === 'reasoning.delta') {
      const reasoningIndex = message.timeline.findIndex((item) => item.kind === 'reasoning' && item.reasoningId === event.reasoningId);
      if (reasoningIndex >= 0) {
        const row = message.timeline[reasoningIndex];
        if (row.kind === 'reasoning') message.timeline[reasoningIndex] = { ...row, detail: `${row.detail ?? ''}${event.text}`.slice(0, 200_000) };
      }
    }
    if (event.type === 'reasoning.completed') {
      const reasoningIndex = message.timeline.findIndex((item) => item.kind === 'reasoning' && item.reasoningId === event.reasoningId);
      if (reasoningIndex >= 0) {
        const row = message.timeline[reasoningIndex];
        if (row.kind === 'reasoning') message.timeline[reasoningIndex] = {
          ...row,
          state: event.outcome === 'completed' ? 'success' : 'failure',
          truncated: event.truncated,
          detail: event.truncated ? `${row.detail ?? ''}\n\n（思考内容过长，已截断）` : row.detail,
        };
      }
    }
    if (event.type === 'tool.started') message.toolEvents!.push({ id: event.toolCallId, label: event.summary, state: 'running' });
    if (event.type === 'tool.progress') {
      const toolIndex = message.toolEvents!.findIndex((tool) => tool.id === event.toolCallId);
      if (toolIndex >= 0) message.toolEvents![toolIndex] = { ...message.toolEvents![toolIndex], label: event.summary };
    }
    if (event.type === 'tool.completed') {
      const toolIndex = message.toolEvents!.findIndex((tool) => tool.id === event.toolCallId);
      const tool = { id: event.toolCallId, label: event.summary, state: event.outcome } as const;
      if (toolIndex >= 0) message.toolEvents![toolIndex] = tool;
      else message.toolEvents!.push(tool);
    }
    if (event.type === 'tool.started' || event.type === 'tool.progress' || event.type === 'tool.completed') {
      const previousAction = message.timeline?.find((item) => (item.kind === 'tool' || item.kind === 'computer') && item.toolCallId === event.toolCallId);
      const toolName = 'toolName' in event ? event.toolName : previousAction?.kind === 'tool' ? previousAction.toolName : undefined;
      const presentationName = event.type === 'tool.started' ? event.presentationName : previousAction?.kind === 'tool' ? previousAction.presentationName : undefined;
      const isComputer = previousAction?.kind === 'computer' || Boolean(toolName && /computer|desktop|browser.*control/i.test(toolName));
      message.timeline = appendTimeline(message, isComputer ? {
        id: event.eventId, sequence: event.sequence, kind: 'computer', toolCallId: event.toolCallId,
        summary: event.type === 'tool.completed' ? `操作电脑${event.outcome === 'success' ? '成功' : '失败'}` : '正在操作电脑',
        state: event.type === 'tool.completed' ? event.outcome : 'running',
      } : {
      id: event.eventId, sequence: event.sequence, kind: 'tool', toolCallId: event.toolCallId,
      ...(toolName ? { toolName } : {}),
      ...(presentationName ? { presentationName } : {}),
      category: operationCategory(presentationName ?? toolName),
      ...('mutatesExternalState' in event ? { mutatesExternalState: event.mutatesExternalState } : {}),
      summary: event.summary, state: event.type === 'tool.completed' ? event.outcome : 'running', detail: eventDetail(event.detail),
      });
    }
    if (event.type === 'file.produced') {
      message.toolEvents!.push({ id: event.artifactId, label: `产出文件：${event.name}`, state: 'success' });
      message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'file', artifactId: event.artifactId, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), name: event.name, summary: `产出文件：${event.name}`, state: 'success', mediaType: event.mediaType, sizeBytes: event.sizeBytes, changeKind: event.changeKind });
      const artifact = { id: event.artifactId, name: event.name, artifactRef: event.artifactRef, mediaType: event.mediaType, sizeBytes: event.sizeBytes, createdAt: event.occurredAt, runId: event.runId, sourceKind: event.sourceKind, registrationMethod: event.registrationMethod, availability: event.availability, cached: event.cached, localSourceKey: event.localSourceKey };
      next = { ...next, artifacts: [...(next.artifacts ?? []), artifact] };
    }
    if (event.type === 'authorization.requested') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'authorization', authorizationId: event.authorizationId, ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), summary: event.summary, detail: event.targets.join('\n'), action: event.action, risk: event.risk, state: 'running', purpose: event.purpose });
    if (event.type === 'authorization.resolved') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'authorization', authorizationId: event.authorizationId, summary: event.extensionTrustGranted ? '已允许并持续信任此扩展' : event.decision === 'allow_once' ? '已允许本次操作' : '已拒绝本次操作', decision: event.decision, extensionTrustGranted: event.extensionTrustGranted, state: event.decision === 'allow_once' ? 'success' : 'failure' });
    if (event.type === 'user_input.requested') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'user_input', requestId: event.requestId, questions: event.questions, state: 'running' });
    if (event.type === 'user_input.resolved') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'user_input', requestId: event.requestId, questions: [], answers: event.answers, customAnswers: event.customAnswers, state: 'success' });
    if (event.type === 'plan.updated') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'plan', status: event.status, summary: planStatusLabel(event.status), detail: event.explanation ?? event.steps?.map((step) => `${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '→' : '○'} ${step.text}`).join('\n'), state: event.status === 'completed' ? 'success' : 'running' });
    if (event.type === 'run.failed') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'error', summary: friendlyRuntimeErrorMessage(event.error.message), detail: event.error.technicalDetail, state: 'failure' });
    if (event.type === 'run.cancelled') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'status', summary: event.reason, state: 'failure' });
    if (event.type === 'extension.event') message.timeline = appendTimeline(message, { id: event.eventId, sequence: event.sequence, kind: 'status', summary: `${event.namespace} · ${event.name}`, detail: eventDetail(JSON.stringify(event.payload, null, 2)), state: 'success' });
    if (event.type === 'run.completed') Object.assign(message, { runState: 'completed' as const, isStreaming: false, completedAt: event.occurredAt, timeline: finalizeTimeline(message, 'success') });
    if (event.type === 'run.failed') Object.assign(message, { runState: 'failed' as const, isStreaming: false, completedAt: event.occurredAt, error: { ...event.error, message: friendlyRuntimeErrorMessage(event.error.message) }, timeline: finalizeTimeline(message, 'failure') });
    if (event.type === 'run.cancelled') Object.assign(message, { runState: 'cancelled' as const, isStreaming: false, completedAt: event.occurredAt, timeline: finalizeTimeline(message, 'failure') });
    messages[index] = message;
  }
  if (event.type === 'run.completed') next = { ...next, activeRun: undefined, pendingAuthorization: undefined, pendingUserInput: undefined, workStatus: undefined, awaitingFirstResponse: undefined, runNotice: undefined, regenerationBackup: undefined };
  if (event.type === 'run.failed') next = { ...next, activeRun: undefined, pendingAuthorization: undefined, pendingUserInput: undefined, workStatus: undefined, awaitingFirstResponse: undefined, runNotice: { state: 'failed', message: friendlyRuntimeErrorMessage(event.error.message) } };
  if (event.type === 'run.cancelled') next = { ...next, activeRun: undefined, pendingAuthorization: undefined, pendingUserInput: undefined, workStatus: undefined, awaitingFirstResponse: undefined, runNotice: { state: 'cancelled', message: event.reason } };
  if ((event.type === 'run.failed' || event.type === 'run.cancelled') && next.regenerationBackup) {
    const backup = next.regenerationBackup;
    next = { ...next, messages: backup.messages, sessionId: backup.sessionId, regenerationBackup: undefined, runNotice: { ...next.runNotice!, restored: true } };
    return next;
  }
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i].runId === event.runId && messages[i].guidanceState === 'queued') messages[i] = { ...messages[i], status: 'failed' };
    }
  }
  return { ...next, messages };
}

function eventBelongsToConversation(conversation: Conversation, event: PartnerEvent | MessageDeliveryEvent) {
  if (conversation.partnerId !== event.partnerId) return false;
  const ownsClientMessage = conversation.messages.some((message) => isAsteriumUser(message.authorId) && message.clientMessageId === event.clientMessageId);
  if (event.type === 'message.delivery') return ownsClientMessage;
  if (event.type === 'session.bound') return ownsClientMessage || conversation.activeRun?.clientMessageId === event.clientMessageId;
  if (conversation.sessionId && conversation.sessionId !== event.sessionId) return false;
  if (conversation.activeRun) return conversation.activeRun.runId === event.runId && conversation.activeRun.clientMessageId === event.clientMessageId;
  return ownsClientMessage || conversation.messages.some((message) => message.runId === event.runId);
}

export function prototypeReducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case 'automationEvent': {
      const t = action.run.definition.target;
        if (action.event.conversationId !== t.conversationId || action.event.partnerId !== t.partnerId || action.event.sessionId !== t.nativeThreadId) return state;
        if (t.roomId) {
          if (action.event.route?.scope !== 'group' || action.event.route.roomId !== t.roomId) return state;
          const notify = ['run.completed', 'run.failed', 'run.cancelled'].includes(action.event.type) && (action.run.definition.notifications === 'always' || action.event.type !== 'run.completed' || action.run.changed !== false);
          return notify ? { ...state, groupChats: state.groupChats.map(g => g.id === t.roomId ? { ...g, unreadCompletedAt: action.event.occurredAt } : g) } : state;
        }
      return updateConversation(state, t.conversationId, c => {
        if (c.partnerId !== t.partnerId || c.sessionId !== t.nativeThreadId) return c;
        const next = applyAgentEventToConversation(c, action.event);
        const messages = next.messages.map(m => m.runId === action.event.runId ? { ...m, automation: { automationId: action.run.automationId, runId: action.run.id, name: action.run.definition.name } } : m);
        const notify = ['run.completed', 'run.failed', 'run.cancelled'].includes(action.event.type) && (action.run.definition.notifications === 'always' || action.event.type !== 'run.completed' || action.run.changed !== false);
        return { ...next, messages, ...(notify ? { unreadCompletedAt: action.event.occurredAt } : {}) };
      });
    }
    case 'automationHydrate': {
      let next = state;
      for (const run of action.runs) {
        if (run.definition.target.roomId) continue;
        const t = run.definition.target;
        if (['starting', 'running', 'waiting_approval'].includes(run.state)) continue;
        if (!run.summary?.trim() && !run.events.length) continue;
        next = updateConversation(next, t.conversationId, c => {
          if (c.partnerId !== t.partnerId || c.messages.some(m => m.automation?.runId === run.id || m.id === run.messageId)) return c;
          const at = run.startedAt ?? run.createdAt;
          const text = run.summary ?? run.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
          return { ...c, ...((run.definition.notifications === 'always' || run.state !== 'succeeded' || run.changed !== false) ? { unreadCompletedAt: run.finishedAt ?? run.updatedAt } : {}), messages: [...c.messages, { id: run.messageId ?? `automation-result:${run.id}`, authorId: t.partnerId, content: text, createdAt: new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), occurredAt: at, completedAt: run.finishedAt, status: 'delivered', runState: run.state === 'succeeded' ? 'completed' : 'failed', automation: { automationId: run.automationId, runId: run.id, name: run.definition.name } }] };
        });
      }
      return next;
    }
    case 'selectPartner': {
      if (state.partners.find((partner) => partner.id === action.partnerId)?.isRemoved) return state;
      const firstConversation = state.conversations.find((conversation) => conversation.partnerId === action.partnerId && !conversation.isArchived);
      return {
        ...state,
        activePartnerId: action.partnerId,
        activeConversationId: firstConversation?.id ?? '',
        conversations: firstConversation
          ? state.conversations.map((conversation) => conversation.id === firstConversation.id ? { ...conversation, unreadCompletedAt: undefined } : conversation)
          : state.conversations,
      };
    }
    case 'selectConversation': {
      const conversation = state.conversations.find((item) => item.id === action.conversationId);
      return {
        ...state,
        activeConversationId: action.conversationId,
        activePartnerId: conversation?.partnerId ?? state.activePartnerId,
        conversations: state.conversations.map((item) => item.id === action.conversationId ? { ...item, unreadCompletedAt: undefined } : item),
      };
    }
    case 'selectProject':
      {
        const groupId = state.groupChats.find((groupChat) => groupChat.projectId === action.projectId && !groupChat.archivedAt)?.id ?? '';
        return {
          ...state,
          activeProjectId: action.projectId,
          activeGroupChatId: groupId,
          groupChats: state.groupChats.map((groupChat) => groupChat.id === groupId ? { ...groupChat, unreadCompletedAt: undefined } : groupChat),
        };
      }
    case 'addPartner':
      return { ...state, partners: [...state.partners, action.partner], activePartnerId: action.partner.id };
    case 'updatePartner':
      return { ...state, partners: state.partners.map((partner) => {
        if (partner.id !== action.partner.id) return partner;
        if (!action.previous) return action.partner;
        // A delayed save receipt cannot overwrite newer runtime observations,
        // a later profile refresh, or a removed/reconfigured partner.
        if (partner.isRemoved || partner.sourceMode !== action.previous.sourceMode
          || partner.profileRevision !== action.previous.profileRevision && partner.profileRevision !== action.partner.profileRevision) return partner;
        const before = action.previous as unknown as Record<string, unknown>, after = action.partner as unknown as Record<string, unknown>;
        const changes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((key) => !Object.is(before[key], after[key])).map((key) => [key, after[key]]));
        return { ...partner, ...changes } as Partner;
      }) };
    case 'updateUserProfile':
      return { ...state, userProfile: action.profile };
    case 'hydratePartnerProfiles': {
      const snapshots = new Map(action.profiles.partners.map((profile) => [profile.partnerId, profile]));
      return {
        ...state,
        userProfile: { ...state.userProfile, ...action.profiles.user, audience: 'all' },
        partners: state.partners.map((partner) => {
          const profile = snapshots.get(partner.id);
          if (!profile) return partner;
          return {
            ...partner,
            publicIdentity: profile.publicIdentity,
            profileManagement: profile.management,
            profileRevision: profile.revision,
            recentModel: profile.recentModel,
            ...(profile.management.personality
              ? partner.sourceMode === 'api_partner'
                ? { personality: profile.personality ?? '', systemPrompt: profile.systemPrompt || undefined }
                : { managedPersonality: profile.personality ?? '', managedSystemPrompt: profile.systemPrompt || undefined }
              : {}),
          } as Partner;
        }),
        conversations: state.conversations.map((conversation) => {
          const model = snapshots.get(conversation.partnerId)?.conversationModels[conversation.id];
          return model ? { ...conversation, runtimeModel: model } : conversation;
        }),
      };
    }
    case 'removePartner': {
      const partners = state.partners.map((partner) => partner.id === action.partnerId
        ? {
            ...partner,
            status: 'offline' as const,
            isRemoved: true,
            removedAt: action.removedAt,
            ...(partner.sourceMode === 'local_cli'
              ? { workspaceGrantId: undefined, workspaceGrantIds: undefined, activeWorkspaceGrantId: undefined, partnerRootGrantId: undefined }
              : { credentialRef: undefined, configured: false }),
            ...(partner.sourceMode === 'existing_thread' ? { connectionStatus: 'failed' as const } : {}),
          }
        : partner);
      if (state.activePartnerId !== action.partnerId) return { ...state, partners };
      const nextPartner = partners.find((partner) => !partner.isRemoved);
      return {
        ...state,
        partners,
        activePartnerId: nextPartner?.id ?? '',
        activeConversationId: nextPartner ? state.conversations.find((conversation) => conversation.partnerId === nextPartner.id && !conversation.isArchived)?.id ?? '' : '',
      };
    }
    case 'markPartnerDataDeleted':
      return {
        ...state,
        partners: state.partners.map((partner) => partner.id === action.partnerId && partner.isRemoved
          ? { ...partner, managedDataDeletedAt: action.deletedAt }
          : partner),
      };
    case 'createConversation':
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activePartnerId: action.conversation.partnerId,
        activeConversationId: action.conversation.id,
      };
    case 'renameConversation':
      return {
        ...state,
        conversations: state.conversations.map((conversation) => conversation.id === action.conversationId
          ? { ...conversation, title: action.title.trim().slice(0, 50), updatedAt: new Date().toISOString() }
          : conversation),
      };
    case 'archiveConversation': {
      const archived = state.conversations.find((conversation) => conversation.id === action.conversationId);
      const owner = state.partners.find((partner) => partner.id === archived?.partnerId);
      if (!archived || archived.activeRun || (archived.isPrimaryThread && !owner?.isRemoved)) return state;
      const conversations = state.conversations.map((conversation) => conversation.id === action.conversationId
        ? { ...conversation, isArchived: true, isPinned: false, archivedAt: action.archivedAt }
        : conversation);
      if (state.activeConversationId !== action.conversationId) return { ...state, conversations };
      const next = conversations.find((conversation) => !conversation.isArchived && conversation.partnerId === archived.partnerId)
        ?? conversations.find((conversation) => !conversation.isArchived);
      return {
        ...state,
        conversations,
        activeConversationId: next?.id ?? '',
        activePartnerId: next?.partnerId ?? state.partners.find((partner) => !partner.isRemoved)?.id ?? '',
      };
    }
    case 'archivePartnerConversations': {
      if (state.conversations.some((conversation) => conversation.partnerId === action.partnerId && conversation.activeRun)) return state;
      const owner = state.partners.find((partner) => partner.id === action.partnerId);
      if (owner?.sourceMode === 'existing_thread' && !owner.isRemoved) return state;
      const conversations = state.conversations.map((conversation) => conversation.partnerId === action.partnerId
        ? { ...conversation, isArchived: true, isPinned: false, archivedAt: action.archivedAt }
        : conversation);
      if (!conversations.find((conversation) => conversation.id === state.activeConversationId)?.isArchived) return { ...state, conversations };
      const next = conversations.find((conversation) => !conversation.isArchived);
      return { ...state, conversations, activeConversationId: next?.id ?? '', activePartnerId: next?.partnerId ?? state.partners.find((partner) => !partner.isRemoved)?.id ?? '' };
    }
    case 'restoreConversation':
      return {
        ...state,
        conversations: state.conversations.map((conversation) => conversation.id === action.conversationId
          ? { ...conversation, isArchived: undefined, archivedAt: undefined }
          : conversation),
      };
    case 'deleteConversationPermanently': {
      const target = state.conversations.find((conversation) => conversation.id === action.conversationId);
      const owner = state.partners.find((partner) => partner.id === target?.partnerId);
      if (!target?.isArchived || target.activeRun || (target.isPrimaryThread && !owner?.isRemoved)) return state;
      return { ...state, conversations: state.conversations.filter((conversation) => conversation.id !== action.conversationId) };
    }
    case 'reconcileDeletedConversations': {
      const deleted = new Set(action.conversationIds);
      const conversations = state.conversations.filter((conversation) => !deleted.has(conversation.id));
      if (conversations.length === state.conversations.length) return state;
      if (!deleted.has(state.activeConversationId)) return { ...state, conversations };
      const next = conversations.find((conversation) => !conversation.isArchived) ?? conversations[0];
      return {
        ...state,
        conversations,
        activeConversationId: next?.id ?? '',
        activePartnerId: next?.partnerId ?? state.partners.find((partner) => !partner.isRemoved)?.id ?? '',
      };
    }
    case 'syncNativeThreadLifecycle': {
      const target = state.conversations.find((conversation) => conversation.id === action.conversationId);
      if (!target) return state;
      if (target.nativeThreadStateCheckedAt && target.nativeThreadStateCheckedAt > action.checkedAt) return state;
      if (action.state === 'deleted') {
        const conversations = state.conversations.filter((conversation) => conversation.id !== action.conversationId);
        if (state.activeConversationId !== action.conversationId) return { ...state, conversations };
        const next = conversations.find((conversation) => !conversation.isArchived && conversation.partnerId === target.partnerId)
          ?? conversations.find((conversation) => !conversation.isArchived);
        return { ...state, conversations, activeConversationId: next?.id ?? '', activePartnerId: next?.partnerId ?? state.activePartnerId };
      }
      const restoredByNative = action.state === 'active' && target.nativeThreadState === 'archived';
      const notice = action.message ? { state: action.state === 'unavailable' ? 'error' as const : 'warning' as const, message: action.message } : undefined;
      const conversations = state.conversations.map((conversation) => conversation.id === action.conversationId ? {
        ...conversation,
        nativeThreadState: action.state,
        nativeThreadStateCheckedAt: action.checkedAt,
        nativeThreadNotice: notice,
        ...(action.state === 'archived' ? { isArchived: true, isPinned: false, archivedAt: conversation.archivedAt ?? action.checkedAt } : {}),
        ...(action.state === 'active' ? {
          nativeThreadNotice: undefined,
          ...(restoredByNative ? { isArchived: undefined, archivedAt: undefined } : {}),
        } : {}),
      } : conversation);
      if (action.state !== 'archived' || state.activeConversationId !== action.conversationId) return { ...state, conversations };
      const next = conversations.find((conversation) => !conversation.isArchived && conversation.partnerId === target.partnerId)
        ?? conversations.find((conversation) => !conversation.isArchived);
      return { ...state, conversations, activeConversationId: next?.id ?? '', activePartnerId: next?.partnerId ?? state.activePartnerId };
    }
    case 'toggleConversationPin':
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId
            ? { ...conversation, isPinned: !conversation.isPinned }
            : conversation,
        ),
      };
    case 'hydrateProjectDomain': {
      const tasksByProject = new Map(action.snapshot.projects.map((project) => [
        project.id,
        action.snapshot.tasks.filter((task) => task.projectId === project.id),
      ]));
      const projects = action.snapshot.projects.map((record) => {
        const existing = state.projects.find((project) => project.id === record.id);
        return {
          ...record,
          files: existing?.files ?? [],
          tasks: tasksByProject.get(record.id) ?? [],
          ...(existing?.workspace ? { workspace: existing.workspace } : {}),
        };
      });
      const projectIds = new Set(projects.map((project) => project.id));
      const groupChats = state.groupChats.filter((group) => projectIds.has(group.projectId) || Boolean(group.archivedAt));
      const activeProjectId = projectIds.has(state.activeProjectId) ? state.activeProjectId : projects[0]?.id ?? '';
      const activeGroupChatId = groupChats.some((group) => group.id === state.activeGroupChatId)
        ? state.activeGroupChatId
        : groupChats.find((group) => group.projectId === activeProjectId && !group.archivedAt)?.id ?? '';
      return { ...state, projects, groupChats, activeProjectId, activeGroupChatId };
    }
    case 'createProject':
      return {
        ...state,
        projects: [action.project, ...state.projects],
        activeProjectId: action.project.id,
      };
    case 'updateProject':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.project.id ? action.project : project),
      };
    case 'upsertProjectTask':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.task.projectId
          ? { ...project, tasks: [...project.tasks.filter((task) => task.id !== action.task.id), action.task] }
          : project),
      };
    case 'removeProjectTask':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.projectId
          ? { ...project, tasks: project.tasks.filter((task) => task.id !== action.taskId) }
          : project),
      };
    case 'removeProject': {
      const projects = state.projects.filter((project) => project.id !== action.projectId);
      const removedGroupIds = new Set(state.groupChats.filter((group) => group.projectId === action.projectId).map((group) => group.id));
      const groupChats = state.groupChats.map((group) => group.projectId === action.projectId
        ? { ...group, archivedAt: group.archivedAt ?? action.archivedAt, projectDeletedAt: group.projectDeletedAt ?? action.archivedAt, unreadCompletedAt: undefined, updatedAt: group.archivedAt ? group.updatedAt : action.archivedAt }
        : group);
      if (state.activeProjectId !== action.projectId) {
        return {
          ...state,
          projects,
          groupChats,
          activeGroupChatId: removedGroupIds.has(state.activeGroupChatId)
            ? groupChats.find((group) => group.projectId === state.activeProjectId && !group.archivedAt)?.id ?? ''
            : state.activeGroupChatId,
        };
      }
      const nextProject = projects[0];
      const nextGroup = nextProject ? groupChats.find((group) => group.projectId === nextProject.id && !group.archivedAt) : undefined;
      return {
        ...state,
        projects,
        groupChats,
        activeProjectId: nextProject?.id ?? '',
        activeGroupChatId: nextGroup?.id ?? '',
      };
    }
    case 'setProjectMembers': {
      const memberIds = [...new Set(action.memberIds)];
      const project = state.projects.find((item) => item.id === action.projectId);
      if (!project) return state;
      const removed = new Set(project.memberIds.filter((id) => !memberIds.includes(id)));
      return {
        ...state,
        projects: state.projects.map((item) => item.id === action.projectId ? { ...item, memberIds } : item),
        groupChats: state.groupChats.map((group) => group.projectId === action.projectId
          ? { ...group, memberIds: group.memberIds.filter((id) => !removed.has(id)), updatedAt: new Date().toISOString() }
          : group),
      };
    }
    case 'updateProjectWorkspace':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.projectId
          ? {
              ...project,
              workspace: action.workspace,
              files: [...project.files.filter((file) => !action.files.some((next) => next.relativePath === file.relativePath)), ...action.files],
            }
          : project),
      };
    case 'selectGroupChat': {
      const groupChat = state.groupChats.find((item) => item.id === action.groupChatId);
      return {
        ...state,
        activeGroupChatId: action.groupChatId,
        activeProjectId: groupChat?.projectId ?? state.activeProjectId,
        groupChats: state.groupChats.map((item) => item.id === action.groupChatId ? { ...item, unreadCompletedAt: undefined } : item),
      };
    }
    case 'createGroupChat':
      return {
        ...state,
        groupChats: [action.groupChat, ...state.groupChats],
        projects: state.projects.map((project) => project.id === action.groupChat.projectId
          ? { ...project, memberIds: [...new Set([...project.memberIds, ...action.groupChat.memberIds])] }
          : project),
        activeGroupChatId: action.groupChat.id,
        activeProjectId: action.groupChat.projectId,
      };
    case 'updateGroupChat':
      return { ...state, groupChats: state.groupChats.map((groupChat) => groupChat.id === action.groupChat.id ? action.groupChat : groupChat) };
    case 'setGroupMembers': {
      const target = state.groupChats.find((group) => group.id === action.groupChatId);
      if (!target) return state;
      const memberIds = [...new Set(action.memberIds)];
      return {
        ...state,
        groupChats: state.groupChats.map((group) => group.id === action.groupChatId ? { ...group, memberIds, updatedAt: new Date().toISOString() } : group),
        projects: state.projects.map((project) => project.id === target.projectId
          ? { ...project, memberIds: [...new Set([...project.memberIds, ...memberIds])] }
          : project),
      };
    }
    case 'archiveGroupChat': {
      const target = state.groupChats.find((groupChat) => groupChat.id === action.groupChatId);
      if (!target) return state;
      const groupChats = state.groupChats.map((groupChat) => groupChat.id === action.groupChatId
        ? { ...groupChat, archivedAt: action.archivedAt, unreadCompletedAt: undefined, updatedAt: action.archivedAt }
        : groupChat);
      if (state.activeGroupChatId !== action.groupChatId) return { ...state, groupChats };
      const next = groupChats.find((groupChat) => groupChat.projectId === target.projectId && !groupChat.archivedAt);
      return { ...state, groupChats, activeGroupChatId: next?.id ?? '' };
    }
    case 'restoreGroupChat':
      return {
        ...state,
        groupChats: state.groupChats.map((groupChat) => groupChat.id === action.groupChatId
          ? { ...groupChat, archivedAt: undefined, updatedAt: new Date().toISOString() }
          : groupChat),
      };
    case 'removeGroupChat': {
      const groupChats = state.groupChats.filter((groupChat) => groupChat.id !== action.groupChatId);
      if (state.activeGroupChatId !== action.groupChatId) return { ...state, groupChats };
      const next = groupChats.find((groupChat) => groupChat.projectId === state.activeProjectId);
      return { ...state, groupChats, activeGroupChatId: next?.id ?? '' };
    }
    case 'toggleGroupMember': {
      const target = state.groupChats.find((groupChat) => groupChat.id === action.groupChatId);
      if (!target) return state;
      const adding = !target.memberIds.includes(action.partnerId);
      if (adding && state.partners.find((partner) => partner.id === action.partnerId)?.isRemoved) return state;
      return {
        ...state,
        groupChats: state.groupChats.map((groupChat) => groupChat.id === action.groupChatId
          ? { ...groupChat, memberIds: adding ? [...groupChat.memberIds, action.partnerId] : groupChat.memberIds.filter((id) => id !== action.partnerId), updatedAt: new Date().toISOString() }
          : groupChat),
        projects: adding ? state.projects.map((project) => project.id === target.projectId
          ? { ...project, memberIds: [...new Set([...project.memberIds, action.partnerId])] }
          : project) : state.projects,
      };
    }
    case 'sendChatMessage':
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId
            ? { ...conversation, messages: [...conversation.messages, action.message], awaitingFirstResponse: action.message.clientMessageId ? { clientMessageId: action.message.clientMessageId, startedAt: new Date().toISOString() } : undefined, updatedAt: new Date().toISOString() }
            : conversation,
        ),
      };
    case 'sendChatGuidance':
      return updateConversation(state, action.conversationId, (conversation) => {
        if (conversation.messages.some((message) => message.clientMessageId === action.message.clientMessageId)) return conversation;
        if (action.waitForApplication) return { ...conversation, messages: [...conversation.messages, action.message], updatedAt: new Date().toISOString() };
        const messages = [...conversation.messages];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (isAsteriumUser(message.authorId) || message.runId !== action.runId) continue;
          messages[index] = {
            ...message,
            id: `${message.id}:before-guidance:${action.message.id}`,
            runId: `${action.runId}:before-guidance:${action.message.id}`,
            runState: 'completed',
            isStreaming: false,
            completedAt: new Date().toISOString(),
            timeline: finalizeTimeline(message, 'success'),
          };
          break;
        }
        return {
          ...conversation,
          messages: [...messages, action.message],
          awaitingFirstResponse: action.message.clientMessageId ? { clientMessageId: action.message.clientMessageId, startedAt: new Date().toISOString() } : undefined,
          workStatus: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
    case 'rejectChatGuidance':
      return updateConversation(state, action.conversationId, (conversation) => ({ ...conversation, messages: conversation.messages.filter((message) => message.clientMessageId !== action.clientMessageId || message.guidanceState === 'applied') }));
    case 'setConversationPermissionMode':
      return updateConversation(state, action.conversationId, (conversation) => ({ ...conversation, permissionMode: action.mode, updatedAt: new Date().toISOString() }));
    case 'setConversationCodexModel':
      return updateConversation(state, action.conversationId, (conversation) => ({ ...conversation, codexModel: action.selection }));
    case 'setConversationPlanMode':
      return updateConversation(state, action.conversationId, (conversation) => ({ ...conversation, planMode: action.mode, planStatus: action.mode === 'plan' ? 'planning' : undefined, updatedAt: new Date().toISOString() }));
    case 'switchConversationWorkspace':
      return updateConversation(state, action.conversationId, () => action.conversation);
    case 'addProjectFile':
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.projectId
          ? { ...project, files: [...project.files.filter((file) => file.fileId !== action.file.fileId), action.file] }
          : project),
      };
    case 'syncProjectFiles':
      return {
        ...state,
        projects: state.projects.map((project) => {
          if (project.id !== action.projectId) return project;
          const previous = new Map(project.files.flatMap((file) => file.fileId ? [[file.fileId, file] as const] : []));
          const files = action.files.map((disk) => {
            const existing = previous.get(disk.fileId);
            return {
              ...(existing ?? {}),
              id: disk.fileId,
              fileId: disk.fileId,
              name: disk.name,
              meta: disk.category === 'template' ? '项目基础文件' : '项目交付文件',
              kind: projectFileKind(disk.name),
              relativePath: disk.relativePath,
              revision: disk.revision,
              category: disk.category,
              sizeBytes: disk.sizeBytes,
              savedAt: disk.modifiedAt,
              availability: disk.availability,
              ...(disk.artifactId ? { artifactId: disk.artifactId } : {}),
              ...(disk.contentHash ? { contentHash: disk.contentHash } : {}),
              ...(disk.savedAt ? { savedAt: disk.savedAt } : {}),
              ...(disk.sourcePartnerId ? { sourcePartnerId: disk.sourcePartnerId } : {}),
              ...(disk.sourcePartnerName ? { sourcePartnerName: disk.sourcePartnerName } : {}),
            };
          });
          return { ...project, files };
        }),
      };
    case 'addConversationArtifact':
      return updateConversation(state, action.conversationId, (conversation) => ({
        ...conversation,
        artifacts: [...(conversation.artifacts ?? []).filter((item) => item.id !== action.artifact.id), action.artifact],
        updatedAt: new Date().toISOString(),
      }));
    case 'removeConversationArtifact':
      return updateConversation(state, action.conversationId, (conversation) => ({
        ...conversation,
        artifacts: (conversation.artifacts ?? []).filter((item) => item.id !== action.artifactId && item.artifactRef !== action.artifactId),
        updatedAt: new Date().toISOString(),
      }));
    case 'sendStudioMessage':
      return {
        ...state,
        groupChats: state.groupChats.map((groupChat) =>
          groupChat.id === action.groupChatId ? { ...groupChat, messages: [...groupChat.messages, action.message], updatedAt: new Date().toISOString() } : groupChat,
        ),
      };
    case 'hydrateStudioMessages':
      return {
        ...state,
        groupChats: state.groupChats.map((groupChat) => groupChat.id === action.groupChatId
          ? { ...groupChat, messages: action.messages, updatedAt: new Date().toISOString(), unreadCompletedAt: action.unreadCompletedAt ?? groupChat.unreadCompletedAt }
          : groupChat),
      };
    case 'replaceLastTurn':
      return updateConversation(state, action.conversationId, (conversation) => ({
        ...conversation,
        regenerationBackup: action.restoreOnFailure ? { messages: conversation.messages, sessionId: conversation.sessionId } : undefined,
        messages: action.messages,
        sessionId: action.sessionId,
        activeRun: undefined,
        pendingAuthorization: undefined,
        workStatus: undefined,
        runNotice: undefined,
        lastRunId: undefined,
        lastSequence: undefined,
        updatedAt: new Date().toISOString(),
      }));
    case 'addProjectMember':
      return {
        ...state,
        projects: state.projects.map((project) =>
          project.id === action.projectId && !project.memberIds.includes(action.partnerId)
            ? { ...project, memberIds: [...project.memberIds, action.partnerId] }
            : project,
        ),
      };
    case 'updatePartnerWorkspaceGrants':
      return {
        ...state,
        partners: state.partners.map((partner) => {
          if (partner.id !== action.partnerId || partner.sourceMode === 'existing_thread') return partner;
          if (partner.sourceMode === 'api_partner') {
            const primaryWorkspaceGrantId = action.preferredGrantId && action.grants.some((grant) => grant.grantId === action.preferredGrantId)
              ? action.preferredGrantId : action.grants[0]?.grantId;
            return {
              ...partner,
              workingDirectories: action.grants.map((grant) => grant.displayPath),
              workspaceGrantIds: action.grants.map((grant) => grant.grantId),
              primaryWorkspaceGrantId,
            };
          }
          return {
            ...partner,
            workingDirectories: action.grants.map((grant) => grant.displayPath),
            workspaceGrantIds: action.grants.map((grant) => grant.grantId),
            activeWorkspaceGrantId: action.preferredGrantId && action.grants.some((grant) => grant.grantId === action.preferredGrantId)
              ? action.preferredGrantId : action.grants[0]?.grantId,
            workingDirectory: action.grants[0]?.displayPath,
            workspaceGrantId: action.grants[0]?.grantId,
            primaryWorkspaceGrantId: undefined,
          };
        }),
      };
    case 'syncPartnerWorkspaceState': {
      let changed = false;
      const partners = state.partners.map((partner) => {
        if (partner.id !== action.workspace.partnerId || partner.sourceMode === 'existing_thread') return partner;
        const next = applyPartnerWorkspace(partner, action.workspace);
        if (samePartnerWorkspace(partner, next)) return partner;
        changed = true;
        return next;
      });
      return changed ? { ...state, partners } : state;
    }
    case 'rebindPartnerRoot': {
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        activePartnerId: action.partnerId,
        activeConversationId: action.conversation.id,
      };
    }
    case 'bindRunReceipt':
      return updateConversation(state, action.conversationId, (conversation) => ({
        ...conversation,
        sessionId: action.sessionId,
        activeRun: { runId: action.runId, clientMessageId: action.clientMessageId },
        messages: conversation.messages.map((message) => message.clientMessageId === action.clientMessageId ? { ...message, runId: action.runId } : message),
      }));
    case 'agentEvent': {
      const event = action.event;
      if (event.type === 'existing_thread.reply') {
        const partner = state.partners.find((item) => item.id === event.partnerId);
        if (partner?.sourceMode !== 'existing_thread' || partner.isRemoved || partner.threadId !== event.threadId) return state;
        return updateConversation(state, event.conversationId, (conversation) => {
          const id = `cyberboss-reply:${event.threadId}:${event.eventId}`;
          if (conversation.partnerId !== event.partnerId || conversation.sessionId !== event.threadId
            || conversation.messages.some((message) => message.id === id)) return conversation;
          const message: Message = {
            id,
            authorId: event.partnerId,
            content: event.text,
            occurredAt: event.occurredAt,
            createdAt: new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          };
          return { ...conversation, messages: [...conversation.messages, message], updatedAt: new Date().toISOString() };
        });
      }
      if (event.type === 'existing_thread.changed') {
        const partner = state.partners.find((item): item is ExistingThreadPartner => item.id === event.partnerId && item.sourceMode === 'existing_thread');
        const conversationsCurrent = state.conversations
          .filter((conversation) => conversation.partnerId === event.partnerId)
          .every((conversation) => conversation.sessionId === event.threadId);
        if (partner?.threadId === event.threadId && partner.workspaceRoot === event.workspaceRoot && conversationsCurrent) return state;
        return {
          ...state,
          partners: state.partners.map((item) => item.id === event.partnerId && item.sourceMode === 'existing_thread'
            ? { ...item, threadId: event.threadId, workspaceRoot: event.workspaceRoot }
            : item),
          conversations: state.conversations.map((conversation) => conversation.partnerId === event.partnerId
            ? { ...conversation, sessionId: event.threadId, updatedAt: event.occurredAt }
            : conversation),
        };
      }
      const target = state.conversations.find((conversation) => conversation.id === event.conversationId);
      const targetPartner = state.partners.find((partner) => partner.id === target?.partnerId);
      if (!target || !targetPartner || targetPartner.sourceMode !== event.connectionSource || !eventBelongsToConversation(target, event)) return state;
      if (event.type === 'message.delivery') return updateConversation(state, event.conversationId, (conversation) => {
        if (event.state === 'failed' && conversation.regenerationBackup) return {
          ...conversation,
          messages: conversation.regenerationBackup.messages,
          sessionId: conversation.regenerationBackup.sessionId,
          regenerationBackup: undefined,
          failedRegenerationClientMessageId: event.clientMessageId,
          activeRun: undefined,
          awaitingFirstResponse: undefined,
          runNotice: { state: 'failed', message: friendlyRuntimeErrorMessage(event.error?.message ?? '重新生成失败'), restored: true },
        };
        return {
          ...conversation,
          ...(event.state === 'failed' ? { awaitingFirstResponse: undefined } : {}),
          messages: conversation.messages.map((message) => message.clientMessageId === event.clientMessageId
            ? { ...message, status: event.state, error: event.error }
            : message),
        };
      });
      if (event.type === 'extension.event') {
        const model = observedModel(event);
        if (model) return {
          ...state,
          partners: state.partners.map((partner) => partner.id === event.partnerId ? { ...partner, recentModel: { ...model, status: 'recent' } } : partner),
          conversations: state.conversations.map((conversation) => conversation.id === event.conversationId ? { ...conversation, runtimeModel: model } : conversation),
        };
      }
      if (event.type === 'session.bound') {
        const model = boundModel(event);
        if (model) return {
          ...state,
          partners: state.partners.map((partner) => partner.id === event.partnerId ? { ...partner, recentModel: { ...model, status: 'recent' } } : partner),
          conversations: state.conversations.map((conversation) => conversation.id === event.conversationId ? applyAgentEventToConversation(conversation, event) : conversation),
        };
      }
      return updateConversation(state, event.conversationId, (conversation) => {
        const updated = applyAgentEventToConversation(conversation, event);
        if (event.type !== 'run.completed' || !action.unreadOnCompletion) return updated;
        const assistant = updated.messages.find((message) => message.runId === event.runId && !isAsteriumUser(message.authorId));
        const hasVisibleOutput = Boolean(assistant?.content.trim() || assistant?.timeline?.length);
        return hasVisibleOutput ? { ...updated, unreadCompletedAt: event.occurredAt } : updated;
      });
    }
    case 'messageSendFailed':
      return updateConversation(state, action.conversationId, (conversation) => ({
        ...conversation,
        activeRun: undefined,
        awaitingFirstResponse: undefined,
        runNotice: { state: 'failed', message: friendlyRuntimeErrorMessage(action.error.message), ...(conversation.regenerationBackup ? { restored: true } : {}) },
        messages: conversation.regenerationBackup?.messages ?? conversation.messages.map((message) => message.clientMessageId === action.clientMessageId
          ? { ...message, status: 'failed', error: action.error }
          : message),
        ...(conversation.regenerationBackup ? { sessionId: conversation.regenerationBackup.sessionId, regenerationBackup: undefined } : {}),
      }));
    case 'reset':
      return action.state;
    default:
      return state;
  }
}

interface PrototypeContextValue {
  state: PrototypeState;
  chatMaintenanceRunning: Record<string, boolean>;
  chatCommandResults: Record<string, { state: 'running' | 'success' | 'info' | 'error'; message: string; session?: SessionStatus }>;
  dismissChatCommandResult: (conversationId: string, result: PrototypeContextValue['chatCommandResults'][string]) => void;
  executeChatCommand: (conversationId: string, command: SessionCommandName) => Promise<void>;
  chatCompactions: Record<string, { state: 'running' | 'success' | 'info' | 'error'; message: string }>;
  dismissChatCompaction: (conversationId: string, result: PrototypeContextValue['chatCompactions'][string]) => void;
  compactChatContext: (conversationId: string) => Promise<void>;
  appearance: AppearanceSettings;
  appearanceError: string | null;
  updateAppearance: (patch: AppearanceUpdate) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  selectPartner: (partnerId: string) => void;
  selectConversation: (conversationId: string) => void;
  selectProject: (projectId: string) => void;
  refreshProfiles: () => Promise<import('../../shared/agentProtocol').PartnerProfilesSyncResult | undefined>;
  addPartner: (partner: Partner, alreadySaved?: boolean) => void;
  updatePartner: (partner: Partner, alreadySaved?: boolean) => Promise<void>;
  updateUserProfile: (profile: UserProfile) => Promise<UserProfile>;
  removePartner: (partnerId: string) => void;
  trashRemovedPartnerData: (partnerId: string) => Promise<boolean>;
  createConversation: (partnerId: string, title?: string, sessionId?: string) => string;
  renameConversation: (conversationId: string, title: string) => void;
  archiveConversation: (conversationId: string) => Promise<ConversationLifecycleOutcome>;
  archivePartnerConversations: (partnerId: string) => void;
  restoreConversation: (conversationId: string) => Promise<ConversationLifecycleOutcome>;
  deleteConversationPermanently: (conversationId: string) => Promise<ConversationLifecycleOutcome>;
  ensureConversation: (partnerId: string) => string;
  toggleConversationPin: (conversationId: string) => void;
  setConversationPermissionMode: (conversationId: string, mode: PermissionMode) => void;
  setConversationPlanMode: (conversationId: string, mode: PlanMode) => void;
  setConversationCodexModel: (conversationId: string, selection: import('../../shared/codexModels').CodexModelSelection) => void;
  createProject: (name: string, options?: { description?: string; locationSelectionId?: string }) => Promise<string>;
  updateProject: (project: Project) => Promise<void>;
  createProjectTask: (request: ProjectTaskCreateRequest) => Promise<TaskItem>;
  updateProjectTask: (request: ProjectTaskUpdateRequest) => Promise<void>;
  removeProjectTask: (projectId: string, taskId: string, expectedRevision: number) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  initializeProjectWorkspace: (projectId: string, locationSelectionId?: string) => Promise<void>;
  addProjectFile: (projectId: string, file: ProjectFile) => void;
  selectGroupChat: (groupChatId: string) => void;
  createGroupChat: (projectId: string, name: string, memberIds?: string[], avatarDataUrl?: string) => Promise<string>;
  updateGroupChat: (groupChat: GroupChat) => void;
  setGroupMembers: (groupChatId: string, memberIds: string[]) => Promise<void>;
  setProjectMembers: (projectId: string, memberIds: string[]) => Promise<Project | undefined>;
  archiveGroupChat: (groupChatId: string) => void;
  restoreGroupChat: (groupChatId: string) => void;
  removeGroupChat: (groupChatId: string) => Promise<void>;
  toggleGroupMember: (groupChatId: string, partnerId: string) => void;
  prepareConversationWorkspace: (conversationId: string, decision: WorkspaceSwitchDecision) => Promise<boolean>;
  contextHandoffDraft?: ContextHandoff;
  setContextHandoffDraft: (draft?: ContextHandoff) => void;
  sendChatMessage: (conversationId: string, content: string, attachments?: MessageAttachment[], messageId?: string, workspaceDecision?: WorkspaceSwitchDecision, quote?: MessageQuote, contextHandoff?: ContextHandoff) => Promise<boolean>;
  sendChatGuidance: (conversationId: string, content: string, expectedRunId: RunId, quote?: MessageQuote, clientMessageId?: string) => Promise<'accepted' | 'deferred' | false>;
  addConversationArtifact: (conversationId: string, artifact: ConversationArtifact) => void;
  removeConversationArtifact: (conversationId: string, artifactId: string) => void;
  regenerateChatTurn: (conversationId: string, content?: string) => void;
  cancelChatRun: (conversationId: string) => void;
  resolveChatAuthorization: (conversationId: string, decision: 'allow_once' | 'deny', persistExtensionTrust?: boolean) => void;
  resolveChatUserInput: (conversationId: string, answers: Record<string, string[]>, customAnswers?: Record<string, string>, requestId?: string) => Promise<void>;
  updatePartnerWorkspaceGrants: (partnerId: string, grants: WorkspaceGrant[], preferredGrantId?: string) => void;
  rebindPartnerRoot: (partner: Extract<Partner, { sourceMode: 'local_cli' }>) => void;
  studioRooms: Record<string, StudioRoomSnapshot>;
  studioInteractions: Record<string, StudioInteraction>;
  sendStudioMessage: (groupChatId: string, content: string, mentions?: StudioMention[], attachmentSelectionIds?: string[], contextHandoff?: ContextHandoff) => Promise<boolean>;
  setStudioMuted: (groupChatId: string, partnerIds: string[]) => Promise<void>;
  setStudioSettings: (groupChatId: string, settings: StudioRoomSettings) => Promise<void>;
  resolveStudioDiscussion: (groupChatId: string, decision: 'continue' | 'end') => Promise<void>;
  cancelStudioRound: (groupChatId: string) => Promise<void>;
  resolveStudioAuthorization: (groupChatId: string, decision: 'allow_once' | 'deny', persistExtensionTrust?: boolean) => void;
  resolveStudioUserInput: (groupChatId: string, answers: Record<string, string[]>, customAnswers?: Record<string, string>, requestId?: string) => Promise<void>;
  addProjectMember: (projectId: string, partnerId: string) => void;
}

export interface StudioInteraction {
  partnerId: string;
  conversationId: string;
  clientMessageId: string;
  runId: string;
  sessionId: string;
  route: Extract<NonNullable<PartnerEvent['route']>, { scope: 'group' }>;
  pendingAuthorization?: Conversation['pendingAuthorization'];
  pendingUserInput?: Conversation['pendingUserInput'];
  timeline: TurnTimelineItem[];
}

export interface ConversationLifecycleOutcome {
  ok: boolean;
  message?: string;
}

const PrototypeContext = createContext<PrototypeContextValue | null>(null);

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function studioMessages(snapshot: StudioRoomSnapshot): Message[] {
  const messages: Message[] = snapshot.messages.map((message) => ({
    id: message.messageId,
    authorId: message.authorId,
    content: message.content,
    createdAt: new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    occurredAt: message.createdAt,
    status: 'delivered',
    runState: message.status === 'interrupted' ? 'cancelled' : 'completed',
    studioSeq: message.seq,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.automation ? { automation: message.automation } : {}),
    ...(message.mentions?.length ? { studioMentions: message.mentions } : {}),
  }));
  if (snapshot.streaming?.content) messages.push({
    id: `studio-stream:${snapshot.streaming.runId}`,
    authorId: snapshot.streaming.partnerId,
    runId: snapshot.streaming.runId,
    content: snapshot.streaming.content,
    createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    status: 'delivered',
    runState: 'running',
    isStreaming: true,
  });
  return messages;
}

function projectFileKind(name: string): ProjectFile['kind'] {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return 'image';
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.csv'].includes(extension)) return 'sheet';
  if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(extension)) return 'archive';
  return 'document';
}

function newConversation(partner: Partner, title?: string, sessionId?: string): Conversation {
  return {
    id: makeId('conversation'),
    partnerId: partner.id,
    title: title?.trim() || `和 ${partner.publicIdentity.displayName || '新伙伴'} 的新对话`,
    messages: [],
    updatedAt: new Date().toISOString(),
    permissionMode: partner.defaultPermissionMode ?? 'manual',
    planMode: 'default',
    ...(sessionId ? { sessionId } : {}),
    ...(partner.sourceMode === 'existing_thread' ? { isPrimaryThread: true } : {}),
    ...(partner.sourceMode === 'local_cli' ? {
      partnerRootKind: partner.partnerRootKind ?? 'private',
      ...(partner.partnerRoot ? { partnerRoot: partner.partnerRoot } : {}),
      ...(partner.partnerRootGrantId ? { partnerRootGrantId: partner.partnerRootGrantId } : {}),
    } : {}),
  };
}

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [chatMaintenanceRunning, setChatMaintenanceRunning] = useState<Record<string, boolean>>({});
  const [chatCommandResults, setChatCommandResults] = useState<PrototypeContextValue['chatCommandResults']>({});
  const [chatCompactions, setChatCompactions] = useState<PrototypeContextValue['chatCompactions']>({});
  const compactingRef = useRef(new Set<string>());
  const [state, dispatch] = useReducer(prototypeReducer, undefined, loadPrototypeState);
  const { appearanceError, appearance, updateAppearance, theme, setTheme, toggleTheme } = useAppearance();
  const [studioRooms, setStudioRooms] = useState<Record<string, StudioRoomSnapshot>>({});
  const [studioInteractions, setStudioInteractions] = useState<Record<string, StudioInteraction>>({});
  const [projectAuthority, setProjectAuthority] = useState({
    ready: !window.asteriumProjects?.initializeDomain,
    blockedProjectIds: [] as string[],
  });
  const [conversationAuthorityReady, setConversationAuthorityReady] = useState(!window.asteriumConversations?.listDeleted);
  const studioRoomsRef = useRef<Record<string, StudioRoomSnapshot>>({});
  const projectAuthorityGenerationRef = useRef(0);
  const startupProjectMigrationRef = useRef(state.projects.map((project) => ({
    id: project.id,
    name: project.name,
    avatarDataUrl: project.avatarDataUrl,
    description: project.description,
    status: project.status,
    progress: project.progress,
    tags: project.tags,
    memberIds: project.memberIds,
    tasks: project.tasks,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  })));
  const location = useLocation();
  const viewContextRef = useRef({ pathname: location.pathname, activeConversationId: state.activeConversationId, activeGroupChatId: state.activeGroupChatId });
  const profileSyncStartedRef = useRef(false);
  const singleChatMessageSyncRef = useRef('');

  useEffect(() => {
    const api = window.asteriumAutomations; if (!api) return;
    let live = true;
    const hydrate = () => { void api.get().then(snapshot => { if (live) dispatch({ type: 'automationHydrate', runs: snapshot.runs }); }).catch(() => undefined); };
    hydrate(); const offChanged = api.onChanged(hydrate);
    const offEvents = api.onEvent?.(payload => dispatch({ type: 'automationEvent', ...payload }));
    return () => { live = false; offChanged(); offEvents?.(); };
  }, []);

  useLayoutEffect(() => {
    viewContextRef.current = { pathname: location.pathname, activeConversationId: state.activeConversationId, activeGroupChatId: state.activeGroupChatId };
  }, [location.pathname, state.activeConversationId, state.activeGroupChatId]);

  useEffect(() => {
    if (projectAuthority.ready) savePrototypeState(state);
  }, [projectAuthority.ready, state]);

  useEffect(() => {
    const conversations = window.asteriumConversations;
    if (!conversationAuthorityReady || !conversations?.syncMessages) return;
    const snapshots = state.conversations.map((conversation) => ({
      conversationId: conversation.id,
      partnerId: conversation.partnerId,
      messages: conversation.messages
        .filter((message) => !message.isStreaming)
        .map((message) => ({
          messageId: message.id,
          automationRunId: message.automation?.runId,
          authorType: isAsteriumUser(message.authorId) ? 'user' as const : 'partner' as const,
          authorId: message.authorId,
          content: message.content,
          createdAt: message.createdAt,
          occurredAt: message.occurredAt,
          completedAt: message.completedAt,
          fallbackEligible: !message.error && (!message.runState || message.runState === 'completed') && (!message.status || message.status === 'delivered'),
        })),
      busy: Boolean(conversation.activeRun || conversation.awaitingFirstResponse),
      permissionMode: conversation.permissionMode ?? state.partners.find((partner) => partner.id === conversation.partnerId)?.defaultPermissionMode ?? 'manual',
      planMode: conversation.planMode ?? 'default',
      planStatus: conversation.planStatus,
      apiSessionHistoryEnabled: state.partners.find((partner) => partner.id === conversation.partnerId)?.sourceMode === 'api_partner' ? Boolean((state.partners.find((partner) => partner.id === conversation.partnerId) as ApiPartner).apiSessionHistoryEnabled) : undefined,
      isArchived: Boolean(conversation.isArchived),
      isDisabled: Boolean(conversation.isDisabled),
      title: conversation.title,
      partnerRootGrantId: conversation.partnerRootGrantId,
      ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
    }));
    const signature = JSON.stringify(snapshots);
    if (signature === singleChatMessageSyncRef.current) return;
    singleChatMessageSyncRef.current = signature;
    void conversations.syncMessages(snapshots).catch(() => { singleChatMessageSyncRef.current = ''; });
  }, [conversationAuthorityReady, state.conversations, state.partners]);

  useEffect(() => {
    const conversations = window.asteriumConversations;
    if (!conversations?.listDeleted) return;
    let cancelled = false;
    void conversations.listDeleted()
      .then((conversationIds) => {
        if (!cancelled && conversationIds.length) dispatch({ type: 'reconcileDeletedConversations', conversationIds });
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setConversationAuthorityReady(true); });
    return () => { cancelled = true; };
  }, []);


  useEffect(() => {
    return window.asteriumAgents?.onEvent((event) => {
      if ('route' in event && event.route?.scope === 'group') {
        const route = event.route;
        setStudioInteractions((current) => {
          const existing = current[route.roomId];
          const base: StudioInteraction = existing ?? {
            partnerId: event.partnerId,
            conversationId: event.conversationId,
            clientMessageId: event.clientMessageId,
            runId: event.runId,
            sessionId: event.sessionId,
            route,
            timeline: [],
          };
          if (event.type === 'authorization.requested') return { ...current, [route.roomId]: {
            ...base,
            pendingAuthorization: {
              authorizationId: event.authorizationId, toolCallId: event.toolCallId, action: event.action, risk: event.risk,
              summary: event.summary, targets: event.targets, resolution: event.resolution, purpose: event.purpose, extensionTrust: event.extensionTrust,
            },
            timeline: [...base.timeline, {
              id: event.eventId, sequence: event.sequence, kind: 'authorization', authorizationId: event.authorizationId,
              toolCallId: event.toolCallId, summary: event.summary, state: 'running',
              action: event.action, risk: event.risk, purpose: event.purpose,
            }],
          } };
          if (event.type === 'user_input.requested') return { ...current, [route.roomId]: {
            ...base,
            pendingUserInput: { requestId: event.requestId, questions: event.questions },
            timeline: [...base.timeline, { id: event.eventId, sequence: event.sequence, kind: 'user_input', requestId: event.requestId, questions: event.questions, state: 'running' }],
          } };
          if (event.type === 'authorization.resolved') return { ...current, [route.roomId]: {
            ...base,
            pendingAuthorization: undefined,
            timeline: base.timeline.map((item) => item.kind === 'authorization' && item.authorizationId === event.authorizationId
              ? { ...item, summary: event.extensionTrustGranted ? '已允许并持续信任此扩展' : event.decision === 'allow_once' ? '已允许本次操作' : '已拒绝本次操作', decision: event.decision, extensionTrustGranted: event.extensionTrustGranted, state: event.decision === 'allow_once' ? 'success' : 'failure' }
              : item),
          } };
          if (event.type === 'user_input.resolved') return { ...current, [route.roomId]: { ...base, pendingUserInput: undefined, timeline: [] } };
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
            const next = { ...current };
            delete next[route.roomId];
            return next;
          }
          return { ...current, [route.roomId]: base };
        });
        return;
      }
      dispatch({
      type: 'agentEvent',
      event,
      unreadOnCompletion: event.type === 'run.completed' && (
        viewContextRef.current.pathname !== '/chat'
        || viewContextRef.current.activeConversationId !== event.conversationId
        || document.visibilityState !== 'visible'
        || !document.hasFocus()
      ),
      });
    });
  }, []);

  useEffect(() => window.asteriumStudio?.onRoomChanged((snapshot) => {
    const previous = studioRoomsRef.current[snapshot.metadata.roomId];
    const previousIds = new Set(previous?.messages.map((message) => message.messageId) ?? []);
    // The first snapshot after startup is hydration, not a newly completed
    // reply. Only compare completions after this room has a renderer baseline.
    const completed = previous
      ? [...snapshot.messages].reverse().find((message) => message.authorType === 'partner' && message.status === 'completed' && !message.automation && !previousIds.has(message.messageId))
      : undefined;
    const hidden = viewContextRef.current.pathname !== '/studio/discussion'
      || viewContextRef.current.activeGroupChatId !== snapshot.metadata.roomId
      || document.visibilityState !== 'visible'
      || !document.hasFocus();
    studioRoomsRef.current = { ...studioRoomsRef.current, [snapshot.metadata.roomId]: snapshot };
    setStudioRooms(studioRoomsRef.current);
    dispatch({ type: 'hydrateStudioMessages', groupChatId: snapshot.metadata.roomId, messages: studioMessages(snapshot), ...(completed && hidden ? { unreadCompletedAt: completed.createdAt } : {}) });
  }), []);

  useEffect(() => {
    const projects = window.asteriumProjects;
    if (!projects?.initializeDomain) return;
    const generation = ++projectAuthorityGenerationRef.current;
    const hydrate = async () => {
      const snapshot = await projects.initializeDomain({ legacyProjects: startupProjectMigrationRef.current });
      if (projectAuthorityGenerationRef.current !== generation) return;
      dispatch({ type: 'hydrateProjectDomain', snapshot });
      const workspaces = await Promise.all(snapshot.projects.map(async (project) => ({ project, workspace: await projects.get(project.id).catch(() => null) })));
      if (projectAuthorityGenerationRef.current !== generation) return;
      for (const { project, workspace } of workspaces) {
        dispatch({
          type: 'updateProjectWorkspace',
          projectId: project.id,
          workspace: workspace ? {
            status: 'ready', rootPath: workspace.rootPath, deliverablesPath: workspace.deliverablesPath, initializedAt: workspace.createdAt,
          } : { status: 'unavailable' },
          files: workspace?.templateFiles.map((file) => ({
            id: `${project.id}:template:${file.relativePath}`,
            name: file.name,
            meta: file.label,
            kind: 'document' as const,
            relativePath: file.relativePath,
            savedAt: workspace.createdAt,
          })) ?? [],
        });
      }
      setProjectAuthority({ ready: true, blockedProjectIds: [] });
    };
    void hydrate().catch(() => setProjectAuthority({ ready: false, blockedProjectIds: startupProjectMigrationRef.current.map((project) => project.id) }));
    return () => {
      if (projectAuthorityGenerationRef.current === generation) projectAuthorityGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => window.asteriumProjects?.onDomainChanged?.((change) => {
    if (change.type === 'snapshot') dispatch({ type: 'hydrateProjectDomain', snapshot: change.snapshot });
    // The initiating delete request archives its rooms only after Main has
    // committed the full project transaction. A transient domain removal may
    // still be rolled back by a later deletion stage.
  }), []);

  const blockedProjectIds = new Set(projectAuthority.blockedProjectIds);

  const studioMetadata = JSON.stringify(state.groupChats.filter((groupChat) => !groupChat.projectDeletedAt && !blockedProjectIds.has(groupChat.projectId)).map((groupChat) => ({
    roomId: groupChat.id,
    projectId: groupChat.projectId,
    name: groupChat.name,
    memberIds: groupChat.memberIds,
    archived: Boolean(groupChat.archivedAt),
  })));

  useEffect(() => {
    const studio = window.asteriumStudio;
    if (!studio || !projectAuthority.ready) return;
    let cancelled = false;
    const rooms = JSON.parse(studioMetadata) as Array<{ roomId: string; projectId: string; name: string; memberIds: string[]; archived: boolean }>;
    for (const room of rooms) void studio.syncRoom(room).then((snapshot) => {
      if (cancelled) return;
      studioRoomsRef.current = { ...studioRoomsRef.current, [room.roomId]: snapshot };
      setStudioRooms(studioRoomsRef.current);
      dispatch({ type: 'hydrateStudioMessages', groupChatId: room.roomId, messages: studioMessages(snapshot) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectAuthority.ready, studioMetadata]);

  const singleBindings = JSON.stringify(state.conversations.flatMap((conversation) => {
    const partner = state.partners.find((item) => item.id === conversation.partnerId);
    if (!conversation.sessionId || !partner || partner.sourceMode === 'existing_thread') return [];
    return [{ partnerId: partner.id, source: partner.sourceMode, conversationId: conversation.id, nativeThreadId: conversation.sessionId }];
  }));

  useEffect(() => {
    const api = window.asteriumNativeBindings;
    if (!api || !conversationAuthorityReady) return;
    const bindings = JSON.parse(singleBindings) as Array<{ partnerId: string; source: 'local_cli' | 'api_partner'; conversationId: string; nativeThreadId: string }>;
    if (bindings.length) void api.syncSingle(bindings).catch(() => undefined);
  }, [conversationAuthorityReady, singleBindings]);

  useEffect(() => window.asteriumAgents?.onPartnerWorkspaceChanged?.((workspace) => {
    dispatch({ type: 'syncPartnerWorkspaceState', workspace });
  }), []);

  useEffect(() => window.asteriumAgents?.onPartnerProfilesChanged?.((profiles) => {
    dispatch({ type: 'hydratePartnerProfiles', profiles });
  }), []);

  useEffect(() => {
    const agents = window.asteriumAgents;
    if (!agents?.getPartnerWorkspace) return;
    let cancelled = false;
    const partners = state.partners.filter((partner): partner is LocalCliPartner | ApiPartner => !partner.isRemoved && !partner.isPrototype && (partner.sourceMode === 'local_cli' || partner.sourceMode === 'api_partner'));
    for (const partner of partners) void agents.getPartnerWorkspace(partner.id).then(async (workspace) => {
      if (workspace.version === 0 && agents.syncPartnerWorkspace) {
        const seeded = await agents.syncPartnerWorkspace(
          partner.id,
          partner.sourceMode === 'local_cli' ? partner.partnerRootGrantId : partner.primaryWorkspaceGrantId,
          partner.workspaceGrantIds ?? [],
        );
        if (seeded) workspace = seeded;
      }
      if (!cancelled && workspace.version > 0) dispatch({ type: 'syncPartnerWorkspaceState', workspace });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [state.partners]);

  const projectWorkspaceMemberships = JSON.stringify(state.projects.filter((project) => !blockedProjectIds.has(project.id)).map((project) => ({
    projectId: project.id,
    ready: project.workspace?.status === 'ready',
    partnerIds: project.memberIds.filter((partnerId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      return Boolean(partner && !partner.isRemoved && !partner.isPrototype && (partner.sourceMode === 'local_cli' || partner.sourceMode === 'api_partner'));
    }),
    partnerWorkspaceVersions: project.memberIds.map((partnerId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      return [partnerId, partner?.workspaceVersion ?? 0] as const;
    }),
  })));
  const projectWorkspaceMembershipsRef = useRef(projectWorkspaceMemberships);
  useLayoutEffect(() => {
    projectWorkspaceMembershipsRef.current = projectWorkspaceMemberships;
  }, [projectWorkspaceMemberships]);
  const projectWorkspaceSyncTrigger = JSON.stringify({
    projects: state.projects.map((project) => ({ projectId: project.id, ready: project.workspace?.status === 'ready' })),
    partners: state.partners.map((partner) => ({ partnerId: partner.id, version: partner.workspaceVersion ?? 0, removed: Boolean(partner.isRemoved) })),
  });

  useEffect(() => {
    if (!projectAuthority.ready) return;
    const projects = JSON.parse(projectWorkspaceMembershipsRef.current) as Array<{ projectId: string; ready: boolean; partnerIds: string[]; partnerWorkspaceVersions: Array<[string, number]> }>;
    void window.asteriumProjects?.syncMembers(projects.filter((project) => project.ready).map(({ projectId, partnerIds }) => ({ projectId, partnerIds }))).catch(() => undefined);
  }, [projectAuthority.ready, projectWorkspaceSyncTrigger]);

  const projectFileSyncPayload = JSON.stringify(state.projects.flatMap((project) => project.workspace?.status === 'ready' && !blockedProjectIds.has(project.id)
    ? [{ projectId: project.id }]
    : []));

  useEffect(() => {
    const projects = window.asteriumProjects;
    if (!projects?.listFiles || !projectAuthority.ready) return;
    const targets = JSON.parse(projectFileSyncPayload) as Array<{ projectId: string }>;
    let cancelled = false;
    const synchronize = async () => {
      for (const target of targets) {
        try {
          const files = await projects.listFiles(target.projectId);
          if (!cancelled) dispatch({ type: 'syncProjectFiles', projectId: target.projectId, files });
        } catch {
          // A missing workspace is reported by its existing workspace state; file metadata stays untouched.
        }
      }
    };
    void synchronize();
    const onFocus = () => { void synchronize(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [projectAuthority.ready, projectFileSyncPayload]);

  useEffect(() => window.asteriumProjects?.onFilesChanged?.((snapshot) => {
    dispatch({ type: 'syncProjectFiles', projectId: snapshot.projectId, files: snapshot.files });
  }), []);

  useEffect(() => {
    const sync = window.asteriumAgents?.syncPartnerProfiles;
    if (!sync || profileSyncStartedRef.current) return;
    profileSyncStartedRef.current = true;
    const partners = state.partners.filter((partner) => !partner.isRemoved && !partner.managedDataDeletedAt).map(partnerProfileSeed);
    void sync({ displayName: state.userProfile.displayName, introduction: state.userProfile.introduction, updatedAt: state.userProfile.updatedAt }, partners)
      .then((profiles) => dispatch({ type: 'hydratePartnerProfiles', profiles }))
      .catch(() => { profileSyncStartedRef.current = false; });
  }, [state.partners, state.userProfile]);

  const nativeLifecycleSyncPayload = JSON.stringify(buildNativeLifecycleSyncGroups(state.partners, state.conversations));

  useEffect(() => {
    const agents = window.asteriumAgents;
    if (!agents?.getLocalThreadLifecycles || !conversationAuthorityReady) return;
    const groups = JSON.parse(nativeLifecycleSyncPayload) as NativeLifecycleSyncGroup[];
    let cancelled = false;
    let synchronization: Promise<void> | undefined;
    let lastSynchronizationStartedAt = 0;
    const performSynchronization = async () => {
      for (const group of groups) {
        try {
          const results = await agents.getLocalThreadLifecycles!(group.request);
          if (cancelled) return;
          for (const result of results) {
            for (const conversation of group.conversations.filter((item) => item.threadId === result.threadId)) {
              // A newly bound Codex thread can stream successfully before thread/list indexes it.
              // Keep the direct session.bound evidence instead of surfacing that brief uncertainty.
              if (result.state === 'unavailable' && conversation.nativeThreadState === 'active') continue;
              const state = result.state === 'unavailable'
                && result.reason !== 'runtime_unavailable'
                && conversation.nativeThreadState === 'archived'
                ? 'deleted'
                : result.state;
              if (state === 'deleted') {
                if (window.asteriumConversations) {
                  await window.asteriumConversations.delete({
                    conversationId: conversation.conversationId,
                    partnerId: group.request.partnerId,
                    source: 'local_cli',
                  });
                } else {
                  await window.asteriumAttachments?.deleteConversation(conversation.conversationId);
                }
              }
              dispatch({
                type: 'syncNativeThreadLifecycle',
                conversationId: conversation.conversationId,
                state,
                checkedAt: result.checkedAt,
                message: state === 'deleted' ? '原生 Codex 线程已删除，星丛已清理对应记录。' : result.message,
              });
            }
          }
        } catch (error) {
          if (cancelled) return;
          const detail = error instanceof Error ? error.message : String(error);
          const message = detail.includes('CODEX_NOT_LOGGED_IN')
            ? '当前选择的 Codex 运行时已退出登录，请在伙伴管理中重新检测。'
            : detail.includes('CODEX_RUNTIME_SELECTION_REQUIRED')
              ? '找不到上次选择的 Codex 运行时；星丛没有切换到其他来源。请在伙伴管理中重新选择。'
              : '暂时无法同步原生 Codex 线程状态；星丛没有改动本地记录。';
          for (const conversation of group.conversations) dispatch({
            type: 'syncNativeThreadLifecycle',
            conversationId: conversation.conversationId,
            state: 'unavailable',
            checkedAt: new Date().toISOString(),
            message,
          });
        }
      }
    };
    const synchronize = () => {
      if (synchronization) return synchronization;
      if (Date.now() - lastSynchronizationStartedAt < 1_000) return Promise.resolve();
      lastSynchronizationStartedAt = Date.now();
      synchronization = performSynchronization().finally(() => { synchronization = undefined; });
      return synchronization;
    };
    void synchronize();
    const onFocus = () => { void synchronize(); };
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [conversationAuthorityReady, nativeLifecycleSyncPayload]);

  const existingThreadWatchSignature = JSON.stringify(
    state.partners
      .filter((partner): partner is ExistingThreadPartner => partner.sourceMode === 'existing_thread' && !partner.isRemoved && partner.configured && Boolean(partner.credentialRef))
      .map((partner) => ({
        partnerId: partner.id,
        connection: {
          serviceUrl: partner.serviceUrl,
          threadId: partner.threadId,
          ...(partner.workspaceRoot ? { workspaceRoot: partner.workspaceRoot } : {}),
          credentialRef: partner.credentialRef!,
        },
      })),
  );

  useEffect(() => {
    const agents = window.asteriumAgents;
    if (!agents?.watchExistingThread) return;
    const watches = JSON.parse(existingThreadWatchSignature) as Array<{
      partnerId: string;
      connection: { serviceUrl: string; threadId: string; workspaceRoot?: string; credentialRef: string };
    }>;
    for (const watch of watches) {
      void agents.watchExistingThread(watch.partnerId, watch.connection).catch(() => undefined);
    }
    return () => {
      for (const watch of watches) void agents.stopExistingThreadWatch?.(watch.partnerId).catch(() => undefined);
    };
  }, [existingThreadWatchSignature]);

  const changeConversationLifecycle = useCallback(async (conversationId: string, action: 'archive' | 'restore' | 'delete'): Promise<ConversationLifecycleOutcome> => {
    if (compactingRef.current.has(conversationId)) return { ok: false, message: '正在压缩上下文，请等待完成。' };
    const conversation = state.conversations.find((item) => item.id === conversationId);
    const partner = state.partners.find((item) => item.id === conversation?.partnerId);
    if (!conversation || !partner) return { ok: false, message: '没有找到这段对话。' };
    if (conversation.activeRun) return { ok: false, message: '伙伴仍在回复，请先停止当前任务。' };
    if (conversation.isPrimaryThread && !partner.isRemoved) return { ok: false, message: '伙伴主线程不能在这里归档或删除。' };
    if (action === 'delete' && !conversation.isArchived) return { ok: false, message: '请先归档，再永久删除。' };

    if (action === 'archive') dispatch({ type: 'archiveConversation', conversationId, archivedAt: new Date().toISOString() });
    if (action === 'restore') {
      if (partner.sourceMode === 'local_cli' && partner.adapterType === 'codex_cli' && conversation.nativeThreadState === 'archived') {
        return { ok: false, message: '这条原生 Codex 线程仍处于归档状态，请先在 Codex 中恢复；星丛会自动同步。' };
      }
      dispatch({ type: 'restoreConversation', conversationId });
    }
    if (action === 'delete') {
      if (window.asteriumConversations) {
        await window.asteriumConversations.delete({ conversationId, partnerId: partner.id, source: partner.sourceMode });
      } else {
        if (partner.sourceMode === 'api_partner') await window.asteriumAgents?.deleteApiSession?.(partner.id, conversation.id);
        await window.asteriumAttachments?.deleteConversation(conversationId);
      }
      dispatch({ type: 'deleteConversationPermanently', conversationId });
    }
    return { ok: true };
  }, [state]);

  const refreshProfiles = useCallback(async () => {
    const profiles = await window.asteriumAgents?.refreshPartnerProfiles?.();
    if (profiles) dispatch({ type: 'hydratePartnerProfiles', profiles });
    return profiles;
  }, []);
  useEffect(() => {
    const refresh = () => { void refreshProfiles().catch(() => undefined); };
    if (location.pathname === '/profile' || location.pathname.startsWith('/settings')) refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [location.pathname, refreshProfiles]);

  const dismissChatCommandResult = useCallback<PrototypeContextValue['dismissChatCommandResult']>((conversationId, result) => setChatCommandResults((current) => {
    if (current[conversationId] !== result || result.state === 'running') return current;
    const next = { ...current }; delete next[conversationId]; return next;
  }), []);
  const dismissChatCompaction = useCallback<PrototypeContextValue['dismissChatCompaction']>((conversationId, result) => setChatCompactions((current) => {
    if (current[conversationId] !== result || result.state === 'running') return current;
    const next = { ...current }; delete next[conversationId]; return next;
  }), []);

  const [projectConfirmation, setProjectConfirmation] = useState<{ name: string; path: string }>();
  const projectConfirmationResolver = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const projectConfirmationCancel = useRef<HTMLButtonElement>(null);
  const finishProjectConfirmation = (confirmed: boolean) => {
    const resolve = projectConfirmationResolver.current;
    projectConfirmationResolver.current = undefined;
    setProjectConfirmation(undefined);
    resolve?.(confirmed);
  };
  const confirmProjectLocation = useCallback((name: string, path: string) => {
    if (projectConfirmationResolver.current) throw new Error('PROJECT_CREATE_CONFIRMATION_BUSY');
    return new Promise<boolean>(resolve => {
      projectConfirmationResolver.current = resolve;
      setProjectConfirmation({ name, path });
    });
  }, []);

  const [contextHandoffDraft, setContextHandoffDraft] = useState<ContextHandoff>();
  useEffect(() => window.asteriumContextHandoff?.onDelivered(id => {
    setContextHandoffDraft(current => current?.id === id ? undefined : current);
  }), []);

  const value = useMemo<PrototypeContextValue>(() => ({
    state,
    refreshProfiles,
    chatCommandResults,
    dismissChatCommandResult,
    chatMaintenanceRunning,
    executeChatCommand: async (conversationId, command) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      if (!conversation || !partner || !window.asteriumAgents?.executeSessionCommand) return;
      if (command !== 'status' && (compactingRef.current.has(conversationId) || conversation.activeRun || conversation.awaitingFirstResponse || conversation.pendingAuthorization || conversation.pendingUserInput || conversationWorkspaceMismatch(partner, conversation))) {
        setChatCommandResults((current) => ({ ...current, [conversationId]: { state: 'error', message: '请先处理当前任务、提问或工作区变更。' } })); return;
      }
      if (command !== 'status') { compactingRef.current.add(conversationId); setChatMaintenanceRunning((current) => ({ ...current, [conversationId]: true })); }
      setChatCommandResults((current) => ({ ...current, [conversationId]: { state: 'running', message: command === 'status' ? '正在查询会话状态…' : command === 'compact' ? '正在压缩当前对话上下文…' : '正在重读选定资料并等待伙伴确认…' } }));
      try {
        const result = await window.asteriumAgents.executeSessionCommand({ commandId: makeId('session-command'), command, partnerId: partner.id, conversationId, source: partner.sourceMode, ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}) });
        setChatCommandResults((current) => ({ ...current, [conversationId]: { state: result.status, message: result.message, session: result.session } }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : '';
        setChatCommandResults((current) => ({ ...current, [conversationId]: { state: 'error', message: detail.includes('PROFILE_RELOAD_RECOVERY_REQUIRED') ? '资料重读未能恢复，普通续聊已暂停。请恢复连接后重试资料重读，或新建对话。' : detail.includes('MISMATCH') ? '会话绑定已变化，请刷新后重试。' : detail.includes('BUSY') ? '当前对话仍有任务在运行。' : '指令未完成：' + (detail || '请检查连接后重试') } }));
      } finally { if (command !== 'status') { compactingRef.current.delete(conversationId); setChatMaintenanceRunning((current) => ({ ...current, [conversationId]: false })); } }
    },
    chatCompactions,
    dismissChatCompaction,
    compactChatContext: async (conversationId) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      if (compactingRef.current.has(conversationId)) return;
      if (!conversation?.sessionId || conversation.activeRun || conversation.awaitingFirstResponse || conversation.isDisabled || conversation.isArchived || !partner || partner.isRemoved || partner.isPrototype || partner.sourceMode === 'existing_thread' || conversationWorkspaceMismatch(partner, conversation) || !window.asteriumAgents?.compactSession) return;
      if (conversation.nativeThreadState === 'deleted' || conversation.nativeThreadState === 'unavailable'
        || (partner.sourceMode === 'api_partner' && (!partner.configured || !partner.apiSessionHistoryEnabled))
        || (partner.sourceMode === 'local_cli' && partner.connectionKind !== 'local_claude' && partner.connectionKind !== 'local_codex')) return;
      compactingRef.current.add(conversationId);
      setChatCompactions((current) => ({ ...current, [conversationId]: { state: 'running', message: '正在压缩当前对话上下文…' } }));
      try {
        const result = await window.asteriumAgents.compactSession({ commandId: makeId('compact'), partnerId: partner.id, conversationId, sessionId: conversation.sessionId, source: partner.sourceMode });
        setChatCompactions((current) => ({ ...current, [conversationId]: { state: result.status === 'compacted' ? 'success' : 'info', message: result.message } }));
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const message = code.includes('BUSY') ? '当前对话仍有任务在运行，请稍后重试。' : code.includes('CONTEXT_TOO_LARGE') ? '上下文超过本次压缩的处理上限，原上下文已保留。' : code.includes('MISMATCH') || code.includes('UNAVAILABLE') ? '当前会话暂不支持压缩，请确认连接和线程状态。' : '本次压缩未确认完成，请检查连接后重试；聊天记录仍保留。';
        setChatCompactions((current) => ({ ...current, [conversationId]: { state: 'error', message } }));
      } finally { compactingRef.current.delete(conversationId); }
    },
    studioRooms,
    studioInteractions,
    theme,
    appearanceError, appearance, updateAppearance, setTheme, toggleTheme,
    selectPartner: (partnerId) => dispatch({ type: 'selectPartner', partnerId }),
    selectConversation: (conversationId) => dispatch({ type: 'selectConversation', conversationId }),
    selectProject: (projectId) => dispatch({ type: 'selectProject', projectId }),
    addPartner: (partner, alreadySaved = false) => {
      if (!alreadySaved && !partner.isPrototype) void window.asteriumAgents?.savePartnerProfile?.(partnerProfileSeed(partner)).catch(() => undefined);
      dispatch({ type: 'addPartner', partner });
      if (partner.sourceMode === 'existing_thread') {
        dispatch({ type: 'createConversation', conversation: newConversation(partner, `和 ${partner.publicIdentity.displayName} 的主对话`, partner.threadId) });
      }
    },
    updatePartner: async (partner, alreadySaved = false) => {
      const previous = state.partners.find((item) => item.id === partner.id);
      if (!alreadySaved && !partner.isPrototype) {
        const save = window.asteriumAgents?.savePartnerProfile;
        if (!save) throw new Error('PARTNER_PROFILE_SAVE_UNAVAILABLE');
        const saved = await save(partnerProfileSeed(partner));
        partner = { ...partner, profileRevision: saved.revision };
      }
      dispatch({ type: 'updatePartner', partner, ...(!alreadySaved ? { previous } : {}) });
    },
    updateUserProfile: async (profile) => {
      const saved = await window.asteriumAgents?.saveUserProfile?.({ displayName: profile.displayName, introduction: profile.introduction, updatedAt: profile.updatedAt, revision: profile.revision });
      const next: UserProfile = { ...profile, ...saved, audience: 'all' };
      dispatch({ type: 'updateUserProfile', profile: next }); return next;
    },
    removePartner: (partnerId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (partner && !partner.isPrototype) {
        const removed = { ...partner, isRemoved: true } as Partner;
        void window.asteriumAgents?.savePartnerProfile?.(partnerProfileSeed(removed)).catch(() => undefined);
      }
      dispatch({ type: 'removePartner', partnerId, removedAt: new Date().toISOString() });
    },
    trashRemovedPartnerData: async (partnerId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (!partner?.isRemoved || partner.managedDataDeletedAt) return false;
      if (!partner.isPrototype) {
        const trashed = await window.asteriumAgents?.trashPartnerProfile?.(partnerId);
        if (!trashed) return false;
      }
      dispatch({ type: 'markPartnerDataDeleted', partnerId, deletedAt: new Date().toISOString() });
      return true;
    },
    createConversation: (partnerId, title, sessionId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (!partner || partner.isRemoved) return '';
      if (partner.sourceMode === 'existing_thread' && state.conversations.some((conversation) => conversation.partnerId === partnerId)) return '';
      const conversation = newConversation(partner, title, sessionId);
      dispatch({ type: 'createConversation', conversation });
      return conversation.id;
    },
    renameConversation: (conversationId, title) => dispatch({ type: 'renameConversation', conversationId, title }),
    archiveConversation: (conversationId) => changeConversationLifecycle(conversationId, 'archive'),
    archivePartnerConversations: (partnerId) => dispatch({ type: 'archivePartnerConversations', partnerId, archivedAt: new Date().toISOString() }),
    restoreConversation: (conversationId) => changeConversationLifecycle(conversationId, 'restore'),
    deleteConversationPermanently: (conversationId) => changeConversationLifecycle(conversationId, 'delete'),
    ensureConversation: (partnerId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (!partner || partner.isRemoved) return '';
      const existing = state.conversations.find((conversation) => conversation.partnerId === partnerId && !conversation.isArchived);
      if (existing) {
        dispatch({ type: 'selectConversation', conversationId: existing.id });
        return existing.id;
      }
      const archived = partner.sourceMode === 'existing_thread'
        ? state.conversations.find((conversation) => conversation.partnerId === partnerId && conversation.isArchived)
        : undefined;
      if (archived) {
        dispatch({ type: 'restoreConversation', conversationId: archived.id });
        dispatch({ type: 'selectConversation', conversationId: archived.id });
        return archived.id;
      }
      const conversation = newConversation(partner, undefined, partner.sourceMode === 'existing_thread' ? partner.threadId : undefined);
      dispatch({ type: 'createConversation', conversation });
      return conversation.id;
    },
    toggleConversationPin: (conversationId) => dispatch({ type: 'toggleConversationPin', conversationId }),
    setConversationPermissionMode: (conversationId, mode) => dispatch({ type: 'setConversationPermissionMode', conversationId, mode }),
    setConversationPlanMode: (conversationId, mode) => dispatch({ type: 'setConversationPlanMode', conversationId, mode }),
    setConversationCodexModel: (conversationId, selection) => dispatch({ type: 'setConversationCodexModel', conversationId, selection }),
    prepareConversationWorkspace: async (conversationId, decision) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      if (!conversation || !partner || partner.sourceMode !== 'local_cli' || !conversationWorkspaceMismatch(partner, conversation)) return Boolean(conversation && partner);
      if (decision === 'new_session_in_current_cwd') {
        dispatch({ type: 'switchConversationWorkspace', conversationId, conversation: conversationForCurrentWorkspace(partner, conversation) });
        return true;
      }
      if (!conversation.partnerRoot || !conversation.partnerRootGrantId || !window.asteriumAgents?.syncPartnerWorkspace) return false;
      try {
        await window.asteriumAgents.syncPartnerWorkspace(partner.id, conversation.partnerRootGrantId, partner.workspaceGrantIds ?? []);
      } catch {
        return false;
      }
      dispatch({ type: 'updatePartner', partner: {
        ...partner,
        partnerRootKind: conversation.partnerRootKind ?? 'imported',
        partnerRoot: conversation.partnerRoot,
        partnerRootGrantId: conversation.partnerRootGrantId,
      } });
      return true;
    },
    createProject: async (name, options) => {
      const projectId = makeId('project');
      const projectName = name.trim();
      const description = options?.description?.trim() || '项目刚刚建立，目标、范围与人员安排可在项目方案中继续补充。';
      const projects = window.asteriumProjects;
      const request = {
        projectId,
        name: projectName,
        description,
        tags: ['新项目'],
        memberIds: [],
        ...(options?.locationSelectionId ? { locationSelectionId: options.locationSelectionId } : {}),
      };
      let created: Awaited<ReturnType<NonNullable<typeof projects>['create']>> | undefined;
      if (projects) {
        if (!projects.previewCreateLocation) throw new Error('PROJECT_CREATE_PREVIEW_UNAVAILABLE');
        const confirmedRoot = await projects.previewCreateLocation(request);
        if (!await confirmProjectLocation(projectName, confirmedRoot)) throw new Error('PROJECT_CREATE_CANCELLED');
        created = await projects.create({ ...request, confirmedRoot });
      }
      const now = new Date().toISOString();
      const workspace = created?.workspace;
      const project: Project = {
        version: 1,
        id: projectId,
        name: created?.project.name ?? projectName,
        description: created?.project.description ?? description,
        status: created?.project.status ?? 'active',
        progress: created?.project.progress ?? 0,
        tags: created?.project.tags ?? ['新项目'],
        memberIds: created?.project.memberIds ?? [],
        revision: created?.project.revision ?? 1,
        createdAt: created?.project.createdAt ?? now,
        updatedAt: created?.project.updatedAt ?? now,
        files: workspace?.templateFiles.map((file) => ({
          id: `${projectId}:template:${file.relativePath}`,
          name: file.name,
          meta: file.label,
          kind: 'document' as const,
          relativePath: file.relativePath,
          savedAt: workspace.createdAt,
        })) ?? [],
        tasks: [],
        workspace: workspace ? {
          status: 'ready',
          rootPath: workspace.rootPath,
          deliverablesPath: workspace.deliverablesPath,
          initializedAt: workspace.createdAt,
        } : { status: 'unavailable' },
      };
      dispatch({ type: 'createProject', project });
      return project.id;
    },
    updateProject: async (project) => {
      const updated = window.asteriumProjects?.update ? await window.asteriumProjects.update({
        projectId: project.id,
        expectedRevision: project.revision,
        name: project.name,
        description: project.description,
        ...(project.avatarDataUrl ? { avatarDataUrl: project.avatarDataUrl } : {}),
        status: project.status,
        progress: project.progress,
        tags: project.tags,
      }) : { ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() };
      dispatch({ type: 'updateProject', project: { ...project, ...updated } });
    },
    createProjectTask: async (request) => {
      if (!window.asteriumProjects?.createTask) throw new Error('PROJECT_TASKS_UNAVAILABLE');
      const task = await window.asteriumProjects.createTask(request);
      dispatch({ type: 'upsertProjectTask', task });
      return task;
    },
    updateProjectTask: async (request) => {
      if (!window.asteriumProjects?.updateTask) throw new Error('PROJECT_TASKS_UNAVAILABLE');
      dispatch({ type: 'upsertProjectTask', task: await window.asteriumProjects.updateTask(request) });
    },
    removeProjectTask: async (projectId, taskId, expectedRevision) => {
      if (!window.asteriumProjects?.removeTask) throw new Error('PROJECT_TASKS_UNAVAILABLE');
      await window.asteriumProjects.removeTask({ projectId, taskId, expectedRevision });
      dispatch({ type: 'removeProjectTask', projectId, taskId });
    },
    removeProject: async (projectId) => {
      const projectGroups = state.groupChats.filter((group) => group.projectId === projectId);
      const hasActiveRound = projectGroups.some((group) => studioRoomsRef.current[group.id]?.activeRound
        && !['completed', 'failed', 'cancelled'].includes(studioRoomsRef.current[group.id].activeRound!.state));
      if (hasActiveRound) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
      if (window.asteriumProjects) await window.asteriumProjects.remove(projectId, projectGroups.map((group) => group.id));
      dispatch({ type: 'removeProject', projectId, archivedAt: new Date().toISOString() });
    },
    initializeProjectWorkspace: async (projectId, locationSelectionId) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project || !window.asteriumProjects) throw new Error('PROJECT_WORKSPACE_UNAVAILABLE');
      const workspace = await window.asteriumProjects.createWorkspace({
        projectId,
        name: project.name,
        description: project.description,
        ...(locationSelectionId ? { locationSelectionId } : {}),
      });
      if (window.asteriumProjects.changeMembers) {
        await window.asteriumProjects.changeMembers({
          projectId,
          projectMemberIds: project.memberIds,
          rooms: state.groupChats.filter((group) => group.projectId === projectId).map((group) => ({
            room: { roomId: group.id, projectId, name: group.name, memberIds: group.memberIds },
          })),
        });
      }
      dispatch({
        type: 'updateProjectWorkspace',
        projectId,
        workspace: {
          status: 'ready',
          rootPath: workspace.rootPath,
          deliverablesPath: workspace.deliverablesPath,
          initializedAt: workspace.createdAt,
        },
        files: [],
      });
      const indexedFiles = await window.asteriumProjects.listFiles(projectId);
      dispatch({ type: 'syncProjectFiles', projectId, files: indexedFiles });
    },
    addProjectFile: (projectId, file) => dispatch({ type: 'addProjectFile', projectId, file }),
    selectGroupChat: (groupChatId) => dispatch({ type: 'selectGroupChat', groupChatId }),
    createGroupChat: async (projectId, name, memberIds, avatarDataUrl) => {
      const groupChat: GroupChat = {
        id: makeId('group'),
        projectId,
        name: name.trim(),
        ...(avatarDataUrl ? { avatarDataUrl } : {}),
        memberIds: memberIds ?? state.projects.find((project) => project.id === projectId)?.memberIds.filter((id) => !state.partners.find((partner) => partner.id === id)?.isRemoved) ?? [],
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const project = state.projects.find((item) => item.id === projectId);
      const projectMemberIds = [...new Set([...(project?.memberIds ?? []), ...groupChat.memberIds])];
      if (window.asteriumProjects?.changeMembers) {
        await window.asteriumProjects.changeMembers({
          projectId,
          projectMemberIds,
          rooms: [...state.groupChats.filter((group) => group.projectId === projectId).map((group) => ({ room: {
            roomId: group.id, projectId, name: group.name, memberIds: group.memberIds,
          } })), { room: { roomId: groupChat.id, projectId, name: groupChat.name, memberIds: groupChat.memberIds } }],
        });
      }
      dispatch({ type: 'createGroupChat', groupChat });
      return groupChat.id;
    },
    updateGroupChat: (groupChat) => dispatch({ type: 'updateGroupChat', groupChat }),
    setGroupMembers: async (groupChatId, memberIds) => {
      const group = state.groupChats.find((item) => item.id === groupChatId);
      if (!group) return;
      const nextIds = [...new Set(memberIds)];
      const added = nextIds.filter((id) => !group.memberIds.includes(id));
      const removed = group.memberIds.filter((id) => !nextIds.includes(id));
      const project = state.projects.find((item) => item.id === group.projectId);
      const projectMemberIds = [...new Set([...(project?.memberIds ?? []), ...nextIds])];
      const announcements = [
        ...added.map((partnerId) => `${state.partners.find((item) => item.id === partnerId)?.publicIdentity.displayName ?? '一位伙伴'}加入了群聊`),
        ...removed.map((partnerId) => `${state.partners.find((item) => item.id === partnerId)?.publicIdentity.displayName ?? '一位伙伴'}被移出了群聊`),
      ];
      if (window.asteriumProjects?.changeMembers) {
        await window.asteriumProjects.changeMembers({
          projectId: group.projectId,
          projectMemberIds,
          rooms: state.groupChats.filter((item) => item.projectId === group.projectId).map((item) => ({
            room: { roomId: item.id, projectId: item.projectId, name: item.name, memberIds: item.id === groupChatId ? nextIds : item.memberIds },
            ...(item.id === groupChatId && announcements.length ? { announcements } : {}),
          })),
        });
      } else if (window.asteriumStudio) {
        await window.asteriumStudio.syncRoom({ roomId: group.id, projectId: group.projectId, name: group.name, memberIds: nextIds });
      }
      dispatch({ type: 'setGroupMembers', groupChatId, memberIds: nextIds });
    },
    setProjectMembers: async (projectId, memberIds) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) return undefined;
      const nextIds = [...new Set(memberIds)];
      const removed = project.memberIds.filter((id) => !nextIds.includes(id));
      const hasActiveRound = removed.length > 0 && state.groupChats.some((group) => group.projectId === projectId && studioRoomsRef.current[group.id]?.activeRound && !['completed', 'failed', 'cancelled'].includes(studioRoomsRef.current[group.id].activeRound!.state));
      if (hasActiveRound) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
      const rooms = state.groupChats.filter((item) => item.projectId === projectId).map((group) => {
        const removedHere = removed.filter((id) => group.memberIds.includes(id));
        return {
          room: { roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds.filter((id) => !removed.includes(id)) },
          ...(removedHere.length ? { announcements: removedHere.map((partnerId) => `${state.partners.find((item) => item.id === partnerId)?.publicIdentity.displayName ?? '一位伙伴'}离开了项目，并被移出了群聊`) } : {}),
        };
      });
      if (window.asteriumProjects?.changeMembers) {
        const result = await window.asteriumProjects.changeMembers({ projectId, projectMemberIds: nextIds, rooms });
        const updated = { ...project, ...result.project };
        dispatch({ type: 'updateProject', project: updated });
        return updated;
      } else if (window.asteriumStudio) {
        for (const change of rooms) await window.asteriumStudio.syncRoom(change.room);
        dispatch({ type: 'setProjectMembers', projectId, memberIds: nextIds });
        return { ...project, memberIds: nextIds };
      }
      dispatch({ type: 'setProjectMembers', projectId, memberIds: nextIds });
      return { ...project, memberIds: nextIds };
    },
    archiveGroupChat: async (groupChatId) => {
      const group = state.groupChats.find((item) => item.id === groupChatId);
      if (!group) return;
      await window.asteriumStudio?.syncRoom({ roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds, archived: true });
      dispatch({ type: 'archiveGroupChat', groupChatId, archivedAt: new Date().toISOString() });
    },
    restoreGroupChat: async (groupChatId) => {
      const group = state.groupChats.find((item) => item.id === groupChatId);
      if (!group || group.projectDeletedAt) return;
      await window.asteriumStudio?.syncRoom({ roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds, archived: false });
      dispatch({ type: 'restoreGroupChat', groupChatId });
    },
    removeGroupChat: async (groupChatId) => {
      await window.asteriumStudio?.removeRoom(groupChatId);
      const nextRooms = { ...studioRoomsRef.current };
      delete nextRooms[groupChatId];
      studioRoomsRef.current = nextRooms;
      setStudioRooms(nextRooms);
      dispatch({ type: 'removeGroupChat', groupChatId });
    },
    toggleGroupMember: (groupChatId, partnerId) => dispatch({ type: 'toggleGroupMember', groupChatId, partnerId }),
    contextHandoffDraft,
    setContextHandoffDraft,
    sendChatMessage: (conversationId, content, attachments, messageId, workspaceDecision, quote, contextHandoff) => compactingRef.current.has(conversationId) ? Promise.resolve(false) : sendSingleChatMessage({
      state,
      dispatch,
      bridge: { agents: window.asteriumAgents, attachments: window.asteriumAttachments },
      conversationId,
      content,
      attachments,
      messageId,
      workspaceDecision,
      quote,
      contextHandoff,
    }),
    sendChatGuidance: async (conversationId, content, expectedRunId, quote, guidanceClientMessageId) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      const text = content.trim();
      const apiGuidance = partner?.sourceMode === 'api_partner' && !partner.isPrototype && partner.configured;
      if (!text || !conversation?.activeRun || conversation.activeRun.runId !== expectedRunId || !conversation.sessionId || !partner || (partner.sourceMode !== 'local_cli' && !apiGuidance) || !window.asteriumAgents?.sendGuidance) return false;
      if (conversation.pendingAuthorization || conversation.pendingUserInput) return false;
      const clientMessageId = guidanceClientMessageId ?? makeId('client-guidance');
      // Register before IPC: an ordered applied event can arrive before invoke resolves.
      const apiMessage = apiGuidance ? { ...createSingleChatMessage(text, undefined, `message-${clientMessageId}`, quote), clientMessageId, runId: expectedRunId, isGuidance: true, guidanceState: 'queued' as const, status: 'awaiting_confirmation' as const } : undefined;
      if (apiMessage) dispatch({ type: 'sendChatGuidance', conversationId, runId: expectedRunId, waitForApplication: true, message: apiMessage });
      try {
        const result = await window.asteriumAgents.sendGuidance({
          protocolVersion: AGENT_PROTOCOL_VERSION,
          type: 'guidance.send',
          commandId: makeId('guidance'),
          partnerId: partner.id,
          conversationId,
          connectionSource: partner.sourceMode,
          clientMessageId,
          runId: conversation.activeRun.runId,
          sessionId: conversation.sessionId,
          content: { type: 'text', text: formatMessageWithQuote(text, quote) },
          ...(apiMessage ? { sourceMessage: { messageId: apiMessage.id, authorType: 'user' as const, authorId: apiMessage.authorId, content: apiMessage.content, createdAt: apiMessage.createdAt, occurredAt: apiMessage.occurredAt } } : {}),
        });
        if (result.disposition === 'accepted' && !apiGuidance) {
          const message = { ...createSingleChatMessage(text, undefined, undefined, quote), clientMessageId, runId: conversation.activeRun.runId, isGuidance: true, status: 'delivered' as const };
          dispatch({ type: 'sendChatGuidance', conversationId, runId: conversation.activeRun.runId, message });
        }
        return result.disposition;
      } catch {
        if (apiGuidance) dispatch({ type: 'rejectChatGuidance', conversationId, clientMessageId });
        return false;
      }
    },
    addConversationArtifact: (conversationId, artifact) => dispatch({ type: 'addConversationArtifact', conversationId, artifact }),
    removeConversationArtifact: (conversationId, artifactId) => dispatch({ type: 'removeConversationArtifact', conversationId, artifactId }),
    cancelChatRun: (conversationId) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      if (!conversation?.activeRun || !conversation.sessionId || !partner || !window.asteriumAgents) return;
      if (partner.sourceMode === 'existing_thread' && !partner.capabilities?.cancellation) return;
      void window.asteriumAgents.cancelRun({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'run.cancel',
        commandId: makeId('cancel'),
        partnerId: partner.id,
        conversationId,
        connectionSource: partner.sourceMode,
        clientMessageId: conversation.activeRun.clientMessageId,
        runId: conversation.activeRun.runId,
        sessionId: conversation.sessionId,
      });
    },
    regenerateChatTurn: (conversationId, editedContent) => compactingRef.current.has(conversationId) ? undefined : regenerateSingleChatTurn({
      state,
      dispatch,
      bridge: { agents: window.asteriumAgents, attachments: window.asteriumAttachments },
      conversationId,
      editedContent,
    }),
    resolveChatAuthorization: (conversationId, decision, persistExtensionTrust) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      const authorization = conversation?.pendingAuthorization;
      if (!conversation?.activeRun || !conversation.sessionId || !authorization || !partner || !window.asteriumAgents?.resolveAuthorization) return;
      void window.asteriumAgents.resolveAuthorization({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'authorization.resolve',
        commandId: makeId('authorization'),
        partnerId: partner.id,
        conversationId,
        connectionSource: partner.sourceMode,
        clientMessageId: conversation.activeRun.clientMessageId,
        runId: conversation.activeRun.runId,
        sessionId: conversation.sessionId,
        authorizationId: authorization.authorizationId,
        decision,
        ...(persistExtensionTrust ? { persistExtensionTrust: true } : {}),
      });
    },
    resolveChatUserInput: async (conversationId, answers, customAnswers, requestId) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      const partner = state.partners.find((item) => item.id === conversation?.partnerId);
      const request = conversation?.pendingUserInput;
      if (!conversation?.activeRun || !conversation.sessionId || !request || !partner || !window.asteriumAgents?.resolveUserInput || (requestId && request.requestId !== requestId)) throw new Error('USER_INPUT_NOT_PENDING');
      await window.asteriumAgents.resolveUserInput({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'user_input.resolve',
        commandId: makeId('user-input'),
        partnerId: partner.id,
        conversationId,
        connectionSource: partner.sourceMode,
        clientMessageId: conversation.activeRun.clientMessageId,
        runId: conversation.activeRun.runId,
        sessionId: conversation.sessionId,
        requestId: request.requestId,
        answers,
        ...(customAnswers ? { customAnswers } : {}),
      });
    },
    updatePartnerWorkspaceGrants: (partnerId, grants, preferredGrantId) => {
      const partner = state.partners.find((item) => item.id === partnerId);
      if (window.asteriumAgents?.syncPartnerWorkspace && partner && partner.sourceMode !== 'existing_thread') {
        const cwdGrantId = partner.sourceMode === 'local_cli'
          ? partner.partnerRootGrantId
          : preferredGrantId ?? partner.primaryWorkspaceGrantId;
        void window.asteriumAgents.syncPartnerWorkspace(partnerId, cwdGrantId, grants.map((grant) => grant.grantId)).catch(() => undefined);
      }
      dispatch({ type: 'updatePartnerWorkspaceGrants', partnerId, grants, preferredGrantId });
    },
    rebindPartnerRoot: (partner) => {
      dispatch({ type: 'rebindPartnerRoot', partnerId: partner.id, conversation: newConversation(partner) });
    },
    sendStudioMessage: async (groupChatId, content, mentions = [], attachmentSelectionIds = [], contextHandoff) => {
      const text = content.trim();
      const groupChat = state.groupChats.find((item) => item.id === groupChatId);
      if ((!text && !attachmentSelectionIds.length) || !groupChat || groupChat.archivedAt || !window.asteriumStudio) return false;
      let snapshot = studioRooms[groupChatId];
      if (!snapshot) snapshot = await window.asteriumStudio.syncRoom({ roomId: groupChat.id, projectId: groupChat.projectId, name: groupChat.name, memberIds: groupChat.memberIds });
      if (snapshot.activeRound && !['completed', 'failed', 'cancelled'].includes(snapshot.activeRound.state)) return false;
      let next: StudioRoomSnapshot;
      try {
        next = await window.asteriumStudio.startRound({
          room: { roomId: groupChat.id, projectId: groupChat.projectId, name: groupChat.name, memberIds: groupChat.memberIds },
          messageId: makeId('studio-message'),
          content: text,
          ...(attachmentSelectionIds.length ? { attachmentSelectionIds } : {}),
          authorId: ASTERIUM_USER_ID,
          // Main owns the authoritative queue. Retain the existing field as a
          // compatibility candidate list for the unchanged IPC contract.
          speakerQueue: [...groupChat.memberIds],
          ...(mentions.length ? { mentions } : {}),
          ...(contextHandoff ? { contextHandoff } : {}),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes('STUDIO_ROUND_HAS_NO_SPEAKERS') || detail.includes('STUDIO_MENTION_TARGET_UNAVAILABLE')) return false;
        throw error;
      }
      studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: next };
      setStudioRooms(studioRoomsRef.current);
      dispatch({ type: 'hydrateStudioMessages', groupChatId, messages: studioMessages(next) });
      return true;
    },
    setStudioMuted: async (groupChatId, partnerIds) => {
      const previous = studioRoomsRef.current[groupChatId]?.mutedPartnerIds ?? [];
      const snapshot = await window.asteriumStudio?.setMuted({ roomId: groupChatId, partnerIds });
      if (snapshot) {
        studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: snapshot };
        setStudioRooms(studioRoomsRef.current);
        const changed = [...new Set([...previous, ...partnerIds])].filter((id) => previous.includes(id) !== partnerIds.includes(id));
        for (const partnerId of changed) {
          const name = state.partners.find((item) => item.id === partnerId)?.publicIdentity.displayName ?? '一位伙伴';
          const announced = await window.asteriumStudio?.announce({ roomId: groupChatId, content: partnerIds.includes(partnerId) ? `${name}已被禁言` : `${name}已解除禁言` });
          if (announced) {
            studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: announced };
            setStudioRooms(studioRoomsRef.current);
          }
        }
      }
    },
    setStudioSettings: async (groupChatId, settings) => {
      const snapshot = await window.asteriumStudio?.setSettings({ roomId: groupChatId, settings });
      if (snapshot) {
        studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: snapshot };
        setStudioRooms(studioRoomsRef.current);
      }
    },
    resolveStudioDiscussion: async (groupChatId, decision) => {
      const snapshot = await window.asteriumStudio?.resolveDiscussion({ roomId: groupChatId, decision });
      if (snapshot) {
        studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: snapshot };
        setStudioRooms(studioRoomsRef.current);
      }
    },
    cancelStudioRound: async (groupChatId) => {
      if (!studioRoomsRef.current[groupChatId]?.activeRound || !window.asteriumStudio) return;
      const next = await window.asteriumStudio.cancelRound({ roomId: groupChatId });
      studioRoomsRef.current = { ...studioRoomsRef.current, [groupChatId]: next };
      setStudioRooms(studioRoomsRef.current);
      dispatch({ type: 'hydrateStudioMessages', groupChatId, messages: studioMessages(next) });
      setStudioInteractions((current) => {
        const updated = { ...current };
        delete updated[groupChatId];
        return updated;
      });
    },
    resolveStudioAuthorization: (groupChatId, decision, persistExtensionTrust) => {
      const interaction = studioInteractions[groupChatId];
      const request = interaction?.pendingAuthorization;
      const partner = state.partners.find((item) => item.id === interaction?.partnerId);
      if (!interaction || !request || !partner) return;
      void window.asteriumAgents?.resolveAuthorization?.({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'authorization.resolve',
        commandId: makeId('studio-authorization'),
        partnerId: interaction.partnerId,
        conversationId: interaction.conversationId,
        connectionSource: partner.sourceMode,
        clientMessageId: interaction.clientMessageId,
        runId: interaction.runId,
        sessionId: interaction.sessionId,
        route: interaction.route,
        authorizationId: request.authorizationId,
        decision,
        ...(persistExtensionTrust ? { persistExtensionTrust: true } : {}),
      });
    },
    resolveStudioUserInput: async (groupChatId, answers, customAnswers, requestId) => {
      const interaction = studioInteractions[groupChatId];
      const request = interaction?.pendingUserInput;
      const partner = state.partners.find((item) => item.id === interaction?.partnerId);
      if (!interaction || !request || !partner || !window.asteriumAgents?.resolveUserInput || (requestId && request.requestId !== requestId)) throw new Error('USER_INPUT_NOT_PENDING');
      await window.asteriumAgents.resolveUserInput({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'user_input.resolve',
        commandId: makeId('studio-user-input'),
        partnerId: interaction.partnerId,
        conversationId: interaction.conversationId,
        connectionSource: partner.sourceMode,
        clientMessageId: interaction.clientMessageId,
        runId: interaction.runId,
        sessionId: interaction.sessionId,
        route: interaction.route,
        requestId: request.requestId,
        answers,
        ...(customAnswers ? { customAnswers } : {}),
      });
    },
    addProjectMember: (projectId, partnerId) => dispatch({ type: 'addProjectMember', projectId, partnerId }),
  }), [confirmProjectLocation, contextHandoffDraft, changeConversationLifecycle, refreshProfiles, dismissChatCommandResult, dismissChatCompaction, chatMaintenanceRunning, chatCommandResults, chatCompactions, state, studioInteractions, studioRooms, theme, appearanceError, appearance, updateAppearance, setTheme, toggleTheme]);

  return <PrototypeContext.Provider value={value}>
    {conversationAuthorityReady ? children : null}
    {projectConfirmation && createPortal(<Modal title="确认项目保存位置" description={`「${projectConfirmation.name}」的项目文件将保存在以下目录。`}
      onClose={() => finishProjectConfirmation(false)} initialFocusRef={projectConfirmationCancel}>
      <div className="modal-body"><div className="project-location-confirmation">{projectConfirmation.path}</div></div>
      <footer className="modal-footer">
        <button ref={projectConfirmationCancel} type="button" className="secondary-button" onClick={() => finishProjectConfirmation(false)}>取消</button>
        <button type="button" className="primary-button" onClick={() => finishProjectConfirmation(true)}>创建项目</button>
      </footer>
    </Modal>, document.body)}
  </PrototypeContext.Provider>;
}

export function usePrototype() {
  const context = useContext(PrototypeContext);
  if (!context) throw new Error('usePrototype 必须在 PrototypeProvider 内使用');
  return context;
}
