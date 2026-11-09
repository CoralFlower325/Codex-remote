import { describe, expect, it } from 'vitest';

import {
  buildSidebarGroups,
  dedupeThreads,
  findModelInfo,
  findProjectForThread,
  layoutForViewport,
  reasoningOptionsForModel,
  reasoningOptionsWithInherit,
  resolveReasoningEffort
} from './workspace-model';
import type { ModelInfo, ProjectInfo, Thread } from './types';

it('uses the phone layout for both orientations of a 1206 by 2622 screen at DPR 3', () => {
  expect(layoutForViewport(402, 874, true)).toBe('mobile');
  expect(layoutForViewport(874, 402, true)).toBe('mobile');
  expect(layoutForViewport(1024, 768, true)).toBe('desktop');
  expect(layoutForViewport(2560, 1440)).toBe('desktop');
});

const project: ProjectInfo = {
  id: 'project-1',
  name: 'Example',
  roots: [{ path: 'F:\\Example' }],
  position: 0
};

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    name: 'Task',
    preview: 'Preview',
    cwd: 'F:\\Example',
    projectId: null,
    model: 'model-a',
    modelProvider: 'openai',
    reasoningEffort: 'high',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    ...overrides
  };
}

describe('workspace model', () => {
  it('deduplicates repeated thread ids and keeps the newest record', () => {
    const result = dedupeThreads([
      thread({ updatedAt: 1, preview: 'old' }),
      thread({ updatedAt: 2, preview: 'new' })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.preview).toBe('new');
  });

  it('prefers the later record when two snapshots share an update timestamp', () => {
    const result = dedupeThreads([
      thread({ updatedAt: 5, name: 'Old title' }),
      thread({ updatedAt: 5, name: 'Fresh title' })
    ]);
    expect(result[0]?.name).toBe('Fresh title');
  });

  it('maps legacy threads to projects by working directory', () => {
    expect(findProjectForThread(thread({ cwd: 'F:\\Example\\src' }), [project])?.id).toBe(project.id);
  });

  it('groups project and standalone tasks for the sidebar', () => {
    const groups = buildSidebarGroups(
      [
        thread({ id: 'project-task', cwd: 'F:\\Example\\src' }),
        thread({ id: 'standalone', cwd: 'C:\\Temp' })
      ],
      [project],
      '',
      'all'
    );
    expect(groups.projects[0]?.threads.map((entry) => entry.id)).toEqual(['project-task']);
    expect(groups.standalone.map((entry) => entry.id)).toEqual(['standalone']);
  });

  it('keeps viewed child chats out of task groups without hiding ordinary unnamed chats', () => {
    const groups = buildSidebarGroups([
      thread({ id: 'ordinary', name: null }),
      thread({ id: 'spawned', name: null, source: { subAgent: { thread_spawn: { parent_thread_id: 'ordinary' } } } }),
      thread({ id: 'review', source: { subAgent: 'review' } }),
      thread({ id: 'temporary', ephemeral: true })
    ], [project], '', 'all');
    expect(groups.total).toBe(1);
    expect(groups.projects[0]?.threads.map(entry => entry.id)).toEqual(['ordinary']);
  });

  it('falls back to the model default reasoning effort', () => {
    const model: ModelInfo = {
      id: 'model-a',
      model: 'model-a',
      displayName: 'Model A',
      description: '',
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'high' }
      ]
    };
    expect(resolveReasoningEffort(model, 'unsupported')).toBe('high');
  });

  it('resolves model aliases with provider identity and exposes native inherit explicitly', () => {
    const models: ModelInfo[] = [{
      id: 'provider-a/model-id',
      model: 'model-alias',
      modelProvider: 'provider-a',
      displayName: 'Provider A',
      description: '',
      isDefault: false,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
    }, {
      id: 'shared-id',
      model: 'shared',
      modelProvider: 'provider-b',
      displayName: 'Provider B',
      description: '',
      isDefault: true,
      hidden: false
    }];

    expect(findModelInfo(models, 'provider-a/model-id', 'provider-a')?.displayName).toBe('Provider A');
    expect(findModelInfo(models, 'model-alias', 'provider-a')?.id).toBe('provider-a/model-id');
    expect(findModelInfo(models, 'shared-id', 'provider-b')?.displayName).toBe('Provider B');
    expect(reasoningOptionsWithInherit(models[0]).map(option => option.value)).toEqual(['', 'high']);
  });

  it('uses the Codex reasoning labels for every supported effort', () => {
    const model: ModelInfo = {
      id: 'model-a',
      model: 'model-a',
      displayName: 'Model A',
      description: '',
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra'
      ].map((reasoningEffort) => ({ reasoningEffort }))
    };

    expect(reasoningOptionsForModel(model).map((option) => option.label)).toEqual([
      '无',
      '极低',
      '轻度',
      '中',
      '高',
      '极高',
      'Max',
      'Ultra'
    ]);
  });
});
