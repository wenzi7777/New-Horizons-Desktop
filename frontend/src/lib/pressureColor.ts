// The pressure colour scale, shared so that a cell looks the same on the
// Visualization page and in the SDK's emulator.

export type PressureRange = { min: number; max: number };

export function valueRatio(value: number, range: PressureRange) {
  const span = Math.max(range.max - range.min, 1);
  return Math.max(0, Math.min(1, (value - range.min) / span));
}

export function cssColorForValue(value: number, range: PressureRange) {
  const ratio = valueRatio(value, range);
  const hue = 154 - ratio * 108;
  const lightness = 78 - ratio * 30;
  return `hsl(${hue}deg 58% ${lightness}%)`;
}
