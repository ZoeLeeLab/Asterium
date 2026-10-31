import assert from 'node:assert/strict';

// A management initialize/list and a partner initialize/list normally create
// separate processes. Only the one actual tools/call identifies the crash target.
export function selectInvokedTree(log, marker) {
  assert.ok(Array.isArray(log) && log.every(e => e.marker === marker), 'FIXTURE_MARKER_MISMATCH');
  assert.ok(!log.some(e => e.event === 'spawn-error'), 'FIXTURE_SPAWN_FAILED');
  const calls = log.filter(e => e.event === 'call');
  assert.equal(calls.length, 1, 'ONE_FORMAL_CALL_REQUIRED');
  assert.equal(calls[0].role, 'mcp', 'CALL_MUST_BELONG_TO_MCP');
  const starts = log.filter(e => e.event === 'start');
  const exactly = (role, predicate) => {
    const found = starts.filter(e => e.role === role && predicate(e));
    assert.equal(found.length, 1, `UNIQUE_${role.toUpperCase()}_REQUIRED`);
    assert.ok(Number.isInteger(found[0].pid) && found[0].pid > 0 && Number.isInteger(found[0].parent) && found[0].parent > 0, 'INVALID_PROCESS_ID');
    return found[0];
  };
  const mcp = exactly('mcp', e => e.pid === calls[0].pid && e.parent === calls[0].parent);
  const child = exactly('child', e => e.parent === mcp.pid);
  const grandchild = exactly('grandchild', e => e.parent === child.pid);
  const roles = [mcp, child, grandchild], pids = new Set(roles.map(e => e.pid));
  assert.equal(pids.size, 3, 'PROCESS_TREE_CYCLE');
  const managementRoots = starts.filter(e => !roles.includes(e));
  assert.ok(managementRoots.every(e => e.role === 'mcp' && !pids.has(e.pid) && !pids.has(e.parent) && e.parent !== mcp.parent), 'UNRELATED_DESCENDANT_OR_DUPLICATE_START');
  assert.equal(new Set(managementRoots.map(e => e.pid)).size, managementRoots.length, 'DUPLICATE_MANAGEMENT_START');
  return { roles, managementRoots };
}

export function noTargetReplay(before, after, selection, marker) {
  if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) return false;
  return after.slice(before.length).every(e => e.marker === marker && e.event === 'request:tools/list'
    && e.role === 'mcp' && selection.managementRoots.some(root => root.pid === e.pid && root.parent === e.parent));
}
