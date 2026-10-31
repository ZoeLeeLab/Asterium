import { randomUUID } from 'node:crypto';
import type { ProjectTaskWorkRole } from '../../shared/projectDomain';
import {
  DEFAULT_PROJECT_WORK_ROLE_GROUP,
  projectWorkRoleSnapshot,
  type ProjectWorkRoleArchiveRequest,
  type ProjectWorkRoleCatalog,
  type ProjectWorkRoleChange,
  type ProjectWorkRoleCreateRequest,
  type ProjectWorkRoleDefinition,
  type ProjectWorkRoleRemoveRequest,
  type ProjectWorkRoleUpdateRequest,
} from '../../shared/projectRoles';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface ProjectWorkRoleFile {
  version: 1;
  roles: ProjectWorkRoleDefinition[];
}

const BUILTIN_CREATED_AT = '2026-10-16T00:00:00.000Z';

export const BUILTIN_PROJECT_WORK_ROLES: readonly ProjectWorkRoleDefinition[] = [
  builtin('builtin-general-executor', '项目中期', '通用任务执行', '按冻结任务契约完成工作并提供可核验证据。', ['完成冻结任务契约', '逐项核对验收标准', '提交结构化交付与未解决问题'], '以当前任务范围为唯一目标，选择与现有项目相容的最小充分实现。'),
  builtin('builtin-requirements-planning', '项目准备', '需求规划', '澄清目标、范围、约束和真正需要用户决定的问题。', ['整理已确认目标与非目标', '识别关键约束与依赖', '形成可执行且可验收的任务边界'], '主动补齐普通分析工作；不得把推测写成用户要求，也不得自行扩大范围。'),
  builtin('builtin-solution-design', '项目前期', '方案设计', '把冻结需求转成可实施、可验证的技术或产品方案。', ['核对现状与约束', '明确数据、接口和失败恢复边界', '说明取舍与验证方法'], '优先复用现有体系，避免平行真源、临时绕路和无依据的复杂化。'),
  builtin('builtin-implementation-engineer', '项目中期', '实现工程师', '在冻结范围内完成实现、测试和准确交付。', ['实现冻结范围', '保持既有数据与兼容边界', '运行与风险相称的验证'], '先理解现有实现再修改；不顺手重构无关部分，不把自检冒充独立复核。'),
  builtin('builtin-test-engineer', '项目中期', '测试工程师', '围绕验收标准设计并执行有信息量的验证。', ['覆盖主要成功和失败路径', '记录可复现证据', '区分已验证、未验证和受环境限制的结论'], '测试结论必须来自实际证据；不得为了让测试通过而改变冻结需求。'),
  builtin('builtin-architecture-audit', '项目收尾', '架构审计', '检查权威数据源、边界、状态流转和恢复能力。', ['核对所有权与持久化位置', '检查接口和失败恢复链路', '指出可证实的架构风险'], '只依据冻结范围和可见证据判断，不创造新需求。'),
  builtin('builtin-decoupling-audit', '项目收尾', '解耦审计', '检查模块职责、依赖方向和不必要耦合。', ['识别重复真源和跨层泄漏', '检查依赖方向与替换边界', '给出范围内的最小调整建议'], '不要把偏好性重构包装成验收缺陷；只报告与当前契约直接相关的问题。'),
  builtin('builtin-research', '项目准备', '资料研究', '收集可信资料并形成可追溯、与任务相关的结论。', ['区分事实、来源和推断', '优先权威与一手资料', '只交付当前任务需要的信息'], '不得引入其他伙伴的私人上下文，也不得用无关资料扩张任务。'),
  builtin('builtin-ux-ui-frontend', '项目前期', 'UX/UI 前端工程师', '在既定产品和视觉边界内实现可用、一致的前端体验。', ['沿用已确认的交互与设计配方', '贯通真实核心链路与必要状态', '验证可用性、响应式与既有工程边界'], '先理解现有界面、设计资产和工程约束；不发明未要求的业务功能或视觉风格。'),
  builtin('builtin-independent-review', '项目收尾', '独立复核', '只按冻结验收标准检查候选交付并提交结构化结论。', ['逐项核对验收标准与证据', '把证据不足标为未验证', '提交通过、调整或需要用户决定的结论'], '不得修改实现、任务契约或交付物；项目共享权限不等于复核修改授权。'),
] as const;

export class ProjectWorkRoleStore {
  private readonly storage: AtomicJsonStore<ProjectWorkRoleFile>;
  private readonly listeners = new Set<(change: ProjectWorkRoleChange) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, roles: [] }),
      decode: decodeFile,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (change: ProjectWorkRoleChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async catalog(projectId: string): Promise<ProjectWorkRoleCatalog> {
    validateProjectId(projectId);
    const current = await this.storage.read();
    return {
      version: 1,
      projectId,
      roles: structuredClone([
        ...BUILTIN_PROJECT_WORK_ROLES,
        ...current.roles.filter((role) => role.scope === 'global' || role.projectId === projectId),
      ]),
    };
  }

  async validateSnapshot(projectId: string, value: ProjectTaskWorkRole) {
    validateProjectId(projectId);
    if (value.scope === 'inline' && !value.roleId && value.roleRevision === undefined) return structuredClone(value);
    if (!value.roleId || !positiveRevision(value.roleRevision)) throw new Error('PROJECT_WORK_ROLE_SNAPSHOT_INVALID');
    const current = await this.storage.read();
    const definition = [...BUILTIN_PROJECT_WORK_ROLES, ...current.roles].find((role) => role.id === value.roleId);
    if (!definition || definition.archivedAt || (definition.scope === 'project' && definition.projectId !== projectId)) {
      throw new Error('PROJECT_WORK_ROLE_NOT_SELECTABLE');
    }
    const expected = projectWorkRoleSnapshot(definition);
    if (!sameSnapshot(expected, value)) throw new Error('PROJECT_WORK_ROLE_SNAPSHOT_STALE');
    return expected;
  }

  create(request: ProjectWorkRoleCreateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const now = new Date().toISOString();
      const role = cleanDefinition({
        version: 1,
        id: randomUUID(),
        scope: request.scope,
        ...(request.scope === 'project' ? { projectId: requireProjectId(request.projectId) } : {}),
        group: request.group ?? DEFAULT_PROJECT_WORK_ROLE_GROUP,
        name: request.name,
        description: request.description ?? '',
        responsibilities: request.responsibilities,
        prompt: request.prompt ?? '',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.storage.writeNow({ version: 1, roles: [...current.roles, role] });
      this.notify(role);
      return structuredClone(role);
    });
  }

  update(request: ProjectWorkRoleUpdateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireCustomRole(current, request.roleId, request.expectedRevision);
      const role = cleanDefinition({
        ...existing,
        group: request.group ?? existing.group,
        name: request.name,
        description: request.description ?? '',
        responsibilities: request.responsibilities,
        prompt: request.prompt ?? '',
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.storage.writeNow({ version: 1, roles: current.roles.map((item) => item.id === role.id ? role : item) });
      this.notify(role);
      return structuredClone(role);
    });
  }

  setArchived(request: ProjectWorkRoleArchiveRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireCustomRole(current, request.roleId, request.expectedRevision);
      const now = new Date().toISOString();
      const role = cleanDefinition({
        ...existing,
        ...(request.archived ? { archivedAt: now } : {}),
        revision: existing.revision + 1,
        updatedAt: now,
      });
      if (!request.archived) delete role.archivedAt;
      await this.storage.writeNow({ version: 1, roles: current.roles.map((item) => item.id === role.id ? role : item) });
      this.notify(role);
      return structuredClone(role);
    });
  }

  remove(request: ProjectWorkRoleRemoveRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireCustomRole(current, request.roleId, request.expectedRevision);
      await this.storage.writeNow({ version: 1, roles: current.roles.filter((item) => item.id !== existing.id) });
      this.notify(existing);
    });
  }

  async projectRoles(projectId: string) {
    validateProjectId(projectId);
    const current = await this.storage.read();
    return structuredClone(current.roles.filter((role) => role.scope === 'project' && role.projectId === projectId));
  }

  removeProject(projectId: string) {
    validateProjectId(projectId);
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const removed = current.roles.filter((role) => role.scope === 'project' && role.projectId === projectId);
      if (!removed.length) return [];
      await this.storage.writeNow({ version: 1, roles: current.roles.filter((role) => role.scope !== 'project' || role.projectId !== projectId) });
      this.notify({ scope: 'project', projectId });
      return structuredClone(removed);
    });
  }

  restoreProject(projectId: string, roles: ProjectWorkRoleDefinition[]) {
    validateProjectId(projectId);
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = roles.map((role) => {
        const decoded = cleanDefinition(role);
        if (decoded.scope !== 'project' || decoded.projectId !== projectId) throw new Error('PROJECT_WORK_ROLE_SCOPE_INVALID');
        return decoded;
      });
      await this.storage.writeNow({
        version: 1,
        roles: [...current.roles.filter((role) => role.scope !== 'project' || role.projectId !== projectId), ...restored],
      });
      this.notify({ scope: 'project', projectId });
    });
  }

  private notify(value: ProjectWorkRoleDefinition | { scope: 'project'; projectId: string }) {
    const change: ProjectWorkRoleChange = value.scope === 'global'
      ? { type: 'changed', scope: 'global' }
      : { type: 'changed', scope: 'project', projectId: value.projectId };
    for (const listener of this.listeners) listener(structuredClone(change));
  }
}

function builtin(id: string, group: string, name: string, description: string, responsibilities: string[], prompt: string): ProjectWorkRoleDefinition {
  return { version: 1, id, scope: 'builtin', group, name, description, responsibilities, prompt, revision: 1, createdAt: BUILTIN_CREATED_AT, updatedAt: BUILTIN_CREATED_AT };
}

function decodeFile(value: unknown): ProjectWorkRoleFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.roles)) throw new Error('PROJECT_WORK_ROLE_STORE_INVALID');
  const roles = value.roles.map(cleanDefinition);
  if (roles.some((role) => role.scope === 'builtin') || new Set(roles.map((role) => role.id)).size !== roles.length) throw new Error('PROJECT_WORK_ROLE_STORE_INVALID');
  return { version: 1, roles };
}

function cleanDefinition(value: unknown): ProjectWorkRoleDefinition {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || (value.scope !== 'global' && value.scope !== 'project' && value.scope !== 'builtin')
    || typeof value.name !== 'string' || typeof value.description !== 'string' || !Array.isArray(value.responsibilities)
    || typeof value.prompt !== 'string' || !positiveRevision(value.revision)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('PROJECT_WORK_ROLE_STORE_INVALID');
  validateRoleId(value.id);
  const responsibilities = cleanList(value.responsibilities, 24, 1_000);
  if (!responsibilities.length) throw new Error('PROJECT_WORK_ROLE_RESPONSIBILITIES_REQUIRED');
  const projectId = value.scope === 'project' ? requireProjectId(value.projectId) : undefined;
  if (value.scope !== 'project' && value.projectId !== undefined) throw new Error('PROJECT_WORK_ROLE_SCOPE_INVALID');
  if (value.archivedAt !== undefined && typeof value.archivedAt !== 'string') throw new Error('PROJECT_WORK_ROLE_STORE_INVALID');
  return {
    version: 1,
    id: value.id,
    scope: value.scope,
    ...(projectId ? { projectId } : {}),
    group: cleanRequired(typeof value.group === 'string' ? value.group : DEFAULT_PROJECT_WORK_ROLE_GROUP, 60, 'PROJECT_WORK_ROLE_GROUP_INVALID'),
    name: cleanRequired(value.name, 80, 'PROJECT_WORK_ROLE_NAME_INVALID'),
    description: cleanOptional(value.description, 2_000),
    responsibilities,
    prompt: cleanOptional(value.prompt, 20_000),
    revision: value.revision,
    ...(value.archivedAt ? { archivedAt: validDate(value.archivedAt) } : {}),
    createdAt: validDate(value.createdAt),
    updatedAt: validDate(value.updatedAt),
  };
}

function requireCustomRole(file: ProjectWorkRoleFile, roleId: string, expectedRevision: number) {
  validateRoleId(roleId);
  const role = file.roles.find((item) => item.id === roleId);
  if (!role) throw new Error('PROJECT_WORK_ROLE_NOT_FOUND');
  if (role.revision !== expectedRevision) throw new Error('PROJECT_WORK_ROLE_REVISION_CONFLICT');
  return role;
}

function sameSnapshot(left: ProjectTaskWorkRole, right: ProjectTaskWorkRole) {
  return left.roleId === right.roleId && left.roleRevision === right.roleRevision && left.name === right.name
    && left.scope === right.scope && (left.description ?? '') === (right.description ?? '') && (left.prompt ?? '') === (right.prompt ?? '')
    && left.responsibilities.length === right.responsibilities.length
    && left.responsibilities.every((item, index) => item === right.responsibilities[index]);
}

function cleanRequired(value: string, max: number, code: string) {
  const cleaned = value.trim().slice(0, max);
  if (!cleaned) throw new Error(code);
  return cleaned;
}

function cleanOptional(value: string, max: number) {
  return value.trim().slice(0, max);
}

function cleanList(value: unknown[], maxItems: number, maxLength: number) {
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, maxLength)))].slice(0, maxItems);
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error('PROJECT_WORK_ROLE_STORE_INVALID');
  return value;
}

function requireProjectId(value: unknown) {
  if (typeof value !== 'string') throw new Error('PROJECT_WORK_ROLE_PROJECT_REQUIRED');
  validateProjectId(value);
  return value;
}

function validateProjectId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('INVALID_PROJECT_ID');
}

function validateRoleId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/.test(value)) throw new Error('PROJECT_WORK_ROLE_ID_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
