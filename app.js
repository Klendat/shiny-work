/* Can I Sweat? — v1
 * Turns temperature + humidity (+ wind) into a verdict on whether your sweat
 * can cool you, plus how hard it's working. Pure air-physics estimate; the
 * minutes-to-danger countdown is intentionally left for v2 (see README).
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Physiology / thermodynamics model
 * ------------------------------------------------------------------ */

const SKIN_TEMP = 35;      // °C, typical warm-skin temperature
const H_RADIATIVE = 4.7;   // W/m²·K, linearized radiative coefficient
const LEWIS = 16.5;        // W/m²·kPa per W/m²·K (Lewis relation for air)

// Metabolic heat production by activity (W/m² of body surface).
const METABOLIC = {
  rest: 65,       // sitting / standing still (~1.1 MET)
  light: 130,     // walking, easy chores (~2.2 MET)
  moderate: 230,  // brisk work, cycling (~4 MET)
  hard: 350,      // running, heavy labor (~6 MET)
};

// Saturation vapor pressure over water (kPa), Tetens equation. T in °C.
function satVaporPressure(t) {
  return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
}

// Wet-bulb temperature (°C) from air temp (°C) and RH (%). Stull (2011).
function wetBulb(t, rh) {
  const r = Math.max(1, Math.min(100, rh)); // formula is undefined at RH<~1
  return (
    t * Math.atan(0.151977 * Math.sqrt(r + 8.313659)) +
    Math.atan(t + r) -
    Math.atan(r - 1.676331) +
    0.00391838 * Math.pow(r, 1.5) * Math.atan(0.023101 * r) -
    4.686035
  );
}

// NWS Heat Index (Rothfusz) — "feels like" temperature in °C, from T(°C), RH(%).
function heatIndex(tC, rh) {
  const t = tC * 9 / 5 + 32; // work in °F
  // Below ~80°F the regression isn't used; NWS falls back to a simple form.
  if (t < 80) {
    const hiF = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
    const avg = (hiF + t) / 2;
    return (avg - 32) * 5 / 9;
  }
  let hi =
    -42.379 + 2.04901523 * t + 10.14333127 * rh -
    0.22475541 * t * rh - 0.00683783 * t * t -
    0.05481717 * rh * rh + 0.00122874 * t * t * rh +
    0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
  // Adjustments
  if (rh < 13 && t >= 80 && t <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  } else if (rh > 85 && t >= 80 && t <= 87) {
    hi += ((rh - 85) / 10) * ((87 - t) / 5);
  }
  return (hi - 32) * 5 / 9;
}

// Convective heat-transfer coefficient (W/m²·K) as a function of wind (m/s).
function convectiveCoeff(windMs) {
  const v = Math.max(0, windMs || 0);
  return Math.max(3.1, 8.3 * Math.sqrt(v)); // 3.1 ≈ still-air natural convection
}

/**
 * Core evaluation. Returns everything the UI needs.
 * @param {number} t    air temperature (°C)
 * @param {number} rh   relative humidity (%)
 * @param {number} windMs wind speed (m/s)
 * @param {string} activity  key of METABOLIC
 */
function evaluate(t, rh, windMs, activity) {
  const Tw = wetBulb(t, rh);
  const feels = heatIndex(t, rh);

  const M = METABOLIC[activity] ?? METABOLIC.light;
  const hc = convectiveCoeff(windMs);

  // Dry heat exchange (skin → air): positive = heat lost, negative = heat gained.
  const dryLoss = (hc + H_RADIATIVE) * (SKIN_TEMP - t);

  // Required evaporative cooling to stay in balance.
  const Ereq = M - dryLoss;

  // Max evaporative cooling the environment allows.
  const Pskin = satVaporPressure(SKIN_TEMP);
  const Pair = (Math.max(0, Math.min(100, rh)) / 100) * satVaporPressure(t);
  const he = LEWIS * hc;
  const Emax = Math.max(0, he * (Pskin - Pair));

  // Skin wettedness required: the fraction of skin that must be sweat-soaked.
  // w <= 1 → sweat can compensate; w > 1 → it cannot.
  let w;
  if (Ereq <= 0) {
    w = 0; // no evaporative cooling needed (air is cool relative to skin/heat)
  } else if (Emax <= 0) {
    w = Infinity; // air is saturated at skin temp — evaporation impossible
  } else {
    w = Ereq / Emax;
  }

  const level = classify(w, Tw);
  return { t, rh, windMs, Tw, feels, M, Ereq, Emax, w, ...level };
}

// Map wettedness (is sweat sufficient for this effort?) plus the absolute
// wet-bulb temperature (is the environment dangerous at all?) to a verdict.
//
// Two independent axes, because they answer different questions:
//   • Wet-bulb sets the danger floor — near skin temp, nobody sheds heat,
//     regardless of effort. This is the well-established heat-stress metric.
//   • Wettedness `w` says whether YOUR current effort outpaces evaporation.
//     In cool air, w>1 just means "you'll warm up running" — not dangerous.
function classify(w, Tw) {
  // Wet-bulb at/above skin temp: evaporation is impossible for anyone.
  if (Tw >= 35) {
    return {
      level: 'crit',
      status: 'Critical — evaporation impossible',
      headline: 'Sweat cannot cool you',
      detail:
        'The air is so warm and humid that sweat will not evaporate at all. Get to ' +
        'shade, air conditioning or cold water now — sweating cannot help here.',
      meterHint: 'Evaporation is effectively zero at this wet-bulb temperature.',
    };
  }

  // Dangerous wet-bulb: risky even at rest, and worse if you can't keep up.
  if (Tw >= 31) {
    return {
      level: 'bad',
      status: 'Dangerous heat',
      headline: 'Cool down another way',
      detail:
        'The wet-bulb temperature is in the dangerous range — sweat can barely ' +
        'evaporate even at rest. Seek shade/AC, wet your skin, use a fan, and limit ' +
        'exertion. Your core temperature can climb here.',
      meterHint: 'Wet-bulb this high leaves almost no evaporative capacity.',
    };
  }

  // Sweat can't keep up with this effort (w > 1).
  if (w > 1) {
    if (Tw >= 27) {
      // Warm AND overloaded — genuinely cool down another way.
      return {
        level: 'bad',
        status: 'Sweat can’t keep up',
        headline: 'Cool down another way',
        detail:
          'At this effort you’re making more heat than the warm, humid air lets you ' +
          'sweat off. Your core temperature will rise. Ease off, seek shade/AC, wet ' +
          'your skin or use a fan.',
        meterHint: 'Above 100%: sweat can’t evaporate fast enough for this effort.',
      };
    }
    // Cool air but hard effort — normal, self-limiting, not dangerous.
    return {
      level: 'warn',
      status: 'Sweat maxed for this effort',
      headline: 'Sweat is at its limit',
      detail:
        'You’re working hard enough to outpace evaporation, so you’ll keep warming ' +
        'up — but the air itself is cool, so this isn’t dangerous. Ease off or hydrate ' +
        'and you’ll settle.',
      meterHint: 'Above 100%, but cool air keeps this safe — just expect to run hot.',
    };
  }

  // Sweat is compensating — grade by how much margin is left.
  if (w > 0.85) {
    return {
      level: 'warn',
      status: 'Working near capacity',
      headline: 'Sweat is working — with little margin',
      detail:
        'Sweating is keeping you in balance, but you’re close to its limit. A little ' +
        'more effort, sun or humidity will tip you over. Hydrate and take it steady.',
      meterHint: 'Near the ~85% sustainable-sweat line — little headroom left.',
    };
  }
  if (w > 0.5) {
    return {
      level: 'good',
      status: 'Sweat is working',
      headline: 'You’re cooling fine',
      detail:
        'Your sweat is evaporating well and keeping you in balance with comfortable ' +
        'margin. Keep drinking water.',
      meterHint: 'Comfortable margin before sweat is maxed out.',
    };
  }
  return {
    level: 'great',
    status: 'Sweat is working',
    headline: 'Plenty of cooling margin',
    detail:
      'Conditions are easy for your body — sweat evaporates readily and you have lots ' +
      'of spare cooling capacity.',
    meterHint: 'Lots of spare evaporative capacity.',
  };
}

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);

const state = {
  activity: 'light',
  unit: 'C',          // 'C' or 'F'
  reading: null,      // { t, rh, windMs, source, placeName, lat?, lon? }
};

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

const cToDisplay = (c) => (state.unit === 'F' ? c * 9 / 5 + 32 : c);
const fmtTemp = (c) => `${Math.round(cToDisplay(c))}°${state.unit}`;

function render() {
  if (!state.reading) return;
  const { t, rh, windMs } = state.reading;
  const r = evaluate(t, rh, windMs, state.activity);

  dom.verdict.dataset.level = r.level;
  dom.statusLine.textContent = r.status;
  dom.headline.textContent = r.headline;
  dom.detail.textContent = r.detail;

  // Meter: show wettedness as a percentage, capped visually at 120%.
  dom.meterSection.hidden = false;
  const pct = r.w === Infinity ? 120 : Math.min(120, Math.round(r.w * 100));
  dom.meterFill.style.width = `${Math.min(100, pct)}%`;
  dom.meterFill.style.background = fillColor(r.level);
  dom.meterValue.textContent = r.w === Infinity ? '∞' : `${pct}%`;
  dom.meterHint.textContent = r.meterHint;

  // Chips
  dom.chips.hidden = false;
  dom.chipTemp.textContent = fmtTemp(t);
  dom.chipHum.textContent = `${Math.round(rh)}%`;
  dom.chipFeels.textContent = fmtTemp(r.feels);
  dom.chipWetbulb.textContent = fmtTemp(r.Tw);

  // Keep manual fields in sync so they're a live starting point.
  dom.manualTemp.value = Math.round(cToDisplay(t) * 10) / 10;
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

function fillColor(level) {
  return {
    great: 'var(--v-great)', good: 'var(--v-good)', warn: 'var(--v-warn)',
    bad: 'var(--v-bad)', crit: 'var(--v-crit)',
  }[level] || 'var(--v-good)';
}

function showMessage(headline, detail, { showManual = false } = {}) {
  delete dom.verdict.dataset.level;
  dom.statusLine.textContent = '';
  dom.headline.textContent = headline;
  dom.detail.textContent = detail;
  if (showManual) dom.manualPanel.open = true;
}

/* ---------- Weather fetch ---------- */

async function fetchWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  const data = await res.json();
  const c = data.current;
  return {
    t: c.temperature_2m,
    rh: c.relative_humidity_2m,
    windMs: (c.wind_speed_10m ?? 0) / 3.6, // km/h → m/s
  };
}

// Best-effort reverse geocode for a friendly place label (no key needed).
async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?latitude=${lat}&longitude=${lon}&count=1`
    );
    if (!res.ok) return null;
    const d = await res.json();
    const p = d.results && d.results[0];
    return p ? [p.name, p.admin1].filter(Boolean).join(', ') : null;
  } catch {
    return null;
  }
}

function locate() {
  if (!('geolocation' in navigator)) {
    showMessage('Location unavailable',
      'Your browser can’t share location. Enter the conditions manually below.',
      { showManual: true });
    return;
  }
  showMessage('Locating you…', 'Reading the weather where you are.');
  dom.refreshBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const [reading, placeName] = await Promise.all([
          fetchWeather(latitude, longitude),
          reverseGeocode(latitude, longitude),
        ]);
        state.reading = { ...reading, source: 'gps', placeName, lat: latitude, lon: longitude };
        render();
      } catch (err) {
        showMessage('Couldn’t get the weather',
          `${err.message}. Check your connection or enter conditions manually.`,
          { showManual: true });
      } finally {
        dom.refreshBtn.disabled = false;
      }
    },
    (err) => {
      dom.refreshBtn.disabled = false;
      const denied = err.code === err.PERMISSION_DENIED;
      showMessage(
        denied ? 'Location permission denied' : 'Couldn’t find your location',
        'Enter the current temperature and humidity manually below and tap Calculate.',
        { showManual: true });
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
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

let leafletMap = null;
let mapMarker = null;
let pickedPoint = null;

function openMap() {
  dom.mapModal.showModal();
  if (!leafletMap) {
    leafletMap = L.map('map', { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(leafletMap);
    leafletMap.on('click', (e) => {
      pickedPoint = e.latlng;
      if (mapMarker) {
        mapMarker.setLatLng(pickedPoint);
      } else {
        mapMarker = L.circleMarker(pickedPoint, {
          radius: 9, weight: 3, color: '#2f6bd8', fillColor: '#5b9dff', fillOpacity: 0.9,
        }).addTo(leafletMap);
      }
      dom.mapConfirm.disabled = false;
    });
  }
  // Center on the current reading if we have coordinates, else a world view.
  const hasCoords = state.reading && state.reading.lat != null;
  leafletMap.setView(
    hasCoords ? [state.reading.lat, state.reading.lon] : [20, 0],
    hasCoords ? 10 : 2
  );
  // The map measures itself while the dialog is still opening; re-measure after.
  setTimeout(() => leafletMap.invalidateSize(), 60);
}

async function confirmMapPick() {
  if (!pickedPoint) return;
  const { lat, lng } = pickedPoint;
  dom.mapModal.close();
  showMessage('Getting the weather…', 'Fetching conditions for the pinned location.');
  try {
    const [reading, placeName] = await Promise.all([
      fetchWeather(lat, lng),
      reverseGeocode(lat, lng),
    ]);
    state.reading = { ...reading, source: 'map', placeName, lat, lon: lng };
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
  for (const b of dom.activity.querySelectorAll('.seg')) {
    b.classList.toggle('is-active', b === btn);
  }
  render();
});

dom.refreshBtn.addEventListener('click', locate);
dom.applyManual.addEventListener('click', applyManual);
dom.mapBtn.addEventListener('click', openMap);
dom.mapClose.addEventListener('click', () => dom.mapModal.close());
dom.mapConfirm.addEventListener('click', confirmMapPick);

dom.unitToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn || btn.dataset.unit === state.unit) return;
  state.unit = btn.dataset.unit;
  for (const b of dom.unitToggle.querySelectorAll('.seg')) {
    b.classList.toggle('is-active', b === btn);
  }
  for (const tag of document.querySelectorAll('.unitTag')) tag.textContent = `°${state.unit}`;
  render();
});

// Register service worker for offline shell / installability.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Kick off on load.
locate();

// Expose model for quick console/unit checks.
window.__canISweat = { evaluate, wetBulb, heatIndex };
