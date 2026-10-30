import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import webPush from 'web-push';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionTracker } from './question-tracker.js';
import { questionItemId, serializeQuestionReplies } from '../shared/async-user-input.js';
import { PushNotifications } from './push-notifications.js';

const directories: string[] = [];
const servers: http.Server[] = [];
const sent = { statusCode: 201, body: '', headers: {} };

function create() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-push-'));
  directories.push(directory);
  return { directory, notifications: new PushNotifications(directory, 'https://remote.example.test') };
}

function subscription(id = 'device') {
  return {
    endpoint: `https://push.example.test/${id}`,
    keys: {
      p256dh: webPush.generateVAPIDKeys().publicKey,
      auth: Buffer.alloc(16, 1).toString('base64url')
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('private standard Web Push subscriptions', () => {
  it('persists stable VAPID keys, subscriptions and ordinary-chat scope across restarts', async () => {
    const generate = vi.spyOn(webPush, 'generateVAPIDKeys');
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { directory, notifications } = create();
    const device = subscription();
    const generations = generate.mock.calls.length;
    expect(notifications.subscribe(device)).toBe(true);
    notifications.watch('ordinary-chat');
    const restarted = new PushNotifications(directory, 'https://remote.example.test');
    expect(generate).toHaveBeenCalledTimes(generations);
    expect(restarted.publicKey).toBe(notifications.publicKey);
    expect(restarted.status(device.endpoint)).toBe(true);
    await restarted.notifyTurn({ threadId: 'ordinary-chat', turn: { id: 'turn', status: 'completed' } });
    expect(send).toHaveBeenCalledOnce();
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'web-push.json'), 'utf8'));
    expect(persisted.keys.publicKey).toBe(notifications.publicKey);
    expect(persisted.keys.privateKey).toBeTruthy();
    expect(persisted.subscriptions).toEqual([device]);
    expect(persisted.watchedThreads).toEqual(['ordinary-chat']);
    restarted.unsubscribe(device.endpoint);
    expect(new PushNotifications(directory, 'https://remote.example.test').status(device.endpoint)).toBe(false);
  });

  it('includes the conversation name and the current reply preview in completion notifications', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create();
    const device = subscription();
    notifications.subscribe(device);
    notifications.watch('chat/with space');
    await notifications.notifyTurn({
      threadId: 'chat/with space',
      thread: { name: '实现登录流程' },
      turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: '已完成登录流程，并更新了相关测试。' }] }
    });
    await notifications.notifyApproval({
      threadId: 'chat/with space', command: 'PRIVATE_COMMAND', requestId: 'request'
    });
    expect(send).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(send.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({
      title: '实现登录流程', body: '任务已完成：已完成登录流程，并更新了相关测试。',
      threadId: 'chat/with space', url: '/?thread=chat%2Fwith%20space'
    });
    expect(send.mock.calls[0]![2]).toMatchObject({
      TTL: 300, timeout: 8000, urgency: 'high', contentEncoding: 'aes128gcm',
      vapidDetails: { publicKey: notifications.publicKey, subject: 'https://remote.example.test' }
    });
  });

  it('falls back to the native thread title and truncates long replies by Unicode characters', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const readThread = vi.fn(async () => ({ thread: { name: '来自桌面的任务' } }));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-push-'));
    directories.push(directory);
    const notifications = new PushNotifications(directory, 'https://remote.example.test', readThread);
    const device = subscription();
    notifications.subscribe(device);
    notifications.watch('native-title');
    const reply = `${'a'.repeat(100)}结尾不应出现`;
    await notifications.notifyTurn({
      threadId: 'native-title', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: reply }] }
    });
    const payload = JSON.parse(send.mock.calls[0]![1] as string);
    expect(payload.title).toBe('来自桌面的任务');
    expect(payload.body).toBe(`任务已完成：${'a'.repeat(100)}…`);
    expect(readThread).toHaveBeenCalledWith('native-title');
  });

  it('ignores unwatched side/subagent chats and unfinished turns', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create();
    notifications.subscribe(subscription());
    notifications.watch('main');
    await notifications.notifyTurn({ threadId: 'ephemeral', turn: { id: 'turn', status: 'completed' } });
    await notifications.notifyTurn({ threadId: 'child', turn: { id: 'turn', status: 'completed' } });
    await notifications.notifyApproval({ threadId: 'child' });
    await notifications.notifyTurn({ threadId: 'main', turn: { id: 'turn', status: 'inProgress' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not read title metadata when no devices are subscribed', async () => {
    const { directory } = create();
    const readThread = vi.fn();
    const notifications = new PushNotifications(directory, 'https://remote.example.test', readThread);
    notifications.watch('main');
    await notifications.notifyTurn({ threadId: 'main', turn: { id: 'turn', status: 'completed' } });
    await notifications.notifyApproval({ threadId: 'main' });
    expect(readThread).not.toHaveBeenCalled();
  });

  it('delivers with a default title after 1.5 seconds even when native metadata hangs', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { directory } = create();
    let rejectRead!: (error: Error) => void;
    const readThread = vi.fn(() => new Promise((_, reject) => { rejectRead = reject; }));
    const notifications = new PushNotifications(directory, 'https://remote.example.test', readThread);
    notifications.subscribe(subscription());
    notifications.watch('main');
    const pending = notifications.notifyTurn({
      threadId: 'main', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Ready' }] }
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(JSON.parse(send.mock.calls[0]![1] as string)).toMatchObject({ title: 'Codex', body: '任务已完成：Ready' });
    rejectRead(new Error('Late native failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers final replies and excludes commentary and tool bodies from the reply preview', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create();
    notifications.subscribe(subscription());
    notifications.watch('main');
    await notifications.notifyTurn({
      threadId: 'main', thread: { name: 'Task' }, turn: { id: 'turn', status: 'completed', items: [
        { type: 'agentMessage', phase: 'final_answer', text: 'Done' },
        { type: 'agentMessage', phase: 'commentary', text: 'PRIVATE_COMMENTARY' },
        { type: 'commandExecution', text: 'PRIVATE_COMMAND' }
      ] }
    });
    expect(JSON.parse(send.mock.calls[0]![1] as string).body).toBe('任务已完成：Done');
    await notifications.notifyTurn({
      threadId: 'main', thread: { name: 'Task' },
      turn: { id: 'turn-2', status: 'completed', items: [{ type: 'agentMessage', phase: 'commentary', text: 'PRIVATE_COMMENTARY' }] }
    });
    expect(JSON.parse(send.mock.calls[1]![1] as string).body).toBe('任务已完成');
  });

  it('retries transient background delivery without any browser connection', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(webPush, 'sendNotification')
      .mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValue(sent);
    const { notifications } = create();
    notifications.subscribe(subscription());
    notifications.watch('main');
    const delivery = notifications.notifyTurn({ threadId: 'main', turn: { id: 'turn', status: 'completed' } });
    await vi.advanceTimersByTimeAsync(1000);
    await delivery;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toBe(send.mock.calls[1]![1]);
  });

  it('bounds retries and stops if the device unsubscribes during a retry wait', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(webPush, 'sendNotification').mockRejectedValue({ statusCode: 503 });
    const { notifications } = create();
    const device = subscription();
    notifications.subscribe(device);
    notifications.watch('main');
    const params = { threadId: 'main', turn: { id: 'turn', status: 'completed' } };
    const failed = notifications.notifyTurn(params);
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(send).toHaveBeenCalledTimes(3);
    const cancelled = notifications.notifyTurn(params);
    await vi.advanceTimersByTimeAsync(0);
    notifications.unsubscribe(device.endpoint);
    await vi.advanceTimersByTimeAsync(1000);
    await cancelled;
    expect(send).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([404, 410])('removes expired push endpoints after HTTP %s without rejecting the native event', async statusCode => {
    const send = vi.spyOn(webPush, 'sendNotification').mockRejectedValue({ statusCode });
    const { notifications, directory } = create();
    const device = subscription();
    notifications.subscribe(device);
    notifications.watch('main');
    await expect(notifications.notifyTurn({ threadId: 'main', turn: { id: 'turn', status: 'completed' } }))
      .resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(notifications.status(device.endpoint)).toBe(false);
    expect(new PushNotifications(directory, 'https://remote.example.test').status(device.endpoint)).toBe(false);
  });

  it('keeps transient failures subscribed and bounds a hung sender to eight seconds', async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(webPush, 'sendNotification').mockRejectedValueOnce(new Error('Offline'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { notifications } = create();
    const device = subscription();
    notifications.subscribe(device);
    expect(await notifications.test(device.endpoint)).toBe('failed');
    expect(notifications.status(device.endpoint)).toBe(true);
    let settled = false;
    const pending = notifications.test(device.endpoint).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('failed');
    expect(send).toHaveBeenCalledTimes(2);
    expect(notifications.status(device.endpoint)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed subscriptions without storing arbitrary request fields', () => {
    const { notifications } = create();
    const device = subscription();
    expect(notifications.subscribe({ ...device, endpoint: 'http://push.example.test/device' })).toBe(false);
    expect(notifications.subscribe({ ...device, keys: { p256dh: 'bad', auth: 'bad' } })).toBe(false);
    expect(notifications.subscribe(null)).toBe(false);
    expect(notifications.subscribe({ ...device, privateField: 'discard' })).toBe(true);
  });

  it('provides router contracts and tests only this device endpoint', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create();
    const app = express();
    app.use(express.json());
    app.use('/api/notifications', notifications.router());
    const server = http.createServer(app);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api/notifications`;
    // OS-assigned ports can be on Fetch's browser-only forbidden-port list.
    const request = (route: string, body?: unknown, method = 'GET') => new Promise<Response>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json',
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const post = (route: string, body: unknown, method = 'POST') => request(route, body, method);
    const key = await (await request('/public-key')).json();
    expect(key).toEqual({ publicKey: notifications.publicKey });
    expect(key).not.toHaveProperty('privateKey');
    const first = subscription('first');
    const second = subscription('second');
    expect((await post('/test', { endpoint: first.endpoint })).status).toBe(404);
    expect(await (await post('/status', { endpoint: first.endpoint })).json()).toEqual({ enabled: false });
    expect((await post('/subscription', { subscription: {} })).status).toBe(400);
    expect(await (await post('/subscription', { subscription: first })).json()).toEqual({ ok: true });
    await post('/subscription', { subscription: second });
    expect(await (await post('/status', { endpoint: first.endpoint })).json()).toEqual({ enabled: true });
    expect(await (await post('/test', { endpoint: first.endpoint })).json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].endpoint).toBe(first.endpoint);
    expect(await (await post('/subscription', { endpoint: first.endpoint }, 'DELETE')).json()).toEqual({ ok: true });
    expect(await (await post('/status', { endpoint: first.endpoint })).json()).toEqual({ enabled: false });
    expect(notifications.status(second.endpoint)).toBe(true);
  });
});


describe('pending question notifications', () => {
  const question = { type: 'agentMessage', id: 'call', delivery: 'async', text: 'PRIVATE_FALLBACK',
    questions: [{ title: '请选择方案', options: ['A', 'B'] }, { title: '补充说明', options: null }] };
  it('notifies once for a newly pending live question and not for duplicate item/turn events or history hydration', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create();
    notifications.subscribe(subscription()); notifications.watch('main');
    const tracker = new QuestionTracker();
    async function event(method: string, body: Record<string, unknown>) {
      const params = { threadId: 'main', thread: { name: '测试会话' }, ...body };
      const before = tracker.pendingIds('main');
      tracker.event(method, params);
      await notifications.notifyQuestions(params, [...tracker.pendingIds('main')].filter(id => !before.has(id)));
    }
    await event('item/started', { item: question });
    await event('item/completed', { item: question });
    await event('turn/completed', { turn: { items: [question] } });
    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(send.mock.calls[0]![1] as string);
    expect(payload).toMatchObject({ title: '测试会话', body: '需要你回答：请选择方案；补充说明',
      tag: 'codex-question-main', url: '/?thread=main' });
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_FALLBACK');
    const answer = { type: 'userMessage', content: [{ type: 'text', text: serializeQuestionReplies([0, 1].map(index =>
      ({ questionItemId: questionItemId('call', index), question: 'Synthetic', answer: 'A' }))) }] };
    await event('item/completed', { item: answer });
    tracker.ingest('main', [question]);
    await event('turn/completed', { turn: { items: [question] } });
    expect(send).toHaveBeenCalledOnce();
  });
  it('supports whole-turn arrivals, exact newly pending IDs, Unicode preview limits and blocking questions', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create(); notifications.subscribe(subscription()); notifications.watch('main');
    await notifications.notifyQuestions({ threadId: 'main', thread: { name: 'Task' }, turn: { items: [
      { ...question, questions: [{ title: 'OLD_QUESTION', options: null }, { title: '答'.repeat(101), options: null }] }
    ] } }, [questionItemId('call', 1)]);
    expect(JSON.parse(send.mock.calls[0]![1] as string).body).toBe(`需要你回答：${'答'.repeat(100)}…`);
    await notifications.notifyApproval({ threadId: 'main', thread: { name: 'Task' },
      questions: [{ id: 'q', question: '要继续吗？' }] }, 'item/tool/requestUserInput');
    expect(JSON.parse(send.mock.calls[1]![1] as string).body).toBe('需要你回答：要继续吗？');
  });
  it('skips absent subscriptions, unwatched chats, unrelated IDs and malformed items', async () => {
    const send = vi.spyOn(webPush, 'sendNotification').mockResolvedValue(sent);
    const { notifications } = create(); notifications.watch('main');
    await notifications.notifyQuestions({ threadId: 'main', item: question }, [questionItemId('call', 0)]);
    notifications.subscribe(subscription());
    await notifications.notifyQuestions({ threadId: 'child', item: question }, [questionItemId('call', 0)]);
    await notifications.notifyQuestions({ threadId: 'main', item: question }, ['unrelated']);
    await notifications.notifyQuestions({ threadId: 'main', turn: { items: [null, {}, { ...question, questions: [{}] }] } }, ['x']);
    expect(send).not.toHaveBeenCalled();
  });
});
