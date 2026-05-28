'use strict';

// ── Push notification module ──────────────────────────────────────────────────

const STORE_KEY = 'caribu_notif_v1';
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min per type

const DEFAULT_THRESHOLDS = {
  socLow:    20,
  socFull:   95,
  tempLow:   10,
  solarAlert: true,
};

// ── Thresholds ────────────────────────────────────────────────────────────────

export function getThresholds() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return { ...DEFAULT_THRESHOLDS, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function saveThresholds(t) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(t)); }
  catch (e) { console.warn('notifications.js: save failed', e); }
}

// ── Permission ────────────────────────────────────────────────────────────────

export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  const result = await Notification.requestPermission();
  return result;
}

// ── Notify ────────────────────────────────────────────────────────────────────

export async function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    if ('serviceWorker' in navigator) {
      const sw = await navigator.serviceWorker.ready;
      await sw.showNotification(title, {
        body,
        icon: '/icons/icon.svg',
        badge: '/icons/icon.svg',
      });
    } else {
      // eslint-disable-next-line no-new
      new Notification(title, { body, icon: '/icons/icon.svg' });
    }
  } catch (e) {
    console.warn('notifications.js: notify failed', e);
    try { new Notification(title, { body }); } catch {}
  }
}

// ── Threshold checks ──────────────────────────────────────────────────────────

// cooldown map: type → last fired timestamp
const _last = {};

function _canFire(type) {
  const now = Date.now();
  if (_last[type] && now - _last[type] < COOLDOWN_MS) return false;
  _last[type] = now;
  return true;
}

/**
 * checkThresholds(state) — compare state against saved thresholds.
 */
export function checkThresholds(state) {
  if (Notification.permission !== 'granted') return;
  const t = getThresholds();

  const soc    = parseInt(state.bms?.soc);
  const temp   = parseFloat(state.heater?.currentTemp);
  const pvW    = (parseFloat(state.mppt1?.pvW) || 0) + (parseFloat(state.mppt2?.pvW) || 0);
  const mpptOn = state.mppt1?.connected || state.mppt2?.connected;

  // SOC low
  if (!isNaN(soc) && soc <= t.socLow && _canFire('socLow')) {
    notify('🔋 Batteria scarica', `SOC al ${soc}% — sotto la soglia di ${t.socLow}%`);
  }

  // SOC full
  if (!isNaN(soc) && soc >= t.socFull && _canFire('socFull')) {
    notify('🔋 Batteria carica', `SOC al ${soc}% — carica completata`);
  }

  // Temp low
  if (!isNaN(temp) && temp < t.tempLow && _canFire('tempLow')) {
    notify('🌡️ Temperatura bassa', `${temp}°C — sotto la soglia di ${t.tempLow}°C`);
  }

  // Solar alert: MPPT connected, ora diurna (9-17), PV = 0
  if (t.solarAlert && mpptOn && pvW === 0) {
    const h = new Date().getHours();
    if (h >= 9 && h < 17 && _canFire('solarAlert')) {
      notify('☀️ Nessuna produzione solare', 'I pannelli non producono durante le ore diurne. Verifica l\'orientamento.');
    }
  }
}

// ── Render settings UI ────────────────────────────────────────────────────────

/**
 * renderNotifSettings(containerId) — renders the notification settings UI.
 */
export function renderNotifSettings(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const t    = getThresholds();

  const permColor = perm === 'granted' ? 'var(--green)' : perm === 'denied' ? 'var(--red)' : 'var(--amber)';
  const permLabel = perm === 'granted' ? '✅ Abilitate' : perm === 'denied' ? '🚫 Bloccate' : perm === 'unsupported' ? '⚠️ Non supportate' : '⏳ Non richieste';

  container.innerHTML = `
    <div class="settings-row">
      <label>Stato permesso</label>
      <span style="color:${permColor};font-weight:700">${permLabel}</span>
    </div>
    ${perm !== 'granted' && perm !== 'unsupported' ? `
    <div style="margin-bottom:12px">
      <button class="btn btn-primary btn-full" onclick="window.requestNotifPerm()">🔔 Abilita notifiche</button>
    </div>` : ''}
    <div class="settings-row">
      <label>SOC basso (alert sotto)</label>
      <input type="number" min="5" max="50" value="${t.socLow}"
        style="width:72px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:13px;text-align:right"
        onchange="window.saveNotifThreshold('socLow',+this.value)"> %
    </div>
    <div class="settings-row">
      <label>SOC pieno (alert sopra)</label>
      <input type="number" min="80" max="100" value="${t.socFull}"
        style="width:72px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:13px;text-align:right"
        onchange="window.saveNotifThreshold('socFull',+this.value)"> %
    </div>
    <div class="settings-row">
      <label>Temp. min riscaldatore</label>
      <input type="number" min="-20" max="30" value="${t.tempLow}"
        style="width:72px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:13px;text-align:right"
        onchange="window.saveNotifThreshold('tempLow',+this.value)"> °C
    </div>
    <div class="settings-row">
      <label>Alert solare (ore 9-17 senza prod.)</label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" ${t.solarAlert ? 'checked' : ''}
          style="width:18px;height:18px;accent-color:var(--amber)"
          onchange="window.saveNotifThreshold('solarAlert',this.checked)">
        <span style="font-size:13px">${t.solarAlert ? 'Attivo' : 'Disattivo'}</span>
      </label>
    </div>
    <div style="font-size:11px;color:var(--text-2);margin-top:4px;line-height:1.6">Cooldown: 30 min per tipo di notifica.</div>
  `;
}
