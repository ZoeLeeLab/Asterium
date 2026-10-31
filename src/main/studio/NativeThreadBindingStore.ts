import { randomUUID } from 'node:crypto';
import type { ConnectionSource, NativeThreadScope, SendMessageCommand, SessionBootstrapDocument } from '../../shared/agentProtocol';
import type { NativeThreadBinding, StudioSpeakingMode } from '../../shared/studioRuntime';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

interface BindingFile {
  version: 1;
  bindings: NativeThreadBinding[];
}

export class NativeThreadBindingStore {
  private readonly storage: AtomicJsonStore<BindingFile>;

  constructor(filePath: string | (() => string)) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, bindings: [] }),
      decode: decodeBindingFile,
    });
  }

  async getForScope(partnerId: string, scope: NativeThreadScope, scopeId: string) {
    const bindings = (await this.storage.read()).bindings;
    return bindings.find((item) => item.partnerId === partnerId && item.scope === scope && bindingScopeId(item) === scopeId && item.state !== 'invalid');
  }

  async reserve(input: {
    partnerId: string;
    source: ConnectionSource;
    scope: NativeThreadScope;
    conversationId: string;
    generationScopedConversation?: boolean;
    roomId?: string;
    projectId?: string;
    workflowGenerationId?: string;
  }) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const scopeId = input.scope === 'single' ? input.conversationId
        : input.scope === 'group' ? input.roomId
          : input.scope === 'workflow_planning' ? input.workflowGenerationId
            : input.projectId;
      if (!scopeId) throw new Error('NATIVE_BINDING_SCOPE_ID_REQUIRED');
      const current = data.bindings.find((item) => item.partnerId === input.partnerId && item.scope === input.scope && bindingScopeId(item) === scopeId && item.state !== 'invalid');
      if (current) return current;
      const latestGeneration = Math.max(0, ...data.bindings
        .filter((item) => item.partnerId === input.partnerId && item.scope === input.scope && bindingScopeId(item) === scopeId)
        .map((item) => item.generation));
      const now = new Date().toISOString();
      const binding: NativeThreadBinding = {
        bindingId: randomUUID(),
        partnerId: input.partnerId,
        source: input.source,
        scope: input.scope,
        conversationId: input.generationScopedConversation && input.scope === 'group' ? `${input.conversationId}:generation:${latestGeneration + 1}` : input.conversationId,
        ...(input.roomId ? { roomId: input.roomId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.workflowGenerationId ? { workflowGenerationId: input.workflowGenerationId } : {}),
        generation: latestGeneration + 1,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      data.bindings.push(binding);
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async registerSingle(input: { partnerId: string; source: ConnectionSource; conversationId: string; nativeThreadId: string }) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const current = data.bindings.find((item) => item.partnerId === input.partnerId && item.scope === 'single'
        && item.conversationId === input.conversationId && item.state !== 'invalid');
      if (current?.state === 'active' && current.nativeThreadId === input.nativeThreadId) return current;

      const collision = data.bindings.find((item) => item.nativeThreadId === input.nativeThreadId
        && (item.scope !== 'single' || item.state !== 'invalid')
        && !(item.scope === 'single' && item.conversationId === input.conversationId));
      if (collision) throw new Error('NATIVE_THREAD_ALREADY_BOUND');

      const latestGeneration = Math.max(0, ...data.bindings
        .filter((item) => item.partnerId === input.partnerId && item.scope === 'single' && item.conversationId === input.conversationId)
        .map((item) => item.generation));
      const now = new Date().toISOString();
      if (current) {
        current.state = 'invalid';
        current.updatedAt = now;
      }
      const binding: NativeThreadBinding = {
        bindingId: randomUUID(),
        partnerId: input.partnerId,
        source: input.source,
        scope: 'single',
        conversationId: input.conversationId,
        generation: latestGeneration + 1,
        state: 'active',
        createdAt: now,
        updatedAt: now,
        nativeThreadId: input.nativeThreadId,
      };
      data.bindings.push(binding);
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async activate(bindingId: string, nativeThreadId: string) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId);
      if (!binding || binding.state === 'invalid') throw new Error('NATIVE_BINDING_NOT_PENDING');
      const collision = data.bindings.find((item) => item.bindingId !== bindingId && item.nativeThreadId === nativeThreadId && item.state !== 'invalid');
      if (collision) throw new Error('NATIVE_THREAD_ALREADY_BOUND');
      binding.nativeThreadId = nativeThreadId;
      binding.state = 'active';
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async invalidate(bindingId: string) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId);
      if (!binding) return;
      binding.state = 'invalid';
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
    });
  }

  /** A late failure may only invalidate the exact generation that started it. */
  async invalidateGroupTurn(command: Pick<SendMessageCommand, 'partnerId' | 'conversationId' | 'connectionSource' | 'route'>) {
    const route = command.route;
    if (route?.scope !== 'group') return;
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.scope === 'group' && item.roomId === route.roomId
        && item.partnerId === command.partnerId && item.source === command.connectionSource
        && item.conversationId === command.conversationId && item.generation === route.bindingGeneration
        && item.state !== 'invalid');
      if (!binding) return;
      binding.state = 'invalid'; binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
    });
  }

  async listForRooms(roomIds: string[]) {
    const targets = new Set(roomIds);
    return structuredClone((await this.storage.read()).bindings.filter((binding) => binding.scope === 'group' && binding.roomId && targets.has(binding.roomId)));
  }

  async listForProjects(projectIds: string[]) {
    const targets = new Set(projectIds);
    return structuredClone((await this.storage.read()).bindings.filter((binding) => (binding.scope === 'workspace' || binding.scope === 'workflow_planning') && binding.projectId && targets.has(binding.projectId)));
  }

  async removeConversations(conversationIds: string[]) {
    const targets = new Set(conversationIds);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const next = data.bindings.filter((binding) => binding.scope !== 'single' || !targets.has(binding.conversationId));
      if (next.length === data.bindings.length) return;
      data.bindings = next;
      await this.writeUnlocked(data);
    });
  }

  async invalidateRoomMembers(roomId: string, partnerIds: string[]) {
    const targets = new Set(partnerIds);
    await this.mutate(async () => {
      const data = await this.readUnlocked(); let changed = false;
      for (const binding of data.bindings) {
        if (binding.scope !== 'group' || binding.roomId !== roomId || !targets.has(binding.partnerId) || binding.state === 'invalid') continue;
        binding.state = 'invalid'; binding.updatedAt = new Date().toISOString(); changed = true;
      }
      if (changed) await this.writeUnlocked(data);
    });
  }

  async invalidateRooms(roomIds: string[]) {
    const targets = new Set(roomIds);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const now = new Date().toISOString();
      let changed = false;
      for (const binding of data.bindings) {
        if (binding.scope !== 'group' || !binding.roomId || !targets.has(binding.roomId) || binding.state === 'invalid') continue;
        binding.state = 'invalid';
        binding.updatedAt = now;
        changed = true;
      }
      if (changed) await this.writeUnlocked(data);
    });
  }

  async removeRooms(roomIds: string[]) {
    const targets = new Set(roomIds);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const next = data.bindings.filter((binding) => binding.scope !== 'group' || !binding.roomId || !targets.has(binding.roomId));
      if (next.length === data.bindings.length) return;
      data.bindings = next;
      await this.writeUnlocked(data);
    });
  }

  async removeProjects(projectIds: string[]) {
    const targets = new Set(projectIds);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const next = data.bindings.filter((binding) => (binding.scope !== 'workspace' && binding.scope !== 'workflow_planning') || !binding.projectId || !targets.has(binding.projectId));
      if (next.length === data.bindings.length) return;
      data.bindings = next;
      await this.writeUnlocked(data);
    });
  }

  async restore(bindings: NativeThreadBinding[]) {
    await this.mutate(async () => {
      if (!bindings.length) return;
      const data = await this.readUnlocked();
      const restored = new Map(bindings.map((binding) => [binding.bindingId, structuredClone(binding)]));
      data.bindings = data.bindings.map((binding) => restored.get(binding.bindingId) ?? binding);
      for (const binding of restored.values()) if (!data.bindings.some((item) => item.bindingId === binding.bindingId)) data.bindings.push(binding);
      await this.writeUnlocked(data);
    });
  }

  async markCompleted(bindingId: string, runId: string) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId && item.state === 'active');
      if (!binding) throw new Error('NATIVE_BINDING_NOT_ACTIVE');
      binding.lastCompletedRunId = runId;
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async setProfileRecoveryRequired(bindingId: string, required: boolean) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId && item.state === 'active');
      if (!binding) throw new Error('NATIVE_BINDING_NOT_ACTIVE');
      binding.profileRecoveryRequired = required;
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
    });
  }

  async markPersonaVersion(bindingId: string, personaVersion: string, bootstrapVersion?: number, bootstrap?: SessionBootstrapDocument, options?: { clearProfileRecovery: boolean }) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId && item.state === 'active');
      if (!binding) throw new Error('NATIVE_BINDING_NOT_ACTIVE');
      binding.personaVersion = personaVersion;
      if (bootstrapVersion !== undefined) binding.bootstrapVersion = bootstrapVersion;
      if (bootstrap) binding.bootstrap = structuredClone(bootstrap);
      if (options?.clearProfileRecovery) binding.profileRecoveryRequired = false;
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async markStudioSpeakingMode(bindingId: string, speakingMode: StudioSpeakingMode) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const binding = data.bindings.find((item) => item.bindingId === bindingId && item.state === 'active');
      if (!binding) throw new Error('NATIVE_BINDING_NOT_ACTIVE');
      if (binding.studioSpeakingMode === speakingMode) return binding;
      binding.studioSpeakingMode = speakingMode;
      binding.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return binding;
    });
  }

  async isBoundNativeThread(nativeThreadId: string, except?: { scope: NativeThreadScope; scopeId: string }) {
    return (await this.storage.read()).bindings.some((item) => item.nativeThreadId === nativeThreadId && (item.scope !== 'single' || item.state !== 'invalid')
      && (!except || item.scope !== except.scope || bindingScopeId(item) !== except.scopeId));
  }

  async activeNativeThreadIds(scope?: NativeThreadScope) {
    return (await this.storage.read()).bindings
      .filter((item) => item.nativeThreadId && (item.scope !== 'single' || item.state === 'active') && (!scope || item.scope === scope))
      .map((item) => item.nativeThreadId as string);
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: BindingFile) { return this.storage.writeNow(data); }

  private mutate<T>(operation: () => Promise<T>) {
    return this.storage.runExclusive(operation);
  }
}

function decodeBindingFile(parsed: unknown): BindingFile {
  if (isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.bindings)) return parsed as unknown as BindingFile;
  throw new Error('NATIVE_BINDING_STORE_INVALID');
}

function bindingScopeId(binding: NativeThreadBinding) {
  return binding.scope === 'single' ? binding.conversationId
    : binding.scope === 'group' ? binding.roomId
      : binding.scope === 'workflow_planning' ? binding.workflowGenerationId
        : binding.projectId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
