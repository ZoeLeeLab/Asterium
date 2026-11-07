import type { ProjectRunChange } from '../../../shared/projectRunChanges';
import { RunChangeView } from './RunChangeSummary';
import { ProjectGitPane } from './ProjectGitPane';
import { RefreshCw, X } from 'lucide-react';
import type { ProjectBrowseRequest } from '../../../shared/projectBrowser';
import { ProjectFileTree } from './ProjectFileTree';
import { useProjectBrowseRefresh } from './useProjectBrowseRefresh';

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
  const [refresh, reload] = useProjectBrowseRefresh(projectId, open);
  return <aside className="glass-panel project-browser-pane" hidden={!open} aria-label="项目浏览">
    <header className="project-browser-heading"><strong>{change ? '本次改动' : '项目浏览'}</strong><span>{!change && <button className="icon-button" type="button" aria-label="刷新项目浏览" onClick={reload}><RefreshCw size={14} /></button>}<button className="icon-button" type="button" aria-label={change ? '关闭本次改动' : '关闭项目浏览'} onClick={change ? onCloseChange : onClose}><X size={15} /></button></span></header>
    {change && <><button type="button" className="text-button run-change-back" onClick={onCloseChange}>返回项目浏览</button><RunChangeView change={change} onOpen={(file) => onOpenChange?.(file)} /></>}
    <div className="project-browser-normal" hidden={Boolean(change)}>
    <nav className="project-browser-tabs" aria-label="项目浏览视图">{([['files', '项目文件'], ['history', '提交历史'], ['status', '未提交']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => onTab(key)}>{label}</button>)}</nav>
    <div className="project-browser-body scroll-region" hidden={tab !== 'files'}><ProjectFileTree key={projectId} projectId={projectId} refresh={refresh} active={open && !change && tab === 'files'} onOpenFile={onOpenFile} /></div>
    <ProjectGitPane projectId={projectId} open={open && !change} tab={tab} refresh={refresh} onOpenFile={onOpenFile} />
    </div>
  </aside>;
}
