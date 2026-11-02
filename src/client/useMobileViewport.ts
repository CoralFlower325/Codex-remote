import { useLayoutEffect, type RefObject } from 'react';
import { mobileViewportGeometry } from './mobile-viewport';

/** Follow the visible viewport once; do not subtract the keyboard a second time. */
export function useMobileViewport(rootRef: RefObject<HTMLDivElement | null>, mobile: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !mobile) return;
    const viewport = window.visualViewport;
    let baselineHeight = window.innerHeight;
    let width = window.innerWidth;
    let frame = 0;
    let previousKeyboard: boolean | undefined;
    let previousFrame = '';
    let dock: Element | null = null;
    const clearVisibleViewport = () => {
      root.style.removeProperty('--mobile-viewport-height');
      root.style.removeProperty('--mobile-viewport-top');
    };
    const measure = () => {
      frame = 0;
      if (width !== window.innerWidth) {
        width = window.innerWidth;
        clearVisibleViewport();
        baselineHeight = Math.max(window.innerHeight, root.getBoundingClientRect().height,
          viewport?.height ?? 0);
      }
      const shellHeight = root.getBoundingClientRect().height;
      baselineHeight = Math.max(baselineHeight, window.innerHeight, shellHeight, viewport?.height ?? 0);
      const editing = document.activeElement?.matches(
        'textarea, input:not([type="button"]), [contenteditable="true"]'
      ) ?? false;
      const geometry = mobileViewportGeometry({
        layoutHeight: window.innerHeight, visibleHeight: viewport?.height ?? window.innerHeight,
        offsetTop: viewport?.offsetTop ?? 0, scale: viewport?.scale ?? 1, baselineHeight,
        editing
      });
      if (geometry.keyboardOpen) {
        root.style.setProperty('--mobile-viewport-height', `${geometry.height}px`);
        root.style.setProperty('--mobile-viewport-top', `${geometry.top}px`);
      } else {
        clearVisibleViewport();
      }
      root.dataset.keyboardOpen = String(geometry.keyboardOpen);
      const dockRect = dock?.getBoundingClientRect();
      const frameState = {
        ...geometry,
        layoutHeight: Math.round(window.innerHeight),
        visibleHeight: Math.round(viewport?.height ?? window.innerHeight),
        offsetTop: Math.round(viewport?.offsetTop ?? 0),
        shellHeight: Math.round(shellHeight),
        baselineHeight: Math.round(baselineHeight),
        editing,
        dockTop: dockRect ? Math.round(dockRect.top) : null,
        dockBottom: dockRect ? Math.round(dockRect.bottom) : null
      };
      const frameKey = JSON.stringify(frameState);
      if (frameKey !== previousFrame || previousKeyboard !== geometry.keyboardOpen) {
        console.debug('[mobile-layout] viewport measured', frameState);
        previousFrame = frameKey;
        previousKeyboard = geometry.keyboardOpen;
      }
      const nextDock = root.querySelector('.thread-bottom, .home-composer-dock');
      if (nextDock !== dock) {
        if (dock) observer.unobserve(dock);
        dock = nextDock;
        if (dock) observer.observe(dock);
      }
      const dockHeight = dock?.getBoundingClientRect().height ?? 0;
      root.style.setProperty('--mobile-dock-height', `${Math.ceil(dockHeight)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { childList: true, subtree: true });
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    clearVisibleViewport();
    baselineHeight = Math.max(window.innerHeight, root.getBoundingClientRect().height,
      viewport?.height ?? 0);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      for (const key of ['--mobile-viewport-height', '--mobile-viewport-top', '--mobile-dock-height']) root.style.removeProperty(key);
      delete root.dataset.keyboardOpen;
    };
  }, [rootRef, mobile]);
}
