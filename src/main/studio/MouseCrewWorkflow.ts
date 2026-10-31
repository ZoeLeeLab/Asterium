import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MOUSECREW_COMMIT = 'a405854543eeb3a8c18800d17b07455b0f9bf2d6';

export type StudioWorkflowStage = 'discovery' | 'design' | 'implementation' | 'integration' | 'delivery';

const STAGE_REFERENCES: Record<StudioWorkflowStage, string[]> = {
  discovery: ['references/requirements.md', 'references/workflow.md'],
  design: ['references/visual-assets.md'],
  implementation: ['references/implementation.md'],
  integration: ['references/integration.md'],
  delivery: ['references/delivery.md'],
};

export interface StudioWorkflowContext {
  projectName: string;
  projectRole: string;
  responsibilities: string;
  stage: StudioWorkflowStage;
}

export class MouseCrewWorkflow {
  constructor(private readonly sourceRoot: string) {}

  static developmentRoot(repositoryRoot = process.cwd()) {
    return path.join(repositoryRoot, 'third_party', 'mousecrew', 'a4058545', 'skills', 'frontend-builder');
  }

  static packagedRoot(resourcesPath: string) {
    return path.join(resourcesPath, 'mousecrew', 'a4058545', 'skills', 'frontend-builder');
  }

  referencesFor(stage: StudioWorkflowStage) {
    return [...STAGE_REFERENCES[stage]];
  }

  async load(context: StudioWorkflowContext) {
    const sourceFiles = ['SKILL.md', ...this.referencesFor(context.stage)];
    const sections = await Promise.all(sourceFiles.map(async (relativePath) => ({
      relativePath,
      content: await readFile(path.join(this.sourceRoot, ...relativePath.split('/')), 'utf8'),
    })));
    return {
      source: { project: 'MouseCrew', commit: MOUSECREW_COMMIT, files: sourceFiles },
      prompt: `${adapterBoundary(context)}\n\n${sections.map((section) => `# MouseCrew: ${section.relativePath}\n\n${section.content}`).join('\n\n')}`,
    };
  }
}

function adapterBoundary(context: StudioWorkflowContext) {
  return [
    '# 星丛工作室边界',
    `项目：${context.projectName}`,
    `当前阶段：${context.stage}`,
    `本项目临时身份：${context.projectRole}`,
    `本项目职责：${context.responsibilities}`,
    '',
    '- MouseCrew 原文只提供工作方法；星丛的项目身份、权限、记忆与文件边界始终优先。',
    '- 上述身份和职责只属于当前项目，退出项目后失效。',
    '- 除项目情况外，不得把项目身份、职责或分工写入伙伴私人记忆。',
    '- 仅加载当前阶段列出的原始参考文件，不把整个技能一次性注入上下文。',
  ].join('\n');
}
