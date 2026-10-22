import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, DEFAULT_SETTINGS, buildPoiIndex, findNearest, surfaceDistance,
  project, unproject, pointInBoundary, calculateGrid, scoreGrid, gridToCsv,
} from '../js/engine.js';

const collection = (features = []) => ({ type: 'FeatureCollection', features });
const poi = (category, coordinates, name = category, id = `${category}:${coordinates}`) => ({
  type: 'Feature', id, properties: { category, name }, geometry: { type: 'Point', coordinates },
});
const oneCell = (distances) => collection([{ type: 'Feature', geometry: null, properties: { id: 'test', center: [121.47, 31.23], distances } }]);
const distanceEntries = (values) => Object.fromEntries(Object.entries(values).map(([id, distance]) => [id, distance === null ? null : { distance, name: id, poiId: id }]));
const metricBbox = (minX, minY, maxX, maxY) => [...unproject([minX, minY]), ...unproject([maxX, maxY])];

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
  const scored = scoreGrid(grid, { weights: { cafe: 1, mall: 1, school: 0, metro: 0 } });
  assert.equal(scored.features[0].properties.score, 50);
  assert.equal(scored.features[0].properties.coverage, 1);
  assert.deepEqual(scored.features[0].properties.validCategories, ['cafe', 'mall']);
  assert.deepEqual(grid, before);
  assert.equal(scored.features[0].properties.distances, grid.features[0].properties.distances);
  const rescored = scoreGrid(grid, { weights: { cafe: 3, mall: 1, school: 0, metro: 0 } });
  assert.equal(rescored.features[0].properties.score, 75);
});

test('unknown data is never converted to zero; partial score is explicit', () => {
  const grid = oneCell(distanceEntries({ cafe: 200, mall: null, school: null, metro: null }));
  const result = scoreGrid(grid).features[0].properties;
  assert.equal(result.score, null);
  assert.equal(result.partialScore, 100);
  assert.equal(result.scores.mall, null);
  assert.equal(result.coverage, 0.15);
  assert.deepEqual(result.missingCategories, ['mall', 'school', 'metro']);
  const empty = scoreGrid(oneCell({})).features[0].properties;
  assert.equal(empty.score, null);
  assert.equal(empty.partialScore, null);
  assert.equal(empty.coverage, 0);
});

test('zero weights can disable unknown categories; all-zero weights yields no score', () => {
  const grid = oneCell(distanceEntries({ cafe: 200 }));
  assert.equal(scoreGrid(grid, { weights: { cafe: 1, mall: 0, school: 0, metro: 0 } }).features[0].properties.score, 100);
  const zero = scoreGrid(grid, { weights: { cafe: 0, mall: 0, school: 0, metro: 0 } }).features[0].properties;
  assert.equal(zero.score, null);
  assert.equal(zero.partialScore, null);
  assert.equal(zero.coverage, 0);
});

test('score thresholds are continuous and settings reject invalid values', () => {
  const grid = oneCell(distanceEntries({ cafe: 500 }));
  const settings = { weights: { cafe: 1, mall: 0, school: 0, metro: 0 }, thresholds: { cafe: { good: 0, max: 1000 } } };
  assert.equal(scoreGrid(grid, settings).features[0].properties.score, 50);
  assert.throws(() => scoreGrid(grid, { weights: { cafe: -1 } }), /权重/);
  assert.throws(() => scoreGrid(grid, { thresholds: { cafe: { good: 1000, max: 1000 } } }), /满分距离/);
  assert.throws(() => scoreGrid(grid, { thresholds: { cafe: { good: NaN } } }), /满分距离/);
  assert.throws(() => calculateGrid({ bbox: [0, 0, 1, 1], gridSize: 0 }), /网格边长/);
  assert.equal(CATEGORIES.length, 4);
  assert.equal(DEFAULT_SETTINGS.gridSize, 250);
});

test('CSV preserves missing distances, quotes names and protects formulas', () => {
  const grid = oneCell({ cafe: { distance: 123.45, name: '=HYPERLINK("x")', poiId: 'coffee' } });
  const result = gridToCsv(scoreGrid(grid));
  assert.ok(result.startsWith('\uFEFFcell_id,'));
  assert.ok(result.includes('123,"\'=HYPERLINK(""x"")",coffee'));
  assert.equal(result.split('\r\n')[1].split(',').slice(-3).join(','), ',,');
  assert.ok(!gridToCsv(grid, { bom: false }).startsWith('\uFEFF'));
});
