import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectBrowseRequest, ProjectPreviewContent } from '../../../shared/projectBrowser';
import { FilePreviewPane, type PreviewTab } from '../chat/FilePreviewPane';
interface PreviewRequest { request: ProjectBrowseRequest; key: string; name: string; load?: () => Promise<{ content?: ProjectPreviewContent }> }
export function useStudioPreview(projectId?: string) {
  const [state, setState] = useState<{ projectId?: string; tabs: PreviewTab[]; activeId: string }>({ tabs: [], activeId: '' });
  const [minimized, setMinimized] = useState(false);
  const requests = useRef(new Map<string, PreviewRequest>());
  const tokens = useRef(new Map<string, number>());
  const counter = useRef(0);
  const owner = useRef(projectId); owner.current = projectId;
  if (state.projectId !== projectId) {
    requests.current.clear(); tokens.current.clear();
    setState({ projectId, tabs: [], activeId: '' });
    if (minimized) setMinimized(false);
  }
  const visible = state.projectId === projectId ? state : { tabs: [], activeId: '' };
  const opened = visible.tabs.length > 0 && !minimized;
  const [width, setWidth] = useState(() => Math.max(320, Math.min(860, Number(localStorage.getItem('asterium.studio.previewWidth')) || 480)));
  useEffect(() => { localStorage.setItem('asterium.studio.previewWidth', String(width)); }, [width]);
  const fetchContent = useCallback(async (entry: PreviewRequest) => {
    if (!projectId) return;
    const token = ++counter.current; tokens.current.set(entry.key, token);
    const current = () => owner.current === projectId && tokens.current.get(entry.key) === token;
    try {
      if (!entry.load && !window.asteriumProjects?.browse) throw new Error('请在桌面应用中预览文件');
      const { content } = entry.load ? await entry.load() : await window.asteriumProjects!.browse!(entry.request);
      if (!current()) return;
      if (!content) throw new Error('文件内容不可用');
      setState((previous) => previous.projectId === projectId ? { ...previous, tabs: previous.tabs.map((tab) => tab.id === entry.key ? { ...tab, content, error: undefined } : tab) } : previous);
    } catch (error) {
      if (!current()) return;
      setState((previous) => previous.projectId === projectId ? { ...previous, tabs: previous.tabs.map((tab) => tab.id === entry.key ? { ...tab, content: undefined, error: error instanceof Error ? error.message : '文件读取失败' } : tab) } : previous);
    }
  }, [projectId]);
  useEffect(() => {
    if (!opened) return;
    const refresh = () => { for (const entry of requests.current.values()) if (!entry.load && (entry.request.action === 'file' || entry.request.action === 'diff') && !entry.request.revision) void fetchContent(entry); };
    window.addEventListener('focus', refresh);
    const files = window.asteriumProjects?.onFilesChanged?.((snapshot) => { if (snapshot.projectId === projectId) refresh(); });
    const runs = window.asteriumProjects?.onRunChangesChanged?.((id) => { if (id === projectId) refresh(); });
    return () => { window.removeEventListener('focus', refresh); files?.(); runs?.(); };
  }, [opened, projectId, fetchContent]);
  const open = async (request: ProjectBrowseRequest, key: string, name: string, load?: PreviewRequest['load']) => {
    if (!projectId) return;
    setMinimized(false);
    const entry = { request, key, name, load }; requests.current.set(key, entry);
    const openSystem = request.action === 'file' && request.fileId && !load ? () => { void window.asteriumProjects?.openFile(projectId, request.fileId!); } : undefined;
    setState((previous) => ({ projectId, activeId: key, tabs: [...(previous.projectId === projectId ? previous.tabs.filter((tab) => tab.id !== key) : []), { id: key, artifactRef: '', name, createdAt: '', open: openSystem }] }));
    await fetchContent(entry);
  };
  const close = (id: string) => { requests.current.delete(id); tokens.current.delete(id); setState((previous) => ({ ...previous, tabs: previous.tabs.filter((tab) => tab.id !== id) })); };
  return {
    width, setWidth, opened, open, minimize: () => setMinimized(true),
    closeAll: () => { requests.current.clear(); tokens.current.clear(); setState({ projectId, tabs: [], activeId: '' }); },
    pane: opened && <FilePreviewPane tabs={visible.tabs} activeId={visible.activeId} onActive={(activeId) => setState((previous) => ({ ...previous, activeId }))} onClose={close} onMinimize={() => setMinimized(true)} />,
  };
}
