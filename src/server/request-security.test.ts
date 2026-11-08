import express from 'express';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { LoginBudget, localSetupRequest, proxyTrust } from './request-security.js';

afterEach(() => vi.useRealTimers());

it('trusts only loopback upstreams by default and accepts explicit proxy ranges', () => {
  expect(proxyTrust('1')).toEqual(['loopback']);
  expect(proxyTrust('')).toEqual(['loopback']);
  expect(proxyTrust('0')).toBe(false);
  expect(proxyTrust('loopback,10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
});

it('keeps forwarded loopback claims away from initial local password setup', async () => {
  const app = express();
  app.set('trust proxy', proxyTrust('1'));
  app.get('/', (req, res) => res.json({ setup: localSetupRequest(req), address: req.ip, secure: req.secure }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const request = (headers: Record<string, string>) => new Promise<any>((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: (server.address() as any).port, path: '/', headers }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  try {
    expect(await request({})).toMatchObject({ setup: true, secure: false });
    expect(await request({ 'x-forwarded-for': '127.0.0.1' })).toMatchObject({ setup: false });
    expect(await request({ 'forwarded': 'for=127.0.0.1' })).toMatchObject({ setup: false });
    expect(await request({ 'x-forwarded-for': '203.0.113.1', 'x-forwarded-proto': 'https' }))
      .toMatchObject({ setup: false, secure: true, address: '203.0.113.1' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('reserves concurrent login work before hashing and limits repeated failures', () => {
  vi.useFakeTimers();
  const budget = new LoginBudget();
  const begin = (key: string) => {
    const result = budget.begin(key);
    if ('retryAfter' in result) throw new Error('Unexpected limit');
    return result.finish;
  };
  const a = begin('a'), b = begin('a'), c = begin('c');
  expect(budget.begin('a')).toHaveProperty('retryAfter');
  expect(budget.begin('other')).toHaveProperty('retryAfter');
  const recovery = budget.begin('direct-local', Date.now(), true);
  expect(recovery).toHaveProperty('finish');
  if ('finish' in recovery) recovery.finish(true);
  a(false); a(false); b(false); c(true);
  for (let i = 0; i < 3; i++) begin('a')(false);
  expect(budget.begin('a')).toEqual({ retryAfter: 100 });
  vi.advanceTimersByTime(100_000);
  begin('a')(true);
  expect(budget.begin('a')).toHaveProperty('finish');
});

it('bounds distributed failures without blocking the reserved direct-local recovery path', () => {
  vi.useFakeTimers();
  const budget = new LoginBudget();
  for (let i = 0; i < 30; i++) {
    const attempt = budget.begin(`source-${i}`);
    expect(attempt).toHaveProperty('finish');
    if ('finish' in attempt) attempt.finish(false);
  }
  expect(budget.begin('new-source')).toHaveProperty('retryAfter');
  const local = budget.begin('direct-local', Date.now(), true);
  expect(local).toHaveProperty('finish');
  if ('finish' in local) local.finish(true);
  vi.advanceTimersByTime(60_001);
  expect(budget.begin('new-source')).toHaveProperty('finish');
});
