import { dedupeThreads } from './workspace-model';
import type { Thread } from './types';

export function appendDirectoryThread(threads: Thread[], thread: Thread): Thread[] {
  return dedupeThreads([...threads, thread]);
}

export function updateDirectoryThread(threads: Thread[], threadId: string,
  update: (thread: Thread) => Thread): Thread[] {
  return threads.map(thread => thread.id === threadId ? update(thread) : thread);
}

export function replaceDirectoryThread(threads: Thread[], thread: Thread): Thread[] {
  return dedupeThreads([...threads.filter(entry => entry.id !== thread.id), thread]);
}

export function removeDirectoryThread(threads: Thread[], threadId: string): Thread[] {
  return threads.filter(thread => thread.id !== threadId);
}

export function restoreSavedThreads(threads: Thread[], saved: Thread[]): Thread[] {
  if (threads.length) return threads;
  return dedupeThreads(saved);
}
