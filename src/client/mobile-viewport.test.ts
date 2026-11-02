import { describe, expect, it } from 'vitest';
import { mobileViewportGeometry } from './mobile-viewport';

const base = { layoutHeight: 874, visibleHeight: 874, offsetTop: 0, baselineHeight: 874, scale: 1, editing: false };

describe('mobile visible viewport', () => {
  it('uses the visible height once when the keyboard opens and Safari pans the page', () => {
    expect(mobileViewportGeometry({ ...base, visibleHeight: 520, offsetTop: 32, editing: true }))
      .toEqual({ height: 520, top: 32, keyboardOpen: true });
  });
  it('recognizes keyboards when the browser also resizes the layout viewport', () => {
    expect(mobileViewportGeometry({ ...base, layoutHeight: 520, visibleHeight: 520, editing: true }).keyboardOpen).toBe(true);
  });
  it('does not treat browser toolbar changes or pinch zoom as a keyboard', () => {
    expect(mobileViewportGeometry({ ...base, visibleHeight: 800, editing: true }).keyboardOpen).toBe(false);
    expect(mobileViewportGeometry({ ...base, visibleHeight: 400, scale: 2, editing: true }).keyboardOpen).toBe(false);
    expect(mobileViewportGeometry({ ...base, visibleHeight: 520 }).keyboardOpen).toBe(false);
  });
  it('never locks a transient visual viewport height while the keyboard is closed', () => {
    expect(mobileViewportGeometry({ ...base, visibleHeight: 610 })).toEqual({
      height: 874, top: 0, keyboardOpen: false
    });
  });
  it('restores normal safe area spacing after closing the keyboard', () => {
    expect(mobileViewportGeometry({ ...base, editing: true })).toEqual({ height: 874, top: 0, keyboardOpen: false });
  });
  it('sanitizes invalid viewport metrics', () => {
    expect(mobileViewportGeometry({ ...base, visibleHeight: NaN, offsetTop: -10 }))
      .toEqual({ height: 874, top: 0, keyboardOpen: false });
  });
});
