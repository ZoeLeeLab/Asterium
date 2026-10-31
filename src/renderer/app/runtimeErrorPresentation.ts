const CODEX_ACTIVE_WRITER = /CODEX_RPC_ERROR:.*thread\s+[^\s]+\s+already has an active writer/i;

export function friendlyRuntimeErrorMessage(message: string) {
  if (CODEX_ACTIVE_WRITER.test(message)) {
    return '这个 Codex 线程正被另一个连接使用。请关闭对应的 Codex 桌面对话；若刚调整过工作区或项目成员，请重启星丛后重试。';
  }
  return message;
}
