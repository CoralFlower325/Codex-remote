import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { discoverMacTunnels, repairMacTunnel } from '../desktop/macos-tunnel.mjs';
import { run } from '../desktop/process.mjs';

if (process.platform !== 'darwin') throw new Error('This acceptance requires macOS.');
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-tunnel-')));
const domain = `gui/${process.getuid()}`;
const label = `io.codex.remote.synthetic-tunnel-${process.pid}`;
const id = `${domain}/${label}`;
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
try {
  const binary = path.join(directory, 'cloudflared');
  await fs.writeFile(binary, '#!/bin/sh\nexec /bin/sleep 180\n', { mode: 0o755 });
  await fs.writeFile(path.join(directory, 'tunnel.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(binary)}</string><string>tunnel</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`, 'utf8');
  const locations = [{ directory, domain }];
  const services = await discoverMacTunnels(run, locations);
  assert.equal(services.length, 1);
  await repairMacTunnel(services[0], run, locations);
  const first = await run('/bin/launchctl', ['print', id]);
  assert.match(first, /state = running/);
  const pid = first.match(/pid = (\d+)/)?.[1];
  assert.ok(pid);
  await repairMacTunnel(services[0], run, locations);
  const restarted = await run('/bin/launchctl', ['print', id]);
  assert.match(restarted, /state = running/);
  assert.notEqual(restarted.match(/pid = (\d+)/)?.[1], pid);
  console.log('Isolated macOS Cloudflare job discovery, bootstrap and restart passed.');
} finally {
  await run('/bin/launchctl', ['bootout', id]).catch(() => {});
  await fs.rm(directory, { recursive: true, force: true });
}
