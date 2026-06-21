'use strict';

// ── Campsite log module ───────────────────────────────────────────────────────

const STORE_KEY   = 'caribu_camps_v1';
const STILL_DIST  = 200;     // metres to be considered "still"
const STILL_TIME  = 10 * 60 * 1000; // 10 min in ms

let _watchId     = null;
let _lastPos     = null;    // { lat, lon, ts }
let _stillSince  = null;    // timestamp when we stopped moving
let _loggedToday = null;    // date string (YYYY-MM-DD) of last auto-log

// ── Storage ───────────────────────────────────────────────────────────────────

export function getCampsites() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
  catch { return []; }
}

function _save(arr) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); }
  catch (e) { console.warn('campsites.js: save failed', e); }
}

export function deleteCampsite(id) {
  _save(getCampsites().filter(c => c.id !== id));
}

export function updateNotes(id, notes) {
  const arr = getCampsites().map(c => c.id === id ? { ...c, notes } : c);
  _save(arr);
}

// Mark current campsite as departed
function _markDeparted(id) {
  const arr = getCampsites().map(c =>
    c.id === id && !c.departure ? { ...c, departure: new Date().toISOString() } : c
  );
  _save(arr);
}

// ── Weather at arrival ────────────────────────────────────────────────────────

async function _fetchArrivalWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&current_weather=true`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const cw = data.current_weather;
    if (!cw) return null;
    return { temp: Math.round(cw.temperature), code: cw.weathercode };
  } catch {
    return null;
  }
}

// ── WMO weather code → emoji ──────────────────────────────────────────────────

function _wmoEmoji(code) {
  if (code === 0)                return '☀️';
  if (code === 1)                return '🌤';
  if (code === 2)                return '⛅';
  if (code === 3)                return '☁️';
  if (code === 45 || code === 48) return '🌫';
  if (code >= 51 && code <= 65)  return '🌧';
  if (code >= 71 && code <= 77)  return '🌨';
  if (code >= 80 && code <= 82)  return '🌦';
  if (code >= 95)                return '⛈';
  return '🌡';
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

async function _reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=it`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'CaribuApp/1.0' }
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const a = json.address || {};
    return a.village || a.town || a.city || a.municipality || a.county || json.display_name || null;
  } catch {
    return null;
  }
}

// ── Tracking ──────────────────────────────────────────────────────────────────

/**
 * Haversine distance in metres.
 */
function _dist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function _onPosition(pos) {
  const lat = pos.coords.latitude;
  const lon = pos.coords.longitude;
  const now = Date.now();

  if (!_lastPos) {
    _lastPos = { lat, lon, ts: now };
    _stillSince = now;
    return;
  }

  const d = _dist(_lastPos.lat, _lastPos.lon, lat, lon);

  if (d > STILL_DIST) {
    // Moving — close any open campsite
    const arr = getCampsites();
    const open = arr.find(c => !c.departure);
    if (open) _markDeparted(open.id);

    _lastPos   = { lat, lon, ts: now };
    _stillSince = now;
    return;
  }

  // Still — check if long enough
  const stillFor = now - (_stillSince || now);
  if (stillFor >= STILL_TIME) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const arr = getCampsites();
    const hasOpen = arr.some(c => !c.departure);

    if (!hasOpen && _loggedToday !== todayStr) {
      _loggedToday = todayStr;
      const [address, weather] = await Promise.all([
        _reverseGeocode(lat, lon).then(a => a ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`),
        _fetchArrivalWeather(lat, lon),
      ]);
      const entry = {
        id:       `camp_${now}`,
        lat, lon,
        address,
        weather,
        arrival:   new Date().toISOString(),
        departure: null,
        notes:     '',
      };
      _save([entry, ...getCampsites()]);
    }
  }
}

/**
 * startTracking() — starts geolocation watchPosition.
 * Safe to call multiple times (only one watch active).
 */
export function startTracking() {
  if (!navigator.geolocation) return;
  if (_watchId !== null) return;
  _watchId = navigator.geolocation.watchPosition(
    _onPosition,
    err => console.warn('campsites.js: GPS error', err),
    { enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 }
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

function _nights(arrival, departure) {
  const a = new Date(arrival);
  const b = departure ? new Date(departure) : new Date();
  return Math.max(0, Math.round((b - a) / 86400000));
}

function _fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * renderCampsites(containerId) — renders the campsite list.
 */
export function renderCampsites(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const arr = getCampsites();
  if (!arr.length) {
    container.innerHTML = `<div class="connect-placeholder"><div class="icon">📍</div><p>Nessun campeggio registrato.<br>Il rilevamento automatico si attiva quando resti fermo per 10+ minuti.</p></div>`;
    return;
  }

  container.innerHTML = arr.map(c => {
    const active = !c.departure;
    const nights = _nights(c.arrival, c.departure);
    const nightLabel = nights === 0 ? 'Prima notte' : nights === 1 ? '1 notte' : `${nights} notti`;
    const weatherBadge = c.weather
      ? `<span style="font-size:11px;color:var(--text-2)">${_wmoEmoji(c.weather.code)} ${c.weather.temp}°C all'arrivo</span>`
      : '';
    return `
    <div class="camp-card ${active ? 'camp-active' : ''}">
      <div class="camp-header">
        <div>
          <div class="camp-location">📍 ${c.address}</div>
          <div class="camp-date">Arrivo: ${_fmtDate(c.arrival)} · ${nightLabel}</div>
          ${c.departure ? `<div class="camp-date">Partenza: ${_fmtDate(c.departure)}</div>` : ''}
          ${weatherBadge}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          ${active ? '<span class="badge badge-green"><span class="badge-dot"></span>Qui ora</span>' : ''}
          <button class="btn btn-ghost" style="padding:5px 10px;font-size:11px" onclick="window.deleteCamp('${c.id}')">🗑</button>
        </div>
      </div>
      <textarea class="camp-notes" placeholder="Note…" onchange="window.updateCampNotes('${c.id}',this.value)">${c.notes || ''}</textarea>
    </div>`;
  }).join('');
}
