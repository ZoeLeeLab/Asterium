import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiPartnerConnectionFields } from '../../src/renderer/components/settings/ApiPartnerConnectionFields';
import { saveApiPartnerConnection, newApiModel, type ApiConnectionValue } from '../../src/renderer/components/settings/apiPartnerConnection';
import { apiSitePreset } from '../../src/shared/apiPresets';
import type { ApiConfiguration, ApiConfigurationMutation } from '../../src/shared/apiConnections';

const configuration: ApiConfiguration = { version: 1, revision: 4, services: [{ id: 's', name: '通用服务', protocol: 'chat_completions', endpoint: 'https://fixture.invalid/v1', credentialRef: 'encrypted-ref', settings: { headers: [{ name: 'X-Site', credentialRef: 'header-ref' }] } }], models: [{ id: 'm', serviceId: 's', model: 'exact-model', name: '聊天模型', tools: true, images: false }], bindings: [] };
function setup(config = configuration) {
  let data = structuredClone(config);
  const mutate = vi.fn(async (request: ApiConfigurationMutation) => {
    if (request.action === 'service') data.services = [...data.services.filter(item => item.id !== request.value.id), request.value];
    if (request.action === 'model') data.models = [...data.models.filter(item => item.id !== request.value.id), request.value];
    if (request.action === 'delete_service') data.services = data.services.filter(item => item.id !== request.id);
    data = { ...data, revision: data.revision + 1 }; return structuredClone(data);
  });
  const save = vi.fn(async () => ({ credentialRef: 'new-ref', configured: true, masked: '••••' }));
  const list = vi.fn(async () => [{ id: 'model-a' }, { id: 'model-b' }]);
  const probe = vi.fn();
  window.asteriumAgents = { apiConnectionsGet: async () => structuredClone(data), apiConnectionsMutate: mutate, apiConnectionsProbe: probe, saveApiCredential: save, listApiModels: list } as never;
  return { mutate, save, list, probe };
}
const initial: ApiConnectionValue = { service: apiSitePreset('preset-deepseek'), provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: '', model: '' };
function Form({ value = initial, onChange = () => undefined, submit = () => undefined }: { value?: ApiConnectionValue; onChange?: (value: Partial<ApiConnectionValue>) => void; submit?: () => void }) {
  const [draft, setDraft] = useState(value);
  return <form onSubmit={event => { event.preventDefault(); submit(); }}><ApiPartnerConnectionFields value={draft} onChange={next => { setDraft(current => ({ ...current, ...next })); onChange(next); }} /></form>;
}

describe('API partner site configuration', () => {
  it('shows five ready presets and only key/model fields, with advanced settings closed', () => {
    setup(); const { container } = render(<Form />);
    for (const name of ['DeepSeek', 'Kimi', 'OpenAI', 'Anthropic', '硅基流动', '＋ 自定义配置…']) expect(screen.getByRole('option', { name })).toBeInTheDocument();
    expect(screen.queryByLabelText('完整 API 端点')).not.toBeInTheDocument();
    expect(container.querySelector('details[open]')).toBeNull();
    expect(screen.getByLabelText('API Key')).toHaveValue('');
  });
  it('makes disabled tools visible without enabling them, then reflects an explicit opt-in', async () => {
    setup(); const changed = vi.fn();
    const model = { ...configuration.models[0], tools: false };
    render(<Form value={{ ...initial, service: configuration.services[0], model: model.model, modelConfig: model }} onChange={changed} />);
    expect(screen.getByText(/工具调用未启用：伙伴只能文字聊天/)).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('高级模型设置'));
    fireEvent.click(screen.getByRole('checkbox', { name: '启用工具调用' }));
    expect(screen.getByText('工具调用已启用；实际操作仍遵循会话权限与审批。')).toBeInTheDocument();
    expect(changed.mock.calls.at(-1)?.[0].modelConfig.tools).toBe(true);
  });
  it('reuses saved site credentials, fetches selectable models, and preserves saved model capabilities', async () => {
    const { list } = setup(); const changed = vi.fn(); render(<Form onChange={changed} />);
    await screen.findByRole('option', { name: '通用服务' });
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 's' } });
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
    await screen.findByRole('option', { name: 'model-a' });
    expect(list).toHaveBeenCalledWith('openai', 'https://fixture.invalid/v1', 'encrypted-ref', undefined, 's');
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'exact-model' } });
    expect(changed.mock.calls.at(-1)?.[0].modelConfig).toMatchObject({ id: 'm', tools: true });
  });
  it('does not carry keys or stale model results across sites', async () => {
    const { list } = setup(); let complete!: (models: { id: string }[]) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<Form />);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'transient' } });
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-kimi' } });
    complete([{ id: 'wrong-site-model' }]);
    await waitFor(() => expect(screen.getByRole('button', { name: '拉取模型' })).toBeEnabled());
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.queryByRole('option', { name: 'wrong-site-model' })).not.toBeInTheDocument();
  });
  it('saves a custom site with optional headers encrypted, without sending a model request or submitting the partner', async () => {
    const { mutate, save, probe } = setup(); const submit = vi.fn(); render(<Form submit={submit} />);
    await screen.findByRole('option', { name: '通用服务' });
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'custom' } });
    const dialog = within(screen.getByRole('dialog', { name: '新增自定义站点' }));
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '我的中转站' } });
    fireEvent.change(dialog.getByLabelText('地址'), { target: { value: 'https://other.invalid/v1' } });
    fireEvent.change(dialog.getByLabelText('API Key'), { target: { value: 'fixture-secret' } });
    fireEvent.change(dialog.getByLabelText('Headers（可选）'), { target: { value: '{"X-Custom":"header-secret"}' } });
    fireEvent.click(dialog.getByRole('button', { name: '确认' }));
    await screen.findByRole('option', { name: '我的中转站' });
    expect(save).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mutate.mock.calls)).not.toContain('fixture-secret');
    expect(JSON.stringify(mutate.mock.calls)).not.toContain('header-secret');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'service', expectedRevision: 4, value: expect.objectContaining({ credentialRef: 'new-ref', settings: { headers: [{ name: 'X-Custom', credentialRef: 'new-ref' }] } }) }));
    expect(probe).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '编辑自定义站点' })).toBeInTheDocument();
  });
  it('keeps an existing key/headers on edit, and allows deleting an unused site', async () => {
    const { mutate, save } = setup(); render(<Form />);
    await screen.findByRole('option', { name: '通用服务' });
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑自定义站点' }));
    let dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText('Headers（可选）')).toHaveValue('');
    fireEvent.change(dialog.getByLabelText('名称'), { target: { value: '改名服务' } });
    fireEvent.click(dialog.getByRole('button', { name: '确认' }));
    await screen.findByRole('option', { name: '改名服务' });
    expect(save).not.toHaveBeenCalled();
    expect(mutate.mock.calls[0][0]).toMatchObject({ value: { credentialRef: 'encrypted-ref', settings: configuration.services[0].settings } });
    fireEvent.click(screen.getByRole('button', { name: '编辑自定义站点' }));
    dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('option', { name: '改名服务' })).not.toBeInTheDocument());
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'delete_service', id: 's' });
  });
  it('protects an in-use site and rejects invalid headers before encrypting secrets', async () => {
    const { save, mutate } = setup({ ...configuration, bindings: [{ partnerId: 'p', modelId: 'm' }] }); render(<Form />);
    await screen.findByRole('option', { name: '通用服务' });
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: '编辑自定义站点' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('button', { name: '删除' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Headers（可选）'), { target: { value: '{"Authorization":"secret"}' } });
    fireEvent.click(dialog.getByRole('button', { name: '确认' }));
    await dialog.findByRole('alert'); expect(save).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it('reuses unchanged models but clones changed model settings rather than affecting another partner', async () => {
    const { mutate } = setup(); const service = configuration.services[0], model = configuration.models[0];
    const value = { ...initial, service, model: model.model, modelConfig: model };
    expect(await saveApiPartnerConnection(value, service.credentialRef)).toBe('m'); expect(mutate).not.toHaveBeenCalled();
    const next = await saveApiPartnerConnection({ ...value, modelConfig: { ...model, tools: false } }, service.credentialRef);
    expect(next).not.toBe('m'); expect(mutate.mock.calls[0][0]).toMatchObject({ action: 'model', value: { tools: false, serviceId: 's' } });
  });
  it('defaults every new model to tools enabled and preserves the required Anthropic output limit', () => {
    for (const id of ['preset-deepseek', 'preset-kimi', 'preset-openai', 'preset-anthropic', 'preset-siliconflow']) {
      const site = apiSitePreset(id); if (site) expect(newApiModel(site, 'model').tools).toBe(true);
    }
    expect(newApiModel(apiSitePreset('preset-anthropic')!, 'claude-model')).toMatchObject({ tools: true, settings: { maxOutputTokens: 4096 } });
  });

  it('enables image input for new supported model profiles while retaining the legacy DeepSeek exception', () => {
    for (const id of ['preset-kimi', 'preset-openai', 'preset-anthropic', 'preset-siliconflow']) {
      expect(newApiModel(apiSitePreset(id)!, 'synthetic-model').images).toBe(true);
    }
    expect(newApiModel(apiSitePreset('preset-deepseek')!, 'synthetic-model').images).toBe(false);
  });

  it('starts the advanced image checkbox enabled for a new model, but preserves a saved explicit off', async () => {
    setup(); const view = render(<Form value={{ ...initial, service: configuration.services[0], model: 'new-synthetic-model' }} />);
    fireEvent.click(screen.getByText('高级模型设置')); expect(screen.getByRole('checkbox', { name: '启用聊天图片输入' })).toBeChecked();
    view.unmount(); render(<Form value={{ ...initial, service: configuration.services[0], model: 'exact-model', modelConfig: configuration.models[0] }} />);
    fireEvent.click(screen.getByText('高级模型设置')); expect(screen.getByRole('checkbox', { name: '启用聊天图片输入' })).not.toBeChecked();
  });
});
