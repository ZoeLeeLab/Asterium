// @vitest-environment node
import { expect, it } from 'vitest';
import { assertReadOnlyDelegation, assertReviewExecution, delegationSystemPrompt, negotiateReviewExecution, resolveDelegationExecution, restrictDelegationExecution, reviewAccessModes } from '../../src/main/runtime/DelegationAccess';
import { existingPartnerReviewMessage } from '../../src/main/runtime/ExistingPartnerReview';
import { delegationInput } from '../../src/main/runtime/PartnerDelegation';
import { delegationExecutionSchema } from '../../src/shared/delegationAccess';
import { reviewCapabilitySchema, reviewReceiptSchema, reviewRequestSchema } from '../../src/shared/existingPartnerReview';
import type { PermissionMode } from '../../src/shared/contracts/core';

const capability = { version: 2 as const, threadId: 'synthetic-thread', accessModes: ['read', 'write'] as const };
const host = reviewCapabilitySchema.parse(capability);

it.each(['read_only', 'manual', 'automatic', 'full'] as const)('keeps read-only tasks read-only under parent %s', permissionMode => {
  expect(resolveDelegationExecution('read', { permissionMode })).toEqual({ access: 'read', permissionMode: 'read_only' });
  expect(resolveDelegationExecution(undefined, { permissionMode })).toEqual({ access: 'read', permissionMode: 'read_only' });
});

it.each(['manual', 'automatic', 'full'] as const)('preserves the parent %s ceiling for explicit execution', permissionMode => {
  expect(resolveDelegationExecution('write', { permissionMode })).toEqual({ access: 'write', permissionMode });
  expect(() => resolveDelegationExecution('write', { permissionMode, planMode: 'plan' })).toThrow('DELEGATION_ACCESS_DENIED');
});

it('rejects write from read-only and does not interpret execution keywords as authority', () => {
  expect(() => resolveDelegationExecution('write', { permissionMode: 'read_only' })).toThrow('DELEGATION_ACCESS_DENIED');
  const input = delegationInput.parse({ tasks: [{ targetPartnerId: 'synthetic-target', instruction: 'Deploy the example application' }] });
  expect(resolveDelegationExecution(input.tasks[0].access)).toEqual({ access: 'read', permissionMode: 'read_only' });
  expect(resolveDelegationExecution('write')).toEqual({ access: 'write', permissionMode: 'manual' });
  for (const extra of [{ access: 'root' }, { permissionMode: 'full' }, { execution: { permissionMode: 'full' } }]) {
    expect(delegationInput.safeParse({ tasks: [{ targetPartnerId: 'synthetic-target', instruction: 'Review', ...extra }] }).success).toBe(false);
  }
});

it.each(['manual', 'automatic', 'full'] as const)('never raises an accepted %s task when source permission changes', permissionMode => {
  const accepted = { access: 'write' as const, permissionMode };
  expect(restrictDelegationExecution(accepted, { permissionMode: 'full' })).toEqual(accepted);
  expect(restrictDelegationExecution(accepted, { permissionMode: 'manual' })).toEqual({ access: 'write', permissionMode: 'manual' });
  expect(() => restrictDelegationExecution(accepted, { permissionMode: 'read_only' })).toThrow('DELEGATION_ACCESS_DENIED');
  expect(() => restrictDelegationExecution(accepted, { planMode: 'plan' })).toThrow('DELEGATION_ACCESS_DENIED');
});

it('negotiates explicit host capabilities and refuses silent fallback to a legacy review', () => {
  const legacy = { version: 1 as const, threadId: 'synthetic-thread' };
  const read = resolveDelegationExecution();
  const write = resolveDelegationExecution('write', { permissionMode: 'full' });
  expect(reviewAccessModes(legacy)).toEqual(['read']);
  expect(reviewAccessModes(host)).toEqual(['read', 'write']);
  expect(negotiateReviewExecution(legacy, read)).toBeUndefined();
  expect(negotiateReviewExecution(host, write)).toEqual(write);
  expect(() => negotiateReviewExecution(legacy, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => negotiateReviewExecution({ version: 2, threadId: 'synthetic-thread', accessModes: ['read'] }, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewExecution(legacy, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewExecution(legacy, read)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewExecution(host, write)).not.toThrow();
  expect(() => assertReviewExecution(host)).not.toThrow();
  expect(() => assertReadOnlyDelegation('write')).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReadOnlyDelegation()).not.toThrow();
});

it.each([
  ['read', 'full'], ['write', 'read_only'], ['write', 'unrestricted'],
])('rejects inconsistent or invalid transport execution %s/%s', (access, permissionMode) => {
  expect(delegationExecutionSchema.safeParse({ access, permissionMode }).success).toBe(false);
});

it('keeps task intent and user scope, without imposing a review-only prompt on execution', () => {
  const instruction = '按已授权的合成环境部署附件里的示例应用，并验证。';
  const original = '只允许修改合成测试服务，不要动其他服务。';
  const forwarded = existingPartnerReviewMessage('示例伙伴', instruction, original, 'example.md', '示例用户', 'write');
  expect(forwarded).toContain(instruction);
  expect(forwarded).toContain(original);
  expect(forwarded).toContain('本次为可执行任务');
  expect(forwarded).not.toContain('本次任务为只读');
  expect(forwarded).not.toContain('本次只请你给评审意见');
  expect(forwarded).not.toContain('只返回你的结论');
  expect(forwarded).toContain('保留宿主审批和原线程权限');
  const read = existingPartnerReviewMessage('示例伙伴', '仅查看', '不要修改', 'example.md');
  expect(read).toContain('本次任务为只读');
  expect(read).toContain('不要修改');
  expect(delegationSystemPrompt('示例伙伴')).not.toContain('只返回你的结论');
  expect(delegationSystemPrompt('示例伙伴')).toContain('不修改文件');
});

it('validates v2 request and receipt permissions while preserving the strict v1 contract', () => {
  const base = { requestId: '00000001-0000-4000-8000-000000000001', threadId: 'synthetic-thread' };
  const file = { name: 'example.md', sizeBytes: 12, sha256: 'a'.repeat(64) };
  for (const permissionMode of ['manual', 'automatic', 'full'] as PermissionMode[]) {
    const execution = resolveDelegationExecution('write', { permissionMode });
    const request = { version: 2, ...base, message: 'Synthetic task', file, execution };
    expect(reviewRequestSchema.parse(request)).toEqual(request);
    expect(reviewReceiptSchema.parse({ version: 2, ...base, execution, status: 'succeeded', result: 'Synthetic result' })).toMatchObject({ execution });
    for (const status of ['permission_denied', 'approval_required']) {
      expect(reviewReceiptSchema.safeParse({ version: 2, ...base, execution, status }).success).toBe(true);
    }
    expect(reviewRequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false);
    expect(reviewReceiptSchema.safeParse({ version: 1, ...base, execution, status: 'accepted' }).success).toBe(false);
  }
  expect(reviewRequestSchema.safeParse({ version: 2, ...base, message: 'Synthetic task', file }).success).toBe(false);
  expect(reviewReceiptSchema.safeParse({ version: 2, ...base, status: 'accepted' }).success).toBe(false);
});
