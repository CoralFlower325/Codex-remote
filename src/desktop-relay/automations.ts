import { newMessagePortRpcSession } from 'capnweb';
import { automationMethods, type AutomationMethod } from '../shared/automation-schedule';

interface NativeAutomations {
  list(): unknown;
  readHistory(input: unknown): unknown;
  create(input: unknown): unknown;
  update(input: unknown): unknown;
  delete(input: unknown): unknown;
  runNow(input: unknown): unknown;
}

declare global {
  interface Window {
    __codexRemoteAutomationRequest: (method: AutomationMethod, input?: unknown) => Promise<unknown>;
  }
}

window.__codexRemoteAutomationRequest = async (method, input) => {
  if (!automationMethods.includes(method)) throw new Error('Automation method is not allowed.');
  const { port1, port2 } = new MessageChannel();
  const host = newMessagePortRpcSession<{ services: { localAutomations: NativeAutomations | null } }>(port1);
  let disposeService = () => {};
  let finished = false;
  const reading = method === 'list' || method === 'readHistory';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    window.postMessage({ type: 'connect-app-host', port: port2 }, window.location.origin, [port2]);
    const result = await Promise.race([
      (async () => {
        const service = await host.services.localAutomations;
        if (!service) throw new Error('当前 Codex Desktop 未提供原生自动任务接口，请更新桌面端。');
        if (finished) { service[Symbol.dispose](); return; }
        disposeService = () => service[Symbol.dispose]();
        return method === 'list' ? await service.list() : await service[method](input);
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(reading
          ? '原生自动任务读取超时，请刷新重试。'
          : '原生自动任务请求超时。操作结果无法确认，请检查 Desktop 后再决定是否重试。')),
        reading ? 6000 : 110_000);
      })
    ]);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    finished = true;
    clearTimeout(timer);
    disposeService();
    host[Symbol.dispose]();
    port1.close();
  }
};
