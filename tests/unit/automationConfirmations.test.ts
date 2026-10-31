import { expect, it, vi } from 'vitest';
import { AutomationConfirmations } from '../../src/main/automation/AutomationConfirmations';
import type { AutomationConfirmation } from '../../src/shared/automations';

const proposal: Omit<AutomationConfirmation, 'id'> = { action: 'create', partnerName: '本地伙伴', targetLabel: '原对话', task: { name: '整理', instructions: '只检查授权目录', schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai', catchUp: 'same_day', notifications: 'always', enabled: true } };
it('keeps immutable proposals pending until an explicit decision and rejects stale IDs', async () => {
  const changed = vi.fn(), broker = new AutomationConfirmations(changed);
  const pending = broker.request(proposal, 'owner');
  const [item] = broker.list(); item.task.instructions = 'tampered';
  expect(broker.list()[0].task.instructions).toBe(proposal.task.instructions);
  broker.resolve(item.id, true); expect(await pending).toBe(true);
  expect(broker.list()).toEqual([]); expect(changed).toHaveBeenCalledTimes(2);
  expect(() => broker.resolve(item.id, true)).toThrow('EXPIRED');
});
it('cancels by source run or signal without blocking unrelated proposals', async () => {
  const broker = new AutomationConfirmations(() => undefined), controller = new AbortController();
  const a = broker.request(proposal, 'a'), b = broker.request(proposal, 'b', controller.signal);
  broker.cancelOwner('a'); expect(await a).toBe(false); expect(broker.list()).toHaveLength(1);
  controller.abort(); expect(await b).toBe(false); expect(broker.list()).toEqual([]);
  const c = broker.request(proposal); broker.dispose(); expect(await c).toBe(false);
  expect(await broker.request(proposal)).toBe(false);
});
