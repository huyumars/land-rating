// Map and legend share these RGB-interpolated color anchors.
export const SCORE_PALETTE = ['#dd5838', '#edb43c', '#b8dce7', '#438fbd', '#57358c'];
export const NO_DATA_COLOR = '#77818c';

const clampScore = (value) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const rgb = (color) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
const paletteRgb = SCORE_PALETTE.map(rgb);

export function displayScore(value) {
  const score = clampScore(value);
  return score === null ? null : Math.round(score * 10) / 10;
}

function interpolateRgb(from, to, position) {
  return `#${from.map((channel, index) => Math.round(channel + (to[index] - channel) * position).toString(16).padStart(2, '0')).join('')}`;
}

function paletteColor(position) {
  const offset = Math.max(0, Math.min(1, position)) * (SCORE_PALETTE.length - 1);
  const index = Math.min(Math.floor(offset), SCORE_PALETTE.length - 2);
  return interpolateRgb(paletteRgb[index], paletteRgb[index + 1], offset - index);
}

function quantile(sorted, position) {
  const offset = (sorted.length - 1) * position;
  const lower = Math.floor(offset);
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * (offset - lower);
}

export function createColorScale(values, mode = 'relative') {
  // Keep calculation precision: rounding belongs only in displayed score labels.
  const sorted = values.map(clampScore).filter((value) => value !== null).sort((a, b) => a - b);
  const total = sorted.length;
  const absolute = mode === 'absolute';
  const domain = absolute || !total ? [0, 100] : [sorted[0], sorted.at(-1)];
  const [min, max] = domain;
  let stops;

  if (!absolute && (!total || min === max)) {
    const color = total ? paletteColor(min / 100) : NO_DATA_COLOR;
    stops = [{ value: min, color, position: 0 }, { value: max, color, position: 1 }];
  } else if (absolute) {
    stops = SCORE_PALETTE.map((color, index) => ({ value: index * 25, color, position: index / 4 }));
  } else {
    // Repeated quantiles must share one anchor to avoid a color jump at a tie.
    const groups = [];
    SCORE_PALETTE.forEach((color, index) => {
      const value = quantile(sorted, index / 4);
      const last = groups.at(-1);
      if (last?.value === value) last.lastIndex = index;
      else groups.push({ value, firstIndex: index, lastIndex: index });
    });
    stops = groups.map(({ value, firstIndex, lastIndex }) => ({
      value,
      color: value === min ? SCORE_PALETTE[0] : value === max ? SCORE_PALETTE.at(-1) : paletteColor((firstIndex + lastIndex) / 8),
      position: (value - min) / (max - min),
    }));
  }

  const channels = stops.map(({ color }) => rgb(color));
  return {
    stops,
    domain,
    total,
    color(value) {
      const score = clampScore(value);
      if (score === null || (!absolute && !total)) return NO_DATA_COLOR;
      if (score <= min) return stops[0].color;
      if (score >= max) return stops.at(-1).color;
      const upper = stops.findIndex((stop) => stop.value >= score);
      const lower = upper - 1;
      return interpolateRgb(channels[lower], channels[upper], (score - stops[lower].value) / (stops[upper].value - stops[lower].value));
    },
  };
}
