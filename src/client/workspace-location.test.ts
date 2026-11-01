import { describe, expect, it } from 'vitest';

import { readWorkspaceLocation, workspaceLocationUrl } from './workspace-location';

describe('workspace task locations', () => {
  it('retains task and archive selection through a copied URL', () => {
    const target = { threadId: 'synthetic-task', archived: true };
    const url = workspaceLocationUrl(new URL('https://example.test/remote-client/?other=kept#anchor'), target);
    expect(readWorkspaceLocation(url)).toEqual(target);
    expect(url.pathname).toBe('/remote-client/');
    expect(url.searchParams.get('other')).toBe('kept');
    expect(url.hash).toBe('#anchor');
  });

  it('returns home without retaining a previous task or archive filter', () => {
    const url = workspaceLocationUrl(new URL('https://example.test/?thread=old&archived=1'), {
      threadId: null, archived: false
    });
    expect(url.search).toBe('');
    expect(readWorkspaceLocation(url)).toEqual({ threadId: null, archived: false });
  });

  it('ignores oversized and control-character task identifiers', () => {
    for (const thread of ['x'.repeat(257), 'task\ninjected']) {
      const url = new URL('https://example.test/');
      url.searchParams.set('thread', thread);
      expect(readWorkspaceLocation(url).threadId).toBeNull();
    }
  });
});
