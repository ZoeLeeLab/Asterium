import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PartnerQuickCard } from '../../src/renderer/components/ui/PartnerQuickCard';
import type { ApiPartner } from '../../src/renderer/types/domain';

const apiPartner: ApiPartner = {
  id: 'deepseek-partner',
  publicIdentity: {
    displayName: '测试伙伴',
    introduction: '',
    expertise: '',
    mentionName: '测试伙伴',
  },
  status: 'online',
  isPrototype: false,
  createdAt: '2026-09-22T00:00:00.000Z',
  accent: '#58d1c2',
  sourceMode: 'api_partner',
  provider: 'deepseek',
  model: 'deepseek-chat',
  personality: '',
  apiSessionHistoryEnabled: true,
  thinkingMode: 'auto',
  reasoningEffort: 'high',
  configured: true,
};

describe('PartnerQuickCard directory presentation', () => {
  it('separates the API primary directory from additional subdirectories', () => {
    render(<PartnerQuickCard
      partner={{
        ...apiPartner,
        primaryWorkspaceGrantId: 'grant-secondary',
        workspaceGrantIds: ['grant-primary', 'grant-secondary'],
        workingDirectories: ['K:\\普通目录', 'K:\\测试伙伴工作区'],
      }}
      onUpdatePartner={vi.fn()}
      onUpdateWorkspaceGrants={vi.fn()}
    />);

    expect(screen.getByText('伙伴配置来源')).toBeInTheDocument();
    expect(screen.getByText('K:\\测试伙伴工作区')).toBeInTheDocument();
    expect(screen.getByText('子目录')).toBeInTheDocument();
    expect(screen.getByText('K:\\普通目录')).toBeInTheDocument();
    expect(screen.getByText('项目目录')).toBeInTheDocument();
    expect(screen.queryByText('此伙伴无需工作区')).not.toBeInTheDocument();
  });

  it('uses an accurate empty state before an API workspace is configured', () => {
    const { container } = render(<PartnerQuickCard partner={apiPartner} onUpdatePartner={vi.fn()} onUpdateWorkspaceGrants={vi.fn()} />);

    expect(screen.getByText('伙伴配置来源')).toBeInTheDocument();
    expect(screen.getAllByText('空')).toHaveLength(3);
    expect(screen.queryByText('此伙伴无需工作区')).not.toBeInTheDocument();
    expect(container.querySelector('.quick-model-select > svg')).toBeNull();
  });

  it('shows only the newest directory until expanded and keeps project directories out of subdirectories', () => {
    render(<PartnerQuickCard
      partner={{
        ...apiPartner,
        primaryWorkspaceGrantId: 'grant-root',
        workspaceGrantIds: ['grant-root', 'grant-old', 'grant-project', 'grant-new'],
        workingDirectories: ['K:\\伙伴目录', 'K:\\子目录一', 'K:\\项目甲', 'K:\\子目录二'],
      }}
      projects={[{
        version: 1, id: 'project-a', name: '项目甲', description: '', status: 'active', progress: 0, tags: [], memberIds: [apiPartner.id], tasks: [], files: [], revision: 1,
        createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
        workspace: { status: 'ready', rootPath: 'K:\\项目甲', deliverablesPath: 'K:\\项目甲\\deliverables' },
      }]}
      onUpdatePartner={vi.fn()}
      onUpdateWorkspaceGrants={vi.fn()}
    />);

    expect(screen.getByText('K:\\子目录二')).toBeInTheDocument();
    expect(screen.queryByText('K:\\子目录一')).not.toBeInTheDocument();
    expect(screen.getByText('K:\\项目甲')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开全部子目录' }));
    expect(screen.getByText('K:\\子目录一')).toBeInTheDocument();
    expect(screen.getAllByText('K:\\项目甲')).toHaveLength(1);
  });

  it('shows the current conversation model before the partner recent model', () => {
    render(<PartnerQuickCard partner={{ ...apiPartner, recentModel: { model: 'recent-model', status: 'recent', observedAt: '2026-10-08T00:00:00.000Z', source: 'history' } }} conversation={{ id: 'conversation-1', partnerId: apiPartner.id, title: '对话', messages: [], artifacts: [], permissionMode: 'manual', planMode: 'default', updatedAt: '2026-10-08T01:00:00.000Z', runtimeModel: { model: 'current-model', status: 'current', observedAt: '2026-10-08T01:00:00.000Z', source: 'runtime', conversationId: 'conversation-1' } }} onUpdatePartner={vi.fn()} onUpdateWorkspaceGrants={vi.fn()} />);
    expect(screen.getByText('当前模型')).toBeInTheDocument();
    expect(screen.getByText('current-model')).toBeInTheDocument();
    expect(screen.queryByText('recent-model')).not.toBeInTheDocument();
  });

  it('keeps the API model selector next to the observed runtime model', async () => {
    const onUpdatePartner = vi.fn();
    const listApiModels = vi.fn(async () => [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]);
    window.asteriumAgents = { ...window.asteriumAgents!, listApiModels };
    render(<PartnerQuickCard partner={{ ...apiPartner, credentialRef: 'credential-test' }} onUpdatePartner={onUpdatePartner} onUpdateWorkspaceGrants={vi.fn()} />);

    expect(screen.getByText('选择模型')).toBeInTheDocument();
    const selector = screen.getByRole('combobox', { name: '选择 API 模型' });
    expect(selector).toHaveValue('deepseek-chat');
    fireEvent.focus(selector);
    await waitFor(() => expect(screen.getByRole('option', { name: 'deepseek-reasoner' })).toBeInTheDocument());
    fireEvent.change(selector, { target: { value: 'deepseek-reasoner' } });
    await waitFor(() => expect(onUpdatePartner).toHaveBeenCalledWith(expect.objectContaining({ model: 'deepseek-reasoner' }))); 
  });
  it.each([true, false])('preserves the explicit tool switch %s when changing a generic API model', async tools => {
    const oldBridge = window.asteriumAgents;
    const profile = { id: 'm', serviceId: 's', model: 'deepseek-chat', name: '模型', tools, images: false };
    const configuration = { version: 1, revision: 1, models: [profile], services: [{ id: 's', name: '合成站点', protocol: 'chat_completions', endpoint: 'https://fixture.invalid/v1', credentialRef: 'synthetic-ref' }], bindings: [{ partnerId: apiPartner.id, modelId: 'm' }] };
    const mutate = vi.fn<(request: unknown) => Promise<typeof configuration>>(async () => ({ ...configuration, revision: 2 }));
    window.asteriumAgents = { ...oldBridge!, apiConnectionsGet: async () => configuration, apiConnectionsMutate: mutate, listApiModels: async () => [{ id: 'next-model' }] } as never;
    try {
      const update = vi.fn(); render(<PartnerQuickCard partner={{ ...apiPartner, provider: 'openai', credentialRef: 'fixture' }} onUpdatePartner={update} onUpdateWorkspaceGrants={vi.fn()} />);
      const selector = screen.getByRole('combobox', { name: '选择 API 模型' }); fireEvent.focus(selector);
      await screen.findByRole('option', { name: 'next-model' }); fireEvent.change(selector, { target: { value: 'next-model' } });
      await waitFor(() => expect(update).toHaveBeenCalled());
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({ action: 'model', value: { tools, images: true } });
    } finally { window.asteriumAgents = oldBridge; }
  });

  it.each([true, false])('retains the saved image preference %s when selecting an existing model', async images => {
    const oldBridge = window.asteriumAgents;
    const profile = { id: 'm', serviceId: 's', model: 'deepseek-chat', name: '当前模型', tools: true, images: false };
    const saved = { ...profile, id: 'saved', model: 'saved-model', images };
    const config = { version: 1, revision: 1, models: [profile, saved], services: [{ id: 's', name: '合成站点', protocol: 'chat_completions', endpoint: 'https://fixture.invalid/v1', credentialRef: 'synthetic-ref' }], bindings: [{ partnerId: apiPartner.id, modelId: 'm' }] };
    const mutate = vi.fn(async () => ({ ...config, revision: 2 }));
    window.asteriumAgents = { apiConnectionsGet: async () => config, apiConnectionsMutate: mutate, listApiModels: async () => [{ id: 'saved-model' }] } as never;
    try {
      const update = vi.fn(); render(<PartnerQuickCard partner={{ ...apiPartner, provider: 'openai', credentialRef: 'synthetic-ref' }} onUpdatePartner={update} onUpdateWorkspaceGrants={vi.fn()} />);
      const selector = screen.getByRole('combobox', { name: '选择 API 模型' }); fireEvent.focus(selector); await screen.findByRole('option', { name: 'saved-model' });
      fireEvent.change(selector, { target: { value: 'saved-model' } }); await waitFor(() => expect(update).toHaveBeenCalled());
      expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'model', value: expect.objectContaining({ images }) }));
    } finally { window.asteriumAgents = oldBridge; }
  });

  it('adds an API subdirectory while preserving its primary workspace grant', async () => {
    const originalAgents = window.asteriumAgents;
    const selectWorkspace = vi.fn(async () => ({ grantId: 'grant-extra', displayPath: 'K:\\新增子目录' }));
    const onUpdateWorkspaceGrants = vi.fn();
    window.asteriumAgents = { ...window.asteriumAgents!, selectWorkspace };
    try {
      render(<PartnerQuickCard
        partner={{
          ...apiPartner,
          primaryWorkspaceGrantId: 'grant-primary',
          workspaceGrantIds: ['grant-primary'],
          workingDirectories: ['K:\\API主目录'],
        }}
        onUpdatePartner={vi.fn()}
        onUpdateWorkspaceGrants={onUpdateWorkspaceGrants}
      />);

      fireEvent.click(screen.getByRole('button', { name: '添加子目录' }));

      await waitFor(() => expect(onUpdateWorkspaceGrants).toHaveBeenCalledWith(apiPartner.id, [
        { grantId: 'grant-primary', displayPath: 'K:\\API主目录' },
        { grantId: 'grant-extra', displayPath: 'K:\\新增子目录' },
      ], 'grant-primary'));
      expect(screen.getByText('子目录已添加；API 伙伴主工作目录保持不变')).toBeInTheDocument();
    } finally {
      window.asteriumAgents = originalAgents;
    }
  });
});
