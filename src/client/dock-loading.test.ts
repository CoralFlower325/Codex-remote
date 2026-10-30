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
  readDeviceWorkspace: async () => null, readDeviceChat: async () => null,
  saveDeviceWorkspace: async () => {}, saveDeviceChat: async () => {}, removeDeviceChat: async () => {}
}));
vi.mock('./background-work', () => ({
  prioritizeInteraction: () => {}, beginForegroundRead: () => () => {}, constrainedNetwork: () => false,
  yieldToInteraction: () => new Promise(() => {})
}));
import { useRemote } from './useRemote';
import { pendingQuestionGroups } from './async-questions';
import { useHistoryDetails } from './history-details';
import type { ThreadItem } from './types';
import { QuestionDock, QuestionCard } from './components/QuestionDock';
import { parseQuestionReplies, questionItemId } from '../shared/async-user-input';
import { historyConfig } from './history-config';
import { QueuedMessages } from './components/QueuedMessages';
import type { Thread, WorkspaceBootstrap } from './types';

let scope: InstanceType<typeof hooks.Scope>;
afterEach(() => { scope?.dispose(); hooks.threadId = 'synthetic-chat'; vi.useRealTimers(); vi.unstubAllGlobals(); });
const thread = { id: 'synthetic-chat', status: { type: 'active' }, updatedAt: 1 } as Thread;

async function settle() {
  for (let pass = 0; pass < 10; pass++) { await Promise.resolve(); scope.render(); }
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
  let remote!: ReturnType<typeof useRemote>;
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
  it('preselects the first option but waits for explicit submission, preserves multiline drafts on failure', async () => {
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
    expect(elements(card).find(node => node.props?.['aria-pressed'])?.props.children.props.children).toBe('A');
    const inputs = elements(card).filter(node => node.type === 'textarea');
    inputs[1]!.props.onChange({ target: { value: 'First line\nSecond line' } });
    scope.render();
    expect(onSubmit).not.toHaveBeenCalled(); // A newline in a free-text answer is never send.
    let button = elements(card).find(node => node.props?.className === 'primary-button');
    expect(button.props.disabled).toBe(false);
    button.props.onClick(); await settle();
    expect(onError).toHaveBeenCalledOnce();
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
