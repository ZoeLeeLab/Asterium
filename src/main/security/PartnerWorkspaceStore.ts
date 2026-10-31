import path from 'node:path';
import type { PartnerWorkspaceState, PermissionMode } from '../../shared/agentProtocol';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { normalizeReportedLocalPath } from './localPath';
import type { WorkspaceGrantStore } from './WorkspaceGrantStore';
import { assertCanonicalPathOutsideProtectedRoots } from './ProtectedPathPolicy';

interface PartnerWorkspaceRecord {
  partnerId: string;
  cwdGrantId?: string;
  manualWorkspaceGrantIds: string[];
  projectWorkspaces: Record<string, string>;
  version: number;
  updatedAt: string;
}

interface PartnerWorkspaceFile {
  version: 2;
  partners: Record<string, PartnerWorkspaceRecord>;
}

export interface ProjectWorkspaceAssignment {
  projectId: string;
  rootPath: string;
  partnerIds: string[];
}

export interface WorkspaceSnapshot {
  cwd?: string;
  workspaceFolders: string[];
  permissionMode: PermissionMode;
  workspaceVersion: number;
  managementTool: { name: 'asterium_workspace'; actions: Array<'list' | 'add' | 'remove'> };
  unavailableFolders: string[];
  workspaceSources: Array<{ path: string; source: 'manual' | 'project'; projectId?: string }>;
}

/** Workspace grants belong to a partner, not to an individual conversation. */
export class PartnerWorkspaceStore {
  private readonly storage: AtomicJsonStore<PartnerWorkspaceFile>;
  private readonly listeners = new Set<(state: PartnerWorkspaceState) => unknown>();

  constructor(
    filePath: string | (() => string),
    private readonly grants: WorkspaceGrantStore,
    private readonly protectedRoots: readonly string[] = [],
  ) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 2, partners: {} }),
      decode: decodePartnerWorkspaceFile,
    });
  }

  async ensure(partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[]) {
    await this.assertGrantIdsAllowed([cwdGrantId, ...workspaceGrantIds]);
    let created = false;
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const current = data.partners[partnerId];
      if (current) return;
      data.partners[partnerId] = {
        partnerId,
        ...(cwdGrantId ? { cwdGrantId } : {}),
        manualWorkspaceGrantIds: uniqueValues(workspaceGrantIds.filter((grantId) => grantId !== cwdGrantId)),
        projectWorkspaces: {},
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      await this.writeUnlocked(data);
      created = true;
    });
    if (created) await this.notify(partnerId);
  }

  /** Replace a partner's configured CWD and extra grants without touching the external folders. */
  async sync(partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[], expectedVersion?: number) {
    await this.assertGrantIdsAllowed([cwdGrantId, ...workspaceGrantIds]);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const current = data.partners[partnerId];
      if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new Error('PARTNER_WORKSPACE_VERSION_CONFLICT');
      data.partners[partnerId] = {
        partnerId,
        ...(cwdGrantId ? { cwdGrantId } : {}),
        manualWorkspaceGrantIds: uniqueValues(workspaceGrantIds.filter((grantId) => grantId !== cwdGrantId)),
        projectWorkspaces: { ...(current?.projectWorkspaces ?? {}) },
        version: (current?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.writeUnlocked(data);
    });
    return this.notify(partnerId);
  }

  async configuredState(partnerId: string): Promise<PartnerWorkspaceState> {
    const record = (await this.storage.read()).partners[partnerId];
    if (!record) return { partnerId, workspaces: [], version: 0, unavailableGrantIds: [] };
    const cwdPath = record.cwdGrantId ? await this.grants.get(record.cwdGrantId) : undefined;
    const manual = await Promise.all(record.manualWorkspaceGrantIds.map(async (grantId) => ({ grantId, path: await this.grants.get(grantId), source: 'manual' as const })));
    const projects = await Promise.all(Object.entries(record.projectWorkspaces).map(async ([projectId, grantId]) => ({ grantId, path: await this.grants.get(grantId), source: 'project' as const, projectId })));
    const resolved = [...manual, ...projects];
    return {
      partnerId,
      ...(record.cwdGrantId && cwdPath ? { cwd: { grantId: record.cwdGrantId, displayPath: cwdPath } } : {}),
      workspaces: resolved.filter((item) => Boolean(item.path)).map((item) => ({ grantId: item.grantId, displayPath: item.path!, source: item.source, ...('projectId' in item ? { projectId: item.projectId } : {}) })),
      version: record.version,
      unavailableGrantIds: [
        ...(record.cwdGrantId && !cwdPath ? [record.cwdGrantId] : []),
        ...resolved.filter((item) => !item.path).map((item) => item.grantId),
      ],
    };
  }

  subscribe(listener: (state: PartnerWorkspaceState) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(partnerId: string, permissionMode: PermissionMode): Promise<WorkspaceSnapshot> {
    const record = (await this.storage.read()).partners[partnerId];
    if (!record) return emptySnapshot(permissionMode);
    const cwd = record.cwdGrantId ? await this.grants.get(record.cwdGrantId) : undefined;
    const manual = await Promise.all(record.manualWorkspaceGrantIds.map(async (grantId) => ({ grantId, path: await this.grants.get(grantId), source: 'manual' as const })));
    const projects = await Promise.all(Object.entries(record.projectWorkspaces).map(async ([projectId, grantId]) => ({ grantId, path: await this.grants.get(grantId), source: 'project' as const, projectId })));
    const resolved = [...manual, ...projects];
    const folders = unique([cwd, ...resolved.map((item) => item.path)].filter((item): item is string => Boolean(item)));
    return {
      ...(cwd ? { cwd } : {}),
      workspaceFolders: folders,
      permissionMode,
      workspaceVersion: record.version,
      managementTool: { name: 'asterium_workspace', actions: ['list', 'add', 'remove'] },
      unavailableFolders: resolved.filter((item) => !item.path).map((item) => item.grantId),
      workspaceSources: resolved.filter((item) => Boolean(item.path)).map((item) => ({ path: item.path!, source: item.source, ...('projectId' in item ? { projectId: item.projectId } : {}) })),
    };
  }

  async add(partnerId: string, absolutePath: string, permissionMode: PermissionMode) {
    if (permissionMode === 'read_only') throw new Error('ASTERIUM_READ_ONLY');
    if (!isReportedAbsolutePath(absolutePath)) throw new Error('WORKSPACE_PATH_MUST_BE_ABSOLUTE');
    const normalizedPath = normalizeReportedLocalPath(absolutePath);
    await assertCanonicalPathOutsideProtectedRoots(normalizedPath, this.protectedRoots);
    const grant = await this.grants.add(normalizedPath);
    let used = false;
    try {
      await this.mutate(async () => {
        const data = await this.readUnlocked();
        const record = data.partners[partnerId];
        if (!record) throw new Error('PARTNER_WORKSPACE_NOT_INITIALIZED');
        const existing = await Promise.all([...record.manualWorkspaceGrantIds, ...Object.values(record.projectWorkspaces)].map(async (grantId) => ({ grantId, path: await this.grants.get(grantId) })));
        if (!existing.some((item) => item.path && samePath(item.path, grant.displayPath))) {
          record.manualWorkspaceGrantIds.push(grant.grantId);
          used = true;
        }
        record.version += 1;
        record.updatedAt = new Date().toISOString();
        await this.writeUnlocked(data);
      });
    } catch (error) {
      await this.grants.deleteMany([grant.grantId]);
      throw error;
    }
    if (!used) await this.grants.deleteMany([grant.grantId]);
    await this.notify(partnerId);
    return this.snapshot(partnerId, permissionMode);
  }

  async remove(partnerId: string, targetPath: string, permissionMode: PermissionMode) {
    if (permissionMode === 'read_only') throw new Error('ASTERIUM_READ_ONLY');
    if (!isReportedAbsolutePath(targetPath)) throw new Error('WORKSPACE_PATH_MUST_BE_ABSOLUTE');
    const normalizedTarget = normalizeReportedLocalPath(targetPath);
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      const record = data.partners[partnerId];
      if (!record) throw new Error('PARTNER_WORKSPACE_NOT_INITIALIZED');
      const cwd = record.cwdGrantId ? await this.grants.get(record.cwdGrantId) : undefined;
      if (cwd && samePath(cwd, normalizedTarget)) throw new Error('WORKSPACE_CWD_IMMUTABLE');
      const projectResolved = await Promise.all(Object.entries(record.projectWorkspaces).map(async ([projectId, grantId]) => ({ projectId, grantId, path: await this.grants.get(grantId) })));
      if (projectResolved.some((item) => item.path && samePath(item.path, normalizedTarget))) throw new Error('PROJECT_WORKSPACE_MANAGED');
      const resolved = await Promise.all(record.manualWorkspaceGrantIds.map(async (grantId) => ({ grantId, path: await this.grants.get(grantId) })));
      const match = resolved.find((item) => item.path && samePath(item.path, normalizedTarget));
      if (!match) throw new Error('WORKSPACE_NOT_ATTACHED');
      record.manualWorkspaceGrantIds = record.manualWorkspaceGrantIds.filter((grantId) => grantId !== match.grantId);
      record.version += 1;
      record.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
    });
    await this.notify(partnerId);
    return this.snapshot(partnerId, permissionMode);
  }

  async grantIds(partnerId: string) {
    const record = (await this.storage.read()).partners[partnerId];
    return record ? { cwdGrantId: record.cwdGrantId, workspaceGrantIds: uniqueValues([...record.manualWorkspaceGrantIds, ...Object.values(record.projectWorkspaces)]) } : undefined;
  }

  async reconcileProjects(assignments: ProjectWorkspaceAssignment[]) {
    const normalized = assignments.map((assignment) => ({
      projectId: assignment.projectId,
      rootPath: path.resolve(assignment.rootPath),
      partnerIds: uniqueValues(assignment.partnerIds),
    }));
    const changed = new Set<string>();
    const createdGrantIds: string[] = [];
    try {
      await this.mutate(async () => {
        const data = await this.readUnlocked();
        const assignmentByProject = new Map(normalized.map((item) => [item.projectId, item]));
        for (const [partnerId, record] of Object.entries(data.partners)) {
          for (const projectId of Object.keys(record.projectWorkspaces)) {
            const assignment = assignmentByProject.get(projectId);
            if (assignment?.partnerIds.includes(partnerId)) continue;
            delete record.projectWorkspaces[projectId];
            record.version += 1;
            record.updatedAt = new Date().toISOString();
            changed.add(partnerId);
          }
        }
        for (const assignment of normalized) {
          await assertCanonicalPathOutsideProtectedRoots(assignment.rootPath, this.protectedRoots);
          for (const partnerId of assignment.partnerIds) {
            const record = data.partners[partnerId];
            if (!record) continue;
            const currentGrantId = record.projectWorkspaces[assignment.projectId];
            const currentPath = currentGrantId ? await this.grants.get(currentGrantId) : undefined;
            if (currentPath && samePath(currentPath, assignment.rootPath)) continue;
            const matchingManual = await findMatchingGrant(record.manualWorkspaceGrantIds, assignment.rootPath, this.grants);
            const grantId = matchingManual ?? await this.createProjectGrant(assignment.rootPath, createdGrantIds);
            record.projectWorkspaces[assignment.projectId] = grantId;
            record.version += 1;
            record.updatedAt = new Date().toISOString();
            changed.add(partnerId);
          }
        }
        if (changed.size) await this.writeUnlocked(data);
      });
    } catch (error) {
      await this.rollbackProjectGrants(createdGrantIds, error);
    }
    for (const partnerId of changed) await this.notify(partnerId);
    return Promise.all([...changed].map((partnerId) => this.configuredState(partnerId)));
  }

  async projectPartnerIds(projectId: string) {
    const data = await this.storage.read();
    return Object.entries(data.partners)
      .filter(([, record]) => Boolean(record.projectWorkspaces[projectId]))
      .map(([partnerId]) => partnerId);
  }

  async reconcileProject(assignment: { projectId: string; rootPath?: string; partnerIds: string[] }) {
    const rootPath = assignment.rootPath ? path.resolve(assignment.rootPath) : undefined;
    const partnerIds = uniqueValues(assignment.partnerIds);
    if (rootPath) await assertCanonicalPathOutsideProtectedRoots(rootPath, this.protectedRoots);
    const changed = new Set<string>();
    const createdGrantIds: string[] = [];
    try {
      await this.mutate(async () => {
        const data = await this.readUnlocked();
        for (const [partnerId, record] of Object.entries(data.partners)) {
          const shouldHave = Boolean(rootPath && partnerIds.includes(partnerId));
          const currentGrantId = record.projectWorkspaces[assignment.projectId];
          if (!shouldHave && currentGrantId) {
            delete record.projectWorkspaces[assignment.projectId];
            record.version += 1;
            record.updatedAt = new Date().toISOString();
            changed.add(partnerId);
            continue;
          }
          if (!shouldHave || !rootPath) continue;
          const currentPath = currentGrantId ? await this.grants.get(currentGrantId) : undefined;
          if (currentPath && samePath(currentPath, rootPath)) continue;
          const matchingManual = await findMatchingGrant(record.manualWorkspaceGrantIds, rootPath, this.grants);
          record.projectWorkspaces[assignment.projectId] = matchingManual ?? await this.createProjectGrant(rootPath, createdGrantIds);
          record.version += 1;
          record.updatedAt = new Date().toISOString();
          changed.add(partnerId);
        }
        if (changed.size) await this.writeUnlocked(data);
      });
    } catch (error) {
      await this.rollbackProjectGrants(createdGrantIds, error);
    }
    for (const partnerId of changed) await this.notify(partnerId);
    return Promise.all([...changed].map((partnerId) => this.configuredState(partnerId)));
  }

  async deletePartner(partnerId: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      if (!data.partners[partnerId]) return;
      delete data.partners[partnerId];
      await this.writeUnlocked(data);
    });
    await this.notify(partnerId);
  }

  private async assertGrantIdsAllowed(grantIds: Array<string | undefined>) {
    for (const grantId of uniqueValues(grantIds.filter((value): value is string => Boolean(value)))) {
      const grantedPath = await this.grants.get(grantId);
      if (grantedPath) await assertCanonicalPathOutsideProtectedRoots(grantedPath, this.protectedRoots);
    }
  }

  private async createProjectGrant(rootPath: string, createdGrantIds: string[]) {
    const grant = await this.grants.add(rootPath);
    createdGrantIds.push(grant.grantId);
    return grant.grantId;
  }

  private async rollbackProjectGrants(grantIds: string[], cause: unknown): Promise<never> {
    try {
      await this.grants.deleteMany(grantIds);
    } catch (rollbackError) {
      throw new AggregateError([cause, rollbackError], 'PROJECT_WORKSPACE_GRANT_COMPENSATION_FAILED', { cause: rollbackError });
    }
    throw cause;
  }

  private async notify(partnerId: string) {
    const state = await this.configuredState(partnerId);
    for (const listener of this.listeners) await listener(state);
    return state;
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: PartnerWorkspaceFile) { return this.storage.writeNow(data); }

  private mutate<T>(operation: () => Promise<T>) {
    return this.storage.runExclusive(operation);
  }
}

function decodePartnerWorkspaceFile(parsed: unknown): PartnerWorkspaceFile {
  if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) throw new Error('PARTNER_WORKSPACE_STORE_INVALID');
  if (parsed.version === 2 && isRecord(parsed.partners)) return parsed as unknown as PartnerWorkspaceFile;
  if (parsed.version === 1 && isRecord(parsed.partners)) {
    const partners: Record<string, PartnerWorkspaceRecord> = {};
    for (const [partnerId, raw] of Object.entries(parsed.partners)) {
      if (!isRecord(raw)) continue;
      partners[partnerId] = {
        partnerId,
        ...(typeof raw.cwdGrantId === 'string' ? { cwdGrantId: raw.cwdGrantId } : {}),
        manualWorkspaceGrantIds: Array.isArray(raw.workspaceGrantIds) ? raw.workspaceGrantIds.filter((id): id is string => typeof id === 'string') : [],
        projectWorkspaces: {},
        version: typeof raw.version === 'number' ? raw.version : 1,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      };
    }
    return { version: 2, partners };
  }
  // Compatibility for the short-lived conversation-keyed prototype: collapse
  // records by partner and union their extra grants. The first CWD wins.
  if (isRecord(parsed.conversations)) {
    const partners: Record<string, PartnerWorkspaceRecord> = {};
    for (const value of Object.values(parsed.conversations)) {
      if (!isRecord(value) || typeof value.partnerId !== 'string' || !Array.isArray(value.workspaceGrantIds)) continue;
      const existing = partners[value.partnerId];
      const ids = value.workspaceGrantIds.filter((id): id is string => typeof id === 'string');
      if (existing) {
        existing.manualWorkspaceGrantIds = uniqueValues([...existing.manualWorkspaceGrantIds, ...ids]);
        continue;
      }
      partners[value.partnerId] = {
        partnerId: value.partnerId,
        ...(typeof value.cwdGrantId === 'string' ? { cwdGrantId: value.cwdGrantId } : {}),
        manualWorkspaceGrantIds: uniqueValues(ids.filter((id) => id !== value.cwdGrantId)),
        projectWorkspaces: {},
        version: typeof value.version === 'number' ? value.version : 1,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      };
    }
    return { version: 2, partners };
  }
  throw new Error('PARTNER_WORKSPACE_STORE_INVALID');
}

function emptySnapshot(permissionMode: PermissionMode): WorkspaceSnapshot {
  return { workspaceFolders: [], permissionMode, workspaceVersion: 0, managementTool: { name: 'asterium_workspace', actions: ['list', 'add', 'remove'] }, unavailableFolders: [], workspaceSources: [] };
}

async function findMatchingGrant(grantIds: string[], targetPath: string, grants: WorkspaceGrantStore) {
  for (const grantId of grantIds) {
    const grantedPath = await grants.get(grantId);
    if (grantedPath && samePath(grantedPath, targetPath)) return grantId;
  }
  return undefined;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function samePath(left: string, right: string) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}

function isReportedAbsolutePath(value: string) {
  const input = value.trim();
  if (/^file:/i.test(input)) return true;
  if (process.platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(input)
    || /^[/\\](?:mnt[/\\])?[a-zA-Z][/\\]/.test(input)
    || /^(?:\\\\|\/\/)/.test(input);
  return path.isAbsolute(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
