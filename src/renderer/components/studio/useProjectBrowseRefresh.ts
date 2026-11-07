import { useEffect, useState } from 'react';

export function useProjectBrowseRefresh(projectId: string | undefined, open: boolean) {
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open || !projectId) return;
    const reload = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', reload);
    const tasks = window.asteriumProjects?.onTaskExecutionChanged?.(reload);
    const runs = window.asteriumProjects?.onRunChangesChanged?.((owner) => { if (owner === projectId) reload(); });
    const files = window.asteriumProjects?.onFilesChanged?.((snapshot) => { if (snapshot.projectId === projectId) reload(); });
    return () => { window.removeEventListener('focus', reload); tasks?.(); runs?.(); files?.(); };
  }, [open, projectId]);
  return [refresh, () => setRefresh((value) => value + 1)] as const;
}
