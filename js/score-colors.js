// Shared map/legend bins. Display precision matches the one-decimal score card.
export const SCORE_PALETTE = ['#dd5838', '#edb43c', '#b8dce7', '#438fbd', '#57358c'];
export const NO_DATA_COLOR = '#77818c';
export function displayScore(value) {
  return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value)) * 10) / 10 : null;
}

export function createColorScale(values, mode = 'relative') {
  const sorted = values.map(displayScore).filter((value) => value !== null).sort((a, b) => a - b);
  const min = sorted[0] ?? 0;
  const max = sorted.at(-1) ?? 100;
  const thresholds = mode === 'absolute' ? [20, 40, 60, 80] : [...new Set(
    [1, 2, 3, 4].map((i) => sorted[Math.floor(sorted.length * i / 5)])
      .filter((value) => Number.isFinite(value) && value > min),
  )];
  const colors = Array.from({ length: thresholds.length + 1 }, (_, i) => {
    const paletteIndex = thresholds.length ? Math.round(i * (SCORE_PALETTE.length - 1) / thresholds.length) : Math.min(4, Math.floor(min / 20));
    return SCORE_PALETTE[paletteIndex];
  });
  const edges = [mode === 'absolute' ? 0 : min, ...thresholds, mode === 'absolute' ? 100 : max];
  const binIndex = (value) => {
    const index = thresholds.findIndex((threshold) => value < threshold);
    return index < 0 ? thresholds.length : index;
  };
  const bins = sorted.length ? colors.map((color, index) => ({ color, min: edges[index], max: edges[index + 1], count: 0, upperInclusive: index === colors.length - 1 })) : [];
  sorted.forEach((value) => { bins[binIndex(value)].count += 1; });
  return {
    bins,
    total: sorted.length,
    color(value) {
      const rounded = displayScore(value);
      return rounded === null ? NO_DATA_COLOR : colors[binIndex(rounded)];
    },
  };
}
