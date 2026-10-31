import { expect, it, vi } from 'vitest';
import { DesktopNotifications } from '../../src/main/settings/DesktopNotifications';
import { DEFAULT_GENERAL_SETTINGS } from '../../src/shared/generalSettings';
import type { PartnerEvent } from '../../src/shared/agentProtocol';
import type { AutomationRun } from '../../src/shared/automations';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';
import type { ProjectTask } from '../../src/shared/projectDomain';

const now = Date.parse('2026-10-26T12:00:00Z'), at = new Date(now + 1).toISOString();
const event = (extra: Record<string, unknown> = {}) => ({ type: 'run.completed', partnerId: 'p', conversationId: 'c', runId: 'r', clientMessageId: 'm', occurredAt: at, ...extra }) as PartnerEvent;
function setup() {
  const settings = structuredClone(DEFAULT_GENERAL_SETTINGS), background = vi.fn(() => true), supported = vi.fn(() => true), show = vi.fn(), restore = vi.fn(), navigationReady = vi.fn();
  return { settings, background, supported, show, restore, navigationReady, service: new DesktopNotifications({ settings: () => settings, background, supported, show, restore, navigationReady, now: () => now }) };
}
it('notifies once in the background, consumes foreground or disabled events and excludes old events', () => {
  const t = setup(); t.background.mockReturnValue(false); t.service.agent(event()); t.background.mockReturnValue(true); t.service.agent(event());
  expect(t.show).not.toHaveBeenCalled();
  t.settings.notifications.completed = false; t.service.agent(event({ runId: 'disabled' })); t.settings.notifications.completed = true; t.service.agent(event({ runId: 'disabled' }));
  t.service.agent(event({ runId: 'old', occurredAt: new Date(now - 1).toISOString() })); expect(t.show).not.toHaveBeenCalled();
  t.service.agent(event({ runId: 'new' })); t.service.agent(event({ runId: 'new' })); expect(t.show).toHaveBeenCalledOnce();
  expect(t.show.mock.calls[0][0]).toEqual({ title: '星丛 · 任务完成', body: '伙伴已完成本次回复。' });
});
it('keeps notification failures outside task execution', () => {
  const t = setup(); t.supported.mockReturnValue(false); expect(() => t.service.agent(event())).not.toThrow(); expect(t.show).not.toHaveBeenCalled();
  t.supported.mockReturnValue(true); t.show.mockImplementation(() => { throw Error('OS blocked'); }); expect(() => t.service.agent(event({ runId: 'second' }))).not.toThrow();
});
it('aggregates group completion and never notifies per member or internal maintenance', () => {
  const t = setup(); t.service.agent(event({ route: { scope: 'group', roomId: 'g' } }));
  t.service.agent(event({ route: { scope: 'workspace', projectId: 'project' } }));
  t.service.agent(event({ route: { scope: 'workflow_planning' } }));
  t.service.agent(event({ clientMessageId: 'profile-reload:confirmation' })); expect(t.show).not.toHaveBeenCalled();
  const room = { metadata: { roomId: 'g' }, activeRound: { roundId: 'round', state: 'completed', updatedAt: at } } as StudioRoomSnapshot;
  t.service.room(room); t.service.room(room); expect(t.show).toHaveBeenCalledOnce();
});
it('waits for final project completion rather than review and does not re-notify edits', () => {
  const t = setup(), task = { id: 't', projectId: 'p', status: 'review', updatedAt: at } as ProjectTask;
  t.service.tasks([task]); expect(t.show).not.toHaveBeenCalled();
  t.service.tasks([{ ...task, status: 'completed' }]); t.service.tasks([{ ...task, status: 'completed', updatedAt: new Date(now + 10).toISOString() }]); expect(t.show).toHaveBeenCalledOnce();
});
it('covers automation failures without runtime events and respects each successful task notification policy', () => {
  const t = setup(), run = { id: 'run', automationId: 'a', state: 'failed', finishedAt: at, definition: { notifications: 'changes_or_failure' }, changed: false } as AutomationRun;
  t.service.automations([run]); t.service.automations([run]); expect(t.show).toHaveBeenCalledOnce();
  t.service.automations([{ ...run, id: 'unchanged', state: 'succeeded' }]); expect(t.show).toHaveBeenCalledOnce();
  t.service.automations([{ ...run, id: 'changed', state: 'succeeded', changed: true }]); expect(t.show).toHaveBeenCalledTimes(2);
  t.service.agent(event(), { ...run, state: 'succeeded' }); expect(t.show).toHaveBeenCalledTimes(2);
});
it('deduplicates approval IDs and queues click navigation until the renderer takes it', () => {
  const t = setup(); const request = event({ type: 'authorization.requested', authorizationId: 'approval', summary: 'private command', targets: ['private'] });
  t.service.agent(request, undefined, '伙伴\n甲'); t.service.agent(request, undefined, '伙伴\n甲'); expect(t.show).toHaveBeenCalledOnce();
  expect(JSON.stringify(t.show.mock.calls[0][0])).not.toMatch(/private/);
  expect(t.show.mock.calls[0][0].body).toBe('伙伴 甲有一项操作正在等待你的审批。');
  t.show.mock.calls[0][1](); expect(t.restore).toHaveBeenCalledOnce(); expect(t.navigationReady).toHaveBeenCalledOnce();
  expect(t.service.takeNavigation()).toEqual({ kind: 'conversation', conversationId: 'c' }); expect(t.service.takeNavigation()).toBeUndefined();
  t.service.dispose(); t.show.mock.calls[0][1](); expect(t.restore).toHaveBeenCalledOnce();
});
