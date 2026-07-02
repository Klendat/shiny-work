/* "The Thermometer" (design 1c) controller.
 * All state, geolocation, map and manual-entry flow comes from CIS.createApp;
 * this file only paints the full-bleed verdict screen. Colour and copy follow
 * the calibrated evaluate() verdict; the sweat-load % is shown on its own bar. */

'use strict';

const CIS = window.CIS;

// Gradient "from" colour per tier — used to keep the browser chrome in sync.
const THEME = { ok: '#0f766e', watch: '#a16207', high: '#c2410c', over: '#b91c1c', critical: '#7f1d1d' };
const themeMeta = document.querySelector('meta[name="theme-color"]');

const root = document.getElementById('root');
const els = {
  temp: document.getElementById('temp'),
  meta: document.getElementById('meta'),
  sentence: document.getElementById('sentence'),
  loadValue: document.getElementById('loadValue'),
  loadFill: document.getElementById('loadFill'),
  place: document.getElementById('place'),
  manualPanel: document.getElementById('manualPanel'),
};

// Degrees-only display (e.g. "33°"), honouring the current unit.
const deg = (c, unit) => `${Math.round(CIS.toDisplay(c, unit))}°`;

function setTier(tier) {
  root.dataset.tier = tier;
  if (themeMeta && THEME[tier]) themeMeta.setAttribute('content', THEME[tier]);
}

function placeLabel(reading) {
  if (!reading) return '';
  if (reading.source === 'manual') return 'Manual conditions';
  if (reading.placeName) return reading.placeName;
  if (reading.lat != null) return `${reading.lat.toFixed(3)}, ${reading.lon.toFixed(3)}`;
  return '';
}

function render(r, state) {
  const tier = CIS.TIER_FROM_LEVEL[r.level];
  setTier(tier);

  els.temp.textContent = deg(r.t, state.unit);
  els.meta.textContent =
    `feels like ${deg(r.feels, state.unit)} · humidity ${Math.round(r.rh)}% · wet-bulb ${deg(r.Tw, state.unit)}`;
  els.sentence.textContent = r.headline;

  const crit = r.w === Infinity;
  const pct = crit ? 120 : Math.min(120, Math.round(r.w * 100));
  els.loadValue.textContent = crit ? 'off the scale' : `${pct}%`;
  els.loadFill.style.width = `${Math.min(100, pct)}%`;

  els.place.textContent = placeLabel(state.reading);
}

function showMessage(headline, detail, opts) {
  // Loading / error states use the calm teal field (README).
  setTier('ok');
  els.temp.textContent = '—';
  els.meta.textContent = detail || ' ';
  els.sentence.textContent = headline;
  els.loadValue.textContent = '—';
  els.loadFill.style.width = '0%';
  if (opts && opts.showManual && els.manualPanel) els.manualPanel.hidden = false;
}

CIS.createApp({ render, showMessage });
