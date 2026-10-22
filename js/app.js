import { CATEGORIES, DEFAULT_SETTINGS, scoreGrid, gridToCsv, project, validateSettings } from './engine.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const EMPTY = { type: 'FeatureCollection', features: [] };
const ORDER = ['metro', 'school', 'mall', 'cafe'];
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const REGIONS = {
  central: { label: '上海中心城区', bbox: [121.41, 31.18, 121.55, 31.29] },
  xuhui: { label: '徐汇 · 衡复周边', bbox: [121.40, 31.16, 121.48, 31.23] },
  jingan: { label: '静安 · 南京西路周边', bbox: [121.40, 31.21, 121.48, 31.28] },
  pudong: { label: '浦东 · 陆家嘴周边', bbox: [121.48, 31.19, 121.58, 31.28] },
  all: { label: '上海主要陆域', bbox: [120.85, 30.65, 122.05, 31.89] },
};
const PRESETS = {
  balanced: { metro: 40, school: 25, mall: 20, cafe: 15 },
  commute: { metro: 65, school: 5, mall: 10, cafe: 20 },
  family: { metro: 25, school: 50, mall: 20, cafe: 5 },
};
const ICONS = {
  metro: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 10h14M8 21l2-3m6 3-2-3M9 14h.01M15 14h.01M9 6h6"/>',
  school: '<path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M6 11v7c4 3 8 3 12 0v-7M21 9v8"/>',
  mall: '<path d="M5 7h14l2 4H3l2-4Z"/><path d="M4 11v10h16V11M8 7V3h8v4M9 21v-6h6v6"/>',
  cafe: '<path d="M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M17 9h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2M3 23h16"/>',
};
const icon = (id) => `<span class="category-icon" style="--category-color:${CATEGORY[id].color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg></span>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = (value) => Number(value).toLocaleString('zh-CN');
const distanceText = (distance) => distance === null || distance === undefined ? '暂无数据' : distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
const settingsKey = 'shanghai-neighborhood-settings-v1';

let settings = structuredClone(DEFAULT_SETTINGS);
try { const saved = JSON.parse(localStorage.getItem(settingsKey)); if (saved) settings = validateSettings(saved); } catch { /* Private mode or old settings: use defaults. */ }
if (![100, 250, 500, 1000].includes(settings.gridSize)) settings.gridSize = 250;
let region = 'central';
let layer = 'overall';
let rawGrid = EMPTY;
let scoredGrid = EMPTY;
let selectedId = null;
let currentBBox = [...REGIONS.central.bbox];
let computedGridSize = null;
let pois = EMPTY;
let metadata = {};
let boundary = EMPTY;
let water = EMPTY;
let dataReady = false;
let map;
let mapReady = false;
let popup;
let analysisVersion = 0;
let workerSequence = 0;
let toastTimer;
let searchTimer;
let scoreTimer;
const pendingTasks = new Map();
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => {
  const task = pendingTasks.get(data.id);
  if (!task) return;
  pendingTasks.delete(data.id);
  if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
};
worker.onerror = () => {
  for (const task of pendingTasks.values()) task.reject(new Error('本地计算模块未能启动，请刷新页面重试。'));
  pendingTasks.clear();
};
function callWorker(type, payload) {
  return new Promise((resolve, reject) => {
    const id = ++workerSequence;
    pendingTasks.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4600);
}
function persistSettings() {
  try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch { /* Storage is optional. */ }
}
function setBusy(busy, label = '正在计算网格与设施距离') {
  $('#loading-overlay').hidden = !busy;
  $('#loading-label').textContent = label;
  $('#analyze-button').disabled = busy;
  $('#export-button').disabled = busy;
}
function renderWeightControls() {
  const sum = Object.values(settings.weights).reduce((a, b) => a + b, 0);
  $$('.weight-presets button').forEach((button) => {
    button.classList.toggle('active', ORDER.every((id) => settings.weights[id] === PRESETS[button.dataset.preset][id]));
  });
  $('#weight-controls').innerHTML = ORDER.map((id) => {
    const c = CATEGORY[id];
    const threshold = settings.thresholds[id];
    const weight = settings.weights[id];
    return `<div class="weight-row" style="--category-color:${c.color};--range:${weight}%"><div class="weight-heading">${icon(id)}<span><span class="weight-name">${id === 'metro' ? '地铁入口' : c.label}</span><span class="weight-subtitle" id="threshold-caption-${id}">满分 ≤ ${distanceText(threshold.good)} · 零分 ≥ ${distanceText(threshold.max)}</span></span><span class="weight-number" id="weight-display-${id}">${sum ? Math.round(weight / sum * 100) : 0}<small>%</small></span></div><label class="visually-hidden" for="weight-${id}">${c.label}权重</label><input id="weight-${id}" data-weight="${id}" type="range" min="0" max="100" step="1" value="${weight}" aria-valuetext="${weight}"></div>`;
  }).join('');
  $$('#weight-controls input').forEach((input) => input.addEventListener('input', () => {
    const id = input.dataset.weight;
    const previous = settings.weights[id];
    settings.weights[id] = Number(input.value);
    if (Object.values(settings.weights).every((weight) => weight === 0)) {
      settings.weights[id] = previous;
      input.value = previous;
      toast('至少保留一类设施的权重。');
      return;
    }
    input.setAttribute('aria-valuetext', input.value);
    input.closest('.weight-row').style.setProperty('--range', `${input.value}%`);
    updateWeightNumbers();
    $$('.weight-presets button').forEach((button) => button.classList.remove('active'));
    clearTimeout(scoreTimer);
    scoreTimer = setTimeout(rescore, 65);
  }));
  updateGridControls();
}
function updateWeightNumbers() {
  const sum = Object.values(settings.weights).reduce((a, b) => a + b, 0);
  ORDER.forEach((id) => { $(`#weight-display-${id}`).innerHTML = `${sum ? Math.round(settings.weights[id] / sum * 100) : 0}<small>%</small>`; });
}
function updateGridControls() {
  $$('#grid-size-control button').forEach((button) => {
    const active = Number(button.dataset.size) === settings.gridSize;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#grid-size-caption').textContent = `${settings.gridSize} × ${settings.gridSize} m`;
}
function metric(feature) {
  return layer === 'overall' ? feature.properties.score : feature.properties.scores?.[layer];
}
function rescore() {
  persistSettings();
  if (!rawGrid.features.length) return;
  scoredGrid = scoreGrid(rawGrid, settings);
  const valid = scoredGrid.features.map(metric).filter((score) => score !== null && Number.isFinite(score));
  $('#average-score').textContent = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : '—';
  $('#cell-count').textContent = number(scoredGrid.features.length);
  $('#legend-title').textContent = layer === 'overall' ? '综合便利度' : `${CATEGORY[layer].label}接近程度`;
  renderGrid();
  renderDetail();
}
function mapGrid() {
  return { type: 'FeatureCollection', features: scoredGrid.features.map((feature) => ({
    type: 'Feature', id: feature.id, geometry: feature.geometry,
    properties: { id: feature.properties.id, displayScore: metric(feature) ?? -1 },
  })) };
}
function renderGrid() {
  if (!mapReady) return;
  map.getSource('grid')?.setData(mapGrid());
  const selected = scoredGrid.features.find((f) => f.properties.id === selectedId);
  map.getSource('selection')?.setData(selected ? { type: 'FeatureCollection', features: [selected] } : EMPTY);
}
function renderDetail() {
  const feature = scoredGrid.features.find((f) => f.properties.id === selectedId);
  if (!feature) return;
  const p = feature.properties;
  const score = metric(feature);
  const verdict = score === null ? '数据不足' : score >= 85 ? '日常触手可及' : score >= 65 ? '生活较便利' : score >= 40 ? '仍有探索空间' : '设施相对较远';
  $('#detail-card').innerHTML = `<div class="detail-top"><div class="detail-label"><span>网格 ${escape(p.id)}</span><button id="close-detail" aria-label="收起网格详情">收起 ↗</button></div><div class="detail-score-line"><div class="detail-score">${score === null ? '—' : score.toFixed(1)}<small>/100</small></div><div class="score-verdict"><strong>${verdict}</strong><span>${layer === 'overall' ? '综合便利度评分' : `${CATEGORY[layer].label}分项评分`}</span></div></div><div class="detail-coordinates">${p.center[0].toFixed(5)}° E &nbsp; ${p.center[1].toFixed(5)}° N · ${computedGridSize} m 网格</div></div><div class="detail-list">${ORDER.map((id) => {
    const nearest = p.distances[id];
    const categoryScore = p.scores[id];
    return `<button class="facility-detail" data-detail-category="${id}" style="--category-color:${CATEGORY[id].color}" title="查看${CATEGORY[id].label}的直线连接">${icon(id)}<div class="facility-body"><div class="facility-title"><span>${id === 'metro' ? '地铁入口' : CATEGORY[id].label}</span><strong>${nearest ? escape(distanceText(nearest.distance)) : '—'}</strong></div><div class="facility-name">${nearest ? escape(nearest.name) : '该类别暂无记录'}${settings.weights[id] === 0 ? ' · 未计入总分' : ''}</div><div class="mini-progress"><span style="width:${categoryScore ?? 0}%"></span></div></div></button>`;
  }).join('')}</div><div class="detail-bottom"><span>ⓘ</span><span>已收录设施中的最近点。直线距离不计跨江绕行，开放数据收录可能不完整。</span></div>`;
  $('#detail-card').hidden = false;
  $('#close-detail').addEventListener('click', () => { $('#detail-card').hidden = true; selectedId = null; renderGrid(); drawConnections(null); });
  $$('.facility-detail').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.detailCategory;
    drawConnections(feature, id);
    if (p.distances[id]) {
      const n = p.distances[id];
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: true, maxWidth: '230px' }).setLngLat(n.coordinates).setHTML(`<strong>${escape(n.name)}</strong><br>${escape(CATEGORY[id].label)} · 直线 ${escape(distanceText(n.distance))}`).addTo(map);
      map.fitBounds([p.center, n.coordinates], { padding: { top: 100, bottom: 125, left: 70, right: innerWidth > 760 ? 290 : 60 }, maxZoom: 15.5, duration: 550 });
    }
  }));
  drawConnections(feature);
}
function selectCell(id, { fly = false } = {}) {
  const feature = scoredGrid.features.find((f) => f.properties.id === id);
  if (!feature) return;
  selectedId = id;
  renderGrid();
  renderDetail();
  if (fly && mapReady) map.easeTo({ center: feature.properties.center, zoom: Math.max(map.getZoom(), 13), duration: 450 });
}
function drawConnections(feature, onlyCategory) {
  if (!mapReady) return;
  const lines = [];
  const points = [];
  if (feature) {
    const ids = onlyCategory ? [onlyCategory] : ORDER;
    ids.forEach((id) => {
      const nearest = feature.properties.distances[id];
      if (!nearest) return;
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [feature.properties.center, nearest.coordinates] }, properties: { color: CATEGORY[id].color } });
      points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: nearest.coordinates }, properties: { color: CATEGORY[id].color, name: nearest.name } });
    });
    points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: feature.properties.center }, properties: { color: '#1d5042', name: '网格中心' } });
  }
  map.getSource('connections')?.setData({ type: 'FeatureCollection', features: lines });
  map.getSource('endpoints')?.setData({ type: 'FeatureCollection', features: points });
}
function fitArea() {
  if (!mapReady) return;
  map.fitBounds([[currentBBox[0], currentBBox[1]], [currentBBox[2], currentBBox[3]]], { padding: { top: 100, bottom: 90, left: 50, right: innerWidth > 1000 ? 285 : 50 }, duration: 650 });
}
function initializeMap() {
  if (!window.maplibregl) {
    $('#map-error').hidden = false;
    $('#map-error strong').textContent = '地图库加载失败';
    return;
  }
  try {
    map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [121.47, 31.235], zoom: 11.5, minZoom: 7, maxZoom: 18, attributionControl: { compact: true }, maxPitch: 0 });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left');
    map.on('load', () => {
      mapReady = true;
      $('#map-error').hidden = true;
      setupLayers();
      renderGrid();
      if (selectedId) renderDetail();
      fitArea();
      if (dataReady && !rawGrid.features.length && region === 'viewport') analyze();
    });
    let basemapErrors = 0;
    map.on('error', (event) => {
      basemapErrors += 1;
      if (!mapReady || basemapErrors > 5) $('#map-error').hidden = false;
      console.warn('底图资源未能加载：', event.error?.message || 'network error');
    });
  } catch {
    $('#map-error').hidden = false;
    $('#map-error strong').textContent = '浏览器暂不支持地图渲染';
  }
}
function setupLayers() {
  for (const [name, data] of Object.entries({ grid: EMPTY, selection: EMPTY, connections: EMPTY, endpoints: EMPTY, pois, boundary })) map.addSource(name, { type: 'geojson', data });
  map.addLayer({ id: 'admin-boundary', source: 'boundary', type: 'line', paint: { 'line-color': '#b3c2a9', 'line-width': 1.2, 'line-dasharray': [4, 4], 'line-opacity': .7 } });
  const labels = map.getStyle().layers.find((l) => l.type === 'symbol' && l.layout?.['text-field']);
  const before = labels?.id;
  map.addLayer({ id: 'grid-fill', type: 'fill', source: 'grid', paint: {
    'fill-color': ['case', ['<', ['get', 'displayScore'], 0], '#d3d9ce', ['interpolate', ['linear'], ['get', 'displayScore'], 0, '#d3b793', 25, '#d9cda6', 50, '#b1cb9d', 75, '#78b18c', 100, '#368461']],
    'fill-opacity': .54,
  } }, before);
  map.addLayer({ id: 'grid-lines', type: 'line', source: 'grid', paint: { 'line-color': '#f9fcf4', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, .25, 14, .8], 'line-opacity': .75 } }, before);
  map.addLayer({ id: 'selection-fill', type: 'fill', source: 'selection', paint: { 'fill-color': '#d9efb6', 'fill-opacity': .25 } });
  map.addLayer({ id: 'selection-line', type: 'line', source: 'selection', paint: { 'line-color': '#1f5a43', 'line-width': 2.3 } });
  map.addLayer({ id: 'poi-points', type: 'circle', source: 'pois', layout: { visibility: $('#show-pois').checked ? 'visible' : 'none' }, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 4], 'circle-color': ['match', ['get', 'category'], ...CATEGORIES.flatMap((c) => [c.id, c.color]), '#7c8a70'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.1, 'circle-opacity': .88 } });
  map.addLayer({ id: 'connection-lines', type: 'line', source: 'connections', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': .95 } });
  map.addLayer({ id: 'endpoint-points', type: 'circle', source: 'endpoints', paint: { 'circle-color': ['get', 'color'], 'circle-radius': 4.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.on('click', 'grid-fill', (event) => {
    if (event.features?.[0]) selectCell(event.features[0].properties.id);
  });
  map.on('mouseenter', 'grid-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'grid-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'poi-points', (event) => {
    const f = event.features?.[0];
    if (!f) return;
    popup?.remove();
    popup = new maplibregl.Popup().setLngLat(f.geometry.coordinates).setHTML(`<strong>${escape(f.properties.name)}</strong><br>${escape(CATEGORY[f.properties.category]?.label || '设施')}`).addTo(map);
  });
  // Prefer the Chinese OSM name while retaining the provider's fallback labels.
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && l.layout?.['text-field']) {
      try { map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:zh'], ['get', 'name'], l.layout['text-field']]); } catch { /* Keep original style if unsupported. */ }
    }
  }
}
async function analyze({ fit = true } = {}) {
  if (!dataReady) return;
  const preflightNotice = (message) => {
    if (!pendingTasks.size) setBusy(false);
    toast(message);
  };
  let bbox = REGIONS[region]?.bbox;
  if (region === 'viewport') {
    if (!mapReady) return preflightNotice('底图加载完成后，可以分析当前地图视野。');
    const b = map.getBounds();
    bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  const limits = REGIONS.all.bbox;
  bbox = [Math.max(bbox[0], limits[0]), Math.max(bbox[1], limits[1]), Math.min(bbox[2], limits[2]), Math.min(bbox[3], limits[3])];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return preflightNotice('当前视野在上海分析范围之外，请回到上海后再计算。');
  const a = project(bbox.slice(0, 2));
  const b = project(bbox.slice(2, 4));
  const estimated = Math.ceil((b[0] - a[0]) / settings.gridSize + 1) * Math.ceil((b[1] - a[1]) / settings.gridSize + 1);
  if (estimated > 30000) return preflightNotice('该范围的网格过多。请选择更大的网格，或缩小地图分析范围。');
  const version = ++analysisVersion;
  setBusy(true);
  try {
    const gridSize = settings.gridSize;
    const { grid, elapsed } = await callWorker('calculate', { bbox, gridSize });
    if (version !== analysisVersion) return;
    if (!grid.features.length) { toast('范围内没有可分析的陆地中心点，请移动或扩大区域。'); return; }
    rawGrid = grid;
    currentBBox = bbox;
    computedGridSize = gridSize;
    selectedId = null;
    rescore();
    const center = region === 'central' ? [121.4737, 31.2304] : [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    const chosen = scoredGrid.features.reduce((best, f) => {
      const d = (f.properties.center[0] - center[0]) ** 2 + (f.properties.center[1] - center[1]) ** 2;
      return !best || d < best.d ? { f, d } : best;
    }, null);
    if (chosen) selectCell(chosen.f.properties.id);
    $('#status-text').textContent = `${number(grid.features.length)} 个网格 · ${gridSize} m · 本地计算 ${Math.max(1, Math.round(elapsed))} ms`;
    if (fit) fitArea();
    $('#settings-panel').classList.remove('open');
  } catch (error) {
    toast(error.message);
  } finally {
    if (version === analysisVersion) setBusy(false);
  }
}
function download(content, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openAbout() { $('#about-dialog').showModal(); }
function searchPois() {
  const input = $('#poi-search');
  const query = input.value.trim().toLocaleLowerCase();
  const results = $('#search-results');
  if (!query) { results.hidden = true; return; }
  const found = pois.features.filter((f) => String(f.properties.name || '').toLocaleLowerCase().includes(query)).slice(0, 8);
  results.innerHTML = found.length ? found.map((f, i) => `<button data-search-result="${i}">${icon(f.properties.category)}<span><strong>${escape(f.properties.name)}</strong><small>${escape(CATEGORY[f.properties.category].label)} · OSM 已收录</small></span></button>`).join('') : '<div class="search-empty">没有找到已收录的设施。<br>试试“咖啡”“学校”或具体设施名称。</div>';
  results.hidden = false;
  $$('[data-search-result]').forEach((button) => button.addEventListener('click', () => {
    const f = found[Number(button.dataset.searchResult)];
    if (!mapReady) return toast('地图尚未加载完成。');
    results.hidden = true;
    input.value = f.properties.name;
    popup?.remove();
    popup = new maplibregl.Popup().setLngLat(f.geometry.coordinates).setHTML(`<strong>${escape(f.properties.name)}</strong><br>${escape(CATEGORY[f.properties.category].label)} · OSM 已收录`).addTo(map);
    map.flyTo({ center: f.geometry.coordinates, zoom: 14.5, duration: 700 });
    const cell = scoredGrid.features.find((g) => {
      const ring = g.geometry.coordinates[0];
      return f.geometry.coordinates[0] >= ring[0][0] && f.geometry.coordinates[0] <= ring[2][0] && f.geometry.coordinates[1] >= ring[0][1] && f.geometry.coordinates[1] <= ring[2][1];
    });
    if (cell) selectCell(cell.properties.id);
    else toast('该设施在当前分析区域外，可选择“当前地图视野”重新计算。');
  }));
}
function setupEvents() {
  $('#region-select').addEventListener('change', (event) => {
    region = event.target.value;
    if (region === 'all' && settings.gridSize < 1000) { settings.gridSize = 1000; updateGridControls(); }
    analyze();
  });
  $$('#grid-size-control button').forEach((button) => button.addEventListener('click', () => {
    settings.gridSize = Number(button.dataset.size);
    updateGridControls();
    persistSettings();
    analyze({ fit: false });
  }));
  $$('.weight-presets button').forEach((button) => button.addEventListener('click', () => {
    settings.weights = { ...PRESETS[button.dataset.preset] };
    $$('.weight-presets button').forEach((b) => b.classList.toggle('active', b === button));
    renderWeightControls();
    rescore();
  }));
  $$('#layer-tabs button').forEach((button) => button.addEventListener('click', () => {
    layer = button.dataset.layer;
    $$('#layer-tabs button').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    if (mapReady) map.setFilter('poi-points', layer === 'overall' ? null : ['==', ['get', 'category'], layer]);
    rescore();
  }));
  $('#analyze-button').addEventListener('click', () => analyze());
  $('#fit-button').addEventListener('click', fitArea);
  $('#show-pois').addEventListener('change', (event) => { if (mapReady) map.setLayoutProperty('poi-points', 'visibility', event.target.checked ? 'visible' : 'none'); });
  $('#reset-button').addEventListener('click', () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    region = 'central';
    $('#region-select').value = region;
    renderWeightControls();
    $$('.weight-presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'balanced'));
    persistSettings();
    analyze();
    toast('已恢复默认区域与评分参数。');
  });
  $('#mobile-settings').addEventListener('click', () => { $('#settings-panel').classList.toggle('open'); });
  $('#about-button').addEventListener('click', openAbout);
  $('#source-button').addEventListener('click', openAbout);
  $('#close-about').addEventListener('click', () => $('#about-dialog').close());
  $('#threshold-button').addEventListener('click', () => {
    $('#threshold-error').textContent = '';
    $('#threshold-fields').innerHTML = ORDER.map((id) => `<div class="threshold-row"><span>${icon(id)}${CATEGORY[id].label}</span><label><span class="visually-hidden">${CATEGORY[id].label}满分距离</span><input id="good-${id}" type="number" min="0" max="100000" step="50" value="${settings.thresholds[id].good}"></label><label><span class="visually-hidden">${CATEGORY[id].label}零分距离</span><input id="max-${id}" type="number" min="1" max="200000" step="50" value="${settings.thresholds[id].max}"></label></div>`).join('');
    $('#threshold-dialog').showModal();
  });
  $('#save-thresholds').addEventListener('click', () => {
    const thresholds = Object.fromEntries(ORDER.map((id) => [id, { good: Number($(`#good-${id}`).value), max: Number($(`#max-${id}`).value) }]));
    if (ORDER.some((id) => !$(`#good-${id}`).value || !$(`#max-${id}`).value || !Number.isFinite(thresholds[id].good) || thresholds[id].good < 0 || !Number.isFinite(thresholds[id].max) || thresholds[id].max <= thresholds[id].good)) {
      $('#threshold-error').textContent = '请填写有效距离：满分距离不小于 0，零分距离必须大于满分距离。';
      return;
    }
    settings.thresholds = thresholds;
    renderWeightControls();
    rescore();
    $('#threshold-dialog').close();
    toast('评分阈值已更新，使用已有距离重新评分。');
  });
  $('#export-button').addEventListener('click', () => {
    if (!scoredGrid.features.length) return toast('请先计算一个区域。');
    download(gridToCsv(scoredGrid), `上海便利度-${computedGridSize}m-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
    toast(`已导出 ${number(scoredGrid.features.length)} 个网格的评分与距离。`);
  });
  $('#download-settings').addEventListener('click', () => download(JSON.stringify({ ...settings, region, bbox: currentBBox, dataDate: metadata.dataDate, distanceMode: 'great-circle', source: metadata.source }, null, 2), '上海便利度-评分参数.json'));
  $('#download-pois').addEventListener('click', () => download(JSON.stringify(pois), '上海设施-OSM.geojson', 'application/geo+json'));
  $('#poi-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchPois, 160); });
  $('#poi-search').addEventListener('keydown', (event) => { if (event.key === 'Escape') $('#search-results').hidden = true; if (event.key === 'Enter') $('#search-results button')?.click(); });
  document.addEventListener('click', (event) => { if (!event.target.closest('.map-search')) $('#search-results').hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#poi-search').focus(); }
  });
  $('#retry-map').addEventListener('click', () => { location.reload(); });
  $('#import-file').addEventListener('change', importData);
}
async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) { event.target.value = ''; return toast('请导入小于 40 MB 的点数据文件。'); }
  try {
    const fc = JSON.parse(await file.text());
    if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features) || fc.features.length > 100000) throw new Error('请导入不超过 10 万条设施的 GeoJSON FeatureCollection。');
    const valid = fc.features.filter((f) => f.geometry?.type === 'Point' && CATEGORY[f.properties?.category] && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length >= 2 && f.geometry.coordinates.slice(0, 2).every(Number.isFinite) && Math.abs(f.geometry.coordinates[0]) <= 180 && Math.abs(f.geometry.coordinates[1]) <= 90);
    if (!valid.length) throw new Error('未找到有效设施点，请检查 category 和经纬度。');
    const imported = { type: 'FeatureCollection', features: valid, metadata: { source: `用户导入：${file.name}`, dataDate: null } };
    setBusy(true, '读取本地设施数据');
    const result = await callWorker('init', { pois: imported, boundary, water });
    pois = imported;
    metadata = imported.metadata;
    // A new dataset invalidates every distance and score from the old snapshot.
    // Clear before analysis, including when the chosen grid fails a size guard.
    rawGrid = EMPTY;
    scoredGrid = EMPTY;
    selectedId = null;
    computedGridSize = null;
    $('#average-score').textContent = '—';
    $('#cell-count').textContent = '—';
    $('#detail-card').hidden = true;
    $('#status-text').textContent = '已载入新设施数据，请计算所选区域';
    renderGrid();
    drawConnections(null);
    renderDataInfo(result.counts);
    if (mapReady) map.getSource('pois').setData(pois);
    $('#about-dialog').close();
    toast(`已载入 ${number(valid.length)} 条设施，忽略 ${number(fc.features.length - valid.length)} 条无效记录。原始文件不会上传。`);
    await analyze();
  } catch (error) { toast(`导入失败：${error.message}`); }
  finally { event.target.value = ''; setBusy(false); }
}
function renderDataInfo(counts) {
  const count = Object.values(counts).reduce((a, b) => a + b, 0);
  $('#poi-count').textContent = number(count);
  $('#data-description').textContent = metadata.dataDate ? `设施、边界和水面来自 Geofabrik 的上海 OpenStreetMap 快照，截至 ${metadata.dataDate.slice(0, 10)}。共 ${number(count)} 条设施记录，数据按 ODbL 许可使用。下载范围包含部分边界缓冲，但不保证所有边界外设施。` : `${metadata.source}。共 ${number(count)} 条有效记录；请自行确认数据日期与覆盖范围。分析仍限制在上海主要陆域。`;
  $('#data-counts').innerHTML = ORDER.map((id) => `<div>${id === 'metro' ? '地铁入口' : CATEGORY[id].label}<strong>${number(counts[id] || 0)}</strong></div>`).join('');
}
async function loadData() {
  try {
    const [poiData, boundaryData, waterData, meta] = await Promise.all(['pois.geojson', 'boundary.geojson', 'water.geojson', 'metadata.json'].map(async (file) => {
      const response = await fetch(new URL(`../data/${file}`, import.meta.url));
      if (!response.ok) throw new Error(`数据文件 ${file} 读取失败。`);
      return response.json();
    }));
    pois = poiData;
    boundary = boundaryData;
    water = waterData;
    metadata = meta;
    const result = await callWorker('init', { pois, boundary, water });
    dataReady = true;
    renderDataInfo(result.counts);
    if (mapReady) { map.getSource('pois').setData(pois); map.getSource('boundary').setData(boundary); }
    await analyze();
  } catch (error) {
    setBusy(false);
    $('#status-text').textContent = '设施数据未能读取，请刷新重试';
    toast(error.message);
  }
}

renderWeightControls();
setupEvents();
initializeMap();
loadData();
