import { ChevronDown, CircleAlert, RefreshCw } from 'lucide-react';
import type { TurnTiming } from '../../shared/turn-timing';
import { nativeErrorContent } from '../native-error-content';

export function NativeTurnError({ turn }: { turn: TurnTiming | undefined }) {
  const error = turn?.error;
  if (!error) return null;
  const retrying = turn.status === 'inProgress' && turn.errorWillRetry === true;
  const content = nativeErrorContent(error, retrying);
  return <div className={`native-turn-error${retrying ? ' native-turn-error--retrying' : ''}`}
    role={retrying ? 'status' : 'alert'} data-native-error={turn.id}>
    {retrying ? <RefreshCw size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
    {error.additionalDetails?.trim() ? <details className="native-error-stream-details">
      <summary><span>{content}</span><ChevronDown size={12} aria-hidden="true" /></summary>
      <div>{error.additionalDetails}</div>
    </details> : <span className="native-error-content">{content}</span>}
  </div>;
}
