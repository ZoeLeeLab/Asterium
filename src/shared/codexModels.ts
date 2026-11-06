import type { LocalThreadLifecycleRequest } from './contracts/connections';

export type CodexModelListRequest = Pick<LocalThreadLifecycleRequest, 'partnerRootGrantId' | 'codexRuntimeId' | 'codexRuntimeEnvironment'>;

export interface CodexModelSelection {
  model: string;
  effort?: string;
}

export interface CodexModelOption {
  model: string;
  displayName: string;
  defaultEffort?: string;
  efforts: string[];
}

export function isCodexModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
}

export function isCodexEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function isCodexModelSelection(value: unknown): value is CodexModelSelection {
  return typeof value === 'object' && value !== null && 'model' in value && isCodexModelId(value.model)
    && (!('effort' in value) || value.effort === undefined || isCodexEffort(value.effort));
}
