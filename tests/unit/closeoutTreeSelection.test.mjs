// @vitest-environment node
import { expect, it } from 'vitest';
import { selectInvokedTree, noTargetReplay } from '../fixtures/sandbox/closeout-tree-selection.mjs';

const marker = 'FIXTURE_PROCESS_TREE';
// Synthetic management and partner connections with a child process tree.
const event = (event, role, pid, parent) => ({ event, role, pid, parent, marker });
const log = [event('start', 'mcp', 100, 90), event('request:initialize', 'mcp', 100, 90), event('request:tools/list', 'mcp', 100, 90),
  event('start', 'mcp', 200, 190), event('request:initialize', 'mcp', 200, 190), event('request:tools/list', 'mcp', 200, 190),
  event('request:tools/call', 'mcp', 200, 190), event('call', 'mcp', 200, 190), event('start', 'child', 201, 200), event('start', 'grandchild', 202, 201)];

it('selects the invoked partner tree and excludes the independent management connection', () => {
  const selection = selectInvokedTree(log, marker);
  expect(selection.roles.map(e => e.pid)).toEqual([200, 201, 202]);
  expect(selection.roles[0].parent).toBe(190);
  expect(selection.managementRoots).toEqual([log[0]]);
});
it('also accepts one partner connection without a management probe', () => {
  expect(selectInvokedTree(log.slice(3), marker).managementRoots).toEqual([]);
});
it.each(['marker', 'no-call', 'two-calls', 'missing-child', 'missing-grandchild', 'duplicate-start', 'wrong-parent', 'shared-helper'])('fails closed on %s instead of guessing which helper to kill', change => {
  let altered = structuredClone(log);
  if (change === 'marker') altered[0].marker = 'other';
  if (change === 'no-call') altered = altered.filter(e => e.event !== 'call');
  if (change === 'two-calls') altered.push(event('call', 'mcp', 100, 90));
  if (change === 'missing-child') altered = altered.filter(e => e.role !== 'child');
  if (change === 'missing-grandchild') altered = altered.filter(e => e.role !== 'grandchild');
  if (change === 'duplicate-start') altered.push(altered[3]);
  if (change === 'wrong-parent') altered.at(-1).parent = 100;
  if (change === 'shared-helper') altered[0].parent = 190;
  expect(() => selectInvokedTree(altered, marker)).toThrow();
});
it('does not mistake existing management discovery for target replay', () => {
  expect(noTargetReplay(log, [...log, event('request:tools/list', 'mcp', 100, 90)], selectInvokedTree(log, marker), marker)).toBe(true);
});
it.each(['restart', 'call', 'target-output', 'log-truncated', 'unknown-process'])('detects %s across the crash/cleanup and quiet periods', change => {
  let after = [...log];
  if (change === 'restart') after.push(event('start', 'mcp', 300, 290));
  if (change === 'call') after.push(event('request:tools/call', 'mcp', 100, 90));
  if (change === 'target-output') after.push(event('request:tools/list', 'mcp', 200, 190));
  if (change === 'log-truncated') after = after.slice(1);
  if (change === 'unknown-process') after.push(event('request:tools/list', 'mcp', 300, 290));
  expect(noTargetReplay(log, after, selectInvokedTree(log, marker), marker)).toBe(false);
});
