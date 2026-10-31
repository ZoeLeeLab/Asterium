import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import { partnerProfileSeed, PrototypeProvider, prototypeReducer, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { PartnerQuickCard } from '../../src/renderer/components/ui/PartnerQuickCard';

const fixtures: Array<{ root: string; store: PartnerProfileStore }> = [];
afterEach(async () => { window.asteriumAgents = undefined; await Promise.all(fixtures.splice(0).map(async ({ root, store }) => { store.dispose(); await rm(root, { recursive: true, force: true }); })); });
async function setup(gate?: Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-quick-save-')), store = new PartnerProfileStore(root); fixtures.push({ root, store });
  const state = createTestState(), partner = state.partners.find((item) => item.id === 'fixture-api')!;
  Object.assign(partner, { isPrototype: false, configured: true, model: 'deepseek-chat', credentialRef: 'test-ref' });
  const initial = await store.sync(state.userProfile, [partnerProfileSeed(partner)]); partner.profileRevision = initial.partners[0].revision;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  const save = vi.fn(async (seed: PartnerProfileSeed) => { await gate; return store.savePartner(seed); });
  const refresh = vi.fn(() => store.refresh());
  window.asteriumAgents = { onEvent: () => () => undefined, savePartnerProfile: save, refreshPartnerProfiles: refresh, listApiModels: vi.fn(async () => [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]) } as unknown as NonNullable<Window['asteriumAgents']>;
  function Card() {
    const value = usePrototype(), current = value.state.partners.find((item) => item.id === 'fixture-api');
    return <PartnerQuickCard partner={current} onUpdatePartner={value.updatePartner} onUpdateWorkspaceGrants={vi.fn()} />;
  }
  render(<MemoryRouter><PrototypeProvider><Card /></PrototypeProvider></MemoryRouter>);
  const selector = screen.getByRole('combobox', { name: '选择 API 模型' }); fireEvent.focus(selector);
  await screen.findByRole('option', { name: 'deepseek-reasoner' });
  const directory = path.join(root, 'partners', initial.partners[0].directoryName);
  return { store, save, refresh, selector, initial, directory };
}

it('persists consecutive model changes using the latest successful revision', async () => {
  const t = await setup();
  for (const [index, model] of ['deepseek-reasoner', 'deepseek-chat'].entries()) {
    fireEvent.change(t.selector, { target: { value: model } });
    await waitFor(() => expect(t.selector).toHaveValue(model));
    await waitFor(() => expect(t.selector).toBeEnabled());
    expect(JSON.parse(await readFile(path.join(t.directory, 'connection.json'), 'utf8')).configuredModel).toBe(model);
    expect(t.save).toHaveBeenCalledTimes(index + 1);
  }
  const first = await t.save.mock.results[0].value;
  expect(t.save.mock.calls[0][0].expectedRevision).toBe(t.initial.partners[0].revision);
  expect(t.save.mock.calls[1][0].expectedRevision).toBe(first.revision);
});

it('surfaces conflicts, keeps the selected model and external persona, and retries after focus refresh', async () => {
  const t = await setup();
  await writeFile(path.join(t.directory, 'persona.md'), '# 伙伴设定\n\n## 性格与相处方式\n\n外部人设\n\n## 稳定指令\n\n外部指令\n');
  fireEvent.change(t.selector, { target: { value: 'deepseek-reasoner' } });
  await screen.findByText('伙伴资料已变化，模型未切换。请刷新资料后重试。');
  expect(t.selector).toHaveValue('deepseek-chat');
  expect((await t.store.managedPersonaState('fixture-api'))).toMatchObject({ personality: '外部人设' });
  await act(async () => { fireEvent(window, new Event('focus')); await t.refresh.mock.results.at(-1)!.value; });
  fireEvent.change(t.selector, { target: { value: 'deepseek-reasoner' } });
  await waitFor(() => expect(t.selector).toHaveValue('deepseek-reasoner'));
  expect((await t.store.managedPersonaState('fixture-api'))).toMatchObject({ personality: '外部人设' });
});

it('shows a persistence error without switching the model and allows retry', async () => {
  const t = await setup(); t.save.mockRejectedValueOnce(new Error('bridge-disconnected'));
  fireEvent.change(t.selector, { target: { value: 'deepseek-reasoner' } });
  await screen.findByText('模型保存失败，仍使用原选择。请重试。');
  expect(t.selector).toHaveValue('deepseek-chat'); expect(t.selector).toBeEnabled();
  fireEvent.change(t.selector, { target: { value: 'deepseek-reasoner' } });
  await waitFor(() => expect(t.selector).toHaveValue('deepseek-reasoner'));
});

it('waits for persistence before switching the model and prevents duplicate selection while saving', async () => {
  let release!: () => void;
  const t = await setup(new Promise<void>((resolve) => { release = resolve; }));
  fireEvent.change(t.selector, { target: { value: 'deepseek-reasoner' } });
  expect(t.selector).toBeDisabled(); expect(t.selector).toHaveValue('deepseek-chat');
  await waitFor(() => expect(t.save).toHaveBeenCalledOnce());
  await act(async () => { release(); });
  await waitFor(() => expect(t.selector).toHaveValue('deepseek-reasoner'));
  expect(t.selector).toBeEnabled();
});

it('merges only edited fields from a save receipt and preserves newer observations or profile revisions', () => {
  const state = createTestState(), previous = state.partners.find((item) => item.id === 'fixture-api')!;
  const saved = { ...previous, model: 'saved-model', profileRevision: 'saved-revision' };
  const current = { ...previous, status: 'busy' as const, recentModel: { model: 'observed-model', status: 'current' as const, observedAt: '', source: 'runtime' as const } };
  state.partners = state.partners.map((partner) => partner.id === previous.id ? current : partner);
  expect(prototypeReducer(state, { type: 'updatePartner', partner: saved, previous }).partners.find((partner) => partner.id === previous.id)).toMatchObject({ model: 'saved-model', profileRevision: 'saved-revision', status: 'busy', recentModel: { model: 'observed-model' } });
  current.profileRevision = 'newer-profile';
  expect(prototypeReducer(state, { type: 'updatePartner', partner: saved, previous }).partners.find((partner) => partner.id === previous.id)).toBe(current);
});
