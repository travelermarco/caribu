'use strict';

// ── History / Snapshot storage ────────────────────────────────────────────────
const STORE_KEY   = 'caribu_history_v1';
const INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const MAX_AGE_MS  = 7 * 24 * 3600 * 1000; // 7 days

let _lastPush = 0;

function _load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}

function _save(arr) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); }
  catch (e) { console.warn('history.js: save failed', e); }
}

/**
 * pushSnapshot({ soc, pvW, battW, temp })
 * Throttled to one write every 5 minutes.
 * Prunes entries older than 7 days automatically.
 */
export function pushSnapshot(snap) {
  const now = Date.now();
  if (now - _lastPush < INTERVAL_MS) return;
  _lastPush = now;

  const arr = _load();
  arr.push({ ts: now, ...snap });

  // Prune
  const cutoff = now - MAX_AGE_MS;
  const pruned = arr.filter(e => e.ts >= cutoff);
  _save(pruned);
}

/**
 * getRecent(hours) — returns entries from the last N hours.
 */
export function getRecent(hours = 24) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  return _load().filter(e => e.ts >= cutoff);
}

/**
 * estimateAutonomy(state) — stima autonomia in ore basata su consumo medio ultime 2h.
 * Ritorna ore (float) o null se dati insufficienti.
 */
export function estimateAutonomy(state) {
  const soc      = parseInt(state.bms?.soc);
  const capacity = parseFloat(state.bms?.capacity);
  const voltage  = parseFloat(state.bms?.voltage);
  if (isNaN(soc) || isNaN(capacity) || isNaN(voltage) || capacity <= 0 || voltage <= 0) return null;

  const recent = getRecent(2).filter(p => p.battW != null);
  if (recent.length < 3) return null;

  const avgNetW = recent.reduce((s, p) => s + p.battW, 0) / recent.length;
  const netLoadW = -avgNetW; // positivo = batteria in scarica
  if (netLoadW <= 1) return null;

  const remainingWh = (soc / 100) * capacity * voltage;
  return remainingWh / netLoadW;
}

/**
 * getCumulativeEnergy(hours) — kWh prodotti e consumati negli ultimi N ore.
 */
export function getCumulativeEnergy(hours = 24) {
  const points = getRecent(hours).filter(p => p.pvW != null || p.battW != null);
  if (!points.length) return { pvKwh: 0, loadKwh: 0 };
  const intervalH = INTERVAL_MS / 3600000;
  let pvKwh = 0, loadKwh = 0;
  for (const p of points) {
    pvKwh   += ((p.pvW ?? 0) * intervalH) / 1000;
    const loadW = Math.max(0, (p.pvW ?? 0) - Math.max(0, p.battW ?? 0));
    loadKwh += (loadW * intervalH) / 1000;
  }
  return { pvKwh, loadKwh };
}

/**
 * getNightStats(dateStr?) — stats for the night starting on dateStr (YYYY-MM-DD, default yesterday).
 * A "night" spans 22:00 of dateStr → 09:00 of dateStr+1.
 * Returns { min, max, avg, heaterMins, points } or null if no data.
 */
export function getNightStats(dateStr) {
  const base = dateStr
    ? new Date(dateStr + 'T22:00:00')
    : (() => { const d = new Date(); d.setDate(d.getDate() - (d.getHours() < 9 ? 1 : 0)); d.setHours(22,0,0,0); return d; })();
  const nightStart = base.getTime();
  const nightEnd   = nightStart + 11 * 3600 * 1000; // +11h → 09:00 next day

  const points = _load().filter(p => p.temp != null && p.ts >= nightStart && p.ts <= nightEnd);
  if (!points.length) return null;

  const temps = points.map(p => p.temp);
  const min   = Math.min(...temps);
  const max   = Math.max(...temps);
  const avg   = temps.reduce((a, b) => a + b, 0) / temps.length;
  const heaterMins = points.length * (INTERVAL_MS / 60000);

  return { min, max, avg: Math.round(avg * 10) / 10, heaterMins: Math.round(heaterMins), points };
}

// ── SVG time-series chart ─────────────────────────────────────────────────────
const W = 320, H = 90;
const PAD = { t: 6, r: 4, b: 18, l: 36 };
const PW  = W - PAD.l - PAD.r;   // plot width
const PH  = H - PAD.t - PAD.b;   // plot height

function fmt2(n) { return String(n).padStart(2, '0'); }
function timeLabel(ts) {
  const d = new Date(ts);
  return `${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
}

/**
 * drawHistChart(domElement, field, { color, unit, label, yMin, yMax })
 *
 * Renders an SVG time-series chart inside domElement.
 * field: key to read from each snapshot ('soc' | 'pvW' | 'battW' | 'temp')
 */
export function drawHistChart(domElement, field, { color = '#38BDF8', unit = '', label = '', yMin, yMax } = {}) {
  if (!domElement) return;

  const points = getRecent(24).filter(e => e[field] != null);

  if (points.length < 2) {
    domElement.innerHTML = `
      <div style="font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-2);margin-bottom:4px">${label}</div>
      <div class="hist-empty">Raccolta dati in corso…</div>`;
    return;
  }

  const vals  = points.map(p => p[field]);
  const times = points.map(p => p.ts);

  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const lo = yMin !== undefined ? Math.min(yMin, rawMin) : rawMin;
  const hi = yMax !== undefined ? Math.max(yMax, rawMax) : rawMax;
  const range = hi - lo || 1;

  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tRange = tMax - tMin || 1;

  // Map value → Y (SVG, top=0)
  const yOf = v => PAD.t + PH - ((v - lo) / range) * PH;
  // Map timestamp → X
  const xOf = t => PAD.l + ((t - tMin) / tRange) * PW;

  // Build polyline points
  const ptStr = points.map(p => `${xOf(p.ts).toFixed(1)},${yOf(p[field]).toFixed(1)}`).join(' ');

  // Area path (closed shape for gradient fill)
  const firstX = xOf(times[0]).toFixed(1);
  const lastX  = xOf(times[times.length - 1]).toFixed(1);
  const baseY  = (PAD.t + PH).toFixed(1);
  const areaD  = `M${firstX},${baseY} ` +
    points.map(p => `L${xOf(p.ts).toFixed(1)},${yOf(p[field]).toFixed(1)}`).join(' ') +
    ` L${lastX},${baseY} Z`;

  // Y-axis ticks (3 levels: lo, mid, hi)
  const mid = (lo + hi) / 2;
  const yTicks = [
    { v: hi,  y: yOf(hi) },
    { v: mid, y: yOf(mid) },
    { v: lo,  y: yOf(lo) },
  ];

  // Time ticks: first and last
  const tTicks = [
    { ts: times[0],                 x: xOf(times[0]) },
    { ts: times[times.length - 1],  x: xOf(times[times.length - 1]) },
  ];

  const gradId = `hg_${field}`;

  const svg = `
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Y grid lines + labels -->
  ${yTicks.map(tk => `
  <line x1="${PAD.l}" y1="${tk.y.toFixed(1)}" x2="${W - PAD.r}" y2="${tk.y.toFixed(1)}"
        stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <text x="${PAD.l - 3}" y="${(tk.y + 3.5).toFixed(1)}"
        text-anchor="end" font-size="7.5" fill="rgba(255,255,255,0.35)">${Math.round(tk.v)}${unit}</text>`).join('')}

  <!-- Area fill -->
  <path d="${areaD}" fill="url(#${gradId})"/>

  <!-- Line -->
  <polyline points="${ptStr}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>

  <!-- Time labels -->
  ${tTicks.map((tk, i) => `
  <text x="${Math.min(Math.max(tk.x, PAD.l + 2), W - PAD.r - 20).toFixed(1)}"
        y="${H - 3}"
        text-anchor="${i === 0 ? 'start' : 'end'}"
        font-size="7.5" fill="rgba(255,255,255,0.3)">${timeLabel(tk.ts)}</text>`).join('')}
</svg>`;

  domElement.innerHTML = `
    <div style="font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--text-2);margin-bottom:4px">${label}</div>
    ${svg}`;
}
