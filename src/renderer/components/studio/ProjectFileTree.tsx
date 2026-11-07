import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';
import type { ProjectBrowseRequest, ProjectDirectoryEntry } from '../../../shared/projectBrowser';

interface ProjectFileTreeProps {
  projectId: string;
  refresh: number;
  active?: boolean;
  label?: string;
  onOpenFile: (request: ProjectBrowseRequest, key: string, name: string) => void;
  onFileMenu?: (path: string, event: MouseEvent<HTMLButtonElement>) => void;
}

export function ProjectFileTree({ projectId, refresh, active = true, label = '项目目录树', onOpenFile, onFileMenu }: ProjectFileTreeProps) {
  const [directories, setDirectories] = useState<Record<string, ProjectDirectoryEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) { setLoading(true); setError(''); } });
    const paths = ['', ...expanded];
    void Promise.all(paths.map(async (directory) => {
      if (!window.asteriumProjects?.browse) throw new Error('请在桌面应用中浏览项目');
      const pending = window.asteriumProjects.browse({ projectId, action: 'directory', path: directory });
      // An expanded subdirectory may have been removed since the last read.
      const result = await (directory ? pending.catch(() => undefined) : pending);
      return [directory, result?.entries ?? []] as const;
    })).then((values) => { if (!cancelled) setDirectories(Object.fromEntries(values)); }).catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, projectId, refresh, expanded]);
  const renderDirectory = (directory: string): React.ReactNode => <ul role="group">{(Object.hasOwn(directories, directory) ? directories[directory] : []).map((entry) => <li key={entry.path}>
    <button type="button" className={selected === entry.path ? 'is-selected' : ''} title={entry.path} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
      onContextMenu={entry.directory ? undefined : (event) => onFileMenu?.(entry.path, event)} onClick={() => {
      setSelected(entry.path);
      if (entry.directory) setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
      else onOpenFile({ projectId, action: 'file', path: entry.path }, projectId + ':current:' + entry.path, entry.name);
    }}>{entry.directory ? <>{expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expanded.has(entry.path) ? <FolderOpen size={15} /> : <Folder size={15} />}</> : <><span className="tree-indent" /><FileCode2 size={15} /></>}<span>{entry.name}</span></button>
    {entry.directory && expanded.has(entry.path) && renderDirectory(entry.path)}
  </li>)}</ul>;
  return <>
    {error && <p role="alert">{error}</p>}
    {loading && <p className="browser-hint">正在读取…</p>}
    <div className="project-tree" role="tree" aria-label={label}>{renderDirectory('')}</div>
    {!loading && !error && directories['']?.length === 0 && <p className="browser-hint">这个文件夹是空的</p>}
  </>;
}
