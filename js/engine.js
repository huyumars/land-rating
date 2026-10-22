/** Pure, offline distance and scoring functions. Coordinates are WGS84. */
export const EARTH_RADIUS_METERS = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const REFERENCE = Object.freeze([121.47, 31.23]);
const X_METERS_PER_DEGREE = EARTH_RADIUS_METERS * DEG_TO_RAD * Math.cos(REFERENCE[1] * DEG_TO_RAD);
const Y_METERS_PER_DEGREE = EARTH_RADIUS_METERS * DEG_TO_RAD;

export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'cafe', label: '咖啡店', color: '#d49657', defaultWeight: 15, good: 200, max: 1500 }),
  Object.freeze({ id: 'mall', label: '商场', color: '#b586b8', defaultWeight: 20, good: 500, max: 3000 }),
  Object.freeze({ id: 'school', label: '学校', color: '#62a69a', defaultWeight: 25, good: 500, max: 2500 }),
  Object.freeze({ id: 'metro', label: '地铁', color: '#6797cf', defaultWeight: 40, good: 300, max: 2000 }),
]);

export const DEFAULT_SETTINGS = Object.freeze({
  gridSize: 250,
  weights: Object.freeze(Object.fromEntries(CATEGORIES.map((category) => [category.id, category.defaultWeight]))),
  thresholds: Object.freeze(Object.fromEntries(CATEGORIES.map((category) => [category.id, Object.freeze({ good: category.good, max: category.max })]))),
});

const CATEGORY_IDS = CATEGORIES.map((category) => category.id);

function isCoordinate(coordinates) {
  return Array.isArray(coordinates) && coordinates.length >= 2
    && Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1])
    && coordinates[0] >= -180 && coordinates[0] <= 180
    && coordinates[1] >= -90 && coordinates[1] <= 90;
}

/** A local metric projection, anchored once so grid cells stay fixed when panning. */
export function project(coordinates) {
  if (!isCoordinate(coordinates)) throw new TypeError('坐标必须为有效的 [经度, 纬度]。');
  return [(coordinates[0] - REFERENCE[0]) * X_METERS_PER_DEGREE, (coordinates[1] - REFERENCE[1]) * Y_METERS_PER_DEGREE];
}

export function unproject(coordinates) {
  if (!Array.isArray(coordinates) || !coordinates.slice(0, 2).every(Number.isFinite)) throw new TypeError('投影坐标必须为有限数。');
  return [REFERENCE[0] + coordinates[0] / X_METERS_PER_DEGREE, REFERENCE[1] + coordinates[1] / Y_METERS_PER_DEGREE];
}

function toUnitSphere([longitude, latitude]) {
  const lon = longitude * DEG_TO_RAD;
  const lat = latitude * DEG_TO_RAD;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function squaredDistance(left, right) {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

function buildKdTree(points, depth = 0) {
  if (!points.length) return null;
  const axis = depth % 3;
  points.sort((left, right) => left.unit[axis] - right.unit[axis]);
  const middle = Math.floor(points.length / 2);
  return {
    point: points[middle],
    axis,
    left: buildKdTree(points.slice(0, middle), depth + 1),
    right: buildKdTree(points.slice(middle + 1), depth + 1),
  };
}

/**
 * A 3D unit-sphere KD tree gives the exact nearest great-circle neighbour:
 * chord distance and great-circle distance have the same ordering. No latitude
 * distortion or approximate shortlist is used to select the winning POI.
 */
export function buildPoiIndex(featureCollection) {
  if (featureCollection?.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
    throw new TypeError('设施数据必须是 GeoJSON FeatureCollection。');
  }
  const grouped = Object.fromEntries(CATEGORY_IDS.map((id) => [id, []]));
  let skipped = 0;
  featureCollection.features.forEach((feature, position) => {
    const coordinates = feature?.geometry?.coordinates;
    const category = feature?.properties?.category;
    if (feature?.geometry?.type !== 'Point' || !isCoordinate(coordinates) || !Object.hasOwn(grouped, category)) {
      skipped += 1;
      return;
    }
    const pointCoordinates = coordinates.slice(0, 2);
    grouped[category].push({
      poiId: String(feature.id ?? feature.properties.id ?? `${category}:${position}`),
      name: String(feature.properties.name || CATEGORIES.find((entry) => entry.id === category).label),
      coordinates: pointCoordinates,
      unit: toUnitSphere(pointCoordinates),
    });
  });
  return {
    counts: Object.fromEntries(CATEGORY_IDS.map((id) => [id, grouped[id].length])),
    trees: Object.fromEntries(CATEGORY_IDS.map((id) => [id, buildKdTree(grouped[id])])),
    skipped,
  };
}

export function findNearest(index, category, coordinates) {
  if (!CATEGORY_IDS.includes(category)) throw new RangeError(`未知设施类别：${category}`);
  if (!isCoordinate(coordinates)) throw new TypeError('坐标必须为有效的 [经度, 纬度]。');
  const tree = index?.trees?.[category];
  if (!tree) return null;
  const query = toUnitSphere(coordinates);
  let best = null;
  let bestSquared = Infinity;
  const visit = (node) => {
    if (!node) return;
    const distance = squaredDistance(query, node.point.unit);
    if (distance < bestSquared) {
      bestSquared = distance;
      best = node.point;
    }
    const delta = query[node.axis] - node.point.unit[node.axis];
    visit(delta <= 0 ? node.left : node.right);
    if (delta * delta <= bestSquared) visit(delta <= 0 ? node.right : node.left);
  };
  visit(tree);
  return {
    distance: EARTH_RADIUS_METERS * 2 * Math.asin(Math.min(1, Math.sqrt(bestSquared) / 2)),
    poiId: best.poiId,
    name: best.name,
    coordinates: [...best.coordinates],
  };
}

/** Great-circle surface distance in meters; no route or road assumption. */
export function surfaceDistance(left, right) {
  if (!isCoordinate(left) || !isCoordinate(right)) throw new TypeError('距离计算需要有效经纬度。');
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.min(1, Math.sqrt(squaredDistance(toUnitSphere(left), toUnitSphere(right))) / 2));
}

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]) < 1e-10;
  if (Math.abs(cross) > 1e-10 * length) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-10 && point[0] <= Math.max(start[0], end[0]) + 1e-10
    && point[1] >= Math.min(start[1], end[1]) - 1e-10 && point[1] <= Math.max(start[1], end[1]) + 1e-10;
}

function inRing(point, ring) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const start = ring[previous];
    const end = ring[current];
    if (pointOnSegment(point, start, end)) return true;
    if ((start[1] > point[1]) !== (end[1] > point[1])
      && point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]) inside = !inside;
  }
  return inside;
}

function inPolygon(point, rings) {
  return Boolean(rings.length && inRing(point, rings[0]) && !rings.slice(1).some((hole) => inRing(point, hole)));
}

/** Boundary filtering uses cell centers; polygons are kept as complete squares. */
export function pointInBoundary(point, boundary) {
  if (!boundary) return true;
  if (boundary.type === 'Feature') return pointInBoundary(point, boundary.geometry);
  if (boundary.type === 'FeatureCollection') return boundary.features.some((feature) => pointInBoundary(point, feature));
  if (boundary.type === 'Polygon') return inPolygon(point, boundary.coordinates);
  if (boundary.type === 'MultiPolygon') return boundary.coordinates.some((polygon) => inPolygon(point, polygon));
  throw new TypeError('边界必须为 Polygon 或 MultiPolygon。');
}

function boundaryPredicate(boundary, emptyResult = true) {
  if (!boundary) return () => emptyResult;
  const polygons = [];
  const add = (value) => {
    if (!value) return;
    if (value.type === 'Feature') return add(value.geometry);
    if (value.type === 'FeatureCollection') return value.features.forEach(add);
    if (value.type === 'MultiPolygon') return value.coordinates.forEach((coordinates) => add({ type: 'Polygon', coordinates }));
    if (value.type !== 'Polygon') throw new TypeError('边界必须为 Polygon 或 MultiPolygon。');
    if (!value.coordinates.length || !value.coordinates[0].length) return;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    value.coordinates[0].forEach(([lon, lat]) => {
      bounds[0] = Math.min(bounds[0], lon);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lon);
      bounds[3] = Math.max(bounds[3], lat);
    });
    polygons.push({ bounds, rings: value.coordinates });
  };
  add(boundary);
  return (point) => polygons.some(({ bounds, rings }) => point[0] >= bounds[0] && point[0] <= bounds[2]
    && point[1] >= bounds[1] && point[1] <= bounds[3] && inPolygon(point, rings));
}

export function calculateGrid({ bbox, gridSize = DEFAULT_SETTINGS.gridSize, index, categories = CATEGORY_IDS, boundary = null, excludeBoundary = null }) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
    || !isCoordinate(bbox.slice(0, 2)) || !isCoordinate(bbox.slice(2, 4))
    || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new RangeError('分析范围必须为 [西, 南, 东, 北]，且范围不能为空。');
  if (!Number.isFinite(gridSize) || gridSize <= 0) throw new RangeError('网格边长必须大于 0 米。');
  if (!Array.isArray(categories) || categories.some((id) => !CATEGORY_IDS.includes(id))) throw new RangeError('分析类别无效。');
  const categoryIds = [...new Set(categories)];
  const [minX, minY] = project(bbox.slice(0, 2));
  const [maxX, maxY] = project(bbox.slice(2, 4));
  const minColumn = Math.floor(minX / gridSize);
  const maxColumn = Math.ceil(maxX / gridSize) - 1;
  const minRow = Math.floor(minY / gridSize);
  const maxRow = Math.ceil(maxY / gridSize) - 1;
  // Defend against an accidental input that would freeze a browser tab.
  if ((maxColumn - minColumn + 1) * (maxRow - minRow + 1) > 100_000) throw new RangeError('网格数量超过 100,000，请缩小范围或增加网格边长。');
  // Precompute polygon bounds once: most water polygons can be skipped cheaply.
  const inside = boundaryPredicate(boundary);
  const excluded = boundaryPredicate(excludeBoundary, false);
  const features = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const x = column * gridSize;
      const y = row * gridSize;
      const center = unproject([x + gridSize / 2, y + gridSize / 2]);
      if (center[0] < bbox[0] || center[0] > bbox[2] || center[1] < bbox[1] || center[1] > bbox[3] || !inside(center) || excluded(center)) continue;
      const corners = [[x, y], [x + gridSize, y], [x + gridSize, y + gridSize], [x, y + gridSize], [x, y]].map(unproject);
      const id = `${gridSize}:${column}:${row}`;
      features.push({
        type: 'Feature', id,
        geometry: { type: 'Polygon', coordinates: [corners] },
        properties: {
          id, center,
          distances: Object.fromEntries(categoryIds.map((category) => [category, findNearest(index, category, center)])),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features, metadata: { bbox: [...bbox], gridSize, categories: categoryIds, projection: 'local-equirectangular-31.23', boundaryMode: 'center' } };
}

export function validateSettings(settings = {}) {
  const weights = { ...DEFAULT_SETTINGS.weights, ...settings.weights };
  const thresholds = Object.fromEntries(CATEGORY_IDS.map((id) => [id, { ...DEFAULT_SETTINGS.thresholds[id], ...settings.thresholds?.[id] }]));
  for (const id of CATEGORY_IDS) {
    if (!Number.isFinite(weights[id]) || weights[id] < 0) throw new RangeError(`${id} 权重必须为非负数。`);
    const { good, max } = thresholds[id];
    if (!Number.isFinite(good) || !Number.isFinite(max) || good < 0 || max <= good) throw new RangeError(`${id} 的满分距离须不小于 0，零分距离须大于满分距离。`);
  }
  return { ...DEFAULT_SETTINGS, ...settings, weights, thresholds };
}

function categoryScore(distance, { good, max }) {
  if (!Number.isFinite(distance) || distance < 0) return null;
  if (distance <= good) return 100;
  if (distance >= max) return 0;
  return (max - distance) / (max - good) * 100;
}

/** Rescoring never changes the input grid or repeats distance calculations. */
export function scoreGrid(grid, settings = DEFAULT_SETTINGS) {
  const normalized = validateSettings(settings);
  const activeCategories = CATEGORY_IDS.filter((id) => normalized.weights[id] > 0);
  const totalWeight = activeCategories.reduce((sum, id) => sum + normalized.weights[id], 0);
  return {
    ...grid,
    metadata: { ...grid.metadata, scoring: { weights: normalized.weights, thresholds: normalized.thresholds } },
    features: grid.features.map((feature) => {
      const distances = feature.properties.distances ?? {};
      const scores = Object.fromEntries(CATEGORY_IDS.map((id) => [id, categoryScore(distances[id]?.distance, normalized.thresholds[id])]));
      const validCategories = activeCategories.filter((id) => scores[id] !== null);
      const missingCategories = activeCategories.filter((id) => scores[id] === null);
      const validWeight = validCategories.reduce((sum, id) => sum + normalized.weights[id], 0);
      const weightedScore = validCategories.reduce((sum, id) => sum + scores[id] * normalized.weights[id], 0);
      const partialScore = validWeight ? Math.round(weightedScore / validWeight * 10) / 10 : null;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          score: totalWeight > 0 && missingCategories.length === 0 ? partialScore : null,
          partialScore, scores, validCategories, missingCategories,
          coverage: totalWeight > 0 ? validWeight / totalWeight : 0,
        },
      };
    }),
  };
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  let result = String(value);
  // Names are external data. Prevent spreadsheet formula execution on import.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(result)) result = `'${result}`;
  return /[",\n\r]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}

export function gridToCsv(grid, { bom = true } = {}) {
  const columns = ['cell_id', 'longitude', 'latitude', 'score', 'partial_score', 'coverage', ...CATEGORY_IDS.flatMap((id) => [`${id}_distance_m`, `${id}_name`, `${id}_poi_id`])];
  const rows = grid.features.map(({ properties }) => {
    const coordinates = properties.center ?? [];
    return [properties.id, coordinates[0], coordinates[1], properties.score, properties.partialScore, properties.coverage,
      ...CATEGORY_IDS.flatMap((id) => {
        const nearest = properties.distances?.[id];
        return [nearest ? Math.round(nearest.distance) : null, nearest?.name, nearest?.poiId];
      })];
  });
  return `${bom ? '\uFEFF' : ''}${[columns, ...rows].map((row) => row.map(csvValue).join(',')).join('\r\n')}\r\n`;
}
