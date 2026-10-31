import { describe, expect, it, vi } from 'vitest';
import { ApiToolRegistry, apiToolRequiresAuthorization, assertApiToolAllowed, type ApiToolRegistration, type ToolAuthorizationDescriptor } from '../../src/main/api/ApiToolRegistry';

function registration(overrides: Partial<ApiToolRegistration> = {}): ApiToolRegistration {
  return {
    definition: {
      name: 'inspect_document', description: 'Inspect one document.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    },
    source: 'workspace',
    describe: (args) => ({ mutates: false, action: 'read_file', risk: 'low', summary: 'Read document', targets: [args.path as string] }),
    execute: vi.fn(async () => ({ content: 'document' })),
    ...overrides,
  };
}

describe('API tool registration and policy', () => {
  it('keeps presentation metadata separate from schema, dispatch and authorization', async () => {
    const registry = new ApiToolRegistry();
    const tool = registration({ presentationName: 'mcp__fixture__search_memory', source: 'mcp', describe: () => ({ mutates: true, action: 'external_side_effect', risk: 'high', summary: 'External call', targets: [] }) });
    registry.register(tool);
    expect(registry.definitions[0]).not.toHaveProperty('presentationName');
    expect(() => registry.prepare('mcp__fixture__search_memory', { path: 'file.md' })).toThrow('TOOL_NOT_AVAILABLE');
    const prepared = registry.prepare('inspect_document', { path: 'file.md' });
    expect(prepared.presentationName).toBe('mcp__fixture__search_memory');
    expect(apiToolRequiresAuthorization(prepared, { permissionMode: 'manual', planMode: 'default' })).toBe(true);
    expect(() => assertApiToolAllowed(prepared, { permissionMode: 'read_only', planMode: 'default' })).toThrow('ASTERIUM_READ_ONLY');
    await prepared.execute(new AbortController().signal);
    expect(tool.execute).toHaveBeenCalledWith({ path: 'file.md' }, expect.any(AbortSignal), {});
  });
  it('rejects unknown and duplicate names without falling back to another handler', () => {
    const registry = new ApiToolRegistry();
    const original = registration();
    registry.register(original);
    expect(() => registry.prepare('missing', {})).toThrow('TOOL_NOT_AVAILABLE');
    expect(() => registry.prepare('toString', {})).toThrow('TOOL_NOT_AVAILABLE');
    expect(() => registry.register(registration())).toThrow('API_TOOL_ALREADY_REGISTERED');
    expect(original.execute).not.toHaveBeenCalled();
  });

  it.each([{}, { path: 4 }, { path: 'file.md', extra: true }, null, []])('rejects invalid input before description or execution: %j', (args) => {
    const registry = new ApiToolRegistry();
    const describeTool = vi.fn(() => ({ mutates: false, action: 'read_file' as const, risk: 'low' as const, summary: 'Read', targets: [] }));
    const tool = registration({ describe: describeTool });
    registry.register(tool);
    expect(() => registry.prepare(tool.definition.name, args as Record<string, unknown>)).toThrow('TOOL_ARGUMENT_INVALID');
    expect(describeTool).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('uses private snapshots of the advertised schema and validated arguments', async () => {
    const registry = new ApiToolRegistry();
    const tool = registration();
    registry.register(tool);
    tool.definition.parameters.required = [];
    registry.definitions[0].parameters.required = [];
    expect(() => registry.prepare(tool.definition.name, {})).toThrow('TOOL_ARGUMENT_INVALID');
    const args = { path: 'authorized.md' };
    const prepared = registry.prepare(tool.definition.name, args);
    args.path = 'different.md';
    await prepared.execute(new AbortController().signal);
    expect(tool.execute).toHaveBeenCalledWith({ path: 'authorized.md' }, expect.any(AbortSignal), {});
  });

  it('runs domain validation before a tool can be approved and dispatches no aborted calls', async () => {
    const registry = new ApiToolRegistry();
    const tool = registration({ validate: () => { throw new Error('DOMAIN_INPUT_REJECTED'); } });
    registry.register(tool);
    expect(() => registry.prepare(tool.definition.name, { path: 'file.md' })).toThrow('DOMAIN_INPUT_REJECTED');
    expect(tool.execute).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const runnable = new ApiToolRegistry();
    runnable.register(registration());
    await expect(runnable.prepare('inspect_document', { path: 'file.md' }).execute(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('requires explicit Plan eligibility regardless of a tool name or read descriptor', () => {
    const registry = new ApiToolRegistry();
    registry.register(registration());
    const prepared = registry.prepare('inspect_document', { path: 'file.md' });
    expect(() => assertApiToolAllowed(prepared, { permissionMode: 'full', planMode: 'plan' })).toThrow('ASTERIUM_PLAN_READ_ONLY');
    expect(apiToolRequiresAuthorization(prepared, { permissionMode: 'manual', planMode: 'default' })).toBe(false);

    const allowed = new ApiToolRegistry();
    allowed.register(registration({ allowInPlan: true }));
    expect(apiToolRequiresAuthorization(allowed.prepare('inspect_document', { path: 'file.md' }), { permissionMode: 'read_only', planMode: 'plan' })).toBe(false);
  });

  it.each([
    ['write_file', 'manual', false, true],
    ['write_file', 'automatic', false, false],
    ['write_file', 'automatic', true, true],
    ['write_file', 'full', true, false],
    ['delete_file', 'automatic', false, true],
    ['run_command', 'automatic', false, true],
    ['external_side_effect', 'automatic', false, true],
  ] as const)('preserves %s approval in %s mode (outside write=%s)', (action, permissionMode, externalWrite, expected) => {
    const registry = new ApiToolRegistry();
    registry.register(registration({
      // Even an accidental Plan opt-in cannot enable an externally mutating operation.
      allowInPlan: true,
      describe: () => ({ mutates: true, action, risk: 'high', summary: 'External operation', targets: [] }),
    }));
    const prepared = registry.prepare('inspect_document', { path: 'file.md' });
    expect(apiToolRequiresAuthorization(prepared, { permissionMode, planMode: 'default' }, externalWrite)).toBe(expected);
    expect(() => apiToolRequiresAuthorization(prepared, { permissionMode: 'read_only', planMode: 'default' })).toThrow('ASTERIUM_READ_ONLY');
    expect(() => apiToolRequiresAuthorization(prepared, { permissionMode: 'full', planMode: 'plan' })).toThrow('ASTERIUM_PLAN_READ_ONLY');
  });

  it('retains separate Main authorization for memory writes instead of treating them as file writes', () => {
    const registry = new ApiToolRegistry();
    const descriptor: ToolAuthorizationDescriptor = { mutates: false, action: 'external_side_effect', risk: 'low', summary: 'Managed memory', targets: [] };
    registry.register(registration({ source: 'asterium', allowInPlan: true, describe: () => descriptor }));
    expect(apiToolRequiresAuthorization(registry.prepare('inspect_document', { path: 'file.md' }), { permissionMode: 'read_only', planMode: 'plan' })).toBe(false);
  });
});
