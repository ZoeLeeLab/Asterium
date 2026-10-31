import { useId, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import type { TurnTimelineItem } from '../../types/domain';

export type ResolveQuestion = (answers: Record<string, string[]>, customAnswers?: Record<string, string>) => void | Promise<void>;
interface Draft { selected: string[]; custom: boolean; text: string }
const emptyDraft: Draft = { selected: [], custom: false, text: '' };
function localizeRecommended(value: string) {
  return value.replace(/\s*\(recommended\)/gi, '（推荐）').replace(/\brecommended\b/gi, '推荐');
}

export function UserInputRow({ row, active, onResolve }: { row: Extract<TurnTimelineItem, { kind: 'user_input' }>; active: boolean; onResolve: ResolveQuestion }) {
  const groupId = useId();
  const [drafts, setDrafts] = useState(new Map<string, Draft>());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const update = (id: string, change: (draft: Draft) => Draft) => setDrafts((current) => new Map(current).set(id, change(current.get(id) ?? emptyDraft)));
  if (!active || row.state !== 'running') return <details className="timeline-user-input-record"><summary><Check size={13} /><span>{row.answers ? '已回答伙伴的澄清问题' : '本次提问已结束'}</span><ChevronDown size={12} /></summary><div>{row.questions.map((question) => <p key={question.id}><strong>{question.prompt}</strong><span>{(row.answers?.[question.id] ?? []).map((value) => row.customAnswers?.[question.id] === value ? value : question.options?.some((option) => option.label === value) ? localizeRecommended(value) : value).join('、') || '未填写'}</span></p>)}</div></details>;

  const valid = row.questions.every((question) => {
    const draft = drafts.get(question.id) ?? emptyDraft;
    return question.options?.length ? (!draft.custom || Boolean(draft.text.trim())) && (draft.selected.length > 0 || draft.custom) : Boolean(draft.text.trim());
  });
  const submit = async () => {
    if (!valid || pending.current) return;
    pending.current = true; setSubmitting(true); setError('');
    const answers = Object.fromEntries(row.questions.map((question) => {
      const draft = drafts.get(question.id) ?? emptyDraft;
      return [question.id, question.options?.length ? [...new Set([...draft.selected, ...(draft.custom ? [draft.text] : [])])] : [draft.text]];
    }));
    const customAnswers = Object.fromEntries(row.questions.flatMap((question) => {
      const draft = drafts.get(question.id) ?? emptyDraft;
      return question.options?.length && draft.custom ? [[question.id, draft.text]] : [];
    }));
    try {
      if (Object.keys(customAnswers).length) await onResolve(answers, customAnswers);
      else await onResolve(answers);
      // Keep submission locked until the resolved event or a new request arrives.
    } catch {
      pending.current = false; setSubmitting(false); setError('暂时未能提交，请重试。');
    }
  };
  return <section className="timeline-user-input-card">
    <header><CircleAlert size={16} /><span><strong>伙伴需要你补充信息</strong><small>这不是权限审批</small></span></header>
    {row.questions.map((question) => {
      const draft = drafts.get(question.id) ?? emptyDraft;
      return <fieldset key={question.id} disabled={submitting}>
        <legend>{question.header && <em>{question.header}</em>}{question.prompt}</legend>
        {question.options?.length ? <>
          {question.options.map((option, index) => <label key={index}>
            <input type={question.multiple ? 'checkbox' : 'radio'} name={`${groupId}-${question.id}`} checked={draft.selected.includes(option.label)} onChange={(event) => {
              const checked = event.target.checked;
              update(question.id, (current) => ({ ...current, custom: question.multiple ? current.custom : false, selected: question.multiple ? checked ? [...current.selected, option.label] : current.selected.filter((value) => value !== option.label) : [option.label] }));
            }} />
            <span><strong>{localizeRecommended(option.label)}</strong>{option.description && <small>{localizeRecommended(option.description)}</small>}</span>
          </label>)}
          <label><input type={question.multiple ? 'checkbox' : 'radio'} name={`${groupId}-${question.id}`} checked={draft.custom} onChange={(event) => {
            const checked = event.target.checked;
            update(question.id, (current) => ({ ...current, custom: checked, selected: question.multiple ? current.selected : [] }));
          }} /><span><strong>其他／自行填写</strong><small>输入你自己的答案</small></span></label>
          {draft.custom && <textarea aria-label={`自行填写：${question.prompt}`} value={draft.text} onChange={(event) => update(question.id, (current) => ({ ...current, text: event.target.value }))} />}
        </> : <textarea aria-label={`回答：${question.prompt}`} value={draft.text} onChange={(event) => update(question.id, (current) => ({ ...current, text: event.target.value }))} />}
      </fieldset>;
    })}
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" disabled={!valid || submitting} onClick={() => void submit()}>{submitting ? '正在提交…' : '提交回答'}</button></footer>
  </section>;
}
