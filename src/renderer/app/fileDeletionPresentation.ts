export function fileDeletionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('FILE_DELETE_REFERENCED')) return '文件的引用状态已经变化，当前不能删除。请查看最新引用位置。';
  if (message.includes('FILE_DELETE_PATH_REQUIRED')) return '无法确认需要删除的原文件路径。';
  return message;
}
