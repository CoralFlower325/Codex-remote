import { LoaderCircle, MessageSquareText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { pendingQuestionGroups, type QuestionGroup } from '../async-questions';
import { serializeQuestionReplies } from '../../shared/async-user-input';
import type { ThreadItem } from '../types';

interface QuestionDockProps {
  items: ThreadItem[];
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export function QuestionDock({ items, disabled, onSubmit, onError }: QuestionDockProps) {
  const groups = useMemo(() => pendingQuestionGroups(items), [items]);
  if (!groups.length) return null;
  return <section className="approval-dock question-dock" aria-label="Codex 等待你的回答">
    {groups.map(group => <QuestionCard key={group.id} group={group} disabled={disabled}
      onSubmit={onSubmit} onError={onError} />)}
  </section>;
}

export function QuestionCard({ group, disabled, onSubmit, onError }: {
  group: QuestionGroup;
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerFor = (id: string, options: string[] | null) => answers[id] ?? options?.[0] ?? '';
  const submit = async () => {
    if (disabled || working || submitted) return;
    setWorking(true); setError(null);
    console.debug('[async-questions] submitting', { count: group.questions.length });
    try {
      await onSubmit(serializeQuestionReplies(group.questions.map(question => ({ questionItemId: question.id,
        question: question.title, answer: answerFor(question.id, question.options) }))));
      setSubmitted(true);
      console.debug('[async-questions] native answer accepted');
    } catch (error) {
      console.warn('[async-questions] answer failed');
      setError(error instanceof Error ? error.message : '回答未确认送达，请检查连接和会话记录。');
      onError(error);
    } finally { setWorking(false); }
  };
  if (submitted) return <div className="approval-card" role="status">回答已提交</div>;
  return <div className="approval-card">
    <div className="approval-heading"><span className="approval-icon"><MessageSquareText size={17} /></span>
      <div><strong>Codex 需要你的选择</strong><p>选择选项或输入答案，点击提交后发送。</p></div>
    </div>
    {group.questions.map((question, index) => {
      const answer = answerFor(question.id, question.options);
      const selectedOption = Boolean(question.options?.includes(answer));
      return <fieldset className="question-block" key={question.id} disabled={disabled || working}>
        <legend>{group.questions.length > 1 ? `${index + 1}. ` : ''}{question.title}</legend>
        {question.options?.length ? <div className="choice-grid" role="group" aria-label={question.title}>
          {question.options.map((option, index) => <button type="button" key={index}
            className={`choice-button${answer === option ? ' choice-button--active' : ''}`}
            aria-pressed={answer === option} onClick={() => setAnswers(current => ({ ...current, [question.id]: option }))}>
            <span>{option}</span>
          </button>)}
        </div> : null}
        <textarea className="question-input" rows={2} aria-label={`${question.title}：自定义答案`}
          placeholder={question.options?.length ? '或输入其他答案' : '输入答案'}
          value={selectedOption ? '' : answer}
          onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} />
      </fieldset>;
    })}
    {error && <p className="question-error" role="alert">{error}</p>}
    <button type="button" className="primary-button" disabled={disabled || working ||
      group.questions.some(question => !answerFor(question.id, question.options).trim())} onClick={() => void submit()}>
      {working && <LoaderCircle size={16} className="spin" aria-hidden="true" />}提交回答
    </button>
  </div>;
}
