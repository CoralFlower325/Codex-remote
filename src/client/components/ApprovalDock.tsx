import { CircleAlert, Copy, FileCode2, LoaderCircle, MessageSquareText, ShieldCheck } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { copyText } from '../clipboard';

import { approvalDecisions, commandApprovalOptions, permissionApprovalResponse, type PermissionDecision } from '../approval';
import type { ServerRequest } from '../types';

interface ApprovalDockProps {
  requests: ServerRequest[];
  onRespond: (request: ServerRequest, result: unknown) => Promise<void>;
  onError: (error: unknown) => void;
}

export function ApprovalDock({ requests, onRespond, onError }: ApprovalDockProps) {
  if (requests.length === 0) return null;
  return (
    <section className="approval-dock" aria-label="等待中的审批">
      {requests.map((request) => (
        <ApprovalCard key={String(request.requestId)} request={request} onRespond={onRespond} onError={onError} />
      ))}
    </section>
  );
}

function ApprovalCard({
  request,
  onRespond,
  onError
}: {
  request: ServerRequest;
  onRespond: (request: ServerRequest, result: unknown) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState(false);
  const responding = useRef(false);
  const respond = async (result: unknown) => {
    if (responding.current) return;
    responding.current = true;
    setWorking(true);
    try {
      await onRespond(request, result);
    } catch (error) {
      onError(error);
    } finally {
      responding.current = false;
      setWorking(false);
    }
  };

  if (request.method === 'item/commandExecution/requestApproval') {
    return (
      <div className="approval-card">
        <ApprovalHeading
          icon={<CircleAlert size={17} />}
          title="允许运行命令？"
          description={String(request.params.reason ?? 'Codex 请求在这台电脑上执行命令。')}
        />
        <pre className="approval-command">{String(request.params.command ?? '')}</pre>
        <div className="approval-actions">
          {commandApprovalOptions(request.params.availableDecisions).map((option, index) => (
            <button type="button" key={index}
              className={option.decision === 'accept' ? 'primary-button' : 'secondary-button'}
              disabled={working} onClick={() => void respond({ decision: option.decision })}>
              <span>{option.label}</span>
              {option.detail && <code className="approval-policy-detail">{option.detail}</code>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (request.method === 'item/fileChange/requestApproval') {
    return (
      <div className="approval-card">
        <ApprovalHeading
          icon={<FileCode2 size={17} />}
          title="允许修改文件？"
          description={String(request.params.reason ?? 'Codex 请求写入工作区文件。')}
        />
        {request.params.grantRoot ? <pre className="approval-command">{String(request.params.grantRoot)}</pre> : null}
        <ApprovalButtons working={working} availableDecisions={request.params.availableDecisions} onDecision={(decision) => void respond({ decision })} />
      </div>
    );
  }

  if (request.method === 'item/permissions/requestApproval') {
    const permissions = request.params.permissions as
      | { network?: unknown; fileSystem?: unknown }
      | undefined;
    return (
      <div className="approval-card">
        <ApprovalHeading
          icon={<ShieldCheck size={17} />}
          title="允许额外权限？"
          description={String(request.params.reason ?? 'Codex 请求扩展当前任务的权限。')}
        />
        <pre className="approval-command">{JSON.stringify(permissions ?? {}, null, 2)}</pre>
        <ApprovalButtons
          working={working}
          onDecision={(decision) => void respond(permissionApprovalResponse(decision, permissions))}
        />
      </div>
    );
  }

  if (request.method === 'item/tool/requestUserInput') {
    return <UserInputApproval request={request} working={working} onRespond={respond} />;
  }

  return (
    <div className="approval-card">
      <ApprovalHeading
        icon={<CircleAlert size={17} />}
        title="需要在 Desktop 处理"
        description="此审批类型尚未适配。请在主机的 Codex Desktop 中处理，Remote 会同步结果。"
      />
      <details className="approval-details">
        <summary>请求详情</summary>
        <code>{request.method}</code>
        <pre className="approval-command">{JSON.stringify(request.params, null, 2).slice(0, 20_000)}</pre>
      </details>
      <button type="button" className="secondary-button" onClick={() => {
        void copyText(JSON.stringify({ method: request.method, params: request.params }, null, 2)).catch(onError);
      }}><Copy size={14} />复制请求</button>
    </div>
  );
}

function ApprovalHeading({
  icon,
  title,
  description
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="approval-heading">
      <span className="approval-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}

function UserInputApproval({
  request,
  working,
  onRespond
}: {
  request: ServerRequest;
  working: boolean;
  onRespond: (result: unknown) => Promise<void>;
}) {
  const questions = (request.params.questions ?? []) as Array<{
    id: string;
    header: string;
    question: string;
    isOther?: boolean;
    isSecret?: boolean;
    options?: Array<{ label: string; description?: string }> | null;
  }>;
  const [answers, setAnswers] = useState<Record<string, string>>({});

  return (
    <div className="approval-card">
      <ApprovalHeading
        icon={<MessageSquareText size={17} />}
        title="Codex 需要你的选择"
        description="回答后任务会继续执行。"
      />
      {questions.map((question) => {
        const options = question.options ?? [];
        const selected = answers[question.id] ?? '';
        const selectedOption = options.some((option) => option.label === selected);
        return (
          <fieldset className="question-block" key={question.id}>
            <legend>{question.header || question.question}</legend>
            <p>{question.question}</p>
            {options.length > 0 && (
              <div className="choice-grid">
                {options.map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    className={`choice-button${selected === option.label ? ' choice-button--active' : ''}`}
                    aria-pressed={selected === option.label}
                    onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
            )}
            {(options.length === 0 || question.isOther) && (
              <input
                className="question-input"
                type={question.isSecret ? 'password' : 'text'}
                value={selectedOption ? '' : selected}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                placeholder={question.isOther ? '输入其他答案' : '输入答案'}
              />
            )}
          </fieldset>
        );
      })}
      <button
        type="button"
        className="primary-button"
        disabled={working || questions.some((question) => !answers[question.id]?.trim())}
        onClick={() =>
          void onRespond({
            answers: Object.fromEntries(
              Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])
            )
          })
        }
      >
        {working ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
        提交回答
      </button>
    </div>
  );
}

function ApprovalButtons({
  working,
  availableDecisions,
  onDecision
}: {
  working: boolean;
  availableDecisions?: unknown;
  onDecision: (decision: PermissionDecision) => void;
}) {
  return (
    <div className="approval-actions">
      {approvalDecisions(availableDecisions).map((decision) => (
        <button type="button" key={decision} className={decision === 'accept' ? 'primary-button' : 'secondary-button'}
          disabled={working} onClick={() => onDecision(decision)}>
          {working && decision === 'accept' ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : null}
          {decision === 'accept' ? '允许一次' : decision === 'acceptForSession' ? '本次会话允许' : decision === 'cancel' ? '取消' : '拒绝'}
        </button>
      ))}
    </div>
  );
}
