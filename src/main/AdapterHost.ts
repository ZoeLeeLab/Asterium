import type { PartnerAdapter } from './adapters/PartnerAdapter';

export class AdapterHost {
  private readonly adapters = new Map<string, PartnerAdapter>();
  private readonly runAdapters = new Map<string, PartnerAdapter>();
  private readonly sessionAdapters = new Map<string, PartnerAdapter>();

  get(key: string) {
    return this.adapters.get(key);
  }

  set(key: string, adapter: PartnerAdapter) {
    this.adapters.set(key, adapter);
    return adapter;
  }

  values() {
    return this.adapters.values();
  }

  bindRun(runId: string, adapter: PartnerAdapter) {
    this.runAdapters.set(runId, adapter);
  }

  adapterForRun(runId: string) {
    return this.runAdapters.get(runId);
  }

  releaseRun(runId: string) {
    this.runAdapters.delete(runId);
  }

  bindSession(partnerId: string, conversationId: string, sessionId: string, adapter: PartnerAdapter) {
    this.sessionAdapters.set(sessionKey(partnerId, conversationId, sessionId), adapter);
  }

  adapterForSession(partnerId: string, conversationId: string, sessionId: string) {
    return this.sessionAdapters.get(sessionKey(partnerId, conversationId, sessionId));
  }

  async dispose() {
    const unique = [...new Set(this.adapters.values())];
    this.runAdapters.clear();
    this.sessionAdapters.clear();
    this.adapters.clear();
    await Promise.all(unique.map((adapter) => adapter.dispose?.()));
  }
}

function sessionKey(partnerId: string, conversationId: string, sessionId: string) {
  return JSON.stringify([partnerId, conversationId, sessionId]);
}
