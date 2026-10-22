import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, DEFAULT_SETTINGS, EARTH_RADIUS_METERS, buildPoiIndex, findNearest, countNearby, surfaceDistance,
  project, unproject, pointInBoundary, calculateGrid, scoreGrid, gridToCsv, validateSettings,
} from '../js/engine.js';

const collection = (features = []) => ({ type: 'FeatureCollection', features });
const poi = (category, coordinates, name = category, id = `${category}:${coordinates}`) => ({
  type: 'Feature', id, properties: { category, name }, geometry: { type: 'Point', coordinates },
});
const oneCell = (distances, nearbyCounts) => collection([{ type: 'Feature', geometry: null, properties: { id: 'test', center: [121.47, 31.23], distances, ...(nearbyCounts ? { nearbyCounts } : {}) } }]);
const distanceEntries = (values) => Object.fromEntries(Object.entries(values).map(([id, distance]) => [id, distance === null ? null : { distance, name: id, poiId: id }]));
const metricBbox = (minX, minY, maxX, maxY) => [...unproject([minX, minY]), ...unproject([maxX, maxY])];
const weights = (overrides = {}) => ({ ...Object.fromEntries(CATEGORIES.map(({ id }) => [id, 0])), ...overrides });

test('surface distance has correct units, symmetry, zero, and latitude scaling', () => {
  assert.equal(surfaceDistance([121.47, 31.23], [121.47, 31.23]), 0);
  const north = surfaceDistance([121.47, 31.23], [121.47, 31.24]);
  assert.ok(Math.abs(north - 1111.95) < 0.1);
  assert.ok(Math.abs(surfaceDistance([121.47, 31.23], [121.48, 31.23]) - 950.8) < 1);
  const equator = surfaceDistance([0, 0], [1, 0]);
  const highLatitude = surfaceDistance([0, 60], [1, 60]);
  assert.ok(Math.abs(highLatitude / equator - 0.5) < 0.001);
  assert.equal(surfaceDistance([1, 2], [4, 5]), surfaceDistance([4, 5], [1, 2]));
});

test('spatial index chooses actual spherical nearest across latitudes and dateline', () => {
  const index = buildPoiIndex(collection([
    poi('cafe', [1, 60], 'east'), poi('cafe', [0, 60.6], 'north'),
    poi('metro', [-179.99, 0], 'across dateline'), poi('metro', [179, 0], 'same side'),
  ]));
  assert.equal(findNearest(index, 'cafe', [0, 60]).name, 'east');
  assert.equal(findNearest(index, 'metro', [179.99, 0]).name, 'across dateline');
  assert.ok(findNearest(index, 'metro', [179.99, 0]).distance < 2300);
  assert.equal(findNearest(index, 'mall', [0, 0]), null);
});

test('KD nearest agrees with exhaustive surface distances on varied coordinates', () => {
  let seed = 31;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const points = Array.from({ length: 250 }, (_, id) => poi('school', [random() * 360 - 180, random() * 170 - 85], `school-${id}`, id));
  const index = buildPoiIndex(collection(points));
  for (let i = 0; i < 30; i += 1) {
    const query = [random() * 360 - 180, random() * 170 - 85];
    const expected = points.reduce((best, candidate) => surfaceDistance(query, candidate.geometry.coordinates) < surfaceDistance(query, best.geometry.coordinates) ? candidate : best);
    assert.equal(findNearest(index, 'school', query).poiId, String(expected.id));
  }
});

test('invalid and unsupported POIs are skipped without altering input', () => {
  const data = collection([poi('cafe', [121.5, 31.2]), poi('school', [181, 0]), poi('unknown', [0, 0])]);
  const before = structuredClone(data);
  const index = buildPoiIndex(data);
  assert.deepEqual(data, before);
  assert.equal(index.counts.cafe, 1);
  assert.equal(index.counts.school, 0);
  assert.equal(index.skipped, 2);
});

test('local grid is fixed to metric origin across overlapping requests', () => {
  const index = buildPoiIndex(collection());
  const larger = calculateGrid({ bbox: metricBbox(1, 1, 999, 999), gridSize: 250, index });
  const smaller = calculateGrid({ bbox: metricBbox(251, 251, 749, 749), gridSize: 250, index });
  assert.equal(larger.features.length, 16);
  assert.equal(smaller.features.length, 4);
  for (const cell of smaller.features) {
    assert.deepEqual(cell, larger.features.find((candidate) => candidate.id === cell.id));
  }
  const cell = larger.features[0];
  const corners = cell.geometry.coordinates[0].map(project);
  assert.ok(Math.abs(corners[1][0] - corners[0][0] - 250) < 1e-6);
  assert.ok(Math.abs(corners[2][1] - corners[1][1] - 250) < 1e-6);
  assert.ok(cell.properties.center[0] > 121.47);
});

test('changing grid size recalculates independent cells and distances locally', () => {
  const index = buildPoiIndex(collection([poi('cafe', unproject([125, 125]))]));
  const bbox = metricBbox(1, 1, 999, 999);
  const coarse = calculateGrid({ bbox, gridSize: 500, index });
  const fine = calculateGrid({ bbox, gridSize: 250, index });
  assert.equal(coarse.features.length, 4);
  assert.equal(fine.features.length, 16);
  assert.equal(fine.features[0].properties.distances.cafe.distance, 0);
  assert.ok(coarse.features[0].properties.distances.cafe.distance > 170);
});

test('boundary supports holes and multipolygons and filters cell centers', () => {
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
  const boundary = { type: 'Polygon', coordinates: [outer, hole] };
  assert.equal(pointInBoundary([0.5, 0.5], boundary), true);
  assert.equal(pointInBoundary([2, 2], boundary), false);
  assert.equal(pointInBoundary([5, 5], boundary), false);
  assert.equal(pointInBoundary([0, 2], boundary), true);
  assert.equal(pointInBoundary([0.5, 0.5], { type: 'MultiPolygon', coordinates: [[outer, hole]] }), true);
  const localBoundary = { type: 'Polygon', coordinates: [[unproject([0, 0]), unproject([500, 0]), unproject([500, 500]), unproject([0, 500]), unproject([0, 0])]] };
  const grid = calculateGrid({ bbox: metricBbox(1, 1, 999, 999), gridSize: 250, index: buildPoiIndex(collection()), boundary: localBoundary });
  assert.equal(grid.features.length, 4);
  const landGrid = calculateGrid({ bbox: metricBbox(1, 1, 999, 999), gridSize: 250, index: buildPoiIndex(collection()), excludeBoundary: collection([{ type: 'Feature', geometry: localBoundary, properties: {} }]) });
  assert.equal(landGrid.features.length, 12);
});

test('score is normalized by active weights and rescoring preserves distances/input', () => {
  const grid = oneCell(distanceEntries({ cafe: 200, mall: 3000, school: 1500, metro: 300 }));
  const before = structuredClone(grid);
  const scored = scoreGrid(grid, { weights: weights({ cafe: 1, mall: 1 }), quantityWeight: 0 });
  assert.equal(scored.features[0].properties.score, 50);
  assert.equal(scored.features[0].properties.coverage, 1);
  assert.deepEqual(scored.features[0].properties.validCategories, ['cafe', 'mall']);
  assert.deepEqual(grid, before);
  assert.equal(scored.features[0].properties.distances, grid.features[0].properties.distances);
  const rescored = scoreGrid(grid, { weights: weights({ cafe: 3, mall: 1 }), quantityWeight: 0 });
  assert.equal(rescored.features[0].properties.score, 75);
});

test('unknown data is never converted to zero; partial score is explicit', () => {
  const grid = oneCell(distanceEntries({ cafe: 200, mall: null, school: null, metro: null }));
  const result = scoreGrid(grid, { quantityWeight: 0 }).features[0].properties;
  assert.equal(result.score, null);
  assert.equal(result.partialScore, 100);
  assert.equal(result.scores.mall, null);
  assert.equal(result.coverage, 0.1);
  assert.deepEqual(result.missingCategories, ['mall', 'school', 'metro', 'sports', 'library']);
  const empty = scoreGrid(oneCell({})).features[0].properties;
  assert.equal(empty.score, null);
  assert.equal(empty.partialScore, null);
  assert.equal(empty.coverage, 0);
});

test('zero weights can disable unknown categories; all-zero weights yields no score', () => {
  const grid = oneCell(distanceEntries({ cafe: 200 }));
  assert.equal(scoreGrid(grid, { weights: weights({ cafe: 1 }), quantityWeight: 0 }).features[0].properties.score, 100);
  const zero = scoreGrid(grid, { weights: weights(), quantityWeight: 0 }).features[0].properties;
  assert.equal(zero.score, null);
  assert.equal(zero.partialScore, null);
  assert.equal(zero.coverage, 0);
});

test('score thresholds are continuous and settings reject invalid values', () => {
  const grid = oneCell(distanceEntries({ cafe: 500 }));
  const settings = { weights: weights({ cafe: 1 }), quantityWeight: 0, thresholds: { cafe: { good: 0, max: 1000 } } };
  assert.equal(scoreGrid(grid, settings).features[0].properties.score, 50);
  assert.throws(() => scoreGrid(grid, { weights: { cafe: -1 } }), /权重/);
  assert.throws(() => scoreGrid(grid, { thresholds: { cafe: { good: 1000, max: 1000 } } }), /满分距离/);
  assert.throws(() => scoreGrid(grid, { thresholds: { cafe: { good: NaN } } }), /满分距离/);
  assert.throws(() => calculateGrid({ bbox: [0, 0, 1, 1], gridSize: 0 }), /网格边长/);
  assert.equal(CATEGORIES.length, 6);
  assert.equal(DEFAULT_SETTINGS.gridSize, 250);
  assert.equal(DEFAULT_SETTINGS.countRadius, 1000);
  assert.equal(DEFAULT_SETTINGS.quantityWeight, 30);
  assert.equal(Object.values(DEFAULT_SETTINGS.weights).reduce((sum, value) => sum + value, 0), 100);
});

test('CSV preserves missing distances, quotes names and protects formulas', () => {
  const grid = oneCell({ cafe: { distance: 123.45, name: '=HYPERLINK("x")', poiId: 'coffee' } });
  const result = gridToCsv(scoreGrid(grid));
  assert.ok(result.startsWith('\uFEFFcell_id,'));
  assert.ok(result.includes('123,"\'=HYPERLINK(""x"")",coffee'));
  assert.equal(result.split('\r\n')[1].split(',').slice(-6).join(','), ',,,,,');
  assert.ok(!gridToCsv(grid, { bom: false }).startsWith('\uFEFF'));
});

test('more distinct nearby facilities score higher at the same nearest distance, with a cap', () => {
  const center = unproject([125, 125]);
  const features = Array.from({ length: 7 }, (_, id) => poi('cafe', [center[0], center[1] + (100 + id * 80) / EARTH_RADIUS_METERS * 180 / Math.PI], `cafe-${id}`, `cafe-${id}`));
  const calculate = (subset) => calculateGrid({ bbox: metricBbox(1, 1, 249, 249), index: buildPoiIndex(collection(subset)), countRadius: 1000 });
  const single = calculate(features.slice(0, 1));
  const multiple = calculate(features.slice(0, 5));
  const beyondTarget = calculate(features);
  const settings = { weights: weights({ cafe: 1 }), quantityWeight: 30 };
  const one = scoreGrid(single, settings).features[0].properties;
  const five = scoreGrid(multiple, settings).features[0].properties;
  const seven = scoreGrid(beyondTarget, settings).features[0].properties;
  assert.equal(one.distances.cafe.distance, five.distances.cafe.distance);
  assert.equal(one.nearbyCounts.cafe, 1);
  assert.equal(five.nearbyCounts.cafe, 5);
  assert.equal(one.distanceScores.cafe, 100);
  assert.equal(one.quantityScores.cafe, 20);
  assert.equal(one.score, 76);
  assert.equal(five.score, 100);
  assert.equal(seven.score, 100);
  assert.equal(scoreGrid(single, { ...settings, quantityWeight: 0 }).features[0].properties.score, 100);
  assert.equal(scoreGrid(single, { ...settings, quantityWeight: 100 }).features[0].properties.score, 20);
});

test('radius query includes the boundary and counts known zero separately from unknown', () => {
  const center = [121.47, 31.23];
  const north = (meters) => [center[0], center[1] + meters / EARTH_RADIUS_METERS * 180 / Math.PI];
  const index = buildPoiIndex(collection([
    poi('sports', north(0), 'here', 'here'),
    poi('sports', north(999.999), 'inside', 'inside'),
    poi('sports', north(1000), 'edge', 'edge'),
    poi('sports', north(1000.001), 'outside', 'outside'),
    poi('library', north(2000), 'far', 'far'),
  ]));
  assert.equal(countNearby(index, 'sports', center, 1000), 3);
  assert.equal(countNearby(index, 'sports', center, 0), 1);
  assert.equal(countNearby(index, 'library', center, 1000), 0);
  assert.equal(countNearby(index, 'cafe', center, 1000), null);
  const knownZero = oneCell({ library: findNearest(index, 'library', center) }, { library: 0 });
  const scored = scoreGrid(knownZero, { weights: weights({ library: 1 }) }).features[0].properties;
  assert.equal(scored.quantityScores.library, 0);
  assert.ok(scored.score > 0 && scored.score < scored.distanceScores.library);
  assert.throws(() => countNearby(index, 'library', center, -1), /半径/);
});

test('duplicate ids are ignored while distinct station entrances retain the closest point and count one station', () => {
  const point = (id, meters, groupId, useLegacyGroup = false) => {
    const entry = poi('metro', [121.47, 31.23 + meters / EARTH_RADIUS_METERS * 180 / Math.PI], id, id);
    entry.properties[useLegacyGroup ? 'facilityGroupId' : 'groupId'] = groupId;
    return entry;
  };
  const data = collection([
    point('station-a-far', 700, 'station-a'),
    point('station-a-close', 100, 'station-a'),
    point('station-a-close', 10, 'fake-duplicate'),
    point('station-b', 800, 'station-b', true),
    point('station-c', 1200, 'station-c'),
  ]);
  const before = structuredClone(data);
  const index = buildPoiIndex(data);
  assert.equal(index.counts.metro, 4);
  assert.equal(index.groupCounts.metro, 3);
  assert.equal(index.duplicates, 1);
  assert.equal(index.skipped, 1);
  const nearest = findNearest(index, 'metro', [121.47, 31.23]);
  assert.equal(nearest.poiId, 'station-a-close');
  assert.equal(nearest.groupId, 'station-a');
  assert.ok(Math.abs(nearest.distance - 100) < 0.001);
  assert.equal(countNearby(index, 'metro', [121.47, 31.23], 1000), 2);
  assert.equal(countNearby(index, 'metro', [121.47, 31.23], 1500), 3);
  assert.deepEqual(data, before);
});

test('KD radius query agrees with exhaustive grouped counts across the globe', () => {
  let seed = 61;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const points = Array.from({ length: 300 }, (_, id) => {
    const feature = poi('library', [random() * 360 - 180, random() * 170 - 85], `library-${id}`, id);
    feature.properties.groupId = `building-${Math.floor(id / 2)}`;
    return feature;
  });
  const index = buildPoiIndex(collection(points));
  for (let i = 0; i < 20; i += 1) {
    const query = [random() * 360 - 180, random() * 170 - 85];
    const radius = random() * Math.PI * EARTH_RADIUS_METERS;
    const expected = new Set(points.filter((point) => surfaceDistance(query, point.geometry.coordinates) <= radius).map((point) => point.properties.groupId)).size;
    assert.equal(countNearby(index, 'library', query, radius), expected);
  }
  assert.equal(countNearby(index, 'library', [179.99, 80], 2 * Math.PI * EARTH_RADIUS_METERS), 150);
});

test('all six categories produce counts and scores while absent data stays null', () => {
  const center = unproject([125, 125]);
  const index = buildPoiIndex(collection(CATEGORIES.map(({ id }) => poi(id, center))));
  const grid = calculateGrid({ bbox: metricBbox(1, 1, 249, 249), index });
  const scored = scoreGrid(grid).features[0].properties;
  assert.equal(grid.metadata.countRadius, 1000);
  assert.equal(Object.keys(scored.nearbyCounts).length, 6);
  assert.equal(scored.coverage, 1);
  assert.ok(scored.score >= 70 && scored.score <= 100);
  for (const { id } of CATEGORIES) {
    assert.equal(scored.nearbyCounts[id], 1);
    assert.equal(scored.distanceScores[id], 100);
    assert.ok(scored.quantityScores[id] > 0 && scored.quantityScores[id] <= 100);
    assert.ok(scored.scores[id] > 70 && scored.scores[id] <= 100);
  }
  const empty = scoreGrid(calculateGrid({ bbox: metricBbox(1, 1, 249, 249), index: buildPoiIndex(collection()) })).features[0].properties;
  assert.equal(empty.score, null);
  assert.equal(empty.partialScore, null);
  assert.equal(empty.coverage, 0);
  for (const { id } of CATEGORIES) {
    assert.equal(empty.nearbyCounts[id], null);
    assert.equal(empty.quantityScores[id], null);
    assert.equal(empty.distanceScores[id], null);
  }
});

test('old grids and changed radius cannot manufacture quantity data from the nearest POI', () => {
  const oldGrid = oneCell(distanceEntries({ sports: 100 }));
  const settings = { weights: weights({ sports: 1 }) };
  const unknown = scoreGrid(oldGrid, settings).features[0].properties;
  assert.equal(unknown.score, null);
  assert.equal(unknown.distanceScores.sports, 100);
  assert.equal(unknown.quantityScores.sports, null);
  assert.equal(scoreGrid(oldGrid, { ...settings, quantityWeight: 0 }).features[0].properties.score, 100);
  const grid = oneCell(distanceEntries({ sports: 100 }), { sports: 3 });
  grid.metadata = { countRadius: 1000 };
  const before = structuredClone(grid);
  const rescore = scoreGrid(grid, { ...settings, quantityWeight: 50, thresholds: { sports: { targetCount: 3 } } });
  assert.equal(rescore.features[0].properties.score, 100);
  assert.equal(rescore.features[0].properties.distances, grid.features[0].properties.distances);
  assert.equal(rescore.features[0].properties.nearbyCounts, grid.features[0].properties.nearbyCounts);
  assert.deepEqual(grid, before);
  const changedRadius = scoreGrid(grid, { ...settings, countRadius: 2000 });
  assert.equal(changedRadius.features[0].properties.score, null);
  assert.equal(changedRadius.features[0].properties.quantityScores.sports, null);
});

test('quantity targets, mix percentages and radii are validated', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => validateSettings({ thresholds: { sports: { targetCount: value } } }), /数量/);
  for (const value of [-1, 101, NaN, Infinity]) assert.throws(() => validateSettings({ quantityWeight: value }), /权重/);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => validateSettings({ countRadius: value }), /半径/);
  assert.equal(validateSettings({ quantityWeight: 0, countRadius: 0 }).quantityWeight, 0);
  assert.equal(validateSettings({ quantityWeight: 100 }).quantityWeight, 100);
});

test('CSV exports counts, component scores and the actual calculation radius and mix', () => {
  const grid = oneCell(distanceEntries({ sports: 100 }), { sports: 4 });
  grid.metadata = { countRadius: 500 };
  const scored = scoreGrid(grid, { weights: weights({ sports: 1 }), quantityWeight: 25, countRadius: 500 });
  const [header, data] = gridToCsv(scored, { bom: false }).trim().split('\r\n').map((row) => row.split(','));
  const row = Object.fromEntries(header.map((column, i) => [column, data[i]]));
  assert.equal(row.count_radius_m, '500');
  assert.equal(row.quantity_weight_pct, '25');
  assert.equal(row.sports_nearby_count, '4');
  assert.equal(row.sports_distance_score, '100');
  assert.equal(row.sports_quantity_score, '80');
  assert.equal(row.library_nearby_count, '');
});
