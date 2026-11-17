import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryImportPanel } from '../../src/renderer/components/memory/MemoryImportPanel';
import type { MemoryImportCandidate } from '../../src/shared/memoryImport';
import type { MemoryFallbackSnapshot } from '../../src/shared/memoryFallback';

afterEach(() => { delete window.asteriumMemory; delete window.asteriumMemoryFallback; });

it('shows the API destination, lets the user edit and select a subset, then shows the undo result', async () => {
  const configured: MemoryFallbackSnapshot = { settings: {
    provider: 'openai', endpoint: 'https://model.example.invalid/chat/completions', model: 'test-model',
    credentialConfigured: true, intervalMinutes: 20, partners: {},
  }, jobs: [] };
  const candidates: MemoryImportCandidate[] = [
    { id: 'first', type: 'stable_fact', body: '第一条', paragraph: 1, excerpt: '对话原文', possibleConflicts: [] },
    { id: 'second', type: 'stable_fact', body: '第二条', paragraph: 1, excerpt: '对话原文', possibleConflicts: [] },
  ];
  const preview = vi.fn(async () => ({ candidates, duplicateCount: 0, rejectedCount: 1, failedBatchCount: 1 }));
  const confirm = vi.fn(async () => ({ added: 1, skipped: 0 }));
  const undo = vi.fn(async () => ({ removed: 1, retained: 0 }));
  window.asteriumMemory = { importText: { preview, confirm, undo, cancel: vi.fn(async () => undefined) } } as unknown as NonNullable<typeof window.asteriumMemory>;
  window.asteriumMemoryFallback = {
    get: vi.fn(async () => configured), setPartner: vi.fn(async () => configured),
    configure: vi.fn(async () => configured), listModels: vi.fn(async () => []),
  };
  render(<MemoryImportPanel partnerId="p1" />);
  fireEvent.click(screen.getByText('导入旧对话'));
  await screen.findByText(/test-model.*model.example.invalid/);
  const picker = screen.getByLabelText('选择 UTF-8 文本文件');
  expect(picker).toHaveAttribute('hidden');
  const openPicker = vi.spyOn(picker, 'click');
  fireEvent.click(screen.getByRole('button', { name: '选择文本文件' }));
  expect(openPicker).toHaveBeenCalledOnce();
  const bytes = new TextEncoder().encode('旧文件内容');
  fireEvent.change(screen.getByLabelText('选择 UTF-8 文本文件'), { target: { files: [{
    name: 'old.md', size: bytes.length, arrayBuffer: async () => bytes.buffer,
  }] } });
  await waitFor(() => expect(screen.getByLabelText('要发送的对话文本')).toHaveValue('旧文件内容'));
  fireEvent.change(screen.getByLabelText('要发送的对话文本'), { target: { value: '对话原文' } });
  fireEvent.click(screen.getByRole('button', { name: '发送并生成预览' }));
  const controls = await screen.findAllByLabelText('记忆正文');
  const previewList = screen.getByRole('region', { name: '记忆候选列表' });
  expect(previewList).toHaveAttribute('tabindex', '0');
  expect(previewList).toContainElement(controls[1]);
  expect(previewList).not.toContainElement(screen.getByRole('button', { name: '确认导入（2）' }));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('跳过 1 条未通过校验的候选，1 个片段提炼失败');
  fireEvent.change(controls[0], { target: { value: '核对后修改' } });
  fireEvent.click(screen.getAllByLabelText('导入这条')[1]);
  fireEvent.click(screen.getByRole('button', { name: '确认导入（1）' }));
  await screen.findByText(/已导入 1 条/);
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1', text: '对话原文', model: 'test-model' }));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
    partnerId: 'p1', selected: [{ id: 'first', type: 'stable_fact', body: '核对后修改' }],
  }));
  fireEvent.click(screen.getByRole('button', { name: '撤销本批' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已移入归档库 1 条'));
});

it('imports a memory backup into the selected partner only after confirmation and without a model', async () => {
  const choose = vi.fn(async () => ({ id: 'backup', fileName: '伙伴.asterium-memory.gz', total: 3, archived: 1 }));
  const restore = vi.fn(async () => ({ added: 2, skipped: 1 }));
  const preview = vi.fn();
  window.asteriumMemory = { backup: { choose, import: restore, cancel: vi.fn(), export: vi.fn() }, importText: { preview } } as unknown as NonNullable<typeof window.asteriumMemory>;
  window.asteriumMemoryFallback = { get: vi.fn(async () => ({ settings: { credentialConfigured: false } })) } as unknown as NonNullable<typeof window.asteriumMemoryFallback>;
  render(<MemoryImportPanel partnerId="new-partner" partnerName="小伙伴" />);
  fireEvent.click(screen.getByText('导入旧对话'));
  fireEvent.click(screen.getByRole('button', { name: '导入星丛记忆' }));
  expect(await screen.findByRole('dialog', { name: '导入记忆备份' })).toHaveTextContent(/3 条记忆导入「小伙伴」，其中 1 条留在归档库/);
  expect(choose).toHaveBeenCalledWith('new-partner');
  expect(restore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认导入备份' }));
  await screen.findByText('已恢复 2 条记忆，跳过 1 条已有记录。');
  expect(restore).toHaveBeenCalledWith('new-partner', 'backup');
  expect(preview).not.toHaveBeenCalled();
});
