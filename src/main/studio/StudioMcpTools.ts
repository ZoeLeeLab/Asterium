import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AUTOMATION_TOOL_DESCRIPTION, automationToolSchema } from '../../shared/automationTool';
import { STUDIO_PUBLIC_HISTORY_BUDGET } from '../../shared/studioRuntime';
import { STUDIO_MCP_CONTENT_CHUNK_CHARACTERS } from '../../shared/studioMcp';
import type { StudioMcpService } from './StudioMcpService';

export function createStudioMcpServer(service: StudioMcpService, token: string) {
  const server = new McpServer({ name: 'asterium-group-chat', version: '1.0.0' });
  const scope = { roomId: z.string().min(1).max(200), membershipGeneration: z.number().int().positive() };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('asterium_automation', {
    description: `${AUTOMATION_TOOL_DESCRIPTION} External management must first be enabled by the user in Asterium. This does not enable external scheduled execution; a dedicated host Adapter is required.`,
    inputSchema: automationToolSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, input => result(async () => {
    if (!service.automation) throw new Error('AUTOMATION_EXTERNAL_DISABLED');
    return JSON.parse(await service.automation(token, input)) as object;
  }));
  server.registerTool('asterium_list_rooms', {
    description: 'List your authorized Asterium groups. Call first; copy roomId and membershipGeneration exactly from the result. Credentials bind your partner identity; never supply a sender identity. No private original-thread content is shared.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => result(() => service.listRooms(token)));
  server.registerTool('asterium_read_history', {
    description: 'Read public group messages. First call omits both cursors for a bounded Studio bootstrap; use beforeSeq for older public history, or afterSeq for oldest-first increments. Only afterSeq increments omit your own messages; bootstrap and older history retain them. Continue with returned throughSeq, including when messages is empty: it scans past skipped own messages. Do not use latestSeq to skip unread pages, guess cursors, or poll rapidly. Reading does not acknowledge processing. Keep readId until you finish processing that page. If contentRequiresChunks is true, read_message_content in order before acknowledging that message. Never publish private host-thread history.',
    inputSchema: z.object({ ...scope, afterSeq: z.number().int().nonnegative().optional(), beforeSeq: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages).optional() }).strict(), annotations: readOnly,
  }, ({ roomId, membershipGeneration, ...request }) => result(() => service.history(token, roomId, membershipGeneration, request)));
  server.registerTool('asterium_read_message_content', {
    description: 'Read an oversized public message in bounded chunks. Start at offset=0 without readId. Continue with the returned readId and nextOffset, keeping the same limit. Read in order; do not guess offsets. Only complete=true makes the receipt cover this entire message. Acknowledge after processing, not merely after receiving a chunk.',
    inputSchema: z.object({ ...scope, messageId: z.string().min(1).max(200), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(256).max(STUDIO_MCP_CONTENT_CHUNK_CHARACTERS).default(STUDIO_MCP_CONTENT_CHUNK_CHARACTERS), readId: z.string().uuid().optional() }).strict(), annotations: readOnly,
  }, ({ roomId, membershipGeneration, ...request }) => result(() => service.content(token, roomId, membershipGeneration, request)));
  server.registerTool('asterium_send_message', {
    description: 'Publish one public group reply as your authenticated partner. Follow speaking and mute rules. In free discussion, optional mentionPartnerIds explicitly invites other external members; copy partner IDs with participation=external from list_rooms.members. Ordinary replies do not wake everyone. Use a unique requestId and reuse the SAME ID, content and mentions after a timeout. Publishing does not acknowledge input. Never publish private host-thread conversation.',
    inputSchema: z.object({ ...scope, requestId: z.string().min(1).max(200), content: z.string().trim().min(1).max(STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters),
      mentionPartnerIds: z.array(z.string().min(1).max(200)).max(16).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ roomId, membershipGeneration, ...request }) => result(() => service.send(token, roomId, membershipGeneration, request)));
  server.registerTool('asterium_acknowledge', {
    description: 'Confirm you have finished processing a previously read public page. Copy its readId; acknowledgement advances only that frozen input boundary, never messages arriving later. Retry is safe. Do not acknowledge merely because a wake was delivered or a host accepted a task.',
    inputSchema: z.object({ ...scope, readId: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ roomId, membershipGeneration, readId }) => result(() => service.acknowledge(token, roomId, membershipGeneration, readId)));
  return server;
}

async function result(operation: () => Promise<object>) {
  try {
    const value = await operation();
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
  } catch (error) {
    // Only public domain codes cross the transport, never filesystem paths or secrets.
    const code = error instanceof Error && /^(STUDIO|PROJECT|AUTOMATION)_[A-Z_]+$/.test(error.message) ? error.message : 'STUDIO_MCP_OPERATION_FAILED';
    return { content: [{ type: 'text' as const, text: code }], isError: true };
  }
}
