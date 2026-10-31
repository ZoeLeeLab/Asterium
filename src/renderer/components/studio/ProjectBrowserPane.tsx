import type { ProjectRunChange } from '../../../shared/projectRunChanges';
import { RunChangeView } from './RunChangeSummary';
import { ProjectGitPane } from './ProjectGitPane';
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectBrowseRequest, ProjectDirectoryEntry } from '../../../shared/projectBrowser';

export type BrowserTab = 'files' | 'history' | 'status';
export interface ProjectBrowserPaneProps {
  projectId: string;
  open: boolean;
  tab: BrowserTab;
  onTab: (tab: BrowserTab) => void;
  onClose: () => void;
  change?: ProjectRunChange;
  onCloseChange?: () => void;
  onOpenChange?: (path: string) => void;
  onOpenFile: (request: ProjectBrowseRequest, key: string, name: string) => void;
}
export function ProjectBrowserPane({ projectId, open, tab, onTab, onClose, onOpenFile, change, onCloseChange, onOpenChange }: ProjectBrowserPaneProps) {
  const [directories, setDirectories] = useState<Record<string, ProjectDirectoryEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open || change || tab !== 'files') return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) { setLoading(true); setError(''); } });
    const paths = ['', ...expanded];
    void Promise.all(paths.map(async (directory) => {
      if (!window.asteriumProjects?.browse) throw new Error('请在桌面应用中浏览项目');
      return [directory, (await window.asteriumProjects.browse({ projectId, action: 'directory', path: directory })).entries ?? []] as const;
    })).then((values) => { if (!cancelled) setDirectories(Object.fromEntries(values)); }).catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, open, tab, refresh, expanded, change]);
  useEffect(() => {
    if (!open) return;
    const reload = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', reload);
    const unsubscribe = window.asteriumProjects?.onTaskExecutionChanged?.(reload);
    const runs = window.asteriumProjects?.onRunChangesChanged?.((owner) => { if (owner === projectId) reload(); });
    return () => { window.removeEventListener('focus', reload); unsubscribe?.(); runs?.(); };
  }, [open, projectId]);
  const renderDirectory = (directory: string): React.ReactNode => <ul role="group">{(Object.hasOwn(directories, directory) ? directories[directory] : []).map((entry) => <li key={entry.path}>
    <button type="button" className={selected === entry.path ? 'is-selected' : ''} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} onClick={() => {
      setSelected(entry.path);
      if (entry.directory) setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      else onOpenFile({ projectId, action: 'file', path: entry.path }, `${projectId}:current:${entry.path}`, entry.name);
    }}>{entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expanded.has(entry.path) ? <FolderOpen size={15} /> : <Folder size={15} />}</> : <><span className="tree-indent" /><FileCode2 size={15} /></>}<span>{entry.name}</span></button>
    {entry.directory && expanded.has(entry.path) && renderDirectory(entry.path)}
  </li>)}</ul>;
  return <aside className="glass-panel project-browser-pane" hidden={!open} aria-label="项目浏览">
    <header className="project-browser-heading"><strong>{change ? '本次改动' : '项目浏览'}</strong><span>{!change && <button className="icon-button" type="button" aria-label="刷新项目浏览" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /></button>}<button className="icon-button" type="button" aria-label={change ? '关闭本次改动' : '关闭项目浏览'} onClick={change ? onCloseChange : onClose}><X size={15} /></button></span></header>
    {change && <><button type="button" className="text-button run-change-back" onClick={onCloseChange}>返回项目浏览</button><RunChangeView change={change} onOpen={(file) => onOpenChange?.(file)} /></>}
    <div className="project-browser-normal" hidden={Boolean(change)}>
    <nav className="project-browser-tabs" aria-label="项目浏览视图">{([['files', '项目文件'], ['history', '提交历史'], ['status', '未提交']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => onTab(key)}>{label}</button>)}</nav>
    <div className="project-browser-body scroll-region" hidden={tab !== 'files'}>{error && <p role="alert">{error}</p>}{loading && <p className="browser-hint">正在读取…</p>}<div className="project-tree" role="tree" aria-label="项目目录树">{renderDirectory('')}</div>{!loading && !error && directories['']?.length === 0 && <p className="browser-hint">这个文件夹是空的</p>}</div>
    <ProjectGitPane projectId={projectId} open={open && !change} tab={tab} refresh={refresh} onOpenFile={onOpenFile} />
    </div>
  </aside>;
}
