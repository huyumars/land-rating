// polygon-clipping 0.15.7, official UMD distribution, MIT.
// Source: https://github.com/mfogel/polygon-clipping/tree/v0.15.7
// The upstream bundle and its license notices are preserved in ../vendor/.
import '../vendor/polygon-clipping.umd.min.js';

const { intersection } = globalThis.polygonClipping;

function polygonCoordinates(boundary) {
  const polygons = [];
  const add = (value) => {
    if (!value) return;
    if (value.type === 'Feature') return add(value.geometry);
    if (value.type === 'FeatureCollection') return value.features.forEach(add);
    if (value.type === 'MultiPolygon') return value.coordinates.forEach((coordinates) => add({ type: 'Polygon', coordinates }));
    if (value.type !== 'Polygon') throw new TypeError('裁切边界必须为 Polygon 或 MultiPolygon。');
    if (!value.coordinates.length || !value.coordinates[0].length) return;
    for (const ring of value.coordinates) {
      if (!Array.isArray(ring) || ring.length < 3 || ring.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
        throw new TypeError('裁切边界需要有效的多边形坐标环。');
      }
    }
    polygons.push(value.coordinates);
  };
  add(boundary);
  return polygons;
}

/**
 * Index every boundary segment into conservative metric grid buckets once.
 * If no boundary segment touches a cell and its center is already inside,
 * continuity guarantees the entire cell is inside, including around holes.
 * Interior cells can keep the original square; all possible edge cells use
 * full polygon intersection, which preserves holes and disconnected pieces.
 */
export function createGridClipper(boundary, { project, gridSize, minColumn, maxColumn, minRow, maxRow }) {
  const polygons = polygonCoordinates(boundary);
  const boundaryCells = new Set();
  const margin = 1e-7;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const points = ring.map(project);
      for (let i = 0; i < points.length; i += 1) {
        const first = points[i];
        const second = points[(i + 1) % points.length];
        const west = Math.max(minColumn, Math.floor((Math.min(first[0], second[0]) - margin) / gridSize));
        const east = Math.min(maxColumn, Math.floor((Math.max(first[0], second[0]) + margin) / gridSize));
        const south = Math.max(minRow, Math.floor((Math.min(first[1], second[1]) - margin) / gridSize));
        const north = Math.min(maxRow, Math.floor((Math.max(first[1], second[1]) + margin) / gridSize));
        for (let row = south; row <= north; row += 1) {
          for (let column = west; column <= east; column += 1) boundaryCells.add(`${column}:${row}`);
        }
      }
    }
  }
  return (ring, column, row) => {
    if (!boundaryCells.has(`${column}:${row}`)) return { type: 'Polygon', coordinates: [ring] };
    const coordinates = intersection([ring], polygons);
    if (!coordinates.length) return null;
    return coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0] } : { type: 'MultiPolygon', coordinates };
  };
}
