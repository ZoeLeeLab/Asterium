// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { StudioMcpAccessStore } from '../../src/main/studio/StudioMcpAccessStore';
import { StudioMcpService } from '../../src/main/studio/StudioMcpService';
import { StudioMcpHost } from '../../src/main/studio/StudioMcpHost';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';
import { STUDIO_MCP_CONTENT_CHUNK_CHARACTERS } from '../../src/shared/studioMcp';
import { STUDIO_PUBLIC_HISTORY_BUDGET } from '../../src/shared/studioRuntime';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const room = { roomId: 'public-room', projectId: 'project-one', name: '公开讨论', memberIds: ['chuan', 'other'] };

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-mcp-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const accessFile = path.join(directory, 'access.json');
  const roomsFile = path.join(directory, 'rooms.json');
  const access = new StudioMcpAccessStore(accessFile);
  const rooms = new StudioRoomStore(roomsFile);
  await rooms.syncRoom(room);
  await rooms.syncRoom({ ...room, roomId: 'private-room', name: '另一个群', memberIds: ['other'] });
  const coordinator = new ProjectMutationCoordinator();
  const partners = new Set(['chuan', 'other']);
  const service = new StudioMcpService(access, rooms, coordinator, (id) => partners.has(id));
  const host = new StudioMcpHost(access, service);
  disposers.push(() => host.dispose());
  const issued = await access.issue('chuan');
  const port = await freePort();
  const configuration = { enabled: true, port, publicOrigin: 'https://computer.tail-test.ts.net' };
  await host.configure(configuration);
  return { accessFile, roomsFile, directory, access, rooms, coordinator, service, host, issued, configuration, partners,
    endpoint: `http://127.0.0.1:${port}/mcp`, scope: { roomId: room.roomId, membershipGeneration: 1 } };
}

async function connect(endpoint: string, token: string, mode: 'legacy' | 'auto' = 'legacy') {
  const client = new Client({ name: 'acceptance-client', version: '1.0.0' }, { versionNegotiation: { mode } });
  disposers.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('TEST_PORT_UNAVAILABLE');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe('Studio MCP HTTP and authority', () => {
  it('publishes attachment metadata without exposing local paths or binary content', async () => {
    const s = await setup();
    const attachment = { id: 'attachment-generic', name: 'requirements.txt', mediaType: 'text/plain', sizeBytes: 40, sourcePath: 'X:/synthetic-private/input.txt' };
    await s.rooms.publishUserMessage({ room, messageId: 'attached-message', content: '', authorId: 'user', speakerQueue: [], attachments: [attachment] }, 'manual', ['chuan']);
    const page = await s.service.history(s.issued.token, room.roomId, 1, {});
    expect(page.messages[0].attachments).toEqual([{ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes }]);
    expect(JSON.stringify(page)).not.toContain('sourcePath');
    expect(JSON.stringify(page)).not.toContain('synthetic-private');
  });
  it.each(['legacy', 'auto'] as const)('serves real %s MCP clients with scoped read/write and frozen acknowledgement', async (mode) => {
    const s = await setup();
    const client = await connect(s.endpoint, s.issued.token, mode);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['asterium_acknowledge', 'asterium_automation', 'asterium_list_rooms', 'asterium_read_history', 'asterium_read_message_content', 'asterium_send_message']);
    const disabledAutomation = await client.callTool({ name: 'asterium_automation', arguments: { action: 'list' } });
    expect(disabledAutomation.isError).toBe(true); expect(JSON.stringify(disabledAutomation)).toContain('AUTOMATION_EXTERNAL_DISABLED');
    expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    const listing = await client.callTool({ name: 'asterium_list_rooms', arguments: {} });
    expect(listing.structuredContent).toMatchObject({ partnerId: 'chuan', rooms: [{ roomId: room.roomId, membershipGeneration: 1 }] });
    expect(JSON.stringify(listing)).not.toContain('private-room');
    await s.rooms.publishUserMessage({ room, messageId: 'user-1', authorId: 'user', content: '请看公开群消息', speakerQueue: [] }, 'manual', ['chuan']);
    const read = await client.callTool({ name: 'asterium_read_history', arguments: s.scope });
    expect(read.structuredContent).toMatchObject({ messages: [{ content: '请看公开群消息' }], throughSeq: 1, processedThroughSeq: 0 });
    const readId = (read.structuredContent as Record<string, unknown>).readId;
    const reply = { ...s.scope, requestId: 'reply-one', content: '这是外部伙伴公开回复' };
    const sent = await client.callTool({ name: 'asterium_send_message', arguments: reply });
    const retried = await client.callTool({ name: 'asterium_send_message', arguments: reply });
    expect(sent.structuredContent).toEqual(retried.structuredContent);
    expect(sent.structuredContent).toMatchObject({ authorId: 'chuan', seq: 2 });
    const ack = await client.callTool({ name: 'asterium_acknowledge', arguments: { ...s.scope, readId } });
    expect(ack.structuredContent).toEqual({ processedThroughSeq: 1 });
    const increment = await client.callTool({ name: 'asterium_read_history', arguments: { ...s.scope, afterSeq: 1 } });
    expect(increment.structuredContent).toMatchObject({ messages: [], throughSeq: 2, latestSeq: 2, hasNewer: false, processedThroughSeq: 1 });
    const other = await s.access.issue('other');
    expect(await s.service.history(other.token, room.roomId, 1, { afterSeq: 1 })).toMatchObject({ messages: [{ seq: 2, authorId: 'chuan' }] });
    const receipt = (increment.structuredContent as Record<string, unknown>).readId;
    const processed = await client.callTool({ name: 'asterium_acknowledge', arguments: { ...s.scope, readId: receipt } });
    expect(processed.structuredContent).toEqual({ processedThroughSeq: 2 });
    expect((await s.host.status()).lastAuthenticatedAt).toBeDefined();
  });

  it('stores no plaintext credentials and returns no credential hashes or internal read state', async () => {
    const s = await setup();
    expect(await readFile(s.accessFile, 'utf8')).not.toContain(s.issued.token);
    expect(JSON.stringify(await s.host.status())).not.toMatch(/tokenHash|asterium_/);
    const listing = await s.service.listRooms(s.issued.token);
    expect(JSON.stringify(listing)).not.toMatch(/externalState|reads|processedThroughSeq|tokenHash/);
    const reloaded = new StudioMcpAccessStore(s.accessFile);
    expect((await reloaded.authenticate(s.issued.token)).partnerId).toBe('chuan');
  });

  it('rejects sender spoofing, another room, stale membership, and revoked credentials through the real endpoint', async () => {
    const s = await setup();
    const client = await connect(s.endpoint, s.issued.token);
    const spoof = await client.callTool({ name: 'asterium_send_message', arguments: { ...s.scope, requestId: 'spoof', content: '冒充', partnerId: 'other' } });
    expect(spoof.isError).toBe(true);
    const privateRead = await client.callTool({ name: 'asterium_read_history', arguments: { ...s.scope, roomId: 'private-room' } });
    expect(privateRead.isError).toBe(true);
    await s.rooms.applyProjectMemberships(room.projectId, [{ room: { ...room, memberIds: ['other'] } }]);
    await s.rooms.applyProjectMemberships(room.projectId, [{ room }]);
    const stale = await client.callTool({ name: 'asterium_send_message', arguments: { ...s.scope, requestId: 'stale', content: '迟到' } });
    expect(stale).toMatchObject({ isError: true, content: [{ text: 'STUDIO_MEMBERSHIP_STALE' }] });
    await s.coordinator.run(() => s.access.revoke(s.issued.credential.credentialId));
    const denied = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${s.issued.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
    expect((await s.rooms.getRoom(room.roomId))?.messages).toEqual([]);
  });

  it('serializes external operations with membership transactions and rechecks revocation after waiting', async () => {
    const s = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const transaction = s.coordinator.run(async () => { await blocked; await s.access.revoke(s.issued.credential.credentialId); });
    const send = s.service.send(s.issued.token, room.roomId, 1, { requestId: 'queued', content: '不应发出' });
    release();
    await transaction;
    await expect(send).rejects.toThrow('STUDIO_MCP_UNAUTHORIZED');
    expect((await s.rooms.getRoom(room.roomId))?.messages).toHaveLength(0);
  });

  it('stops removed partners and deleted projects independently from saved credentials', async () => {
    const s = await setup();
    s.partners.delete('chuan');
    await expect(s.service.listRooms(s.issued.token)).rejects.toThrow('STUDIO_MCP_UNAUTHORIZED');
    s.partners.add('chuan');
    s.coordinator.markProjectDeleted(room.projectId);
    expect((await s.service.listRooms(s.issued.token)).rooms).toEqual([]);
    await expect(s.service.send(s.issued.token, room.roomId, 1, { requestId: 'deleted', content: '不应发出' })).rejects.toThrow('PROJECT_REMOVED');
  });

  it('keeps oversized history off the wire and requires ordered chunks before acknowledging that message', async () => {
    const s = await setup();
    const snapshot = (await s.rooms.getRoom(room.roomId))!;
    const content = 'x'.repeat(STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters + 777);
    snapshot.messages.push({ roomId: room.roomId, messageId: 'huge', seq: 1, roundId: 'legacy', authorType: 'partner', authorId: 'other', content, createdAt: new Date(0).toISOString(), status: 'completed' });
    await writeFile(s.roomsFile, JSON.stringify({ version: 2, rooms: { [room.roomId]: { ...snapshot, nextSeq: 2 } } }));
    const client = await connect(s.endpoint, s.issued.token);
    const history = await client.callTool({ name: 'asterium_read_history', arguments: s.scope });
    expect(history.structuredContent).toMatchObject({ messages: [{ messageId: 'huge', contentRequiresChunks: true }], throughSeq: 0 });
    expect(history.structuredContent).not.toHaveProperty('readId');
    expect(JSON.stringify(history).length).toBeLessThan(STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters);
    await s.service.send(s.issued.token, room.roomId, 1, { requestId: 'own-after-huge', content: '自己的新回复' });
    const forward = await client.callTool({ name: 'asterium_read_history', arguments: { ...s.scope, afterSeq: 0 } });
    expect(forward.structuredContent).toMatchObject({ messages: [{ messageId: 'huge', contentRequiresChunks: true }], throughSeq: 0, latestSeq: 2 });
    expect(forward.structuredContent).not.toHaveProperty('readId');
    const first = await s.service.content(s.issued.token, room.roomId, 1, { messageId: 'huge', offset: 0, limit: STUDIO_MCP_CONTENT_CHUNK_CHARACTERS });
    expect(first.throughSeq).toBe(0);
    expect(await s.service.acknowledge(s.issued.token, room.roomId, 1, first.readId)).toEqual({ processedThroughSeq: 0 });
    await expect(s.service.content(s.issued.token, room.roomId, 1, { messageId: 'huge', offset: content.length - 1, limit: 256, readId: first.readId })).rejects.toThrow('STUDIO_CONTENT_PAGE_OUT_OF_ORDER');
    let next = first;
    let reconstructed = first.content;
    while (!next.complete) {
      next = await s.service.content(s.issued.token, room.roomId, 1, { messageId: 'huge', offset: next.nextOffset, limit: STUDIO_MCP_CONTENT_CHUNK_CHARACTERS, readId: first.readId });
      reconstructed += next.content;
    }
    expect(reconstructed).toBe(content);
    expect(await s.service.acknowledge(s.issued.token, room.roomId, 1, first.readId)).toEqual({ processedThroughSeq: 1 });
  });

  it('validates host/origin and method before dispatch and closes the listener on stop', async () => {
    const s = await setup();
    const headers = { Authorization: `Bearer ${s.issued.token}`, 'Content-Type': 'application/json' };
    expect((await fetch(s.endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    const maliciousHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(s.endpoint, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.end('{}');
    });
    expect(maliciousHostStatus).toBe(403);
    expect((await fetch(s.endpoint)).status).toBe(405);
    expect((await fetch(s.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    await s.host.configure({ ...s.configuration, enabled: false });
    expect((await s.host.status()).running).toBe(false);
    await expect(fetch(s.endpoint)).rejects.toThrow();
  });

  it('never permits a public bare HTTP origin or arbitrary HTTPS host', async () => {
    const s = await setup();
    for (const publicOrigin of ['http://0.0.0.0', 'https://public.example', 'https://computer.ts.net/path', 'https://user:pass@computer.ts.net']) {
      await expect(async () => s.host.configure({ ...s.configuration, publicOrigin })).rejects.toThrow('STUDIO_MCP_PRIVATE_ORIGIN_REQUIRED');
    }
    expect((await s.host.status()).running).toBe(true);
  });

  it('bounds HTTP requests and body size without dispatching model work', async () => {
    const s = await setup();
    const headers = { Authorization: `Bearer ${s.issued.token}`, 'Content-Type': 'application/json' };
    const large = await fetch(s.endpoint, { method: 'POST', headers, body: 'x'.repeat(512 * 1024 + 1) });
    expect(large.status).toBe(413); await large.arrayBuffer();
    let limited = false;
    for (let i = 0; i < 120; i++) {
      const response = await fetch(s.endpoint, { method: 'POST', headers, body: '{}' });
      await response.arrayBuffer();
      if (response.status === 429) { expect(response.headers.get('Retry-After')).toBe('60'); limited = true; break; }
    }
    expect(limited).toBe(true);
    expect((await s.rooms.getRoom(room.roomId))?.messages).toHaveLength(0);
  });

  it('leaves the service stopped after a port conflict and can be explicitly started again', async () => {
    const s = await setup();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    disposers.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('TEST_PORT_UNAVAILABLE');
    await expect(s.host.configure({ ...s.configuration, port: address.port })).rejects.toThrow('STUDIO_MCP_LISTEN_FAILED');
    expect(await s.host.status()).toMatchObject({ running: false, configuration: { enabled: true }, error: 'STUDIO_MCP_LISTEN_FAILED' });
    await s.host.configure(s.configuration);
    expect((await s.host.status()).running).toBe(true);
  });

  it('restores the saved listener and credentials once on restart, and respects a later manual stop', async () => {
    const s = await setup(); await s.host.dispose();
    const restored = new StudioMcpHost(s.access, s.service); disposers.push(() => restored.dispose());
    await Promise.all([restored.restore(), restored.restore()]);
    expect(await restored.status()).toMatchObject({ running: true, configuration: s.configuration });
    const client = await connect(s.endpoint, s.issued.token);
    expect((await client.callTool({ name: 'asterium_list_rooms', arguments: {} })).structuredContent).toMatchObject({ partnerId: 'chuan' });
    await client.close();
    await restored.configure({ ...s.configuration, enabled: false }); await restored.dispose();
    const stopped = new StudioMcpHost(s.access, s.service); disposers.push(() => stopped.dispose());
    expect((await stopped.restore()).running).toBe(false);
    expect((await s.access.snapshot()).configuration.enabled).toBe(false);
  });

  it('preserves enabled intent after startup failure, stays stopped after the port is freed, and allows a manual retry', async () => {
    const s = await setup(); await s.host.dispose();
    const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(s.configuration.port, '127.0.0.1', resolve));
    disposers.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const restored = new StudioMcpHost(s.access, s.service); disposers.push(() => restored.dispose());
    await expect(restored.restore()).rejects.toThrow('STUDIO_MCP_LISTEN_FAILED');
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await expect(restored.restore()).rejects.toThrow('STUDIO_MCP_LISTEN_FAILED');
    expect(await restored.status()).toMatchObject({ running: false, configuration: { enabled: true }, error: 'STUDIO_MCP_LISTEN_FAILED' });
    expect(await restored.configure(s.configuration)).toMatchObject({ running: true });
  });
});
