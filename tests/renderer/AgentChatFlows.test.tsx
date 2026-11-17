import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

describe('local Codex renderer flow', () => {
  afterEach(() => { window.asteriumAgents = undefined; window.asteriumAttachments = undefined; });

  it('detects Codex, grants one directory, streams events, and resolves allow-once approval', async () => {
    let attachmentSent = false;
    const attachment = { id: 'attachment-image', name: '参考图.png', mediaType: 'image/png', sizeBytes: 128, createdAt: '2026-09-24T00:00:00.000Z', sentAt: '2026-09-24T00:00:00.000Z', sourceId: 'source-image', sourceAvailability: 'available' as const, sends: [], availability: 'available' as const };
    const revealAttachment = vi.fn(async () => undefined);
    const copyAttachmentPath = vi.fn(async () => undefined);
    const exportAttachment = vi.fn(async () => true);
    const saveAttachmentToProject = vi.fn(async (_attachmentId: string, _conversationId: string, projectId: string) => ({ artifactId: 'saved-attachment-artifact', projectId, fileId: 'file-attachment', revision: 1, contentHash: 'abc123456789def', sizeBytes: attachment.sizeBytes, savedAt: '2026-09-24T00:00:00.000Z', name: attachment.name, absolutePath: 'C:\\Projects\\参考图.png', relativePath: '参考图.png' }));
    window.asteriumAttachments = {
      choose: vi.fn(async () => [{ selectionId: 'pending-image', name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes }]),
      discard: vi.fn(async () => undefined),
      commit: vi.fn(async () => { attachmentSent = true; return [{ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes }]; }),
      list: vi.fn(async () => attachmentSent ? [attachment] : []),
      inspect: vi.fn(async () => attachment),
      read: vi.fn(async () => ({ info: { ...attachment, previewKind: 'image' as const }, dataUrl: 'data:image/png;base64,aW1hZ2U=' })),
      open: vi.fn(async () => undefined),
      reveal: revealAttachment,
      copyPath: copyAttachmentPath,
      exportAs: exportAttachment,
      saveToProject: saveAttachmentToProject,
      thumbnail: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
      deleteConversation: vi.fn(async () => undefined),
    };
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const sendLocalCliMessage = vi.fn(async (
      adapterType: 'claude_code' | 'codex_cli',
      partnerId: string,
      partnerRootGrantId: string | undefined,
      grantIds: string[],
      command: SendMessageCommand,
    ) => {
      void adapterType;
      void partnerId;
      void partnerRootGrantId;
      void grantIds;
      void command;
      return { runId: 'turn-1', sessionId: 'thread-1' };
    });
    const resolveAuthorization = vi.fn(async () => undefined);
    const sendGuidance = vi.fn(async () => ({ disposition: 'accepted' as const }));
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
      detectCodex: vi.fn(async () => ({
        installed: true, loggedIn: true, version: '0.144.5', authMethod: 'using ChatGPT', executableLabel: 'codex.exe',
        recommendedRuntimeId: 'runtime-global',
        runtimes: [{ runtimeId: 'runtime-global', executablePath: 'C:\\npm\\codex.exe', executableLabel: 'codex.exe', environment: 'global_cli' as const, environmentLabel: '全局 npm CLI', codexHome: 'C:\\Users\\fixture-user\\.codex', installed: true, loggedIn: true, version: '0.144.5', authMethod: 'using ChatGPT' }],
      })),
      listCodexModels: vi.fn(async () => [{ model: 'codex-fixture-model', displayName: '测试模型', defaultEffort: 'medium', efforts: ['medium', 'high'] }]),
      selectWorkspace: vi.fn(async () => ({ grantId: 'grant-codex', displayPath: 'K:\\qa\\codex-smoke-renderer' })),
      sendClaudeMessage: vi.fn(),
      sendLocalCliMessage,
      cancelRun: vi.fn(async () => undefined),
      sendGuidance,
      resumeSession: vi.fn(async () => undefined),
      resolveAuthorization,
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    expect((await screen.findAllByText(/0\.144\.5/)).length).toBeGreaterThan(0);
    expect(screen.getByText('C:\\npm\\codex.exe')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\fixture-user\\.codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开启新线程' })).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: '导入配置来源' }));
    expect(await screen.findByText('K:\\qa\\codex-smoke-renderer')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '测试助手' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '测试助手' } });
    fireEvent.click(screen.getByRole('button', { name: '确认邀请本地伙伴' }));
    expect(await screen.findByText('测试助手 已加入星丛')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去和 TA 聊聊' }));

    const input = await screen.findByRole('textbox', { name: /给 测试助手 发送消息/ });
    fireEvent.click(screen.getByRole('button', { name: '添加图片或文件' }));
    expect(await screen.findByAltText('参考图.png')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '请生成一份文件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendLocalCliMessage).toHaveBeenCalledTimes(1));
    expect(sendLocalCliMessage).toHaveBeenCalledWith(
      'codex_cli',
      expect.any(String),
      'grant-codex',
      [],
      expect.objectContaining({ connectionSource: 'local_cli', content: { type: 'text', text: '请生成一份文件' }, runtimeContext: expect.not.objectContaining({ user: expect.anything() }) }),
      'runtime-global',
      'global_cli',
    );
    expect(sendLocalCliMessage.mock.calls[0][4].sessionId).toBeUndefined();
    expect(sendLocalCliMessage.mock.calls[0][4].attachments).toEqual([{ id: 'attachment-image', name: '参考图.png', mediaType: 'image/png', sizeBytes: 128 }]);
    expect(await screen.findByText('我的附件')).toBeInTheDocument();
    expect(screen.getAllByText('参考图.png').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: '添加文件' })).not.toBeInTheDocument();
    const deliveryPanel = screen.getByLabelText('交付文件');
    expect(deliveryPanel).toHaveClass('artifact-list');
    fireEvent.pointerMove(deliveryPanel, { clientX: 0 });
    expect(deliveryPanel).toHaveClass('artifact-list--scrollbar');
    fireEvent.click(screen.getByRole('button', { name: '折叠文件与交付' }));
    expect(screen.queryByLabelText('交付文件')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开文件与交付' }));
    const attachmentPanel = screen.getByLabelText('我的附件');
    expect(attachmentPanel).toHaveClass('artifact-list');
    fireEvent.pointerMove(attachmentPanel, { clientX: 0 });
    expect(attachmentPanel).toHaveClass('artifact-list--scrollbar');
    fireEvent.click(screen.getByRole('button', { name: '折叠我的附件' }));
    expect(screen.queryByLabelText('我的附件')).not.toBeInTheDocument();
    expect(localStorage.getItem('asterium.chat.collapsedResourceSections')).toContain('"attachments":true');
    fireEvent.click(screen.getByRole('button', { name: '展开我的附件' }));
    const expandedAttachmentPanel = screen.getByLabelText('我的附件');
    fireEvent.click(within(expandedAttachmentPanel).getByTitle('打开原文件所在文件夹'));
    expect(revealAttachment).toHaveBeenCalledWith('attachment-image', expect.any(String));
    fireEvent.contextMenu(within(expandedAttachmentPanel).getByText('参考图.png'));
    expect(screen.getByRole('button', { name: '复制原文件路径' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '文件另存为' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存到项目' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复制原文件路径' }));
    expect(copyAttachmentPath).toHaveBeenCalledWith('attachment-image', expect.any(String));
    fireEvent.contextMenu(within(expandedAttachmentPanel).getByText('参考图.png'));
    fireEvent.click(screen.getByRole('button', { name: '文件另存为' }));
    expect(exportAttachment).toHaveBeenCalledWith('attachment-image', expect.any(String));
    fireEvent.contextMenu(within(expandedAttachmentPanel).getByText('参考图.png'));
    fireEvent.click(screen.getByRole('button', { name: '保存到项目' }));
    fireEvent.click(screen.getByRole('button', { name: '保存到项目' }));
    await waitFor(() => expect(saveAttachmentToProject).toHaveBeenCalledWith('attachment-image', expect.any(String), expect.any(String)));
    const messageAttachmentCard = document.querySelector<HTMLButtonElement>('.message-attachment-card');
    expect(messageAttachmentCard).not.toBeNull();
    fireEvent.contextMenu(messageAttachmentCard!);
    expect(screen.getByRole('button', { name: '复制原文件路径' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '文件另存为' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存到项目' })).toBeInTheDocument();
    fireEvent.pointerDown(window);

    const sent = sendLocalCliMessage.mock.calls[0][4];
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: 'event-1',
      partnerId: sent.partnerId,
      conversationId: sent.conversationId,
      connectionSource: 'local_cli' as const,
      clientMessageId: sent.clientMessageId,
      sessionId: 'thread-1',
      runId: 'turn-1',
      occurredAt: new Date(0).toISOString(),
    };
    act(() => listener?.({ ...base, type: 'session.bound', isNew: true, sequence: 1 }));
    act(() => listener?.({ ...base, eventId: 'event-2', type: 'message.accepted', sequence: 2 }));
    fireEvent.change(input, { target: { value: '先确认测试，再继续处理文件' } });
    fireEvent.click(screen.getByRole('button', { name: '暂存中途消息' }));
    expect(sendGuidance).not.toHaveBeenCalled();
    const pendingGuidance = screen.getByLabelText('待发送的中途消息');
    fireEvent.click(within(pendingGuidance).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendGuidance).toHaveBeenCalledWith(expect.objectContaining({
      type: 'guidance.send',
      runId: 'turn-1',
      sessionId: 'thread-1',
      content: { type: 'text', text: '先确认测试，再继续处理文件' },
    })));
    expect(screen.getAllByText('先确认测试，再继续处理文件').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '停止当前任务' })).toBeInTheDocument();
    act(() => listener?.({ ...base, eventId: 'event-3', type: 'tool.started', sequence: 3, toolCallId: 'file-1', toolName: 'fileChange', summary: '准备修改文件…', mutatesExternalState: true }));
    act(() => listener?.({ ...base, eventId: 'event-4', type: 'work.status', sequence: 4, state: 'waiting_authorization', summary: 'Codex 请求修改文件。' }));
    act(() => listener?.({ ...base, eventId: 'event-5', type: 'authorization.requested', sequence: 5, authorizationId: 'auth-1', toolCallId: 'file-1', action: 'write_file', risk: 'medium', summary: 'Codex 请求修改文件。', targets: ['K:\\qa\\result.md'] }));

    expect(await screen.findByText('需要你的确认')).toBeInTheDocument();
    expect(screen.getByText('测试助手请求修改文件。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    await waitFor(() => expect(resolveAuthorization).toHaveBeenCalledWith(expect.objectContaining({ authorizationId: 'auth-1', decision: 'allow_once', runId: 'turn-1' })));

    act(() => listener?.({ ...base, eventId: 'event-6', type: 'authorization.resolved', sequence: 6, authorizationId: 'auth-1', decision: 'allow_once' }));
    act(() => listener?.({ ...base, eventId: 'event-7', type: 'work.status', sequence: 7, state: 'working', summary: '授权已确认，Codex 继续工作…' }));
    const messageList = document.querySelector<HTMLElement>('.message-list')!;
    let messageScrollHeight = 900;
    Object.defineProperty(messageList, 'scrollHeight', { configurable: true, get: () => messageScrollHeight });
    Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: 400 });
    messageList.scrollTop = 500;
    fireEvent.scroll(messageList);
    messageScrollHeight = 1_200;
    act(() => listener?.({ ...base, eventId: 'event-8', type: 'text.delta', sequence: 8, text: '文件已经准备好。' }));
    expect(messageList.scrollTop).toBe(1_200);
    messageScrollHeight = 1_400;
    act(() => { messageList.append(document.createElement('div')); });
    await waitFor(() => expect(messageList.scrollTop).toBe(1_400));
    expect(await screen.findByRole('status', { name: '测试助手仍在工作' })).toBeInTheDocument();
    act(() => listener?.({ ...base, eventId: 'event-9', type: 'file.produced', sequence: 9, artifactId: 'artifact-1', toolCallId: 'file-1', name: 'result.md', artifactRef: 'K:\\qa\\result.md', changeKind: 'create' }));
    act(() => listener?.({ ...base, eventId: 'event-10', type: 'tool.completed', sequence: 10, toolCallId: 'file-1', outcome: 'success', summary: '修改文件完成' }));
    act(() => listener?.({ ...base, eventId: 'event-11', type: 'run.completed', sequence: 11, finishReason: 'end_turn' }));

    expect(await screen.findByText('文件已经准备好。')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '测试助手仍在工作' })).not.toBeInTheDocument();
    expect(screen.getByText('已允许 · 写入文件')).toBeInTheDocument();
    expect(screen.getByText(/把 result\.md 写好了$/)).toBeInTheDocument();
    expect(screen.queryByText('授权记录')).not.toBeInTheDocument();
    expect(screen.getByText('测试助手请求修改文件。')).toBeInTheDocument();
    expect(screen.queryByText('授权已确认，Codex 继续工作…')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('预览 result.md')).toHaveLength(2);
    expect(screen.queryByText('需要你的确认')).not.toBeInTheDocument();

    const modelSelect = screen.getByRole('combobox', { name: '选择 Codex 模型' });
    expect(modelSelect.closest('.partner-quick-card')).toBeInTheDocument();
    fireEvent.focus(modelSelect);
    await within(modelSelect).findByRole('option', { name: '测试模型' });
    expect(window.asteriumAgents?.listCodexModels).toHaveBeenCalledWith({
      partnerRootGrantId: 'grant-codex', codexRuntimeId: 'runtime-global', codexRuntimeEnvironment: 'global_cli',
    });
    fireEvent.change(modelSelect, { target: { value: 'codex-fixture-model' } });
    fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), { target: { value: 'high' } });
    expect(sendLocalCliMessage.mock.calls[0][4].execution?.codexModel).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: '引用' }));
    const quoteCard = screen.getByLabelText('引用 测试助手 的完整回复');
    expect(within(quoteCard).getByText('文件已经准备好。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '请补充一句' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendLocalCliMessage).toHaveBeenCalledTimes(2));
    expect(sendLocalCliMessage.mock.calls[1][4]).toMatchObject({
      conversationId: sendLocalCliMessage.mock.calls[0][4].conversationId,
      sessionId: 'thread-1',
      execution: { codexModel: { model: 'codex-fixture-model', effort: 'high' } },
    });
    expect(sendLocalCliMessage.mock.calls[1][4].content).toEqual({
      type: 'text',
      text: '[引用内容 · 测试助手 · 完整回复]\n文件已经准备好。\n[引用结束]\n\n[用户本轮消息]\n请补充一句',
    });
    expect(screen.getByLabelText('引用 测试助手 的完整回复')).toBeInTheDocument();
  });

  it('lets the user choose an existing Codex thread and imports it into a new chat window', async () => {
    const sentCommands: SendMessageCommand[] = [];
    let directoryAvailable = false;
    const chooseCodexThreadDirectory = vi.fn(async () => ({
      date: '2026-09-03', unavailableCount: 0, threads: [
        { selectionId: 'selection-imported', threadId: 'thread-imported', title: '已有研究线程',
          cwd: 'K:\\qa\\thread-import', updatedAt: '2026-09-11T12:00:00.000Z', directoryAvailable,
          currentRecord: { date: '2026-09-07' } },
        { selectionId: 'selection-other', threadId: 'thread-other', title: '同日另一条线程',
          cwd: 'K:\\qa\\other', directoryAvailable: true },
      ],
    }));
    const confirmCodexThreadImport = vi.fn(async (_selectionId: string, partnerId: string) => ({
      kind: 'conversation' as const,
      conversation: { id: 'conversation-imported', partnerId, title: '已有研究线程', messages: [],
        updatedAt: '2026-09-11T12:00:00.000Z', sessionId: 'thread-imported', importedCodexThread: true },
    }));
    const chooseCodexImportedDirectory = vi.fn(async () => {
      directoryAvailable = true;
      return { directory: 'K:\\qa\\thread-renamed', available: true };
    });
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
      detectCodex: vi.fn(async () => ({
        installed: true, loggedIn: true, version: '0.144.5', authMethod: 'using ChatGPT', executableLabel: 'codex.exe',
        recommendedRuntimeId: 'runtime-global',
        runtimes: [
          { runtimeId: 'runtime-global', executablePath: 'C:\\npm\\codex.exe', executableLabel: 'codex.exe', environment: 'global_cli' as const, environmentLabel: '全局 npm CLI', codexHome: 'C:\\Users\\fixture-user\\.codex', installed: true, loggedIn: true, version: '0.144.5', authMethod: 'using ChatGPT' },
          { runtimeId: 'runtime-desktop', executablePath: 'C:\\desktop\\codex.exe', executableLabel: 'codex.exe', environment: 'desktop_app' as const, environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', installed: true, loggedIn: true, version: '0.153.4', authMethod: 'using ChatGPT' },
        ],
      })),
      chooseCodexThreadDirectory,
      confirmCodexThreadImport,
      codexImportedWorkspaceStatus: vi.fn(async () => ({ directory: 'K:\\qa\\thread-import', available: directoryAvailable })),
      chooseCodexImportedDirectory,
      selectWorkspace: vi.fn(async () => ({ grantId: 'grant-partner', displayPath: 'J:\\qa\\partner-source' })),
      sendClaudeMessage: vi.fn(),
      sendLocalCliMessage: vi.fn(async (_adapterType, _partnerId, _partnerRootGrantId, _grantIds, command) => {
        sentCommands.push(command);
        if (sentCommands.length === 1) throw new Error('CODEX_THREAD_IN_USE');
        return { runId: 'turn-imported', sessionId: 'thread-imported' };
      }),
      cancelRun: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => undefined),
      resolveAuthorization: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    expect(await screen.findByRole('button', { name: /选择 Codex 运行时 全局 npm CLI/ })).toHaveClass('active');
    const desktopRuntime = screen.getByRole('button', { name: /选择 Codex 运行时 Codex 桌面应用/ });
    fireEvent.click(desktopRuntime);
    expect(desktopRuntime).toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: /选择 Codex 运行时 全局 npm CLI/ }));
    fireEvent.click(screen.getByRole('button', { name: '导入配置来源' }));
    expect(await screen.findByText('J:\\qa\\partner-source')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入已有线程' }));
    const confirmSelection = await screen.findByRole('button', { name: '确认选择' });
    expect(confirmSelection).toBeDisabled();
    expect(screen.getByRole('radio', { name: /同日另一条线程/ })).toBeInTheDocument();
    expect(screen.getByText('将续接 Codex 当前记录（2026-09-07）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /已有研究线程/ }));
    fireEvent.click(confirmSelection);
    expect(chooseCodexThreadDirectory).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'runtime-global', runtimeEnvironment: 'global_cli',
    }));
    expect(confirmCodexThreadImport).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '续接伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '续接伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '确认邀请本地伙伴' }));
    const chooseDirectory = await screen.findByRole('button', { name: '重新选择目录' });
    expect(confirmCodexThreadImport).toHaveBeenCalledExactlyOnceWith('selection-imported', expect.any(String), 'manual');
    expect(screen.getByRole('textbox', { name: '请先重新选择工作目录' })).toBeDisabled();
    fireEvent.click(chooseDirectory);
    await waitFor(() => expect(chooseCodexImportedDirectory).toHaveBeenCalledWith(expect.any(String), 'conversation-imported'));
    const input = await screen.findByRole('textbox', { name: /给 续接伙伴 发送消息/ });
    fireEvent.change(input, { target: { value: '继续之前的话题' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const retry = await screen.findByRole('button', { name: '重试' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(sentCommands).toHaveLength(2));
    const [first, retried] = sentCommands;
    expect(first).toMatchObject({ conversationId: 'conversation-imported', sessionId: 'thread-imported', content: { text: '继续之前的话题' } });
    expect(retried).toMatchObject({ conversationId: first.conversationId, sessionId: first.sessionId, messageId: first.messageId });
    expect(retried.clientMessageId).not.toBe(first.clientMessageId);
    expect(window.asteriumAgents.sendLocalCliMessage).toHaveBeenCalledWith('codex_cli', expect.any(String), 'grant-partner', [], expect.any(Object), 'runtime-global', 'global_cli');
  });

  it('connects an existing partner through CyberBoss, sends mixed attachments, and renders the bridged reply', async () => {
    const imageData = { name: '样图.png', mediaType: 'image/png', sizeBytes: 128 };
    const image = { id: 'attachment-cyberboss-image', ...imageData };
    const fileData = { name: '方案.md', mediaType: 'text/markdown', sizeBytes: 40 };
    const file = { id: 'attachment-cyberboss-file', ...fileData };
    const choose = vi.fn(async () => [{ selectionId: 'pending-image', ...imageData }, { selectionId: 'pending-file', ...fileData }]);
    const commit = vi.fn(async () => [image, file]);
    window.asteriumAttachments = {
      choose, commit, discard: vi.fn(), list: vi.fn(async () => []),
      thumbnail: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
      inspect: vi.fn(async (id: string) => ({
        ...(id === image.id ? image : file), createdAt: '', sentAt: '', sourceId: 'source-attachment', sends: [],
        sourceAvailability: 'available' as const, availability: 'available' as const,
      })),
      read: vi.fn(), open: vi.fn(), reveal: vi.fn(), copyPath: vi.fn(), exportAs: vi.fn(), saveToProject: vi.fn(), deleteConversation: vi.fn(),
    };
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    let sentCommand: SendMessageCommand | undefined;
    let runCount = 0;
    const sendExistingThreadMessage = vi.fn(async (_connection, command: SendMessageCommand) => {
      sentCommand = command;
      return { runId: `bridge-run-${++runCount}`, sessionId: '00000000-0000-7000-8000-000000000001' };
    });
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      saveBridgeCredential: vi.fn(async () => ({ credentialRef: 'credential-cyberboss', configured: true, masked: '••••••••' })),
      testExistingThread: vi.fn(async () => ({
        credentialRef: 'credential-cyberboss', configured: true, masked: '••••••••', authenticated: true,
        threadId: '00000000-0000-7000-8000-000000000001',
        workspaceRoot: '/workspace/example-project',
        capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
      })),
      getExistingThreadFileCapabilities: vi.fn(async () => ({
        fileTypes: { md: 'text/markdown' }, maxFileBytes: 20_971_520, maxAttachments: 10, maxImages: 4,
        maxImageBytes: 10_485_760, maxTotalBytes: 52_428_800, mixedWithImages: true,
      })),
      sendExistingThreadMessage,
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://cyberboss.example.invalid' } });
    fireEvent.change(screen.getByLabelText(/认证信息/), { target: { value: 'renderer-bridge-secret' } });
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '示例伙伴甲' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '示例伙伴甲' } });
    fireEvent.click(screen.getByRole('button', { name: '测试真实连接' }));
    expect(await screen.findByText(/星丛会动态跟随 CyberBoss 当前活跃线程/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接回伙伴' }));
    expect(await screen.findByText('示例伙伴甲 已加入星丛')).toBeInTheDocument();
    expect(localStorage.getItem('asterium.prototype.v7')).not.toContain('renderer-bridge-secret');
    expect(localStorage.getItem('asterium.prototype.v7')).toContain('credential-cyberboss');
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('asterium.prototype.v7') ?? '{}') as {
        partners?: Array<{ id: string; publicIdentity?: { displayName?: string } }>;
        conversations?: Array<{ partnerId: string; sessionId?: string; isPrimaryThread?: boolean }>;
      };
      const storedPartner = stored.partners?.find((partner) => partner.publicIdentity?.displayName === '示例伙伴甲');
      const primaryConversations = stored.conversations?.filter((conversation) => conversation.partnerId === storedPartner?.id) ?? [];
      expect(primaryConversations).toHaveLength(1);
      expect(primaryConversations[0]).toMatchObject({ sessionId: '00000000-0000-7000-8000-000000000001', isPrimaryThread: true });
    });
    fireEvent.click(screen.getByRole('button', { name: '去和 TA 聊聊' }));

    const input = await screen.findByRole('textbox', { name: /给 示例伙伴甲 发送消息/ });
    fireEvent.click(await screen.findByRole('button', { name: '添加图片或文件' }));
    expect(await screen.findByAltText('样图.png')).toBeInTheDocument();
    expect(screen.getByText('方案.md')).toBeInTheDocument();
    expect(choose).toHaveBeenCalledWith(10, undefined, true);
    expect(screen.queryByText(/伙伴无法查看其中的图片/)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '星丛桥接测试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendExistingThreadMessage).toHaveBeenCalledTimes(1));
    expect(screen.getByText('示例伙伴甲 正在整理思路')).toBeInTheDocument();
    expect(sendExistingThreadMessage.mock.calls[0][0]).toEqual({
      serviceUrl: 'https://cyberboss.example.invalid',
      threadId: '00000000-0000-7000-8000-000000000001',
      workspaceRoot: '/workspace/example-project',
      credentialRef: 'credential-cyberboss',
    });
    expect(sentCommand).toMatchObject({
      connectionSource: 'existing_thread',
      sessionId: '00000000-0000-7000-8000-000000000001',
      content: { type: 'text', text: '星丛桥接测试' },
      attachments: [image, file],
    });
    expect(commit).toHaveBeenCalledWith(sentCommand?.conversationId, ['pending-image', 'pending-file'], sentCommand?.messageId);

    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: sentCommand!.partnerId, conversationId: sentCommand!.conversationId,
      connectionSource: 'existing_thread' as const, clientMessageId: sentCommand!.clientMessageId,
      sessionId: '00000000-0000-7000-8000-000000000001', runId: 'bridge-run-1', occurredAt: new Date(0).toISOString(),
    };
    act(() => listener?.({ ...base, eventId: 'bridge-event-1', type: 'session.bound', isNew: false, sequence: 1 }));
    act(() => listener?.({ ...base, eventId: 'bridge-event-2', type: 'message.accepted', sequence: 2 }));
    act(() => listener?.({ ...base, eventId: 'bridge-event-3', type: 'work.status', state: 'thinking', summary: '外部伙伴正在输入…', sequence: 3 }));
    expect(screen.getByText('示例伙伴甲正在输入…')).toBeInTheDocument();
    expect(screen.getByTitle('当前桥接暂不支持远程取消')).toBeDisabled();
    act(() => listener?.({ ...base, eventId: 'bridge-event-4', type: 'text.delta', text: '示例用户，我从原线程收到啦。', sequence: 4 }));
    expect(await screen.findByText('示例用户，我从原线程收到啦。')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '示例伙伴甲仍在工作' })).toBeInTheDocument();
    act(() => listener?.({ ...base, eventId: 'bridge-event-5', type: 'run.completed', finishReason: 'end_turn', sequence: 5 }));
    const lateReply = {
      type: 'existing_thread.reply' as const, partnerId: base.partnerId, conversationId: base.conversationId,
      threadId: base.sessionId, eventId: '2148', occurredAt: base.occurredAt, text: '这是查到的结论。',
    };
    act(() => {
      listener?.(lateReply);
      listener?.(lateReply);
      listener?.({ ...lateReply, threadId: 'another-thread', text: '其他线程的消息' });
    });
    expect(await screen.findByText('这是查到的结论。')).toBeInTheDocument();
    expect(screen.getByText('示例用户，我从原线程收到啦。')).toBeInTheDocument();
    expect(screen.getAllByText('这是查到的结论。')).toHaveLength(1);
    expect(screen.queryByText('其他线程的消息')).not.toBeInTheDocument();
    expect(screen.queryByText('示例伙伴甲 正在整理思路')).not.toBeInTheDocument();
    const streamStatus = { name: '示例伙伴甲仍在工作' };
    expect(screen.queryByRole('status', streamStatus)).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '合成的下一轮问题' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendExistingThreadMessage).toHaveBeenCalledTimes(2));
    const nextRun = { ...base, clientMessageId: sentCommand!.clientMessageId, runId: 'bridge-run-2' };
    act(() => {
      listener?.({ ...nextRun, eventId: 'bridge-next-bound', type: 'session.bound', isNew: false, sequence: 1 });
      listener?.({ ...nextRun, eventId: 'bridge-next-text', type: 'text.delta', text: '合成的下一轮回复。', sequence: 2 });
    });
    const nextReply = screen.getByText('合成的下一轮回复。').closest('article')!;
    expect(screen.getByRole('status', streamStatus)).toBe(within(nextReply).getByRole('status', streamStatus));
    act(() => listener?.({ ...nextRun, eventId: 'bridge-next-done', type: 'run.completed', finishReason: 'end_turn', sequence: 3 }));
    expect(screen.queryByRole('status', streamStatus)).not.toBeInTheDocument();
    expect(screen.getByText('这是查到的结论。')).toBeInTheDocument();
  });

  it('stores a DeepSeek credential by reference and renders a real streamed reply', async () => {
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    let sentCommand: SendMessageCommand | undefined;
    const sendApiMessage = vi.fn(async (_connection, command: SendMessageCommand) => {
      sentCommand = command;
      return { runId: 'api-run-1', sessionId: 'api-session-1' };
    });
    const attachment = { id: 'large-reference', name: '测试文档.json', mediaType: 'application/json', sizeBytes: 21 * 1024 * 1024, localReference: true } as const;
    const choose = vi.fn(async () => [{ ...attachment, selectionId: 'large-reference-selection' }]);
    window.asteriumAttachments = {
      choose, discard: vi.fn(), commit: vi.fn(async () => [attachment]),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => ({ ...attachment, availability: 'available' as const, sourceAvailability: 'available' as const, sends: [], sentAt: '', createdAt: '', sourceId: 'source' })),
      read: vi.fn(), open: vi.fn(), thumbnail: vi.fn(),
      reveal: vi.fn(), copyPath: vi.fn(), exportAs: vi.fn(), saveToProject: vi.fn(), deleteConversation: vi.fn(),
    };
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      saveApiCredential: vi.fn(async () => ({ credentialRef: 'credential-deepseek', configured: true, masked: '••••••••' })),
      apiCredentialStatus: vi.fn(async () => ({ credentialRef: 'credential-deepseek', configured: true, masked: '••••••••' })),
      sendApiMessage,
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '添加新伙伴' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-deepseek' } });
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'deepseek-v4-flash' } });
    expect(screen.queryByLabelText('完整 API 端点')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('deepseek-v4-flash')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'renderer-only-secret' } });
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: 'DeepSeek 伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: 'DeepSeek伙伴' } });
    fireEvent.change(screen.getByLabelText('性格与相处方式'), { target: { value: '温柔、简洁' } });
    fireEvent.click(screen.getByRole('button', { name: '添加 API 伙伴' }));
    expect(await screen.findByText('DeepSeek 伙伴 已加入星丛')).toBeInTheDocument();
    expect(localStorage.getItem('asterium.prototype.v7')).not.toContain('renderer-only-secret');
    expect(localStorage.getItem('asterium.prototype.v7')).toContain('credential-deepseek');
    fireEvent.click(screen.getByRole('button', { name: '去和 TA 聊聊' }));

    const input = await screen.findByRole('textbox', { name: /给 DeepSeek 伙伴 发送消息/ });
    const permission = screen.getByRole('button', { name: '权限模式：手动审批' });
    expect(permission).toBeEnabled();
    fireEvent.click(permission);
    expect(screen.getByRole('menuitemradio', { name: /自动审批/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /手动审批/ }));
    fireEvent.click(screen.getByRole('button', { name: '指令' }));
    const planMode = screen.getByRole('menuitemcheckbox', { name: /计划模式/ });
    expect(planMode).toBeEnabled();
    fireEvent.click(planMode);
    fireEvent.click(screen.getByRole('button', { name: '指令' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /计划模式/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加图片或文件' }));
    expect(await screen.findByText(/本地引用/)).toBeVisible();
    expect(choose).toHaveBeenCalledWith(10, undefined, true);
    fireEvent.change(input, { target: { value: '你好呀' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendApiMessage).toHaveBeenCalledTimes(1));
    expect(sendApiMessage.mock.calls[0][0]).toEqual({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', credentialRef: 'credential-deepseek', thinkingMode: 'auto', reasoningEffort: 'high', primaryWorkspaceGrantId: undefined, workspaceGrantIds: [], attachmentCapabilities: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } });
    expect(sentCommand).toMatchObject({ connectionSource: 'api_partner', apiContext: { history: [], apiSessionHistoryEnabled: true } });
    expect(sentCommand?.attachments).toEqual([attachment]);
    expect(sentCommand!.apiContext).not.toHaveProperty('systemPrompt');
    expect(sentCommand!.apiContext).not.toHaveProperty('userProfileContext');

    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: sentCommand!.partnerId, conversationId: sentCommand!.conversationId,
      connectionSource: 'api_partner' as const, clientMessageId: sentCommand!.clientMessageId, sessionId: 'api-session-1', runId: 'api-run-1', occurredAt: new Date(0).toISOString(),
    };
    act(() => listener?.({ ...base, eventId: 'api-event-1', type: 'session.bound', isNew: true, sequence: 1 }));
    act(() => listener?.({ ...base, eventId: 'api-event-2', type: 'message.accepted', sequence: 2 }));
    act(() => listener?.({ ...base, eventId: 'api-event-3', type: 'text.delta', text: '你好，用户。', sequence: 3 }));
    act(() => listener?.({ ...base, eventId: 'api-event-4', type: 'run.completed', finishReason: 'end_turn', sequence: 4 }));
    expect(await screen.findByText('你好，用户。')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '继续聊' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendApiMessage).toHaveBeenCalledTimes(2));
    const continuedCommand = sendApiMessage.mock.calls[1][1];
    expect(continuedCommand.sessionId).toBe('api-session-1');
    expect(continuedCommand.apiContext).not.toHaveProperty('systemPrompt');
    expect(continuedCommand.apiContext).not.toHaveProperty('userProfileContext');
  });
});
