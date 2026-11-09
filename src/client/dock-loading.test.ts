import { afterEach, describe, expect, it, vi } from 'vitest';

// A small effect runner keeps this integration test independent of a browser/DOM.
const hooks = vi.hoisted(() => {
  type Slot = { value?: any; deps?: unknown[]; cleanup?: void | (() => void) };
  class Scope {
    slots: Slot[] = [];
    effects: (() => void)[] = [];
    cursor = 0;
    dirty = true;
    root: () => void = () => {};
    slot() { return this.slots[this.cursor++] ?? (this.slots[this.cursor - 1] = {}); }
    render() {
      for (let pass = 0; this.dirty && pass < 20; pass++) {
        this.dirty = false;
        this.cursor = 0;
        hooks.active = this;
        this.root();
        this.effects.splice(0).forEach(effect => effect());
      }
      if (this.dirty) throw new Error('Hook rendering did not settle.');
    }
    dispose() { this.slots.forEach(slot => slot.cleanup?.()); }
  }
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b ||
    a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
  return { Scope, changed, active: null as Scope | null, threadId: 'synthetic-chat' };
});
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useContext() { return hooks.threadId; },
  useState(initial: any) {
    const scope = hooks.active!, slot = scope.slot();
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial;
    return [slot.value, (update: any) => {
      const next = typeof update === 'function' ? update(slot.value) : update;
      if (!Object.is(slot.value, next)) { slot.value = next; scope.dirty = true; }
    }];
  },
  useRef(initial: any) {
    const slot = hooks.active!.slot();
    return slot.value ??= { current: initial };
  },
  useMemo(create: () => any, deps: unknown[]) {
    const slot = hooks.active!.slot();
    if (hooks.changed(slot.deps, deps)) { slot.value = create(); slot.deps = deps; }
    return slot.value;
  },
  useCallback(callback: any, deps: unknown[]) {
    const slot = hooks.active!.slot();
    if (hooks.changed(slot.deps, deps)) { slot.value = callback; slot.deps = deps; }
    return slot.value;
  },
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const scope = hooks.active!, slot = scope.slot();
    if (hooks.changed(slot.deps, deps)) {
      slot.deps = deps;
      scope.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    }
  }
}));
const connection = vi.hoisted(() => ({ options: null as any }));
vi.mock('./remote-connection', () => ({ RemoteConnection: class {
  constructor(options: unknown) { connection.options = options; }
  start() {} dispose() {} reconnect() {}
} }));
vi.mock('./device-snapshots', () => ({
  readDeviceWorkspace: async () => null, readDeviceChat: vi.fn(async () => null),
  saveDeviceWorkspace: async () => {}, saveDeviceChat: async () => {}, removeDeviceChat: async () => {}
}));
vi.mock('./background-work', () => ({
  prioritizeInteraction: () => {}, beginForegroundRead: () => () => {}, constrainedNetwork: () => false,
  yieldToInteraction: () => new Promise(() => {})
}));
import { useRemote } from './useRemote';
import { readDeviceChat } from './device-snapshots';
import { useSubagentChats, type SubagentChatsController } from './useSubagentChats';
import type { RemoteController } from './remote-contracts';
import type { ChatTransport } from './chat-transport';
import { pendingQuestionGroups } from './async-questions';
import type { QueuedSubmission } from './queued-messages';
import { useHistoryDetails } from './history-details';
import type { ThreadItem } from './types';
import { QuestionDock, QuestionCard } from './components/QuestionDock';
import { parseQuestionReplies, questionItemId } from '../shared/async-user-input';
import { historyConfig } from './history-config';
import { QueuedMessages } from './components/QueuedMessages';
import type { Thread, ThreadHistoryPage, WorkspaceBootstrap } from './types';

let scope: InstanceType<typeof hooks.Scope>;
afterEach(() => {
  scope?.dispose(); hooks.threadId = 'synthetic-chat';
  vi.mocked(readDeviceChat).mockReset().mockResolvedValue(null);
  vi.useRealTimers(); vi.unstubAllGlobals();
});
const thread = { id: 'synthetic-chat', status: { type: 'active' }, updatedAt: 1 } as Thread;

async function settle() {
  for (let pass = 0; pass < 10; pass++) { await Promise.resolve(); scope.render(); }
}

function synchronizeConnection() {
  connection.options.onMessage({ type: 'bridge.status', status: 'ready' });
  connection.options.onMessage({ type: 'sync.ready', epoch: 'synthetic', sequence: 0, resumed: true });
}

const goal = { threadId: thread.id, objective: 'Synthetic goal', status: 'active', tokenBudget: null,
  tokensUsed: 10, timeUsedSeconds: 5, createdAt: 1, updatedAt: 10 };
const queued = { id: 'q', clientUserMessageId: 'u', input: [{ type: 'text', text: 'Synthetic steering', text_elements: [] }] };
function fixture(fetcher: typeof fetch, authenticated = true) {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    location: { protocol: 'http:', host: 'localhost' }, setTimeout, clearTimeout, setInterval, clearInterval
  }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  vi.stubGlobal('fetch', fetcher);
  let remote!: RemoteController;
  let queue: ReturnType<typeof QueuedMessages> = null;
  let questions: ReturnType<typeof QuestionDock> = null;
  const bootstrap = { threads: { data: [thread], nextCursor: null }, models: { data: [] },
    projects: { data: [] } } as unknown as WorkspaceBootstrap;
  scope = new hooks.Scope();
  scope.root = () => {
    remote = useRemote({ authenticated, bootstrap });
    questions = QuestionDock({ items: remote.items, disabled: false, onSubmit: async () => {}, onError: console.error });
    if (remote.activeThread) queue = QueuedMessages({ transport: remote.chatTransport, threadId: thread.id,
      readable: remote.authenticated, connected: remote.connected && remote.threadReady, activeTurnId: null,
      onError: console.error, onOpenSideChat: () => {}, queueEnabled: true, onQueueEnabledChange: () => {} });
  };
  scope.render();
  return { get remote() { return remote; }, get queue() { return queue; }, get questions() { return questions; } };
}
const json = (body: unknown) => Promise.resolve({ ok: true, text: async () => JSON.stringify(body) } as Response);

describe('thread dock load ordering', () => {
  it.each([true, false])('bounds live growth while preserving a reading window (reading: %s)', async reading => {
    const records = Array.from({ length: 800 }, (_, index) => ({
      turnId: index < 400 ? 'previous' : 'running', item: {
        type: 'agentMessage', id: `record-${index}`, text: `Record ${index}`
      }
    }));
    const f = fixture(path => String(path).includes('/thread/open?') ? json({
      result: { thread }, items: records, turns: [], activeTurnId: 'running', turnsCursor: null, nextCursor: 'older'
    }) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    f.remote.setHistoryReading(thread.id, reading);
    connection.options.onMessage({ type: 'event', method: 'item/started', params: {
      threadId: thread.id, turnId: 'running', item: { type: 'agentMessage', id: 'record-new', text: 'Live addition' }
    } });
    await settle();
    expect(f.remote.items.length).toBeLessThanOrEqual(800);
    if (reading) {
      expect(f.remote.items.map(item => item.id)).toEqual(records.map(record => record.item.id));
      expect(f.remote.viewingHistory).toBe(true);
      expect(f.remote.hasNewerHistory).toBe(true);
    } else {
      expect(f.remote.items.at(-1)?.id).toBe('record-new');
      expect(f.remote.viewingHistory).toBe(false);
    }
    expect(f.remote.hasMoreHistory).toBe(true);
  });

  it('retains a created chat when optional settings fail and sends the first turn to that same chat', async () => {
    const f = fixture(() => new Promise(() => {}));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const created = { ...thread, id: 'created-once', status: { type: 'idle' } };
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      calls.push(message);
      connection.options.onMessage(message.method === 'thread/settings/update'
        ? { type: 'rpc.error', id: message.id, error: { code: -32000, message: 'Synthetic settings rejected' } }
        : { type: 'rpc.result', id: message.id, result: message.method === 'thread/start'
          ? { thread: created } : message.method === 'turn/start'
            ? { turn: { id: 'first-turn', status: 'inProgress' } } : { data: [], nextCursor: null } });
    } });
    const result = await f.remote.createThread({ effort: 'high' });
    await settle();
    expect(result.id).toBe(created.id);
    expect(f.remote.activeThreadId).toBe(created.id);
    expect(f.remote.lastError).toContain('聊天已经创建');
    expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    await f.remote.sendTurn(created.id, 'First request', { effort: 'high' });
    await settle();
    expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
    expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ threadId: created.id, effort: 'high' });
  });

  it('renders goal and steering before a stalled realtime connection or history read completes', async () => {
    const fetcher = vi.fn<typeof fetch>((path) => String(path).includes('/dock/goal') ? json({ goal })
      : String(path).includes('/dock/queue') ? json({ data: [queued] }) : new Promise(() => {}));
    const f = fixture(fetcher);
    void f.remote.openThread(thread.id).catch(() => {});
    await settle();
    expect(f.remote.activeThread?.id).toBe(thread.id);
    expect(f.remote.threadReady).toBe(false);
    expect(f.remote.activeGoal).toEqual(goal);
    expect(f.queue).not.toBeNull();
    const paths = fetcher.mock.calls.map(([path]) => String(path));
    expect(paths.some(path => path.includes('/goal'))).toBe(true);
    expect(paths.some(path => path.includes('/queue'))).toBe(true);
  });
  it('never starts private dock reads in an unverified returning shell', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const f = fixture(fetcher, false);
    void f.remote.openThread(thread.id).catch(() => {});
    await settle();
    expect(fetcher.mock.calls.some(([path]) => String(path).includes('/dock/'))).toBe(false);
  });
  it('does not let an old goal read overwrite a newer native update', async () => {
    let resolveGoal!: (response: Response) => void;
    const f = fixture((path) => String(path).includes('/dock/goal')
      ? new Promise(resolve => { resolveGoal = resolve; }) : new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    const updated = { ...goal, status: 'paused', updatedAt: 20 };
    connection.options.onMessage({ type: 'event', method: 'thread/goal/updated', params: { threadId: thread.id, goal: updated } });
    scope.render();
    resolveGoal(await json({ goal })); await settle();
    expect(f.remote.activeGoal).toEqual(updated);
  });
  it('uses native goal actions with user provenance and immediately applies successful responses', async () => {
    const f = fixture((path) => String(path).includes('/dock/goal') ? json({ goal }) : new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      expect(message.params.origin).toBe('user');
      connection.options.onMessage({ type: 'rpc.result', id: message.id, result: message.method === 'thread/goal/clear'
        ? { cleared: true } : { goal: { ...goal, ...message.params } } });
    } });
    await f.remote.setGoal(thread.id, { status: 'paused' }); await settle();
    expect(f.remote.activeGoal?.status).toBe('paused');
    await f.remote.setGoal(thread.id, { objective: 'Edited objective', status: 'active' }); await settle();
    expect(f.remote.activeGoal?.objective).toBe('Edited objective');
    await f.remote.clearGoal(thread.id); await settle();
    expect(f.remote.activeGoal).toBeNull();
  });
  it('reuses a recent navigation window and invalidates it on a native change to that turn', async () => {
    const page = { items: [{ turnId: 't', item: { type: 'userMessage', id: 'u', content: [] } }],
      nextCursor: 'older', newerCursor: 'newer' };
    const fetcher = vi.fn<typeof fetch>((path) => String(path).includes('/around?') ? json(page) : new Promise(() => {}));
    const f = fixture(fetcher); void f.remote.openThread(thread.id).catch(() => {}); await settle();
    expect(await f.remote.revealHistory('t', 'u')).toBe(true); await settle();
    expect(await f.remote.revealHistory('t', 'u')).toBe(true); await settle();
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/around?'))).toHaveLength(1);
    connection.options.onMessage({ type: 'event', method: 'thread/goal/updated', params: { threadId: thread.id, goal } });
    expect(await f.remote.revealHistory('t', 'u')).toBe(true); await settle();
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/around?'))).toHaveLength(2);
  });
  it('does not cache a navigation response invalidated while the read is pending', async () => {
    const page = { items: [{ turnId: 't', item: { type: 'userMessage', id: 'u', content: [] } }],
      nextCursor: null, newerCursor: null };
    let resolvePage!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>((path) => String(path).includes('/around?')
      ? new Promise(resolve => { resolvePage = resolve; }) : new Promise(() => {}));
    const f = fixture(fetcher); void f.remote.openThread(thread.id).catch(() => {}); await settle();
    const first = f.remote.revealHistory('t', 'u'); await settle();
    connection.options.onMessage({ type: 'event', method: 'thread/goal/updated', params: { threadId: thread.id, goal } });
    resolvePage(await json(page)); expect(await first).toBe(true); await settle();
    const second = f.remote.revealHistory('t', 'u'); await settle();
    const reads = fetcher.mock.calls.filter(([path]) => String(path).includes('/around?')).length;
    resolvePage(await json(page)); await second;
    expect(reads).toBe(2);
  });

});

function elements(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)];
}

describe('native question interaction', () => {
  it('requires explicit choices and preserves multiline drafts on failure', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    let card: any;
    scope = new hooks.Scope();
    scope.root = () => { card = QuestionCard({ group: { id: 'q', questions: [
      { id: questionItemId('call', 0), title: 'Choose?', options: ['A', 'B'] },
      { id: questionItemId('call', 1), title: 'Details?', options: null }
    ] }, disabled: false, onSubmit, onError }); };
    scope.render();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(elements(card).some(node => node.props?.['aria-pressed'] === true)).toBe(false);
    const inputs = elements(card).filter(node => node.type === 'textarea');
    inputs[1]!.props.onChange({ target: { value: 'First line\nSecond line' } });
    scope.render();
    expect(onSubmit).not.toHaveBeenCalled(); // A newline in a free-text answer is never send.
    let button = elements(card).find(node => node.props?.className === 'primary-button');
    expect(button.props.disabled).toBe(true);
    button.props.onClick(); await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    elements(card).find(node => node.props?.className === 'choice-button')!.props.onClick();
    scope.render();
    button = elements(card).find(node => node.props?.className === 'primary-button');
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    button.props.onClick(); // Both callbacks can run before React commits the disabled state.
    await settle();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(elements(card).filter(node => node.type === 'textarea')[1]!.props.value).toBe('First line\nSecond line');
    button = elements(card).find(node => node.props?.className === 'primary-button');
    button.props.onClick(); await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(parseQuestionReplies(onSubmit.mock.calls[1]![0])).toEqual([
      { questionItemId: questionItemId('call', 0), question: 'Choose?', answer: 'A' },
      { questionItemId: questionItemId('call', 1), question: 'Details?', answer: 'First line\nSecond line' }
    ]);
    expect(card.props.role).toBe('status');
  });
  it('sends native replies directly with expectedTurnId, never as a queued message', async () => {
    const f = fixture(() => new Promise(() => {}));
    const sent: any[] = [];
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      sent.push(message);
      connection.options.onMessage({ type: 'rpc.result', id: message.id, result: {} });
    } });
    const text = '<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>';
    await f.remote.steerTurn(thread.id, 'active-native-turn', text);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'turn/steer', params: { threadId: thread.id,
      expectedTurnId: 'active-native-turn', input: [{ type: 'text', text }] } });
  });
  it('shows a steer immediately and reconciles it with the native user item', async () => {
    const f = fixture(() => new Promise(() => {}));
    let message: any;
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const parsed = JSON.parse(payload);
      if (parsed.type === 'rpc') message = parsed;
    } });
    const pending = f.remote.steerTurn(thread.id, 'active-native-turn', 'Immediate steer');
    await settle();
    const optimistic = f.remote.items.find(item => item.type === 'userMessage' && item.optimistic);
    expect(optimistic).toMatchObject({ type: 'userMessage', optimistic: 'sending',
      content: [{ type: 'text', text: 'Immediate steer' }] });
    expect(message.params).toMatchObject({ clientUserMessageId: optimistic?.id });
    connection.options.onMessage({ type: 'rpc.result', id: message.id, result: {} });
    await pending;
    expect(f.remote.items.filter(item => item.type === 'userMessage')).toHaveLength(1);
  });
});

describe('optimistic new-turn sends', () => {
  const openFetcher: typeof fetch = (path) => {
    const url = String(path);
    if (url.includes('/thread/open?')) return json({ result: { thread }, items: [], turns: [],
      nextCursor: null, turnsCursor: null, activeTurnId: null });
    if (url.includes('/thread/timings')) return json({ turns: [], turnsCursor: null, activeTurnId: null });
    return new Promise(() => {});
  };
  function captureSocket(onStart: (message: any) => void) {
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'turn/start') return onStart(message);
      connection.options.onMessage({ type: 'rpc.result', id: message.id, result: {} });
    } });
  }

  it('shows a send immediately and reconciles it with the native user item', async () => {
    const f = fixture(openFetcher);
    synchronizeConnection();
    await f.remote.openThread(thread.id);
    await settle();
    let startMessage: any;
    captureSocket(message => { startMessage = message; });
    const pending = f.remote.sendTurn(thread.id, 'Immediate send');
    await settle();
    const optimistic = f.remote.items.find(item => item.type === 'userMessage' && item.optimistic);
    expect(optimistic).toMatchObject({ type: 'userMessage', optimistic: 'sending',
      content: [{ type: 'text', text: 'Immediate send' }] });
    expect(startMessage.params).toMatchObject({ threadId: thread.id, clientUserMessageId: optimistic?.id });
    connection.options.onMessage({ type: 'rpc.result', id: startMessage.id,
      result: { turn: { id: 'turn-new', status: 'inProgress', startedAt: 10 } } });
    await pending;
    await settle();
    connection.options.onMessage({ type: 'event', method: 'item/started', params: {
      threadId: thread.id, turnId: 'turn-new',
      item: { type: 'userMessage', id: optimistic!.id, content: [{ type: 'text', text: 'Immediate send' }] } } });
    await settle();
    const userMessages = f.remote.items.filter(item => item.type === 'userMessage');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.optimistic).toBeUndefined();
  });

  it('steers a queued submission immediately with its own client id', async () => {
    const f = fixture(() => new Promise(() => {}));
    let steerMessage: any;
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'turn/steer') steerMessage = message;
      else connection.options.onMessage({ type: 'rpc.result', id: message.id, result: {} });
    } });
    const queuedMessage = { id: 'native-q', clientUserMessageId: 'queued-client-id',
      input: [{ type: 'text', text: 'Queued steer', text_elements: [] }] } as QueuedSubmission;
    const pending = f.remote.steerQueued(thread.id, 'active-native-turn', queuedMessage);
    await settle();
    const optimistic = f.remote.items.find(item => item.type === 'userMessage' && item.optimistic);
    expect(optimistic?.id).toBe('queued-client-id');
    expect(optimistic).toMatchObject({ optimistic: 'sending', turnId: 'active-native-turn',
      content: [{ type: 'text', text: 'Queued steer' }] });
    expect(steerMessage.params).toMatchObject({ threadId: thread.id,
      expectedTurnId: 'active-native-turn', clientUserMessageId: 'queued-client-id' });
    connection.options.onMessage({ type: 'rpc.result', id: steerMessage.id, result: {} });
    await pending;
    await settle();
    expect(f.remote.items.filter(item => item.type === 'userMessage')).toHaveLength(1);
  });

  it('removes the optimistic send when turn/start is rejected', async () => {
    const f = fixture(openFetcher);
    synchronizeConnection();
    await f.remote.openThread(thread.id);
    await settle();
    let startMessage: any;
    captureSocket(message => { startMessage = message; });
    const pending = f.remote.sendTurn(thread.id, 'Rejected send');
    const rejection = expect(pending).rejects.toThrow('Synthetic rejection');
    await settle();
    expect(f.remote.items.some(item => item.type === 'userMessage' && item.optimistic)).toBe(true);
    connection.options.onMessage({ type: 'rpc.error', id: startMessage.id,
      error: { message: 'Synthetic rejection', code: -1 } });
    await rejection;
    await settle();
    expect(f.remote.items.some(item => item.type === 'userMessage')).toBe(false);
  });
});

describe('slow history transport regression', () => {
  it('allows the selected chat body to finish past six seconds, retaining the first download', async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((path, options) => String(path).includes('/thread/open?')
      ? new Promise((resolve, reject) => {
        finish = resolve; signal = options?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal!.reason));
      }) : new Promise(() => {}));
    const f = fixture(fetcher);
    const opening = f.remote.openThread(thread.id);
    await settle();
    await vi.advanceTimersByTimeAsync(7000);
    expect(signal?.aborted).toBe(false);
    expect(historyConfig.readTimeoutMs).toBeGreaterThan(7000);
    finish(await json({ result: { thread }, items: [{ turnId: 't', item: { type: 'agentMessage', id: 'a', text: 'Answer' } }],
      nextCursor: null, turns: [], turnsCursor: null, activeTurnId: null }));
    await opening; await settle();
    expect(f.remote.items[0]).toMatchObject({ id: 'a', text: 'Answer' });
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))).toHaveLength(1);
  });
});

describe('cached history verification', () => {
  const timing = { id: 't', status: 'completed' as const, startedAt: 1, completedAt: 2, durationMs: 1000 };
  const page: ThreadHistoryPage & { result: { thread: Thread } } = {
    result: { thread },
    items: [
      { turnId: 't', startedAtMs: null, completedAtMs: null,
        item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] } },
      { turnId: 't', startedAtMs: null, completedAtMs: null,
        item: { type: 'subAgentActivity', id: 'child', kind: 'completed', agentThreadId: 'synthetic-child',
          agentPath: '/child', model: null, reasoningEffort: null } },
      { turnId: 't', startedAtMs: null, completedAtMs: null,
        item: { type: 'agentMessage', id: 'a', text: 'Answer' } }
    ], nextCursor: 'older', turns: [timing], turnsCursor: null, activeTurnId: null
  };
  it('waits for the latest native page instead of flashing old rounds on five reopenings', async () => {
    const f = fixture(path => String(path).includes('/thread/open?') ? json(page)
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    const expected = f.remote.items;
    expect(expected.map(item => item.id)).toEqual(['u', 'child', 'a']);
    expect(f.remote.historySnapshot).toBeNull();
    for (let attempt = 0; attempt < 5; attempt++) {
      f.remote.closeThread(); scope.render();
      const opening = f.remote.openThread(thread.id); scope.render();
      expect(f.remote.loadingThread).toBe(true);
      expect(f.remote.historySnapshot).toBe('loading');
      expect(f.remote.items).toEqual([]);
      await opening; await settle();
      expect(f.remote.historySnapshot).toBeNull();
      expect(f.remote.items).toEqual(expected);
      expect(f.remote.hasMoreHistory).toBe(true);
    }
  });
  it('retains the cached content and failed-verification state until a successful retry', async () => {
    let fail = false;
    const f = fixture(path => String(path).includes('/thread/open?') ? fail
      ? Promise.resolve({ ok: false, status: 404, text: async () => '{"error":"Unavailable"}' } as Response)
      : json(page) : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    f.remote.closeThread(); scope.render(); fail = true;
    await expect(f.remote.openThread(thread.id)).rejects.toThrow('Unavailable'); await settle();
    expect(f.remote.historySnapshot).toBe('failed');
    expect(f.remote.items.map(item => item.id)).toEqual(['u', 'a']);
    expect(f.remote.threadReady).toBe(false);
    fail = false;
    await f.remote.openThread(thread.id); await settle();
    expect(f.remote.historySnapshot).toBeNull();
    expect(f.remote.items.map(item => item.id)).toEqual(['u', 'child', 'a']);
  });
  it('ignores an older device preview that arrives after the native history', async () => {
    let finish!: (value: Awaited<ReturnType<typeof readDeviceChat>>) => void;
    vi.mocked(readDeviceChat).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const f = fixture(path => String(path).includes('/thread/open?') || String(path).includes('/thread/timings?')
      ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    finish({ thread, page: { ...page, items: [], nextCursor: null } }); await settle();
    expect(f.remote.historySnapshot).toBeNull();
    expect(f.remote.items.map(item => item.id)).toEqual(['u', 'child', 'a']);
    expect(f.remote.hasMoreHistory).toBe(true);
  });
  it('does not display a device preview while waiting for the latest round', async () => {
    vi.mocked(readDeviceChat).mockResolvedValue({ thread, page });
    let finish!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(path => String(path).includes('/thread/open?')
      ? new Promise(resolve => { finish = resolve; }) : new Promise(() => {}));
    const f = fixture(fetcher);
    const opening = f.remote.openThread(thread.id);
    await settle();
    expect(f.remote.items).toEqual([]);
    expect(f.remote.loadingThread).toBe(true);
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))
      .every(([path]) => new URL(String(path), 'http://localhost').searchParams.get('fresh') === '1')).toBe(true);
    finish(await json({ ...page, items: [...page.items, { turnId: 'latest',
      item: { type: 'agentMessage', id: 'latest-answer', text: 'Latest answer' } }] }));
    await opening; await settle();
    expect(f.remote.items.at(-1)?.id).toBe('latest-answer');
    expect(f.remote.historySnapshot).toBeNull();
  });
  it('does not restart a pending selection or reload the already verified selected chat', async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>((path, options) => String(path).includes('/thread/open?')
      ? ++reads === 1 ? new Promise(resolve => { finish = resolve; signal = options?.signal ?? undefined; }) : json(page)
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    const f = fixture(fetcher);
    const opening = f.remote.openThread(thread.id); await settle();
    await f.remote.openThread(thread.id); await settle();
    expect(signal?.aborted).toBe(false);
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))).toHaveLength(1);
    finish(await json(page)); await opening; await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    const mountedItems = f.remote.items;
    const mountedThread = f.remote.activeThread;
    await f.remote.openThread(thread.id); await settle();
    expect(f.remote.items).toBe(mountedItems);
    expect(f.remote.activeThread).toBe(mountedThread);
    expect(f.remote.loadingThread).toBe(false);
    expect(f.remote.historySnapshot).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))).toHaveLength(2);
  });
  it.each([false, true])('attaches during the first download and reveals only its reconciled tail (invalidated: %s)', async invalidated => {
    const pending: ((value: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(path => String(path).includes('/thread/open?')
      ? new Promise(resolve => pending.push(resolve))
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    const f = fixture(fetcher);
    const opening = f.remote.openThread(thread.id); await settle();
    const resumes: string[] = [];
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'thread/resume') resumes.push(message.id);
      connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread: { ...thread, model: 'native-model' } } : { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    expect(resumes).toHaveLength(1);
    expect(f.remote.items).toEqual([]);
    expect(f.remote.threadReady).toBe(false);
    pending.shift()!(await json({ ...page, ...(invalidated ? { snapshot: { stale: true, savedAt: 1 } } : {}) })); await settle();
    expect(pending).toHaveLength(1);
    expect(f.remote.items).toEqual([]);
    expect(f.remote.loadingThread).toBe(true);
    pending.shift()!(await json({ ...page, result: { thread: { ...thread, model: 'native-model' } }, items: [...page.items, {
      turnId: 'latest', item: { type: 'agentMessage', id: 'latest-answer', text: 'Latest attached answer' }
    }] }));
    await opening; await settle();
    expect(f.remote.items.at(-1)?.id).toBe('latest-answer');
    expect(f.remote.activeThread?.model).toBe('native-model');
    expect(f.remote.threadReady).toBe(true);
    expect(f.remote.historySnapshot).toBeNull();
    expect(resumes).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))).toHaveLength(2);
  });
  it('keeps readable text mounted while native timings are pending and gates sending until they arrive', async () => {
    let finishTimings!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(path => String(path).includes('/thread/open?')
      ? json(page) : String(path).includes('/thread/timings?')
        ? new Promise(resolve => { finishTimings = resolve; }) : new Promise(() => {}));
    const f = fixture(fetcher);
    await f.remote.openThread(thread.id); await settle();
    const resumes: string[] = [];
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'thread/resume') resumes.push(message.id);
      connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    expect(f.remote.loadingThread).toBe(false);
    expect(f.remote.items.at(-1)?.id).toBe('a');
    expect(f.remote.threadReady).toBe(false);
    const historyReads = () => fetcher.mock.calls.filter(([path]) => /\/thread\/(?:open|timings)\?/.test(String(path))).length;
    const reads = historyReads();
    finishTimings(await json(page)); await settle();
    expect(f.remote.threadReady).toBe(true);
    expect(resumes).toHaveLength(1);
    expect(historyReads()).toBe(reads);
  });
  it('does not repeatedly resume a writer conflict, and leaves archiving on the native transport', async () => {
    const f = fixture(path => /\/thread\/(?:open|timings)\?/.test(String(path)) ? json(page)
      : String(path).includes('/api/threads?') ? json({ data: [], nextCursor: null }) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    const methods: string[] = [];
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      methods.push(message.method);
      connection.options.onMessage(message.method === 'thread/resume'
        ? { type: 'rpc.error', id: message.id,
          error: { message: 'thread-store conflict: thread synthetic already has an active writer' } }
        : { type: 'rpc.result', id: message.id, result: { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000); await settle();
    expect(methods.filter(method => method === 'thread/resume')).toHaveLength(1);
    expect(f.remote.threadReady).toBe(false);
    expect(f.remote.lastError).toContain('active writer');
    await f.remote.archiveThread(thread.id, true); await settle();
    expect(methods.filter(method => method === 'thread/archive')).toHaveLength(1);
    expect(methods).not.toContain('turn/start');
  });
  it('retries an exhausted native resume when the user selects the same chat again', async () => {
    const f = fixture(path => /\/thread\/(?:open|timings)\?/.test(String(path)) ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    let fail = true;
    let resumes = 0;
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'thread/resume') {
        resumes++;
        if (fail) {
          connection.options.onMessage({ type: 'rpc.error', id: message.id,
            error: { message: 'Resume unavailable' } });
          return;
        }
      }
      connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    await vi.advanceTimersByTimeAsync(500); await settle();
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(resumes).toBe(3);
    expect(f.remote.threadReady).toBe(false);
    fail = false;
    await f.remote.openThread(thread.id); await settle(); await settle();
    expect(resumes).toBe(4);
    expect(f.remote.threadReady).toBe(true);
  });
  it.each([false, true])('keeps fresh metadata after an earlier resume snapshot (live update: %s)', async liveUpdate => {
    const pending: ((value: Response) => void)[] = [];
    const f = fixture(path => String(path).includes('/thread/open?')
      ? new Promise(resolve => pending.push(resolve))
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    const opening = f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread: { ...thread, model: 'old-model' } } : { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    pending.shift()!(await json(page)); await settle();
    if (liveUpdate) {
      connection.options.onMessage({ type: 'event', method: 'thread/settings/updated',
        params: { threadId: thread.id, threadSettings: { model: 'new-model' } } });
      scope.render();
    }
    pending.shift()!(await json({ ...page, result: { thread: { ...thread, model: liveUpdate ? 'old-model' : 'new-model' } } }));
    await opening; await settle();
    expect(f.remote.activeThread?.model).toBe('new-model');
    expect(f.remote.threadReady).toBe(true);
  });
  it('does not rewind a native settings event when an older resume response arrives later', async () => {
    let reads = 0;
    let finishHistory!: (response: Response) => void;
    const f = fixture(path => String(path).includes('/thread/open?')
      ? ++reads === 1 ? json(page) : new Promise(resolve => { finishHistory = resolve; })
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    let finishResume!: () => void;
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'rpc') return;
      if (message.method === 'thread/resume') finishResume = () =>
        connection.options.onMessage({ type: 'rpc.result', id: message.id,
          result: { thread: { ...thread, model: 'old-model' } } });
      else connection.options.onMessage({ type: 'rpc.result', id: message.id, result: { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    connection.options.onMessage({ type: 'event', method: 'thread/settings/updated',
      params: { threadId: thread.id, threadSettings: { model: 'new-model' } } });
    scope.render();
    expect(f.remote.activeThread?.model).toBe('new-model');
    finishResume(); await settle();
    expect(f.remote.activeThread?.model).toBe('new-model');
    finishHistory(await json({ ...page, result: { thread: { ...thread, model: 'new-model' } } }));
    await settle();
    expect(f.remote.activeThread?.model).toBe('new-model');
  });
  it('lets a newer native reasoning event win over an older settings acknowledgement and preserves null as inherit', async () => {
    const f = fixture(path => String(path).includes('/thread/open?') ? json(page)
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    let finish!: () => void;
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc' && message.method === 'thread/settings/update') {
        finish = () => connection.options.onMessage({
          type: 'rpc.result', id: message.id, result: { threadSettings: { effort: 'low' } }
        });
      }
    } });
    const pending = f.remote.setThreadSettings(thread.id, { effort: 'low' });
    await settle();
    connection.options.onMessage({ type: 'event', method: 'thread/settings/updated',
      params: { threadId: thread.id, threadSettings: { effort: 'high' } } });
    scope.render();
    expect(f.remote.activeThread?.reasoningEffort).toBe('high');
    finish(); await pending; await settle();
    expect(f.remote.activeThread?.reasoningEffort).toBe('high');

    connection.options.onMessage({ type: 'event', method: 'thread/settings/updated',
      params: { threadId: thread.id, threadSettings: { effort: null } } });
    scope.render();
    expect(f.remote.activeThread?.reasoningEffort).toBeNull();
  });
  it.each(['text', 'timings'])('does not authorize actions after a second stale %s response', async stale => {
    const f = fixture(path => String(path).includes('/thread/open?') ? json({
      ...page, ...(stale === 'text' ? { snapshot: { stale: true, savedAt: 1 } } : {})
    }) : String(path).includes('/thread/timings?') ? json({
      ...page, ...(stale === 'timings' ? { snapshot: { stale: true, savedAt: 1 } } : {})
    }) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    expect(f.remote.historySnapshot).toBe('failed');
    expect(f.remote.threadReady).toBe(false);
    expect(f.remote.loadingThread).toBe(false);
    expect(f.remote.items.length).toBeGreaterThan(0);
  });
  it('keeps text readable after failed timings and retries the same chat without trusting missing native state', async () => {
    let timingsFail = true;
    const f = fixture(path => String(path).includes('/thread/open?') ? json(page)
      : String(path).includes('/thread/timings?') ? timingsFail
        ? Promise.resolve({ ok: false, status: 404, text: async () => '{"error":"Timings unavailable"}' } as Response)
        : json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    expect(f.remote.loadingThread).toBe(false);
    expect(f.remote.items.at(-1)?.id).toBe('a');
    expect(f.remote.threadReady).toBe(false);
    expect(f.remote.lastError).toBe('Timings unavailable');
    timingsFail = false;
    await f.remote.openThread(thread.id); await settle();
    expect(f.remote.items.at(-1)?.id).toBe('a');
    expect(f.remote.threadReady).toBe(true);
    expect(f.remote.lastError).toBeNull();
  });
  it('keeps a second stale native response marked incomplete', async () => {
    const fetcher = vi.fn<typeof fetch>(path => String(path).includes('/thread/open?')
      ? json({ ...page, snapshot: { stale: true, savedAt: 1 } }) : new Promise(() => {}));
    const f = fixture(fetcher);
    await f.remote.openThread(thread.id); await settle();
    expect(fetcher.mock.calls.filter(([path]) => String(path).includes('/thread/open?'))).toHaveLength(2);
    expect(f.remote.historySnapshot).toBe('failed');
  });
  it('does not flash a stale host response while its replacement is still downloading', async () => {
    let reads = 0, finish!: (value: Response) => void;
    const f = fixture(path => String(path).includes('/thread/open?')
      ? ++reads === 1 ? json({ ...page, snapshot: { stale: true, savedAt: 1 } })
        : new Promise(resolve => { finish = resolve; }) : new Promise(() => {}));
    const opening = f.remote.openThread(thread.id);
    await settle();
    expect(reads).toBe(2);
    expect(f.remote.items).toEqual([]);
    expect(f.remote.loadingThread).toBe(true);
    finish(await json(page)); await opening; await settle();
    expect(f.remote.items.at(-1)?.id).toBe('a');
  });
  it('rechecks history after the native subscription attaches', async () => {
    let reads = 0;
    const f = fixture(path => String(path).includes('/thread/open?')
      ? json({ ...page, items: [...page.items, ...(++reads > 1 ? [{ turnId: 'new',
        item: { type: 'agentMessage', id: 'new-answer', text: 'Subscribed answer' } }] : [])] })
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    expect(reads).toBe(2);
    expect(f.remote.items.at(-1)?.id).toBe('new-answer');
  });
  it('runs one trailing reconciliation when completions arrive during an existing refresh', async () => {
    let reads = 0, finish!: (value: Response) => void;
    const f = fixture(path => String(path).includes('/thread/open?')
      ? ++reads === 2 ? new Promise(resolve => { finish = resolve; })
        : json({ ...page, items: [...page.items, ...(reads > 2 ? [{ turnId: 'latest',
          item: { type: 'agentMessage', id: 'last-answer', text: 'Last answer' } }] : [])] })
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    const completion = () => connection.options.onMessage({ type: 'event', method: 'turn/completed',
      params: { threadId: thread.id } });
    completion(); await settle();
    completion(); completion(); await settle();
    expect(reads).toBe(2);
    finish(await json(page)); await settle(); await settle();
    expect(reads).toBe(3);
    expect(f.remote.items.at(-1)?.id).toBe('last-answer');
  });
  it('does not publish a pre-subscription initial page through a concurrent completion refresh', async () => {
    const pending: ((response: Response) => void)[] = [];
    const f = fixture(path => String(path).includes('/thread/open?')
      ? new Promise(resolve => pending.push(resolve))
      : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    const opening = f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle();
    connection.options.onMessage({ type: 'event', method: 'turn/completed', params: { threadId: thread.id } });
    await settle();
    pending.shift()!(await json(page)); await settle();
    const prematurelyPublished = f.remote.items;
    const latest = { ...page, items: [...page.items, { turnId: 'latest',
      item: { type: 'agentMessage' as const, id: 'latest-answer', text: 'Latest native answer' } }] };
    pending.shift()!(await json(latest)); await opening; await settle(); await settle();
    // A completion queued during the initial read gets a fresh, serialized tail.
    while (pending.length) { pending.shift()!(await json(latest)); await settle(); }
    expect(prematurelyPublished).toEqual([]);
    expect(f.remote.items.at(-1)?.id).toBe('latest-answer');
  });
  it('does not let a stale completion refresh clear a newer live turn missing from native history', async () => {
    const f = fixture(path => /\/thread\/(?:open|timings)\?/.test(String(path)) ? json(page) : new Promise(() => {}));
    await f.remote.openThread(thread.id); await settle();
    connection.options.onMessage({ type: 'event', method: 'turn/started',
      params: { threadId: thread.id, turn: { id: 'new-live', status: 'inProgress', startedAt: 20 } } });
    scope.render();
    connection.options.onMessage({ type: 'event', method: 'turn/completed',
      params: { threadId: thread.id, turn: timing } });
    await settle(); await settle();
    expect(f.remote.activeTurnId).toBe('new-live');
    expect(f.remote.turnTimings['new-live']?.status).toBe('inProgress');
  });
  it('refreshes the selected tail on foreground return without restarting task pagination', async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(path => String(path).includes('/thread/open?')
      ? (reads++, json(page)) : String(path).includes('/thread/timings?') ? json(page) : new Promise(() => {}));
    const f = fixture(fetcher);
    await f.remote.openThread(thread.id); await settle();
    connection.options.onSocket({ readyState: 1, send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === 'rpc') connection.options.onMessage({ type: 'rpc.result', id: message.id,
        result: message.method === 'thread/resume' ? { thread } : { data: [] } });
    } });
    synchronizeConnection();
    await settle(); await settle();
    const baseline = reads;
    await vi.advanceTimersByTimeAsync(16_000);
    window.dispatchEvent(new Event('focus')); await settle();
    expect(reads).toBe(baseline + 1);
    window.dispatchEvent(new Event('focus')); await settle();
    expect(reads).toBe(baseline + 1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).startsWith('/api/threads?'))).toHaveLength(0);
  });
});

describe('subagent native history verification', () => {
  const child = { threadId: 'synthetic-child', name: 'Child', status: 'completed' as const };
  const timing = { id: 't', status: 'failed' as const, startedAt: 1, completedAt: 2, durationMs: 1000,
    error: { message: 'Native child error' } };
  const page = (text: string) => ({ result: { thread: { ...thread, id: child.threadId, status: { type: 'idle' } } },
    items: [{ turnId: 't', item: { type: 'agentMessage', id: 'a', text } }],
    nextCursor: 'older', turns: [], turnsCursor: null, activeTurnId: null, timingsPending: true });
  const timingPage = { turns: [timing], turnsCursor: 'older-timings', activeTurnId: null };
  function childFixture(fetcher: typeof fetch) {
    vi.useFakeTimers(); vi.stubGlobal('fetch', fetcher);
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    const transport = {
      rpc: vi.fn(async () => ({ data: [], nextCursor: null })),
      subscribe: (listener: (method: string, params: Record<string, unknown>) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      }, watch: vi.fn()
    } as unknown as ChatTransport;
    let chats!: SubagentChatsController;
    scope = new hooks.Scope(); scope.root = () => { chats = useSubagentChats(transport, true, thread.id); };
    scope.render();
    return { get chats() { return chats; },
      emit(method: string, params: Record<string, unknown>) { listeners.forEach(listener => listener(method, params)); } };
  }
  it('revalidates stale child text and timings without replacing native timing metadata with the text-only page', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(path => {
      const url = String(path);
      if (url.includes('/timings?')) return json({ ...timingPage, snapshot: { stale: !url.includes('fresh=1'), savedAt: 1 } });
      if (url.includes('fresh=1')) return new Promise(resolve => { finish = resolve; });
      return json({ ...page('Old cache'), snapshot: { stale: true, savedAt: 1 } });
    });
    const f = childFixture(fetcher);
    f.chats.open(child); await settle();
    expect(f.chats.chats[0]?.loading).toBe(true);
    expect(f.chats.chats[0]?.items).toEqual([]);
    expect(f.chats.chats[0]?.timings.t?.error?.message).toBe('Native child error');
    finish(await json(page('Native answer'))); await settle();
    expect(f.chats.chats[0]).toMatchObject({ loading: false, turnsCursor: 'older-timings', timingsLoaded: true });
    expect(f.chats.chats[0]?.items[0]).toMatchObject({ text: 'Native answer' });
    const paths = fetcher.mock.calls.map(([path]) => String(path));
    expect(paths.some(path => path.includes('/open?') && path.includes('fresh=1'))).toBe(true);
    expect(paths.some(path => path.includes('/timings?') && path.includes('fresh=1'))).toBe(true);
  });
  it('preserves a newer native child turn while an older timing read finishes', async () => {
    let finish!: (response: Response) => void;
    const f = childFixture(path => String(path).includes('/timings?')
      ? new Promise(resolve => { finish = resolve; }) : json(page('Native answer')));
    f.chats.open(child); await settle();
    expect(f.chats.chats[0]?.loading).toBe(false);
    f.emit('turn/started', { threadId: child.threadId, turn: { id: 'new', status: 'inProgress', startedAt: 5 } });
    await vi.advanceTimersByTimeAsync(60); await settle();
    finish(await json(timingPage)); await settle();
    expect(f.chats.chats[0]?.activeTurnId).toBe('new');
    expect(f.chats.chats[0]?.timings.new?.status).toBe('inProgress');
    expect(f.chats.chats[0]?.timings.t?.error?.message).toBe('Native child error');
  });
  it('recovers timing metadata if older paging interrupts the initial timing read', async () => {
    const fetcher = vi.fn<typeof fetch>((path, options) => {
      const url = String(path);
      if (url.includes('/timings?')) {
        if (url.includes('fresh=1')) return json({ ...timingPage, activeTurnId: 'live',
          turns: [...timingPage.turns, { id: 'live', status: 'inProgress', startedAt: 5 }] });
        return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)));
      }
      if (url.includes('/history?')) return json({ items: [{ turnId: 't',
        item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] } }],
        nextCursor: null, turns: [], turnsCursor: null, activeTurnId: null });
      return json(page('Native answer'));
    });
    const f = childFixture(fetcher); f.chats.open(child); await settle();
    expect(f.chats.chats[0]?.timingsLoaded).toBe(false);
    await f.chats.load(child.threadId, true); await settle();
    expect(f.chats.chats[0]?.items.map(item => item.id)).toEqual(['u', 'a']);
    expect(f.chats.chats[0]).toMatchObject({ timingsLoaded: true, turnsCursor: 'older-timings', cursor: null, activeTurnId: 'live' });
    expect(f.chats.chats[0]?.timings.t?.error?.message).toBe('Native child error');
  });
});

describe('on-demand execution bodies', () => {
  it('loads only opened details, reuses full output and cancels abandoned item reads', async () => {
    let summary: ThreadItem = { type: 'commandExecution', id: 'cmd', turnId: 't', command: 'preview', cwd: '/',
      status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 1, detailsDeferred: true };
    let opened = false;
    let detail!: ReturnType<typeof useHistoryDetails>;
    let finish!: (value: Response) => void;
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_path, options) => new Promise(resolve => {
      finish = resolve; signals.push(options!.signal!);
    }));
    vi.stubGlobal('fetch', fetcher);
    scope = new hooks.Scope(); scope.root = () => { detail = useHistoryDetails(summary, opened); };
    scope.render(); expect(fetcher).not.toHaveBeenCalled();
    opened = true; scope.dirty = true; scope.render();
    expect(detail.loading).toBe(true);
    const full = { ...summary, command: 'echo full command', aggregatedOutput: 'full output', detailsDeferred: false };
    finish(await json({ data: [{ turnId: 't', item: full }] })); await settle();
    expect(detail.item).toMatchObject({ command: 'echo full command', aggregatedOutput: 'full output' });
    expect(detail.loading).toBe(false);
    opened = false; scope.dirty = true; scope.render();
    opened = true; scope.dirty = true; scope.render();
    expect(fetcher).toHaveBeenCalledOnce();
    summary = { ...summary, id: 'second' }; scope.dirty = true; scope.render();
    expect(fetcher).toHaveBeenCalledTimes(2);
    opened = false; scope.dirty = true; scope.render();
    expect(signals[1]?.aborted).toBe(true);
    finish(await json({ data: [{ turnId: 't', item: { ...full, id: 'second' } }] })); await settle();
    expect(detail.item.id).toBe('second');
    expect(detail.item.detailsDeferred).toBe(true); // A closed/abandoned request cannot apply later.
  });
  it('surfaces missing/mismatched native records and retries without losing the row', async () => {
    const summary: ThreadItem = { type: 'dynamicToolCall', id: 'tool', turnId: 't', tool: 'example',
      arguments: null, contentItems: null, status: 'completed', detailsDeferred: true };
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => json({ data: [{ turnId: 'other', item: summary }] }))
      .mockImplementationOnce(() => json({ data: [{ turnId: 't', item: { ...summary, detailsDeferred: false, contentItems: ['full'] } }] }));
    vi.stubGlobal('fetch', fetcher);
    let detail!: ReturnType<typeof useHistoryDetails>;
    scope = new hooks.Scope(); scope.root = () => { detail = useHistoryDetails(summary, true); };
    scope.render(); await settle();
    expect(detail.error).toBeTruthy();
    expect(detail.item).toBe(summary);
    detail.retry(); scope.render(); await settle();
    expect(detail.error).toBeNull();
    expect(detail.item).toMatchObject({ contentItems: ['full'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retain an old read error after full live output replaces its summary', async () => {
    let summary: ThreadItem = { type: 'dynamicToolCall', id: 'tool', turnId: 't', tool: 'example',
      arguments: null, contentItems: null, status: 'completed', detailsDeferred: true };
    vi.stubGlobal('fetch', () => json({ data: [] }));
    let detail!: ReturnType<typeof useHistoryDetails>;
    scope = new hooks.Scope(); scope.root = () => { detail = useHistoryDetails(summary, true); };
    scope.render(); await settle();
    expect(detail.error).toBeTruthy();
    summary = { ...summary, detailsDeferred: false, contentItems: ['live output'] };
    scope.dirty = true; scope.render();
    expect(detail.error).toBeNull();
    expect(detail.loading).toBe(false);
    expect(detail.item).toBe(summary);
  });
  it('scopes loaded details and failures to the owning conversation', async () => {
    const summary: ThreadItem = { type: 'commandExecution', id: 'cmd', turnId: 't', command: 'preview', cwd: '/',
      status: 'completed', aggregatedOutput: null, exitCode: 0, durationMs: 1, detailsDeferred: true };
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => json({ data: [
      { turnId: 't', item: { ...summary, aggregatedOutput: 'first chat output' } }
    ] })).mockImplementationOnce(() => json({ data: [] }))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetcher);
    let detail!: ReturnType<typeof useHistoryDetails>;
    scope = new hooks.Scope(); scope.root = () => { detail = useHistoryDetails(summary, true); };
    scope.render(); await settle();
    expect(detail.item).toMatchObject({ aggregatedOutput: 'first chat output' });
    hooks.threadId = 'second-chat'; scope.dirty = true; scope.render();
    expect(detail.item).toBe(summary);
    await settle();
    expect(detail.error).toBeTruthy();
    hooks.threadId = 'third-chat'; scope.dirty = true; scope.render();
    expect(detail.error).toBeNull();
    expect(detail.loading).toBe(true);
    expect(fetcher.mock.calls.map(([path]) => new URL(String(path), 'http://localhost').searchParams.get('threadId')))
      .toEqual(['synthetic-chat', 'second-chat', 'third-chat']);
  });
});


describe('new native question arrivals', () => {
  it('keeps late native items in their owning turn without clearing the newer active turn', async () => {
    const f = fixture(() => new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    const emit = async (method: string, params: Record<string, unknown>) => {
      connection.options.onMessage({ type: 'event', method, params: { threadId: thread.id, ...params } });
      await settle();
    };
    await emit('turn/started', { turn: { id: 'old', status: 'inProgress', startedAt: 100 } });
    await emit('item/completed', { turnId: 'old',
      item: { type: 'agentMessage', id: 'old-answer', text: 'Earlier' } });
    await emit('turn/started', { turn: { id: 'new', status: 'inProgress', startedAt: 8000 } });
    await emit('item/completed', { turnId: 'new',
      item: { type: 'userMessage', id: 'new-user', content: [] } });
    await emit('item/completed', { turnId: 'old',
      item: { type: 'agentMessage', id: 'late', text: 'Delayed' } });
    await emit('turn/completed', { turn: { id: 'old', status: 'completed', startedAt: 100,
      completedAt: 7293, durationMs: 7_193_000, items: [] } });
    expect(f.remote.activeTurnId).toBe('new');
    expect(f.remote.items.map(item => item.id)).toEqual(['old-answer', 'late', 'new-user']);
    await emit('item/agentMessage/delta', { turnId: 'old', itemId: 'delta', delta: 'Delayed delta' });
    await vi.advanceTimersByTimeAsync(80); await settle();
    expect(f.remote.items.map(item => item.id)).toEqual(['old-answer', 'late', 'delta', 'new-user']);
    expect(f.remote.turnTimings.old).toMatchObject({ startedAt: 100, durationMs: 7_193_000 });
  });
  it('maps native runtime errors to the selected turn, clears recovered retries and retains final failures', async () => {
    const f = fixture(() => new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    const emit = async (method: string, params: Record<string, unknown>) => {
      connection.options.onMessage({ type: 'event', method, params });
      await settle();
    };
    await emit('turn/started', { threadId: thread.id, turn: { id: 't', status: 'inProgress' } });
    await emit('error', { threadId: 'other', turnId: 't', willRetry: true, error: { message: 'Other error' } });
    expect(f.remote.turnTimings.t?.error).toBeUndefined();
    await emit('error', { threadId: thread.id, turnId: 't', willRetry: true,
      error: { message: 'Native retry', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } } });
    expect(f.remote.activeTurnId).toBe('t');
    expect(f.remote.turnTimings.t).toMatchObject({ errorWillRetry: true, error: { message: 'Native retry' } });
    await emit('item/agentMessage/delta', { threadId: thread.id, turnId: 't', itemId: 'a', delta: 'Recovered' });
    expect(f.remote.turnTimings.t?.error).toBeUndefined();
    await emit('turn/completed', { threadId: thread.id, turn: { id: 't', status: 'failed',
      error: { message: 'Native final', codexErrorInfo: 'usageLimitExceeded' } } });
    expect(f.remote.activeTurnId).toBeNull();
    expect(f.remote.turnTimings.t?.error?.message).toBe('Native final');
  });
  it.each(['turn/started', 'turn/completed'])('shows questions embedded in %s immediately without a history refresh', async method => {
    const f = fixture(() => new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    const item: ThreadItem = { type: 'agentMessage', id: 'synthetic-question', text: '', delivery: 'async',
      questions: [{ title: 'Choose?', options: ['A', 'B'] }] };
    connection.options.onMessage({ type: 'event', method, params: { threadId: thread.id,
      turn: { id: 'question-turn', status: method === 'turn/started' ? 'inProgress' : 'completed', items: [item] } } });
    await settle();
    const groups = pendingQuestionGroups(f.remote.items);
    console.info('[question-event-diagnostic]', { method, sourceId: item.id, sourceQuestions: item.questions?.length,
      receivedItems: f.remote.items.length, renderedQuestionIds: groups.flatMap(group => group.questions.map(q => q.id)) });
    expect(groups.flatMap(group => group.questions.map(q => q.id))).toEqual([questionItemId(item.id, 0)]);
    expect(f.questions?.props['aria-label']).toBe('Codex 等待你的回答');
    expect(f.remote.turnTimings['question-turn']).not.toHaveProperty('items');
  });
});


describe('question state synchronization', () => {
  const question: ThreadItem = { type: 'agentMessage', id: 'new-question', text: '', delivery: 'async',
    questions: [{ title: 'Choose?', options: ['A', 'B'] }] };
  it('renders a fresh item question even before its turn-start event arrives', async () => {
    const f = fixture(() => new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    connection.options.onMessage({ type: 'event', method: 'turn/started', params: { threadId: thread.id,
      turn: { id: 'old-turn', status: 'inProgress', items: [] } } }); await settle();
    connection.options.onMessage({ type: 'event', method: 'item/completed', params: { threadId: thread.id,
      turnId: 'new-turn', item: question } }); await settle();
    expect(f.remote.activeTurnId).toBe('old-turn');
    expect(f.questions).not.toBeNull();
    connection.options.onMessage({ type: 'event', method: 'turn/started', params: { threadId: thread.id,
      turn: { id: 'goal-next-turn', status: 'inProgress', items: [] } } }); await settle();
    expect(f.questions).not.toBeNull();
  });
  it('receives an unselected chat badge and replaces it on reconnect without loading its history', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const f = fixture(fetcher);
    connection.options.onMessage({ type: 'questions.snapshot', counts: { other: 2, invalid: -1, fraction: 1.5 } });
    await settle();
    expect(f.remote.questionCounts).toEqual({ other: 2 });
    expect(f.remote.items).toEqual([]);
    expect(fetcher.mock.calls.some(([path]) => String(path).includes('/thread/open'))).toBe(false);
    connection.options.onMessage({ type: 'questions.snapshot', counts: {} }); await settle();
    expect(f.remote.questionCounts).toEqual({});
  });
  it('does not inject window-external live questions while reading older history', async () => {
    const f = fixture(path => String(path).includes('/around?') ? json({ items: [{ turnId: 'old-turn',
      item: { type: 'userMessage', id: 'old-user', content: [{ type: 'text', text: 'Old context' }] } }],
      nextCursor: 'older', newerCursor: 'newer' }) : new Promise(() => {}));
    void f.remote.openThread(thread.id).catch(() => {}); await settle();
    expect(await f.remote.revealHistory('old-turn', 'old-user')).toBe(true); await settle();
    connection.options.onMessage({ type: 'event', method: 'turn/started', params: { threadId: thread.id,
      turn: { id: 'new-turn', status: 'inProgress', items: [question] } } }); await settle();
    expect(f.remote.viewingHistory).toBe(true);
    expect(f.remote.items.map(item => item.id)).toEqual(['old-user']);
  });
});
