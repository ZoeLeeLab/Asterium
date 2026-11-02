import { runAutoTest, testRm as rm, createTestHttpServer as createServer, buildTestSdk } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

await runAutoTest(async () => {
const { WakeBridgeSession, WakeDeliveryStore, studioWakeControlReplySchema, studioWakeControlRequestSchema } = await buildTestSdk('vite.studio-wake.config.ts', 'studio-wake-adapter.mjs');
// --mock uses a local SSE fixture and a fixed-thread enqueue mock; never calls a model.









const flags = process.argv.slice(2);
const option = (name) => { const i = flags.indexOf(name); return i < 0 ? undefined : flags[i + 1]; };
const cases = [];
const request = (action, binding = 'fixture') => ({ protocolVersion: 2, source: 'asterium', action, requestId: randomUUID(), connectionBindingId: binding });
if (flags.includes('--mock')) {
  await mock();
  console.log(JSON.stringify({ status: 'passed', mode: 'mock', realCyberBoss: false, modelCalled: false, cases }, null, 2));
} else {
  assert.ok(option('--config'), 'Build SDK; use --mock or --config <binding.json>. Optional --connect or --retry/--ignore TRIGGER_ID is an explicit action.');
  const configuration = JSON.parse(await readFile(option('--config'), 'utf8'));
  const base = new URL(configuration.serviceUrl);
  assert.ok(base.protocol === 'https:' && base.hostname.endsWith('.ts.net') && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash, 'Private HTTPS origin required');
  const secret = process.env.CYBERBOSS_WEB_SECRET; assert.ok(secret, 'Set CYBERBOSS_WEB_SECRET in the process environment; never pass it on the command line');
  const auth = await fetch(new URL('/api/auth', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Origin: base.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) });
  assert.ok(auth.ok, 'SMALL_GATE_AUTH_FAILED'); const cookie = /(?:^|,\s*)(cyberboss_web_session=[^;,\s]+)/i.exec(auth.headers.get('set-cookie') ?? '')?.[1];
  await auth.body?.cancel(); assert.ok(cookie, 'SMALL_GATE_SESSION_MISSING');
  const action = flags.includes('--connect') ? 'connect_once' : option('--retry') ? 'retry' : option('--ignore') ? 'ignore' : 'status';
  const input = { ...request(action, configuration.connectionBindingId), ...(option('--retry') || option('--ignore') ? { triggerId: option('--retry') ?? option('--ignore') } : {}) };
  assert.ok(studioWakeControlRequestSchema.safeParse(input).success);
  const response = await fetch(new URL('/api/asterium/wake/control', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Origin: base.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.ok(response.ok, 'WAKE_CONTROL_UNAVAILABLE');
  const parsed = studioWakeControlReplySchema.safeParse(await response.json());
  assert.ok(parsed.success && parsed.data.requestId === input.requestId && parsed.data.connectionBindingId === input.connectionBindingId, 'WAKE_CONTROL_REPLY_INVALID');
  console.log(JSON.stringify({ status: 'control-accepted', action, connection: parsed.data.connection, reviewCount: parsed.data.reviews.length,
    realWakeLoopVerified: false, remaining: 'Verify original thread, host queue serialization, group reply and no WeChat echo separately' }, null, 2));
}

async function mock() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-minimal-adapter-'));
  const store = new WakeDeliveryStore(path.join(directory, 'positions.json'));
  let live, connections = 0, failNext = false; const accepted = [];
  const server = createServer((req, res) => {
    assert.equal(req.url?.split('?')[0], '/wake/events'); assert.equal(req.headers.authorization, 'Bearer fixture-token');
    connections += 1; live = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
    res.write(`id: 0\nevent: checkpoint\ndata: {"latestEventId":0,"caughtUp":true}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = new WakeBridgeSession('fixture', `http://127.0.0.1:${server.address().port}`, 'fixture-token', { enqueue: async (trigger) => {
    assert.equal(trigger.source, 'asterium'); assert.equal(trigger.type, 'asterium.group_wake');
    assert.equal(trigger.adapterId, 'fixture');
    if (failNext) { failNext = false; throw new Error('unknown receipt'); }
    accepted.push(trigger); return { accepted: true, triggerId: trigger.triggerId };
  } }, store);
  const emit = (eventId, roomId) => {
    const hint = { latestEventId: eventId, roomId, membershipGeneration: 1, cursor: eventId, wakeReason: 'user_message', wakeEligible: true };
    live.write(`id: ${eventId}\nevent: wake\ndata: ${JSON.stringify(hint)}\n\nid: ${eventId}\nevent: checkpoint\ndata: ${JSON.stringify({ latestEventId: eventId, caughtUp: true })}\n\n`);
  };
  const status = () => session.control(request('status'));
  try {
    assert.equal((await status()).connection.phase, 'stopped'); assert.equal(connections, 0);
    const start = request('connect_once'); await session.control(start);
    await waitFor(async () => (await status()).connection.phase === 'connected');
    await session.control(start); await session.control(request('connect_once')); assert.equal(connections, 1);
    cases.push('no-autostart-one-connection-idempotent-duplicate-start');
    live.write(': heartbeat\n\n'); emit(1, 'A');
    await waitFor(async () => (await store.read()).scanCursor === 1);
    // observe() persists scanCursor before offer() and the following checkpoint
    // finish. Pump only succeeds after that checkpoint marks the stream caught up.
    // Wait for the actual enqueue, not an earlier intermediate disk write.
    await waitFor(async () => { await session.tick(Date.now() + 2100); return accepted.length === 1; });
    assert.equal(accepted.length, 1); assert.equal((await status()).reviews.length, 0);
    cases.push('actual-http-sse-heartbeat-and-original-thread-enqueue-acceptance');
    failNext = true; emit(2, 'A'); emit(3, 'B');
    await waitFor(async () => { await session.tick(Date.now() + 2200); return accepted.length === 2; });
    assert.equal(accepted.at(-1).roomId, 'B');
    assert.equal((await status()).reviews[0].roomId, 'A'); await session.tick(Date.now() + 10000);
    assert.equal(accepted.length, 2);
    cases.push('unknown-delivery-manual-review-does-not-block-other-groups-or-auto-retry');
    const review = (await status()).reviews[0];
    const retry = { ...request('retry'), triggerId: review.triggerId }; await session.control(retry); await session.control(retry);
    assert.equal(accepted.at(-1).triggerId, review.triggerId); assert.equal(accepted.length, 3);
    cases.push('manual-retry-same-trigger-and-idempotent-control-request');
    const contents = await readFile(path.join(directory, 'positions.json'), 'utf8'); assert.doesNotMatch(contents, /active|pending|state|token|content|starts/);
    cases.push('only-notification-cursors-and-last-success-are-persistent');
    live.end(); await waitFor(async () => (await status()).connection.phase === 'stopped');
    await session.control(start); assert.equal(connections, 1);
    const manual = request('connect_once'); await session.control(manual);
    await waitFor(async () => connections === 2); await session.dispose();
    cases.push('eof-stops-no-reconnect-until-fresh-explicit-control');
  } finally {
    await session.dispose(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true });
  }
}
async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'MOCK_WAIT_TIMEOUT'); await delay(5); }
}
});
