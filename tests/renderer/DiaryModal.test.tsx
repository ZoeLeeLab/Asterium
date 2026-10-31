import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiaryModal } from '../../src/renderer/components/diary/DiaryModal';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import { savePrototypeState } from '../../src/renderer/app/persistence';
import type { PartnerDiaryEntry } from '../../src/shared/partnerDiary';

afterEach(() => { delete window.asteriumPartnerDiary; });
function renderDiary(onClose = vi.fn()) { return render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><DiaryModal partnerId="fixture-local-a" onClose={onClose} /></PrototypeProvider></MemoryRouter>); }
function expandSettings() { fireEvent.click(screen.getByText('每日写作设置')); }
const entry: PartnerDiaryEntry = { partnerId: 'fixture-local-a', date: '2026-10-21', generationId: 'generation', conversationId: 'conversation-a-1', state: 'completed', attemptedAt: '2026-10-21T13:00:00.000Z', finishedAt: '2026-10-21T13:00:05.000Z' };
describe('partner diary modal', () => {
  it('shows read-only diary Markdown and exports the original document, without memory or generation actions', async () => {
    const exportMarkdown = vi.fn(async () => true);
    const read = vi.fn(async () => ({ entry, content: '# 2026-10-21\n\n今天我和用户读书。' }));
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [entry] })), read, exportMarkdown, configure: vi.fn() };
    renderDiary();
    expect(await screen.findByText('今天我和用户读书。')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /正文|日记内容/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /立即生成|补写|编辑日记/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith({ partnerId: 'fixture-local-a', date: '2026-10-21' }));
    expandSettings();
    expect(screen.getByLabelText('开启伙伴日记')).not.toBeChecked();
    // fixture-local-a manages its own memory; diary settings remain available.
    fireEvent.click(screen.getByLabelText('开启伙伴日记'));
    fireEvent.click(screen.getByRole('button', { name: '保存日记设置' }));
    await waitFor(() => expect(window.asteriumPartnerDiary?.configure).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'fixture-local-a', enabled: true, conversationId: 'conversation-a-1' })));
  });
  it('keeps removed partners readable and exportable, but never offers diary scheduling controls', async () => {
    const state = createTestState(); state.partners[0].isRemoved = true; savePrototypeState(state);
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [entry] })), read: vi.fn(async () => ({ entry, content: '移除前的日记仍保留。' })), exportMarkdown: vi.fn(async () => true), configure: vi.fn() };
    renderDiary();
    expect(await screen.findByText('移除前的日记仍保留。')).toBeInTheDocument();
    expandSettings();
    expect(screen.queryByLabelText('开启伙伴日记')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeEnabled();
  });
  it('shows skip reasons and prevents export when no Markdown was generated', async () => {
    const skipped = { ...entry, state: 'skipped' as const, reason: 'source_busy' };
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [skipped] })), read: vi.fn(async () => ({ entry: skipped })), exportMarkdown: vi.fn(), configure: vi.fn() };
    renderDiary();
    expect(await screen.findByText('到点时来源会话正在回复，今天已跳过。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeDisabled();
  });
  it('requires explicit acknowledgement before enabling diaries on an existing upstream thread', async () => {
    const state = createTestState();
    state.partners[0] = { ...state.partners[0], sourceMode: 'existing_thread', serviceType: 'custom', serviceUrl: 'https://diary-test.example', threadId: 'upstream', connectionLabel: 'test', connectionStatus: 'connected', configured: true };
    savePrototypeState(state);
    const configure = vi.fn();
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [] })), read: vi.fn(), exportMarkdown: vi.fn(), configure };
    renderDiary();
    expandSettings();
    fireEvent.click(screen.getByLabelText('开启伙伴日记'));
    expect(screen.getByRole('button', { name: '保存日记设置' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('确认上游日记历史风险'));
    fireEvent.click(screen.getByRole('button', { name: '保存日记设置' }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, acknowledgeUpstreamHistory: true })));
  });
  it('opens under participating projects for the current chat partner, closes on Escape, and restores focus', async () => {
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [] })), read: vi.fn(), exportMarkdown: vi.fn(), configure: vi.fn() };
    const state = createTestState(); state.activePartnerId = 'fixture-local-b'; state.activeConversationId = 'conversation-b-1'; savePrototypeState(state);
    render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><ChatPage /></PrototypeProvider></MemoryRouter>);
    expect(within(screen.getByLabelText('主要页面')).queryByRole('button', { name: '日记本' })).not.toBeInTheDocument();
    const open = screen.getByRole('button', { name: '打开测试伙伴 B的日记本' }); open.focus(); fireEvent.click(open);
    expect(await screen.findByRole('dialog', { name: '测试伙伴 B的日记本' })).toBeInTheDocument();
    expect(screen.getByLabelText('日记伙伴')).toHaveValue('fixture-local-b');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(open).toHaveFocus();
  });
  it('reads only the expanded date and isolates content when selecting another partner', async () => {
    const older = { ...entry, date: '2026-10-20' };
    const read = vi.fn(async ({ date }: { date: string }) => ({ entry: date === entry.date ? entry : older, content: `正文 ${date}` }));
    window.asteriumPartnerDiary = { get: vi.fn(async () => ({ configs: [], entries: [older, entry] })), read, exportMarkdown: vi.fn(), configure: vi.fn() };
    renderDiary(); expect(await screen.findByText('正文 2026-10-21')).toBeInTheDocument(); expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '阅读 2026-10-20 日记' }));
    expect(await screen.findByText('正文 2026-10-20')).toBeInTheDocument(); expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('正文 2026-10-21')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('日记伙伴'), { target: { value: 'fixture-local-b' } });
    expect(screen.queryByText('正文 2026-10-20')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '测试伙伴 B的日记本' })).toBeInTheDocument();
  });
});
