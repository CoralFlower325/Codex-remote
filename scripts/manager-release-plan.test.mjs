import { describe, expect, it } from 'vitest';
import { managerReleasePlan } from './manager-release-plan.mjs';

describe('independent manager releases', () => {
  it('skips packaging for Remote-only changes', () => {
    expect(managerReleasePlan('0.2.0', '0.2.0',
      ['src/client/Workspace.tsx', 'package.json', 'docs/desktop-manager.md']))
      .toEqual({ version: '0.2.0', package: false });
  });

  it('packages a new manager version independently of Remote', () => {
    expect(managerReleasePlan('0.2.1', '0.2.0', ['desktop/main.mjs']))
      .toEqual({ version: '0.2.1', package: true });
    expect(managerReleasePlan('0.2.0', '0.2.1', ['desktop/package.json']).package).toBe(true);
  });

  it('blocks shipping manager edits under an unchanged version', () => {
    expect(() => managerReleasePlan('0.2.0', '0.2.0', ['desktop/renderer/main.tsx']))
      .toThrow('version increment');
    expect(() => managerReleasePlan('0.2.0', '0.2.0', ['scripts/build-manager.mjs']))
      .toThrow('version increment');
  });

  it('allows manager test and documentation changes without a package', () => {
    expect(managerReleasePlan('0.2.0', '0.2.0',
      ['desktop/updater.test.mjs', 'desktop/README.md']).package).toBe(false);
  });
});
