export function trayAppearance(status, healthError, darkSystem = true) {
  // Public reachability and Desktop readiness do not determine service ownership.
  const running = !healthError && Boolean(status?.service?.running) &&
    !['conflict', 'unowned', 'stopped'].includes(status?.state);
  return { running, template: running ? 'trayRunningTemplate.png' : 'trayStoppedTemplate.png',
    windows: running ? darkSystem ? 'trayRunning.png' : 'trayRunningTemplate.png' : 'trayStopped.png' };
}
