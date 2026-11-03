import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiWebTools } from '../../src/main/api/ApiWebTools';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-tools-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('ApiAgentTools', () => {
  it('routes delegation through the configured controller with the runtime call identity', async () => {
    const delegation = vi.fn(async () => '{"id":"batch"}');
    const runtime = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), delegation,
    });
    const signal = new AbortController().signal;
    const input = { tasks: [{ targetPartnerId: 'reviewer', instruction: 'Review the proposal' }] };
    expect(runtime.definitions.map(tool => tool.name)).toContain('wait_delegate_tasks');
    expect(await runtime.execute('delegate_tasks', input, signal, { toolCallId: 'call-1' })).toEqual({ content: '{"id":"batch"}' });
    expect(delegation).toHaveBeenCalledWith('delegate_tasks', { tasks: [{ ...input.tasks[0], attachmentIds: [] }] }, signal, 'call-1');
  });
  it('never executes tools absent from the configured runtime catalog', async () => {
    const signal = new AbortController().signal;
    const noWorkspace = new ApiAgentTools(undefined);
    for (const [name, args] of [
      ['list_directory', {}], ['read_file', { path: 'private.md' }],
      ['write_file', { path: 'private.md', content: 'no' }],
      ['run_command', { command: 'Write-Output unexpected' }], ['toString', {}],
    ] as const) {
      expect(() => noWorkspace.describe(name, args)).toThrow('TOOL_NOT_AVAILABLE');
      await expect(noWorkspace.execute(name, args, signal)).rejects.toThrow('TOOL_NOT_AVAILABLE');
    }

    const search = vi.fn(async () => '[]');
    const readOnlyMemory = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(),
      memory: { access: 'read', search, readSource: vi.fn(async () => '{}') },
    });
    await expect(readOnlyMemory.execute('hold_memory', { type: 'stable_fact', body: 'no' }, signal)).rejects.toThrow('TOOL_NOT_AVAILABLE');
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects invalid enum, nested and extra arguments before calling Main controllers', async () => {
    const task = vi.fn(async () => '{}');
    const workspace = vi.fn(async () => '{}');
    const tools = new ApiAgentTools(undefined, [], undefined, { status: vi.fn(async () => '{}'), workspace, task, update: vi.fn() });
    const signal = new AbortController().signal;
    await expect(tools.execute('asterium_workspace', { action: 'unknown' }, signal)).rejects.toThrow('TOOL_ARGUMENT_INVALID:action');
    await expect(tools.execute('asterium_workspace', { action: 'list', extra: true }, signal)).rejects.toThrow('TOOL_ARGUMENT_INVALID');
    await expect(tools.execute('asterium_task', { action: 'submit_handoff', criterion_evidence: [{ criterion_id: 'a', result: 'invented', evidence: [] }] }, signal)).rejects.toThrow('TOOL_ARGUMENT_INVALID');
    await expect(tools.execute('asterium_task', { action: 'submit_handoff' }, signal)).rejects.toThrow('TOOL_ARGUMENT_INVALID:criterion_evidence');
    expect(task).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
  });

  it('keeps file operations inside granted roots while registering exact delivered files outside them', async () => {
    const primary = await tempDirectory();
    const additional = await tempDirectory();
    const outside = await tempDirectory();
    await writeFile(path.join(primary, 'notes.txt'), 'hello world', 'utf8');
    await writeFile(path.join(additional, 'extra.txt'), 'second workspace', 'utf8');
    await writeFile(path.join(outside, 'final.pdf'), 'completed delivery', 'utf8');
    const tools = new ApiAgentTools(primary, [additional]);
    const signal = new AbortController().signal;

    expect((await tools.execute('read_file', { path: 'notes.txt' }, signal)).content).toBe('hello world');
    expect((await tools.execute('search_files', { query: 'world', path: '.' }, signal)).content).toContain('notes.txt:1');
    const created = await tools.execute('write_file', { path: 'result.md', content: 'first' }, signal);
    const overwritten = await tools.execute('write_file', { path: 'result.md', content: 'second' }, signal);
    const edited = await tools.execute('edit_file', { path: 'result.md', old_text: 'second', new_text: 'final' }, signal);
    expect(created.artifact?.changeKind).toBe('create');
    expect(overwritten.artifact?.changeKind).toBe('modify');
    expect(edited.artifact?.changeKind).toBe('modify');
    expect(await readFile(path.join(primary, 'result.md'), 'utf8')).toBe('final');
    expect((await tools.execute('deliver_file', { path: path.join(additional, 'extra.txt'), name: '交付.txt' }, signal)).artifact).toMatchObject({ name: '交付.txt', method: 'deliver_tool' });
    expect((await tools.execute('deliver_file', { path: path.join(outside, 'final.pdf') }, signal)).artifact).toMatchObject({ path: expect.stringMatching(/[\\/]final\.pdf$/), method: 'deliver_tool' });
    await expect(tools.execute('deliver_file', { path: outside }, signal)).rejects.toThrow('TOOL_DELIVERY_NOT_FILE');
    await expect(tools.execute('deliver_file', { path: path.join(outside, 'missing.pdf') }, signal)).rejects.toThrow('TOOL_DELIVERY_FILE_NOT_FOUND');
  });

  it('blocks traversal and refuses recursive directory deletion', async () => {
    const primary = await tempDirectory();
    const outside = await tempDirectory();
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const tools = new ApiAgentTools(primary);
    const signal = new AbortController().signal;
    await expect(tools.execute('read_file', { path: path.join(outside, 'secret.txt') }, signal)).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
    await mkdir(path.join(primary, 'non-empty'));
    await writeFile(path.join(primary, 'non-empty', 'child.txt'), 'x');
    await expect(tools.execute('delete_path', { path: 'non-empty' }, signal)).rejects.toThrow('TOOL_DELETE_DIRECTORY_NOT_EMPTY');
  });

  it('blocks profile data even when a broader workspace or one-time write would otherwise allow it', async () => {
    const primary = await tempDirectory();
    const protectedRoot = path.join(primary, 'AsteriumData');
    await mkdir(protectedRoot);
    await writeFile(path.join(protectedRoot, 'profile.md'), 'private', 'utf8');
    const tools = new ApiAgentTools(primary, [], undefined, undefined, undefined, [protectedRoot]);
    const signal = new AbortController().signal;
    await expect(tools.execute('read_file', { path: path.join(protectedRoot, 'profile.md') }, signal)).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await expect(tools.execute('list_directory', { path: primary }, signal)).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await expect(tools.oneTimeExternalWriteTarget('write_file', { path: path.join(protectedRoot, 'new.md') })).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await expect(tools.execute('run_command', { cwd: primary, command: `Get-Content '${protectedRoot}'` }, signal)).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
  });

  it('writes one exact outside file only when the runtime supplies its matching one-time authorization', async () => {
    const primary = await tempDirectory();
    const outside = await tempDirectory();
    const target = path.join(outside, 'one-time.md');
    const sibling = path.join(outside, 'sibling.md');
    await writeFile(sibling, 'private', 'utf8');
    const tools = new ApiAgentTools(primary);
    const signal = new AbortController().signal;
    const authorizedTarget = await tools.oneTimeExternalWriteTarget('write_file', { path: target, content: 'approved' });

    expect(authorizedTarget).toMatch(/[\\/]one-time\.md$/);
    await expect(tools.execute('write_file', { path: target, content: 'blocked' }, signal)).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
    await tools.execute('write_file', { path: target, content: 'approved' }, signal, { externalWritePath: authorizedTarget });
    expect(await readFile(target, 'utf8')).toBe('approved');
    await expect(tools.execute('write_file', { path: sibling, content: 'wrong target' }, signal, { externalWritePath: authorizedTarget })).rejects.toThrow('EXTERNAL_WRITE_AUTHORIZATION_MISMATCH');
    expect((await tools.execute('read_file', { path: target }, signal, { externalReadPaths: new Set([authorizedTarget!]) })).content).toBe('approved');
    await expect(tools.execute('read_file', { path: sibling }, signal, { externalReadPaths: new Set([authorizedTarget!]) })).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
    await expect(tools.execute('list_directory', { path: outside }, signal, { externalReadPaths: new Set([authorizedTarget!]) })).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
    await expect(tools.execute('search_files', { path: outside, query: 'approved' }, signal, { externalReadPaths: new Set([authorizedTarget!]) })).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
    await expect(tools.execute('read_file', { path: target }, signal)).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
  });

  it('exposes chunked text attachment reading without a workspace and reaches eof without truncation', async () => {
    const root = await tempDirectory();
    const attachment = path.join(root, 'attachment.txt');
    const original = '来自用户附件。'.repeat(10_000);
    await writeFile(attachment, original, 'utf8');
    const attachmentId = 'attachment-00000000-0000-0000-0000-000000000000';
    const pathFor = vi.fn(async (id: string, conversationId: string) => {
      expect(id).toBe(attachmentId);
      expect(conversationId).toBe('conversation-a');
      return attachment;
    });
    const inspect = vi.fn(async () => ({ id: attachmentId, name: 'attachment.txt', mediaType: 'text/plain', sizeBytes: Buffer.byteLength(original) }));
    const tools = new ApiAgentTools(undefined, [], { conversationId: 'conversation-a', pathFor, inspect });

    expect(tools.definitions.map((item) => item.name)).toEqual(['read_attachment_text']);
    let offset = 0;
    let combined = '';
    for (;;) {
      const result = JSON.parse((await tools.execute('read_attachment_text', { attachment_id: attachmentId, offset, max_characters: 4096 }, new AbortController().signal)).content) as { content: string; nextOffset: number; eof: boolean; totalCharacters: number };
      combined += result.content;
      offset = result.nextOffset;
      expect(result.totalCharacters).toBe(original.length);
      if (result.eof) break;
    }
    expect(combined).toBe(original);
    expect(pathFor).toHaveBeenCalled();
  });

  it('never returns base64 samples for binary attachments', async () => {
    const root = await tempDirectory();
    const attachment = path.join(root, 'image.png');
    await writeFile(attachment, Buffer.from([0, 1, 2, 3]));
    const tools = new ApiAgentTools(undefined, [], {
      conversationId: 'conversation-a',
      pathFor: async () => attachment,
      inspect: async () => ({ id: 'attachment-image', name: 'image.png', mediaType: 'image/png', sizeBytes: 4 }),
    });
    await expect(tools.execute('read_attachment_text', { attachment_id: 'attachment-image' }, new AbortController().signal)).rejects.toThrow('ATTACHMENT_TEXT_UNSUPPORTED_TYPE');
  });

  it('exposes the status console and narrow workspace manager independently from file tools', async () => {
    const runtimeTools = {
      status: vi.fn(async (key: string) => JSON.stringify({ key, authoritative: true })),
      workspace: vi.fn(async (action: string, targetPath?: string) => JSON.stringify({ action, targetPath })),
      update: vi.fn(),
    };
    const tools = new ApiAgentTools(undefined, [], undefined, runtimeTools);
    const signal = new AbortController().signal;

    expect(tools.definitions.map((item) => item.name)).toEqual(['asterium_status', 'asterium_workspace']);
    expect((await tools.execute('asterium_status', { key: 'workspace' }, signal)).content).toContain('authoritative');
    expect((await tools.execute('asterium_workspace', { action: 'add', path: 'D:\\shared' }, signal)).content).toContain('D:\\\\shared');
    expect(runtimeTools.workspace).toHaveBeenCalledWith('add', 'D:\\shared');
    expect(tools.describe('asterium_workspace', { action: 'add', path: 'D:\\shared' })).toMatchObject({ purpose: 'workspace_add' });
    expect(tools.describe('asterium_workspace', { action: 'remove', path: 'D:\\shared' })).toMatchObject({ purpose: 'workspace_remove' });
  });

  it('exposes the same structured workspace-task handoff bridge without file permissions', async () => {
    const task = vi.fn(async () => JSON.stringify({ accepted: true }));
    const runtimeTools = {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), task, update: vi.fn(),
    };
    const tools = new ApiAgentTools(undefined, [], undefined, runtimeTools);
    const signal = new AbortController().signal;

    expect(tools.definitions.map((item) => item.name)).toEqual(['asterium_status', 'asterium_workspace', 'asterium_task']);
    await expect(tools.execute('asterium_task', { action: 'context' }, signal)).resolves.toMatchObject({ content: expect.stringContaining('accepted') });
    expect(task).toHaveBeenCalledWith({ action: 'context' });
    expect(tools.describe('asterium_task', {
      action: 'submit_handoff', disposition: 'submitted', summary: '完成', criterion_evidence: [],
      changed_paths: [], verification: [], delivery_refs: [], unresolved_issues: [],
    })).toMatchObject({ mutates: false, risk: 'low' });
  });

  it('exposes only the structured draft submission tool during a planning turn', async () => {
    const workflowDraft = vi.fn(async () => JSON.stringify({ saved: true, status: 'draft' }));
    const runtimeTools = {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), workflowDraft, update: vi.fn(),
    };
    const tools = new ApiAgentTools('K:\\project', [], undefined, runtimeTools, new ApiWebTools());
    const signal = new AbortController().signal;

    expect(tools.definitions.map((item) => item.name)).toEqual(['submit_workflow_draft']);
    await expect(tools.execute('read_file', { path: 'private.md' }, signal)).rejects.toThrow('ASTERIUM_WORKFLOW_PLANNING_TOOL_NOT_AVAILABLE');
    await tools.execute('submit_workflow_draft', {
      name: '流程', description: '', generation_summary: '依据公开讨论',
      nodes: [{ client_key: 'step-a', title: '执行', description: '', dependency_keys: [], acceptance_criteria: [], completion_rule: { type: 'executor_submit' }, source_message_ids: ['message-a'] }],
    }, signal);
    expect(workflowDraft).toHaveBeenCalledWith(expect.objectContaining({ name: '流程', nodes: [expect.objectContaining({ clientKey: 'step-a', sourceMessageIds: ['message-a'] })] }));
  });

  it('exposes all five internally authorized memory tools for managed daily conversations', async () => {
    const memory = {
      access: 'write' as const,
      search: vi.fn(async () => '[{"memoryId":"memory-1"}]'),
      readSource: vi.fn(async () => '[{"state":"live"}]'),
      hold: vi.fn(async () => '{"memoryId":"memory-2"}'),
      comment: vi.fn(async () => '{"memoryId":"memory-1"}'),
      update: vi.fn(async () => '{"memoryId":"memory-1","status":"obsolete"}'),
    };
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), memory, update: vi.fn() };
    const tools = new ApiAgentTools(undefined, [], undefined, runtimeTools);
    const signal = new AbortController().signal;

    expect(tools.definitions.map((item) => item.name)).toEqual([
      'asterium_status', 'asterium_workspace', 'search_memory', 'read_memory_source', 'hold_memory', 'comment_memory', 'update_memory',
    ]);
    await tools.execute('hold_memory', { type: 'stable_fact', body: '事实', weight: 3 }, signal);
    await tools.execute('search_memory', { text: '事实', statuses: ['active'] }, signal);
    await tools.execute('comment_memory', { memory_id: 'memory-1', content: '补充' }, signal);
    await tools.execute('update_memory', { memory_id: 'memory-1', status: 'obsolete' }, signal);
    await tools.execute('read_memory_source', { memory_id: 'memory-1', source_index: 0 }, signal);
    expect(memory.hold).toHaveBeenCalledWith(expect.objectContaining({ type: 'stable_fact', body: '事实', weight: 3 }));
    expect(memory.search).toHaveBeenCalledWith(expect.objectContaining({ text: '事实', statuses: ['active'] }));
    expect(tools.describe('hold_memory', { type: 'stable_fact', body: '事实' })).toMatchObject({ mutates: false, risk: 'low' });
  });

  it('adds only memory reads beside the required draft tool during workflow planning', async () => {
    const workflowDraft = vi.fn(async () => '{}');
    const memory = { access: 'read' as const, search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '[]') };
    const tools = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), workflowDraft, memory, update: vi.fn(),
    });
    const signal = new AbortController().signal;
    expect(tools.definitions.map((item) => item.name)).toEqual(['submit_workflow_draft', 'search_memory', 'read_memory_source']);
    await expect(tools.execute('search_memory', {}, signal)).resolves.toEqual({ content: '[]' });
    await expect(tools.execute('hold_memory', { type: 'stable_fact', body: '不得写入' }, signal)).rejects.toThrow('ASTERIUM_WORKFLOW_PLANNING_TOOL_NOT_AVAILABLE');
  });

  it('exposes the internally authorized project notebook tool and preserves revision-safe replace inputs', async () => {
    const projectNotebook = vi.fn(async () => '{"revision":4}');
    const tools = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), projectNotebook, update: vi.fn(),
    });
    const signal = new AbortController().signal;

    expect(tools.definitions.map((item) => item.name)).toEqual(['asterium_status', 'asterium_workspace', 'project_notebook']);
    await expect(tools.execute('project_notebook', { action: 'replace', project_id: 'project-a', content: '整理版', expected_revision: 3 }, signal)).resolves.toEqual({ content: '{"revision":4}' });
    expect(projectNotebook).toHaveBeenCalledWith({ action: 'replace', projectId: 'project-a', content: '整理版', expectedRevision: 3 });
    expect(tools.describe('project_notebook', { action: 'replace', project_id: 'project-a', content: '整理版', expected_revision: 3 })).toMatchObject({ mutates: false, risk: 'low', targets: ['project-a'] });
  });

  it('exposes read-only web tools without a workspace', async () => {
    const fetcher = vi.fn(async () => new Response('<?xml version="1.0"?><rss><channel><item><title>Result</title><link>https://example.com/result</link><description>Fresh source</description></item></channel></rss>', { headers: { 'content-type': 'text/xml' } }));
    const webTools = new ApiWebTools({ fetcher, lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never) });
    const tools = new ApiAgentTools(undefined, [], undefined, undefined, webTools);

    expect(tools.definitions.map((item) => item.name)).toEqual(['web_search', 'web_fetch']);
    expect(tools.describe('web_search', { query: 'latest news' })).toMatchObject({ mutates: false, action: 'read_file', risk: 'low' });
    const result = JSON.parse((await tools.execute('web_search', { query: 'latest news' }, new AbortController().signal)).content);
    expect(result).toMatchObject({ backend: 'bing_rss', results: [{ url: 'https://example.com/result' }] });
  });
});
