import { randomUUID } from 'node:crypto';
import type { ProjectRecord, ProjectTaskCompletionRule } from '../../shared/projectDomain';
import { projectWorkRoleSnapshot, type ProjectWorkRoleDefinition } from '../../shared/projectRoles';
import {
  projectMethodTemplateSnapshot,
  type ProjectMethodTemplateDefinition,
  type ProjectWorkflowDraftNode,
  type ProjectWorkflowTemplate,
  type ProjectWorkflowTemplateSummary,
} from '../../shared/projectWorkflows';

export const MOUSECREW_TEMPLATE_COMMIT = 'a405854543eeb3a8c18800d17b07455b0f9bf2d6';
const MOUSECREW_ATTRIBUTION = `MouseCrew frontend-builder @ ${MOUSECREW_TEMPLATE_COMMIT} (MIT); native Asterium adaptation`;

export const BUILTIN_PROJECT_METHOD_TEMPLATES: readonly ProjectMethodTemplateDefinition[] = [
  method('method-solution-boundary', '方案与边界检查', '在实现前固定目标、非目标、权威数据源、接口和恢复边界。', [
    '先核对现有实现与冻结任务，再给出最小充分方案。',
    '明确权威数据源、跨层接口、失败恢复与验证方法。',
    '不引入平行体系，不把偏好性改造变成新需求。',
  ]),
  method('method-implementation-self-check', '实现与自检', '完成冻结范围并以真实证据自检。', [
    '只修改当前任务需要的内容，保留兼容与用户数据。',
    '覆盖主要成功路径、关键失败路径和与改动风险相称的回归。',
    '将自检明确标记为自检，不冒充独立复核。',
  ]),
  method('method-independent-verification', '独立验证', '围绕冻结验收标准产生可复现结论。', [
    '逐项检查验收标准，区分已验证、未通过、证据不足和环境受限。',
    '不为让测试通过而改写冻结契约或扩大实现范围。',
  ]),
  method('method-delivery-readiness', '交付整理', '核对正式文件、验证证据、运行入口和已知限制。', [
    '整理当前唯一有效交付物、可重跑的验证与未解决问题。',
    '截图、构建通过或测试数量不能单独证明产品完成。',
  ]),
  mouseMethod('method-mousecrew-discovery', 'MouseCrew 目标与范围', '从设备、使用方式、功能与偏好中提炼目标和关键取舍。', 'requirements.md + workflow.md'),
  mouseMethod('method-mousecrew-design', 'MouseCrew UX/UI 方案', '以具备 UX/UI 设计能力的产品实现角度，形成可验收的页面结构、代表页与设计配方。', 'visual-assets.md'),
  mouseMethod('method-mousecrew-implementation', 'MouseCrew 实现', '沿用已确认的设计配方贯通核心链路，补齐必要状态并自检。', 'implementation.md'),
  mouseMethod('method-mousecrew-integration', 'MouseCrew 集成验证', '核对持久化、接口、权限和异步链路，验证真实可用性。', 'integration.md'),
  mouseMethod('method-mousecrew-delivery', 'MouseCrew 交付', '以可用核心链路、可维护产物、设计配方、资产与明确限制共同判断交付。', 'delivery.md'),
] as const;

interface WorkflowTemplateNodeSpec {
  key: string;
  title: string;
  description: string;
  roleId: string;
  methodId?: string;
  dependsOn?: string[];
  acceptanceCriteria: string[];
  completionRule: ProjectTaskCompletionRule;
}

interface WorkflowTemplateSpec extends ProjectWorkflowTemplateSummary {
  nodes: WorkflowTemplateNodeSpec[];
}

const BUILTIN_WORKFLOW_TEMPLATES: readonly WorkflowTemplateSpec[] = [
  template('blank', '空白流程', '从空白 DAG 开始，自由增加与组织步骤。', []),
  template('quick-implementation', '快速实现', '单一实现与自检步骤，交付后等待用户最终确认。', [
    node('implement', '实现并自检', '在冻结范围内完成实现、验证与正式交付。', 'builtin-implementation-engineer', 'method-implementation-self-check', [], ['冻结范围已实现', '关键验证有可核对证据', '交付物与已知限制已说明'], { type: 'user_confirm' }),
  ]),
  template('standard-development', '标准开发', '方案、实现、独立验证与交付整理组成的可编辑 DAG。', [
    node('plan', '方案与边界', '核对现状，形成可实施且可验收的方案。', 'builtin-solution-design', 'method-solution-boundary', [], ['目标、非目标与约束明确', '权威数据源、接口与恢复边界明确', '验证方法可执行'], { type: 'executor_submit' }),
    node('implement', '实现与自检', '根据已完成的方案实现并运行相称验证。', 'builtin-implementation-engineer', 'method-implementation-self-check', ['plan'], ['实现符合已确认边界', '主要成功与失败路径已自检', '变更与证据可追溯'], { type: 'executor_submit' }),
    node('verify', '独立验证', '不扩大范围地核对交付与验收标准。', 'builtin-test-engineer', 'method-independent-verification', ['implement'], ['验收标准均有明确结论', '失败、未验证与环境限制已区分', '结论可复现'], { type: 'executor_submit' }),
    node('deliver', '交付整理', '整理正式交付、验证和已知限制，等待用户最终验收。', 'builtin-general-executor', 'method-delivery-readiness', ['verify'], ['当前有效交付物明确', '验证入口与结果明确', '未解决问题与已知限制明确'], { type: 'user_confirm' }),
  ]),
  template('mousecrew-example', 'MouseCrew 示例流程', '将固定来源的 frontend-builder 方法转为星丛原生 DAG，运行时不读取第三方原文。', [
    node('scope', '目标与范围', '主动整理设备、使用方式、功能、偏好与关键取舍。', 'builtin-requirements-planning', 'method-mousecrew-discovery', [], ['用户目标与重要取舍明确', '已确认需求与可撤回假设已区分'], { type: 'executor_submit' }),
    node('design', 'UX/UI 方案', '形成页面结构、代表页方向和可复用设计配方。', 'builtin-solution-design', 'method-mousecrew-design', ['scope'], ['页面与核心交互结构明确', '视觉与组件配方可复用'], { type: 'executor_submit' }),
    node('implement', '实现核心链路', '以具备 UX/UI 设计能力的前端工程师角度贯通真实功能。', 'builtin-ux-ui-frontend', 'method-mousecrew-implementation', ['design'], ['核心使用链路可实际运行', '已确认设计配方被一致实现', '必要状态和错误处理完整'], { type: 'executor_submit' }),
    node('integrate', '集成验证', '验证持久化、接口、权限、异步与设备体验。', 'builtin-test-engineer', 'method-mousecrew-integration', ['implement'], ['真实核心链路通过', '跨层契约与失败路径已验证'], { type: 'executor_submit' }),
    node('deliver', '验收与交付', '整理可用产物、资产、设计配方、验证与限制。', 'builtin-general-executor', 'method-mousecrew-delivery', ['integrate'], ['可用产物与运行入口明确', '设计配方、资产和验证可追溯', '已知限制与待用户决定项明确'], { type: 'user_confirm' }),
  ], MOUSECREW_ATTRIBUTION),
] as const;

export function projectWorkflowCatalog() {
  return {
    version: 1 as const,
    templates: BUILTIN_WORKFLOW_TEMPLATES.map(({ nodes, ...summary }) => ({ ...summary, kind: 'builtin' as const, nodeCount: nodes.length })),
    methods: BUILTIN_PROJECT_METHOD_TEMPLATES.map((method) => structuredClone(method)),
  };
}

export function projectWorkflowTemplateSummary(template: ProjectWorkflowTemplate): ProjectWorkflowTemplateSummary {
  return {
    id: template.id,
    version: String(template.revision),
    name: template.name,
    description: template.description,
    nodeCount: template.nodes.length,
    kind: 'project',
    projectId: template.projectId,
    revision: template.revision,
  };
}

export function instantiateSavedProjectWorkflowTemplate(
  template: ProjectWorkflowTemplate,
  roles: ProjectWorkRoleDefinition[],
  project: Pick<ProjectRecord, 'memberIds'>,
) {
  const nodeIds = new Map(template.nodes.map((item) => [item.id, randomUUID()]));
  const warnings: string[] = [];
  const roleById = new Map(roles.filter((role) => !role.archivedAt).map((role) => [role.id, role]));
  const nodes = template.nodes.map((item, position) => {
    const execution = item.execution ? structuredClone(item.execution) : undefined;
    let assigneeId = item.assigneeId;
    if (assigneeId && !project.memberIds.includes(assigneeId)) {
      warnings.push(`“${item.title}”的原执行伙伴已不在项目中，请重新选择。`);
      assigneeId = undefined;
    }
    if (execution?.workRole?.roleId) {
      const current = roleById.get(execution.workRole.roleId);
      if (current) execution.workRole = projectWorkRoleSnapshot(current);
      else {
        warnings.push(`“${item.title}”的执行角色已不可用，请重新选择。`);
        delete execution.workRole;
      }
    }
    if (execution?.reviewWorkRole?.roleId) {
      const current = roleById.get(execution.reviewWorkRole.roleId);
      if (current) execution.reviewWorkRole = projectWorkRoleSnapshot(current);
      else {
        warnings.push(`“${item.title}”的复核角色已不可用，请重新选择。`);
        delete execution.reviewWorkRole;
      }
    }
    if (execution?.completionRule?.type === 'partner_review') {
      const reviewerId = execution.completionRule.reviewerPartnerId;
      if (!project.memberIds.includes(reviewerId) || reviewerId === assigneeId) {
        warnings.push(`“${item.title}”的独立复核伙伴已不可用，已改为等待用户确认。`);
        execution.completionRule = { type: 'user_confirm' };
        delete execution.reviewWorkRole;
      }
    }
    return {
      ...item,
      id: nodeIds.get(item.id)!,
      position,
      ...(assigneeId ? { assigneeId } : { assigneeId: undefined }),
      dependencyNodeIds: item.dependencyNodeIds.map((id) => nodeIds.get(id)!),
      ...(execution && Object.keys(execution).length ? { execution } : { execution: undefined }),
    };
  });
  return { template: projectWorkflowTemplateSummary(template), nodes, warnings: [...new Set(warnings)] };
}

export function instantiateProjectWorkflowTemplate(templateId: string, roles: ProjectWorkRoleDefinition[]) {
  const template = BUILTIN_WORKFLOW_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error('PROJECT_WORKFLOW_TEMPLATE_NOT_FOUND');
  const nodeIds = new Map(template.nodes.map((item) => [item.key, randomUUID()]));
  const nodes: ProjectWorkflowDraftNode[] = template.nodes.map((item, position) => {
    const role = roles.find((candidate) => candidate.id === item.roleId && !candidate.archivedAt);
    if (!role) throw new Error('PROJECT_WORKFLOW_TEMPLATE_ROLE_MISSING');
    const methodDefinition = item.methodId ? BUILTIN_PROJECT_METHOD_TEMPLATES.find((candidate) => candidate.templateId === item.methodId) : undefined;
    if (item.methodId && !methodDefinition) throw new Error('PROJECT_WORKFLOW_TEMPLATE_METHOD_MISSING');
    return {
      id: nodeIds.get(item.key)!, position, title: item.title, description: item.description,
      dependencyNodeIds: (item.dependsOn ?? []).map((key) => nodeIds.get(key)!),
      acceptanceCriteria: [...item.acceptanceCriteria], note: '',
      execution: {
        workRole: projectWorkRoleSnapshot(role),
        completionRule: structuredClone(item.completionRule),
        ...(methodDefinition ? { methodTemplate: projectMethodTemplateSnapshot(methodDefinition) } : {}),
      },
    };
  });
  return {
    template: {
      id: template.id, version: template.version, name: template.name, description: template.description,
      nodeCount: template.nodes.length,
      ...(template.sourceAttribution ? { sourceAttribution: template.sourceAttribution } : {}),
    },
    nodes,
  };
}

export function validateProjectMethodTemplate(value: ProjectTaskExecutionConfigMethod, existing?: ProjectTaskExecutionConfigMethod) {
  if (existing && JSON.stringify(value) === JSON.stringify(existing)) return structuredClone(existing);
  const definition = BUILTIN_PROJECT_METHOD_TEMPLATES.find((item) => item.templateId === value.templateId && item.version === value.version);
  if (!definition) throw new Error('PROJECT_METHOD_TEMPLATE_NOT_SELECTABLE');
  const expected = projectMethodTemplateSnapshot(definition);
  if (JSON.stringify(expected) !== JSON.stringify(value)) throw new Error('PROJECT_METHOD_TEMPLATE_SNAPSHOT_STALE');
  return expected;
}

type ProjectTaskExecutionConfigMethod = NonNullable<import('../../shared/projectDomain').ProjectTaskExecutionConfig['methodTemplate']>;

function method(id: string, name: string, description: string, instructions: string[]): ProjectMethodTemplateDefinition {
  return { templateId: id, name, version: '1', description, instructions: instructions.join('\n') };
}

function mouseMethod(id: string, name: string, description: string, reference: string): ProjectMethodTemplateDefinition {
  return {
    templateId: id, name, version: '1', description,
    instructions: `${description}\n已确认方向持续有效；只在影响当前交付的关键取舍未定时等待用户，不重复索要例行确认。`,
    sourceAttribution: `${MOUSECREW_ATTRIBUTION}; reference: ${reference}`,
  };
}

function template(id: string, name: string, description: string, nodes: WorkflowTemplateNodeSpec[], sourceAttribution?: string): WorkflowTemplateSpec {
  return { id, version: '1', name, description, nodeCount: nodes.length, kind: 'builtin', nodes, ...(sourceAttribution ? { sourceAttribution } : {}) };
}

function node(
  key: string,
  title: string,
  description: string,
  roleId: string,
  methodId: string | undefined,
  dependsOn: string[],
  acceptanceCriteria: string[],
  completionRule: ProjectTaskCompletionRule,
): WorkflowTemplateNodeSpec {
  return { key, title, description, roleId, ...(methodId ? { methodId } : {}), dependsOn, acceptanceCriteria, completionRule };
}
