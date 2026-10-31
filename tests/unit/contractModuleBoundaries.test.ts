import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION as BARREL_PROTOCOL_VERSION,
  COMMON_IMAGE_MIME_TYPES as BARREL_IMAGE_TYPES,
  isTerminalEvent as barrelIsTerminalEvent,
  type PartnerEvent as BarrelPartnerEvent,
} from '../../src/shared/agentProtocol';
import { COMMON_IMAGE_MIME_TYPES } from '../../src/shared/contracts/attachments';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/contracts/core';
import { isTerminalEvent, type PartnerEvent } from '../../src/shared/contracts/runtime';
import type { Partner as BarrelPartner } from '../../src/renderer/types/domain';
import type { Partner } from '../../src/renderer/types/domain/partner';

describe('contract compatibility barrels', () => {
  it('keeps agent protocol runtime exports identical to the focused modules', () => {
    expect(BARREL_PROTOCOL_VERSION).toBe(AGENT_PROTOCOL_VERSION);
    expect(BARREL_IMAGE_TYPES).toBe(COMMON_IMAGE_MIME_TYPES);
    expect(barrelIsTerminalEvent).toBe(isTerminalEvent);
  });

  it('keeps focused and compatibility type exports assignable', () => {
    const event = { type: 'run.completed' } as PartnerEvent;
    const barrelEvent: BarrelPartnerEvent = event;
    const partner = {} as Partner;
    const barrelPartner: BarrelPartner = partner;

    expect(isTerminalEvent(barrelEvent)).toBe(true);
    expect(barrelPartner).toBe(partner);
  });
});
