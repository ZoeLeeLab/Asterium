import type { MemoryStatus, MemoryType } from '../../../shared/memoryArchive';

export const memoryTypeLabels: Record<MemoryType, string> = {
  self_summary: '自我总结',
  relationship_with_user: '与用户的关系',
  stable_fact: '稳定事实',
  long_term_project: '长期项目',
  recurring_behavior_pattern: '反复行为模式',
  preference_and_collaboration: '偏好与协作方式',
  open_question_and_follow_up: '未闭合问题与后续',
};

export const memoryStatusLabels: Record<MemoryStatus, string> = {
  active: '有效',
  completed: '已完成',
  obsolete: '已过时',
  superseded: '已被取代',
};
