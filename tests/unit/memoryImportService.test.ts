import { randomUUID } from 'node:crypto';
import { testRm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryImportService } from '../../src/main/memory/MemoryImportService';
import { MemorySourceService } from '../../src/main/memory/MemorySourceService';
import { SqliteMemoryArchiveStore } from '../../src/main/memory/SqliteMemoryArchiveStore';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => testRm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-import-'));
  roots.push(root);
  const store = (id: string) => new SqliteMemoryArchiveStore(path.join(root, id, 'memory.sqlite'), id);
  const adapter = (respond: (request: ApiProviderRequest) => AsyncIterable<import('../../src/main/api/ApiProviderAdapter').ApiProviderStreamEvent>): ApiProviderAdapter => ({
    provider: 'fake',
    capabilities: { streamingText: true, reasoning: false, toolCalls: false, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
    stream: respond,
  });
  const connect = vi.fn(async () => adapter(async function* (request) {
    expect(request.tools).toEqual([]);
    yield { type: 'text.delta', text: JSON.stringify([
      { type: 'stable_fact', body: '星星使用开发版。', paragraph: '1' },
      { type: 'long_term_project', body: '星丛发布由星星验收。', paragraph: 2 },
      { type: 'preference_and_collaboration', body: '先审计再实施。', paragraph: 2 },
    ]) };
  }));
  const service = new MemoryImportService({
    list: (id, options) => store(id).list(options),
    importReceipt: (id, batch) => store(id).importReceipt(batch),
    confirmImport: (id, batch, records) => store(id).confirmImport(batch, records),
    undoImport: (id, batch) => store(id).undoImport(batch),
  }, id => id === 'p1' || id === 'p2', connect);
  const input = {
    partnerId: 'p1', batchId: randomUUID(), label: '旧对话.md', text: '星星：我在开发版上工作。\n\n星星：发布前由我验收，先审计再实施。',
    endpoint: 'https://example.invalid', provider: 'fake', model: 'test',
  };
  return { store, service, input, connect, adapter };
}

describe('memory import', () => {
  it('previews without writes, imports a selected subset, preserves excerpts, and undoes only untouched entries', async () => {
    const { store, service, input } = await fixture();
    const { candidates } = await service.preview(input);
    expect(candidates).toHaveLength(3);
    expect(await store('p1').list()).toEqual([]);
    const selected = candidates.slice(0, 2).map(({ id, type, body }) => ({ id, type, body }));
    await expect(service.confirm({ partnerId: 'p2', batchId: input.batchId, selected })).rejects.toThrow('MEMORY_IMPORT_PREVIEW_EXPIRED');
    const confirm = { partnerId: 'p1', batchId: input.batchId, selected };
    await expect(Promise.all([service.confirm(confirm), service.confirm(confirm)])).resolves.toEqual([
      { added: 2, skipped: 0 }, { added: 2, skipped: 0 },
    ]);
    const records = await store('p1').list();
    expect(records).toHaveLength(2);
    expect(await store('p2').list()).toEqual([]);
    expect(await store('p1').fallbackMemoryIds()).toEqual([]);
    const source = records.find(record => record.type === 'stable_fact')!.sources[0];
    const sources = new MemorySourceService({ getWindow: vi.fn() }, { getRoom: vi.fn() });
    await expect(sources.read('p1', source)).resolves.toMatchObject({ state: 'frozen', source: {
      kind: 'imported_text', label: input.label, messageId: '1', excerpt: '星星：我在开发版上工作。',
    } });
    const again = await service.preview({ ...input, batchId: randomUUID() });
    expect(again.candidates.map(item => item.type)).toEqual(['preference_and_collaboration']);
    expect(again.duplicateCount).toBe(2);
    await store('p1').update({ ...records[0], body: '已人工改过' });
    expect(() => service.undo(confirm)).toThrow();
    await expect(service.undo({ partnerId: 'p1', batchId: input.batchId })).resolves.toEqual({ removed: 1, retained: 1 });
    expect((await store('p1').list()).map(record => record.body)).toEqual(['已人工改过']);
  });

  it('rejects fabricated sources and allows cancellation of an active request', async () => {
    const { service, store, connect, adapter, input } = await fixture();
    connect.mockResolvedValueOnce(adapter(async function* () {
      yield { type: 'text.delta', text: '[{"type":"stable_fact","body":"虚构内容","paragraph":"999"}]' };
    }));
    await expect(service.preview(input)).resolves.toMatchObject({ candidates: [], rejectedCount: 1,
      diagnostic: 'MEMORY_IMPORT_OUTPUT_DIAGNOSTIC:source_not_in_batch:missing' });
    expect(await store('p1').list()).toEqual([]);
    connect.mockResolvedValueOnce(adapter(async function* ({ signal }) {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      yield { type: 'text.delta', text: '[]' };
    }));
    const pending = service.preview(input);
    service.cancel({ partnerId: input.partnerId, batchId: input.batchId });
    await expect(pending).rejects.toThrow();
    expect((await service.preview({ ...input, batchId: randomUUID() })).candidates).toHaveLength(3);
  });

  it('skips exported automation turns and retries malformed output without exposing it to the next request', async () => {
    const { service, input, connect, adapter } = await fixture();
    let calls = 0;
    connect.mockResolvedValueOnce(adapter(async function* ({ messages, tools }) {
      calls++;
      expect(tools).toEqual([]);
      expect(JSON.stringify(messages)).not.toContain('private-trigger-payload');
      expect(JSON.stringify(messages)).not.toContain('invalid-model-reply');
      const request = JSON.parse(String(messages[1].content));
      expect(request.map((part: { text: string }) => part.text)).toEqual(['用户：正常旧对话', '用户：第二条正常对话']);
      yield { type: 'text.delta', text: calls === 1 ? 'invalid-model-reply' : '[{"type":"stable_fact","body":"有效候选","paragraph":2}]' };
    }));
    const result = await service.preview({ ...input, text: [
      '用户：正常旧对话',
      '用户：SYSTEM ACTION MODE: internal trigger, not user chat.\nprivate-trigger-payload',
      'AI：{"action":"silent"}',
      '用户：第二条正常对话',
    ].join('\n\n') });
    expect(calls).toBe(2);
    expect(result.candidates[0]).toMatchObject({ excerpt: '用户：第二条正常对话' });
  });

  it.each([
    ['length', 'private partial response', 'truncated'],
    ['stop', 'private malformed response', 'invalid_json'],
    ['stop', '[{"type":"private invalid value","body":"private body","paragraph":1}]', 'field_type'],
    ['stop', '[{"type":"stable_fact","body":7,"paragraph":1}]', 'field_body'],
    ['stop', '[{"type":"stable_fact","body":"private body","paragraph":"1-2"}]', 'field_paragraph'],
    ['stop', '[{"type":"stable_fact","body":"private body"}]', 'field_paragraph'],
  ])('reports only safe diagnostics for finish %s', async (finish, reply, category) => {
    const { service, input, connect, adapter } = await fixture();
    connect.mockResolvedValueOnce(adapter(async function* () {
      yield { type: 'text.delta', text: reply };
      yield { type: 'finish', reason: finish };
    }));
    const diagnostic = `MEMORY_IMPORT_OUTPUT_DIAGNOSTIC:${category}:${finish}`;
    const batchFailed = category === 'truncated' || category === 'invalid_json';
    await expect(service.preview(input)).resolves.toMatchObject({
      candidates: [], failedBatchCount: batchFailed ? 1 : 0, rejectedCount: batchFailed ? 0 : 1,
      diagnostic: batchFailed ? `${diagnostic};${diagnostic}` : diagnostic,
    });
  });

  it('keeps valid entries in a mixed batch, continues after an unreadable batch, and writes only on confirm', async () => {
    const { service, input, connect, adapter, store } = await fixture();
    let calls = 0;
    connect.mockResolvedValueOnce(adapter(async function* ({ messages }) {
      calls++;
      const [{ paragraph }] = JSON.parse(String(messages[1].content));
      const good = { type: 'stable_fact', body: `有效候选 ${paragraph}`, paragraph };
      const reply = paragraph === 3 ? 'invalid JSON' : JSON.stringify(paragraph === 1 ? [
        { ...good, paragraph: '1-2' }, good, { ...good, paragraph: 999 },
      ] : [good]);
      yield { type: 'text.delta', text: reply };
      yield { type: 'finish', reason: 'stop' };
    }));
    const result = await service.preview({ ...input, text: '甲'.repeat(33_000) });
    expect(calls).toBe(4);
    expect(result).toMatchObject({ rejectedCount: 2, failedBatchCount: 1 });
    expect(result.candidates.map(item => item.paragraph)).toEqual([1, 5]);
    expect(await store('p1').list()).toEqual([]);
    const { id, type, body } = result.candidates[1];
    await expect(service.confirm({ partnerId: 'p1', batchId: input.batchId, selected: [{ id, type, body }] }))
      .resolves.toEqual({ added: 1, skipped: 0 });
    expect(await store('p1').list()).toMatchObject([{ body, sources: [{ messageId: '5' }] }]);
  });

  it('splits long text into bounded requests without dropping its tail', async () => {
    const { service, input, connect, adapter } = await fixture();
    const calls: string[] = [];
    connect.mockResolvedValueOnce(adapter(async function* ({ messages }) {
      calls.push(String(messages[1].content));
      yield { type: 'text.delta', text: '[]' };
    }));
    await expect(service.preview({ ...input, text: '甲'.repeat(33_000) + '结尾' })).resolves.toEqual({ candidates: [], duplicateCount: 0, rejectedCount: 0, failedBatchCount: 0, diagnostic: undefined });
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toContain('结尾');
  });
});
