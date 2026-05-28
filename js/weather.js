'use strict';

// ── Open-Meteo weather module ─────────────────────────────────────────────────

const CACHE_KEY_WEATHER = 'caribu_weather_v1';
const CACHE_KEY_COORDS  = 'caribu_coords_v1';
const WEATHER_TTL_MS    = 60 * 60 * 1000;   // 1h
const COORDS_TTL_MS     = 10 * 60 * 1000;   // 10min

// ── Coords ────────────────────────────────────────────────────────────────────

/**
 * getCoords() — resolves to { lat, lon }.
 * Uses navigator.geolocation with 10-min cache.
 */
export async function getCoords() {
  const cached = _loadJSON(CACHE_KEY_COORDS);
  if (cached && Date.now() - cached.ts < COORDS_TTL_MS) {
    return { lat: cached.lat, lon: cached.lon };
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocalizzazione non supportata da questo browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        _saveJSON(CACHE_KEY_COORDS, { lat, lon, ts: Date.now() });
        resolve({ lat, lon });
      },
      err => reject(new Error(`GPS non disponibile: ${err.message}`)),
      { timeout: 10000, maximumAge: COORDS_TTL_MS }
    );
  });
}

// ── Weather fetch ─────────────────────────────────────────────────────────────

/**
 * getWeather() — returns full Open-Meteo response (cached 1h).
 */
export async function getWeather() {
  const cached = _loadJSON(CACHE_KEY_WEATHER);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    return cached.data;
  }

  const { lat, lon } = await getCoords();
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,sunrise,sunset`
    + `&hourly=direct_radiation,cloudcover`
    + `&timezone=auto&forecast_days=3`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const data = await resp.json();
  data._lat = lat;
  data._lon = lon;
  _saveJSON(CACHE_KEY_WEATHER, { ts: Date.now(), data });
  return data;
}

// ── WMO code → label ──────────────────────────────────────────────────────────

export function wmoLabel(code) {
  if (code === 0)                return { emoji: '☀️',  text: 'Sereno' };
  if (code === 1)                return { emoji: '🌤',  text: 'Parz. sereno' };
  if (code === 2)                return { emoji: '⛅',  text: 'Variabile' };
  if (code === 3)                return { emoji: '☁️',  text: 'Coperto' };
  if (code === 45 || code === 48) return { emoji: '🌫', text: 'Nebbia' };
  if (code >= 51 && code <= 55)  return { emoji: '🌦',  text: 'Pioggerella' };
  if (code >= 61 && code <= 65)  return { emoji: '🌧',  text: 'Pioggia' };
  if (code >= 71 && code <= 75)  return { emoji: '🌨',  text: 'Neve' };
  if (code >= 80 && code <= 82)  return { emoji: '🌦',  text: 'Rovesci' };
  if (code === 95 || code === 96 || code === 99) return { emoji: '⛈', text: 'Temporale' };
  return { emoji: '🌡', text: `Codice ${code}` };
}

// ── Solar forecast ────────────────────────────────────────────────────────────

/**
 * solarForecast(data) — media irradianza diretta ore diurne di oggi (W/m²).
 */
export function solarForecast(data) {
  const hours  = data.hourly?.time || [];
  const rads   = data.hourly?.direct_radiation || [];
  const today  = (data.daily?.time || [])[0] || '';
  const todayH = hours.reduce((acc, t, i) => {
    if (t.startsWith(today) && rads[i] > 0) acc.push(rads[i]);
    return acc;
  }, []);
  if (!todayH.length) return null;
  return todayH.reduce((a, b) => a + b, 0) / todayH.length;
}

// ── renderWeather ─────────────────────────────────────────────────────────────

/**
 * renderWeather(containerId) — async, populates the container.
 */
export async function renderWeather(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let data;
  try {
    data = await getWeather();
  } catch (err) {
    // If geolocation failed, show manual input form
    container.innerHTML = _manualForm(containerId, err.message);
    return;
  }

  container.innerHTML = _buildHtml(data);
}

// Helper called from manual form submit
window._weatherManualSubmit = async (containerId) => {
  const latEl = document.getElementById('_wx_lat');
  const lonEl = document.getElementById('_wx_lon');
  if (!latEl || !lonEl) return;
  const lat = parseFloat(latEl.value);
  const lon = parseFloat(lonEl.value);
  if (isNaN(lat) || isNaN(lon)) { alert('Coordinate non valide'); return; }
  // Save manually entered coords
  _saveJSON(CACHE_KEY_COORDS, { lat, lon, ts: Date.now() });
  // Clear old weather cache so we re-fetch
  localStorage.removeItem(CACHE_KEY_WEATHER);
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = '<div class="connect-placeholder"><div class="icon">🌤</div><p>Caricamento…</p></div>';
  try {
    const d = await getWeather();
    if (container) container.innerHTML = _buildHtml(d);
  } catch (e) {
    if (container) container.innerHTML = `<div class="alert alert-err">❌ ${e.message}</div>`;
  }
};

function _buildHtml(data) {
  const days  = data.daily?.time || [];
  const tMax  = data.daily?.temperature_2m_max || [];
  const tMin  = data.daily?.temperature_2m_min || [];
  const codes = data.daily?.weathercode || [];
  const prec  = data.daily?.precipitation_sum || [];
  const lat   = data._lat?.toFixed(4) ?? '—';
  const lon   = data._lon?.toFixed(4) ?? '—';
  const now   = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const radAvg = solarForecast(data);

  const dayNames = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  const dayCards = days.map((d, i) => {
    const date = new Date(d + 'T12:00:00');
    const name = i === 0 ? 'Oggi' : i === 1 ? 'Domani' : dayNames[date.getDay()];
    const { emoji, text } = wmoLabel(codes[i] ?? 0);
    const rain = prec[i] > 0 ? `<div class="weather-rain">💧 ${prec[i]?.toFixed(1)} mm</div>` : '';
    return `
    <div class="weather-day">
      <div class="weather-day-name">${name}</div>
      <div class="weather-emoji">${emoji}</div>
      <div class="weather-temps"><span style="color:var(--amber)">${Math.round(tMax[i] ?? 0)}°</span>&nbsp;<span class="lo">${Math.round(tMin[i] ?? 0)}°</span></div>
      <div class="weather-desc">${text}</div>
      ${rain}
    </div>`;
  }).join('');

  let solarHtml = '';
  if (radAvg !== null) {
    const quality = radAvg > 200 ? { label: 'Ottima ☀️', color: 'var(--amber)' }
                  : radAvg > 100 ? { label: 'Buona 🌤', color: 'var(--green)' }
                  :                { label: 'Bassa ☁️', color: 'var(--text-2)' };
    solarHtml = `
    <div class="card" style="margin-top:10px">
      <div class="card-title">☀️ Stima produzione solare (oggi)</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:26px;font-weight:800;color:${quality.color}">${Math.round(radAvg)}<span style="font-size:12px;font-weight:500;color:var(--text-2)"> W/m²</span></div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">Irradianza media diretta ore diurne</div>
        </div>
        <div style="font-size:22px;font-weight:700;color:${quality.color}">${quality.label}</div>
      </div>
    </div>`;
  }

  return `
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">📍 Posizione</div>
      <div style="font-size:13px;color:var(--text-2)">Lat ${lat}, Lon ${lon}</div>
    </div>
    <div class="weather-grid">${dayCards}</div>
    ${solarHtml}
    <div style="font-size:10px;color:var(--text-2);text-align:right;margin-top:6px">Aggiornato alle ${now} · Open-Meteo</div>`;
}

function _manualForm(containerId, errMsg) {
  return `
    <div class="alert alert-err">❌ ${errMsg}</div>
    <div class="card">
      <div class="card-title">📍 Inserisci coordinate manualmente</div>
      <div class="settings-row">
        <label>Latitudine</label>
        <input type="number" id="_wx_lat" placeholder="45.4654" step="0.0001"
          style="flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;min-width:0">
      </div>
      <div class="settings-row">
        <label>Longitudine</label>
        <input type="number" id="_wx_lon" placeholder="9.1859" step="0.0001"
          style="flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;min-width:0">
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="window._weatherManualSubmit('${containerId}')">🌤 Carica meteo</button>
    </div>
    <p style="font-size:12px;color:var(--text-2);padding:0 4px;line-height:1.6">Abilita il GPS nelle impostazioni del browser per ottenere le previsioni in automatico.</p>`;
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function _loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function _saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { console.warn('weather.js: save failed', e); }
}
