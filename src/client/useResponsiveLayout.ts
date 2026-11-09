import { useEffect, useState } from 'react';

import { layoutForViewport } from './workspace-model';

export type LayoutMode = 'desktop' | 'mobile';

export function useResponsiveLayout(): LayoutMode {
  const getLayout = (): LayoutMode => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    return layoutForViewport(width, height, matchMedia('(pointer: coarse)').matches);
  };
  const [layout, setLayout] = useState<LayoutMode>(getLayout);

  useEffect(() => {
    const update = () => setLayout(getLayout());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return layout;
}
