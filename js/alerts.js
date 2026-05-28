'use strict';

import { getCoords } from './weather.js';

const HAIL_CODES = new Set([96, 99]);
const WIND_KMH   = 60;
const CACHE_KEY  = 'caribu_alerts_v1';
const CACHE_TTL  = 30 * 60 * 1000;

export async function checkWeatherAlerts() {
  const cached = _load();
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.alerts;

  try {
    const { lat, lon } = await getCoords();
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
      + `&hourly=weathercode,windgusts_10m&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();

    const now     = Date.now();
    const horizon = now + 12 * 3600 * 1000;
    const hours   = (data.hourly?.time || []).map((t, i) => ({
      ms:   new Date(t).getTime(),
      code: data.hourly.weathercode[i],
      gust: data.hourly.windgusts_10m[i] || 0,
    })).filter(h => h.ms > now && h.ms <= horizon);

    const alerts = [];
    if (hours.some(h => HAIL_CODES.has(h.code))) {
      alerts.push({ type: 'hail', icon: '🌨', title: 'Allerta grandine', msg: 'Grandine prevista nelle prossime 12 ore — ricovera il van' });
    }
    const maxGust = hours.reduce((m, h) => Math.max(m, h.gust), 0);
    if (maxGust >= WIND_KMH) {
      alerts.push({ type: 'wind', icon: '💨', title: 'Vento forte', msg: `Raffiche fino a ${Math.round(maxGust)} km/h previste` });
    }

    _save({ ts: now, alerts });
    return alerts;
  } catch {
    return [];
  }
}

export function renderWeatherAlerts(alerts, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!alerts?.length) { el.style.display = 'none'; return; }
  el.innerHTML = alerts.map(a => `
    <div class="alert-weather alert-weather-${a.type}">
      <span class="alert-weather-icon">${a.icon}</span>
      <div>
        <div class="alert-weather-title">${a.title}</div>
        <div class="alert-weather-msg">${a.msg}</div>
      </div>
    </div>`).join('');
  el.style.display = '';
}

function _load()  { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } }
function _save(v) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch {} }
