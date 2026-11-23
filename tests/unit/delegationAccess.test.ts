// @vitest-environment node
import { expect, it } from 'vitest';
import { assertReadOnlyDelegation, assertReviewPermission, delegationSystemPrompt, negotiateReviewPermission, resolveDelegationAccess, reviewAccessModes } from '../../src/main/runtime/DelegationAccess';
import { existingPartnerReviewMessage } from '../../src/main/runtime/ExistingPartnerReview';
import { delegationInput } from '../../src/main/runtime/PartnerDelegation';
import { delegationAccessSchema } from '../../src/shared/delegationAccess';
import { reviewCapabilitySchema, reviewReceiptSchema, reviewRequestSchema } from '../../src/shared/existingPartnerReview';

const capability = { version: 2 as const, threadId: 'synthetic-thread', permissions: ['read', 'write'] as const };
const host = reviewCapabilitySchema.parse(capability);

it.each(['read_only', 'manual', 'automatic', 'full'] as const)('keeps read-only tasks read-only under parent %s', permissionMode => {
  expect(resolveDelegationAccess('read', { permissionMode })).toBe('read');
  expect(resolveDelegationAccess(undefined, { permissionMode })).toBe('read');
});

it.each(['manual', 'automatic', 'full'] as const)('allows write from %s without exporting its approval configuration', permissionMode => {
  expect(resolveDelegationAccess('write', { permissionMode })).toBe('write');
  expect(() => resolveDelegationAccess('write', { permissionMode, planMode: 'plan' })).toThrow('DELEGATION_ACCESS_DENIED');
});

it('rejects write from read-only and does not interpret execution keywords as authority', () => {
  expect(() => resolveDelegationAccess('write', { permissionMode: 'read_only' })).toThrow('DELEGATION_ACCESS_DENIED');
  const input = delegationInput.parse({ tasks: [{ targetPartnerId: 'synthetic-target', instruction: 'Deploy the example application' }] });
  expect(resolveDelegationAccess(input.tasks[0].access)).toBe('read');
  expect(resolveDelegationAccess('write')).toBe('write');
  for (const extra of [{ access: 'root' }, { permissionMode: 'full' }, { execution: { permissionMode: 'full' } }]) {
    expect(delegationInput.safeParse({ tasks: [{ targetPartnerId: 'synthetic-target', instruction: 'Review', ...extra }] }).success).toBe(false);
  }
});

it('blocks a queued write after its source becomes read-only while keeping ordinary mode changes independent', () => {
  const accepted = resolveDelegationAccess('write', { permissionMode: 'full' });
  expect(resolveDelegationAccess(accepted, { permissionMode: 'manual' })).toBe('write');
  expect(() => resolveDelegationAccess(accepted, { permissionMode: 'read_only' })).toThrow('DELEGATION_ACCESS_DENIED');
  expect(() => resolveDelegationAccess(accepted, { permissionMode: 'automatic', planMode: 'plan' })).toThrow('DELEGATION_ACCESS_DENIED');
});

it('negotiates explicit host capabilities and refuses silent fallback to a legacy review', () => {
  const legacy = { version: 1 as const, threadId: 'synthetic-thread' };
  const read = resolveDelegationAccess();
  const write = resolveDelegationAccess('write', { permissionMode: 'full' });
  expect(reviewAccessModes(legacy)).toEqual(['read']);
  expect(reviewAccessModes(host)).toEqual(['read', 'write']);
  expect(negotiateReviewPermission(legacy, read)).toBeUndefined();
  expect(negotiateReviewPermission(host, write)).toBe(write);
  expect(() => negotiateReviewPermission(legacy, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => negotiateReviewPermission({ version: 2, threadId: 'synthetic-thread', permissions: ['read'] }, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewPermission(legacy, write)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewPermission(legacy, read)).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReviewPermission(host, write)).not.toThrow();
  expect(() => assertReviewPermission(host)).not.toThrow();
  expect(() => assertReadOnlyDelegation('write')).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReadOnlyDelegation()).not.toThrow();
});

it.each(['full', 'root', '', null])('rejects invalid task permission %s', value => {
  expect(delegationAccessSchema.safeParse(value).success).toBe(false);
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

it.each(['read', 'write'] as const)('uses only permission %s in v2 and preserves the strict v1 contract', permission => {
  const base = { requestId: '00000001-0000-4000-8000-000000000001', threadId: 'synthetic-thread' };
  const file = { name: 'example.md', sizeBytes: 12, sha256: 'a'.repeat(64) };
  const request = { version: 2, ...base, message: 'Synthetic task', file, permission };
  const receipt = { version: 2, ...base, permission, status: 'succeeded', result: 'Synthetic result' };
  expect(reviewRequestSchema.parse(request)).toEqual(request);
  expect(reviewReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const status of ['permission_denied', 'approval_required']) {
    expect(reviewReceiptSchema.safeParse({ version: 2, ...base, permission, status }).success).toBe(true);
  }
  expect(reviewRequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false);
  expect(reviewReceiptSchema.safeParse({ ...receipt, version: 1 }).success).toBe(false);
  expect(reviewRequestSchema.safeParse({ version: 2, ...base, message: 'Synthetic task', file }).success).toBe(false);
  expect(reviewReceiptSchema.safeParse({ version: 2, ...base, status: 'accepted' }).success).toBe(false);
  for (const extra of [{ permissionMode: 'full' }, { execution: { access: permission, permissionMode: 'manual' } }]) {
    expect(reviewRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(reviewReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  }
  expect(reviewCapabilitySchema.safeParse({ ...capability, permissions: undefined, accessModes: ['read', 'write'] }).success).toBe(false);
});
