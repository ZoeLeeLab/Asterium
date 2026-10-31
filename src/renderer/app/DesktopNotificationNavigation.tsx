import { useEffect, useEffectEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePrototype } from './PrototypeProvider';
import type { DesktopNavigationTarget } from '../../shared/desktopNotifications';

export function DesktopNotificationNavigation() {
  const navigate = useNavigate();
  const { state, selectConversation, selectGroupChat, selectProject } = usePrototype();
  const open = useEffectEvent((target: DesktopNavigationTarget) => {
    if (target.kind === 'conversation') {
      if (state.conversations.some(c => c.id === target.conversationId && !c.isArchived)) selectConversation(target.conversationId);
      navigate('/chat');
    } else if (target.kind === 'group') {
      const group = state.groupChats.find(g => g.id === target.roomId && !g.archivedAt);
      if (group && state.projects.some(p => p.id === group.projectId)) { selectProject(group.projectId); selectGroupChat(group.id); }
      navigate('/studio/discussion');
    } else if (target.kind === 'project') {
      const project = state.projects.find(p => p.id === target.projectId);
      if (project) selectProject(project.id);
      navigate('/studio/workspace', { state: project && target.taskId && project.tasks.some(t => t.id === target.taskId) ? { notificationTaskId: target.taskId } : {} });
    } else {
      navigate('/settings/partners?section=automations' + (target.automationId ? `&automation=${encodeURIComponent(target.automationId)}` : ''));
    }
  });
  useEffect(() => {
    let live = true;
    const ready = () => { if (live) void window.asteriumDesktopNavigation?.take().then(target => { if (live && target) open(target); }).catch(() => undefined); };
    const unsubscribe = window.asteriumDesktopNavigation?.onReady(ready);
    queueMicrotask(ready); // StrictMode's discarded mount must not consume a pending click.
    return () => { live = false; unsubscribe?.(); };
  }, []);
  return null;
}
