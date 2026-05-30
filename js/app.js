'use strict';
import { HeaterBLE, HEATER_ERROR }  from './heater.js';
import { BMABLE }                    from './bms.js';
import { VictronMPPT }               from './victron.js';
import { ImouAPI }                   from './imou.js';
import { MiniChart }                 from './chart.js';
import { pushSnapshot, drawHistChart, estimateAutonomy, getCumulativeEnergy } from './history.js';
import { renderWeather }               from './weather.js';
import { startTracking, renderCampsites, deleteCampsite, updateNotes } from './campsites.js';
import { checkThresholds, requestPermission, renderNotifSettings, getThresholds, saveThresholds } from './notifications.js';
import { renderMaintenance, markDone, checkMaintenanceAlerts } from './maintenance.js';
import { checkWeatherAlerts, renderWeatherAlerts } from './alerts.js';
import { initLock, clearLock, showPinSetup, registerBiometric, renderSecuritySettings } from './lock.js';
import { renderDocuments, addDocument, getDocuments, deleteDocument } from './documents.js';

// ── Charts ────────────────────────────────────────────────────────────────────
const chartSOC = new MiniChart({
  maxPoints: 60,
  height: 100,
  yMin: 0,
  yMax: 100,
  yLabel: '%',
  colorFn: (v) => v >= 50 ? '#4ADE80' : v >= 20 ? '#F59E0B' : '#F87171',
});

const chartBMSPower = new MiniChart({
  maxPoints: 60,
  height: 80,
  yLabel: 'W',
  dualColor: true,
});

const chartPVPower = new MiniChart({
  maxPoints: 60,
  height: 100,
  yMin: 0,
  yLabel: 'W',
  colorFn: () => '#F59E0B',
});

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  heater: { connected:false, state:0, currentTemp:'--', targetTemp:20, voltage:'--', power:1, errorCode:0, mode:1, rawHex:null, lastTx:null, lastWriteErr:null, bleLog:[], bleInfo:null },
  bms:    { connected:false, soc:'--', voltage:'--', current:'--', remaining:'--', capacity:'--', cycles:'--', temps:[], cells:[], protect:0, fetCharge:true, fetDischarge:true, balance:0, cellCount:0 },
  mppt1:  { connected:false, label:'MPPT 1', battV:'--', battA:'--', battW:'--', pvW:'--', pvV:'--', pvA:'--', yieldToday:'--', yieldYesterday:'--', maxPowerToday:'--', cs:'--', csNum:-1, isCharging:false, error:'--', plainHex:null, plainRaw:null, lastUpdate:null },
  mppt2:  { connected:false, label:'MPPT 2', battV:'--', battA:'--', battW:'--', pvW:'--', pvV:'--', pvA:'--', yieldToday:'--', yieldYesterday:'--', maxPowerToday:'--', cs:'--', csNum:-1, isCharging:false, error:'--', plainHex:null, plainRaw:null, lastUpdate:null },
  imou:   { connected:false, devices:[], error:null },
};

// ── Device instances ──────────────────────────────────────────────────────────
const heater = new HeaterBLE(d => {
  const prevErr = state.heater.lastWriteErr;
  Object.assign(state.heater, d);
  if (d.lastWriteErr && d.lastWriteErr !== prevErr) toast('⚠ Heater: ' + d.lastWriteErr);
  renderHeater(); renderDash(); updateDots();
});
const bms    = new BMABLE   (d => {
  Object.assign(state.bms, d);
  // Push chart data
  const socN = parseInt(state.bms.soc);
  if (!isNaN(socN)) chartSOC.push(socN);
  const bmsW = battWatts(state.bms.voltage, state.bms.current);
  if (bmsW !== null) chartBMSPower.push(bmsW);
  renderBMS();    renderDash(); updateDots();
  // History snapshot + thresholds + charts
  const snap = {
    soc:   parseInt(state.bms.soc) || null,
    battW: battWatts(state.bms.voltage, state.bms.current),
    pvW:   (state.mppt1.connected ? parseFloat(state.mppt1.pvW) || 0 : 0)
         + (state.mppt2.connected ? parseFloat(state.mppt2.pvW) || 0 : 0),
    temp:  parseFloat(state.heater.currentTemp) || null,
  };
  pushSnapshot(snap);
  checkThresholds(state);
  renderHistCharts();
  renderEnergy();
});
const mppt1  = new VictronMPPT('MPPT 1', d => {
  Object.assign(state.mppt1, d);
  try { _pushPVChart(); } catch (_) {}
  try {
    const v1 = parseFloat(state.mppt1.battV), cs1 = state.mppt1.csNum;
    if (cs1 === 3 || cs1 === 4) { _socTrend.mppt1 = []; }           // in carica: azzerato
    else if (v1 > 0) updateSocTrend('mppt1', _voltsToSOC(v1, cs1, 'mppt1'));
  } catch (_) {}
  try { renderVictron(); } catch (e) { console.error('[mppt1 render] renderVictron:', e); }
  try { renderDash();    } catch (e) { console.error('[mppt1 render] renderDash:', e); }
  try { updateDots();    } catch (_) {}
  try { renderEnergy();  } catch (e) { console.error('[mppt1 render] renderEnergy:', e); }
});
const mppt2  = new VictronMPPT('MPPT 2', d => {
  Object.assign(state.mppt2, d);
  try { _pushPVChart(); } catch (_) {}
  try {
    const v2 = parseFloat(state.mppt2.battV), cs2 = state.mppt2.csNum;
    if (cs2 === 3 || cs2 === 4) { _socTrend.mppt2 = []; }
    else if (v2 > 0) updateSocTrend('mppt2', _voltsToSOC(v2, cs2, 'mppt2'));
  } catch (_) {}
  try { renderVictron(); } catch (e) { console.error('[mppt2 render] renderVictron:', e); }
  try { renderDash();    } catch (e) { console.error('[mppt2 render] renderDash:', e); }
  try { updateDots();    } catch (_) {}
  try { renderEnergy();  } catch (e) { console.error('[mppt2 render] renderEnergy:', e); }
});

function _pushPVChart() {
  const w1 = state.mppt1.connected ? parseFloat(state.mppt1.pvW) || 0 : 0;
  const w2 = state.mppt2.connected ? parseFloat(state.mppt2.pvW) || 0 : 0;
  if (w1 + w2 > 0 || state.mppt1.connected || state.mppt2.connected) {
    chartPVPower.push(w1 + w2);
  }
}
const imou   = new ImouAPI  (d => { Object.assign(state.imou, d); renderImou(); updateDots(); });

// ── Heater schedule ───────────────────────────────────────────────────────────
const sched = {
  startTime: localStorage.getItem('heater_sched_start') || '',
  stopTime:  localStorage.getItem('heater_sched_stop')  || '',
  enabled:   localStorage.getItem('heater_sched_on') === '1',
  startTimer: null,
  stopTimer:  null,
  countdownTimer: null,
};

function schedApply() {
  clearTimeout(sched.startTimer);
  clearTimeout(sched.stopTimer);
  clearInterval(sched.countdownTimer);
  if (!sched.enabled) { renderHeaterSched(); return; }

  const msUntil = (hhmm) => {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const t = new Date(now); t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t - now;
  };

  const ms1 = msUntil(sched.startTime);
  const ms2 = msUntil(sched.stopTime);
  if (ms1 !== null) sched.startTimer = setTimeout(() => { heater.turnOn(); toast('⏰ Riscaldatore acceso (timer)'); }, ms1);
  if (ms2 !== null) sched.stopTimer  = setTimeout(() => { heater.turnOff(); toast('⏰ Riscaldatore spento (timer)'); }, ms2);

  sched.countdownTimer = setInterval(renderHeaterSched, 10000);
  renderHeaterSched();
}

function renderHeaterSched() {
  const el2 = document.getElementById('heater-sched');
  if (!el2) return;
  const countdown = (hhmm) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const t = new Date(now); t.setHours(h, m, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    const diff = Math.round((t - now) / 60000);
    const dh = Math.floor(diff / 60), dm = diff % 60;
    return ` <span style="color:var(--text-2);font-size:11px">(tra ${dh > 0 ? dh + 'h ' : ''}${dm}m)</span>`;
  };
  el2.innerHTML = `
    <div class="settings-row">
      <label>Programmazione</label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="sched-enabled" ${sched.enabled ? 'checked' : ''} onchange="schedToggle(this.checked)" style="width:18px;height:18px;accent-color:var(--amber)">
        <span style="font-size:13px">${sched.enabled ? 'Attiva' : 'Disattiva'}</span>
      </label>
    </div>
    <div class="settings-row">
      <label>Accendi alle${sched.enabled && sched.startTime ? countdown(sched.startTime) : ''}</label>
      <input type="time" id="sched-start" value="${sched.startTime}"
        style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:14px"
        onchange="schedSave('start',this.value)">
    </div>
    <div class="settings-row">
      <label>Spegni alle${sched.enabled && sched.stopTime ? countdown(sched.stopTime) : ''}</label>
      <input type="time" id="sched-stop" value="${sched.stopTime}"
        style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:14px"
        onchange="schedSave('stop',this.value)">
    </div>
    ${sched.enabled ? `<div style="font-size:11px;color:var(--amber);margin-top:4px">⏰ Timer attivo — mantieni l'app aperta</div>` : ''}
  `;
}

window.schedToggle = (on) => { sched.enabled = on; localStorage.setItem('heater_sched_on', on ? '1' : '0'); schedApply(); };
window.schedSave   = (k, v) => {
  if (k === 'start') { sched.startTime = v; localStorage.setItem('heater_sched_start', v); }
  else               { sched.stopTime  = v; localStorage.setItem('heater_sched_stop',  v); }
  if (sched.enabled) schedApply(); else renderHeaterSched();
};

// Load saved Victron keys
const k1 = localStorage.getItem('victron_key_1');
const k2 = localStorage.getItem('victron_key_2');
if (k1) mppt1.setKey(k1);
if (k2) mppt2.setKey(k2);

// ── Tab routing (lazy renders wired via globals) ──────────────────────────────
window._onTabMeteo      = () => renderMeteo();
window._onTabCampeggi   = () => renderCampeggi();
window._onTabDocumenti  = () => renderDocuments('documenti-body');

// ── Swipe gesture navigation ──────────────────────────────────────────────────
const ALL_TABS = ['dash','heater','bms','victron','imou','settings','meteo','campeggi','documenti'];
let _tx = 0, _ty = 0;
document.addEventListener('touchstart', e => {
  _tx = e.touches[0].clientX;
  _ty = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', e => {
  // Ignore if sheet is open
  if (document.getElementById('dock-sheet')?.classList.contains('open')) return;
  const dx = e.changedTouches[0].clientX - _tx;
  const dy = e.changedTouches[0].clientY - _ty;
  if (Math.abs(dx) < 55 || Math.abs(dy) > Math.abs(dx) * 0.9) return;
  const cur = ALL_TABS.find(t => document.getElementById(`screen-${t}`)?.classList.contains('active')) || 'dash';
  const idx = ALL_TABS.indexOf(cur);
  if (dx < 0 && idx < ALL_TABS.length - 1) window.switchTab(ALL_TABS[idx + 1]);
  if (dx > 0 && idx > 0)                   window.switchTab(ALL_TABS[idx - 1]);
}, { passive: true });

// ── Connection dots ───────────────────────────────────────────────────────────
function updateDots() {
  const dot = (id, ok) => {
    const el = document.getElementById(id);
    if (el) el.className = 'conn-dot' + (ok ? ' ok' : '');
  };
  dot('dot-heater', state.heater.connected);
  dot('dot-bms',    state.bms.connected);
  dot('dot-mppt1',  state.mppt1.connected);
  dot('dot-mppt2',  state.mppt2.connected);
}

function setDotConnecting(id) {
  const el = document.getElementById(id);
  if (el) el.className = 'conn-dot connecting';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function badge(type, text) {
  return `<span class="badge badge-${type}"><span class="badge-dot"></span>${text}</span>`;
}
function placeholder(icon, text) {
  return `<div style="text-align:center;padding:4px 0"><div style="font-size:28px;opacity:.4">${icon}</div><div style="font-size:12px;color:var(--text-2);margin-top:4px">${text}</div></div>`;
}
function statCard(label, color, value, unit) {
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" style="color:${color}">${value}<span class="stat-unit">${unit}</span></div></div>`;
}

// Calcola ETA a pieno (se in carica) o a scarico (se in scarica).
// Ritorna null se non applicabile (standby o dati mancanti).
function calcETA(current, remaining, capacity) {
  const curr = parseFloat(current);
  const rem  = parseFloat(remaining);
  const cap  = parseFloat(capacity);
  if (isNaN(curr) || isNaN(rem) || isNaN(cap) || cap <= 0) return null;
  let hours;
  if (curr > 0.1) {
    const toFull = cap - rem;
    if (toFull <= 0) return null; // già piena
    hours = toFull / curr;
  } else if (curr < -0.1) {
    if (rem <= 0) return null;
    hours = rem / Math.abs(curr);
  } else {
    return null; // standby
  }
  if (hours < 0 || !isFinite(hours)) return null;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function chargeStatus(current) {
  const curr = parseFloat(current);
  if (curr > 0.1)  return { label: 'In carica',  badge: 'green' };
  if (curr < -0.1) return { label: 'In scarica', badge: 'amber' };
  return { label: 'Standby', badge: 'grey' };
}

function battWatts(voltage, current) {
  const v = parseFloat(voltage);
  const a = parseFloat(current);
  if (isNaN(v) || isNaN(a)) return null;
  const w = v * a;
  if (Math.abs(w) < 0.5) return null;
  return w;
}

// ── Battery profiles & SOC estimation from MPPT ───────────────────────────────
const BATT_PROFILE = {
  mppt1: { capacity: 100, label: 'LiFePO4 100Ah', type: 'lifepo4' },
  mppt2: { capacity:  70, label: 'Piombo 70Ah',   type: 'lead'    },
};

// LiFePO4 12V OCV → SOC (può arrivare a 14.4 V in assorbimento)
const _SOC_LIFEPO4 = [
  [14.40, 100], [13.60, 100], [13.40, 95], [13.30, 90],
  [13.20,  75], [13.10,  55], [13.00, 35], [12.90, 20],
  [12.80,  12], [12.70,   8], [12.60,  5], [12.00,  0],
];
// Piombo 12V OCV → SOC (AGM/gel a riposo)
const _SOC_LEAD = [
  [12.73, 100], [12.55, 80], [12.31, 60], [12.08, 40],
  [11.83,  20], [11.63,  5], [10.80,  0],
];

function _tableSOC(v, table) {
  if (v >= table[0][0]) return 100;
  if (v <= table[table.length - 1][0]) return 0;
  for (let i = 0; i < table.length - 1; i++) {
    const [v1, s1] = table[i], [v2, s2] = table[i + 1];
    if (v >= v2) return Math.round(s2 + (v - v2) / (v1 - v2) * (s1 - s2));
  }
  return 0;
}

function _voltsToSOC(v, csNum, key) {
  if (csNum === 5 || csNum === 6) return 100;
  if (csNum === 4) return BATT_PROFILE[key].type === 'lifepo4' ? 92 : 85;
  // Bulk e tutti gli altri stati: calcola dalla tabella OCV
  // (in Bulk la tensione può essere leggermente gonfiata → SOC sovrastimato, ma è meglio di 0%)
  return _tableSOC(v, BATT_PROFILE[key].type === 'lifepo4' ? _SOC_LIFEPO4 : _SOC_LEAD);
}

// Trend SOC nel tempo per stima scarico
const _socTrend = { mppt1: [], mppt2: [] };

function updateSocTrend(key, soc) {
  if (soc === null) return;
  _socTrend[key].push({ soc, ts: Date.now() });
  if (_socTrend[key].length > 30) _socTrend[key].shift();
}

function _socRate(key) {
  const arr = _socTrend[key];
  if (arr.length < 3) return null;
  const span = arr[arr.length - 1].ts - arr[0].ts;
  if (span < 60000) return null; // almeno 1 minuto
  return (arr[arr.length - 1].soc - arr[0].soc) / (span / 3600000); // %/h
}

function _estimateLoadW(key) {
  const m     = key === 'mppt1' ? state.mppt1 : state.mppt2;
  const csNum = m.csNum;
  // In Bulk e Absorption il MPPT controlla la tensione; battA include già i carichi
  // → separare carico da carica è impossibile senza shunt → non mostrare stima
  if (csNum === 3 || csNum === 4) return null;

  const battV   = parseFloat(m.battV) || 0;
  const pvW     = parseFloat(m.pvW)   || 0;
  const cap     = BATT_PROFILE[key].capacity;
  const rate    = _socRate(key);
  const arr     = _socTrend[key];
  const spanMin = arr.length > 1 ? Math.round((arr[arr.length-1].ts - arr[0].ts) / 60000) : 0;

  // netBattW = flusso netto sulla batteria (positivo=carica, negativo=scarica)
  const netBattW = rate !== null ? (rate / 100) * cap * battV : null;

  // In Float (csNum=5/6): pvW è quasi tutto carichi (trickle trascurabile)
  // In Off (csNum=0/1): pvW=0, carichi = scarica dalla batteria
  let loadW = null;
  if (netBattW !== null) loadW = Math.max(0, pvW - netBattW);
  else if (pvW > 5 && (csNum === 5 || csNum === 6)) loadW = pvW; // Float: pvW ≈ carichi

  if (loadW === null) return null;

  // Stima affidabile: almeno 2 min dati + solare basso (senza carica attiva che distorce)
  const reliable = spanMin >= 2 && rate !== null && pvW < 20;
  return {
    W: Math.round(loadW),
    A: battV > 0 ? (loadW / battV).toFixed(1) : '--',
    rate,
    netBattW: netBattW !== null ? Math.round(netBattW) : null,
    pvW: Math.round(pvW),
    hasSolar: pvW > 5,
    reliable,
    spanMin,
  };
}

function _calcETA(key, soc, csNum, battAStr) {
  if (soc === null) return null;
  const cap   = BATT_PROFILE[key].capacity;
  const battA = parseFloat(battAStr);
  // Carica: in Bulk/Absorption con corrente significativa
  if ((csNum === 3 || csNum === 4) && !isNaN(battA) && battA > 1.0) {
    const remAh = cap * (1 - soc / 100);
    return { label: 'a pieno', hours: remAh > 0.5 ? remAh / battA : 0 };
  }
  // Scarico: stima dal tasso di calo SOC (soglia abbassata: 0.5 %/h)
  const rate = _socRate(key);
  if (rate !== null && rate < -0.5) {
    return { label: 'a vuoto', hours: soc / Math.abs(rate) };
  }
  return null;
}

function _fmtH(h) {
  if (!h || h <= 0) return null;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return hh === 0 ? `${mm}m` : mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}

function battInfoForKey(key) {
  const m = key === 'mppt1' ? state.mppt1 : state.mppt2;
  if (!m.connected || !(parseFloat(m.battV) > 0)) return null;
  const v      = parseFloat(m.battV);
  const soc    = _voltsToSOC(v, m.csNum, key);   // sempre un numero (mai null)
  const inBulk = m.csNum === 3;
  const battA  = parseFloat(m.battA) || 0;
  const mpptW  = v * battA;
  const remAh  = soc !== null ? BATT_PROFILE[key].capacity * soc / 100 : null;
  return {
    v, csNum: m.csNum, cs: m.cs, soc, inBulk,
    battA: battA > 0 ? battA.toFixed(1) : '--',
    mpptW: mpptW > 0.5 ? mpptW.toFixed(0) : '--',
    pvW: m.pvW, yieldToday: m.yieldToday, yieldYesterday: m.yieldYesterday,
    remAh: remAh !== null ? remAh.toFixed(1) : '--',
    eta: _calcETA(key, soc, m.csNum, m.battA),
    dischargeEst: _estimateLoadW(key),
    ratePerH: _socRate(key),
    label: BATT_PROFILE[key].label,
    capacity: BATT_PROFILE[key].capacity,
  };
}

// ── Connect placeholders for dashboard ───────────────────────────────────────
function connectPlaceholder(icon, label, onConnect) {
  return `<div style="text-align:center;padding:4px 0">
    <div style="font-size:26px;opacity:.35;margin-bottom:6px">${icon}</div>
    <button class="btn btn-ghost" style="font-size:11px;padding:6px 14px;border-radius:10px" onclick="${onConnect}">Connetti</button>
  </div>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDash() {
  // Heater card
  const hs = state.heater;
  const heaterOn = hs.state === 1 || hs.state === 2;
  const heaterErr = hs.errorCode && HEATER_ERROR[hs.errorCode];
  el('dash-heater').innerHTML = hs.connected
    ? `<div class="temp-row" style="padding:0">
         <div class="temp-box"><div class="label">Attuale</div><div class="temp-current" style="font-size:36px">${hs.currentTemp}°</div></div>
         <div class="temp-box"><div class="label">Target</div><div class="temp-target" style="font-size:28px">${hs.targetTemp}°</div></div>
       </div>
       <div style="margin-top:8px">${badge(heaterOn ? 'green' : 'grey', heaterOn ? 'Attivo' : heater.stateLabel())}</div>
       ${heaterErr ? `<div style="font-size:11px;color:var(--red);margin-top:4px">⚠ ${heaterErr}</div>` : ''}`
    : connectPlaceholder('🔥', 'Riscaldatore', 'connectHeater()');

  // BMS card
  const bs = state.bms;
  const socNum = parseInt(bs.soc);
  const socColor = socNum >= 50 ? 'var(--green)' : socNum >= 20 ? 'var(--amber)' : 'var(--red)';
  const cs  = chargeStatus(bs.current);
  const eta = calcETA(bs.current, bs.remaining, bs.capacity);
  const bmsW = battWatts(bs.voltage, bs.current);
  const bmsWColor = bmsW > 0 ? 'var(--green)' : 'var(--amber)';
  el('dash-bms').innerHTML = bs.connected
    ? `<div class="big-num" style="color:${socColor};font-size:42px">${bs.soc}<span class="big-unit" style="font-size:16px">%</span></div>
       <div class="stat-sub" style="margin-bottom:4px">${bs.voltage} V · ${bs.current} A${bmsW !== null ? ` · <span style="color:${bmsWColor};font-weight:700">${bmsW > 0 ? '+' : ''}${bmsW.toFixed(0)} W</span>` : ''}</div>
       <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
         ${badge(cs.badge, cs.label)}
         ${eta !== null ? `<span class="badge badge-grey">⏱ ${eta}</span>` : ''}
       </div>`
    : (() => {
        const b1 = battInfoForKey('mppt1');
        if (!b1) return connectPlaceholder('🔋', 'Batterie', 'connectBMS()');
        const b2 = battInfoForKey('mppt2');
        const sN = b1.soc;
        const sColor = sN !== null ? (sN >= 50 ? 'var(--green)' : sN >= 20 ? 'var(--amber)' : 'var(--red)') : 'var(--green)';
        const eta1str = b1.eta && _fmtH(b1.eta.hours) ? `<div style="font-size:11px;color:var(--text-2)">⏱ ~${_fmtH(b1.eta.hours)} ${b1.eta.label}</div>` : '';
        const piomboLine = b2
          ? `<div style="font-size:11px;color:var(--text-2);margin-top:3px;border-top:1px solid var(--border);padding-top:3px">
               🪫 Piombo ~${b2.soc !== null ? b2.soc + '%' : '?'} · ${b2.v.toFixed(2)} V${b2.inBulk ? ' ⚡' : ''}
             </div>` : '';
        return sN !== null
          ? `<div class="big-num" style="color:${sColor};font-size:36px">~${sN}<span class="big-unit" style="font-size:13px">%</span></div>
             <div style="font-size:11px;color:var(--text-2)">🔋 Litio · ${b1.v.toFixed(2)} V · ${b1.cs}</div>
             ${eta1str}${piomboLine}`
          : `<div class="big-num" style="color:var(--green);font-size:24px">In carica ⚡</div>
             <div style="font-size:11px;color:var(--text-2)">🔋 Litio · ${b1.v.toFixed(2)} V · ${b1.cs}</div>
             ${piomboLine}`;
      })();

  // Solar card
  const totalW = (() => {
    const w1 = state.mppt1.connected ? parseFloat(state.mppt1.pvW) || 0 : 0;
    const w2 = state.mppt2.connected ? parseFloat(state.mppt2.pvW) || 0 : 0;
    return (w1 + w2) > 0 ? (w1 + w2).toFixed(0) : '--';
  })();
  const yT = (() => {
    const y1 = parseFloat(state.mppt1.yieldToday) || 0;
    const y2 = parseFloat(state.mppt2.yieldToday) || 0;
    return (y1 + y2) > 0 ? (y1 + y2).toFixed(2) : '--';
  })();
  el('dash-solar').innerHTML = (state.mppt1.connected || state.mppt2.connected)
    ? `<div class="big-num" style="color:var(--amber);font-size:38px">${totalW}<span class="big-unit" style="font-size:14px">W</span></div>
       <div class="stat-sub">Oggi: ${yT} kWh</div>`
    : connectPlaceholder('☀️', 'Solare', 'connectMPPT(1)');

  // Imou card
  const ic = state.imou;
  el('dash-imou').innerHTML = ic.connected
    ? `<div style="font-size:13px;color:var(--text-2)">${ic.devices.length} camera${ic.devices.length !== 1 ? 'e' : ''}</div>
       ${badge('green', 'Online')}`
    : connectPlaceholder('📷', 'Camere', "imou.connect()");
}

// ── Heater screen ─────────────────────────────────────────────────────────────
function renderHeater() {
  const hs = state.heater;
  if (!hs.connected) {
    el('heater-body').innerHTML = `<div class="connect-placeholder"><div class="icon">🔥</div><p>Connetti il riscaldatore via Bluetooth</p><button class="btn btn-primary btn-full" onclick="connectHeater()">Connetti</button></div>`;
    return;
  }
  const heaterOn  = hs.state === 1 || hs.state === 2;
  const errLabel  = hs.errorCode ? (HEATER_ERROR[hs.errorCode] ?? `E-${String(hs.errorCode).padStart(2, '0')}`) : null;
  const modeLabel = hs.mode === 2 ? 'Termostato' : 'Manuale';

  el('heater-body').innerHTML = `
    <div class="card">
      <div class="card-row" style="justify-content:center;flex-direction:column;gap:12px">
        <div class="temp-row">
          <div class="temp-box"><div class="label">Temperatura attuale</div><div class="temp-current">${hs.currentTemp}°C</div></div>
          <div class="temp-box"><div class="label">Target</div><div class="temp-target">${hs.targetTemp}°C</div></div>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          ${badge(heaterOn ? 'green' : hs.state === 4 ? 'amber' : 'grey', heater.stateLabel())}
          ${badge('grey', modeLabel)}
        </div>
        ${errLabel ? `<div class="alert alert-err" style="margin:0">⚠️ ${errLabel}</div>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Accensione</div>
      <button class="power-btn ${heaterOn ? 'on' : ''}" onclick="toggleHeater()" ${_heaterBusy ? 'disabled style="opacity:.45;cursor:default"' : ''}>⏻</button>
      <div style="text-align:center;font-size:12px;color:var(--text-2);margin-top:4px">${_heaterBusy ? 'Comando inviato…' : heaterOn ? 'Tocca per spegnere' : 'Tocca per accendere'}</div>
    </div>

    <div class="card">
      <div class="card-title">Modalità</div>
      <div style="display:flex;gap:8px">
        <button class="btn ${hs.mode !== 2 ? 'btn-primary' : 'btn-ghost'} btn-full" onclick="setHeaterMode(1)">🔥 Manuale</button>
        <button class="btn ${hs.mode === 2 ? 'btn-primary' : 'btn-ghost'} btn-full" onclick="setHeaterMode(2)">🌡️ Termostato</button>
      </div>
      ${hs.mode === 2 ? `
      <div class="slider-wrap" style="margin-top:14px">
        <div class="card-title" style="margin-bottom:8px">Temperatura target</div>
        <div class="slider-label"><span>15°C</span><span id="temp-val">${hs.targetTemp}°C</span><span>35°C</span></div>
        <input type="range" min="15" max="35" value="${hs.targetTemp}" id="temp-slider"
          oninput="document.getElementById('temp-val').textContent=this.value+'°C'"
          onchange="setHeaterTemp(+this.value)">
      </div>` : `
      <div style="margin-top:14px">
        <div class="card-title" style="margin-bottom:8px">Livello potenza</div>
        <div class="level-pills">
          ${[1,2,3,4,5,6,7,8,9,10].map(l => `<div class="level-pill ${hs.power===l?'active':''}" onclick="setHeaterLevel(${l})">${l}</div>`).join('')}
        </div>
      </div>`}
    </div>

    <div class="card">
      <div class="card-title">Programmazione accensione</div>
      <div id="heater-sched"></div>
    </div>

    <div class="card">
      <div class="card-title">Info</div>
      <div class="settings-row"><label>Tensione batteria</label><span style="color:var(--amber)">${hs.voltage} V</span></div>
      <div class="settings-row"><label>Modalità attiva</label><span>${modeLabel}</span></div>
      ${errLabel ? `<div class="settings-row"><label>Errore</label><span style="color:var(--red)">${errLabel}</span></div>` : ''}
      ${hs.lastWriteErr ? `<div class="settings-row"><label>Errore TX</label><span style="color:var(--red);font-size:12px">${hs.lastWriteErr}</span></div>` : ''}
      <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="window.heater.disconnect();renderHeater()">Disconnetti</button>
    </div>

    <div class="card">
      <div class="card-title">Debug BLE</div>
      ${hs.bleInfo ? `<div style="font-size:10px;font-family:monospace;color:var(--text-2);margin-bottom:10px;word-break:break-all;line-height:1.6">${hs.bleInfo}</div>` : ''}
      <div style="font-family:monospace;font-size:11px;background:var(--surface2);border-radius:8px;padding:8px;margin-bottom:10px;min-height:44px;max-height:180px;overflow-y:auto">
        ${hs.bleLog.length
          ? hs.bleLog.map(e => `<div style="color:${e.dir==='TX'?'var(--blue)':'var(--green)'}"><span style="color:var(--text-2);margin-right:6px">${e.t}</span>${e.dir} ${e.hex}</div>`).join('')
          : '<span style="color:var(--text-2)">Nessun frame ancora — premi un tasto</span>'}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input id="heater-hex-in" type="text" placeholder="aa 55 01 01 00 00 00"
          style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:12px;font-family:monospace;outline:none;min-width:0" />
        <button class="btn btn-ghost" style="white-space:nowrap" onclick="heaterSendHex()">Invia</button>
      </div>
      <div style="font-size:10px;color:var(--text-2);line-height:1.8">
        ON &nbsp;<code style="background:var(--surface2);padding:1px 4px;border-radius:4px">aa 55 01 01 00 00 00</code><br>
        OFF <code style="background:var(--surface2);padding:1px 4px;border-radius:4px">aa 55 01 00 00 00 00</code><br>
        STS <code style="background:var(--surface2);padding:1px 4px;border-radius:4px">aa 55 10 00 00 00 00</code>
      </div>
    </div>
  `;
  renderHeaterSched();
}

// ── BMS screen ────────────────────────────────────────────────────────────────
function renderBMS() {
  const bs = state.bms;
  if (!bs.connected) {
    if (window._bmsShowMPPT) {
      const _mpptSlot = (key, idx, label) => {
        const card = _mpptBattCard(key);
        if (card) return card;
        return `<div class="card" style="text-align:center">
          <div class="card-title">🔋 ${label}</div>
          <div class="connect-placeholder" style="padding:16px 0">
            <div class="icon" style="font-size:28px;opacity:.4">📡</div>
            <p style="font-size:13px;color:var(--text-2);margin:8px 0">MPPT ${idx} non connesso</p>
            <button class="btn btn-primary" onclick="connectMPPT(${idx})">Connetti MPPT ${idx}</button>
          </div>
        </div>`;
      };
      el('bms-body').innerHTML = `
        ${_mpptSlot('mppt1', 1, 'LiFePO4 100Ah')}
        ${_mpptSlot('mppt2', 2, 'Piombo 70Ah')}
        <button class="btn btn-ghost btn-full" style="margin-top:6px" onclick="window._bmsShowMPPT=false;window.renderBMS()">← Torna a Connetti BMS</button>`;
    } else {
      el('bms-body').innerHTML = `
        <div class="connect-placeholder">
          <div class="icon">🔋</div>
          <p>Connetti il BMS XiaoXiang via Bluetooth</p>
          <button class="btn btn-primary btn-full" onclick="connectBMS()">Connetti</button>
          <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="window._bmsShowMPPT=true;window.renderBMS()">📊 Stima da MPPT</button>
        </div>`;
    }
    return;
  }
  window._bmsShowMPPT = false;
  const socN = parseInt(bs.soc) || 0;
  const socColor = socN >= 50 ? '#4ADE80' : socN >= 20 ? '#F59E0B' : '#F87171';
  const cs   = chargeStatus(bs.current);
  const eta  = calcETA(bs.current, bs.remaining, bs.capacity);
  const bmsW = battWatts(bs.voltage, bs.current);

  // SVG semicircle gauge
  const r = 70, cx = 90, cy = 95, sw = 14;
  const angle = (socN / 100) * 180;
  const arcX  = cx + r * Math.cos(Math.PI - angle * Math.PI / 180);
  const arcY  = cy - r * Math.sin(angle * Math.PI / 180);
  const la    = angle > 180 ? 1 : 0;

  // Protection flags
  const protFlags = [
    [0, 'Sovratensione cella'], [1, 'Sottotensione cella'],
    [2, 'Sovratensione pacco'], [3, 'Sottotensione pacco'],
    [4, 'Temp carica alta'],    [5, 'Temp carica bassa'],
    [6, 'Temp scarica alta'],   [7, 'Temp scarica bassa'],
    [8, 'Sovracorrente carica'],[9, 'Sovracorrente scarica'],
    [10, 'Cortocircuito'],      [11, 'Errore MOSFET'],
  ].filter(([bit]) => bs.protect & (1 << bit)).map(([, name]) => name);

  // Cell stats
  let cellStatsHtml = '';
  if (bs.cells.length) {
    const vCells = bs.cells.map(v => parseFloat(v));
    const vMin   = Math.min(...vCells).toFixed(3);
    const vMax   = Math.max(...vCells).toFixed(3);
    const vDelta = (Math.max(...vCells) - Math.min(...vCells)).toFixed(3);
    const deltaColor = parseFloat(vDelta) > 0.050 ? 'var(--red)' : parseFloat(vDelta) > 0.020 ? 'var(--amber)' : 'var(--green)';
    cellStatsHtml = `
    <div class="grid-2" style="margin-bottom:10px">
      ${statCard('Cella min', 'var(--blue)', vMin, 'V')}
      ${statCard('Cella max', 'var(--green)', vMax, 'V')}
      ${statCard('Delta', deltaColor, vDelta, 'V')}
      ${statCard('N° celle', 'var(--text-2)', bs.cells.length, '')}
    </div>`;
  }

  // Temperature cards (all NTCs)
  const tempCards = bs.temps.map((t, i) => {
    const tN = parseFloat(t);
    const tC = tN > 40 ? 'var(--red)' : tN > 30 ? 'var(--amber)' : 'var(--green)';
    return statCard(`NTC ${i + 1}`, tC, t, '°C');
  }).join('');

  el('bms-body').innerHTML = `
    <div class="card" style="text-align:center">
      <div class="card-title">Stato di carica</div>
      <svg viewBox="0 0 180 110" style="width:200px;height:120px">
        <path d="M ${cx-r},${cy} A ${r},${r} 0 0 1 ${cx+r},${cy}" fill="none" stroke="var(--surface2)" stroke-width="${sw}" stroke-linecap="round"/>
        ${socN > 0 ? `<path d="M ${cx-r},${cy} A ${r},${r} 0 ${la} 1 ${arcX},${arcY}" fill="none" stroke="${socColor}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
        <text x="${cx}" y="${cy-10}" text-anchor="middle" class="gauge-text" style="fill:${socColor}">${bs.soc}%</text>
        <text x="${cx}" y="${cy+12}" text-anchor="middle" class="gauge-sub">SOC</text>
      </svg>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px">
        ${badge(cs.badge, cs.label)}
        ${eta !== null ? `<span class="badge badge-grey">⏱ ${eta}</span>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Storico SOC</div>
      <div id="chart-soc-mount"></div>
    </div>

    <div class="card">
      <div class="card-title">Potenza batteria</div>
      <div id="chart-bms-power-mount"></div>
    </div>

    <div class="grid-2">
      ${statCard('Tensione', 'var(--blue)', bs.voltage, 'V')}
      ${statCard('Corrente', cs.badge === 'green' ? 'var(--green)' : cs.badge === 'amber' ? 'var(--amber)' : 'var(--text-2)', bs.current, 'A')}
      ${bmsW !== null ? statCard('Potenza', bmsW > 0 ? 'var(--green)' : 'var(--amber)', (bmsW > 0 ? '+' : '') + bmsW.toFixed(0), 'W') : ''}
      ${statCard('Capacità res.', socColor, bs.remaining, 'Ah')}
      ${statCard('Capacità nom.', 'var(--text-2)', bs.capacity, 'Ah')}
      ${statCard('Cicli', 'var(--text)', bs.cycles, '')}
    </div>

    <div class="card">
      <div class="card-title">Stato MOSFET</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${badge(bs.fetCharge    ? 'green' : 'red', bs.fetCharge    ? 'CHG ON' : 'CHG OFF')}
        ${badge(bs.fetDischarge ? 'green' : 'red', bs.fetDischarge ? 'DSG ON' : 'DSG OFF')}
      </div>
    </div>

    ${bs.temps.length > 0 ? `
    <div class="card">
      <div class="card-title">Temperature NTC</div>
      <div class="grid-2" style="margin:0">${tempCards}</div>
    </div>` : ''}

    ${bs.cells.length ? `
    <div class="card">
      <div class="card-title">Tensioni celle</div>
      ${cellStatsHtml}
      <div class="cell-grid">
        ${bs.cells.map((v, i) => {
          const vn  = parseFloat(v);
          // LiFePO4 range: 2.50–3.65 V (non Li-Ion 2.8–4.2 V)
          const pct = Math.min(100, Math.max(0, ((vn - 2.5) / (3.65 - 2.5)) * 100)).toFixed(0);
          const cls = vn < 2.8 ? 'danger' : vn < 3.1 ? 'warn' : '';
          const isBalancing = (bs.balance >> i) & 1;
          return `<div class="cell-item">
            <div class="cell-label">C${i+1}${isBalancing ? ' ⚖' : ''}</div>
            <div class="cell-v" style="color:${cls==='danger'?'var(--red)':cls==='warn'?'var(--amber)':'var(--green)'}">${v}V</div>
            <div class="cell-bar"><div class="cell-bar-fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${protFlags.length ? `<div class="alert alert-err">⚠️ ${protFlags.join(' · ')}</div>` : ''}
    <button class="btn btn-ghost btn-full" onclick="window.bms.disconnect();renderBMS()">Disconnetti</button>
  `;
  chartSOC.mount('#chart-soc-mount');
  chartBMSPower.mount('#chart-bms-power-mount');
}

// ── Battery card helper for Victron screen ─────────────────────────────────────
function _mpptBattCard(key) {
  const info = battInfoForKey(key);
  if (!info) return '';
  const socN     = info.soc ?? 0;
  const socColor = socN >= 50 ? '#4ADE80' : socN >= 20 ? '#F59E0B' : '#F87171';
  const r = 70, cx = 90, cy = 95, sw = 14;
  const angle = (socN / 100) * 180;
  const arcX  = cx + r * Math.cos(Math.PI - angle * Math.PI / 180);
  const arcY  = cy - r * Math.sin(angle * Math.PI / 180);
  const la    = angle > 180 ? 1 : 0;
  const gaugeSub = info.inBulk ? 'pre-carica' : 'SOC stimato';
  const gaugeHtml = `<svg viewBox="0 0 180 110" style="width:180px;height:110px">
    <path d="M ${cx-r},${cy} A ${r},${r} 0 0 1 ${cx+r},${cy}" fill="none" stroke="var(--surface2)" stroke-width="${sw}" stroke-linecap="round"/>
    ${socN > 0 ? `<path d="M ${cx-r},${cy} A ${r},${r} 0 ${la} 1 ${arcX},${arcY}" fill="none" stroke="${socColor}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
    <text x="${cx}" y="${cy-10}" text-anchor="middle" class="gauge-text" style="fill:${socColor}">~${socN}%</text>
    <text x="${cx}" y="${cy+12}" text-anchor="middle" class="gauge-sub">${gaugeSub}</text>
  </svg>`;
  // Badge stato carica: unificato e chiaro per entrambe le batterie
  const csBadgeColor = (info.csNum === 3 || info.csNum === 4) ? 'green'
    : (info.csNum === 5 || info.csNum === 6) ? 'ok'
    : (info.csNum === 2) ? 'err'
    : 'grey';
  const csBadgeLabel = info.csNum === 3 ? '⚡ Bulk — In carica'
    : info.csNum === 4 ? '⚡ Absorption — In carica'
    : info.csNum === 5 ? '≈ Float'
    : info.csNum === 6 ? '≈ Storage'
    : info.csNum === 0 ? 'Off'
    : info.cs || '--';
  const etaStr = info.eta && _fmtH(info.eta.hours) ? `<span class="badge badge-grey">⏱ ~${_fmtH(info.eta.hours)} ${info.eta.label} (stima)</span>` : '';
  const aNum   = parseFloat(info.battA);
  const wNum   = parseFloat(info.mpptW);
  const aColor = (info.csNum === 3 || info.csNum === 4) ? 'var(--green)' : 'var(--text-2)';

  // Tasso netto SOC e stima carichi
  const isActiveChrg = info.csNum === 3 || info.csNum === 4;
  const rate = info.ratePerH;
  const rateStr = isActiveChrg
    ? `<div style="font-size:12px;font-weight:600;color:var(--green);margin-top:6px">
        ⚡ In carica rapida — trend non disponibile
       </div>`
    : rate !== null
      ? `<div style="font-size:12px;font-weight:600;color:${rate > 0 ? 'var(--green)' : rate < -0.3 ? 'var(--amber)' : 'var(--text-2)'};margin-top:6px">
          ${rate > 0.3 ? '↑' : rate < -0.3 ? '↓' : '≈'} ${Math.abs(rate).toFixed(1)}%/h
          <span style="font-size:10px;font-weight:400;color:var(--text-2)">(tasso netto SOC)</span>
         </div>`
      : '';

  const dis = info.dischargeEst;
  const disHtml = isActiveChrg
    ? `<div style="background:var(--surface2);border-radius:8px;padding:8px 10px;margin-top:8px;text-align:left">
         <div style="font-size:11px;color:var(--text-2);margin-bottom:2px;text-transform:uppercase;letter-spacing:.4px">Consumo stimato</div>
         <div style="font-size:11px;color:var(--text-2)">N/D durante carica Bulk/Absorption</div>
         <div style="font-size:10px;color:var(--text-2);margin-top:2px">Il MPPT controlla la tensione — impossibile separare carica da carichi</div>
       </div>`
    : dis
      ? `<div style="background:var(--surface2);border-radius:8px;padding:8px 10px;margin-top:8px;text-align:left">
           <div style="font-size:11px;color:var(--text-2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Consumo stimato</div>
           <div style="display:flex;gap:16px;align-items:baseline;flex-wrap:wrap">
             <span style="font-size:20px;font-weight:800;color:var(--amber)">~${dis.W} W</span>
             <span style="font-size:13px;color:var(--text-2)">${dis.A} A</span>
             ${dis.pvW > 0 ? `<span style="font-size:12px;color:var(--amber)">☀ ${dis.pvW} W solare</span>` : ''}
           </div>
           ${dis.netBattW !== null
             ? `<div style="font-size:11px;color:${dis.netBattW >= 0 ? 'var(--green)' : 'var(--amber)'};margin-top:3px">
                  Batteria: ${dis.netBattW >= 0 ? '↑ +' : '↓ '}${dis.netBattW} W netti
                </div>` : ''}
           <div style="font-size:10px;margin-top:3px;color:${dis.reliable ? 'var(--green)' : 'var(--text-2)'}">
             ${dis.reliable
               ? `✓ ${dis.spanMin} min dati · ${dis.hasSolar ? 'solare + trend' : 'solo trend'}`
               : dis.spanMin > 0
                 ? `⏳ ${dis.spanMin} min dati (ancora pochi)`
                 : `☀ Stima da solare (in attesa trend)`}
           </div>
         </div>`
      : '';

  return `<div class="card" style="text-align:center">
    <div class="card-title">🔋 ${info.label}</div>
    ${gaugeHtml}
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px">
      ${badge(csBadgeColor, csBadgeLabel)}
      ${etaStr}
    </div>
    ${rateStr}
    ${disHtml}
    <div class="grid-2" style="margin-top:10px">
      ${statCard('Tensione', 'var(--blue)', info.v.toFixed(2), 'V')}
      ${!isNaN(aNum) && aNum > 0 ? statCard('Corrente MPPT', aColor, info.battA, 'A') : ''}
      ${!isNaN(wNum) && wNum > 0 ? statCard('Potenza MPPT', 'var(--green)', '+' + info.mpptW, 'W') : ''}
      ${statCard('Cap. residua', socColor, info.remAh, 'Ah')}
      ${statCard('Cap. nominale', 'var(--text-2)', info.capacity, 'Ah')}
      ${info.pvW && info.pvW !== '--' ? statCard('Solare', 'var(--amber)', info.pvW, 'W') : ''}
      ${info.yieldToday && info.yieldToday !== '--' ? statCard('Resa oggi', 'var(--amber)', info.yieldToday, 'kWh') : ''}
    </div>
    <div style="font-size:10px;color:var(--text-2);margin-top:6px">
      Stima da tensione MPPT · ±5%${info.inBulk ? ' · % da ultima lettura pre-Bulk' : ''}
    </div>
  </div>`;
}

// ── Victron screen ────────────────────────────────────────────────────────────
function csInfo(csNum) {
  if (csNum === 3 || csNum === 4) return { color: 'var(--green)',  label: csNum === 3 ? 'Bulk' : 'Absorption', dot: 'green' };
  if (csNum === 5)                return { color: 'var(--blue)',   label: 'Float',   dot: 'ok' };
  if (csNum === 6)                return { color: 'var(--blue)',   label: 'Storage', dot: 'ok' };
  if (csNum === 2)                return { color: 'var(--red)',    label: 'Fault',   dot: 'err' };
  if (csNum === 1)                return { color: 'var(--amber)',  label: 'Low pwr', dot: 'connecting' };
  if (csNum === 7)                return { color: 'var(--amber)',  label: 'Equalize',dot: 'connecting' };
  return                                 { color: 'var(--text-2)', label: 'Off',     dot: '' };
}

function renderVictron() {
  const mpptCard = (m, idx) => {
    const keyId  = `victron_key_${idx}`;
    const pvWnum = parseFloat(m.pvW) || 0;
    const cs     = csInfo(m.csNum);
    const glowColor = m.isCharging ? 'rgba(74,222,128,.25)' : 'transparent';

    // Circular PV power arc gauge
    const pvMax = 300, r = 54, cx = 65, cy = 70, sw = 11;
    const angle = Math.min(180, (pvWnum / pvMax) * 180);
    const arcX  = cx + r * Math.cos(Math.PI - angle * Math.PI / 180);
    const arcY  = cy - r * Math.sin(angle * Math.PI / 180);
    const la    = angle > 180 ? 1 : 0;
    const pvGauge = `
      <svg viewBox="0 0 130 82" style="width:160px;height:98px">
        <path d="M ${cx-r},${cy} A ${r},${r} 0 0 1 ${cx+r},${cy}" fill="none" stroke="var(--surface2)" stroke-width="${sw}" stroke-linecap="round"/>
        ${pvWnum > 0 ? `<path d="M ${cx-r},${cy} A ${r},${r} 0 ${la} 1 ${arcX},${arcY}" fill="none" stroke="${cs.color}" stroke-width="${sw}" stroke-linecap="round"/>` : ''}
        <text x="${cx}" y="${cy-14}" text-anchor="middle" font-size="22" font-weight="800" fill="${cs.color}">${m.pvW}</text>
        <text x="${cx}" y="${cy+2}" text-anchor="middle" font-size="10" fill="var(--text-2)">W solare</text>
      </svg>`;

    return `
    <div class="card" style="box-shadow:0 0 0 2px ${m.isCharging ? 'rgba(74,222,128,.3)' : 'transparent'}">
      <div class="card-row" style="margin-bottom:10px">
        <span class="card-title" style="margin:0">${m.label}</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${m.connected ? `<span class="badge badge-${m.isCharging ? 'green' : m.csNum === 5 || m.csNum === 6 ? 'amber' : 'grey'}"
            style="${m.isCharging ? `background:${glowColor}` : ''}">
            <span class="badge-dot"></span>${cs.label}
          </span>` : ''}
          ${badge(m.connected ? 'green' : 'grey', m.connected ? 'BLE' : 'Off')}
        </div>
      </div>
      ${m.connected ? `
      <div style="text-align:center;margin-bottom:10px">${pvGauge}</div>

      <div class="grid-2" style="margin-bottom:10px">
        ${statCard('Batt. V', 'var(--green)', m.battV, 'V')}
        ${statCard('Batt. A', 'var(--blue)',  m.battA, 'A')}
        ${statCard('Batt. W', m.isCharging ? 'var(--green)' : 'var(--text-2)', m.battW, 'W')}
        ${statCard('Max oggi', 'var(--amber)', m.maxPowerToday, 'W')}
      </div>

      <div class="divider"></div>
      <div class="card-row" style="padding:5px 0"><span style="font-size:12px;color:var(--text-2)">Stato</span><span style="font-size:12px;font-weight:600;color:${cs.color}">${m.cs}</span></div>
      <div class="card-row" style="padding:5px 0"><span style="font-size:12px;color:var(--text-2)">Errore</span><span style="font-size:12px">${m.error}</span></div>
      <div class="divider"></div>
      <div class="card-row" style="padding:5px 0"><span style="font-size:12px;color:var(--text-2)">Resa oggi</span><span style="font-size:13px;color:var(--amber);font-weight:700">${m.yieldToday} kWh</span></div>
      <div class="card-row" style="padding:5px 0"><span style="font-size:12px;color:var(--text-2)">Resa ieri</span><span style="font-size:13px;font-weight:600">${m.yieldYesterday} kWh</span></div>
      ${m.lastUpdate ? `<div style="font-size:10px;color:var(--text-2);margin-top:4px">Aggiornato: ${m.lastUpdate}</div>` : ''}
      ${m.plainHex ? `<div style="background:var(--bg);border-radius:6px;padding:6px 8px;margin-top:8px;font-size:9px;font-family:monospace;color:var(--text-2);word-break:break-all">
        HEX: ${m.plainHex}<br>
        pvVr(b6)=${m.plainRaw?.pvVr} · yYr=${m.plainRaw?.yYr} · maxPWr=${m.plainRaw?.maxPWr}
      </div>` : ''}
      <button class="btn btn-ghost btn-full" style="margin-top:10px" onclick="(${idx===1?'window.mppt1':'window.mppt2'}).disconnect();renderVictron()">Disconnetti</button>
      ` : `
      <button class="btn btn-primary btn-full" onclick="connectMPPT(${idx})">Connetti</button>
      `}
      <div class="divider"></div>
      <div class="settings-row">
        <label>Chiave cifratura</label>
        <input type="password" id="${keyId}" placeholder="32 char hex" style="max-width:160px"
          value="${localStorage.getItem(keyId) ?? ''}"
          onchange="saveVictronKey(${idx},this.value)">
      </div>
    </div>`;
  };

  el('victron-body').innerHTML = `
    <div class="alert alert-warn">ℹ️ Chiave: VictronConnect → dispositivo → ⋮ → <strong>Show encryption data</strong></div>
    <div class="alert alert-warn" style="font-size:11px">Su Android potrebbe servire abilitare <strong>chrome://flags/#enable-experimental-web-platform-features</strong></div>
    ${(state.mppt1.connected || state.mppt2.connected) ? `
    <div class="card">
      <div class="card-title">Potenza solare totale</div>
      <div id="chart-pv-power-mount"></div>
    </div>` : ''}
    ${mpptCard(state.mppt1, 1)}
    ${mpptCard(state.mppt2, 2)}
  `;
  if (state.mppt1.connected || state.mppt2.connected) {
    chartPVPower.mount('#chart-pv-power-mount');
  }
}

// ── Imou screen ───────────────────────────────────────────────────────────────
function renderImou() {
  const ic = state.imou;
  if (!imou.hasCredentials()) {
    el('imou-body').innerHTML = `
      <div class="card">
        <div class="card-title">Configurazione Imou</div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.6">
          Registrati su <strong style="color:var(--amber)">open.imoulife.com</strong>, crea un'app e incolla le credenziali qui sotto.
        </p>
        <div class="settings-row"><label>App ID</label><input type="text" id="imou-id" placeholder="appId"></div>
        <div class="settings-row"><label>App Secret</label><input type="password" id="imou-secret" placeholder="appSecret"></div>
        <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="saveImouCreds()">Salva e connetti</button>
      </div>`;
    return;
  }
  el('imou-body').innerHTML = ic.connected
    ? `
      ${ic.devices.length === 0 ? '<div class="connect-placeholder"><div class="icon">📷</div><p>Nessuna camera trovata</p></div>' : ''}
      <div class="cam-grid">
        ${ic.devices.map(d => `
          <div class="cam-card" onclick="loadImouSnap('${d.id}',this)">
            <div class="cam-offline">📷</div>
            <div class="cam-name">${d.name}</div>
          </div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-full" style="margin-top:12px" onclick="imou.connect()">🔄 Aggiorna</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="clearImouCreds()">Cambia credenziali</button>`
    : `
      <div class="connect-placeholder">
        ${ic.error ? `<div class="alert alert-err" style="width:100%">❌ ${ic.error}</div>` : ''}
        <div class="icon">📷</div><p>Non connesso</p>
      </div>
      <button class="btn btn-primary btn-full" onclick="imou.connect()">Connetti</button>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="clearImouCreds()">Cambia credenziali</button>`;
}

// ── Settings screen ───────────────────────────────────────────────────────────
function renderSettings() {
  const saved = (key) => localStorage.getItem(key) ? '✅ memorizzato' : '—';
  el('settings-body').innerHTML = `
    <div class="card">
      <div class="card-title">Generale</div>
      <div class="settings-row"><label>Versione app</label><span style="color:var(--text-2)">1.1.0</span></div>
      <div class="settings-row"><label>Aggiornamento</label><button class="btn btn-ghost" onclick="checkUpdate()">🔄 Verifica</button></div>
    </div>
    <div class="card">
      <div class="card-title">Dispositivi salvati</div>
      <div style="font-size:12px;color:var(--text-2);line-height:2">
        BMS: ${saved('ble_bms_id')}<br>
        Riscaldatore: ${saved('ble_heater_id')}<br>
        MPPT 1: ${saved('ble_mppt1_id')}<br>
        MPPT 2: ${saved('ble_mppt2_id')}
      </div>
      <button class="btn btn-danger btn-full" style="margin-top:10px" onclick="clearSavedDevices()">🗑 Dimentica tutti i dispositivi</button>
    </div>
    <div class="card">
      <div class="card-title">Reset connessioni</div>
      <button class="btn btn-danger btn-full" onclick="disconnectAll()">Disconnetti tutto</button>
    </div>
    <div class="card">
      <div class="card-title">🔔 Notifiche</div>
      <div id="notif-settings-body"></div>
    </div>
    <div class="card">
      <div class="card-title">🔧 Manutenzione</div>
      <div id="maint-body"></div>
    </div>
    <div class="card">
      <div class="card-title">🔐 Sicurezza</div>
      <div id="security-body"></div>
    </div>`;
  renderNotifSettings('notif-settings-body');
  renderMaintenance('maint-body');
  renderSecuritySettings('security-body');
}

// ── Energy balance ────────────────────────────────────────────────────────────
function renderEnergy() {
  const solarW = (state.mppt1.connected ? parseFloat(state.mppt1.pvW) || 0 : 0)
              + (state.mppt2.connected ? parseFloat(state.mppt2.pvW) || 0 : 0);
  const hasBMS = state.bms.connected;
  let battW = hasBMS ? (battWatts(state.bms.voltage, state.bms.current) ?? 0) : null;
  let battEstimated = false;
  if (battW === null) {
    // Stima dalla somma delle potenze MPPT (battV × battA): approssimazione per carichi su batteria
    const w1 = (() => { const b = battInfoForKey('mppt1'); return b ? parseFloat(b.mpptW) || 0 : 0; })();
    const w2 = (() => { const b = battInfoForKey('mppt2'); return b ? parseFloat(b.mpptW) || 0 : 0; })();
    if (w1 + w2 > 0) { battW = w1 + w2; battEstimated = true; }
  }
  const loadW  = battW !== null ? Math.max(0, solarW - battW) : null;
  const card   = el('energy-balance-card');
  const body   = el('energy-balance-body');
  if (!card || !body) return;
  const hasData = (state.mppt1.connected || state.mppt2.connected) || hasBMS;
  card.style.display = hasData ? '' : 'none';
  if (!hasData) return;
  const battColor = battW !== null ? (battW >= 0 ? 'var(--green)' : 'var(--amber)') : 'var(--text-2)';
  const battLabel = battW !== null
    ? (battEstimated ? '↑ carica (stima)' : (battW >= 0 ? '↑ carica' : '↓ scarica'))
    : '–';

  // Autonomia off-grid
  const autoH = estimateAutonomy(state);
  let autoHtml = '';
  if (autoH !== null) {
    const d = Math.floor(autoH / 24);
    const h = Math.floor(autoH % 24);
    const m = Math.floor((autoH * 60) % 60);
    const label = d > 0 ? `${d}g ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    const color = autoH >= 24 ? 'var(--green)' : autoH >= 6 ? 'var(--amber)' : 'var(--red)';
    autoHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
      <span style="font-size:12px;color:var(--text-2)">⏱ Autonomia stimata (consumo attuale)</span>
      <span style="font-size:15px;font-weight:800;color:${color}">${label}</span>
    </div>`;
  }

  // Bilancio cumulativo
  const { pvKwh, loadKwh } = getCumulativeEnergy(24);
  const cumHtml = (pvKwh > 0 || loadKwh > 0) ? `
    <div style="display:flex;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
      <div style="flex:1;text-align:center">
        <div style="font-size:18px;font-weight:800;color:var(--amber)">${pvKwh.toFixed(2)}<span style="font-size:10px;color:var(--text-2)"> kWh</span></div>
        <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;margin-top:2px">☀️ Prodotti oggi</div>
      </div>
      <div style="width:1px;background:var(--border)"></div>
      <div style="flex:1;text-align:center">
        <div style="font-size:18px;font-weight:800;color:var(--blue)">${loadKwh.toFixed(2)}<span style="font-size:10px;color:var(--text-2)"> kWh</span></div>
        <div style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.4px;margin-top:2px">🏠 Consumati oggi</div>
      </div>
    </div>` : '';

  body.innerHTML = `
    <div class="energy-flow">
      <div class="energy-node">
        <div class="energy-icon">☀️</div>
        <div class="energy-val" style="color:var(--amber)">${solarW.toFixed(0)}<span class="energy-unit">W</span></div>
        <div class="energy-lbl">Solare</div>
      </div>
      <div class="energy-arrow">→</div>
      <div class="energy-node">
        <div class="energy-icon">🔋</div>
        <div class="energy-val" style="color:${battColor}">${battW !== null ? (battW >= 0 ? '+' : '') + battW.toFixed(0) : '–'}<span class="energy-unit">${battW !== null ? 'W' : ''}</span></div>
        <div class="energy-lbl">${battLabel}</div>
      </div>
      <div class="energy-arrow">→</div>
      <div class="energy-node">
        <div class="energy-icon">🏠</div>
        <div class="energy-val">${loadW !== null ? loadW.toFixed(0) : '–'}<span class="energy-unit">${loadW !== null ? 'W' : ''}</span></div>
        <div class="energy-lbl">Carichi</div>
      </div>
    </div>
    ${solarW > 0 && battW !== null ? `
    <div style="margin-top:10px">
      <div style="height:6px;border-radius:3px;background:var(--surface2);overflow:hidden;display:flex">
        <div style="width:${Math.min(100, (battW / Math.max(solarW, 1)) * 100).toFixed(0)}%;background:var(--green);border-radius:3px;transition:width .5s"></div>
        <div style="flex:1;background:var(--amber);opacity:.6"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-2);margin-top:3px">
        <span>🔋 Carica</span><span>🏠 Carichi</span>
      </div>
    </div>` : ''}
    ${autoHtml}
    ${cumHtml}
  `;
}

// ── Historical charts ─────────────────────────────────────────────────────────
function renderHistCharts() {
  drawHistChart(el('hist-soc-container'),  'soc',   { color: '#4ADE80', unit: '%', label: 'SOC batteria',       yMin: 0, yMax: 100 });
  drawHistChart(el('hist-pv-container'),   'pvW',   { color: '#F59E0B', unit: 'W', label: 'Produzione solare',  yMin: 0 });
  drawHistChart(el('hist-batt-container'), 'battW', { color: '#38BDF8', unit: 'W', label: 'Potenza batteria' });
}

// ── Meteo / Campeggi screens ──────────────────────────────────────────────────
async function renderMeteo() {
  const body = el('meteo-body');
  body.innerHTML = '<div class="connect-placeholder"><div class="icon">🌤</div><p>Caricamento meteo…</p></div>';
  try { await renderWeather('meteo-body'); }
  catch (e) { body.innerHTML = `<div class="alert alert-err">❌ ${e.message}</div><p style="font-size:12px;color:var(--text-2);padding:16px">Abilita il GPS per ottenere le previsioni meteo locali.</p>`; }
}

function renderCampeggi() {
  renderCampsites('campeggi-body');
}

window.refreshCampeggi   = () => renderCampsites('campeggi-body');
window.deleteCamp        = (id) => { deleteCampsite(id); renderCampeggi(); };
window.updateCampNotes   = (id, notes) => updateNotes(id, notes);
window.requestNotifPerm  = async () => { await requestPermission(); renderNotifSettings('notif-settings-body'); };
window.saveNotifThreshold = (key, val) => { const t = getThresholds(); t[key] = val; saveThresholds(t); };

// ── Auto-reconnect on startup ─────────────────────────────────────────────────

// Cache degli oggetti BLE device ottenuti da getDevices() — riusati per reconnect senza picker
const _bleCache = {};

async function autoReconnect() {
  const saved = {
    bms:    localStorage.getItem('ble_bms_id'),
    heater: localStorage.getItem('ble_heater_id'),
    mppt1:  localStorage.getItem('ble_mppt1_id'),
    mppt2:  localStorage.getItem('ble_mppt2_id'),
  };
  if (!Object.values(saved).some(Boolean)) return;

  // Raccogli oggetti device da getDevices() senza aprire picker
  if (navigator.bluetooth?.getDevices) {
    try {
      for (const dev of await navigator.bluetooth.getDevices()) {
        if (dev.id === saved.heater) _bleCache.heater = dev;
        if (dev.id === saved.bms)    _bleCache.bms    = dev;
        if (dev.id === saved.mppt1)  _bleCache.mppt1  = dev;
        if (dev.id === saved.mppt2)  _bleCache.mppt2  = dev;
      }
    } catch (e) { console.warn('getDevices:', e); }
  }

  // Tenta reconnect silenzioso per i device di cui abbiamo l'oggetto
  let attempted = 0;
  if (_bleCache.heater) { setDotConnecting('dot-heater'); heater.reconnect(_bleCache.heater); attempted++; }
  if (_bleCache.bms)    { setDotConnecting('dot-bms');    bms.reconnect(_bleCache.bms);       attempted++; }
  if (_bleCache.mppt1)  { setDotConnecting('dot-mppt1');  mppt1.reconnect(_bleCache.mppt1);   attempted++; }
  if (_bleCache.mppt2)  { setDotConnecting('dot-mppt2');  mppt2.reconnect(_bleCache.mppt2);   attempted++; }
  if (attempted) toast('🔄 Riconnessione in corso…');

  // Mostra banner se: mancano oggetti device, O dopo 7s se qualcosa non si è connesso
  const missingObj = (saved.heater && !_bleCache.heater) || (saved.bms && !_bleCache.bms) ||
                     (saved.mppt1  && !_bleCache.mppt1)  || (saved.mppt2 && !_bleCache.mppt2);
  const delay = missingObj ? 600 : 7000;
  setTimeout(() => {
    const anyDisconnected =
      (saved.heater && !state.heater.connected) || (saved.bms && !state.bms.connected) ||
      (saved.mppt1  && !state.mppt1.connected)  || (saved.mppt2 && !state.mppt2.connected);
    if (anyDisconnected) _showReconnectBanner(saved);
  }, delay);
}

function _showReconnectBanner(saved) {
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;
  const labels = { heater:'Riscaldatore', bms:'BMS', mppt1:'MPPT 1', mppt2:'MPPT 2' };
  const icons  = { heater:'🔥', bms:'🔋', mppt1:'☀️', mppt2:'☀️' };
  const missing = [
    saved.heater && !state.heater.connected && 'heater',
    saved.bms    && !state.bms.connected    && 'bms',
    saved.mppt1  && !state.mppt1.connected  && 'mppt1',
    saved.mppt2  && !state.mppt2.connected  && 'mppt2',
  ].filter(Boolean);
  if (!missing.length) { banner.style.display = 'none'; return; }
  const chips = missing.map(k =>
    `<button class="reconnect-chip" onclick="window.quickReconnect('${k}')">${icons[k]} ${labels[k]}</button>`
  ).join('');
  banner.innerHTML = `
    <div class="reconnect-label">📶 Non connessi</div>
    <div class="reconnect-btns">
      ${chips}
      ${missing.length > 1 ? `<button class="reconnect-chip reconnect-all" onclick="window.quickReconnectAll()">🔄 Tutto</button>` : ''}
    </div>`;
  banner.style.display = '';
}

window.quickReconnectAll = async () => {
  const banner = document.getElementById('reconnect-banner');
  const saved = {
    bms: localStorage.getItem('ble_bms_id'), heater: localStorage.getItem('ble_heater_id'),
    mppt1: localStorage.getItem('ble_mppt1_id'), mppt2: localStorage.getItem('ble_mppt2_id'),
  };

  // Prova prima a riacquisire il cache (caso: getDevices() era vuota al boot ma ora funziona)
  if (navigator.bluetooth?.getDevices) {
    try {
      for (const dev of await navigator.bluetooth.getDevices()) {
        if (dev.id === saved.heater) _bleCache.heater = dev;
        if (dev.id === saved.bms)    _bleCache.bms    = dev;
        if (dev.id === saved.mppt1)  _bleCache.mppt1  = dev;
        if (dev.id === saved.mppt2)  _bleCache.mppt2  = dev;
      }
    } catch {}
  }

  // Device con oggetto in cache → gatt.connect() silenzioso
  const silent = [];
  if (_bleCache.heater && saved.heater && !state.heater.connected) { setDotConnecting('dot-heater'); heater.reconnect(_bleCache.heater); silent.push('heater'); }
  if (_bleCache.bms    && saved.bms    && !state.bms.connected)    { setDotConnecting('dot-bms');    bms.reconnect(_bleCache.bms);       silent.push('bms'); }
  if (_bleCache.mppt1  && saved.mppt1  && !state.mppt1.connected)  { setDotConnecting('dot-mppt1');  mppt1.reconnect(_bleCache.mppt1);   silent.push('mppt1'); }
  if (_bleCache.mppt2  && saved.mppt2  && !state.mppt2.connected)  { setDotConnecting('dot-mppt2');  mppt2.reconnect(_bleCache.mppt2);   silent.push('mppt2'); }

  // Device senza cache → picker obbligatorio, uno alla volta
  const needPicker = [
    saved.heater && !_bleCache.heater && !state.heater.connected && 'heater',
    saved.bms    && !_bleCache.bms    && !state.bms.connected    && 'bms',
    saved.mppt1  && !_bleCache.mppt1  && !state.mppt1.connected  && 'mppt1',
    saved.mppt2  && !_bleCache.mppt2  && !state.mppt2.connected  && 'mppt2',
  ].filter(Boolean);

  if (silent.length) {
    if (banner) banner.innerHTML = `<div class="reconnect-label">🔄 Connessione in corso…</div><div class="reconnect-btns"><span style="font-size:12px;color:var(--text-2)">${silent.length} dispositiv${silent.length > 1 ? 'i' : 'o'}</span></div>`;
  }

  if (needPicker.length) {
    // Picker filtrato per nome — 1 voce sola nel picker, solo 1 tap per device
    const instMap = { heater, bms, mppt1, mppt2 };
    const nameKey = { heater:'ble_heater_name', bms:'ble_bms_name', mppt1:'ble_mppt1_name', mppt2:'ble_mppt2_name' };
    const dotMap  = { heater:'dot-heater', bms:'dot-bms', mppt1:'dot-mppt1', mppt2:'dot-mppt2' };
    const labels  = { heater:'Riscaldatore', bms:'Batterie', mppt1:'MPPT 1', mppt2:'MPPT 2' };
    for (const key of needPicker) {
      const nameHint = localStorage.getItem(nameKey[key]) || null;
      if (banner) banner.innerHTML = `<div class="reconnect-label">🔵 Seleziona <strong>${nameHint || labels[key]}</strong> nel menu BLE</div>`;
      setDotConnecting(dotMap[key]);
      await instMap[key].connectFiltered(nameHint);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // Aggiorna banner dopo 7s
  await new Promise(r => setTimeout(r, 7000));
  _showReconnectBanner(saved);
};

window.quickReconnect = async (key) => {
  const dotMap  = { heater:'dot-heater', bms:'dot-bms', mppt1:'dot-mppt1', mppt2:'dot-mppt2' };
  const instMap = { heater, bms, mppt1, mppt2 };
  const nameKey = { heater:'ble_heater_name', bms:'ble_bms_name', mppt1:'ble_mppt1_name', mppt2:'ble_mppt2_name' };
  setDotConnecting(dotMap[key]);
  if (_bleCache[key]) {
    // Cache disponibile → gatt.connect() silenzioso, nessun picker
    await instMap[key].reconnect(_bleCache[key]);
  } else {
    // Nessun cache → picker filtrato per nome (mostra solo 1 voce)
    const nameHint = localStorage.getItem(nameKey[key]) || null;
    await instMap[key].connectFiltered(nameHint);
  }
  setTimeout(() => {
    const saved = { bms: localStorage.getItem('ble_bms_id'), heater: localStorage.getItem('ble_heater_id'),
                    mppt1: localStorage.getItem('ble_mppt1_id'), mppt2: localStorage.getItem('ble_mppt2_id') };
    _showReconnectBanner(saved);
  }, 2000);
};

// ── Global actions ────────────────────────────────────────────────────────────
window.connectHeater = async () => {
  setDotConnecting('dot-heater');
  const ok = await heater.connect();
  if (!ok) updateDots();
};
window.renderBMS     = () => renderBMS();
window.connectBMS = async () => {
  setDotConnecting('dot-bms');
  const ok = await bms.connect();
  if (!ok) updateDots();
};
window.connectMPPT = async (i) => {
  setDotConnecting(i === 1 ? 'dot-mppt1' : 'dot-mppt2');
  const ok = await (i === 1 ? mppt1 : mppt2).connect();
  if (!ok) updateDots();
};

let _heaterBusy = false;
window.toggleHeater = async () => {
  if (_heaterBusy) return;
  _heaterBusy = true;
  setTimeout(() => { _heaterBusy = false; renderHeater(); }, 4000);
  const on = state.heater.state === 1 || state.heater.state === 2;
  on ? await heater.turnOff() : await heater.turnOn();
};
window.heaterSendHex  = () => heater.sendHex(document.getElementById('heater-hex-in')?.value ?? '');
window.setHeaterTemp  = (t) => heater.setTemp(t);
window.setHeaterLevel = (l) => {
  heater.setLevel(l);
  document.querySelectorAll('.level-pill').forEach((p, i) => p.classList.toggle('active', i + 1 === l));
};
window.setHeaterMode = (m) => heater.setMode(m);

window.saveVictronKey = (idx, val) => {
  localStorage.setItem(`victron_key_${idx}`, val);
  (idx === 1 ? mppt1 : mppt2).setKey(val);
  toast('Chiave salvata');
};

window.saveImouCreds = () => {
  const id     = el('imou-id')?.value?.trim();
  const secret = el('imou-secret')?.value?.trim();
  if (!id || !secret) { toast('Inserisci App ID e Secret'); return; }
  imou.saveCredentials(id, secret);
  imou.connect();
};
window.clearImouCreds = () => {
  localStorage.removeItem('imou_app_id');
  localStorage.removeItem('imou_app_secret');
  imou.appId = ''; imou.appSecret = '';
  renderImou();
};
window.loadImouSnap = async (deviceId, card) => {
  const url = await imou.getSnapshot(deviceId);
  if (url) { const img = document.createElement('img'); img.src = url; card.prepend(img); }
};

window.disconnectAll = () => {
  heater.disconnect(); bms.disconnect();
  mppt1.disconnect();  mppt2.disconnect();
  toast('Disconnesso');
};

// ── Theme toggle ──────────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('caribu_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = saved === 'dark' ? '🌙' : '☀️';
})();

window.toggleTheme = () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next    = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('caribu_theme', next);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';
};

// ── Maintenance helpers ───────────────────────────────────────────────────────
window.maintMarkDone = (id) => {
  markDone(id);
  renderMaintenance('maint-body');
  toast('✓ Manutenzione registrata');
};

// ── Document handlers ─────────────────────────────────────────────────────────
window._docPick = (input) => {
  const file = input.files[0];
  if (!file) return;
  window._pendingDocFile = file;
  const picker = document.getElementById('doc-cat-picker');
  if (picker) picker.style.display = 'flex';
};

window._docCat = async (category) => {
  const picker = document.getElementById('doc-cat-picker');
  if (picker) picker.style.display = 'none';
  const file = window._pendingDocFile;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    await addDocument({ id: Date.now().toString(), name: file.name, category, type: file.type, data: e.target.result, ts: Date.now() });
    toast('📄 Documento salvato');
    renderDocuments('documenti-body');
  };
  reader.readAsDataURL(file);
};

window._docView = async (id) => {
  const docs = await getDocuments();
  const doc  = docs.find(d => d.id === id);
  if (!doc) return;
  const win = window.open('', '_blank');
  if (doc.type?.startsWith('image/')) {
    win.document.write(`<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${doc.data}" style="max-width:100%;max-height:100vh;object-fit:contain"></body></html>`);
  } else {
    win.location.href = doc.data;
  }
};

window._docDel = async (id) => {
  if (!confirm('Eliminare questo documento?')) return;
  await deleteDocument(id);
  toast('Documento eliminato');
  renderDocuments('documenti-body');
};

// ── Security handlers ─────────────────────────────────────────────────────────
window.secSetPIN    = () => showPinSetup(ok => { if (ok) { toast('🔒 PIN impostato'); renderSecuritySettings('security-body'); } });
window.secChangePIN = () => showPinSetup(ok => { if (ok) { toast('🔒 PIN aggiornato'); renderSecuritySettings('security-body'); } });
window.secRemovePIN = () => { clearLock(); toast('PIN rimosso'); renderSecuritySettings('security-body'); };
window.secEnableBIO = async () => { const ok = await registerBiometric(); toast(ok ? '✓ Biometria attivata' : 'Biometria non disponibile'); renderSecuritySettings('security-body'); };
window.secRemoveBIO = () => { localStorage.removeItem('caribu_bio_cred'); toast('Biometria rimossa'); renderSecuritySettings('security-body'); };
window.clearSavedDevices = () => {
  ['ble_bms_id','ble_bms_name','ble_heater_id','ble_heater_name',
   'ble_mppt1_id','ble_mppt1_name','ble_mppt2_id','ble_mppt2_name'].forEach(k => localStorage.removeItem(k));
  const b = document.getElementById('reconnect-banner');
  if (b) b.style.display = 'none';
  toast('Dispositivi dimenticati');
  renderSettings();
};
window.checkUpdate = () => { location.reload(true); };

// Expose instances globally for inline onclick
window.heater = heater;
window.bms    = bms;
window.mppt1  = mppt1;
window.mppt2  = mppt2;

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
window.toast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
};

// ── Init ──────────────────────────────────────────────────────────────────────
renderDash();
renderHeater();
renderBMS();
renderVictron();
renderImou();
renderSettings();
updateDots();

if (imou.hasCredentials()) imou.connect();
schedApply();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

// Weather alerts: check at startup + every 30 min
async function _runWeatherAlerts() {
  const alerts = await checkWeatherAlerts();
  renderWeatherAlerts(alerts, 'weather-alerts-area');
  if (alerts.length && Notification.permission === 'granted') {
    alerts.forEach(a => {
      try { new Notification(a.title, { body: a.msg, icon: '/icons/icon.svg' }); } catch {}
    });
  }
}
_runWeatherAlerts();
setInterval(_runWeatherAlerts, 30 * 60 * 1000);

// Lock screen (overlay over already-rendered app)
initLock(() => {});

autoReconnect();
startTracking();
renderHistCharts();

// Handle PWA shortcut URL params (?tab=bms, ?tab=heater, etc.)
const _urlTab = new URLSearchParams(location.search).get('tab');
if (_urlTab) window.switchTab(_urlTab);

// Check maintenance alerts at startup (if notifications granted)
if (Notification.permission === 'granted') {
  checkMaintenanceAlerts((title, body) => {
    import('./notifications.js').then(m => m.notify(title, body));
  });
}
