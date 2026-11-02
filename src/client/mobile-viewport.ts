export const mobileViewportConfig = {
  keyboardThreshold: 120,
  scaleTolerance: 0.02
};

export function mobileViewportGeometry(input: {
  layoutHeight: number;
  visibleHeight: number;
  offsetTop: number;
  baselineHeight: number;
  scale: number;
  editing: boolean;
}) {
  const positive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;
  const layoutHeight = positive(input.layoutHeight, 1);
  const height = positive(input.visibleHeight, layoutHeight);
  const top = Number.isFinite(input.offsetTop) ? Math.max(0, input.offsetTop) : 0;
  const keyboardOpen = input.editing &&
    Math.abs(input.scale - 1) < mobileViewportConfig.scaleTolerance &&
    positive(input.baselineHeight, layoutHeight) - height > mobileViewportConfig.keyboardThreshold;
  return keyboardOpen
    ? { height, top, keyboardOpen: true }
    : { height: layoutHeight, top: 0, keyboardOpen: false };
}
