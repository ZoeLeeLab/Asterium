import type { SessionCompactRequest, SessionCompactResult } from '../../shared/sessionCompaction';
import { assertSessionCompactRequest } from '../../shared/sessionCompaction';
import { conversationWriterScope, type WriterLeaseCoordinator } from './WriterLeaseCoordinator';

/** Explicit maintenance operation. Shares the conversation writer with normal replies. */
export class SessionCompactionService {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<SessionCompactResult> }>();
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly leases: WriterLeaseCoordinator,
    private readonly execute: (request: SessionCompactRequest, signal: AbortSignal) => Promise<SessionCompactResult>,
    private readonly timeoutMs = 180_000) {}

  compact(request: SessionCompactRequest) {
    assertSessionCompactRequest(request);
    const fingerprint = JSON.stringify([request.partnerId, request.conversationId, request.sessionId, request.source]);
    const prior = this.requests.get(request.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return Promise.reject(new Error('IDEMPOTENCY_CONFLICT'));
      return prior.result;
    }
    const lease = this.leases.tryAcquire(conversationWriterScope(request), `compact:${request.commandId}`);
    if (!lease) return Promise.reject(new Error('COMPACT_CONVERSATION_BUSY'));
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('COMPACT_TIMEOUT')), this.timeoutMs);
    const result = Promise.resolve().then(() => this.execute(request, controller.signal)).finally(() => {
      clearTimeout(timer); this.controllers.delete(controller); lease.release();
    });
    this.requests.set(request.commandId, { fingerprint, result });
    // Bound the completed-operation cache; never evict work that is still running.
    void result.then(() => { if (this.requests.size > 128) this.requests.delete(request.commandId); }, () => this.requests.delete(request.commandId));
    return result;
  }
  dispose() { for (const controller of this.controllers) controller.abort(new Error('COMPACT_INTERRUPTED')); }
}
