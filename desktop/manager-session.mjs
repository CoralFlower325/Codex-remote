import fs from 'node:fs/promises';
import path from 'node:path';
import { health, installation, control, serviceStatus, portListening, startupReady } from './controller.mjs';
import { latestRelease, prepareUpdate, installUpdate } from './updater.mjs';
import { discoverInstallations, preferredInstallation } from './discovery.mjs';
import { updateError, createUpdateProgress } from './update-progress.mjs';
import { pendingUpdate, recoverPendingUpdate } from './update-transaction.mjs';
import { manageAuthentication } from './security.mjs';
import { repairControl } from './diagnostics.mjs';
// Installation state and serialized operations; the Electron shell owns windows.
export function createManagerSession({ app, dialog, shell, fetchRelease, getWindow, publish, here }) {
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  let polling = null;
  let healthError = '';
  const settings = { root: '', launchAtLogin: false };
  const state = { status: null, busy: '', error: '', release: null, result: '', events: [], installations: [],
    updateProgress: null, recoveryRequired: false, security: null, connectionReport: null, logs: null };
  function event(message) {
    state.events = [{ time: Date.now(), message }, ...state.events].slice(0, 60);
  }
  function snapshot() {
    return { ...state, root: settings.root, launchAtLogin: settings.launchAtLogin,
      packaged: app.isPackaged, version: app.getVersion(), platform: process.platform, healthError };
  }
  async function saveSettings() {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), JSON.stringify(settings), 'utf8');
  }
  async function refresh() {
    if (polling) return polling;
    if (state.busy || !settings.root) return;
    polling = (async () => {
      try {
        state.status = await health(settings.root, undefined, process.platform, fetchRelease);
        healthError = '';
      } catch (error) {
        healthError = error.message;
        state.status = null;
      } finally { polling = null; publish(); }
    })();
    return polling;
  }
  function showError(error) {
    state.error = error.message; event(`操作未完成：${error.message.slice(0, 500)}`); publish();
  }
  async function exclusive(label, fn) {
    if (state.managerUpdate?.status === 'installing') throw new Error('正在交接管理器安装，请等待管理器重新打开。');
    if (state.busy) throw new Error('已有操作正在进行。');
    // A read already in progress must finish before a mutation uses its snapshot.
    if (polling) await polling;
    if (state.busy) throw new Error('已有操作正在进行。');
    state.busy = label; state.error = ''; state.result = ''; state.updateProgress = null; event(label); publish();
    try { return await fn(); }
    catch (error) { showError(error); throw error; }
    finally { state.busy = ''; await refresh(); publish(); }
  }
  async function waitStopped() {
    for (let i = 0; i < 30; i++) {
      const info = await installation(settings.root);
      const service = await serviceStatus(info);
      if (!service.running && !await portListening(info.localUrl)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('旧 Remote 仍在运行，已停止后续操作。');
  }
  async function stop() { await control(settings.root, 'Stop'); await waitStopped(); }
  async function verify({ requireDesktop = true } = {}) {
    let status;
    for (let i = 0; i < 6; i++) {
      status = await health(settings.root);
      if (startupReady(status, true)) return status;
      if (i < 5) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (startupReady(status, requireDesktop)) return status;
    throw new Error(status.diagnostics.join('\n') || 'Remote 本地健康检测尚未通过。');
  }
  async function requireCompletedUpdate() {
    if (state.recoveryRequired) throw new Error('请先恢复中断的更新。');
    state.recoveryRequired = true;
    // Leave the guard set if the journal is unreadable or damaged.
    state.recoveryRequired = Boolean(await pendingUpdate(settings.root));
    if (state.recoveryRequired) throw new Error('请先恢复中断的更新。');
  }
  async function action(kind) {
    if (!settings.root) throw new Error('请先选择安装目录。');
    if (!['Start', 'Stop', 'Restart'].includes(kind)) throw new Error('Invalid action.');
    return exclusive(kind === 'Start' ? '正在开启 Remote' : kind === 'Stop' ? '正在关闭 Remote' : '正在重启 Remote',
      async () => {
        await requireCompletedUpdate();
        if (kind !== 'Start') await stop();
        if (kind === 'Stop') event('Remote 已关闭');
        else {
          await control(settings.root, 'Start');
          const status = await verify({ requireDesktop: false });
          event(status.desktop ? 'Remote 已启动' : 'Remote 已启动，Desktop 同步待就绪');
        }
      });
  }
  async function openRemote() {
    const info = await installation(settings.root);
    await shell.openExternal(info.publicUrl || info.localUrl);
  }
  async function diagnose() {
    return exclusive('正在复检连接', async () => {
      const status = await health(settings.root, undefined, process.platform, fetchRelease, { publicTimeout: 12_000 });
      state.status = status;
      state.connectionReport = { checkedAt: status.checkedAt, ...status.publicEntry };
      event(status.publicEntry.reachable ? '公网复检通过' : '公网复检完成，需查看诊断结果');
    });
  }
  async function repair(target) {
    if (!['Server', 'Tunnel'].includes(target)) throw new Error('未知修复目标。');
    const selectedRoot = settings.root;
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'question', title: target === 'Tunnel' ? '修复受管隧道' : '修复 Remote 服务',
      message: target === 'Tunnel' ? '重启当前安装的受管隧道？' : '重启当前安装的 Remote 服务？',
      detail: target === 'Tunnel' ? '公网连接会短暂中断，Remote 和 Codex Desktop 保持运行。'
        : 'Remote 会短暂离线，Codex Desktop 和独立隧道保持运行。',
      buttons: ['取消', '开始修复'], defaultId: 0, cancelId: 0
    });
    if (response !== 1) return;
    return exclusive('正在修复连接', async () => {
      if (settings.root !== selectedRoot) throw new Error('安装目录已改变，请重新确认修复。');
      await requireCompletedUpdate();
      const status = await health(settings.root, undefined, process.platform, fetchRelease);
      if (['conflict', 'unowned'].includes(status.state)) throw new Error('请先解决服务归属或端口冲突。');
      await repairControl(status, target);
      if (target === 'Server') await verify({ requireDesktop: false });
      const checked = await health(settings.root, undefined, process.platform, fetchRelease, { publicTimeout: 12_000 });
      state.connectionReport = { checkedAt: checked.checkedAt, ...checked.publicEntry };
      state.result = target === 'Tunnel' ? '受管隧道已重新启动，请查看连接复检结果。' : 'Remote 已重新启动，请查看健康状态。';
    });
  }
  async function security(request) {
    const selectedRoot = settings.root;
    if (!request || !['list', 'password', 'revoke', 'revoke-all'].includes(request.action)) throw new Error('未知认证操作。');
    if (request.action === 'password' && (typeof request.password !== 'string' || request.password.trim().length < 6 ||
      request.password.length > 256 || request.password !== request.confirm)) throw new Error('请输入两次相同的新密码，长度为 6 至 256 位。');
    if (request.action === 'revoke' && (typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id))) throw new Error('请选择有效设备。');
    if (request.action !== 'list') {
      const { response } = await dialog.showMessageBox(getWindow(), {
        type: 'warning', title: '管理设备认证',
        message: request.action === 'password' ? '修改访问密码并退出所有设备？'
          : request.action === 'revoke-all' ? '撤销所有设备的认证？' : '撤销此设备的认证？',
        detail: '受影响浏览器需要重新登录，现有网页及终端连接将断开。系统推送权限需在设备上另行管理。',
        buttons: ['取消', '确认操作'], defaultId: 0, cancelId: 0
      });
      if (response !== 1) return;
    }
    return exclusive(request.action === 'list' ? '正在读取已认证设备' : '正在更新设备认证', async () => {
      if (settings.root !== selectedRoot) throw new Error('安装目录已改变，请重新确认认证操作。');
      await requireCompletedUpdate();
      const status = await health(settings.root, undefined, process.platform, fetchRelease);
      if (['conflict', 'unowned'].includes(status.state)) throw new Error('请先解决服务归属或端口冲突。');
      state.security = await manageAuthentication(settings.root, {
        action: request.action, ...(request.action === 'password' ? { password: request.password } : {}),
        ...(request.action === 'revoke' ? { id: request.id } : {})
      });
      if (request.action !== 'list') {
        state.result = request.action === 'password' ? '访问密码已修改，旧登录已失效。' : '设备认证已撤销。';
        event(state.result);
      }
    });
  }
  async function checkUpdate() {
    return exclusive('正在检查更新', async () => {
      const info = await installation(settings.root);
      try { state.release = await latestRelease(info.version, fetchRelease); }
      catch (error) { throw new Error(`检查版本未完成。${updateError(error)}`, { cause: error }); }
      state.result = state.release.available ? '' : `本机 ${info.version} 已是最新版本。`;
      event(state.release.available ? `发现新版本 ${state.release.version}` : '本机已是最新版本');
    });
  }
  async function update() {
    if (state.recoveryRequired) throw new Error('请先恢复中断的更新。');
    if (!state.release?.available) throw new Error('请先检查更新。');
    const release = { ...state.release };
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'question', title: '更新本机 Codex Remote',
      message: `更新到 ${release.version}？`,
      detail: '标准安装优先使用预构建运行包；源码定制安装使用隔离构建。将检查冲突并保留恢复备份，安装时 Remote 会短暂离线。外部静态托管需另行同步。\n\n' + release.notes,
      buttons: ['取消', '更新本机'], defaultId: 0, cancelId: 0
    });
    if (response !== 1) return;
    return exclusive('正在准备更新', async () => {
      await requireCompletedUpdate();
      const current = await health(settings.root);
      if (['conflict', 'unowned'].includes(current.state)) throw new Error('请先解决服务归属或端口冲突。');
      const progress = (message, detail) => {
        state.busy = message; state.updateProgress = detail;
        if (detail?.kind !== 'output') event(message);
        publish();
      };
      const prepared = await prepareUpdate(settings.root, release, progress, undefined, { fetcher: fetchRelease });
      let requireDesktop = current.desktop;
      let result;
      try { result = await installUpdate(prepared, {
        stop, start: () => control(settings.root, 'Start'), verify: () => verify({ requireDesktop }),
        isRunning: async () => {
          const status = await health(settings.root);
          requireDesktop = status.desktop;
          return status.service.running;
        }, progress, requireDesktop
      }); } finally {
        state.recoveryRequired = true;
        state.recoveryRequired = Boolean(await pendingUpdate(settings.root));
      }
      state.release = null;
      state.result = `已通过${result.mode === 'runtime' ? '预构建运行包' : '源码构建'}安装 ${result.version}。备份：${result.backup}` +
        (result.preservedFiles.length ? `\n已保留本机文档：${result.preservedFiles.join('、')}。新版副本位于备份的 incoming 目录。` : '') +
        (result.wasRunning ? '' : '\nRemote 保持关闭。') +
        (result.edgeSyncRequired ? '\n若使用外部静态托管，请同步新版前端资源。' : '') +
        (result.cleanupWarning ? `\n${result.cleanupWarning}` : '');
      event(`本机已更新到 ${result.version}`);
    });
  }
  async function recoverInstallation() {
    if (!settings.root) return;
    return exclusive('正在检查未完成更新', async () => {
      state.recoveryRequired = true;
      const report = createUpdateProgress((message, detail) => {
        state.busy = message; state.updateProgress = detail; publish();
      });
      try {
        const pending = await pendingUpdate(settings.root);
        if (!pending) { state.recoveryRequired = false; return; }
        const result = await recoverPendingUpdate(settings.root, {
          stop, start: () => control(settings.root, 'Start'),
          verify: () => verify({ requireDesktop: Boolean(pending.requireDesktop) }), report
        });
        state.recoveryRequired = false;
        state.release = null;
        if (result) {
          state.result = result.terminal === 'committed' ? '已确认上次更新完成。' : '已恢复中断更新前的版本和运行状态。';
          event(state.result);
        }
      } catch (error) {
        report.terminal('recovery-failed', '中断更新恢复未完成',
          '已保留事务记录和备份，请检查错误后重试恢复。', error);
        throw Object.assign(new Error(`中断更新恢复未完成，事务记录和备份已保留。\n${updateError(error)}`,
          { cause: error }), { code: error.code });
      }
    });
  }
  async function chooseDirectory() {
    if (state.busy) throw new Error('请等待当前操作完成。');
    const chosen = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'],
      title: '选择已安装并构建的 Codex Remote 目录' });
    if (chosen.canceled) return;
    await selectDirectory(chosen.filePaths[0]);
  }
  async function selectDirectory(directory, discoveredOnly = false) {
    await exclusive('正在选择安装目录', async () => {
      if (discoveredOnly && !state.installations.some((item) => item.root === directory)) {
        throw new Error('请重新探测安装目录。');
      }
      const info = await installation(directory);
      settings.root = info.root; state.release = null; state.status = null; state.result = ''; state.error = '';
      state.security = null; state.connectionReport = null; state.logs = null;
      healthError = '';
      if (!discoveredOnly) state.installations = [];
      await saveSettings();
      state.recoveryRequired = true;
      state.recoveryRequired = Boolean(await pendingUpdate(settings.root));
      event('已选择本机安装目录');
    });
    if (state.recoveryRequired) await recoverInstallation();
  }
  async function detectDirectory() {
    return exclusive('正在探测安装目录', async () => {
      state.installations = await discoverInstallations({
        nearby: [settings.root, process.cwd(), path.dirname(process.execPath), ...(!app.isPackaged ? [path.dirname(here)] : [])]
      });
      const selected = preferredInstallation(state.installations, settings.root);
      if (settings.root !== (selected?.root || '')) {
        state.release = null; state.status = null; healthError = '';
        state.security = null; state.connectionReport = null; state.logs = null;
      }
      settings.root = selected?.root || '';
      state.recoveryRequired = Boolean(settings.root);
      if (settings.root) state.recoveryRequired = Boolean(await pendingUpdate(settings.root));
      await saveSettings();
      if (selected) {
        event('已识别本机安装目录');
      }
      state.result = state.installations.length ? '' : '未发现已构建的安装，请手动选择安装目录。';
    });
  }
  async function restoreDirectory() {
    if (settings.root) {
      try {
        const info = await installation(settings.root);
        if (settings.root !== info.root) { settings.root = info.root; await saveSettings(); }
        return;
      }
      catch { settings.root = ''; state.release = null; state.status = null; healthError = ''; }
    }
    await detectDirectory();
  }
  return { state, settings, event, snapshot, saveSettings, refresh, showError, exclusive, action, openRemote, diagnose, repair, security, checkUpdate, update, recoverInstallation, chooseDirectory, selectDirectory, detectDirectory, restoreDirectory };
}
