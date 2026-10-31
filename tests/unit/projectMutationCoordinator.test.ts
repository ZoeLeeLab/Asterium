import { describe, expect, it } from 'vitest';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';

describe('ProjectMutationCoordinator', () => {
  it('serializes project metadata and delivery mutations through one lifecycle boundary', async () => {
    const coordinator = new ProjectMutationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run(async () => {
      events.push('project-start');
      await firstGate;
      events.push('project-end');
    });
    const second = coordinator.run(async () => {
      events.push('delivery-start');
      events.push('delivery-end');
    });

    await Promise.resolve();
    expect(events).toEqual(['project-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['project-start', 'project-end', 'delivery-start', 'delivery-end']);
  });
});
