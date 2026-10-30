import { changesSince, checkAppVersion, refreshAppVersion, updateStageLabels, type AppBuild } from './app-update';

const button = document.querySelector<HTMLButtonElement>('#update-button');
const status = document.querySelector<HTMLParagraphElement>('#update-status');
const version = document.querySelector<HTMLParagraphElement>('#update-version');
if (!button || !status || !version) throw new Error('更新页面缺少必要控件。');
version.textContent = `更新工具版本：${import.meta.env.VITE_APP_VERSION}`;
button.disabled = false;
button.textContent = '检查并更新版本';
let available: AppBuild | null = null;
button.addEventListener('click', () => {
  button.disabled = true;
  status.dataset.error = 'false';
  const action = async () => {
    if (!available) {
      status.textContent = updateStageLabels.checking;
      const check = await checkAppVersion();
      if (!check.updateAvailable) {
        status.textContent = updateStageLabels.current;
        const back = document.createElement('a');
        back.href = '/'; back.textContent = '返回应用';
        status.append(document.createElement('br'), back);
        button.disabled = false; button.textContent = '重新检查';
        return;
      }
      available = check.latest;
      version.textContent = `可更新至 ${available.version}`;
      status.textContent = changesSince(available, check.current?.version).flatMap(note =>
        [note.version, ...note.changes]).join('\n') || '此版本未提供更新摘要。';
      status.style.whiteSpace = 'pre-line';
      button.disabled = false; button.textContent = `更新至 ${available.version}`;
      return;
    }
    const outcome = await refreshAppVersion({ returnToApp: true, expectedBuild: available, onStage: (stage, build) => {
    status.textContent = `${updateStageLabels[stage]}${build ? `（${build.version}）` : ''}`;
    } });
    if (outcome === 'current') {
      available = null;
      const back = document.createElement('a'); back.href = '/'; back.textContent = '返回应用';
      status.append(document.createElement('br'), back);
      button.textContent = '重新检查';
    }
    button.disabled = false;
  };
  void action().catch(error => {
    available = null;
    status.dataset.error = 'true';
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
    button.textContent = '重试更新';
  });
});
