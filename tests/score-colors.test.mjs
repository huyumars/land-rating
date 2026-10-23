import test from 'node:test';
import assert from 'node:assert/strict';
import { createColorScale, displayScore, NO_DATA_COLOR, SCORE_PALETTE } from '../js/score-colors.js';

const channels = (color) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
const difference = (a, b) => Math.max(...channels(a).map((channel, index) => Math.abs(channel - channels(b)[index])));

test('absolute colors continuously interpolate RGB across the full score domain', () => {
  const scale = createColorScale([41, 42], 'absolute');
  assert.deepEqual(scale.domain, [0, 100]);
  assert.equal(scale.total, 2);
  assert.deepEqual(scale.stops.map(({ value, position }) => [value, position]), [[0, 0], [25, 0.25], [50, 0.5], [75, 0.75], [100, 1]]);
  SCORE_PALETTE.forEach((color, index) => assert.equal(scale.color(index * 25), color));
  assert.equal(scale.color(12.5), '#e5863a');
  assert.notEqual(scale.color(1), scale.color(19));
  for (const value of [25, 50, 75]) assert.ok(difference(scale.color(value - 0.00001), scale.color(value + 0.00001)) <= 1);
  assert.equal(scale.color(-10), SCORE_PALETTE[0]);
  assert.equal(scale.color(110), SCORE_PALETTE.at(-1));
});

test('relative gradient uses raw quantiles without rounding away score variation', () => {
  const scale = createColorScale([11, 11.025, 11.05, 11.075, 11.1]);
  assert.deepEqual(scale.domain, [11, 11.1]);
  assert.deepEqual(scale.stops.map(({ value }) => value), [11, 11.025, 11.05, 11.075, 11.1]);
  assert.equal(displayScore(11.01), displayScore(11.04));
  assert.notEqual(scale.color(11.01), scale.color(11.04));
  for (const { value, color, position } of scale.stops) {
    assert.equal(scale.color(value), color);
    assert.ok(Math.abs(position - (value - 11) / 0.1) < 1e-12);
    assert.ok(difference(scale.color(value - 0.00000001), scale.color(value + 0.00000001)) <= 1);
  }
});

test('tied relative quantiles collapse into unique anchors without color jumps', () => {
  const values = [0, 0, 0, 0, 20, 20, 20, 20, 100];
  const scale = createColorScale(values);
  assert.deepEqual(scale.stops.map(({ value }) => value), [0, 20, 100]);
  assert.equal(new Set(scale.stops.map(({ value }) => value)).size, scale.stops.length);
  assert.equal(scale.color(0), SCORE_PALETTE[0]);
  assert.equal(scale.color(100), SCORE_PALETTE.at(-1));
  assert.ok(difference(scale.color(20 - 0.00001), scale.color(20 + 0.00001)) <= 1);
  assert.deepEqual(createColorScale([...values].reverse()).stops, scale.stops);
});

test('constant data has one absolute-derived color and a valid flat legend', () => {
  const scale = createColorScale([42, 42, 42]);
  const expected = createColorScale([], 'absolute').color(42);
  assert.deepEqual(scale.domain, [42, 42]);
  assert.equal(scale.total, 3);
  assert.deepEqual(scale.stops, [{ value: 42, color: expected, position: 0 }, { value: 42, color: expected, position: 1 }]);
  assert.equal(scale.color(42), expected);
  assert.equal(scale.color(10), expected);
  assert.equal(scale.color(90), expected);
});

test('missing observations and invalid scores have explicit no-data behavior', () => {
  const scale = createColorScale([null, undefined, NaN, Infinity, -Infinity, '40']);
  assert.equal(scale.total, 0);
  assert.deepEqual(scale.domain, [0, 100]);
  assert.deepEqual(scale.stops.map(({ color, position }) => [color, position]), [[NO_DATA_COLOR, 0], [NO_DATA_COLOR, 1]]);
  assert.equal(scale.color(50), NO_DATA_COLOR);
  for (const value of [null, undefined, NaN, Infinity, '40']) {
    assert.equal(scale.color(value), NO_DATA_COLOR);
    assert.equal(createColorScale([], 'absolute').color(value), NO_DATA_COLOR);
    assert.equal(displayScore(value), null);
  }
  assert.equal(displayScore(-2), 0);
  assert.equal(displayScore(102), 100);
  assert.equal(displayScore(42.16), 42.2);
});
