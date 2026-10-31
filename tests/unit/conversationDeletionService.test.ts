import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationDeletionService } from '../../src/main/conversation/ConversationDeletionService';
import { ConversationDeletionStore } from '../../src/main/conversation/ConversationDeletionStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-conversation-delete-'));
  temporary.push(directory);
  const deletions = new ConversationDeletionStore(path.join(directory, 'deletions.json'));
  const apiSessions = { delete: vi.fn(async () => undefined) };
  const attachments = { deleteConversation: vi.fn(async () => undefined) };
  const bindings = { removeConversations: vi.fn(async () => undefined) };
  const messages = { deleteConversation: vi.fn(async () => undefined) };
  return {
    deletions,
    apiSessions,
    attachments,
    bindings,
    messages,
    service: new ConversationDeletionService({ deletions, apiSessions, attachments, bindings, messages }),
  };
}

describe('ConversationDeletionService', () => {
  it('durably records deletion before cleaning every API conversation resource', async () => {
    const fixture = await setup();
    const request = { conversationId: 'conversation-a', partnerId: 'partner-a', source: 'api_partner' as const };

    await expect(fixture.service.delete(request)).resolves.toEqual({ conversationId: 'conversation-a', cleanupPending: false });

    expect(await fixture.service.listDeletedIds()).toEqual(['conversation-a']);
    expect(fixture.apiSessions.delete).toHaveBeenCalledWith('partner-a', 'conversation-a');
    expect(fixture.attachments.deleteConversation).toHaveBeenCalledWith('conversation-a');
    expect(fixture.bindings.removeConversations).toHaveBeenCalledWith(['conversation-a']);
    expect(await fixture.deletions.listPending()).toEqual([]);
  });

  it('keeps a failed cleanup pending and finishes it after restart without losing the tombstone', async () => {
    const fixture = await setup();
    fixture.attachments.deleteConversation.mockRejectedValueOnce(new Error('disk busy'));
    const request = { conversationId: 'conversation-retry', partnerId: 'partner-a', source: 'api_partner' as const };

    await expect(fixture.service.delete(request)).resolves.toEqual({ conversationId: 'conversation-retry', cleanupPending: true });
    expect(await fixture.service.listDeletedIds()).toEqual(['conversation-retry']);
    expect(await fixture.deletions.listPending()).toHaveLength(1);

    const restarted = new ConversationDeletionService({
      deletions: new ConversationDeletionStore(path.join(temporary[0], 'deletions.json')),
      apiSessions: fixture.apiSessions,
      attachments: fixture.attachments,
      bindings: fixture.bindings,
      messages: fixture.messages,
    });
    await restarted.recover();

    expect(fixture.attachments.deleteConversation).toHaveBeenCalledTimes(2);
    expect(await fixture.deletions.listPending()).toEqual([]);
    expect(await restarted.listDeletedIds()).toEqual(['conversation-retry']);
  });

  it('does not touch API sessions for local CLI conversations', async () => {
    const fixture = await setup();
    await fixture.service.delete({ conversationId: 'conversation-local', partnerId: 'partner-local', source: 'local_cli' });
    expect(fixture.apiSessions.delete).not.toHaveBeenCalled();
    expect(fixture.messages.deleteConversation).toHaveBeenCalledWith('conversation-local');
  });
});
