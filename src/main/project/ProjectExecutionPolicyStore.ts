import type { ProjectExecutionPolicy, ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import { isProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface ProjectExecutionPolicyFile {
  version: 1;
  policies: ProjectExecutionPolicy[];
  needsMigration?: true;
}

export class ProjectExecutionPolicyStore {
  private readonly storage: AtomicJsonStore<ProjectExecutionPolicyFile>;
  private readonly listeners = new Set<(policy: ProjectExecutionPolicy) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore<ProjectExecutionPolicyFile>({
      filePath,
      empty: () => ({ version: 1, policies: [] }),
      decode: decodeProjectExecutionPolicies,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (policy: ProjectExecutionPolicy) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async get(projectId: string) {
    validateProjectId(projectId);
    const current = await this.storage.read();
    const policy = current.policies.find((item) => item.projectId === projectId);
    return policy ? structuredClone(policy) : undefined;
  }

  getOrCreate(projectId: string) {
    validateProjectId(projectId);
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.policies.find((policy) => policy.projectId === projectId);
      if (existing) {
        if (current.needsMigration) await this.storage.writeNow({ version: 1, policies: current.policies });
        return structuredClone(existing);
      }
      const created = createPolicy(projectId, 'manual');
      await this.storage.writeNow({ version: 1, policies: [...current.policies, created] });
      return structuredClone(created);
    });
  }

  update(projectId: string, permissionMode: ProjectPermissionMode) {
    validateProjectId(projectId);
    if (!isProjectPermissionMode(permissionMode)) throw new Error('INVALID_PROJECT_PERMISSION_MODE');
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const next = createPolicy(projectId, permissionMode);
      await this.storage.writeNow({
        version: 1,
        policies: [...current.policies.filter((policy) => policy.projectId !== projectId), next],
      });
      this.notify(next);
      return structuredClone(next);
    });
  }

  remove(projectId: string) {
    validateProjectId(projectId);
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (!current.policies.some((policy) => policy.projectId === projectId)) return;
      await this.storage.writeNow({
        version: 1,
        policies: current.policies.filter((policy) => policy.projectId !== projectId),
      });
    });
  }

  restore(policy: ProjectExecutionPolicy) {
    validateProjectId(policy.projectId);
    if (!isProjectPermissionMode(policy.permissionMode)) throw new Error('INVALID_PROJECT_PERMISSION_MODE');
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = { ...policy, version: 1 as const };
      await this.storage.writeNow({
        version: 1,
        policies: [...current.policies.filter((item) => item.projectId !== restored.projectId), restored],
      });
      this.notify(restored);
    });
  }

  private notify(policy: ProjectExecutionPolicy) {
    for (const listener of this.listeners) listener(structuredClone(policy));
  }
}

function createPolicy(projectId: string, permissionMode: ProjectPermissionMode): ProjectExecutionPolicy {
  return { version: 1, projectId, permissionMode, updatedAt: new Date().toISOString() };
}

function decodeProjectExecutionPolicies(value: unknown): ProjectExecutionPolicyFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.policies)) throw new Error('PROJECT_EXECUTION_POLICY_STORE_INVALID');
  const policies = new Map<string, ProjectExecutionPolicy>();
  let needsMigration = false;
  for (const item of value.policies) {
    if (!isRecord(item) || typeof item.projectId !== 'string' || typeof item.updatedAt !== 'string') throw new Error('PROJECT_EXECUTION_POLICY_STORE_INVALID');
    validateProjectId(item.projectId);
    const permissionMode = isProjectPermissionMode(item.permissionMode) ? item.permissionMode : 'manual';
    if (permissionMode !== item.permissionMode || policies.has(item.projectId)) needsMigration = true;
    policies.set(item.projectId, {
      version: 1,
      projectId: item.projectId,
      permissionMode,
      updatedAt: item.updatedAt,
    });
  }
  return { version: 1, policies: [...policies.values()], ...(needsMigration ? { needsMigration: true as const } : {}) };
}

function validateProjectId(projectId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('INVALID_PROJECT_ID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
