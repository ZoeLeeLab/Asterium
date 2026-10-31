import { useEffect, useState } from 'react';
import type { ProjectRunChange } from '../../../shared/projectRunChanges';
export function useProjectRunChanges(projectId?: string) {
  const [state, setState] = useState<{ projectId?: string; records: ProjectRunChange[]; error?: string }>({ records: [] });
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const refresh = () => {
      void window.asteriumProjects?.listRunChanges?.(projectId).then((records) => { if (!cancelled) setState({ projectId, records }); }).catch(() => { if (!cancelled) setState({ projectId, records: [], error: '改动记录暂不可用' }); });
    };
    refresh();
    const unsubscribe = window.asteriumProjects?.onRunChangesChanged?.((owner) => { if (owner === projectId) refresh(); });
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; unsubscribe?.(); window.removeEventListener('focus', refresh); };
  }, [projectId]);
  return state.projectId === projectId ? state : { records: [] as ProjectRunChange[] };
}
