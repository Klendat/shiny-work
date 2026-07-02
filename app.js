/* Can I Sweat? — v1 (main app UI)
 * Turns temperature + humidity (+ wind) into a verdict on whether your sweat
 * can cool you, plus how hard it's working. The physics/weather/geolocation and
 * map-picker logic lives in core.js (window.CIS) and is shared with the
 * alternate design pages; this file is just the main app's DOM wiring.
 */

'use strict';

const {
  evaluate,
  fetchWeather,
  reverseGeocode,
  getPosition,
  initMapPicker,
  toDisplay,
  fmtTemp,
  loadPrefs,
  savePrefs,
} = window.CIS;

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);

const state = {
  activity: 'light',
  age: 'adult',
  unit: 'C',          // 'C' or 'F'
  reading: null,      // { t, rh, windMs, source, placeName, lat?, lon? }
};

// Restore saved preferences (activity / age / unit) from a previous visit.
const savedPrefs = loadPrefs();
if (savedPrefs.activity) state.activity = savedPrefs.activity;
if (savedPrefs.age) state.age = savedPrefs.age;
if (savedPrefs.unit === 'C' || savedPrefs.unit === 'F') state.unit = savedPrefs.unit;

const dom = {
  verdict: el('verdict'),
  statusLine: el('statusLine'),
  headline: el('headline'),
  detail: el('detail'),
  meterSection: el('meterSection'),
  meterFill: el('meterFill'),
  meterValue: el('meterValue'),
  meterHint: el('meterHint'),
  chips: el('chips'),
  chipTemp: el('chipTemp'),
  chipHum: el('chipHum'),
  chipFeels: el('chipFeels'),
  chipWetbulb: el('chipWetbulb'),
  activity: el('activity'),
  ageGroup: el('ageGroup'),
  refreshBtn: el('refreshBtn'),
  mapBtn: el('mapBtn'),
  mapModal: el('mapModal'),
  mapClose: el('mapClose'),
  mapConfirm: el('mapConfirm'),
  unitToggle: el('unitToggle'),
  manualPanel: el('manualPanel'),
  manualTemp: el('manualTemp'),
  manualHum: el('manualHum'),
  manualWind: el('manualWind'),
  applyManual: el('applyManual'),
  place: el('place'),
};

function persistPrefs() {
  savePrefs({ activity: state.activity, age: state.age, unit: state.unit });
}

// Reflect the current state in a segmented control's active button.
function setActive(container, key, value) {
  for (const b of container.querySelectorAll('.seg')) {
    b.classList.toggle('is-active', b.dataset[key] === value);
  }
}

function render() {
  if (!state.reading) return;
  const { t, rh, windMs } = state.reading;
  const r = evaluate(t, rh, windMs, state.activity, state.age);

  dom.verdict.dataset.level = r.level;
  dom.statusLine.textContent = r.status;
  dom.headline.textContent = r.headline;
  dom.detail.textContent = r.detail;

  // Meter: show wettedness as a percentage, capped visually at 120%.
  dom.meterSection.hidden = false;
  const pct = r.w === Infinity ? 120 : Math.min(120, Math.round(r.w * 100));
  dom.meterFill.style.width = `${Math.min(100, pct)}%`;
  // Colour the bar by the sweat LOAD itself, not the overall verdict: in a hot
  // environment the banner may be amber while the load is genuinely low.
  dom.meterFill.style.background = loadColor(r.w);
  dom.meterValue.textContent = r.w === Infinity ? '∞' : `${pct}%`;
  dom.meterHint.textContent = r.meterHint;

  // Chips
  dom.chips.hidden = false;
  dom.chipTemp.textContent = fmtTemp(t, state.unit);
  dom.chipHum.textContent = `${Math.round(rh)}%`;
  dom.chipFeels.textContent = fmtTemp(r.feels, state.unit);
  dom.chipWetbulb.textContent = fmtTemp(r.Tw, state.unit);

  // Keep manual fields in sync so they're a live starting point.
  dom.manualTemp.value = Math.round(toDisplay(t, state.unit) * 10) / 10;
  dom.manualHum.value = Math.round(rh);
  if (state.reading.source === 'manual') {
    dom.place.textContent = 'Manual conditions';
  } else if (state.reading.placeName) {
    dom.place.textContent = `📍 ${state.reading.placeName}`;
  } else if (state.reading.lat != null) {
    dom.place.textContent = `📍 ${state.reading.lat.toFixed(3)}, ${state.reading.lon.toFixed(3)}`;
  } else {
    dom.place.textContent = '';
  }
}

function loadColor(w) {
  if (w > 1) return 'var(--v-bad)';
  if (w > 0.85) return 'var(--v-warn)';
  if (w > 0.5) return 'var(--v-good)';
  return 'var(--v-great)';
}

function showMessage(headline, detail, { showManual = false } = {}) {
  delete dom.verdict.dataset.level;
  dom.statusLine.textContent = '';
  dom.headline.textContent = headline;
  dom.detail.textContent = detail;
  if (showManual) dom.manualPanel.open = true;
}

/* ---------- Location ---------- */

async function locate() {
  showMessage('Locating you…', 'Reading the weather where you are.');
  dom.refreshBtn.disabled = true;
  try {
    const pos = await getPosition();
    const { latitude, longitude } = pos.coords;
    const [reading, placeName] = await Promise.all([
      fetchWeather(latitude, longitude),
      reverseGeocode(latitude, longitude),
    ]);
    state.reading = { ...reading, source: 'gps', placeName, lat: latitude, lon: longitude };
    render();
  } catch (err) {
    handleLocationError(err);
  } finally {
    dom.refreshBtn.disabled = false;
  }
}

// Map a geolocation/weather failure to the right message. Geolocation rejects
// with a numeric `.code` (1 = denied, 2/3 = unavailable/timeout); a weather
// fetch error has no such code and falls through to the generic branch.
function handleLocationError(err) {
  if (err && err.code === 'UNAVAILABLE') {
    showMessage('Location unavailable',
      'Your browser can’t share location. Enter the conditions manually below.',
      { showManual: true });
  } else if (err && err.code === 1) {
    showMessage('Location permission denied',
      'Enter the current temperature and humidity manually below and tap Calculate.',
      { showManual: true });
  } else if (err && (err.code === 2 || err.code === 3)) {
    showMessage('Couldn’t find your location',
      'Enter the current temperature and humidity manually below and tap Calculate.',
      { showManual: true });
  } else {
    const msg = err && err.message ? err.message : 'Something went wrong';
    showMessage('Couldn’t get the weather',
      `${msg}. Check your connection or enter conditions manually.`,
      { showManual: true });
  }
}

function applyManual() {
  const rawT = parseFloat(dom.manualTemp.value);
  const rh = parseFloat(dom.manualHum.value);
  if (Number.isNaN(rawT) || Number.isNaN(rh)) {
    dom.manualPanel.open = true;
    showMessage('Enter temperature and humidity',
      'Both a temperature and a humidity value are needed to calculate.',
      { showManual: true });
    return;
  }
  const tC = state.unit === 'F' ? (rawT - 32) * 5 / 9 : rawT;
  const windKmh = parseFloat(dom.manualWind.value);
  state.reading = {
    t: tC,
    rh: Math.max(0, Math.min(100, rh)),
    windMs: Number.isNaN(windKmh) ? 0 : windKmh / 3.6,
    source: 'manual',
    placeName: null,
  };
  render();
}

/* ---------- Map picker ---------- */

let mapPicker = null;

function openMap() {
  if (!mapPicker) {
    mapPicker = initMapPicker({
      dialog: dom.mapModal,
      mapEl: 'map',
      confirmBtn: dom.mapConfirm,
      closeBtn: dom.mapClose,
      getCenter: () =>
        state.reading && state.reading.lat != null
          ? { lat: state.reading.lat, lon: state.reading.lon }
          : null,
      onConfirm: onMapConfirm,
    });
  }
  mapPicker.open();
}

async function onMapConfirm({ lat, lon }) {
  showMessage('Getting the weather…', 'Fetching conditions for the pinned location.');
  try {
    const [reading, placeName] = await Promise.all([
      fetchWeather(lat, lon),
      reverseGeocode(lat, lon),
    ]);
    state.reading = { ...reading, source: 'map', placeName, lat, lon };
    render();
  } catch (err) {
    showMessage('Couldn’t get the weather',
      `${err.message}. Check your connection or enter conditions manually.`,
      { showManual: true });
  }
}

/* ---------- Events ---------- */

dom.activity.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  state.activity = btn.dataset.activity;
  setActive(dom.activity, 'activity', state.activity);
  persistPrefs();
  render();
});

dom.ageGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  state.age = btn.dataset.age;
  setActive(dom.ageGroup, 'age', state.age);
  persistPrefs();
  render();
});

dom.refreshBtn.addEventListener('click', locate);
dom.applyManual.addEventListener('click', applyManual);
dom.mapBtn.addEventListener('click', openMap);

dom.unitToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn || btn.dataset.unit === state.unit) return;
  state.unit = btn.dataset.unit;
  setActive(dom.unitToggle, 'unit', state.unit);
  for (const tag of document.querySelectorAll('.unitTag')) tag.textContent = `°${state.unit}`;
  persistPrefs();
  render();
});

// Reflect any restored preferences in the controls before the first reading.
setActive(dom.activity, 'activity', state.activity);
setActive(dom.ageGroup, 'age', state.age);
setActive(dom.unitToggle, 'unit', state.unit);
for (const tag of document.querySelectorAll('.unitTag')) tag.textContent = `°${state.unit}`;

// Register service worker for offline shell / installability.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Kick off on load.
locate();
