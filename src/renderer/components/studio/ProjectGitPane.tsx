import { ChevronDown, ChevronRight, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectBrowseRequest, ProjectGitChange, ProjectGitCommit } from '../../../shared/projectBrowser';
import type { BrowserTab } from './ProjectBrowserPane';

export function ProjectGitPane({ projectId, open, tab, refresh, onOpenFile }: { projectId: string; open: boolean; tab: BrowserTab; refresh: number; onOpenFile: (request: ProjectBrowseRequest, key: string, name: string) => void }) {
  const [commits, setCommits] = useState<ProjectGitCommit[]>([]);
  const [changes, setChanges] = useState<ProjectGitChange[]>([]);
  const [commitChanges, setCommitChanges] = useState<Record<string, ProjectGitChange[]>>({});
  const [expanded, setExpanded] = useState<string>();
  const [more, setMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [git, setGit] = useState<string>();
  useEffect(() => {
    if (!open || tab === 'files') return;
    let cancelled = false;
    const browse = window.asteriumProjects?.browse;
    if (!browse) return;
    void browse(tab === 'history' ? { projectId, action: 'history', offset } : { projectId, action: 'status' }).then((result) => {
      if (cancelled) return;
      setError(''); setGit(result.git);
      if (tab === 'history') { setCommits((previous) => offset ? [...new Map([...previous, ...(result.commits ?? [])].map((item) => [item.sha, item])).values()] : result.commits ?? []); setMore(Boolean(result.more)); }
      else setChanges(result.changes ?? []);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Git 查询失败'); });
    return () => { cancelled = true; };
  }, [projectId, open, tab, refresh, offset]);
  const openChange = (change: ProjectGitChange, revision?: string) => onOpenFile({ projectId, action: 'diff', path: change.path, revision, group: change.group }, `${projectId}:${revision ?? change.group}:${change.path}`, `${change.path.split('/').at(-1)} · ${revision?.slice(0, 7) ?? ({ staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' }[change.group ?? 'unstaged'])}`);
  const fileList = (files: ProjectGitChange[], revision?: string) => <ul className="git-file-list">{files.map((change) => <li key={`${change.group}:${change.path}`}><button type="button" title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path} onClick={() => openChange(change, revision)}><span className={`git-status git-status-${change.status}`}>{change.status}</span><span>{change.path}</span></button></li>)}</ul>;
  return <div className="project-browser-body scroll-region" hidden={tab === 'files'} aria-label={tab === 'history' ? '提交历史列表' : '未提交列表'}>
    {error && <p role="alert">{error}</p>}
    {git === 'unavailable' ? <p className="browser-hint">此项目尚无可用 Git 仓库，文件浏览仍然可用。</p> : tab === 'history' ? <>
      {!commits.length && <p className="browser-hint">暂无提交记录</p>}
      {commits.map((commit) => <article className="git-commit" key={commit.sha}><button type="button" className="git-commit-heading" aria-expanded={expanded === commit.sha} onClick={() => {
        const next = expanded === commit.sha ? undefined : commit.sha; setExpanded(next);
        if (next) void window.asteriumProjects?.browse?.({ projectId, action: 'changes', revision: commit.sha }).then((result) => { setCommitChanges((previous) => ({ ...previous, [commit.sha]: result.changes ?? [] })); }).catch((reason) => setError(String(reason)));
      }}>{expanded === commit.sha ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<GitCommitHorizontal size={15} /><span><strong>{commit.subject}</strong><small>{commit.shortSha} · {commit.author} · {new Date(commit.date).toLocaleString('zh-CN')}</small></span></button>{expanded === commit.sha && <div>{commit.body && <p className="git-commit-body">{commit.body}</p>}{commitChanges[commit.sha] ? fileList(commitChanges[commit.sha], commit.sha) : <p className="browser-hint">正在读取变更…</p>}</div>}</article>)}
      {more && <button className="text-button" type="button" onClick={() => setOffset(commits.length)}>加载更多提交</button>}
    </> : <>{(['staged', 'unstaged', 'untracked'] as const).map((group) => <section className="git-change-group" key={group}><h3>{{ staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' }[group]} <small>{changes.filter((change) => change.group === group).length}</small></h3>{fileList(changes.filter((change) => change.group === group))}</section>)}{!changes.length && <p className="browser-hint">工作目录没有未提交改动</p>}</>}
  </div>;
}
