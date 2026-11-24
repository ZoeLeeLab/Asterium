// @vitest-environment node
import { expect, it } from 'vitest';
import { assertReadOnlyDelegation, delegationSystemPrompt, resolveDelegationAccess } from '../../src/main/runtime/DelegationAccess';
import { existingPartnerReviewMessage } from '../../src/main/runtime/ExistingPartnerReview';
import { delegationInput } from '../../src/main/runtime/PartnerDelegation';
import { delegationAccessSchema } from '../../src/shared/delegationAccess';
import { reviewCapabilitySchema, reviewReceiptSchema, reviewRequestSchema } from '../../src/shared/existingPartnerReview';

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

it('keeps one-shot local and API delegates read-only', () => {
  expect(() => assertReadOnlyDelegation('write')).toThrow('DELEGATION_ACCESS_UNSUPPORTED');
  expect(() => assertReadOnlyDelegation()).not.toThrow();
});

it.each(['full', 'root', '', null])('rejects invalid task permission %s', value => {
  expect(delegationAccessSchema.safeParse(value).success).toBe(false);
});

it.each(['read', 'write'] as const)('forwards the user scope and adds only the chosen %s task instruction', access => {
  const instruction = '按已授权的合成环境部署附件里的示例应用，并验证。';
  const original = '只允许修改合成测试服务，不要动其他服务。';
  const forwarded = existingPartnerReviewMessage('示例伙伴', instruction, original, 'example.md', '示例用户', access);
  expect(forwarded).toContain(instruction);
  expect(forwarded).toContain(original);
  expect(forwarded).toContain(`本次权限：${access}`);
  expect(forwarded).not.toContain(`本次权限：${access === 'read' ? 'write' : 'read'}`);
  expect(forwarded).not.toContain('本次只请你给评审意见');
  expect(forwarded).not.toContain('只返回你的结论');
  if (access === 'write') expect(forwarded).toContain('沿用你当前的权限和审批');
  else expect(forwarded).toContain('不修改文件');
  const read = existingPartnerReviewMessage('示例伙伴', '仅查看', '不要修改', 'example.md');
  expect(read).toContain('本次权限：read');
  expect(read).toContain('不要修改');
  expect(delegationSystemPrompt('示例伙伴')).not.toContain('只返回你的结论');
  expect(delegationSystemPrompt('示例伙伴')).toContain('不修改文件');
});

it.each(['read', 'write'] as const)('uses the existing v1 protocol with only a %s instruction in the message', access => {
  const base = { requestId: '00000001-0000-4000-8000-000000000001', threadId: 'synthetic-thread' };
  const file = { name: 'example.md', sizeBytes: 12, sha256: 'a'.repeat(64) };
  const message = existingPartnerReviewMessage('示例伙伴', '请处理合成任务。', '仅处理已授权的合成示例。', file.name, '示例用户', access);
  const request = { version: 1, ...base, message, file };
  const receipt = { version: 1, ...base, status: 'succeeded', result: 'Synthetic result' };
  expect(reviewRequestSchema.parse(request)).toEqual(request);
  expect(reviewReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const extra of [{ access }, { permission: access }, { permissionMode: 'full' }, { execution: { access } }]) {
    expect(reviewRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(reviewReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  }
  expect(reviewCapabilitySchema.parse({ version: 1, threadId: base.threadId })).toEqual({ version: 1, threadId: base.threadId });
  expect(reviewCapabilitySchema.safeParse({ version: 2, threadId: base.threadId, permissions: ['read', 'write'] }).success).toBe(false);
  expect(reviewRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false);
  expect(reviewReceiptSchema.safeParse({ ...receipt, version: 2 }).success).toBe(false);
});
