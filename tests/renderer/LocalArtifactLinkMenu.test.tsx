import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestState } from '../fixtures/applicationState';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import type { ArtifactInfo } from '../../src/shared/desktopBridge';

const originalBridge = window.asteriumArtifacts;
const href = 'C:/Fixtures/report.md';
const info: ArtifactInfo = {
  id: 'fixture-file', name: 'report.md', extension: '.md', mediaType: 'text/markdown', previewKind: 'markdown',
  sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false,
  localSourceKey: 'fixture-source', sizeBytes: 42, createdAt: '2026-11-21T00:00:00.000Z',
};

afterEach(() => { window.asteriumArtifacts = originalBridge; });

function SwitchConversation({ id }: { id: string }) {
  const { selectConversation } = usePrototype();
  return <button onClick={() => selectConversation(id)}>切换合成对话</button>;
}

function mount(timeline = false) {
  const state = createTestState(), conversation = state.conversations[0];
  const text = `交付文档：[合成文档](${href})。`;
  conversation.messages = [{ id: 'fixture-message', authorId: conversation.partnerId, content: text, createdAt: '00:00', runState: 'completed',
    ...(timeline ? { timeline: [{ id: 'text', kind: 'text', sequence: 1, text }] } : {}),
  }];
  // A sidebar record can have a different renderer ID from its registered artifact.
  conversation.artifacts = [{ ...info, id: 'fixture-delivery-row', artifactRef: info.id }];
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  const resolveConversationLink = vi.fn(async () => ({ artifact: info, action: 'preview' as const }));
  const read = vi.fn(async () => ({ info, text: '合成文件预览' }));
  const copyPath = vi.fn(async () => undefined);
  const reveal = vi.fn(async () => undefined);
  const openInBrowser = vi.fn(async () => undefined);
  const exportAs = vi.fn(async () => true);
  const saveToProject = vi.fn(async (_id: string, projectId: string) => ({
    projectId, artifactId: info.id, fileId: 'fixture-project-file', name: info.name, relativePath: info.name,
    absolutePath: href, sizeBytes: 42, savedAt: info.createdAt, revision: 1, contentHash: 'a'.repeat(64),
  }));
  window.asteriumArtifacts = { ...originalBridge, resolveConversationLink, inspect: vi.fn(async () => info),
    read, copyPath, reveal, openInBrowser, exportAs, saveToProject,
  } as NonNullable<typeof originalBridge>;
  const show = () => render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><ChatPage />
    <SwitchConversation id={state.conversations[1].id} /></PrototypeProvider></MemoryRouter>);
  const openMenu = async () => {
    fireEvent.contextMenu(screen.getByRole('link', { name: '合成文档' }), { clientX: 30, clientY: 45 });
    return within(await screen.findByLabelText('交付文件操作'));
  };
  return { state, conversation, show, openMenu, resolveConversationLink, read, copyPath, reveal, openInBrowser, exportAs, saveToProject };
}

it.each([false, true])('uses all six existing delivery actions for a reply link without opening a preview (timeline: %s)', async timeline => {
  const fixture = mount(timeline);
  fixture.show();
  let menu = await fixture.openMenu();
  expect(menu.getAllByRole('button').map(button => button.textContent)).toEqual([
    '用默认浏览器打开', '打开文件所在文件夹', '在文件与交付中定位', '复制路径', '文件另存为', '保存到项目',
  ]);
  expect(fixture.read).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu', { name: '回复内容操作' })).not.toBeInTheDocument();
  fireEvent.click(menu.getByRole('button', { name: '复制路径' }));
  await waitFor(() => expect(fixture.copyPath).toHaveBeenCalledWith(info.id));
  menu = await fixture.openMenu();
  fireEvent.click(menu.getByRole('button', { name: '用默认浏览器打开' }));
  await waitFor(() => expect(fixture.openInBrowser).toHaveBeenCalledWith(info.id));
  menu = await fixture.openMenu();
  fireEvent.click(menu.getByRole('button', { name: '打开文件所在文件夹' }));
  await waitFor(() => expect(fixture.reveal).toHaveBeenCalledWith(info.id));
  menu = await fixture.openMenu();
  fireEvent.click(menu.getByRole('button', { name: '文件另存为' }));
  await waitFor(() => expect(fixture.exportAs).toHaveBeenCalledWith(info.id));
  fireEvent.click(screen.getByRole('button', { name: '折叠文件与交付' }));
  menu = await fixture.openMenu();
  fireEvent.click(menu.getByRole('button', { name: '在文件与交付中定位' }));
  expect((await screen.findByTitle('预览 report.md')).closest('.artifact-row')).toHaveFocus();
  menu = await fixture.openMenu();
  fireEvent.click(menu.getByRole('button', { name: '保存到项目' }));
  const dialog = screen.getByRole('dialog', { name: '保存到项目' });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存到项目' }));
  await waitFor(() => expect(fixture.saveToProject).toHaveBeenCalledWith(info.id, fixture.state.activeProjectId));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('link', { name: '合成文档' }));
  expect(await screen.findByText('合成文件预览')).toBeInTheDocument();
  expect(fixture.resolveConversationLink).toHaveBeenCalledWith(fixture.conversation.id, href);
});

it.each(['escape', 'pointer', 'switch'])('discards a pending file menu after %s', async dismissal => {
  const fixture = mount();
  let finish!: (value: { artifact: ArtifactInfo; action: 'preview' }) => void;
  const pending = new Promise<{ artifact: ArtifactInfo; action: 'preview' }>(resolve => { finish = resolve; });
  fixture.resolveConversationLink.mockImplementation(() => pending);
  fixture.show();
  fireEvent.contextMenu(screen.getByRole('link', { name: '合成文档' }));
  if (dismissal === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
  else if (dismissal === 'pointer') fireEvent.pointerDown(document.body);
  else fireEvent.click(screen.getByRole('button', { name: '切换合成对话' }));
  await act(async () => finish({ artifact: info, action: 'preview' }));
  expect(screen.queryByLabelText('交付文件操作')).not.toBeInTheDocument();
  expect(fixture.read).not.toHaveBeenCalled();
});

it('keeps unavailable file actions disabled and refuses links outside the conversation', async () => {
  const fixture = mount();
  fixture.resolveConversationLink.mockResolvedValue({ artifact: { ...info, availability: 'missing' }, action: 'preview' });
  fixture.show();
  const menu = await fixture.openMenu();
  expect(menu.getByRole('button', { name: '用默认浏览器打开' })).toBeDisabled();
  expect(menu.getByRole('button', { name: '文件另存为' })).toBeDisabled();
  expect(menu.getByRole('button', { name: '复制路径' })).toBeEnabled();
  fireEvent.keyDown(window, { key: 'Escape' });
  window.asteriumArtifacts!.resolveConversationLink = vi.fn(async () => null);
  fireEvent.contextMenu(screen.getByRole('link', { name: '合成文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('这个文件没有在当前对话中交付');
  expect(screen.queryByLabelText('交付文件操作')).not.toBeInTheDocument();
  expect(fixture.read).not.toHaveBeenCalled();
});
