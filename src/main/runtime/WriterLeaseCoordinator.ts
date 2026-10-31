export type WriterLeaseScope =
  | { kind: 'conversation'; partnerId: string; conversationId: string }
  | { kind: 'project_partner'; projectId: string; partnerId: string }
  | { kind: 'project_workspace'; projectId: string };

export interface WriterLease {
  scope: WriterLeaseScope;
  ownerId: string;
  release: () => void;
}

interface WaitingWriter {
  ownerId: string;
  scope: WriterLeaseScope;
  resolve: (lease: WriterLease) => void;
}

/**
 * Process-wide writer leases keyed by logical runtime scope. Conversation
 * writers are isolated by partner and conversation. Injected task runtimes may
 * use the project-partner scope, while the real shared-worktree runtime holds
 * one writer for the whole project until worktrees are designed.
 */
export class WriterLeaseCoordinator {
  private readonly active = new Map<string, string>();
  private readonly waiting = new Map<string, WaitingWriter[]>();
  private readonly listeners = new Set<(scope: WriterLeaseScope) => void>();

  subscribeAvailable(listener: (scope: WriterLeaseScope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tryAcquire(scope: WriterLeaseScope, ownerId: string): WriterLease | undefined {
    const key = writerLeaseKey(scope);
    if (this.active.has(key)) return undefined;
    this.active.set(key, ownerId);
    return this.createLease(scope, ownerId);
  }

  acquire(scope: WriterLeaseScope, ownerId: string): Promise<WriterLease> {
    const lease = this.tryAcquire(scope, ownerId);
    if (lease) return Promise.resolve(lease);
    const key = writerLeaseKey(scope);
    return new Promise((resolve) => {
      const queue = this.waiting.get(key) ?? [];
      queue.push({ ownerId, scope, resolve });
      this.waiting.set(key, queue);
    });
  }

  ownerFor(scope: WriterLeaseScope) {
    return this.active.get(writerLeaseKey(scope));
  }

  private createLease(scope: WriterLeaseScope, ownerId: string): WriterLease {
    const key = writerLeaseKey(scope);
    let released = false;
    return {
      scope,
      ownerId,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(key) !== ownerId) return;
        const next = this.waiting.get(key)?.shift();
        if (!next) {
          this.active.delete(key);
          this.waiting.delete(key);
          for (const listener of this.listeners) listener(scope);
          return;
        }
        this.active.set(key, next.ownerId);
        if (!this.waiting.get(key)?.length) this.waiting.delete(key);
        next.resolve(this.createLease(next.scope, next.ownerId));
      },
    };
  }
}

export function conversationWriterScope(input: { partnerId: string; conversationId: string }): WriterLeaseScope {
  return { kind: 'conversation', partnerId: input.partnerId, conversationId: input.conversationId };
}

export function projectPartnerWriterScope(projectId: string, partnerId: string): WriterLeaseScope {
  return { kind: 'project_partner', projectId, partnerId };
}

export function projectWorkspaceWriterScope(projectId: string): WriterLeaseScope {
  return { kind: 'project_workspace', projectId };
}

function writerLeaseKey(scope: WriterLeaseScope) {
  if (scope.kind === 'conversation') return JSON.stringify([scope.kind, scope.partnerId, scope.conversationId]);
  if (scope.kind === 'project_partner') return JSON.stringify([scope.kind, scope.projectId, scope.partnerId]);
  return JSON.stringify([scope.kind, scope.projectId]);
}
