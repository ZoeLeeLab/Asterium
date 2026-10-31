import { randomUUID } from 'node:crypto';
import type { AutomationConfirmation } from '../../shared/automations';

/** Renderer shows a frozen proposal; only the trusted window can resolve its random ID. */
export class AutomationConfirmations {
  private disposed = false;
  private readonly pending = new Map<string, { proposal: AutomationConfirmation; owner?: string; finish(approved: boolean): void }>();
  constructor(private readonly changed: () => void) {}
  list() { return [...this.pending.values()].map(p => structuredClone(p.proposal)); }
  request(proposal: Omit<AutomationConfirmation, 'id'>, owner?: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || signal?.aborted) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise(resolve => {
      const abort = () => finish(false);
      const finish = (approved: boolean) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener('abort', abort); resolve(approved); this.changed();
      };
      this.pending.set(id, { proposal: structuredClone({ ...proposal, id }), owner, finish });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) finish(false); else this.changed();
    });
  }
  resolve(id: string, approved: boolean) { const found = this.pending.get(id); if (!found) throw new Error('AUTOMATION_CONFIRMATION_EXPIRED'); found.finish(approved); }
  cancelOwner(owner: string) { for (const value of [...this.pending.values()]) if (value.owner === owner) value.finish(false); }
  dispose() { this.disposed = true; for (const value of [...this.pending.values()]) value.finish(false); }
}
