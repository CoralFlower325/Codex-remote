const steps = [
  ['fetch', '获取新版本', 0, 12, '正在获取官方版本和源码，现有服务继续运行。'],
  ['compare', '检查安装文件', 12, 18, '正在检查本机改动和文件冲突，保留私有配置与数据。'],
  ['dependencies', '下载并安装依赖', 18, 43, '正在临时目录安装依赖；网络较慢时此步骤可能持续数分钟。'],
  ['typecheck', '检查代码类型', 43, 51, '正在检查新版本代码的类型。'],
  ['test', '运行自动测试', 51, 66, '正在验证新版本功能和更新保护机制。'],
  ['build', '构建新版本', 66, 78, '正在生成网页和服务程序，现有服务继续运行。'],
  ['offline', '验证离线安装', 78, 81, '正在验证本次缓存可独立完成依赖安装，现有服务继续运行。'],
  ['runtime', '下载运行包', 18, 65, '正在下载当前系统的官方运行包，现有服务继续运行。'],
  ['unpack', '校验运行包', 65, 81, '正在校验文件、解压并检查运行环境，无需本机构建。'],
  ['backup', '备份当前版本', 81, 85, '正在保存受影响的文件和构建，准备失败恢复。'],
  ['stop', '停止旧服务', 85, 88, '正在等待旧服务退出，保留桌面端和私有数据。'],
  ['install', '安装新版本', 88, 96, '正在安装已验证的文件和运行依赖，远程服务会短暂离线。'],
  ['verify', '确认服务状态', 96, 99, '正在恢复更新前的运行状态并检查本机服务。'],
  ['cleanup', '完成更新', 99, 100, '正在清理本次更新的临时文件，保留版本备份。']
];

export function cleanOutput(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [已隐藏]')
    .replace(/((?:_authToken|authorization|password|token)\s*[=:]\s*)[^\s]+/gi, '$1[已隐藏]');
}

export function updateError(error) {
  const detail = cleanOutput(error?.message || error);
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network.*(?:failed|error)|could not resolve|unable to access/i.test(detail)) {
    return '下载连接中断或超时，有限次数的重试未能完成。请确认当前网络、依赖源或代理可用后重试。';
  }
  if (/ENOTCACHED/i.test(detail)) return '本次离线依赖缓存不完整，请重新准备更新。';
  if (/Command timed out/.test(detail)) return '当前步骤已超过最长等待时间，更新已停止。请查看最近输出后重试。';
  if (/EACCES|EPERM|permission denied/i.test(detail)) return '更新遇到文件权限问题，请检查所选安装目录和临时目录的访问权限。';
  if (/ENOSPC|no space left/i.test(detail)) return '磁盘空间不足，请释放安装目录和临时目录所在磁盘的空间后重试。';
  if (/Local changes conflict/.test(detail)) return '本机代码或配置与新版本存在冲突，更新已停止。请先保留并核对这些本机改动。';
  return '当前更新步骤未能完成，请展开最近输出查看具体原因。';
}

export function networkFailure(error) {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up|fetch failed|could not resolve|unable to access/i.test(
    `${error?.message || ''} ${error?.cause?.code || ''}`);
}

export function createUpdateProgress(notify) {
  let state = { percent: 0, step: '', title: '准备更新', detail: '正在检查当前安装。',
    startedAt: Date.now(), stepStartedAt: Date.now(), lastOutputAt: null,
    endedAt: null, status: 'running', logs: [] };
  let pendingOutput = '';
  let lastOutputNotice = 0;
  const emit = (kind) => notify(state.title, { ...state, logs: [...state.logs], kind });
  const log = (text) => {
    for (const line of cleanOutput(text).split(/[\r\n]+/).filter((line) => line.trim())) {
      state.logs.push({ time: Date.now(), message: line.slice(-600) });
    }
    state.logs = state.logs.slice(-40);
  };
  const output = (chunk) => {
    state.lastOutputAt = Date.now();
    pendingOutput = (pendingOutput + chunk).slice(-8000);
    if (Date.now() - lastOutputNotice < 250) return;
    log(pendingOutput); pendingOutput = ''; lastOutputNotice = Date.now(); emit('output');
  };
  const flush = () => { if (pendingOutput) { log(pendingOutput); pendingOutput = ''; } };
  return {
    output,
    download(loaded, total) {
      if (state.step !== 'runtime' || total <= 0) return;
      const percent = 18 + Math.floor(Math.min(1, loaded / total) * 47);
      const detail = `已下载 ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB。`;
      if (percent <= state.percent) return;
      state.percent = percent; state.detail = detail; state.lastOutputAt = Date.now(); emit('output');
    },
    start(key) {
      flush();
      const step = steps.find(([id]) => id === key);
      if (!step) throw new Error('Unknown update step');
      state = { ...state, step: key, title: step[1], percent: Math.max(state.percent, step[2]), detail: step[4],
        status: 'running', stepStartedAt: Date.now(), lastOutputAt: null };
      emit('step');
    },
    finish(key) {
      flush();
      state.percent = Math.max(state.percent, steps.find(([id]) => id === key)[3]);
      emit('step');
    },
    note(detail) { state.detail = detail; emit('note'); },
    recovery(key, title, percent, detail) {
      flush();
      state = { ...state, step: key, title, percent, detail,
        status: 'recovering', stepStartedAt: Date.now(), lastOutputAt: null };
      emit('step');
    },
    terminal(status, title, detail, error) {
      flush();
      if (error) log(error.message || error);
      state = { ...state, status, title, detail,
        endedAt: Date.now(), percent: status === 'completed' || status === 'recovered' ? 100 : state.percent };
      emit('terminal');
    }
  };
}
