import type { PartnerEvent } from '../../shared/agentProtocol';
import type { AutomationConfirmation, AutomationRun } from '../../shared/automations';
import type { GeneralSettings } from '../../shared/generalSettings';
import type { DesktopNavigationTarget } from '../../shared/desktopNotifications';
import type { StudioRoomSnapshot } from '../../shared/studioRuntime';
import type { ProjectTask } from '../../shared/projectDomain';

export class DesktopNotifications {
  private readonly seen = new Set<string>();
  private readonly taskStates = new Map<string, string>();
  private pending?: DesktopNavigationTarget;
  private disposed = false;
  private readonly startedAt;
  constructor(private readonly options: {
    settings: () => GeneralSettings;
    background: () => boolean;
    supported: () => boolean;
    show: (message: { title: string; body: string }, click: () => void) => void;
    restore: () => void;
    navigationReady: () => void;
    now?: () => number;
  }) { this.startedAt = (options.now ?? Date.now)(); }
  takeNavigation() { const target = this.pending; this.pending = undefined; return target; }
  private name(value?: string) { return value?.replace(/[\r\n\t]/g, ' ').trim().slice(0, 60); }
  private fresh(at: string) { return Date.parse(at) >= this.startedAt; }
  private notify(key: string, setting: keyof GeneralSettings['notifications'], body: string, target: DesktopNavigationTarget) {
    if (this.disposed || this.seen.has(key)) return;
    this.seen.add(key); // Foreground/disabled events are consumed, never replayed later.
    if (!this.options.settings().notifications[setting] || !this.options.background()) return;
    try {
      if (!this.options.supported()) return;
      this.options.show({ title: `星丛 · ${{ completed: '任务完成', approval: '等待审批', automationFailed: '自动化失败' }[setting]}`, body }, () => {
        if (this.disposed) return;
        this.pending = target; this.options.restore(); this.options.navigationReady();
      });
    } catch { /* OS notification availability must not fail a running task. */ }
  }
  agent(event: PartnerEvent, automation?: AutomationRun, partnerName?: string) {
    if ((event.type !== 'run.completed' && event.type !== 'authorization.requested') || !this.fresh(event.occurredAt)) return;
    if (event.route?.scope === 'workflow_planning' || event.clientMessageId.startsWith('profile-reload:')) return;
    const target: DesktopNavigationTarget = automation ? { kind: 'automations', automationId: automation.automationId }
      : event.route?.scope === 'group' ? { kind: 'group', roomId: event.route.roomId }
      : event.route?.scope === 'workspace' ? { kind: 'project', projectId: event.route.projectId }
      : { kind: 'conversation', conversationId: event.conversationId };
    const name = this.name(partnerName);
    if (event.type === 'authorization.requested') {
      this.notify(`approval:${event.partnerId}:${event.runId}:${event.authorizationId}`, 'approval', name ? `${name}有一项操作正在等待你的审批。` : '有一项操作正在等待你的审批。', target);
    } else if (!automation && (!event.route || event.route.scope === 'single')) {
      this.notify(`reply:${event.partnerId}:${event.conversationId}:${event.runId}`, 'completed', name ? `${name}已完成本次回复。` : '伙伴已完成本次回复。', target);
    }
  }
  room(snapshot: StudioRoomSnapshot) {
    const round = snapshot.activeRound;
    if (snapshot.metadata.archived || round?.state !== 'completed' || !this.fresh(round.updatedAt)) return;
    const name = this.name(snapshot.metadata.name);
    this.notify(`round:${snapshot.metadata.roomId}:${round.roundId}`, 'completed', name ? `“${name}”本轮群聊已完成。` : '本轮群聊已完成。', { kind: 'group', roomId: snapshot.metadata.roomId });
  }
  tasks(tasks: ProjectTask[]) {
    for (const task of tasks) {
      const key = `${task.projectId}:${task.id}`, previous = this.taskStates.get(key);
      this.taskStates.set(key, task.status);
      if (task.status === 'completed' && previous !== 'completed' && this.fresh(task.updatedAt)) {
        const name = this.name(task.title);
        this.notify(`task:${key}:${task.updatedAt}`, 'completed', name ? `项目任务“${name}”已完成。` : '项目任务已完成。', { kind: 'project', projectId: task.projectId, taskId: task.id });
      }
    }
  }
  automations(runs: AutomationRun[]) {
    for (const run of runs) {
      if (!this.fresh(run.finishedAt ?? run.updatedAt)) continue;
      const target: DesktopNavigationTarget = { kind: 'automations', automationId: run.automationId };
      const name = this.name(run.definition.name);
      if (run.state === 'failed') this.notify(`automation-failed:${run.id}`, 'automationFailed', name ? `“${name}”执行失败，请打开星丛查看。` : '自动化执行失败，请打开星丛查看。', target);
      else if (run.state === 'succeeded' && (run.definition.notifications === 'always' || run.changed)) {
        this.notify(`automation-completed:${run.id}`, 'completed', name ? `自动化“${name}”已完成。` : '自动化任务已完成。', target);
      }
    }
  }
  confirmations(confirmations: AutomationConfirmation[]) {
    for (const item of confirmations) this.notify(`automation-approval:${item.id}`, 'approval', '自动化设置正在等待你的审批。', { kind: 'automations' });
  }
  dispose() { this.disposed = true; this.pending = undefined; this.seen.clear(); this.taskStates.clear(); }
}
