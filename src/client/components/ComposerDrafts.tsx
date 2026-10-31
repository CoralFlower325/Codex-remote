import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createComposerDrafts, type ComposerInput } from '../composer-drafts';

const DraftsContext = createContext<ReturnType<typeof createComposerDrafts> | null>(null);

export function ComposerDrafts({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => createComposerDrafts({
    getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key)
  }));
  return <DraftsContext.Provider value={drafts}>{children}</DraftsContext.Provider>;
}

export function useComposerDraft(key: string, temporary: boolean, initial?: ComposerInput) {
  const shared = useContext(DraftsContext);
  const [local] = useState(() => createComposerDrafts());
  const owner = useMemo(() => (temporary ? local : shared ?? local).open(key, initial),
    [shared, local, temporary, key]);
  const draft = useSyncExternalStore(owner.subscribe, owner.get);
  return { ...draft, owner };
}
