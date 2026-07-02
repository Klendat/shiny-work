/* "The Instrument" (design 1b) controller.
 * Paints a monospaced cockpit gauge from the calibrated evaluate() verdict.
 * The gauge arc sweeps 0–120% of sweat load over a 270° dial; the tone colour
 * (green→red) follows the verdict tier, not the raw percentage. */

'use strict';

const CIS = window.CIS;

const TONE = { ok: '#4ade80', watch: '#facc15', high: '#fb923c', over: '#f87171', critical: '#ff4d4d' };

// Arc geometry (r = 84): full circumference, and a 270° visible span.
const CIRC = 2 * Math.PI * 84;   // ≈ 527.79
const SPAN = CIRC * 0.75;        // ≈ 395.84 (the dial sweeps three-quarters)

const root = document.getElementById('root');
const arc = document.getElementById('gaugeArc');
const els = {
  pct: document.getElementById('pct'),
  status: document.getElementById('status'),
  head: document.getElementById('head'),
  detail: document.getElementById('detail'),
  cellTemp: document.getElementById('cellTemp'),
  cellHum: document.getElementById('cellHum'),
  cellFeels: document.getElementById('cellFeels'),
  cellWet: document.getElementById('cellWet'),
  place: document.getElementById('place'),
  manualPanel: document.getElementById('manualPanel'),
};

function placeLabel(reading) {
  if (!reading) return '—';
  if (reading.source === 'manual') return 'MANUAL';
  if (reading.placeName) return reading.placeName;
  if (reading.lat != null) return `${reading.lat.toFixed(2)}, ${reading.lon.toFixed(2)}`;
  return '—';
}

function setArc(pct) {
  const fill = SPAN * Math.min(pct, 120) / 120;
  arc.setAttribute('stroke-dasharray', `${fill.toFixed(1)} ${CIRC.toFixed(1)}`);
}

function render(r, state) {
  const tier = CIS.TIER_FROM_LEVEL[r.level];
  root.style.setProperty('--tone', TONE[tier]);
  arc.style.stroke = TONE[tier];

  const crit = r.w === Infinity;
  const pct = crit ? 120 : Math.min(120, Math.round(r.w * 100));
  setArc(pct);
  els.pct.textContent = crit ? 'N/A' : `${pct}%`;

  els.status.textContent = `▮ ${r.status.toUpperCase()}`;
  els.head.textContent = r.headline;
  els.detail.textContent = r.detail;

  els.cellTemp.textContent = CIS.fmtTemp(r.t, state.unit);
  els.cellHum.textContent = `${Math.round(r.rh)}%`;
  els.cellFeels.textContent = CIS.fmtTemp(r.feels, state.unit);
  els.cellWet.textContent = CIS.fmtTemp(r.Tw, state.unit);
  els.place.textContent = placeLabel(state.reading);
}

function showMessage(headline, detail, opts) {
  els.status.textContent = '▮ STANDBY';
  els.head.textContent = headline;
  els.detail.textContent = detail || '';
  els.pct.textContent = '—';
  setArc(0);
  if (opts && opts.showManual && els.manualPanel) els.manualPanel.hidden = false;
}

CIS.createApp({ render, showMessage });
