import { randomUUID } from 'node:crypto';
import type {
  ProjectWorkflowGeneration,
  ProjectWorkflowGenerationChange,
  ProjectWorkflowGenerationError,
  ProjectWorkflowGenerationSourceMessage,
} from '../../shared/projectWorkflowGeneration';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface GenerationFile {
  version: 1;
  generations: ProjectWorkflowGeneration[];
}

export class ProjectWorkflowGenerationStore {
  private readonly storage: AtomicJsonStore<GenerationFile>;
  private readonly listeners = new Set<(change: ProjectWorkflowGenerationChange) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, generations: [] }),
      decode: decodeFile,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (change: ProjectWorkflowGenerationChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listProject(projectId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    return structuredClone((await this.storage.read()).generations.filter((item) => item.projectId === projectId));
  }

  async listAll() {
    return structuredClone((await this.storage.read()).generations);
  }

  async get(generationId: string) {
    validateId(generationId, 'PROJECT_WORKFLOW_GENERATION_ID_INVALID');
    const item = (await this.storage.read()).generations.find((generation) => generation.id === generationId);
    return item ? structuredClone(item) : undefined;
  }

  create(input: {
    requestId: string;
    requestFingerprint: string;
    projectId: string;
    roomId: string;
    plannerPartnerId: string;
    sourceDigest: string;
    sourceMessages: ProjectWorkflowGenerationSourceMessage[];
    retryOfGenerationId?: string;
  }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      validateId(input.requestId, 'PROJECT_WORKFLOW_GENERATION_REQUEST_ID_INVALID');
      const repeated = current.generations.find((item) => item.requestId === input.requestId);
      if (repeated) {
        if (repeated.requestFingerprint !== input.requestFingerprint) throw new Error('PROJECT_WORKFLOW_GENERATION_IDEMPOTENCY_CONFLICT');
        return structuredClone(repeated);
      }
      if (current.generations.some((item) => item.projectId === input.projectId && item.roomId === input.roomId && item.status === 'running')) {
        throw new Error('PROJECT_WORKFLOW_GENERATION_ALREADY_RUNNING');
      }
      const now = new Date().toISOString();
      const generation = cleanGeneration({
        version: 1,
        id: randomUUID(),
        ...input,
        status: 'running',
        validationFailures: 0,
        createdAt: now,
        updatedAt: now,
      });
      await this.storage.writeNow({ version: 1, generations: [...current.generations, generation] });
      this.notify({ type: 'changed', generation });
      return structuredClone(generation);
    });
  }

  bindRuntime(generationId: string, runtime: { conversationId: string; bindingId: string; runId: string; sessionId: string }) {
    return this.update(generationId, (generation) => {
      return { ...generation, ...runtime, updatedAt: new Date().toISOString() };
    });
  }

  claimStart(generationId: string, runtime: { conversationId: string; bindingId: string }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const index = current.generations.findIndex((item) => item.id === generationId);
      if (index < 0) throw new Error('PROJECT_WORKFLOW_GENERATION_NOT_FOUND');
      const generation = current.generations[index];
      if (generation.status !== 'running' || generation.conversationId) {
        return { claimed: false, generation: structuredClone(generation) };
      }
      const updated = cleanGeneration({ ...generation, ...runtime, updatedAt: new Date().toISOString() });
      const generations = [...current.generations];
      generations[index] = updated;
      await this.storage.writeNow({ version: 1, generations });
      this.notify({ type: 'changed', generation: updated });
      return { claimed: true, generation: structuredClone(updated) };
    });
  }

  recordValidationFailure(generationId: string, error: ProjectWorkflowGenerationError) {
    return this.update(generationId, (generation) => {
      if (generation.status !== 'running') throw new Error('PROJECT_WORKFLOW_GENERATION_NOT_RUNNING');
      const validationFailures = generation.validationFailures + 1;
      return {
        ...generation,
        validationFailures,
        ...(validationFailures >= 2 ? { status: 'failed' as const, error } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  markSubmitted(generationId: string, workflowId: string) {
    return this.update(generationId, (generation) => {
      if (generation.status === 'submitted' && generation.workflowId === workflowId) return generation;
      if (generation.status !== 'running') throw new Error('PROJECT_WORKFLOW_GENERATION_NOT_RUNNING');
      const now = new Date().toISOString();
      return { ...generation, status: 'submitted' as const, workflowId, error: undefined, updatedAt: now, submittedAt: now };
    });
  }

  markFailed(generationId: string, error: ProjectWorkflowGenerationError) {
    return this.update(generationId, (generation) => {
      if (generation.status === 'submitted' || generation.status === 'cancelled') return generation;
      return { ...generation, status: 'failed' as const, error, updatedAt: new Date().toISOString() };
    });
  }

  markCancelled(generationId: string) {
    return this.update(generationId, (generation) => {
      if (generation.status === 'submitted' || generation.status === 'cancelled') return generation;
      const now = new Date().toISOString();
      return { ...generation, status: 'cancelled' as const, error: undefined, updatedAt: now, cancelledAt: now };
    });
  }

  recover() {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const now = new Date().toISOString();
      let changed = false;
      const generations = current.generations.map((generation) => {
        if (generation.status !== 'running') return generation;
        changed = true;
        return cleanGeneration({
          ...generation,
          status: 'interrupted',
          error: { code: 'PROJECT_WORKFLOW_GENERATION_INTERRUPTED', message: '应用重启中断了这次生成，可使用原消息重新生成。', retryable: true },
          updatedAt: now,
        });
      });
      if (changed) await this.storage.writeNow({ version: 1, generations });
      for (const generation of generations) if (generation.status === 'interrupted' && generation.updatedAt === now) this.notify({ type: 'changed', generation });
      return structuredClone(generations);
    });
  }

  removeProject(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const next = current.generations.filter((item) => item.projectId !== projectId);
      if (next.length === current.generations.length) return;
      await this.storage.writeNow({ version: 1, generations: next });
      this.notify({ type: 'project_removed', projectId });
    });
  }

  private update(generationId: string, mutate: (generation: ProjectWorkflowGeneration) => ProjectWorkflowGeneration) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const index = current.generations.findIndex((item) => item.id === generationId);
      if (index < 0) throw new Error('PROJECT_WORKFLOW_GENERATION_NOT_FOUND');
      const updated = cleanGeneration(mutate(structuredClone(current.generations[index])));
      const generations = [...current.generations];
      generations[index] = updated;
      await this.storage.writeNow({ version: 1, generations });
      this.notify({ type: 'changed', generation: updated });
      return structuredClone(updated);
    });
  }

  private notify(change: ProjectWorkflowGenerationChange) {
    for (const listener of this.listeners) listener(structuredClone(change));
  }
}

function decodeFile(value: unknown): GenerationFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.generations)) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  const generations = value.generations.map(cleanGeneration);
  if (new Set(generations.map((item) => item.id)).size !== generations.length || new Set(generations.map((item) => item.requestId)).size !== generations.length) {
    throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  }
  return { version: 1, generations };
}

function cleanGeneration(value: unknown): ProjectWorkflowGeneration {
  if (!isRecord(value) || value.version !== 1 || !isStatus(value.status) || !Array.isArray(value.sourceMessages)
    || !Number.isSafeInteger(value.validationFailures) || Number(value.validationFailures) < 0) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  const required = ['id', 'requestId', 'requestFingerprint', 'projectId', 'roomId', 'plannerPartnerId', 'sourceDigest', 'createdAt', 'updatedAt'] as const;
  for (const key of required) if (typeof value[key] !== 'string' || !String(value[key]).trim()) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  const sourceMessages = value.sourceMessages.map(cleanSourceMessage).sort((left, right) => left.seq - right.seq);
  if (!sourceMessages.length || new Set(sourceMessages.map((item) => item.messageId)).size !== sourceMessages.length) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  return {
    version: 1,
    id: String(value.id), requestId: String(value.requestId), requestFingerprint: String(value.requestFingerprint),
    projectId: String(value.projectId), roomId: String(value.roomId), plannerPartnerId: String(value.plannerPartnerId), sourceDigest: String(value.sourceDigest),
    sourceMessages, status: value.status, validationFailures: Number(value.validationFailures),
    ...optionalString(value, 'retryOfGenerationId'), ...optionalString(value, 'workflowId'), ...optionalString(value, 'conversationId'),
    ...optionalString(value, 'bindingId'), ...optionalString(value, 'runId'), ...optionalString(value, 'sessionId'),
    ...(isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string' && typeof value.error.retryable === 'boolean'
      ? { error: { code: value.error.code, message: value.error.message, retryable: value.error.retryable } } : {}),
    createdAt: validDate(String(value.createdAt)), updatedAt: validDate(String(value.updatedAt)),
    ...optionalDate(value, 'submittedAt'), ...optionalDate(value, 'cancelledAt'),
  };
}

function cleanSourceMessage(value: unknown): ProjectWorkflowGenerationSourceMessage {
  if (!isRecord(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 || !['user', 'partner', 'system'].includes(String(value.authorType))
    || !['completed', 'interrupted'].includes(String(value.status))) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  for (const key of ['messageId', 'authorId', 'content', 'contentHash', 'createdAt'] as const) if (typeof value[key] !== 'string') throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  return {
    messageId: String(value.messageId), seq: Number(value.seq), authorType: value.authorType as ProjectWorkflowGenerationSourceMessage['authorType'],
    authorId: String(value.authorId), content: String(value.content), contentHash: String(value.contentHash), createdAt: validDate(String(value.createdAt)),
    status: value.status as ProjectWorkflowGenerationSourceMessage['status'],
  };
}

function optionalString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' && value[key] ? { [key]: value[key] } : {};
}

function optionalDate(value: Record<string, unknown>, key: string) {
  return typeof value[key] === 'string' ? { [key]: validDate(value[key]) } : {};
}

function isStatus(value: unknown): value is ProjectWorkflowGeneration['status'] {
  return ['running', 'submitted', 'failed', 'cancelled', 'interrupted'].includes(String(value));
}

function validateId(value: string, code: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(code);
}

function validDate(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error('PROJECT_WORKFLOW_GENERATION_STORE_INVALID');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
