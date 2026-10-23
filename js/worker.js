import { buildPoiIndex, calculateGrid } from './engine.js';

let index;
let boundary;
let water;
let suburbanBoundary;
self.onmessage = ({ data: { id, type, payload } }) => {
  try {
    if (type === 'init') {
      index = buildPoiIndex(payload.pois);
      boundary = payload.boundary;
      water = payload.water;
      suburbanBoundary = payload.suburbanBoundary;
      self.postMessage({ id, result: { counts: index.counts, groupCounts: index.groupCounts, skipped: index.skipped } });
    } else if (type === 'calculate') {
      if (!index) throw new Error('设施数据尚未读取完成。');
      const start = performance.now();
      const grid = calculateGrid({ ...payload, index, boundary, excludeBoundary: water, clipBoundary: payload.region === 'suburban' ? suburbanBoundary : null });
      self.postMessage({ id, result: { grid, elapsed: performance.now() - start } });
    } else {
      throw new Error('未知计算任务。');
    }
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
