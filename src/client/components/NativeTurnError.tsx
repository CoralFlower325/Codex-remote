import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { TurnTiming } from '../../shared/turn-timing';
import { nativeErrorPresentation } from '../../shared/native-error';

export function NativeTurnError({ turn }: { turn: TurnTiming | undefined }) {
  const error = turn?.error;
  if (!error) return null;
  const { title, kind, httpStatusCode } = nativeErrorPresentation(error);
  const retrying = turn.status === 'inProgress' && turn.errorWillRetry === true;
  return <div className={`native-turn-error${retrying ? ' native-turn-error--retrying' : ''}`}
    role={retrying ? 'status' : 'alert'} data-native-error={turn.id}>
    {retrying ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
    <div>
      <strong>{title}{httpStatusCode && <span> · HTTP {httpStatusCode}</span>}</strong>
      {retrying && <span className="native-error-retry">Codex 正在重试</span>}
      <p>{error.message}</p>
      {(kind || error.additionalDetails) && <details>
        <summary>错误详情</summary>
        {kind && <code>{kind}</code>}
        {error.additionalDetails && <pre>{error.additionalDetails}</pre>}
      </details>}
    </div>
  </div>;
}
