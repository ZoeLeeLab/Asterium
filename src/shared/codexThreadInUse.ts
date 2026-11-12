import type { ProtocolError } from './agentProtocol';

export const CODEX_THREAD_IN_USE = 'CODEX_THREAD_IN_USE';

export function codexThreadInUseFailure(error: unknown): ProtocolError | undefined {
  if (!(error instanceof Error) || !/(^|: )CODEX_THREAD_IN_USE$/.test(error.message)) return undefined;
  return {
    code: CODEX_THREAD_IN_USE,
    message: '原线程正在使用。请先关闭 Codex 里的同一条对话。',
    stage: 'adapter',
    retryable: true,
  };
}
