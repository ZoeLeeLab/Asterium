import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkRoleStore } from '../../src/main/project/ProjectWorkRoleStore';
import {
  BUILTIN_PROJECT_METHOD_TEMPLATES,
  MOUSECREW_TEMPLATE_COMMIT,
  instantiateProjectWorkflowTemplate,
  projectWorkflowCatalog,
} from '../../src/main/project/ProjectWorkflowTemplates';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function roles() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-template-'));
  temporary.push(root);
  return (await new ProjectWorkRoleStore(path.join(root, 'roles.json')).catalog('project-a')).roles;
}

describe('ProjectWorkflowTemplates', () => {
  it('publishes four native, editable templates without partner assignments', async () => {
    const catalog = projectWorkflowCatalog();
    expect(catalog.templates.map((template) => template.id)).toEqual([
      'blank', 'quick-implementation', 'standard-development', 'mousecrew-example',
    ]);

    for (const template of catalog.templates) {
      const instantiated = instantiateProjectWorkflowTemplate(template.id, await roles());
      expect(instantiated.nodes).toHaveLength(template.nodeCount);
      expect(instantiated.nodes.every((node) => node.assigneeId === undefined)).toBe(true);
      expect(instantiated.nodes.map((node) => node.position)).toEqual(instantiated.nodes.map((_, index) => index));
    }
  });

  it('keeps standard and MouseCrew intermediate steps automatic and the final step user-owned', async () => {
    const availableRoles = await roles();
    for (const templateId of ['standard-development', 'mousecrew-example']) {
      const { nodes } = instantiateProjectWorkflowTemplate(templateId, availableRoles);
      expect(nodes.slice(0, -1).every((node) => node.execution?.completionRule?.type === 'executor_submit')).toBe(true);
      expect(nodes.at(-1)?.execution?.completionRule).toEqual({ type: 'user_confirm' });
      expect(nodes.slice(1).every((node) => node.dependencyNodeIds.length > 0)).toBe(true);
    }
  });

  it('adapts MouseCrew into frozen native snapshots without importing its runtime workflow', async () => {
    const { nodes, template } = instantiateProjectWorkflowTemplate('mousecrew-example', await roles());
    expect(template.sourceAttribution).toContain(MOUSECREW_TEMPLATE_COMMIT);
    expect(nodes.every((node) => node.execution?.workRole?.roleId && node.execution?.workRole?.roleRevision)).toBe(true);
    expect(nodes.every((node) => node.execution?.methodTemplate?.sourceAttribution?.includes(MOUSECREW_TEMPLATE_COMMIT))).toBe(true);
    expect(BUILTIN_PROJECT_METHOD_TEMPLATES.filter((method) => method.templateId.startsWith('method-mousecrew-'))).toHaveLength(5);

    const moduleSource = await readFile(path.join(process.cwd(), 'src/main/project/ProjectWorkflowTemplates.ts'), 'utf8');
    expect(moduleSource).not.toContain("from './MouseCrewWorkflow'");
    expect(moduleSource).not.toContain("from \"./MouseCrewWorkflow\"");
  });
});
