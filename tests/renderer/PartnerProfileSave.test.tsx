import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfilesSyncResult, PartnerProfileSeed } from '../../src/shared/agentProtocol';
import { partnerProfileSeed, PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';

const fixtures: Array<{ root: string; store: PartnerProfileStore }> = [];
afterEach(async () => {
  window.asteriumAgents = undefined;
  await Promise.all(fixtures.splice(0).map(async ({ root, store }) => { store.dispose(); await rm(root, { recursive: true, force: true }); }));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-save-'));
  const store = new PartnerProfileStore(root); fixtures.push({ root, store });
  const state = createTestState();
  const partner = state.partners.find((item) => item.id === 'fixture-api')!;
  if (partner.sourceMode !== 'api_partner') throw new Error('expected API partner');
  Object.assign(partner, { isPrototype: false, configured: true, credentialRef: 'test-ref', endpoint: 'https://api.deepseek.com/chat/completions', personality: '原人设' });
  const initial = await store.sync(state.userProfile, [partnerProfileSeed(partner)]);
  partner.profileRevision = initial.partners[0].revision;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  const listeners = new Set<(profiles: PartnerProfilesSyncResult) => void>();
  store.subscribe((profiles) => { for (const listener of listeners) listener(profiles); });
  const save = vi.fn((seed: PartnerProfileSeed) => store.savePartner(seed));
  const refresh = vi.fn(() => store.refresh());
  window.asteriumAgents = {
    onEvent: () => () => undefined,
    apiCredentialStatus: vi.fn(async () => ({ credentialRef: 'test-ref', configured: true, masked: '***' })),
    saveApiCredential: vi.fn(), savePartnerProfile: save, refreshPartnerProfiles: refresh,
    onPartnerProfilesChanged: (listener: (profiles: PartnerProfilesSyncResult) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as NonNullable<Window['asteriumAgents']>;
  render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /测试伙伴 C的头像/ }));
  const personaPath = path.join(root, 'partners', initial.partners[0].directoryName, 'persona.md');
  return { store, save, initial, personaPath };
}

it('keeps the editing revision and draft across focus refresh, rejecting an external persona overwrite', async () => {
  const t = await setup();
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  const input = screen.getByRole('textbox', { name: '性格与相处方式' });
  fireEvent.change(input, { target: { value: '未保存草稿' } });
  await writeFile(t.personaPath, '# 伙伴设定\n\n## 性格与相处方式\n\n外部人设\n\n## 稳定指令\n\n外部指令\n');
  await act(async () => { fireEvent(window, new Event('focus')); await t.store.refresh(); });
  expect(input).toHaveValue('未保存草稿');
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByText('磁盘资料已变化，未覆盖外部修改；草稿已保留，请刷新资料并取消编辑后重新打开。');
  expect(t.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: t.initial.partners[0].revision }));
  expect(await t.store.managedPersonaState('fixture-api')).toMatchObject({ personality: '外部人设', systemPrompt: '外部指令' });
  expect(input).toHaveValue('未保存草稿');
  fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  expect(input).toHaveValue('外部人设');
  fireEvent.change(input, { target: { value: '确认后的人设' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await screen.findByText('修改已保存；已有单聊需显式重读人设，工作室需退出后重新加入。');
  expect(await t.store.managedPersonaState('fixture-api')).toMatchObject({ personality: '确认后的人设' });
});

it('uses the saved revision for the next edit without requiring a focus refresh', async () => {
  const t = await setup();
  for (const personality of ['第一次保存', '第二次保存']) {
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '性格与相处方式' }), { target: { value: personality } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText('修改已保存；已有单聊需显式重读人设，工作室需退出后重新加入。');
    expect(await t.store.managedPersonaState('fixture-api')).toMatchObject({ personality });
  }
  const firstSaved = await t.save.mock.results[0].value;
  expect(t.save.mock.calls[1][0].expectedRevision).toBe(firstSaved.revision);
});
