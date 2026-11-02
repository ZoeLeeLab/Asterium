// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiAgentSessionStore, type ApiAgentSession } from '../../src/main/api/ApiAgentSessionStore';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent } from '../../src/shared/agentProtocol';

async function cleanup(directory: string) { if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('UNSAFE_CLEANUP'); await rm(directory, { recursive: true, force: true }); }
describe('automatic context preflight', () => {
  for (const failure of [false, true]) it(failure ? 'retains original history and stops if compaction fails' : 'compacts before generation and preserves the newest six complete turns', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-auto-compact-'));
    try {
      const store = new ApiAgentSessionStore(directory);
      const original: ApiAgentSession = { version: 1, partnerId: 'p', conversationId: 'c', provider: 'fixture', bindingKey: 'b', updatedAt: '', turns: Array.from({ length: 8 }, (_, index) => ({ clientMessageId: `turn-${index}`, userContent: index < 2 ? 'old-data'.repeat(1000) : `recent-${index}`, messages: [{ role: 'assistant' as const, content: `answer-${index}`, reasoningContent: '' }], completedAt: '' })) };
      await store.remember(original); const before = await store.load('p', 'c');
      const requests: ApiProviderRequest[] = [];
      const provider: ApiProviderAdapter = { provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: false, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) {
        requests.push(request);
        const compacting = request.messages[0]?.role === 'system' && request.messages[0].content.startsWith('只压缩');
        if (compacting && failure) throw new Error('FIXTURE_COMPACTION_FAILED');
        yield { type: 'text.delta', text: compacting ? '已确认目标；保留文件引用' : 'OK' }; yield { type: 'finish', reason: 'stop' };
      } };
      const events: PartnerEvent[] = [];
      for await (const event of new ApiAgentRuntime({ provider, sessionStore: store, bindingKey: 'b', modelSettings: { autoCompact: true, inputBudget: 6000 } }).sendMessage({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'cmd', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', clientMessageId: 'new', content: { type: 'text', text: 'continue' } })) events.push(event);
      if (failure) { expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'API_COMPACTION_FAILED' } }); expect(await store.load('p', 'c')).toEqual(before); expect(requests).toHaveLength(1); }
      else {
        expect(events.at(-1)?.type).toBe('run.completed');
        const saved = (await store.load('p', 'c'))!; expect(saved.turns.slice(0, 6).map(turn => turn.clientMessageId)).toEqual(['turn-2', 'turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7']);
        expect(saved.compaction?.summary).toBe('已确认目标；保留文件引用');
        expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('old-data');
      }
    } finally { await cleanup(directory); }
  });
});
