export class ProjectMutationCoordinator {
  private mutation = Promise.resolve();
  private readonly deletedProjectIds = new Set<string>();

  run<T>(operation: () => Promise<T>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  assertProjectActive(projectId: string) {
    if (this.deletedProjectIds.has(projectId)) throw new Error('PROJECT_REMOVED');
  }

  markProjectActive(projectId: string) {
    this.deletedProjectIds.delete(projectId);
  }

  markProjectDeleted(projectId: string) {
    this.deletedProjectIds.add(projectId);
  }

  replaceDeletedProjects(projectIds: string[]) {
    this.deletedProjectIds.clear();
    for (const projectId of projectIds) this.deletedProjectIds.add(projectId);
  }
}
