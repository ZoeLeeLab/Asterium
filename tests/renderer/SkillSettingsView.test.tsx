import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillSettingsView } from '../../src/renderer/components/extensions/SkillSettingsView';
import type { ApiExtensionSummary, ApiExtensionsSnapshot, AsteriumExtensionsApi } from '../../src/shared/apiExtensions';
import { createTestState } from '../fixtures/applicationState';
import type { ApiPartner } from '../../src/renderer/types/domain';

const id = 'extension-11111111-1111-1111-1111-111111111111', other = 'extension-22222222-2222-2222-2222-222222222222';
const skill: ApiExtensionSummary = { id, kind: 'skill', name: 'Fixture', enabled: true, configuration: { type: 'skill', directory: 'K:\\fixture' }, secretNames: [], hasSecrets: false, generation: 1, inventoryKnown: false, trust: 'untrusted' };
const partner = { ...createTestState().partners[0], id: 'api', sourceMode: 'api_partner', configured: true, isPrototype: false, publicIdentity: { displayName: 'API 一', introduction: '', expertise: '', mentionName: 'api' } } as ApiPartner;
afterEach(() => { window.asteriumExtensions = undefined; });
function setup(entry = skill) {
  let state: ApiExtensionsSnapshot = { version: 1, extensions: [entry], bindings: [{ partnerId: 'api', extensionIds: [other] }] };
  const api = { get: vi.fn(async () => structuredClone(state)), upsert: vi.fn<AsteriumExtensionsApi['upsert']>(async () => structuredClone(state)), setBinding: vi.fn<AsteriumExtensionsApi['setBinding']>(async () => structuredClone(state)),
    setTrust: vi.fn<AsteriumExtensionsApi['setTrust']>(async (request) => { state = { ...state, version: state.version + 1, extensions: [{ ...entry, trust: request.action === 'request' ? 'pending' : 'untrusted' }] }; return structuredClone(state); }), remove: vi.fn<AsteriumExtensionsApi['remove']>(), connectMcp: vi.fn(), disconnectMcp: vi.fn(), mcpStatus: vi.fn() } satisfies AsteriumExtensionsApi;
  window.asteriumExtensions = api; const onDirtyChange = vi.fn(); render(<SkillSettingsView partners={[partner, ...createTestState().partners]} onDirtyChange={onDirtyChange} />);
  return { api, onDirtyChange, setState: (value: ApiExtensionsSnapshot) => { state = value; } };
}
async function ready() { await screen.findByRole('heading', { name: '技能包' }); }
describe('Skill management', () => {
  it.each(['success', 'failure'] as const)('locks inputs during save and preserves the submitted draft on %s', async (outcome) => {
    const s = setup(); await ready(); let resolve!: (value: ApiExtensionsSnapshot) => void, reject!: (error: Error) => void;
    s.api.upsert.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    fireEvent.click(screen.getByRole('button', { name: '编辑 Skill' }));
    fireEvent.change(screen.getByLabelText('Skill 名称'), { target: { value: 'Submitted name' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() => expect(s.api.upsert).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Skill 名称')).toBeDisabled(); expect(screen.getByLabelText('Skill 文件夹')).toBeDisabled();
    expect(s.api.upsert.mock.calls[0][0].name).toBe('Submitted name');
    await act(async () => {
      if (outcome === 'success') resolve({ version: 2, extensions: [{ ...skill, name: 'Submitted name' }], bindings: [] });
      else reject(new Error('synthetic-save-failure'));
    });
    if (outcome === 'success') { await ready(); expect(s.onDirtyChange).toHaveBeenLastCalledWith(false); }
    else { expect(screen.getByLabelText('Skill 名称')).toBeEnabled(); expect(screen.getByLabelText('Skill 名称')).toHaveValue('Submitted name'); expect(s.onDirtyChange).toHaveBeenLastCalledWith(true); }
  });
  it('loads without launching services, and preserves existing MCP bindings', async () => {
    const s = setup(); await ready(); expect(s.api.connectMcp).not.toHaveBeenCalled(); expect(s.api.setTrust).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'API 一' }));
    await waitFor(() => expect(s.api.setBinding).toHaveBeenCalledWith({ expectedVersion: 1, partnerId: 'api', extensionIds: [other, id] }));
  });
  it('requests pending script trust and supports cancellation and revocation', async () => {
    const s = setup(); await ready(); fireEvent.click(screen.getByRole('button', { name: '申请脚本持续信任' }));
    await screen.findByRole('button', { name: '取消待信任' }); fireEvent.click(screen.getByRole('button', { name: '取消待信任' }));
    await screen.findByRole('button', { name: '申请脚本持续信任' }); expect(s.api.setTrust).toHaveBeenLastCalledWith({ expectedVersion: 2, id, action: 'revoke' });
  });
  it('validates absolute directory paths without sending invalid configuration', async () => {
    const s = setup(); await ready(); fireEvent.click(screen.getByRole('button', { name: '添加 Skill' }));
    fireEvent.change(screen.getByLabelText('Skill 名称'), { target: { value: 'New' } }); fireEvent.change(screen.getByLabelText('Skill 文件夹'), { target: { value: '../outside' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Skill' })); expect(screen.getByRole('alert')).toHaveTextContent('绝对路径'); expect(s.api.upsert).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Skill 文件夹'), { target: { value: 'K:\\new' } }); fireEvent.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() => expect(s.api.upsert).toHaveBeenCalledWith({ expectedVersion: 1, name: 'New', enabled: true, configuration: { type: 'skill', directory: 'K:\\new' } }));
  });
  it('protects unsaved inputs and never retries stale writes', async () => {
    const s = setup(); await ready(); fireEvent.click(screen.getByRole('button', { name: '编辑 Skill' }));
    fireEvent.change(screen.getByLabelText('Skill 名称'), { target: { value: 'draft' } }); expect(s.onDirtyChange).toHaveBeenCalledWith(true);
    s.setState({ version: 2, extensions: [{ ...skill, name: 'changed' }], bindings: [] }); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled());
    expect(screen.getByLabelText('Skill 名称')).toHaveValue('draft'); expect(s.api.upsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' })); await screen.findByRole('dialog'); fireEvent.click(screen.getByRole('button', { name: '放弃修改' })); await ready();
  });
  it('revokes known trust when a refresh fails and hides raw errors', async () => {
    const s = setup({ ...skill, trust: 'trusted' }); await ready(); s.api.get.mockRejectedValue(new Error('private-error')); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: '撤销信任' }));
    await waitFor(() => expect(s.api.setTrust).toHaveBeenCalledWith({ expectedVersion: 1, id, action: 'revoke' })); expect(document.body.textContent).not.toContain('private-error');
  });
});
