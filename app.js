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
const H_RADIATIVE = 4.5;   // W/m²·K, whole-body radiative coeff (de Dear 1997)
const LEWIS = 16.5;        // W/m²·kPa per W/m²·K (Lewis relation for air)
const MAX_SWEAT_COOLING = 450; // W/m² — peak evaporative cooling the body can
                               // actually produce. ~350–400 for an average
                               // unacclimatized adult, ~560+ for a fit,
                               // acclimatized one; 450 is a conservative middle.

// Metabolic heat production by activity (W/m² of body surface).
const METABOLIC = {
  rest: 65,       // sitting / standing still (~1.1 MET)
  light: 130,     // walking, easy chores (~2.2 MET)
  moderate: 230,  // brisk work, cycling (~4 MET)
  hard: 350,      // running, heavy labor (~6 MET)
};

// Age-group heat-vulnerability adjustments. Two effects:
//   • offset  — degrees added to the perceived wet-bulb / air temperature for
//     the risk tiers. Vulnerable groups reach danger at lower ambient heat.
//   • sweat   — fraction of an adult's evaporative (sweat) capacity.
// Calibrated to the heat-physiology literature (Vecellio 2022, Wolf 2023,
// Vanos 2023, Falk & Dotan 2008). Only three groups are actually distinguishable
// from the data — children, healthy adults, older adults — so we use those;
// "infant" is kept for parents but flagged as not calibratable (little hard
// human data; much infant risk is caregiver dependence, not physiology).
// These are coarse RISK adjustments, not per-person predictions.
const AGE = {
  infant:  { offset: 3.5, sweat: 0.50, vulnerable: true, lowConfidence: true,
             note: 'For infants and toddlers this is a rough guide only — there’s little hard data on infant heat limits, and much of the danger is being left in a hot room or car. Never leave a small child in the heat, and don’t rely on an app.' },
  child:   { offset: 1.0, sweat: 0.70, vulnerable: false, lowConfidence: false, note: '' },
  adult:   { offset: 0.0, sweat: 1.00, vulnerable: false, lowConfidence: false, note: '' },
  older:   { offset: 2.5, sweat: 0.70, vulnerable: true, lowConfidence: false,
             note: 'Older adults sweat less, feel thirst less, and may take medications that reduce heat tolerance — take this more seriously than the numbers alone suggest.' },
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
 * @param {string} age  key of AGE
 */
function evaluate(t, rh, windMs, activity, age) {
  const Tw = wetBulb(t, rh);
  const feels = heatIndex(t, rh);
  const ageAdj = AGE[age] ?? AGE.adult;

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
  // The usable evaporative cooling is the lesser of what the air permits and
  // what the body can actually sweat — otherwise a breeze invents capacity.
  // The sweat ceiling is scaled down for age groups that sweat less.
  const Eusable = Math.min(Emax, MAX_SWEAT_COOLING * ageAdj.sweat);

  // Skin wettedness required: the fraction of skin that must be sweat-soaked.
  // w <= 1 → sweat can compensate; w > 1 → it cannot.
  let w;
  if (Ereq <= 0) {
    w = 0; // no evaporative cooling needed (air is cool relative to skin/heat)
  } else if (Eusable <= 0) {
    w = Infinity; // air is saturated at skin temp — evaporation impossible
  } else {
    w = Ereq / Eusable;
  }

  const level = classify(w, Tw, t, ageAdj);
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
//   • Air temperature is a third floor: once it reaches skin temp (~35 °C) the
//     air ADDS heat to you and sweat is your only cooling — so a low sweat load
//     (often thanks to wind) must never read as "easy". Wind aids evaporation
//     in dry heat, but it can't be trusted to cool you when the air is this hot.
function classify(w, Tw, t, age) {
  const result = pickVerdict(w, Tw, t, age);
  // Append the age note. Low-confidence groups (infants) always show it — the
  // "don't rely on an app" message matters even in mild conditions. Others show
  // it only when we're actually flagging something (warn/bad/crit).
  if (age.note) {
    const flagged = result.level !== 'great' && result.level !== 'good';
    if (age.lowConfidence || flagged) result.detail += ` ${age.note}`;
  }
  return result;
}

function pickVerdict(w, Tw, t, age) {
  // Physical limit first — evaporation is impossible for ANYONE at this
  // wet-bulb, so age can't change it. Uses the real wet-bulb, not adjusted.
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

  // For the risk tiers below, treat the environment as hotter for vulnerable
  // ages: they reach the same danger at a lower true temperature.
  const TwR = Tw + age.offset;
  const tR = t + age.offset;

  // Dangerous wet-bulb: risky even at rest, and worse if you can't keep up.
  if (TwR >= 31) {
    return {
      level: 'bad',
      status: 'Dangerous heat',
      headline: 'Cool down another way',
      detail:
        'The wet-bulb temperature is in the dangerous range — sweat can barely ' +
        'evaporate even at rest. Seek shade/AC, wet the skin, use a fan, and limit ' +
        'exertion. Core temperature can climb here.',
      meterHint: 'Wet-bulb this high leaves almost no evaporative capacity.',
    };
  }

  // Sweat can't keep up with this effort (w > 1).
  if (w > 1) {
    if (TwR >= 27) {
      // Warm AND overloaded — genuinely cool down another way.
      return {
        level: 'bad',
        status: 'Sweat can’t keep up',
        headline: 'Cool down another way',
        detail:
          'At this effort you’re making more heat than the warm, humid air lets you ' +
          'sweat off. Core temperature will rise. Ease off, seek shade/AC, wet the ' +
          'skin or use a fan.',
        meterHint: 'Above 100%: sweat can’t evaporate fast enough for this effort.',
      };
    }
    // Cool air but hard effort — normal, self-limiting, not dangerous.
    return {
      level: 'warn',
      status: 'Sweat maxed for this effort',
      headline: 'Sweat is at its limit',
      detail:
        'Working hard enough to outpace evaporation means warming up — but the air ' +
        'itself is cool, so this isn’t dangerous. Ease off or hydrate and it settles.',
      meterHint: 'Above 100%, but cool air keeps this safe — just expect to run hot.',
    };
  }

  // Sweat is keeping up, but the air itself is hot. A wet-bulb this high is a
  // genuine heat-stress environment even when the sweat load looks modest —
  // heavy sweating and fluid loss, so this must never read as "easy".
  if (TwR >= 27) {
    return {
      level: 'warn',
      status: 'Hot — heat-stress zone',
      headline: 'It’s hot — don’t overdo it',
      detail:
        'Sweat is keeping up for now, but this is a genuinely hot, humid ' +
        `environment (wet-bulb ${Math.round(Tw)} °C). Expect heavy sweating and ` +
        'fluid loss — drink plenty, rest in shade or AC, and avoid hard exertion.',
      meterHint:
        'The sweat load may look modest, but the air itself is hot — heat still ' +
        'strains the body here.',
    };
  }

  // Air at or above skin temperature: it's adding heat, and evaporating sweat
  // is the ONLY cooling. Dry enough that wind still helps, but fluid is going
  // fast and a lull in wind or rise in humidity tips you over.
  if (tR >= 35) {
    return {
      level: 'warn',
      status: 'Hot — running on sweat alone',
      headline: 'The air is adding heat',
      detail:
        'The air is hotter than skin, so it’s warming the body — only sweat ' +
        'evaporating is cooling it. It’s dry enough that sweating works, but a hot ' +
        'breeze won’t cool you (a humid one makes it worse), and fluid is going ' +
        'fast. Drink constantly, seek shade or AC, and don’t rely on the wind.',
      meterHint: 'Cooling depends entirely on sweat evaporating — the air gives none back.',
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
  // Moderate load, warm-but-muggy air (wet-bulb 24–27 °C), or simply hot air
  // (≥33 °C): comfortable, but not "nothing" — you'll feel it and should drink.
  if (w > 0.5 || TwR >= 24 || tR >= 33) {
    return {
      level: 'good',
      status: 'Sweat is working',
      headline: 'You’re cooling fine',
      detail:
        'Sweat is evaporating well and keeping you in balance. It may feel warm ' +
        'or muggy, so keep drinking water — but there’s room to spare.',
      meterHint: 'Comfortable margin before sweat is maxed out.',
    };
  }
  return {
    level: 'great',
    status: 'Sweat is working',
    headline: 'Plenty of cooling margin',
    detail:
      'Conditions are easy for the body — sweat evaporates readily and there’s lots ' +
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
  age: 'adult',
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

const cToDisplay = (c) => (state.unit === 'F' ? c * 9 / 5 + 32 : c);
const fmtTemp = (c) => `${Math.round(cToDisplay(c))}°${state.unit}`;

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

dom.ageGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  state.age = btn.dataset.age;
  for (const b of dom.ageGroup.querySelectorAll('.seg')) {
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
