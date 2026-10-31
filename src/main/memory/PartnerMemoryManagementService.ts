import type {
  MemoryArchiveCommentRequest,
  MemoryArchiveCreateRequest,
  MemoryArchiveMutationRequest,
  MemoryArchiveQuery,
  MemoryArchiveQueryResult,
  MemoryArchiveSourceReadRequest,
  MemoryArchiveUpdateRequest,
} from '../../shared/memoryArchive';
import type { PartnerMemoryBriefingService } from './PartnerMemoryBriefingService';
import type { PartnerMemoryService } from './PartnerMemoryService';
import { PartnerMemoryToolService, searchMemoryRecords } from './PartnerMemoryToolService';

export class PartnerMemoryManagementService {
  constructor(
    private readonly memories: PartnerMemoryService,
    private readonly tools: PartnerMemoryToolService,
    private readonly briefings: PartnerMemoryBriefingService,
  ) {}

  async query(request: MemoryArchiveQuery): Promise<MemoryArchiveQueryResult> {
    const snapshot = await this.memories.snapshot(request.partnerId, { includeDeleted: request.includeDeleted });
    return {
      partnerId: request.partnerId,
      archiveVersion: snapshot.archiveVersion,
      records: searchMemoryRecords(snapshot.records, request),
      fallbackMemoryIds: await this.memories.fallbackMemoryIds(request.partnerId),
    };
  }

  briefing(partnerId: string) {
    return this.briefings.get(partnerId);
  }

  create(request: MemoryArchiveCreateRequest) {
    return this.tools.hold({ partnerId: request.partnerId }, request);
  }

  update(request: MemoryArchiveUpdateRequest) {
    const { partnerId, expectedUpdatedAt, ...input } = request;
    return this.tools.update({ partnerId }, input, expectedUpdatedAt);
  }

  comment(request: MemoryArchiveCommentRequest) {
    return this.tools.comment({ partnerId: request.partnerId }, {
      memoryId: request.memoryId,
      content: request.content,
    }, request.expectedUpdatedAt);
  }

  softDelete(request: MemoryArchiveMutationRequest) {
    return this.memories.softDelete(request.partnerId, request.memoryId, request.expectedUpdatedAt);
  }

  restore(request: MemoryArchiveMutationRequest) {
    return this.memories.restore(request.partnerId, request.memoryId, request.expectedUpdatedAt);
  }

  purge(request: MemoryArchiveMutationRequest) {
    return this.memories.purge(request.partnerId, request.memoryId, request.expectedUpdatedAt);
  }

  readSource(request: MemoryArchiveSourceReadRequest) {
    return this.tools.readSource({ partnerId: request.partnerId }, {
      memoryId: request.memoryId,
      sourceIndex: request.sourceIndex,
    });
  }
}
