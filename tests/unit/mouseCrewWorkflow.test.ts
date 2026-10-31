import { describe, expect, it } from 'vitest';
import { MouseCrewWorkflow, MOUSECREW_COMMIT } from '../../src/main/studio/MouseCrewWorkflow';

describe('MouseCrewWorkflow', () => {
  it('loads only the upstream files needed by the active stage and prepends Asterium boundaries', async () => {
    const workflow = new MouseCrewWorkflow(MouseCrewWorkflow.developmentRoot());
    const loaded = await workflow.load({ projectName: '星丛前端', projectRole: '前端搭建伙伴', responsibilities: '实现并验证界面', stage: 'implementation' });

    expect(loaded.source).toEqual({ project: 'MouseCrew', commit: MOUSECREW_COMMIT, files: ['SKILL.md', 'references/implementation.md'] });
    expect(loaded.prompt).toContain('本项目临时身份：前端搭建伙伴');
    expect(loaded.prompt).toContain('不得把项目身份、职责或分工写入伙伴私人记忆');
    expect(loaded.prompt).toContain('# MouseCrew: references/implementation.md');
    expect(loaded.prompt).not.toContain('# MouseCrew: references/delivery.md');
  });
});
