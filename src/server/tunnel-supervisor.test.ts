import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TunnelSupervisor, type TunnelChild } from './tunnel-supervisor.js';

describe('Tunnel recovery supervisor', () => {
  let supervisor: TunnelSupervisor;
  let done: Promise<void>;
  let children: (TunnelChild & { exit: () => void })[];
  let network: string;
  const start = vi.fn<() => Promise<TunnelChild>>();
  const ready = vi.fn<() => Promise<boolean>>();
  const egressReady = vi.fn<() => Promise<boolean>>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    children = [];
    network = 'wifi';
    start.mockReset().mockImplementation(async () => {
      let exit!: () => void;
      const exited = new Promise<void>(resolve => { exit = resolve; });
      const child = { exited, exit, stop: vi.fn(async () => exit()) };
      children.push(child);
      return child;
    });
    ready.mockReset().mockResolvedValue(true);
    egressReady.mockReset().mockResolvedValue(true);
    supervisor = new TunnelSupervisor({ start, ready, egressReady, network: () => network, log: vi.fn() });
    done = supervisor.run();
  });

  afterEach(async () => {
    supervisor.stop();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('keeps healthy HA connections across network and proxy events', async () => {
    await vi.advanceTimersByTimeAsync(2000);
    network = 'hotspot';
    supervisor.networkChanged();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledOnce();
    expect(children[0]!.stop).not.toHaveBeenCalled();
    expect(egressReady).not.toHaveBeenCalled();
  });

  it('relaunches an exited process after one second instead of a scheduler minute', async () => {
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(999);
    expect(start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a stuck tunnel after startup grace and outbound availability are confirmed', async () => {
    ready.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(21_999);
    expect(start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(children[0]!.stop).toHaveBeenCalledOnce();
    expect(egressReady).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('does not add a polling delay when a process exits during a readiness request', async () => {
    let finish!: (value: boolean) => void;
    ready.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(1200);
    finish(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('waits while outbound networking is unavailable and wakes when the network returns', async () => {
    ready.mockResolvedValue(false);
    egressReady.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledOnce();
    egressReady.mockResolvedValue(true);
    network = 'restored';
    supervisor.networkChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('preserves a tunnel that becomes ready during the outbound check', async () => {
    ready.mockResolvedValue(false);
    egressReady.mockImplementation(async () => { ready.mockResolvedValue(true); return true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(start).toHaveBeenCalledOnce();
    expect(children[0]!.stop).not.toHaveBeenCalled();
  });

  it('stops its child and never restarts after an explicit stop', async () => {
    await vi.advanceTimersByTimeAsync(0);
    supervisor.stop();
    await done;
    supervisor.networkChanged();
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children[0]!.stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});
