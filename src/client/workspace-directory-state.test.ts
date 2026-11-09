import { describe, expect, it } from 'vitest';

import {
  appendDirectoryThread,
  removeDirectoryThread,
  replaceDirectoryThread,
  restoreSavedThreads,
  updateDirectoryThread
} from './workspace-directory-state';
import type { Thread } from './types';

const thread = (id: string, name = id): Thread => ({
  id,
  name,
  preview: '',
  cwd: '/workspace',
  projectId: null,
  model: null,
  modelProvider: 'openai',
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 1,
  status: { type: 'idle' }
});

describe('workspace directory state commands', () => {
  it('appends without duplicating an existing thread identity', () => {
    expect(appendDirectoryThread([thread('one')], thread('one', 'new'))).toEqual([thread('one', 'new')]);
  });

  it('updates and replaces rows without changing unrelated identities', () => {
    const current = [thread('one'), thread('two')];
    expect(updateDirectoryThread(current, 'one', entry => ({ ...entry, name: 'renamed' }))[0]?.name)
      .toBe('renamed');
    expect(replaceDirectoryThread(current, thread('one', 'moved')).map(entry => entry.id)).toEqual(['two', 'one']);
  });

  it('removes exactly one thread and restores saved rows only into an empty directory', () => {
    expect(removeDirectoryThread([thread('one'), thread('two')], 'one').map(entry => entry.id)).toEqual(['two']);
    expect(restoreSavedThreads([], [thread('saved')])).toEqual([thread('saved')]);
    const existing = [thread('live')];
    expect(restoreSavedThreads(existing, [thread('saved')])).toBe(existing);
  });
});
