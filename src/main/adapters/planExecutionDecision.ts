import type { UserInputQuestion, UserInputResponse } from '../../shared/agentProtocol';

export const PLAN_EXECUTION_QUESTION_ID = 'plan-execution';
export const PLAN_EXECUTION_START = '开始执行 (Recommended)';
export const PLAN_EXECUTION_STOP = '暂不执行';

export function planExecutionQuestions(): UserInputQuestion[] {
  return [{
    id: PLAN_EXECUTION_QUESTION_ID,
    header: '执行计划',
    prompt: '计划已经完成，是否开始执行？',
    options: [
      { label: PLAN_EXECUTION_START, description: '退出计划模式，并按当前计划继续修改。' },
      { label: PLAN_EXECUTION_STOP, description: '保留计划并停止当前任务，不做修改。' },
    ],
  }];
}

export function shouldExecutePlan(answers: Record<string, string[]>, customAnswers?: Record<string, string>) {
  const values = answers[PLAN_EXECUTION_QUESTION_ID];
  return customAnswers?.[PLAN_EXECUTION_QUESTION_ID] === undefined && values?.length === 1 && values[0] === PLAN_EXECUTION_START;
}

export function planExecutionDecision({ answers, customAnswers }: UserInputResponse): { action: 'execute' | 'stop' } | { action: 'revise'; feedback: string } {
  const values = answers[PLAN_EXECUTION_QUESTION_ID];
  if (values?.length !== 1 || !values[0].trim()) throw new Error('INVALID_PLAN_ANSWER');
  const custom = customAnswers?.[PLAN_EXECUTION_QUESTION_ID];
  if (custom !== undefined && custom !== values[0]) throw new Error('INVALID_PLAN_ANSWER');
  if (shouldExecutePlan(answers, customAnswers)) return { action: 'execute' };
  if (custom === undefined && values[0] === PLAN_EXECUTION_STOP) return { action: 'stop' };
  return { action: 'revise', feedback: values[0] };
}
